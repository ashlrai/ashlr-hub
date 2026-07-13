/**
 * Append-only metadata-only daemon activity journal.
 *
 * This source is explicitly observational (`authority: "none"`). It must never
 * authorize dispatch, readiness, learning labels, verification, or merges.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fsyncDirectory } from '../util/durability.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';

const MAX_PARTITION_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5_000;
const MAX_ROW_BYTES = 768;
const MAX_PARTITIONS = 8;
const FUTURE_TOLERANCE_MS = 5_000;
export const DAEMON_ACTIVITY_STALE_MS = 90_000;

export type DaemonActivityPhase = 'starting' | 'tick' | 'post-tick' | 'idle' | 'stopping';
export type DaemonActivityFreshness = 'fresh' | 'stale' | 'future' | 'unknown';
export type DaemonActivityOwnerState = 'alive' | 'dead' | 'reused' | 'unknown';

export interface DaemonActivityRowV1 {
  schemaVersion: 1;
  observedAt: string;
  authority: 'none';
  instanceId: string;
  pid: number;
  processStartRef: string | null;
  daemonStartedAt: string;
  phase: DaemonActivityPhase;
  activeChildren: number | null;
}

export interface DaemonActivityReadResult {
  sourceState: 'missing' | 'healthy' | 'degraded';
  freshness: DaemonActivityFreshness;
  ownerState: DaemonActivityOwnerState;
  activity: DaemonActivityRowV1 | null;
  phaseStartedAt: string | null;
  ageMs: number | null;
}

const ROW_KEYS = new Set([
  'schemaVersion', 'observedAt', 'authority', 'instanceId', 'pid', 'processStartRef',
  'daemonStartedAt', 'phase', 'activeChildren',
]);
const INSTANCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const START_REF_RE = /^[a-f0-9]{64}$/;
const PARTITION_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function storageRoot(): string {
  const configured = process.env['ASHLR_HOME'];
  if (typeof configured === 'string' && configured.length > 0 && isAbsolute(configured)) {
    try {
      const normalized = resolve(configured);
      if (normalized === configured) return normalized;
    } catch {
      // Fall back to the private default.
    }
  }
  return join(homedir(), '.ashlr');
}

export function daemonActivityDirectory(): string {
  return join(storageRoot(), 'daemon-activity');
}

export function daemonActivityPath(day = new Date().toISOString().slice(0, 10)): string {
  return join(daemonActivityDirectory(), `${day}.jsonl`);
}

function privateOwner(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function privateDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && privateOwner(stat.uid) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function privateFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && privateOwner(stat.uid) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseRow(value: unknown): DaemonActivityRowV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== ROW_KEYS.size || Object.keys(row).some((key) => !ROW_KEYS.has(key)) ||
    row['schemaVersion'] !== 1 || row['authority'] !== 'none' || !canonicalTimestamp(row['observedAt']) ||
    !canonicalTimestamp(row['daemonStartedAt']) || Date.parse(row['daemonStartedAt']) > Date.parse(row['observedAt']) ||
    typeof row['instanceId'] !== 'string' || !INSTANCE_RE.test(row['instanceId']) ||
    !Number.isSafeInteger(row['pid']) || (row['pid'] as number) <= 0 ||
    !(row['processStartRef'] === null ||
      (typeof row['processStartRef'] === 'string' && START_REF_RE.test(row['processStartRef']))) ||
    !(row['phase'] === 'starting' || row['phase'] === 'tick' || row['phase'] === 'post-tick' ||
      row['phase'] === 'idle' || row['phase'] === 'stopping') ||
    !(row['activeChildren'] === null ||
      (Number.isSafeInteger(row['activeChildren']) && (row['activeChildren'] as number) >= 0 &&
        (row['activeChildren'] as number) <= 64))) return null;
  if (row['phase'] !== 'post-tick' && row['activeChildren'] !== null) return null;
  return row as unknown as DaemonActivityRowV1;
}

let selfStartRef: string | null | undefined;
function processStartRef(pid: number): string | null {
  if (pid === process.pid && selfStartRef !== undefined) return selfStartRef;
  if (process.platform === 'win32') return null;
  try {
    if (!existsSync('/bin/ps')) return null;
    const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 1_024, shell: false,
    });
    const value = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const ref = value ? createHash('sha256').update(`${pid}:${value}`).digest('hex') : null;
    if (pid === process.pid) selfStartRef = ref;
    return ref;
  } catch {
    return null;
  }
}

let ownerCache: {
  pid: number;
  startRef: string | null;
  checkedAt: number;
  state: DaemonActivityOwnerState;
} | null = null;

function pidState(pid: number, expectedStartRef: string | null): DaemonActivityOwnerState {
  const now = Date.now();
  if (ownerCache && ownerCache.pid === pid && ownerCache.startRef === expectedStartRef &&
    now - ownerCache.checkedAt < 5_000) return ownerCache.state;
  let state: DaemonActivityOwnerState;
  try {
    process.kill(pid, 0);
  } catch (error) {
    state = (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH' ? 'dead' : 'unknown';
    ownerCache = { pid, startRef: expectedStartRef, checkedAt: now, state };
    return state;
  }
  if (!expectedStartRef) state = 'unknown';
  const observed = processStartRef(pid);
  if (!expectedStartRef || !observed) state = 'unknown';
  else state = observed === expectedStartRef ? 'alive' : 'reused';
  ownerCache = { pid, startRef: expectedStartRef, checkedAt: now, state };
  return state;
}

function verifyOrCreatePrivateDirectory(path: string): Stats {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory() || !privateOwner(before.uid)) {
    throw new Error('unsafe daemon activity directory');
  }
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (!privateDirectory(after) || !sameNode(before, after)) throw new Error('daemon activity directory changed');
  return after;
}

function ensurePrivateDirectories(): { root: Stats; directory: Stats } {
  const root = verifyOrCreatePrivateDirectory(storageRoot());
  const directory = verifyOrCreatePrivateDirectory(daemonActivityDirectory());
  const rootAfter = lstatSync(storageRoot());
  if (!privateDirectory(rootAfter) || !sameNode(root, rootAfter)) throw new Error('daemon activity root changed');
  return { root: rootAfter, directory };
}

function readPartition(path: string, expectedDirectory: Stats): DaemonActivityRowV1[] | null {
  let fd: number | undefined;
  try {
    const directory = lstatSync(daemonActivityDirectory());
    if (!privateDirectory(directory) || !sameNode(directory, expectedDirectory)) return null;
    const named = lstatSync(path);
    if (!privateFile(named) || named.size < 2 || named.size > MAX_PARTITION_BYTES) return null;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(named, opened) || opened.size !== named.size) return null;
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!privateFile(after) || !privateFile(rebound) || !sameNode(opened, after) ||
      !sameNode(after, rebound) || after.size !== opened.size) return null;
    const raw = bytes.toString('utf8');
    if (!raw.endsWith('\n')) return null;
    const lines = raw.slice(0, -1).split('\n');
    if (lines.length === 0 || lines.length > MAX_ROWS) return null;
    const rows: DaemonActivityRowV1[] = [];
    for (const line of lines) {
      if (!line || Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) return null;
      const row = parseRow(JSON.parse(line));
      if (!row) return null;
      const prior = rows.at(-1);
      if (prior && row.observedAt < prior.observedAt) return null;
      rows.push(row);
    }
    return rows;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function prunePartitions(directory: string): boolean {
  try {
    const partitions = readdirSync(directory).filter((name) => PARTITION_RE.test(name)).sort();
    for (const name of partitions.slice(0, -MAX_PARTITIONS)) {
      const path = join(directory, name);
      let fd: number | undefined;
      try {
        const named = lstatSync(path);
        if (!privateFile(named)) return false;
        fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const opened = fstatSync(fd);
        const rebound = lstatSync(path);
        if (!privateFile(opened) || !privateFile(rebound) || !sameNode(named, opened) ||
          !sameNode(opened, rebound)) return false;
        unlinkSync(path);
      } finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
      }
    }
    fsyncDirectory(directory);
    return true;
  } catch {
    return false;
  }
}

export function readDaemonActivity(options: { nowMs?: number; staleMs?: number } = {}): DaemonActivityReadResult {
  const missing: DaemonActivityReadResult = {
    sourceState: 'missing', freshness: 'unknown', ownerState: 'unknown',
    activity: null, phaseStartedAt: null, ageMs: null,
  };
  const degraded: DaemonActivityReadResult = {
    ...missing, sourceState: 'degraded',
  };
  const rootPath = storageRoot();
  const directoryPath = daemonActivityDirectory();
  if (!existsSync(rootPath) || !existsSync(directoryPath)) return missing;
  try {
    const root = lstatSync(rootPath);
    const directory = lstatSync(directoryPath);
    if (!privateDirectory(root) || !privateDirectory(directory)) return degraded;
    const partitions = readdirSync(directoryPath)
      .filter((name) => PARTITION_RE.test(name))
      .sort();
    if (partitions.length === 0) return missing;
    if (partitions.length > MAX_PARTITIONS) return degraded;
    const rows = readPartition(join(directoryPath, partitions.at(-1)!), directory);
    if (!rows || rows.length === 0) return degraded;
    const activity = rows.at(-1)!;
    let phaseStartedAt = activity.observedAt;
    for (let index = rows.length - 2; index >= 0; index--) {
      const row = rows[index]!;
      if (row.instanceId !== activity.instanceId || row.phase !== activity.phase) break;
      phaseStartedAt = row.observedAt;
    }
    const nowMs = options.nowMs ?? Date.now();
    const observedMs = Date.parse(activity.observedAt);
    const delta = Number.isFinite(nowMs) ? nowMs - observedMs : NaN;
    const ageMs = Number.isFinite(delta) ? Math.max(0, delta) : null;
    const staleMs = Math.max(1_000, options.staleMs ?? DAEMON_ACTIVITY_STALE_MS);
    const freshness: DaemonActivityFreshness = !Number.isFinite(delta)
      ? 'unknown'
      : delta < -FUTURE_TOLERANCE_MS ? 'future' : delta > staleMs ? 'stale' : 'fresh';
    return {
      sourceState: 'healthy',
      freshness,
      ownerState: pidState(activity.pid, activity.processStartRef),
      activity,
      phaseStartedAt,
      ageMs,
    };
  } catch {
    return degraded;
  }
}

export function writeDaemonActivity(input: {
  instanceId: string;
  daemonStartedAt: string;
  phase: DaemonActivityPhase;
  activeChildren?: number | null;
  now?: Date;
}): boolean {
  const observedAt = (input.now ?? new Date()).toISOString();
  const row = parseRow({
    schemaVersion: 1,
    observedAt,
    authority: 'none',
    instanceId: input.instanceId,
    pid: process.pid,
    processStartRef: processStartRef(process.pid),
    daemonStartedAt: input.daemonStartedAt,
    phase: input.phase,
    activeChildren: input.phase === 'post-tick' ? input.activeChildren ?? 0 : null,
  });
  if (!row) return false;
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
  if (bytes.length > MAX_ROW_BYTES) return false;
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  let fd: number | undefined;
  try {
    const directories = ensurePrivateDirectories();
    const path = daemonActivityPath(observedAt.slice(0, 10));
    lock = acquireLocalStoreLock(join(daemonActivityDirectory(), '.activity.lock'), 2_000);
    if (!lock) return false;
    const directoryAfterLock = lstatSync(daemonActivityDirectory());
    if (!privateDirectory(directoryAfterLock) || !sameNode(directories.directory, directoryAfterLock)) return false;
    let prior: Stats | null = null;
    if (existsSync(path)) {
      prior = lstatSync(path);
      if (!privateFile(prior) || prior.size + bytes.length > MAX_PARTITION_BYTES) return false;
      const priorRows = readPartition(path, directories.directory);
      if (!priorRows || priorRows.length >= MAX_ROWS) return false;
      fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
    } else {
      fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    }
    const opened = fstatSync(fd);
    if (!privateFile(opened) || (prior && !sameNode(prior, opened))) return false;
    if (writeSync(fd, bytes) !== bytes.length) return false;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    const expectedSize = (prior?.size ?? 0) + bytes.length;
    if (!privateFile(persisted) || !sameNode(opened, persisted) || persisted.size !== expectedSize) return false;
    const rebound = lstatSync(path);
    if (!privateFile(rebound) || !sameNode(persisted, rebound) || rebound.size !== expectedSize) return false;
    fsyncDirectory(daemonActivityDirectory());
    return prunePartitions(daemonActivityDirectory());
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    releaseLocalStoreLock(lock);
  }
}
