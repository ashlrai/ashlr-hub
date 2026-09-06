import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runUniverseDemo } from '../src/cli/universe-demo.js';
import { readUniverseOverview } from '../src/core/universe/index.js';
import { artifactDigest } from '../src/core/universe/artifacts.js';

const fixtures: string[] = [];

// Archived directories are intentionally read-only. Restore permissions only
// inside this test's generated root so normal cleanup can remove its fixtures.
function restoreDirectoryWrites(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) restoreDirectoryWrites(join(path, name));
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    restoreDirectoryWrites(fixture);
    rmSync(fixture, { recursive: true, force: true });
  }
});

// This integration proof exercises the actual macOS sandbox, local Git seed,
// candidate processes, independent evaluator, and durable archive. Additional
// platforms require independently verified isolation before this proof applies.
describe.runIf(process.platform === 'darwin')('Universe executable demo', () => {
  it('evaluates real artifacts and uses niche elites as second-generation parents', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'ashlr-universe-demo-'));
    fixtures.push(root);
    const result = await runUniverseDemo({ root });
    expect(result.measurementScope).toBe('local-experiment');
    expect(result.verified, JSON.stringify(result)).toBe(true);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.runs).toHaveLength(2);
    const [first, second] = result.runs;
    expect(first!.generation).toBe(1);
    expect(second!.generation).toBe(2);
    expect(first!.manifestDigest).toBe(second!.manifestDigest);
    expect(first!.comparatorDigest).toBe(second!.comparatorDigest);

    for (const run of result.runs) {
      expect(run.status).toBe('completed');
      expect(run.tokensUsed).toBeNull();
      expect(run.costUsd).toBeNull();
      expect(run.trials).toHaveLength(3);
      const rejected = run.trials.find((trial) => trial.variantId === 'broken');
      expect(rejected?.status).toBe('failed');
      expect(rejected?.selected).toBe(false);
      expect(run.trials.filter((trial) => trial.selected).map((trial) => trial.niche).sort())
        .toEqual(['compact', 'readable']);
      for (const trial of run.trials.filter((item) => item.selected)) {
        expect(trial.status).toBe('passed');
        expect(trial.metrics.casesPassed).toBe(7);
        expect(trial.artifact).not.toBeNull();
        const measured = readFileSync(join(trial.artifact!.path, 'solution.mjs')).byteLength;
        expect(trial.score).toBe(measured);
        expect(trial.metrics.artifactBytes).toBe(measured);
        expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
      }
    }

    expect(first!.trials.every((trial) => trial.parentTrialId === null)).toBe(true);
    for (const trial of second!.trials) {
      const parent = first!.trials.find((candidate) => candidate.selected && candidate.niche === trial.niche);
      expect(trial.parentTrialId).toBe(parent?.id);
      if (trial.selected) {
        expect(trial.score!).toBeLessThan(parent!.score!);
        expect(trial.delta).toBe(parent!.score! - trial.score!);
      }
    }

    const overview = readUniverseOverview({ root });
    expect(overview.sourceState).toBe('healthy');
    expect(overview.universes).toHaveLength(1);
    const saved = overview.universes[0]!;
    expect(saved.manifest.id).toBe(result.universeId);
    expect(saved.activeRun).toBeNull();
    expect(saved.runs).toEqual(result.runs);
    expect(saved.elites.map((elite) => elite.niche).sort()).toEqual(['compact', 'readable']);
    for (const elite of saved.elites) {
      expect(elite.generation).toBe(2);
      expect(elite.runId).toBe(second!.id);
      expect(elite.comparatorDigest).toBe(second!.comparatorDigest);
      expect(elite.trialId).toBe(second!.trials.find((trial) => trial.selected && trial.niche === elite.niche)?.id);
    }
    expect(readFileSync(join(result.seedRepo, 'solution.mjs'), 'utf8'))
      .toBe('export default values => values;\n');
  });
});
