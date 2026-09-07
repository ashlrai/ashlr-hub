import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { generationResources, newGenerationReceipt } from '../src/core/universe/generation.js';
import { buildUniverseSearchContext, searchContextReceipt } from '../src/core/universe/search-context.js';
import { appendRecord, comparatorDigest, newRun, projectUniverse, readRecords, selectWinners,
  type ManifestRecord, type UniverseRecord } from '../src/core/universe/store.js';
import type { UniverseFeedback, UniverseGenerationConfig, UniverseManifest, UniverseRun, UniverseSearchContext, UniverseTrial } from '../src/core/universe/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const generation: UniverseGenerationConfig = { kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1',
  model: 'never-contacted-fixture', files: ['value.mjs'], maxOutputTokens: 256 };

function fixture(command: boolean, variants: number): { directory: string; manifest: ManifestRecord } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-search-replay-'))); roots.push(root);
  const directory = join(root, 'universes', 'search-replay'); const seed = join(directory, 'seed');
  mkdirSync(seed, { recursive: true, mode: 0o700 }); mkdirSync(join(directory, 'artifacts'), { mode: 0o700 });
  writeFileSync(join(seed, 'value.mjs'), 'export const value = 0;');
  writeFileSync(join(seed, 'evaluate.mjs'), '/* Fixed evaluator identity, never executed. */');
  const definition: UniverseManifest = { schemaVersion: 1, id: 'search-replay', name: 'Search replay fixture', objective: 'Improve measured value',
    seed: { repo: join(root, 'source'), revision: 'a'.repeat(40) }, metric: { name: 'value', direction: 'maximize', minImprovement: 1 },
    budget: { maxTrials: variants, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 1_000 },
    evaluation: { command: ['evaluate.mjs'], timeoutMs: 1_000 },
    variants: Array.from({ length: variants }, (_, index) => ({ id: `variant-${index}`, niche: 'shared', hypothesis: 'Improve one candidate',
      ...(command ? { command: ['worker.mjs'] } : { generation }) })) };
  const partial: Omit<ManifestRecord, 'comparatorDigest'> = { id: 'manifest', kind: 'manifest', manifest: definition,
    manifestDigest: digest(canonical(definition)), seedArtifact: { path: seed, digest: artifactDigest(seed), revision: definition.seed.revision },
    evaluationCommand: [join(seed, 'evaluate.mjs')], evaluationExecutableDigest: digest(readFileSync(join(seed, 'evaluate.mjs'))) };
  const manifest = { ...partial, comparatorDigest: comparatorDigest(partial) };
  appendRecord(directory, manifest); return { directory, manifest };
}

// Deliberately independent of current feedback builder/receipt helpers. This is
// the exact version-one wire object whose old digest must remain replayable.
function frozenLegacyFeedback(run: UniverseRun, trial: UniverseTrial): UniverseFeedback {
  const content = readFileSync(join(trial.artifact!.path, 'value.mjs'), 'utf8');
  return { schemaVersion: 1, source: { runId: run.id, trialId: trial.id, generation: run.generation,
    comparatorDigest: run.comparatorDigest, artifactDigest: trial.artifact!.digest },
  status: trial.status, score: trial.score, metrics: { ...trial.metrics }, diagnostics: [],
  previousAttemptFiles: [{ path: 'value.mjs', contentDigest: digest(content), content }] };
}

function persist(directory: string, run: UniverseRun): void {
  const start = { ...run, trials: [], status: 'running' as const, finishedAt: null, durationMs: 0, ...generationResources([], false) };
  delete start.generationUsage;
  appendRecord(directory, { id: `${run.id}.start`, kind: 'start', run: start, ownerPid: process.pid, ownerStart: 'private-fixture-owner' });
  for (const trial of run.trials) appendRecord(directory, { id: `${run.id}.trial.${trial.id}`, kind: 'trial', runId: run.id,
    trial: { ...trial, selected: false, delta: null } });
  appendRecord(directory, { id: `${run.id}.final`, kind: 'final', run });
}

function history({ version = 2, feedback = true, command = false, variants = 1, values = [1, 1, 2] }:
  { version?: 1 | 2; feedback?: boolean; command?: boolean; variants?: number; values?: number[] } = {}) {
  const { directory, manifest } = fixture(command, variants);
  const runs: UniverseRun[] = []; const contexts: UniverseSearchContext[][] = [];
  for (const [index, value] of values.entries()) {
    const summary = projectUniverse(directory);
    const run = { ...newRun(manifest, index + 1), status: 'completed' as const, finishedAt: new Date().toISOString(), durationMs: 1 };
    if (feedback) { run.feedbackEnabled = true; if (version === 2) run.feedbackVersion = 2; }
    const row: UniverseSearchContext[] = [];
    run.trials = manifest.manifest.variants.map((variant, ordinal) => {
      const artifact = join(directory, 'artifacts', run.id, `trial-${index + 1}-${ordinal}`);
      mkdirSync(artifact, { recursive: true, mode: 0o700 }); writeFileSync(join(artifact, 'value.mjs'), `export const value = ${value};`);
      const trial: UniverseTrial = { id: `trial-${index + 1}-${ordinal}`, variantId: variant.id, niche: variant.niche,
        parentTrialId: summary.elites.find((elite) => elite.niche === variant.niche)?.trialId ?? null,
        status: 'passed', score: value, metrics: { value }, artifact: { path: artifact, digest: artifactDigest(artifact), revision: manifest.manifest.seed.revision },
        durationMs: 1, selected: false, delta: null };
      if (variant.generation) {
        trial.generation = { ...newGenerationReceipt(variant.generation), status: 'succeeded', requestStarted: true,
          promptDigest: 'c'.repeat(64), responseDigest: 'd'.repeat(64), changedFiles: ['value.mjs'],
          usage: { state: 'reported', inputTokens: 3, outputTokens: 2 } };
        const prior = runs.at(-1);
        if (feedback && prior) {
          const old = frozenLegacyFeedback(prior, prior.trials[ordinal]!);
          trial.generation.feedback = { ...old.source, digest: digest(canonical(old)) };
        }
        if (feedback && version === 2) {
          const context = buildUniverseSearchContext(summary, variant); row.push(context);
          trial.generation.search = searchContextReceipt(context);
        }
      }
      return trial;
    });
    selectWinners(run, manifest.manifest, summary.elites);
    Object.assign(run, generationResources(run.trials, true));
    persist(directory, run); runs.push(run); contexts.push(row);
  }
  expect(projectUniverse(directory).sourceState).toBe('healthy');
  return { directory, manifest, runs, contexts };
}

function rewrite(directory: string, record: UniverseRecord): void {
  const path = join(directory, 'ledger', 'records', `${record.id}.json`);
  chmodSync(path, 0o600); writeFileSync(path, `${canonical(record)}\n`);
}
function alterTrials(directory: string, runId: string, transform: (trial: UniverseTrial) => void): void {
  for (const record of readRecords(directory)) {
    if (record.kind === 'trial' && record.runId === runId) { transform(record.trial); rewrite(directory, record); }
    if (record.kind === 'final' && record.run.id === runId) {
      for (const trial of record.run.trials) transform(trial);
      Object.assign(record.run, generationResources(record.run.trials, true)); rewrite(directory, record);
    }
  }
}
function alterRuns(directory: string, runId: string, transform: (run: UniverseRun) => void): void {
  for (const record of readRecords(directory)) if ((record.kind === 'start' || record.kind === 'final') && record.run.id === runId) {
    transform(record.run); rewrite(directory, record);
  }
}

describe('versioned Universe search context durable replay', () => {
  it('replays frozen version-one feedback and records without adding fields or rewriting bytes', () => {
    const { directory, runs } = history({ version: 1 });
    const records = readRecords(directory);
    const bytes = records.map((record) => readFileSync(join(directory, 'ledger', 'records', `${record.id}.json`), 'utf8'));
    const summary = projectUniverse(directory);
    expect(summary.runs).toEqual(runs);
    expect(summary.runs.every((run) => run.feedbackVersion === undefined && run.trials.every((trial) => trial.generation!.search === undefined))).toBe(true);
    expect(records.map((record) => readFileSync(join(directory, 'ledger', 'records', `${record.id}.json`), 'utf8'))).toEqual(bytes);
  });

  it('replays distinct sibling contexts against the prior archive, not a same-generation winner', () => {
    const { directory, runs, contexts } = history({ variants: 2, values: [1, 2] });
    const previous = runs[0]!.trials.find((trial) => trial.selected)!;
    expect(runs[1]!.trials[0]!.selected).toBe(true);
    expect(contexts[1]!.map((context) => context.parent!.trialId)).toEqual([previous.id, previous.id]);
    expect(contexts[1]!.map((context) => context.previous!.selected)).toEqual([true, false]);
    expect(projectUniverse(directory).runs).toEqual(runs);
  });

  it.each(['missing', 'unknown', 'changed-digest'] as const)('rejects %s search receipt even when raw and final trial records agree', (change) => {
    const { directory, runs } = history();
    alterTrials(directory, runs[2]!.id, (trial) => {
      if (change === 'missing') delete trial.generation!.search;
      else if (change === 'unknown') Object.assign(trial.generation!.search!, { schemaVersion: 3 });
      else trial.generation!.search!.digest = 'e'.repeat(64);
    });
    expect(() => projectUniverse(directory)).toThrow(/search|evidence unavailable/i);
  });

  it.each(['missing-final', 'missing-both', 'unknown', 'nonfeedback'] as const)('rejects %s run search-version mutation', (change) => {
    const { directory, runs } = history(); const id = runs[2]!.id;
    if (change === 'missing-final') {
      const record = readRecords(directory).find((record) => record.kind === 'final' && record.run.id === id)!;
      if (record.kind !== 'final') throw new Error('Missing fixture final');
      delete record.run.feedbackVersion; rewrite(directory, record);
    } else alterRuns(directory, id, (run) => {
      if (change === 'missing-both') delete run.feedbackVersion;
      if (change === 'unknown') Object.assign(run, { feedbackVersion: 3 });
      if (change === 'nonfeedback') delete run.feedbackEnabled;
    });
    expect(() => projectUniverse(directory)).toThrow(/search|feedback|Final run|evidence unavailable/i);
  });

  it.each(['metric-direction', 'metric-threshold', 'parent-occurrence', 'parent-score', 'previous-selected',
    'previous-delta', 'repeat-count', 'repeat-source', 'variant', 'manifest'] as const)(
    'binds search receipt digest to actual historical %s', (change) => {
      const { directory, runs, contexts } = history();
      const context = structuredClone(contexts[2]![0]!);
      if (change === 'metric-direction') context.metric.direction = 'minimize';
      if (change === 'metric-threshold') context.metric.minImprovement = 2;
      if (change === 'parent-occurrence') context.parent!.runId = runs[1]!.id;
      if (change === 'parent-score') context.parent!.score = 20;
      if (change === 'previous-selected') context.previous!.selected = true;
      if (change === 'previous-delta') context.previous!.delta = 1;
      if (change === 'repeat-count') context.repetition.matchingArtifactCount++;
      if (change === 'repeat-source') context.repetition.sampledAttempts[0]!.trialId = runs[0]!.trials[0]!.id;
      if (change === 'variant') context.variantId = 'another-variant';
      if (change === 'manifest') context.manifestDigest = 'e'.repeat(64);
      alterTrials(directory, runs[2]!.id, (trial) => { trial.generation!.search!.digest = digest(canonical(context)); });
      expect(() => projectUniverse(directory)).toThrow(/search/i);
    });

  it('rejects feedback provenance relabeled to an older nonpreceding attempt', () => {
    const { directory, runs } = history();
    alterTrials(directory, runs[2]!.id, (trial) => { trial.generation!.feedback!.trialId = runs[0]!.trials[0]!.id; });
    expect(() => projectUniverse(directory)).toThrow(/preceding completed variant outcome/);
  });

  it.each([false, true])('rejects forged search receipts on a nonfeedback run (command=%s)', (command) => {
    const { directory, runs } = history({ feedback: false, command, values: [1] });
    alterTrials(directory, runs[0]!.id, (trial) => {
      trial.generation ??= { ...newGenerationReceipt(generation), status: 'succeeded', requestStarted: true,
        promptDigest: 'c'.repeat(64), responseDigest: 'd'.repeat(64), usage: { state: 'reported', inputTokens: 3, outputTokens: 2 }, changedFiles: ['value.mjs'] };
      trial.generation.search = { schemaVersion: 2, digest: 'e'.repeat(64) };
    });
    expect(() => projectUniverse(directory)).toThrow(/search|Command trial/i);
  });
});
