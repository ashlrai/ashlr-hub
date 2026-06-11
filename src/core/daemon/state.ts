/**
 * state.ts — Daemon state persistence.
 *
 * Responsibilities:
 *  - daemonStatePath(): path to ~/.ashlr/daemon.json
 *  - loadDaemonState(): read + parse; NEVER throws; returns zeroed state on
 *    missing/corrupt file.
 *  - saveDaemonState(): atomic write (tmp + rename, POSIX-atomic); mkdir -p.
 *  - resetDayIfNeeded(): pure — if todayDate has rolled over, zero daily
 *    spend and update the date. Returns (possibly new) state; caller persists.
 *
 * No new runtime deps; node builtins only.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonState } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of tick history entries kept in daemon.json. */
const MAX_TICKS = 100;

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

function ashlrDir(): string {
  return join(homedir(), '.ashlr');
}

/** Absolute path to the daemon state file. */
export function daemonStatePath(): string {
  return join(ashlrDir(), 'daemon.json');
}

// ---------------------------------------------------------------------------
// Zeroed default state
// ---------------------------------------------------------------------------

function freshState(): DaemonState {
  return {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks: [],
  };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read and parse daemonStatePath(). NEVER throws.
 * Returns a fresh zeroed DaemonState when the file is missing or malformed.
 */
export function loadDaemonState(): DaemonState {
  const p = daemonStatePath();
  if (!existsSync(p)) return freshState();
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return freshState();
    }
    const obj = parsed as Record<string, unknown>;
    // Validate and coerce each field with a safe fallback.
    const state: DaemonState = {
      running: typeof obj['running'] === 'boolean' ? obj['running'] : false,
      pid:
        typeof obj['pid'] === 'number'
          ? obj['pid']
          : obj['pid'] === null
            ? null
            : null,
      startedAt:
        typeof obj['startedAt'] === 'string' ? obj['startedAt'] : null,
      lastTickAt:
        typeof obj['lastTickAt'] === 'string' ? obj['lastTickAt'] : null,
      todayDate:
        typeof obj['todayDate'] === 'string' ? obj['todayDate'] : null,
      todaySpentUsd:
        typeof obj['todaySpentUsd'] === 'number' ? obj['todaySpentUsd'] : 0,
      itemsProcessed:
        typeof obj['itemsProcessed'] === 'number' ? obj['itemsProcessed'] : 0,
      ticks: Array.isArray(obj['ticks'])
        ? (obj['ticks'] as unknown[]).filter(
            (t): t is DaemonState['ticks'][number] =>
              typeof t === 'object' &&
              t !== null &&
              !Array.isArray(t) &&
              typeof (t as Record<string, unknown>)['ts'] === 'string',
          )
        : [],
    };
    // Self-heal at the load chokepoint: a daemon killed -9 leaves
    // running:true/pid:<dead> behind; reconcile (read-only liveness) flips it to
    // a truthful stopped state so status/start/tick never see a phantom-live
    // daemon. Observability-only — touches NO spend accounting, NO guard.
    return reconcileDaemonState(state);
  } catch {
    // Corrupt JSON or any other read error — return zeroed state.
    return freshState();
  }
}

// ---------------------------------------------------------------------------
// Save (atomic)
// ---------------------------------------------------------------------------

/**
 * Atomically write DaemonState to daemonStatePath() via tmp-file + rename
 * (POSIX-atomic). Creates ~/.ashlr if needed. Never throws.
 */
export function saveDaemonState(s: DaemonState): void {
  try {
    const dir = ashlrDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Bound ticks history before persisting.
    const bounded: DaemonState = {
      ...s,
      ticks: s.ticks.slice(-MAX_TICKS),
    };
    const dest = daemonStatePath();
    const tmp = dest + '.tmp';
    writeFileSync(tmp, JSON.stringify(bounded, null, 2) + '\n', 'utf8');
    renameSync(tmp, dest);
  } catch {
    // Persistence failure must not crash the daemon — swallow silently.
  }
}

// ---------------------------------------------------------------------------
// Daily budget reset
// ---------------------------------------------------------------------------

/**
 * If s.todayDate differs from today's YYYY-MM-DD, return a copy with
 * todayDate set to today and todaySpentUsd reset to 0 (daily budget reset).
 * itemsProcessed and ticks are preserved.
 *
 * Pure-ish: returns the (possibly new) state; caller is responsible for
 * persisting via saveDaemonState().
 */
export function resetDayIfNeeded(s: DaemonState): DaemonState {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (s.todayDate === today) return s;
  return {
    ...s,
    todayDate: today,
    todaySpentUsd: 0,
  };
}

// ---------------------------------------------------------------------------
// Stale-daemon reconciliation (H5 — OBSERVABILITY-ONLY liveness check)
// ---------------------------------------------------------------------------

/**
 * READ-ONLY liveness reconcile. If `s.running === true` but the recorded `pid`
 * is NOT alive — `process.kill(pid, 0)` throws `ESRCH` (no such process) — flip
 * `running` to false and `pid` to null so `daemon status` reports a dead daemon
 * as stopped. Otherwise return `s` unchanged.
 *
 * HONEST BOUND (pid reuse): this reports a dead daemon as live ONLY in the rare
 * case where the OS recycled the recorded pid for an unrelated live process
 * (then `process.kill(pid,0)` succeeds and we leave the state unchanged) —
 * inherent to pid-0 liveness. In every other case it is truthful. It is
 * conservative-toward-alive (it NEVER force-flips a genuinely running daemon
 * off), and since it changes no spend/guard the residual false-positive is an
 * observability nicety only, never a safety issue.
 *
 * OBSERVABILITY-ONLY by construction: it touches NO spend accounting
 * (`todaySpentUsd` / `itemsProcessed` / `ticks` are preserved byte-for-byte),
 * NO guard (kill switch / enrollment / sandbox are unaffected), and adds NO
 * capability. It only makes the persisted running/pid pair truthful.
 *
 * Liveness rules (conservative — NEVER destroy a real running daemon's state):
 *  - `running !== true` or `pid` not a number => nothing to reconcile => unchanged.
 *  - `process.kill(pid, 0)` succeeds => process alive => unchanged.
 *  - throws `ESRCH` => process is GONE => flip to { running:false, pid:null }.
 *  - throws `EPERM` (exists but not signalable by us) => process EXISTS => alive
 *    => unchanged (do NOT flip).
 *  - any other/unexpected error => treat as alive => unchanged.
 *
 * Pure-ish: returns the (possibly new) state; caller persists via
 * saveDaemonState(). Never throws.
 */
export function reconcileDaemonState(s: DaemonState): DaemonState {
  if (s.running !== true || typeof s.pid !== 'number') {
    return s;
  }
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(s.pid, 0);
    // No throw => the process exists and is signalable => treat as alive.
    return s;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ESRCH') {
      // No such process — the daemon is dead. Flip to a truthful stopped state.
      return { ...s, running: false, pid: null };
    }
    // EPERM (exists, not ours) or any other error => conservatively alive.
    return s;
  }
}
