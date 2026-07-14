/**
 * m335.model-stats.test.ts — M335: the joined per-model stats behind the
 * dashboard Models tab.
 *
 * Covers:
 *  - the three-stream join: ROI (M322) + real-world outcomes (M332, producer
 *    join) + best-of-N participation (M333);
 *  - race-only models stay visible (zero-filled ROI) — a model that keeps
 *    LOSING races must not vanish from the tab;
 *  - sort by dispatches desc; cold start → [].
 */

import { describe, it, expect, vi } from 'vitest';

const NOW = Date.now();
const HOUR = 3_600_000;
const ts = (h: number) => new Date(NOW - h * HOUR).toISOString();

function realizedMergeEvidence(observedAt: string) {
  return {
    schemaVersion: 1 as const,
    source: 'local-default-branch' as const,
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    mergeCommitOid: '3'.repeat(40),
    observedAt,
  };
}

let ledger: Record<string, unknown>[] = [];
let traces: Record<string, unknown>[] = [];
let bonRecords: Record<string, unknown>[] = [];
let bonQuality: Record<string, unknown> | undefined;
let proposals: Record<string, unknown>[] = [];

function completeSource<T>(rows: T[]): T[] {
  Object.defineProperty(rows, 'sourceQuality', {
    value: {
      sourceState: 'healthy', sourcePresent: rows.length > 0, complete: true,
      stopReasons: [], filesRead: rows.length > 0 ? 1 : 0, bytesRead: 0,
      rowsScanned: rows.length, invalidRows: 0, unreadableFiles: 0,
    },
    configurable: true,
    enumerable: false,
  });
  return rows;
}

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn(() => completeSource(ledger)),
  recordDecision: vi.fn(() => {}),
}));
vi.mock('../src/core/fleet/judge-trace.js', () => ({
  readJudgeTraces: vi.fn(() => completeSource(traces)),
  linkOutcome: vi.fn(() => {}),
}));
vi.mock('../src/core/fleet/best-of-n-ledger.js', () => ({
  readBestOfNRecords: vi.fn(() => {
    completeSource(bonRecords);
    if (bonQuality) Object.defineProperty(bonRecords, 'sourceQuality', {
      value: bonQuality,
      configurable: true,
      enumerable: false,
    });
    return bonRecords;
  }),
  recordBestOfN: vi.fn(() => {}),
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
vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: vi.fn(() => proposals),
  listProposalsDetailed: vi.fn(() => ({
    proposals,
    sourceState: proposals.length > 0 ? 'healthy' : 'missing',
    sourcePresent: proposals.length > 0,
    complete: true,
    stopReasons: [],
    filesDiscovered: proposals.length,
    filesRead: proposals.length,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
  })),
  loadProposal: vi.fn(() => null),
}));

import { computeModelStats, computeModelStatsDetailed } from '../src/core/fleet/model-stats.js';

function seed(): void {
  bonQuality = undefined;
  proposals = [
    {
      id: 'p1', repo: '/r', status: 'applied', createdAt: ts(3),
      workItemId: '/r:issue:p1', workSource: 'issue',
      engineModel: 'claude:claude-sonnet-5', engineTier: 'frontier',
      diffHash: '1'.repeat(64), provenanceSig: 'test-provenance',
      producerProvenanceVersion: 2, producerProvenanceSig: 'test-producer-provenance',
      realizedMerge: realizedMergeEvidence(ts(1)),
    },
    {
      id: 'p2', repo: '/r', status: 'pending', createdAt: ts(4),
      workItemId: '/r:issue:p2', workSource: 'issue',
      engineModel: 'claude:sonnet-5', engineTier: 'frontier',
      diffHash: '2'.repeat(64), provenanceSig: 'test-provenance',
      producerProvenanceVersion: 2, producerProvenanceSig: 'test-producer-provenance',
    },
    {
      id: 'p3', repo: '/r', status: 'pending', createdAt: ts(5),
      workItemId: '/r:issue:p3', workSource: 'issue',
      engineModel: 'claude:claude-opus-4-8', engineTier: 'frontier',
      diffHash: '3'.repeat(64), provenanceSig: 'test-provenance',
      producerProvenanceVersion: 2, producerProvenanceSig: 'test-producer-provenance',
    },
  ];
  ledger = [
    // sonnet-5: 2 dispatches, judged ship + merged on p1
    { ts: ts(1), proposalId: 'p1', action: 'merged', labelBasis: 'realized-merge-v1', engine: 'claude', model: 'claude:claude-sonnet-5' },
    { ts: ts(2), proposalId: 'p1', action: 'judged', engine: 'claude-fable-5', model: 'claude-fable-5', verdict: 'ship', costUsd: 0.2 },
    { ts: ts(3), proposalId: 'p1', action: 'proposed', engine: 'claude', model: 'claude:claude-sonnet-5', costUsd: 1.0, tokensIn: 1000, tokensOut: 200, durationMs: 60_000 },
    { ts: ts(4), proposalId: 'p2', action: 'proposed', engine: 'claude', model: 'sonnet-5', costUsd: 0.8 },
    // opus: 1 dispatch
    { ts: ts(5), proposalId: 'p3', action: 'proposed', engine: 'claude', model: 'claude:claude-opus-4-8', costUsd: 2.0 },
  ];
  traces = [
    // p1's merge was later reverted in the real world
    { proposalId: 'p1', judgeEngine: 'claude-fable-5', verdict: 'ship', scores: { value: 4, correctness: 4, scope: 4, alignment: 4 }, fullReasoning: '', promptContext: '', ts: ts(1), outcome: 'reverted', outcomeAt: ts(0.5) },
  ];
  bonRecords = [
    {
      ts: ts(2), source: 'issue', repo: '/r', n: 2, winnerIndex: 0, winnerProposalId: 'p1', totalCostUsd: 1.0,
      candidates: [
        { index: 0, engine: 'claude', model: 'claude-sonnet-5', score: 16, proposalId: 'p1', won: true },
        // race-only loser — never a solo 'proposed' dispatch under this key
        { index: 1, engine: 'local-coder', model: 'qwen3-coder-next', score: 8, proposalId: null, proposalOutcome: 'proposal-disabled', won: false },
      ],
    },
  ];
}

describe('M335 computeModelStats', () => {
  it('joins ROI + outcomes + best-of-N onto canonical keys', () => {
    seed();
    const stats = computeModelStats('all');
    const s5 = stats.find((s) => s.engineModel === 'claude:sonnet-5');
    expect(s5).toBeDefined();
    expect(s5!.dispatches).toBe(2); // both spellings collapsed
    expect(s5!.merged).toBe(1);
    expect(s5!.judgeCostUsd).toBeCloseTo(0.2, 5);
    expect(s5!.outcomes.reverted).toBe(1); // producer join, not the judge's key
    expect(s5!.bestOfN).toEqual({ entered: 1, won: 1, winRate: 1 });
    expect(s5!.bestOfNAvailable).toBe(true);
    // the judge model never appears as a producer row
    expect(stats.some((s) => s.engineModel.includes('fable'))).toBe(false);
  });

  it('race-only losers stay visible with zero-filled ROI', () => {
    seed();
    const loser = computeModelStats('all').find(
      (s) => s.engineModel === 'local-coder:qwen3-coder-next',
    );
    expect(loser).toBeDefined();
    expect(loser!.dispatches).toBe(0);
    expect(loser!.bestOfN).toEqual({ entered: 1, won: 0, winRate: 0 });
  });

  it('sorts by dispatches desc', () => {
    seed();
    const stats = computeModelStats('all');
    expect(stats[0]!.engineModel).toBe('claude:sonnet-5');
    const idxOpus = stats.findIndex((s) => s.engineModel === 'claude:opus');
    const idxLoser = stats.findIndex((s) => s.engineModel === 'local-coder:qwen3-coder-next');
    expect(idxOpus).toBeGreaterThan(0);
    expect(idxLoser).toBeGreaterThan(idxOpus);
  });

  it('cold start → []', () => {
    ledger = [];
    traces = [];
    bonRecords = [];
    expect(computeModelStats('30d')).toEqual([]);
  });

  it('withholds Best-of-N rates while preserving independent ROI when the source is degraded', () => {
    seed();
    bonQuality = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['row-limit'], filesRead: 1, bytesRead: 100,
      rowsScanned: 1, invalidRows: 0, unreadableFiles: 0,
    };

    const result = computeModelStatsDetailed('all');
    const producer = result.models.find((s) => s.engineModel === 'claude:sonnet-5');
    expect(producer?.dispatches).toBe(2);
    expect(producer?.bestOfN).toEqual({ entered: 0, won: 0, winRate: 0 });
    expect(producer?.bestOfNAvailable).toBe(false);
    expect(result.models.some((s) => s.engineModel === 'local-coder:qwen3-coder-next')).toBe(false);
    expect(result.bestOfNSource).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['row-limit'],
    });
  });
});
