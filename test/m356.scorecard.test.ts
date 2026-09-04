/**
 * m356.scorecard.test.ts — fleet self-evaluation scorecard tests.
 *
 * Covers:
 *   1. computeFleetScorecard — proposals section (filed/complete/partial, windowed)
 *   2. computeFleetScorecard — proposals section degrades to unknown (null), never 0
 *   3. computeFleetScorecard — judge throughput + parse/network failure split
 *   4. computeFleetScorecard — merges: only write-path-authenticated rows count
 *      (FALSIFIES: a generic row and shape-only receipt earn no credit;
 *      released post-merge credit is explicit uncommissioned state)
 *   5. computeFleetScorecard — cost per authenticated merged change
 *   6. computeFleetScorecard — dispatch→verdict latency (median/mean)
 *   7. computeFleetScorecard — rejection-lesson count (self-improve:written)
 *   8. computeFleetScorecard — per-engine/model splits
 *   9. computeFleetScorecard — capability (eval) axis: unavailable vs observed
 *  10. computeFleetScorecard — degraded decisions ledger → every decision-derived
 *      section becomes unknown (null), never a fabricated 0
 *  11. computeFleetScorecard — never throws
 *  12. scorecard-history — append/read round trip, bounded read, malformed rows
 *  13. snapshotScorecardIfDue — writes once, throttles, writes again after interval
 *  14. readScorecardTrend — window filter
 *  15. CLI `ashlr fleet scorecard --json` — selfEvaluation shape
 *  16. API `GET /api/scorecard` — 200 JSON shape, window query param
 *
 * Hermetic: HOME relocated to tmp dir; listProposalsDetailed is mocked
 * (mirrors m119 conventions); decisions ledger + eval reports are real
 * fs reads/writes under the isolated HOME.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AshlrConfig,
  Proposal,
  ProposalLocalMergeIntent,
  WebServerOptions,
} from '../src/core/types.js';
import {
  signLocalMergeIntent,
  signLocalRealizedMergeReceipt,
} from '../src/core/foundry/provenance.js';
import { setScorecardHistoryTestHooksForTests } from '../src/core/fleet/scorecard-history.js';
import { startServer, readAuthHeaders } from './helpers/authenticated-web-server.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m356-home-'));
  process.env.HOME = tmpHome;
  delete process.env.ASHLR_HOME;
});

afterEach(() => {
  setScorecardHistoryTestHooksForTests(undefined);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Mock proposal store (mirrors m119.quality-metrics.test.ts conventions)
// ---------------------------------------------------------------------------

const mockProposals: Proposal[] = [];
let mockProposalSourceState: 'healthy' | 'degraded' | 'missing' = 'healthy';
let mockProposalComplete = true;

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    listProposalsDetailed: () => ({
      proposals: mockProposalComplete ? ([...mockProposals] as Proposal[]) : [],
      sourceState: mockProposalSourceState,
      sourcePresent: mockProposals.length > 0,
      complete: mockProposalComplete,
      stopReasons: mockProposalComplete ? [] : ['invalid-file'],
      filesDiscovered: mockProposals.length,
      filesRead: mockProposals.length,
      bytesRead: 0,
      invalidFiles: mockProposalComplete ? 0 : 1,
      unreadableFiles: 0,
    }),
  };
});

beforeEach(() => {
  mockProposals.length = 0;
  mockProposalSourceState = 'healthy';
  mockProposalComplete = true;
});

let _seq = 0;
function pid(): string { return `p-m356-${_seq++}`; }

function makeMockProposal(overrides: Partial<Proposal> & { createdAt: string }): Proposal {
  return {
    id: pid(),
    repo: '/repos/alpha',
    status: 'applied',
    origin: 'backlog',
    kind: 'patch',
    title: 'test proposal',
    summary: 'summary',
    ...overrides,
  };
}

function makeAuthenticatedRealizedProposal(
  proposalId: string,
  observedAt: string,
  opts: { repo?: string; mergeCommitOid?: string } = {},
): Proposal {
  const repo = opts.repo ?? path.join(tmpHome, 'repos', proposalId);
  fs.mkdirSync(repo, { recursive: true });
  const diff = '--- a/file.ts\n+++ b/file.ts\n@@\n-old\n+new\n';
  const diffHash = 'd'.repeat(64);
  const proposal = makeMockProposal({
    id: proposalId,
    repo,
    status: 'applied',
    createdAt: observedAt,
    diff,
    diffHash,
    verifyResult: {
      passed: true,
      baseHead: '1'.repeat(40),
      diffHash,
    },
  });
  const unsignedIntent: Omit<ProposalLocalMergeIntent, 'attestation'> = {
    schemaVersion: 1,
    branch: `ashlr/merge/${proposalId}`,
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    diffHash,
    evidencePackDigest: '4'.repeat(64),
    authorizationId: '5'.repeat(32),
    authorizedAt: observedAt,
  };
  const intentAttestation = signLocalMergeIntent(proposalId, repo, unsignedIntent);
  proposal.localMergeIntent = { ...unsignedIntent, attestation: intentAttestation };
  const unsignedRealized = {
    schemaVersion: 1 as const,
    source: 'local-default-branch' as const,
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    mergeCommitOid: opts.mergeCommitOid ?? '3'.repeat(40),
    observedAt,
    proposalId,
    diffHash,
    intentAttestation,
  };
  proposal.realizedMerge = {
    ...unsignedRealized,
    attestation: signLocalRealizedMergeReceipt(proposalId, repo, unsignedRealized),
  };
  return proposal;
}

// ---------------------------------------------------------------------------
// Decision-ledger fixture helpers (real ledger, isolated HOME)
// ---------------------------------------------------------------------------

async function recordProposed(
  proposalId: string,
  ts: string,
  opts: { engine?: string; model?: string; costUsd?: number; tokensIn?: number; tokensOut?: number } = {},
): Promise<void> {
  const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
  recordDecision({
    ts,
    proposalId,
    action: 'proposed',
    engine: opts.engine ?? 'claude',
    model: opts.model ?? 'claude:sonnet-5',
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    ...(opts.tokensIn !== undefined ? { tokensIn: opts.tokensIn } : {}),
    ...(opts.tokensOut !== undefined ? { tokensOut: opts.tokensOut } : {}),
  });
}

async function recordJudged(
  proposalId: string,
  ts: string,
  verdict: string,
  detail?: 'judge-parse-failure' | 'judge-network-failure',
): Promise<void> {
  const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
  recordDecision({
    ts,
    proposalId,
    action: 'judged',
    verdict,
    ...(detail ? { detail } : {}),
  });
}

async function recordRealizedMerge(proposalId: string, ts: string): Promise<void> {
  const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
  mockProposals.push(makeAuthenticatedRealizedProposal(proposalId, ts));
  recordDecision({ ts, proposalId, action: 'merged', verdict: 'merged', labelBasis: 'realized-merge-v1' });
}

async function recordSelfImprove(proposalId: string, ts: string): Promise<void> {
  const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
  recordDecision({ ts, proposalId, action: 'self-improve:written', detail: 'verdict=noise' });
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 1-2. proposals section
// ---------------------------------------------------------------------------

describe('computeFleetScorecard — proposals section', () => {
  it('counts filed/complete/partial within the window; excludes stale proposals', async () => {
    mockProposals.push(
      makeMockProposal({ createdAt: isoAgo(1 * DAY_MS), diff: '+x\n-y\n' }), // complete, in-window
      makeMockProposal({ createdAt: isoAgo(2 * DAY_MS) }), // no diff → partial, in-window
      makeMockProposal({ createdAt: isoAgo(2 * DAY_MS), diff: '+x\n', isPartial: true }), // partial (isPartial), in-window
      makeMockProposal({ createdAt: isoAgo(10 * DAY_MS), diff: '+x\n' }), // outside 7d window
    );

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.proposals.filed).toBe(3);
    expect(sc.proposals.complete).toBe(1);
    expect(sc.proposals.partial).toBe(2);
    expect(sc.proposals.sourceQuality.sourceState).toBe('healthy');
    expect(sc.proposals.sourceQuality.complete).toBe(true);
  });

  it('degrades to unknown (null), never a fabricated 0, when the proposal source is incomplete', async () => {
    mockProposals.push(makeMockProposal({ createdAt: isoAgo(1 * DAY_MS), diff: '+x\n' }));
    mockProposalComplete = false;
    mockProposalSourceState = 'degraded';

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.proposals.filed).toBeNull();
    expect(sc.proposals.complete).toBeNull();
    expect(sc.proposals.partial).toBeNull();
    expect(sc.proposals.sourceQuality.sourceState).toBe('degraded');
    expect(sc.proposals.sourceQuality.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. judge section
// ---------------------------------------------------------------------------

describe('computeFleetScorecard — judge section', () => {
  it('splits judge calls into verdicts vs parse/network failures', async () => {
    await recordJudged(pid(), isoAgo(1 * DAY_MS), 'ship');
    await recordJudged(pid(), isoAgo(1 * DAY_MS), 'noise');
    await recordJudged(pid(), isoAgo(1 * DAY_MS), 'review', 'judge-parse-failure');
    await recordJudged(pid(), isoAgo(1 * DAY_MS), 'review', 'judge-network-failure');

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.judge.calls).toBe(4);
    expect(sc.judge.verdicts).toBe(2);
    expect(sc.judge.failures).toEqual({ parse: 1, network: 1, total: 2 });
    expect(sc.judge.failureRate).toBeCloseTo(0.5, 5);
  });

  it('reports failureRate null (not 0) when there are zero judge calls', async () => {
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.judge.calls).toBe(0);
    expect(sc.judge.failureRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. merges section — authenticated-only, with deliberate falsification
// ---------------------------------------------------------------------------

describe('computeFleetScorecard — merges section (evidence-only)', () => {
  it('counts an authenticated realized proposal witness without trusting ledger fanout', async () => {
    const id = pid();
    mockProposals.push(makeAuthenticatedRealizedProposal(id, isoAgo(1 * DAY_MS)));

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.merges.realized).toBe(1);
    expect(sc.merges.released).toBeNull();
    expect(sc.merges.releasedState).toBe('uncommissioned');
  });

  it('reports released post-merge credit as uncommissioned while operational release is disabled', async () => {
    const id = pid();
    await recordRealizedMerge(id, isoAgo(1 * DAY_MS));

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.merges.released).toBeNull();
    expect(sc.merges.releasedState).toBe('uncommissioned');
    expect(sc.merges.releasedReason).toBe('operational-release-disabled');
  });

  it('FALSIFY: a generic realized-merge decision without its exact authenticated proposal earns no credit', async () => {
    const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
    const id = pid();
    recordDecision({
      ts: isoAgo(1 * DAY_MS),
      proposalId: id,
      action: 'merged',
      verdict: 'merged',
      labelBasis: 'realized-merge-v1',
    });

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.merges.realized).toBe(0);
  });

  it('FALSIFY: shape-only realized evidence without a valid receipt earns no credit', async () => {
    const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
    const id = pid();
    const proposal = makeAuthenticatedRealizedProposal(id, isoAgo(1 * DAY_MS));
    if (proposal.realizedMerge?.source === 'local-default-branch') {
      proposal.realizedMerge.attestation = '0'.repeat(64);
    }
    mockProposals.push(proposal);
    recordDecision({
      ts: isoAgo(1 * DAY_MS),
      proposalId: id,
      action: 'merged',
      verdict: 'merged',
      labelBasis: 'realized-merge-v1',
    });

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.merges.realized).toBe(0);
  });

  it('FALSIFY: a fresh ledger row cannot replay an old authenticated merge into the window', async () => {
    const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
    const id = pid();
    const oldObservedAt = isoAgo(10 * DAY_MS);
    mockProposals.push(makeAuthenticatedRealizedProposal(id, oldObservedAt));
    recordDecision({
      ts: isoAgo(1 * DAY_MS),
      proposalId: id,
      action: 'merged',
      verdict: 'merged',
      labelBasis: 'realized-merge-v1',
    });

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.merges.realized).toBe(0);
  });

  it('FALSIFY: a future authenticated observation is not current realized credit', async () => {
    const id = pid();
    const futureObservedAt = new Date(Date.now() + 30_000).toISOString();
    const proposal = makeAuthenticatedRealizedProposal(id, futureObservedAt);
    const { authenticatedRealizedMergeOf } = await import('../src/core/inbox/realized-merge.js');
    expect(authenticatedRealizedMergeOf(proposal)).not.toBeNull();
    mockProposals.push(proposal);

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    expect(computeFleetScorecard('7d').merges.realized).toBe(0);
  });

  it('FALSIFY: partial, non-patch, and empty-diff proposals cannot earn realized credit', async () => {
    const observedAt = isoAgo(1 * DAY_MS);
    const partial = makeAuthenticatedRealizedProposal(pid(), observedAt);
    partial.isPartial = true;
    const emptyDiff = makeAuthenticatedRealizedProposal(pid(), observedAt);
    emptyDiff.diff = '   ';
    const wrongKind = makeAuthenticatedRealizedProposal(pid(), observedAt);
    wrongKind.kind = 'note';
    mockProposals.push(partial, emptyDiff, wrongKind);

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    expect(computeFleetScorecard('7d').merges.realized).toBe(0);
  });

  it('FALSIFY: an old/current replay of one canonical merge identity degrades to unknown', async () => {
    const sharedRepo = path.join(tmpHome, 'repos', 'canonical-duplicate');
    const mergeCommitOid = '9'.repeat(40);
    mockProposals.push(
      makeAuthenticatedRealizedProposal(pid(), isoAgo(10 * DAY_MS), { repo: sharedRepo, mergeCommitOid }),
      makeAuthenticatedRealizedProposal(pid(), isoAgo(1 * DAY_MS), { repo: sharedRepo, mergeCommitOid }),
    );

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.merges.realized).toBeNull();
    expect(sc.merges.sourceQuality).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(sc.merges.sourceQuality.reasons).toContain('duplicate-canonical-realized-merge-identity');
    expect(sc.cost.mergedChanges).toBeNull();
    expect(sc.byEngine).toEqual([]);
  });

  it('FALSIFY: exact-timestamp generic rows cannot create or duplicate authenticated credit', async () => {
    const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
    const id = pid();
    const observedAt = isoAgo(1 * DAY_MS);
    mockProposals.push(makeAuthenticatedRealizedProposal(id, observedAt));

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    expect(computeFleetScorecard('7d').merges.realized).toBe(1);

    recordDecision({
      ts: observedAt,
      proposalId: id,
      action: 'merged',
      verdict: 'merged',
      labelBasis: 'realized-merge-v1',
    });
    recordDecision({
      ts: observedAt,
      proposalId: id,
      action: 'merged',
      verdict: 'merged',
      labelBasis: 'realized-merge-v1',
    });

    const sc = computeFleetScorecard('7d');
    expect(sc.merges.realized).toBe(1);
  });

  it('FALSIFY: an unsigned bare post-merge-credit literal is rejected at the ledger write boundary — no row is ever persisted', async () => {
    const { recordDecision, readDecisions } = await import('../src/core/fleet/decisions-ledger.js');
    const id = pid();
    recordDecision({
      ts: isoAgo(1 * DAY_MS),
      proposalId: id,
      action: 'merged',
      verdict: 'applied',
      labelBasis: 'post-merge-credit-release-v1', // bare literal — no signature
    });
    const rows = readDecisions({ proposalId: id, requireComplete: true });
    expect(rows.length).toBe(0); // decisions-ledger.ts's own guard silently drops it

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.merges.released).toBeNull();
    expect(sc.merges.releasedState).toBe('uncommissioned');
  });

  it('FALSIFY: a forged signed-looking token with an invalid MAC is written but never counted as released', async () => {
    const { recordDecision, readDecisions } = await import('../src/core/fleet/decisions-ledger.js');
    const id = pid();
    const forged = `post-merge-credit-release-v1:${'a'.repeat(24)}:${'b'.repeat(24)}`;
    recordDecision({ ts: isoAgo(1 * DAY_MS), proposalId: id, action: 'merged', verdict: 'applied', labelBasis: forged });
    const rows = readDecisions({ proposalId: id, requireComplete: true });
    expect(rows.length).toBe(1); // the row IS written (well-formed shape)...

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.merges.released).toBeNull();
    expect(sc.merges.releasedState).toBe('uncommissioned');

    // Also not counted as "realized" — wrong labelBasis entirely.
    expect(sc.merges.realized).toBe(0);
  });

  it('FALSIFY: an arbitrary labelBasis string does not count as a realized merge', async () => {
    const { recordDecision } = await import('../src/core/fleet/decisions-ledger.js');
    const id = pid();
    recordDecision({ ts: isoAgo(1 * DAY_MS), proposalId: id, action: 'merged', verdict: 'applied', labelBasis: 'proposal-status' });

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.merges.realized).toBe(0);
    expect(sc.merges.released).toBeNull();
    expect(sc.merges.releasedState).toBe('uncommissioned');
  });
});

// ---------------------------------------------------------------------------
// 5. cost section
// ---------------------------------------------------------------------------

describe('computeFleetScorecard — cost section', () => {
  it('sums producer run usage joined to authenticated realized merges and divides by merge count', async () => {
    const a = pid();
    const b = pid();
    await recordProposed(a, isoAgo(2 * DAY_MS), { costUsd: 0.5, tokensIn: 1000, tokensOut: 500 });
    await recordRealizedMerge(a, isoAgo(1 * DAY_MS));
    await recordProposed(b, isoAgo(2 * DAY_MS), { costUsd: 1.5, tokensIn: 3000, tokensOut: 1500 });
    await recordRealizedMerge(b, isoAgo(1 * DAY_MS));

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.cost.mergedChanges).toBe(2);
    expect(sc.cost.totalCostUsd).toBeCloseTo(2.0, 5);
    expect(sc.cost.totalTokensIn).toBe(4000);
    expect(sc.cost.totalTokensOut).toBe(2000);
    expect(sc.cost.perMergedChangeUsd).toBeCloseTo(1.0, 5);
  });

  it('reports perMergedChangeUsd null (never divide-by-zero) when there are zero authenticated merges', async () => {
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.cost.mergedChanges).toBe(0);
    expect(sc.cost.perMergedChangeUsd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. latency section
// ---------------------------------------------------------------------------

describe('computeFleetScorecard — latency section', () => {
  it('computes dispatch→verdict median/mean from matched proposed/judged pairs', async () => {
    const a = pid();
    const b = pid();
    const t0 = Date.now() - 2 * DAY_MS;
    await recordProposed(a, new Date(t0).toISOString());
    await recordJudged(a, new Date(t0 + 1000).toISOString(), 'ship');
    await recordProposed(b, new Date(t0).toISOString());
    await recordJudged(b, new Date(t0 + 3000).toISOString(), 'noise');

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.latency.sampleSize).toBe(2);
    expect(sc.latency.dispatchToVerdictMsMedian).toBeCloseTo(2000, 0);
    expect(sc.latency.dispatchToVerdictMsMean).toBeCloseTo(2000, 0);
  });
});

// ---------------------------------------------------------------------------
// 7. learning section
// ---------------------------------------------------------------------------

describe('computeFleetScorecard — learning section', () => {
  it('counts self-improve:written rows — the anti-playbook lesson writer telemetry', async () => {
    await recordSelfImprove(pid(), isoAgo(1 * DAY_MS));
    await recordSelfImprove(pid(), isoAgo(2 * DAY_MS));

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.learning.rejectionLessonsWritten).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 8. byEngine splits
// ---------------------------------------------------------------------------

describe('computeFleetScorecard — byEngine splits', () => {
  it('buckets dispatches and authenticated merges per engine/model', async () => {
    const a = pid();
    const b = pid();
    await recordProposed(a, isoAgo(2 * DAY_MS), { engine: 'claude', model: 'claude:sonnet-5', costUsd: 1.0 });
    await recordRealizedMerge(a, isoAgo(1 * DAY_MS));
    await recordProposed(b, isoAgo(2 * DAY_MS), { engine: 'codex', model: 'codex:gpt-5.5', costUsd: 2.0 });

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    const claude = sc.byEngine.find((e) => e.engine === 'claude');
    const codex = sc.byEngine.find((e) => e.engine === 'codex');
    expect(claude?.dispatches).toBe(1);
    expect(claude?.realizedMerges).toBe(1);
    expect(claude?.costPerRealizedMergeUsd).toBeCloseTo(1.0, 5);
    expect(codex?.dispatches).toBe(1);
    expect(codex?.realizedMerges).toBe(0);
    expect(codex?.costPerRealizedMergeUsd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. capability (eval) axis
// ---------------------------------------------------------------------------

describe('computeFleetScorecard — capability axis', () => {
  it('reports unavailable with a clear reason when no eval report is persisted', async () => {
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.capability.state).toBe('unavailable');
    expect(sc.capability.reason).toMatch(/dataset|engine/i);
    expect(sc.capability.latest).toBeUndefined();
  });

  it('reports observed with the latest persisted report when one exists', async () => {
    const { saveReport } = await import('../src/core/eval/swe-bench.js');
    saveReport({
      id: 'bench-test1', ts: new Date().toISOString(), engine: 'local-coder',
      total: 2, resolved: 1, resolveRate: 0.5, perTask: [], byEngine: {},
    });

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.capability.state).toBe('observed');
    expect(sc.capability.latest?.id).toBe('bench-test1');
    expect(sc.capability.latest?.resolveRate).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// 10. degraded decisions ledger — unknown, never a fabricated 0
// ---------------------------------------------------------------------------

describe('computeFleetScorecard — degraded decisions ledger', () => {
  it('keeps authenticated proposal truth while decision-derived attribution becomes unknown', async () => {
    await recordRealizedMerge(pid(), isoAgo(1 * DAY_MS)); // would otherwise produce real, non-zero counts

    const { decisionsDir } = await import('../src/core/fleet/decisions-ledger.js');
    const dir = decisionsDir();
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, '{"torn":true'); // malformed trailing line, no newline

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc = computeFleetScorecard('7d');
    expect(sc.judge.calls).toBeNull();
    expect(sc.merges.realized).toBe(1);
    expect(sc.merges.released).toBeNull();
    expect(sc.merges.sourceQuality).toMatchObject({ sourceState: 'healthy', complete: true });
    expect(sc.cost.perMergedChangeUsd).toBeNull();
    expect(sc.latency.sampleSize).toBeNull();
    expect(sc.learning.rejectionLessonsWritten).toBeNull();
    expect(sc.byEngine).toEqual([]);
    for (const sq of [
      sc.judge.sourceQuality, sc.cost.sourceQuality,
      sc.latency.sourceQuality, sc.learning.sourceQuality,
    ]) {
      expect(sq.sourceState).toBe('degraded');
      expect(sq.complete).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. never throws
// ---------------------------------------------------------------------------

describe('computeFleetScorecard — never throws', () => {
  it('never throws even when the proposal mock throws', async () => {
    mockProposalComplete = true;
    mockProposals.push(makeMockProposal({ createdAt: isoAgo(1 * DAY_MS) }));
    // Corrupt HOME so the decisions ledger read hits an io-error path too.
    fs.rmSync(path.join(tmpHome, '.ashlr'), { recursive: true, force: true });
    fs.writeFileSync(path.join(tmpHome, '.ashlr'), 'not-a-directory');

    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    expect(() => computeFleetScorecard('30d')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. scorecard-history — append/read round trip
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('scorecard-history POSIX persistence', () => {
  it('round-trips appended snapshots, newest-first, bounded', async () => {
    const { appendScorecardSnapshot, readScorecardHistory } = await import('../src/core/fleet/scorecard-history.js');
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc7 = computeFleetScorecard('7d');
    appendScorecardSnapshot({ ts: isoAgo(2 * DAY_MS), window: '7d', scorecard: sc7 });
    appendScorecardSnapshot({ ts: isoAgo(1 * DAY_MS), window: '7d', scorecard: sc7 });

    const read = readScorecardHistory({});
    expect(read.sourceState).toBe('healthy');
    expect(read.complete).toBe(true);
    expect(read.records.length).toBe(2);
    // newest first
    expect(Date.parse(read.records[0]!.ts)).toBeGreaterThan(Date.parse(read.records[1]!.ts));
  });

  it('caps returned rows via limit', async () => {
    const { appendScorecardSnapshot, readScorecardHistory } = await import('../src/core/fleet/scorecard-history.js');
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const sc7 = computeFleetScorecard('7d');
    for (let i = 0; i < 5; i++) {
      appendScorecardSnapshot({ ts: isoAgo(i * DAY_MS), window: '7d', scorecard: sc7 });
    }
    const read = readScorecardHistory({ limit: 2 });
    expect(read.records.length).toBe(2);
  });

  it('reports invalidRows and degrades sourceState on a malformed line', async () => {
    const { scorecardHistoryDir } = await import('../src/core/fleet/scorecard-history.js');
    const dir = scorecardHistoryDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const month = new Date().toISOString().slice(0, 7);
    fs.writeFileSync(path.join(dir, `${month}.jsonl`), 'not json at all\n');

    const { readScorecardHistory } = await import('../src/core/fleet/scorecard-history.js');
    const read = readScorecardHistory({});
    expect(read.invalidRows).toBe(1);
    expect(read.sourceState).toBe('degraded');
    expect(read.complete).toBe(false);
  });

  it('does not append when the history pathname is replaced after descriptor open', async () => {
    const { appendScorecardSnapshot, scorecardHistoryDir } =
      await import('../src/core/fleet/scorecard-history.js');
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const ts = new Date().toISOString();
    const record = { ts, window: '7d' as const, scorecard: computeFleetScorecard('7d') };
    appendScorecardSnapshot(record);
    const historyPath = path.join(scorecardHistoryDir(), `${ts.slice(0, 7)}.jsonl`);
    const displaced = `${historyPath}.displaced`;
    const original = fs.readFileSync(historyPath, 'utf8');
    const replacement = '{"replacement":"must-survive"}\n';
    setScorecardHistoryTestHooksForTests({
      operation: 'append',
      fileSwap: {
        fileName: path.basename(historyPath),
        displacedName: path.basename(displaced),
        replacementContents: replacement,
      },
    });

    appendScorecardSnapshot({ ...record, ts: new Date(Date.now() + 1_000).toISOString() });

    expect(fs.readFileSync(displaced, 'utf8')).toBe(original);
    expect(fs.readFileSync(historyPath, 'utf8')).toBe(replacement);
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow a symlink installed immediately before the atomic append open',
    async () => {
      const { appendScorecardSnapshot, scorecardHistoryDir } =
        await import('../src/core/fleet/scorecard-history.js');
      const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
      const ts = new Date().toISOString();
      const historyPath = path.join(scorecardHistoryDir(), `${ts.slice(0, 7)}.jsonl`);
      const externalPath = path.join(tmpHome, 'external-history-target.jsonl');
      const external = '{"external":"must-survive"}\n';
      fs.writeFileSync(externalPath, external, { mode: 0o600 });
      setScorecardHistoryTestHooksForTests({
        operation: 'append',
        beforeAppendSymlinkTarget: externalPath,
      });

      appendScorecardSnapshot({ ts, window: '7d', scorecard: computeFleetScorecard('7d') });

      expect(fs.lstatSync(historyPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(externalPath, 'utf8')).toBe(external);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not traverse a symlinked history directory on append',
    async () => {
      const { appendScorecardSnapshot, scorecardHistoryDir } =
        await import('../src/core/fleet/scorecard-history.js');
      const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
      const ashlrRoot = path.join(tmpHome, '.ashlr');
      const externalDir = path.join(tmpHome, 'external-history-directory');
      fs.mkdirSync(ashlrRoot, { mode: 0o700 });
      fs.mkdirSync(externalDir, { mode: 0o700 });
      fs.symlinkSync(externalDir, scorecardHistoryDir());

      appendScorecardSnapshot({
        ts: new Date().toISOString(),
        window: '7d',
        scorecard: computeFleetScorecard('7d'),
      });

      expect(fs.readdirSync(externalDir)).toEqual([]);
    },
  );

  it('appends only through the POSIX-pinned cwd when the named parent is replaced', async () => {
    const { appendScorecardSnapshot, scorecardHistoryDir } =
      await import('../src/core/fleet/scorecard-history.js');
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const ts = new Date().toISOString();
    appendScorecardSnapshot({ ts, window: '7d', scorecard: computeFleetScorecard('7d') });
    const dir = scorecardHistoryDir();
    const displaced = `${dir}.displaced-scorecard-append0001`;
    const historyPath = path.join(dir, `${ts.slice(0, 7)}.jsonl`);
    const original = fs.readFileSync(historyPath, 'utf8');
    const external = '{"external":"must-survive"}\n';
    setScorecardHistoryTestHooksForTests({
      operation: 'append',
      parentSwap: {
        directoryPath: dir,
        displacedPath: displaced,
        replacementFiles: { [path.basename(historyPath)]: external },
      },
    });

    appendScorecardSnapshot({
      ts: new Date(Date.now() + 1_000).toISOString(),
      window: '7d',
      scorecard: computeFleetScorecard('7d'),
    });

    expect(fs.readFileSync(historyPath, 'utf8')).toBe(external);
    const pinnedContents = fs.readFileSync(path.join(displaced, path.basename(historyPath)), 'utf8');
    expect(pinnedContents.startsWith(original)).toBe(true);
    expect(pinnedContents.trim().split('\n')).toHaveLength(2);
  });

  it('withholds history when the pathname is replaced after read descriptor open', async () => {
    const { appendScorecardSnapshot, readScorecardHistory, scorecardHistoryDir } =
      await import('../src/core/fleet/scorecard-history.js');
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const ts = new Date().toISOString();
    appendScorecardSnapshot({ ts, window: '7d', scorecard: computeFleetScorecard('7d') });
    const historyPath = path.join(scorecardHistoryDir(), `${ts.slice(0, 7)}.jsonl`);
    const displaced = `${historyPath}.displaced`;
    const original = fs.readFileSync(historyPath, 'utf8');
    const replacement = '{"replacement":"must-survive"}\n';
    setScorecardHistoryTestHooksForTests({
      operation: 'read',
      fileSwap: {
        fileName: path.basename(historyPath),
        displacedName: path.basename(displaced),
        replacementContents: replacement,
      },
    });

    const read = readScorecardHistory({});

    expect(read).toMatchObject({
      sourceState: 'degraded', complete: false, records: [], unreadableFiles: 1,
    });
    expect(fs.readFileSync(displaced, 'utf8')).toBe(original);
    expect(fs.readFileSync(historyPath, 'utf8')).toBe(replacement);
  });

  it('enumerates and reads only through pinned cwd, then withholds if its named parent changed', async () => {
    const { appendScorecardSnapshot, readScorecardHistory, scorecardHistoryDir } =
      await import('../src/core/fleet/scorecard-history.js');
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    const ts = new Date().toISOString();
    appendScorecardSnapshot({ ts, window: '7d', scorecard: computeFleetScorecard('7d') });
    const dir = scorecardHistoryDir();
    const displaced = `${dir}.displaced-scorecard-read00001`;
    const historyPath = path.join(dir, `${ts.slice(0, 7)}.jsonl`);
    const original = fs.readFileSync(historyPath, 'utf8');
    const external = JSON.stringify({
      ts: new Date(Date.now() + 10_000).toISOString(),
      window: '7d',
      scorecard: { external: 'must-not-return' },
    }) + '\n';
    setScorecardHistoryTestHooksForTests({
      operation: 'read',
      parentSwap: {
        directoryPath: dir,
        displacedPath: displaced,
        replacementFiles: { [path.basename(historyPath)]: external },
      },
    });

    expect(readScorecardHistory({})).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      records: [],
      unreadableFiles: 1,
    });
    expect(fs.readFileSync(path.join(displaced, path.basename(historyPath)), 'utf8')).toBe(original);
    expect(fs.readFileSync(historyPath, 'utf8')).toBe(external);
  });

  it.each([
    ['nonzero', undefined, undefined],
    ['malformed-output', undefined, undefined],
    ['oversized-output', undefined, 1024 * 1024],
    ['timeout', 10, undefined],
  ] as const)(
    'degrades and withholds on bounded worker failure: %s',
    async (workerFailure, workerTimeoutMs, workerMaxBufferBytes) => {
      const { appendScorecardSnapshot, readScorecardHistory } =
        await import('../src/core/fleet/scorecard-history.js');
      const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
      appendScorecardSnapshot({
        ts: new Date().toISOString(),
        window: '7d',
        scorecard: computeFleetScorecard('7d'),
      });
      setScorecardHistoryTestHooksForTests({
        operation: 'read',
        workerFailure,
        ...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }),
        ...(workerMaxBufferBytes === undefined ? {} : { workerMaxBufferBytes }),
      });

      expect(readScorecardHistory({})).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        records: [],
        stopReasons: ['io-error'],
        unreadableFiles: 1,
      });
    },
  );
});

it.skipIf(process.platform !== 'win32')(
  'withholds scorecard persistence explicitly when handle-relative custody is unavailable',
  async () => {
    const { appendScorecardSnapshot, readScorecardHistory, scorecardHistoryDir } =
      await import('../src/core/fleet/scorecard-history.js');
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    appendScorecardSnapshot({
      ts: new Date().toISOString(),
      window: '7d',
      scorecard: computeFleetScorecard('7d'),
    });
    expect(fs.existsSync(scorecardHistoryDir())).toBe(false);
    expect(readScorecardHistory({})).toMatchObject({
      sourceState: 'degraded',
      sourcePresent: false,
      complete: false,
      records: [],
      stopReasons: ['unsupported-platform'],
    });
  },
);

// ---------------------------------------------------------------------------
// 13. snapshotScorecardIfDue
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('snapshotScorecardIfDue', () => {
  it('writes on first call, throttles immediately after, writes again once the interval elapses', async () => {
    const { snapshotScorecardIfDue } = await import('../src/core/fleet/scorecard.js');
    const { readScorecardHistory } = await import('../src/core/fleet/scorecard-history.js');

    const t0 = Date.now();
    const first = snapshotScorecardIfDue({ nowMs: t0 });
    expect(first.wrote).toBe(true);
    const afterFirst = readScorecardHistory({});
    expect(afterFirst.records.length).toBe(2); // one per window (7d + 30d)

    const second = snapshotScorecardIfDue({ nowMs: t0 + 1000 }); // 1s later — throttled
    expect(second.wrote).toBe(false);
    const afterSecond = readScorecardHistory({});
    expect(afterSecond.records.length).toBe(2);

    const third = snapshotScorecardIfDue({ nowMs: t0 + 25 * 60 * 60 * 1000 }); // 25h later — due
    expect(third.wrote).toBe(true);
    const afterThird = readScorecardHistory({});
    expect(afterThird.records.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 14. readScorecardTrend
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('readScorecardTrend', () => {
  it('filters trend points by window', async () => {
    const { appendScorecardSnapshot } = await import('../src/core/fleet/scorecard-history.js');
    const { computeFleetScorecard, readScorecardTrend } = await import('../src/core/fleet/scorecard.js');
    const sc7 = computeFleetScorecard('7d');
    const sc30 = computeFleetScorecard('30d');
    appendScorecardSnapshot({ ts: isoAgo(1 * DAY_MS), window: '7d', scorecard: sc7 });
    appendScorecardSnapshot({ ts: isoAgo(1 * DAY_MS), window: '30d', scorecard: sc30 });

    const trend7 = readScorecardTrend('7d');
    expect(trend7.points.length).toBe(1);
    expect(trend7.points[0]!.window).toBe('7d');
  });
});

// ---------------------------------------------------------------------------
// 15. CLI shape
// ---------------------------------------------------------------------------

describe('ashlr fleet scorecard CLI', () => {
  it('--json includes a selfEvaluation key with the FleetScorecard shape', async () => {
    await recordRealizedMerge(pid(), isoAgo(1 * DAY_MS));
    const { cmdFleet } = await import('../src/cli/fleet.js');
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const code = await cmdFleet(['scorecard', '--json']);
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(writes.join(''));
    expect(parsed).toHaveProperty('selfEvaluation');
    expect(parsed.selfEvaluation).toHaveProperty('window');
    expect(parsed.selfEvaluation).toHaveProperty('proposals');
    expect(parsed.selfEvaluation).toHaveProperty('judge');
    expect(parsed.selfEvaluation).toHaveProperty('merges');
    expect(parsed.selfEvaluation).toHaveProperty('cost');
    expect(parsed.selfEvaluation).toHaveProperty('latency');
    expect(parsed.selfEvaluation).toHaveProperty('learning');
    expect(parsed.selfEvaluation).toHaveProperty('byEngine');
    expect(parsed.selfEvaluation).toHaveProperty('capability');
    expect(parsed.selfEvaluation.merges.realized).toBe(1);
    // Legacy QualityMetrics fields remain present, unchanged, at the top level.
    expect(parsed).toHaveProperty('proposalsCreated');
  });

  it('human-readable mode prints the self-evaluation section without throwing', async () => {
    const { cmdFleet } = await import('../src/cli/fleet.js');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    try {
      const code = await cmdFleet(['scorecard']);
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(logs.some((l) => l.includes('Self-evaluation'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 16. API shape
// ---------------------------------------------------------------------------

function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function get(url: string, port: number) {
  return httpRequest('GET', url, { Host: `127.0.0.1:${port}`, ...readAuthHeaders(port) });
}

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
  } as unknown as AshlrConfig;
}

function makeOpts(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return { port: 0, open: false, allowDispatch: false, ...overrides };
}

describe('GET /api/scorecard', () => {
  it('returns 200 JSON with the FleetScorecard shape and honors ?window=', async () => {
    await recordRealizedMerge(pid(), isoAgo(1 * DAY_MS));
    const handle = await startServer(makeConfig(), makeOpts());
    try {
      const res7 = await get(`http://127.0.0.1:${handle.port}/api/scorecard`, handle.port);
      expect(res7.statusCode).toBe(200);
      const body7 = JSON.parse(res7.body);
      expect(body7.window).toBe('7d');
      expect(body7.merges.realized).toBe(1);
      expect(body7).toHaveProperty('proposals');
      expect(body7).toHaveProperty('capability');

      const res30 = await get(`http://127.0.0.1:${handle.port}/api/scorecard?window=30d`, handle.port);
      const body30 = JSON.parse(res30.body);
      expect(body30.window).toBe('30d');
    } finally {
      await handle.close();
    }
  });
});
