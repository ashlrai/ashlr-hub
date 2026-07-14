/**
 * m322.model-roi.test.ts — M322: per-model ROI rollup from the decisions ledger.
 *
 * Covers:
 *  - producer aggregation from 'proposed' entries (dispatches/tokens/cost/latency);
 *  - verdict + outcome attribution JOINED to the producer by proposalId
 *    (a judged entry carries the JUDGE's model — attribution must not key on it);
 *  - judge spend accumulated onto the producer's ROI;
 *  - canonical-key collapse of ledger spelling variants
 *    ('claude:claude-sonnet-5' + 'sonnet-5' → one 'claude:sonnet-5' key);
 *  - shipRate / costPerMergedUsd math and null-safety;
 *  - cold start (empty ledger) → {}.
 *
 * Mirrors m246 conventions: vi.mock the decisions ledger with a fixture array.
 */

import { describe, it, expect, vi } from 'vitest';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const ts = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

// newest-first, like the real readDecisions
const FIXTURE: Record<string, unknown>[] = [
  // ── outcomes / verdicts (chronologically after the proposals) ──────────
  // M337: a manager-gated auto-merge writes TWO 'merged' entries per proposal
  // (gate-7 record + setStatus record) — the ROI must count it ONCE.
  { ts: ts(0.9), proposalId: 'p-s5-a', action: 'merged', labelBasis: 'realized-merge-v1', engine: 'claude', model: 'claude:claude-sonnet-5' },
  { ts: ts(1), proposalId: 'p-s5-a', action: 'merged', labelBasis: 'realized-merge-v1', engine: 'claude', model: 'claude:claude-sonnet-5' },
  {
    ts: ts(2), proposalId: 'p-s5-a', action: 'judged',
    // judge ran on Fable — must be attributed to the PRODUCER (sonnet-5)
    engine: 'claude-fable-5', model: 'claude-fable-5',
    verdict: 'ship', costUsd: 0.30,
  },
  {
    ts: ts(2), proposalId: 'p-s5-b', action: 'judged',
    engine: 'claude-fable-5', model: 'claude-fable-5',
    verdict: 'review', costUsd: 0.20,
  },
  { ts: ts(1), proposalId: 'p-opus-a', action: 'rejected', engine: 'claude', model: 'claude:claude-opus-4-8' },
  {
    ts: ts(2), proposalId: 'p-opus-a', action: 'judged',
    engine: 'claude-fable-5', model: 'claude-fable-5',
    verdict: 'reject', costUsd: 0.25,
  },
  // judged entry for an UNKNOWN proposal (no producer) — must be ignored
  {
    ts: ts(2), proposalId: 'p-ghost', action: 'judged',
    engine: 'claude-fable-5', model: 'claude-fable-5', verdict: 'ship', costUsd: 9.99,
  },
  // ── producers ───────────────────────────────────────────────────────────
  {
    ts: ts(5), proposalId: 'p-s5-a', action: 'proposed',
    engine: 'claude', model: 'claude:claude-sonnet-5',
    costUsd: 0.50, tokensIn: 10_000, tokensOut: 2_000, durationMs: 120_000,
  },
  {
    // spelling variant of the SAME model — must land on the same key
    ts: ts(6), proposalId: 'p-s5-b', action: 'proposed',
    engine: 'claude', model: 'sonnet-5',
    costUsd: 0.70, tokensIn: 14_000, tokensOut: 3_000, durationMs: 180_000,
  },
  {
    ts: ts(7), proposalId: 'p-opus-a', action: 'proposed',
    engine: 'claude', model: 'claude:claude-opus-4-8',
    costUsd: 2.00, tokensIn: 12_000, tokensOut: 2_500, durationMs: 300_000,
  },
  {
    // free local producer, never judged
    ts: ts(8), proposalId: 'p-local-a', action: 'proposed',
    engine: 'local-coder', model: 'qwen2.5-coder:32b',
    costUsd: 0, tokensIn: 8_000, tokensOut: 1_500,
  },
];

let fixture: Record<string, unknown>[] = FIXTURE;
let proposals: Record<string, unknown>[] = [{
  id: 'p-s5-a',
  status: 'applied',
  realizedMerge: {
    schemaVersion: 1,
    source: 'local-default-branch',
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    mergeCommitOid: '3'.repeat(40),
    observedAt: ts(0.8),
  },
}];

vi.mock('../src/core/foundry/provenance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/foundry/provenance.js')>();
  return {
    ...real,
    verifyProducerProvenanceV2: (proposal: { producerProvenanceSig?: string }) => ({
      ok: proposal.producerProvenanceSig === 'test-producer-provenance',
    }),
  };
});

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn((opts?: { sinceMs?: number }) => {
    const since = opts?.sinceMs ?? 0;
    return fixture.filter((d) => Date.parse(String(d['ts'])) >= since);
  }),
  recordDecision: vi.fn(() => {}),
}));

// quality-metrics also imports the inbox store at module load — keep it inert.
vi.mock('../src/core/inbox/store.js', () => {
  const rows = () => {
    const byId = new Map(proposals.map((proposal) => [String(proposal['id']), proposal]));
    for (const entry of fixture) {
      if (entry['action'] !== 'proposed' || typeof entry['engine'] !== 'string') continue;
      const id = String(entry['proposalId']);
      const existing = byId.get(id) ?? {};
      const engine = String(entry['engine']);
      const model = String(entry['model'] ?? '');
      byId.set(id, {
        ...existing,
        id,
        repo: '/mock/repo',
        workItemId: `/mock/repo:issue:${id}`,
        workSource: 'issue',
        engineModel: model.startsWith(`${engine}:`) ? model : `${engine}:${model}`,
        engineTier: engine === 'local-coder' ? 'mid' : 'frontier',
        diff: 'diff --git a/a b/a',
        diffHash: 'd'.repeat(64),
        provenanceSig: 'test-provenance',
        producerProvenanceVersion: 2,
        producerProvenanceSig: 'test-producer-provenance',
      });
    }
    return [...byId.values()];
  };
  return {
  listProposals: vi.fn(() => rows()),
  listProposalsDetailed: vi.fn(() => {
    const proposalRows = rows();
    return {
    proposals: proposalRows,
    sourceState: proposalRows.length > 0 ? 'healthy' : 'missing',
    sourcePresent: proposalRows.length > 0,
    complete: true,
    stopReasons: [],
    filesDiscovered: proposalRows.length,
    filesRead: proposalRows.length,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
  };}),
};});

import { computeModelRoi } from '../src/core/fleet/quality-metrics.js';

describe('M322 computeModelRoi', () => {
  it('collapses spelling variants onto one canonical key', () => {
    const roi = computeModelRoi('all');
    expect(Object.keys(roi)).toContain('claude:sonnet-5');
    expect(Object.keys(roi)).toContain('claude:opus');
    expect(Object.keys(roi)).toContain('local-coder:qwen2.5-coder:32b');
    // no doubled key survives
    expect(Object.keys(roi).some((k) => k.includes('claude:claude-'))).toBe(false);
  });

  it('aggregates producer dispatches, tokens, cost, latency', () => {
    const s5 = computeModelRoi('all')['claude:sonnet-5']!;
    expect(s5.dispatches).toBe(2);
    expect(s5.tokensIn).toBe(24_000);
    expect(s5.tokensOut).toBe(5_000);
    expect(s5.costUsd).toBeCloseTo(1.2, 5);
    expect(s5.avgLatencyMs).toBe(150_000);
  });

  it('joins verdicts to the PRODUCER, not the judge model', () => {
    const roi = computeModelRoi('all');
    const s5 = roi['claude:sonnet-5']!;
    expect(s5.judged).toBe(2);
    expect(s5.shipVerdicts).toBe(1);
    expect(s5.shipRate).toBeCloseTo(0.5, 5);
    // M337: the fixture carries a DUPLICATE 'merged' entry for p-s5-a — the
    // manager-gate double-record must count once per proposal.
    expect(s5.merged).toBe(1);
    // the judge's own model never becomes a producer key
    expect(roi['claude-fable-5:claude-fable-5']).toBeUndefined();
    expect(roi['claude:fable-5']).toBeUndefined();
  });

  it('accumulates judge spend onto the producer ROI', () => {
    const roi = computeModelRoi('all');
    expect(roi['claude:sonnet-5']!.judgeCostUsd).toBeCloseTo(0.5, 5);
    expect(roi['claude:opus']!.judgeCostUsd).toBeCloseTo(0.25, 5);
  });

  it('costPerMergedUsd = (producer + judge spend) / merged; null when 0 merged', () => {
    const roi = computeModelRoi('all');
    expect(roi['claude:sonnet-5']!.costPerMergedUsd).toBeCloseTo(1.7, 5);
    expect(roi['claude:opus']!.merged).toBe(0);
    expect(roi['claude:opus']!.costPerMergedUsd).toBeNull();
    expect(roi['claude:opus']!.rejected).toBe(1);
  });

  it('M338: a proposal with BOTH merged and rejected entries counts once, newest wins', () => {
    const flip: Record<string, unknown>[] = [
      // newest-first: the rejection is the proposal's actual final state
      // (gate-7 wrote a stale 'merged' before Gate 8 refused).
      { ts: ts(0.4), proposalId: 'p-flip', action: 'rejected', engine: 'claude', model: 'claude:claude-sonnet-5' },
      { ts: ts(0.6), proposalId: 'p-flip', action: 'merged', engine: 'claude', model: 'claude:claude-sonnet-5' },
      { ts: ts(5.5), proposalId: 'p-flip', action: 'proposed', engine: 'claude', model: 'claude:claude-sonnet-5', costUsd: 0.1 },
    ];
    fixture = [...flip, ...FIXTURE];
    try {
      const s5 = computeModelRoi('all')['claude:sonnet-5']!;
      // p-s5-a merged once (dedup) + p-flip must NOT add a merged…
      expect(s5.merged).toBe(1);
      // …it lands in rejected exactly once instead.
      expect(s5.rejected).toBe(1);
    } finally {
      fixture = FIXTURE;
    }
  });

  it('never-judged local producer: shipRate 0, latency null when unrecorded', () => {
    const local = computeModelRoi('all')['local-coder:qwen2.5-coder:32b']!;
    expect(local.dispatches).toBe(1);
    expect(local.judged).toBe(0);
    expect(local.shipRate).toBe(0);
    expect(local.avgLatencyMs).toBeNull();
    expect(local.costPerMergedUsd).toBeNull();
  });

  it('ignores verdicts whose producer is unknown (no phantom keys)', () => {
    const roi = computeModelRoi('all');
    const totalJudged = Object.values(roi).reduce((s, r) => s + r.judged, 0);
    expect(totalJudged).toBe(3); // p-ghost's judged entry dropped
  });

  it('window filter excludes older entries', () => {
    // Only entries within the last 7 days pass — all fixtures are hours old,
    // so 7d === all here; verify the sinceMs path executes without throwing.
    const roi7 = computeModelRoi('7d');
    expect(roi7['claude:sonnet-5']!.dispatches).toBe(2);
  });

  it('uses witness time for merge ROI windows', () => {
    const proposalId = 'p-windowed-witness';
    fixture = [
      {
        ts: ts(24 * 10),
        proposalId,
        action: 'merged',
        labelBasis: 'realized-merge-v1',
      },
      {
        ts: ts(24 * 10 + 1),
        proposalId,
        action: 'proposed',
        engine: 'claude',
        model: 'claude:claude-sonnet-5',
      },
    ];
    proposals = [{
      id: proposalId,
      status: 'applied',
      realizedMerge: {
        schemaVersion: 1,
        source: 'local-default-branch',
        base: 'main',
        baseBeforeOid: '1'.repeat(40),
        proposalHeadOid: '2'.repeat(40),
        mergeCommitOid: '3'.repeat(40),
        observedAt: ts(1),
      },
    }];
    try {
      expect(computeModelRoi('7d')['claude:sonnet-5']).toMatchObject({
        dispatches: 0,
        merged: 1,
      });

      const proposal = proposals[0]!;
      const evidence = proposal['realizedMerge'] as Record<string, unknown>;
      evidence['observedAt'] = ts(24 * 10);
      expect(computeModelRoi('7d')).toEqual({});
    } finally {
      fixture = FIXTURE;
      proposals = [{
        id: 'p-s5-a',
        status: 'applied',
        realizedMerge: {
          schemaVersion: 1,
          source: 'local-default-branch',
          base: 'main',
          baseBeforeOid: '1'.repeat(40),
          proposalHeadOid: '2'.repeat(40),
          mergeCommitOid: '3'.repeat(40),
          observedAt: ts(0.8),
        },
      }];
    }
  });

  it('cold start (empty ledger) → {}', () => {
    fixture = [];
    try {
      expect(computeModelRoi('all')).toEqual({});
    } finally {
      fixture = FIXTURE;
    }
  });

  it('ignores a bare historical merged row without a realized witness', () => {
    proposals = [];
    try {
      expect(computeModelRoi('all')['claude:sonnet-5']!.merged).toBe(0);
    } finally {
      proposals = [{
        id: 'p-s5-a',
        status: 'applied',
        realizedMerge: {
          schemaVersion: 1,
          source: 'local-default-branch',
          base: 'main',
          baseBeforeOid: '1'.repeat(40),
          proposalHeadOid: '2'.repeat(40),
          mergeCommitOid: '3'.repeat(40),
          observedAt: ts(0.8),
        },
      }];
    }
  });

  it('ignores a legacy merged row even when the proposal has a current witness', () => {
    fixture = FIXTURE.map((entry) => entry['action'] === 'merged'
      ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'labelBasis'))
      : entry);
    try {
      expect(computeModelRoi('all')['claude:sonnet-5']!.merged).toBe(0);
    } finally {
      fixture = FIXTURE;
    }
  });
});
