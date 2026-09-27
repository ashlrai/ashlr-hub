/**
 * What the daemon's CURRENT tick is doing, for `ashlr daemon status` and the
 * Fleet status API ("tick in progress: mirror prep (ashlrai/binshield:
 * installing dependencies with pnpm) for 9m").
 *
 * Why this exists (2026-09-26, the fleet's first live tick): the first tick
 * spent 15 minutes in mirror preparation — two dependency installs that
 * stalled until their 10-minute timeout, then a synchronous delete of the
 * half-written node_modules — while `ashlr daemon status` still said "last
 * tick 25d ago" with no hint that a tick was running or where. The activity
 * journal (activity.ts) says only `phase: tick`; its row schema is strict and
 * shared, so the finer phase lives here instead.
 *
 * OBSERVATIONAL ONLY (authority: none). Nothing may gate dispatch, readiness,
 * verification or merges on this file. It is a single small JSON record,
 * rewritten atomically on each phase change of a tick and removed when the
 * tick ends; a reader treats a record whose writer is gone as no tick.
 *
 * Writes happen only while this process has a tick open (`beginTickProgress`
 * — the resident loop calls it around every tick), so the manual `ashlr
 * mirror sync` path, which shares the mirror code that reports phases, never
 * writes it.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface DaemonTickProgressV1 {
  v: 1;
  authority: 'none';
  pid: number;
  /** When the current tick began. */
  tickStartedAt: string;
  /** A short phase name: 'starting', 'tick hooks', 'mirror prep', 'dispatch', … */
  phase: string;
  /** What exactly, when known (e.g. `ashlrai/binshield: installing dependencies with pnpm`). */
  detail: string | null;
  phaseStartedAt: string;
}

export interface DaemonTickProgressRead {
  progress: DaemonTickProgressV1;
  /** How long the tick has been running. */
  tickAgeMs: number;
  /** How long it has been in the current phase. */
  phaseAgeMs: number;
}

const MAX_TEXT = 200;

function storageRoot(): string {
  // Same resolution as activity.ts: an absolute, normalized ASHLR_HOME, else ~/.ashlr.
  const configured = process.env['ASHLR_HOME'];
  if (typeof configured === 'string' && configured.length > 0 && isAbsolute(configured) && resolve(configured) === configured) {
    return configured;
  }
  return join(homedir(), '.ashlr');
}

export function daemonTickProgressPath(): string {
  return join(storageRoot(), 'daemon-tick-progress.json');
}

function bounded(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

let open: { tickStartedAt: string } | null = null;

function write(record: DaemonTickProgressV1): void {
  const root = storageRoot();
  const target = daemonTickProgressPath();
  const temporary = join(root, `.daemon-tick-progress.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
    writeSync(fd, `${JSON.stringify(record)}\n`);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
  } catch {
    // Observational: a failed write must never affect the tick.
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

/** The resident loop opens a tick. Returns a function that closes it (idempotent). */
export function beginTickProgress(now: Date = new Date()): () => void {
  const tickStartedAt = now.toISOString();
  const mine = { tickStartedAt };
  open = mine;
  write({ v: 1, authority: 'none', pid: process.pid, tickStartedAt, phase: 'starting', detail: null, phaseStartedAt: tickStartedAt });
  return () => {
    if (open !== mine) return;
    open = null;
    try {
      const current = readRecord();
      // Remove only our own record (a restarted daemon may already have written its own).
      if (!current || (current.pid === process.pid && current.tickStartedAt === tickStartedAt)) {
        rmSync(daemonTickProgressPath(), { force: true });
      }
    } catch { /* best effort */ }
  };
}

/** Record the phase the open tick is in. A no-op when this process has no tick open. */
export function noteTickPhase(phase: string, detail: string | null = null, now: Date = new Date()): void {
  if (!open) return;
  write({
    v: 1,
    authority: 'none',
    pid: process.pid,
    tickStartedAt: open.tickStartedAt,
    phase: bounded(phase) || 'tick',
    detail: detail === null ? null : bounded(detail) || null,
    phaseStartedAt: now.toISOString(),
  });
}

/** True while this process has a tick open (tests and callers that build details lazily). */
export function tickProgressOpen(): boolean {
  return open !== null;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function readRecord(): DaemonTickProgressV1 | null {
  const path = daemonTickProgressPath();
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed['v'] !== 1 || parsed['authority'] !== 'none') return null;
    if (!Number.isSafeInteger(parsed['pid']) || (parsed['pid'] as number) <= 0) return null;
    if (!canonicalIso(parsed['tickStartedAt']) || !canonicalIso(parsed['phaseStartedAt'])) return null;
    if (typeof parsed['phase'] !== 'string' || parsed['phase'].length === 0) return null;
    if (parsed['detail'] !== null && typeof parsed['detail'] !== 'string') return null;
    return {
      v: 1,
      authority: 'none',
      pid: parsed['pid'] as number,
      tickStartedAt: parsed['tickStartedAt'],
      phase: bounded(parsed['phase']),
      detail: parsed['detail'] === null ? null : bounded(parsed['detail'] as string),
      phaseStartedAt: parsed['phaseStartedAt'],
    };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but is not ours to signal — still alive.
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

/**
 * The tick in progress, or null when none is (no record, a malformed one, or
 * its writer is gone). `expectPid` narrows it to the daemon the caller already
 * believes is running.
 */
export function readTickProgress(options: { nowMs?: number; expectPid?: number | null } = {}): DaemonTickProgressRead | null {
  const record = readRecord();
  if (!record) return null;
  if (typeof options.expectPid === 'number' && record.pid !== options.expectPid) return null;
  if (!pidAlive(record.pid)) return null;
  const nowMs = options.nowMs ?? Date.now();
  return {
    progress: record,
    tickAgeMs: Math.max(0, nowMs - Date.parse(record.tickStartedAt)),
    phaseAgeMs: Math.max(0, nowMs - Date.parse(record.phaseStartedAt)),
  };
}

/** "1m", "14m", "2h 5m" — for the status line. */
export function describeTickDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return `${Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `tick in progress: mirror prep (ashlrai/binshield: installing dependencies with pnpm) for 9m (tick 14m)`. */
export function describeTickProgress(read: DaemonTickProgressRead): string {
  const { progress } = read;
  const what = progress.detail ? `${progress.phase} (${progress.detail})` : progress.phase;
  const tickPart = read.tickAgeMs - read.phaseAgeMs >= 60_000 ? ` (tick ${describeTickDuration(read.tickAgeMs)})` : '';
  return `tick in progress: ${what} for ${describeTickDuration(read.phaseAgeMs)}${tickPart}`;
}
