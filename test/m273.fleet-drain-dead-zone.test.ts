/**
 * M273 fleet drain dead-zone tests.
 *
 * THE DEAD ZONE:
 *   When pending count < judgePerPass, proposals are NOT capped. They reach
 *   the judge path each pass. If the judge client is null (unavailable) the
 *   old code fell through to `continue` with NO increment of judgeNonShipCount
 *   OR stuckPassCount — proposals idled forever.
 *
 * THE FIX (M273):
 *   When judgeClient===null AND the proposal already has judgeNonShipCount>=1
 *   (was seen as non-ship at least once before), apply M271-style stuckPassCount
 *   accrual so the proposal eventually archives. Fresh proposals (judgeNonShipCount=0)
 *   are NOT drained via the cheap path — they wait for a judge to become available
 *   (fail-safe: a proposal that might ship if a judge comes back is not pre-emptively
 *   archived). Ship-recovery is fully preserved: when judgeClient is non-null and
 *   returns 'ship', the proposal proceeds to the merge gate as before.
 *
 * Tests:
 *  1. With null judge client + judgeNonShipCount>=1: stuckPassCount increments (no judge call).
 *  2. With null judge client + judgeNonShipCount>=1: archives when stuckPassCount reaches K.
 *  3. With null judge client + judgeNonShipCount===0 (fresh): NOT drained (safe-stall).
 *  4. A pending-that-would-ship: when judge IS available and returns ship, still merges.
 *  5. Drain accumulates across passes: 0→1→2→archive.
 *  6. judgeNonShipCount increments correctly in non-capped path when judge is available.
 *
 * HOME is overridden to a tmp dir so no real ~/.ashlr state is touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { AutoMergeResult } from '../src/core/inbox/merge.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
const origAshlrHome = process.env.ASHLR_HOME;
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
  isFrontierJudge: (engine: string | undefined) =>
    typeof engine === 'string' && engine.toLowerCase().includes('claude'),
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

/** Config with high judgePerPass so proposals are never capped (small backlog scenario). */
function cfg273(overrides?: Record<string, unknown>): AshlrConfig {
  return {
    version: 1,
    foundry: {
      autoMerge: { enabled: true, managerGate: true },
      autoArchiveAfterRejects: 3,
      proposalTtlDays: 30,
      judgePerPass: 8, // high cap — small backlog never reaches cap
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m273-test-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = join(tmpHome, '.ashlr');
  mockSetStatus.mockReturnValue(true);
  mockUpdateProposalField.mockReturnValue(true);
  setKill(false);
  mockListProposals.mockImplementation(() => []);
  // Default: judge unavailable (null client) — the dead-zone scenario
  mockResolveFrontierJudgeClient.mockReturnValue(null);
  mockAutoMergeProposal.mockResolvedValue({
    merged: true,
    branched: false,
    proposalId: 'mock',
    reason: '',
  } as AutoMergeResult);
  mockJudgeProposal.mockResolvedValue(shipVerdict('mock'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M273 fleet drain dead-zone', () => {
  it('increments stuckPassCount (no judge call) when client is null and judgeNonShipCount>=1', async () => {
    // Dead-zone scenario: 1 pending proposal, judgePerPass=8 (never capped),
    // judge client is null, but proposal already has judgeNonShipCount=1 from a prior run.
    const p = makeProposal('p-deadzone', { judgeNonShipCount: 1, stuckPassCount: 0 });
    mockListProposals.mockReturnValue([p]);
    mockResolveFrontierJudgeClient.mockReturnValue(null); // judge unavailable

    const result = await runAutoMergePass(cfg273());

    // No judge call — client was null
    expect(mockJudgeProposal).not.toHaveBeenCalled();

    // stuckPassCount should be incremented to 1
    const stuckCall = mockUpdateProposalField.mock.calls.find(
      (c) => c[0] === 'p-deadzone' && c[1]?.stuckPassCount !== undefined,
    );
    expect(stuckCall).toBeDefined();
    expect(stuckCall![1]).toEqual({ stuckPassCount: 1 });

    // Not archived yet (only 1 pass)
    expect(result.autoArchived).toBe(0);
    const archiveCall = mockSetStatus.mock.calls.find(
      (c) => c[0] === 'p-deadzone' && c[1] === 'rejected',
    );
    expect(archiveCall).toBeUndefined();
  });

  it('archives when stuckPassCount reaches autoArchiveAfterRejects (null-client drain)', async () => {
    // stuckPassCount already at 2 — this pass pushes it to 3 → archive
    const p = makeProposal('p-archive', { judgeNonShipCount: 1, stuckPassCount: 2 });
    mockListProposals.mockReturnValue([p]);
    mockResolveFrontierJudgeClient.mockReturnValue(null);

    const result = await runAutoMergePass(cfg273({ autoArchiveAfterRejects: 3 }));

    // No judge call
    expect(mockJudgeProposal).not.toHaveBeenCalled();

    // Should be archived
    const archiveCall = mockSetStatus.mock.calls.find(
      (c) => c[0] === 'p-archive' && c[1] === 'rejected',
    );
    expect(archiveCall).toBeDefined();
    expect(archiveCall![3]).toMatch(/M273 drained/);
    expect(result.autoArchived).toBeGreaterThanOrEqual(1);

    // Never reached autoMergeProposal
    const mergeCall = mockAutoMergeProposal.mock.calls.find((c) => c[0] === 'p-archive');
    expect(mergeCall).toBeUndefined();
  });

  it('does NOT drain fresh proposals (judgeNonShipCount===0) when client is null', async () => {
    // Fresh proposal that has never been judged — must NOT be drained via cheap path
    // when judge is unavailable. It stays pending until a judge is available.
    const p = makeProposal('p-fresh', { judgeNonShipCount: 0 });
    mockListProposals.mockReturnValue([p]);
    mockResolveFrontierJudgeClient.mockReturnValue(null);

    await runAutoMergePass(cfg273());

    // No stuckPassCount update
    const stuckCall = mockUpdateProposalField.mock.calls.find(
      (c) => c[0] === 'p-fresh' && c[1]?.stuckPassCount !== undefined,
    );
    expect(stuckCall).toBeUndefined();

    // No rejection
    const archiveCall = mockSetStatus.mock.calls.find(
      (c) => c[0] === 'p-fresh' && c[1] === 'rejected',
    );
    expect(archiveCall).toBeUndefined();
  });

  it('NEVER archives a proposal that gets a ship verdict — ship-recovery fully preserved', async () => {
    // Proposal has judgeNonShipCount=1, stuckPassCount=2.
    // This pass: judge IS available and returns ship → must MERGE, not archive.
    const pShip = makeProposal('p-ship-recovery', {
      judgeNonShipCount: 1,
      stuckPassCount: 2,
    });
    mockListProposals.mockReturnValue([pShip]);

    // Judge IS available this pass
    mockResolveFrontierJudgeClient.mockReturnValue({
      model: 'claude-opus-4-8',
      complete: async () => '{}',
    });
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict('p-ship-recovery'));

    const result = await runAutoMergePass(cfg273({ judgePerPass: 8 }));

    // Judge was called
    expect(mockJudgeProposal).toHaveBeenCalledTimes(1);

    // Reached the merge gate
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('p-ship-recovery', expect.anything());

    // NOT archived
    const archiveCall = mockSetStatus.mock.calls.find(
      (c) => c[0] === 'p-ship-recovery' && c[1] === 'rejected',
    );
    expect(archiveCall).toBeUndefined();
    expect(result.autoArchived).toBe(0);
    expect(result.merged).toBe(1);
  });

  it('drain accumulates across passes (stuckPassCount 0→1→2→archive) with null client', async () => {
    const baseCfg = cfg273({ judgePerPass: 8, autoArchiveAfterRejects: 3 });
    let currentStuck = 0;
    let archived = false;

    for (let pass = 1; pass <= 3; pass++) {
      vi.clearAllMocks();
      setKill(false);
      mockResolveFrontierJudgeClient.mockReturnValue(null); // always null
      mockAutoMergeProposal.mockResolvedValue({ merged: true, branched: false, proposalId: 'mock', reason: '' });

      const p = makeProposal('p-drain', {
        judgeNonShipCount: 1, // already seen as non-ship
        stuckPassCount: currentStuck,
      });
      mockListProposals.mockReturnValue([p]);

      const result = await runAutoMergePass(baseCfg);

      if (pass < 3) {
        const stuckCall = mockUpdateProposalField.mock.calls.find(
          (c) => c[0] === 'p-drain' && c[1]?.stuckPassCount !== undefined,
        );
        expect(stuckCall).toBeDefined();
        expect(stuckCall![1].stuckPassCount).toBe(currentStuck + 1);
        currentStuck++;
        expect(result.autoArchived).toBe(0);
      } else {
        const archiveCall = mockSetStatus.mock.calls.find(
          (c) => c[0] === 'p-drain' && c[1] === 'rejected',
        );
        expect(archiveCall).toBeDefined();
        expect(archiveCall![3]).toMatch(/M273 drained/);
        expect(result.autoArchived).toBeGreaterThanOrEqual(1);
        archived = true;
      }

      // Judge was never called (client is null)
      expect(mockJudgeProposal).not.toHaveBeenCalled();
    }

    expect(archived).toBe(true);
  });

  it('judgeNonShipCount increments correctly in non-capped path when judge is available', async () => {
    // Verify the standard non-capped path: small backlog + working judge + non-ship
    // → judgeNonShipCount increments 0→1→2→3(archive) across passes.
    const baseCfg = cfg273({ judgePerPass: 8, autoArchiveAfterRejects: 3 });
    const reviewVerdict = (id: string) => ({
      proposalId: id, verdict: 'review' as const,
      value: 2, correctness: 2, scope: 3, alignment: 2,
      rationale: 'needs review', wouldMerge: false,
    });

    let currentCount = 0;
    let archived = false;

    for (let pass = 1; pass <= 3; pass++) {
      vi.clearAllMocks();
      setKill(false);
      // Judge IS available
      mockResolveFrontierJudgeClient.mockReturnValue({ model: 'mock', complete: async () => '{}' });
      mockJudgeProposal.mockResolvedValue(reviewVerdict('p-nonship'));

      const p = makeProposal('p-nonship', { judgeNonShipCount: currentCount });
      mockListProposals.mockReturnValue([p]);

      const result = await runAutoMergePass(baseCfg);

      // Judge was called (not capped, not null client)
      expect(mockJudgeProposal).toHaveBeenCalledTimes(1);

      if (pass < 3) {
        const countCall = mockUpdateProposalField.mock.calls.find(
          (c) => c[0] === 'p-nonship' && c[1]?.judgeNonShipCount !== undefined,
        );
        expect(countCall).toBeDefined();
        expect(countCall![1].judgeNonShipCount).toBe(currentCount + 1);
        currentCount++;
        expect(result.autoArchived).toBe(0);
      } else {
        // Pass 3: judgeNonShipCount was 2, newCount=3 >= 3 → auto-archive
        const archiveCall = mockSetStatus.mock.calls.find(
          (c) => c[0] === 'p-nonship' && c[1] === 'rejected',
        );
        expect(archiveCall).toBeDefined();
        expect(archiveCall![3]).toMatch(/auto-archived/);
        expect(result.autoArchived).toBeGreaterThanOrEqual(1);
        archived = true;
      }
    }

    expect(archived).toBe(true);
  });
});
