import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ViteUserConfig, TestProjectInlineConfiguration } from 'vitest/config';
import base from '../vitest.config.js';
import { deriveReleaseVitestConfig } from './config/release-vitest-partition.js';
import { RELEASE_NATIVE_CANDIDATES } from './config/release-native-candidates.mjs';
import { verifyReleaseTestCoverage } from '../scripts/check-release-test-coverage.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeFiles = RELEASE_NATIVE_CANDIDATES.map((entry) => entry.file);
const projects = (config: ViteUserConfig) => config.test!.projects as TestProjectInlineConfiguration[];
function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

async function discover(directory: string, config: string) {
  const { createVitest } = await import('vitest/node');
  const context = await createVitest('test', {
    root: directory, config: join(directory, config), watch: false, run: true, api: false, ui: false,
  });
  try {
    const files = (await context.globTestSpecifications()).map((entry) => ({
      project: entry.project.name, file: relative(directory, entry.moduleId).replaceAll('\\', '/'),
    }));
    const settings = Object.fromEntries(context.projects.map((project) => [project.name, {
      setupFiles: project.config.setupFiles, pool: project.config.pool,
      testTimeout: project.config.testTimeout, hookTimeout: project.config.hookTimeout,
      clearMocks: project.config.clearMocks, isolate: project.config.isolate,
      environment: project.config.environment, globals: project.config.globals,
      maxWorkers: project.config.maxWorkers,
      groupOrder: project.config.sequence.groupOrder,
    }]));
    return { files, settings, fileParallelism: context.vite.config.test?.fileParallelism ?? true };
  } finally {
    await context.close();
  }
}

describe('opt-in release Vitest partition', () => {
  it('preserves all ordinary config fields except deduplicated native exclusions without mutating input', () => {
    const input = structuredClone(base);
    const before = structuredClone(input);
    deepFreeze(input);
    const actual = deriveReleaseVitestConfig(input, 'ordinary');
    const expected = structuredClone(before);
    for (const project of projects(expected)) project.test!.exclude = [...new Set([...project.test!.exclude!, ...nativeFiles])];
    expect(actual).toEqual(expected);
    expect(input).toEqual(before);
    for (const project of projects(actual)) expect(new Set(project.test!.exclude).size).toBe(project.test!.exclude!.length);
  });

  it('preserves all native fields except project selection, include and explicit serial scheduling', () => {
    const input = structuredClone(base);
    const before = structuredClone(input);
    deepFreeze(input);
    const actual = deriveReleaseVitestConfig(input, 'native');
    const realIo = projects(before).find((entry) => entry.test!.name === 'real-io')!;
    expect(actual).toEqual({ ...before, test: {
      ...before.test, maxWorkers: 1, fileParallelism: false,
      projects: [{ ...realIo, test: { ...realIo.test, include: nativeFiles, maxWorkers: 1, fileParallelism: false } }],
    } });
    expect(input).toEqual(before);
    expect(Object.hasOwn(actual.test!, 'include')).toBe(false);
  });

  it.each([
    ['root include', (value: any) => { value.test.include = ['test/**/*.test.ts']; }],
    ['undefined root include', (value: any) => { value.test.include = undefined; }],
    ['missing root excludes', (value: any) => { delete value.test.exclude; }],
    ['sparse root excludes', (value: any) => { value.test.exclude = new Array(1); }],
    ['sparse projects', (value: any) => { delete value.test.projects[0]; }],
    ['extra project', (value: any) => { value.test.projects.push(value.test.projects[0]); }],
    ['missing project', (value: any) => { value.test.projects.pop(); }],
    ['duplicate project name', (value: any) => { value.test.projects[1].test.name = 'unit'; }],
    ['config-file project', (value: any) => { value.test.projects[0] = './another.config.ts'; }],
    ['function project', (value: any) => { value.test.projects[0] = () => ({}); }],
    ['non-inherited project', (value: any) => { value.test.projects[0].extends = false; }],
    ['changed unit glob', (value: any) => { value.test.projects[0].test.include = ['**/*.test.ts']; }],
    ['sparse unit includes', (value: any) => { value.test.projects[0].test.include = new Array(1); }],
    ['sparse real-io includes', (value: any) => { value.test.projects[1].test.include.length += 1; }],
    ['sparse unit excludes', (value: any) => { value.test.projects[0].test.exclude.length += 1; }],
    ['sparse real-io excludes', (value: any) => { value.test.projects[1].test.exclude.length += 1; }],
    ['changed worker policy', (value: any) => { value.test.projects[1].test.maxWorkers = 4; }],
    ['native file removed from lane', (value: any) => { value.test.projects[1].test.include = []; }],
    ['native file no longer excluded from unit', (value: any) => { value.test.projects[0].test.exclude = []; }],
  ])('refuses %s', (_label, mutate) => {
    const input = structuredClone(base);
    mutate(input);
    expect(() => deriveReleaseVitestConfig(input, 'ordinary')).toThrow('release Vitest partition:');
    expect(() => deriveReleaseVitestConfig(input, 'native')).toThrow('release Vitest partition:');
  });

  it.each([
    ['missing', RELEASE_NATIVE_CANDIDATES.slice(1)],
    ['duplicate', [RELEASE_NATIVE_CANDIDATES[0], ...RELEASE_NATIVE_CANDIDATES.slice(0, -1)]],
    ['stale', [{ project: 'real-io', file: 'test/does-not-exist.test.ts' }, ...RELEASE_NATIVE_CANDIDATES.slice(1)]],
    ['wrong project', [{ ...RELEASE_NATIVE_CANDIDATES[0], project: 'unit' }, ...RELEASE_NATIVE_CANDIDATES.slice(1)]],
    ['glob', [{ project: 'real-io', file: 'test/*.test.ts' }, ...RELEASE_NATIVE_CANDIDATES.slice(1)]],
  ])('refuses %s native manifest', (_label, manifest) => {
    expect(() => deriveReleaseVitestConfig(base, 'native', manifest)).toThrow('release Vitest partition:');
  });

  it('discovers the actual three configs with exact coverage and resolved execution-setting parity', async () => {
    const original = await discover(root, 'vitest.config.ts');
    const ordinary = await discover(root, 'vitest.config.release-ordinary.ts');
    const native = await discover(root, 'vitest.config.release-native.ts');
    const verified = verifyReleaseTestCoverage(original.files, RELEASE_NATIVE_CANDIDATES, [
      ...ordinary.files.map((entry) => ({ ...entry, group: 'ordinary' })),
      ...native.files.map((entry) => ({ ...entry, group: 'native' })),
    ]);
    expect(verified.counts.native).toBe(9);
    expect(ordinary.settings).toEqual(original.settings);
    expect(native.settings).toEqual({ 'real-io': { ...original.settings['real-io'], maxWorkers: 1 } });
    expect(ordinary.fileParallelism).toBe(original.fileParallelism);
    expect(native.fileParallelism).toBe(false);
  }, 30_000);

  it('derived configs discover but never import throwing test/setup sentinels and close their contexts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ashlr-release-partition-'));
    const imported = join(directory, 'imported');
    const closed = join(directory, 'closed');
    try {
      mkdirSync(join(directory, 'test'));
      const sentinel = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(imported)}, 'bad'); throw new Error('test module was imported');`;
      for (const file of [...nativeFiles, 'test/small.test.ts']) writeFileSync(join(directory, file), sentinel);
      writeFileSync(join(directory, 'setup.ts'), sentinel);
      const fixture = structuredClone(base);
      fixture.test!.setupFiles = ['./setup.ts'];
      writeFileSync(join(directory, 'vitest.config.ts'), `import { writeFileSync } from 'node:fs'; export default { ...${JSON.stringify(fixture)}, plugins: [{ name: 'close-proof', closeBundle() { writeFileSync(${JSON.stringify(closed)}, 'closed'); } }] };`);
      for (const mode of ['ordinary', 'native'] as const) {
        writeFileSync(join(directory, `vitest.config.release-${mode}.ts`), `import base from './vitest.config.ts'; import { deriveReleaseVitestConfig } from ${JSON.stringify(join(root, 'test/config/release-vitest-partition.ts'))}; export default deriveReleaseVitestConfig(base, '${mode}');`);
      }
      const original = await discover(directory, 'vitest.config.ts');
      const ordinary = await discover(directory, 'vitest.config.release-ordinary.ts');
      const native = await discover(directory, 'vitest.config.release-native.ts');
      expect(verifyReleaseTestCoverage(original.files, RELEASE_NATIVE_CANDIDATES, [
        ...ordinary.files.map((entry) => ({ ...entry, group: 'ordinary' })),
        ...native.files.map((entry) => ({ ...entry, group: 'native' })),
      ]).counts).toEqual({ default: 10, ordinary: 1, native: 9 });
      expect(existsSync(imported)).toBe(false);
      expect(existsSync(closed)).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
