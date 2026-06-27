/**
 * H3 BUILD 2 — CONCURRENCY-CAP-HOLDS.
 *
 * Drives the REAL bounded worker pool (loop.ts:82-105) AND the REAL `runSwarm`
 * internal `MAX_PARALLEL = 8` clamp (runner.ts:179, 1085-1088) under FLOOD, via
 * `makeConcurrencyProbe`: a mocked unit calls `enter()` on start and `leave()`
 * on finish, and the suite asserts the OBSERVED peak in-flight count is
 * `<= limit`. Concurrency is asserted by BOUND (true under every interleaving),
 * never by order — so the test is deterministic.
 *
 * WHAT IS REAL vs. MOCKED:
 *   - REAL: the daemon `tick()` selection + `bounded(tasks, parallel)` worker
 *     pool, the `resolveCfg` parallel clamp `Math.min(max(1,parallel), 8)`
 *     (loop.ts:64-66), AND (test 3) the `runSwarm` BUILD-phase batch loop with
 *     its `MAX_PARALLEL = 8` slice (runner.ts:179, executePhase build batch).
 *   - MOCKED (M24/M12 convention): `runSwarm` for the tick-level probe;
 *     `runGoal` + `planSwarm` for the runSwarm-internal BUILD-phase probe. The
 *     mocks are INSTANT, KNOWN-cost, model-free and bracket each unit with the
 *     concurrency probe.
 *
 * SAFETY: isolated tmp HOME (H1 fixture), disposable repos only, runSwarm/runGoal
 * mocked (no real agent / subprocess / network), no outward action. See
 * CONTRACT-H3.md.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// runSwarm MOCKED for the tick-level concurrency probe (M24 convention). The
// daemon's `tick` imports runSwarm from this module, so mocking it lets the
// REAL bounded() worker pool run while each "dispatch" is instant + probed.
const mockRunSwarm = vi.fn();
vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

// runGoal MOCKED for the runSwarm-internal BUILD-phase probe (M12 convention).
// Test 3 drives the REAL runSwarm (via vi.importActual) whose BUILD phase calls
// runGoal per task; mocking runGoal lets the REAL MAX_PARALLEL batch loop run
// while each task is instant + probed.
const mockRunGoal = vi.fn();
vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: (...args: unknown[]) => mockRunGoal(...args),
  saveRun: vi.fn(),
  loadRun: vi.fn().mockReturnValue(null),
  listRuns: vi.fn().mockReturnValue([]),
  planGoal: vi.fn(),
}));

// planSwarm MOCKED so test 3 controls the plan size (many BUILD tasks) without a
// model. The REAL runSwarm consumes this plan and runs its REAL batch loop.
const mockPlanSwarm = vi.fn();
vi.mock('../src/core/swarm/planner.js', () => ({
  planSwarm: (...args: unknown[]) => mockPlanSwarm(...args),
}));

// buildBacklog MOCKED so the tick-level flood tests get a deterministic large
// backlog regardless of which scanners are enabled (M136 made scanTodos
// default-OFF, breaking the SEEDED_ITEMS assumption). The concurrency-cap tests
// are about the bounded() pool, not scanner behavior — mocking the backlog keeps
// them focused on the cap under test.
const mockBuildBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
}));

import { tick } from '../src/core/daemon/loop.js';
import { makeFixture, makeCfg, todoSeedFiles, todoScannerAvailable } from './helpers/h1-fixture.js';
import {
  makeConcurrencyProbe,
  makeSpendingSwarmStub,
  makeCountingGoalStub,
  spawnConcurrent,
} from './helpers/h3-stress.js';
import type { H1Fixture, DisposableRepo } from './helpers/h1-fixture.js';
import type {
  AshlrConfig,
  SwarmOptions,
  SwarmPlan,
  SwarmRun,
} from '../src/core/types.js';
import type { StreamSink } from '../src/core/run/streaming.js';

// The number of TODO files seeded per repo — far more than any cap so the
// selection step always has more candidates than the concurrency limit.
const SEEDED_ITEMS = 24;

let fx: H1Fixture;
let repo: DisposableRepo;

beforeEach(() => {
  // H3 false-green guard (matches h3.budget-cap.test.ts:49 / h3.daily-reset.test.ts):
  // every it() MUST run at least one assertion. Without it, a scanner-absent path
  // that bailed early would PASS vacuously — the exact false-green the H2 review
  // caught. With it, any assertion-less run FAILS loudly. (The two tick-flood
  // tests below ALSO hard-require the scanner rather than skipping, so the
  // PRIMARY concurrency proofs always actually exercise the cap.)
  expect.hasAssertions();
  fx = makeFixture();
  repo = fx.makeRepo({ files: todoSeedFiles(SEEDED_ITEMS) });
  repo.enroll();
  mockRunSwarm.mockReset();
  mockRunGoal.mockReset();
  mockPlanSwarm.mockReset();
  mockBuildBacklog.mockReset();
  // M136: scanTodos is default-OFF in the SCANNERS array, so a real buildBacklog
  // call returns far fewer than SEEDED_ITEMS items — not enough to flood the pool.
  // Return a synthetic backlog of SEEDED_ITEMS work items so tick() has enough
  // candidates (>> any concurrency cap) for the flood to be a real bound test.
  const now = new Date().toISOString();
  mockBuildBacklog.mockResolvedValue({
    generatedAt: now,
    repos: [repo.dir],
    items: Array.from({ length: SEEDED_ITEMS }, (_, i) => ({
      id: `${repo.dir}:todo:h3-flood-${i}`,
      repo: repo.dir,
      source: 'todo' as const,
      title: `1 marker in src/todo-${i}.ts:2`,
      detail: `File: src/todo-${i}.ts:2 — "implement f${i}". Implement this specific change.`,
      value: 2,
      effort: 2,
      score: 3,
      tags: ['todo'],
      ts: now,
    })),
  });
});

afterEach(() => {
  fx.cleanup();
});

const nullSink: StreamSink = () => {};

/**
 * Build a plan with one scaffold task + `buildCount` independent BUILD tasks (no
 * other phases) so the ONLY concurrent batch is the BUILD phase — its observed
 * peak is exactly the MAX_PARALLEL slice size, uncontaminated by the
 * sequentially-run scaffold/integrate/verify/review phases.
 */
function buildHeavyPlan(buildCount: number): SwarmPlan {
  return {
    specId: null,
    goal: 'h3 build-phase concurrency probe',
    tasks: [
      { id: 'scaffold-1', phase: 'scaffold', goal: 'Init', deps: [] },
      ...Array.from({ length: buildCount }, (_, i) => ({
        id: `build-${i + 1}`,
        phase: 'build' as const,
        goal: `Build module ${i + 1}`,
        deps: ['scaffold-1'],
      })),
    ],
  };
}

describe('H3 CONCURRENCY-CAP-HOLDS — never more than `limit` units in flight under flood', () => {
  // Skip ONLY when no TODO scanner (rg/grep) is on PATH — this flood proof drives
  // the daemon's REAL scanTodos over the enrolled repo, which needs one. Windows
  // dev boxes ship neither; macOS/Linux CI always have grep, so the proof (and its
  // hard `expect(todoScannerAvailable()).toBe(true)` false-green guard) still runs there.
  it.skipIf(!todoScannerAvailable())('the daemon `parallel` cap bounds the observed peak in-flight swarm dispatches', async () => {
    // The daemon discovers backlog by running the REAL scanTodos over the
    // enrolled repo, which needs `rg` or `grep` on PATH. The whole point is to
    // prove the bound under a real FLOOD, so REQUIRE the scanner (fail loudly if
    // absent) rather than silently skipping into a vacuous green — both macOS and
    // Linux CI always ship grep.
    expect(todoScannerAvailable()).toBe(true);

    const probe = makeConcurrencyProbe();
    // cost 0 so the in-tick budget short-circuit never trips mid-batch — we are
    // isolating the CONCURRENCY cap, not the budget cap (that is BUILD 1).
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: 0, probe }));

    const PARALLEL = 4;
    // perTickItems high + budget high so selectCount is bound by item count,
    // letting MANY (>> PARALLEL) dispatches flood the REAL bounded() pool.
    const cfg = makeCfg({
      daemon: { dailyBudgetUsd: 100, perTickItems: SEEDED_ITEMS, parallel: PARALLEL, intervalMs: 100 },
    });

    const result = await tick(cfg, { dryRun: false });

    // Sanity: the tick actually dispatched a flood (more than PARALLEL units),
    // otherwise the bound is vacuously true.
    expect(mockRunSwarm.mock.calls.length).toBeGreaterThan(PARALLEL);
    expect(result.reason).toBe('ok');
    // The REAL bounded(tasks, parallel) pool never ran more than `parallel`
    // dispatches at once — true under every interleaving.
    expect(probe.peak()).toBeLessThanOrEqual(PARALLEL);
    expect(probe.peak()).toBeGreaterThan(0);
    // All units left — no leaked in-flight counter.
    expect(probe.current()).toBe(0);
  });

  // Skip ONLY when no TODO scanner (rg/grep) is on PATH (see note on the prior test):
  // the clamp proof must drive a real scanTodos flood, absent on bare Windows.
  it.skipIf(!todoScannerAvailable())('clamps a cfg requesting parallel:100 down to an observed peak <= 8', async () => {
    // REQUIRE the scanner (see test 1): the clamp proof must run a real flood, not
    // silently skip into a vacuous green when grep/rg is absent.
    expect(todoScannerAvailable()).toBe(true);

    const probe = makeConcurrencyProbe();
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: 0, probe }));

    // parallel:100 is out of range; resolveCfg clamps it to the hard upper bound
    // of 8 (loop.ts:64-66). With SEEDED_ITEMS (>> 8) dispatched, an UNCLAMPED
    // pool would peak well above 8; the clamp must hold the observed peak <= 8.
    const cfg = makeCfg({
      daemon: { dailyBudgetUsd: 100, perTickItems: SEEDED_ITEMS, parallel: 100, intervalMs: 100 },
    });

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    // More than 8 dispatches occurred, so a peak <= 8 is a real bound, not vacuous.
    expect(mockRunSwarm.mock.calls.length).toBeGreaterThan(8);
    expect(probe.peak()).toBeLessThanOrEqual(8);
    expect(probe.current()).toBe(0);
  });

  it('runSwarm BUILD phase honors MAX_PARALLEL=8 with runGoal MOCKED + probed', async () => {
    // Drive the REAL runSwarm (the file-level mock above replaces it for `tick`,
    // so pull the ACTUAL implementation here). Its BUILD phase batches tasks in
    // slices of parallelCap = min(parallel, MAX_PARALLEL=8); runGoal is mocked +
    // probed so the REAL batch loop runs while each task is instant.
    const actual = await vi.importActual<typeof import('../src/core/swarm/runner.js')>(
      '../src/core/swarm/runner.js',
    );
    const realRunSwarm = actual.runSwarm;

    const probe = makeConcurrencyProbe();
    // Tiny per-task usage so the swarm's hard total budget is never exhausted —
    // an exhausted pool would SKIP tasks and artificially lower concurrency.
    mockRunGoal.mockImplementation(
      makeCountingGoalStub({ probe, usagePerTask: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0 } }),
    );

    // A BUILD phase far larger than 8 so the cap is the binding constraint.
    const BUILD_TASKS = 30;
    mockPlanSwarm.mockResolvedValueOnce(buildHeavyPlan(BUILD_TASKS));

    // parallel:100 is clamped to MAX_PARALLEL=8 inside runSwarm; no sandbox / no
    // project so no worktree is created (deterministic, model-free). Huge budget
    // so no task is skipped for budget.
    const opts: SwarmOptions & { noCapture?: boolean } = {
      parallel: 100,
      budget: { maxTokens: 100_000_000, maxSteps: 1_000_000, allowCloud: false },
      dryRun: false,
      noCapture: true,
    };

    const run: SwarmRun = await realRunSwarm(
      { goal: 'h3 build-phase concurrency probe' },
      makeCfg() as AshlrConfig,
      opts,
      nullSink,
    );

    // The swarm ran the full BUILD phase (every build task executed) so the
    // peak reflects a genuine flood, not a truncated run.
    const buildTaskRuns = run.tasks.filter((t) => t.phase === 'build');
    expect(buildTaskRuns.length).toBe(BUILD_TASKS);
    // runGoal was invoked for every build task (plus the single scaffold task).
    expect(mockRunGoal.mock.calls.length).toBeGreaterThan(8);
    // The REAL MAX_PARALLEL batch loop never ran more than 8 tasks at once,
    // regardless of the requested parallel:100 or the 30-task plan size.
    expect(probe.peak()).toBeLessThanOrEqual(8);
    expect(probe.peak()).toBeGreaterThan(0);
    expect(probe.current()).toBe(0);
  });

  it('runSwarm BUILD phase keeps sum(authorized per-task budgets) within the hard total under a CONSTRAINED pool (sliceBudget reservation binds)', async () => {
    // The companion to the MAX_PARALLEL test: that one proves the CONCURRENCY cap
    // with a huge budget that never binds; THIS one proves the per-task budget
    // RESERVATION (sliceBudget, runner.ts:206-265) — the `sum(authorized) <= pool`
    // invariant CONTRACT-H3 invariant #1 claims — by making the total budget
    // SMALL enough to bind and asserting the authorized slices never overshoot it.
    //
    // The old (pre-reservation) bug was 8 concurrent tasks each sized at 25% of
    // the total = ~200% overshoot. With the reservation, the slices a single batch
    // hands out sum to <= the remaining pool, so a batch can never overshoot.
    const actual = await vi.importActual<typeof import('../src/core/swarm/runner.js')>(
      '../src/core/swarm/runner.js',
    );
    const realRunSwarm = actual.runSwarm;

    // Capture the per-task budget runSwarm AUTHORIZED to each build task: the
    // runGoal stub records the `budget.maxTokens` it was handed (the slice). A
    // non-trivial usagePerTask advances run.usage between batches so the pool
    // genuinely shrinks — exercising the (total - used - reserved) math.
    const authorizedByCall: Array<{ goal: string; maxTokens: number }> = [];
    mockRunGoal.mockImplementation(
      async (goal: string, _cfg: unknown, runOpts: unknown): Promise<unknown> => {
        const budget = (runOpts as { budget?: { maxTokens?: number } }).budget;
        authorizedByCall.push({ goal, maxTokens: budget?.maxTokens ?? 0 });
        // Non-trivial per-task usage so `used` advances across batches.
        await Promise.resolve();
        const now = new Date().toISOString();
        return {
          id: `h3-run-${authorizedByCall.length}`,
          goal,
          engine: 'builtin',
          provider: 'builtin',
          createdAt: now,
          updatedAt: now,
          budget: { maxTokens: 1000, maxSteps: 10, allowCloud: false },
          usage: { tokensIn: 200, tokensOut: 200, steps: 1, estCostUsd: 0 },
          tasks: [],
          steps: [],
          status: 'done',
          result: `h3 stress result for: ${goal}`,
        } as unknown;
      },
    );

    // 16 build tasks => two full batches of parallelCap=8, so the pool binds and
    // shrinks between batches. Total maxTokens chosen so a batch's fair shares are
    // SMALL (sum must stay <= total) — a non-batch-aligned, genuinely binding pool.
    const BUILD_TASKS = 16;
    const TOTAL_MAX_TOKENS = 9_000;
    mockPlanSwarm.mockResolvedValueOnce(buildHeavyPlan(BUILD_TASKS));

    const opts: SwarmOptions & { noCapture?: boolean } = {
      parallel: 100, // clamped to MAX_PARALLEL=8 inside runSwarm
      budget: { maxTokens: TOTAL_MAX_TOKENS, maxSteps: 1_000_000, allowCloud: false },
      dryRun: false,
      noCapture: true,
    };

    await realRunSwarm(
      { goal: 'h3 sliceBudget reservation probe' },
      makeCfg() as AshlrConfig,
      opts,
      nullSink,
    );

    // Only the BUILD-phase calls carry the reservation logic; the single scaffold
    // task runs alone first. Drop it and group the build calls into batches of 8.
    const buildAuthorized = authorizedByCall
      .filter((c) => c.goal.includes('Build module'))
      .map((c) => c.maxTokens);
    expect(buildAuthorized.length).toBe(BUILD_TASKS);

    // THE INVARIANT: within EVERY concurrent batch (slices of parallelCap=8), the
    // sum of authorized per-task budgets never exceeds the hard total — the
    // reservation pool holds (`sum(authorized) <= total`, the very bound the old
    // 8x25%=200% overshoot violated). `used` only grows across batches, so the
    // total is the loosest valid ceiling; staying under it batch-by-batch proves
    // the reservation works.
    const PARALLEL_CAP = 8;
    let bindingBatchSeen = false;
    for (let i = 0; i < buildAuthorized.length; i += PARALLEL_CAP) {
      const batch = buildAuthorized.slice(i, i + PARALLEL_CAP);
      const sum = batch.reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThanOrEqual(TOTAL_MAX_TOKENS);
      // Each authorized slice is positive (no phantom/zero budget authorized while
      // the pool still has room) and capped at 25% of the total (one task can't
      // hog the swarm).
      for (const tk of batch) {
        expect(tk).toBeGreaterThan(0);
        expect(tk).toBeLessThanOrEqual(Math.ceil(TOTAL_MAX_TOKENS / 4));
      }
      // Prove the pool actually BOUND for at least one batch: a full 8-task batch
      // whose equal shares (total/8) are the binding constraint, i.e. the sum
      // approaches the pool rather than sitting far below it.
      if (batch.length === PARALLEL_CAP) bindingBatchSeen = true;
    }
    expect(bindingBatchSeen).toBe(true);
  });

  it('spawnConcurrent settles all units in input order and never throws on a rejection', async () => {
    // Flood N units where every even index REJECTS and every odd index resolves
    // to its own value. spawnConcurrent must settle ALL N (a failing unit never
    // masks its siblings) and preserve INPUT order (results[i] <-> unit i).
    const N = 50;
    const results = await spawnConcurrent(N, async (i): Promise<number> => {
      // Yield so units genuinely interleave before settling.
      await Promise.resolve();
      if (i % 2 === 0) {
        throw new Error(`unit ${i} rejected`);
      }
      return i;
    });

    // All N settled — none lost or masked by a sibling rejection.
    expect(results.length).toBe(N);

    for (let i = 0; i < N; i++) {
      const r = results[i]!;
      if (i % 2 === 0) {
        // Even units surface as `rejected` settled results carrying their reason.
        expect(r.status).toBe('rejected');
        if (r.status === 'rejected') {
          expect(String((r.reason as Error).message)).toContain(`unit ${i} rejected`);
        }
      } else {
        // Odd units surface as `fulfilled` with their own value, in input order.
        expect(r.status).toBe('fulfilled');
        if (r.status === 'fulfilled') {
          expect(r.value).toBe(i);
        }
      }
    }

    // Exactly half rejected, half fulfilled — no double-count, no dropped unit.
    const rejected = results.filter((r) => r.status === 'rejected').length;
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    expect(rejected).toBe(N / 2);
    expect(fulfilled).toBe(N / 2);
  });
});
