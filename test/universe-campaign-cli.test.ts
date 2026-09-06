import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';

const core = vi.hoisted(() => ({
  initUniverseCampaign: vi.fn(), readUniverseCampaign: vi.fn(), readUniverseCampaigns: vi.fn(),
  requestUniverseCampaignControl: vi.fn(), runUniverseCampaign: vi.fn(),
}));
const files = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('../src/core/universe/index.js', () => core);
vi.mock('node:fs', () => files);
import { cmdUniverseCampaign } from '../src/cli/universe-campaign.js';

function campaign(overrides: Partial<UniverseCampaignSummary> = {}): UniverseCampaignSummary {
  return {
    definition: { schemaVersion: 1, id: 'search', universeId: 'compiler', budget: {
      maxGenerations: 4, maxDurationMs: 60_000, maxModelRequests: 8, maxStagnantGenerations: 2, maxReportedTokens: null,
    }, feedback: true },
    definitionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64),
    createdAt: '2026-09-06T12:00:00.000Z', startedAt: null, deadlineAt: null, finishedAt: null,
    state: 'ready', reason: null, steps: [], owner: null, sourceState: 'healthy', reasons: [],
    progress: { attempts: 0, completedRuns: 0, interruptedRuns: 0, reservedModelRequests: 0,
      reportedTokens: null, recordedTokens: 0, usageComplete: false, admissions: 0, improvements: 0, stagnantGenerations: 0 },
    ...overrides,
  };
}

describe('Universe campaign CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.initUniverseCampaign.mockReturnValue(campaign());
    core.readUniverseCampaign.mockReturnValue(campaign());
    core.readUniverseCampaigns.mockReturnValue({ campaigns: [], sourceState: 'healthy', reasons: [] });
    core.runUniverseCampaign.mockResolvedValue(campaign({ state: 'completed', reason: 'generation-limit' }));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['run'], ['resume'], ['pause'], ['stop'], ['run', '../escape'], ['status', 'one', 'two'],
    ['unknown'], ['init'], ['status', '--manifest', 'a.json'], ['status', '--root'],
    ['status', '--unknown'], ['run', 'one', '--root', '/a', '--root', '/b'],
    ['init', '--manifest', '/a', '--manifest', '/b'],
  ])('rejects invalid invocation %j before mutation', async (...args) => {
    expect(await cmdUniverseCampaign([...args, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toHaveProperty('error');
    expect(core.initUniverseCampaign).not.toHaveBeenCalled();
    expect(core.runUniverseCampaign).not.toHaveBeenCalled();
    expect(core.requestUniverseCampaignControl).not.toHaveBeenCalled();
  });

  it('defaults to a read-only machine-readable campaign inventory', async () => {
    const result = { campaigns: [campaign()], sourceState: 'healthy', reasons: [] };
    core.readUniverseCampaigns.mockReturnValue(result);
    expect(await cmdUniverseCampaign(['--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(result);
    expect(core.runUniverseCampaign).not.toHaveBeenCalled();
  });

  it('routes the existing universe command into the campaign subcommand', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse(['campaign', 'status', 'search', '--json'])).toBe(0);
    expect(core.readUniverseCampaign).toHaveBeenCalledWith('search', { root: undefined });
  });

  it('registers a parsed definition without starting a campaign', async () => {
    const definition = campaign().definition;
    files.readFileSync.mockReturnValue(JSON.stringify(definition));
    expect(await cmdUniverseCampaign(['init', '--manifest', '/private/campaign.json', '--root', '/private/store', '--json'])).toBe(0);
    expect(core.initUniverseCampaign).toHaveBeenCalledWith(definition, { root: '/private/store' });
    expect(core.runUniverseCampaign).not.toHaveBeenCalled();
  });

  it('retains a custom root in the executable continuation hint', async () => {
    expect(await cmdUniverseCampaign(['status', 'search', '--root', "/private/owner's store"])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain("campaign run search --root '/private/owner'\\''s store'");
  });

  it('does not register malformed JSON', async () => {
    files.readFileSync.mockReturnValue('{invalid');
    expect(await cmdUniverseCampaign(['init', '--manifest', '/private/campaign.json', '--json'])).toBe(1);
    expect(core.initUniverseCampaign).not.toHaveBeenCalled();
  });

  it('makes resume an ordinary run with the same ID and no fresh budget', async () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    expect(await cmdUniverseCampaign(['resume', 'search', '--root', '/private/store', '--json'])).toBe(0);
    expect(core.runUniverseCampaign).toHaveBeenCalledWith('search', { root: '/private/store', signal: expect.any(AbortSignal) });
    expect(core.initUniverseCampaign).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it.each(['pause', 'stop'] as const)('reports %s as requested until the owner acknowledges it', async (action) => {
    core.requestUniverseCampaignControl.mockReturnValue(campaign({ state: `${action}-requested`, reason: 'owner-control-request' }));
    expect(await cmdUniverseCampaign([action, 'search'])).toBe(0);
    expect(core.requestUniverseCampaignControl).toHaveBeenCalledWith('search', action, { root: undefined });
    expect(output.mock.calls[0]![0]).toContain('Control requested; the owner has not yet acknowledged completion.');
    expect(core.runUniverseCampaign).not.toHaveBeenCalled();
  });

  it.each(['failed', 'interrupted'] as const)('returns %s execution as non-success', async (state) => {
    core.runUniverseCampaign.mockResolvedValue(campaign({ state }));
    expect(await cmdUniverseCampaign(['run', 'search', '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string).state).toBe(state);
  });

  it.each(['paused', 'stopped', 'completed'] as const)('reports handled %s state without claiming project success', async (state) => {
    core.runUniverseCampaign.mockResolvedValue(campaign({ state }));
    expect(await cmdUniverseCampaign(['run', 'search'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('Campaign termination is not project success.');
  });

  it('preserves incomplete usage and the recorded subtotal as different observations', async () => {
    const current = campaign({ state: 'interrupted' });
    current.progress.recordedTokens = 240;
    current.progress.reservedModelRequests = 2;
    core.readUniverseCampaign.mockReturnValue(current);
    expect(await cmdUniverseCampaign(['status', 'search'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('Reported token total: unavailable · recorded subtotal: 240');
    expect(output.mock.calls[0]![0]).not.toContain('token total: 0');
  });

  it('returns degraded inventory as non-success without fabricating healthy emptiness', async () => {
    core.readUniverseCampaigns.mockReturnValue({ campaigns: [], sourceState: 'degraded', reasons: ['Invalid campaign record'] });
    expect(await cmdUniverseCampaign(['status', '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string).reasons).toEqual(['Invalid campaign record']);
  });

  it('prints campaign help without store inspection or execution', async () => {
    expect(await cmdUniverseCampaign(['help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('does not reset the deadline or budget');
    expect(core.readUniverseCampaigns).not.toHaveBeenCalled();
    expect(core.runUniverseCampaign).not.toHaveBeenCalled();
  });
});
