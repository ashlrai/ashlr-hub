/**
 * test/m151.edv-feedback.test.ts — M151: EDV independent-confirmation gate.
 *
 * Verifies:
 *   1. edvConfirmationWeight: testPass signal (verifyResult.passed).
 *   2. edvConfirmationWeight: verifierVerdict signal (action==='verified' decisions).
 *   3. edvConfirmationWeight: absent signals → unverified weight.
 *   4. edvConfirmationWeight: never throws.
 *   5. computeOutcomePriors + EDV ON: confirmed accept → full weight (acceptRate = 1.0 source).
 *   6. computeOutcomePriors + EDV ON: unconfirmed accept → reduced acceptRate.
 *   7. computeOutcomePriors + EDV OFF: identical acceptRate to pre-M151 (flag-off parity).
 *   8. scoreAdjustment: EDV-confirmed source scores higher than unconfirmed.
 *   9. MIN_SAMPLES gate still applies under EDV ON.
 *  10. [0.5, 1.5] clamp still holds under EDV ON.
 *  11. Never throws under EDV ON with garbage input.
 *
 * Hermetic: all ledgers mocked; no filesystem access. Mirrors m125/m119 conventions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  computeOutcomePriors,
  scoreAdjustment,
  MIN_SAMPLES,
  MULTIPLIER_FLOOR,
  MULTIPLIER_CEIL,
  type OutcomePriors,
} from '../src/core/fleet/feedback.js';
import {
  edvConfirmationWeight,
  EDV_UNVERIFIED_WEIGHT,
} from '../src/core/portfolio/edv-verify.js';
import type { WorkItem, WorkSource, Proposal, ProposalKind, DecisionEntry } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock ledgers (same pattern as m125)
// ---------------------------------------------------------------------------

let _mockDecisions: DecisionEntry[] = [];
let _mockWorkedEvents: { itemId: string; outcome: 'diff' | 'empty' | 'dispatch-blocked'; ts: string }[] = [];

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

let _seq = 0;

function makeProposal(
  over: Partial<Proposal> & { kind: ProposalKind },
): Proposal {
  const id = over.id ?? `prop-m151-${String(_seq++).padStart(4, '0')}`;
  return {
    id,
    origin: 'backlog',
    kind: over.kind,
    title: over.title ?? `test proposal ${id}`,
    summary: 'summary',
    status: over.status ?? 'pending',
    createdAt: over.createdAt ?? new Date().toISOString(),
    repo: over.repo ?? '/repo/alpha',
    ...over,
  };
}

function makeDecision(
  proposalId: string,
  action: DecisionEntry['action'],
  verdict?: string,
): DecisionEntry {
  return { ts: new Date().toISOString(), proposalId, action, verdict };
}

function makeItem(source: WorkSource, repo = '/repo/alpha'): WorkItem {
  return {
    id: `/repo/alpha:${source}:item${_seq++}`,
    repo,
    source,
    title: `${source} item`,
    detail: 'detail',
    value: 3,
    effort: 2,
    score: 1.5,
    tags: [],
    ts: new Date().toISOString(),
  };
}

/** Build N merged-decision entries for a proposal, filling MIN_SAMPLES. */
function fillMergedDecisions(p: Proposal, n = MIN_SAMPLES): void {
  for (let i = 0; i < n; i++) {
    _mockDecisions.push(makeDecision(p.id, 'merged', 'approved'));
  }
}

beforeEach(() => {
  _mockDecisions = [];
  _mockWorkedEvents = [];
  _seq = 0;
});

it('selection-only dispatch blocks do not become empty execution priors', async () => {
  const now = new Date().toISOString();
  _mockWorkedEvents = [
    { itemId: '/repo/alpha:todo:diff', outcome: 'diff', ts: now },
    { itemId: '/repo/alpha:todo:empty', outcome: 'empty', ts: now },
    { itemId: '/repo/alpha:todo:blocked', outcome: 'dispatch-blocked', ts: now },
  ];

  const priors = await computeOutcomePriors({ listProposals: () => [] });

  expect(priors.global['todo']).toMatchObject({ diffCount: 1, emptyCount: 1 });
});

// ---------------------------------------------------------------------------
// §1 — edvConfirmationWeight: testPass signal
// ---------------------------------------------------------------------------

describe('M151 §1 — edvConfirmationWeight: testPass signal', () => {
  it('verifyResult.passed=true → confirmed=true, source=testPass, weight=1.0', () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind, verifyResult: { passed: true } });
    const result = edvConfirmationWeight(p, []);
    expect(result.confirmed).toBe(true);
    expect(result.source).toBe('testPass');
    expect(result.weight).toBe(1.0);
  });

  it('verifyResult.passed=false → confirmed=false, source=testPass, weight=EDV_UNVERIFIED_WEIGHT', () => {
    const p = makeProposal({
      kind: 'patch' as ProposalKind,
      verifyResult: { passed: false, failed: ['test suite'] },
    });
    const result = edvConfirmationWeight(p, []);
    expect(result.confirmed).toBe(false);
    expect(result.source).toBe('testPass');
    expect(result.weight).toBe(EDV_UNVERIFIED_WEIGHT);
  });

  it('testPass takes priority over verifierVerdict (both present, testPass wins)', () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind, verifyResult: { passed: true } });
    const decisions: DecisionEntry[] = [makeDecision(p.id, 'verified', 'rejected')];
    // testPass passed → should be confirmed regardless of verifier verdict
    const result = edvConfirmationWeight(p, decisions);
    expect(result.confirmed).toBe(true);
    expect(result.source).toBe('testPass');
  });
});

// ---------------------------------------------------------------------------
// §2 — edvConfirmationWeight: verifierVerdict signal
// ---------------------------------------------------------------------------

describe('M151 §2 — edvConfirmationWeight: verifierVerdict signal', () => {
  it('verified decision with no verdict → confirmed=true, source=verifierVerdict', () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    const decisions: DecisionEntry[] = [makeDecision(p.id, 'verified')];
    const result = edvConfirmationWeight(p, decisions);
    expect(result.confirmed).toBe(true);
    expect(result.source).toBe('verifierVerdict');
    expect(result.weight).toBe(1.0);
  });

  it('verified decision with approved verdict → confirmed=true', () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    const decisions: DecisionEntry[] = [makeDecision(p.id, 'verified', 'approved')];
    const result = edvConfirmationWeight(p, decisions);
    expect(result.confirmed).toBe(true);
    expect(result.weight).toBe(1.0);
  });

  it('verified decision with rejected verdict → confirmed=false, weight=EDV_UNVERIFIED_WEIGHT', () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    const decisions: DecisionEntry[] = [makeDecision(p.id, 'verified', 'rejected')];
    const result = edvConfirmationWeight(p, decisions);
    expect(result.confirmed).toBe(false);
    expect(result.source).toBe('verifierVerdict');
    expect(result.weight).toBe(EDV_UNVERIFIED_WEIGHT);
  });

  it('verified decision with noise verdict → confirmed=false', () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    const decisions: DecisionEntry[] = [makeDecision(p.id, 'verified', 'noise')];
    const result = edvConfirmationWeight(p, decisions);
    expect(result.confirmed).toBe(false);
    expect(result.weight).toBe(EDV_UNVERIFIED_WEIGHT);
  });

  it('verified decision with harmful verdict → confirmed=false', () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    const decisions: DecisionEntry[] = [makeDecision(p.id, 'verified', 'harmful')];
    const result = edvConfirmationWeight(p, decisions);
    expect(result.confirmed).toBe(false);
  });

  it('non-verified decisions are ignored (only verified action counts)', () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    // Only a 'judged' action — not 'verified'
    const decisions: DecisionEntry[] = [makeDecision(p.id, 'judged', 'ship')];
    const result = edvConfirmationWeight(p, decisions);
    // No verifyResult, no 'verified' action → none
    expect(result.source).toBe('none');
    expect(result.confirmed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §3 — edvConfirmationWeight: absent signals → unverified
// ---------------------------------------------------------------------------

describe('M151 §3 — edvConfirmationWeight: absent signals', () => {
  it('no verifyResult and no verified decisions → source=none, weight=EDV_UNVERIFIED_WEIGHT', () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    const result = edvConfirmationWeight(p, []);
    expect(result.confirmed).toBe(false);
    expect(result.source).toBe('none');
    expect(result.weight).toBe(EDV_UNVERIFIED_WEIGHT);
  });
});

// ---------------------------------------------------------------------------
// §4 — edvConfirmationWeight: never throws
// ---------------------------------------------------------------------------

describe('M151 §4 — edvConfirmationWeight: never throws', () => {
  it('handles null/undefined gracefully', () => {
    // @ts-expect-error intentionally bad input
    expect(() => edvConfirmationWeight(null, [])).not.toThrow();
    // @ts-expect-error intentionally bad input
    expect(() => edvConfirmationWeight({}, null)).not.toThrow();
    // @ts-expect-error intentionally bad input
    expect(() => edvConfirmationWeight(undefined, undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §5 — computeOutcomePriors + EDV ON: confirmed accept → full acceptRate
// ---------------------------------------------------------------------------

describe('M151 §5 — EDV ON: confirmed accept reinforces at full weight', () => {
  it('proposal with verifyResult.passed=true → acceptRate uses weight 1.0', async () => {
    const p = makeProposal({
      kind: 'patch' as ProposalKind,
      verifyResult: { passed: true },
    });
    // MIN_SAMPLES merged decisions + created entry from the proposal list
    fillMergedDecisions(p, MIN_SAMPLES);

    const priors = await computeOutcomePriors({
      listProposals: () => [p],
      edvVerify: true,
    });

    const stats = priors.global['todo'];
    expect(stats).toBeDefined();
    // mergedWeightedSum should equal MIN_SAMPLES × 1.0
    expect(stats!.mergedWeightedSum).toBeCloseTo(MIN_SAMPLES * 1.0, 5);
    // acceptRate = (mergedWeightedSum + 0) / created = MIN_SAMPLES / 1
    // (created=1 from the single proposal; merged each decision counts but
    // the proposal was created once)
    expect(stats!.mergedWeightedSum).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §6 — computeOutcomePriors + EDV ON: unconfirmed accept → reduced acceptRate
// ---------------------------------------------------------------------------

describe('M151 §6 — EDV ON: unconfirmed accept contributes reduced weight', () => {
  it('proposal with no verifyResult → mergedWeightedSum < merged (integer)', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind }); // no verifyResult
    fillMergedDecisions(p, MIN_SAMPLES);

    const priors = await computeOutcomePriors({
      listProposals: () => [p],
      edvVerify: true,
    });

    const stats = priors.global['todo'];
    expect(stats).toBeDefined();
    // Integer merged is MIN_SAMPLES; weighted sum is MIN_SAMPLES × 0.3
    expect(stats!.merged).toBe(MIN_SAMPLES);
    expect(stats!.mergedWeightedSum).toBeCloseTo(MIN_SAMPLES * EDV_UNVERIFIED_WEIGHT, 5);
    // acceptRate (EDV) < acceptRate (flag-off) for same data
    const edvAcceptRate = stats!.acceptRate;
    const flagOffAcceptRate = (MIN_SAMPLES + 0) / 1; // merged/created
    expect(edvAcceptRate).toBeLessThan(flagOffAcceptRate);
  });

  it('two proposals: one confirmed, one not — weighted sum is 1.0 + 0.3', async () => {
    const p1 = makeProposal({ kind: 'patch' as ProposalKind, verifyResult: { passed: true } });
    const p2 = makeProposal({ kind: 'patch' as ProposalKind }); // no verifyResult

    _mockDecisions.push(makeDecision(p1.id, 'merged', 'approved'));
    _mockDecisions.push(makeDecision(p2.id, 'merged', 'approved'));

    const priors = await computeOutcomePriors({
      listProposals: () => [p1, p2],
      edvVerify: true,
    });

    const stats = priors.global['todo'];
    expect(stats).toBeDefined();
    expect(stats!.merged).toBe(2);
    expect(stats!.mergedWeightedSum).toBeCloseTo(1.0 + EDV_UNVERIFIED_WEIGHT, 5);
  });
});

// ---------------------------------------------------------------------------
// §7 — Flag-off parity: EDV OFF → identical acceptRate to pre-M151
// ---------------------------------------------------------------------------

describe('M151 §7 — Flag-off parity (edvVerify=false)', () => {
  it('EDV OFF → mergedWeightedSum is absent, acceptRate identical to flag-off formula', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind }); // no verifyResult
    fillMergedDecisions(p, MIN_SAMPLES);

    const priorsOff = await computeOutcomePriors({
      listProposals: () => [p],
      edvVerify: false,
    });

    const statsOff = priorsOff.global['todo'];
    expect(statsOff).toBeDefined();
    // No mergedWeightedSum field when EDV is off
    expect(statsOff!.mergedWeightedSum).toBeUndefined();
    // acceptRate = (merged + 0) / created = MIN_SAMPLES / 1
    expect(statsOff!.acceptRate).toBeCloseTo(MIN_SAMPLES / 1, 5);
  });

  it('EDV OFF and EDV ON (confirmed) produce same integer merged count', async () => {
    const p = makeProposal({
      kind: 'patch' as ProposalKind,
      verifyResult: { passed: true },
    });
    fillMergedDecisions(p, MIN_SAMPLES);

    const priorsOff = await computeOutcomePriors({ listProposals: () => [p], edvVerify: false });
    const priorsOn  = await computeOutcomePriors({ listProposals: () => [p], edvVerify: true  });

    // Integer merged count should be the same regardless of EDV flag
    expect(priorsOff.global['todo']!.merged).toBe(priorsOn.global['todo']!.merged);
  });

  it('default (edvVerify absent) behaves identical to edvVerify=false', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    fillMergedDecisions(p, MIN_SAMPLES);

    const priorsDefault = await computeOutcomePriors({ listProposals: () => [p] });
    const priorsOff     = await computeOutcomePriors({ listProposals: () => [p], edvVerify: false });

    const sD = priorsDefault.global['todo']!;
    const sO = priorsOff.global['todo']!;
    expect(sD.acceptRate).toBeCloseTo(sO.acceptRate, 10);
    expect(sD.mergedWeightedSum).toBeUndefined();
    expect(sO.mergedWeightedSum).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §8 — scoreAdjustment: EDV-confirmed source scores higher than unconfirmed
// ---------------------------------------------------------------------------

describe('M151 §8 — scoreAdjustment: confirmed > unconfirmed source', () => {
  it('confirmed source multiplier > unconfirmed source multiplier (same sample count)', async () => {
    const pConfirmed   = makeProposal({ kind: 'patch' as ProposalKind, repo: '/repo/a', verifyResult: { passed: true } });
    const pUnconfirmed = makeProposal({ kind: 'security' as ProposalKind, repo: '/repo/a' });

    fillMergedDecisions(pConfirmed, MIN_SAMPLES);
    fillMergedDecisions(pUnconfirmed, MIN_SAMPLES);

    const priors = await computeOutcomePriors({
      listProposals: () => [pConfirmed, pUnconfirmed],
      edvVerify: true,
    });

    const itemTodo     = makeItem('todo' as WorkSource, '/repo/a');
    const itemSecurity = makeItem('security' as WorkSource, '/repo/a');

    const mTodo     = scoreAdjustment(itemTodo, priors);
    const mSecurity = scoreAdjustment(itemSecurity, priors);

    // todo source is confirmed, security is not — todo multiplier should be higher
    expect(mTodo).toBeGreaterThan(mSecurity);
  });
});

// ---------------------------------------------------------------------------
// §9 — MIN_SAMPLES gate still applies under EDV ON
// ---------------------------------------------------------------------------

describe('M151 §9 — MIN_SAMPLES gate under EDV ON', () => {
  it('below MIN_SAMPLES → scoreAdjustment returns 1.0 even with EDV ON', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind, verifyResult: { passed: true } });
    // Only MIN_SAMPLES - 1 decisions → below threshold
    fillMergedDecisions(p, MIN_SAMPLES - 1);

    const priors = await computeOutcomePriors({ listProposals: () => [p], edvVerify: true });
    const item = makeItem('todo' as WorkSource);
    expect(scoreAdjustment(item, priors)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// §10 — [0.5, 1.5] clamp holds under EDV ON
// ---------------------------------------------------------------------------

describe('M151 §10 — multiplier clamp [FLOOR, CEIL] under EDV ON', () => {
  it('all-unconfirmed source: multiplier >= MULTIPLIER_FLOOR', async () => {
    const proposals: Proposal[] = [];
    for (let i = 0; i < MIN_SAMPLES * 3; i++) {
      const p = makeProposal({ kind: 'patch' as ProposalKind }); // all unconfirmed
      proposals.push(p);
      _mockDecisions.push(makeDecision(p.id, 'merged', 'approved'));
      // Add noise verdicts to drive productivity down
      _mockDecisions.push(makeDecision(p.id, 'judged', 'noise'));
    }

    const priors = await computeOutcomePriors({ listProposals: () => proposals, edvVerify: true });
    const item = makeItem('todo' as WorkSource);
    const m = scoreAdjustment(item, priors);
    expect(m).toBeGreaterThanOrEqual(MULTIPLIER_FLOOR);
    expect(m).toBeLessThanOrEqual(MULTIPLIER_CEIL);
  });

  it('all-confirmed source: multiplier <= MULTIPLIER_CEIL', async () => {
    const proposals: Proposal[] = [];
    for (let i = 0; i < MIN_SAMPLES * 3; i++) {
      const p = makeProposal({ kind: 'patch' as ProposalKind, verifyResult: { passed: true } });
      proposals.push(p);
      _mockDecisions.push(makeDecision(p.id, 'merged', 'approved'));
      _mockDecisions.push(makeDecision(p.id, 'judged', 'ship'));
    }
    _mockWorkedEvents = proposals.map((p) => ({
      itemId: `/repo/alpha:todo:${p.id}`,
      outcome: 'diff' as const,
      ts: new Date().toISOString(),
    }));

    const priors = await computeOutcomePriors({ listProposals: () => proposals, edvVerify: true });
    const item = makeItem('todo' as WorkSource);
    const m = scoreAdjustment(item, priors);
    expect(m).toBeGreaterThanOrEqual(MULTIPLIER_FLOOR);
    expect(m).toBeLessThanOrEqual(MULTIPLIER_CEIL);
  });
});

// ---------------------------------------------------------------------------
// §11 — Never throws under EDV ON with garbage input
// ---------------------------------------------------------------------------

describe('M151 §11 — never throws under EDV ON', () => {
  it('computeOutcomePriors with edvVerify=true and empty ledgers does not throw', async () => {
    await expect(
      computeOutcomePriors({ listProposals: () => [], edvVerify: true }),
    ).resolves.toBeDefined();
  });

  it('computeOutcomePriors with edvVerify=true and throwing listProposals does not throw', async () => {
    await expect(
      computeOutcomePriors({
        listProposals: () => { throw new Error('boom'); },
        edvVerify: true,
      }),
    ).resolves.toBeDefined();
  });

  it('scoreAdjustment with EDV-produced priors does not throw', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind, verifyResult: { passed: true } });
    fillMergedDecisions(p, MIN_SAMPLES);
    const priors = await computeOutcomePriors({ listProposals: () => [p], edvVerify: true });
    // @ts-expect-error intentionally bad item
    expect(() => scoreAdjustment(null, priors)).not.toThrow();
    expect(() => scoreAdjustment(makeItem('todo' as WorkSource), priors)).not.toThrow();
  });
});
