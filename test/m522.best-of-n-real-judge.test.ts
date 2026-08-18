/**
 * m522.best-of-n-real-judge.test.ts — M498/M522: best-of-N real-judge wiring.
 *
 * Prior to this fix, runBestOfN()'s scoring call used buildNullJudgeClient()
 * unconditionally — complete() always returned '', so parseJudgeResponse('')
 * always failed and every candidate "score" was manager.ts's synthetic
 * parse-failure fallback (score 8, identical for every candidate, every
 * run). Selection was therefore always the deterministic tiebreak heuristic,
 * never a real judgment, despite the config surface (foundry.bestOfN +
 * tasteCritic) implying a critic scores candidates.
 *
 * Test groups:
 *
 *   1. DEFAULT OFF — cfg.foundry.bestOfNJudge unset never attempts
 *      resolveFrontierJudgeClient, regardless of candidate distinctness
 *      (preserves m142/m183/m333's existing unmocked-resolver behavior and
 *      protects every production install from an unconsented cost increase).
 *
 *   2. REAL JUDGE PATH — bestOfNJudge:true + a resolvable independent client
 *      → judgeSource:'real', critique.judge.status:'real', winner picked by
 *      the higher real verdict score.
 *
 *   3. UNAVAILABLE PATH — bestOfNJudge:true but no independent client
 *      resolvable → judgeSource:'unavailable', no fabricated verdict/score,
 *      explicit fallback to the existing heuristic (first clean candidate).
 *
 *   4. FAILURE PATH — a real client resolves, but the judge call itself
 *      throws or returns a judgeFailure verdict → judgeSource stays 'real'
 *      (a genuine attempt was made) yet score/verdict stay honest (0 /
 *      undefined), and critique.judge.callsFailed counts it — mirrors
 *      fleet/model-racing.ts's recordRaceJudgeFailure real-vs-unavailable
 *      distinction.
 *
 *   5. COST-BOUNDING — bestOfNJudge:true but fewer than 2 materially
 *      distinct candidates → judging is skipped entirely (resolver never
 *      called), judgeSource:'skipped'.
 *
 * Mock conventions mirror m142.best-of-n.test.ts: vi.doMock + vi.resetModules()
 * + cache-busting UUID query strings on dynamic imports.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashDiff,
  signPendingProposalAuthorityV1,
  signProvenance,
} from '../src/core/foundry/provenance.js';
import { canonicalFilesystemPathIdentity } from '../src/core/sandbox/policy.js';

const MOCK_REPO = '/tmp/fake-repo-m522';
const mockPersistedProposals = new Map<string, import('../src/core/types.js').Proposal>();
const originalHome = process.env.HOME;
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'ashlr-best-of-n-m522-'));
  process.env.HOME = testHome;
});

afterEach(() => {
  vi.resetModules();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});

function makeItem() {
  return {
    id: 'item-1',
    repo: MOCK_REPO,
    source: 'manual' as const,
    title: 'Fix the thing',
    detail: 'Details here',
    value: 3,
    effort: 2,
    score: 3,
    tags: [],
    ts: new Date().toISOString(),
  };
}

function makeConfig(opts: { bestOfN?: number; bestOfNJudge?: boolean } = {}) {
  const foundry: Record<string, unknown> = { allowedBackends: ['local-coder'] };
  if (opts.bestOfN !== undefined) foundry['bestOfN'] = opts.bestOfN;
  if (opts.bestOfNJudge !== undefined) foundry['bestOfNJudge'] = opts.bestOfNJudge;
  return { foundry } as unknown as import('../src/core/types.js').AshlrConfig;
}

/**
 * Build a mock runApiModelSandboxed that files a REAL persisted proposal for
 * every candidate index (mirrors m142.best-of-n.test.ts's makeSandboxMock) —
 * best-of-n.ts's winner-selection step re-validates each candidate's
 * proposal via loadProposal()/isAuthoritativeDurablePendingProposal(), so a
 * candidate without a genuinely persisted+signed proposal loses its
 * proposalId during capture and drops out of candidateHasProposalMaterial()
 * before critique.judge is ever computed.
 */
function makeSandboxMock(opts: { diffs?: string[] } = {}) {
  let callCount = 0;
  return vi.fn(async (_engine: unknown, _goal: unknown, _cfg: unknown, runOpts: Record<string, unknown>) => {
    const idx = callCount++;
    const runId = String(runOpts['runId'] ?? `run-${idx}`);
    const proposalId = `proposal-${idx}`;
    const persistedDiff = opts.diffs?.[idx] ?? `diff content for candidate ${idx}`;
    const diffHash = hashDiff(persistedDiff);
    const engineModel = 'local-coder:mock-model';
    const engineTier = 'mid' as const;
    const proposalOutcome = {
      kind: 'filed' as const,
      reason: 'proposal filed',
      proposalId,
      files: 1,
      insertions: 1,
      deletions: 0,
    };
    const proposal: import('../src/core/types.js').Proposal = {
      id: proposalId,
      repo: canonicalFilesystemPathIdentity(String(runOpts['sourceRepo'] ?? MOCK_REPO), { foldWindowsCase: false }),
      origin: 'agent',
      kind: 'patch',
      title: `candidate ${idx}`,
      summary: `candidate ${idx}`,
      diff: persistedDiff,
      diffHash,
      provenanceSig: signProvenance(engineModel, engineTier, diffHash),
      engineModel,
      engineTier,
      runId,
      trajectoryId: `run:${runId}`,
      workItemId: runOpts['workItemId'] as string | undefined,
      workItemGenerationId: runOpts['workItemGenerationId'] as string | undefined,
      status: 'pending',
      createdAt: new Date().toISOString(),
      runEventSummary: { runId, status: 'done', outcome: 'filed', proposalCreated: true, proposalId },
      producerStatus: 'done',
    };
    proposal.pendingAuthorityVersion = 1;
    proposal.pendingAuthoritySig = signPendingProposalAuthorityV1(proposal);
    mockPersistedProposals.set(proposalId, proposal);
    return {
      state: { id: runId, status: 'done', result: persistedDiff, proposalOutcome },
      proposalId,
      proposalOutcome,
    };
  });
}

function mockSandboxedEngine(apiSandboxMock: ReturnType<typeof vi.fn>) {
  mockPersistedProposals.clear();
  vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
    runApiModelSandboxed: apiSandboxMock,
    runEngineSandboxed: vi.fn(),
  }));
  vi.doMock('../src/core/inbox/store.js', () => ({
    loadProposal: vi.fn((id: string) => mockPersistedProposals.get(id) ?? null),
  }));
}

/**
 * Build a manager.js mock whose judgeProposal simulates the REAL module's
 * client-dependent behavior: a client carrying `.model` (the shape
 * resolveFrontierJudgeClient returns) yields a real verdict from `scores`;
 * a client with no `.model` (buildNullJudgeClient's shape) yields the same
 * synthetic judgeFailure fallback manager.ts's judgeProposal produces for an
 * unparseable ('') response — so this mock exercises best-of-n.ts's own
 * client-selection logic instead of bypassing it.
 */
function makeManagerMock(opts: {
  scores?: number[];
  resolvedClient?: { complete: (s: string, u: string) => Promise<string>; model: string } | null;
  throwOnReal?: boolean;
  realJudgeFailure?: 'parse' | 'network';
}) {
  let callCount = 0;
  const judgeProposal = vi.fn(async (
    proposal: { id: string },
    _cfg: unknown,
    client: { model?: string },
  ) => {
    const idx = callCount++;
    if (client.model === undefined) {
      return {
        proposalId: proposal.id,
        verdict: 'review' as const,
        value: 3, correctness: 3, scope: 3, alignment: 3,
        rationale: 'judge response unparseable — held for human review',
        wouldMerge: false,
        judgeFailure: 'parse' as const,
      };
    }
    if (opts.throwOnReal) throw new Error('judge call failed');
    if (opts.realJudgeFailure) {
      return {
        proposalId: proposal.id,
        verdict: 'review' as const,
        value: 3, correctness: 3, scope: 3, alignment: 3,
        rationale: 'judge call failed',
        wouldMerge: false,
        judgeFailure: opts.realJudgeFailure,
      };
    }
    const score = opts.scores?.[idx] ?? 8;
    const perDim = Math.max(1, Math.min(5, Math.round(score / 4)));
    return {
      proposalId: proposal.id,
      verdict: 'ship' as const,
      value: perDim, correctness: perDim, scope: 6 - perDim, alignment: perDim,
      rationale: `Mock rationale for candidate ${idx}`,
      wouldMerge: perDim >= 4,
    };
  });
  const resolveFrontierJudgeClient = vi.fn(() => opts.resolvedClient ?? null);
  return { judgeProposal, resolveFrontierJudgeClient };
}

// ---------------------------------------------------------------------------
// 1. DEFAULT OFF
// ---------------------------------------------------------------------------

describe('M522 — real judge default OFF', () => {
  it('cfg.foundry.bestOfNJudge unset never calls resolveFrontierJudgeClient', async () => {
    const sandboxMock = makeSandboxMock({ diffs: ['diff A', 'diff B'] });
    mockSandboxedEngine(sandboxMock);
    const mgr = makeManagerMock({
      scores: [10, 18],
      resolvedClient: { complete: async () => '{}', model: 'claude:opus' },
    });
    vi.doMock('../src/core/fleet/manager.js', () => mgr);

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?m522-default-off=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ bestOfN: 2 }));

    expect(mgr.resolveFrontierJudgeClient).not.toHaveBeenCalled();
    expect(result.critique.judge?.status).toBe('skipped');
    expect(result.critique.judge?.callsAttempted).toBe(0);
    for (const c of result.candidates) {
      expect(c.judgeSource).toBe('skipped');
      expect(c.verdict).toBeUndefined();
      expect(c.score).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. REAL JUDGE PATH
// ---------------------------------------------------------------------------

describe('M522 — real judge path', () => {
  it('opts into a real independent judge and picks the higher-scored candidate', async () => {
    const sandboxMock = makeSandboxMock({ diffs: ['diff A candidate 0', 'diff B candidate 1'] });
    mockSandboxedEngine(sandboxMock);
    const mgr = makeManagerMock({
      scores: [8, 18],
      resolvedClient: { complete: async () => '{}', model: 'claude:claude-opus-4-5' },
    });
    vi.doMock('../src/core/fleet/manager.js', () => mgr);

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?m522-real=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ bestOfN: 2, bestOfNJudge: true }));

    expect(mgr.resolveFrontierJudgeClient).toHaveBeenCalled();
    const [, resolveOpts] = mgr.resolveFrontierJudgeClient.mock.calls[0] as [unknown, { requireIndependent?: boolean; producerModel?: string }];
    expect(resolveOpts.requireIndependent).toBe(true);
    expect(typeof resolveOpts.producerModel).toBe('string');

    expect(result.critique.judge?.status).toBe('real');
    expect(result.critique.judge?.models).toContain('claude:claude-opus-4-5');
    expect(result.critique.judge?.callsAttempted).toBe(2);
    expect(result.critique.judge?.callsFailed).toBe(0);
    for (const c of result.candidates) {
      expect(c.judgeSource).toBe('real');
      expect(c.verdict).toBeDefined();
    }
    // Candidate 1 scored 18 > candidate 0's 8 → candidate 1 wins.
    expect(result.winner?.index).toBe(1);
    expect(result.winner?.score).toBeGreaterThan(result.candidates[0]!.score);
  });
});

// ---------------------------------------------------------------------------
// 3. UNAVAILABLE PATH
// ---------------------------------------------------------------------------

describe('M522 — judge unavailable path', () => {
  it('no independent client resolvable → explicit unavailable, no fabricated verdict/score', async () => {
    const sandboxMock = makeSandboxMock({ diffs: ['diff A candidate 0', 'diff B candidate 1'] });
    mockSandboxedEngine(sandboxMock);
    const mgr = makeManagerMock({ resolvedClient: null });
    vi.doMock('../src/core/fleet/manager.js', () => mgr);

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?m522-unavail=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ bestOfN: 2, bestOfNJudge: true }));

    expect(mgr.resolveFrontierJudgeClient).toHaveBeenCalled();
    expect(result.critique.judge?.status).toBe('unavailable');
    expect(result.critique.judge?.callsAttempted).toBe(0);
    for (const c of result.candidates) {
      expect(c.judgeSource).toBe('unavailable');
      // The null-client fallback call still runs (judgeProposal returns a
      // judgeFailure verdict), but best-of-n.ts must not surface it as a
      // considered judgment or a non-zero score.
      expect(c.verdict).toBeUndefined();
      expect(c.score).toBe(0);
    }
    // Heuristic fallback: first clean, non-empty candidate wins by index.
    expect(result.winner?.index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. FAILURE PATH
// ---------------------------------------------------------------------------

describe('M522 — real judge call failure', () => {
  it('a resolved client whose call throws is recorded as a real failure, not unavailable', async () => {
    const sandboxMock = makeSandboxMock({ diffs: ['diff A candidate 0', 'diff B candidate 1'] });
    mockSandboxedEngine(sandboxMock);
    const mgr = makeManagerMock({
      resolvedClient: { complete: async () => { throw new Error('boom'); }, model: 'claude:claude-opus-4-5' },
      throwOnReal: true,
    });
    vi.doMock('../src/core/fleet/manager.js', () => mgr);

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?m522-throw=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ bestOfN: 2, bestOfNJudge: true }));

    expect(result.critique.judge?.status).toBe('real');
    expect(result.critique.judge?.callsAttempted).toBe(2);
    expect(result.critique.judge?.callsFailed).toBe(2);
    for (const c of result.candidates) {
      expect(c.judgeSource).toBe('real');
      expect(c.verdict).toBeUndefined();
      expect(c.score).toBe(0);
    }
    expect(result.winner?.index).toBe(0);
  });

  it('a resolved client whose verdict carries judgeFailure is not treated as a judgment', async () => {
    const sandboxMock = makeSandboxMock({ diffs: ['diff A candidate 0', 'diff B candidate 1'] });
    mockSandboxedEngine(sandboxMock);
    const mgr = makeManagerMock({
      resolvedClient: { complete: async () => '', model: 'claude:claude-opus-4-5' },
      realJudgeFailure: 'network',
    });
    vi.doMock('../src/core/fleet/manager.js', () => mgr);

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?m522-netfail=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ bestOfN: 2, bestOfNJudge: true }));

    expect(result.critique.judge?.status).toBe('real');
    expect(result.critique.judge?.callsFailed).toBe(2);
    for (const c of result.candidates) {
      expect(c.judgeSource).toBe('real');
      expect(c.verdict).toBeUndefined();
      expect(c.score).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. COST-BOUNDING
// ---------------------------------------------------------------------------

describe('M522 — cost-bounded judging', () => {
  it('fewer than 2 materially distinct candidates → judging skipped, resolver never called', async () => {
    // Both candidates produce the IDENTICAL diff — nothing for a judge to
    // differentiate, so the resolver must never be invoked.
    const sandboxMock = makeSandboxMock({ diffs: ['same diff content', 'same diff content'] });
    mockSandboxedEngine(sandboxMock);
    const mgr = makeManagerMock({
      scores: [10, 18],
      resolvedClient: { complete: async () => '{}', model: 'claude:claude-opus-4-5' },
    });
    vi.doMock('../src/core/fleet/manager.js', () => mgr);

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?m522-costbound=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ bestOfN: 2, bestOfNJudge: true }));

    expect(mgr.resolveFrontierJudgeClient).not.toHaveBeenCalled();
    expect(result.critique.judge?.status).toBe('skipped');
    expect(result.critique.judge?.callsAttempted).toBe(0);
    for (const c of result.candidates) {
      expect(c.judgeSource).toBe('skipped');
    }
  });

  it('a single candidate (N=1) never attempts judging even with bestOfNJudge enabled', async () => {
    const sandboxMock = makeSandboxMock({ diffs: ['solo diff'] });
    mockSandboxedEngine(sandboxMock);
    const mgr = makeManagerMock({
      resolvedClient: { complete: async () => '{}', model: 'claude:claude-opus-4-5' },
    });
    vi.doMock('../src/core/fleet/manager.js', () => mgr);

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?m522-n1=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ bestOfN: 1, bestOfNJudge: true }));

    expect(mgr.resolveFrontierJudgeClient).not.toHaveBeenCalled();
    expect(result.critique.judge?.status).toBe('skipped');
  });

  it('two materially distinct candidates DO trigger real judging when enabled', async () => {
    const sandboxMock = makeSandboxMock({ diffs: ['diff A', 'diff B — materially different'] });
    mockSandboxedEngine(sandboxMock);
    const mgr = makeManagerMock({
      scores: [10, 18],
      resolvedClient: { complete: async () => '{}', model: 'claude:claude-opus-4-5' },
    });
    vi.doMock('../src/core/fleet/manager.js', () => mgr);

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?m522-distinct=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ bestOfN: 2, bestOfNJudge: true }));

    expect(mgr.resolveFrontierJudgeClient).toHaveBeenCalled();
    expect(result.critique.judge?.status).toBe('real');
  });

  it('opts.disableJudge overrides cfg.foundry.bestOfNJudge=true', async () => {
    const sandboxMock = makeSandboxMock({ diffs: ['diff A', 'diff B — materially different'] });
    mockSandboxedEngine(sandboxMock);
    const mgr = makeManagerMock({
      scores: [10, 18],
      resolvedClient: { complete: async () => '{}', model: 'claude:claude-opus-4-5' },
    });
    vi.doMock('../src/core/fleet/manager.js', () => mgr);

    const { runBestOfN } = await import('../src/core/run/best-of-n.js?m522-disable=' + randomUUID());
    const result = await runBestOfN(makeItem(), makeConfig({ bestOfN: 2, bestOfNJudge: true }), { disableJudge: true });

    expect(mgr.resolveFrontierJudgeClient).not.toHaveBeenCalled();
    expect(result.critique.judge?.status).toBe('skipped');
  });
});
