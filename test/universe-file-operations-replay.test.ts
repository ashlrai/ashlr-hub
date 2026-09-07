import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, canonical, copyArtifact, digest } from '../src/core/universe/artifacts.js';
import { buildUniverseFileOperationsContext, fileOperationsContextDigest } from '../src/core/universe/file-operations-context.js';
import { buildUniverseFeedback, feedbackReceipt } from '../src/core/universe/feedback.js';
import { generationResources, newGenerationReceipt } from '../src/core/universe/generation.js';
import { buildUniverseSearchContext, searchContextReceipt } from '../src/core/universe/search-context.js';
import { appendRecord, comparatorDigest, newRun, projectUniverse, readRecords, selectWinners,
  type ManifestRecord, type UniverseRecord } from '../src/core/universe/store.js';
import type { UniverseFileOperationEvidence } from '../src/core/universe/file-operations-types.js';
import type { UniverseManifest, UniverseRun, UniverseTrial } from '../src/core/universe/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Real immutable private records and artifact bytes; no model/evaluator runs. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-file-replay-'))); roots.push(root);
  const directory = join(root, 'universes', 'file-replay'); const seed = join(directory, 'seed');
  mkdirSync(seed, { recursive: true, mode: 0o700 }); mkdirSync(join(directory, 'artifacts'), { mode: 0o700 });
  writeFileSync(join(seed, 'main.ts'), 'export const value = 0;'); writeFileSync(join(seed, 'obsolete.ts'), 'old helper');
  writeFileSync(join(seed, 'types.ts'), 'export type Value = number;'); writeFileSync(join(seed, 'evaluate.mjs'), '/* pinned, never executed */');
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'file-replay', name: 'File replay fixture', objective: 'Create a helper',
    seed: { repo: join(root, 'source'), revision: 'a'.repeat(40) }, metric: { name: 'quality', direction: 'maximize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10000, trialTimeoutMs: 1000 },
    evaluation: { command: ['evaluate.mjs'], timeoutMs: 1000 }, variants: [{ id: 'candidate', niche: 'quality', hypothesis: 'Extract helper',
      generation: { kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1', model: 'never-contacted', files: ['main.ts', 'helper.ts', 'obsolete.ts'],
        maxOutputTokens: 256, fileOperations: { schemaVersion: 1, contextFiles: ['types.ts'] } } }] };
  const partial = { id: 'manifest' as const, kind: 'manifest' as const, manifest, manifestDigest: digest(canonical(manifest)),
    seedArtifact: { path: seed, digest: artifactDigest(seed), revision: manifest.seed.revision },
    evaluationCommand: [join(seed, 'evaluate.mjs')], evaluationExecutableDigest: digest(readFileSync(join(seed, 'evaluate.mjs'))) };
  const record: ManifestRecord = { ...partial, comparatorDigest: comparatorDigest(partial) }; appendRecord(directory, record);
  return { directory, record };
}

function persist(directory: string, run: UniverseRun): void {
  const start = { ...run, trials: [], status: 'running' as const, finishedAt: null, durationMs: 0, ...generationResources([], false) };
  delete start.generationUsage;
  appendRecord(directory, { id: `${run.id}.start`, kind: 'start', run: start, ownerPid: process.pid, ownerStart: 'fixture-owner' });
  for (const trial of run.trials) appendRecord(directory, { id: `${run.id}.trial.${trial.id}`, kind: 'trial', runId: run.id,
    trial: { ...trial, selected: false, delta: null } });
  appendRecord(directory, { id: `${run.id}.final`, kind: 'final', run });
}

function history({ feedback = true, count = 3, noOp = false }: { feedback?: boolean; count?: number; noOp?: boolean } = {}) {
  const { directory, record } = fixture(); const runs: UniverseRun[] = [];
  for (let index = 0; index < count; index++) {
    const summary = projectUniverse(directory); const variant = record.manifest.variants[0];
    const context = buildUniverseFileOperationsContext(summary, variant, directory, record.seedArtifact, feedback ? { feedback: true } : {});
    const run = { ...newRun(record, index + 1), status: 'completed' as const, finishedAt: new Date().toISOString(), durationMs: 1 };
    if (feedback) { run.feedbackEnabled = true; run.feedbackVersion = 2; }
    const artifactPath = join(directory, 'artifacts', run.id, 'trial'); mkdirSync(join(directory, 'artifacts', run.id), { mode: 0o700 });
    const parent = summary.elites[0]?.artifact ?? record.seedArtifact; copyArtifact(parent.path, artifactPath);
    const operations: UniverseFileOperationEvidence[] = [];
    if (!noOp) {
      const main = 'export { value } from "./helper.js";'; const helper = `export const value = ${index};`;
      const oldMain = readFileSync(join(artifactPath, 'main.ts'), 'utf8');
      if (index < 2) {
        operations.push({ op: 'create', path: 'helper.ts', beforeDigest: null, afterDigest: digest(helper) });
        operations.push({ op: 'replace', path: 'main.ts', beforeDigest: digest(oldMain), afterDigest: digest(main) });
        operations.push({ op: 'delete', path: 'obsolete.ts', beforeDigest: digest('old helper'), afterDigest: null });
        writeFileSync(join(artifactPath, 'main.ts'), main); unlinkSync(join(artifactPath, 'obsolete.ts'));
      } else operations.push({ op: 'replace', path: 'helper.ts', beforeDigest: digest(`export const value = ${index - 1};`), afterDigest: digest(helper) });
      writeFileSync(join(artifactPath, 'helper.ts'), helper);
    }
    const trial: UniverseTrial = { id: 'trial', variantId: variant.id, niche: variant.niche, parentTrialId: summary.elites[0]?.trialId ?? null,
      status: index === 0 && !noOp ? 'failed' : 'passed', score: index, metrics: {},
      artifact: { path: artifactPath, digest: artifactDigest(artifactPath), revision: record.manifest.seed.revision },
      durationMs: 1, selected: false, delta: null, generation: { ...newGenerationReceipt(variant.generation!), status: 'succeeded',
        requestStarted: true, promptDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64), changedFiles: operations.map((operation) => operation.path),
        usage: { state: 'reported', inputTokens: 3, outputTokens: 2 },
        fileOperations: { schemaVersion: 1, contextDigest: fileOperationsContextDigest(context), operations } } };
    if (feedback) {
      const prior = buildUniverseFeedback(summary, variant, directory);
      if (prior) trial.generation!.feedback = feedbackReceipt(prior);
      trial.generation!.search = searchContextReceipt(buildUniverseSearchContext(summary, variant));
    }
    run.trials = [trial]; selectWinners(run, record.manifest, summary.elites); Object.assign(run, generationResources(run.trials));
    persist(directory, run); runs.push(run);
  }
  expect(projectUniverse(directory).sourceState).toBe('healthy'); return { directory, record, runs };
}
function rewrite(directory: string, record: UniverseRecord): void {
  const path = join(directory, 'ledger', 'records', `${record.id}.json`); chmodSync(path, 0o600); writeFileSync(path, `${canonical(record)}\n`);
}
function alter(directory: string, runId: string, transform: (trial: UniverseTrial) => void): void {
  for (const record of readRecords(directory)) {
    if (record.kind === 'trial' && record.runId === runId) { transform(record.trial); rewrite(directory, record); }
    if (record.kind === 'final' && record.run.id === runId) { record.run.trials.forEach(transform); rewrite(directory, record); }
  }
}

describe('file operation provenance durable replay', () => {
  it('replays absent seed -> rejected create -> admitted create -> retained replacement with reused trial IDs', () => {
    const { directory, runs } = history(); const summary = projectUniverse(directory);
    expect(summary.runs.map((run) => run.trials[0].selected)).toEqual([false, true, true]);
    expect(summary.runs[2].trials[0].generation!.fileOperations!.operations).toEqual([
      { op: 'replace', path: 'helper.ts', beforeDigest: digest('export const value = 1;'), afterDigest: digest('export const value = 2;') },
    ]);
    expect(summary.elites[0].runId).toBe(runs[2].id); expect(summary.runs.map((run) => run.tokensUsed)).toEqual([5, 5, 5]);
  });
  it('replays all-no-op operation receipt with no invented changed files', () => {
    const { directory } = history({ count: 1, noOp: true });
    expect(projectUniverse(directory).runs[0].trials[0].generation).toMatchObject({ changedFiles: [], fileOperations: { operations: [] } });
  });
  it('pins current file state with feedback disabled and does not manufacture previous context', () => {
    const { directory, record } = history({ feedback: false });
    const summary = projectUniverse(directory);
    expect(summary.runs.every((run) => !run.feedbackEnabled && !run.trials[0].generation!.feedback)).toBe(true);
    expect(buildUniverseFileOperationsContext(summary, record.manifest.variants[0], directory, record.seedArtifact).previous).toBeNull();
  });
  it.each(['missing-receipt', 'missing-context', 'changed-context', 'before-digest', 'after-digest', 'changed-files', 'unknown-schema'] as const)(
    'rejects synchronized raw/final %s tampering', (change) => {
      const { directory, runs } = history(); alter(directory, runs[2].id, (trial) => {
        if (change === 'missing-receipt') delete trial.generation!.fileOperations;
        if (change === 'missing-context') trial.generation!.fileOperations!.contextDigest = null;
        if (change === 'changed-context') trial.generation!.fileOperations!.contextDigest = 'f'.repeat(64);
        if (change === 'before-digest') trial.generation!.fileOperations!.operations[0].beforeDigest = 'f'.repeat(64);
        if (change === 'after-digest') trial.generation!.fileOperations!.operations[0].afterDigest = 'f'.repeat(64);
        if (change === 'changed-files') trial.generation!.changedFiles = [];
        if (change === 'unknown-schema') Object.assign(trial.generation!.fileOperations!, { schemaVersion: 2 });
      });
      expect(() => projectUniverse(directory)).toThrow(/file|generation|evidence|operation/i);
    });
  it.each(['undeclared-create', 'undeclared-delete', 'readonly-replace', 'mode-only', 'created-executable'] as const)(
    'detects %s even when the attacker updates the recorded artifact digest', (change) => {
      const { directory, runs } = history(); const run = runs[2]; const artifact = run.trials[0].artifact!;
      if (change === 'undeclared-create') writeFileSync(join(artifact.path, 'hidden.ts'), 'undeclared');
      if (change === 'undeclared-delete') unlinkSync(join(artifact.path, 'evaluate.mjs'));
      if (change === 'readonly-replace') writeFileSync(join(artifact.path, 'types.ts'), 'mutated contract');
      if (change === 'mode-only') chmodSync(join(artifact.path, 'main.ts'), 0o700);
      if (change === 'created-executable') chmodSync(join(artifact.path, 'helper.ts'), 0o700);
      const changed = artifactDigest(artifact.path); alter(directory, run.id, (trial) => { trial.artifact!.digest = changed; });
      expect(() => projectUniverse(directory)).toThrow(/file operations/);
    });
  it('does not archive or admit a failed operation generation', () => {
    const { directory, record } = fixture(); const run = { ...newRun(record, 1), status: 'completed' as const, finishedAt: new Date().toISOString(), durationMs: 1 };
    run.trials = [{ id: 'trial', variantId: 'candidate', niche: 'quality', parentTrialId: null, status: 'failed', score: null, metrics: {},
      artifact: null, durationMs: 1, delta: null, selected: false, generation: newGenerationReceipt(record.manifest.variants[0].generation!) }];
    Object.assign(run, generationResources(run.trials)); persist(directory, run);
    expect(projectUniverse(directory).elites).toEqual([]);
    alter(directory, run.id, (trial) => { trial.artifact = record.seedArtifact; });
    expect(() => projectUniverse(directory)).toThrow(/artifact|generation/);
  });
  it('preserves succeeded generation evidence with no artifact after cancellation before evaluation', () => {
    const { directory, runs } = history({ count: 1 });
    alter(directory, runs[0].id, (trial) => { trial.artifact = null; trial.status = 'cancelled'; trial.score = null; });
    const summary = projectUniverse(directory);
    expect(summary.sourceState).toBe('healthy'); expect(summary.elites).toEqual([]);
    expect(summary.runs[0].trials[0].generation!.fileOperations!.operations).toHaveLength(3);
  });
  it('never rewrites ledger bytes while reconstructing contexts and full-tree operation evidence', () => {
    const { directory } = history(); const records = readRecords(directory);
    const paths = records.map((record) => join(directory, 'ledger', 'records', `${record.id}.json`));
    const bytes = paths.map((path) => readFileSync(path, 'utf8'));
    projectUniverse(directory); projectUniverse(directory);
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(bytes);
  });
});
