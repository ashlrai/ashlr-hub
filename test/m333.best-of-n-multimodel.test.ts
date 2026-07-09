/**
 * m333.best-of-n-multimodel.test.ts — M333 (completes M142): multi-model
 * best-of-N with full-cost accounting, loser archival, and the record stream.
 *
 * Groups:
 *  1. CANDIDATE SPECS — each candidate runs on its own engine/model; the
 *     runner kind (cli-agent vs api-model) is resolved PER CANDIDATE.
 *  2. COST — critique.totalCostUsd sums ALL candidates; billableCostUsd
 *     applies the M80 subscription-$0 rule per candidate.
 *  3. LOSERS — exactly one pending proposal survives; losers are rejected
 *     with a provenance reason naming the winner.
 *  4. LEDGER — one BestOfNRecord per run with per-candidate rows + won flag.
 *  5. PARITY — no candidates opt ⇒ single-engine resampling (M142/M170).
 *
 * Mock conventions: vi.doMock + vi.resetModules() + cache-busting UUID
 * imports — mirrors m142.best-of-n.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

const MOCK_REPO = '/tmp/fake-repo';

function makeItem() {
  return {
    id: 'item-1',
    repo: MOCK_REPO,
    source: 'manual' as const,
    title: 'Fix the thing',
    detail: 'Details here',
    value: 3,
    effort: 2,
    score: 8,
    tags: [],
    ts: new Date().toISOString(),
  };
}

function makeConfig(): import('../src/core/types.js').AshlrConfig {
  return {
    foundry: { allowedBackends: ['claude', 'local-coder'] } as Record<string, unknown>,
  } as unknown as import('../src/core/types.js').AshlrConfig;
}

/** Sandbox mock returning a proposal + cost for every call; records inputs. */
function makeSandboxMock(costUsd: number, label: string) {
  let n = 0;
  const calls: Array<{ engine: string; model?: string }> = [];
  const options: Array<Record<string, unknown>> = [];
  const fn = vi.fn(
    async (engine: unknown, _goal: unknown, _cfg: unknown, runOpts: Record<string, unknown>) => {
      const idx = n++;
      calls.push({ engine: String(engine), model: runOpts['model'] as string | undefined });
      options.push(runOpts);
      return {
        state: {
          id: `run-${label}-${idx}`,
          status: 'done',
          result: `diff ${label} ${idx}`,
          usage: { estCostUsd: costUsd },
        },
        proposalId: `proposal-${label}-${idx}`,
      };
    },
  );
  return { fn, calls, options };
}

function judgeMockWithScores(scoreOrder: number[]) {
  let n = 0;
  return vi.fn(async () => {
    const perDim = Math.max(1, Math.min(5, scoreOrder[n++] ?? 3));
    return {
      proposalId: `v-${n}`,
      verdict: 'ship' as const,
      value: perDim,
      correctness: perDim,
      scope: 6 - perDim,
      alignment: perDim,
      rationale: 'mock',
      wouldMerge: true,
    };
  });
}

interface Harness {
  runBestOfN: typeof import('../src/core/run/best-of-n.js').runBestOfN;
  setStatus: ReturnType<typeof vi.fn>;
  recordBestOfN: ReturnType<typeof vi.fn>;
}

async function harness(opts: {
  cli: ReturnType<typeof vi.fn>;
  api: ReturnType<typeof vi.fn>;
  judgeScores?: number[];
  subscriptionEngines?: string[];
}): Promise<Harness> {
  vi.resetModules();
  vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
    runEngineSandboxed: opts.cli,
    runApiModelSandboxed: opts.api,
  }));
  vi.doMock('../src/core/fleet/manager.js', () => ({
    judgeProposal: judgeMockWithScores(opts.judgeScores ?? [4, 4, 4]),
  }));
  const setStatus = vi.fn();
  vi.doMock('../src/core/inbox/store.js', () => ({
    loadProposal: vi.fn(() => null),
    setStatus,
  }));
  const recordBestOfN = vi.fn();
  vi.doMock('../src/core/fleet/best-of-n-ledger.js', () => ({
    recordBestOfN,
    readBestOfNRecords: vi.fn(() => []),
  }));
  const subs = new Set(opts.subscriptionEngines ?? ['claude', 'codex']);
  vi.doMock('../src/core/fleet/subscription-usage.js', () => ({
    isSubscriptionEngine: vi.fn((e: string) => subs.has(e)),
    subscriptionAllows: vi.fn(() => ({ allowed: true, reason: 'mock' })),
    subscriptionUsage: vi.fn(() => null),
  }));
  const mod = await import('../src/core/run/best-of-n.js?m333=' + randomUUID());
  return { runBestOfN: mod.runBestOfN, setStatus, recordBestOfN };
}

afterEach(() => {
  vi.doUnmock('../src/core/run/sandboxed-engine.js');
  vi.doUnmock('../src/core/fleet/manager.js');
  vi.doUnmock('../src/core/inbox/store.js');
  vi.doUnmock('../src/core/fleet/best-of-n-ledger.js');
  vi.doUnmock('../src/core/fleet/subscription-usage.js');
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// 1. Candidate specs
// ---------------------------------------------------------------------------

describe('M333 — candidate specs', () => {
  it('routes each candidate to its OWN engine + model with the right runner kind', async () => {
    const cli = makeSandboxMock(1.0, 'cli'); // claude → cli-agent runner
    const api = makeSandboxMock(0.0, 'api'); // local-coder → api-model runner
    const h = await harness({ cli: cli.fn, api: api.fn });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 3,
      candidates: [
        { engine: 'claude' as never, model: 'claude-sonnet-5' },
        { engine: 'local-coder' as never, model: 'qwen3-coder-next' },
        { engine: 'claude' as never, model: null },
      ],
    });

    expect(cli.fn).toHaveBeenCalledTimes(2);
    expect(api.fn).toHaveBeenCalledTimes(1);
    expect(cli.calls[0]).toEqual({ engine: 'claude', model: 'claude-sonnet-5' });
    expect(api.calls[0]).toEqual({ engine: 'local-coder', model: 'qwen3-coder-next' });
    expect(cli.calls[1]).toEqual({ engine: 'claude', model: undefined });
    expect(cli.options[0]?.['delegationScope']).toMatchObject({
      origin: 'best-of-n',
      sourceRepo: MOCK_REPO,
      workItemId: 'item-1',
      workSource: 'manual',
      taskId: 'candidate-0',
      backend: {
        engine: 'claude',
        model: 'claude-sonnet-5',
        assignedBy: 'best-of-n',
      },
      resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
    });
    expect(api.options[0]?.['delegationScope']).toMatchObject({
      origin: 'best-of-n',
      taskId: 'candidate-1',
      backend: {
        engine: 'local-coder',
        model: 'qwen3-coder-next',
      },
    });
    expect(cli.options[1]?.['delegationScope']).toMatchObject({
      origin: 'best-of-n',
      taskId: 'candidate-2',
      backend: {
        engine: 'claude',
        model: null,
      },
    });
    expect((cli.options[0]?.['delegationScope'] as Record<string, unknown>)?.['runId']).toEqual(expect.any(String));

    expect(result.candidates.map((c) => c.engine)).toEqual(['claude', 'local-coder', 'claude']);
    expect(result.candidates.map((c) => c.model)).toEqual([
      'claude-sonnet-5',
      'qwen3-coder-next',
      null,
    ]);
    expect(result.winner).toBeDefined();
  });

  it('cycles specs when n exceeds the spec list', async () => {
    const cli = makeSandboxMock(0.1, 'cli');
    const api = makeSandboxMock(0.0, 'api');
    const h = await harness({ cli: cli.fn, api: api.fn, judgeScores: [3, 3, 3, 3] });

    await h.runBestOfN(makeItem(), makeConfig(), {
      n: 4,
      candidates: [
        { engine: 'claude' as never, model: 'claude-sonnet-5' },
        { engine: 'local-coder' as never },
      ],
    });
    expect(cli.fn).toHaveBeenCalledTimes(2);
    expect(api.fn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Cost accounting
// ---------------------------------------------------------------------------

describe('M333 — full-cost accounting', () => {
  it('totalCostUsd sums ALL candidates; billable applies subscription-$0 per candidate', async () => {
    const cli = makeSandboxMock(1.0, 'cli'); // claude (subscription → $0 billable)
    const api = makeSandboxMock(1.0, 'api'); // local-coder (billable)
    const h = await harness({ cli: cli.fn, api: api.fn });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 2,
      candidates: [{ engine: 'claude' as never }, { engine: 'local-coder' as never }],
    });

    expect(result.critique.totalCostUsd).toBeCloseTo(2.0, 5);
    expect(result.critique.billableCostUsd).toBeCloseTo(1.0, 5);
  });

  it('summarizes terminal no-proposal reasons when every candidate is gate-blocked', async () => {
    const cli = vi.fn(async (_engine: unknown, _goal: unknown, _cfg: unknown, runOpts: Record<string, unknown>) => ({
      state: {
        id: String(runOpts['runId'] ?? 'run-gate-blocked'),
        status: 'done',
        result: 'typecheck failed',
        usage: { estCostUsd: 0.25 },
        proposalOutcome: {
          kind: 'completeness-gate',
          reason: 'completeness gate blocked proposal: typecheck failed',
          files: 2,
          insertions: 4,
          deletions: 1,
        },
      },
      proposalOutcome: {
        kind: 'completeness-gate',
        reason: 'completeness gate blocked proposal: typecheck failed',
        files: 2,
        insertions: 4,
        deletions: 1,
      },
    }));
    const api = makeSandboxMock(0.0, 'api');
    const h = await harness({ cli, api: api.fn, subscriptionEngines: [] });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 2,
      engine: 'claude' as never,
    });

    expect(result.winner).toBeUndefined();
    expect(result.critique.noProposalReasons).toEqual([
      {
        reason: 'completeness-gate: completeness gate blocked proposal: typecheck failed',
        count: 2,
      },
    ]);
    expect(h.recordBestOfN).toHaveBeenCalledTimes(1);
    const rec = h.recordBestOfN.mock.calls[0]![0] as {
      candidates: Array<{ proposalOutcome?: string; proposalOutcomeReason?: string; proposalId: string | null }>;
    };
    expect(rec.candidates).toHaveLength(2);
    expect(rec.candidates[0]).toMatchObject({
      proposalId: null,
      proposalOutcome: 'completeness-gate',
      proposalOutcomeReason: 'completeness gate blocked proposal: typecheck failed',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Losers
// ---------------------------------------------------------------------------

describe('M333 — loser archival', () => {
  it('rejects every non-winner proposal with a provenance reason naming the winner', async () => {
    const cli = makeSandboxMock(0.1, 'cli');
    const api = makeSandboxMock(0.0, 'api');
    // candidate 1 wins (highest per-dim score)
    const h = await harness({ cli: cli.fn, api: api.fn, judgeScores: [2, 5, 3] });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 3,
      candidates: [
        { engine: 'claude' as never },
        { engine: 'claude' as never },
        { engine: 'claude' as never },
      ],
    });

    const winnerPid = result.winner!.proposalId!;
    expect(h.setStatus).toHaveBeenCalledTimes(2);
    for (const call of h.setStatus.mock.calls) {
      expect(call[0]).not.toBe(winnerPid);
      expect(call[1]).toBe('rejected');
      expect(String(call[3])).toContain(`best-of-n loser: winner ${winnerPid}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Ledger record
// ---------------------------------------------------------------------------

describe('M333 — record stream', () => {
  it('appends one record with per-candidate rows and the won flag on the winner only', async () => {
    const cli = makeSandboxMock(0.5, 'cli');
    const api = makeSandboxMock(0.0, 'api');
    const h = await harness({ cli: cli.fn, api: api.fn, judgeScores: [5, 2] });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 2,
      candidates: [{ engine: 'claude' as never, model: 'claude-sonnet-5' }, { engine: 'local-coder' as never }],
    });

    expect(h.recordBestOfN).toHaveBeenCalledTimes(1);
    const rec = h.recordBestOfN.mock.calls[0]![0] as {
      n: number;
      winnerProposalId: string | null;
      totalCostUsd: number;
      candidates: Array<{ engine: string; model: string | null; won: boolean; costUsd?: number }>;
    };
    expect(rec.n).toBe(2);
    expect(rec.winnerProposalId).toBe(result.winner!.proposalId);
    expect(rec.candidates).toHaveLength(2);
    expect(rec.candidates.filter((c) => c.won)).toHaveLength(1);
    expect(rec.candidates[0]!.engine).toBe('claude');
    expect(rec.candidates[0]!.model).toBe('claude-sonnet-5');
    expect(rec.totalCostUsd).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// 5. Parity
// ---------------------------------------------------------------------------

describe('M333 — parity without candidate specs', () => {
  it('no candidates opt ⇒ single-engine resampling with the opts engine/model', async () => {
    const cli = makeSandboxMock(0.2, 'cli');
    const api = makeSandboxMock(0.0, 'api');
    const h = await harness({ cli: cli.fn, api: api.fn });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 3,
      engine: 'claude' as never,
      model: 'claude-sonnet-5',
    });

    expect(cli.fn).toHaveBeenCalledTimes(3);
    expect(api.fn).not.toHaveBeenCalled();
    expect(cli.calls.every((c) => c.engine === 'claude' && c.model === 'claude-sonnet-5')).toBe(true);
    expect(result.critique.totalCostUsd).toBeCloseTo(0.6, 5);
    expect(result.winner).toBeDefined();
  });
});
