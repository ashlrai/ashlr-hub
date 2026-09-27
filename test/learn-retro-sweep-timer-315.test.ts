/**
 * The retro sweep on a timer (3.15 follow-up, learn/retro/sweep-timer.ts):
 * never during startup, then hourly; unref'd; single-flight with the user's
 * sweeps; stoppable; off in test processes unless explicitly enabled.
 *
 * Timers are vitest fakes; every sweep is a fake except the single-flight
 * case, which runs the real sweepRetros over injected empty sources (HOME is
 * isolated by test/setup/home.ts). No model, Jev or network call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RETRO_SWEEP_FIRST_DELAY_MS,
  RETRO_SWEEP_INTERVAL_MS,
  RETRO_SWEEP_MIN_GAP_MS,
  defaultRetroSweepTimerDeps,
  retroSweepScheduled,
  retroSweepTimerEnabled,
  scheduleRetroSweep,
  startRetroSweepTimer,
  stopRetroSweepSchedule,
  type RetroSweepTickOutcome,
  type RetroSweepTimerDeps,
} from '../src/core/learn/retro/sweep-timer.js';
import { isRetroSweepInFlight, sweepRetros, type RetroSweepDeps } from '../src/core/learn/retro/sweep.js';
import type { LedgerReadResult } from '../src/core/authority/types.js';

const MIN = 60_000;

function harness(over: Partial<RetroSweepTimerDeps> = {}) {
  const outcomes: RetroSweepTickOutcome[] = [];
  const unrefs = { count: 0 };
  const sweep = vi.fn(async () => undefined);
  const deps: RetroSweepTimerDeps = {
    now: () => Date.now(),
    lastSweptAt: async () => null,
    inFlight: async () => false,
    sweep,
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      return { unref: () => { unrefs.count += 1; return handle.unref(); }, handle } as unknown as { unref(): unknown };
    },
    clearTimer: (h) => clearTimeout((h as unknown as { handle: ReturnType<typeof setTimeout> }).handle),
    ...over,
  };
  return { deps, sweep, outcomes, unrefs, onTick: (o: RetroSweepTickOutcome) => { outcomes.push(o); } };
}

describe('retroSweepTimerEnabled', () => {
  it('is off under a test runner, on otherwise, and the explicit flag wins both ways', () => {
    expect(retroSweepTimerEnabled({})).toBe(true);
    expect(retroSweepTimerEnabled({ VITEST: 'true' })).toBe(false);
    expect(retroSweepTimerEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(retroSweepTimerEnabled({ VITEST: 'true', ASHLR_RETRO_SWEEP_TIMER: '1' })).toBe(true);
    expect(retroSweepTimerEnabled({ ASHLR_RETRO_SWEEP_TIMER: '0' })).toBe(false);
    expect(retroSweepTimerEnabled({ ASHLR_RETRO_SWEEP_TIMER: 'off' })).toBe(false);
    // This very process is a vitest worker: the default reads process.env.
    expect(retroSweepTimerEnabled()).toBe(false);
  });
});

describe('startRetroSweepTimer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs nothing at start, first sweeps after the startup delay, then hourly; every timer is unref\'d', async () => {
    const h = harness();
    const timer = startRetroSweepTimer(h.deps, { onTick: h.onTick });
    expect(h.sweep).not.toHaveBeenCalled();
    expect(h.unrefs.count).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRO_SWEEP_FIRST_DELAY_MS - 1);
    expect(h.sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sweep).toHaveBeenCalledTimes(1);
    expect(h.outcomes).toEqual(['swept']);
    await vi.advanceTimersByTimeAsync(RETRO_SWEEP_INTERVAL_MS - 1);
    expect(h.sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sweep).toHaveBeenCalledTimes(2);
    expect(h.unrefs.count).toBe(3);
    expect(RETRO_SWEEP_FIRST_DELAY_MS).toBeGreaterThanOrEqual(3 * MIN);
    expect(RETRO_SWEEP_INTERVAL_MS).toBe(60 * MIN);
    await timer.stop();
  });

  it('skips while another sweep is in flight (the Lessons GET kick or POST), without joining it', async () => {
    const h = harness({ inFlight: async () => true });
    const timer = startRetroSweepTimer(h.deps, { onTick: h.onTick });
    await vi.advanceTimersByTimeAsync(RETRO_SWEEP_FIRST_DELAY_MS);
    expect(h.sweep).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual(['skipped-busy']);
    await timer.stop();
  });

  it('skips when the last sweep (any caller) is recent, and sweeps once it is not', async () => {
    let last: string | null = null;
    const h = harness({ lastSweptAt: async () => last });
    const timer = startRetroSweepTimer(h.deps, { onTick: h.onTick });
    await vi.advanceTimersByTimeAsync(RETRO_SWEEP_FIRST_DELAY_MS - 2 * MIN);
    last = new Date(Date.now()).toISOString(); // Mason swept 2 minutes before the first tick
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(h.outcomes).toEqual(['skipped-recent']);
    expect(h.sweep).not.toHaveBeenCalled();
    expect(RETRO_SWEEP_INTERVAL_MS).toBeGreaterThan(RETRO_SWEEP_MIN_GAP_MS);
    await vi.advanceTimersByTimeAsync(RETRO_SWEEP_INTERVAL_MS);
    expect(h.outcomes).toEqual(['skipped-recent', 'swept']);
    await timer.stop();
  });

  it('a failing sweep is reported and the chain goes on', async () => {
    const h = harness({ sweep: vi.fn(async () => { throw new Error('ledger unreadable'); }) });
    const timer = startRetroSweepTimer(h.deps, { onTick: h.onTick });
    await vi.advanceTimersByTimeAsync(RETRO_SWEEP_FIRST_DELAY_MS + RETRO_SWEEP_INTERVAL_MS);
    expect(h.outcomes).toEqual(['failed', 'failed']);
    await timer.stop();
  });

  it('stop() clears the timer: no tick ever runs after it', async () => {
    const h = harness();
    const timer = startRetroSweepTimer(h.deps, { onTick: h.onTick });
    await timer.stop();
    await timer.stop(); // idempotent
    await vi.advanceTimersByTimeAsync(RETRO_SWEEP_FIRST_DELAY_MS + 3 * RETRO_SWEEP_INTERVAL_MS);
    expect(h.sweep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() waits for a sweep in flight, bounded, and schedules nothing after it', async () => {
    let release!: () => void;
    const sweep = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const h = harness({ sweep });
    const timer = startRetroSweepTimer(h.deps, { onTick: h.onTick, stopWaitMs: 5_000 });
    await vi.advanceTimersByTimeAsync(RETRO_SWEEP_FIRST_DELAY_MS);
    expect(timer.running).toBe(true);
    let stopped = false;
    const stopping = timer.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // A sweep that never settles cannot hold shutdown past stopWaitMs.
    const stuck = harness({ sweep: vi.fn(() => new Promise<void>(() => {})) });
    const t2 = startRetroSweepTimer(stuck.deps, { stopWaitMs: 5_000 });
    await vi.advanceTimersByTimeAsync(RETRO_SWEEP_FIRST_DELAY_MS);
    let done = false;
    const p2 = t2.stop().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p2;
    expect(done).toBe(true);
  });
});

describe('single-flight with a user-triggered sweep (real sweepRetros)', () => {
  it('the production in-flight probe sees a Lessons sweep, and a tick then skips instead of sweeping again', async () => {
    let releaseLedger!: (r: LedgerReadResult) => void;
    const userDeps: RetroSweepDeps = {
      now: () => Date.now(),
      readLedger: () => new Promise<LedgerReadResult>((resolve) => { releaseLedger = resolve; }),
      decidedProposals: () => [],
      loadProposal: () => null,
      cloudTasks: () => [],
      leaderActions: () => [],
      model: null,
    };
    const user = sweepRetros(userDeps);
    const probe = defaultRetroSweepTimerDeps(null);
    expect(isRetroSweepInFlight()).toBe(true);
    await expect(probe.inFlight()).resolves.toBe(true);

    vi.useFakeTimers();
    try {
      const h = harness({ inFlight: probe.inFlight, lastSweptAt: async () => null });
      const timer = startRetroSweepTimer(h.deps, { onTick: h.onTick });
      await vi.advanceTimersByTimeAsync(RETRO_SWEEP_FIRST_DELAY_MS);
      expect(h.outcomes).toEqual(['skipped-busy']);
      expect(h.sweep).not.toHaveBeenCalled();
      await timer.stop();
    } finally {
      vi.useRealTimers();
    }

    releaseLedger({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null });
    const result = await user;
    expect(result.created).toBe(0);
    expect(isRetroSweepInFlight()).toBe(false);
    await expect(probe.inFlight()).resolves.toBe(false);
  });
});

describe('scheduleRetroSweep (the process singleton Verse starts and server close stops)', () => {
  afterEach(async () => { await stopRetroSweepSchedule(); });

  it('does not schedule in a test process by default', () => {
    const sweep = vi.fn(async () => undefined);
    const stop = scheduleRetroSweep(null, { deps: { ...harness().deps, sweep } });
    expect(stop).toBeNull();
    expect(retroSweepScheduled()).toBe(false);
  });

  it('schedules once when explicitly enabled; a second call is refused; stopRetroSweepSchedule ends it', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const stop = scheduleRetroSweep(null, { env: { ASHLR_RETRO_SWEEP_TIMER: '1' }, deps: h.deps, onTick: h.onTick });
      expect(stop).toBeTypeOf('function');
      expect(retroSweepScheduled()).toBe(true);
      expect(scheduleRetroSweep(null, { env: { ASHLR_RETRO_SWEEP_TIMER: '1' }, deps: h.deps })).toBeNull();
      await stopRetroSweepSchedule();
      expect(retroSweepScheduled()).toBe(false);
      await vi.advanceTimersByTimeAsync(RETRO_SWEEP_FIRST_DELAY_MS + RETRO_SWEEP_INTERVAL_MS);
      expect(h.sweep).not.toHaveBeenCalled();
      stop!(); // the background-service stopper after server close: harmless
    } finally {
      vi.useRealTimers();
    }
  });
});
