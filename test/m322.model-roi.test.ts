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
  { ts: ts(1), proposalId: 'p-s5-a', action: 'merged', engine: 'claude', model: 'claude:claude-sonnet-5' },
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

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn((opts?: { sinceMs?: number }) => {
    const since = opts?.sinceMs ?? 0;
    return fixture.filter((d) => Date.parse(String(d['ts'])) >= since);
  }),
  recordDecision: vi.fn(() => {}),
}));

// quality-metrics also imports the inbox store at module load — keep it inert.
vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: vi.fn(() => []),
}));

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

  it('cold start (empty ledger) → {}', () => {
    fixture = [];
    try {
      expect(computeModelRoi('all')).toEqual({});
    } finally {
      fixture = FIXTURE;
    }
  });
});
