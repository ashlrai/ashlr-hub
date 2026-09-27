/**
 * The retro sweep on a timer (3.15 follow-up). Before this, the sweep ran only
 * when someone opened Lessons (GET /api/verse/learning/lessons kicks a stale
 * sweep; POST …/lessons/sweep runs one), so task ends went unlearned for as
 * long as nobody looked. The Verse server now also sweeps in the background.
 *
 * THE RULES, and why:
 *   - NEVER DURING STARTUP. The first run waits RETRO_SWEEP_FIRST_DELAY_MS.
 *     Server start is when macOS TCC prompts fire (a fresh ad-hoc code
 *     identity after `ship:local`; see verse/folder-io.ts): the sidecar's one
 *     thread must be free to serve `/verse/` then, not reading the inbox.
 *   - HOURLY after that, as a setTimeout chain (not setInterval), so a slow
 *     sweep can never stack a second one behind it.
 *   - UNREF'D. The timer never keeps the process alive on its own.
 *   - SINGLE-FLIGHT with the user's sweeps. sweepRetros() already shares one
 *     in-flight promise per process; a tick that finds a sweep in flight (the
 *     Lessons GET kick or the POST) skips instead of joining it, and a tick
 *     within RETRO_SWEEP_MIN_GAP_MS of the last sweep skips too — the user
 *     just swept.
 *   - STARTED BY VERSE, STOPPED WITH THE SERVER. `ashlr verse` starts it as a
 *     background service (cli/verse.ts startVerseBackgroundServices, live
 *     console only — not a --no-accounts throwaway server). There is one per
 *     process (a module singleton, like the Fleet history service), and
 *     server.ts close() stops it through stopRetroSweepSchedule(): the timer
 *     is cleared and a tick in flight is waited for (bounded), so no sweep
 *     writes into a HOME that is about to go away.
 *   - OFF IN TESTS unless explicitly enabled (retroSweepTimerEnabled): vitest
 *     sets VITEST in every worker and every child it spawns.
 *   - NOT IN THE DAEMON. The daemon is Tier-1 and already busy; the sweep only
 *     reads what the daemon records, and Verse is where its output is read.
 *
 * Kill switch: ASHLR_RETRO_SWEEP_TIMER=0. Budgets are the sweep's own
 * (≤ RETRO_SWEEP_MAX_NEW retros per sweep, RETRO_MODEL_CALLS_PER_DAY model
 * calls, the Jev layer's daily budget and kill switches) — the timer adds none.
 */

/** First tick after server start. Long enough that startup (and any TCC prompt) is over. */
export const RETRO_SWEEP_FIRST_DELAY_MS = 5 * 60_000;
/** Between ticks. */
export const RETRO_SWEEP_INTERVAL_MS = 60 * 60_000;
/** A tick this soon after the last sweep (any caller's) skips. Matches the Lessons GET's stale window. */
export const RETRO_SWEEP_MIN_GAP_MS = 10 * 60_000;
/** stop() waits at most this long for a tick in flight. */
export const RETRO_SWEEP_STOP_WAIT_MS = 5_000;

export type RetroSweepTickOutcome = 'swept' | 'skipped-recent' | 'skipped-busy' | 'failed' | 'stopped';

export interface RetroSweepTimerDeps {
  now(): number;
  /** ISO time of the last completed sweep (any caller), null when none. */
  lastSweptAt(): Promise<string | null>;
  /** True while a sweep (any caller) is running in this process. */
  inFlight(): Promise<boolean>;
  /** Run one sweep. */
  sweep(): Promise<unknown>;
  setTimer(fn: () => void, ms: number): { unref?(): unknown };
  clearTimer(handle: { unref?(): unknown }): void;
}

export interface RetroSweepTimerOptions {
  firstDelayMs?: number;
  intervalMs?: number;
  minGapMs?: number;
  stopWaitMs?: number;
  /** Called after every tick (observability and tests). Never throws out. */
  onTick?(outcome: RetroSweepTickOutcome): void;
}

export interface RetroSweepTimer {
  /** Clear the timer and wait (≤ stopWaitMs) for a tick in flight. Idempotent. */
  stop(): Promise<void>;
  /** The tick in flight, if any (tests). */
  readonly running: boolean;
}

const OFF = new Set(['0', 'false', 'off', 'no']);
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Whether the background sweep may run in this process. An explicit
 * ASHLR_RETRO_SWEEP_TIMER wins; otherwise it is off under a test runner
 * (VITEST, which vitest also passes to every child process, or NODE_ENV=test).
 */
export function retroSweepTimerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env['ASHLR_RETRO_SWEEP_TIMER']?.trim().toLowerCase();
  if (flag && OFF.has(flag)) return false;
  if (flag && ON.has(flag)) return true;
  if (env['VITEST'] || env['NODE_ENV'] === 'test') return false;
  return true;
}

/** Start the chain. The first tick runs after `firstDelayMs`; nothing runs synchronously. */
export function startRetroSweepTimer(deps: RetroSweepTimerDeps, opts: RetroSweepTimerOptions = {}): RetroSweepTimer {
  const firstDelayMs = opts.firstDelayMs ?? RETRO_SWEEP_FIRST_DELAY_MS;
  const intervalMs = opts.intervalMs ?? RETRO_SWEEP_INTERVAL_MS;
  const minGapMs = opts.minGapMs ?? RETRO_SWEEP_MIN_GAP_MS;
  const stopWaitMs = opts.stopWaitMs ?? RETRO_SWEEP_STOP_WAIT_MS;
  let stopped = false;
  let handle: { unref?(): unknown } | null = null;
  let tickInFlight: Promise<void> | null = null;

  const report = (outcome: RetroSweepTickOutcome): void => {
    try { opts.onTick?.(outcome); } catch { /* observability only */ }
  };

  const tick = async (): Promise<RetroSweepTickOutcome> => {
    if (stopped) return 'stopped';
    try {
      if (await deps.inFlight()) return 'skipped-busy';
      const last = await deps.lastSweptAt();
      const lastMs = last ? Date.parse(last) : Number.NaN;
      if (Number.isFinite(lastMs) && deps.now() - lastMs < minGapMs) return 'skipped-recent';
      // Re-check after the await: stop() or a user sweep may have started meanwhile.
      if (stopped) return 'stopped';
      if (await deps.inFlight()) return 'skipped-busy';
      await deps.sweep();
      return 'swept';
    } catch {
      return 'failed';
    }
  };

  const schedule = (ms: number): void => {
    if (stopped) return;
    handle = deps.setTimer(() => {
      handle = null;
      tickInFlight = tick()
        .then(report)
        .finally(() => {
          tickInFlight = null;
          schedule(intervalMs);
        });
    }, ms);
    handle.unref?.();
  };

  schedule(firstDelayMs);

  return {
    get running() {
      return tickInFlight !== null;
    },
    async stop(): Promise<void> {
      stopped = true;
      if (handle) {
        deps.clearTimer(handle);
        handle = null;
      }
      const pending = tickInFlight;
      if (!pending) return;
      let waitHandle: { unref?(): unknown } | null = null;
      await Promise.race([
        pending.catch(() => undefined),
        new Promise<void>((resolve) => {
          waitHandle = deps.setTimer(resolve, stopWaitMs);
          waitHandle.unref?.();
        }),
      ]);
      if (waitHandle) deps.clearTimer(waitHandle);
    },
  };
}

/** Production deps: the real sweep, loaded lazily (literal specifiers — the sidecar bundles only those). */
export function defaultRetroSweepTimerDeps(cfg: unknown): RetroSweepTimerDeps {
  return {
    now: () => Date.now(),
    lastSweptAt: async () => (await (await import('./store.js')).readSweepState()).sweptAt,
    inFlight: async () => (await import('./sweep.js')).isRetroSweepInFlight(),
    sweep: async () => {
      const { loadDefaultRetroSweepDeps, sweepRetros } = await import('./sweep.js');
      return sweepRetros(await loadDefaultRetroSweepDeps(cfg));
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

// ---------------------------------------------------------------------------
// The process's one schedule (Verse background service ↔ server close)
// ---------------------------------------------------------------------------

let active: RetroSweepTimer | null = null;

export interface ScheduleRetroSweepOptions extends RetroSweepTimerOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam; default: the real sweep (defaultRetroSweepTimerDeps). */
  deps?: RetroSweepTimerDeps;
}

/**
 * Start this process's background sweep. Returns its stop function, or null
 * when this process must not run it (a test runner, ASHLR_RETRO_SWEEP_TIMER=0)
 * or it is already running. Never runs a sweep synchronously.
 */
export function scheduleRetroSweep(cfg: unknown, opts: ScheduleRetroSweepOptions = {}): (() => void) | null {
  if (active) return null;
  if (!retroSweepTimerEnabled(opts.env ?? process.env)) return null;
  const timer = startRetroSweepTimer(opts.deps ?? defaultRetroSweepTimerDeps(cfg), opts);
  active = timer;
  return () => {
    if (active === timer) active = null;
    void timer.stop();
  };
}

/** True while this process has a background sweep scheduled. */
export function retroSweepScheduled(): boolean {
  return active !== null;
}

/** Server shutdown: stop the schedule if one was ever started (never starts one). */
export async function stopRetroSweepSchedule(): Promise<void> {
  const previous = active;
  active = null;
  await previous?.stop().catch(() => undefined);
}
