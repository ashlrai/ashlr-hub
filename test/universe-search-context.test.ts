import { describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { buildUniverseFeedback, feedbackReceipt } from '../src/core/universe/feedback.js';
import { buildUniverseSearchContext, searchContextReceipt, validateUniverseSearchContext } from '../src/core/universe/search-context.js';
import type { UniverseRun, UniverseSearchContext, UniverseSummary, UniverseTrial } from '../src/core/universe/types.js';

const A = digest('fixture-artifact-a');
const B = digest('fixture-artifact-b');
const C = digest('fixture-artifact-c');

/** Metadata fixtures only: no provider, worker, evaluator or artifact file is accessed. */
function fixture(direction: 'maximize' | 'minimize' = 'maximize'): UniverseSummary {
  return { manifest: { schemaVersion: 1, id: 'fixture', name: 'Search fixture', objective: 'Improve measured fixture behavior',
    seed: { repo: '/unused/search-fixture', revision: 'a'.repeat(40) }, metric: { name: 'score', direction, minImprovement: 0 },
    budget: { maxTrials: 2, maxParallel: 2, maxDurationMs: 1000, trialTimeoutMs: 1000 },
    evaluation: { command: ['unused-evaluator'], timeoutMs: 1000 },
    variants: [{ id: 'candidate', niche: 'quality', hypothesis: 'Improve the score', generation: {
      kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture', files: ['value.json'], maxOutputTokens: 64 } }] },
  manifestDigest: digest('fixture-manifest'), comparatorDigest: digest('fixture-comparator'),
  runs: [], elites: [], activeRun: null, sourceState: 'healthy', reasons: [] };
}

function record(summary: UniverseSummary, score: number | null, options: {
  artifact?: string | null; trialId?: string; status?: UniverseTrial['status']; runStatus?: UniverseRun['status']; variantId?: string;
} = {}): UniverseTrial {
  const generation = summary.runs.length + 1;
  const variant = summary.manifest.variants.find((item) => item.id === (options.variantId ?? 'candidate'))!;
  const parent = summary.elites.find((item) => item.niche === variant.niche);
  const status = options.status ?? (score === null ? 'failed' : 'passed');
  const runStatus = options.runStatus ?? 'completed';
  const difference = status === 'passed' && runStatus === 'completed' && parent ?
    (summary.manifest.metric.direction === 'maximize' ? 1 : -1) * (score! - parent.score) : null;
  // Durable JSON canonicalizes signed zero before the next historical read.
  const delta = Object.is(difference, -0) ? 0 : difference;
  const selected = status === 'passed' && runStatus === 'completed' &&
    (!parent || delta! > 0 && delta! >= summary.manifest.metric.minImprovement);
  const trial: UniverseTrial = { id: options.trialId ?? `trial-${generation}`, variantId: variant.id, niche: variant.niche,
    parentTrialId: parent?.trialId ?? null, status, score, metrics: {},
    artifact: options.artifact === null ? null : { path: `/unused/run-${generation}/artifact`, digest: options.artifact ?? A,
      revision: summary.manifest.seed.revision }, durationMs: 1, delta, selected };
  const run: UniverseRun = { id: `run-${generation}`, universeId: summary.manifest.id, generation,
    manifestDigest: summary.manifestDigest, comparatorDigest: summary.comparatorDigest, startedAt: '2026-09-07T00:00:00.000Z',
    finishedAt: runStatus === 'running' ? null : '2026-09-07T00:00:01.000Z', status: runStatus,
    trials: [trial], durationMs: 1, tokensUsed: null, costUsd: null };
  summary.runs.push(run);
  if (selected) summary.elites = [...summary.elites.filter((item) => item.niche !== variant.niche), {
    niche: variant.niche, variantId: variant.id, trialId: trial.id, runId: run.id, generation, score: score!, metrics: {},
    artifact: trial.artifact!, comparatorDigest: summary.comparatorDigest }];
  return trial;
}

const build = (summary: UniverseSummary): UniverseSearchContext => buildUniverseSearchContext(summary, summary.manifest.variants[0]!);

describe('pure versioned Universe search context', () => {
  it.each(['maximize', 'minimize'] as const)('supplies %s metric from the first attempt without inventing a seed measurement', (direction) => {
    const summary = fixture(direction); summary.manifest.metric.minImprovement = 0.5;
    const context = build(summary);
    expect(context).toMatchObject({ schemaVersion: 2, generation: 1, universeId: 'fixture', variantId: 'candidate', niche: 'quality',
      metric: { name: 'score', direction, minImprovement: 0.5 }, parent: null, previous: null,
      repetition: { totalAttempts: 0, sampledAttempts: [], truncated: false, latestArtifactDigest: null, matchingArtifactCount: 0 } });
    expect(JSON.stringify(context)).not.toContain('/unused/');
    expect(searchContextReceipt(context)).toEqual({ schemaVersion: 2, digest: digest(canonical(context)) });
  });

  it.each(['maximize', 'minimize'] as const)('separates passing ties from admission and %s improvement', (direction) => {
    const summary = fixture(direction); const first = direction === 'maximize' ? 1 : 9;
    record(summary, first);
    expect(build(summary)).toMatchObject({ parent: { runId: 'run-1', score: first }, previous: { selected: true, delta: null },
      repetition: { totalAttempts: 0, matchingArtifactCount: 0 } });
    record(summary, first);
    expect(build(summary)).toMatchObject({ previous: { selected: false, delta: 0 }, repetition: { totalAttempts: 1, matchingArtifactCount: 1 } });
    record(summary, first);
    expect(build(summary)).toMatchObject({ parent: { runId: 'run-1' }, previous: { runId: 'run-3', selected: false, delta: 0 },
      repetition: { totalAttempts: 2, matchingArtifactCount: 2 } });
    record(summary, first + (direction === 'maximize' ? 1 : -1), { artifact: B });
    expect(build(summary)).toMatchObject({ parent: { runId: 'run-4', artifactDigest: B }, previous: { selected: true, delta: 1 },
      repetition: { totalAttempts: 0, matchingArtifactCount: 0 } });
  });

  it('resolves reused raw trial IDs to full parent occurrences and resets only at the new retained occurrence', () => {
    const summary = fixture();
    record(summary, 1, { trialId: 'shared' }); record(summary, 1);
    record(summary, 2, { trialId: 'shared', artifact: B }); record(summary, 2, { artifact: B });
    const context = build(summary);
    expect(context.parent).toMatchObject({ runId: 'run-3', trialId: 'shared' });
    expect(context.repetition).toMatchObject({ totalAttempts: 1, matchingArtifactCount: 1,
      sampledAttempts: [{ runId: 'run-4', trialId: 'trial-4' }] });
  });

  it('samples only the same variant while accepting a parent retained from another variant', () => {
    const summary = fixture();
    summary.manifest.variants.push({ ...summary.manifest.variants[0]!, id: 'other' });
    record(summary, 1, { variantId: 'other' }); record(summary, 1);
    record(summary, 1, { variantId: 'other' }); record(summary, 1);
    const context = build(summary);
    expect(context.parent).toMatchObject({ runId: 'run-1' });
    expect(context.previous).toMatchObject({ runId: 'run-4' });
    expect(context.repetition.sampledAttempts.map((attempt) => attempt.runId)).toEqual(['run-2', 'run-4']);
    expect(context.repetition.matchingArtifactCount).toBe(2);
  });

  it('does not equate identical recorded bytes with identical evaluator outcomes', () => {
    const summary = fixture(); record(summary, 10); record(summary, 9); record(summary, -1, { status: 'failed' });
    const context = build(summary);
    expect(context.previous).toMatchObject({ status: 'failed', score: -1, selected: false, delta: null });
    expect(context.parent?.score).toBe(10);
    expect(context.repetition.matchingArtifactCount).toBe(2);
  });

  it('retains negative below-threshold delta and rejects a false selection claim', () => {
    const summary = fixture(); summary.manifest.metric.minImprovement = 2;
    record(summary, 4); record(summary, 3);
    expect(build(summary).previous).toMatchObject({ selected: false, delta: -1 });
    record(summary, 5);
    const context = build(summary);
    expect(context.previous).toMatchObject({ selected: false, delta: 1 });
    expect(() => validateUniverseSearchContext({ ...context, previous: { ...context.previous!, selected: true } })).toThrow(/selection semantics/);
  });

  it('excludes incomplete and failed runs from previous-outcome and repetition evidence', () => {
    const summary = fixture(); record(summary, 1); record(summary, 1);
    for (const runStatus of ['interrupted', 'failed', 'running'] as const) record(summary, 2, { runStatus, artifact: B });
    const context = build(summary);
    expect(context.previous?.runId).toBe('run-2'); expect(context.parent?.runId).toBe('run-1');
    expect(context.repetition.totalAttempts).toBe(1);
  });

  it('bounds repetition to the latest16 attempts and reports exact omitted coverage', () => {
    const summary = fixture();
    for (let index = 0; index < 20; index++) record(summary, null, { artifact: index < 4 ? B : A });
    const context = build(summary);
    expect(context.repetition).toMatchObject({ limit: 16, totalAttempts: 20, truncated: true, matchingArtifactCount: 16, latestArtifactDigest: A });
    expect(context.repetition.sampledAttempts.map((attempt) => attempt.generation)).toEqual(Array.from({ length: 16 }, (_, index) => index + 5));
  });

  it('never counts missing artifact digests as matching output', () => {
    const summary = fixture(); record(summary, null); record(summary, null, { artifact: null });
    const context = build(summary);
    expect(context.repetition).toMatchObject({ totalAttempts: 2, latestArtifactDigest: null, matchingArtifactCount: 0 });
    expect(context.previous?.artifactDigest).toBeNull();
  });

  it('counts only matches to the latest sampled digest', () => {
    const summary = fixture();
    for (const artifact of [A, B, A, C, B]) record(summary, null, { artifact });
    expect(build(summary).repetition).toMatchObject({ totalAttempts: 5, latestArtifactDigest: B, matchingArtifactCount: 2 });
  });

  it('returns detached metadata snapshots and omits source text, diagnostics, commands and usage', () => {
    const summary = fixture(); const trial = record(summary, 1);
    trial.diagnostics = [{ code: 'PRIVATE', message: 'private diagnostic text' }]; trial.error = 'private command output';
    const context = build(summary); const original = structuredClone(context);
    summary.manifest.metric.name = 'changed'; trial.score = 999; summary.elites[0]!.score = 999;
    expect(context).toEqual(original);
    const validated = validateUniverseSearchContext(context);
    validated.metric.name = 'mutated'; validated.parent!.score = 999;
    expect(context).toEqual(original);
    expect(JSON.stringify(context)).not.toMatch(/private diagnostic|private command|unused-evaluator|hypothesis|tokensUsed|costUsd/);
  });

  it('preserves permitted metric-name whitespace and control metadata', () => {
    const summary = fixture(); summary.manifest.metric.name = ' score\n\t\u0001 ';
    expect(build(summary).metric.name).toBe(summary.manifest.metric.name);
  });

  it('leaves legacy feedback schema and receipt construction byte-compatible', () => {
    const summary = fixture(); record(summary, null, { artifact: null });
    const legacy = buildUniverseFeedback(summary, summary.manifest.variants[0]!, '/unused/does-not-exist')!;
    const bytes = canonical(legacy); const receipt = feedbackReceipt(legacy);
    build(summary);
    expect(canonical(legacy)).toBe(bytes); expect(feedbackReceipt(legacy)).toEqual(receipt);
    expect(legacy.schemaVersion).toBe(1); expect(receipt).not.toHaveProperty('schemaVersion'); expect(receipt).not.toHaveProperty('search');
  });
});

describe('strict search-context protocol and history validation', () => {
  it.each([
    ['direction', new String('maximize')], ['direction', { toString: () => 'maximize' }],
    ['status', new String('passed')], ['status', { toString: () => 'passed' }],
  ])('rejects object-valued enum %s without coercion', (field, invalid) => {
    const summary = fixture(); record(summary, 1); const context = build(summary);
    const value = field === 'direction' ? { ...context, metric: { ...context.metric, direction: invalid } } :
      { ...context, previous: { ...context.previous!, status: invalid } };
    expect(() => validateUniverseSearchContext(value)).toThrow(/Invalid Universe search context/);
  });

  it.each([
    ['schemaVersion', 1], ['generation', 0], ['generation', 10002], ['variantId', '../escape'],
    ['universeId', 'UPPER'], ['manifestDigest', 'bad'], ['comparatorDigest', null], ['unexpected', true],
  ])('rejects invalid top-level %s', (key, value) => {
    expect(() => validateUniverseSearchContext({ ...build(fixture()), [key]: value })).toThrow(/Invalid Universe search context/);
  });

  it.each([NaN, Infinity, -1])('rejects invalid minImprovement %s', (minImprovement) => {
    const context = build(fixture());
    expect(() => validateUniverseSearchContext({ ...context, metric: { ...context.metric, minImprovement } })).toThrow();
  });

  it.each(['totalAttempts', 'sampledAttempts', 'truncated', 'latestArtifactDigest', 'matchingArtifactCount'] as const)(
    'rejects contradictory repetition %s', (field) => {
      const summary = fixture(); record(summary, null); record(summary, null); const context = build(summary);
      const values = { totalAttempts: 3, sampledAttempts: [...context.repetition.sampledAttempts].reverse(), truncated: true,
        latestArtifactDigest: B, matchingArtifactCount: 1 };
      expect(() => validateUniverseSearchContext({ ...context, repetition: { ...context.repetition, [field]: values[field] } })).toThrow();
    });

  it('rejects sampled occurrences before the current parent or inconsistent with the latest outcome', () => {
    const summary = fixture(); record(summary, 1); record(summary, 1); const context = build(summary);
    expect(() => validateUniverseSearchContext({ ...context, repetition: { ...context.repetition,
      sampledAttempts: [{ ...context.repetition.sampledAttempts[0]!, generation: 1 }] } })).toThrow();
    expect(() => validateUniverseSearchContext({ ...context, previous: { ...context.previous!, trialId: 'different' } })).toThrow();
  });

  it.each(['degraded', 'variant', 'generation-gap', 'run-scope', 'duplicate-run', 'duplicate-variant', 'parent-id', 'elite'] as const)(
    'fails closed on inconsistent %s history', (mode) => {
      const summary = fixture(); record(summary, 1); record(summary, 1);
      if (mode === 'degraded') summary.sourceState = 'degraded';
      if (mode === 'variant') summary.manifest.variants[0] = { ...summary.manifest.variants[0]!, command: ['worker'] } as never;
      if (mode === 'generation-gap') summary.runs[1]!.generation = 3;
      if (mode === 'run-scope') summary.runs[0]!.comparatorDigest = B;
      if (mode === 'duplicate-run') summary.runs[1]!.id = summary.runs[0]!.id;
      if (mode === 'duplicate-variant') summary.runs[1]!.trials.push({ ...summary.runs[1]!.trials[0]!, id: 'extra' });
      if (mode === 'parent-id') summary.runs[1]!.trials[0]!.parentTrialId = 'other';
      if (mode === 'elite') summary.elites[0]!.runId = 'other';
      expect(() => build(summary)).toThrow(/Invalid Universe search context/);
    });

  it('rejects command variants and declared-model configuration drift', () => {
    const summary = fixture();
    expect(() => buildUniverseSearchContext(summary, { id: 'candidate', niche: 'quality', hypothesis: 'Command', command: ['worker'] })).toThrow();
    expect(() => buildUniverseSearchContext(summary, { ...summary.manifest.variants[0]!, hypothesis: 'Different' })).toThrow();
  });
});
