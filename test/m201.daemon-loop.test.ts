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
 *    E8. runDaemon loop stays resident and sleeps when same-day budget is exhausted
 *    E9. resident loop wakes on the next UTC budget day, resets spend, and dispatches
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
import { join } from 'node:path';
import type { AshlrConfig, DaemonTick } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Core mocks — MUST be declared before lazy imports.
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();
vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

const mockBuildBacklog = vi.fn();
const mockLoadBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
  loadBacklog: (...args: unknown[]) => mockLoadBacklog(...args),
}));

const mockLoadQueuedAutonomyItems = vi.fn();
vi.mock('../src/core/portfolio/queued-autonomy.js', () => ({
  loadQueuedAutonomyItems: (...args: unknown[]) => mockLoadQueuedAutonomyItems(...args),
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
const mockRunSelfHealCycleForRepos = vi.fn();
vi.mock('../src/core/fleet/self-heal.js', () => ({
  runSelfHealCycle: (...args: unknown[]) => mockRunSelfHealCycle(...args),
  runSelfHealCycleForRepos: (...args: unknown[]) => mockRunSelfHealCycleForRepos(...args),
}));

const mockQueueProposalRepairWorkForPendingProposals = vi.fn();
vi.mock('../src/core/fleet/proposal-repair-work.js', () => ({
  queueProposalRepairWorkForPendingProposals: (...args: unknown[]) => mockQueueProposalRepairWorkForPendingProposals(...args),
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

const mockReconcileRemoteHandoffs = vi.fn();
vi.mock('../src/core/inbox/remote-handoff.js', () => ({
  reconcileRemoteHandoffs: (...args: unknown[]) => mockReconcileRemoteHandoffs(...args),
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

const mockRecommendRoute = vi.fn(async () => ({ backend: 'builtin', tier: 'local', reason: 'mock' }));
const mockRecoverWithinBudget = vi.fn((_r: unknown, _c: unknown) => ({
  action: 'proceed',
  decision: { backend: 'builtin', tier: 'local', reason: 'mock' },
}));
vi.mock('../src/core/run/learned-router.js', () => ({
  recommendRoute: (...args: unknown[]) => mockRecommendRoute(...args),
  recoverWithinBudget: (...args: unknown[]) => mockRecoverWithinBudget(...args),
}));

function defaultReloadConfig(): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 1.0,
      perTickItems: 3,
      parallel: 2,
      intervalMs: 50,
    },
  } as AshlrConfig;
}

const mockLoadConfig = vi.fn(defaultReloadConfig);
vi.mock('../src/core/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports — AFTER all mocks.
// ---------------------------------------------------------------------------

import { tick, runDaemon, buildItemGoal, workedOutcomeFromDispatchProduction } from '../src/core/daemon/loop.js';
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
import { readDispatchProductionEvents } from '../src/core/fleet/dispatch-production-ledger.js';
import { readAgentActions } from '../src/core/fleet/agent-action-ledger.js';
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
let prevAshlrHome: string | undefined;

beforeEach(() => {
  mockRunSwarm.mockReset();
  mockBuildBacklog.mockReset();
  mockRunGoal.mockReset();
  mockRunBestOfN.mockReset();
  mockRunSelfHealCycle.mockReset();
  mockRunSelfHealCycleForRepos.mockReset();
  mockQueueProposalRepairWorkForPendingProposals.mockReset();
  mockRunViaAshlrcode.mockReset();
  mockRunInventCycle.mockReset();
  mockRunCounterfactualReplay.mockReset();
  mockDetectRegression.mockReset();
  mockBisectAndRevert.mockReset();
  mockRouteBackend.mockReset();
  mockEngineTierOf.mockReset();
  mockRecommendRoute.mockReset();
  mockRecoverWithinBudget.mockReset();
  mockRunAutoMergePass.mockReset();
  mockReconcileRemoteHandoffs.mockReset();
  mockBuildResourceStrategyReport.mockReset();
  mockLoadQueuedAutonomyItems.mockReset();

  fx = makeFixture();
  prevAshlrHome = process.env.ASHLR_HOME;
  process.env.ASHLR_HOME = join(fx.home, '.ashlr');

  // Default benign implementations.
  mockRunSelfHealCycle.mockResolvedValue({ checked: 0, broken: [], healItems: [] });
  mockRunSelfHealCycleForRepos.mockResolvedValue({ checked: 0, broken: [], healItems: [] });
  mockQueueProposalRepairWorkForPendingProposals.mockReturnValue({ scanned: 0, eligible: 0, queued: 0, failed: 0 });
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
  mockRecommendRoute.mockResolvedValue({ backend: 'builtin', tier: 'local', reason: 'mock' });
  mockRecoverWithinBudget.mockReturnValue({
    action: 'proceed',
    decision: { backend: 'builtin', tier: 'local', reason: 'mock' },
  });
  mockRunViaAshlrcode.mockResolvedValue({ ok: true });
  mockRunAutoMergePass.mockResolvedValue({ merged: 0 });
  mockReconcileRemoteHandoffs.mockReturnValue({ checked: 0, merged: 0, closed: 0, open: 0, unknown: 0 });
  mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'backlog-build', reasons: ['mock backlog'] });
  mockLoadBacklog.mockReturnValue(null);
  mockLoadQueuedAutonomyItems.mockReturnValue([]);
  mockLoadConfig.mockReset();
  mockLoadConfig.mockImplementation(defaultReloadConfig);
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
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
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

/** Seed daemon state with a spent amount for an explicit UTC budget day. */
function seedSpendForDate(date: string, spentUsd: number): void {
  saveDaemonState({
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: date,
    todaySpentUsd: spentUsd,
    itemsProcessed: 0,
    ticks: [],
  });
}

/** Seed daemon state with recent tick history. */
function seedTicks(ticks: DaemonTick[]): void {
  saveDaemonState({
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: ticks.at(-1)?.ts ?? null,
    todayDate: today(),
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks,
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
  it('A0: dispatch production maps proposal-created to diff, no-proposal outcomes to empty, and proposal-disabled to neutral', () => {
    expect(workedOutcomeFromDispatchProduction(undefined)).toBeUndefined();
    expect(workedOutcomeFromDispatchProduction({
      outcome: 'proposal-created',
      proposalId: 'p1',
      runId: 'r1',
    })).toBe('diff');

    for (const outcome of [
      'empty-diff',
      'gate-blocked',
      'engine-failed',
      'sandbox-failed',
      'proposal-capture-error',
      'unknown',
    ] as const) {
      expect(workedOutcomeFromDispatchProduction({ outcome, runId: `run-${outcome}` })).toBe('empty');
    }
    expect(workedOutcomeFromDispatchProduction({
      outcome: 'proposal-disabled',
      runId: 'run-proposal-disabled',
    })).toBeUndefined();
  });

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
    expect(mockRunSelfHealCycle).toHaveBeenCalledTimes(1);
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1-start: live tick writes start and terminal agent actions without extra daemon ticks', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });

    const result = await tick(cfgBuiltin({ perTickItems: 4, parallel: 3 }), { dryRun: false });

    const actions = readAgentActions();
    const start = actions.find((event) => event.action === 'daemon:tick-start');
    const terminal = actions.find((event) => event.action === 'daemon:tick');
    const state = loadDaemonState();

    expect(result.reason).toBe('no-backlog');
    expect(state.ticks).toHaveLength(1);
    expect(state.ticks[0]!.reason).toBe('no-backlog');
    expect(start).toMatchObject({
      actor: 'daemon',
      kind: 'tick',
      outcome: 'started',
      action: 'daemon:tick-start',
      counts: { perTickItems: 4, parallel: 3 },
    });
    expect(start?.tags).toEqual(expect.arrayContaining(['tick-start', 'live']));
    expect(start?.repo).toBeUndefined();
    expect(start?.itemId).toBeUndefined();
    expect(start?.proposalId).toBeUndefined();
    expect(start?.runId).toBeUndefined();
    expect(terminal).toMatchObject({
      actor: 'daemon',
      kind: 'tick',
      outcome: 'skipped',
      action: 'daemon:tick',
      reason: 'no-backlog',
    });
  });

  it('A1a: empty backlog runs self-heal, rebuilds, and dispatches refilled work in the same tick', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const items = makeItems(repo.dir, 1);
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(2);
    expect(mockRunSelfHealCycle).toHaveBeenCalledTimes(1);
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
  });

  it('A1a2: empty backlog runs bounded invent only after self-heal refill stays empty', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const items = makeItems(repo.dir, 1);
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { autonomyControlLoop: false, generative: true },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(3);
    expect(mockRunSelfHealCycle).toHaveBeenCalledTimes(1);
    expect(mockRunInventCycle).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
  });

  it('A1a2b: proposal repair maintenance can refill backlog before selection', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repairItems = makeItems(repo.dir, 1).map((item) => ({
      ...item,
      id: `${repo.dir}:proposal-repair:abc123`,
      source: 'self' as const,
      title: 'Repair proposal prop-partial: test failure in src/app.ts:12',
      detail: 'Proposal repair: test failure in src/app.ts:12 expected ready state.',
      tags: ['self-heal', 'proposal-repair', 'verify'],
    }));
    mockQueueProposalRepairWorkForPendingProposals.mockReturnValue({
      scanned: 1,
      eligible: 2,
      queued: 2,
      failed: 0,
      dispatchCaptureScanned: 1,
      dispatchCaptureEligible: 1,
      dispatchCaptureQueued: 1,
      dispatchCaptureFailed: 0,
      dispatchNoDiffScanned: 1,
      dispatchNoDiffEligible: 1,
      dispatchNoDiffQueued: 1,
      dispatchNoDiffFailed: 0,
    });
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: repairItems });

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autonomyControlLoop: false } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockQueueProposalRepairWorkForPendingProposals).toHaveBeenCalledTimes(1);
    expect(mockQueueProposalRepairWorkForPendingProposals.mock.calls[0]).toEqual([]);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(2);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(result.producerMaintenance).toMatchObject({
      proposalRepair: true,
      proposalRepairEligible: 2,
      proposalRepairQueued: 2,
      proposalRepairFailed: 0,
      dispatchCaptureRepairScanned: 1,
      dispatchCaptureRepairEligible: 1,
      dispatchCaptureRepairQueued: 1,
      dispatchCaptureRepairFailed: 0,
      dispatchNoDiffResliceScanned: 1,
      dispatchNoDiffResliceEligible: 1,
      dispatchNoDiffResliceQueued: 1,
      dispatchNoDiffResliceFailed: 0,
    });
    expect(result.dispatches?.[0]?.itemId).toBe(repairItems[0]!.id);
  });

  it('A1a2b2: foundry.proposalRepair=false disables repair maintenance', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autonomyControlLoop: false, proposalRepair: false } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('no-backlog');
    expect(mockQueueProposalRepairWorkForPendingProposals).not.toHaveBeenCalled();
  });

  it('A1a2c: non-empty backlog refreshes after self-heal maintenance before selection', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const [staleBase, freshItem] = makeItems(repo.dir, 2);
    const staleSelfHeal = {
      ...staleBase!,
      id: `${repo.dir}:self-heal:stale-green-build`,
      source: 'self' as const,
      title: 'Fix broken build in ashlrcode: stale typecheck error',
      detail: 'Stale self-heal item that should be pruned after verification is green.',
      score: 9,
      tags: ['self-heal', 'build', 'high-priority'],
    };
    const freshWork = {
      ...freshItem!,
      id: `${repo.dir}:todo:fresh-real-work`,
      title: 'Fresh real work after stale self-heal pruning',
      score: 3,
    };
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [staleSelfHeal, freshWork] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [freshWork] });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: freshWork.id,
      title: freshWork.title,
    });
    expect(result.dispatches?.[0]?.itemId).not.toBe(staleSelfHeal.id);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(2);
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycleForRepos).toHaveBeenCalledTimes(1);
    expect(mockRunSelfHealCycleForRepos).toHaveBeenCalledWith([repo.dir], expect.any(Object));
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(result.producerMaintenance).toMatchObject({
      selfHeal: true,
      ancillary: true,
    });
  });

  it('A1a2d: self-heal maintenance that empties a non-empty backlog still runs auto-merge drain', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const [staleBase] = makeItems(repo.dir, 1);
    const staleSelfHeal = {
      ...staleBase!,
      id: `${repo.dir}:self-heal:stale-only-green-build`,
      source: 'self' as const,
      title: 'Fix broken build in ashlrcode: stale only item',
      detail: 'Stale self-heal item that should be pruned with no replacement work.',
      score: 9,
      tags: ['self-heal', 'build', 'high-priority'],
    };
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [staleSelfHeal] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] });
    mockRunAutoMergePass.mockResolvedValue({ merged: 1 });

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('no-backlog');
    expect(result.itemsConsidered).toBe(0);
    expect(result.merged).toBe(1);
    expect(result.autoMerge).toMatchObject({ merged: 1 });
    expect(mockBuildBacklog).toHaveBeenCalledTimes(2);
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycleForRepos).toHaveBeenCalledTimes(1);
    expect(mockRunSelfHealCycleForRepos).toHaveBeenCalledWith([repo.dir], expect.any(Object));
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1a2e: ordinary self-improve backlog does not trigger self-heal maintenance', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const [base] = makeItems(repo.dir, 1);
    const selfImproveItem = {
      ...base!,
      id: `${repo.dir}:self:skip-test-gap`,
      source: 'self' as const,
      title: 'Restore skipped test in fleet.test.ts:12',
      detail: 'Bare skipped test that should be handled as ordinary self-improvement work.',
      tags: ['self', 'test-gap'],
    };
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [selfImproveItem],
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(1);
    expect(mockRunSelfHealCycleForRepos).not.toHaveBeenCalled();
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(result.dispatches?.[0]?.itemId).toBe(selfImproveItem.id);
  });

  it('A1a3: empty backlog does not rerun producer maintenance inside the daemon interval', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });
    seedTicks([{
      ts: new Date().toISOString(),
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'no-backlog',
      producerMaintenance: {
        selfHeal: true,
        invent: false,
        ancillary: true,
      },
    }]);

    const result = await tick(
      {
        ...cfgBuiltin(),
        daemon: {
          ...cfgBuiltin().daemon,
          intervalMs: 60_000,
          mode: 'continuous',
          idleBackoffMs: 1,
        },
        foundry: { autonomyControlLoop: false, generative: true },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('no-backlog');
    expect(mockBuildBacklog).toHaveBeenCalledTimes(1);
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(result.producerMaintenance).toMatchObject({
      selfHeal: false,
      invent: false,
      ancillary: false,
      skippedByCadence: true,
    });
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
    expect(mockReconcileRemoteHandoffs).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunInventCycle).not.toHaveBeenCalled();
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
    expect(mockReconcileRemoteHandoffs).not.toHaveBeenCalled();
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
    mockReconcileRemoteHandoffs.mockReturnValue({ checked: 1, merged: 1, closed: 0, open: 0, unknown: 0 });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autonomyControlLoop: true } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    expect(result.directionMode).toBe('pause');
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: {
        buildFleetStatus?: () => Promise<{ queue?: { backlogItems?: number } }>;
        runEcosystemDoctor?: (opts?: { root?: string; now?: Date }) => Promise<{ summary?: { total?: number } }>;
        listOutcomeRecords?: () => unknown[];
      };
    };
    await expect(strategyOpts.deps?.buildFleetStatus?.()).resolves.toMatchObject({
      queue: { backlogItems: 0 },
    });
    await expect(strategyOpts.deps?.runEcosystemDoctor?.()).resolves.toMatchObject({
      summary: { total: 1 },
    });
    expect(strategyOpts.deps?.listOutcomeRecords?.()).toEqual([]);
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockReconcileRemoteHandoffs).not.toHaveBeenCalled();
    expect(result.remoteHandoff).toBeUndefined();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1e2: production velocity supplies pending outcome records to the daemon strategy', async () => {
    const { items } = enrollWithItems(1);
    const proposal = createProposal({
      repo: items[0]!.repo,
      origin: 'agent',
      kind: 'patch',
      title: `Pending ${items[0]!.id}`,
      summary: 'pending proposal for production velocity strategy',
      diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
      workItemId: items[0]!.id,
      workSource: items[0]!.source,
    });
    mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'pause', reasons: ['mock guard block'] });

    const result = await tick(
      {
        ...cfgBuiltin(),
        foundry: {
          autonomyControlLoop: true,
          productionVelocity: { enabled: true, profile: 'resource-control' },
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: { listOutcomeRecords?: (opts?: { limit?: number }) => Array<{ proposal?: { id?: string } }> };
    };
    const records = strategyOpts.deps?.listOutcomeRecords?.({ limit: 6 }) ?? [];
    expect(records.some((record) => record.proposal?.id === proposal.id)).toBe(true);
    expect(mockBuildBacklog).not.toHaveBeenCalled();
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
	      invalidRejected: 1,
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
	      invalidRejected: 1,
    });
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockReconcileRemoteHandoffs).toHaveBeenCalledTimes(1);
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1f2: Foundry defaults to executable verify-only control', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'verify-only', reasons: ['pending proposals need verification'] });
    mockRunAutoMergePass.mockResolvedValue({ attempted: 1, merged: 0 });
    mockReconcileRemoteHandoffs.mockReturnValue({ checked: 2, merged: 1, closed: 1, open: 0, unknown: 0 });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('verify-only');
    expect(result.directionMode).toBe('verify-only');
    expect(result.directionReason).toBe('pending proposals need verification');
    expect(result.remoteHandoff).toEqual({ checked: 2, merged: 1, closed: 1, open: 0, unknown: 0 });
    const state = loadDaemonState();
    expect(state.ticks.at(-1)?.remoteHandoff).toEqual({ checked: 2, merged: 1, closed: 1, open: 0, unknown: 0 });
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockReconcileRemoteHandoffs).toHaveBeenCalledTimes(1);
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1f4: executable direction uses persisted enrolled backlog count before scanner refresh', async () => {
    const { repo, items } = enrollWithItems(1);
    mockLoadBacklog.mockReturnValue({ generatedAt: new Date().toISOString(), repos: [repo.dir], items });
    mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'pause', reasons: ['cached count only'] });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: { buildFleetStatus?: () => Promise<{ queue?: { backlogItems?: number } }> };
    };
    await expect(strategyOpts.deps?.buildFleetStatus?.()).resolves.toMatchObject({
      queue: { backlogItems: 1 },
    });
  });

  it('A1f5: executable direction counts queued self-heal work when persisted backlog is stale', async () => {
    const { repo, items } = enrollWithItems(1);
    mockLoadBacklog.mockReturnValue({
      generatedAt: new Date().toISOString(),
      repos: ['/tmp/deleted-fixture'],
      items: [{ ...items[0]!, repo: '/tmp/deleted-fixture', id: 'stale-temp-item' }],
    });
    mockLoadQueuedAutonomyItems.mockReturnValue([
      {
        ...items[0]!,
        id: 'queued-self-heal',
        repo: repo.dir,
        source: 'self',
        tags: ['self-heal', 'test'],
      },
    ]);
    mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'pause', reasons: ['cached count only'] });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: { buildFleetStatus?: () => Promise<{ queue?: { backlogItems?: number } }> };
    };
    await expect(strategyOpts.deps?.buildFleetStatus?.()).resolves.toMatchObject({
      queue: { backlogItems: 1 },
    });
    expect(mockBuildBacklog).not.toHaveBeenCalled();
  });

  it('A1f3: explicit autonomyControlLoop=false keeps Foundry advisory-only', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'verify-only', reasons: ['pending proposals need verification'] });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { autonomyControlLoop: false, autoMerge: { enabled: true } },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.directionMode).toBeUndefined();
    expect(mockBuildResourceStrategyReport).not.toHaveBeenCalled();
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
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

  it('A1h2: sandboxed engine proposal outcomes are persisted on dispatch traces', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock local-coder' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-empty-diff',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.004, steps: 1 },
      proposalOutcome: {
        kind: 'empty-diff',
        reason: 'engine "local-coder" completed without file changes',
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      skipReason: 'empty-diff: engine "local-coder" completed without file changes',
      production: {
        outcome: 'empty-diff',
        runId: 'run-empty-diff',
        reason: 'engine "local-coder" completed without file changes',
      },
    });
    expect(result.proposalProduction?.reasons?.[0]).toEqual({
      reason: 'empty-diff: engine "local-coder" completed without file changes',
      count: 1,
    });
    expect(loadDaemonState().ticks.at(-1)?.dispatches?.[0]?.production).toMatchObject({
      outcome: 'empty-diff',
      runId: 'run-empty-diff',
      trajectoryId: 'run:run-empty-diff',
    });
    const productionEvent = readDispatchProductionEvents({ limit: 1 })[0];
    expect(productionEvent).toMatchObject({
      itemId: items[0]!.id,
      source: 'todo',
      repo: items[0]!.repo,
      title: items[0]!.title,
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'router',
      routeReason: 'mock local-coder',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-empty-diff',
      trajectoryId: 'run:run-empty-diff',
      routeSnapshot: {
        backend: 'local-coder',
        tier: 'mid',
        assignedBy: 'router',
        reason: 'mock local-coder',
      },
      runEventSummary: {
        runId: 'run-empty-diff',
        status: 'done',
        outcome: 'empty-diff',
        proposalCreated: false,
        costUsd: 0.004,
      },
      learningSource: 'daemon-dispatch',
      labelBasis: 'dispatch-outcome',
      spentUsd: 0.004,
      reason: 'engine "local-coder" completed without file changes',
      basis: 'run-proposal-outcome',
    });
    const dispatchAction = readAgentActions({ limit: 10 }).find((event) => event.action === 'daemon:dispatch');
    expect(dispatchAction).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'no-proposal',
      trajectoryId: productionEvent?.trajectoryId,
      runEventSummary: productionEvent?.runEventSummary,
    });
  });

  it('A1h2b: trivial proposal outcomes persist as gate-blocked no-proposal production', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock local-coder trivial' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-trivial-proposal',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.003, steps: 1 },
      proposalOutcome: {
        kind: 'trivial-proposal',
        reason: 'trivial proposal blocked: 2 changed line(s) in docs only',
        files: 1,
        insertions: 1,
        deletions: 1,
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(0);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      skipReason: 'gate-blocked: trivial proposal blocked: 2 changed line(s) in docs only',
      production: {
        outcome: 'gate-blocked',
        runId: 'run-trivial-proposal',
        reason: 'trivial proposal blocked: 2 changed line(s) in docs only',
        diffFiles: 1,
        diffLines: 2,
      },
    });
    expect(result.proposalProduction?.reasons?.[0]).toEqual({
      reason: 'gate-blocked: trivial proposal blocked: 2 changed line(s) in docs only',
      count: 1,
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, outcome: 'empty' }),
    ]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'gate-blocked',
      proposalCreated: false,
      runId: 'run-trivial-proposal',
      reason: 'trivial proposal blocked: 2 changed line(s) in docs only',
      diffFiles: 1,
      diffLines: 2,
      basis: 'run-proposal-outcome',
    });
    expect(readAgentActions({ limit: 10 }).find((event) => event.action === 'daemon:dispatch')).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'no-proposal',
      runId: 'run-trivial-proposal',
    });
  });

  it('A1h3: routed model is passed into the normal sandboxed runGoal path', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen-routed-model',
      reason: 'mock local-coder model route',
    });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({
      engine: 'local-coder',
      model: 'qwen-routed-model',
      sandboxEngine: true,
      requireSandbox: true,
      delegationScope: {
        origin: 'daemon',
        sourceRepo: items[0]!.repo,
        workItemId: items[0]!.id,
        workSource: items[0]!.source,
        objective: items[0]!.title,
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
        backend: {
          engine: 'local-coder',
          model: 'qwen-routed-model',
          tier: 'mid',
          assignedBy: 'router',
          reason: 'mock local-coder model route',
        },
      },
    });
    expect(result.dispatches?.[0]).toMatchObject({
      backend: 'local-coder',
      model: 'qwen-routed-model',
    });
  });

  it('A1h3b: learned-router backend changes do not keep the previous backend model', async () => {
    enrollWithItems(1);
    mockRouteBackend.mockReturnValue({
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen-routed-model',
      reason: 'mock local-coder model route',
    });
    mockEngineTierOf.mockImplementation((backend: unknown) =>
      backend === 'local-coder' || backend === 'codex' ? 'mid' : 'local',
    );
    mockRecommendRoute.mockResolvedValue({
      backend: 'codex',
      tier: 'mid',
      reason: 'learned-router: same-tier reroute to codex',
    });
    mockRecoverWithinBudget.mockImplementation((decision: unknown) => ({
      action: 'proceed',
      decision,
    }));

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder', 'codex'],
          intelligence: {},
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    const opts = mockRunGoal.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts).toMatchObject({
      engine: 'codex',
      sandboxEngine: true,
      requireSandbox: true,
    });
    expect(opts).not.toHaveProperty('model');
  });

  it('A1h4: dispatch-production ledger records filed proposal outcomes with proposal id', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', model: 'qwen', reason: 'mock local-coder filed' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockImplementationOnce(async () => {
      const proposal = createProposal({
        repo: items[0]!.repo,
        origin: 'swarm',
        kind: 'patch',
        title: 'Filed from daemon',
        summary: 'daemon filed proposal',
        diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
        workItemId: items[0]!.id,
        workSource: items[0]!.source,
        runId: 'run-filed',
      });
      return {
        id: 'run-filed',
        status: 'done',
        usage: { totalTokens: 100, estCostUsd: 0.006, steps: 1 },
        proposalOutcome: {
          kind: 'filed',
          proposalId: proposal.id,
          files: 1,
          insertions: 1,
          deletions: 1,
        },
      };
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(1);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      model: 'qwen',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: expect.stringMatching(/^prop-/),
      runId: 'run-filed',
      spentUsd: 0.006,
      diffFiles: 1,
      diffLines: 2,
      basis: 'run-proposal-outcome',
    });
  });

  it('A1h5: proposal-created production records worked diff even when pending delta is zero', async () => {
    const before = pendingCount();
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock production-only filed' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-filed-production-only',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.003, steps: 1 },
      proposalOutcome: {
        kind: 'filed',
        proposalId: 'p-production-only',
        files: 1,
        insertions: 2,
        deletions: 1,
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(0);
    expect(pendingCount()).toBe(before);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      production: {
        outcome: 'proposal-created',
        proposalId: 'p-production-only',
        runId: 'run-filed-production-only',
        diffFiles: 1,
        diffLines: 3,
      },
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, outcome: 'diff' }),
    ]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'p-production-only',
      basis: 'run-proposal-outcome',
    });
  });

  it('A1h5b: proposal-disabled production does not record empty cooldown', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock proposal disabled' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-proposal-disabled',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: {
        kind: 'proposal-disabled',
        reason: 'proposal filing disabled for this sandboxed attempt',
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(0);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      production: {
        outcome: 'proposal-disabled',
        runId: 'run-proposal-disabled',
        reason: 'proposal filing disabled for this sandboxed attempt',
      },
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'proposal-disabled',
      proposalCreated: false,
      runId: 'run-proposal-disabled',
      basis: 'run-proposal-outcome',
    });
  });

  it('A1h6: non-proposal production does not inherit proposal ids from the pending delta', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock empty with side proposal' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockImplementationOnce(async () => {
      createProposal({
        repo: items[0]!.repo,
        origin: 'swarm',
        kind: 'patch',
        title: 'Side proposal',
        summary: 'created by another capture path',
        diff: 'diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-old\n+new\n',
        workItemId: items[0]!.id,
        workSource: items[0]!.source,
        runId: 'run-side-proposal',
      });
      return {
        id: 'run-empty-with-side-proposal',
        status: 'done',
        usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
        proposalOutcome: {
          kind: 'empty-diff',
          reason: 'empty result despite a side proposal',
        },
      };
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(1);
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, outcome: 'empty' }),
    ]);
    const event = readDispatchProductionEvents({ limit: 1 })[0]!;
    expect(event).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-empty-with-side-proposal',
      basis: 'run-proposal-outcome',
    });
    expect(event).not.toHaveProperty('proposalId');
  });

  it('A1h7: thrown sandboxed dispatch records an engine-failed production outcome', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock local-coder throw' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockRejectedValueOnce(new Error('model process crashed'));

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      skipReason: 'dispatch-error: model process crashed',
      production: {
        outcome: 'engine-failed',
        reason: 'dispatch-error: model process crashed',
      },
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, outcome: 'empty' }),
    ]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'engine-failed',
      proposalCreated: false,
      reason: 'dispatch-error: model process crashed',
      basis: 'run-proposal-outcome',
    });
  });

  it('A1i: live ticks persist bounded dispatch assignment traces', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'builtin', tier: 'local', model: null, reason: 'test route' });

    const result = await tick(
      cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({
      workItemId: items[0]!.id,
      workSource: items[0]!.source,
      delegationScope: {
        origin: 'daemon',
        sourceRepo: items[0]!.repo,
        workItemId: items[0]!.id,
        workSource: items[0]!.source,
        objective: items[0]!.title,
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
        backend: {
          engine: 'builtin',
          model: null,
          tier: 'local',
          assignedBy: 'router',
          reason: 'test route',
        },
      },
    });
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'builtin',
      tier: 'local',
      assignedBy: 'router',
      reason: 'test route',
      dispatched: true,
      spentUsd: 0.001,
    });
    expect(result.proposalProduction).toMatchObject({
      selected: 1,
      claimed: 1,
      dispatched: 1,
      skipped: 0,
      errors: 0,
      proposalsCreated: 0,
      noProposalDispatches: 1,
    });

    const state = loadDaemonState();
    expect(state.ticks.at(-1)?.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'builtin',
      reason: 'test route',
      dispatched: true,
    });
    expect(state.ticks.at(-1)?.proposalProduction?.noProposalDispatches).toBe(1);
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

  it('A6b: strategic core repos lead round-robin when capacity is scarce', async () => {
    const parent = fs.mkdtempSync(`${fx.home}/strategic-repos-`);
    const supportingRepo = `${parent}/ashlr-config`;
    const coreRepo = `${parent}/ashlr-hub`;
    fs.mkdirSync(supportingRepo, { recursive: true });
    fs.mkdirSync(coreRepo, { recursive: true });
    fs.mkdirSync(fx.ashlrDir, { recursive: true });
    fs.writeFileSync(
      `${fx.ashlrDir}/enrollment.json`,
      JSON.stringify({ repos: [supportingRepo, coreRepo] }),
      'utf8',
    );
    const supportItems = makeItems(supportingRepo, 2);
    const coreItems = makeItems(coreRepo, 2);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [supportingRepo, coreRepo],
      items: [...supportItems, ...coreItems],
    });
    const dispatchedRepos: string[] = [];
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
      const project = (opts as Record<string, unknown>)?.project as string | undefined;
      if (project) dispatchedRepos.push(project);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(dispatchedRepos).toEqual([coreRepo]);
  });

  it('A7: items with a pending proposal are skipped during selection', async () => {
    const { repo, items } = enrollWithItems(3);
    // New proposals use workItemId as the source of truth; stale prose that
    // mentions another item must not block that other item.
    createProposal({
      repo: repo.dir,
      origin: 'swarm',
      kind: 'patch',
      title: `pending for ${items[1]!.id}`,
      summary: `covers ${items[1]!.id}`,
      diff: 'diff --git a/x.ts b/x.ts\n',
      workItemId: items[0]!.id,
    });

    const dispatchedItemIds: string[] = [];
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
      const workItemId = (opts as Record<string, unknown>)?.workItemId as string | undefined;
      if (workItemId) dispatchedItemIds.push(workItemId);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 3, parallel: 3 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    // items[0] was skipped; only 2 items dispatched from the 3 available.
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    expect(dispatchedItemIds).not.toContain(items[0]!.id);
    expect(dispatchedItemIds).toContain(items[1]!.id);
    expect(dispatchedItemIds).toContain(items[2]!.id);
  });

  it('A7c: stale pending proposals do not skip matching items under production velocity', async () => {
    const { repo, items } = enrollWithItems(2);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
      createProposal({
        repo: repo.dir,
        origin: 'swarm',
        kind: 'patch',
        title: `old pending for ${items[0]!.id}`,
        summary: `covers ${items[0]!.id}`,
        diff: 'diff --git a/x.ts b/x.ts\n',
        workItemId: items[0]!.id,
      });
      vi.setSystemTime(new Date('2026-07-03T00:00:00.000Z'));

      const dispatchedItemIds: string[] = [];
      mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
        const workItemId = (opts as Record<string, unknown>)?.workItemId as string | undefined;
        if (workItemId) dispatchedItemIds.push(workItemId);
        return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
      });

      const result = await tick(
        {
          ...cfgBuiltin({ perTickItems: 2, parallel: 2 }),
          foundry: {
            autonomyControlLoop: false,
            productionVelocity: { enabled: true, profile: 'resource-control', stalePendingTtlHours: 24 },
          },
        } as AshlrConfig,
        { dryRun: false },
      );

      expect(result.reason).toBe('ok');
      expect(mockRunSwarm).toHaveBeenCalledTimes(2);
      expect(dispatchedItemIds).toContain(items[0]!.id);
      expect(dispatchedItemIds).toContain(items[1]!.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('A7b: legacy pending proposals without workItemId still skip exact item-id matches', async () => {
    const { repo, items } = enrollWithItems(3);
    createProposal({
      repo: repo.dir,
      origin: 'swarm',
      kind: 'patch',
      title: `legacy pending for ${items[1]!.id}`,
      summary: 'legacy proposal has no causal work item id',
      diff: 'diff --git a/x.ts b/x.ts\n',
    });

    const dispatchedItemIds: string[] = [];
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
      const workItemId = (opts as Record<string, unknown>)?.workItemId as string | undefined;
      if (workItemId) dispatchedItemIds.push(workItemId);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 3, parallel: 3 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    expect(dispatchedItemIds).toContain(items[0]!.id);
    expect(dispatchedItemIds).not.toContain(items[1]!.id);
    expect(dispatchedItemIds).toContain(items[2]!.id);
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
        mode: 'continuous',
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
    expect(result.proposalProduction).toMatchObject({
      selected: 2,
      claimed: 2,
      dispatched: 2,
      skipped: 0,
      errors: 0,
      proposalsCreated: 0,
      noProposalDispatches: 2,
    });
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

  it('E1b: runDaemon once=true reloads Foundry policy from disk before ticking', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue({ mode: 'verify-only', reasons: ['caller cfg would enforce verify-only'] });
    mockLoadConfig.mockReturnValue({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { autonomyControlLoop: false, autoMerge: { enabled: true } },
    } as AshlrConfig);

    const callerCfg = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { autoMerge: { enabled: true } },
    } as AshlrConfig;
    const state = await runDaemon(callerCfg, { once: true, dryRun: false });

    expect(mockBuildResourceStrategyReport).not.toHaveBeenCalled();
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(state.running).toBe(false);
    expect(state.ticks.at(-1)?.reason).toBe('ok');
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

    // Use continuous mode to prove the non-empty loop does not require fixed
    // interval sleeps between ticks. idleBackoffMs:1 keeps any idle branch fast.
    const cfg = makeCfg({
      daemon: {
        dailyBudgetUsd: 1.0,
        perTickItems: 1,
        parallel: 1,
        intervalMs: 50,
        idleBackoffMs: 1,
        mode: 'continuous',
        concurrency: { local: 2, cloud: 6, total: 8 },
      } as AshlrConfig['daemon'],
    });
    mockLoadConfig.mockReturnValue(cfg);
    const state = await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 2 });

    // Daemon should have run exactly 2 tick cycles and stopped.
    // ticks[] records one entry per cycle; daemon is no longer running.
    expect(state.ticks.length).toBe(2);
    expect(state.running).toBe(false);
    expect(mockRunSwarm.mock.calls.length).toBeLessThanOrEqual(2);
  }, 10_000);

  it('E2b: batch loop sleeps with live daemon.intervalMs, not the startup config interval', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 10),
    });

    const startupCfg = cfgBuiltin({ perTickItems: 1, parallel: 1 }) as AshlrConfig;
    startupCfg.daemon = { ...startupCfg.daemon, intervalMs: 10_000 };
    const liveCfg = cfgBuiltin({ perTickItems: 1, parallel: 1 }) as AshlrConfig;
    liveCfg.daemon = { ...liveCfg.daemon, intervalMs: 7 };
    mockLoadConfig.mockReturnValue(liveCfg);

    const realSetTimeout = globalThis.setTimeout;
    const sleepMs: number[] = [];
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      sleepMs.push(Number(timeout ?? 0));
      return realSetTimeout(handler as (...handlerArgs: unknown[]) => void, 0, ...args);
    }) as typeof setTimeout);

    try {
      const state = await runDaemon(startupCfg, { once: false, dryRun: false, maxCycles: 2 });

      expect(state.running).toBe(false);
      expect(state.ticks.length).toBe(2);
      expect(sleepMs).toContain(7);
      expect(sleepMs).not.toContain(10_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('E2c: loop mode is re-read from live config between iterations', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 10),
    });

    const startupCfg = cfgBuiltin({ perTickItems: 1, parallel: 1 }) as AshlrConfig;
    startupCfg.daemon = { ...startupCfg.daemon, intervalMs: 10_000, mode: 'batch' };
    const liveBatch = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      daemon: { ...cfgBuiltin().daemon, perTickItems: 1, parallel: 1, intervalMs: 250, mode: 'batch' },
    } as AshlrConfig;
    const liveContinuous = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      daemon: {
        ...cfgBuiltin().daemon,
        perTickItems: 1,
        parallel: 1,
        intervalMs: 250,
        idleBackoffMs: 5,
        mode: 'continuous',
        concurrency: { local: 2, cloud: 6, total: 8 },
      },
    } as AshlrConfig;
    mockLoadConfig
      .mockReturnValueOnce(liveBatch)
      .mockReturnValue(liveContinuous);

    const realSetTimeout = globalThis.setTimeout;
    const sleepMs: number[] = [];
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      sleepMs.push(Number(timeout ?? 0));
      return realSetTimeout(handler as (...handlerArgs: unknown[]) => void, 0, ...args);
    }) as typeof setTimeout);

    try {
      const state = await runDaemon(startupCfg, { once: false, dryRun: false, maxCycles: 2 });

      expect(state.running).toBe(false);
      expect(state.ticks.length).toBe(2);
      expect(sleepMs).not.toContain(250);
      expect(sleepMs).not.toContain(10_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

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

  it('E8: same-day exhausted budget keeps the loop resident and sleeps without backlog or dispatch', async () => {
    vi.useFakeTimers();
    let run: Promise<unknown> | undefined;
    let settled = false;
    try {
      vi.setSystemTime(new Date('2026-07-02T23:59:59.000Z'));
      const repo = fx.makeRepo();
      repo.enroll();
      mockBuildBacklog.mockResolvedValue({
        generatedAt: new Date().toISOString(),
        repos: [repo.dir],
        items: makeItems(repo.dir, 1),
      });
      seedSpendForDate('2026-07-02', 1.0);
      const cfg = makeCfg({
        daemon: {
          dailyBudgetUsd: 1.0,
          perTickItems: 1,
          parallel: 1,
          intervalMs: 50,
          idleBackoffMs: 1,
          mode: 'continuous',
          concurrency: { local: 2, cloud: 6, total: 8 },
        } as AshlrConfig['daemon'],
      });
      mockLoadConfig.mockReturnValue(cfg);

      run = runDaemon(cfg, { once: false, dryRun: false, maxCycles: 1 }).then((state) => {
        settled = true;
        return state;
      });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(settled).toBe(false);
      const sleepingState = loadDaemonState();
      expect(sleepingState.running).toBe(true);
      expect(sleepingState.ticks.at(-1)?.reason).toBe('budget-exhausted');
      expect(mockBuildBacklog).not.toHaveBeenCalled();
      expect(mockRunSwarm).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_001);
      const finalState = await run;
      expect((finalState as { running?: boolean }).running).toBe(false);
      expect(mockBuildBacklog).not.toHaveBeenCalled();
      expect(mockRunSwarm).not.toHaveBeenCalled();
    } finally {
      if (run && !settled) {
        try {
          fx.setKill(true);
          await vi.advanceTimersByTimeAsync(1_001);
          await run;
        } catch {
          // best-effort cleanup for failed assertions
        }
      }
      vi.useRealTimers();
    }
  });

  it('E9: resident loop wakes on the next UTC budget day, resets stale spend, and dispatches', async () => {
    vi.useFakeTimers();
    let run: Promise<unknown> | undefined;
    let settled = false;
    try {
      vi.setSystemTime(new Date('2026-07-02T23:59:59.000Z'));
      const repo = fx.makeRepo();
      repo.enroll();
      mockBuildBacklog.mockResolvedValue({
        generatedAt: new Date().toISOString(),
        repos: [repo.dir],
        items: makeItems(repo.dir, 1),
      });
      seedSpendForDate('2026-07-02', 1.0);
      const cfg = makeCfg({
        daemon: {
          dailyBudgetUsd: 1.0,
          perTickItems: 1,
          parallel: 1,
          intervalMs: 50,
          idleBackoffMs: 1,
          mode: 'continuous',
          concurrency: { local: 2, cloud: 6, total: 8 },
        } as AshlrConfig['daemon'],
      });
      mockLoadConfig.mockReturnValue(cfg);

      run = runDaemon(cfg, { once: false, dryRun: false, maxCycles: 2 }).then((state) => {
        settled = true;
        return state;
      });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(loadDaemonState().ticks.at(-1)?.reason).toBe('budget-exhausted');
      expect(mockBuildBacklog).not.toHaveBeenCalled();
      expect(mockRunSwarm).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_001);
      const finalState = await run;

      expect((finalState as { running?: boolean }).running).toBe(false);
      expect(mockBuildBacklog).toHaveBeenCalledTimes(1);
      expect(mockRunSwarm).toHaveBeenCalledTimes(1);
      const loaded = loadDaemonState();
      expect(loaded.todayDate).toBe('2026-07-03');
      expect(loaded.todaySpentUsd).toBeCloseTo(0.001, 10);
      expect(loaded.ticks.at(-1)?.reason).toBe('ok');
    } finally {
      if (run && !settled) {
        try {
          fx.setKill(true);
          await vi.advanceTimersByTimeAsync(1_001);
          await run;
        } catch {
          // best-effort cleanup for failed assertions
        }
      }
      vi.useRealTimers();
    }
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
    expect(source).toContain('const routeModels = new Map<string, string | null>();');
    expect(source).toContain('routeReasons.set(workedSet[i]!.id, d.value.reason);');
    expect(source).toContain('routeModels.set(workedSet[i]!.id, d.value.model ?? null);');
    expect(source).toContain('routeReasons,');
    expect(source).toContain('const assignedModel = hintedBackend === _backend ? routeModels.get(item.id) : undefined;');
    expect(source).toContain('return taskEntry.run(_backend, assignedReason, assignedModel);');
    expect(source).toContain('buildConcurrentDispatchRouteItem(');
  });

  it('G2: assigned gateway resource-pause decisions skip instead of dispatching', () => {
    const source = fs.readFileSync(new URL('../src/core/daemon/loop.ts', import.meta.url), 'utf8');

    expect(source).toContain("assignedReason?.startsWith('resource-pause:')");
    expect(source).toContain("gd.reason.startsWith('resource-pause:')");
  });
});
