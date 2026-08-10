/**
 * H3 BUILD 1 — BUDGET-CAP-HOLDS.
 *
 * Drives the REAL `tick()` budget gate and synchronous spend reservations with
 * `runSwarm` MOCKED to a KNOWN per-dispatch cost (makeSpendingSwarmStub). The
 * between-tick gate, selection shrink, minimum per-item envelope, concurrent
 * admission, and durable spend accounting all run for real under demand that
 * would overspend without preventive reservation.
 *
 * SAFETY: isolated tmp HOME (H1 fixture), disposable repos only, runSwarm mocked
 * (no real agent / subprocess / network), no outward action. See CONTRACT-H3.md.
 *
 * DETERMINISM: undersized slices are rejected synchronously before `runSwarm`;
 * admitted stubs report a known `usage.estCostUsd`. Assertions key off launch
 * counts and persisted spend, not discovery order.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/core/daemon/activation-permit.js', () => ({
  consumeDaemonActivationPermit: () => ({
    authorized: true,
    required: false,
    reason: 'test-authorized',
  }),
  isDaemonActivationCapability: () => true,
}));
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
  it('refuses every producer when the per-item reservation is below the minimum envelope', async () => {
    // $0.10 divided across five selected items is $0.02 each, below the
    // conservative $0.05 / 1,000-token minimum. Admission therefore refuses
    // before runSwarm instead of relying on realized spend between calls.
    const costUsd = 0.05;
    const cfg = cfgCaps({ dailyBudgetUsd: 0.1, perTickItems: 5, parallel: 1 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBeGreaterThanOrEqual(2);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(result.spentUsd).toBe(0);
    expect(loadDaemonState().todaySpentUsd).toBe(0);
  });

  it('ends a sequential tick at zero spend when every requested envelope is too small', async () => {
    const costUsd = 0.05;
    const dailyBudgetUsd = 0.1;
    const cfg = cfgCaps({ dailyBudgetUsd, perTickItems: 5, parallel: 1 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    const after = loadDaemonState();
    expect(after.todaySpentUsd).toBeLessThanOrEqual(dailyBudgetUsd);
    expect(after.todaySpentUsd).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('holds the cap with parallel workers by refusing undersized envelopes synchronously', async () => {
    const costUsd = 0.05;
    const dailyBudgetUsd = 0.1;
    const cfg = cfgCaps({ dailyBudgetUsd, perTickItems: 5, parallel: 2 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunSwarm).not.toHaveBeenCalled();
    const after = loadDaemonState();
    expect(after.todaySpentUsd).toBeLessThanOrEqual(dailyBudgetUsd);
    expect(after.todaySpentUsd).toBe(0);
  });

  it('eliminates the legacy non-batch-aligned overshoot before concurrent launch', async () => {
    const costUsd = 0.05;
    const dailyBudgetUsd = 0.125;
    const parallel = 3;
    const cfg = cfgCaps({ dailyBudgetUsd, perTickItems: 5, parallel });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunSwarm).not.toHaveBeenCalled();

    const after = loadDaemonState();
    expect(after.todaySpentUsd).toBeLessThanOrEqual(dailyBudgetUsd);
    expect(after.todaySpentUsd).toBe(0);
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
    const now = new Date();
    const armed = armDaemonSpendGuard({
      itemIds: ['previous-item'],
      daemonStartedAt: null,
      budgetDay: now.toISOString().slice(0, 10),
      dailyBudgetUsd: 1,
      spentUsdAtArm: 0,
      reservedUsd: 1,
      now,
    });
    expect(armed.ok).toBe(true);

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('state-persistence-failed');
    expect(result.itemsConsidered).toBe(0);
    expect(result.spentUsd).toBe(0);
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(readAudit().some((e) => e.action === 'daemon:persistence-failed' && e.summary.includes('unresolved spend guard'))).toBe(true);
  });

  it('shrinks selectCount and still refuses producers below the minimum reservation', async () => {
    // remaining budget = $0.025. The selection math (loop.ts:257-260) caps the
    // selected count by how many MIN_PER_ITEM_USD ($0.01) slices fit:
    //   maxByBudget = max(1, floor(0.025 / 0.01)) = 2
    //   selectCount = min(perTickItems(5), maxByBudget(2), backlog) = 2
    // Items considered still shrinks to two, but the $0.0125 per-item envelopes
    // are too small to authorize model work.
    const cfg = cfgCaps({ dailyBudgetUsd: 0.025, perTickItems: 5, parallel: 1 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd: 0, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    // selectCount shrank to the budget-bounded 2, below the perTickItems of 5.
    expect(result.itemsConsidered).toBe(2);
    expect(result.itemsConsidered).toBeLessThan(5);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('selects one item with near-zero headroom but refuses its producer launch', async () => {
    // remaining = $0.004 => floor(0.004/0.01) = 0, but max(1, …) FLOORS the
    // budget-bounded count at 1. Selection remains observable, while the
    // minimum dispatch envelope prevents the tiny budget from reaching a model.
    const cfg = cfgCaps({ dailyBudgetUsd: 0.004, perTickItems: 5, parallel: 1 });
    mockRunSwarm.mockImplementation(
      makeSpendingSwarmStub({ costUsd: 0, repo: repo.dir, propose: true }),
    );

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(loadDaemonState().todaySpentUsd).toBeLessThanOrEqual(0.004);
  });
});
