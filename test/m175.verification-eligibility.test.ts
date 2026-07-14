/**
 * M175 — Verification-mode pre-filter: any-tier proposals are judged in
 * verification mode; default tier mode remains frontier-only but judge-free
 * unless the explicit managerGate is enabled.
 *
 * WHAT THIS TESTS:
 *   The pre-filter in runAutoMergePass (~line 164 after M175 patch) that was
 *   previously `if (p.engineTier !== 'frontier' && !midEligible) continue` now
 *   checks trustBasis before skipping:
 *
 *     - trustBasis='verification' → LOCAL + MID proposals are NOT pre-filtered;
 *       they reach the judge-then-merge section and are forwarded to
 *       autoMergeProposal only if the judge ships them. autoMergeProposal then
 *       applies the full M153 verification gate (frontier-judge-ship + suite
 *       green + risk-low + scope-cap + EDV + signed attestation). THE SAFETY
 *       IS IN THE GATE, NOT THE PRE-FILTER.
 *
 *     - trustBasis='tier' or absent (M51 default) → LOCAL + MID proposals ARE
 *       still pre-filtered. Frontier proposals reach autoMergeProposal without
 *       a pass-level judge unless managerGate=true. The downstream merge gate
 *       still owns authority, provenance, verification, risk, and scope.
 *
 * ADVERSARIAL MATRIX:
 *
 *  Verification-mode eligibility (any-tier is judged)
 *  [V1]  local proposal, verification mode, judge ships → judged + attempted
 *  [V2]  mid proposal, verification mode, judge ships → judged + attempted
 *  [V3]  local proposal, verification mode, judge review → judged, NOT attempted
 *  [V4]  local proposal, verification mode, judge harmful → judged, NOT attempted
 *  [V5]  local proposal, verification mode, judge noise → judged, NOT attempted
 *  [V6]  local proposal, verification mode, no judge client → fail-closed, NOT attempted
 *  [V7]  mixed-tier bag (local+mid+frontier), verification mode → all judged
 *
 *  M51 tier-mode lock (local is still skipped)
 *  [L1]  local proposal, trustBasis absent (tier default) → skipped, judge not called
 *  [L2]  local proposal, trustBasis='tier' explicit → skipped, judge not called
 *  [L3]  mid proposal, trustBasis absent, midToBranch=false → skipped
 *  [L4]  frontier proposal, trustBasis absent → NOT skipped, no pass-level judge
 *  [L5]  frontier proposal, managerGate=true → judged before merge
 *
 *  Gate enforcement (autoMergeProposal still guards the actual merge)
 *  [G1]  verification mode, local, judge ships, autoMergeProposal refuses → r.merged=0
 *  [G2]  verification mode, local, judge ships, autoMergeProposal merges → r.merged=1
 *  [G3]  verification mode, multiple local proposals, gate refuses all → attempted>0, merged=0
 *
 *  Never-throws
 *  [N1]  verification mode, judge throws on local proposal → swallowed, pass continues
 *
 *  Flag invariants
 *  [F1]  autoMerge.enabled=false + verification mode → zeros, judge not called
 *  [F2]  kill switch on + verification mode → zeros, judge not called
 *
 * HERMETICITY:
 *  - HOME overridden to tmp dir; no real ~/.ashlr state touched.
 *  - judgeProposal MOCKED — no real LLM calls.
 *  - autoMergeProposal MOCKED — no real git operations.
 *  - readDecisions MOCKED — full ledger control.
 *  - getActiveClient MOCKED — controls judge client availability.
 *  - listProposalsDetailed MOCKED — controls pending proposal list.
 *  - killSwitchOn MOCKED.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

const mockAutoMergeProposal = vi.fn();
const mockVerifyProposal = vi.fn();
vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
  evaluateAutoMergeReadinessPreflight: () => ({ ready: true, advisories: [] }),
  verifyProposal: (...args: unknown[]) => mockVerifyProposal(...args),
  verifyResultFromProposalResult: (result: { ok: boolean; ran: unknown[]; detail: string }) => ({
    passed: result.ok,
    ...(result.ok ? {} : { failed: [result.detail] }),
    detail: result.detail,
    ran: result.ran,
    verifiedAt: '2026-01-01T00:00:00.000Z',
    source: 'auto-merge-preflight',
  }),
}));

const mockListProposals = vi.fn();
vi.mock('../src/core/inbox/store.js', () => ({
  listProposalsDetailed: (...args: unknown[]) => ({
    proposals: mockListProposals(...args),
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
  }),
  setStatus: vi.fn(() => true),
  updateProposalField: vi.fn(() => true),
}));

const mockKillSwitchOn = vi.fn(() => false);
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => mockKillSwitchOn(),
}));

const mockReadDecisions = vi.fn(() => []);
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (...args: unknown[]) => mockReadDecisions(...args),
  recordDecision: vi.fn(),
}));

const mockJudgeProposal = vi.fn();
const mockResolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mockJudgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mockResolveFrontierJudgeClient(...args),
}));

const mockGetActiveClient = vi.fn();
vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (...args: unknown[]) => mockGetActiveClient(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks
// ---------------------------------------------------------------------------

import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { ManagerVerdict } from '../src/core/fleet/manager.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m175-'));
  process.env.HOME = tmpHome;
  vi.clearAllMocks();

  mockKillSwitchOn.mockReturnValue(false);
  mockListProposals.mockReturnValue([]);
  mockReadDecisions.mockReturnValue([]);
  mockAutoMergeProposal.mockResolvedValue({ ok: true, merged: true, branched: false });
  mockVerifyProposal.mockResolvedValue({ ok: true, ran: [], detail: 'mock verified' });
  mockGetActiveClient.mockResolvedValue({
    model: 'claude-opus-4-8',
    complete: async () =>
      '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"ship"}',
  });
  // M176: resolveFrontierJudgeClient default — returns a working frontier client.
  mockResolveFrontierJudgeClient.mockReturnValue({
    model: 'claude-opus-4-8',
    complete: async () =>
      '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"ship"}',
  });
  mockJudgeProposal.mockResolvedValue({
    proposalId: 'default',
    verdict: 'ship',
    value: 5,
    correctness: 5,
    scope: 1,
    alignment: 5,
    rationale: 'mock ship',
    wouldMerge: true,
  } satisfies ManagerVerdict);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

/** Minimal verification-mode config. */
function verifyCfg(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    foundry: {
      autoMerge: { enabled: true, trustBasis: 'verification', ...over },
    },
  } as unknown as AshlrConfig;
}

/** Minimal tier-mode config (M51 default — no trustBasis). */
function tierCfg(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    foundry: {
      autoMerge: { enabled: true, ...over },
    },
  } as unknown as AshlrConfig;
}

function makeProp(id: string, tier: 'frontier' | 'mid' | 'local' = 'local'): Proposal {
  return {
    id,
    repo: '/tmp/m175-repo',
    origin: 'agent',
    kind: 'patch',
    title: `m175 prop ${id}`,
    summary: 'test',
    diff: `+fix ${id}\n`,
    diffHash: `hash-${id}`,
    engineModel: tier === 'frontier' ? 'claude-opus-4-8' : `local:qwen3-${id}`,
    engineTier: tier,
    status: 'pending',
    createdAt: new Date().toISOString(),
  } as unknown as Proposal;
}

function shipVerdict(id: string): ManagerVerdict {
  return { proposalId: id, verdict: 'ship', value: 5, correctness: 5, scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true };
}

// ===========================================================================
// [V1–V7] Verification-mode eligibility — any-tier proposals are judged
// ===========================================================================

describe('M175 verification-mode eligibility — any tier is judged', () => {
  it('[V1] local proposal, verification mode, judge ships → judged + attempted', async () => {
    const p = makeProp('v1', 'local');
    mockListProposals.mockReturnValue([p]);
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('v1'));

    const r = await runAutoMergePass(verifyCfg());

    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(r.judged).toBe(1);
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('v1', expect.anything());
    expect(r.attempted).toBe(1);
    expect(r.merged).toBe(1);
  });

  it('[V2] mid proposal, verification mode, judge ships → judged + attempted', async () => {
    const p = makeProp('v2', 'mid');
    mockListProposals.mockReturnValue([p]);
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('v2'));

    const r = await runAutoMergePass(verifyCfg());

    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(r.judged).toBe(1);
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('v2', expect.anything());
    expect(r.attempted).toBe(1);
  });

  it('[V3] local proposal, verification mode, judge review → judged, NOT attempted', async () => {
    const p = makeProp('v3', 'local');
    mockListProposals.mockReturnValue([p]);
    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 'v3', verdict: 'review', value: 3, correctness: 3,
      scope: 3, alignment: 3, rationale: 'needs review', wouldMerge: false,
    } satisfies ManagerVerdict);

    const r = await runAutoMergePass(verifyCfg());

    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(r.judged).toBe(1);
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.attempted).toBe(0);
  });

  it('[V4] local proposal, verification mode, judge harmful → judged, NOT attempted', async () => {
    const p = makeProp('v4', 'local');
    mockListProposals.mockReturnValue([p]);
    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 'v4', verdict: 'harmful', value: 1, correctness: 1,
      scope: 5, alignment: 1, rationale: 'dangerous', wouldMerge: false,
    } satisfies ManagerVerdict);

    const r = await runAutoMergePass(verifyCfg());

    expect(r.judged).toBe(1);
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.attempted).toBe(0);
  });

  it('[V5] local proposal, verification mode, judge noise → judged, NOT attempted', async () => {
    const p = makeProp('v5', 'local');
    mockListProposals.mockReturnValue([p]);
    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 'v5', verdict: 'noise', value: 1, correctness: 1,
      scope: 1, alignment: 1, rationale: 'trivial', wouldMerge: false,
    } satisfies ManagerVerdict);

    const r = await runAutoMergePass(verifyCfg());

    expect(r.judged).toBe(1);
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.attempted).toBe(0);
  });

  it('[V6] local proposal, verification mode, no judge client → fail-closed, NOT attempted', async () => {
    const p = makeProp('v6', 'local');
    mockListProposals.mockReturnValue([p]);
    // M176: resolveFrontierJudgeClient (not getActiveClient) controls availability.
    mockResolveFrontierJudgeClient.mockReturnValue(null);

    const r = await runAutoMergePass(verifyCfg());

    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.judged).toBe(0);
    expect(r.attempted).toBe(0);
  });

  it('[V7] mixed-tier bag (local+mid+frontier), verification mode → all three judged', async () => {
    const proposals = [
      makeProp('v7-local', 'local'),
      makeProp('v7-mid', 'mid'),
      makeProp('v7-frontier', 'frontier'),
    ];
    mockListProposals.mockReturnValue(proposals);
    mockJudgeProposal.mockResolvedValue(shipVerdict('any'));

    const r = await runAutoMergePass(verifyCfg({ judgePerPass: 10 }));

    // All three proposals reached the judge (not skipped by pre-filter).
    expect(mockJudgeProposal).toHaveBeenCalledTimes(3);
    expect(r.judged).toBe(3);
    expect(r.attempted).toBe(3);
  });
});

// ===========================================================================
// [L1–L5] M51 tier-mode lock — local/mid still skipped in tier mode
// ===========================================================================

describe('M175 M51 tier-mode lock — local/mid still skipped', () => {
  it('[L1] local proposal, trustBasis absent (tier default) → skipped, judge not called', async () => {
    const p = makeProp('l1', 'local');
    mockListProposals.mockReturnValue([p]);

    const r = await runAutoMergePass(tierCfg());

    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.judged).toBe(0);
    expect(r.attempted).toBe(0);
  });

  it('[L2] local proposal, explicit trustBasis=tier → skipped, judge not called', async () => {
    const p = makeProp('l2', 'local');
    mockListProposals.mockReturnValue([p]);

    const r = await runAutoMergePass(tierCfg({ trustBasis: 'tier' }));

    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.judged).toBe(0);
    expect(r.attempted).toBe(0);
  });

  it('[L3] mid proposal, trustBasis absent, midToBranch=false → skipped', async () => {
    const p = makeProp('l3', 'mid');
    mockListProposals.mockReturnValue([p]);

    const r = await runAutoMergePass(tierCfg({ midToBranch: false }));

    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.judged).toBe(0);
  });

  it('[L4] frontier proposal, trustBasis absent → NOT skipped, no pass-level judge', async () => {
    const p = makeProp('l4', 'frontier');
    mockListProposals.mockReturnValue([p]);
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('l4'));

    const r = await runAutoMergePass(tierCfg());

    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('l4', expect.anything());
    expect(r.attempted).toBe(1);
  });

  it('[L5] frontier proposal, managerGate=true → judged before merge', async () => {
    const p = makeProp('l5', 'frontier');
    mockListProposals.mockReturnValue([p]);
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('l5'));

    const r = await runAutoMergePass(tierCfg({ managerGate: true }));

    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('l5', expect.anything());
    expect(r.judged).toBe(1);
    expect(r.attempted).toBe(1);
  });
});

// ===========================================================================
// [G1–G3] Gate enforcement — autoMergeProposal still guards the actual merge
// ===========================================================================

describe('M175 gate enforcement — autoMergeProposal still guards the merge', () => {
  it('[G1] verification mode, local, judge ships, autoMergeProposal refuses → r.merged=0', async () => {
    const p = makeProp('g1', 'local');
    mockListProposals.mockReturnValue([p]);
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('g1'));
    // Gate refuses (e.g. no frontier-judge attestation in real ledger)
    mockAutoMergeProposal.mockResolvedValueOnce({
      ok: false, merged: false, branched: false,
      reason: 'merge authority denied: no judged decision with frontier judge',
    });

    const r = await runAutoMergePass(verifyCfg());

    expect(r.judged).toBe(1);
    expect(r.attempted).toBe(1);
    expect(r.merged).toBe(0);
    expect(r.results[0]).toMatchObject({ ok: false, merged: false });
  });

  it('[G2] verification mode, local, judge ships, autoMergeProposal merges → r.merged=1', async () => {
    const p = makeProp('g2', 'local');
    mockListProposals.mockReturnValue([p]);
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('g2'));
    mockAutoMergeProposal.mockResolvedValueOnce({ ok: true, merged: true, branched: false });

    const r = await runAutoMergePass(verifyCfg());

    expect(r.judged).toBe(1);
    expect(r.attempted).toBe(1);
    expect(r.merged).toBe(1);
  });

  it('[G3] verification mode, 3 local proposals, judge ships all, gate refuses all → attempted=3, merged=0', async () => {
    const proposals = ['g3a', 'g3b', 'g3c'].map((id) => makeProp(id, 'local'));
    mockListProposals.mockReturnValue(proposals);
    mockJudgeProposal.mockResolvedValue(shipVerdict('any'));
    // All gate refusals
    mockAutoMergeProposal.mockResolvedValue({
      ok: false, merged: false, branched: false,
      reason: 'merge authority denied: verification gate failed',
    });

    const r = await runAutoMergePass(verifyCfg({ judgePerPass: 10 }));

    expect(r.judged).toBe(3);
    expect(r.attempted).toBe(3);
    expect(r.merged).toBe(0);
  });
});

// ===========================================================================
// [N1] Never-throws
// ===========================================================================

describe('M175 never-throws', () => {
  it('[N1] verification mode, judge throws on local proposal → swallowed, pass continues', async () => {
    const p1 = makeProp('n1a', 'local');
    const p2 = makeProp('n1b', 'local');
    mockListProposals.mockReturnValue([p1, p2]);

    mockJudgeProposal
      .mockRejectedValueOnce(new Error('LLM timeout'))  // p1 throws
      .mockResolvedValueOnce(shipVerdict('n1b'));        // p2 ships

    const r = await runAutoMergePass(verifyCfg());

    // Must not throw
    expect(r).toHaveProperty('judged');
    // p2 shipped → merge attempted
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('n1b', expect.anything());
  });
});

// ===========================================================================
// [F1–F2] Flag invariants in verification mode
// ===========================================================================

describe('M175 flag invariants — verification mode', () => {
  it('[F1] autoMerge.enabled=false + verification mode → zeros, judge not called', async () => {
    const p = makeProp('f1', 'local');
    mockListProposals.mockReturnValue([p]);

    const cfg: AshlrConfig = {
      foundry: { autoMerge: { enabled: false, trustBasis: 'verification' } },
    } as unknown as AshlrConfig;

    const r = await runAutoMergePass(cfg);

    expect(r.attempted).toBe(0);
    expect(r.merged).toBe(0);
    expect(r.judged).toBe(0);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

  it('[F2] kill switch on + verification mode → zeros, judge not called', async () => {
    const p = makeProp('f2', 'local');
    mockListProposals.mockReturnValue([p]);
    mockKillSwitchOn.mockReturnValue(true);

    const r = await runAutoMergePass(verifyCfg());

    expect(r.attempted).toBe(0);
    expect(r.merged).toBe(0);
    expect(r.judged).toBe(0);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });
});
