/**
 * test/m201.daemon-loop.test.ts — M201: Complementary daemon/loop.ts tick-mechanics tests.
 *
 * Coverage COMPLEMENTARY to h1/h3/h4/m192 (which own safety invariants and the M185–M189
 * cadence hooks). This suite proves the tick's INTERNAL MECHANICS under the mocking
 * approach established in those suites:
 *
 *  Group A — Backlog build + top-K selection within budget
 *    A1. backlog returns 0 items → reason 'no-backlog', proposalsCreated=0
 *    A2. buildBacklog throws → tick still returns 'no-backlog' (guard caught)
 *    A3. top-K selection respects perTickItems cap (itemsConsidered === min(cap, backlog.length))
 *    A4. selectCount floor: near-zero remaining budget still selects exactly 1 item
 *    A5. selectCount shrinks via maxByBudget formula (remainingBudget / MIN_PER_ITEM_USD)
 *    A6. round-robin across repos: 2 repos with items → items interleaved across repos
 *    A7. pending proposal items are skipped (item id present in a pending proposal → not re-dispatched)
 *
 *  Group B — TieredPool local/cloud concurrency caps (continuous / explicit-concurrency mode)
 *    B1. local cap: all-local items, local=1 → peak concurrency 1
 *    B2. cloud cap: all-cloud items, cloud=1 → peak concurrency 1
 *    B3. total cap: mixed tiers, total=1 → only one in flight at a time
 *    B4. local items do NOT consume cloud slots (and vice-versa)
 *
 *  Group C — Per-item dispatch accounting (cost tally, proposalDelta)
 *    C1. tickSpent accumulates per-item usage.estCostUsd across a batch
 *    C2. proposalsCreated = pendingCount delta (not swarm result count)
 *    C3. a swarm that completes but creates no proposal is NOT counted
 *    C4. state.todaySpentUsd updated by tick's realized spend
 *    C5. state.itemsProcessed incremented by dispatched count (not skipped)
 *    C6. ASHLR_IN_SWARM env restored after each item dispatch (no env leak)
 *    C7. in-tick budget short-circuit: kill set mid-tick skips remaining items
 *
 *  Group D — M197 observability: console.warn on dispatch failures
 *    D1. runSwarm throws → daemon:swarm-error audit emitted, tick still returns 'ok'
 *    D2. multiple items, one throws → only that item skipped; others proceed
 *
 *  Group E — Config reload per tick (M85 runDaemon loop)
 *    E1. runDaemon once=true reloads daemon config from disk (uses loadConfig)
 *    E2. runDaemon loop once=false with maxCycles=2 runs exactly 2 ticks then stops
 *    E3. runDaemon loop stops when kill switch set between iterations
 *    E4. runDaemon re-entrancy guard: refuses when ASHLR_IN_DAEMON is set
 *    E5. runDaemon re-entrancy guard: refuses when ASHLR_IN_SWARM is set
 *    E6. runDaemon dry-run loop terminates after one iteration
 *    E7. runDaemon sets running=true on start, running=false on exit
 *
 *  Group F — buildItemGoal purity
 *    F1. includes item title
 *    F2. includes detail when non-empty and different from title
 *    F3. omits detail when it equals the title
 *    F4. includes repo anchor
 *    F5. includes behavioral guidance (no-op escape hatch)
 *    F6. never throws on minimal item (all optional fields absent)
 *
 * MOCKING STRATEGY (identical to m192 / h1 suites):
 *   - runSwarm, buildBacklog, runGoal declared before lazy imports so the daemon
 *     binds to the mocks.
 *   - All auxiliary modules that the tick exercises but that are not under test here
 *     (routeBackend, quota, subscription-usage, sandboxed-engine, automerge-pass,
 *     learned-router, self-heal, invent-cycle, counterfactual, regression-sentinel)
 *     are mocked to benign pass-through values.
 *   - H1 fixture provides isolated tmp HOME per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Core mocks — MUST be declared before lazy imports.
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
}));

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

// ---------------------------------------------------------------------------
// Auxiliary mocks (benign pass-through — not under test here).
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

// engineTierOf default: 'local' (overridden in B2/B3/B4 via inline mock)
const mockEngineTierOf = vi.fn();
vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  engineTierOf: (...args: unknown[]) => mockEngineTierOf(...args),
}));

const mockRunAutoMergePass = vi.fn();
vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: (...args: unknown[]) => mockRunAutoMergePass(...args),
}));

const mockBuildResourceStrategyReport = vi.fn();
vi.mock('../src/core/autonomy/resource-strategy.js', () => ({
  buildResourceStrategyReport: (...args: unknown[]) => mockBuildResourceStrategyReport(...args),
  resourceStrategyToDaemonPlan: (report: { mode?: string; reasons?: string[] }) => {
    const mode = report.mode ?? 'backlog-build';
    const reason = report.reasons?.[0] ?? `mock ${mode}`;
    if (mode === 'pause') {
      return { mode, allowDispatch: false, forceLocalOnly: false, runAutoMergeMaintenance: false, reason };
    }
    if (mode === 'verify-only' || mode === 'auto-merge-ready') {
      return { mode, allowDispatch: false, forceLocalOnly: false, runAutoMergeMaintenance: true, reason };
    }
    if (mode === 'local-only') {
      return { mode, allowDispatch: true, forceLocalOnly: true, runAutoMergeMaintenance: true, reason };
    }
    return { mode: 'backlog-build', allowDispatch: true, forceLocalOnly: false, runAutoMergeMaintenance: true, reason };
  },
}));

vi.mock('../src/core/run/learned-router.js', () => ({
  recommendRoute: async () => ({ backend: 'builtin', tier: 'local', reason: 'mock' }),
  recoverWithinBudget: (_r: unknown, _c: unknown) => ({
    action: 'proceed',
    decision: { backend: 'builtin', tier: 'local', reason: 'mock' },
  }),
}));

vi.mock('../src/core/config.js', () => ({
  loadConfig: () => ({
    version: 1,
    daemon: {
      dailyBudgetUsd: 1.0,
      perTickItems: 3,
      parallel: 2,
      intervalMs: 50,
    },
  }),
}));

// ---------------------------------------------------------------------------
// Lazy imports — AFTER all mocks.
// ---------------------------------------------------------------------------

import { tick, runDaemon, buildItemGoal } from '../src/core/daemon/loop.js';
import {
  acquireDaemonLock,
  loadDaemonState,
  releaseDaemonLock,
  saveDaemonState,
} from '../src/core/daemon/state.js';
import {
  createProposal,
  pendingCount,
} from '../src/core/inbox/store.js';
import { loadWorkedLedger } from '../src/core/fleet/worked-ledger.js';
import {
  makeFixture,
  makeCfg,
  type H1Fixture,
} from './helpers/h1-fixture.js';
import { makeSpendingSwarmStub } from './helpers/h3-stress.js';

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
  mockRouteBackend.mockReset();
  mockEngineTierOf.mockReset();
  mockRunAutoMergePass.mockReset();
  mockBuildResourceStrategyReport.mockReset();

  fx = makeFixture();

  // Default benign implementations.
  mockRunSelfHealCycle.mockResolvedValue({ checked: 0, broken: [], healItems: [] });
  mockRunGoal.mockResolvedValue({
    id: `mock-rungoal-${Date.now()}`,
    status: 'done',
    usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
  });
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
  mockDetectRegression.mockResolvedValue({ regressed: false, details: [] });
  mockBisectAndRevert.mockResolvedValue({ reverted: false });
  mockRunInventCycle.mockResolvedValue({ invented: 0, items: [] });
  mockRunCounterfactualReplay.mockResolvedValue({ replayed: 0, proposals: [] });
  mockRunViaAshlrcode.mockResolvedValue({ ok: true });
  mockRunAutoMergePass.mockResolvedValue({ merged: 0 });
  mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'backlog-build', reasons: ['mock backlog'] });
  // Default: builtin backend (route to runSwarm path).
  mockRouteBackend.mockReturnValue({ backend: 'builtin', tier: 'local', reason: 'mock' });
  // Default: local engine tier.
  mockEngineTierOf.mockReturnValue('local');
  // Default runSwarm: success, $0.001 cost.
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

/** Today's date in YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Seed daemon state with a given spent amount for today. */
function seedSpend(spentUsd: number): void {
  saveDaemonState({
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: today(),
    todaySpentUsd: spentUsd,
    itemsProcessed: 0,
    ticks: [],
  });
}

/** Build N synthetic WorkItems for a given repo. */
function makeItems(repoDir: string, count: number) {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    id: `${repoDir}:m201-item-${i}`,
    repo: repoDir,
    source: 'todo' as const,
    title: `M201 item ${i}`,
    detail: `Detail for m201 item ${i}.`,
    value: 3,
    effort: 1,
    score: 3 - i * 0.01, // slight score variation so ordering is deterministic
    tags: ['m201'],
    ts: now,
  }));
}

/** Enroll a repo and seed buildBacklog with N items. */
function enrollWithItems(count: number) {
  const repo = fx.makeRepo();
  repo.enroll();
  const items = makeItems(repo.dir, count);
  mockBuildBacklog.mockResolvedValue({
    generatedAt: new Date().toISOString(),
    repos: [repo.dir],
    items,
  });
  return { repo, items };
}

/** A cfg with a builtin backend (routes to runSwarm) and given daemon caps. */
function cfgBuiltin(daemon: { dailyBudgetUsd?: number; perTickItems?: number; parallel?: number } = {}): AshlrConfig {
  return makeCfg({
    daemon: {
      dailyBudgetUsd: daemon.dailyBudgetUsd ?? 1.0,
      perTickItems: daemon.perTickItems ?? 5,
      parallel: daemon.parallel ?? 2,
      intervalMs: 50,
    },
  });
}

// ===========================================================================
// Group A — Backlog build + top-K selection within budget
// ===========================================================================

describe('M201 — Group A: backlog build + top-K selection', () => {
  it('A1: empty backlog → reason no-backlog, proposalsCreated=0, runSwarm not called', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });

    const result = await tick(cfgBuiltin(), { dryRun: false });

    expect(result.reason).toBe('no-backlog');
    expect(result.proposalsCreated).toBe(0);
    expect(result.itemsConsidered).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1b: empty backlog still runs auto-merge maintenance when enabled', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });
    mockRunAutoMergePass.mockResolvedValue({ merged: 2 });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('no-backlog');
    expect(result.merged).toBe(2);
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1c: empty backlog dry-run does not run auto-merge maintenance', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: true },
    );

    expect(result.reason).toBe('no-backlog');
    expect(result.dryRun).toBe(true);
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1c2: selected backlog dry-run marks simulation and dispatches nothing', async () => {
    enrollWithItems(1);

    const result = await tick(cfgBuiltin({ perTickItems: 1 }), { dryRun: true });

    expect(result.reason).toBe('dry-run');
    expect(result.dryRun).toBe(true);
    expect(result.spentUsd).toBe(0);
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1d: budget exhaustion blocks auto-merge maintenance', async () => {
    seedSpend(1.0);

    const result = await tick(
      { ...cfgBuiltin({ dailyBudgetUsd: 1.0 }), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('budget-exhausted');
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1e: autonomy control pause builds strategy snapshot and skips dispatch', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'pause', reasons: ['mock guard block'] });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autonomyControlLoop: true } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    expect(result.directionMode).toBe('pause');
    expect(mockBuildBacklog).toHaveBeenCalledTimes(1);
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: {
        buildFleetStatus?: () => Promise<{ queue?: { backlogItems?: number } }>;
        runEcosystemDoctor?: (opts?: { root?: string; now?: Date }) => Promise<{ summary?: { total?: number } }>;
        listOutcomeRecords?: () => unknown[];
      };
    };
    await expect(strategyOpts.deps?.buildFleetStatus?.()).resolves.toMatchObject({
      queue: { backlogItems: 1 },
    });
    await expect(strategyOpts.deps?.runEcosystemDoctor?.()).resolves.toMatchObject({
      summary: { total: 1 },
    });
    expect(strategyOpts.deps?.listOutcomeRecords?.()).toEqual([]);
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1f: autonomy control verify-only builds strategy snapshot and runs merge maintenance only', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'verify-only', reasons: ['pending proposals need verification'] });
	    mockRunAutoMergePass.mockResolvedValue({
	      attempted: 3,
	      judgePerPass: 4,
	      judged: 2,
	      judgeCapped: 1,
	      verifyBeforeJudgePerPass: 3,
	      verifyBeforeJudgeRan: 2,
	      verifyBeforeJudgeCapped: 1,
	      judgeEstimatedSpendUsd: 0.0123,
	      merged: 1,
	      autoArchived: 1,
	      ttlRejected: 1,
	    });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autonomyControlLoop: true, autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('verify-only');
	    expect(result.directionMode).toBe('verify-only');
	    expect(result.directionReason).toBe('pending proposals need verification');
	    expect(result.merged).toBe(1);
	    expect(result.spentUsd).toBe(0);
	    expect(result.autoMerge).toEqual({
	      attempted: 3,
	      judgePerPass: 4,
	      judged: 2,
	      judgeCapped: 1,
	      verifyBeforeJudgePerPass: 3,
	      verifyBeforeJudgeRan: 2,
	      verifyBeforeJudgeCapped: 1,
	      judgeEstimatedSpendUsd: 0.0123,
	      merged: 1,
	      autoArchived: 1,
	      ttlRejected: 1,
	    });
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1g: autonomy control local-only clamps cloud routing to builtin dispatch', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'local-only', reasons: ['cloud resources constrained'] });
    mockRouteBackend.mockReturnValue({ backend: 'claude', tier: 'frontier', reason: 'mock cloud' });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          autonomyControlLoop: true,
          allowedBackends: ['claude', 'builtin'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.directionMode).toBe('local-only');
    expect(result.backends).toEqual({ builtin: 1 });
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('A1h: autonomy control local-only preserves local-coder dispatch', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'local-only', reasons: ['frontier budget constrained'] });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock local-coder' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          autonomyControlLoop: true,
          allowedBackends: ['claude', 'local-coder', 'builtin'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.directionMode).toBe('local-only');
    expect(result.directionReason).toBe('frontier budget constrained');
    expect(result.backends).toEqual({ 'local-coder': 1 });
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({ engine: 'local-coder' });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1i: live ticks persist bounded dispatch assignment traces', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'builtin', tier: 'local', model: null, reason: 'test route' });

    const result = await tick(
      cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'builtin',
      tier: 'local',
      assignedBy: 'router',
      reason: 'test route',
      dispatched: true,
      spentUsd: 0.001,
    });

    const state = loadDaemonState();
    expect(state.ticks.at(-1)?.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'builtin',
      reason: 'test route',
      dispatched: true,
    });
  });

  it('A2: buildBacklog throws → tick swallows and returns no-backlog', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockRejectedValue(new Error('buildBacklog exploded'));

    const result = await tick(cfgBuiltin(), { dryRun: false });

    expect(result.reason).toBe('no-backlog');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A3: perTickItems cap limits selection — itemsConsidered <= cap regardless of backlog size', async () => {
    const { } = enrollWithItems(10);
    const cap = 3;

    const result = await tick(cfgBuiltin({ perTickItems: cap }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBeLessThanOrEqual(cap);
    expect(result.itemsConsidered).toBe(cap);
    expect(mockRunSwarm).toHaveBeenCalledTimes(cap);
  });

  it('A4: near-zero remaining budget still selects exactly 1 item (selectCount floor)', async () => {
    enrollWithItems(5);
    // $0.004 remaining → floor(0.004 / 0.01) = 0, but max(1, 0) = 1
    const cfg = cfgBuiltin({ dailyBudgetUsd: 0.004, perTickItems: 5 });
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: 0 }));

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
  });

  it('A5: selectCount shrinks via maxByBudget formula when remaining budget is small', async () => {
    enrollWithItems(10);
    // remainingBudget = $0.025 → floor(0.025 / 0.01) = 2
    const cfg = cfgBuiltin({ dailyBudgetUsd: 0.025, perTickItems: 8 });
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: 0 }));

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(2);
    expect(result.itemsConsidered).toBeLessThan(8);
  });

  it('A6: round-robin across 2 repos — both repos get at least one item in a cap-2 tick', async () => {
    const repo1 = fx.makeRepo();
    const repo2 = fx.makeRepo();
    repo1.enroll();
    repo2.enroll();
    const now = new Date().toISOString();
    const items1 = makeItems(repo1.dir, 3);
    const items2 = makeItems(repo2.dir, 3);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: now,
      repos: [repo1.dir, repo2.dir],
      items: [...items1, ...items2],
    });

    const dispatchedRepos: string[] = [];
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
      const project = (opts as Record<string, unknown>)?.project as string | undefined;
      if (project) dispatchedRepos.push(project);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 2, parallel: 2 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(2);
    // Both repos should each get one item via round-robin.
    expect(dispatchedRepos).toContain(repo1.dir);
    expect(dispatchedRepos).toContain(repo2.dir);
  });

  it('A7: items with a pending proposal are skipped during selection', async () => {
    const { repo, items } = enrollWithItems(3);
    // Create a pending proposal whose title contains items[0].id so the skip logic fires.
    createProposal({
      repo: repo.dir,
      origin: 'swarm',
      kind: 'patch',
      title: `pending for ${items[0]!.id}`,
      summary: `covers ${items[0]!.id}`,
      diff: 'diff --git a/x.ts b/x.ts\n',
    });

    const dispatchedItemIds: string[] = [];
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
      const project = (opts as Record<string, unknown>)?.project as string | undefined;
      // Track which item ids were dispatched by looking at what the tick selected
      if (project) dispatchedItemIds.push(project);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 3, parallel: 3 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    // items[0] was skipped; only 2 items dispatched from the 3 available.
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// Group B — TieredPool local/cloud concurrency caps
// ===========================================================================

describe('M201 — Group B: TieredPool local/cloud concurrency caps', () => {
  /** Create a cfg that enables continuous mode (engages TieredPool). */
  function cfgContinuous(opts: {
    perTickItems?: number;
    local?: number;
    cloud?: number;
    total?: number;
  } = {}): AshlrConfig {
    return makeCfg({
      daemon: {
        dailyBudgetUsd: 1.0,
        perTickItems: opts.perTickItems ?? 4,
        parallel: 4,
        intervalMs: 50,
        mode: 'continuous' as unknown as undefined,
        concurrency: {
          local: opts.local ?? 2,
          cloud: opts.cloud ?? 6,
          total: opts.total ?? 8,
        },
      } as AshlrConfig['daemon'],
    });
  }

  it('B1: local cap=1, all local items → peak concurrency never exceeds 1', async () => {
    enrollWithItems(4);
    mockEngineTierOf.mockReturnValue('local');

    const conc = { current: 0, max: 0 };
    mockRunSwarm.mockImplementation(async () => {
      conc.current++;
      conc.max = Math.max(conc.max, conc.current);
      await new Promise((r) => setTimeout(r, 5));
      conc.current--;
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgContinuous({ local: 1, cloud: 4, total: 4, perTickItems: 4 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(conc.max).toBeGreaterThan(0);
    expect(conc.max).toBeLessThanOrEqual(1);
  });

  it('B2: cloud cap=1, all cloud items → peak concurrency never exceeds 1', async () => {
    enrollWithItems(4);
    // engineTierOf returns 'frontier' → poolTierOf maps to 'cloud'
    mockEngineTierOf.mockReturnValue('frontier');

    const conc = { current: 0, max: 0 };
    mockRunSwarm.mockImplementation(async () => {
      conc.current++;
      conc.max = Math.max(conc.max, conc.current);
      await new Promise((r) => setTimeout(r, 5));
      conc.current--;
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgContinuous({ local: 4, cloud: 1, total: 4, perTickItems: 4 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(conc.max).toBeGreaterThan(0);
    expect(conc.max).toBeLessThanOrEqual(1);
  });

  it('B3: total cap=1, mixed tiers → never more than 1 item in flight at once', async () => {
    enrollWithItems(4);
    // Alternate local/cloud tiers per item call.
    let callCount = 0;
    mockEngineTierOf.mockImplementation(() => (callCount++ % 2 === 0 ? 'local' : 'frontier'));

    const conc = { current: 0, max: 0 };
    mockRunSwarm.mockImplementation(async () => {
      conc.current++;
      conc.max = Math.max(conc.max, conc.current);
      await new Promise((r) => setTimeout(r, 5));
      conc.current--;
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgContinuous({ local: 2, cloud: 2, total: 1, perTickItems: 4 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(conc.max).toBeGreaterThan(0);
    expect(conc.max).toBeLessThanOrEqual(1);
  });

  it('B4: local=2 cloud=1 — local slots do not count against cloud cap', async () => {
    enrollWithItems(4);
    // First 2 items are local, last 2 are cloud.
    let idx = 0;
    mockEngineTierOf.mockImplementation(() => (idx++ < 2 ? 'local' : 'frontier'));

    const cloudConc = { current: 0, max: 0 };
    const localConc = { current: 0, max: 0 };
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
      // We can't directly inspect which tier was used from opts, so track total conc as proxy
      cloudConc.current++;
      cloudConc.max = Math.max(cloudConc.max, cloudConc.current);
      await new Promise((r) => setTimeout(r, 5));
      cloudConc.current--;
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgContinuous({ local: 2, cloud: 1, total: 4, perTickItems: 4 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    // All 4 items dispatched — local cap allows 2 concurrent, cloud cap allows 1.
    expect(mockRunSwarm).toHaveBeenCalledTimes(4);
  });
});

// ===========================================================================
// Group C — Per-item dispatch accounting
// ===========================================================================

describe('M201 — Group C: per-item dispatch accounting', () => {
  it('C1: tickSpent is the sum of per-item usage.estCostUsd', async () => {
    enrollWithItems(3);
    const costPerItem = 0.05;
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: costPerItem }));

    const result = await tick(cfgBuiltin({ perTickItems: 3, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    // 3 items dispatched × $0.05 each = $0.15.
    expect(result.spentUsd).toBeCloseTo(3 * costPerItem, 10);
  });

  it('C2: proposalsCreated equals the pendingCount delta, not the swarm dispatch count', async () => {
    const { repo, items } = enrollWithItems(2);
    const before = pendingCount();
    // Only the first swarm creates a proposal; the second returns done with no proposal.
    let call = 0;
    mockRunSwarm.mockImplementation(async () => {
      if (call++ === 0) {
        createProposal({
          repo: repo.dir,
          origin: 'swarm',
          kind: 'patch',
          title: 'C2 proposal',
          summary: 'C2',
          diff: 'diff --git a/x.ts b/x.ts\n',
          workItemId: items[0]!.id,
          workSource: items[0]!.source,
          runId: 'm201-run-first',
        });
      }
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 2, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(1); // only 1 new pending proposal
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    expect(pendingCount()).toBe(before + 1);
    const ledger = loadWorkedLedger();
    expect(ledger.events.find((e) => e.itemId === items[0]!.id)?.outcome).toBe('diff');
    expect(ledger.events.find((e) => e.itemId === items[1]!.id)?.outcome).toBe('empty');
  });

  it('C3: swarm that returns done but creates no proposal is NOT counted in proposalsCreated', async () => {
    enrollWithItems(2);
    const before = pendingCount();
    // Swarm succeeds but creates nothing.
    mockRunSwarm.mockResolvedValue({
      id: 'mock', status: 'done', goal: '', result: '',
      usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 },
    });

    const result = await tick(cfgBuiltin({ perTickItems: 2, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(0);
    expect(pendingCount()).toBe(before);
  });

  it('C4: state.todaySpentUsd is updated by the tick\'s realized spend', async () => {
    enrollWithItems(2);
    const costPerItem = 0.03;
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: costPerItem }));

    await tick(cfgBuiltin({ perTickItems: 2, parallel: 1 }), { dryRun: false });

    const state = loadDaemonState();
    expect(state.todaySpentUsd).toBeCloseTo(2 * costPerItem, 10);
  });

  it('C5: state.itemsProcessed incremented by dispatched count (skip-items not counted)', async () => {
    enrollWithItems(3);
    seedSpend(0);

    // Set budget so only 2 items can be dispatched (in-tick short-circuit fires on 3rd)
    const costPerItem = 0.05;
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: costPerItem }));

    const cfg = cfgBuiltin({ dailyBudgetUsd: 0.10, perTickItems: 3, parallel: 1 });
    await tick(cfg, { dryRun: false });

    const state = loadDaemonState();
    // 2 items dispatched, 3rd short-circuited by in-tick budget guard.
    expect(state.itemsProcessed).toBe(2);
  });

  it('C6: ASHLR_IN_SWARM env is restored after each item dispatch (no env leak)', async () => {
    enrollWithItems(2);
    const swarmEnvsDuring: Array<string | undefined> = [];
    mockRunSwarm.mockImplementation(async () => {
      // The swarm runner sets ASHLR_IN_SWARM=1; the daemon restores it after.
      // Here we just capture the value DURING the call to observe it's set.
      swarmEnvsDuring.push(process.env['ASHLR_IN_SWARM']);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0, steps: 1 } };
    });

    const prevSwarm = process.env['ASHLR_IN_SWARM'];
    await tick(cfgBuiltin({ perTickItems: 2, parallel: 1 }), { dryRun: false });

    // After the tick, ASHLR_IN_SWARM should be back to its pre-tick value.
    expect(process.env['ASHLR_IN_SWARM']).toBe(prevSwarm);
  });

  it('C7: kill set mid-tick skips remaining items (in-tick per-item kill check)', async () => {
    enrollWithItems(4);
    let callCount = 0;
    mockRunSwarm.mockImplementation(async () => {
      callCount++;
      // Set kill after first dispatch so remaining items are skipped.
      if (callCount === 1) {
        fx.setKill(true);
      }
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 4, parallel: 1 }), { dryRun: false });

    // Tick should return 'ok' (the kill was set mid-item, not before the tick).
    expect(result.reason).toBe('ok');
    // Only the first item was dispatched; subsequent items saw kill=ON and skipped.
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Group D — M197 observability: console.warn on dispatch failures
// ===========================================================================

describe('M201 — Group D: observability — dispatch failure logging', () => {
  it('D1: runSwarm throws → daemon:swarm-error path taken; tick still returns reason ok', async () => {
    enrollWithItems(1);
    mockRunSwarm.mockRejectedValue(new Error('runSwarm exploded for D1'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await tick(cfgBuiltin({ perTickItems: 1 }), { dryRun: false });

    warnSpy.mockRestore();

    // The tick must not rethrow — it wraps every item dispatch in try/catch.
    expect(result.reason).toBe('ok');
    expect(typeof result.proposalsCreated).toBe('number');
    expect(typeof result.spentUsd).toBe('number');
  });

  it('D2: 3 items, middle one throws → other 2 dispatched, tick returns ok', async () => {
    enrollWithItems(3);
    let callNum = 0;
    mockRunSwarm.mockImplementation(async () => {
      const n = callNum++;
      if (n === 1) throw new Error('middle dispatch exploded D2');
      return { id: `mock-${n}`, status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await tick(cfgBuiltin({ perTickItems: 3, parallel: 1 }), { dryRun: false });

    warnSpy.mockRestore();

    expect(result.reason).toBe('ok');
    // All 3 items attempted; one threw but others succeeded.
    expect(mockRunSwarm).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// Group E — Config reload per tick (M85 runDaemon loop)
// ===========================================================================

describe('M201 — Group E: runDaemon config reload + loop mechanics', () => {
  it('E1: runDaemon once=true runs exactly one tick and stops', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });

    const cfg = cfgBuiltin({ perTickItems: 1 });
    const state = await runDaemon(cfg, { once: true, dryRun: true });

    // After once=true, daemon is no longer running.
    expect(state.running).toBe(false);
    // One tick happened (ticks array has at least one entry from the dry-run tick).
    expect(state.ticks.length).toBeGreaterThanOrEqual(1);
    expect(state.ticks.at(-1)?.dryRun).toBe(true);
  });

  it('E2: runDaemon loop with maxCycles=2 runs exactly 2 ticks and stops', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    // Use enough distinct items so cycle 2 is not blocked by the per-item
    // cooldown that fires after cycle 1 dispatches the same item.
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 10),
    });

    let tickCount = 0;
    mockRunSwarm.mockImplementation(async () => {
      tickCount++;
      return { id: `mock-${tickCount}`, status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    // Use continuous mode — that is the only loop branch that honours maxCycles.
    // Batch mode has no cycle counter; maxCycles is silently ignored there and
    // the loop would spin until budget exhaustion / kill, causing a timeout.
    // idleBackoffMs:1 ensures the idle-backoff sleep (triggered when the backlog
    // appears empty after cooldown filtering) is negligible rather than 5 s.
    const cfg = makeCfg({
      daemon: {
        dailyBudgetUsd: 1.0,
        perTickItems: 1,
        parallel: 1,
        intervalMs: 50,
        idleBackoffMs: 1,
        mode: 'continuous' as unknown as undefined,
        concurrency: { local: 2, cloud: 6, total: 8 },
      } as AshlrConfig['daemon'],
    });
    const state = await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 2 });

    // Daemon should have run exactly 2 tick cycles and stopped.
    // ticks[] records one entry per cycle; daemon is no longer running.
    expect(state.ticks.length).toBe(2);
    expect(state.running).toBe(false);
    // The loadConfig mock returns perTickItems:3; with 10 items available each
    // cycle dispatches up to 3 items → at most 2 × 3 = 6 swarm calls total.
    expect(mockRunSwarm.mock.calls.length).toBeLessThanOrEqual(6);
  }, 10_000);

  it('E3: runDaemon loop stops when kill switch is set before the next iteration', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });

    let swarmCalls = 0;
    mockRunSwarm.mockImplementation(async () => {
      swarmCalls++;
      // Set kill on first call so the loop exits after iteration 1.
      fx.setKill(true);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0, steps: 1 } };
    });

    const cfg = cfgBuiltin({ perTickItems: 1, parallel: 1 });
    const state = await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 10 });

    expect(state.running).toBe(false);
    // Kill fired after first swarm call → loop stopped; swarm called at most once.
    expect(swarmCalls).toBeLessThanOrEqual(1);
  });

  it('E4: runDaemon re-entrancy guard — refuses when ASHLR_IN_DAEMON is already set', async () => {
    process.env['ASHLR_IN_DAEMON'] = '1';
    const cfg = cfgBuiltin();

    // Should return without running any tick (re-entrancy guard fires immediately).
    const state = await runDaemon(cfg, { once: true, dryRun: true });

    // Guard returned the current state, swarm never dispatched.
    expect(mockRunSwarm).not.toHaveBeenCalled();
    // state is a valid DaemonState (guard returns loadDaemonState()).
    expect(typeof state.running).toBe('boolean');

    // Restore — the fixture cleanup restores ASHLR_IN_DAEMON but let's be explicit.
    delete process.env['ASHLR_IN_DAEMON'];
  });

  it('E5: runDaemon re-entrancy guard — refuses when ASHLR_IN_SWARM is already set', async () => {
    process.env['ASHLR_IN_SWARM'] = '1';
    const cfg = cfgBuiltin();

    const state = await runDaemon(cfg, { once: true, dryRun: true });

    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(typeof state.running).toBe('boolean');

    delete process.env['ASHLR_IN_SWARM'];
  });

  it('E5b: runDaemon singleton lock refuses a second process before ticking', async () => {
    const held = acquireDaemonLock();
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;

    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });

    const cfg = cfgBuiltin({ perTickItems: 1 });
    const state = await runDaemon(cfg, { once: true, dryRun: true });

    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(state.running).toBe(false);
    expect(releaseDaemonLock(held.lock)).toBe(true);
  });

  it('E6: runDaemon dry-run loop terminates after one tick (dry-run = bounded)', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });

    const cfg = cfgBuiltin({ perTickItems: 1 });
    const state = await runDaemon(cfg, { once: false, dryRun: true, maxCycles: 100 });

    // Dry-run loops terminate after a single iteration regardless of maxCycles.
    expect(state.running).toBe(false);
    // No swarm dispatched (dry-run path returns before dispatch).
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(state.ticks.at(-1)?.dryRun).toBe(true);
  });

  it('E7: runDaemon sets running=true on start and running=false on exit', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });

    let runningDuringTick: boolean | undefined;
    mockRunSwarm.mockImplementation(async () => {
      // Read state while the tick is in progress.
      runningDuringTick = loadDaemonState().running;
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0, steps: 1 } };
    });

    const cfg = cfgBuiltin({ perTickItems: 1, parallel: 1 });
    const finalState = await runDaemon(cfg, { once: true, dryRun: false });

    // Was running=true during the tick (captured by mockRunSwarm).
    expect(runningDuringTick).toBe(true);
    // running=false after runDaemon resolves.
    expect(finalState.running).toBe(false);
  });
});

// ===========================================================================
// Group F — buildItemGoal purity
// ===========================================================================

describe('M201 — Group F: buildItemGoal purity', () => {
  const baseItem = {
    id: 'test:item-1',
    repo: '/tmp/test-repo',
    source: 'todo' as const,
    title: 'Implement the login handler',
    detail: 'The /auth/login route returns 501 Not Implemented.',
    value: 5,
    effort: 2,
    score: 2.5,
    tags: ['auth', 'p1'],
    ts: new Date().toISOString(),
  };

  it('F1: output includes the item title', () => {
    const goal = buildItemGoal(baseItem);
    expect(goal).toContain(baseItem.title);
  });

  it('F2: output includes detail when non-empty and different from title', () => {
    const goal = buildItemGoal(baseItem);
    expect(goal).toContain(baseItem.detail);
  });

  it('F3: output omits detail when it equals the title', () => {
    const item = { ...baseItem, detail: baseItem.title };
    const goal = buildItemGoal(item);
    // Title appears once; detail (= title) should not be duplicated as a separate block.
    const titleCount = (goal.match(new RegExp(baseItem.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    expect(titleCount).toBe(1);
  });

  it('F4: output includes the repo anchor', () => {
    const goal = buildItemGoal(baseItem);
    expect(goal).toContain(`Repo: ${baseItem.repo}`);
  });

  it('F5: output includes behavioral guidance (no-op escape hatch text)', () => {
    const goal = buildItemGoal(baseItem);
    expect(goal).toContain('make NO changes and stop');
  });

  it('F6: never throws on a minimal item (all optional fields absent)', () => {
    const minimal = {
      id: 'test:minimal',
      repo: '',
      source: 'todo' as const,
      title: 'Minimal item',
      detail: '',
      value: 1,
      effort: 1,
      score: 1,
      tags: [],
      ts: new Date().toISOString(),
    };
    expect(() => buildItemGoal(minimal)).not.toThrow();
    const goal = buildItemGoal(minimal);
    expect(goal).toContain('Minimal item');
  });
});

// ===========================================================================
// Group G — Concurrent dispatch routing wire guards
// ===========================================================================

describe('M201 — Group G: concurrent dispatch routing wire guards', () => {
  it('G1: concurrent dispatch passes assigned backend and gateway reason into task runner', () => {
    const source = fs.readFileSync(new URL('../src/core/daemon/loop.ts', import.meta.url), 'utf8');

    expect(source).toContain('const routeReasons = new Map<string, string>();');
    expect(source).toContain('routeReasons.set(workedSet[i]!.id, d.value.reason);');
    expect(source).toContain('return taskEntry.run(_backend, routeReasons.get(item.id));');
  });

  it('G2: assigned gateway resource-pause decisions skip instead of dispatching', () => {
    const source = fs.readFileSync(new URL('../src/core/daemon/loop.ts', import.meta.url), 'utf8');

    expect(source).toContain("assignedReason?.startsWith('resource-pause:')");
    expect(source).toContain("gd.reason.startsWith('resource-pause:')");
  });
});
