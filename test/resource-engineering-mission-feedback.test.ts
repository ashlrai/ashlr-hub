/** Pure synthetic projections, not genuine campaign or model acceptance. */
import { describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { MAX_MISSION_FEEDBACK_BYTES, projectEngineeringMissionFeedback } from '../src/core/resources/engineering-mission-feedback.js';
import type { ResourceEngineeringOutcomes } from '../src/core/resources/engineering-outcomes-types.js';

function fixture() {
  const usage = { attempts: 1, joinedAttempts: 1, reportedAttempts: 1, unknownAttempts: 0, recordedInputTokens: 10,
    recordedOutputTokens: 5, totalTokens: 15, complete: true };
  const timing = { scope: 'summed-worker-execution' as const, attempts: 1, measuredAttempts: 1,
    recordedDurationMs: 100, totalDurationMs: 100, complete: true };
  const outcomes: Omit<ResourceEngineeringOutcomes, 'sampledAt'> = { schemaVersion: 1, enrollmentId: 'tip', enrollmentDigest: 'a'.repeat(64),
    sourceState: 'healthy', scope: 'campaign-evaluations-and-recorded-worker-usage', authority: 'observation-only',
    acceptanceScope: 'fixed-evaluator-and-local-branch-only', attribution: 'campaign-cumulative-not-graph-invocation',
    productionAccepted: null, routingChanged: false, complete: true, reasons: [], usage, timing,
    campaigns: [{ campaignId: 'campaign', universeId: 'universe', definitionDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64),
      sourceState: 'healthy', reasons: [], state: 'completed', metric: { name: 'processes', direction: 'minimize', minImprovement: 1 },
      seed: { status: 'measured', score: 150, passed: true },
      stages: { trials: 1, evaluated: 1, passed: 1, rejected: 0, selected: 1, strictImprovements: 0, verifiedLocalDeliveries: 1 },
      usage: { ...usage }, timing: { ...timing }, workers: [], niches: [{ niche: 'verification', score: 149, deltaFromSeed: 1,
        artifactDigest: 'd'.repeat(64), runId: 'run', trialId: 'trial' }] }] };
  return { tip: { enrollmentId: 'tip', enrollmentDigest: 'a'.repeat(64), projectId: 'hub', commit: 'e'.repeat(40) },
    deliveryDigest: 'f'.repeat(64), outcomes };
}
describe('bounded measured mission proposal context', () => {
  it('binds exact delivered source and separate comparator evidence without claiming product acceptance', () => {
    const input = fixture(); const before = structuredClone(input); const result = projectEngineeringMissionFeedback(input);
    expect(result).toMatchObject({ availability: 'available', authority: 'observation-only', productionAccepted: null, routingChanged: false,
      source: { ...input.tip, deliveryDigest: input.deliveryDigest }, evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.campaigns[0]).toMatchObject({ comparatorDigest: 'c'.repeat(64), seed: { score: 150 },
      selected: [{ score: 149, deltaFromSeed: 1 }], usage: { coverage: 'complete', totalTokens: 15 }, timing: { totalDurationMs: 100 } });
    expect(input).toEqual(before); expect(result.campaigns[0]?.metric).not.toBe(input.outcomes.campaigns[0]?.metric);
  });
  it('keeps unknown token and worker timing coverage null, not zero yield', () => {
    const input = fixture(); const row = input.outcomes.campaigns[0]!;
    input.outcomes.sourceState = 'degraded'; input.outcomes.complete = false;
    row.usage.complete = false; row.usage.reportedAttempts = 0; row.usage.unknownAttempts = 1; row.usage.totalTokens = null;
    row.timing.complete = false; row.timing.totalDurationMs = null;
    const result = projectEngineeringMissionFeedback(input);
    expect(result.availability).toBe('available');
    expect(result.campaigns[0]).toMatchObject({ usage: { coverage: 'incomplete', totalTokens: null },
      timing: { scope: 'summed-worker-execution', coverage: 'incomplete', totalDurationMs: null } });
    expect(canonical(result)).not.toMatch(/yield|tokensPer|ranking/);
  });
  it('retains unmeasured seed as unknown and preserves failed measurement facts', () => {
    const input = fixture(); const row = input.outcomes.campaigns[0]!;
    row.seed = { status: 'unmeasured', score: null, passed: null }; row.niches[0]!.deltaFromSeed = null;
    expect(projectEngineeringMissionFeedback(input).campaigns[0]?.seed).toEqual(row.seed);
    row.seed = { status: 'measured', score: 9, passed: false };
    expect(projectEngineeringMissionFeedback(input).campaigns[0]?.seed).toEqual(row.seed);
  });
  it.each(['enrollmentId', 'enrollmentDigest', 'sourceState', 'productionAccepted', 'authority'] as const)('refuses mismatched %s instead of inventing metrics', key => {
    const input = fixture(); Object.assign(input.outcomes, { [key]: key === 'productionAccepted' ? true : 'wrong' });
    const result = projectEngineeringMissionFeedback(input);
    expect(result).toMatchObject({ availability: 'unavailable', evidenceDigest: null, campaigns: [] });
  });
  it.each(['comparator', 'usage', 'timing', 'seed', 'delivery'] as const)('refuses malformed %s facts', key => {
    const input = fixture(); const row = input.outcomes.campaigns[0]!;
    if (key === 'comparator') row.comparatorDigest = 'bad';
    if (key === 'usage') row.usage.totalTokens = -1;
    if (key === 'timing') row.timing.totalDurationMs = -1;
    if (key === 'seed') row.seed.score = Infinity;
    if (key === 'delivery') row.stages.verifiedLocalDeliveries = null;
    if (key === 'seed') expect(() => projectEngineeringMissionFeedback(input)).toThrow('Mission feedback unavailable');
    else expect(projectEngineeringMissionFeedback(input)).toMatchObject({ availability: 'unavailable', campaigns: [] });
  });
  it('excludes timestamps, worker model strings, paths and unrelated fields from projection identity', () => {
    const input = fixture(); const first = projectEngineeringMissionFeedback(input);
    Object.assign(input.outcomes, { sampledAt: '2099-01-01T00:00:00.000Z', privatePath: '/private/secret' });
    Object.assign(input.outcomes.campaigns[0]!.metric!, { secret: '/private/secret' });
    Object.assign(input.outcomes.campaigns[0]!.stages, { secret: '/private/secret' });
    expect(projectEngineeringMissionFeedback(input)).toEqual(first);
    expect(canonical(first)).not.toContain('/private/secret');
  });
  it.each(['score', 'tokens', 'comparator', 'delivery'] as const)('changes deterministic proposal evidence for changed %s', key => {
    const input = fixture(); const first = projectEngineeringMissionFeedback(input);
    if (key === 'score') input.outcomes.campaigns[0]!.niches[0]!.score--;
    if (key === 'tokens') input.outcomes.campaigns[0]!.usage.totalTokens!++;
    if (key === 'comparator') input.outcomes.campaigns[0]!.comparatorDigest = '1'.repeat(64);
    if (key === 'delivery') input.deliveryDigest = '1'.repeat(64);
    expect(projectEngineeringMissionFeedback(input).evidenceDigest).not.toBe(first.evidenceDigest);
  });
  it('bounds detailed context and returns explicit unavailable without partial numeric summaries', () => {
    const input = fixture(); const campaign = input.outcomes.campaigns[0]!;
    input.outcomes.campaigns = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(campaign), campaignId: `campaign-${index}` }));
    const result = projectEngineeringMissionFeedback(input);
    expect(result).toMatchObject({ availability: 'unavailable', reason: 'feedback-bounds-exceeded', evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/), campaigns: [] });
    expect(Buffer.byteLength(canonical(result))).toBeLessThan(MAX_MISSION_FEEDBACK_BYTES);
    input.outcomes.campaigns[0]!.niches[0]!.score--;
    expect(projectEngineeringMissionFeedback(input).evidenceDigest).not.toBe(result.evidenceDigest);
  });
  it('retains partial measurement facts and changes identity before coverage is complete', () => {
    const input = fixture(); const row = input.outcomes.campaigns[0]!;
    Object.assign(row.usage, { attempts: 2, joinedAttempts: 2, reportedAttempts: 1, unknownAttempts: 1, complete: false, totalTokens: null });
    Object.assign(row.timing, { attempts: 2, measuredAttempts: 0, recordedDurationMs: 0, complete: false, totalDurationMs: null });
    const first = projectEngineeringMissionFeedback(input);
    Object.assign(row.timing, { measuredAttempts: 1, recordedDurationMs: 500 });
    const second = projectEngineeringMissionFeedback(input);
    expect(second.campaigns[0]?.timing).toMatchObject({ coverage: 'incomplete', attempts: 2, measuredAttempts: 1, recordedDurationMs: 500, totalDurationMs: null });
    expect(second.evidenceDigest).not.toBe(first.evidenceDigest);
    row.usage.recordedInputTokens++;
    const third = projectEngineeringMissionFeedback(input);
    expect(third.campaigns[0]?.usage).toMatchObject({ coverage: 'incomplete', recordedInputTokens: 11, recordedOutputTokens: 5, totalTokens: null });
    expect(third.evidenceDigest).not.toBe(second.evidenceDigest);
  });
  it('does not execute accessors in caller data', () => {
    const input = fixture(); const getter = vi.fn(() => input.outcomes);
    const hostile = Object.defineProperty({ ...input }, 'outcomes', { enumerable: true, get: getter });
    expect(() => projectEngineeringMissionFeedback(hostile)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['reported', 'unknown', 'sum', 'measured', 'duration', 'attempts'] as const)('never labels contradictory %s coverage complete', key => {
    const input = fixture(); const row = input.outcomes.campaigns[0]!;
    if (key === 'reported') { row.usage.reportedAttempts = 0; row.usage.unknownAttempts = 1; }
    if (key === 'unknown') row.usage.unknownAttempts = 1;
    if (key === 'sum') row.usage.totalTokens = 999;
    if (key === 'measured') row.timing.measuredAttempts = 0;
    if (key === 'duration') row.timing.totalDurationMs = 999;
    if (key === 'attempts') row.timing.attempts = -1;
    expect(projectEngineeringMissionFeedback(input)).toMatchObject({ availability: 'unavailable', evidenceDigest: null, campaigns: [] });
  });
});
