/**
 * core/verse/process-registry.ts — which vendor CLI processes this Verse
 * server launched, so the NEXT server can reap the ones a crash left behind.
 *
 *   <root>/running.json   (default root ~/.ashlr/verse; 0600, atomic rewrite)
 *   { "v": 1, "entries": [ { sessionId, turnId, pid, pgid, markers, spawnedAt,
 *                            serverPid, serverStartedAt } ] }
 *
 * WHY. Every turn's CLI runs in its own DETACHED process group (so Stop can
 * signal the whole tree). When the server dies without settling it — a crash,
 * `kill -9`, a sidecar the desktop shell tore down — the OS reparents that
 * group to launchd, and it keeps spending quota and editing files with
 * `acceptEdits` and no timeout (r2/reliability.md #3). On the next start
 * `reconcileInterrupted` marked the session errored but never killed anything,
 * although the pid was sitting in the log's `turn-started` event.
 *
 * IDENTITY BEFORE KILLING. A pid in a file is only a hint: the process may be
 * long gone and the number reused. A group is killed only when it is proven
 * to be the one we launched:
 *  - the registering server is dead (a live server owns its own turns), and
 *  - the group LEADER (pid === pgid) started within START_TOLERANCE_MS of the
 *    recorded spawn time AND its command line names one of the recorded argv
 *    markers (launcher basename / vendor binary name); or
 *  - the leader is gone but members of that process group remain — POSIX never
 *    reuses a pid as a new group id while the old group still has members, so
 *    those members ARE the orphans — and every one of them started after the
 *    recorded spawn.
 * Anything short of that is left alone and logged. Wrongly skipping an orphan
 * costs quota; wrongly killing a stranger's process is unacceptable.
 *
 * Kill: SIGTERM to the group, then SIGKILL after a grace period if it is still
 * alive (unref'd timer — never holds the process open).
 *
 * `ps` is only run when there is something to verify (a live group whose
 * server is dead); a clean start reads an empty file and spawns nothing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { writePrivateFileAtomically } from './session-store.js';

export const VERSE_RUNNING_FILE = 'running.json';
/** `ps -o lstart` has one-second resolution; a spawn is matched within this window. */
export const START_TOLERANCE_MS = 3_000;
/** SIGTERM → SIGKILL escalation for a reaped group. */
export const REAP_TERM_GRACE_MS = 3_000;

export interface VerseRunningEntry {
  sessionId: string;
  turnId: string;
  /** Group leader pid (the spawned CLI / launcher). */
  pid: number;
  /** Process group id; null where groups are not used (Windows) — never reaped. */
  pgid: number | null;
  /**
   * Command-line markers the leader must show before it may be killed:
   * basenames of the spawned binary / launcher script and the vendor CLI name.
   * Basenames only — the full launcher path names a private native profile.
   */
  markers: string[];
  /** Epoch ms, taken right after spawn() returned. */
  spawnedAt: number;
  serverPid: number;
  /** Epoch ms the registering server process started; null when unknown. */
  serverStartedAt: number | null;
}

export interface ProcessRow {
  pid: number;
  pgid: number;
  /** Epoch ms (second resolution). */
  startedAt: number;
  command: string;
}

export interface ReapReport {
  examined: number;
  reaped: { sessionId: string; turnId: string; pgid: number; pids: number[] }[];
  skipped: { sessionId: string; turnId: string; reason: string }[];
}

export interface ProcessRegistryOptions {
  /** Every process on the machine, or null when that cannot be read (then nothing is reaped). */
  listProcesses?: () => ProcessRow[] | null;
  /** `kill(pid, 0)` semantics: true when the pid (or, negative, the group) exists. */
  exists?: (pidOrNegPgid: number) => boolean;
  kill?: (pidOrNegPgid: number, signal: NodeJS.Signals) => void;
  termGraceMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** This server's identity. Default: process.pid and its start time from uptime. */
  serverPid?: number;
  serverStartedAt?: number | null;
}

export interface VerseProcessRegistry {
  readonly path: string;
  /** Record a launched turn. Never throws (a registry write must not fail a turn). */
  add(entry: Omit<VerseRunningEntry, 'serverPid' | 'serverStartedAt'>): void;
  /** Forget a settled turn. Never throws. */
  remove(sessionId: string, turnId: string): void;
  entries(): VerseRunningEntry[];
  /** Kill verified orphans of dead servers and prune the file. Call once at startup. */
  reapOrphans(): ReapReport;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isEntry(value: unknown): value is VerseRunningEntry {
  return isObject(value)
    && typeof value['sessionId'] === 'string'
    && typeof value['turnId'] === 'string'
    && isPid(value['pid'])
    && (value['pgid'] === null || isPid(value['pgid']))
    && Array.isArray(value['markers']) && value['markers'].every((m) => typeof m === 'string' && m.length > 0)
    && typeof value['spawnedAt'] === 'number' && Number.isFinite(value['spawnedAt'])
    && isPid(value['serverPid'])
    && (value['serverStartedAt'] === null
      || (typeof value['serverStartedAt'] === 'number' && Number.isFinite(value['serverStartedAt'])));
}

/** Basenames used as command-line markers; never a full path. */
export function argvMarkers(argv: readonly string[], vendorBinary: string | null): string[] {
  const out = new Set<string>();
  for (const part of argv.slice(0, 2)) {
    const name = basename(part);
    // Too generic to identify anything (`node`, `sh`): the start time does the work.
    if (name.length >= 4 && name !== 'node' && name !== 'env') out.add(name);
  }
  if (vendorBinary) out.add(vendorBinary);
  return [...out];
}

const LSTART_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** Parse `ps -A -ww -o pid=,pgid=,lstart=,command=` output. Exported for tests. */
export function parsePsRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = LSTART_ROW_RE.exec(line);
    if (!m) continue;
    const startedAt = Date.parse(m[3].replace(/\s+/g, ' '));
    if (!Number.isFinite(startedAt)) continue;
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), startedAt, command: m[4] });
  }
  return rows;
}

/**
 * Default process lister. Fixed `/bin/ps` (never a PATH lookup — this feeds a
 * kill decision) with the C locale so `lstart` parses. Null on any failure or
 * an unsupported platform, which means "cannot verify" → nothing is killed.
 */
export function listProcessesWithPs(): ProcessRow[] | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  if (!existsSync('/bin/ps')) return null;
  try {
    const result = spawnSync('/bin/ps', ['-A', '-ww', '-o', 'pid=,pgid=,lstart=,command='], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
      shell: false,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    return parsePsRows(result.stdout);
  } catch {
    return null;
  }
}

function defaultExists(pidOrNegPgid: number): boolean {
  try {
    process.kill(pidOrNegPgid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

function defaultKill(pidOrNegPgid: number, signal: NodeJS.Signals): void {
  process.kill(pidOrNegPgid, signal);
}

export function createProcessRegistry(root: string, opts: ProcessRegistryOptions = {}): VerseProcessRegistry {
  const path = join(root, VERSE_RUNNING_FILE);
  const listProcesses = opts.listProcesses ?? listProcessesWithPs;
  const exists = opts.exists ?? defaultExists;
  const kill = opts.kill ?? defaultKill;
  const termGraceMs = opts.termGraceMs ?? REAP_TERM_GRACE_MS;
  const log = opts.log ?? (() => {});
  const serverPid = opts.serverPid ?? process.pid;
  const serverStartedAt = opts.serverStartedAt !== undefined
    ? opts.serverStartedAt
    : Math.round(Date.now() - process.uptime() * 1_000);

  function read(): VerseRunningEntry[] {
    try {
      if (!existsSync(path)) return [];
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!isObject(parsed) || !Array.isArray(parsed['entries'])) return [];
      return parsed['entries'].filter(isEntry);
    } catch {
      return [];
    }
  }

  function write(entries: VerseRunningEntry[]): void {
    writePrivateFileAtomically(root, path, `${JSON.stringify({ v: 1, entries }, null, 2)}\n`);
  }

  /**
   * Read-modify-write. Two servers can share one root (a stale one plus the
   * desktop sidecar); each only ever changes ITS OWN entries plus, at reap
   * time, the entries of servers proven dead, so the other's survive.
   */
  function update(change: (entries: VerseRunningEntry[]) => VerseRunningEntry[]): void {
    try {
      write(change(read()));
    } catch (err) {
      log('warn', `process registry write failed: ${(err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error'}`);
    }
  }

  /** True when the registering server is (still) this or another live server. */
  function serverAlive(entry: VerseRunningEntry, rows: ProcessRow[] | null): boolean {
    if (entry.serverPid === serverPid) return true;
    if (!exists(entry.serverPid)) return false;
    // The pid exists. Only a start-time mismatch (pid reused by a stranger)
    // proves the server dead; without a listing, assume it is alive.
    if (!rows || entry.serverStartedAt === null) return true;
    const row = rows.find((r) => r.pid === entry.serverPid);
    if (!row) return true;
    return Math.abs(row.startedAt - entry.serverStartedAt) <= START_TOLERANCE_MS;
  }

  function verifyGroup(entry: VerseRunningEntry, rows: ProcessRow[]): { ok: true; pids: number[] } | { ok: false; reason: string } {
    const pgid = entry.pgid as number;
    const members = rows.filter((r) => r.pgid === pgid);
    if (members.length === 0) return { ok: false, reason: 'process group already gone' };
    const leader = members.find((r) => r.pid === pgid);
    if (leader) {
      if (Math.abs(leader.startedAt - entry.spawnedAt) > START_TOLERANCE_MS) {
        return { ok: false, reason: `pid ${pgid} was reused (started ${new Date(leader.startedAt).toISOString()})` };
      }
      if (entry.markers.length > 0 && !entry.markers.some((m) => leader.command.includes(m))) {
        return { ok: false, reason: `pid ${pgid} command does not match the launched CLI` };
      }
      return { ok: true, pids: members.map((m) => m.pid) };
    }
    // Leader gone, members remain: see the header for why they are ours.
    const early = members.find((m) => m.startedAt < entry.spawnedAt - START_TOLERANCE_MS);
    if (early) return { ok: false, reason: `group ${pgid} has a member older than the turn (pid ${early.pid})` };
    return { ok: true, pids: members.map((m) => m.pid) };
  }

  function killGroup(pgid: number): void {
    try { kill(-pgid, 'SIGTERM'); } catch { return; }
    const timer = setTimeout(() => {
      try {
        if (exists(-pgid)) kill(-pgid, 'SIGKILL');
      } catch { /* gone */ }
    }, termGraceMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    path,

    add(entry): void {
      const full: VerseRunningEntry = { ...entry, serverPid, serverStartedAt };
      update((entries) => [
        ...entries.filter((e) => !(e.serverPid === serverPid && e.sessionId === entry.sessionId)),
        full,
      ]);
    },

    remove(sessionId: string, turnId: string): void {
      update((entries) => entries.filter((e) => !(e.serverPid === serverPid && e.sessionId === sessionId && e.turnId === turnId)));
    },

    entries(): VerseRunningEntry[] {
      return read();
    },

    reapOrphans(): ReapReport {
      const report: ReapReport = { examined: 0, reaped: [], skipped: [] };
      const all = read();
      if (all.length === 0) return report;
      report.examined = all.length;

      // Cheap pass first: an entry whose server is plainly dead and whose
      // group no longer exists needs no `ps` at all.
      const needsListing = all.some((e) =>
        (e.serverPid !== serverPid && exists(e.serverPid)) // may be a reused pid: verify
        || (e.pgid !== null && !exists(e.serverPid) && exists(-e.pgid)));
      const rows = needsListing ? listProcesses() : null;

      const keep: VerseRunningEntry[] = [];
      for (const entry of all) {
        if (serverAlive(entry, rows)) {
          keep.push(entry);
          continue;
        }
        if (entry.pgid === null || !exists(-entry.pgid)) continue; // nothing left to kill
        if (!rows) {
          report.skipped.push({ sessionId: entry.sessionId, turnId: entry.turnId, reason: 'process list unavailable; cannot verify identity' });
          log('warn', `orphan check skipped for session ${entry.sessionId}: cannot list processes to verify pgid ${entry.pgid}`);
          continue;
        }
        const verdict = verifyGroup(entry, rows);
        if (!verdict.ok) {
          report.skipped.push({ sessionId: entry.sessionId, turnId: entry.turnId, reason: verdict.reason });
          log('info', `orphan not reaped for session ${entry.sessionId}: ${verdict.reason}`);
          continue;
        }
        killGroup(entry.pgid);
        report.reaped.push({ sessionId: entry.sessionId, turnId: entry.turnId, pgid: entry.pgid, pids: verdict.pids });
        log('warn', `reaped orphaned turn process group ${entry.pgid} (pids ${verdict.pids.join(',')}) of session ${entry.sessionId}, left by dead server pid ${entry.serverPid}`);
      }
      if (keep.length !== all.length) {
        update((current) => current.filter((e) => keep.some((k) =>
          k.serverPid === e.serverPid && k.sessionId === e.sessionId && k.turnId === e.turnId)
          // An entry a live server added while we were reaping is kept too.
          || !all.some((a) => a.serverPid === e.serverPid && a.sessionId === e.sessionId && a.turnId === e.turnId)));
      }
      return report;
    },
  };
}
