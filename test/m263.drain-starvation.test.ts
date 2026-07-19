/**
 * M263: drain starvation fix — oldest-first judge ordering.
 *
 * The bug: proposal reads return most-recent-first. When the judge loop
 * iterates in that order and the pass is interrupted (killed, paused, capped),
 * the OLDEST pending proposal is always last and always the first to be skipped.
 * A proposal pending since day 0 could go unjudged indefinitely.
 *
 * The fix (automerge-pass.ts): after enumeration, sort pending oldest-first
 * before the judge loop so the stalest entries drain first.
 *
 * Tests assert:
 *  1. With judgePerPass=1, the OLDEST proposal (not the newest) is judged.
 *  2. judgeNonShipCount increments correctly from unset (treated as 0).
 *  3. The oldest proposal reaches judgeNonShipCount=K and is auto-archived.
 *  4. The merge gate is unchanged — ship verdict still proceeds to autoMergeProposal.
 *  5. NO-REGRESSION: m259 auto-archive + TTL behavior is unaffected by the sort.
 *
 * SAFETY PROOF: the sort only reorders which proposal is judged FIRST within a
 * pass. It NEVER causes a merge — a proposal can only be merged after a frontier
 * judge 'ship' verdict + HMAC attestation + all M47 gate criteria. None of those
 * are weakened by sort order.
 *
 * Mocking follows the same pattern as m259.queue-drain.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { AutoMergeResult } from '../src/core/inbox/merge.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(),
  isEnrolled: () => true,
}));

const mockSetStatus = vi.fn();
const mockUpdateProposalField = vi.fn();

let pendingProposals: Proposal[] = [];
const mockListProposals = vi.fn();

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    listProposalsDetailed: (...args: unknown[]) => ({
      proposals: mockListProposals(...args),
      sourceState: 'healthy',
      complete: true,
    }),
    setStatus: (...args: unknown[]) => mockSetStatus(...args),
    updateProposalField: (...args: unknown[]) => mockUpdateProposalField(...args),
  };
});

const mockAutoMergeProposal = vi.fn();
vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
  evaluateAutoMergeReadinessPreflight: () => ({ ready: true, advisories: [] }),
  isFrontierJudge: (engine: string | undefined) => /claude|gpt|codex/.test(String(engine ?? '').toLowerCase()),
}));

const mockJudgeProposal = vi.fn();
const mockResolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mockJudgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mockResolveFrontierJudgeClient(...args),
}));

const mockRecordDecision = vi.fn();
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn(() => []),
  recordDecision: (...args: unknown[]) => mockRecordDecision(...args),
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(async () => ({
    model: 'claude-opus-4-8',
    complete: async () => '{"verdict":"review","value":2,"correctness":2,"scope":2,"alignment":2,"rationale":"mock"}',
  })),
}));

vi.mock('../src/core/fleet/self-improve.js', () => ({ learnFromRejection: vi.fn() }));
vi.mock('../src/core/fleet/skill-library.js', () => ({ learnFromApplied: vi.fn() }));
vi.mock('../src/core/integrations/fleet-pulse-emit.js', () => ({
  emitMerge: vi.fn(async () => {}),
  emitJudgeVerdict: vi.fn(async () => {}),
}));
vi.mock('../src/core/comms/events.js', () => ({ notifyFleetEvent: vi.fn(async () => {}) }));
vi.mock('../src/core/run/blast-radius.js', () => ({
  analyzeBlastRadius: vi.fn(async () => ({ risk: 'low', detail: '' })),
}));
vi.mock('../src/core/run/spec-contract.js', () => ({
  checkSpecContract: vi.fn(async () => ({ satisfied: true, detail: { reason: '' } })),
}));
vi.mock('../src/core/fleet/red-team.js', () => ({
  redTeamProposal: vi.fn(async () => ({ verdict: 'ok', detail: '' })),
}));

// ---------------------------------------------------------------------------
// Lazy import (after mocks)
// ---------------------------------------------------------------------------

import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';
import { setKill } from '../src/core/sandbox/policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Proposal timestamps spaced 1 hour apart; lower index = older. */
const BASE_MS = new Date('2026-06-24T00:00:00.000Z').getTime();
const TEST_NOW_MS = new Date('2026-06-29T12:00:00.000Z').getTime();
function isoAt(offsetHours: number): string {
  return new Date(BASE_MS + offsetHours * 3_600_000).toISOString();
}

function makeProposal(id: string, over?: Partial<Proposal>): Proposal {
  return {
    id,
    repo: '/tmp/repo',
    origin: 'agent',
    kind: 'patch',
    title: `Proposal ${id}`,
    summary: 'summary',
    diff: `diff --git a/${id}.ts\n+// ${id}`,
    diffHash: `hash-${id}`,
    status: 'pending',
    engineTier: 'frontier',
    engineModel: 'codex:gpt-5.5',
    createdAt: isoAt(0),
    ...over,
  };
}

function baseCfg(overrides?: Record<string, unknown>): AshlrConfig {
  return {
    version: 1,
    foundry: {
      autoMerge: { enabled: true, managerGate: true },
      autoArchiveAfterRejects: 3,
      proposalTtlDays: 14,
      judgePerPass: 8,
      ...overrides,
    },
  } as AshlrConfig;
}

function reviewVerdict(proposalId: string) {
  return {
    proposalId,
    verdict: 'review' as const,
    value: 2, correctness: 2, scope: 3, alignment: 2,
    rationale: 'needs review',
    wouldMerge: false,
  };
}

function shipVerdict(proposalId: string) {
  return {
    proposalId,
    verdict: 'ship' as const,
    value: 5, correctness: 5, scope: 1, alignment: 5,
    rationale: 'looks good',
    wouldMerge: true,
  };
}

function expectAttestedShipDecision(proposalId: string): void {
  const call = mockRecordDecision.mock.calls.find(
    ([entry]) => (entry as Record<string, unknown>)['proposalId'] === proposalId,
  );
  expect(call).toBeDefined();
  const entry = call![0] as Record<string, unknown>;
  expect(entry).toEqual(expect.objectContaining({
    proposalId,
    action: 'judged',
    engine: 'claude-opus-4-8',
    verdict: 'ship',
    detail: 'would-merge',
    judgeAttestationIssuedAt: expect.any(String),
    judgeAttestationIntent: 'would-merge',
  }));
  expect(entry['judgeAttestation']).toMatch(/^[0-9a-f]{64}$/);
  expect(entry['judgeAttestationIssuedAt']).toBe(entry['ts']);
}

beforeEach(() => {
  vi.useFakeTimers({ now: TEST_NOW_MS, toFake: ['Date'] });
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m263-'));
  process.env.HOME = tmpHome;

  pendingProposals = [];
  mockListProposals.mockReset();
  mockAutoMergeProposal.mockReset();
  mockJudgeProposal.mockReset();
  mockSetStatus.mockReset();
  mockUpdateProposalField.mockReset();
  mockRecordDecision.mockReset();

  mockListProposals.mockImplementation(() => pendingProposals);
  mockSetStatus.mockReturnValue(true);
  mockUpdateProposalField.mockReturnValue(true);
  mockAutoMergeProposal.mockImplementation(async (id: string) => ({
    ok: true, merged: true, reason: `merged ${id}`,
  } as AutoMergeResult));
  mockResolveFrontierJudgeClient.mockReturnValue({
    model: 'claude-opus-4-8',
    complete: async () => '{"verdict":"review","value":2,"correctness":2,"scope":2,"alignment":2,"rationale":"mock"}',
  });

  try { setKill(false); } catch { /* ignore */ }
});

afterEach(() => {
  vi.useRealTimers();
  try { setKill(false); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.clearAllMocks();
});

// ===========================================================================
// 1. OLDEST-FIRST: starvation prevention
// ===========================================================================

describe('M263 oldest-first judge ordering (starvation fix)', () => {
  it('with judgePerPass=1, judges the OLDEST proposal (not the newest)', async () => {
    // listProposals returns newest-first (as the real store does).
    // The loop must re-sort oldest-first and judge p-old before p-new.
    const pOld = makeProposal('p-old', { createdAt: isoAt(0) });  // oldest
    const pMid = makeProposal('p-mid', { createdAt: isoAt(1) });
    const pNew = makeProposal('p-new', { createdAt: isoAt(2) });  // newest

    // Return in most-recent-first order (as real listProposals does).
    pendingProposals = [pNew, pMid, pOld];
    mockJudgeProposal.mockResolvedValue(reviewVerdict('p-old'));

    const out = await runAutoMergePass(baseCfg({ judgePerPass: 1 }));

    // Only 1 judge call fired (cap=1)
    expect(out.judged).toBe(1);
    expect(out.judgeCapped).toBe(2);

    // The judgeProposal call must have been for p-old (oldest), not p-new (newest)
    expect(mockJudgeProposal).toHaveBeenCalledTimes(1);
    const judgedId = (mockJudgeProposal.mock.calls[0]![0] as Proposal).id;
    expect(judgedId).toBe('p-old');
  });

  it('all proposals judged when cap >= count, still oldest-first order', async () => {
    const pOld = makeProposal('p-a', { createdAt: isoAt(0) });
    const pMid = makeProposal('p-b', { createdAt: isoAt(5) });
    const pNew = makeProposal('p-c', { createdAt: isoAt(10) });

    // Return newest-first
    pendingProposals = [pNew, pMid, pOld];
    mockJudgeProposal.mockImplementation(async (p: Proposal) => reviewVerdict(p.id));

    const out = await runAutoMergePass(baseCfg({ judgePerPass: 10 }));

    expect(out.judged).toBe(3);
    expect(out.judgeCapped).toBe(0);

    // Calls should be in oldest-first order
    const judgedIds = mockJudgeProposal.mock.calls.map((c) => (c[0] as Proposal).id);
    expect(judgedIds).toEqual(['p-a', 'p-b', 'p-c']);
  });

  it('a proposal with same createdAt is stable (no crash, all judged)', async () => {
    const ts = isoAt(0);
    const proposals = [
      makeProposal('same-a', { createdAt: ts }),
      makeProposal('same-b', { createdAt: ts }),
    ];
    pendingProposals = proposals;
    mockJudgeProposal.mockImplementation(async (p: Proposal) => reviewVerdict(p.id));

    const out = await runAutoMergePass(baseCfg({ judgePerPass: 10 }));
    expect(out.judged).toBe(2);
  });
});

// ===========================================================================
// 2. judgeNonShipCount increments from unset (treated as 0)
// ===========================================================================

describe('M263 judgeNonShipCount increments correctly', () => {
  it('unset count (no field) treated as 0, incremented to 1', async () => {
    // judgeNonShipCount field absent — must default to 0 → increment to 1
    const p = makeProposal('p-unset'); // no judgeNonShipCount field
    expect((p as Record<string, unknown>)['judgeNonShipCount']).toBeUndefined();
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(reviewVerdict('p-unset'));

    const out = await runAutoMergePass(baseCfg());

    expect(out.autoArchived).toBe(0);
    expect(mockUpdateProposalField).toHaveBeenCalledWith(
      'p-unset',
      { judgeNonShipCount: 1 },
      expect.anything(),
    );
  });

  it('count=1 incremented to 2 (below K=3 threshold)', async () => {
    const p = makeProposal('p-count1', { judgeNonShipCount: 1 });
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(reviewVerdict('p-count1'));

    const out = await runAutoMergePass(baseCfg());

    expect(out.autoArchived).toBe(0);
    expect(mockUpdateProposalField).toHaveBeenCalledWith(
      'p-count1',
      { judgeNonShipCount: 2 },
      expect.anything(),
    );
  });

  it('count=2 → non-ship → reaches K=3 → auto-archived', async () => {
    const p = makeProposal('p-count2', { judgeNonShipCount: 2 });
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(reviewVerdict('p-count2'));

    const out = await runAutoMergePass(baseCfg());

    expect(out.autoArchived).toBe(1);
    expect(mockSetStatus).toHaveBeenCalledWith(
      'p-count2', 'rejected', undefined, expect.stringContaining('auto-archived'), expect.anything(), {}, 'pending',
    );
    // updateProposalField must NOT be called for archived (setStatus is used instead)
    expect(mockUpdateProposalField).not.toHaveBeenCalledWith('p-count2', expect.anything());
    // NEVER forwarded to merge gate
    expect(mockAutoMergeProposal).not.toHaveBeenCalledWith('p-count2', expect.anything());
  });

  it('oldest proposal in mixed queue gets judged + counted first', async () => {
    // Simulates the exact live bug: oldest proposal always last in most-recent-first
    // list, always the one skipped when pass is capped.
    const oldest = makeProposal('p-oldest', { createdAt: isoAt(0) });  // was unset
    const newer  = makeProposal('p-newer',  { createdAt: isoAt(48), judgeNonShipCount: 1 });

    // listProposals returns newest-first
    pendingProposals = [newer, oldest];

    mockJudgeProposal.mockImplementation(async (p: Proposal) => reviewVerdict(p.id));

    // Cap at 1 — only oldest should be judged
    const out = await runAutoMergePass(baseCfg({ judgePerPass: 1 }));

    expect(out.judged).toBe(1);
    const firstJudged = (mockJudgeProposal.mock.calls[0]![0] as Proposal).id;
    expect(firstJudged).toBe('p-oldest');

    // oldest gets count bumped from 0→1
    expect(mockUpdateProposalField).toHaveBeenCalledWith(
      'p-oldest',
      { judgeNonShipCount: 1 },
      expect.anything(),
    );
    // newer is NOT judged this pass (capped)
    expect(mockJudgeProposal).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 3. SHIP VERDICT: merge path intact (gate unchanged)
// ===========================================================================

describe('M263 ship verdict — merge gate unchanged', () => {
  it('ship verdict on oldest proposal still calls autoMergeProposal', async () => {
    const pOld = makeProposal('p-ship-old', { createdAt: isoAt(0) });
    const pNew = makeProposal('p-ship-new', { createdAt: isoAt(24) });

    pendingProposals = [pNew, pOld]; // newest-first from store
    mockJudgeProposal.mockImplementation(async (p: Proposal) => shipVerdict(p.id));

    await runAutoMergePass(baseCfg());

    // Both should reach the merge gate (both ship)
    expectAttestedShipDecision('p-ship-old');
    expectAttestedShipDecision('p-ship-new');
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('p-ship-old', expect.anything());
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('p-ship-new', expect.anything());
  });

  it('ship verdict does NOT increment judgeNonShipCount', async () => {
    const p = makeProposal('p-ship-nocount', { judgeNonShipCount: 2 });
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(shipVerdict('p-ship-nocount'));

    await runAutoMergePass(baseCfg());

    // No archive
    expect(mockSetStatus).not.toHaveBeenCalledWith(
      'p-ship-nocount', 'rejected', expect.anything(), expect.anything(),
    );
    // updateProposalField may reset count to 0, but must NOT increment it
    const updateCalls = mockUpdateProposalField.mock.calls.filter(
      (c) => c[0] === 'p-ship-nocount' &&
             typeof (c[1] as Record<string, unknown>)['judgeNonShipCount'] === 'number' &&
             ((c[1] as Record<string, unknown>)['judgeNonShipCount'] as number) > 2,
    );
    expect(updateCalls).toHaveLength(0);
    // Proceeds to merge gate
    expectAttestedShipDecision('p-ship-nocount');
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('p-ship-nocount', expect.anything());
  });
});

// ===========================================================================
// 4. NO-REGRESSION: m259 TTL + auto-archive behavior unaffected by the sort
// ===========================================================================

describe('M263 no-regression: m259 TTL + auto-archive unaffected', () => {
  it('TTL rejection still fires for stale proposals regardless of sort order', async () => {
    vi.setSystemTime(TEST_NOW_MS);

    const staleDate = new Date(TEST_NOW_MS - 10 * 24 * 60 * 60 * 1000).toISOString();
    const stale = makeProposal('p-stale-regress', { createdAt: staleDate });
    const fresh = makeProposal('p-fresh-regress', {
      createdAt: new Date(TEST_NOW_MS - 1 * 24 * 60 * 60 * 1000).toISOString(),
    });

    mockListProposals
      .mockReturnValueOnce([fresh, stale]) // initial fetch (newest-first)
      .mockReturnValueOnce([fresh, stale]); // authoritative refresh

    mockJudgeProposal.mockImplementation(async (p: Proposal) => shipVerdict(p.id));

    const out = await runAutoMergePass(baseCfg({ proposalTtlDays: 7 }));

    expect(out.ttlRejected).toBe(1);
    expect(mockSetStatus).toHaveBeenCalledWith(
      'p-stale-regress', 'rejected', undefined, expect.stringContaining('TTL'), expect.anything(), {}, 'pending',
    );
  });

  it('auto-archive at K=3 still fires after sort reorder', async () => {
    // Oldest proposal already at count=2 — this review is the 3rd → archive
    const pOld = makeProposal('p-archive-regress', {
      createdAt: isoAt(0),
      judgeNonShipCount: 2,
    });
    const pNew = makeProposal('p-ok-regress', {
      createdAt: isoAt(48),
      judgeNonShipCount: 0,
    });

    // Newest-first from store
    pendingProposals = [pNew, pOld];
    mockJudgeProposal.mockImplementation(async (p: Proposal) => reviewVerdict(p.id));

    // Cap=1 → only oldest judged
    const out = await runAutoMergePass(baseCfg({ judgePerPass: 1 }));

    expect(out.autoArchived).toBe(1);
    expect(mockSetStatus).toHaveBeenCalledWith(
      'p-archive-regress', 'rejected', undefined, expect.stringContaining('auto-archived'), expect.anything(), {}, 'pending',
    );
    expect(mockAutoMergeProposal).not.toHaveBeenCalledWith(
      'p-archive-regress', expect.anything(),
    );
  });
});
