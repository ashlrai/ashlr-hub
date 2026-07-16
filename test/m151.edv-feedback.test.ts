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
} from '../src/core/fleet/feedback.js';
import {
  edvConfirmationWeight,
  EDV_UNVERIFIED_WEIGHT,
} from '../src/core/portfolio/edv-verify.js';
import type {
  WorkItem,
  WorkSource,
  Proposal,
  ProposalKind,
  DecisionEntry,
  RealizedMergeEvidence,
} from '../src/core/types.js';

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

vi.mock('../src/core/foundry/provenance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/foundry/provenance.js')>();
  return {
    ...real,
    verifyProducerProvenanceV2: (proposal: {
      producerProvenanceVersion?: number;
      producerProvenanceSig?: string;
    }) => ({
      ok: proposal.producerProvenanceVersion === 2 &&
        proposal.producerProvenanceSig === 'm151-producer-provenance-v2',
      reason: 'M151 producer provenance fixture',
    }),
  };
});

vi.mock('../src/core/inbox/remote-handoff-attestation.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/inbox/remote-handoff-attestation.js')>();
  return {
    ...real,
    verifyRemoteHandoffReconciliation: (
      _proposalId: string,
      _repo: string,
      handoff: { reconciliation?: { attestation?: string } },
    ) => handoff.reconciliation?.attestation === 'a'.repeat(64),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;

function makeProposal(
  over: Partial<Proposal> & { kind: ProposalKind },
): Proposal {
  const id = over.id ?? `prop-m151-${String(_seq++).padStart(4, '0')}`;
  const observedAt = over.createdAt ?? new Date().toISOString();
  const repo = over.repo ?? '/repo/alpha';
  const diffHash = 'd'.repeat(64);
  const branch = `ashlr/merge/${id}`;
  const prUrl = `https://github.com/ashlrai/m151-fixture/pull/${_seq + 1}`;
  const expectedHeadOid = '2'.repeat(40);
  const mergeCommitOid = '3'.repeat(40);
  const reconciliation = {
    schemaVersion: 1 as const,
    observedAt,
    attestation: 'a'.repeat(64),
  };
  const realizedMerge: RealizedMergeEvidence = {
    schemaVersion: 1,
    source: 'github-host',
    provider: 'github',
    prUrl,
    branch,
    base: 'main',
    expectedHeadOid,
    mergeCommitOid,
    mergedAt: observedAt,
    reconciliation,
  };
  return {
    id,
    origin: 'backlog',
    kind: over.kind,
    title: over.title ?? `test proposal ${id}`,
    summary: 'summary',
    status: over.status ?? 'pending',
    createdAt: observedAt,
    repo,
    diff: 'diff --git a/source.ts b/source.ts\n+const m151 = true;\n',
    diffHash,
    workItemId: `${repo}:todo:${id}`,
    workSource: over.kind === 'security' ? 'security' : 'todo',
    engineModel: 'codex:m151-fixture',
    engineTier: 'frontier',
    provenanceSig: 'm151-legacy-provenance',
    producerProvenanceVersion: 2,
    producerProvenanceSig: 'm151-producer-provenance-v2',
    remoteHandoff: {
      provider: 'github',
      state: 'merged',
      prUrl,
      branch,
      base: 'main',
      expectedHeadOid,
      mergeCommitOid,
      mergedAt: observedAt,
      reconciliation,
      createdAt: observedAt,
    },
    realizedMerge,
    ...over,
  };
}

function makeDecision(
  proposalId: string,
  action: DecisionEntry['action'],
  verdict?: string,
): DecisionEntry {
  return {
    ts: new Date().toISOString(),
    proposalId,
    action,
    verdict,
    ...(action === 'merged' ? { labelBasis: 'post-merge-credit-release-v1' as const } : {}),
  };
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

/** Build N distinct proposals with caller-controlled raw v1 merge labels. */
function fillMergedDecisions(p: Proposal, n = MIN_SAMPLES): Proposal[] {
  p.status = 'applied';
  const proposals = [p];
  _mockDecisions.push(makeDecision(p.id, 'merged', 'applied'));
  for (let i = 1; i < n; i++) {
    const sibling = makeProposal({
      kind: p.kind,
      repo: p.repo,
      status: 'applied',
      ...(p.verifyResult ? { verifyResult: p.verifyResult } : {}),
    });
    proposals.push(sibling);
    _mockDecisions.push(makeDecision(sibling.id, 'merged', 'applied'));
  }
  return proposals;
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

  expect(priors.global['todo']).toMatchObject({ diffCount: 0, emptyCount: 1 });
});

it('realized-merge-v1 does not grant positive EDV feedback credit', async () => {
  const p = makeProposal({ kind: 'patch' as ProposalKind, status: 'applied' });
  _mockDecisions = [{
    ...makeDecision(p.id, 'merged', 'applied'),
    labelBasis: 'realized-merge-v1',
  }];

  const priors = await computeOutcomePriors({
    listProposals: () => [p],
    edvVerify: true,
  });

  expect(priors.global['todo']?.merged).toBe(0);
  expect(priors.global['todo']?.mergedWeightedSum).toBeUndefined();
  expect(priors.global['todo']?.acceptRate).toBe(0);
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

describe('M151 §5 — EDV ON: verification cannot release held merge credit', () => {
  it('verifyResult.passed=true does not authorize a raw v1 merge label', async () => {
    const p = makeProposal({
      kind: 'patch' as ProposalKind,
      verifyResult: { passed: true },
    });
    const proposals = fillMergedDecisions(p, MIN_SAMPLES);

    const priors = await computeOutcomePriors({
      listProposals: () => proposals,
      edvVerify: true,
    });

    const stats = priors.global['todo'];
    expect(stats).toBeDefined();
    expect(stats).toMatchObject({ merged: 0, acceptRate: 0 });
    expect(stats!.mergedWeightedSum).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §6 — computeOutcomePriors + EDV ON: unconfirmed accept → reduced acceptRate
// ---------------------------------------------------------------------------

describe('M151 §6 — EDV ON: unconfirmed raw labels remain held', () => {
  it('proposal with no verifyResult receives no integer or weighted merge credit', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind }); // no verifyResult
    const proposals = fillMergedDecisions(p, MIN_SAMPLES);

    const priors = await computeOutcomePriors({
      listProposals: () => proposals,
      edvVerify: true,
    });

    const stats = priors.global['todo'];
    expect(stats).toBeDefined();
    expect(stats).toMatchObject({ merged: 0, acceptRate: 0 });
    expect(stats!.mergedWeightedSum).toBeUndefined();
  });

  it('verification differences cannot turn either raw v1 row into credit', async () => {
    const p1 = makeProposal({
      kind: 'patch' as ProposalKind,
      status: 'applied',
      verifyResult: { passed: true },
    });
    const p2 = makeProposal({ kind: 'patch' as ProposalKind, status: 'applied' }); // no verifyResult

    _mockDecisions.push(makeDecision(p1.id, 'merged', 'approved'));
    _mockDecisions.push(makeDecision(p2.id, 'merged', 'approved'));

    const priors = await computeOutcomePriors({
      listProposals: () => [p1, p2],
      edvVerify: true,
    });

    const stats = priors.global['todo'];
    expect(stats).toBeDefined();
    expect(stats).toMatchObject({ merged: 0, acceptRate: 0 });
    expect(stats!.mergedWeightedSum).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §7 — Flag-off parity: EDV OFF → identical acceptRate to pre-M151
// ---------------------------------------------------------------------------

describe('M151 §7 — Flag-off parity (edvVerify=false)', () => {
  it('EDV OFF also grants no raw v1 merge credit', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind }); // no verifyResult
    const proposals = fillMergedDecisions(p, MIN_SAMPLES);

    const priorsOff = await computeOutcomePriors({
      listProposals: () => proposals,
      edvVerify: false,
    });

    const statsOff = priorsOff.global['todo'];
    expect(statsOff).toBeDefined();
    // No mergedWeightedSum field when EDV is off
    expect(statsOff!.mergedWeightedSum).toBeUndefined();
    expect(statsOff).toMatchObject({ merged: 0, acceptRate: 0 });
  });

  it('EDV OFF and EDV ON (confirmed) produce same integer merged count', async () => {
    const p = makeProposal({
      kind: 'patch' as ProposalKind,
      verifyResult: { passed: true },
    });
    const proposals = fillMergedDecisions(p, MIN_SAMPLES);

    const priorsOff = await computeOutcomePriors({ listProposals: () => proposals, edvVerify: false });
    const priorsOn  = await computeOutcomePriors({ listProposals: () => proposals, edvVerify: true  });

    // Integer merged count should be the same regardless of EDV flag
    expect(priorsOff.global['todo']!.merged).toBe(priorsOn.global['todo']!.merged);
  });

  it('default (edvVerify absent) behaves identical to edvVerify=false', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind });
    const proposals = fillMergedDecisions(p, MIN_SAMPLES);

    const priorsDefault = await computeOutcomePriors({ listProposals: () => proposals });
    const priorsOff     = await computeOutcomePriors({ listProposals: () => proposals, edvVerify: false });

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

describe('M151 §8 — scoreAdjustment: held credit stays neutral across verification', () => {
  it('confirmed and unconfirmed raw v1 rows cannot create a routing preference', async () => {
    const pConfirmed   = makeProposal({ kind: 'patch' as ProposalKind, repo: '/repo/a', verifyResult: { passed: true } });
    const pUnconfirmed = makeProposal({ kind: 'security' as ProposalKind, repo: '/repo/a' });

    const proposals = [
      ...fillMergedDecisions(pConfirmed, MIN_SAMPLES),
      ...fillMergedDecisions(pUnconfirmed, MIN_SAMPLES),
    ];

    const priors = await computeOutcomePriors({
      listProposals: () => proposals,
      edvVerify: true,
    });

    const itemTodo     = makeItem('todo' as WorkSource, '/repo/a');
    const itemSecurity = makeItem('security' as WorkSource, '/repo/a');

    const mTodo     = scoreAdjustment(itemTodo, priors);
    const mSecurity = scoreAdjustment(itemSecurity, priors);

    expect(mTodo).toBe(mSecurity);
  });
});

// ---------------------------------------------------------------------------
// §9 — MIN_SAMPLES gate still applies under EDV ON
// ---------------------------------------------------------------------------

describe('M151 §9 — MIN_SAMPLES gate under EDV ON', () => {
  it('below MIN_SAMPLES → scoreAdjustment returns 1.0 even with EDV ON', async () => {
    const p = makeProposal({ kind: 'patch' as ProposalKind, verifyResult: { passed: true } });
    // Only MIN_SAMPLES - 1 decisions → below threshold
    const proposals = fillMergedDecisions(p, MIN_SAMPLES - 1);

    const priors = await computeOutcomePriors({ listProposals: () => proposals, edvVerify: true });
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
    const proposals = fillMergedDecisions(p, MIN_SAMPLES);
    const priors = await computeOutcomePriors({ listProposals: () => proposals, edvVerify: true });
    // @ts-expect-error intentionally bad item
    expect(() => scoreAdjustment(null, priors)).not.toThrow();
    expect(() => scoreAdjustment(makeItem('todo' as WorkSource), priors)).not.toThrow();
  });
});
