/**
 * m145.judge-calibration.test.ts — Judge calibration + self-health tests.
 *
 * Covers:
 *   1. cohenKappa — perfect agreement → 1.0; chance agreement → ~0; mixed
 *   2. cohenKappa — empty input → null; single category → graceful
 *   3. darkCurrent — computes verdict distribution + mean/std scores per engine
 *   4. darkCurrent — empty input → []; groups correctly by judgeEngine
 *   5. runDegradationHarness — mock judge catches corruptions → high recovery
 *   6. runDegradationHarness — mock judge misses corruptions → low recovery + flag
 *   7. runDegradationHarness — insufficient merged traces → sampleSize=0 + flag
 *   8. runDegradationHarness — never throws under any input
 *   9. judgeHealth — assembles kappa + dark-current + flags correctly
 *  10. judgeHealth — "insufficient traces" path when < MIN_TRACES
 *  11. judgeHealth — kappa flag when kappa < 0.20
 *  12. judgeHealth — dark-current rubber-stamp flag (>85% ship)
 *  13. judgeHealth — degradation path plumbed through judgeHealth opts
 *  14. judgeHealth — never throws on empty/corrupt traces
 *
 * Hermetic: HOME relocated to tmp dir; judgeProposal + readJudgeTraces are
 * always mocked — no live LLM calls, no real fs reads.
 *
 * Mirrors m141/m119 conventions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JudgeTrace } from '../src/core/fleet/judge-trace.js';
import type { ManagerVerdict } from '../src/core/fleet/manager.js';
import type { Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m145-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function pid(): string { return `p-m145-${_seq++}`; }

function makeTrace(overrides: Partial<JudgeTrace> = {}): JudgeTrace {
  return {
    proposalId: pid(),
    judgeEngine: 'test-engine',
    verdict: 'ship',
    scores: { value: 4, correctness: 4, scope: 2, alignment: 4 },
    fullReasoning: 'good change',
    promptContext: 'ctx',
    ts: new Date().toISOString(),
    ...overrides,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: pid(),
    repo: '/repos/test',
    origin: 'backlog',
    kind: 'patch',
    title: 'test proposal',
    summary: 'test summary',
    status: 'pending',
    createdAt: new Date().toISOString(),
    diff: '+const x = 1;\n+if (x < 2) { return x; }',
    ...overrides,
  } as Proposal;
}

/** Build a judge fn that always returns a given verdict/scores. */
function mockJudge(
  verdict: ManagerVerdict['verdict'],
  scores: { value: number; correctness: number; scope: number; alignment: number },
): (p: Proposal, cfg: never, client: never) => Promise<ManagerVerdict> {
  return vi.fn().mockResolvedValue({
    proposalId: 'mock',
    verdict,
    ...scores,
    rationale: 'mock',
    wouldMerge: false,
  } as ManagerVerdict);
}

// ---------------------------------------------------------------------------
// 1. cohenKappa — known matrices
// ---------------------------------------------------------------------------

describe('m145 cohenKappa — known agreement matrices', () => {
  it('returns 1.0 for perfect agreement', async () => {
    const { cohenKappa } = await import('../src/core/fleet/judge-calibration.js');
    const pairs = [
      { raterA: 'merge', raterB: 'merge' },
      { raterA: 'reject', raterB: 'reject' },
      { raterA: 'review', raterB: 'review' },
      { raterA: 'merge', raterB: 'merge' },
    ];
    const kappa = cohenKappa(pairs);
    expect(kappa).not.toBeNull();
    expect(kappa!).toBeCloseTo(1.0, 5);
  });

  it('returns ~0 for chance-level agreement (uniform distribution)', async () => {
    const { cohenKappa } = await import('../src/core/fleet/judge-calibration.js');
    // With equal distribution and no diagonal preference, kappa ≈ 0
    const pairs = [
      { raterA: 'merge', raterB: 'reject' },
      { raterA: 'reject', raterB: 'merge' },
      { raterA: 'review', raterB: 'merge' },
      { raterA: 'merge', raterB: 'review' },
    ];
    const kappa = cohenKappa(pairs);
    // Not null, should be near zero or negative (systematic disagreement)
    expect(kappa).not.toBeNull();
    expect(kappa!).toBeLessThan(0.2);
  });

  it('returns positive kappa for partial agreement', async () => {
    const { cohenKappa } = await import('../src/core/fleet/judge-calibration.js');
    const pairs = [
      { raterA: 'merge', raterB: 'merge' }, // agree
      { raterA: 'merge', raterB: 'merge' }, // agree
      { raterA: 'reject', raterB: 'reject' }, // agree
      { raterA: 'merge', raterB: 'reject' }, // disagree
    ];
    const kappa = cohenKappa(pairs);
    expect(kappa).not.toBeNull();
    expect(kappa!).toBeGreaterThan(0.0);
    expect(kappa!).toBeLessThan(1.0);
  });

  it('handles binary (two-class) pairs correctly', async () => {
    const { cohenKappa } = await import('../src/core/fleet/judge-calibration.js');
    // Perfect binary agreement
    const pairs = [
      { raterA: 'yes', raterB: 'yes' },
      { raterA: 'no',  raterB: 'no' },
      { raterA: 'yes', raterB: 'yes' },
      { raterA: 'no',  raterB: 'no' },
    ];
    const kappa = cohenKappa(pairs);
    expect(kappa).not.toBeNull();
    expect(kappa!).toBeCloseTo(1.0, 5);
  });

  it('returns null for empty pairs', async () => {
    const { cohenKappa } = await import('../src/core/fleet/judge-calibration.js');
    const kappa = cohenKappa([]);
    expect(kappa).toBeNull();
  });

  it('handles single category (all same) without throwing', async () => {
    const { cohenKappa } = await import('../src/core/fleet/judge-calibration.js');
    const pairs = [
      { raterA: 'merge', raterB: 'merge' },
      { raterA: 'merge', raterB: 'merge' },
    ];
    // degenerate: p_e = 1, should return 1.0 gracefully
    expect(() => cohenKappa(pairs)).not.toThrow();
    const kappa = cohenKappa(pairs);
    expect(kappa).not.toBeNull();
  });

  it('returns negative kappa for systematic disagreement', async () => {
    const { cohenKappa } = await import('../src/core/fleet/judge-calibration.js');
    const pairs = [
      { raterA: 'merge',  raterB: 'reject' },
      { raterA: 'reject', raterB: 'merge' },
      { raterA: 'merge',  raterB: 'reject' },
      { raterA: 'reject', raterB: 'merge' },
    ];
    const kappa = cohenKappa(pairs);
    expect(kappa).not.toBeNull();
    expect(kappa!).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. darkCurrent — baseline distribution
// ---------------------------------------------------------------------------

describe('m145 darkCurrent — baseline distribution', () => {
  it('returns empty array for empty traces', async () => {
    const { darkCurrent } = await import('../src/core/fleet/judge-calibration.js');
    expect(darkCurrent([])).toEqual([]);
  });

  it('computes verdict distribution correctly', async () => {
    const { darkCurrent } = await import('../src/core/fleet/judge-calibration.js');
    const traces: JudgeTrace[] = [
      makeTrace({ verdict: 'ship',   judgeEngine: 'e1' }),
      makeTrace({ verdict: 'ship',   judgeEngine: 'e1' }),
      makeTrace({ verdict: 'review', judgeEngine: 'e1' }),
      makeTrace({ verdict: 'noise',  judgeEngine: 'e1' }),
    ];
    const dc = darkCurrent(traces);
    expect(dc).toHaveLength(1);
    const e1 = dc[0]!;
    expect(e1.judgeEngine).toBe('e1');
    expect(e1.traceCount).toBe(4);
    expect(e1.verdictDistribution['ship']).toBeCloseTo(0.5);
    expect(e1.verdictDistribution['review']).toBeCloseTo(0.25);
    expect(e1.verdictDistribution['noise']).toBeCloseTo(0.25);
  });

  it('computes mean scores correctly', async () => {
    const { darkCurrent } = await import('../src/core/fleet/judge-calibration.js');
    const traces: JudgeTrace[] = [
      makeTrace({ scores: { value: 4, correctness: 5, scope: 2, alignment: 3 }, judgeEngine: 'e2' }),
      makeTrace({ scores: { value: 2, correctness: 3, scope: 4, alignment: 5 }, judgeEngine: 'e2' }),
    ];
    const dc = darkCurrent(traces);
    expect(dc).toHaveLength(1);
    const e2 = dc[0]!;
    expect(e2.meanScores.value).toBeCloseTo(3.0);
    expect(e2.meanScores.correctness).toBeCloseTo(4.0);
    expect(e2.meanScores.scope).toBeCloseTo(3.0);
    expect(e2.meanScores.alignment).toBeCloseTo(4.0);
  });

  it('groups correctly by judgeEngine — two engines produce two entries', async () => {
    const { darkCurrent } = await import('../src/core/fleet/judge-calibration.js');
    const traces: JudgeTrace[] = [
      makeTrace({ judgeEngine: 'alpha', verdict: 'ship' }),
      makeTrace({ judgeEngine: 'alpha', verdict: 'ship' }),
      makeTrace({ judgeEngine: 'beta',  verdict: 'noise' }),
    ];
    const dc = darkCurrent(traces);
    expect(dc).toHaveLength(2);
    const engines = dc.map((d) => d.judgeEngine).sort();
    expect(engines).toContain('alpha');
    expect(engines).toContain('beta');
  });

  it('computes std deviation (population) correctly', async () => {
    const { darkCurrent } = await import('../src/core/fleet/judge-calibration.js');
    const traces: JudgeTrace[] = [
      makeTrace({ scores: { value: 1, correctness: 3, scope: 2, alignment: 4 }, judgeEngine: 'e3' }),
      makeTrace({ scores: { value: 3, correctness: 3, scope: 2, alignment: 4 }, judgeEngine: 'e3' }),
      makeTrace({ scores: { value: 5, correctness: 3, scope: 2, alignment: 4 }, judgeEngine: 'e3' }),
    ];
    const dc = darkCurrent(traces);
    const e3 = dc.find((d) => d.judgeEngine === 'e3')!;
    // value: [1,3,5] → mean=3, variance=8/3, std≈1.633
    expect(e3.stdScores.value).toBeCloseTo(Math.sqrt(8 / 3), 2);
    // correctness: constant → std=0
    expect(e3.stdScores.correctness).toBeCloseTo(0, 5);
  });

  it('never throws on malformed trace input', async () => {
    const { darkCurrent } = await import('../src/core/fleet/judge-calibration.js');
    expect(() => darkCurrent(null as unknown as JudgeTrace[])).not.toThrow();
    expect(() => darkCurrent(undefined as unknown as JudgeTrace[])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. runDegradationHarness — judge CATCHES corruption → high recovery
// ---------------------------------------------------------------------------

describe('m145 runDegradationHarness — catching judge', () => {
  it('produces high recovery rate when judge scores corrupted diff lower', async () => {
    const { runDegradationHarness } = await import('../src/core/fleet/judge-calibration.js');

    const proposalId1 = pid();
    const proposalId2 = pid();
    const proposalId3 = pid();
    const proposalId4 = pid();
    const proposalId5 = pid();

    const mergedTraces: JudgeTrace[] = [
      makeTrace({ proposalId: proposalId1, verdict: 'ship', outcome: 'merged', scores: { value: 5, correctness: 5, scope: 2, alignment: 5 } }),
      makeTrace({ proposalId: proposalId2, verdict: 'ship', outcome: 'merged', scores: { value: 4, correctness: 4, scope: 2, alignment: 4 } }),
      makeTrace({ proposalId: proposalId3, verdict: 'ship', outcome: 'merged', scores: { value: 5, correctness: 4, scope: 2, alignment: 5 } }),
      makeTrace({ proposalId: proposalId4, verdict: 'ship', outcome: 'merged', scores: { value: 4, correctness: 5, scope: 2, alignment: 4 } }),
      makeTrace({ proposalId: proposalId5, verdict: 'ship', outcome: 'merged', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 } }),
    ];

    const proposals: Record<string, Proposal> = {
      [proposalId1]: makeProposal({ id: proposalId1 }),
      [proposalId2]: makeProposal({ id: proposalId2 }),
      [proposalId3]: makeProposal({ id: proposalId3 }),
      [proposalId4]: makeProposal({ id: proposalId4 }),
      [proposalId5]: makeProposal({ id: proposalId5 }),
    };

    // Catching judge: returns very low scores for any call
    const catchingJudge = mockJudge('harmful', { value: 1, correctness: 1, scope: 1, alignment: 1 });

    const result = await runDegradationHarness({} as never, {
      _readTracesFn: (f) => f?.outcomeOnly ? mergedTraces : mergedTraces,
      _loadProposalFn: (id) => proposals[id] ?? null,
      _judgeProposalFn: catchingJudge as never,
    });

    expect(result.sampleSize).toBeGreaterThanOrEqual(5);
    expect(result.recoveryRate).toBeGreaterThanOrEqual(0.8);
    expect(result.flags).not.toContain(expect.stringMatching(/recovery rate/));
    expect(result.trials.every((t) => t.caught)).toBe(true);
  });

  it('trial.caught is true when verdict escalates (ship → harmful)', async () => {
    const { runDegradationHarness } = await import('../src/core/fleet/judge-calibration.js');

    const ids = [pid(), pid(), pid(), pid(), pid()];
    const traces = ids.map((id) =>
      makeTrace({ proposalId: id, verdict: 'ship', outcome: 'merged', scores: { value: 3, correctness: 3, scope: 3, alignment: 3 } }),
    );
    const proposals = Object.fromEntries(ids.map((id) => [id, makeProposal({ id })]));

    // Judge escalates to harmful
    const escalatingJudge = mockJudge('harmful', { value: 2, correctness: 2, scope: 2, alignment: 2 });

    const result = await runDegradationHarness({} as never, {
      _readTracesFn: () => traces,
      _loadProposalFn: (id) => proposals[id] ?? null,
      _judgeProposalFn: escalatingJudge as never,
    });

    expect(result.recoveryRate).toBeGreaterThan(0);
    expect(result.trials.every((t) => t.caught)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. runDegradationHarness — judge MISSES corruption → low recovery + flag
// ---------------------------------------------------------------------------

describe('m145 runDegradationHarness — missing judge', () => {
  it('produces low recovery rate and a flag when judge does not score lower', async () => {
    const { runDegradationHarness } = await import('../src/core/fleet/judge-calibration.js');

    const ids = [pid(), pid(), pid(), pid(), pid()];
    const traces = ids.map((id) =>
      makeTrace({ proposalId: id, verdict: 'ship', outcome: 'merged', scores: { value: 4, correctness: 4, scope: 2, alignment: 4 } }),
    );
    const proposals = Object.fromEntries(ids.map((id) => [id, makeProposal({ id })]));

    // Rubber-stamp judge: always returns ship with the same high scores regardless of corruption
    const missingJudge = mockJudge('ship', { value: 4, correctness: 4, scope: 2, alignment: 4 });

    const result = await runDegradationHarness({} as never, {
      _readTracesFn: () => traces,
      _loadProposalFn: (id) => proposals[id] ?? null,
      _judgeProposalFn: missingJudge as never,
    });

    expect(result.sampleSize).toBeGreaterThanOrEqual(5);
    expect(result.recoveryRate).toBe(0); // same scores → none caught
    expect(result.flags.length).toBeGreaterThan(0);
    expect(result.flags.some((f) => f.includes('recovery rate'))).toBe(true);
  });

  it('adds critical flag when recovery rate < 30%', async () => {
    const { runDegradationHarness } = await import('../src/core/fleet/judge-calibration.js');

    const ids = [pid(), pid(), pid(), pid(), pid()];
    const traces = ids.map((id) =>
      makeTrace({ proposalId: id, verdict: 'ship', outcome: 'merged', scores: { value: 4, correctness: 4, scope: 2, alignment: 4 } }),
    );
    const proposals = Object.fromEntries(ids.map((id) => [id, makeProposal({ id })]));

    // No catch at all
    const blindJudge = mockJudge('ship', { value: 4, correctness: 4, scope: 2, alignment: 4 });

    const result = await runDegradationHarness({} as never, {
      _readTracesFn: () => traces,
      _loadProposalFn: (id) => proposals[id] ?? null,
      _judgeProposalFn: blindJudge as never,
    });

    // recovery 0% < 30%: both the general and critical flags should be set
    expect(result.flags.some((f) => f.includes('recovery rate'))).toBe(true);
    expect(result.flags.some((f) => f.includes('critical'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. runDegradationHarness — insufficient merged traces
// ---------------------------------------------------------------------------

describe('m145 runDegradationHarness — insufficient traces', () => {
  it('returns sampleSize=0 and flag when fewer than 5 merged traces', async () => {
    const { runDegradationHarness } = await import('../src/core/fleet/judge-calibration.js');

    const traces: JudgeTrace[] = [
      makeTrace({ outcome: 'merged' }),
      makeTrace({ outcome: 'merged' }),
    ];

    const result = await runDegradationHarness({} as never, {
      _readTracesFn: () => traces,
      _loadProposalFn: () => null,
      _judgeProposalFn: mockJudge('ship', { value: 4, correctness: 4, scope: 2, alignment: 4 }) as never,
    });

    expect(result.sampleSize).toBe(0);
    expect(result.flags.length).toBeGreaterThan(0);
    expect(result.recoveryRate).toBe(0);
  });

  it('returns sampleSize=0 and flag when no merged traces at all', async () => {
    const { runDegradationHarness } = await import('../src/core/fleet/judge-calibration.js');

    const result = await runDegradationHarness({} as never, {
      _readTracesFn: () => [],
      _loadProposalFn: () => null,
      _judgeProposalFn: mockJudge('ship', { value: 4, correctness: 4, scope: 2, alignment: 4 }) as never,
    });

    expect(result.sampleSize).toBe(0);
    expect(result.flags.length).toBeGreaterThan(0);
  });

  it('never throws even when judgeProposalFn throws', async () => {
    const { runDegradationHarness } = await import('../src/core/fleet/judge-calibration.js');

    const ids = [pid(), pid(), pid(), pid(), pid()];
    const traces = ids.map((id) =>
      makeTrace({ proposalId: id, outcome: 'merged' }),
    );
    const proposals = Object.fromEntries(ids.map((id) => [id, makeProposal({ id })]));

    const throwingJudge = vi.fn().mockRejectedValue(new Error('judge exploded'));

    await expect(
      runDegradationHarness({} as never, {
        _readTracesFn: () => traces,
        _loadProposalFn: (id) => proposals[id] ?? null,
        _judgeProposalFn: throwingJudge as never,
      }),
    ).resolves.not.toThrow();
  });

  it('never throws when loadProposalFn returns null for all proposals', async () => {
    const { runDegradationHarness } = await import('../src/core/fleet/judge-calibration.js');

    const ids = [pid(), pid(), pid(), pid(), pid()];
    const traces = ids.map((id) =>
      makeTrace({ proposalId: id, outcome: 'merged' }),
    );

    const result = await runDegradationHarness({} as never, {
      _readTracesFn: () => traces,
      _loadProposalFn: () => null,
      _judgeProposalFn: mockJudge('review', { value: 2, correctness: 2, scope: 2, alignment: 2 }) as never,
    });

    // No proposals found → no trials
    expect(result.sampleSize).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. judgeHealth — assembles the report
// ---------------------------------------------------------------------------

describe('m145 judgeHealth — assembles combined report', () => {
  it('assembles kappa + dark-current + sampleSize with sufficient traces', async () => {
    const { judgeHealth } = await import('../src/core/fleet/judge-calibration.js');

    const traces: JudgeTrace[] = [
      makeTrace({ verdict: 'ship',   outcome: 'merged',   judgeEngine: 'e1', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 } }),
      makeTrace({ verdict: 'ship',   outcome: 'merged',   judgeEngine: 'e1', scores: { value: 4, correctness: 4, scope: 2, alignment: 4 } }),
      makeTrace({ verdict: 'review', outcome: 'reverted', judgeEngine: 'e1', scores: { value: 3, correctness: 3, scope: 3, alignment: 3 } }),
      makeTrace({ verdict: 'noise',  outcome: 'rejected', judgeEngine: 'e1', scores: { value: 1, correctness: 1, scope: 1, alignment: 1 } }),
      makeTrace({ verdict: 'ship',   outcome: 'merged',   judgeEngine: 'e1', scores: { value: 5, correctness: 5, scope: 1, alignment: 5 } }),
    ];

    const report = await judgeHealth({} as never, {
      _readTracesFn: () => traces,
    });

    expect(report.sampleSize).toBe(5);
    expect(report.kappaVsOutcome).not.toBeNull();
    expect(typeof report.kappaVsOutcome).toBe('number');
    expect(report.darkCurrent).toHaveLength(1);
    expect(report.darkCurrent[0]!.judgeEngine).toBe('e1');
    expect(report.darkCurrent[0]!.traceCount).toBe(5);
    // Not running degradation by default
    expect(report.degradationRecoveryRate).toBeNull();
  });

  it('returns insufficient-traces report when < 5 traces', async () => {
    const { judgeHealth } = await import('../src/core/fleet/judge-calibration.js');

    const traces = [
      makeTrace(),
      makeTrace(),
      makeTrace(),
    ];

    const report = await judgeHealth({} as never, {
      _readTracesFn: () => traces,
    });

    expect(report.sampleSize).toBe(0);
    expect(report.kappaVsOutcome).toBeNull();
    expect(report.darkCurrent).toHaveLength(0);
    expect(report.flags.length).toBeGreaterThan(0);
    expect(report.flags[0]).toContain('insufficient traces');
  });

  it('emits kappa-low flag when kappa < 0.20', async () => {
    const { judgeHealth } = await import('../src/core/fleet/judge-calibration.js');

    // All verdicts = ship but all outcomes = rejected → kappa very negative/low
    const traces: JudgeTrace[] = Array.from({ length: 6 }, () =>
      makeTrace({ verdict: 'ship', outcome: 'rejected' }),
    );

    const report = await judgeHealth({} as never, {
      _readTracesFn: () => traces,
    });

    expect(report.flags.some((f) => f.includes('kappa'))).toBe(true);
  });

  it('emits rubber-stamp flag when >85% ship rate', async () => {
    const { judgeHealth } = await import('../src/core/fleet/judge-calibration.js');

    // 9 ship + 1 noise — engine has >85% ship rate
    const traces: JudgeTrace[] = [
      ...Array.from({ length: 9 }, () => makeTrace({ verdict: 'ship', judgeEngine: 'e-stamp' })),
      makeTrace({ verdict: 'noise', judgeEngine: 'e-stamp' }),
    ];

    const report = await judgeHealth({} as never, {
      _readTracesFn: () => traces,
    });

    expect(report.flags.some((f) => f.includes('rubber-stamp'))).toBe(true);
  });

  it('plumbs degradation harness through opts.runDegradation', async () => {
    const { judgeHealth } = await import('../src/core/fleet/judge-calibration.js');

    const ids = [pid(), pid(), pid(), pid(), pid(), pid()];
    const traces = ids.map((id) =>
      makeTrace({ proposalId: id, verdict: 'ship', outcome: 'merged', scores: { value: 4, correctness: 4, scope: 2, alignment: 4 } }),
    );
    const proposals = Object.fromEntries(ids.map((id) => [id, makeProposal({ id })]));

    // Catching judge — score drops a lot
    const catchingJudge = mockJudge('harmful', { value: 1, correctness: 1, scope: 1, alignment: 1 });

    const report = await judgeHealth({} as never, {
      runDegradation: true,
      _readTracesFn: () => traces,
      _loadProposalFn: (id) => proposals[id] ?? null,
      _judgeProposalFn: catchingJudge as never,
    });

    expect(report.degradationRecoveryRate).not.toBeNull();
    expect(report.degradationRecoveryRate!).toBeGreaterThan(0.5);
  });

  it('never throws with empty traces', async () => {
    const { judgeHealth } = await import('../src/core/fleet/judge-calibration.js');
    await expect(judgeHealth({} as never, { _readTracesFn: () => [] })).resolves.not.toThrow();
  });

  it('never throws with null/undefined _readTracesFn result', async () => {
    const { judgeHealth } = await import('../src/core/fleet/judge-calibration.js');
    // Simulate _readTracesFn returning garbage
    const badFn = () => null as unknown as JudgeTrace[];
    await expect(judgeHealth({} as never, { _readTracesFn: badFn })).resolves.not.toThrow();
  });
});
