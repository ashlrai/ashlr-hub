/** Pure seed-receipt eligibility, distinct from delivery's durable/byte custody. */
import { describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { verifiedInitialCampaignRepair } from '../src/core/universe/campaign-improvement.js';
import type { UniverseCampaignSummary, UniverseSummary, UniverseTrial } from '../src/core/universe/types.js';

function fixture() {
  const hash = 'a'.repeat(64); const seedDigest = 'b'.repeat(64); const revision = 'c'.repeat(40);
  const trial: UniverseTrial = { id: 'trial', variantId: 'repair', niche: 'quality', parentTrialId: null, status: 'passed',
    score: 1, metrics: {}, artifact: { path: '/fixture/candidate', digest: 'd'.repeat(64), revision }, durationMs: 5, delta: null, selected: true };
  const universe: UniverseSummary = { manifest: { schemaVersion: 1, id: 'universe', name: 'Fixture', objective: 'Repair',
    seed: { repo: '/fixture/repo', revision }, metric: { name: 'quality', direction: 'maximize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 1000, trialTimeoutMs: 1000 },
    evaluation: { command: ['inert'], timeoutMs: 1000 }, variants: [{ id: 'repair', niche: 'quality', hypothesis: 'Repair', command: ['inert'] }] },
  manifestDigest: hash, comparatorDigest: hash, elites: [], activeRun: null, sourceState: 'healthy', reasons: [], runs: [{
    id: 'run', universeId: 'universe', generation: 1, manifestDigest: hash, comparatorDigest: hash,
    startedAt: '2026-09-10T00:00:03.000Z', finishedAt: '2026-09-10T00:00:04.000Z', status: 'completed', trials: [trial],
    durationMs: 1000, tokensUsed: null, costUsd: null, campaign: { id: 'campaign', ordinal: 1, definitionDigest: hash } }] };
  const campaign: UniverseCampaignSummary = { definition: { schemaVersion: 1, id: 'campaign', universeId: 'universe', feedback: false, measureSeed: true,
    budget: { maxGenerations: 1, maxDurationMs: 10000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } },
  definitionDigest: hash, manifestDigest: hash, comparatorDigest: hash, createdAt: '2026-09-10T00:00:00.000Z',
  startedAt: '2026-09-10T00:00:01.000Z', deadlineAt: '2026-09-10T00:00:11.000Z', finishedAt: '2026-09-10T00:00:05.000Z',
  state: 'completed', reason: 'generation-budget', owner: null, sourceState: 'healthy', reasons: [], steps: [{
    ordinal: 1, runId: 'run', generation: 1, variantIds: ['repair'], reservedModelRequests: 0, createdAt: '2026-09-10T00:00:03.000Z',
    state: 'completed', trialCount: 1, passedTrials: 1, admissions: 1, improvements: 0, tokensUsed: null }],
  progress: { attempts: 1, completedRuns: 1, interruptedRuns: 0, reservedModelRequests: 0, reportedTokens: null, recordedTokens: 0,
    usageComplete: true, admissions: 1, improvements: 0, stagnantGenerations: 0 }, seedEvaluation: {
    intent: { schemaVersion: 1, id: '11111111-1111-4111-8111-111111111111', sessionSequence: 1, definitionDigest: hash,
      manifestDigest: hash, comparatorDigest: hash, seedArtifactDigest: seedDigest, context: 'campaign-seed-v1',
      startedAt: '2026-09-10T00:00:01.000Z', deadlineAt: '2026-09-10T00:00:11.000Z' },
    result: { schemaVersion: 1, intentDigest: '', status: 'measured', finishedAt: '2026-09-10T00:00:02.000Z', durationMs: 1000,
      processGroupSettlement: 'group-exit-confirmed', measurement: { passed: false, score: 0, metrics: {} }, reason: null } } };
  campaign.seedEvaluation!.result!.intentDigest = digest(canonical(campaign.seedEvaluation!.intent));
  return { universe, campaign, trial, seedDigest, proof: () => verifiedInitialCampaignRepair(universe, campaign, trial, seedDigest) };
}

describe('automatic seed measurement repair proof', () => {
  it('returns separate exact intent/result identities without inventing a baseline trial or mutating lineage', () => {
    const f = fixture(); const before = structuredClone([f.universe, f.campaign]); const seed = f.campaign.seedEvaluation!;
    expect(f.proof()).toEqual({ kind: 'seed-evaluation', seedIntentDigest: digest(canonical(seed.intent)),
      seedResultDigest: digest(canonical(seed.result)), baselineArtifactDigest: f.seedDigest, delta: 1 });
    expect([f.universe, f.campaign]).toEqual(before); expect(f.trial.parentTrialId).toBeNull(); expect(f.trial.delta).toBeNull();
  });
  it('applies direction, positive finite delta and the fixed minimum', () => {
    const f = fixture(); f.universe.manifest.metric.direction = 'minimize'; f.trial.score = -1;
    expect(f.proof()?.delta).toBe(1); f.universe.manifest.metric.minImprovement = 1.01; expect(f.proof()).toBeNull();
    f.universe.manifest.metric.minImprovement = 0;
    for (const score of [0, 1, Infinity, NaN]) { f.trial.score = score; expect(f.proof()).toBeNull(); }
  });
  const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['missing opt-in', f => { delete f.campaign.definition.measureSeed; }],
    ['missing measurement', f => { f.campaign.seedEvaluation!.result = null; }],
    ['wrong context', f => { Object.assign(f.campaign.seedEvaluation!.intent, { context: 'foreign' }); }],
    ['wrong session', f => { f.campaign.seedEvaluation!.intent.sessionSequence = 0; }],
    ['wrong campaign', f => { f.campaign.seedEvaluation!.intent.definitionDigest = 'e'.repeat(64); }],
    ['wrong manifest', f => { f.campaign.seedEvaluation!.intent.manifestDigest = 'e'.repeat(64); }],
    ['wrong comparator', f => { f.campaign.seedEvaluation!.intent.comparatorDigest = 'e'.repeat(64); }],
    ['changed seed', f => { f.campaign.seedEvaluation!.intent.seedArtifactDigest = 'e'.repeat(64); }],
    ['changed original deadline', f => { f.campaign.seedEvaluation!.intent.deadlineAt = '2026-09-10T00:00:12.000Z'; }],
    ['before session', f => { f.campaign.seedEvaluation!.intent.startedAt = '2026-09-10T00:00:00.000Z'; }],
    ['unlinked result', f => { f.campaign.seedEvaluation!.result!.intentDigest = 'e'.repeat(64); }],
    ['failed evaluator', f => { f.campaign.seedEvaluation!.result!.status = 'failed'; }],
    ['timed out evaluator', f => { f.campaign.seedEvaluation!.result!.status = 'timed-out'; }],
    ['cancelled evaluator', f => { f.campaign.seedEvaluation!.result!.status = 'cancelled'; }],
    ['not started evaluator', f => { f.campaign.seedEvaluation!.result!.processGroupSettlement = 'not-started'; }],
    ['integrity failure', f => { f.campaign.seedEvaluation!.result!.reason = 'integrity-changed'; }],
    ['null measurement', f => { f.campaign.seedEvaluation!.result!.measurement = null; }],
    ['passing seed', f => { f.campaign.seedEvaluation!.result!.measurement!.passed = true; }],
    ['nonfinite score', f => { f.campaign.seedEvaluation!.result!.measurement!.score = NaN; }],
    ['reversed time', f => { f.campaign.seedEvaluation!.result!.finishedAt = '2026-09-10T00:00:00.000Z'; }],
    ['after candidate', f => { f.campaign.seedEvaluation!.result!.finishedAt = '2026-09-10T00:00:04.000Z'; }],
    ['after first reservation', f => { f.campaign.steps[0]!.createdAt = '2026-09-10T00:00:01.500Z'; }],
    ['invalid duration', f => { f.campaign.seedEvaluation!.result!.durationMs = -1; }],
    ['failed candidate generation', f => { Object.assign(f.trial, { generation: { status: 'failed' } }); }],
    ['foreign candidate session', f => { f.universe.runs[0]!.campaign!.definitionDigest = 'e'.repeat(64); }],
    ['uncompleted candidate step', f => { f.campaign.steps[0]!.state = 'pending'; }],
    ['unselected candidate', f => { f.trial.selected = false; }],
    ['unchanged candidate', f => { f.trial.artifact!.digest = f.seedDigest; }],
    ['fabricated lineage', f => { f.trial.parentTrialId = 'seed-evaluator'; }],
  ];
  it.each(mutations)('refuses %s', (_name, mutate) => {
    const f = fixture(); mutate(f);
    // Refresh the result linkage for intent mutations so each pin is tested
    // independently of the outer digest mismatch.
    if (f.campaign.seedEvaluation?.result && _name !== 'unlinked result') {
      f.campaign.seedEvaluation.result.intentDigest = digest(canonical(f.campaign.seedEvaluation.intent));
    }
    expect(f.proof()).toBeNull();
  });
});
