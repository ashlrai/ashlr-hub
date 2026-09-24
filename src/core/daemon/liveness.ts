/**
 * Daemon liveness — V3.10 Track B unit U5 (SPEC-310B §3 "24/7").
 *
 * WHY THIS EXISTS. `~/.ashlr/daemon.json` said `running: true, pid: 850` for
 * three weeks after that process died on 2026-09-01 (no audited stop; the
 * machine rebooted on Sep 6 with launchd disabled). Every surface that read the
 * record — Verse's `projectDaemonState`, `ashlr daemon status` — reported a
 * running fleet that did not exist. A recorded pid is a CLAIM; this module is
 * the proof.
 *
 * THE PROOF, strongest first:
 *   1. The singleton lock (`daemon.lock`) names the owner pid and carries a
 *      heartbeat rewritten every 30 s by a live resident.
 *   2. The activity journal (`daemon/activity.ts`) binds that pid to its
 *      PROCESS START TIME (`processStartRef`), so a reused pid — some other
 *      program that happens to get number 850 — is told apart from the daemon.
 *   3. `process.kill(pid, 0)`: ESRCH is proof of death; EPERM means the pid
 *      belongs to another user, which is never our daemon.
 * A pid that exists but whose heartbeat is stale and whose identity cannot be
 * proven is reported as `unknown` — never as running, never as stopped.
 *
 * READ-ONLY, except `clearStaleDaemonRecord`, which rewrites daemon.json's
 * `running/pid` ONLY after proving the recorded owner is gone and taking the
 * singleton lock itself (the same recovery `runDaemon` performs on start) —
 * `ashlr daemon doctor --clear-stale`.
 *
 * Never throws. Results are cached ≤ 5 s (the activity probe runs `ps`).
 */
import { readDaemonActivity, DAEMON_ACTIVITY_STALE_MS, type DaemonActivityPhase } from './activity.js';
import {
  acquireDaemonLock,
  loadDaemonStateStrict,
  readDaemonLockOwner,
  releaseDaemonLock,
  saveDaemonStateResult,
} from './state.js';

/** A resident rewrites its lock heartbeat every 30 s; three missed beats is stale. */
export const LOCK_HEARTBEAT_STALE_MS = DAEMON_ACTIVITY_STALE_MS;

const CACHE_MS = 5_000;

/**
 * - `alive`   — a daemon process provably owns the lock right now.
 * - `stale`   — the record says running, but the recorded process is provably
 *               gone (or is someone else's process): the daemon is NOT running.
 * - `stopped` — nothing claims to be running and nothing is.
 * - `unknown` — something exists but cannot be proven to be the daemon, or the
 *               records could not be read.
 */
export type DaemonLivenessState = 'alive' | 'stale' | 'stopped' | 'unknown';

export interface DaemonLivenessV1 {
  v: 1;
  checkedAt: string;
  state: DaemonLivenessState;
  /** true = running; false = provably not; null = cannot tell. */
  alive: boolean | null;
  /** The proven daemon pid when alive, else null. */
  pid: number | null;
  /** What daemon.json claims (null fields = unreadable / absent). */
  recorded: { running: boolean | null; pid: number | null; startedAt: string | null; lastTickAt: string | null };
  lock: { pid: number; heartbeatAt: string; heartbeatAgeMs: number | null } | null;
  activity: { phase: DaemonActivityPhase | null; ageMs: number | null; ownerState: string } | null;
  /** daemon.json claims a run that provably ended — `ashlr daemon doctor --clear-stale` fixes it. */
  staleRecord: boolean;
  /** One specific sentence. */
  reason: string;
}

type PidProbe = 'alive' | 'dead' | 'foreign';

function probePid(pid: number): PidProbe {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // EPERM: the pid exists but belongs to another user — not our daemon.
    return code === 'ESRCH' ? 'dead' : 'foreign';
  }
}

function ageMs(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, nowMs - at) : null;
}

function describeAge(ms: number | null): string {
  if (ms === null) return 'at an unknown time';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export interface LivenessProbeDeps {
  nowMs?: number;
  pidProbe?: (pid: number) => PidProbe;
  /**
   * The daemon.json claim when the caller has ALREADY read it (`daemon
   * status` does) — so the probe adds no second read of the state file.
   * `null` fields mean the record was unreadable.
   */
  recorded?: DaemonLivenessV1['recorded'];
}

let cache: { atMs: number; value: DaemonLivenessV1 } | null = null;

/** Test hook: drop the cached verdict. */
export function resetDaemonLivenessCache(): void {
  cache = null;
}

/** Probe whether the resident daemon is really running. Never throws. */
export function probeDaemonLiveness(deps: LivenessProbeDeps = {}): DaemonLivenessV1 {
  const nowMs = deps.nowMs ?? Date.now();
  const useCache = deps.nowMs === undefined && deps.pidProbe === undefined && deps.recorded === undefined;
  if (useCache && cache && nowMs - cache.atMs < CACHE_MS) return cache.value;
  const value = computeLiveness(nowMs, deps.pidProbe ?? probePid, deps.recorded);
  if (useCache) cache = { atMs: nowMs, value };
  return value;
}

function computeLiveness(
  nowMs: number,
  pidProbe: (pid: number) => PidProbe,
  given: DaemonLivenessV1['recorded'] | undefined,
): DaemonLivenessV1 {
  const checkedAt = new Date(nowMs).toISOString();
  let recorded: DaemonLivenessV1['recorded'] = { running: null, pid: null, startedAt: null, lastTickAt: null };
  let recordReadable = false;
  if (given !== undefined) {
    recorded = given;
    recordReadable = given.running !== null;
  } else {
    try {
      // preserveOwnerIdentity: the RAW claim. The default load "reconciles" a
      // dead pid to not-running, but treats EPERM (a root-owned process that
      // reused the number — exactly pid 850 after the Sep 6 reboot) as alive;
      // this module does its own, stronger proof below.
      const loaded = loadDaemonStateStrict({ preserveOwnerIdentity: true });
      if (loaded.ok) {
        recordReadable = true;
        recorded = {
          running: loaded.state.running === true,
          pid: typeof loaded.state.pid === 'number' ? loaded.state.pid : null,
          startedAt: loaded.state.startedAt ?? null,
          lastTickAt: loaded.state.lastTickAt ?? null,
        };
      }
    } catch {
      recordReadable = false;
    }
  }

  let lock: DaemonLivenessV1['lock'] = null;
  try {
    const owner = readDaemonLockOwner();
    if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
      lock = { pid: owner.pid, heartbeatAt: owner.heartbeatAt, heartbeatAgeMs: ageMs(owner.heartbeatAt, nowMs) };
    }
  } catch {
    lock = null;
  }

  let activity: DaemonLivenessV1['activity'] = null;
  let activityPid: number | null = null;
  try {
    const read = readDaemonActivity({ nowMs });
    if (read.activity) {
      activityPid = read.activity.pid;
      activity = { phase: read.activity.phase, ageMs: read.ageMs, ownerState: read.ownerState };
    }
  } catch {
    activity = null;
  }

  const result = (
    state: DaemonLivenessState,
    alive: boolean | null,
    pid: number | null,
    reason: string,
    staleRecord = false,
  ): DaemonLivenessV1 => ({ v: 1, checkedAt, state, alive, pid, recorded, lock, activity, staleRecord, reason });

  const lastTick = recorded.lastTickAt ? ` The last tick was ${describeAge(ageMs(recorded.lastTickAt, nowMs))}.` : '';

  if (lock) {
    const probe = pidProbe(lock.pid);
    if (probe === 'dead') {
      return result('stale', false, null,
        `The daemon lock names pid ${lock.pid}, which no longer exists (its last heartbeat was ${describeAge(lock.heartbeatAgeMs)}). `
        + `The daemon is NOT running.${lastTick}`,
        recorded.running === true);
    }
    if (probe === 'foreign') {
      return result('stale', false, null,
        `The daemon lock names pid ${lock.pid}, which now belongs to another user's process. The daemon is NOT running.${lastTick}`,
        recorded.running === true);
    }
    if (activityPid === lock.pid && activity?.ownerState === 'reused') {
      return result('stale', false, null,
        `Pid ${lock.pid} from the daemon lock now belongs to a different process (its start time does not match). `
        + `The daemon is NOT running.${lastTick}`,
        recorded.running === true);
    }
    if (activityPid === lock.pid && activity?.ownerState === 'alive') {
      return result('alive', true, lock.pid, `Running as pid ${lock.pid} (identity proven by its start time).`);
    }
    if (lock.heartbeatAgeMs !== null && lock.heartbeatAgeMs <= LOCK_HEARTBEAT_STALE_MS) {
      return result('alive', true, lock.pid, `Running as pid ${lock.pid} (lock heartbeat ${describeAge(lock.heartbeatAgeMs)}).`);
    }
    return result('unknown', null, null,
      `Pid ${lock.pid} from the daemon lock exists, but its heartbeat is ${describeAge(lock.heartbeatAgeMs)} and its identity `
      + 'cannot be proven — it may be a hung daemon or an unrelated process that reused the pid.');
  }

  // No lock: a live resident always holds one, so nothing is running.
  if (!recordReadable) {
    return result('unknown', null, null, 'The daemon state file could not be read, so whether a daemon ran last cannot be said; no daemon holds the lock.');
  }
  if (recorded.running === true) {
    const pid = recorded.pid;
    const probe = pid === null ? 'dead' : pidProbe(pid);
    return result('stale', false, null,
      pid === null
        ? `daemon.json says running, but names no pid and no daemon holds the lock. The daemon is NOT running.${lastTick}`
        : probe === 'dead'
          ? `daemon.json says running as pid ${pid}, but that process no longer exists and no daemon holds the lock. `
            + `The daemon is NOT running.${lastTick}`
          : `daemon.json says running as pid ${pid}, but no daemon holds the lock, so pid ${pid} is not the daemon. `
            + `The daemon is NOT running.${lastTick}`,
      true);
  }
  return result('stopped', false, null, `The daemon is not running.${lastTick}`);
}

/**
 * `running` as a surface should report it: the recorded flag only when
 * liveness cannot contradict it. `false` for a stale record, `null` when
 * nothing can be proven either way.
 */
export function verifiedRunning(liveness: DaemonLivenessV1): boolean | null {
  return liveness.alive;
}

export interface ClearStaleResult {
  ok: boolean;
  /** True when daemon.json was rewritten. */
  changed: boolean;
  reason: string;
}

/**
 * Clear a stale `running/pid` claim from daemon.json — only after proving the
 * recorded owner is gone, and only while holding the singleton lock (a stale
 * lock is replaced by `acquireDaemonLock` exactly as `runDaemon` does). A live
 * or unprovable daemon is never touched.
 */
export function clearStaleDaemonRecord(deps: LivenessProbeDeps = {}): ClearStaleResult {
  const liveness = probeDaemonLiveness({ ...deps, nowMs: deps.nowMs ?? Date.now() });
  if (liveness.state !== 'stale') {
    return {
      ok: liveness.state === 'stopped',
      changed: false,
      reason: liveness.state === 'stopped'
        ? 'Nothing to clear: no stale running record.'
        : `Refusing to clear: ${liveness.reason}`,
    };
  }
  const attempt = acquireDaemonLock();
  if (!attempt.acquired) {
    return { ok: false, changed: false, reason: 'Refusing to clear: the daemon lock could not be taken (another process holds it).' };
  }
  try {
    const loaded = loadDaemonStateStrict({ preserveOwnerIdentity: true });
    if (!loaded.ok) {
      return { ok: false, changed: false, reason: `Refusing to clear: daemon.json is ${loaded.reason}; repair it with \`ashlr daemon recover-state\`.` };
    }
    if (loaded.state.running !== true && loaded.state.pid === null) {
      return { ok: true, changed: false, reason: 'Nothing to clear: the record already says not running.' };
    }
    const saved = saveDaemonStateResult({ ...loaded.state, running: false, pid: null });
    if (!saved.ok) return { ok: false, changed: false, reason: `Could not rewrite daemon.json (${saved.error}).` };
    resetDaemonLivenessCache();
    return {
      ok: true,
      changed: true,
      reason: `Cleared the stale running record${liveness.recorded.pid !== null ? ` for pid ${liveness.recorded.pid}` : ''}.`,
    };
  } finally {
    releaseDaemonLock(attempt.lock);
  }
}
