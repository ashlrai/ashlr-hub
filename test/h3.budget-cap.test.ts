/**
 * H3 BUILD 1 — BUDGET-CAP-HOLDS.
 *
 * Drives the REAL `tick()` budget gate + in-tick short-circuit (loop.ts) with
 * `runSwarm` MOCKED to a KNOWN per-dispatch cost (makeSpendingSwarmStub), so the
 * REAL accounting (`tickSpent`, `state.todaySpentUsd += tickSpent`) and the
 * REAL budget controls (the between-tick gate loop.ts:176-193, the in-tick
 * `tickSpent >= remainingBudget` short-circuit loop.ts:330-332, the per-item USD
 * slice loop.ts:300-309, the `selectCount` shrink loop.ts:257-260) run for real
 * under a load that WOULD overshoot if uncapped.
 *
 * SAFETY: isolated tmp HOME (H1 fixture), disposable repos only, runSwarm mocked
 * (no real agent / subprocess / network), no outward action. See CONTRACT-H3.md.
 *
 * DETERMINISM: the per-dispatch cost is a KNOWN constant the stub reports via
 * `usage.estCostUsd` — exactly the field loop.ts:370 reads to tally `tickSpent`.
 * Budgets are chosen so the cumulative spend lands on EXACT, integer-multiple
 * boundaries, so the in-tick short-circuit fires at a deterministic dispatch
 * count regardless of scheduling order (the contract's BOUND-not-order rule).
 * Assertions key off `mockRunSwarm` call counts + the persisted `todaySpentUsd`,
 * not on discovery's exact item count, so they hold whatever scanDocs surfaces
 * beyond the seeded TODO markers (discovery yields >= perTickItems items here).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// runSwarm is MOCKED before the daemon loop imports it (M24 convention).
const mockRunSwarm = vi.fn();
vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

// buildBacklog MOCKED so tick() has discoverable work regardless of which
// scanners are enabled (M160 made scanDeps/scanLint/scanHygiene DEFAULT-OFF,
// so a real buildBacklog call over these repos returns ~nothing). The budget-cap
// tests are about the accounting / short-circuit logic, not scanner behavior —
// mocking the backlog keeps them focused on the caps under test.
const mockBuildBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
}));

// Lazy imports after the mock is registered.
import { tick } from '../src/core/daemon/loop.js';
import { armDaemonSpendGuard, daemonStatePath, loadDaemonState, saveDaemonState } from '../src/core/daemon/state.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import { makeFixture, makeCfg, todoSeedFiles } from './helpers/h1-fixture.js';
import { seedMidTickSpend, today } from './helpers/h2-faults.js';
import { makeSpendingSwarmStub } from './helpers/h3-stress.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { H1Fixture, DisposableRepo } from './helpers/h1-fixture.js';

// Number of synthetic work items — more than any perTickItems cap used in this
// suite (max is 5) so the per-tick cap, not the item count, is always the
// binding constraint under test.
const SEEDED_ITEMS = 8;

let fx: H1Fixture;
let repo: DisposableRepo;

beforeEach(() => {
  // H3 false-green guard (mirrors H2): every it() MUST run at least one
  // assertion, so a future empty-stub test fails loudly instead of passing
  // vacuously — the exact risk the H2 review caught and this milestone disproves.
  expect.hasAssertions();
  fx = makeFixture();
  // Seed enough TODO markers that, uncapped, dispatch would overshoot the budget.
  // Discovery (scanTodos + scanDocs) surfaces >= perTickItems items, so the
  // per-tick cap — not the item count — is the binding control under test.
  repo = fx.makeRepo({ files: todoSeedFiles(8) });
  repo.enroll();
  mockRunSwarm.mockReset();
  mockBuildBacklog.mockReset();
  // M160: scanDeps/scanLint/scanHygiene are DEFAULT-OFF, so a real buildBacklog
  // call returns ~nothing. Seed a synthetic backlog so tick() always has
  // SEEDED_ITEMS (>> any perTickItems cap) of discoverable work, keeping the
  // budget/selection/concurrency controls under test rather than the scanners.
  const now = new Date().toISOString();
  mockBuildBacklog.mockResolvedValue({
    generatedAt: now,
    repos: [repo.dir],
    items: Array.from({ length: SEEDED_ITEMS }, (_, i) => ({
      id: `${repo.dir}:todo:h3-budget-${i}`,
      repo: repo.dir,
      source: 'todo' as const,
      title: `1 marker in src/todo-${i}.ts:2`,
      detail: `File: src/todo-${i}.ts:2 — "implement f${i}".`,
      value: 3,
      effort: 2,
      score: 1.5,
      tags: ['todo'],
      ts: now,
    })),
  });
});

afterEach(() => {
  fx.cleanup();
});

/** A daemon cfg with explicit caps for budget-boundary stress. */
function cfgCaps(daemon: {
  dailyBudgetUsd: number;
  perTickItems: number;
  parallel: number;
}): AshlrConfig {
  return makeCfg({ daemon: { ...daemon, intervalMs: 100 } });
}

describe('H3 BUDGET-CAP-HOLDS — tick never overspends the daily cap under load', () => {
  it('stops dispatching MID-batch once cumulative spend reaches the remaining budget (parallel 1)', async () => {
    // Budget = 2 × per-dispatch cost, with perTickItems=5 selected. Sequential
    // (parallel:1) dispatch accumulates 0.05 → 0.10; the 3rd item sees
    // tickSpent(0.10) >= remainingBudget(0.10) and the in-tick short-circuit
    // (loop.ts:330-332) returns dispatched:false WITHOUT calling runSwarm. So
    // exactly 2 of the 5 selected items are ever dispatched.
    const costUsd = 0.05;
    const cfg = cfgCaps({ dailyBudgetUsd: 0.1, perTickItems: 5, parallel: 1 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    // 5 items considered (top-K), but only 2 dispatched before the budget
    // short-circuit halts the rest — runSwarm is called EXACTLY twice.
    expect(result.itemsConsidered).toBeGreaterThanOrEqual(2);
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    // The later (un-dispatched) items spent nothing: realized spend == 2 × cost.
    expect(result.spentUsd).toBeCloseTo(2 * costUsd, 10);
    expect(loadDaemonState().todaySpentUsd).toBeCloseTo(2 * costUsd, 10);
  });

  it('ends a tick with todaySpentUsd <= dailyBudgetUsd even when items would overshoot (parallel 1)', async () => {
    // perTickItems=5 × cost 0.05 = $0.25 of demand against a $0.10 cap — a 2.5×
    // overshoot if uncapped. The short-circuit lands cumulative spend EXACTLY on
    // the cap (2 dispatches × 0.05 = 0.10), so todaySpentUsd <= dailyBudgetUsd.
    //
    // This hard `<= dailyBudgetUsd` cap is exact ONLY at parallel:1 (sequential:
    // tickSpent is updated between each dispatch, so the gate sees realized spend
    // before authorizing the next). At parallel>1 the check-then-act gate admits a
    // whole batch at once and spend can overshoot by up to (parallel-1)×cost — see
    // the BOUNDED OVERSHOOT test below for the honest parallel>1 guarantee.
    const costUsd = 0.05;
    const dailyBudgetUsd = 0.1;
    const cfg = cfgCaps({ dailyBudgetUsd, perTickItems: 5, parallel: 1 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    const after = loadDaemonState();
    // The HARD invariant: realized daily spend never exceeds the daily cap.
    expect(after.todaySpentUsd).toBeLessThanOrEqual(dailyBudgetUsd);
    // …and it would have overshot to $0.25 had the cap not held.
    expect(after.todaySpentUsd).toBeLessThan(5 * costUsd);
    expect(after.todaySpentUsd).toBeCloseTo(dailyBudgetUsd, 10);
  });

  it('holds the cap even with parallel > 1 and many backlog items (BATCH-ALIGNED budget lands exactly on the cap)', async () => {
    // parallel:2 lets up to 2 dispatches run before the shared tally updates, so
    // the short-circuit must hold against a genuinely concurrent batch. Budget =
    // 2 × cost: the first batch of 2 lands cumulative spend on the cap (0.10),
    // and the next batch sees tickSpent(0.10) >= remaining(0.10) and stops.
    //
    // NOTE: this is the BATCH-ALIGNED case (budget == parallel × cost), so spend
    // lands EXACTLY on the cap. The in-tick gate is a check-then-act: the whole
    // first batch passes the gate while tickSpent is still 0, so with a
    // NON-batch-aligned budget the realized spend can OVERSHOOT the cap by up to
    // (parallel-1) × cost — see the bounded-overshoot test below for that case.
    const costUsd = 0.05;
    const dailyBudgetUsd = 0.1;
    const cfg = cfgCaps({ dailyBudgetUsd, perTickItems: 5, parallel: 2 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    // The first concurrent batch (2 slots) dispatches; the rest short-circuit.
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    const after = loadDaemonState();
    expect(after.todaySpentUsd).toBeLessThanOrEqual(dailyBudgetUsd);
    expect(after.todaySpentUsd).toBeCloseTo(dailyBudgetUsd, 10);
  });

  it('BOUNDED OVERSHOOT: with a NON-batch-aligned budget, parallel>1 spend can EXCEED the daily cap but stays within dailyBudgetUsd + (parallel-1)×cost', async () => {
    // The honest in-process guarantee. The in-tick budget gate (loop.ts:330-332)
    // is check-then-act: tickSpent is only incremented AFTER each runSwarm
    // resolves (loop.ts:371), so up to `parallel` concurrent dispatches can all
    // pass the gate while tickSpent is still 0, then each adds its cost. With a
    // budget that is NOT an exact multiple of `parallel × cost`, the realized
    // spend therefore OVERSHOOTS the daily cap — by at most (parallel-1) × cost.
    //
    // Concretely: parallel:3, dailyBudgetUsd=0.125, cost=0.05. The first batch of
    // 3 all pass the gate (tickSpent 0 < 0.125) and dispatch -> tickSpent = 0.15.
    // The next batch sees 0.15 >= 0.125 and short-circuits. Realized spend lands
    // at 0.15: it EXCEEDS the 0.125 cap (the hard-cap claim would be false) but is
    // within 0.125 + (3-1)×0.05 = 0.225 (the real, bounded guarantee).
    const costUsd = 0.05;
    const dailyBudgetUsd = 0.125;
    const parallel = 3;
    const cfg = cfgCaps({ dailyBudgetUsd, perTickItems: 5, parallel });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    // Exactly one concurrent batch of `parallel` dispatched before the next batch
    // short-circuited — the gate let the whole first batch through.
    expect(mockRunSwarm).toHaveBeenCalledTimes(parallel);

    const after = loadDaemonState();
    const overshootBound = dailyBudgetUsd + (parallel - 1) * costUsd;
    // The HONEST in-process invariant: realized spend is BOUNDED by
    // dailyBudgetUsd + (parallel-1)×cost — NOT a hard <= dailyBudgetUsd cap.
    expect(after.todaySpentUsd).toBeLessThanOrEqual(overshootBound);
    expect(after.todaySpentUsd).toBeCloseTo(parallel * costUsd, 10);
    // PROVE the bound (not merely imply a hard cap): with this non-aligned budget
    // the realized spend genuinely EXCEEDS the daily cap.
    expect(after.todaySpentUsd).toBeGreaterThan(dailyBudgetUsd);
  });

  it('refuses entirely when entered exactly at budget (reason budget-exhausted, runSwarm never called)', async () => {
    // todaySpentUsd == dailyBudgetUsd => remainingBudget == 0 => the between-tick
    // gate (loop.ts:177) refuses BEFORE any dispatch: 0 proposals, runSwarm never
    // called, the persisted spend is left exactly at the cap (never bumped).
    const dailyBudgetUsd = 1.0;
    const cfg = cfgCaps({ dailyBudgetUsd, perTickItems: 3, parallel: 2 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd: 0.05, repo: repo.dir, propose: true }),
    );
    seedMidTickSpend({ spentUsd: dailyBudgetUsd });

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('budget-exhausted');
    expect(result.proposalsCreated).toBe(0);
    expect(result.spentUsd).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    // The at-cap spend is preserved exactly — the refusing tick never bumps it.
    expect(loadDaemonState().todaySpentUsd).toBe(dailyBudgetUsd);
  });

  it('refuses entirely when entered OVER budget (reason budget-exhausted, spend preserved)', async () => {
    // A crash/overshoot left todaySpentUsd ABOVE the cap. remainingBudget < 0 =>
    // the gate (loop.ts:177, remainingBudget <= 0) still refuses; the over-budget
    // spend is neither reduced nor doubled, and no swarm is dispatched.
    const dailyBudgetUsd = 0.5;
    const over = 0.9;
    const cfg = cfgCaps({ dailyBudgetUsd, perTickItems: 3, parallel: 2 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd: 0.05, repo: repo.dir, propose: true }),
    );
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: today(),
      todaySpentUsd: over,
      itemsProcessed: 0,
      ticks: [],
    });

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('budget-exhausted');
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(loadDaemonState().todaySpentUsd).toBe(over);
  });

  it('fails closed before dispatch when daemon state is malformed', async () => {
    const cfg = cfgCaps({ dailyBudgetUsd: 1, perTickItems: 3, parallel: 1 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd: 0.05, repo: repo.dir, propose: true }),
    );
    const p = daemonStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'NOT VALID JSON {{{', 'utf8');

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('state-persistence-failed');
    expect(result.itemsConsidered).toBe(0);
    expect(result.spentUsd).toBe(0);
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(readAudit().some((e) => e.action === 'daemon:persistence-failed' && e.result === 'refused')).toBe(true);
  });

  it('fails closed before dispatch when an unresolved spend guard exists', async () => {
    const cfg = cfgCaps({ dailyBudgetUsd: 1, perTickItems: 3, parallel: 1 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd: 0.05, repo: repo.dir, propose: true }),
    );
    const armed = armDaemonSpendGuard(['previous-item']);
    expect(armed.ok).toBe(true);

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('state-persistence-failed');
    expect(result.itemsConsidered).toBe(0);
    expect(result.spentUsd).toBe(0);
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(readAudit().some((e) => e.action === 'daemon:persistence-failed' && e.summary.includes('unresolved spend guard'))).toBe(true);
  });

  it('shrinks selectCount as remaining budget shrinks (never authorizes a full perTickItems slice against tiny headroom)', async () => {
    // remaining budget = $0.025. The selection math (loop.ts:257-260) caps the
    // selected count by how many MIN_PER_ITEM_USD ($0.01) slices fit:
    //   maxByBudget = max(1, floor(0.025 / 0.01)) = 2
    //   selectCount = min(perTickItems(5), maxByBudget(2), backlog) = 2
    // So itemsConsidered shrinks to 2 — BELOW perTickItems — even though 8 TODO
    // items exist and perTickItems is 5. A zero-cost stub keeps the focus on the
    // SELECTION cap (not the spend short-circuit).
    const cfg = cfgCaps({ dailyBudgetUsd: 0.025, perTickItems: 5, parallel: 1 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd: 0, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    // selectCount shrank to the budget-bounded 2, below the perTickItems of 5.
    expect(result.itemsConsidered).toBe(2);
    expect(result.itemsConsidered).toBeLessThan(5);
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
  });

  it('selects at least one item with a near-zero (but positive) budget (selectCount floor >= 1)', async () => {
    // remaining = $0.004 => floor(0.004/0.01) = 0, but max(1, …) FLOORS the
    // budget-bounded count at 1 (loop.ts:258) so the daemon still makes forward
    // progress on one item rather than selecting zero. The per-item USD slice
    // (loop.ts:300) and token conversion (loop.ts:306-309, floored at 1000
    // maxTokens) therefore never authorize a negative/zero/absurd budget.
    const cfg = cfgCaps({ dailyBudgetUsd: 0.004, perTickItems: 5, parallel: 1 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd: 0, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    // The single dispatch carried a sane (positive, floored) token budget — the
    // call did not throw and the spend stayed within the tiny cap.
    expect(loadDaemonState().todaySpentUsd).toBeLessThanOrEqual(0.004);
  });
});
