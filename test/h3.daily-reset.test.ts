/**
 * test/h3.daily-reset.test.ts — H3 BUILD 3: DAILY-RESET-EXACT.
 *
 * MILESTONE H3 "Harden & Prove" — CONCURRENCY & BUDGET STRESS. This suite proves
 * the daily spend reset is EXACT: it zeroes EXACTLY ONCE at the calendar-day
 * boundary and NEVER double-counts and NEVER loses spend. It drives the REAL
 * `resetDayIfNeeded` (state.ts:157-165) and the REAL `tick` accounting block
 * (loop.ts:172-173 the entry reset, loop.ts:416-418 the post-async reset +
 * `todaySpentUsd += tickSpent`), using the H2 `seedMidTickSpend` helper to
 * construct prior/same-day spend through the REAL `saveDaemonState` store.
 *
 * The four guarantees the task names (cite prep notes H3 / CONTRACT-H3 BUILD 3):
 *   (a) SAME-DAY reload PRESERVES `todaySpentUsd` — the reset is a pure no-op
 *       when `todayDate === today` (state.ts:159 returns the input unchanged).
 *   (b) A DATE CHANGE zeroes `todaySpentUsd` EXACTLY ONCE and stamps `todayDate`
 *       (state.ts:160-164), preserving `itemsProcessed` + `ticks` history.
 *   (c) The tick adds spend AFTER the reset (loop.ts:417-418: reset THEN
 *       `+= tickSpent`), so a day-boundary crossing DURING a tick attributes the
 *       new spend to the NEW day and never drops it and never doubles it.
 *   (d) Repeated `resetDayIfNeeded` calls are IDEMPOTENT (converge once, then a
 *       no-op forever after — re-applying never re-zeroes accrued spend).
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM (no live model, no network, no real subprocess):
 *   `resetDayIfNeeded` reads the real wall clock for "today" ONLY. We never
 *   depend on the clock to FLIP a boundary: the rollover branch is exercised by
 *   constructing states with an EXPLICIT past `todayDate` (e.g. yesterday /
 *   '2000-01-01'); the no-op branch by stamping `todayDate = today()`. Both
 *   branches are therefore deterministic regardless of when the test runs. The
 *   one tick that does real (mocked) work binds `runSwarm` to a KNOWN-cost stub
 *   (`makeSpendingSwarmStub`, H3) — the exact `usage.estCostUsd` loop.ts:370
 *   reads to tally `tickSpent` — so the rollover-tick accounting is precise and
 *   model-free.
 *
 * SAFETY (paramount — inherited verbatim from H1/H2):
 *   FRESH isolated tmp HOME per test (makeFixture asserts homedir() == tmp HOME
 *   and refuses to run otherwise); the real ~/.ashlr/daemon.json is NEVER
 *   touched; DISPOSABLE repos only; the real portfolio ({repos:[]}) is NEVER
 *   enrolled beyond a disposable tmp repo. No outward action (PROPOSAL-ONLY).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// runSwarm mock — declared BEFORE the lazy daemon import so loop.ts binds to the
// mock, not the real swarm runner (DETERMINISM: no model subprocess ever spawns).
// Mirrors the M24 / H1 / H2 daemon-test convention verbatim.
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();
vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

import type { DaemonState } from '../src/core/types.js';
import { tick } from '../src/core/daemon/loop.js';
import {
  loadDaemonState,
  saveDaemonState,
  resetDayIfNeeded,
} from '../src/core/daemon/state.js';
import { makeFixture, makeCfg, todoSeedFiles } from './helpers/h1-fixture.js';
import { seedMidTickSpend, reloadDaemonState, today } from './helpers/h2-faults.js';
import { makeSpendingSwarmStub } from './helpers/h3-stress.js';
import type { H1Fixture, DisposableRepo } from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// Fixture lifecycle — a FRESH isolated tmp HOME per test (paramount: NEVER the
// real ~/.ashlr). mockRunSwarm is reset so cross-test leakage can't fake spend.
// ---------------------------------------------------------------------------

let fx: H1Fixture;
let repo: DisposableRepo;

beforeEach(() => {
  // H2/H3 false-green guard: every it() MUST run at least one real assertion, so
  // an unfilled (TODO) body FAILS loudly instead of passing vacuously.
  expect.hasAssertions();
  fx = makeFixture();
  repo = fx.makeRepo({ files: todoSeedFiles(3) });
  repo.enroll();
  mockRunSwarm.mockReset();
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers (test-scoped)
// ---------------------------------------------------------------------------

/** A calendar day `daysAgo` days before today, in the YYYY-MM-DD form state uses. */
function dateNDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Persist (via the REAL saveDaemonState) a prior-DAY daemon state with explicit
 * spend + history, so the rollover branch of resetDayIfNeeded is exercised
 * deterministically (its `todayDate` is in the PAST relative to the wall clock).
 */
function seedPriorDayState(opts: {
  todayDate: string;
  spentUsd: number;
  itemsProcessed: number;
  ticks: DaemonState['ticks'];
}): DaemonState {
  const state: DaemonState = {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: new Date().toISOString(),
    todayDate: opts.todayDate,
    todaySpentUsd: opts.spentUsd,
    itemsProcessed: opts.itemsProcessed,
    ticks: opts.ticks,
  };
  saveDaemonState(state);
  return state;
}

// ===========================================================================
// (a) SAME-DAY reload PRESERVES todaySpentUsd — the reset is a pure no-op.
// ===========================================================================

describe('H3 DAILY-RESET-EXACT — (a) a same-day reload preserves todaySpentUsd (no zeroing, no double-count)', () => {
  it('resetDayIfNeeded is an identity no-op when todayDate === today (spend preserved EXACTLY)', () => {
    // seedMidTickSpend stamps todayDate = today(), so the reset must take the
    // no-op branch (state.ts:159) and return the spend UNCHANGED — not zeroed,
    // not doubled.
    const X = 0.6;
    seedMidTickSpend({ spentUsd: X });

    const loaded = loadDaemonState();
    expect(loaded.todayDate).toBe(today());
    expect(loaded.todaySpentUsd).toBe(X);

    const reset = resetDayIfNeeded(loaded);
    expect(reset.todaySpentUsd).toBe(X); // preserved exactly
    expect(reset.todaySpentUsd).not.toBe(0); // not zeroed
    expect(reset.todaySpentUsd).not.toBe(2 * X); // not doubled
    expect(reset.todayDate).toBe(today()); // date unchanged
    // No-op branch returns the SAME reference (state.ts:159 `return s`), proving
    // it neither rebuilt nor mutated the state on a same-day call.
    expect(reset).toBe(loaded);
  });

  it('a same-day reload through loadDaemonState round-trips the spend unchanged', () => {
    // The reload the tick performs (loadDaemonState) must surface the persisted
    // same-day spend intact — the value the budget gate then reads.
    const X = 0.37;
    seedMidTickSpend({ spentUsd: X });
    expect(reloadDaemonState().todaySpentUsd).toBe(X);
    expect(resetDayIfNeeded(reloadDaemonState()).todaySpentUsd).toBe(X);
  });
});

// ===========================================================================
// (b) A DATE CHANGE zeroes todaySpentUsd exactly ONCE and stamps today;
//     itemsProcessed + ticks history are preserved.
// ===========================================================================

describe('H3 DAILY-RESET-EXACT — (b) a date change zeroes todaySpentUsd exactly once and stamps today (history preserved)', () => {
  it('a prior-day todayDate zeroes spend, stamps today, and preserves itemsProcessed + ticks', () => {
    const yesterday = dateNDaysAgo(1);
    const ticks: DaemonState['ticks'] = [
      { ts: new Date(Date.now() - 2000).toISOString(), itemsConsidered: 2, proposalsCreated: 1, spentUsd: 0.3, reason: 'ok' },
      { ts: new Date(Date.now() - 1000).toISOString(), itemsConsidered: 1, proposalsCreated: 0, spentUsd: 0.2, reason: 'ok' },
    ];
    seedPriorDayState({ todayDate: yesterday, spentUsd: 9.99, itemsProcessed: 7, ticks });

    const reset = resetDayIfNeeded(loadDaemonState());

    // Zeroed exactly once + stamped to today.
    expect(reset.todaySpentUsd).toBe(0);
    expect(reset.todayDate).toBe(today());
    // History + cumulative progress survive the rollover (state.ts spreads ...s).
    expect(reset.itemsProcessed).toBe(7);
    expect(reset.ticks).toHaveLength(2);
    expect(reset.ticks.map((t) => t.spentUsd)).toEqual([0.3, 0.2]);
  });

  it('a far-past todayDate is also zeroed exactly once (the boundary is date-difference, not adjacency)', () => {
    seedPriorDayState({ todayDate: '2000-01-01', spentUsd: 12_345.0, itemsProcessed: 3, ticks: [] });

    const loaded = loadDaemonState();
    const reset = resetDayIfNeeded(loaded);
    expect(reset.todaySpentUsd).toBe(0);
    expect(reset.todayDate).toBe(today());
    expect(reset.itemsProcessed).toBe(3); // preserved
    // Returns a NEW object on the rollover branch (state.ts:160-164), distinct
    // from the input — the complement of the no-op branch's identity return.
    expect(reset).not.toBe(loaded);
  });

  it('a daemon tick over a prior-day state zeroes the stale spend EXACTLY ONCE and persists today', async () => {
    // The full tick path: a past-dated state is rolled forward + zeroed by the
    // tick's reset. The mock reports zero cost so tickSpent stays 0 and the reset
    // is the only thing that touches todaySpentUsd — proving the zeroing is
    // exactly once (not zero-then-re-add, not double-zero).
    seedPriorDayState({ todayDate: '2000-01-01', spentUsd: 5.0, itemsProcessed: 4, ticks: [] });
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: 0 }));

    await tick(makeCfg(), { dryRun: false });

    const after = reloadDaemonState();
    expect(after.todayDate).toBe(today()); // rolled forward
    expect(after.todaySpentUsd).toBe(0); // stale 5.0 zeroed exactly once, +0 spend
    expect(after.itemsProcessed).toBeGreaterThanOrEqual(4); // prior progress preserved (never reset)
  });
});

// ===========================================================================
// (c) The tick adds spend AFTER the reset, so a day-boundary crossing during a
//     tick attributes spend to the NEW day and never drops or doubles it.
// ===========================================================================

describe('H3 DAILY-RESET-EXACT — (c) the reset precedes todaySpentUsd += tickSpent, so a rollover tick counts only the new spend', () => {
  it('a rollover tick counts ONLY the new realized spend S (not X+S, not 0, not 2S)', async () => {
    // A prior-day state carried X = $4.00. A tick today crosses the boundary:
    // the entry reset (loop.ts:173) AND the post-async reset (loop.ts:417) zero
    // the stale X, THEN `+= tickSpent` adds only the new realized S. So the
    // counter must end EXACTLY at S — the stale X is dropped (correctly, it was
    // yesterday's), the new S is counted once.
    const X = 4.0;
    seedPriorDayState({ todayDate: dateNDaysAgo(1), spentUsd: X, itemsProcessed: 2, ticks: [] });

    const perCall = 0.001;
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: perCall, repo: repo.dir, propose: true }));

    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('ok');
    expect(mockRunSwarm).toHaveBeenCalled();

    const S = result.spentUsd; // the realized spend this tick (perCall * dispatches)
    expect(S).toBeGreaterThan(0);

    const after = reloadDaemonState();
    expect(after.todayDate).toBe(today());
    // EXACTLY S: yesterday's X was zeroed by the reset that PRECEDES the add.
    expect(after.todaySpentUsd).toBeCloseTo(S, 10);
    // Explicitly NOT carried-over (X + S), NOT lost (0), NOT doubled (2S).
    expect(after.todaySpentUsd).not.toBeCloseTo(X + S, 10);
    expect(after.todaySpentUsd).not.toBe(0);
    expect(after.todaySpentUsd).not.toBeCloseTo(2 * S, 10);
  });

  it('a SAME-day tick ADDS this tick S to the preserved prior X (X + S) — the reset is a no-op, spend is never dropped', async () => {
    // The complement of the rollover case: on the SAME day the reset must NOT
    // fire, so the new spend ADDS to the preserved prior spend (X + S). This
    // proves "never loses spend": the add path is reached and the prior X is
    // carried, not zeroed.
    const X = 0.2;
    seedMidTickSpend({ spentUsd: X }); // stamps today() => same-day, no reset

    const perCall = 0.001;
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: perCall, repo: repo.dir, propose: true }));

    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('ok');
    const S = result.spentUsd;
    expect(S).toBeGreaterThan(0);

    const after = reloadDaemonState();
    expect(after.todayDate).toBe(today());
    expect(after.todaySpentUsd).toBeCloseTo(X + S, 10); // prior preserved + new added once
    expect(after.todaySpentUsd).not.toBeCloseTo(2 * X, 10);
    expect(after.todaySpentUsd).not.toBeCloseTo(S, 10); // X was NOT dropped
  });

  it('the post-async re-check (loop.ts:417) accounts spend to TODAY even when the loaded state is stale-dated', async () => {
    // Models a long tick whose work crosses midnight: the state RELOADED in the
    // accounting block (loop.ts:416) is past-dated, so the post-async
    // resetDayIfNeeded (loop.ts:417) must roll it to today BEFORE `+= tickSpent`.
    // We force the reloaded state to be stale-dated by having the mock, during
    // the tick's async work, persist a past-dated todayDate — exactly what a
    // tick that began before midnight and finished after would reload. The new
    // spend must then land on TODAY's freshly-zeroed counter, never on the stale
    // date and never doubled onto the stale spend.
    const stalePriorSpend = 3.0;
    const spendStub = makeSpendingSwarmStub({ costUsd: 0.002, repo: repo.dir, propose: true });
    mockRunSwarm.mockImplementation(async (...args: unknown[]): Promise<unknown> => {
      // Simulate the day-boundary crossing DURING the tick's async work: a
      // writer (here, the in-flight work) leaves a past-dated state on disk that
      // the accounting block (loop.ts:416) will reload.
      const s = loadDaemonState();
      s.todayDate = dateNDaysAgo(1);
      s.todaySpentUsd = stalePriorSpend;
      saveDaemonState(s);
      // Then report a known cost so loop.ts:370-371 tallies a precise tickSpent.
      return spendStub(...args);
    });

    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('ok');
    const S = result.spentUsd;
    expect(S).toBeGreaterThan(0);

    const after = reloadDaemonState();
    // The post-async reset rolled the stale date to today and zeroed the stale
    // spend, THEN added the new S — so the counter is exactly S on today's date.
    expect(after.todayDate).toBe(today());
    expect(after.todaySpentUsd).toBeCloseTo(S, 10);
    // The stale prior spend written mid-tick was NOT carried into today.
    expect(after.todaySpentUsd).not.toBeCloseTo(stalePriorSpend + S, 10);
  });
});

// ===========================================================================
// (d) Repeated resetDayIfNeeded calls are IDEMPOTENT.
// ===========================================================================

describe('H3 DAILY-RESET-EXACT — (d) repeated resetDayIfNeeded calls are idempotent', () => {
  it('re-applying resetDayIfNeeded to an already-reset (today-dated) state is a no-op every time', () => {
    // After the first rollover the state is today-dated with spend 0; every
    // subsequent reset must return it UNCHANGED (the same-day no-op branch), so
    // chaining the function never re-zeroes or mutates.
    seedPriorDayState({ todayDate: '2000-01-01', spentUsd: 8.0, itemsProcessed: 5, ticks: [] });

    const first = resetDayIfNeeded(loadDaemonState());
    expect(first.todayDate).toBe(today());
    expect(first.todaySpentUsd).toBe(0);

    // Re-apply N times: every call is the identity no-op (same reference).
    let cur = first;
    for (let i = 0; i < 5; i++) {
      const next = resetDayIfNeeded(cur);
      expect(next).toBe(cur); // identity no-op — never rebuilds
      expect(next.todaySpentUsd).toBe(0);
      expect(next.todayDate).toBe(today());
      expect(next.itemsProcessed).toBe(5); // preserved across every re-apply
      cur = next;
    }
  });

  it('idempotent reset NEVER re-zeroes spend accrued AFTER the boundary (one-shot on the date change)', () => {
    // The reset fires once on the date change; spend accrued afterward on the
    // SAME day must survive subsequent resets (it must not be repeatedly wiped).
    const rolled = resetDayIfNeeded({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: dateNDaysAgo(2),
      todaySpentUsd: 1.0,
      itemsProcessed: 0,
      ticks: [],
    });
    expect(rolled.todaySpentUsd).toBe(0); // zeroed once
    expect(rolled.todayDate).toBe(today());

    // Accrue same-day spend (as a real working tick would), then re-reset.
    const accrued: DaemonState = { ...rolled, todaySpentUsd: 0.45 };
    const again = resetDayIfNeeded(accrued);
    expect(again.todaySpentUsd).toBe(0.45); // preserved, NOT re-zeroed
    expect(again).toBe(accrued); // identity no-op (same calendar day)
  });

  it('repeated full daemon ticks after a rollover never re-zero accrued same-day spend', async () => {
    // End-to-end idempotency through the REAL tick path: a past-dated state is
    // rolled forward + zeroed by the first tick; subsequent same-day ticks add
    // their own spend and NEVER re-apply the rollover reset.
    seedPriorDayState({ todayDate: '2000-01-01', spentUsd: 50.0, itemsProcessed: 1, ticks: [] });

    const perCall = 0.001;
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: perCall, repo: repo.dir, propose: true }));

    const t1 = await tick(makeCfg(), { dryRun: false });
    expect(t1.reason).toBe('ok');
    const afterFirst = reloadDaemonState();
    expect(afterFirst.todayDate).toBe(today());
    // First tick: stale 50.0 zeroed once, only this tick's S counted.
    expect(afterFirst.todaySpentUsd).toBeCloseTo(t1.spentUsd, 10);

    const t2 = await tick(makeCfg(), { dryRun: false });
    expect(t2.reason).toBe('ok');
    const afterSecond = reloadDaemonState();
    // Second same-day tick ADDS its spend; the reset did NOT fire again (would
    // have wiped the first tick's spend). So spend strictly grew, never re-zeroed.
    expect(afterSecond.todaySpentUsd).toBeCloseTo(t1.spentUsd + t2.spentUsd, 10);
    expect(afterSecond.todaySpentUsd).toBeGreaterThan(afterFirst.todaySpentUsd);
    expect(afterSecond.todayDate).toBe(today());
  });
});
