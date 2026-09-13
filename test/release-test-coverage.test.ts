import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverReleaseTestFiles, proposeReleaseTestCoverage, verifyReleaseTestCoverage,
  type ReleaseTestAssignment,
} from '../scripts/check-release-test-coverage.mjs';
import { RELEASE_NATIVE_CANDIDATES } from './config/release-native-candidates.mjs';

const unit = { project: 'unit', file: 'test/small.test.ts' };
const native = { project: 'real-io', file: 'test/long.test.ts' };
const discovered = [unit, native];
const assignments: ReleaseTestAssignment[] = [
  { ...unit, group: 'ordinary' }, { ...native, group: 'native' },
];

describe('release file coverage inventory (not gate execution)', () => {
  it('preserves the exhaustive default census as an exact-once proposed partition', () => {
    const report = proposeReleaseTestCoverage(discovered, [native]);
    expect(report).toMatchObject({
      schemaVersion: 1, scope: 'hypothetical-whole-file-partition',
      testsExecuted: false, gateAttestation: false,
      counts: { default: 2, ordinary: 1, native: 1 },
      groups: { ordinary: [unit], native: [native] },
    });
    expect(verifyReleaseTestCoverage([...discovered].reverse(), [native], [...assignments].reverse())).toEqual(report);
    expect(discovered).toEqual([unit, native]);
  });

  it('keeps a new default file in ordinary coverage without silently dropping it', () => {
    const newFile = { project: 'unit', file: 'test/new.test.ts' };
    expect(proposeReleaseTestCoverage([...discovered, newFile], [native]).groups.ordinary).toContainEqual(newFile);
    expect(() => verifyReleaseTestCoverage([...discovered, newFile], [native], assignments)).toThrow('unassigned');
  });

  it.each([
    ['duplicate discovery', [unit, native, native], [native], assignments],
    ['duplicate project coverage', [unit, native, { ...native, project: 'unit' }], [native], assignments],
    ['missing native', [unit], [native], assignments],
    ['native project mismatch', discovered, [{ ...native, project: 'unit' }], assignments],
    ['duplicate manifest', discovered, [native, native], assignments],
    ['unknown manifest', discovered, [{ ...native, file: 'test/unknown.test.ts' }], assignments],
    ['missing assignment', discovered, [native], assignments.slice(0, 1)],
    ['duplicate assignment', discovered, [native], [...assignments, assignments[0]]],
    ['unknown assignment', discovered, [native], [...assignments, { ...unit, file: 'test/unknown.test.ts', group: 'ordinary' }]],
    ['assignment project mismatch', discovered, [native], [assignments[0], { ...assignments[1], project: 'unit' }]],
    ['wrong native group', discovered, [native], [assignments[0], { ...assignments[1], group: 'ordinary' }]],
    ['wrong ordinary group', discovered, [native], [{ ...assignments[0], group: 'native' }, assignments[1]]],
    ['unknown group', discovered, [native], [assignments[0], { ...assignments[1], group: 'skipped' }]],
    ['coercible project', discovered, [native], [{ ...assignments[0], project: ['unit'] }, assignments[1]]],
    ['coercible file', discovered, [native], [{ ...assignments[0], file: [unit.file] }, assignments[1]]],
    ['path escape', [{ ...unit, file: 'test/../small.test.ts' }, native], [native], assignments],
    ['extra metadata', [{ ...unit, skipped: true }, native], [native], assignments],
    ['empty discovery', [], [native], []],
  ])('rejects %s', (_label, census, manifest, plan) => {
    expect(() => verifyReleaseTestCoverage(census, manifest, plan)).toThrow('release-test-coverage:');
  });

  it('pins the reviewed nine whole files to their existing real-io project', () => {
    expect(RELEASE_NATIVE_CANDIDATES).toHaveLength(9);
    expect(new Set(RELEASE_NATIVE_CANDIDATES.map((entry: { file: string }) => entry.file)).size).toBe(9);
    expect(RELEASE_NATIVE_CANDIDATES.every((entry: { project: string }) => entry.project === 'real-io')).toBe(true);
    expect(Object.isFrozen(RELEASE_NATIVE_CANDIDATES)).toBe(true);
  });

  it.each(['unit', ''])('real discovery never imports sentinels and closes on success or rejection (project %j)', async (project) => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-release-census-'));
    const marker = join(root, 'imported-marker');
    const closed = join(root, 'closed-marker');
    try {
      mkdirSync(join(root, 'test'));
      const sentinel = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'imported');\nthrow new Error('discovery executed a module');\n`;
      writeFileSync(join(root, 'test', 'sentinel.test.ts'), sentinel);
      writeFileSync(join(root, 'setup.ts'), sentinel);
      writeFileSync(join(root, 'vitest.config.ts'), `import { writeFileSync } from 'node:fs';\nexport default { plugins: [{ name: 'closure-sentinel', closeBundle() { writeFileSync(${JSON.stringify(closed)}, 'closed'); } }], test: { name: ${JSON.stringify(project)}, include: ['test/**/*.test.ts'], setupFiles: ['./setup.ts'] } };\n`);
      if (project) expect(await discoverReleaseTestFiles(root)).toEqual([{ project, file: 'test/sentinel.test.ts' }]);
      else await expect(discoverReleaseTestFiles(root)).rejects.toThrow('default entry invalid');
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(closed)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
