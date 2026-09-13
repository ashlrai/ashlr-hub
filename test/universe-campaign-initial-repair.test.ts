/** Pure recorded-proof tests: no campaigns, evaluators, providers or artifacts are executed/read. */
import { describe, expect, it } from 'vitest';
import { verifiedInitialCampaignRepair } from '../src/core/universe/campaign-improvement.js';
import type { UniverseCampaignSummary, UniverseGenerationReceipt, UniverseRun, UniverseSummary, UniverseTrial } from '../src/core/universe/types.js';

const seedDigest = 'a'.repeat(64); const changedDigest = 'b'.repeat(64); const revision = 'c'.repeat(40);
function fixture() {
  const baseline: UniverseTrial = { id: 'baseline', variantId: 'seed', niche: 'main', parentTrialId: null,
    status: 'failed', score: 0, metrics: { checked: 142 }, artifact: { path: '/fixture/seed', digest: seedDigest, revision },
    durationMs: 5, delta: null, selected: false, error: 'Fixed evaluator rejected the candidate' };
  const trial: UniverseTrial = { id: 'repair', variantId: 'repair', niche: 'main', parentTrialId: null,
    status: 'passed', score: 1, metrics: { checked: 142 }, artifact: { path: '/fixture/repair', digest: changedDigest, revision },
    durationMs: 5, delta: null, selected: true };
  const run = (id: string, generation: number, value: UniverseTrial): UniverseRun => ({ id, universeId: 'universe', generation,
    manifestDigest: 'd'.repeat(64), comparatorDigest: 'e'.repeat(64), startedAt: `2026-09-10T00:00:0${generation * 2}.000Z`,
    finishedAt: `2026-09-10T00:00:0${generation * 2 + 1}.000Z`, status: 'completed', trials: [value], durationMs: 10,
    tokensUsed: null, costUsd: null, campaign: { id: 'campaign', ordinal: generation, definitionDigest: 'f'.repeat(64) } });
  const universe: UniverseSummary = { manifest: { schemaVersion: 1, id: 'universe', name: 'Fixture', objective: 'Repair measured seed',
    seed: { repo: '/fixture/repo', revision }, metric: { name: 'score', direction: 'maximize', minImprovement: 1 },
    budget: { maxTrials: 1, maxDurationMs: 1000, trialTimeoutMs: 500, maxParallel: 1 },
    evaluation: { command: ['inert'], timeoutMs: 500 }, variants: [
      { id: 'seed', niche: 'main', hypothesis: 'Baseline', command: ['inert'] },
      { id: 'repair', niche: 'main', hypothesis: 'Repair', command: ['inert'] }] },
  manifestDigest: 'd'.repeat(64), comparatorDigest: 'e'.repeat(64), runs: [run('baseline-run', 1, baseline), run('repair-run', 2, trial)],
  elites: [], activeRun: null, sourceState: 'healthy', reasons: [] };
  const campaign: UniverseCampaignSummary = { definition: { schemaVersion: 1, id: 'campaign', universeId: 'universe',
    budget: { maxGenerations: 4, maxDurationMs: 1000, maxModelRequests: 4, maxStagnantGenerations: 2, maxReportedTokens: null }, feedback: false },
  definitionDigest: 'f'.repeat(64), manifestDigest: universe.manifestDigest, comparatorDigest: universe.comparatorDigest,
  createdAt: '2026-09-10T00:00:00.000Z', state: 'completed', reason: 'generation-budget', startedAt: '2026-09-10T00:00:01.000Z',
  deadlineAt: '2026-09-10T00:01:00.000Z', finishedAt: '2026-09-10T00:00:06.000Z',
  steps: universe.runs.map(value => ({ ordinal: value.generation, runId: value.id, generation: value.generation,
    variantIds: value.trials.map(row => row.variantId), reservedModelRequests: 0, createdAt: value.startedAt,
    state: 'completed', trialCount: 1, passedTrials: value.generation === 2 ? 1 : 0,
    admissions: value.generation === 2 ? 1 : 0, improvements: 0, tokensUsed: null })),
  progress: { attempts: 2, completedRuns: 2, interruptedRuns: 0, reservedModelRequests: 0, reportedTokens: null,
    recordedTokens: 0, usageComplete: true, admissions: 1, improvements: 0, stagnantGenerations: 0 },
  owner: null, sourceState: 'healthy', reasons: [] };
  return { universe, campaign, trial, baseline, baselineRun: universe.runs[0]!, candidateRun: universe.runs[1]!,
    proof: () => verifiedInitialCampaignRepair(universe, campaign, trial, seedDigest) };
}
const generation = (status: UniverseGenerationReceipt['status']): UniverseGenerationReceipt => ({ schemaVersion: 1,
  provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:1', model: 'fixture', status, requestStarted: true,
  promptDigest: '1'.repeat(64), responseDigest: '2'.repeat(64), durationMs: 1,
  usage: { state: 'unavailable', inputTokens: null, outputTokens: null }, changedFiles: [] });

describe('verified initial campaign repair', () => {
  it('proves an actual rejected seed to first passed changed artifact without manufacturing lineage', () => {
    const f = fixture(); const before = structuredClone([f.universe, f.campaign]);
    expect(f.proof()).toEqual({ baselineRunId: 'baseline-run', baselineTrialId: 'baseline', baselineArtifactDigest: seedDigest, delta: 1 });
    expect([f.universe, f.campaign]).toEqual(before); expect(f.trial.parentTrialId).toBeNull(); expect(f.trial.delta).toBeNull();
    expect(f.baseline.status).toBe('failed'); expect(f.baseline.selected).toBe(false);
  });
  it('handles minimized metrics and the exact minimum improvement boundary', () => {
    const f = fixture(); f.universe.manifest.metric.direction = 'minimize'; f.baseline.score = 3; f.trial.score = 2;
    expect(f.proof()?.delta).toBe(1); f.universe.manifest.metric.minImprovement = 1.01; expect(f.proof()).toBeNull();
  });
  it('requires succeeded generation evidence when the scheduled variant generates a candidate', () => {
    const f = fixture();
    f.universe.manifest.variants = f.universe.manifest.variants.map(value => ({ id: value.id, niche: value.niche,
      hypothesis: value.hypothesis, generation: { kind: 'local-chat', endpoint: 'http://127.0.0.1:1', model: 'fixture',
        files: ['src/file.ts'], maxOutputTokens: 64 } }));
    f.baseline.generation = generation('succeeded'); f.trial.generation = generation('succeeded');
    for (const step of f.campaign.steps) step.reservedModelRequests = 1;
    expect(f.proof()).not.toBeNull();
    delete f.baseline.generation; expect(f.proof()).toBeNull(); f.baseline.generation = generation('succeeded');
    f.trial.generation.error = 'Generation failed'; expect(f.proof()).toBeNull();
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses nonpositive/nonfinite improvement %s', score => {
    const f = fixture(); f.universe.manifest.metric.minImprovement = 0; f.trial.score = score; expect(f.proof()).toBeNull();
  });
  it('rejects overflow and invalid minimums', () => {
    const f = fixture(); f.baseline.score = -Number.MAX_VALUE; f.trial.score = Number.MAX_VALUE; expect(f.proof()).toBeNull();
    f.baseline.score = 0; f.trial.score = 1;
    for (const minimum of [-1, Number.NaN, Number.POSITIVE_INFINITY]) { f.universe.manifest.metric.minImprovement = minimum; expect(f.proof()).toBeNull(); }
  });
  it.each<Partial<UniverseTrial>>([
    { selected: false }, { status: 'failed' }, { status: 'cancelled' }, { status: 'timed-out' }, { score: null },
    { parentTrialId: 'parent' }, { delta: 1 }, { artifact: null }, { artifact: { path: '/fixture', digest: seedDigest, revision } },
    { artifact: { path: '/fixture', digest: changedDigest, revision: '0'.repeat(40) } }, { error: 'Failed after measurement' },
    { generation: generation('failed') }, { generation: generation('cancelled') },
  ])('refuses candidate evidence mismatch %#', change => { const f = fixture(); Object.assign(f.trial, change); expect(f.proof()).toBeNull(); });
  it.each<Partial<UniverseTrial>>([
    { status: 'passed' }, { status: 'cancelled' }, { status: 'timed-out' }, { score: null }, { score: Number.NaN },
    { error: undefined }, { error: 'Malformed evaluator output' }, { error: 'Evaluator timed out' },
    { artifact: null }, { artifact: { path: '/fixture', digest: changedDigest, revision } },
    { artifact: { path: '/fixture', digest: seedDigest, revision: '0'.repeat(40) } },
    { parentTrialId: 'parent' }, { delta: 0 }, { selected: true }, { niche: 'foreign' },
    { generation: generation('failed') }, { generation: generation('timed-out') }, { generation: generation('cancelled') },
  ])('refuses unmeasured, nonseed or unrelated baseline evidence %#', change => {
    const f = fixture(); Object.assign(f.baseline, change); expect(f.proof()).toBeNull();
  });
  it.each(['baseline', 'candidate'] as const)('requires %s completed run/step and exact campaign/comparator linkage', side => {
    const mutations: Array<(f: ReturnType<typeof fixture>, run: UniverseRun) => void> = [
      (_f, run) => { run.status = 'interrupted'; }, (_f, run) => { run.error = 'failed run'; },
      (_f, run) => { run.campaign!.id = 'foreign'; }, (_f, run) => { run.campaign!.definitionDigest = '0'.repeat(64); },
      (_f, run) => { run.manifestDigest = '0'.repeat(64); }, (_f, run) => { run.comparatorDigest = '0'.repeat(64); },
      (_f, run) => { run.universeId = 'foreign'; }, (_f, run) => { run.finishedAt = null; },
      (_f, run) => { run.startedAt = ''; }, (_f, run) => { run.finishedAt = 'invalid'; },
      (f, run) => { f.campaign.steps.find(step => step.runId === run.id)!.state = 'pending'; },
      (f, run) => { f.campaign.steps.find(step => step.runId === run.id)!.generation += 1; },
      (f, run) => { f.campaign.steps.find(step => step.runId === run.id)!.ordinal += 1; },
      (f, run) => { f.campaign.steps.find(step => step.runId === run.id)!.variantIds = ['foreign']; },
      (f, run) => { f.campaign.steps = f.campaign.steps.filter(step => step.runId !== run.id); },
    ];
    for (const mutate of mutations) {
      const f = fixture(); mutate(f, side === 'baseline' ? f.baselineRun : f.candidateRun); expect(f.proof()).toBeNull();
    }
  });
  it('requires a strictly earlier generation/ordinal with finished time no later than candidate start', () => {
    const f = fixture(); f.baselineRun.finishedAt = f.candidateRun.startedAt; expect(f.proof()).not.toBeNull();
    f.baselineRun.finishedAt = f.candidateRun.finishedAt; expect(f.proof()).toBeNull();
    f.baselineRun.finishedAt = '2026-09-10T00:00:03.000Z'; f.baselineRun.generation = 2; f.campaign.steps[0]!.generation = 2; expect(f.proof()).toBeNull();
  });
  it('requires exact recorded candidate identity and rejects duplicate candidate IDs', () => {
    const f = fixture(); expect(verifiedInitialCampaignRepair(f.universe, f.campaign, { ...f.trial, score: 2 }, seedDigest)).toBeNull();
    f.baselineRun.trials.push(structuredClone(f.trial)); expect(f.proof()).toBeNull();
  });
  it.each(['universe', 'campaign'] as const)('rejects degraded %s evidence', source => {
    const f = fixture(); f[source].sourceState = 'degraded'; expect(f.proof()).toBeNull();
  });
  it('rejects mismatched campaign identity and incomplete campaign without reinterpreting historical failure', () => {
    const f = fixture(); f.campaign.definition.universeId = 'foreign'; expect(f.proof()).toBeNull();
    f.campaign.definition.universeId = 'universe'; f.campaign.state = 'running'; expect(f.proof()).toBeNull();
    f.campaign.state = 'completed'; expect(verifiedInitialCampaignRepair(f.universe, f.campaign, f.trial, 'not-a-digest')).toBeNull();
  });
  it('selects the latest qualifying measured seed deterministically without depending on array order', () => {
    const f = fixture();
    f.universe.manifest.variants = [{ id: 'seed', niche: 'main', hypothesis: 'Fixture', command: ['inert'] }];
    f.trial.variantId = 'seed'; f.campaign.steps[1]!.variantIds = ['seed'];
    const newer = structuredClone(f.baselineRun); newer.id = 'newer-baseline'; newer.generation = 2; newer.campaign!.ordinal = 2;
    newer.trials[0]!.id = 'newer-trial'; newer.startedAt = '2026-09-10T00:00:03.100Z'; newer.finishedAt = '2026-09-10T00:00:03.900Z';
    f.candidateRun.generation = 3; f.candidateRun.campaign!.ordinal = 3; f.campaign.steps[1]!.generation = 3; f.campaign.steps[1]!.ordinal = 3;
    f.campaign.steps.push({ ...f.campaign.steps[0]!, runId: newer.id, ordinal: 2, generation: 2 });
    f.universe.runs.unshift(newer); expect(f.proof()?.baselineTrialId).toBe('newer-trial');
    f.universe.runs.reverse(); expect(f.proof()?.baselineTrialId).toBe('newer-trial');
  });
});
