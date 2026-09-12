/** Pure recorded proof only: no fabricated archive parent or filesystem authority. */
import { describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { verifiedInitialCampaignRepair, verifiedInitialCampaignSeedImprovement } from '../src/core/universe/campaign-improvement.js';
import type { UniverseCampaignSummary, UniverseSummary, UniverseTrial } from '../src/core/universe/types.js';

function fixture() {
  const pin = 'a'.repeat(64), seedDigest = 'b'.repeat(64), revision = 'c'.repeat(40);
  const trial: UniverseTrial = { id: 'trial', variantId: 'candidate', niche: 'verification', parentTrialId: null, delta: null,
    status: 'passed', score: 147, metrics: {}, artifact: { path: '/fixture/candidate', digest: 'd'.repeat(64), revision }, durationMs: 5, selected: true };
  const universe: UniverseSummary = { manifest: { schemaVersion: 1, id: 'universe', name: 'Fixture', objective: 'Improve',
    seed: { repo: '/fixture/repo', revision }, metric: { name: 'preparation_processes', direction: 'minimize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 1000, trialTimeoutMs: 1000 },
    evaluation: { command: ['inert'], timeoutMs: 1000 }, variants: [{ id: 'candidate', niche: 'verification', hypothesis: 'Improve', command: ['inert'] }] },
  manifestDigest: pin, comparatorDigest: pin, elites: [], activeRun: null, sourceState: 'healthy', reasons: [], runs: [{
    id: 'run', universeId: 'universe', generation: 1, manifestDigest: pin, comparatorDigest: pin,
    startedAt: '2026-09-12T00:00:03.000Z', finishedAt: '2026-09-12T00:00:04.000Z', status: 'completed', trials: [trial],
    durationMs: 1000, tokensUsed: null, costUsd: null, campaign: { id: 'campaign', ordinal: 1, definitionDigest: pin } }] };
  const campaign: UniverseCampaignSummary = { definition: { schemaVersion: 1, id: 'campaign', universeId: 'universe', feedback: false, measureSeed: true,
    budget: { maxGenerations: 1, maxDurationMs: 10000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } },
  definitionDigest: pin, manifestDigest: pin, comparatorDigest: pin, createdAt: '2026-09-12T00:00:00.000Z',
  startedAt: '2026-09-12T00:00:01.000Z', deadlineAt: '2026-09-12T00:00:11.000Z', finishedAt: '2026-09-12T00:00:05.000Z',
  state: 'completed', reason: 'generation-budget', owner: null, sourceState: 'healthy', reasons: [], steps: [{
    ordinal: 1, runId: 'run', generation: 1, variantIds: ['candidate'], reservedModelRequests: 0, createdAt: '2026-09-12T00:00:03.000Z',
    state: 'completed', trialCount: 1, passedTrials: 1, admissions: 1, improvements: 0, tokensUsed: null }],
  progress: { attempts: 1, completedRuns: 1, interruptedRuns: 0, reservedModelRequests: 0, reportedTokens: null, recordedTokens: 0,
    usageComplete: true, admissions: 1, improvements: 0, stagnantGenerations: 0 }, seedEvaluation: {
    intent: { schemaVersion: 1, id: '11111111-1111-4111-8111-111111111111', sessionSequence: 1, definitionDigest: pin,
      manifestDigest: pin, comparatorDigest: pin, seedArtifactDigest: seedDigest, context: 'campaign-seed-v1',
      startedAt: '2026-09-12T00:00:01.000Z', deadlineAt: '2026-09-12T00:00:11.000Z' },
    result: { schemaVersion: 1, intentDigest: '', status: 'measured', finishedAt: '2026-09-12T00:00:02.000Z', durationMs: 1000,
      processGroupSettlement: 'group-exit-confirmed', measurement: { passed: true, score: 150, metrics: {} }, reason: null } } };
  campaign.seedEvaluation!.result!.intentDigest = digest(canonical(campaign.seedEvaluation!.intent));
  return { universe, campaign, trial, seedDigest, proof: () => verifiedInitialCampaignSeedImprovement(universe, campaign, trial, seedDigest) };
}

describe('first candidate improvement over a passed measured seed', () => {
  it('proves minimize150 to147 without inventing archive parentage or altering admission counters', () => {
    const f = fixture(), before = canonical({ universe: f.universe, campaign: f.campaign });
    expect(f.proof()).toEqual({ kind: 'passed-seed-evaluation', seedIntentDigest: digest(canonical(f.campaign.seedEvaluation!.intent)),
      seedResultDigest: digest(canonical(f.campaign.seedEvaluation!.result)), baselineArtifactDigest: f.seedDigest, delta: 3 });
    expect(verifiedInitialCampaignRepair(f.universe, f.campaign, f.trial, f.seedDigest)).toBeNull();
    expect(canonical({ universe: f.universe, campaign: f.campaign })).toBe(before);
    expect(f.trial).toMatchObject({ parentTrialId: null, delta: null });
    expect(f.campaign.progress).toMatchObject({ admissions: 1, improvements: 0 });
  });
  it('supports maximize and requires a positive improvement meeting the exact minimum', () => {
    const f = fixture(); f.universe.manifest.metric.direction = 'maximize'; f.trial.score = 153;
    expect(f.proof()?.delta).toBe(3); f.universe.manifest.metric.minImprovement = 3.01; expect(f.proof()).toBeNull();
    f.universe.manifest.metric.minImprovement = 0;
    for (const score of [150, 149, Infinity, NaN]) { f.trial.score = score; expect(f.proof()).toBeNull(); }
  });
  it('keeps failed seed evidence exclusively in the existing repair proof', () => {
    const f = fixture(); f.campaign.seedEvaluation!.result!.measurement!.passed = false;
    expect(f.proof()).toBeNull();
    expect(verifiedInitialCampaignRepair(f.universe, f.campaign, f.trial, f.seedDigest)?.delta).toBe(3);
  });
  const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['missing measureSeed', f => { delete f.campaign.definition.measureSeed; }],
    ['missing result', f => { f.campaign.seedEvaluation!.result = null; }],
    ['wrong context', f => { Object.assign(f.campaign.seedEvaluation!.intent, { context: 'foreign' }); }],
    ['wrong session', f => { f.campaign.seedEvaluation!.intent.sessionSequence = 0; }],
    ['wrong campaign', f => { f.campaign.seedEvaluation!.intent.definitionDigest = 'e'.repeat(64); }],
    ['wrong manifest', f => { f.campaign.seedEvaluation!.intent.manifestDigest = 'e'.repeat(64); }],
    ['wrong comparator', f => { f.campaign.seedEvaluation!.intent.comparatorDigest = 'e'.repeat(64); }],
    ['wrong seed', f => { f.campaign.seedEvaluation!.intent.seedArtifactDigest = 'e'.repeat(64); }],
    ['changed deadline', f => { f.campaign.seedEvaluation!.intent.deadlineAt = '2026-09-12T00:00:12.000Z'; }],
    ['before session', f => { f.campaign.seedEvaluation!.intent.startedAt = '2026-09-12T00:00:00.000Z'; }],
    ['unlinked result', f => { f.campaign.seedEvaluation!.result!.intentDigest = 'e'.repeat(64); }],
    ['failed evaluator', f => { f.campaign.seedEvaluation!.result!.status = 'failed'; }],
    ['timed out evaluator', f => { f.campaign.seedEvaluation!.result!.status = 'timed-out'; }],
    ['cancelled evaluator', f => { f.campaign.seedEvaluation!.result!.status = 'cancelled'; }],
    ['not started evaluator', f => { f.campaign.seedEvaluation!.result!.processGroupSettlement = 'not-started'; }],
    ['unconfirmed evaluator', f => { Object.assign(f.campaign.seedEvaluation!.result!, { processGroupSettlement: 'unconfirmed' }); }],
    ['integrity failure', f => { f.campaign.seedEvaluation!.result!.reason = 'integrity-changed'; }],
    ['null measurement', f => { f.campaign.seedEvaluation!.result!.measurement = null; }],
    ['nonfinite seed score', f => { f.campaign.seedEvaluation!.result!.measurement!.score = NaN; }],
    ['reversed time', f => { f.campaign.seedEvaluation!.result!.finishedAt = '2026-09-12T00:00:00.000Z'; }],
    ['after candidate', f => { f.campaign.seedEvaluation!.result!.finishedAt = '2026-09-12T00:00:04.000Z'; }],
    ['after first reservation', f => { f.campaign.steps[0]!.createdAt = '2026-09-12T00:00:01.500Z'; }],
    ['invalid duration', f => { f.campaign.seedEvaluation!.result!.durationMs = -1; }],
    ['failed generation', f => { Object.assign(f.trial, { generation: { status: 'failed' } }); }],
    ['foreign run', f => { f.universe.runs[0]!.campaign!.definitionDigest = 'e'.repeat(64); }],
    ['uncompleted step', f => { f.campaign.steps[0]!.state = 'pending'; }],
    ['unselected candidate', f => { f.trial.selected = false; }],
    ['unchanged candidate', f => { f.trial.artifact!.digest = f.seedDigest; }],
    ['fabricated parent', f => { f.trial.parentTrialId = 'seed-evaluator'; }],
    ['fabricated delta', f => { f.trial.delta = 3; }],
    ['equal score', f => { f.trial.score = 150; }],
    ['worse score', f => { f.trial.score = 151; }],
    ['below threshold', f => { f.universe.manifest.metric.minImprovement = 4; }],
    ['duplicate recorded trial', f => { f.universe.runs[0]!.trials.push({ ...f.trial }); }],
  ];
  it.each(mutations)('refuses %s', (name, mutate) => {
    const f = fixture(); mutate(f);
    if (f.campaign.seedEvaluation?.result && name !== 'unlinked result') {
      f.campaign.seedEvaluation.result.intentDigest = digest(canonical(f.campaign.seedEvaluation.intent));
    }
    expect(f.proof()).toBeNull();
  });
});
