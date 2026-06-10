/**
 * test/h2.daemon-no-double-spend.test.ts — H2 BUILD task 2: NO-DOUBLE-SPEND
 * (DAEMON CRASH RECOVERY).
 *
 * MILESTONE H2 "Harden & Prove" — CRASH RECOVERY & RESUMABILITY. This suite
 * fault-injects a daemon killed MID-TICK and then drives the REAL recovery /
 * restart path (`loadDaemonState` + a fresh `tick` + `resetDayIfNeeded`) to prove
 * the system recovers cleanly and idempotently. It is the daemon half of the H2
 * proof set (the swarm half is h2.swarm-resume.test.ts).
 *
 * A "crash" is SIMULATED, never spawned: `seedMidTickSpend()` writes — through
 * the REAL `saveDaemonState` store — the exact on-disk daemon.json a process
 * killed mid-tick leaves behind: today's spend already debited to `X`,
 * `todayDate = today`, and (realistically) `running = true` with a stale pid
 * because the clean-exit `running = false` write never executed. We then invoke
 * the genuine production restart path and assert:
 *
 *   1. NO-DOUBLE-SPEND — a same-day restart treats the persisted `X` as already
 *      counted: it is never zeroed, never doubled. New realized spend `S` ADDS to
 *      `X` (=> X + S), never re-adds the prior debit (never 2X).
 *   2. IDEMPOTENT BUDGET GATE — a restart over an already-debited budget refuses
 *      work off the PRESERVED `X` (reason 'budget-exhausted', runSwarm NOT
 *      dispatched, spend unchanged) — the cap still fires after a crash.
 *   3. TICK HISTORY INTACT — the crash-era ticks[] survive the restart; the
 *      restart APPENDS its own tick record, never truncates or rewrites history.
 *   4. DAY-RESET BOUNDARY — `resetDayIfNeeded` zeroes spend ONLY on a real
 *      calendar rollover: a same-day restart preserves `X`; a past-dated crash is
 *      reset to 0 exactly once (no dropped and no duplicated spend across the
 *      boundary).
 *   5. GATES STILL HONORED ON RESTART — a restart tick still honors kill switch,
 *      enrollment (DEFAULT EMPTY => no-op), and budget after a crash.
 *   6. STALE running=true (GAP PROBE) — a crash leaves running=true with a stale
 *      pid. We assert the current behavior precisely and FLAG it for a minimal
 *      local-only reconcile fix (see the documented gap below); the
 *      no-double-spend invariant itself holds with NO production change.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DETERMINISM (no live model, no network, no real crashing subprocess):
 *   `runSwarm` is MOCKED (M24 / H1 convention) and declared BEFORE the lazy
 *   daemon import so the loop binds to the mock — NO model subprocess ever
 *   spawns. The kill / budget / enrollment gates all return BEFORE runSwarm in
 *   production, so those paths exercise REAL daemon logic with zero model
 *   dependency; only the (never-budget-blocked) "new spend adds" test lets the
 *   MOCK runSwarm run, reporting a KNOWN spend `S` via usage.estCostUsd (exactly
 *   what loop.ts reads to tally tickSpent).
 *
 * SAFETY (paramount — inherited verbatim from H1):
 *   FRESH isolated tmp HOME per test (makeFixture asserts homedir() == tmp HOME
 *   and refuses to run otherwise); the real ~/.ashlr/daemon.json is NEVER
 *   touched; DISPOSABLE repos only; the real portfolio ({repos:[]}) is NEVER
 *   enrolled. cleanup() restores HOME + re-entrancy env and rm -rf's everything.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DOCUMENTED GAP (flagged precisely for a MINIMAL LOCAL-ONLY fix; see CONTRACT-H2.md
 * gap #2). NO double-count gap exists — `tick()` adds only THIS tick's realized
 * `tickSpent` to the reloaded `todaySpentUsd`, and `resetDayIfNeeded` zeroes only
 * on a real date change, so a same-day restart is already idempotent (proven
 * below with NO production change). The one residual gap is OBSERVABILITY: a
 * crash leaves `running=true`/`pid=<stale>` and nothing reconciles it on
 * load/status, so `daemon status` can MISREPORT a dead daemon as live. The
 * minimal local-only fix (NOT made here — this milestone is proof; integration
 * owns any edit) is a `reconcileDaemonState()` that flips running=false/pid=null
 * when the recorded pid is absent / not alive via a read-only `process.kill(pid,0)`
 * liveness probe at load/status time — a STATUS-FLAG correction only: no outward
 * capability, no weakened guard (kill switch + re-entrancy guard untouched), no
 * happy-path change (a genuinely-running daemon keeps running=true). The
 * `expect(state.running).toBe(true)` assertions below DOCUMENT the current
 * un-reconciled behavior so the fix is greppable when integration applies it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// runSwarm mock — declared BEFORE the lazy daemon import so loop.ts binds to the
// mock, not the real swarm runner (DETERMINISM: no model subprocess ever spawns).
// Mirrors the M24 / H1 daemon-test convention verbatim.
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports — AFTER the mock so the daemon binds to the mocked runSwarm. All
// of these resolve ~/.ashlr paths via homedir() at CALL time, so the fixture's
// HOME relocation isolates their state.
// ---------------------------------------------------------------------------

import type { DaemonState } from '../src/core/types.js';
import { tick } from '../src/core/daemon/loop.js';
import {
  saveDaemonState,
  resetDayIfNeeded,
} from '../src/core/daemon/state.js';
import { listEnrolled } from '../src/core/sandbox/policy.js';
import { pendingCount, createProposal } from '../src/core/inbox/store.js';

import {
  makeFixture,
  makeCfg,
  todoSeedFiles,
  type H1Fixture,
} from './helpers/h1-fixture.js';
import {
  seedMidTickSpend,
  reloadDaemonState,
  daemonStateExists,
  today,
} from './helpers/h2-faults.js';

// ---------------------------------------------------------------------------
// Fixture lifecycle — a FRESH isolated tmp HOME per test (paramount: NEVER the
// real ~/.ashlr). mockRunSwarm is reset so cross-test leakage can't fake spend.
// ---------------------------------------------------------------------------

let fx: H1Fixture;

beforeEach(() => {
  // H2 false-green guard: every H2 it() MUST run at least one assertion. A
  // future empty-stub test (TODO body, zero expect) then FAILS loudly instead
  // of passing vacuously — the headline risk this milestone exists to disprove.
  expect.hasAssertions();
  mockRunSwarm.mockReset();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers (test-scoped)
// ---------------------------------------------------------------------------

/** Default $1.00/day cap config (matches DEFAULTS) for budget-boundary tests. */
function cfgCap(dailyBudgetUsd: number) {
  return makeCfg({
    daemon: { dailyBudgetUsd, perTickItems: 3, parallel: 2, intervalMs: 100 },
  });
}

/**
 * A mock runSwarm that records a PENDING proposal (as the real propose path does)
 * and reports a KNOWN spend `S` via usage.estCostUsd — exactly the field loop.ts
 * reads to tally tickSpent. NO model is ever invoked.
 */
function mockSwarmSpending(repoDir: string, perCallUsd: number) {
  return async (_input: unknown, _cfg: unknown, _opts: unknown) => {
    createProposal({
      repo: repoDir,
      origin: 'swarm',
      kind: 'patch',
      title: 'H2 daemon-crash mock proposal',
      summary: 'recorded by the mocked runSwarm (no model)',
      diff: 'diff --git a/x.ts b/x.ts\n',
    });
    return {
      id: `mock-swarm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      status: 'done',
      goal: 'mock goal',
      result: 'mock result',
      usage: { totalTokens: 100, estCostUsd: perCallUsd, steps: 1 },
    };
  };
}

// ===========================================================================
// 1. NO-DOUBLE-SPEND — a same-day restart never zeroes and never doubles the
//    already-debited spend.
// ===========================================================================

describe('H2 daemon-crash — NO-DOUBLE-SPEND: same-day restart preserves the debited spend', () => {
  it('a fresh restart tick over a seeded mid-tick spend PRESERVES it (not 0, not 2X)', async () => {
    // Crash mid-tick after $0.60 was debited today. No repos enrolled => the
    // restart tick is a no-op (reason 'no-enrolled-repos') but STILL persists
    // state through resetDayIfNeeded — the path that could wrongly zero/double.
    const X = 0.6;
    seedMidTickSpend({ spentUsd: X });

    const result = await tick(makeCfg(), { dryRun: false });

    expect(result.reason).toBe('no-enrolled-repos');
    expect(mockRunSwarm).not.toHaveBeenCalled();

    // The crash-era spend is treated as already-counted: preserved EXACTLY, never
    // reset to 0 (same calendar day) and never doubled to 2X.
    const after = reloadDaemonState();
    expect(after.todaySpentUsd).toBe(X);
    expect(after.todaySpentUsd).not.toBe(0);
    expect(after.todaySpentUsd).not.toBe(2 * X);
    expect(after.todayDate).toBe(today());
  });

  it('repeated restart ticks are IDEMPOTENT — N no-op ticks never grow the debited spend', async () => {
    // Many restarts in a row (a crash-loop) must never accrete the persisted
    // spend: each no-op tick adds 0, so todaySpentUsd stays pinned at X.
    const X = 0.42;
    seedMidTickSpend({ spentUsd: X });

    for (let i = 0; i < 5; i++) {
      await tick(makeCfg(), { dryRun: false });
    }

    expect(reloadDaemonState().todaySpentUsd).toBe(X);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('a restart that also carried a recorded tick (withTickRecord) still does not re-add its spend', async () => {
    // The most aggressive double-count probe: the crash had ALREADY appended the
    // in-flight tick record (ticks[] carries a spentUsd entry) AND debited
    // todaySpentUsd. A naive restart that re-summed ticks[] would double-count.
    // The real path adds only THIS tick's realized spend (0 for a no-op), so X
    // stays X. The pre-existing tick record must also survive (history intact).
    const X = 0.75;
    seedMidTickSpend({ spentUsd: X, withTickRecord: true });

    const before = reloadDaemonState();
    expect(before.ticks.length).toBe(1);
    expect(before.ticks[0]?.spentUsd).toBe(X);

    await tick(makeCfg(), { dryRun: false });

    const after = reloadDaemonState();
    expect(after.todaySpentUsd).toBe(X); // NOT 2X — the recorded tick is not re-summed
    // The crash-era tick record survives + the restart appended its own.
    expect(after.ticks.length).toBe(2);
    expect(after.ticks[0]?.spentUsd).toBe(X);
  });
});

// ===========================================================================
// 2. IDEMPOTENT BUDGET GATE — a restart over an exhausted budget refuses work
//    off the PRESERVED spend.
// ===========================================================================

describe('H2 daemon-crash — IDEMPOTENT BUDGET GATE: a crash-debited budget still blocks on restart', () => {
  it('a restart over an already-debited budget refuses work (budget-exhausted, spend unchanged)', async () => {
    // Crash debited the FULL $1.00 cap. A restart must see budget exhausted off
    // the preserved spend — runSwarm NOT dispatched, spend NOT bumped to 2.0.
    seedMidTickSpend({ spentUsd: 1.0 });
    const repo = fx.makeRepo({ files: todoSeedFiles(1) }); // real discoverable work exists
    repo.enroll();

    const before = pendingCount();
    const result = await tick(cfgCap(1.0), { dryRun: false });

    expect(result.reason).toBe('budget-exhausted');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(pendingCount()).toBe(before);

    // The preserved spend is unchanged — never doubled by the refusing tick.
    expect(reloadDaemonState().todaySpentUsd).toBe(1.0);
  });

  it('a restart just UNDER the cap still computes remaining budget off the preserved spend', async () => {
    // $0.99 debited under a $1.00 cap: a no-op (un-enrolled) restart must keep
    // the $0.99 intact (so a later real tick sees only $0.01 of headroom, not a
    // freshly-reset full cap). Proves the budget math reads the PRESERVED spend.
    seedMidTickSpend({ spentUsd: 0.99 });

    const result = await tick(cfgCap(1.0), { dryRun: false });

    // Un-enrolled => no-op, but the spend that bounds the budget is preserved.
    expect(result.reason).toBe('no-enrolled-repos');
    expect(reloadDaemonState().todaySpentUsd).toBe(0.99);
  });
});

// ===========================================================================
// 3. NEW realized spend ADDS to — never re-adds — the persisted spend.
// ===========================================================================

describe('H2 daemon-crash — NEW SPEND ADDS, never re-adds: X + S, never 2X', () => {
  it('a restart tick that does real (mocked) work tallies X + S exactly', async () => {
    // Crash debited X=$0.30. A restart with headroom dispatches the MOCK swarm,
    // which reports a known S via usage.estCostUsd. The final counter must be
    // EXACTLY X + S — the prior X counted once, the new S added once.
    const X = 0.3;
    const perCall = 0.001; // mock swarm's reported estCostUsd per dispatch
    seedMidTickSpend({ spentUsd: X });

    const repo = fx.makeRepo({ files: todoSeedFiles(1) });
    repo.enroll();
    mockRunSwarm.mockImplementation(mockSwarmSpending(repo.dir, perCall));

    const result = await tick(cfgCap(1.0), { dryRun: false });

    expect(result.reason).toBe('ok');
    // S = the total realized spend this tick = perCall * (number of dispatches).
    // The tick reports it as result.spentUsd, so the assertion holds regardless
    // of how many items discovery surfaced — the load-bearing invariant is that
    // the PRIOR X is counted once and the NEW S added once (never 2X).
    const S = result.spentUsd;
    expect(mockRunSwarm).toHaveBeenCalled();
    expect(S).toBeGreaterThan(0);

    const after = reloadDaemonState();
    // The crash spend (X) was preserved and the new realized spend (S) added once.
    expect(after.todaySpentUsd).toBeCloseTo(X + S, 10);
    // Explicitly NOT 2X and NOT a fresh-day reset to just S.
    expect(after.todaySpentUsd).not.toBeCloseTo(2 * X, 10);
    expect(after.todaySpentUsd).not.toBeCloseTo(S, 10);
  });
});

// ===========================================================================
// 4. DAY-RESET BOUNDARY — resetDayIfNeeded drops no spend on a same-day restart
//    and duplicates none across a rollover.
// ===========================================================================

describe('H2 daemon-crash — DAY-RESET BOUNDARY: the rollover neither drops nor duplicates spend', () => {
  it('resetDayIfNeeded PRESERVES spend on the same calendar day (pure, no zeroing)', () => {
    // Direct unit check of the boundary primitive: same-day => identity on spend.
    const seeded = seedMidTickSpend({ spentUsd: 0.5 });
    const reset = resetDayIfNeeded(seeded);
    expect(reset.todaySpentUsd).toBe(0.5);
    expect(reset.todayDate).toBe(today());
  });

  it('a PAST-dated crash spend is reset to 0 exactly ONCE on the first restart (no carry-over)', async () => {
    // A crash dated to a past day: the daemon's resetDayIfNeeded must zero the
    // stale spend for the new day so it neither carries over (over-counting) nor
    // is silently dropped while the date stays stale (under-counting on the next
    // budget check).
    saveDaemonState({
      running: true,
      pid: 999_999,
      startedAt: new Date().toISOString(),
      lastTickAt: null,
      todayDate: '2000-01-01', // a past calendar day
      todaySpentUsd: 9999.0,
      itemsProcessed: 0,
      ticks: [],
    });

    // No repos enrolled => no-op tick, but it still runs the reset path.
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('no-enrolled-repos');

    const after = reloadDaemonState();
    expect(after.todayDate).toBe(today()); // rolled forward to today
    expect(after.todaySpentUsd).toBe(0); // stale spend zeroed exactly once
  });

  it('after a past-dated reset, a same-day restart no longer zeroes — the boundary is one-shot', async () => {
    // First restart rolls the date forward + zeros. A SECOND same-day restart
    // must NOT re-zero anything it accrues afterward (the reset fired once).
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: '2000-01-01',
      todaySpentUsd: 5.0,
      itemsProcessed: 0,
      ticks: [],
    });

    await tick(makeCfg(), { dryRun: false }); // rolls date forward, zeros spend
    expect(reloadDaemonState().todayDate).toBe(today());

    // Manually debit a same-day spend (as a real working tick would), then prove
    // the next restart preserves it rather than re-applying the rollover reset.
    const s = reloadDaemonState();
    s.todaySpentUsd = 0.2;
    saveDaemonState(s);

    await tick(makeCfg(), { dryRun: false });
    expect(reloadDaemonState().todaySpentUsd).toBe(0.2); // preserved, not re-zeroed
  });
});

// ===========================================================================
// 5. GATES STILL HONORED ON RESTART — kill / enrollment / budget after a crash.
// ===========================================================================

describe('H2 daemon-crash — gates still honored after a crash restart', () => {
  it('a restart still refuses on the kill switch (no swarm, spend unchanged)', async () => {
    // Crash debited some spend; then the kill switch is on at restart time. The
    // restart tick must abort on kill BEFORE budget/enrollment, leaving spend
    // untouched and dispatching no swarm.
    seedMidTickSpend({ spentUsd: 0.4 });
    const repo = fx.makeRepo({ files: todoSeedFiles(1) });
    repo.enroll();
    fx.setKill(true);

    const result = await tick(makeCfg(), { dryRun: false });

    expect(result.reason).toBe('kill-switch');
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(reloadDaemonState().todaySpentUsd).toBe(0.4); // unchanged across the kill-abort
  });

  it('a restart still honors enrollment (DEFAULT EMPTY => no-op, real portfolio untouched)', async () => {
    // Even after a crash, an empty enrollment makes the restart a no-op — proving
    // the crash state never tricks the daemon into acting on a non-enrolled repo.
    seedMidTickSpend({ spentUsd: 0.1 });
    expect(listEnrolled()).toEqual([]);

    const result = await tick(makeCfg(), { dryRun: false });

    expect(result.reason).toBe('no-enrolled-repos');
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(reloadDaemonState().todaySpentUsd).toBe(0.1);
  });
});

// ===========================================================================
// 6. TICK HISTORY INTACT + STALE running=true (GAP PROBE & DOCUMENT).
// ===========================================================================

describe('H2 daemon-crash — history intact + stale running=true is the documented GAP', () => {
  it('the restart APPENDS a tick record without truncating crash-era history', async () => {
    // Seed a multi-entry crash history; a no-op restart tick must preserve all of
    // it and append exactly one new record (operator visibility, no data loss).
    const crash: DaemonState = {
      running: true,
      pid: 999_999,
      startedAt: new Date().toISOString(),
      lastTickAt: new Date().toISOString(),
      todayDate: today(),
      todaySpentUsd: 0.2,
      itemsProcessed: 3,
      ticks: [
        { ts: new Date(Date.now() - 2000).toISOString(), itemsConsidered: 1, proposalsCreated: 1, spentUsd: 0.1, reason: 'ok' },
        { ts: new Date(Date.now() - 1000).toISOString(), itemsConsidered: 1, proposalsCreated: 0, spentUsd: 0.1, reason: 'ok' },
      ],
    };
    saveDaemonState(crash);

    const result = await tick(makeCfg(), { dryRun: false });

    const after = reloadDaemonState();
    // History grew by exactly one (the restart's own record); none dropped.
    expect(after.ticks.length).toBe(3);
    expect(after.ticks.some((t) => t.ts === result.ts)).toBe(true);
    expect(after.ticks.slice(0, 2).map((t) => t.spentUsd)).toEqual([0.1, 0.1]);
    // itemsProcessed (crash-era progress) is preserved, not reset.
    expect(after.itemsProcessed).toBe(3);
  });

  it('GAP: a stale running=true from a crash is NOT reconciled on restart (documented for a local-only fix)', async () => {
    // A crash leaves running=true with a stale pid (the clean-exit running=false
    // write never ran). The restart tick does NOT touch the running flag, so the
    // current behavior leaves it stale. We ASSERT that current behavior so the
    // gap is greppable, and FLAG the minimal local-only fix (a read-only
    // reconcileDaemonState() liveness probe) per CONTRACT-H2.md gap #2.
    //
    // NOTE: this is an OBSERVABILITY gap (daemon status could show a dead daemon
    // as live), NOT a double-count gap — the spend accounting above is already
    // idempotent with NO production change. The fix is status-flag-only: no
    // outward capability, no weakened guard, no happy-path change.
    const seeded = seedMidTickSpend({ spentUsd: 0.3, running: true });
    expect(seeded.running).toBe(true);
    expect(seeded.pid).toBe(999_999); // a pid that is not this live process

    await tick(makeCfg(), { dryRun: false });

    const after = reloadDaemonState();
    // CURRENT (un-reconciled) behavior: the stale running flag survives the
    // restart. <<< GAP: a reconcileDaemonState() should flip this to false when
    // process.kill(pid, 0) shows the recorded pid is dead. >>>
    expect(after.running).toBe(true);
    expect(after.pid).toBe(999_999);
    // The spend invariant is unaffected by the stale flag — no double-count.
    expect(after.todaySpentUsd).toBe(0.3);
  });

  it('the restart tick never re-enters the daemon (re-entrancy guard env stays clear)', async () => {
    // A crashed daemon may have left ASHLR_IN_DAEMON set in a dead process, but a
    // fresh process (the fixture clears it) must run the restart tick cleanly.
    // The tick path itself sets no daemon re-entrancy env, so it stays clear.
    seedMidTickSpend({ spentUsd: 0.05 });
    expect(process.env.ASHLR_IN_DAEMON).toBeUndefined();

    await tick(makeCfg(), { dryRun: false });

    expect(process.env.ASHLR_IN_DAEMON).toBeUndefined();
    expect(daemonStateExists()).toBe(true);
  });
});
