import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceEngineeringOutcomes as Outcomes } from '../../core/resources/engineering-outcomes-types.js';
import { apiGet, apiPost } from './client.js';
import { readWorkspaceEngineeringOutcomes, validateWorkspaceEngineeringOutcomes } from './workspace-engineering-outcomes.js';
import { engineeringEnrollment } from '../routes/workspace/engineering-fixture.test-support.js';
vi.mock('./client.js', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const selected = engineeringEnrollment();
const usage = () => ({ attempts: 1, joinedAttempts: 1, reportedAttempts: 1, unknownAttempts: 0, recordedInputTokens: 20, recordedOutputTokens: 10, totalTokens: 30, complete: true });
const timing = () => ({ scope: 'summed-worker-execution' as const, attempts: 1, measuredAttempts: 1, recordedDurationMs: 125, totalDurationMs: 125, complete: true });
function fixture(): Outcomes {
  return { schemaVersion: 1, enrollmentId: selected.id, enrollmentDigest: selected.enrollmentDigest, sampledAt: '2026-09-11T00:00:00.000Z', sourceState: 'healthy',
    scope: 'campaign-evaluations-and-recorded-worker-usage', authority: 'observation-only', acceptanceScope: 'fixed-evaluator-and-local-branch-only',
    attribution: 'campaign-cumulative-not-graph-invocation', productionAccepted: null, routingChanged: false, complete: true, reasons: [], usage: usage(), timing: timing(),
    campaigns: [{ campaignId: selected.campaigns[0]!.id, universeId: 'integer', definitionDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), state: 'completed', sourceState: 'healthy', reasons: [],
      metric: { name: 'value', direction: 'maximize', minImprovement: 1 }, seed: { status: 'measured', score: 0, passed: false },
      stages: { trials: 1, evaluated: 1, passed: 1, rejected: 0, selected: 1, strictImprovements: 0, verifiedLocalDeliveries: 1 }, usage: usage(), timing: timing(),
      niches: [{ niche: 'integer', score: 3, deltaFromSeed: 3, artifactDigest: 'd'.repeat(64), runId: 'run-1', trialId: 'trial-1' }],
      workers: [{ workerId: 'local', provider: 'local', model: 'fixture', evaluated: 1, passed: 1, rejected: 0, usage: usage(), timing: timing() }] }] };
}
beforeEach(() => vi.clearAllMocks());
describe('engineering outcome read boundary', () => {
  it('reads the exact enrollment with read authority only and does not mutate input', async () => {
    const value = fixture(); const before = JSON.stringify(value); const abort = new AbortController();
    vi.mocked(apiGet).mockResolvedValue(value);
    await expect(readWorkspaceEngineeringOutcomes(selected, abort.signal)).resolves.toEqual(value);
    expect(apiGet).toHaveBeenCalledWith('/api/resources/engineering/default-build/outcomes', abort.signal);
    expect(apiPost).not.toHaveBeenCalled(); expect(JSON.stringify(value)).toBe(before);
  });
  it.each([{ schemaVersion: 2 }, { enrollmentId: 'another' }, { enrollmentDigest: 'f'.repeat(64) }, { productionAccepted: 1 },
    { routingChanged: true }, { attribution: 'graph-invocation' }, { sourceState: 'ready' }, { extra: '/private/root' }, { sampledAt: 'tomorrow' },
    { reasons: ['token=private-error'] }, { campaigns: [] }, { sourceState: 'degraded' }])('rejects malformed, private or overclaimed top-level evidence %j', patch => {
    expect(() => validateWorkspaceEngineeringOutcomes({ ...fixture(), ...patch }, selected)).toThrow('could not be verified');
  });
  it.each([{ totalTokens: 900 }, { reportedAttempts: 2 }, { joinedAttempts: 0 }, { unknownAttempts: 1 }, { recordedInputTokens: -1 },
    { complete: false }, { totalTokens: Infinity }, { extra: true }])('rejects inconsistent usage %j', patch => {
    const value = fixture(); Object.assign(value.usage, patch);
    expect(() => validateWorkspaceEngineeringOutcomes(value, selected)).toThrow('could not be verified');
  });
  it('keeps partial usage and top-level unavailable evidence explicitly unknown', () => {
    const value = fixture(); value.complete = false; value.sourceState = 'degraded';
    value.usage = { ...usage(), attempts: 2, unknownAttempts: 1, totalTokens: null, complete: false };
    value.timing = { ...timing(), attempts: 2, totalDurationMs: null, complete: false };
    expect(validateWorkspaceEngineeringOutcomes(value, selected).usage.totalTokens).toBeNull();
    value.sourceState = 'unavailable'; value.campaigns = []; value.reasons = ['enrollment-or-ledger-unavailable'];
    expect(validateWorkspaceEngineeringOutcomes(value, selected).campaigns).toEqual([]);
  });
  it('accepts idle complete coverage without inventing zero-token measurement', () => {
    const value = fixture(); value.usage = { attempts: 0, joinedAttempts: 0, reportedAttempts: 0, unknownAttempts: 0,
      recordedInputTokens: 0, recordedOutputTokens: 0, totalTokens: null, complete: true };
    value.timing = { ...timing(), attempts: 0, measuredAttempts: 0, recordedDurationMs: 0, totalDurationMs: null };
    expect(validateWorkspaceEngineeringOutcomes(value, selected).usage.totalTokens).toBeNull();
  });
  it.each([{ scope: 'wall-clock' }, { measuredAttempts: 2 }, { recordedDurationMs: -1 }, { totalDurationMs: 99 }, { complete: false }])('rejects false timing coverage %j', patch => {
    const value = fixture(); Object.assign(value.timing, patch);
    expect(() => validateWorkspaceEngineeringOutcomes(value, selected)).toThrow('could not be verified');
  });
  it.each(['campaign', 'worker', 'niche', 'seed', 'metric', 'private-field', 'nonfinite', 'duplicate', 'bound', 'stage'])('rejects invalid nested %s evidence', kind => {
    const value = fixture(); const c = value.campaigns[0]!;
    if (kind === 'campaign') c.campaignId = 'foreign-campaign';
    if (kind === 'worker') c.workers[0]!.usage.totalTokens = 999;
    if (kind === 'niche') c.niches[0]!.artifactDigest = '/private/path';
    if (kind === 'seed') c.seed.status = 'unmeasured';
    if (kind === 'metric') c.metric!.minImprovement = -1;
    if (kind === 'private-field') Object.assign(c, { command: ['sh', '-c', 'private'] });
    if (kind === 'nonfinite') c.niches[0]!.score = NaN;
    if (kind === 'duplicate') c.workers.push(c.workers[0]!);
    if (kind === 'bound') c.niches = Array.from({ length: 257 }, (_, i) => ({ ...c.niches[0]!, niche: `n-${i}` }));
    if (kind === 'stage') c.stages.passed = 3;
    expect(() => validateWorkspaceEngineeringOutcomes(value, selected)).toThrow('could not be verified');
  });
  it('rejects invalid input before HTTP and suppresses raw transport errors without retries', async () => {
    await expect(readWorkspaceEngineeringOutcomes({ ...selected, id: '../private' })).rejects.toThrow('verified');
    expect(apiGet).not.toHaveBeenCalled();
    vi.mocked(apiGet).mockRejectedValue(new Error('/private/credentials'));
    await expect(readWorkspaceEngineeringOutcomes(selected)).rejects.toThrow('Outcome evidence could not be verified');
    expect(apiGet).toHaveBeenCalledOnce();
    vi.mocked(apiGet).mockResolvedValue(fixture()); const abort = new AbortController(); abort.abort();
    await expect(readWorkspaceEngineeringOutcomes(selected, abort.signal)).rejects.toThrow('verified');
  });
});
