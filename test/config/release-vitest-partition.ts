import type { TestProjectInlineConfiguration, ViteUserConfig } from 'vitest/config';
import { RELEASE_NATIVE_CANDIDATES } from './release-native-candidates.mjs';

type Candidate = Readonly<{ project: string; file: string }>;
type Project = TestProjectInlineConfiguration & { test: NonNullable<TestProjectInlineConfiguration['test']> };
function refuse(reason: string): never { throw new Error(`release Vitest partition: ${reason}`); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const strings = (value: unknown): value is string[] => Array.isArray(value) && Array.from(value).every((entry) => typeof entry === 'string');

/** Opt-in file partition, never a replacement for default coverage or a gate. */
export function deriveReleaseVitestConfig(
  base: ViteUserConfig,
  mode: 'ordinary' | 'native',
  manifest: readonly Candidate[] = RELEASE_NATIVE_CANDIDATES,
): ViteUserConfig {
  if (!object(base) || !object(base.test) || Object.hasOwn(base.test, 'include') ||
    !strings(base.test.exclude)) refuse('unsupported root config');
  if (mode !== 'ordinary' && mode !== 'native') refuse('unsupported mode');
  const configured = base.test.projects;
  if (!Array.isArray(configured) || configured.length !== 2) refuse('unsupported projects');
  const projects = Array.from(configured).map((entry): Project => {
    if (!object(entry) || entry.extends !== true || !object(entry.test) ||
      !strings(entry.test.include) || !strings(entry.test.exclude)) refuse('unsupported project');
    return entry as unknown as Project;
  });
  const unit = projects.find((entry) => entry.test.name === 'unit');
  const realIo = projects.find((entry) => entry.test.name === 'real-io');
  if (!unit || !realIo || unit === realIo || unit.test.maxWorkers !== 4 || realIo.test.maxWorkers !== 2 ||
    unit.test.include?.length !== 1 || unit.test.include[0] !== 'test/**/*.test.ts') refuse('unsupported project policy');
  if (!Array.isArray(manifest) || manifest.length !== RELEASE_NATIVE_CANDIDATES.length) refuse('invalid native manifest');
  const native = new Set<string>();
  for (const entry of manifest) {
    if (!object(entry) || Object.keys(entry).sort().join(',') !== 'file,project' || entry.project !== 'real-io' ||
      typeof entry.file !== 'string' || !/^test\/[a-zA-Z0-9._-]+\.test\.ts$/.test(entry.file) ||
      native.has(entry.file) || !realIo.test.include?.includes(entry.file) || !unit.test.exclude?.includes(entry.file)) {
      refuse('duplicate, stale, or unsupported native manifest');
    }
    native.add(entry.file);
  }
  // Vite mergeConfig concatenates arrays. Replace projects and selection arrays
  // explicitly, keeping root include absent so extends:true cannot widen them.
  if (mode === 'ordinary') {
    return { ...base, test: { ...base.test, projects: projects.map((entry) => ({
      ...entry, test: { ...entry.test, exclude: [...new Set([...entry.test.exclude!, ...native])] },
    })) } };
  }
  return { ...base, test: {
    ...base.test, maxWorkers: 1, fileParallelism: false,
    projects: [{ ...realIo, test: {
      ...realIo.test, include: [...native], maxWorkers: 1, fileParallelism: false,
    } }],
  } };
}
