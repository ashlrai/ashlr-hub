/**
 * M271 drain-stall tests — cheap drain path for persistently non-ship pendings.
 *
 * SAFETY PROOF tests:
 *  - A pending proposal with judgeNonShipCount>=1 that is capped out of judging
 *    has stuckPassCount incremented WITHOUT a fresh judge call.
 *  - After K stuck passes (stuckPassCount reaches autoArchiveAfterRejects),
 *    the proposal is archived (status→rejected) without ever being re-judged.
 *  - A proposal with judgeNonShipCount===0 (never judged non-ship) is NOT
 *    drained via the cheap path — it just gets judgeCapped normally.
 *  - A proposal that flips to a ship verdict on its next judge call merges
 *    instead of being archived (gate unchanged, no regression).
 *  - autoMergeProposal is never called for a drained proposal.
 *  - The merge gate (autoMergeProposal logic) is never reached for archives.
 *  - Drain uses setStatus('rejected') only — never hard-deletes.
 *
 * HOME is overridden to a tmp dir so no real ~/.ashlr state is touched.
 * autoMergeProposal, listProposals, setStatus, updateProposalField are MOCKED.
 * Fixed timestamps ensure deterministic results.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const mockSetStatus = vi.fn();
const mockUpdateProposalField = vi.fn();

let pendingProposals: Proposal[] = [];
const mockListProposals = vi.fn();

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    listProposals: (...args: unknown[]) => mockListProposals(...args),
    setStatus: (...args: unknown[]) => mockSetStatus(...args),
    updateProposalField: (...args: unknown[]) => mockUpdateProposalField(...args),
  };
});

const mockAutoMergeProposal = vi.fn();
vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
}));

const mockJudgeProposal = vi.fn();
const mockResolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mockJudgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mockResolveFrontierJudgeClient(...args),
}));

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn(() => []),
  recordDecision: vi.fn(),
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(async () => ({
    model: 'claude-opus-4-8',
    complete: async () => '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"mock"}',
  })),
}));

vi.mock('../src/core/fleet/self-improve.js', () => ({
  learnFromRejection: vi.fn(),
}));

vi.mock('../src/core/fleet/skill-library.js', () => ({
  learnFromApplied: vi.fn(),
}));

vi.mock('../src/core/integrations/fleet-pulse-emit.js', () => ({
  emitMerge: vi.fn(async () => {}),
  emitJudgeVerdict: vi.fn(async () => {}),
}));

vi.mock('../src/core/comms/events.js', () => ({
  notifyFleetEvent: vi.fn(async () => {}),
}));

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
// Lazy imports (after mocks)
// ---------------------------------------------------------------------------

import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';
import { setKill } from '../src/core/sandbox/policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-06-29T12:00:00.000Z';

function makeProposal(id: string, over?: Partial<Proposal>): Proposal {
  return {
    id,
    repo: '/tmp/repo',
    origin: 'swarm',
    kind: 'patch',
    title: `Proposal ${id}`,
    summary: 'summary',
    diff: `diff --git a/${id}.ts b/${id}.ts\n+// change for ${id}`,
    diffHash: `hash-${id}`,
    status: 'pending',
    engineTier: 'frontier',
    engineModel: 'claude:claude-sonnet-4-5',
    createdAt: NOW_ISO,
    ...over,
  };
}

/** Config with judgePerPass=1 so proposals cap quickly. */
function cfg271(overrides?: Record<string, unknown>): AshlrConfig {
  return {
    version: 1,
    foundry: {
      autoMerge: { enabled: true },
      autoArchiveAfterRejects: 3,
      proposalTtlDays: 30,
      judgePerPass: 1, // tight cap so proposals are capped by default
      ...overrides,
    },
  } as AshlrConfig;
}

function shipVerdict(proposalId: string) {
  return {
    proposalId,
    verdict: 'ship' as const,
    value: 5,
    correctness: 5,
    scope: 1,
    alignment: 5,
    rationale: 'looks good',
    wouldMerge: true,
  };
}

function reviewVerdict(proposalId: string) {
  return {
    proposalId,
    verdict: 'review' as const,
    value: 2,
    correctness: 2,
    scope: 3,
    alignment: 2,
    rationale: 'needs review',
    wouldMerge: false,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  setKill(false);
  // Default: no TTL rejection (listProposals called twice — once for TTL, once re-fetch)
  mockListProposals.mockImplementation(() => [...pendingProposals]);
  // Default judge client available
  mockResolveFrontierJudgeClient.mockReturnValue({
    model: 'claude-opus-4-8',
    complete: async () => '{}',
  });
  // Default autoMergeProposal: returns merged=true (gate would pass)
  mockAutoMergeProposal.mockResolvedValue({
    merged: true,
    branched: false,
    proposalId: 'mock',
    reason: '',
  } as AutoMergeResult);
  // Default judge: ship (overridden per test)
  mockJudgeProposal.mockResolvedValue(shipVerdict('mock'));
  tmpHome = `/tmp/m271-test-${Date.now()}`;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M271 cheap drain path', () => {
  it('increments stuckPassCount (no judge call) for capped proposals with judgeNonShipCount>=1', async () => {
    // judgePerPass=1 and there are 2 proposals — the second gets capped.
    // The second already has judgeNonShipCount=1 → should get stuckPassCount=1 via cheap drain.
    const p1 = makeProposal('p-judged', { judgeNonShipCount: 0 });
    const p2 = makeProposal('p-capped', { judgeNonShipCount: 1, stuckPassCount: 0 });
    pendingProposals = [p1, p2];
    mockListProposals.mockImplementation(() => [...pendingProposals]);

    // p1 gets judged → ship verdict → proceeds to merge gate
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('p-judged'));

    const result = await runAutoMergePass(cfg271({ judgePerPass: 1 }));

    // p1 was judged (ship) and reached the merge gate
    expect(mockJudgeProposal).toHaveBeenCalledTimes(1);
    expect(mockAutoMergeProposal).toHaveBeenCalledTimes(1);
    expect(result.judged).toBe(1);
    expect(result.judgeCapped).toBe(1);

    // p2 was capped — but cheap drain incremented stuckPassCount to 1
    const stuckCall = mockUpdateProposalField.mock.calls.find(
      (c) => c[0] === 'p-capped' && c[1]?.stuckPassCount !== undefined,
    );
    expect(stuckCall).toBeDefined();
    expect(stuckCall![1]).toEqual({ stuckPassCount: 1 });

    // p2 was NOT judged
    const judgeCallsForCapped = mockJudgeProposal.mock.calls.filter((c) =>
      String(c[0]?.id) === 'p-capped',
    );
    expect(judgeCallsForCapped).toHaveLength(0);
  });

  it('archives (rejects) a capped proposal when stuckPassCount reaches autoArchiveAfterRejects', async () => {
    // stuckPassCount is already at 2; this pass pushes it to 3 → archive.
    const p1 = makeProposal('p-filler', { judgeNonShipCount: 0 });
    const pStuck = makeProposal('p-stuck', {
      judgeNonShipCount: 1,
      stuckPassCount: 2, // one more increment → reaches threshold of 3
    });
    pendingProposals = [p1, pStuck];
    mockListProposals.mockImplementation(() => [...pendingProposals]);

    // p1 is judged ship → consumes the judgePerPass=1 budget
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('p-filler'));

    const result = await runAutoMergePass(cfg271({ judgePerPass: 1, autoArchiveAfterRejects: 3 }));

    // p-stuck should be archived (setStatus called with 'rejected')
    const archiveCall = mockSetStatus.mock.calls.find(
      (c) => c[0] === 'p-stuck' && c[1] === 'rejected',
    );
    expect(archiveCall).toBeDefined();
    expect(archiveCall![3]).toMatch(/M271 drained/);
    expect(result.autoArchived).toBeGreaterThanOrEqual(1);

    // p-stuck was NEVER judged
    const judgedCapped = mockJudgeProposal.mock.calls.filter((c) =>
      String(c[0]?.id) === 'p-stuck',
    );
    expect(judgedCapped).toHaveLength(0);

    // p-stuck never reached autoMergeProposal
    const mergeForCapped = mockAutoMergeProposal.mock.calls.filter((c) => c[0] === 'p-stuck');
    expect(mergeForCapped).toHaveLength(0);
  });

  it('does NOT drain proposals with judgeNonShipCount===0 (first-timer, just caps normally)', async () => {
    // Two proposals — both have judgeNonShipCount=0. Second is capped but NOT drained.
    const p1 = makeProposal('p-first', { judgeNonShipCount: 0 });
    const p2 = makeProposal('p-fresh', { judgeNonShipCount: 0 });
    pendingProposals = [p1, p2];
    mockListProposals.mockImplementation(() => [...pendingProposals]);

    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('p-first'));

    await runAutoMergePass(cfg271({ judgePerPass: 1 }));

    // No stuckPassCount update for p2 (never judged non-ship)
    const stuckCall = mockUpdateProposalField.mock.calls.find(
      (c) => c[0] === 'p-fresh' && c[1]?.stuckPassCount !== undefined,
    );
    expect(stuckCall).toBeUndefined();

    // No setStatus('rejected') for p2 either
    const archiveCall = mockSetStatus.mock.calls.find(
      (c) => c[0] === 'p-fresh' && c[1] === 'rejected',
    );
    expect(archiveCall).toBeUndefined();
  });

  it('NEVER archives a proposal that gets a ship verdict — it merges instead', async () => {
    // Proposal has judgeNonShipCount=2, stuckPassCount=0.
    // This pass: it makes it under the cap AND gets judged ship → should MERGE, not archive.
    const pShip = makeProposal('p-ship', {
      judgeNonShipCount: 2,
      stuckPassCount: 0,
    });
    pendingProposals = [pShip];
    mockListProposals.mockImplementation(() => [...pendingProposals]);

    // Judge returns ship
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('p-ship'));

    const result = await runAutoMergePass(cfg271({ judgePerPass: 5 }));

    // Should reach the merge gate
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('p-ship', expect.anything());

    // Should NOT be archived
    const archiveCall = mockSetStatus.mock.calls.find(
      (c) => c[0] === 'p-ship' && c[1] === 'rejected',
    );
    expect(archiveCall).toBeUndefined();

    // autoArchived counter unchanged
    expect(result.autoArchived).toBe(0);
  });

  it('drain accumulates across simulated passes correctly (stuckPassCount 0→1→2→archive)', async () => {
    // Simulate K=3 cheap passes by resetting the proposal between calls.
    // Pass 1: stuckPassCount 0 → 1
    // Pass 2: stuckPassCount 1 → 2
    // Pass 3: stuckPassCount 2 → 3 (archive)

    // judgePerPass=1 + a filler proposal ensures p-drain is always capped each pass.
    const baseCfg = cfg271({ judgePerPass: 1, autoArchiveAfterRejects: 3 });

    let currentStuck = 0;
    let archived = false;

    for (let pass = 1; pass <= 3; pass++) {
      vi.clearAllMocks(); // clear call history only — preserves async factory implementations
      setKill(false);
      mockResolveFrontierJudgeClient.mockReturnValue({ model: 'm', complete: async () => '{}' });
      // filler gets judged (ship) — consuming the judgePerPass=1 budget
      mockJudgeProposal.mockResolvedValue(shipVerdict('p-filler'));
      mockAutoMergeProposal.mockResolvedValue({ merged: true, branched: false, proposalId: 'p-filler', reason: '' });

      const pFiller = makeProposal('p-filler', { judgeNonShipCount: 0 });
      const pDrain = makeProposal('p-drain', {
        judgeNonShipCount: 1,
        stuckPassCount: currentStuck,
      });
      // filler listed first → gets judged first → burns the cap
      pendingProposals = [pFiller, pDrain];
      mockListProposals.mockImplementation(() => [...pendingProposals]);

      const result = await runAutoMergePass(baseCfg);

      if (pass < 3) {
        // Should increment stuckPassCount
        const stuckCall = mockUpdateProposalField.mock.calls.find(
          (c) => c[0] === 'p-drain' && c[1]?.stuckPassCount !== undefined,
        );
        expect(stuckCall).toBeDefined();
        expect(stuckCall![1].stuckPassCount).toBe(currentStuck + 1);
        currentStuck++;
        expect(result.autoArchived).toBe(0);
      } else {
        // Pass 3: should archive
        const archiveCall = mockSetStatus.mock.calls.find(
          (c) => c[0] === 'p-drain' && c[1] === 'rejected',
        );
        expect(archiveCall).toBeDefined();
        expect(archiveCall![3]).toMatch(/M271 drained/);
        expect(result.autoArchived).toBeGreaterThanOrEqual(1);
        archived = true;
      }

      // p-drain was NEVER judged (capped behind filler) — filler may have been judged
      const judgeCallsForDrain = mockJudgeProposal.mock.calls.filter(
        (c) => String(c[0]?.id) === 'p-drain',
      );
      expect(judgeCallsForDrain).toHaveLength(0);
    }

    expect(archived).toBe(true);
  });

  it('gate is unchanged — a ship+autoMerge proposal still merges (no regression)', async () => {
    // Single proposal, ample judgePerPass — normal happy path unaffected.
    const pOk = makeProposal('p-ok', { judgeNonShipCount: 0 });
    pendingProposals = [pOk];
    mockListProposals.mockImplementation(() => [...pendingProposals]);

    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('p-ok'));
    mockAutoMergeProposal.mockResolvedValue({
      merged: true,
      branched: false,
      proposalId: 'p-ok',
      reason: '',
    } as AutoMergeResult);

    const result = await runAutoMergePass(cfg271({ judgePerPass: 5 }));

    expect(result.merged).toBe(1);
    expect(result.autoArchived).toBe(0);
    expect(mockJudgeProposal).toHaveBeenCalledTimes(1);
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('p-ok', expect.anything());
  });
});
