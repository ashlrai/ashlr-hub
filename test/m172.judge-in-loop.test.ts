/**
 * M172 — Judge-in-loop: runAutoMergePass judges unjudged pending proposals
 * before forwarding ship-attested ones to autoMergeProposal.
 *
 * Closes the gap where proposals accumulate in 'pending' state because the
 * manager cron (daily) is the only path that runs the frontier judge.
 *
 * FILE OWNERSHIP: automerge-pass.ts only. manager.ts, merge.ts, loop.ts,
 * judge-trace.ts are NOT edited — only imported/mocked.
 *
 * Adversarial matrix:
 *
 *  Judge-then-merge — happy path
 *  [J1]  unjudged pending + judge returns 'ship' → autoMergeProposal called
 *  [J2]  already-judged (hasRecentShipVerdict=true) → skip judge, still merge
 *  [J3]  judge returns 'review' → autoMergeProposal NOT called (stays pending)
 *  [J4]  judge returns 'noise' → autoMergeProposal NOT called
 *  [J5]  judge returns 'harmful' → autoMergeProposal NOT called
 *
 *  Bounds
 *  [B1]  judgePerPass=2, 4 unjudged → judges 2, caps 2 (judgeCapped=2)
 *  [B2]  already-judged proposals don't consume the per-pass cap
 *  [B3]  default judgePerPass=8 (unset in cfg; raised from 5 in M259)
 *
 *  Never-throws
 *  [N1]  judgeProposal throws → swallowed, pass continues, never-throws
 *  [N2]  autoMergeProposal throws → swallowed (existing contract)
 *  [N3]  listProposals throws → returns zeros (existing contract)
 *  [N4]  judge client unavailable (resolveFrontierJudgeClient returns null) → fail-closed, no merge
 *
 *  Flag invariants
 *  [F1]  autoMerge.enabled=false → returns zeros, judge never called
 *  [F2]  kill switch on → returns zeros, judge never called
 *
 *  Output counters
 *  [O1]  judged counter increments per inline judge call
 *  [O2]  merged/attempted/branched reflect autoMergeProposal results
 *
 * HERMETICITY:
 *  - HOME overridden to tmp dir; no real ~/.ashlr state touched.
 *  - judgeProposal MOCKED — no real LLM calls.
 *  - autoMergeProposal MOCKED — no real git operations.
 *  - readDecisions MOCKED — full ledger control.
 *  - resolveFrontierJudgeClient MOCKED (from manager.js) — controls judge client availability (M176).
 *  - listProposals MOCKED — controls pending proposal list.
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
  isFrontierJudge: (engine: string | undefined) => {
    const value = String(engine ?? '').toLowerCase();
    return value.startsWith('claude') || value.includes('claude') || value.startsWith('gpt-5');
  },
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
  listProposals: (...args: unknown[]) => mockListProposals(...args),
  setStatus: vi.fn(),
  updateProposalField: vi.fn(),
}));

const mockKillSwitchOn = vi.fn(() => false);
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => mockKillSwitchOn(),
}));

const mockReadDecisions = vi.fn(() => []);
const mockRecordDecision = vi.fn();
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (...args: unknown[]) => mockReadDecisions(...args),
  recordDecision: (...args: unknown[]) => mockRecordDecision(...args),
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
import { hashDiff, signJudgeAttestation } from '../src/core/foundry/provenance.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m172-'));
  process.env.HOME = tmpHome;
  vi.clearAllMocks();

  // Safe defaults
  mockKillSwitchOn.mockReturnValue(false);
  mockListProposals.mockReturnValue([]);
  mockReadDecisions.mockReturnValue([]);
  mockAutoMergeProposal.mockResolvedValue({ ok: true, merged: true, branched: false });
  mockVerifyProposal.mockResolvedValue({ ok: true, ran: [], detail: 'mock verified' });
  mockGetActiveClient.mockResolvedValue({
    model: 'claude-opus-4-5',
    complete: async () => '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"great"}',
  });
  // Default: resolveFrontierJudgeClient returns a working judge client (M176)
  mockResolveFrontierJudgeClient.mockReturnValue({
    model: 'claude-opus-4-8',
    complete: async () => '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"great"}',
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

/** Minimal enabled config. */
function enabledCfg(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    foundry: {
      autoMerge: { enabled: true, managerGate: true },
      ...over,
    },
  } as unknown as AshlrConfig;
}

/** Minimal frontier proposal fixture. */
function makeProp(id: string, tier: 'frontier' | 'mid' | 'local' = 'frontier'): Proposal {
  return {
    id,
    repo: '/tmp/m172-repo',
    origin: 'agent',
    kind: 'patch',
    title: `m172 prop ${id}`,
    summary: 'test',
    diff: `+fix ${id}\n`,
    diffHash: `hash-${id}`,
    engineModel: 'local:qwen3-coder',
    engineTier: tier,
    status: 'pending',
    createdAt: new Date().toISOString(),
  } as unknown as Proposal;
}

/** A recent decisions-ledger entry with a ship verdict + attestation. */
function recentShipEntry(proposalId: string): Record<string, unknown> {
  const judgeEngine = 'claude-opus-4-5';
  const issuedAt = new Date().toISOString();
  return {
    ts: issuedAt,
    proposalId,
    action: 'judged',
    verdict: 'ship',
    engine: judgeEngine,
    model: judgeEngine,
    reason: 'cached',
    detail: 'would-merge',
    judgeAttestation: signJudgeAttestation({
      proposalId,
      judgeEngine,
      verdict: 'ship',
      diffHash: hashDiff(`+fix ${proposalId}\n`),
      issuedAt,
      mergeIntent: 'would-merge',
    }),
    judgeAttestationIssuedAt: issuedAt,
    judgeAttestationIntent: 'would-merge',
  };
}

// ===========================================================================
// [J1–J5] Judge-then-merge — happy path
// ===========================================================================

describe('M172 judge-then-merge — basic flow', () => {
  it('[J1] unjudged pending proposal + judge ship → autoMergeProposal called', async () => {
    const p = makeProp('j1');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]); // no cached verdict

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 'j1', verdict: 'ship', value: 5, correctness: 5,
      scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
    } satisfies ManagerVerdict);

    const r = await runAutoMergePass(enabledCfg());

    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('j1', expect.anything());
    expect(r.judged).toBe(1);
    expect(r.attempted).toBe(1);
    expect(r.merged).toBe(1);
  });

  it('[J1b] judge returns ship but wouldMerge=false → autoMergeProposal NOT called', async () => {
    const p = makeProp('j1b');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 'j1b', verdict: 'ship', value: 4, correctness: 4,
      scope: 1, alignment: 4, rationale: 'ship but do not merge', wouldMerge: false,
    } satisfies ManagerVerdict);

    const r = await runAutoMergePass(enabledCfg());

    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(mockRecordDecision).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'judged',
      verdict: 'ship',
    }));
    expect(r.judged).toBe(1);
    expect(r.attempted).toBe(0);
  });

  it('[J2] already-judged (hasRecentShipVerdict=true) → judge NOT called, goes to merge', async () => {
    const p = makeProp('j2');
    mockListProposals.mockReturnValue([p]);
    // Simulate a recent ship entry in the ledger
    mockReadDecisions.mockReturnValue([recentShipEntry('j2')]);

    const r = await runAutoMergePass(enabledCfg());

    // Judge should NOT be called — verdict was cached
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    // But autoMergeProposal IS called (cache hit → proceed to merge gate)
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('j2', expect.anything());
    expect(r.judged).toBe(0);
    expect(r.attempted).toBe(1);
  });

  it('[J2b] forged cached ship attestation → judge re-runs before merge', async () => {
    const p = makeProp('j2b');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([
      {
        ...recentShipEntry('j2b'),
        judgeAttestation: '0'.repeat(64),
      },
    ]);

    const r = await runAutoMergePass(enabledCfg());

    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('j2b', expect.anything());
    expect(r.judged).toBe(1);
    expect(r.attempted).toBe(1);
  });

  it('[J3] judge returns review → autoMergeProposal NOT called', async () => {
    const p = makeProp('j3');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 'j3', verdict: 'review', value: 3, correctness: 3,
      scope: 3, alignment: 3, rationale: 'needs review', wouldMerge: false,
    } satisfies ManagerVerdict);

    const r = await runAutoMergePass(enabledCfg());

    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.judged).toBe(1);
    expect(r.attempted).toBe(0);
    expect(r.merged).toBe(0);
  });

  it('[J4] judge returns noise → autoMergeProposal NOT called', async () => {
    const p = makeProp('j4');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 'j4', verdict: 'noise', value: 1, correctness: 1,
      scope: 1, alignment: 1, rationale: 'trivial', wouldMerge: false,
    } satisfies ManagerVerdict);

    const r = await runAutoMergePass(enabledCfg());

    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.judged).toBe(1);
    expect(r.attempted).toBe(0);
  });

  it('[J5] judge returns harmful → autoMergeProposal NOT called', async () => {
    const p = makeProp('j5');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 'j5', verdict: 'harmful', value: 1, correctness: 1,
      scope: 5, alignment: 1, rationale: 'dangerous', wouldMerge: false,
    } satisfies ManagerVerdict);

    const r = await runAutoMergePass(enabledCfg());

    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.judged).toBe(1);
    expect(r.attempted).toBe(0);
  });
});

// ===========================================================================
// [B1–B3] Bounds — judgePerPass cap
// ===========================================================================

describe('M172 bounds — judgePerPass cap', () => {
  it('[B1] judgePerPass=2, 4 unjudged proposals → judges 2, caps 2 (judgeCapped=2)', async () => {
    const proposals = ['b1a', 'b1b', 'b1c', 'b1d'].map((id) => makeProp(id));
    mockListProposals.mockReturnValue(proposals);
    mockReadDecisions.mockReturnValue([]); // all unjudged

    // All get 'ship' from judge (only first 2 should be called)
    mockJudgeProposal.mockResolvedValue({
      proposalId: 'any', verdict: 'ship', value: 5, correctness: 5,
      scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
    } satisfies ManagerVerdict);

    const r = await runAutoMergePass(enabledCfg({ judgePerPass: 2 }));

    expect(mockJudgeProposal).toHaveBeenCalledTimes(2);
    expect(r.judged).toBe(2);
    expect(r.judgeCapped).toBe(2);
    // 2 judged+ship → 2 attempted; 2 capped → 0 attempted for them
    expect(r.attempted).toBe(2);
  });

  it('[B2] already-judged proposals do NOT consume judgePerPass cap', async () => {
    // 3 proposals: first is already-judged, next 2 are unjudged
    const p1 = makeProp('b2a'); // already judged
    const p2 = makeProp('b2b'); // unjudged
    const p3 = makeProp('b2c'); // unjudged
    mockListProposals.mockReturnValue([p1, p2, p3]);

    // Only p1 has a cached entry
    mockReadDecisions.mockImplementation((opts?: { proposalId?: string }) => {
      if (opts?.proposalId === 'b2a') return [recentShipEntry('b2a')];
      return [];
    });

    mockJudgeProposal.mockResolvedValue({
      proposalId: 'any', verdict: 'ship', value: 5, correctness: 5,
      scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
    } satisfies ManagerVerdict);

    // Cap = 2: p1 cached (free), p2 judged (cap -1), p3 judged (cap -1) → both judged
    const r = await runAutoMergePass(enabledCfg({ judgePerPass: 2 }));

    expect(mockJudgeProposal).toHaveBeenCalledTimes(2); // p2 + p3
    expect(r.judged).toBe(2);
    expect(r.judgeCapped).toBe(0);
    expect(r.attempted).toBe(3); // p1 (cached) + p2 (ship) + p3 (ship)
  });

  it('[B3] default judgePerPass=8 when not set in cfg', async () => {
    // M259 raised the default judgePerPass from 5 → 8 to drain the queue faster.
    const proposals = Array.from({ length: 9 }, (_, i) => makeProp(`b3-${i}`));
    mockListProposals.mockReturnValue(proposals);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValue({
      proposalId: 'any', verdict: 'ship', value: 5, correctness: 5,
      scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
    } satisfies ManagerVerdict);

    // No judgePerPass in cfg → default 8
    const r = await runAutoMergePass(enabledCfg()); // no judgePerPass set

    expect(mockJudgeProposal).toHaveBeenCalledTimes(8);
    expect(r.judged).toBe(8);
    expect(r.judgeCapped).toBe(1); // 9th proposal capped
  });
});

// ===========================================================================
// [N1–N4] Never-throws
// ===========================================================================

describe('M172 never-throws', () => {
  it('[N1] judgeProposal throws → swallowed, pass continues to next proposal', async () => {
    const p1 = makeProp('n1a');
    const p2 = makeProp('n1b');
    mockListProposals.mockReturnValue([p1, p2]);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal
      .mockRejectedValueOnce(new Error('LLM timeout'))  // p1 throws
      .mockResolvedValueOnce({                           // p2 ships
        proposalId: 'n1b', verdict: 'ship', value: 5, correctness: 5,
        scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
      } satisfies ManagerVerdict);

    // Must not throw
    const r = await runAutoMergePass(enabledCfg());

    expect(r).toHaveProperty('judged');
    // p1 threw but counted as judged (we incremented before the throw could propagate)
    // p2 shipped → merge attempted
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('n1b', expect.anything());
  });

  it('[N2] autoMergeProposal throws → swallowed (existing contract)', async () => {
    const p = makeProp('n2');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('n2')]); // skip judge

    mockAutoMergeProposal.mockRejectedValueOnce(new Error('git error'));

    const r = await runAutoMergePass(enabledCfg());

    expect(r.attempted).toBe(1);
    expect(r.merged).toBe(0); // threw → merged not incremented
  });

  it('[N3] listProposals throws → returns zeros', async () => {
    mockListProposals.mockImplementationOnce(() => { throw new Error('store error'); });

    const r = await runAutoMergePass(enabledCfg());

    expect(r.attempted).toBe(0);
    expect(r.merged).toBe(0);
    expect(r.judged).toBe(0);
  });

  it('[N4] judge client unavailable (resolveFrontierJudgeClient returns null) → fail-closed, no merge', async () => {
    const p = makeProp('n4');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]); // unjudged

    // M176: automerge-pass now uses resolveFrontierJudgeClient (M135 path), not getActiveClient.
    // Simulate the frontier judge being unavailable by returning null.
    mockResolveFrontierJudgeClient.mockReturnValue(null);

    const r = await runAutoMergePass(enabledCfg());

    // No client → proposal not judged, not merged
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.attempted).toBe(0);
    expect(r.merged).toBe(0);
  });
});

// ===========================================================================
// [F1–F2] Flag invariants
// ===========================================================================

describe('M172 flag invariants', () => {
  it('[F1] autoMerge.enabled=false → returns zeros, judge never called', async () => {
    const p = makeProp('f1');
    mockListProposals.mockReturnValue([p]);

    const cfg: AshlrConfig = {
      foundry: { autoMerge: { enabled: false } },
    } as unknown as AshlrConfig;

    const r = await runAutoMergePass(cfg);

    expect(r.attempted).toBe(0);
    expect(r.merged).toBe(0);
    expect(r.judged).toBe(0);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

  it('[F2] kill switch on → returns zeros, judge never called', async () => {
    const p = makeProp('f2');
    mockListProposals.mockReturnValue([p]);
    mockKillSwitchOn.mockReturnValue(true);

    const r = await runAutoMergePass(enabledCfg());

    expect(r.attempted).toBe(0);
    expect(r.merged).toBe(0);
    expect(r.judged).toBe(0);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// [M175 extension] Verification-mode pre-filter in M172 test file
// These confirm that within the M172 judge-then-merge loop, the trust-basis-
// aware pre-filter correctly widens eligibility in verification mode while
// tier mode stays frontier-only (byte-identical to pre-M175 M51 behaviour).
// ===========================================================================

describe('M172+M175 trust-basis-aware pre-filter', () => {
  it('[T1] verification mode: LOCAL proposal IS judged (not skipped by pre-filter)', async () => {
    const p = makeProp('t1-local', 'local');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 't1-local', verdict: 'ship', value: 5, correctness: 5,
      scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
    } satisfies ManagerVerdict);

    const cfg = {
      foundry: {
        autoMerge: { enabled: true, trustBasis: 'verification' },
      },
    } as unknown as AshlrConfig;

    const r = await runAutoMergePass(cfg);

    // Judge MUST have been called — local proposal was not skipped by pre-filter.
    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(r.judged).toBe(1);
    // autoMergeProposal also called (judge shipped → proceed to gate).
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('t1-local', expect.anything());
    expect(r.attempted).toBe(1);
  });

  it('[T2] verification mode: MID proposal IS judged (not skipped by pre-filter)', async () => {
    const p = makeProp('t2-mid', 'mid');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 't2-mid', verdict: 'ship', value: 5, correctness: 5,
      scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
    } satisfies ManagerVerdict);

    const cfg = {
      foundry: {
        autoMerge: { enabled: true, trustBasis: 'verification' },
      },
    } as unknown as AshlrConfig;

    const r = await runAutoMergePass(cfg);

    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(r.judged).toBe(1);
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('t2-mid', expect.anything());
    expect(r.attempted).toBe(1);
  });

  it('[T3] tier mode (default/absent): LOCAL proposal is still SKIPPED by pre-filter (M51 intact)', async () => {
    const p = makeProp('t3-local', 'local');
    mockListProposals.mockReturnValue([p]);

    const cfg = {
      foundry: {
        autoMerge: { enabled: true },
      },
    } as unknown as AshlrConfig;

    const r = await runAutoMergePass(cfg);

    // Pre-filter must skip the local proposal before the judge is called.
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.judged).toBe(0);
    expect(r.attempted).toBe(0);
  });

  it('[T4] tier mode (explicit trustBasis=tier): LOCAL proposal is SKIPPED (M51 intact)', async () => {
    const p = makeProp('t4-local', 'local');
    mockListProposals.mockReturnValue([p]);

    const cfg = {
      foundry: {
        autoMerge: { enabled: true, trustBasis: 'tier' },
      },
    } as unknown as AshlrConfig;

    const r = await runAutoMergePass(cfg);

    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.judged).toBe(0);
    expect(r.attempted).toBe(0);
  });

  it('[T5] verification mode: local proposal judged NON-ship → autoMergeProposal NOT called', async () => {
    const p = makeProp('t5-local', 'local');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 't5-local', verdict: 'review', value: 3, correctness: 3,
      scope: 3, alignment: 3, rationale: 'needs review', wouldMerge: false,
    } satisfies ManagerVerdict);

    const cfg = {
      foundry: {
        autoMerge: { enabled: true, trustBasis: 'verification' },
      },
    } as unknown as AshlrConfig;

    const r = await runAutoMergePass(cfg);

    // Judge WAS called (proposal not skipped)
    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(r.judged).toBe(1);
    // But judge returned 'review' → autoMergeProposal must NOT be called
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.attempted).toBe(0);
  });

  it('[T6] tier mode: FRONTIER proposal reaches merge gate without pass-level judging', async () => {
    const p = makeProp('t6-frontier', 'frontier');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    const cfg = {
      foundry: {
        autoMerge: { enabled: true },
      },
    } as unknown as AshlrConfig;

    const r = await runAutoMergePass(cfg);

    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('t6-frontier', expect.anything());
    expect(r.judged).toBe(0);
    expect(r.attempted).toBe(1);
  });
});

// ===========================================================================
// [O1–O2] Output counters
// ===========================================================================

describe('M172 output counters', () => {
  it('[O1] judged counter increments per inline judge call', async () => {
    const proposals = ['o1a', 'o1b', 'o1c'].map((id) => makeProp(id));
    mockListProposals.mockReturnValue(proposals);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValue({
      proposalId: 'any', verdict: 'ship', value: 5, correctness: 5,
      scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
    } satisfies ManagerVerdict);

    const r = await runAutoMergePass(enabledCfg());

    expect(r.judged).toBe(3);
  });

  it('[O2] merged/attempted/branched reflect autoMergeProposal results', async () => {
    const p1 = makeProp('o2a');
    const p2 = makeProp('o2b');
    mockListProposals.mockReturnValue([p1, p2]);
    mockReadDecisions.mockReturnValue([
      recentShipEntry('o2a'),
      recentShipEntry('o2b'),
    ]);

    // p1 merges, p2 branches
    mockAutoMergeProposal
      .mockResolvedValueOnce({ ok: true, merged: true, branched: false })
      .mockResolvedValueOnce({ ok: true, merged: false, branched: true });

    const r = await runAutoMergePass(enabledCfg());

    expect(r.attempted).toBe(2);
    expect(r.merged).toBe(1);
    expect(r.branched).toBe(1);
    expect(r.results).toHaveLength(2);
  });
});
