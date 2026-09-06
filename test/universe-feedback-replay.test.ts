import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { buildUniverseFeedback, feedbackReceipt, validateDiagnostics } from '../src/core/universe/feedback.js';
import { assertRunEvidenceBudget, assertTrialEvidenceBudget, MAX_UNIVERSE_RECORD_BYTES, MAX_UNIVERSE_TRIAL_BYTES,
  preflightTrialEvidenceBudget, universeEvidenceBytes } from '../src/core/universe/evidence-size.js';
import { generationResources, newGenerationReceipt } from '../src/core/universe/generation.js';
import { appendRecord, comparatorDigest, newRun, parseEvaluation, projectUniverse, readRecords,
  type ManifestRecord, type UniverseRecord } from '../src/core/universe/store.js';
import type { UniverseDiagnostic, UniverseManifest, UniverseRun, UniverseTrial } from '../src/core/universe/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Real private ledger and source bytes; no worker, provider or evaluator executes. */
function fixture(variantCount = 1, command = false): { directory: string; record: ManifestRecord } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-feedback-replay-')));
  roots.push(root);
  const directory = join(root, 'universes', 'replay');
  const seed = join(directory, 'seed');
  mkdirSync(seed, { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, 'artifacts'), { mode: 0o700 });
  writeFileSync(join(seed, 'value.mjs'), 'export const value = 0;');
  writeFileSync(join(seed, 'evaluate.mjs'), '/* Pinned evaluator identity; not executed by this fixture. */');
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'replay', name: 'Replay fixture', objective: 'Correct fixture behavior',
    seed: { repo: join(root, 'source'), revision: 'a'.repeat(40) }, metric: { name: 'checks', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: variantCount, maxDurationMs: 10_000, trialTimeoutMs: 1_000, maxParallel: 1 },
    evaluation: { command: ['evaluate.mjs'], timeoutMs: 1_000 },
    variants: Array.from({ length: variantCount }, (_, index) => ({ id: `variant-${index}`, niche: `niche-${index}`, hypothesis: 'Fix observed behavior',
      ...(command ? { command: ['worker.mjs'] } : { generation: { kind: 'local-chat' as const, endpoint: 'http://127.0.0.1:11434/v1',
        model: 'fixture', files: ['value.mjs'], maxOutputTokens: 256 } }) })) };
  const partial: Omit<ManifestRecord, 'comparatorDigest'> = { id: 'manifest', kind: 'manifest', manifest,
    manifestDigest: digest(canonical(manifest)), seedArtifact: { path: seed, digest: artifactDigest(seed), revision: manifest.seed.revision },
    evaluationCommand: [join(seed, 'evaluate.mjs')], evaluationExecutableDigest: digest(readFileSync(join(seed, 'evaluate.mjs'))) };
  const record: ManifestRecord = { ...partial, comparatorDigest: comparatorDigest(partial) };
  appendRecord(directory, record);
  return { directory, record };
}

function failedTrial(record: ManifestRecord, index: number, id: string): UniverseTrial {
  const variant = record.manifest.variants[index]!;
  return { id, variantId: variant.id, niche: variant.niche, parentTrialId: null, status: 'failed', score: 0, metrics: {},
    artifact: null, durationMs: 1, delta: null, selected: false,
    ...(variant.generation ? { generation: newGenerationReceipt(variant.generation) } : {}) };
}

function persistRun(directory: string, run: UniverseRun): void {
  const start = { ...run, trials: [], status: 'running' as const, finishedAt: null, durationMs: 0, ...generationResources([], false) };
  delete start.generationUsage;
  appendRecord(directory, { id: `${run.id}.start`, kind: 'start', run: start, ownerPid: process.pid, ownerStart: 'fixture-owner' });
  for (const trial of run.trials) appendRecord(directory, { id: `${run.id}.trial.${trial.id}`, kind: 'trial', runId: run.id, trial });
  appendRecord(directory, { id: `${run.id}.final`, kind: 'final', run });
}

function completeRun(record: ManifestRecord, generation: number, trials: UniverseTrial[]): UniverseRun {
  return { ...newRun(record, generation), status: 'completed', finishedAt: new Date().toISOString(), durationMs: 1, trials,
    ...generationResources(trials, true) };
}

function history(): { directory: string; first: UniverseRun; second: UniverseRun } {
  const { directory, record } = fixture();
  const runs: UniverseRun[] = [];
  for (let generation = 1; generation <= 2; generation++) {
    const trial = failedTrial(record, 0, `trial-${generation}`);
    const run = completeRun(record, generation, [trial]);
    run.feedbackEnabled = true;
    run.campaign = { id: 'campaign', ordinal: generation, definitionDigest: 'b'.repeat(64) };
    const artifact = join(directory, 'artifacts', run.id, trial.id);
    mkdirSync(artifact, { recursive: true, mode: 0o700 });
    writeFileSync(join(artifact, 'value.mjs'), `export const value = ${generation};`);
    trial.artifact = { path: artifact, digest: artifactDigest(artifact), revision: record.manifest.seed.revision };
    trial.diagnostics = [{ code: 'wrong-value', message: `Observed failure ${generation}.`, path: 'value.mjs', line: 1 }];
    Object.assign(trial.generation!, { status: 'succeeded', requestStarted: true, promptDigest: 'c'.repeat(64), responseDigest: 'd'.repeat(64),
      usage: { state: 'reported', inputTokens: 3, outputTokens: 2 }, changedFiles: ['value.mjs'] });
    const previous = buildUniverseFeedback(projectUniverse(directory), record.manifest.variants[0]!, directory);
    if (previous) trial.generation!.feedback = feedbackReceipt(previous);
    Object.assign(run, generationResources(run.trials, true));
    persistRun(directory, run);
    runs.push(run);
  }
  expect(projectUniverse(directory).sourceState).toBe('healthy');
  return { directory, first: runs[0]!, second: runs[1]! };
}

function rewrite(directory: string, record: UniverseRecord): void {
  const path = join(directory, 'ledger', 'records', `${record.id}.json`);
  chmodSync(path, 0o600);
  writeFileSync(path, `${canonical(record)}\n`);
}

function changeTrialAndFinal(directory: string, runId: string, change: (trial: UniverseTrial) => void): void {
  for (const record of readRecords(directory)) {
    if (record.kind === 'trial' && record.runId === runId) { change(record.trial); rewrite(directory, record); }
    if (record.kind === 'final' && record.run.id === runId) { change(record.run.trials[0]!); rewrite(directory, record); }
  }
}

function denseDiagnostics(): UniverseDiagnostic[] {
  const diagnostics = Array.from({ length: 16 }, (_, index) => ({ code: `case-${index}`, message: 'x'.repeat(460) }));
  return validateDiagnostics(diagnostics);
}

describe('durable Universe feedback replay integrity', () => {
  it.each(['changed-digest', 'missing-digest', 'missing-receipt'] as const)('rejects %s even when raw and final trial records agree', (change) => {
    const { directory, second } = history();
    changeTrialAndFinal(directory, second.id, (trial) => {
      if (change === 'changed-digest') trial.generation!.feedback!.digest = 'e'.repeat(64);
      if (change === 'missing-digest') delete (trial.generation!.feedback as Partial<NonNullable<UniverseTrial['generation']>['feedback']>)!.digest;
      if (change === 'missing-receipt') delete trial.generation!.feedback;
    });
    expect(() => projectUniverse(directory)).toThrow(/feedback|evidence unavailable/i);
  });

  it('binds feedback to the actual preceding diagnostics, not just source IDs', () => {
    const { directory, first } = history();
    changeTrialAndFinal(directory, first.id, (trial) => { trial.diagnostics![0]!.message = 'Rewritten preceding outcome'; });
    expect(() => projectUniverse(directory)).toThrow(/feedback digest/);
  });

  it('binds feedback to the preceding source bytes', () => {
    const { directory, first } = history();
    writeFileSync(join(first.trials[0]!.artifact!.path, 'value.mjs'), 'changed after feedback');
    expect(() => projectUniverse(directory)).toThrow(/feedback artifact changed/);
  });

  it.each(['feedbackEnabled', 'campaign-id', 'campaign-ordinal', 'campaign-digest', 'campaign-removed'] as const)(
    'rejects final/start %s mismatch', (change) => {
      const { directory, second } = history();
      const record = readRecords(directory).find((item) => item.kind === 'final' && item.run.id === second.id)!;
      if (record.kind !== 'final') throw new Error('Missing test final');
      if (change === 'feedbackEnabled') delete record.run.feedbackEnabled;
      if (change === 'campaign-id') record.run.campaign!.id = 'another';
      if (change === 'campaign-ordinal') record.run.campaign!.ordinal = 3;
      if (change === 'campaign-digest') record.run.campaign!.definitionDigest = 'e'.repeat(64);
      if (change === 'campaign-removed') delete record.run.campaign;
      rewrite(directory, record);
      expect(() => projectUniverse(directory)).toThrow(/Final run does not match durable trial evidence/);
    });
});

describe('bounded writer evidence with legacy-compatible replay', () => {
  it('admits and reads a complete 64-trial max-diagnostics final above the old 256 KiB limit', () => {
    const { directory, record } = fixture(64, true);
    const diagnostics = denseDiagnostics();
    expect(universeEvidenceBytes(diagnostics)).toBeGreaterThan(7 * 1024);
    const measurement = parseEvaluation(canonical({ passed: false, score: 0, diagnostics }));
    const trials = record.manifest.variants.map((_variant, index) => ({ ...failedTrial(record, index, `trial-${index}`),
      metrics: measurement.metrics, diagnostics: measurement.diagnostics }));
    for (const trial of trials) assertTrialEvidenceBudget(trial);
    const run = completeRun(record, 1, trials);
    const bytes = universeEvidenceBytes({ id: `${run.id}.final`, kind: 'final', run }) + 1;
    expect(bytes).toBeGreaterThan(256 * 1024);
    expect(bytes).toBeLessThan(MAX_UNIVERSE_RECORD_BYTES);
    assertRunEvidenceBudget(run);
    persistRun(directory, run);
    expect(projectUniverse(directory).runs[0]!.trials).toHaveLength(64);
  }, 30_000);

  it('rejects oversized new measurements without mutating or truncating the retained trial', () => {
    const { record } = fixture(1, true);
    const trial = failedTrial(record, 0, 'trial');
    const before = canonical(trial);
    const measurement = { ...trial, diagnostics: denseDiagnostics(),
      metrics: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`metric_${String(index).padStart(2, '0')}_${'m'.repeat(70)}`, Number.MAX_VALUE])),
      error: '\u0001'.repeat(1024) };
    expect(universeEvidenceBytes(measurement)).toBeGreaterThan(MAX_UNIVERSE_TRIAL_BYTES);
    expect(() => assertTrialEvidenceBudget(measurement)).toThrow(/trial evidence/);
    expect(canonical(trial)).toBe(before);
    expect(measurement.diagnostics).toHaveLength(16);
  });

  it('continues reading previously valid version-one trials above the new writer budget', () => {
    const { directory, record } = fixture(1, true);
    const trial = { ...failedTrial(record, 0, 'legacy-trial'), diagnostics: denseDiagnostics(), error: '\u0001'.repeat(1024),
      metrics: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`m${String(index).padStart(2, '0')}${'m'.repeat(77)}`, Number.MAX_VALUE])) };
    expect(universeEvidenceBytes(trial)).toBeGreaterThan(MAX_UNIVERSE_TRIAL_BYTES);
    expect(() => assertTrialEvidenceBudget(trial)).toThrow();
    persistRun(directory, completeRun(record, 1, [trial]));
    expect(projectUniverse(directory).runs[0]!.trials[0]).toEqual(trial);
  });

  it('preflights declared receipt capacity before contact and preserves the original receipt', () => {
    const { record } = fixture();
    const trial = failedTrial(record, 0, 'trial');
    const artifact = { path: '/private/fixture/artifacts/run/trial', digest: 'f'.repeat(64), revision: record.manifest.seed.revision };
    const before = canonical(trial);
    expect(() => preflightTrialEvidenceBudget(trial, { artifact, changedFiles: ['value.mjs'] })).not.toThrow();
    const paths = Array.from({ length: 16 }, (_, index) => `${index}-${'界'.repeat(500)}`);
    expect(() => preflightTrialEvidenceBudget(trial, { artifact, changedFiles: paths })).toThrow(/before execution/);
    expect(canonical(trial)).toBe(before);
    expect(trial.generation!.requestStarted).toBe(false);
  });

  it('rejects a final envelope above one MiB even if handed an unchecked run', () => {
    const { record } = fixture(1, true);
    const run = completeRun(record, 1, [{ ...failedTrial(record, 0, 'trial'), error: 'x'.repeat(MAX_UNIVERSE_RECORD_BYTES) }]);
    expect(() => assertRunEvidenceBudget(run)).toThrow(/1 MiB/);
  });
});
