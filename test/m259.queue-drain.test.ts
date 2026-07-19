/**
 * M259 queue-drain tests — auto-archive + TTL + diffHash dedup.
 *
 * SAFETY PROOF tests:
 *  - A proposal receiving K non-ship verdicts is auto-archived (rejected),
 *    not re-judged, and NEVER reaches autoMergeProposal.
 *  - A proposal receiving a 'ship' verdict is NOT archived and DOES proceed
 *    to the merge gate (autoMergeProposal called).
 *  - A duplicate diffHash at submission → NOT filed (returns rejected shape,
 *    existing proposal is untouched).
 *  - A pending proposal older than proposalTtlDays → auto-rejected as stale.
 *  - The merge gate itself (autoMergeProposal) is never called for archived/TTL
 *    proposals — strictly safer.
 *  - autoArchived/ttlRejected counters reflect actual drain.
 *
 * HOME is overridden to a tmp dir so no real ~/.ashlr state is touched.
 * autoMergeProposal, listProposalsDetailed, setStatus, updateProposalField are MOCKED.
 * Fixed timestamps are used so TTL tests are deterministic.
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

// Track setStatus calls to verify auto-archive behavior.
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

// autoMergeProposal — records which proposals were forwarded to the merge gate.
const mockAutoMergeProposal = vi.fn();
vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
  evaluateAutoMergeReadinessPreflight: () => ({ ready: true, advisories: [] }),
  isFrontierJudge: (engine: string | undefined) => /claude|gpt|codex/.test(String(engine ?? '').toLowerCase()),
}));

// Judge mock — controllable per-proposal verdict.
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
const NOW_MS = new Date(NOW_ISO).getTime();
const REPO = path.join(fs.realpathSync.native(os.tmpdir()), 'ashlr-m259-repo');

/** Make a fresh proposal with fixed timestamp. */
function makeProposal(id: string, over?: Partial<Proposal>): Proposal {
  return {
    id,
    repo: REPO,
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

/** Config with M259 drain settings. */
function drainCfg(overrides?: Record<string, unknown>): AshlrConfig {
  return {
    version: 1,
    foundry: {
      autoMerge: { enabled: true, managerGate: true },
      autoArchiveAfterRejects: 3,
      proposalTtlDays: 7,
      judgePerPass: 8,
      ...overrides,
    },
  } as AshlrConfig;
}

/** Default non-ship verdict. */
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

/** Ship verdict. */
function shipVerdict(proposalId: string) {
  return {
    proposalId,
    verdict: 'ship' as const,
    value: 5,
    correctness: 5,
    scope: 1,
    alignment: 5,
    rationale: 'looks great',
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
    engine: 'gpt-5.5',
    verdict: 'ship',
    detail: 'would-merge',
    judgeAttestationIssuedAt: expect.any(String),
    judgeAttestationIntent: 'would-merge',
  }));
  expect(entry['judgeAttestation']).toMatch(/^[0-9a-f]{64}$/);
  expect(entry['judgeAttestationIssuedAt']).toBe(entry['ts']);
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  // M84 (CI-green): the fixtures hardcode createdAt = NOW_ISO (2026-06-29).
  // Real time crossing NOW_ISO + proposalTtlDays turned the 7-day TTL
  // pre-pass into a time bomb that rejected every fixture. Pin ONLY Date
  // (not setTimeout etc. — the pass awaits real async work) to NOW_MS.
  vi.useFakeTimers({ now: NOW_MS, toFake: ['Date'] });
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m259-home-'));
  process.env.HOME = tmpHome;

  pendingProposals = [];
  mockListProposals.mockReset();
  mockAutoMergeProposal.mockReset();
  mockJudgeProposal.mockReset();
  mockSetStatus.mockReset();
  mockUpdateProposalField.mockReset();
  mockRecordDecision.mockReset();
  mockSetStatus.mockReturnValue(true);
  mockUpdateProposalField.mockReturnValue(true);

  mockListProposals.mockImplementation(() => pendingProposals);
  mockAutoMergeProposal.mockImplementation(async (id: string) => ({
    ok: true,
    merged: true,
    reason: `merged ${id}`,
  } as AutoMergeResult));
  mockResolveFrontierJudgeClient.mockReturnValue({
    model: 'gpt-5.5',
    complete: async () => '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"mock"}',
  });

  try { setKill(false); } catch { /* ignore */ }
});

afterEach(() => {
  try { setKill(false); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ===========================================================================
// 1. AUTO-ARCHIVE: K non-ship verdicts → proposal marked rejected, not re-judged
// ===========================================================================

describe('M259 auto-archive after K non-ship verdicts', () => {
  it('does NOT archive a proposal below the K threshold', async () => {
    const p = makeProposal('p-below', { judgeNonShipCount: 1 });
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(reviewVerdict('p-below'));

    const out = await runAutoMergePass(drainCfg());

    expect(out.autoArchived).toBe(0);
    // setStatus should NOT have been called for rejected (only updateProposalField for counter bump)
    const rejectedCalls = mockSetStatus.mock.calls.filter((c) => c[1] === 'rejected');
    expect(rejectedCalls).toHaveLength(0);
    // Counter should have been incremented
    expect(mockUpdateProposalField).toHaveBeenCalledWith(
      'p-below',
      { judgeNonShipCount: 2 },
      expect.anything(),
    );
  });

  it('auto-archives a proposal that reaches K=3 non-ship verdicts', async () => {
    // judgeNonShipCount: 2 → this non-ship verdict is the 3rd → archive
    const p = makeProposal('p-archive', { judgeNonShipCount: 2 });
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(reviewVerdict('p-archive'));

    const out = await runAutoMergePass(drainCfg());

    expect(out.autoArchived).toBe(1);
    // setStatus must be called with 'rejected'
    expect(mockSetStatus).toHaveBeenCalledWith(
      'p-archive',
      'rejected',
      undefined,
      expect.stringContaining('auto-archived'),
      expect.anything(),
      {},
      'pending',
    );
    // NEVER forwarded to the merge gate
    expect(mockAutoMergeProposal).not.toHaveBeenCalledWith('p-archive', expect.anything());
  });

  it('auto-archives a proposal with no prior count after K=1 (config K=1)', async () => {
    const p = makeProposal('p-k1', { judgeNonShipCount: 0 });
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(reviewVerdict('p-k1'));

    const out = await runAutoMergePass(drainCfg({ autoArchiveAfterRejects: 1 }));

    expect(out.autoArchived).toBe(1);
    expect(mockSetStatus).toHaveBeenCalledWith(
      'p-k1',
      'rejected',
      undefined,
      expect.stringContaining('auto-archived'),
      expect.anything(),
      {},
      'pending',
    );
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

  it('accumulates non-ship count across verdicts (1→2→archive at 3)', async () => {
    // First pass: count 0 → 1
    const p0 = makeProposal('p-accum', { judgeNonShipCount: 0 });
    pendingProposals = [p0];
    mockJudgeProposal.mockResolvedValue(reviewVerdict('p-accum'));
    let out = await runAutoMergePass(drainCfg());
    expect(out.autoArchived).toBe(0);
    expect(mockUpdateProposalField).toHaveBeenCalledWith(
      'p-accum',
      { judgeNonShipCount: 1 },
      expect.anything(),
    );

    // Second pass: count 1 → 2
    mockUpdateProposalField.mockClear();
    mockSetStatus.mockClear();
    const p1 = makeProposal('p-accum', { judgeNonShipCount: 1 });
    pendingProposals = [p1];
    out = await runAutoMergePass(drainCfg());
    expect(out.autoArchived).toBe(0);
    expect(mockUpdateProposalField).toHaveBeenCalledWith(
      'p-accum',
      { judgeNonShipCount: 2 },
      expect.anything(),
    );

    // Third pass: count 2 → 3 → archive
    mockUpdateProposalField.mockClear();
    mockSetStatus.mockClear();
    const p2 = makeProposal('p-accum', { judgeNonShipCount: 2 });
    pendingProposals = [p2];
    out = await runAutoMergePass(drainCfg());
    expect(out.autoArchived).toBe(1);
    expect(mockSetStatus).toHaveBeenCalledWith(
      'p-accum',
      'rejected',
      undefined,
      expect.stringContaining('auto-archived'),
      expect.anything(),
      {},
      'pending',
    );
  });

  it('handles all three non-ship verdict kinds (noise, harmful, review)', async () => {
    for (const v of ['noise', 'harmful', 'review'] as const) {
      mockSetStatus.mockClear();
      mockUpdateProposalField.mockClear();
      const p = makeProposal(`p-${v}`, { judgeNonShipCount: 2 });
      pendingProposals = [p];
      mockJudgeProposal.mockResolvedValue({
        proposalId: `p-${v}`,
        verdict: v,
        value: 1, correctness: 1, scope: 1, alignment: 1,
        rationale: `${v} verdict`,
        wouldMerge: false,
      });
      const out = await runAutoMergePass(drainCfg());
      expect(out.autoArchived).toBe(1);
    }
  });
});

// ===========================================================================
// 2. SHIP VERDICT: NOT archived — proceeds to merge gate (GATE UNCHANGED)
// ===========================================================================

describe('M259 ship verdict — NOT archived, proceeds to merge gate', () => {
  it('a ship verdict does NOT set status to rejected', async () => {
    const p = makeProposal('p-ship', { judgeNonShipCount: 2 });
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(shipVerdict('p-ship'));

    await runAutoMergePass(drainCfg());

    // setStatus must NOT have been called with 'rejected' for p-ship
    const rejectedCalls = mockSetStatus.mock.calls.filter(
      (c) => c[0] === 'p-ship' && c[1] === 'rejected',
    );
    expect(rejectedCalls).toHaveLength(0);
  });

  it('a ship verdict forwards the proposal to autoMergeProposal (merge gate called)', async () => {
    const p = makeProposal('p-ship-gate');
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(shipVerdict('p-ship-gate'));

    await runAutoMergePass(drainCfg());

    expectAttestedShipDecision('p-ship-gate');
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('p-ship-gate', expect.anything());
  });

  it('a ship verdict on a proposal with high judgeNonShipCount still proceeds (no archive)', async () => {
    // Even judgeNonShipCount=99 — a ship verdict MUST NOT archive.
    const p = makeProposal('p-ship-high', { judgeNonShipCount: 99 });
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(shipVerdict('p-ship-high'));

    const out = await runAutoMergePass(drainCfg());

    expect(out.autoArchived).toBe(0);
    expectAttestedShipDecision('p-ship-high');
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('p-ship-high', expect.anything());
  });

  it('autoArchived counter is 0 when all proposals get ship verdict', async () => {
    pendingProposals = [
      makeProposal('ship-a'),
      makeProposal('ship-b'),
      makeProposal('ship-c'),
    ];
    mockJudgeProposal.mockImplementation(async (p: Proposal) => shipVerdict(p.id));

    const out = await runAutoMergePass(drainCfg());

    expect(out.autoArchived).toBe(0);
    expect(out.ttlRejected).toBe(0);
    expectAttestedShipDecision('ship-a');
    expectAttestedShipDecision('ship-b');
    expectAttestedShipDecision('ship-c');
    expect(mockAutoMergeProposal).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// 3. DIFHASH DEDUP: identical diffHash at submission → not filed
// ===========================================================================
// These tests use the REAL createProposal (passed through via importOriginal)
// with an isolated tmp HOME so the real listProposals reads from a fresh inbox.
// We seed the inbox with a pre-existing pending proposal file, then call
// createProposal with the same diffHash and verify the dedup fires.

describe('M259 diffHash dedup at submission (createProposal)', () => {
  // Helper: write a proposal JSON directly into the tmp inbox dir.
  function seedInbox(proposal: Proposal): void {
    const inboxPath = path.join(tmpHome, '.ashlr', 'inbox');
    fs.mkdirSync(inboxPath, { recursive: true });
    fs.writeFileSync(
      path.join(inboxPath, `${proposal.id}.json`),
      JSON.stringify(proposal, null, 2) + '\n',
      'utf8',
    );
  }

  it('dedup returns the existing proposal id (not a new one) when diffHash matches pending', async () => {
    // Seed inbox with an existing pending proposal with diffHash 'abc123'.
    const existing: Proposal = {
      id: 'existing-prop',
      repo: REPO,
      origin: 'swarm',
      kind: 'patch',
      title: 'Fix #38',
      summary: 'first attempt',
      diff: 'diff --git a/file.ts\n+// fix',
      diffHash: 'abc123',
      status: 'pending',
      engineTier: 'frontier',
      createdAt: NOW_ISO,
    };
    seedInbox(existing);

    // Import the real createProposal (passes through from importOriginal mock).
    const { createProposal } = await import('../src/core/inbox/store.js');

    const result = createProposal({
      repo: REPO,
      origin: 'swarm',
      kind: 'patch',
      title: 'Fix #38 again',
      summary: 'duplicate attempt',
      diff: 'diff --git a/file.ts\n+// fix',
      diffHash: 'abc123', // same hash
    });

    // Dedup path: returns the existing proposal's id, status rejected (not persisted).
    expect(result.id).toBe('existing-prop');
    expect(result.status).toBe('rejected');
    expect(result.decisionReason).toContain('diffHash dedup');
    // No new file should have been written (inbox still has only the original).
    const inboxFiles = fs.readdirSync(path.join(tmpHome, '.ashlr', 'inbox'))
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
    expect(inboxFiles).toHaveLength(1);
    expect(inboxFiles[0]).toBe('existing-prop.json');
  });

  it('dedup does NOT fire when diffHash is absent', async () => {
    // Seed with a proposal that has diffHash — incoming has none.
    const existing: Proposal = {
      id: 'existing-nodifhash',
      repo: REPO,
      origin: 'swarm',
      kind: 'patch',
      title: 'Some fix',
      summary: 'original',
      diff: 'diff --git a/a.ts\n+// a',
      diffHash: 'abc456',
      status: 'pending',
      engineTier: 'frontier',
      createdAt: NOW_ISO,
    };
    seedInbox(existing);

    const { createProposal } = await import('../src/core/inbox/store.js');

    const result = createProposal({
      repo: REPO,
      origin: 'swarm',
      kind: 'patch',
      title: 'Different fix',
      summary: 'no diffHash',
      diff: 'diff --git a/b.ts\n+// b',
      // No diffHash
    });

    // No dedup — new proposal filed as pending.
    expect(result.id).not.toBe('existing-nodifhash');
    expect(result.status).toBe('pending');
  });

  it('dedup does NOT fire when diffHash differs', async () => {
    const existing: Proposal = {
      id: 'existing-diff-hash',
      repo: REPO,
      origin: 'swarm',
      kind: 'patch',
      title: 'Fix A',
      summary: 'hash-A',
      diff: 'diff --git a/a.ts\n+// a',
      diffHash: 'hash-A',
      status: 'pending',
      engineTier: 'frontier',
      createdAt: NOW_ISO,
    };
    seedInbox(existing);

    const { createProposal } = await import('../src/core/inbox/store.js');

    const result = createProposal({
      repo: REPO,
      origin: 'swarm',
      kind: 'patch',
      title: 'Fix B',
      summary: 'different content',
      diff: 'diff --git a/b.ts\n+// b',
      diffHash: 'hash-B', // different
    });

    expect(result.id).not.toBe('existing-diff-hash');
    expect(result.status).toBe('pending');
  });
});

// ===========================================================================
// 4. TTL: proposals older than proposalTtlDays → auto-rejected as stale
// ===========================================================================

describe('M259 TTL: stale proposals auto-rejected', () => {
  it('rejects a proposal older than proposalTtlDays', async () => {
    // createdAt = 8 days ago (TTL default 7 days)
    const staleDate = new Date(NOW_MS - 8 * 24 * 60 * 60 * 1000).toISOString();
    const stale = makeProposal('p-stale', { createdAt: staleDate });
    pendingProposals = [stale];
    // The second read is the complete pre-mutation authority refresh.
    mockListProposals
      .mockReturnValueOnce([stale])  // initial fetch
      .mockReturnValueOnce([stale]); // authoritative refresh

    const out = await runAutoMergePass(drainCfg());

    expect(out.ttlRejected).toBe(1);
    expect(mockSetStatus).toHaveBeenCalledWith(
      'p-stale',
      'rejected',
      undefined,
      expect.stringContaining('TTL'),
      expect.anything(),
      {},
      'pending',
    );
    // NEVER forwarded to merge gate
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

  it('does NOT reject a proposal younger than proposalTtlDays', async () => {
    // createdAt = 3 days ago (TTL 7 days)
    const freshDate = new Date(NOW_MS - 3 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = makeProposal('p-fresh', { createdAt: freshDate });
    pendingProposals = [fresh];
    mockJudgeProposal.mockResolvedValue(shipVerdict('p-fresh'));

    const out = await runAutoMergePass(drainCfg());

    expect(out.ttlRejected).toBe(0);
    // Should have proceeded to judge + merge gate
    expectAttestedShipDecision('p-fresh');
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('p-fresh', expect.anything());
  });

  it('TTL=0 disables TTL rejection', async () => {
    const staleDate = new Date(NOW_MS - 30 * 24 * 60 * 60 * 1000).toISOString();
    const old = makeProposal('p-old-nott', { createdAt: staleDate });
    pendingProposals = [old];
    mockJudgeProposal.mockResolvedValue(shipVerdict('p-old-nott'));

    const out = await runAutoMergePass(drainCfg({ proposalTtlDays: 0 }));

    expect(out.ttlRejected).toBe(0);
    // Proposal proceeds normally (no TTL rejection)
  });

  it('rejects multiple stale proposals in one pass', async () => {
    const staleDate = new Date(NOW_MS - 10 * 24 * 60 * 60 * 1000).toISOString();
    const stales = [
      makeProposal('s1', { createdAt: staleDate }),
      makeProposal('s2', { createdAt: staleDate }),
      makeProposal('s3', { createdAt: staleDate }),
    ];
    pendingProposals = stales;
    mockListProposals
      .mockReturnValueOnce(stales)
      .mockReturnValueOnce(stales);

    const out = await runAutoMergePass(drainCfg());

    expect(out.ttlRejected).toBe(3);
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. MERGE GATE UNCHANGED: non-ship archived proposals NEVER reach autoMergeProposal
// ===========================================================================

describe('M259 safety: merge gate NEVER reached for archived/TTL proposals', () => {
  it('archived proposals are NOT passed to autoMergeProposal', async () => {
    const p = makeProposal('p-archived-gate', { judgeNonShipCount: 2 });
    pendingProposals = [p];
    mockJudgeProposal.mockResolvedValue(reviewVerdict('p-archived-gate'));

    await runAutoMergePass(drainCfg());

    expect(mockAutoMergeProposal).not.toHaveBeenCalledWith(
      'p-archived-gate',
      expect.anything(),
    );
  });

  it('TTL-rejected proposals are NOT passed to autoMergeProposal', async () => {
    const staleDate = new Date(NOW_MS - 8 * 24 * 60 * 60 * 1000).toISOString();
    const stale = makeProposal('p-ttl-gate', { createdAt: staleDate });
    pendingProposals = [stale];
    mockListProposals
      .mockReturnValueOnce([stale])
      .mockReturnValueOnce([stale]);

    await runAutoMergePass(drainCfg());

    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

  it('mixed pass: stale+archived skip gate, ship proceeds to gate', async () => {
    const staleDate = new Date(NOW_MS - 10 * 24 * 60 * 60 * 1000).toISOString();
    const stale = makeProposal('p-mix-stale', { createdAt: staleDate });
    const toArchive = makeProposal('p-mix-archive', { judgeNonShipCount: 2 });
    const shipper = makeProposal('p-mix-ship');

    // Both the initial read and pre-mutation refresh include all 3.
    mockListProposals
      .mockReturnValueOnce([stale, toArchive, shipper])
      .mockReturnValueOnce([stale, toArchive, shipper]);

    mockJudgeProposal.mockImplementation(async (p: Proposal) => {
      if (p.id === 'p-mix-archive') return reviewVerdict(p.id);
      return shipVerdict(p.id);
    });

    const out = await runAutoMergePass(drainCfg());

    expect(out.ttlRejected).toBe(1);
    expect(out.autoArchived).toBe(1);
    // Only the ship proposal reached the merge gate
    expectAttestedShipDecision('p-mix-ship');
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('p-mix-ship', expect.anything());
    expect(mockAutoMergeProposal).not.toHaveBeenCalledWith('p-mix-stale', expect.anything());
    expect(mockAutoMergeProposal).not.toHaveBeenCalledWith('p-mix-archive', expect.anything());
  });
});

// ===========================================================================
// 6. judgePerPass: default is now 8 (raised from 5)
// ===========================================================================

describe('M259 judgePerPass default is 8', () => {
  it('judges up to 8 proposals per pass when no config override', async () => {
    // 10 proposals — should judge 8, cap 2
    pendingProposals = Array.from({ length: 10 }, (_, i) => makeProposal(`p${i}`));
    mockJudgeProposal.mockImplementation(async (p: Proposal) => shipVerdict(p.id));

    const out = await runAutoMergePass({
      version: 1,
      foundry: { autoMerge: { enabled: true, managerGate: true } },
    } as AshlrConfig);

    expect(out.judged).toBe(8);
    expect(out.judgeCapped).toBe(2);
  });

  it('respects explicit judgePerPass override', async () => {
    pendingProposals = Array.from({ length: 10 }, (_, i) => makeProposal(`pp${i}`));
    mockJudgeProposal.mockImplementation(async (p: Proposal) => shipVerdict(p.id));

    const out = await runAutoMergePass(drainCfg({ judgePerPass: 3 }));

    expect(out.judged).toBe(3);
    expect(out.judgeCapped).toBe(7);
  });
});
