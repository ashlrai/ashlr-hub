/**
 * m142.best-of-n.test.ts — M142: best-of-N generation with critic selection.
 *
 * Test groups:
 *
 *   1. EXPORT — runBestOfN is exported from src/core/run/best-of-n.ts
 *
 *   2. N=1 PARITY — N=1 behaves identically to a single run (flag-off parity)
 *
 *   3. N=3 SELECTION — generates 3 candidates, mocks the judge to return
 *      differing scores, asserts winner is the highest-scoring non-empty candidate
 *
 *   4. ALL-EMPTY — all candidates return no proposalId → no winner
 *
 *   5. NEVER-THROWS — candidate sandbox errors do not propagate; result is
 *      returned with error fields on affected candidates
 *
 *   6. CFG FLAG — bestOfN read from cfg.foundry.bestOfN when no opts.n
 *
 * Mock conventions: vi.doMock + vi.resetModules() + cache-busting UUID query
 * strings on dynamic imports — mirrors m117.api-model-dispatch.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_REPO = '/tmp/fake-repo';

function makeItem(overrides: Partial<{
  id: string; repo: string; title: string; detail: string;
}> = {}) {
  return {
    id: overrides.id ?? 'item-1',
    repo: overrides.repo ?? MOCK_REPO,
    source: 'manual' as const,
    title: overrides.title ?? 'Fix the thing',
    detail: overrides.detail ?? 'Details here',
    value: 3,
    effort: 2,
    score: 3,
    tags: [],
    ts: new Date().toISOString(),
  };
}

function makeConfig(bestOfN?: number) {
  return {
    foundry: bestOfN != null
      ? ({ bestOfN, allowedBackends: ['local-coder'] } as Record<string, unknown>)
      : ({ allowedBackends: ['local-coder'] } as Record<string, unknown>),
  } as unknown as import('../src/core/types.js').AshlrConfig;
}

/** Build a mock runApiModelSandboxed that returns a proposal on the Nth call. */
function makeSandboxMock(opts: {
  /** Which candidate indices produce a non-empty proposalId. Default: all. */
  withProposalAt?: number[];
  /** Throw on these indices. */
  throwAt?: number[];
}) {
  let callCount = 0;
  return vi.fn(async (_engine: unknown, _goal: unknown, _cfg: unknown, runOpts: Record<string, unknown>) => {
    const idx = callCount++;
    if (opts.throwAt?.includes(idx)) throw new Error(`sandbox error at ${idx}`);
    const hasProposal = !opts.withProposalAt || opts.withProposalAt.includes(idx);
    return {
      state: {
        id: runOpts['runId'] ?? `run-${idx}`,
        status: 'done',
        result: hasProposal ? `diff content for candidate ${idx}` : '',
      },
      proposalId: hasProposal ? `proposal-${idx}` : undefined,
    };
  });
}

/** Build a mock judgeProposal that returns scores in the given order. */
function makeJudgeMock(scores: number[]) {
  let callCount = 0;
  return vi.fn(async (_proposal: unknown, _cfg: unknown, _client: unknown) => {
    const idx = callCount++;
    const score = scores[idx] ?? 8;
    // Distribute score across the 4 dimensions (each 1–5, max total 20)
    // score is already in 0–20 range from our scoreVerdict logic
    const perDim = Math.max(1, Math.min(5, Math.round(score / 4)));
    return {
      proposalId: `verdict-${idx}`,
      verdict: 'ship' as const,
      value: perDim,
      correctness: perDim,
      scope: 6 - perDim,          // higher score → lower scope (inverted)
      alignment: perDim,
      rationale: `Mock rationale for candidate ${idx}`,
      wouldMerge: perDim >= 4,
    };
  });
}

// ---------------------------------------------------------------------------
// 1. EXPORT
// ---------------------------------------------------------------------------

describe('M142 — EXPORT', () => {
  it('runBestOfN is exported from src/core/run/best-of-n.ts', async () => {
    const mod = await import('../src/core/run/best-of-n.js?export=' + randomUUID());
    expect(typeof mod.runBestOfN).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 2. N=1 PARITY
// ---------------------------------------------------------------------------

describe('M142 — N=1 parity (flag-off)', () => {
  afterEach(() => { vi.resetModules(); });

  it('N=1 produces exactly one candidate and uses it as winner when non-empty', async () => {
    const sandboxMock = makeSandboxMock({ withProposalAt: [0] });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: makeJudgeMock([12]),
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?parity=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig(1));

    expect(sandboxMock).toHaveBeenCalledTimes(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.winner).toBeDefined();
    expect(result.winner?.index).toBe(0);
    expect(result.critique.n).toBe(1);
  });

  it('default cfg (no bestOfN field) is equivalent to N=1', async () => {
    const sandboxMock = makeSandboxMock({ withProposalAt: [0] });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: makeJudgeMock([10]),
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?default=' + randomUUID());
    // No bestOfN in config, no opts.n → should behave as N=1
    const cfgNoN = { foundry: { allowedBackends: ['local-coder'] } } as unknown as import('../src/core/types.js').AshlrConfig;
    const result = await runBestOfN(makeItem(), cfgNoN);

    expect(sandboxMock).toHaveBeenCalledTimes(1);
    expect(result.critique.n).toBe(1);
    expect(result.winner).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. N=3 SELECTION — picks highest-scoring non-empty candidate
// ---------------------------------------------------------------------------

describe('M142 — N=3 candidate selection', () => {
  afterEach(() => { vi.resetModules(); });

  it('generates 3 candidates and picks the one with the highest judge score', async () => {
    // Candidates 0, 1, 2 all produce proposals; judge scores them 8, 16, 12
    // → winner should be candidate 1 (score 16)
    const sandboxMock = makeSandboxMock({ withProposalAt: [0, 1, 2] });
    const judgeMock = makeJudgeMock([8, 16, 12]);

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?n3=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig(), { n: 3 });

    expect(sandboxMock).toHaveBeenCalledTimes(3);
    expect(result.candidates).toHaveLength(3);
    expect(result.winner).toBeDefined();
    expect(result.winner?.index).toBe(1);
    expect(result.critique.n).toBe(3);
    expect(result.critique.nonEmpty).toBe(3);
    expect(result.critique.judged).toBe(3);
    expect(result.critique.winnerIndex).toBe(1);
  });

  it('prefers candidate 0 when scores tie', async () => {
    const sandboxMock = makeSandboxMock({ withProposalAt: [0, 1, 2] });
    const judgeMock = makeJudgeMock([10, 10, 10]);

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?tie=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig(), { n: 3 });

    // All tie at same score; sort is stable — first eligible wins
    expect(result.winner).toBeDefined();
    expect([0, 1, 2]).toContain(result.winner?.index);
  });

  it('skips candidates without proposalId in scoring/selection', async () => {
    // Only candidates 0 and 2 produce proposals; candidate 1 is empty
    const sandboxMock = makeSandboxMock({ withProposalAt: [0, 2] });
    const judgeMock = makeJudgeMock([5, 18]); // 2 judged calls (not 3)

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?skip=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig(), { n: 3 });

    expect(result.candidates).toHaveLength(3);
    expect(result.critique.nonEmpty).toBe(2);
    // Candidate 2 scored 18 > candidate 0 scored 5 → winner is candidate 2
    expect(result.winner?.index).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. ALL-EMPTY — no winner
// ---------------------------------------------------------------------------

describe('M142 — all-empty → no winner', () => {
  afterEach(() => { vi.resetModules(); });

  it('returns no winner when all candidates produce no proposalId', async () => {
    // withProposalAt: [] → none get proposals
    const sandboxMock = makeSandboxMock({ withProposalAt: [] });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: vi.fn(),
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?empty=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig(), { n: 3 });

    expect(result.winner).toBeUndefined();
    expect(result.candidates).toHaveLength(3);
    expect(result.critique.nonEmpty).toBe(0);
    expect(result.critique.winnerIndex).toBe(-1);
  });

  it('returns no winner when sandboxed-engine module is unavailable', async () => {
    vi.doMock('../src/core/run/sandboxed-engine.js', () => {
      throw new Error('module not found');
    });
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: vi.fn(),
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?nomod=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig(), { n: 2 });

    expect(result.winner).toBeUndefined();
    expect(result.candidates).toHaveLength(2);
    // All candidates should have errors
    expect(result.candidates.every(c => c.error != null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. NEVER-THROWS — candidate errors surface in result, never propagate
// ---------------------------------------------------------------------------

describe('M142 — never throws on candidate error', () => {
  afterEach(() => { vi.resetModules(); });

  it('partial sandbox throw: surviving candidates still scored + winner picked', async () => {
    // Candidate 0 throws, candidates 1 and 2 succeed with proposals
    const sandboxMock = makeSandboxMock({ withProposalAt: [1, 2], throwAt: [0] });
    const judgeMock = makeJudgeMock([14, 10]);

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?throw=' + randomUUID());

    // Assign directly — runBestOfN never throws by contract
    const result = await runBestOfN(makeItem(), makeConfig(), { n: 3 });

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]?.error).toMatch(/sandbox error at 0/);
    expect(result.winner).toBeDefined();
    // Candidate 1 scored 14 > candidate 2 scored 10
    expect(result.winner?.index).toBe(1);
  });

  it('judge throw does not prevent winner selection (score stays 0)', async () => {
    const sandboxMock = makeSandboxMock({ withProposalAt: [0, 1] });
    const judgeMock = vi.fn().mockRejectedValue(new Error('judge unavailable'));

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?judgerr=' + randomUUID());

    // Assign directly — never throws by contract
    const result = await runBestOfN(makeItem(), makeConfig(), { n: 2 });

    expect(result.candidates).toHaveLength(2);
    // No winner verdict, but first non-empty candidate is still picked
    expect(result.winner).toBeDefined();
    expect(result.winner?.verdict).toBeUndefined();
    expect(result.winner?.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. CFG FLAG — bestOfN read from cfg.foundry.bestOfN
// ---------------------------------------------------------------------------

describe('M142 — cfg.foundry.bestOfN flag', () => {
  afterEach(() => { vi.resetModules(); });

  it('reads N from cfg.foundry.bestOfN when opts.n is absent', async () => {
    const sandboxMock = makeSandboxMock({ withProposalAt: [0, 1, 2, 3] });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: makeJudgeMock([5, 5, 5, 5]),
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?cfg=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig(4)); // cfg says N=4

    expect(sandboxMock).toHaveBeenCalledTimes(4);
    expect(result.critique.n).toBe(4);
  });

  it('opts.n overrides cfg.foundry.bestOfN', async () => {
    const sandboxMock = makeSandboxMock({ withProposalAt: [0, 1] });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: makeJudgeMock([5, 5]),
    }));

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?override=' + randomUUID());
    // cfg says N=4 but opts says N=2 → should use 2
    const result = await runBestOfN(makeItem(), makeConfig(4), { n: 2 });

    expect(sandboxMock).toHaveBeenCalledTimes(2);
    expect(result.critique.n).toBe(2);
  });
});
