/** Parser/rendering fixtures only; no private configuration is opened and no worker runs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseCampaignSummary, UniverseRun } from '../src/core/universe/types.js';
const core = vi.hoisted(() => ({ initUniverse: vi.fn(), readUniverseOverview: vi.fn(), runUniverse: vi.fn(),
  initUniverseCampaign: vi.fn(), readUniverseCampaign: vi.fn(), readUniverseCampaigns: vi.fn(),
  requestUniverseCampaignControl: vi.fn(), runUniverseCampaign: vi.fn() }));
const files = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('../src/core/universe/index.js', () => core);
vi.mock('node:fs', () => files);
import { cmdUniverse } from '../src/cli/universe.js';
import { cmdUniverseCampaign } from '../src/cli/universe-campaign.js';

const runtime = "/private/fixture owner's/runtime.json";
function run(): UniverseRun {
  return { id: 'run', universeId: 'fixture', generation: 1, manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64),
    startedAt: '2026-09-07T12:00:00.000Z', finishedAt: '2026-09-07T12:00:01.000Z', status: 'completed',
    durationMs: 1000, tokensUsed: null, costUsd: null, trials: [{ id: 'trial', variantId: 'pooled', niche: 'one',
      parentTrialId: null, status: 'failed', score: null, metrics: {}, artifact: null, durationMs: 900, delta: null, selected: false,
      generation: { schemaVersion: 1, provider: 'resource-pool', endpoint: null, model: null, status: 'failed', requestStarted: false,
        promptDigest: 'c'.repeat(64), responseDigest: null, durationMs: 500, changedFiles: [],
        usage: { state: 'unavailable', inputTokens: null, outputTokens: null },
        resource: { schemaVersion: 1, poolId: 'fixture-pool', poolDigest: 'd'.repeat(64), allowedWorkerIds: ['native-a'],
          taskId: 'resource-task', taskDigest: 'e'.repeat(64), workerId: 'native-a', workerProvider: 'codex', workerModel: 'fixture-model',
          receiptDigest: 'f'.repeat(64), dispatch: 'settled', taskStatus: 'completed', usageScope: null } } }],
    generationUsage: { scope: 'model-generation', trials: 1, requestsStarted: 0, reportedRequests: 0,
      resourceAttempts: 1, resourceReportedAttempts: 0, inputTokens: null, outputTokens: null } };
}
function campaign(): UniverseCampaignSummary {
  return { definition: { schemaVersion: 1, id: 'campaign', universeId: 'fixture', feedback: false,
    budget: { maxGenerations: 2, maxDurationMs: 10000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: null } },
    definitionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64),
    createdAt: '2026-09-07T12:00:00.000Z', startedAt: null, finishedAt: null, deadlineAt: null, owner: null,
    state: 'paused', reason: null, sourceState: 'healthy', reasons: [], steps: [],
    progress: { attempts: 0, completedRuns: 0, interruptedRuns: 0, reservedModelRequests: 0,
      reportedTokens: null, recordedTokens: 0, usageComplete: false, admissions: 0, improvements: 0, stagnantGenerations: 0 } };
}
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  core.runUniverse.mockResolvedValue(run()); core.runUniverseCampaign.mockResolvedValue(campaign());
  core.readUniverseCampaign.mockReturnValue(campaign());
});
afterEach(() => vi.restoreAllMocks());

describe('execution-only resource runtime option', () => {
  it('forwards an absolute runtime path only to the selected Universe execution', async () => {
    expect(await cmdUniverse(['run', 'fixture', '--root', '/private/universe', '--resource-runtime', runtime, '--json'])).toBe(0);
    expect(core.runUniverse).toHaveBeenCalledWith('fixture', { root: '/private/universe', resourceRuntime: runtime, signal: expect.any(AbortSignal) });
    expect(files.readFileSync).not.toHaveBeenCalled(); expect(output.mock.calls[0]![0]).not.toContain(runtime);
  });
  it.each(['run', 'resume'])('forwards an explicit runtime for campaign %s', async (command) => {
    expect(await cmdUniverseCampaign([command, 'campaign', '--resource-runtime', runtime, '--json'])).toBe(0);
    expect(core.runUniverseCampaign).toHaveBeenCalledWith('campaign', { root: undefined, resourceRuntime: runtime, signal: expect.any(AbortSignal) });
    expect(files.readFileSync).not.toHaveBeenCalled();
  });
  it.each([
    ['status', '--resource-runtime', runtime], ['archive', '--resource-runtime', runtime],
    ['init', '--manifest', '/private/fixture.json', '--resource-runtime', runtime], ['demo', '--resource-runtime', runtime],
    ['run', 'fixture', '--resource-runtime'], ['run', 'fixture', '--resource-runtime', 'relative.json'],
    ['run', 'fixture', '--resource-runtime', '/private/bad\nfile'],
    ['run', 'fixture', '--resource-runtime', runtime, '--resource-runtime', runtime],
  ])('rejects invalid or non-execution Universe scope %j', async (...args) => {
    expect(await cmdUniverse([...args, '--json'])).toBe(2);
    expect(core.runUniverse).not.toHaveBeenCalled(); expect(core.initUniverse).not.toHaveBeenCalled(); expect(files.readFileSync).not.toHaveBeenCalled();
  });
  it.each([
    ['status', '--resource-runtime', runtime], ['pause', 'campaign', '--resource-runtime', runtime],
    ['stop', 'campaign', '--resource-runtime', runtime], ['init', '--manifest', '/private/fixture.json', '--resource-runtime', runtime],
    ['resume', 'campaign', '--resource-runtime', 'relative.json'], ['run', 'campaign', '--resource-runtime'],
    ['run', 'campaign', '--resource-runtime', runtime, '--resource-runtime', runtime],
  ])('rejects invalid or non-execution campaign scope %j', async (...args) => {
    expect(await cmdUniverseCampaign([...args, '--json'])).toBe(2);
    expect(core.runUniverseCampaign).not.toHaveBeenCalled(); expect(core.requestUniverseCampaignControl).not.toHaveBeenCalled();
    expect(core.initUniverseCampaign).not.toHaveBeenCalled(); expect(files.readFileSync).not.toHaveBeenCalled();
  });
  it('renders task provenance separately from failed candidate validation and unknown usage', async () => {
    expect(await cmdUniverse(['run', 'fixture', '--resource-runtime', runtime])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('Model generation: failed · resource-pool · fixture-model');
    expect(text).toContain('Resource dispatch: settled · task outcome=completed');
    expect(text).toContain('worker=native-a · task=resource-task');
    expect(text).toContain('worker completion is not candidate validation or evaluator acceptance');
    expect(text).toContain('provider request count: unknown'); expect(text).toContain('input=unavailable output=unavailable');
    expect(text).toContain('Resource handoff coverage: 0/1'); expect(text).not.toContain('Endpoint:'); expect(text).not.toContain(runtime);
  });
  it('explains the legacy campaign reservation field without renaming stored JSON', async () => {
    expect(await cmdUniverseCampaign(['status', 'campaign'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('Reserved generation invocations: 0/2 (maxModelRequests; not native API calls)');
    expect(output.mock.calls[0]![0]).toContain('--resource-runtime option again on resume');
    output.mockClear(); expect(await cmdUniverseCampaign(['status', 'campaign', '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string).definition.budget.maxModelRequests).toBe(2);
  });
});
