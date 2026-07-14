/**
 * M399: merge priors must reflect applied proposals, not authorization rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DecisionEntry,
  Proposal,
  RealizedMergeEvidence,
  WorkItem,
} from '../src/core/types.js';
import { computeOutcomePriors, scoreAdjustment } from '../src/core/fleet/feedback.js';

let decisions: DecisionEntry[] = [];

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: () => {
    const rows = [...decisions];
    Object.defineProperty(rows, 'sourceQuality', {
      value: {
        sourceState: 'healthy', sourcePresent: true, complete: true,
        stopReasons: [], filesRead: rows.length > 0 ? 1 : 0, bytesRead: 0,
        rowsScanned: rows.length, invalidRows: 0, unreadableFiles: 0,
      },
      enumerable: false,
    });
    return rows;
  },
}));

vi.mock('../src/core/fleet/worked-ledger.js', () => ({
  loadWorkedLedger: () => ({ events: [] }),
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
        proposal.producerProvenanceSig === 'test-producer-provenance',
      reason: 'test producer provenance v2',
    }),
  };
});

function proposal(id: string): Proposal {
  return {
    id,
    origin: 'backlog',
    kind: 'patch',
    title: `proposal ${id}`,
    summary: 'summary',
    status: 'pending',
    createdAt: '2026-07-14T12:00:00.000Z',
    repo: '/repo/alpha',
  };
}

function realizedProposal(id: string, observedAt = '2026-07-14T12:05:00.000Z'): Proposal {
  const realizedMerge: RealizedMergeEvidence = {
    schemaVersion: 1,
    source: 'local-default-branch',
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    mergeCommitOid: '3'.repeat(40),
    observedAt,
  };
  return {
    ...proposal(id),
    status: 'applied',
    producerProvenanceVersion: 2,
    producerProvenanceSig: 'test-producer-provenance',
    realizedMerge,
  };
}

function decision(
  proposalId: string,
  action: DecisionEntry['action'],
  verdict?: string,
  ts = '2026-07-14T12:00:00.000Z',
  canonicalMerge = true,
): DecisionEntry {
  return {
    ts,
    proposalId,
    action,
    ...(verdict !== undefined ? { verdict } : {}),
    ...(action === 'merged' && canonicalMerge
      ? { labelBasis: 'realized-merge-v1' as const }
      : {}),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-14T13:00:00.000Z'));
  decisions = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('M399 computeOutcomePriors merge truth', () => {
  it('does not count merge authorization as a merged proposal', async () => {
    const p = proposal('authorized-only');
    decisions = [decision(p.id, 'merge-authorized', 'approved')];

    const priors = await computeOutcomePriors({ listProposals: () => [p] });

    expect(priors.global.todo).toMatchObject({ created: 1, merged: 0 });
    expect(priors.byRepo[p.repo]?.todo?.merged).toBe(0);
  });

  it('counts application once after authorization', async () => {
    const p = realizedProposal('applied');
    decisions = [
      decision(p.id, 'merge-authorized', 'approved'),
      decision(p.id, 'merged', 'applied'),
    ];

    const priors = await computeOutcomePriors({ listProposals: () => [p] });

    expect(priors.global.todo).toMatchObject({ created: 1, merged: 1, acceptRate: 1 });
    expect(priors.byRepo[p.repo]?.todo?.merged).toBe(1);
  });

  it('deduplicates repeated merged rows per proposal', async () => {
    const first = { ...realizedProposal('duplicate-merge'), verifyResult: { passed: true } };
    const second = { ...realizedProposal('distinct-merge'), verifyResult: { passed: true } };
    decisions = [
      decision(first.id, 'merged', 'applied'),
      decision(first.id, 'merged', 'applied'),
      decision(second.id, 'merged', 'applied'),
    ];

    const priors = await computeOutcomePriors({ listProposals: () => [first, second] });
    const edvPriors = await computeOutcomePriors({
      listProposals: () => [first, second],
      edvVerify: true,
    });

    expect(priors.global.todo).toMatchObject({ created: 2, merged: 2, acceptRate: 1 });
    expect(priors.byRepo[first.repo]?.todo?.merged).toBe(2);
    expect(edvPriors.global.todo).toMatchObject({
      created: 2,
      merged: 2,
      mergedWeightedSum: 2,
      acceptRate: 1,
    });
  });

  it('applies merge windows to witness time instead of the ledger row time', async () => {
    vi.setSystemTime(new Date('2026-07-14T13:00:00.000Z'));
    const recentWitness = realizedProposal('recent-witness', '2026-07-14T12:30:00.000Z');
    const oldWitness = realizedProposal('old-witness', '2026-07-01T12:30:00.000Z');
    decisions = [
      decision(recentWitness.id, 'merged', 'applied', '2026-07-01T12:00:00.000Z'),
      decision(oldWitness.id, 'merged', 'applied', '2026-07-14T12:45:00.000Z'),
    ];

    const priors = await computeOutcomePriors({
      listProposals: () => [recentWitness, oldWitness],
      windowMs: 60 * 60 * 1000,
    });

    expect(priors.global.todo).toMatchObject({ created: 2, merged: 1, acceptRate: 0.5 });
  });

  it('rejects future realized evidence and future judge predictions', async () => {
    const future = realizedProposal('future-witness', '2026-07-14T14:00:00.000Z');
    const pending = proposal('future-prediction');
    decisions = [
      decision(future.id, 'merged', 'applied', '2026-07-14T12:00:00.000Z'),
      decision(pending.id, 'judged', 'ship', '2026-07-14T14:00:00.000Z'),
    ];

    const priors = await computeOutcomePriors({ listProposals: () => [future, pending] });

    expect(priors.global.todo).toMatchObject({
      created: 2,
      judged: 0,
      shipCount: 0,
      merged: 0,
      acceptRate: 0,
    });
  });

  it('does not infer a merge from a legacy approved verdict', async () => {
    const p = proposal('legacy-approved-verdict');
    decisions = [decision(p.id, 'judged', 'approved')];

    const priors = await computeOutcomePriors({ listProposals: () => [p] });

    expect(priors.global.todo).toMatchObject({ created: 1, merged: 0, acceptRate: 0 });
    expect(priors.byRepo[p.repo]?.todo?.merged).toBe(0);
  });

  it('rejects a legacy premature merged row without realized evidence', async () => {
    const p = proposal('legacy-premature-merged');
    decisions = [decision(p.id, 'merged', 'applied', undefined, false)];

    const priors = await computeOutcomePriors({ listProposals: () => [p] });

    expect(priors.global.todo).toMatchObject({ created: 1, merged: 0, acceptRate: 0 });
  });

  it('rejects a legacy merged row even when the proposal has a current witness', async () => {
    const p = realizedProposal('legacy-with-witness');
    decisions = [decision(p.id, 'merged', 'applied', undefined, false)];

    const priors = await computeOutcomePriors({ listProposals: () => [p] });

    expect(priors.global.todo).toMatchObject({ created: 1, merged: 0, acceptRate: 0 });
  });

  it('uses the newest rejection when a premature merge has no witness', async () => {
    const p = proposal('premature-then-rejected');
    decisions = [
      decision(p.id, 'merged', 'applied', '2026-07-14T12:00:00.000Z', false),
      decision(p.id, 'rejected', 'rejected', '2026-07-14T12:10:00.000Z'),
    ];

    const priors = await computeOutcomePriors({ listProposals: () => [p] });

    expect(priors.global.todo).toMatchObject({ merged: 0, rejected: 1, acceptRate: 0 });
  });

  it('makes a newer exact realized witness authoritative over stale rejection history', async () => {
    const p = realizedProposal('realized-after-rejection', '2026-07-14T12:20:00.000Z');
    decisions = [
      decision(p.id, 'merged', 'applied', '2026-07-14T12:00:00.000Z'),
      decision(p.id, 'rejected', 'rejected', '2026-07-14T12:10:00.000Z'),
    ];

    const priors = await computeOutcomePriors({ listProposals: () => [p] });

    expect(priors.global.todo).toMatchObject({ merged: 1, rejected: 0, acceptRate: 1 });
  });

  it('keeps a genuinely newer rejection terminal over older realized evidence', async () => {
    const p = realizedProposal('rejected-after-realization', '2026-07-14T12:05:00.000Z');
    decisions = [
      decision(p.id, 'merged', 'applied', '2026-07-14T12:00:00.000Z'),
      decision(p.id, 'rejected', 'rejected', '2026-07-14T12:10:00.000Z'),
    ];

    const priors = await computeOutcomePriors({ listProposals: () => [p] });

    expect(priors.global.todo).toMatchObject({ merged: 0, rejected: 1, acceptRate: 0 });
  });

  it('keeps Gate 7 ship predictions visible but grants no source credit after Gate 8 refusal', async () => {
    const proposals = Array.from({ length: 5 }, (_, index) => proposal(`gate8-refused-${index}`));
    decisions = proposals.flatMap((p) => [
      decision(p.id, 'judged', 'ship'),
      decision(p.id, 'merge-authorized'),
      decision(p.id, 'escalated'),
    ]);

    const priors = await computeOutcomePriors({ listProposals: () => proposals });
    const stats = priors.global.todo!;
    const item = {
      repo: proposals[0]!.repo,
      source: 'todo',
    } as WorkItem;

    expect(stats).toMatchObject({
      created: proposals.length,
      judged: proposals.length,
      shipCount: proposals.length,
      shipRate: 1,
      merged: 0,
      acceptRate: 0,
    });
    expect(scoreAdjustment(item, priors)).toBeLessThanOrEqual(1);
  });
});
