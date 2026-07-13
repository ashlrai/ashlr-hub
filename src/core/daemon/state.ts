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
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import type { DaemonState } from '../types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of tick history entries kept in daemon.json. */
const MAX_TICKS = 100;

/** Conservative stale-lock window used only after the recorded pid is gone. */
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;

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

/** Absolute path to the daemon spend-commit guard file. */
export function daemonSpendGuardPath(): string {
  return join(ashlrDir(), 'daemon.spend-guard.json');
}

/** Absolute path to the daemon singleton lock file. */
export function daemonLockPath(): string {
  return join(ashlrDir(), 'daemon.lock');
}

export interface DaemonLockOwner {
  pid: number;
  token: string;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface DaemonLock {
  path: string;
  token: string;
  pid: number;
}

export type AcquireDaemonLockResult =
  | { acquired: true; lock: DaemonLock; owner: DaemonLockOwner; replacedStale: boolean }
  | { acquired: false; path: string; owner: DaemonLockOwner | null; reason: 'busy' | 'io-error' };

export type LoadDaemonStateStrictResult =
  | { ok: true; state: DaemonState; fresh: boolean }
  | { ok: false; path: string; reason: 'malformed' | 'unreadable'; error: string };

export type SaveDaemonStateResult =
  | { ok: true; path: string }
  | { ok: false; path: string; error: string };

export interface DaemonSpendGuard {
  token: string;
  pid: number;
  hostname: string;
  armedAt: string;
  itemIds: string[];
}

export type ReadDaemonSpendGuardResult =
  | { exists: false; path: string }
  | { exists: true; path: string; guard: DaemonSpendGuard | null; malformed: boolean; error?: string };

export type ArmDaemonSpendGuardResult =
  | { ok: true; path: string; guard: DaemonSpendGuard }
  | { ok: false; path: string; error: string };

export type ClearDaemonSpendGuardResult =
  | { ok: true; path: string; cleared: boolean }
  | { ok: false; path: string; error: string };

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

function parseDaemonState(raw: string, opts?: { strict?: boolean }): DaemonState | null {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (opts?.strict === true) {
    const pid = obj['pid'];
    if (
      typeof obj['running'] !== 'boolean' ||
      !(typeof pid === 'number' || pid === null) ||
      !(typeof obj['startedAt'] === 'string' || obj['startedAt'] === null) ||
      !(typeof obj['lastTickAt'] === 'string' || obj['lastTickAt'] === null) ||
      !(typeof obj['todayDate'] === 'string' || obj['todayDate'] === null) ||
      typeof obj['todaySpentUsd'] !== 'number' ||
      !Number.isFinite(obj['todaySpentUsd']) ||
      typeof obj['itemsProcessed'] !== 'number' ||
      !Number.isFinite(obj['itemsProcessed']) ||
      !Array.isArray(obj['ticks']) ||
      (obj['automaticDrainOrdinaryTurnDue'] !== undefined &&
        typeof obj['automaticDrainOrdinaryTurnDue'] !== 'boolean')
    ) {
      return null;
    }
  }
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
    automaticDrainOrdinaryTurnDue:
      typeof obj['automaticDrainOrdinaryTurnDue'] === 'boolean'
        ? obj['automaticDrainOrdinaryTurnDue']
        : undefined,
    lastPulseExportAt:
      typeof obj['lastPulseExportAt'] === 'string' ? obj['lastPulseExportAt'] : undefined,
  };
  return reconcileDaemonState(state);
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
    return parseDaemonState(raw) ?? freshState();
  } catch {
    // Corrupt JSON or any other read error — return zeroed state.
    return freshState();
  }
}

/**
 * Strictly read daemonStatePath(). Missing state is a valid fresh state; malformed
 * or unreadable state is returned as an error so spend-sensitive callers can
 * fail closed instead of treating a broken ledger as zero spend.
 */
export function loadDaemonStateStrict(): LoadDaemonStateStrictResult {
  const p = daemonStatePath();
  if (!existsSync(p)) return { ok: true, state: freshState(), fresh: true };
  try {
    const raw = readFileSync(p, 'utf8');
    const state = parseDaemonState(raw, { strict: true });
    if (!state) {
      return { ok: false, path: p, reason: 'malformed', error: 'daemon state is not a JSON object' };
    }
    return { ok: true, state, fresh: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = msg.includes('JSON') || msg.includes('Unexpected') || msg.includes('position')
      ? 'malformed'
      : 'unreadable';
    return { ok: false, path: p, reason, error: msg };
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
  saveDaemonStateResult(s);
}

/** Like saveDaemonState(), but reports persistence failures to fail-closed callers. */
export function saveDaemonStateResult(s: DaemonState): SaveDaemonStateResult {
  let tmp: string | null = null;
  const dest = daemonStatePath();
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
    tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(bounded, null, 2) + '\n', 'utf8');
    renameSync(tmp, dest);
    return { ok: true, path: dest };
  } catch (err) {
    // Persistence failure must not crash the daemon — swallow silently.
    if (tmp) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // Best-effort cleanup only.
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path: dest, error: msg };
  }
}

function parseSpendGuard(raw: string): DaemonSpendGuard | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj['token'] !== 'string' ||
      typeof obj['pid'] !== 'number' ||
      typeof obj['hostname'] !== 'string' ||
      typeof obj['armedAt'] !== 'string' ||
      !Array.isArray(obj['itemIds']) ||
      !obj['itemIds'].every((id) => typeof id === 'string')
    ) {
      return null;
    }
    return {
      token: obj['token'],
      pid: obj['pid'],
      hostname: obj['hostname'],
      armedAt: obj['armedAt'],
      itemIds: obj['itemIds'] as string[],
    };
  } catch {
    return null;
  }
}

export function readDaemonSpendGuard(): ReadDaemonSpendGuardResult {
  const p = daemonSpendGuardPath();
  if (!existsSync(p)) return { exists: false, path: p };
  try {
    const raw = readFileSync(p, 'utf8');
    const guard = parseSpendGuard(raw);
    return { exists: true, path: p, guard, malformed: guard === null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exists: true, path: p, guard: null, malformed: true, error: msg };
  }
}

export function armDaemonSpendGuard(itemIds: string[]): ArmDaemonSpendGuardResult {
  const p = daemonSpendGuardPath();
  try {
    const dir = ashlrDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const guard: DaemonSpendGuard = {
      token: randomUUID(),
      pid: process.pid,
      hostname: osHostname(),
      armedAt: new Date().toISOString(),
      itemIds,
    };
    writeFileSync(p, JSON.stringify(guard, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { ok: true, path: p, guard };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path: p, error: msg };
  }
}

export function clearDaemonSpendGuard(token: string): ClearDaemonSpendGuardResult {
  const p = daemonSpendGuardPath();
  const current = readDaemonSpendGuard();
  if (!current.exists) return { ok: true, path: p, cleared: false };
  if (!current.guard || current.guard.token !== token) {
    return { ok: false, path: p, error: 'spend guard token mismatch or malformed guard' };
  }
  try {
    unlinkSync(p);
    return { ok: true, path: p, cleared: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path: p, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Daemon singleton lock (cross-process, same machine)
// ---------------------------------------------------------------------------

function makeLockOwner(token: string, nowIso: string): DaemonLockOwner {
  return {
    pid: process.pid,
    token,
    hostname: osHostname(),
    acquiredAt: nowIso,
    heartbeatAt: nowIso,
  };
}

function parseLockOwner(raw: string): DaemonLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj['pid'] !== 'number' ||
      typeof obj['token'] !== 'string' ||
      typeof obj['hostname'] !== 'string' ||
      typeof obj['acquiredAt'] !== 'string' ||
      typeof obj['heartbeatAt'] !== 'string'
    ) {
      return null;
    }
    return {
      pid: obj['pid'],
      token: obj['token'],
      hostname: obj['hostname'],
      acquiredAt: obj['acquiredAt'],
      heartbeatAt: obj['heartbeatAt'],
    };
  } catch {
    return null;
  }
}

export function readDaemonLockOwner(): DaemonLockOwner | null {
  try {
    return parseLockOwner(readFileSync(daemonLockPath(), 'utf8'));
  } catch {
    return null;
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code !== 'ESRCH';
  }
}

function lockIsSafelyStale(owner: DaemonLockOwner | null, _staleMs: number): boolean {
  if (!owner || !Number.isFinite(owner.pid) || owner.pid <= 0) return true;
  if (pidExists(owner.pid)) return false;
  return true;
}

function writeNewLock(path: string, owner: DaemonLockOwner): void {
  writeFileSync(path, JSON.stringify(owner, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
}

interface DaemonLockSnapshot {
  dev: number;
  ino: number;
  raw: string;
  owner: DaemonLockOwner | null;
}

function readDaemonLockSnapshot(path: string): DaemonLockSnapshot | null {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const raw = readFileSync(path, 'utf8');
    const after = lstatSync(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) return null;
    return { dev: after.dev, ino: after.ino, raw, owner: parseLockOwner(raw) };
  } catch {
    return null;
  }
}

function sameDaemonLockSnapshot(
  expected: DaemonLockSnapshot,
  current: DaemonLockSnapshot | null,
): boolean {
  return current !== null &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.raw === expected.raw &&
    current.owner?.token === expected.owner?.token;
}

function daemonLockMutationPath(path: string): string {
  return `${path}.mutation.lock`;
}

/**
 * Acquire the same-machine daemon singleton lock.
 *
 * Uses an O_EXCL create so independent `ashlr daemon start` processes cannot
 * both enter the operator loop. A dead-owner lock is reclaimed immediately once
 * the recorded pid is gone; a live pid is always treated as busy to fail closed
 * for slow or stuck live daemons.
 */
export function acquireDaemonLock(opts?: { staleMs?: number }): AcquireDaemonLockResult {
  const path = daemonLockPath();
  const dir = ashlrDir();
  const staleMs = Math.max(0, opts?.staleMs ?? DEFAULT_LOCK_STALE_MS);
  const token = randomUUID();
  const owner = makeLockOwner(token, new Date().toISOString());
  const mutationLock = acquireLocalStoreLock(daemonLockMutationPath(path));
  if (!mutationLock) {
    return { acquired: false, path, owner: readDaemonLockOwner(), reason: 'busy' };
  }

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeNewLock(path, owner);
    return { acquired: true, lock: { path, token, pid: process.pid }, owner, replacedStale: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'EEXIST') {
      return { acquired: false, path, owner: null, reason: 'io-error' };
    }

    const snapshot = readDaemonLockSnapshot(path);
    const existing = snapshot?.owner ?? readDaemonLockOwner();
    if (!snapshot || !lockIsSafelyStale(existing, staleMs)) {
      return { acquired: false, path, owner: existing, reason: 'busy' };
    }

    const current = readDaemonLockSnapshot(path);
    if (!sameDaemonLockSnapshot(snapshot, current)) {
      return { acquired: false, path, owner: current?.owner ?? readDaemonLockOwner(), reason: 'busy' };
    }

    try {
      unlinkSync(path);
      writeNewLock(path, owner);
      return { acquired: true, lock: { path, token, pid: process.pid }, owner, replacedStale: true };
    } catch (reclaimErr) {
      const reclaimCode = (reclaimErr as NodeJS.ErrnoException | undefined)?.code;
      return {
        acquired: false,
        path,
        owner: readDaemonLockOwner(),
        reason: reclaimCode === 'EEXIST' ? 'busy' : 'io-error',
      };
    }
  } finally {
    releaseLocalStoreLock(mutationLock);
  }
}

/** Update the heartbeat for the current lock owner; returns false if ownership was lost. */
export function heartbeatDaemonLock(lock: DaemonLock): boolean {
  const mutationLock = acquireLocalStoreLock(daemonLockMutationPath(lock.path));
  if (!mutationLock) return false;
  try {
    const current = readDaemonLockOwner();
    if (!current || current.pid !== lock.pid || current.token !== lock.token) return false;
    const next: DaemonLockOwner = { ...current, heartbeatAt: new Date().toISOString() };
    const tmp = `${lock.path}.${lock.token}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, lock.path);
    return true;
  } catch {
    return false;
  } finally {
    releaseLocalStoreLock(mutationLock);
  }
}

/** Release the daemon lock only if this process still owns the same token. */
export function releaseDaemonLock(lock: DaemonLock): boolean {
  const mutationLock = acquireLocalStoreLock(daemonLockMutationPath(lock.path));
  if (!mutationLock) return false;
  try {
    const snapshot = readDaemonLockSnapshot(lock.path);
    const current = snapshot?.owner;
    if (!snapshot || !current || current.pid !== lock.pid || current.token !== lock.token) {
      return false;
    }
    if (!sameDaemonLockSnapshot(snapshot, readDaemonLockSnapshot(lock.path))) return false;
    unlinkSync(lock.path);
    return true;
  } catch {
    return false;
  } finally {
    releaseLocalStoreLock(mutationLock);
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
