/**
 * pause.ts — the DAEMON-SCOPED pause. The narrow stop the operator was owed.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `stopDaemon()` (daemon/loop.ts) is literally `setKill(true)`: it writes the
 * GLOBAL `~/.ashlr/KILL` sentinel. That sentinel is also read by
 * `assertMayMutate` (sandbox/policy.ts) and therefore by `mcp-native` and
 * `mcp-native-engineer`, so "stop the loop" also refuses the agent's OWN file
 * writes, everywhere, until it is cleared. V2 disclosed that honestly but the
 * consequence stood: "Stop loop" and "Emergency stop" had identical blast
 * radius, which made the safer of the two controls pointless.
 *
 * This module is the third, genuinely narrower control. It writes a SEPARATE
 * sentinel, `~/.ashlr/daemon.paused`, which:
 *
 *   - halts the autonomous loop's DISPATCH (loop.ts consults it in
 *     `stopRequested()` and parks the continuous loop on it), and
 *   - is consulted by NOTHING ELSE. `assertMayMutate`, `mcp-native`, and
 *     `mcp-native-engineer` do not import this module and must never start.
 *     `test/verse-daemon-pause.test.ts` asserts that separation both ways:
 *     a paused daemon leaves the write-tool path working, an engaged KILL
 *     still blocks it.
 *
 * ── FAIL SAFE, NOT FAIL OPEN ───────────────────────────────────────────────
 * An unreadable, unsafe, or malformed sentinel resolves to `unknown`, and
 * `daemonPaused()` projects `unknown` as PAUSED. Precedent: `readKillSwitch()`
 * keeps `unknown` distinct from both states and `killSwitchOn()` projects it
 * restrictively (true unless proven absent). Same discipline here, pointed the
 * same way — towards "the autonomous agent does not run".
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 * Not an emergency stop: it does not quiesce in-flight work, it takes no
 * outward-mutation fence, and it grants no authority. It only makes the next
 * dispatch decision say "no". The body records WHO paused and WHEN so the
 * cockpit can say "paused 20 minutes ago from the CLI" instead of shrugging;
 * it holds no token, no argv, and no env value.
 *
 * No new runtime deps; node builtins only. Never throws out of a public API.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import { audit } from '../sandbox/audit.js';
import { fsyncDirectory } from '../util/durability.js';
import { daemonPausePath } from './state.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Who asked for the pause. A closed set so the body can never carry prose. */
export type DaemonPauseActor = 'cli' | 'verse-control-plane' | 'unknown';

const PAUSE_ACTORS = new Set<string>(['cli', 'verse-control-plane', 'unknown']);

/** The sentinel's JSON body. Metadata only — never a token, argv, or env value. */
export interface DaemonPauseRecord {
  /** ISO timestamp the pause was requested. */
  pausedAt: string;
  /** Which surface requested it. */
  by: DaemonPauseActor;
}

/**
 * A read of the pause sentinel that does NOT collapse an inspection failure
 * into either state. Mirrors `KillSwitchReadResult` deliberately, so the two
 * sentinels are read, projected, and rendered the same way.
 */
export interface DaemonPauseReadResult {
  /** 'paused' = sentinel present and valid. 'running' = proven absent. */
  state: 'paused' | 'running' | 'unknown';
  sourceState: 'healthy' | 'degraded';
  /** 'present' | 'missing' | 'unsafe' | 'malformed' | 'uninspectable'. */
  reason: string;
  /** Absolute sentinel path. Machine-local; do not ship it on an API payload. */
  path: string;
  /** The parsed body when state is 'paused'; null otherwise. */
  record: DaemonPauseRecord | null;
  /** errno when the read failed for a reason other than absence. */
  errorCode?: string | null;
}

/** Outcome of {@link setDaemonPause}. Idempotent in both directions. */
export interface DaemonPauseMutationResult {
  ok: boolean;
  /** False when the sentinel already had the requested state. */
  changed: boolean;
  /** 'paused' | 'already-paused' | 'resumed' | 'already-running' | an error code. */
  reason: string;
  /** The read taken immediately AFTER the mutation — the authoritative answer. */
  state: DaemonPauseReadResult;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_SENTINEL_BYTES = 4 * 1024;

function missingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function ownedByCurrentUser(stat: Stats): boolean {
  if (process.platform === 'win32') return true;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid === null || Number(stat.uid) === uid;
}

/**
 * The same file-safety predicate the kill sentinel uses: a real, unlinked-once
 * regular file owned by this user with no group/other write bit. A symlink or
 * a group-writable file is NOT a trustworthy pause record, and reading one as
 * "running" would be the fail-open direction.
 */
function safeSentinel(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1 &&
    ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function parseRecord(raw: string): DaemonPauseRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    if (keys.length !== 2 || keys[0] !== 'by' || keys[1] !== 'pausedAt') return null;
    const by = obj['by'];
    const pausedAt = obj['pausedAt'];
    if (typeof by !== 'string' || !PAUSE_ACTORS.has(by)) return null;
    if (typeof pausedAt !== 'string' || !Number.isFinite(Date.parse(pausedAt))) return null;
    return { pausedAt, by: by as DaemonPauseActor };
  } catch {
    return null;
  }
}

/** Write `value` to `path` durably: exclusive tmp file, fsync, atomic rename. */
function writeSentinel(path: string, value: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
      0o600,
    );
    const opened = fstatSync(fd);
    if (!safeSentinel(opened)) throw new Error('unsafe-pause-sentinel');
    const buf = Buffer.from(value, 'utf8');
    let written = 0;
    while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort close */ }
    }
    try { unlinkSync(tmp); } catch { /* the rename already consumed it */ }
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read the daemon pause sentinel without collapsing inspection failures into
 * either state. Never throws.
 *
 * Cheap on the hot path: absence costs one `lstat`, which is the case the
 * running daemon is in on every tick. Only a PRESENT sentinel is read and
 * parsed, and a present sentinel means the tick is about to short-circuit
 * anyway.
 */
export function readDaemonPause(): DaemonPauseReadResult {
  let path = '';
  try {
    path = daemonPausePath();
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (missingPath(error)) {
        return { state: 'running', sourceState: 'healthy', reason: 'missing', path, record: null };
      }
      return {
        state: 'unknown',
        sourceState: 'degraded',
        reason: 'uninspectable',
        path,
        record: null,
        errorCode: (error as NodeJS.ErrnoException).code ?? null,
      };
    }
    if (!safeSentinel(stat) || stat.size > MAX_SENTINEL_BYTES) {
      return { state: 'unknown', sourceState: 'degraded', reason: 'unsafe', path, record: null };
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      return {
        state: 'unknown',
        sourceState: 'degraded',
        reason: 'uninspectable',
        path,
        record: null,
        errorCode: (error as NodeJS.ErrnoException).code ?? null,
      };
    }
    const record = parseRecord(raw);
    if (!record) {
      // FAIL SAFE: a sentinel we cannot understand is a pause we cannot prove
      // was lifted. It is never read as "running".
      return { state: 'unknown', sourceState: 'degraded', reason: 'malformed', path, record: null };
    }
    return { state: 'paused', sourceState: 'healthy', reason: 'present', path, record };
  } catch (error) {
    return {
      state: 'unknown',
      sourceState: 'degraded',
      reason: 'uninspectable',
      path,
      record: null,
      errorCode: (error as NodeJS.ErrnoException)?.code ?? null,
    };
  }
}

/**
 * True unless the pause sentinel is PROVEN absent.
 *
 * The restrictive projection, exactly like `killSwitchOn()`: `unknown` means
 * the daemon does not dispatch. A degraded read must never be the reason an
 * autonomous agent starts spending money.
 */
export function daemonPaused(): boolean {
  return readDaemonPause().state !== 'running';
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Engage (`on: true`) or clear (`on: false`) the daemon pause. Idempotent in
 * both directions; never throws.
 *
 * DOES NOT touch `~/.ashlr/KILL`, take the outward-mutation fence, or quiesce
 * anything. A tick already inside dispatch finishes; the next one does not
 * start. That is the whole point of the control — it is reversible with one
 * click and costs the operator nothing to try.
 *
 * Audited on every call (the requested intent, idempotent or not), matching
 * `setKill`'s discipline.
 */
export function setDaemonPause(
  on: boolean,
  opts: { by?: DaemonPauseActor } = {},
): DaemonPauseMutationResult {
  const by: DaemonPauseActor = opts.by && PAUSE_ACTORS.has(opts.by) ? opts.by : 'unknown';
  const before = readDaemonPause();
  let ok: boolean;
  let changed: boolean;
  let reason: string;

  if (on) {
    if (before.state === 'paused') {
      ok = true;
      changed = false;
      reason = 'already-paused';
    } else {
      try {
        const record: DaemonPauseRecord = { pausedAt: new Date().toISOString(), by };
        writeSentinel(daemonPausePath(), JSON.stringify(record) + '\n');
        ok = true;
        changed = true;
        reason = 'paused';
      } catch (error) {
        ok = false;
        changed = false;
        reason = `pause-write-failed:${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}`;
      }
    }
  } else {
    if (before.state === 'running') {
      ok = true;
      changed = false;
      reason = 'already-running';
    } else {
      try {
        const path = daemonPausePath();
        unlinkSync(path);
        fsyncDirectory(dirname(path));
        ok = true;
        changed = true;
        reason = 'resumed';
      } catch (error) {
        if (missingPath(error)) {
          ok = true;
          changed = false;
          reason = 'already-running';
        } else {
          ok = false;
          changed = false;
          reason = `resume-failed:${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}`;
        }
      }
    }
  }

  // Read back rather than trusting the write: the caller's decision (and the
  // cockpit's badge) must come from the sentinel, not from our intent.
  const state = readDaemonPause();
  if (ok && (on ? state.state !== 'paused' : state.state !== 'running')) {
    ok = false;
    reason = 'pause-readback-failed';
  }

  try {
    audit({
      action: on ? 'daemon:pause' : 'daemon:resume',
      repo: null,
      sandboxId: null,
      summary: on
        ? `daemon dispatch paused by ${by} (${reason}); the global kill switch is untouched`
        : `daemon dispatch resumed by ${by} (${reason})`,
      result: ok ? 'ok' : 'error',
    });
  } catch {
    // audit() swallows its own errors; this covers a thrown path resolution.
  }

  return { ok, changed, reason, state };
}

/** `ashlr daemon pause` / `POST /api/verse/daemon {action:'pause'}`. */
export function pauseDaemon(by: DaemonPauseActor = 'unknown'): DaemonPauseMutationResult {
  return setDaemonPause(true, { by });
}

/** `ashlr daemon resume` / `POST /api/verse/daemon {action:'resume'}`. */
export function resumeDaemon(by: DaemonPauseActor = 'unknown'): DaemonPauseMutationResult {
  return setDaemonPause(false, { by });
}

export { daemonPausePath };
