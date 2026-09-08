import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';

const core = vi.hoisted(() => ({
  initUniverseCampaign: vi.fn(), readUniverseCampaign: vi.fn(), readUniverseCampaigns: vi.fn(),
  requestUniverseCampaignControl: vi.fn(), runUniverseCampaign: vi.fn(),
}));
const files = vi.hoisted(() => ({ readFileSync: vi.fn() }));
const readiness = vi.hoisted(() => ({ readUniverseCampaignReadiness: vi.fn() }));
vi.mock('../src/core/universe/index.js', () => core);
vi.mock('../src/core/universe/campaign-readiness.js', () => readiness);
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

/** CLI transport fixture; the reader's classification semantics have their own tests. */
function readinessReport(overrides: Partial<UniverseCampaignReadiness> = {}): UniverseCampaignReadiness {
  return {
    schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: 'search', universeId: 'compiler',
    observedState: 'ready', sourceState: 'healthy', disposition: 'startable', reasonCode: 'never-started',
    automaticAction: 'run', resourceRuntimeRequired: true,
    expectedIdentity: { universeId: 'compiler', definitionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64),
      comparatorDigest: 'c'.repeat(64), summaryDigest: 'd'.repeat(64) },
    recordsDigest: 'e'.repeat(64), sampledAt: '2026-09-07T12:00:00.000Z', ...overrides,
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
    readiness.readUniverseCampaignReadiness.mockReturnValue(readinessReport());
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['run'], ['resume'], ['pause'], ['stop'], ['run', '../escape'], ['status', 'one', 'two'],
    ['unknown'], ['init'], ['status', '--manifest', 'a.json'], ['status', '--root'],
    ['status', '--unknown'], ['run', 'one', '--root', '/a', '--root', '/b'],
    ['init', '--manifest', '/a', '--manifest', '/b'],
    ['check'], ['check', 'search'], ['check', 'search', '--root', 'relative'],
    ['check', 'search', '--root', '/'], ['check', 'search', '--root', '/private/store/'],
    ['check', 'search', '--root', '/private/other/../store'],
    ['check', 'search', '--root', '/private/store\nunsafe'],
    ['check', 'search', '--root', '/private/store\u0085unsafe'],
    ['check', 'search', '--root', `/private/${'x'.repeat(4096)}`],
    ['check', 'search', '--root', '/private/store', '--resource-runtime', '/private/runtime.json'],
    ['check', 'search', '--root', '/private/store', '--manifest', '/private/campaign.json'],
    ['check', 'search', 'another', '--root', '/private/store'],
    ['check', 'search', '--root', '/private/store', '--root', '/private/another'],
  ])('rejects invalid invocation %j before mutation', async (...args) => {
    expect(await cmdUniverseCampaign([...args, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toHaveProperty('error');
    expect(core.initUniverseCampaign).not.toHaveBeenCalled();
    expect(core.runUniverseCampaign).not.toHaveBeenCalled();
    expect(core.requestUniverseCampaignControl).not.toHaveBeenCalled();
    expect(files.readFileSync).not.toHaveBeenCalled();
    expect(readiness.readUniverseCampaignReadiness).not.toHaveBeenCalled();
  });

  it('defaults to a read-only machine-readable campaign inventory', async () => {
    const result = { campaigns: [campaign()], sourceState: 'healthy', reasons: [] };
    core.readUniverseCampaigns.mockReturnValue(result);
    expect(await cmdUniverseCampaign(['--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(result);
    expect(core.runUniverseCampaign).not.toHaveBeenCalled();
    expect(readiness.readUniverseCampaignReadiness).not.toHaveBeenCalled();
  });

  it('routes the existing universe command into the campaign subcommand', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse(['campaign', 'status', 'search', '--json'])).toBe(0);
    expect(core.readUniverseCampaign).toHaveBeenCalledWith('search', { root: undefined });
  });

  it('returns exactly the selected recorded check without opening private runtime or dispatching work', async () => {
    const root = "/private/owner's campaign store";
    const expected = readinessReport();
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse(['campaign', 'check', 'search', '--root', root, '--json'])).toBe(0);
    expect(readiness.readUniverseCampaignReadiness).toHaveBeenCalledExactlyOnceWith('search', { root });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(expected);
    expect(output.mock.calls[0]![0]).not.toContain(root);
    for (const method of Object.values(core)) expect(method).not.toHaveBeenCalled();
    expect(files.readFileSync).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it.each(['owned', 'owner-held', 'resource-withheld', 'recovery-required', 'attention-required', 'budget-exhausted', 'terminal'] as const)(
    'treats a healthy %s snapshot as handled, not as permission to resume', async (disposition) => {
      const report = readinessReport({ disposition, automaticAction: 'none', observedState: disposition === 'terminal' ? 'completed' : 'paused' });
      readiness.readUniverseCampaignReadiness.mockReturnValue(report);
      expect(await cmdUniverseCampaign(['check', 'search', '--root', '/private/store', '--json'])).toBe(0);
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(report);
      for (const method of Object.values(core)) expect(method).not.toHaveBeenCalled();
      expect(files.readFileSync).not.toHaveBeenCalled();
    });

  it.each(['missing', 'degraded'] as const)('returns %s recorded evidence as unavailable, not a fresh campaign', async (sourceState) => {
    const report = readinessReport({ sourceState, disposition: 'unavailable', automaticAction: 'none',
      universeId: null, observedState: null, resourceRuntimeRequired: null, expectedIdentity: null, recordsDigest: null });
    readiness.readUniverseCampaignReadiness.mockReturnValue(report);
    expect(await cmdUniverseCampaign(['check', 'search', '--root', '/private/store', '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(report);
    for (const method of Object.values(core)) expect(method).not.toHaveBeenCalled();
    expect(files.readFileSync).not.toHaveBeenCalled();
  });

  it('renders recorded-only advice without a run command or a private path', async () => {
    expect(await cmdUniverseCampaign(['check', 'search', '--root', '/private/operator-secret'])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('recorded recovery check · startable');
    expect(text).toContain('Reason code: never-started');
    expect(text).toContain('Advisory action: run (no work started)');
    expect(text).toContain('Explicit resource runtime required: yes');
    expect(text).toContain('Current worker, quota, provider/model and evaluator readiness are not checked.');
    expect(text).toContain('This snapshot is not authorization to start work.');
    expect(text).not.toContain('ashlr universe campaign run');
    expect(text).not.toContain('/private/operator-secret');
    for (const method of Object.values(core)) expect(method).not.toHaveBeenCalled();
  });

  it.each([true, false])('contains unexpected reader exceptions without private path disclosure (json=%s)', async (json) => {
    readiness.readUniverseCampaignReadiness.mockImplementation(() => { throw new Error('EACCES /private/hidden/runtime.json'); });
    expect(await cmdUniverseCampaign(['check', 'search', '--root', '/private/store', ...(json ? ['--json'] : [])])).toBe(1);
    if (json) expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Campaign recorded readiness is unavailable' });
    else expect(console.error).toHaveBeenCalledExactlyOnceWith('universe campaign: Campaign recorded readiness is unavailable');
    expect(JSON.stringify(output.mock.calls)).not.toContain('/private/hidden');
    for (const method of Object.values(core)) expect(method).not.toHaveBeenCalled();
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
    expect(output.mock.calls[0]![0]).toContain('Check requires an explicit canonical absolute private root.');
    expect(output.mock.calls[0]![0]).toContain('current worker readiness. --resource-runtime is not accepted by check.');
    expect(core.readUniverseCampaigns).not.toHaveBeenCalled();
    expect(core.runUniverseCampaign).not.toHaveBeenCalled();
  });
});
