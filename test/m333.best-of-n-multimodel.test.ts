/**
 * m333.best-of-n-multimodel.test.ts — M333 (completes M142): multi-model
 * best-of-N with full-cost accounting, winner-only filing, and the record stream.
 *
 * Groups:
 *  1. CANDIDATE SPECS — each candidate runs on its own engine/model; the
 *     runner kind (cli-agent vs api-model) is resolved PER CANDIDATE.
 *  2. COST — critique.totalCostUsd sums ALL candidates; billableCostUsd
 *     applies the M80 subscription-$0 rule per candidate.
 *  3. FILE-ONCE — exactly one winner proposal is filed; losers stay metadata-only.
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
      const proposalOutcome =
        runOpts['propose'] === false
          ? {
              kind: 'proposal-disabled',
              reason: `proposal filing disabled for candidate ${idx}`,
            }
          : undefined;
      return {
        state: {
          id: `run-${label}-${idx}`,
          status: 'done',
          result: `diff ${label} ${idx}`,
          usage: { estCostUsd: costUsd },
          ...(proposalOutcome ? { proposalOutcome } : {}),
        },
        ...(proposalOutcome ? { proposalOutcome } : {}),
        ...(runOpts['propose'] === false ? {} : { proposalId: `proposal-${label}-${idx}` }),
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
  captureSandboxedProposal?: ReturnType<typeof vi.fn>;
  createSandbox?: ReturnType<typeof vi.fn>;
  removeSandbox?: ReturnType<typeof vi.fn>;
  filedProposals?: Map<string, import('../src/core/types.js').Proposal>;
}

async function harness(opts: {
  cli: ReturnType<typeof vi.fn>;
  api: ReturnType<typeof vi.fn>;
  judgeScores?: number[];
  subscriptionEngines?: string[];
  draftMode?: boolean;
}): Promise<Harness> {
  vi.resetModules();
  const filedProposals = new Map<string, import('../src/core/types.js').Proposal>();
  const captureSandboxedProposal = vi.fn(
    async (
      engine: unknown,
      _goal: unknown,
      _cfg: unknown,
      capOpts: Record<string, unknown>,
    ) => {
      const sb = capOpts['existingWorktree'] as { id: string; sourceRepo: string } | undefined;
      const sandboxId = sb?.id ?? 'sb-missing';
      const idx = Number.parseInt(sandboxId.replace(/\D+/g, ''), 10);
      const safeIdx = Number.isFinite(idx) ? idx : 0;
      const now = new Date().toISOString();
      const diff = `DRAFT_DIFF_${safeIdx}`;
      const baseProposal = {
        id: `draft-${sandboxId}`,
        repo: sb?.sourceRepo ?? MOCK_REPO,
        origin: 'agent' as const,
        kind: 'patch' as const,
        title: `${String(engine)} draft ${safeIdx}`,
        summary: `draft ${safeIdx}`,
        diff,
        sandboxId,
        runId: String(capOpts['runId'] ?? `run-${safeIdx}`),
        engineModel: `${String(engine)}:mock-model`,
        engineTier: 'frontier' as const,
        diffHash: `hash-${safeIdx}`,
        provenanceSig: `sig-${safeIdx}`,
        status: 'pending' as const,
        createdAt: now,
        updatedAt: now,
      };
      if (capOpts['draftOnly'] === true) {
        return {
          state: {
            id: String(capOpts['runId'] ?? `run-${safeIdx}`),
            status: 'done',
            result: 'proposal draft captured',
            usage: capOpts['usage'] ?? { estCostUsd: 0 },
          },
          proposalDraft: baseProposal,
        };
      }
      const proposal = { ...baseProposal, id: `proposal-${sandboxId}` };
      filedProposals.set(proposal.id, proposal);
      const proposalOutcome = {
        kind: 'filed',
        reason: 'proposal filed',
        proposalId: proposal.id,
        files: 1,
        insertions: 1,
        deletions: 0,
      };
      return {
        state: {
          id: String(capOpts['runId'] ?? `run-${safeIdx}`),
          status: 'done',
          result: 'proposal filed',
          usage: capOpts['usage'] ?? { estCostUsd: 0 },
          proposalOutcome,
        },
        proposalId: proposal.id,
        proposalOutcome,
      };
    },
  );
  vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
    runEngineSandboxed: opts.cli,
    runApiModelSandboxed: opts.api,
    ...(opts.draftMode ? { captureSandboxedProposal } : {}),
  }));
  let sandboxN = 0;
  const createSandbox = vi.fn((sourceRepo: string) => {
    const id = `sb-${sandboxN++}`;
    return {
      id,
      sourceRepo,
      worktreePath: `/tmp/${id}`,
      branch: `ashlr/sandbox/${id}`,
      baseHead: 'base',
      createdAt: new Date().toISOString(),
    };
  });
  const removeSandbox = vi.fn();
  if (opts.draftMode) {
    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox,
      removeSandbox,
    }));
  }
  vi.doMock('../src/core/fleet/manager.js', () => ({
    judgeProposal: judgeMockWithScores(opts.judgeScores ?? [4, 4, 4]),
  }));
  const setStatus = vi.fn();
  vi.doMock('../src/core/inbox/store.js', () => ({
    loadProposal: vi.fn((id: string) => filedProposals.get(id) ?? null),
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
  return {
    runBestOfN: mod.runBestOfN,
    setStatus,
    recordBestOfN,
    ...(opts.draftMode ? { captureSandboxedProposal, createSandbox, removeSandbox, filedProposals } : {}),
  };
}

afterEach(() => {
  vi.doUnmock('../src/core/run/sandboxed-engine.js');
  vi.doUnmock('../src/core/sandbox/worktree.js');
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
      resultContract: { kind: 'proposal', requireDiff: true, requireProposal: false },
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
// 3. File-once
// ---------------------------------------------------------------------------

describe('M333 — file-once proposal capture', () => {
  it('files only the selected winner while losers remain metadata-only', async () => {
    const cli = makeSandboxMock(0.1, 'cli');
    const api = makeSandboxMock(0.0, 'api');
    // candidate 1 wins (highest per-dim score)
    const h = await harness({ cli: cli.fn, api: api.fn, judgeScores: [2, 5, 3], draftMode: true });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 3,
      candidates: [
        { engine: 'claude' as never },
        { engine: 'claude' as never },
        { engine: 'claude' as never },
      ],
    });

    const winnerPid = result.winner!.proposalId!;
    expect(result.winner!.index).toBe(1);
    expect(winnerPid).toBe('proposal-sb-1');
    expect(result.candidates.map((c) => c.proposalId ?? null)).toEqual([null, winnerPid, null]);
    expect(cli.options.every((o) => o['propose'] === false)).toBe(true);
    expect(h.captureSandboxedProposal).toHaveBeenCalledTimes(4);
    expect(h.captureSandboxedProposal?.mock.calls.filter((call) => call[3]?.['draftOnly'] === true)).toHaveLength(3);
    expect(h.captureSandboxedProposal?.mock.calls.filter((call) => call[3]?.['draftOnly'] !== true)).toHaveLength(1);
    expect(h.filedProposals?.size).toBe(1);
    expect(h.filedProposals?.get(winnerPid)?.diff).toBe('DRAFT_DIFF_1');
    expect(h.setStatus).not.toHaveBeenCalled();
    expect(h.removeSandbox).toHaveBeenCalledTimes(3);

    expect(h.recordBestOfN).toHaveBeenCalledTimes(1);
    const rec = h.recordBestOfN.mock.calls[0]![0] as {
      winnerIndex: number;
      winnerProposalId: string | null;
      totalCostUsd: number;
      candidates: Array<{ proposalId: string | null; won: boolean; proposalOutcome?: string }>;
    };
    expect(rec.winnerIndex).toBe(1);
    expect(rec.winnerProposalId).toBe(winnerPid);
    expect(rec.totalCostUsd).toBeCloseTo(0.3, 5);
    expect(rec.candidates.map((c) => ({ proposalId: c.proposalId, won: c.won }))).toEqual([
      { proposalId: null, won: false },
      { proposalId: winnerPid, won: true },
      { proposalId: null, won: false },
    ]);
    expect(rec.candidates[0]?.proposalOutcome).toBe('proposal-disabled');
    expect(rec.candidates[1]?.proposalOutcome).toBe('filed');
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
