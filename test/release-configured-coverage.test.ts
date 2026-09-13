import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverConfiguredReleaseTestCoverage, verifyConfiguredReleaseTestCoverage,
  type ReleaseTestFile,
} from '../scripts/check-release-test-coverage.mjs';

const ordinary: ReleaseTestFile[] = ['a', 'b', 'c', 'd', 'e'].map((name, index) => ({
  project: index < 3 ? 'unit' : 'real-io', file: `test/${name}.test.ts`,
}));
const native: ReleaseTestFile = { project: 'real-io', file: 'test/native.test.ts' };
const defaultFiles = [...ordinary, native];
const shards = [[ordinary[0]!, ordinary[3]!], [ordinary[1]!, ordinary[4]!], [ordinary[2]!]];

describe('configured release file coverage without executing tests', () => {
  it('preserves the full default census exactly once across three ordinary shards and native coverage', () => {
    const snapshot = structuredClone({ defaultFiles, ordinary, native, shards });
    const report = verifyConfiguredReleaseTestCoverage(defaultFiles, ordinary, [native], shards, [native]);
    expect(report).toMatchObject({
      schemaVersion: 2, scope: 'configured-whole-file-partition', testsExecuted: false, gateAttestation: false,
      counts: { default: 6, ordinary: 5, native: 1 },
      groups: { ordinary: expect.arrayContaining(ordinary), native: [native] },
      ordinaryShards: shards.map((files, index) => ({ index: index + 1, count: 3, files: expect.arrayContaining(files) })),
    });
    expect(report.ordinaryShards.map(shard => shard.files.length)).toEqual([2, 2, 1]);
    expect({ defaultFiles, ordinary, native, shards }).toEqual(snapshot);
  });

  it.each([
    ['ordinary omission', defaultFiles, ordinary.slice(1), [native], shards, [native]],
    ['ordinary foreign file', defaultFiles, [...ordinary, { project: 'unit', file: 'test/foreign.test.ts' }], [native], shards, [native]],
    ['ordinary project mismatch', defaultFiles, [{ ...ordinary[0], project: 'real-io' }, ...ordinary.slice(1)], [native], shards, [native]],
    ['ordinary duplicate', defaultFiles, [...ordinary, ordinary[0]], [native], shards, [native]],
    ['native omitted', defaultFiles, ordinary, [], shards, [native]],
    ['native project mismatch', defaultFiles, ordinary, [{ ...native, project: 'unit' }], shards, [native]],
    ['native duplicate', defaultFiles, ordinary, [native, native], shards, [native]],
    ['native assignment moved to ordinary', defaultFiles, defaultFiles, [], [...shards.slice(0, 2), [ordinary[2], native]], [native]],
    ['stale native manifest', defaultFiles, ordinary, [native], shards, [{ ...native, file: 'test/missing.test.ts' }]],
    ['duplicate native manifest', defaultFiles, ordinary, [native], shards, [native, native]],
    ['duplicate default project assignment', [...defaultFiles, { ...ordinary[0], project: 'real-io' }], ordinary, [native], shards, [native]],
    ['two shards', defaultFiles, ordinary, [native], shards.slice(0, 2), [native]],
    ['four shards', defaultFiles, ordinary, [native], [...shards, []], [native]],
    ['sparse shards', defaultFiles, ordinary, [native], Object.assign(new Array<ReleaseTestFile[]>(3), { 0: ordinary }), [native]],
    ['dense missing shard', defaultFiles, ordinary, [native], [ordinary, undefined, undefined], [native]],
    ['shard drops a file', defaultFiles, ordinary, [native], [shards[0], shards[1], []], [native]],
    ['nonempty shards omit one ordinary file', defaultFiles, ordinary, [native], [[ordinary[0]], shards[1], shards[2]], [native]],
    ['duplicate within shard', defaultFiles, ordinary, [native], [[...shards[0]!, ordinary[0]], shards[1], shards[2]], [native]],
    ['duplicate across shards', defaultFiles, ordinary, [native], [shards[0], shards[1], [ordinary[0], ordinary[2]]], [native]],
    ['foreign shard member', defaultFiles, ordinary, [native], [shards[0], shards[1], [{ project: 'unit', file: 'test/foreign.test.ts' }]], [native]],
    ['wrong-project shard member', defaultFiles, ordinary, [native], [shards[0], shards[1], [{ ...ordinary[2], project: 'real-io' }]], [native]],
    ['native member in ordinary shard', defaultFiles, ordinary, [native], [shards[0], shards[1], [ordinary[2], native]], [native]],
    ['coercible shard project', defaultFiles, ordinary, [native], [shards[0], shards[1], [{ ...ordinary[2], project: ['unit'] }]], [native]],
  ])('rejects %s without manufacturing full coverage', (_label, census, ordinaryFiles, nativeFiles, ordinaryShards, manifest) => {
    expect(() => verifyConfiguredReleaseTestCoverage(census, ordinaryFiles, nativeFiles, ordinaryShards, manifest))
      .toThrow('release-test-coverage:');
  });
});

/** Real Vitest config discovery; the test modules deliberately cannot be imported. */
function fixture(sharderMode: 'valid' | 'throws' | 'malformed' = 'valid') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-configured-census-')));
  mkdirSync(join(root, 'test'));
  const imported = join(root, 'imported-marker');
  const eventsFile = join(root, 'events.jsonl');
  const sentinel = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(imported)}, 'imported');\nthrow new Error('census imported test or setup');\n`;
  for (const row of defaultFiles) writeFileSync(join(root, row.file), sentinel, { mode: 0o600 });
  writeFileSync(join(root, 'setup.ts'), sentinel, { mode: 0o600 });
  const config = (label: 'default' | 'ordinary' | 'native', rows: ReleaseTestFile[]) => {
    const projects = ['unit', 'real-io'].flatMap(project => {
      const include = rows.filter(row => row.project === project).map(row => row.file);
      return include.length ? [{ test: { name: project, include, setupFiles: ['./setup.ts'] } }] : [];
    });
    return `import { appendFileSync } from 'node:fs';
const record = event => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event) + '\\n');
// Vite calls closeBundle for multiple environments; record one closure per config instance.
let closed = false;
class ConfiguredSequencer {
  constructor(context) { this.context = context; }
  shard(files) {
    const { index, count } = this.context.config.shard;
    record({ type: 'shard', index, count, projects: files.map(file => file.project.name).sort(), length: files.length });
    ${sharderMode === 'throws' ? "throw new Error('fixture configured sharder refused');" : sharderMode === 'malformed' ? 'return [undefined];' : "return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)).filter((_, position) => position % count === index - 1);"}
  }
  sort() { throw new Error('coverage must not sort or execute tests'); }
}
export default {
  plugins: [{ name: 'close-sentinel', closeBundle() { if (!closed) { closed = true; record({ type: 'close', label: ${JSON.stringify(label)} }); } } }],
  test: { projects: ${JSON.stringify(projects)}, setupFiles: ['./setup.ts'],
    ${label === 'ordinary' ? 'sequence: { sequencer: ConfiguredSequencer },' : ''}
    ${label === 'native' ? 'maxWorkers: 1, fileParallelism: false,' : ''}
  },
};\n`;
  };
  writeFileSync(join(root, 'vitest.config.ts'), config('default', defaultFiles), { mode: 0o600 });
  writeFileSync(join(root, 'vitest.config.release-ordinary.ts'), config('ordinary', ordinary), { mode: 0o600 });
  writeFileSync(join(root, 'vitest.config.release-native.ts'), config('native', [native]), { mode: 0o600 });
  return {
    root, imported,
    events: () => readFileSync(eventsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
      type: 'shard' | 'close'; index?: number; count?: number; projects?: string[]; length?: number; label?: string;
    }),
  };
}

describe('real configured sharder discovery', () => {
  it('invokes the configured sharder over both ordinary projects for all three indices and closes every context without importing sentinels', async () => {
    const f = fixture();
    try {
      const report = await discoverConfiguredReleaseTestCoverage(f.root, [native]);
      expect(report).toMatchObject({
        schemaVersion: 2, scope: 'configured-whole-file-partition', testsExecuted: false, gateAttestation: false,
        counts: { default: 6, ordinary: 5, native: 1 },
        ordinaryShards: shards.map((files, index) => ({ index: index + 1, count: 3, files: expect.arrayContaining(files) })),
      });
      expect(report.ordinaryShards.map(shard => shard.files.length)).toEqual([2, 2, 1]);
      const events = f.events();
      expect(events.filter(event => event.type === 'shard')).toEqual([1, 2, 3].map(index => ({
        type: 'shard', index, count: 3, length: 5, projects: ['real-io', 'real-io', 'unit', 'unit', 'unit'],
      })));
      expect(events.filter(event => event.type === 'close').map(event => event.label).sort())
        .toEqual(['default', 'native', 'ordinary', 'ordinary', 'ordinary']);
      expect(existsSync(f.imported)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  it.each(['throws', 'malformed'] as const)('closes the active context when the configured sharder is %s and never imports tests or setup', async (mode) => {
    const f = fixture(mode);
    try {
      const operation = expect(discoverConfiguredReleaseTestCoverage(f.root, [native])).rejects;
      if (mode === 'throws') await operation.toThrow('fixture configured sharder refused');
      else await operation.toThrow();
      const events = f.events();
      expect(events.filter(event => event.type === 'shard')).toEqual([{
        type: 'shard', index: 1, count: 3, length: 5, projects: ['real-io', 'real-io', 'unit', 'unit', 'unit'],
      }]);
      expect(events.filter(event => event.type === 'close').map(event => event.label).sort()).toEqual(['default', 'native', 'ordinary']);
      expect(existsSync(f.imported)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);
});
