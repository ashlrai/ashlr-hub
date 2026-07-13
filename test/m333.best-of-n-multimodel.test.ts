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
import { deriveCandidateAttemptIdentity } from '../src/core/fleet/attempt-identity.js';

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
  judgeProposal: ReturnType<typeof vi.fn>;
  filedProposals?: Map<string, import('../src/core/types.js').Proposal>;
  observeShadowSkills: ReturnType<typeof vi.fn>;
}

async function harness(opts: {
  cli: ReturnType<typeof vi.fn>;
  api: ReturnType<typeof vi.fn>;
  judgeScores?: number[];
  runTests?: ReturnType<typeof vi.fn>;
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
      const isPartial = capOpts['isPartial'] === true;
      const producerStatus = capOpts['producerStatus'] === 'failed' || capOpts['producerStatus'] === 'aborted'
        ? capOpts['producerStatus']
        : 'done';
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
        ...(isPartial ? { isPartial: true } : {}),
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
        reason: isPartial ? 'partial proposal filed' : 'proposal filed',
        proposalId: proposal.id,
        files: 1,
        insertions: 1,
        deletions: 0,
        ...(isPartial ? { isPartial: true } : {}),
      };
      return {
        state: {
          id: String(capOpts['runId'] ?? `run-${safeIdx}`),
          status: producerStatus,
          result: isPartial ? 'partial proposal filed' : 'proposal filed',
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
  const judgeProposal = judgeMockWithScores(opts.judgeScores ?? [4, 4, 4]);
  vi.doMock('../src/core/fleet/manager.js', () => ({
    judgeProposal,
  }));
  if (opts.runTests) {
    vi.doMock('../src/core/run/run-tests.js', () => ({ runTests: opts.runTests }));
  }
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
  const observeShadowSkills = vi.fn(() => ({
    selection: {
      mode: 'shadow',
      policyVersion: 'verified-skills-v1',
      consideredCount: 1,
      eligibleCount: 1,
      selectedSkillIds: ['skill.test'],
      selected: [],
    },
    events: [],
  }));
  vi.doMock('../src/core/fleet/skill-shadow-observer.js', () => ({ observeShadowSkills }));
  const mod = await import('../src/core/run/best-of-n.js?m333=' + randomUUID());
  return {
    runBestOfN: mod.runBestOfN,
    setStatus,
    recordBestOfN,
    judgeProposal,
    observeShadowSkills,
    ...(opts.draftMode ? { captureSandboxedProposal, createSandbox, removeSandbox, filedProposals } : {}),
  };
}

afterEach(() => {
  vi.doUnmock('../src/core/run/sandboxed-engine.js');
  vi.doUnmock('../src/core/sandbox/worktree.js');
  vi.doUnmock('../src/core/fleet/manager.js');
  vi.doUnmock('../src/core/run/run-tests.js');
  vi.doUnmock('../src/core/inbox/store.js');
  vi.doUnmock('../src/core/fleet/best-of-n-ledger.js');
  vi.doUnmock('../src/core/fleet/subscription-usage.js');
  vi.doUnmock('../src/core/fleet/skill-shadow-observer.js');
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// 1. Candidate specs
// ---------------------------------------------------------------------------

describe('M333 — candidate specs', () => {
  it('observes signed cards per candidate with child identity and final engine/model', async () => {
    const cli = makeSandboxMock(0.1, 'cli');
    const api = makeSandboxMock(0.1, 'api');
    const h = await harness({ cli: cli.fn, api: api.fn });
    const attemptId = 'attempt-11111111-1111-4111-8111-111111111111' as const;

    await h.runBestOfN(makeItem(), makeConfig(), {
      n: 2,
      attemptId,
      shadowSkillSelectedAt: '2026-07-10T12:00:00.000Z',
      shadowSkillCards: [{} as import('../src/core/types.js').SkillCard],
      candidates: [
        { engine: 'claude' as never, model: 'claude-sonnet-5' },
        { engine: 'local-coder' as never, model: 'qwen3-coder-next' },
      ],
    });

    expect(h.observeShadowSkills).toHaveBeenCalledTimes(2);
    expect(h.observeShadowSkills.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        identity: {
          trajectoryId: `run:${attemptId}`,
          runId: deriveCandidateAttemptIdentity(attemptId, 0),
        },
        route: { backend: 'claude', tier: 'frontier', model: 'claude-sonnet-5' },
      }),
      expect.objectContaining({
        identity: {
          trajectoryId: `run:${attemptId}`,
          runId: deriveCandidateAttemptIdentity(attemptId, 1),
        },
        route: { backend: 'local-coder', tier: 'mid', model: 'qwen3-coder-next' },
      }),
    ]);
    for (const options of [...cli.options, ...api.options]) {
      expect(options).not.toHaveProperty('selectedSkillIds');
      expect(options).not.toHaveProperty('skills');
      expect(options).not.toHaveProperty('skillContext');
    }
  });

  it('returns candidate errors instead of throwing for a malformed outer attempt id', async () => {
    const cli = makeSandboxMock(0.1, 'cli');
    const api = makeSandboxMock(0.0, 'api');
    const h = await harness({ cli: cli.fn, api: api.fn });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 2,
      attemptId: 'attempt-invalid' as never,
      candidates: [{ engine: 'claude' as never }, { engine: 'local-coder' as never }],
    });

    expect(result.winner).toBeUndefined();
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((candidate) => candidate.error?.includes('valid generated attempt id'))).toBe(true);
    expect(cli.fn).not.toHaveBeenCalled();
    expect(api.fn).not.toHaveBeenCalled();
  });

  it('derives stable candidate run ids from the preallocated outer attempt', async () => {
    const cli = makeSandboxMock(0.1, 'cli');
    const api = makeSandboxMock(0.0, 'api');
    const h = await harness({ cli: cli.fn, api: api.fn });
    const attemptId = 'attempt-018f6d2e-7c50-4f15-8a2c-6efc97fb87a1' as const;

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 2,
      attemptId,
      candidates: [
        { engine: 'claude' as never },
        { engine: 'local-coder' as never },
      ],
    });

    expect(cli.options[0]?.['runId']).toBe(deriveCandidateAttemptIdentity(attemptId, 0));
    expect(api.options[0]?.['runId']).toBe(deriveCandidateAttemptIdentity(attemptId, 1));
    expect(result.candidates.map((candidate) => candidate.runId)).toEqual([
      deriveCandidateAttemptIdentity(attemptId, 0),
      deriveCandidateAttemptIdentity(attemptId, 1),
    ]);
    expect(h.recordBestOfN).toHaveBeenCalledWith(expect.objectContaining({
      attemptId,
      candidates: [
        expect.objectContaining({ runId: deriveCandidateAttemptIdentity(attemptId, 0) }),
        expect.objectContaining({ runId: deriveCandidateAttemptIdentity(attemptId, 1) }),
      ],
    }));
  });

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
      'claude-opus-4-8',
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
  it.each([
    ['file-once', true],
    ['legacy', false],
  ] as const)('pre-cancelled %s path starts no candidate work', async (_label, draftMode) => {
    const cli = makeSandboxMock(0.1, 'cli');
    const h = await harness({ cli: cli.fn, api: cli.fn, draftMode });
    const controller = new AbortController();
    controller.abort();

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 1,
      candidates: [{ engine: 'claude' as never }],
      signal: controller.signal,
    });

    expect(result.winner).toBeUndefined();
    expect(result.candidates[0]).toMatchObject({ error: 'cancelled' });
    expect(result.candidates[0]).not.toHaveProperty('costUsd');
    expect(cli.fn).not.toHaveBeenCalled();
    expect(h.createSandbox?.mock.calls.length ?? 0).toBe(0);
    expect(h.judgeProposal).not.toHaveBeenCalled();
    expect(h.recordBestOfN).toHaveBeenCalledTimes(1);
  });

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
    expect(h.judgeProposal.mock.calls.map((call) => call[3])).toEqual([
      { recordTrace: false },
      { recordTrace: false },
      { recordTrace: false },
    ]);
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

  it('retains the sandbox handle for cleanup when draft capture throws', async () => {
    const cli = makeSandboxMock(0.1, 'cli');
    const h = await harness({ cli: cli.fn, api: cli.fn, judgeScores: [1], draftMode: true });
    h.captureSandboxedProposal?.mockRejectedValueOnce(new Error('draft capture failed'));

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 1,
      candidates: [{ engine: 'claude' as never }],
    });

    expect(result.candidates[0]?.error).toContain('draft capture failed');
    expect(h.removeSandbox).toHaveBeenCalledTimes(1);
  });

  it('quarantines a shared candidate worktree when process cleanup is unconfirmed', async () => {
    const controller = new AbortController();
    const cli = vi.fn(async (_engine, _goal, _cfg, runOptions: Record<string, unknown>) => {
      const sandbox = runOptions['existingWorktree'] as { id: string; worktreePath: string };
      controller.abort();
      return {
        state: {
          id: String(runOptions['runId']),
          status: 'failed',
          result: 'engine failed with sandbox retained: process-group exit unconfirmed',
          usage: { tokensIn: 3, tokensOut: 1, steps: 1, estCostUsd: 0.2 },
          terminationReason: 'error-exit',
        },
        sandboxRetention: {
          status: 'retained',
          reason: 'process-cleanup-unconfirmed',
          sandboxId: sandbox.id,
          worktreePath: sandbox.worktreePath,
          recovery: 'orphan-sweep',
        },
      };
    });
    const h = await harness({ cli, api: cli, draftMode: true });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 1,
      candidates: [{ engine: 'claude' as never }],
      signal: controller.signal,
    });

    expect(cli.mock.calls[0]?.[3]).toMatchObject({
      existingWorktree: { id: 'sb-0', worktreePath: '/tmp/sb-0' },
    });
    expect(result.winner).toBeUndefined();
    expect(result.candidates[0]).toMatchObject({
      error: expect.stringContaining('process-group exit unconfirmed'),
      sandboxRetention: {
        status: 'retained',
        sandboxId: 'sb-0',
        recovery: 'orphan-sweep',
      },
    });
    expect(h.captureSandboxedProposal).not.toHaveBeenCalled();
    expect(h.removeSandbox).not.toHaveBeenCalled();
  });

  it('ranks and owns the strongest failed-producer partial without erasing failure facts', async () => {
    let producerIndex = 0;
    const costs = [0.2, 0.3, 0.4];
    const cli = vi.fn(async (_engine: unknown, _goal: unknown, _cfg: unknown, runOpts: Record<string, unknown>) => {
      const index = producerIndex++;
      const proposalOutcome = {
        kind: 'proposal-disabled',
        reason: `proposal filing disabled for failed candidate ${index}`,
      };
      return {
        state: {
          id: String(runOpts['runId']),
          status: 'failed',
          result: `producer ${index} failed after material draft`,
          usage: { estCostUsd: costs[index] },
          proposalOutcome,
        },
        proposalOutcome,
      };
    });
    const h = await harness({
      cli,
      api: cli,
      judgeScores: [4, 5, 5],
      subscriptionEngines: [],
      draftMode: true,
    });
    const lifecycle: string[] = [];
    const capture = h.captureSandboxedProposal!;
    const originalCapture = capture.getMockImplementation()!;
    capture.mockImplementation(async (...args: Parameters<typeof originalCapture>) => {
      const captured = await originalCapture(...args);
      if (args[3]?.['draftOnly'] !== true && captured.proposalId) {
        lifecycle.push(`owned:${captured.proposalId}`);
      }
      return captured;
    });
    h.removeSandbox?.mockImplementation((sandbox: { id: string }) => {
      lifecycle.push(`removed:${sandbox.id}`);
    });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 3,
      candidates: [
        { engine: 'claude' as never },
        { engine: 'claude' as never },
        { engine: 'claude' as never },
      ],
    });

    expect(h.judgeProposal).toHaveBeenCalledTimes(3);
    expect(result.critique).toMatchObject({
      nonEmpty: 3,
      judged: 3,
      winnerIndex: 1,
      totalCostUsd: 0.9,
      billableCostUsd: 0.9,
    });
    expect(result.winner).toMatchObject({
      index: 1,
      proposalId: 'proposal-sb-1',
      diff: 'DRAFT_DIFF_1',
      error: 'producer 1 failed after material draft',
      proposalOutcome: { kind: 'filed', isPartial: true },
    });
    expect(result.candidates.map((candidate) => candidate.error)).toEqual([
      'producer 0 failed after material draft',
      'producer 1 failed after material draft',
      'producer 2 failed after material draft',
    ]);
    expect(h.filedProposals?.get('proposal-sb-1')).toMatchObject({ isPartial: true });
    expect(capture.mock.calls.filter((call) => call[3]?.['draftOnly'] !== true)).toEqual([
      expect.arrayContaining([
        'claude',
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          existingWorktree: expect.objectContaining({ id: 'sb-1' }),
          isPartial: true,
          producerStatus: 'failed',
          usage: { estCostUsd: 0.3 },
        }),
      ]),
    ]);
    expect(h.recordBestOfN).toHaveBeenCalledTimes(1);
    const record = h.recordBestOfN.mock.calls[0]?.[0] as {
      winnerIndex: number;
      winnerProposalId: string | null;
      totalCostUsd: number;
      candidates: Array<{ error?: string; costUsd?: number; proposalId: string | null; won: boolean }>;
    };
    expect(record).toMatchObject({
      winnerIndex: 1,
      winnerProposalId: 'proposal-sb-1',
      totalCostUsd: 0.9,
    });
    expect(record.candidates).toEqual([
      expect.objectContaining({ error: 'producer 0 failed after material draft', costUsd: 0.2, proposalId: null, won: false }),
      expect.objectContaining({ error: 'producer 1 failed after material draft', costUsd: 0.3, proposalId: 'proposal-sb-1', won: true }),
      expect.objectContaining({ error: 'producer 2 failed after material draft', costUsd: 0.4, proposalId: null, won: false }),
    ]);
    expect(lifecycle).toEqual([
      'owned:proposal-sb-1',
      'removed:sb-0',
      'removed:sb-1',
      'removed:sb-2',
    ]);
  });

  it('does not judge or file a winner after caller cancellation', async () => {
    const cli = makeSandboxMock(0.1, 'cli');
    const h = await harness({ cli: cli.fn, api: cli.fn, judgeScores: [5, 4, 3], draftMode: true });
    const controller = new AbortController();
    h.judgeProposal.mockImplementation(async (_proposal, _cfg, _client, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return {
        proposalId: 'cancelled-verdict',
        verdict: 'ship' as const,
        value: 5,
        correctness: 5,
        scope: 1,
        alignment: 5,
        rationale: 'mock',
        wouldMerge: true,
      };
    });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 3,
      candidates: [
        { engine: 'claude' as never },
        { engine: 'claude' as never },
        { engine: 'claude' as never },
      ],
      signal: controller.signal,
    });

    expect(result.winner).toBeUndefined();
    expect(result.critique.noProposalReasons).toEqual([{ reason: 'selection cancelled', count: 1 }]);
    expect(result.critique.nonEmpty).toBe(3);
    expect(result.critique.judged).toBe(1);
    expect(result.candidates.every((candidate) => candidate.error !== 'cancelled')).toBe(true);
    expect(h.captureSandboxedProposal?.mock.calls.filter((call) => call[3]?.['draftOnly'] !== true)).toHaveLength(0);
    expect(h.filedProposals?.size).toBe(0);
    expect(h.removeSandbox).toHaveBeenCalledTimes(3);
  });

  it('retains paid generation cost on cancellation and keeps subscription usage non-billable', async () => {
    const controller = new AbortController();
    const cli = vi.fn(async () => {
      controller.abort();
      return {
        state: {
          id: 'cancelled-paid-run',
          status: 'aborted',
          result: 'cancelled after provider usage',
          usage: { estCostUsd: 0.75 },
          terminationReason: 'cancelled',
        },
      };
    });
    const h = await harness({ cli, api: cli, subscriptionEngines: ['claude'] });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 1,
      candidates: [{ engine: 'claude' as never }],
      signal: controller.signal,
    });

    expect(result.winner).toBeUndefined();
    expect(result.critique.totalCostUsd).toBeCloseTo(0.75, 5);
    expect(result.critique.billableCostUsd).toBe(0);
    expect(result.critique.noProposalReasons).toEqual([
      { reason: 'selection cancelled', count: 1 },
      { reason: 'cancelled after provider usage', count: 1 },
    ]);
    expect(h.judgeProposal).not.toHaveBeenCalled();
    expect(h.recordBestOfN).toHaveBeenCalledTimes(1);
  });

  it('owns a winner whose durable proposal write completes before cancellation', async () => {
    const controller = new AbortController();
    const cli = makeSandboxMock(0.1, 'cli');
    const h = await harness({ cli: cli.fn, api: cli.fn, judgeScores: [5], draftMode: true });
    const capture = h.captureSandboxedProposal!;
    const original = capture.getMockImplementation()!;
    capture.mockImplementation(async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      const captureOpts = args[3] as Record<string, unknown>;
      if (captureOpts['draftOnly'] !== true) controller.abort();
      return result;
    });

    const result = await h.runBestOfN(makeItem(), makeConfig(), {
      n: 1,
      candidates: [{ engine: 'claude' as never }],
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(result.winner?.proposalId).toBe('proposal-sb-0');
    expect(h.filedProposals?.has('proposal-sb-0')).toBe(true);
    const record = h.recordBestOfN.mock.calls[0]?.[0] as {
      winnerProposalId: string | null;
      candidates: Array<{ won: boolean }>;
    };
    expect(record.winnerProposalId).toBe('proposal-sb-0');
    expect(record.candidates).toEqual([expect.objectContaining({ won: true })]);
  });

  it('propagates mid-cancel through legacy judging and tests while retaining settled evidence', async () => {
    const controller = new AbortController();
    let testsStarted!: () => void;
    const started = new Promise<void>((resolve) => { testsStarted = resolve; });
    const runTests = vi.fn(async (
      _proposalId: string,
      _cfg: unknown,
      _profile: string,
      options?: { signal?: AbortSignal },
    ) => {
      expect(options?.signal).toBe(controller.signal);
      testsStarted();
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return true;
    });
    const cli = makeSandboxMock(0.4, 'cli');
    const h = await harness({ cli: cli.fn, api: cli.fn, judgeScores: [5], runTests });

    const pending = h.runBestOfN(makeItem(), makeConfig(), {
      n: 1,
      candidates: [{ engine: 'claude' as never }],
      signal: controller.signal,
    });
    await started;
    const judgeOptions = h.judgeProposal.mock.calls[0]?.[3] as { signal?: AbortSignal };
    expect(judgeOptions.signal).toBe(controller.signal);
    controller.abort();
    const result = await pending;

    expect(result.winner).toBeUndefined();
    expect(result.candidates[0]).toMatchObject({
      proposalId: 'proposal-cli-0',
      verdict: { verdict: 'ship' },
      testsPassed: true,
      costUsd: 0.4,
    });
    expect(result.critique).toMatchObject({ judged: 1, totalCostUsd: 0.4, winnerIndex: -1 });
    expect(h.recordBestOfN).toHaveBeenCalledWith(expect.objectContaining({
      winnerIndex: -1,
      totalCostUsd: 0.4,
      candidates: [expect.objectContaining({ score: 19, testsPassed: true, costUsd: 0.4 })],
    }));
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
