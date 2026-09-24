/**
 * V3.10 P1 — the LEGACY (no-grant) automerge pass's red team goes through the
 * same router + budget path as G5 under a grant (no unrouted frontier call).
 *
 * Part 1 drives runAutoMergePass (M193 harness): the model half of
 * redTeamProposal only ever gets the lanes legacyJudgeSeatLanes admits, one
 * call spends one of judgePerPass, an answered red team is reused for the
 * same diff, and a failed one is not re-asked inside the retry window.
 *
 * Hermetic: every collaborator is mocked; no model, no git, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockAutoMergeProposal = vi.fn();
vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
  evaluateAutoMergeReadinessPreflight: () => ({ ready: true, advisories: [] }),
  isFrontierJudge: (engine: string | undefined) => String(engine ?? '').toLowerCase().includes('claude'),
}));

const mockListProposals = vi.fn();
vi.mock('../src/core/inbox/store.js', () => ({
  listProposalsDetailed: (...args: unknown[]) => ({ proposals: mockListProposals(...args), sourceState: 'healthy', complete: true }),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => false, isEnrolled: () => true }));

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({ readDecisions: () => [], recordDecision: vi.fn() }));

vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: vi.fn(),
  resolveFrontierJudgeClient: vi.fn(() => null),
}));

const mockRedTeamProposal = vi.fn();
vi.mock('../src/core/fleet/red-team.js', () => ({
  redTeamProposal: (...args: unknown[]) => mockRedTeamProposal(...args),
}));

const mockLanes = vi.fn();
vi.mock('../src/core/fleet/standing-merge-pass.js', () => ({
  legacyJudgeSeatLanes: (...args: unknown[]) => mockLanes(...args),
}));

vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/effective-config.js')>()),
  currentStandingPolicy: () => null,
}));

const { runAutoMergePass, __resetLegacyRedTeamMemoForTests } = await import('../src/core/fleet/automerge-pass.js');
type AshlrConfig = import('../src/core/types.js').AshlrConfig;
type Proposal = import('../src/core/types.js').Proposal;

let tmpHome: string;
const origHome = process.env['HOME'];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-p1-redteam-'));
  process.env['HOME'] = tmpHome;
  vi.clearAllMocks();
  __resetLegacyRedTeamMemoForTests();
  mockAutoMergeProposal.mockResolvedValue({ ok: false, merged: false, branched: false, detail: 'held by the merge gate' });
  mockRedTeamProposal.mockResolvedValue({ broke: false, attacks: [], verdict: 'survived', detail: 'ok', frontier: 'answered' });
  mockLanes.mockReturnValue({ lanes: ['claude-cli'], nextEligibleAt: null });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env['HOME'] = origHome;
});

// Tier mode, no managerGate → no M172 judge in this pass: only the red team spends judgePerPass.
function cfg(over: Record<string, unknown> = {}): AshlrConfig {
  return { foundry: { autoMerge: { enabled: true }, redTeam: true, ...over } } as unknown as AshlrConfig;
}

function prop(id: string, diff = `+++ a/src/${id}.ts\n+fix ${id}\n`): Proposal {
  return {
    id,
    repo: '/tmp/p1-redteam-repo',
    origin: 'agent',
    kind: 'patch',
    title: `p1 ${id}`,
    summary: 'test',
    diff,
    diffHash: `hash-${id}`,
    engineModel: 'grok-cli:grok-4.7',
    engineTier: 'frontier',
    status: 'pending',
    createdAt: new Date().toISOString(),
    specId: null,
  } as unknown as Proposal;
}

function judgeOpt(callIndex: number): { producerModel?: string; requireIndependent?: boolean; allowedJudgeEngines?: readonly string[] } {
  const opts = mockRedTeamProposal.mock.calls[callIndex]?.[2] as { judge?: Record<string, unknown> } | undefined;
  return (opts?.judge ?? {}) as ReturnType<typeof judgeOpt>;
}

describe('legacy automerge red team — routed and budgeted like G5 (P1)', () => {
  it('passes ONLY the router-admitted lanes (with the producer, independence required)', async () => {
    mockListProposals.mockReturnValue([prop('a')]);
    await runAutoMergePass(cfg());
    expect(mockRedTeamProposal).toHaveBeenCalledTimes(1);
    expect(judgeOpt(0)).toEqual({ producerModel: 'grok-cli:grok-4.7', requireIndependent: true, allowedJudgeEngines: ['claude-cli'] });
    expect(mockLanes).toHaveBeenCalledWith(expect.objectContaining({ producerFamily: 'xai' }));
  });

  it('no admitted lane → an EMPTY lane list (deterministic-only, never an unrouted client)', async () => {
    mockLanes.mockReturnValue({ lanes: [], nextEligibleAt: null });
    mockRedTeamProposal.mockResolvedValue({ broke: false, attacks: [], verdict: 'survived', detail: 'ok', frontier: 'none' });
    mockListProposals.mockReturnValue([prop('a')]);
    await runAutoMergePass(cfg());
    expect(judgeOpt(0).allowedJudgeEngines).toEqual([]);
  });

  it('a router that throws fails closed to an empty lane list', async () => {
    mockLanes.mockImplementation(() => { throw new Error('snapshot unreadable'); });
    mockListProposals.mockReturnValue([prop('a')]);
    await runAutoMergePass(cfg());
    expect(judgeOpt(0).allowedJudgeEngines).toEqual([]);
  });

  it('each model call spends one of judgePerPass; an exhausted budget gets no lanes', async () => {
    mockListProposals.mockReturnValue([prop('a'), prop('b'), prop('c')]);
    await runAutoMergePass(cfg({ judgePerPass: 2 }));
    expect(mockRedTeamProposal).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((i) => judgeOpt(i).allowedJudgeEngines)).toEqual([['claude-cli'], ['claude-cli'], []]);
    expect(mockLanes).toHaveBeenCalledTimes(2); // the router is not even consulted past the budget
  });

  it('an ANSWERED red team is reused for the same diff (a held proposal is not re-asked every tick)', async () => {
    mockRedTeamProposal.mockResolvedValue({ broke: true, attacks: [], verdict: 'broken', detail: 'frontier: unsafe', frontier: 'answered' });
    mockListProposals.mockReturnValue([prop('a')]);
    const first = await runAutoMergePass(cfg());
    const second = await runAutoMergePass(cfg());
    expect(mockRedTeamProposal).toHaveBeenCalledTimes(1);
    expect(first.skipped[0]).toMatchObject({ proposalId: 'a', check: 'red-team' });
    expect(second.skipped[0]).toMatchObject({ proposalId: 'a', check: 'red-team', reason: expect.stringContaining('frontier: unsafe') });
    // A changed diff invalidates the memo.
    mockListProposals.mockReturnValue([prop('a', '+++ a/src/a.ts\n+a different fix\n')]);
    await runAutoMergePass(cfg());
    expect(mockRedTeamProposal).toHaveBeenCalledTimes(2);
  });

  it('a FAILED model red team is not re-asked inside the retry window (deterministic-only meanwhile)', async () => {
    mockRedTeamProposal.mockResolvedValueOnce({ broke: false, attacks: [], verdict: 'survived', detail: 'ok', frontier: 'failed' });
    mockRedTeamProposal.mockResolvedValue({ broke: false, attacks: [], verdict: 'survived', detail: 'ok', frontier: 'none' });
    mockListProposals.mockReturnValue([prop('a')]);
    await runAutoMergePass(cfg());
    await runAutoMergePass(cfg());
    expect(judgeOpt(0).allowedJudgeEngines).toEqual(['claude-cli']);
    expect(judgeOpt(1).allowedJudgeEngines).toEqual([]);
    expect(mockLanes).toHaveBeenCalledTimes(1);
  });
});
