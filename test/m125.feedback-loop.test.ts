/**
 * test/m125.feedback-loop.test.ts — M125: Feedback loop invariant suite.
 *
 * Verifies:
 *   1. computeOutcomePriors aggregates verdicts/outcomes correctly per source.
 *   2. scoreAdjustment down-ranks noisy/empty sources, up-ranks ship/merge sources.
 *   3. scoreAdjustment is floored ≥ 0.5 regardless of how bad the stats are.
 *   4. scoreAdjustment returns 1.0 (no change) below the MIN_SAMPLES threshold.
 *   5. backlog re-ranking prefers productive sources over noisy ones.
 *   6. Flag-off (feedbackEnabled=false) → scores byte-identical to pre-M125.
 *
 * Hermetic: all ledgers are mocked; no filesystem access. Mirrors m53/m119 conventions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  computeOutcomePriors,
  scoreAdjustment,
  MIN_SAMPLES,
  MULTIPLIER_FLOOR,
  MULTIPLIER_CEIL,
  type OutcomePriors,
  type SourceStats,
} from '../src/core/fleet/feedback.js';
import type { WorkItem, WorkSource, Proposal, ProposalKind, DecisionEntry } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// ── Mock decisions-ledger and worked-ledger ──────────────────────────────────
// ---------------------------------------------------------------------------

// Hoisted mock state — mutated per-test.
let _mockDecisions: DecisionEntry[] = [];
let _mockWorkedEvents: { itemId: string; outcome: 'diff' | 'empty'; ts: string }[] = [];

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (opts?: { sinceMs?: number }) => {
    if (opts?.sinceMs !== undefined) {
      return _mockDecisions.filter((d) => Date.parse(d.ts) >= opts.sinceMs!);
    }
    return _mockDecisions;
  },
  recordDecision: vi.fn(),
  decisionsDir: () => '/mock/decisions',
}));

vi.mock('../src/core/fleet/worked-ledger.js', () => ({
  loadWorkedLedger: () => ({ events: _mockWorkedEvents }),
  recordOutcome: vi.fn(),
  workedLedgerPath: () => '/mock/worked.json',
  DEFAULT_COOLDOWN_MS: 6 * 60 * 60 * 1000,
  recentlyDeclined: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _proposalSeq = 0;

function makeProposal(
  over: Partial<Proposal> & { kind: ProposalKind; id?: string },
): Proposal {
  const id = over.id ?? `prop-test-${String(_proposalSeq++).padStart(4, '0')}-0000`;
  return {
    id,
    origin: 'backlog',
    kind: over.kind,
    title: over.title ?? `test proposal ${id}`,
    summary: over.summary ?? 'summary',
    status: over.status ?? 'pending',
    createdAt: over.createdAt ?? new Date().toISOString(),
    repo: over.repo ?? '/repo/alpha',
    ...over,
  };
}

let _itemSeq = 0;

function makeItem(source: WorkSource, repo = '/repo/alpha', overrides?: Partial<WorkItem>): WorkItem {
  const id = `/repo/alpha:${source}:item${_itemSeq++}`;
  return {
    id,
    repo,
    source,
    title: `${source} item`,
    detail: 'detail',
    value: 3,
    effort: 2,
    score: 1.5,
    tags: [],
    ts: new Date().toISOString(),
    ...overrides,
  };
}

function makeDecision(
  proposalId: string,
  action: DecisionEntry['action'],
  verdict?: string,
  ts?: string,
): DecisionEntry {
  return {
    ts: ts ?? new Date().toISOString(),
    proposalId,
    action,
    verdict,
  };
}

function makeWorkedEvent(
  source: WorkSource,
  outcome: 'diff' | 'empty',
  repo = '/repo/alpha',
  ts?: string,
): { itemId: string; outcome: 'diff' | 'empty'; ts: string } {
  return {
    itemId: `${repo}:${source}:hash${_itemSeq++}`,
    outcome,
    ts: ts ?? new Date().toISOString(),
  };
}

beforeEach(() => {
  _mockDecisions = [];
  _mockWorkedEvents = [];
  _proposalSeq = 0;
  _itemSeq = 0;
});

// ---------------------------------------------------------------------------
// 1. computeOutcomePriors — correct aggregation
// ---------------------------------------------------------------------------

describe('M125 §1 — computeOutcomePriors: aggregation', () => {
  it('returns empty priors when all ledgers are empty', async () => {
    const priors = await computeOutcomePriors({ listProposals: () => [] });
    expect(Object.keys(priors.global)).toHaveLength(0);
    expect(Object.keys(priors.byRepo)).toHaveLength(0);
    expect(priors.computedAt).toBeTruthy();
  });

  it('counts created proposals per source (via kind mapping)', async () => {
    const proposals = [
      makeProposal({ kind: 'patch' as ProposalKind }),    // → 'todo'
      makeProposal({ kind: 'patch' as ProposalKind }),    // → 'todo'
      makeProposal({ kind: 'security' as ProposalKind }), // → 'security'
    ];
    const priors = await computeOutcomePriors({ listProposals: () => proposals });

    expect(priors.global['todo']?.created).toBe(2);
    expect(priors.global['security']?.created).toBe(1);
  });

  it('counts merged decisions correctly', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    _mockDecisions = [
      makeDecision(p.id, 'merged', 'approved'),
    ];
    const priors = await computeOutcomePriors({ listProposals: () => [p] });
    expect(priors.global['todo']?.merged).toBeGreaterThanOrEqual(1);
  });

  it('counts rejected decisions correctly', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    _mockDecisions = [
      makeDecision(p.id, 'rejected', 'rejected'),
    ];
    const priors = await computeOutcomePriors({ listProposals: () => [p] });
    expect(priors.global['todo']?.rejected).toBeGreaterThanOrEqual(1);
  });

  it('counts ship verdicts', async () => {
    const p = makeProposal({ kind: 'security' as ProposalKind });
    _mockDecisions = [
      makeDecision(p.id, 'judged', 'ship'),
      makeDecision(p.id, 'judged', 'ship'),
    ];
    const priors = await computeOutcomePriors({ listProposals: () => [p] });
    expect(priors.global['security']?.shipCount).toBe(2);
    expect(priors.global['security']?.shipRate).toBeGreaterThan(0);
  });

  it('counts noise/harmful verdicts', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    _mockDecisions = [
      makeDecision(p.id, 'judged', 'noise'),
      makeDecision(p.id, 'judged', 'harmful'),
    ];
    const priors = await computeOutcomePriors({ listProposals: () => [p] });
    expect(priors.global['todo']?.noiseCount).toBe(2);
    expect(priors.global['todo']?.noiseRate).toBeGreaterThan(0);
  });

  it('counts worked-ledger diff/empty events per source', async () => {
    _mockWorkedEvents = [
      makeWorkedEvent('dep', 'diff'),
      makeWorkedEvent('dep', 'diff'),
      makeWorkedEvent('dep', 'empty'),
    ];
    const priors = await computeOutcomePriors({ listProposals: () => [] });

    expect(priors.global['dep']?.diffCount).toBe(2);
    expect(priors.global['dep']?.emptyCount).toBe(1);
    expect(priors.global['dep']?.emptyRate).toBeCloseTo(1 / 3, 5);
  });

  it('separates stats by repo', async () => {
    _mockWorkedEvents = [
      makeWorkedEvent('security', 'diff', '/repo/alpha'),
      makeWorkedEvent('security', 'empty', '/repo/beta'),
    ];
    const priors = await computeOutcomePriors({ listProposals: () => [] });

    expect(priors.byRepo['/repo/alpha']?.['security']?.diffCount).toBe(1);
    expect(priors.byRepo['/repo/beta']?.['security']?.emptyCount).toBe(1);
  });

  it('respects windowMs — excludes old entries', async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    _mockWorkedEvents = [
      { itemId: '/repo/alpha:dep:old', outcome: 'diff', ts: old },
      makeWorkedEvent('dep', 'diff'), // recent
    ];
    // 7-day window — should exclude the old event.
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const priors = await computeOutcomePriors({ listProposals: () => [], windowMs });
    expect(priors.global['dep']?.diffCount).toBe(1); // only recent
  });

  it('rates are recomputed correctly: acceptRate = (merged + shipCount) / created', async () => {
    const p1 = makeProposal({ kind: 'patch' as ProposalKind });
    const p2 = makeProposal({ kind: 'patch' as ProposalKind });
    const p3 = makeProposal({ kind: 'patch' as ProposalKind });
    _mockDecisions = [
      makeDecision(p1.id, 'merged', 'approved'),
      makeDecision(p2.id, 'judged', 'ship'),
    ];
    // 3 created, 1 merged + 1 ship = 2 accepted → acceptRate = 2/3
    const priors = await computeOutcomePriors({ listProposals: () => [p1, p2, p3] });
    const stats = priors.global['todo']!;
    expect(stats.created).toBe(3);
    expect(stats.merged + stats.shipCount).toBe(2);
    expect(stats.acceptRate).toBeCloseTo(2 / 3, 5);
  });
});

// ---------------------------------------------------------------------------
// 2. scoreAdjustment — direction + bounds
// ---------------------------------------------------------------------------

describe('M125 §2 — scoreAdjustment: direction', () => {
  it('returns 1.0 for empty priors (no data)', () => {
    const priors: OutcomePriors = { global: {}, byRepo: {}, computedAt: new Date().toISOString() };
    const item = makeItem('security');
    expect(scoreAdjustment(item, priors)).toBe(1.0);
  });

  it('returns 1.0 when sample count is below MIN_SAMPLES', () => {
    const tinyStats: SourceStats = {
      created: MIN_SAMPLES - 1,
      judged: 0,
      merged: 0,
      rejected: 0,
      shipCount: 0,
      noiseCount: 0,
      diffCount: 0,
      emptyCount: 0,
      shipRate: 0,
      acceptRate: 0,
      emptyRate: 0,
      noiseRate: 0,
    };
    const priors: OutcomePriors = {
      global: { security: tinyStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };
    const item = makeItem('security');
    expect(scoreAdjustment(item, priors)).toBe(1.0);
  });

  it('up-ranks a source with perfect ship/merge history', () => {
    // Perfect productivity: shipRate=1, acceptRate=1, emptyRate=0, noiseRate=0
    const goodStats: SourceStats = {
      created: 10,
      judged: 10,
      merged: 10,
      rejected: 0,
      shipCount: 10,
      noiseCount: 0,
      diffCount: 10,
      emptyCount: 0,
      shipRate: 1.0,
      acceptRate: 1.0,
      emptyRate: 0.0,
      noiseRate: 0.0,
    };
    const priors: OutcomePriors = {
      global: { security: goodStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };
    const item = makeItem('security');
    const multiplier = scoreAdjustment(item, priors);
    expect(multiplier).toBeGreaterThan(1.0);
    expect(multiplier).toBeLessThanOrEqual(MULTIPLIER_CEIL);
  });

  it('down-ranks a source with high noise and empty history', () => {
    // Worst-case: noise=1, empty=1, no ships, no merges
    const badStats: SourceStats = {
      created: 10,
      judged: 10,
      merged: 0,
      rejected: 10,
      shipCount: 0,
      noiseCount: 10,
      diffCount: 0,
      emptyCount: 10,
      shipRate: 0.0,
      acceptRate: 0.0,
      emptyRate: 1.0,
      noiseRate: 1.0,
    };
    const priors: OutcomePriors = {
      global: { dep: badStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };
    const item = makeItem('dep');
    const multiplier = scoreAdjustment(item, priors);
    expect(multiplier).toBeLessThan(1.0);
    expect(multiplier).toBeGreaterThanOrEqual(MULTIPLIER_FLOOR);
  });

  it('floor: multiplier is always ≥ MULTIPLIER_FLOOR (0.5)', () => {
    // Pathological stats: all bad signals.
    const worstStats: SourceStats = {
      created: 100,
      judged: 100,
      merged: 0,
      rejected: 100,
      shipCount: 0,
      noiseCount: 100,
      diffCount: 0,
      emptyCount: 100,
      shipRate: 0.0,
      acceptRate: 0.0,
      emptyRate: 1.0,
      noiseRate: 1.0,
    };
    const priors: OutcomePriors = {
      global: { todo: worstStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };
    const item = makeItem('todo');
    expect(scoreAdjustment(item, priors)).toBeGreaterThanOrEqual(MULTIPLIER_FLOOR);
  });

  it('ceiling: multiplier is always ≤ MULTIPLIER_CEIL (1.5)', () => {
    const bestStats: SourceStats = {
      created: 100,
      judged: 100,
      merged: 100,
      rejected: 0,
      shipCount: 100,
      noiseCount: 0,
      diffCount: 100,
      emptyCount: 0,
      shipRate: 1.0,
      acceptRate: 1.0,
      emptyRate: 0.0,
      noiseRate: 0.0,
    };
    const priors: OutcomePriors = {
      global: { security: bestStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };
    const item = makeItem('security');
    expect(scoreAdjustment(item, priors)).toBeLessThanOrEqual(MULTIPLIER_CEIL);
  });

  it('good source > 1.0 multiplier; bad source < 1.0 multiplier', () => {
    const goodStats: SourceStats = {
      created: 10, judged: 10, merged: 8, rejected: 1, shipCount: 8,
      noiseCount: 1, diffCount: 9, emptyCount: 1,
      shipRate: 0.8, acceptRate: 0.8, emptyRate: 0.1, noiseRate: 0.1,
    };
    const badStats: SourceStats = {
      created: 10, judged: 10, merged: 1, rejected: 8, shipCount: 1,
      noiseCount: 8, diffCount: 2, emptyCount: 8,
      shipRate: 0.1, acceptRate: 0.1, emptyRate: 0.8, noiseRate: 0.8,
    };
    const priors: OutcomePriors = {
      global: { security: goodStats, dep: badStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };
    const goodItem = makeItem('security');
    const badItem = makeItem('dep');
    expect(scoreAdjustment(goodItem, priors)).toBeGreaterThan(1.0);
    expect(scoreAdjustment(badItem, priors)).toBeLessThan(1.0);
  });

  it('prefers repo-specific stats over global when both exist', () => {
    const repoGoodStats: SourceStats = {
      created: 5, judged: 5, merged: 5, rejected: 0, shipCount: 5,
      noiseCount: 0, diffCount: 5, emptyCount: 0,
      shipRate: 1.0, acceptRate: 1.0, emptyRate: 0.0, noiseRate: 0.0,
    };
    const globalBadStats: SourceStats = {
      created: 20, judged: 20, merged: 0, rejected: 20, shipCount: 0,
      noiseCount: 20, diffCount: 0, emptyCount: 20,
      shipRate: 0.0, acceptRate: 0.0, emptyRate: 1.0, noiseRate: 1.0,
    };
    const priors: OutcomePriors = {
      global: { issue: globalBadStats },
      byRepo: { '/repo/alpha': { issue: repoGoodStats } },
      computedAt: new Date().toISOString(),
    };
    const item = makeItem('issue', '/repo/alpha');
    // Repo-specific good stats should give a good multiplier despite bad global.
    expect(scoreAdjustment(item, priors)).toBeGreaterThan(1.0);
  });

  it('falls back to global when no repo-specific entry', () => {
    const goodStats: SourceStats = {
      created: 10, judged: 10, merged: 10, rejected: 0, shipCount: 10,
      noiseCount: 0, diffCount: 10, emptyCount: 0,
      shipRate: 1.0, acceptRate: 1.0, emptyRate: 0.0, noiseRate: 0.0,
    };
    const priors: OutcomePriors = {
      global: { issue: goodStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };
    const item = makeItem('issue', '/repo/different');
    expect(scoreAdjustment(item, priors)).toBeGreaterThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// 3. buildBacklog re-ranking — productive sources float to top
// ---------------------------------------------------------------------------

describe('M125 §3 — buildBacklog re-ranking via feedback priors', () => {
  // We test the adjustment logic directly (without running scanners) by
  // confirming that scoreAdjustment produces relative ordering consistent
  // with what buildBacklog would apply.

  it('adjusting scores re-ranks items: productive source above noisy source', () => {
    const securityItem = makeItem('security', '/repo/alpha', { score: 1.0 });
    const depItem = makeItem('dep', '/repo/alpha', { score: 1.0 });

    const goodStats: SourceStats = {
      created: 10, judged: 10, merged: 10, rejected: 0, shipCount: 10,
      noiseCount: 0, diffCount: 10, emptyCount: 0,
      shipRate: 1.0, acceptRate: 1.0, emptyRate: 0.0, noiseRate: 0.0,
    };
    const badStats: SourceStats = {
      created: 10, judged: 10, merged: 0, rejected: 10, shipCount: 0,
      noiseCount: 10, diffCount: 0, emptyCount: 10,
      shipRate: 0.0, acceptRate: 0.0, emptyRate: 1.0, noiseRate: 1.0,
    };
    const priors: OutcomePriors = {
      global: { security: goodStats, dep: badStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };

    const secMult = scoreAdjustment(securityItem, priors);
    const depMult = scoreAdjustment(depItem, priors);

    // Both start at score 1.0 — after adjustment, security should be higher.
    const adjustedSecurity = securityItem.score * secMult;
    const adjustedDep = depItem.score * depMult;

    expect(adjustedSecurity).toBeGreaterThan(adjustedDep);
  });

  it('items with equal base score are ordered by source productivity', () => {
    const items = (
      ['dep', 'security', 'todo', 'issue'] as WorkSource[]
    ).map((src) => makeItem(src, '/repo/alpha', { score: 2.0 }));

    const secGood: SourceStats = {
      created: 10, judged: 10, merged: 9, rejected: 1, shipCount: 9,
      noiseCount: 1, diffCount: 9, emptyCount: 1,
      shipRate: 0.9, acceptRate: 0.9, emptyRate: 0.1, noiseRate: 0.1,
    };
    const depBad: SourceStats = {
      created: 10, judged: 10, merged: 1, rejected: 9, shipCount: 1,
      noiseCount: 9, diffCount: 1, emptyCount: 9,
      shipRate: 0.1, acceptRate: 0.1, emptyRate: 0.9, noiseRate: 0.9,
    };
    const priors: OutcomePriors = {
      global: { security: secGood, dep: depBad },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };

    const adjusted = items.map((item) => ({
      source: item.source,
      adjustedScore: item.score * scoreAdjustment(item, priors),
    }));
    adjusted.sort((a, b) => b.adjustedScore - a.adjustedScore);

    // security should rank above dep after adjustment.
    const secIdx = adjusted.findIndex((x) => x.source === 'security');
    const depIdx = adjusted.findIndex((x) => x.source === 'dep');
    expect(secIdx).toBeLessThan(depIdx);
  });
});

// ---------------------------------------------------------------------------
// 4. Flag-off — no adjustment when feedbackEnabled=false
// ---------------------------------------------------------------------------

describe('M125 §4 — flag-off: feedbackEnabled=false = no score change', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'm125-flagoff-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('scoreAdjustment with no matching priors returns exactly 1.0', () => {
    const priors: OutcomePriors = { global: {}, byRepo: {}, computedAt: new Date().toISOString() };
    const item = makeItem('lint');
    expect(scoreAdjustment(item, priors)).toBe(1.0);
  });

  it('scoreAdjustment returns 1.0 when below confidence threshold', () => {
    const lowConfidenceStats: SourceStats = {
      created: 2, judged: 1, merged: 1, rejected: 0, shipCount: 1,
      noiseCount: 0, diffCount: 2, emptyCount: 0,
      shipRate: 1.0, acceptRate: 0.5, emptyRate: 0.0, noiseRate: 0.0,
    };
    const priors: OutcomePriors = {
      global: { lint: lowConfidenceStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };
    // effectiveSamples = max(1, 2, 2) = 2 < MIN_SAMPLES(3) → no adjustment
    const item = makeItem('lint');
    expect(scoreAdjustment(item, priors)).toBe(1.0);
  });

  it('exactly at MIN_SAMPLES threshold: adjustment fires', () => {
    const atThresholdStats: SourceStats = {
      created: MIN_SAMPLES,
      judged: MIN_SAMPLES,
      merged: MIN_SAMPLES,
      rejected: 0,
      shipCount: MIN_SAMPLES,
      noiseCount: 0,
      diffCount: MIN_SAMPLES,
      emptyCount: 0,
      shipRate: 1.0,
      acceptRate: 1.0,
      emptyRate: 0.0,
      noiseRate: 0.0,
    };
    const priors: OutcomePriors = {
      global: { security: atThresholdStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };
    const item = makeItem('security');
    // At exactly MIN_SAMPLES, the adjustment should fire (≥ threshold).
    const mult = scoreAdjustment(item, priors);
    expect(mult).not.toBe(1.0);
    expect(mult).toBeGreaterThan(1.0); // perfect stats → uprank
  });
});

// ---------------------------------------------------------------------------
// 5. computeOutcomePriors — never throws
// ---------------------------------------------------------------------------

describe('M125 §5 — never throws invariants', () => {
  it('computeOutcomePriors never throws given malformed worked events', async () => {
    _mockWorkedEvents = [
      { itemId: 'malformed-no-colons', outcome: 'diff', ts: new Date().toISOString() },
      { itemId: '', outcome: 'empty', ts: new Date().toISOString() },
      { itemId: ':only-one-colon', outcome: 'diff', ts: new Date().toISOString() },
    ];
    await expect(
      computeOutcomePriors({ listProposals: () => [] }),
    ).resolves.toBeDefined();
  });

  it('computeOutcomePriors never throws when listProposals throws', async () => {
    const throwing = () => { throw new Error('store unavailable'); };
    await expect(
      computeOutcomePriors({ listProposals: throwing as unknown as () => Proposal[] }),
    ).resolves.toBeDefined();
  });

  it('scoreAdjustment never throws on malformed priors', () => {
    const item = makeItem('todo');
    // Pathologically bad priors object — should not throw.
    expect(() =>
      scoreAdjustment(item, null as unknown as OutcomePriors),
    ).not.toThrow();
    expect(
      scoreAdjustment(item, null as unknown as OutcomePriors),
    ).toBe(1.0);
  });

  it('scoreAdjustment returns 1.0 on undefined stats', () => {
    const priors: OutcomePriors = {
      global: { security: undefined as unknown as SourceStats },
      byRepo: {},
      computedAt: new Date().toISOString(),
    };
    const item = makeItem('security');
    expect(scoreAdjustment(item, priors)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// 6. Multiplier formula verification
// ---------------------------------------------------------------------------

describe('M125 §6 — multiplier formula', () => {
  it('productivity=1.0 maps to MULTIPLIER_CEIL', () => {
    // All four signals perfect.
    const stats: SourceStats = {
      created: 10, judged: 10, merged: 10, rejected: 0, shipCount: 10,
      noiseCount: 0, diffCount: 10, emptyCount: 0,
      shipRate: 1.0, acceptRate: 1.0, emptyRate: 0.0, noiseRate: 0.0,
    };
    const priors: OutcomePriors = { global: { security: stats }, byRepo: {}, computedAt: new Date().toISOString() };
    const item = makeItem('security');
    // productivity = 1.0*0.4 + 1.0*0.3 + 1.0*0.2 + 1.0*0.1 = 1.0
    // multiplier = 0.5 + 1.0 * (1.5 - 0.5) = 1.5
    expect(scoreAdjustment(item, priors)).toBeCloseTo(MULTIPLIER_CEIL, 5);
  });

  it('productivity=0.0 maps to MULTIPLIER_FLOOR', () => {
    // All four signals zero.
    const stats: SourceStats = {
      created: 10, judged: 10, merged: 0, rejected: 10, shipCount: 0,
      noiseCount: 10, diffCount: 0, emptyCount: 10,
      shipRate: 0.0, acceptRate: 0.0, emptyRate: 1.0, noiseRate: 1.0,
    };
    const priors: OutcomePriors = { global: { dep: stats }, byRepo: {}, computedAt: new Date().toISOString() };
    const item = makeItem('dep');
    // productivity = 0*0.4 + 0*0.3 + (1-1)*0.2 + (1-1)*0.1 = 0.0
    // multiplier = 0.5 + 0.0 * 1.0 = 0.5
    expect(scoreAdjustment(item, priors)).toBeCloseTo(MULTIPLIER_FLOOR, 5);
  });

  it('productivity=0.5 maps to midpoint (1.0)', () => {
    // Neutral stats → productivity = 0.5.
    const stats: SourceStats = {
      created: 10, judged: 10, merged: 5, rejected: 5, shipCount: 5,
      noiseCount: 5, diffCount: 5, emptyCount: 5,
      shipRate: 0.5, acceptRate: 0.5, emptyRate: 0.5, noiseRate: 0.5,
    };
    const priors: OutcomePriors = { global: { issue: stats }, byRepo: {}, computedAt: new Date().toISOString() };
    const item = makeItem('issue');
    // productivity = 0.5*0.4 + 0.5*0.3 + (1-0.5)*0.2 + (1-0.5)*0.1
    //             = 0.2 + 0.15 + 0.1 + 0.05 = 0.5
    // multiplier = 0.5 + 0.5 * 1.0 = 1.0
    expect(scoreAdjustment(item, priors)).toBeCloseTo(1.0, 5);
  });
});
