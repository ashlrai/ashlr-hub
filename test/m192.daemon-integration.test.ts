/**
 * test/m192.daemon-integration.test.ts — M192: flag-gated hook integration tests.
 *
 * Tests all 4 hooks committed in M185–M189:
 *
 *  Hook 1 — M185 ashlrcodeExecutor
 *    a. flag ON + local-tier backend → runGoal uses sandboxed ashlrcode engine
 *    b. flag OFF → original runGoal path used; legacy runViaAshlrcode NOT called
 *    c. legacy adapter throws → irrelevant; daemon no longer calls it
 *    d. dry-run → NOT called
 *
 *  Hook 2 — M186 generative invent cycle (src/core/generative/invent-cycle.js)
 *    a. flag ON → runInventCycle called once
 *    b. flag OFF (absent) → NOT called
 *    c. throws → tick still returns reason 'ok'
 *    d. dry-run → NOT called
 *
 *  Hook 3 — M187 counterfactual replay (src/core/fleet/counterfactual.js)
 *    a. flag ON + ticks.length % 20 === 0 → runCounterfactualReplay called
 *    b. flag ON + ticks.length % 20 !== 0 → NOT called (cadence guard)
 *    c. flag OFF → NOT called
 *    d. throws → tick still returns reason 'ok'
 *    e. dry-run → NOT called
 *
 *  Hook 4 — M189 regression sentinel (src/core/fleet/regression-sentinel.js)
 *    a. flag ON + no regression → detectRegression called; bisectAndRevert NOT called
 *    b. flag ON + regression detected → detectRegression + bisectAndRevert both called
 *    c. flag OFF → neither called
 *    d. throws → tick still returns reason 'ok'
 *    e. dry-run → NOT called
 *
 * Mirrors m170.daemon-wiring.test.ts exactly — same mocking approach, same
 * H1 fixture for isolated tmp HOME, same auxiliary mocks (routeBackend, quota,
 * subscription-usage, sandboxed-engine, automerge-pass, learned-router).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Core dependency mocks — declared BEFORE lazy imports.
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();
vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

const mockBuildBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
}));

const mockRunGoal = vi.fn();
vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: (...args: unknown[]) => mockRunGoal(...args),
}));

const mockRunBestOfN = vi.fn();
vi.mock('../src/core/run/best-of-n.js', () => ({
  runBestOfN: (...args: unknown[]) => mockRunBestOfN(...args),
}));

const mockRunSelfHealCycle = vi.fn();
vi.mock('../src/core/fleet/self-heal.js', () => ({
  runSelfHealCycle: (...args: unknown[]) => mockRunSelfHealCycle(...args),
  runSelfHealCycleForRepos: (...args: unknown[]) => mockRunSelfHealCycle(...args),
  queueSelfHealItem: () => true,
  pruneQueuedSelfHealItems: () => ({ scanned: 0, removed: 0, failed: false }),
}));

// ---------------------------------------------------------------------------
// M192 hook mocks — the 4 new modules.
// ---------------------------------------------------------------------------

const mockRunViaAshlrcode = vi.fn();
vi.mock('../src/core/run/ashlrcode-engine.js', () => ({
  runViaAshlrcode: (...args: unknown[]) => mockRunViaAshlrcode(...args),
}));

const mockRunInventCycle = vi.fn();
vi.mock('../src/core/generative/invent-cycle.js', () => ({
  runInventCycle: (...args: unknown[]) => mockRunInventCycle(...args),
}));

const mockRunCounterfactualReplay = vi.fn();
vi.mock('../src/core/fleet/counterfactual.js', () => ({
  runCounterfactualReplay: (...args: unknown[]) => mockRunCounterfactualReplay(...args),
}));

const mockDetectRegression = vi.fn();
const mockBisectAndRevert = vi.fn();
vi.mock('../src/core/fleet/regression-sentinel.js', () => ({
  detectRegression: (...args: unknown[]) => mockDetectRegression(...args),
  bisectAndRevert: (...args: unknown[]) => mockBisectAndRevert(...args),
}));

const mockLoadProposal = vi.fn();
vi.mock('../src/core/inbox/store.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/inbox/store.js')>(),
  loadProposal: (...args: unknown[]) => mockLoadProposal(...args),
}));

const mockRecordPostMergeObservation = vi.fn();
vi.mock('../src/core/fleet/post-merge-observations.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/fleet/post-merge-observations.js')>(),
  recordPostMergeObservation: (...args: unknown[]) => mockRecordPostMergeObservation(...args),
}));

// ---------------------------------------------------------------------------
// Auxiliary mocks (identical to m170 pattern).
// ---------------------------------------------------------------------------

const mockRouteBackend = vi.fn();
vi.mock('../src/core/fleet/router.js', () => ({
  routeBackend: (...args: unknown[]) => mockRouteBackend(...args),
}));

vi.mock('../src/core/fleet/quota.js', () => ({
  withinLimit: () => true,
  recordUse: () => undefined,
}));

vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: () => ({ allowed: true }),
  isSubscriptionEngine: () => false,
}));

vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  engineTierOf: () => 'local',   // local tier so ashlrcodeExecutor branch fires
}));

vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: async () => ({ merged: 0 }),
}));

vi.mock('../src/core/run/learned-router.js', () => ({
  recommendRoute: async () => ({ backend: 'builtin', tier: 'local', reason: 'mock' }),
  recoverWithinBudget: (_r: unknown, _c: unknown) => ({
    action: 'proceed',
    decision: { backend: 'builtin', tier: 'local', reason: 'mock' },
  }),
}));

// ---------------------------------------------------------------------------
// Lazy imports — AFTER all mocks.
// ---------------------------------------------------------------------------

import { tick } from '../src/core/daemon/loop.js';
import { saveDaemonState } from '../src/core/daemon/state.js';
import {
  makeFixture,
  makeCfg,
  type H1Fixture,
} from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// Fixture lifecycle.
// ---------------------------------------------------------------------------

let fx: H1Fixture;

beforeEach(() => {
  mockRunSwarm.mockReset();
  mockBuildBacklog.mockReset();
  mockRunGoal.mockReset();
  mockRunBestOfN.mockReset();
  mockRunSelfHealCycle.mockReset();
  mockRunViaAshlrcode.mockReset();
  mockRunInventCycle.mockReset();
  mockRunCounterfactualReplay.mockReset();
  mockDetectRegression.mockReset();
  mockBisectAndRevert.mockReset();
  mockLoadProposal.mockReset();
  mockRecordPostMergeObservation.mockReset();

  fx = makeFixture();

  // Self-heal: always succeed (not under test here).
  mockRunSelfHealCycle.mockResolvedValue({ checked: 0, broken: [], healItems: [] });

  // runGoal: minimal fulfilled run state (frontier non-executor path).
  mockRunGoal.mockResolvedValue({
    id: `mock-rungoal-${Date.now()}`,
    status: 'done',
    usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
  });

  // runBestOfN: not under test here — return benign winner.
  mockRunBestOfN.mockResolvedValue({
    winner: {
      index: 0,
      diff: 'diff --git a/x.ts b/x.ts\n',
      proposalId: `mock-bon-${Date.now()}`,
      score: 10,
      state: {
        id: `mock-bon-run-${Date.now()}`,
        status: 'done',
        usage: { totalTokens: 200, estCostUsd: 0.002, steps: 2 },
      },
    },
    candidates: [],
    critique: { n: 1, nonEmpty: 1, judged: 1, topScore: 10, winnerIndex: 0 },
  });

  // Legacy direct adapter: daemon should no longer call this path.
  mockRunViaAshlrcode.mockResolvedValue({ ok: true });

  // runInventCycle: success.
  mockRunInventCycle.mockResolvedValue({ invented: 0, items: [] });

  // runCounterfactualReplay: success.
  mockRunCounterfactualReplay.mockResolvedValue({ replayed: 0, proposals: [] });

  // detectRegression: no regression by default.
  mockDetectRegression.mockResolvedValue({ regressed: false, details: [] });

  // bisectAndRevert: success.
  mockBisectAndRevert.mockResolvedValue({ reverted: false });
  mockLoadProposal.mockReturnValue(null);

  // buildBacklog: one item per enrolled repo (sufficient to reach dispatcher).
  mockBuildBacklog.mockImplementation(async (opts?: { repos?: string[] }) => {
    const repoDir = (opts?.repos ?? [])[0] ?? '';
    const now = new Date().toISOString();
    return {
      generatedAt: now,
      repos: opts?.repos ?? [],
      items: [
        {
          id: `${repoDir}:m192-item-0`,
          repo: repoDir,
          source: 'todo' as const,
          title: 'M192 test item 0',
          detail: 'Detail for m192 test item 0.',
          value: 3,
          effort: 1,
          score: 3,
          tags: ['m192'],
          ts: now,
        },
      ],
    };
  });

  // runSwarm: builtin backend path (only used when routing to builtin).
  mockRunSwarm.mockResolvedValue({
    id: `mock-swarm-${Date.now()}`,
    status: 'done',
    goal: 'mock goal',
    result: 'mock result',
    usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
  });
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Enroll a repo and force routeBackend to return a non-builtin (frontier) backend. */
function enrollFrontierRepo() {
  const repo = fx.makeRepo();
  repo.enroll();
  // 'claude' is non-builtin → triggers the frontier executor branch.
  mockRouteBackend.mockReturnValue({ backend: 'claude', tier: 'local', reason: 'mock' });
  return repo;
}

/** Enroll a repo and force routeBackend to return the builtin backend. */
function enrollBuiltinRepo() {
  const repo = fx.makeRepo();
  repo.enroll();
  mockRouteBackend.mockReturnValue({ backend: 'builtin', tier: 'local', reason: 'mock' });
  return repo;
}

/** cfg with ashlrcodeExecutor flag ON and a non-builtin backend. */
function makeAcCfg(extra: Record<string, unknown> = {}): AshlrConfig {
  return makeCfg({
    foundry: {
      allowedBackends: [
        'claude' as import('../src/core/types.js').EngineId,
        'ashlrcode' as import('../src/core/types.js').EngineId,
      ],
      ashlrcodeExecutor: true,
      ...extra,
    } as unknown as AshlrConfig['foundry'],
  });
}

/** cfg with a named flag ON (plus a non-builtin backend for item dispatch). */
function makeFlagCfg(flag: string, extra: Record<string, unknown> = {}): AshlrConfig {
  return makeCfg({
    foundry: {
      allowedBackends: ['claude' as import('../src/core/types.js').EngineId],
      [flag]: true,
      ...extra,
    } as unknown as AshlrConfig['foundry'],
  });
}

// ===========================================================================
// Hook 1 — M185: ashlrcodeExecutor
// ===========================================================================

describe('M192 / M185 — ashlrcodeExecutor: flag ON → sandboxed runGoal', () => {
  it('routes through sandboxed runGoal as ashlrcode when flag is ON + local-tier backend', async () => {
    enrollFrontierRepo();
    const result = await tick(makeAcCfg(), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunViaAshlrcode).not.toHaveBeenCalled();
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    const [, , opts] = mockRunGoal.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(opts).toMatchObject({
      engine: 'ashlrcode',
      sandboxEngine: true,
      requireSandbox: true,
    });
  });

  it('preserves work item context on the sandboxed ashlrcode run', async () => {
    const repo = enrollFrontierRepo();
    const cfg = makeAcCfg();

    await tick(cfg, { dryRun: false });

    expect(mockRunViaAshlrcode).not.toHaveBeenCalled();
    const [goal, passedCfg, opts] = mockRunGoal.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(goal).toContain('M192 test item 0');
    expect(passedCfg).toBe(cfg);
    expect(opts).toMatchObject({
      engine: 'ashlrcode',
      cwd: repo.dir,
      workItemId: `${repo.dir}:m192-item-0`,
      workSource: 'todo',
      sandboxEngine: true,
      requireSandbox: true,
    });
  });

  it('flag OFF → runGoal used; runViaAshlrcode NOT called', async () => {
    enrollFrontierRepo();
    // No ashlrcodeExecutor key in cfg.
    const cfg = makeCfg({
      foundry: {
        allowedBackends: ['claude' as import('../src/core/types.js').EngineId],
      } as unknown as AshlrConfig['foundry'],
    });

    await tick(cfg, { dryRun: false });

    expect(mockRunViaAshlrcode).not.toHaveBeenCalled();
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
  });

  it('flag explicitly false → runGoal path; runViaAshlrcode NOT called', async () => {
    enrollFrontierRepo();
    const cfg = makeCfg({
      foundry: {
        allowedBackends: [
          'claude' as import('../src/core/types.js').EngineId,
          'ashlrcode' as import('../src/core/types.js').EngineId,
        ],
        ashlrcodeExecutor: false,
      } as unknown as AshlrConfig['foundry'],
    });

    await tick(cfg, { dryRun: false });

    expect(mockRunViaAshlrcode).not.toHaveBeenCalled();
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
  });

  it('flag ON but ashlrcode disallowed → original runGoal path is preserved', async () => {
    enrollFrontierRepo();
    const result = await tick(makeAcCfg({
      allowedBackends: ['claude' as import('../src/core/types.js').EngineId],
    }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunViaAshlrcode).not.toHaveBeenCalled();
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    const [, , opts] = mockRunGoal.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(opts.engine).toBe('claude');
  });

  it('legacy runViaAshlrcode failure is ignored because daemon no longer calls it', async () => {
    enrollFrontierRepo();
    mockRunViaAshlrcode.mockRejectedValue(new Error('ashlrcode exploded'));

    const result = await tick(makeAcCfg(), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunViaAshlrcode).not.toHaveBeenCalled();
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    const [, , opts] = mockRunGoal.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(opts.engine).toBe('ashlrcode');
    expect(typeof result.proposalsCreated).toBe('number');
  });

  it('dry-run → runViaAshlrcode NOT called', async () => {
    enrollFrontierRepo();

    const result = await tick(makeAcCfg(), { dryRun: true });

    expect(result.reason).toBe('dry-run');
    expect(mockRunViaAshlrcode).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Hook 2 — M186: generative invent cycle
// ===========================================================================

describe('M192 / M186 — generative invent cycle: flag ON → runInventCycle', () => {
  it('calls runInventCycle exactly once when generative=true', async () => {
    enrollBuiltinRepo();

    await tick(makeFlagCfg('generative'), { dryRun: false });

    expect(mockRunInventCycle).toHaveBeenCalledTimes(1);
  });

  it('passes cfg to runInventCycle', async () => {
    enrollBuiltinRepo();
    const cfg = makeFlagCfg('generative');

    await tick(cfg, { dryRun: false });

    const [passedCfg] = mockRunInventCycle.mock.calls[0] as [unknown];
    expect(passedCfg).toBe(cfg);
  });

  it('flag absent → runInventCycle NOT called', async () => {
    enrollBuiltinRepo();

    await tick(makeCfg({}), { dryRun: false });

    expect(mockRunInventCycle).not.toHaveBeenCalled();
  });

  it('flag false → runInventCycle NOT called', async () => {
    enrollBuiltinRepo();
    const cfg = makeCfg({
      foundry: { generative: false } as unknown as AshlrConfig['foundry'],
    });

    await tick(cfg, { dryRun: false });

    expect(mockRunInventCycle).not.toHaveBeenCalled();
  });

  it('runInventCycle throws → tick still returns reason ok', async () => {
    enrollBuiltinRepo();
    mockRunInventCycle.mockRejectedValue(new Error('invent exploded'));

    const result = await tick(makeFlagCfg('generative'), { dryRun: false });

    expect(result.reason).toBe('ok');
  });

  it('dry-run → runInventCycle NOT called', async () => {
    enrollBuiltinRepo();

    const result = await tick(makeFlagCfg('generative'), { dryRun: true });

    expect(result.reason).toBe('dry-run');
    expect(mockRunInventCycle).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Hook 3 — M187: counterfactual replay (every-20-ticks cadence)
// ===========================================================================

describe('M192 / M187 — counterfactual replay: flag ON + cadence', () => {
  it('calls runCounterfactualReplay when counterfactual=true and ticks.length % 20 === 0', async () => {
    enrollBuiltinRepo();
    // Seed state so ticks.length is exactly 0 (0 % 20 === 0).
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: new Date().toISOString().slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });

    await tick(makeFlagCfg('counterfactual'), { dryRun: false });

    expect(mockRunCounterfactualReplay).toHaveBeenCalledTimes(1);
  });

  it('does NOT call runCounterfactualReplay when ticks.length % 20 !== 0', async () => {
    enrollBuiltinRepo();
    // Seed 1 prior tick so ticks.length === 1 (1 % 20 !== 0).
    const fakeTickRecord = {
      ts: new Date().toISOString(),
      reason: 'ok' as const,
      proposalsCreated: 0,
      spentUsd: 0,
      durationMs: 10,
    };
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: new Date().toISOString().slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [fakeTickRecord],
    });

    await tick(makeFlagCfg('counterfactual'), { dryRun: false });

    expect(mockRunCounterfactualReplay).not.toHaveBeenCalled();
  });

  it('flag absent → NOT called regardless of tick cadence', async () => {
    enrollBuiltinRepo();
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: new Date().toISOString().slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });

    await tick(makeCfg({}), { dryRun: false });

    expect(mockRunCounterfactualReplay).not.toHaveBeenCalled();
  });

  it('runCounterfactualReplay throws → tick still returns reason ok', async () => {
    enrollBuiltinRepo();
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: new Date().toISOString().slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });
    mockRunCounterfactualReplay.mockRejectedValue(new Error('counterfactual exploded'));

    const result = await tick(makeFlagCfg('counterfactual'), { dryRun: false });

    expect(result.reason).toBe('ok');
  });

  it('dry-run → runCounterfactualReplay NOT called', async () => {
    enrollBuiltinRepo();
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: new Date().toISOString().slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });

    const result = await tick(makeFlagCfg('counterfactual'), { dryRun: true });

    expect(result.reason).toBe('dry-run');
    expect(mockRunCounterfactualReplay).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Hook 4 — M189: regression sentinel
// ===========================================================================

describe('M192 / M189 — regression sentinel: flag ON → detectRegression', () => {
  it('calls detectRegression exactly once when regressionSentinel=true', async () => {
    enrollBuiltinRepo();

    await tick(makeFlagCfg('regressionSentinel'), { dryRun: false });

    expect(mockDetectRegression).toHaveBeenCalledTimes(1);
  });

  it('does NOT call bisectAndRevert when detectRegression returns regressed=false', async () => {
    enrollBuiltinRepo();
    mockDetectRegression.mockResolvedValue({ regressed: false, details: [] });

    await tick(makeFlagCfg('regressionSentinel'), { dryRun: false });

    expect(mockDetectRegression).toHaveBeenCalledTimes(1);
    expect(mockBisectAndRevert).not.toHaveBeenCalled();
  });

  it('calls bisectAndRevert when detectRegression returns regressed=true', async () => {
    enrollBuiltinRepo();
    mockDetectRegression.mockResolvedValue({ regressed: true, details: ['sha-abc'] });

    await tick(makeFlagCfg('regressionSentinel'), { dryRun: false });

    expect(mockDetectRegression).toHaveBeenCalledTimes(1);
    expect(mockBisectAndRevert).toHaveBeenCalledTimes(1);
  });

  it('accepts an explicit sentinel config object and records its causal first-bad merge', async () => {
    const repo = enrollBuiltinRepo();
    const culprit = 'a'.repeat(40);
    const observedHead = 'b'.repeat(40);
    const baselineHead = 'c'.repeat(40);
    mockDetectRegression.mockResolvedValue({ regressed: true, details: [culprit] });
    mockBisectAndRevert.mockResolvedValue({
      culprit,
      observedHead,
      baselineHead,
      candidateCount: 3,
      basis: 'bisect-first-bad',
      revertProposal: { culprit, culpritProposalId: 'proposal-causal', proposal: {} },
    });
    mockLoadProposal.mockReturnValue({
      id: 'proposal-causal',
      repo: repo.dir,
      runId: 'run-causal',
      trajectoryId: 'trajectory-causal',
      workItemId: 'work-causal',
      verifyResult: { ran: [{ kind: 'typecheck' }, { kind: 'test' }] },
    });
    const cfg = makeCfg({
      foundry: {
        allowedBackends: ['claude' as import('../src/core/types.js').EngineId],
        regressionSentinel: { minConsecutive: 3 },
      } as unknown as AshlrConfig['foundry'],
    });

    await tick(cfg, { dryRun: false });

    expect(mockDetectRegression).toHaveBeenCalledOnce();
    expect(mockBisectAndRevert).toHaveBeenCalledOnce();
    expect(mockLoadProposal).toHaveBeenCalledWith('proposal-causal');
    expect(mockRecordPostMergeObservation).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'regressed',
      basis: 'bisect-first-bad',
      confidence: 'heuristic',
      proposalId: 'proposal-causal',
      runId: 'run-causal',
      trajectoryId: 'trajectory-causal',
      workItemId: 'work-causal',
      mergeCommit: culprit,
      observedHead,
      baselineHead,
      candidateCount: 3,
      commandKinds: ['test', 'typecheck'],
    }));
  });

  it('passes cfg to detectRegression', async () => {
    enrollBuiltinRepo();
    const cfg = makeFlagCfg('regressionSentinel');

    await tick(cfg, { dryRun: false });

    const [passedCfg] = mockDetectRegression.mock.calls[0] as [unknown];
    expect(passedCfg).toBe(cfg);
  });

  it('flag absent → neither detectRegression nor bisectAndRevert called', async () => {
    enrollBuiltinRepo();

    await tick(makeCfg({}), { dryRun: false });

    expect(mockDetectRegression).not.toHaveBeenCalled();
    expect(mockBisectAndRevert).not.toHaveBeenCalled();
  });

  it('flag false → neither called', async () => {
    enrollBuiltinRepo();
    const cfg = makeCfg({
      foundry: { regressionSentinel: false } as unknown as AshlrConfig['foundry'],
    });

    await tick(cfg, { dryRun: false });

    expect(mockDetectRegression).not.toHaveBeenCalled();
    expect(mockBisectAndRevert).not.toHaveBeenCalled();
  });

  it('detectRegression throws → tick still returns reason ok; bisectAndRevert NOT called', async () => {
    enrollBuiltinRepo();
    mockDetectRegression.mockRejectedValue(new Error('detect exploded'));

    const result = await tick(makeFlagCfg('regressionSentinel'), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockBisectAndRevert).not.toHaveBeenCalled();
  });

  it('bisectAndRevert throws → tick still returns reason ok', async () => {
    enrollBuiltinRepo();
    mockDetectRegression.mockResolvedValue({ regressed: true, details: ['sha-abc'] });
    mockBisectAndRevert.mockRejectedValue(new Error('revert exploded'));

    const result = await tick(makeFlagCfg('regressionSentinel'), { dryRun: false });

    expect(result.reason).toBe('ok');
  });

  it('dry-run → detectRegression NOT called', async () => {
    enrollBuiltinRepo();

    const result = await tick(makeFlagCfg('regressionSentinel'), { dryRun: true });

    expect(result.reason).toBe('dry-run');
    expect(mockDetectRegression).not.toHaveBeenCalled();
    expect(mockBisectAndRevert).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Cross-hook invariant: all 4 flags ON simultaneously — tick still completes
// ===========================================================================

describe('M192 — all 4 flags ON simultaneously: tick completes cleanly', () => {
  it('all hooks called once, tick returns reason ok', async () => {
    enrollBuiltinRepo();
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: new Date().toISOString().slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });
    const cfg = makeCfg({
      foundry: {
        generative: true,
        counterfactual: true,
        regressionSentinel: true,
        // ashlrcodeExecutor only fires on non-builtin backend — skip here to
        // avoid mixing executor + builtin routing in the same tick.
      } as unknown as AshlrConfig['foundry'],
    });

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunInventCycle).toHaveBeenCalledTimes(1);
    expect(mockRunCounterfactualReplay).toHaveBeenCalledTimes(1);
    expect(mockDetectRegression).toHaveBeenCalledTimes(1);
  });

  it('all hooks throw simultaneously — tick still returns a valid DaemonTick', async () => {
    enrollBuiltinRepo();
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: new Date().toISOString().slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });
    mockRunInventCycle.mockRejectedValue(new Error('invent chaos'));
    mockRunCounterfactualReplay.mockRejectedValue(new Error('counterfactual chaos'));
    mockDetectRegression.mockRejectedValue(new Error('sentinel chaos'));
    const cfg = makeCfg({
      foundry: {
        generative: true,
        counterfactual: true,
        regressionSentinel: true,
      } as unknown as AshlrConfig['foundry'],
    });

    const result = await tick(cfg, { dryRun: false });

    expect(typeof result.ts).toBe('string');
    expect(new Date(result.ts).toISOString()).toBe(result.ts);
    expect(typeof result.proposalsCreated).toBe('number');
    expect(typeof result.spentUsd).toBe('number');
  });
});
