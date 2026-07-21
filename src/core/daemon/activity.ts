/**
 * Append-only metadata-only daemon activity journal.
 *
 * This source is explicitly observational (`authority: "none"`). It must never
 * authorize dispatch, readiness, learning labels, verification, or merges.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
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
const MAX_SEGMENT_INDEX = 9_999;
const MAX_PHASE_SCAN_ROWS = 512;
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
const PARTITION_RE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d{4}))?\.jsonl$/;
const UUID_RE_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const STAGING_RE = new RegExp(
  `^\\.activity-stage-(\\d{4}-\\d{2}-\\d{2})-(\\d{4})-(${UUID_RE_SOURCE})-([a-f0-9]{64})\\.tmp$`,
  'i',
);
const DELETE_RE = new RegExp(`^\\.activity-delete-(${UUID_RE_SOURCE})\\.tmp$`, 'i');

interface ActivityPartition {
  day: string;
  index: number;
  name: string;
  path: string;
}

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

function daemonActivitySegmentPath(day: string, index: number): string {
  return index === 0
    ? daemonActivityPath(day)
    : join(daemonActivityDirectory(), `${day}.${String(index).padStart(4, '0')}.jsonl`);
}

function daemonActivityStagePath(day: string, index: number, bytes: Buffer): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return join(
    daemonActivityDirectory(),
    `.activity-stage-${day}-${String(index).padStart(4, '0')}-${randomUUID()}-${digest}.tmp`,
  );
}

function privateOwner(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function privateDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && privateOwner(stat.uid) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function privateFileWithLinks(stat: Stats, allowedLinks: readonly number[]): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && allowedLinks.includes(stat.nlink) && privateOwner(stat.uid) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function privateFile(stat: Stats): boolean {
  return privateFileWithLinks(stat, [1]);
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalDay(value: string): boolean {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
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

function readPartitionBytes(
  path: string,
  expectedDirectory: Stats,
  allowedLinks: readonly number[] = [1],
): Buffer | null {
  let fd: number | undefined;
  try {
    const directory = lstatSync(daemonActivityDirectory());
    if (!privateDirectory(directory) || !sameNode(directory, expectedDirectory)) return null;
    const named = lstatSync(path);
    if (!privateFileWithLinks(named, allowedLinks) || named.size < 2 || named.size > MAX_PARTITION_BYTES) return null;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFileWithLinks(opened, allowedLinks) || !sameNode(named, opened) || opened.size !== named.size) return null;
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!privateFileWithLinks(after, allowedLinks) || !privateFileWithLinks(rebound, allowedLinks) ||
      !sameNode(opened, after) ||
      !sameNode(after, rebound) || after.size !== opened.size) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function partitionLines(
  path: string,
  expectedDirectory: Stats,
  allowedLinks: readonly number[] = [1],
): string[] | null {
  const bytes = readPartitionBytes(path, expectedDirectory, allowedLinks);
  if (!bytes) return null;
  try {
    const raw = bytes.toString('utf8');
    if (!raw.endsWith('\n')) return null;
    const lines = raw.slice(0, -1).split('\n');
    if (lines.length === 0 || lines.length > MAX_ROWS) return null;
    for (const line of lines) {
      if (!line || Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) return null;
    }
    return lines;
  } catch {
    return null;
  }
}

function readPartition(
  path: string,
  expectedDirectory: Stats,
  allowedLinks: readonly number[] = [1],
): DaemonActivityRowV1[] | null {
  const lines = partitionLines(path, expectedDirectory, allowedLinks);
  if (!lines) return null;
  try {
    const rows: DaemonActivityRowV1[] = [];
    for (const line of lines) {
      const row = parseRow(JSON.parse(line));
      if (!row) return null;
      const prior = rows.at(-1);
      if (prior && row.observedAt < prior.observedAt) return null;
      rows.push(row);
    }
    return rows;
  } catch {
    return null;
  }
}

function inspectPartitionEnvelope(path: string, expectedDirectory: Stats): boolean {
  let fd: number | undefined;
  try {
    const directory = lstatSync(daemonActivityDirectory());
    if (!privateDirectory(directory) || !sameNode(directory, expectedDirectory)) return false;
    const named = lstatSync(path);
    if (!privateFile(named) || named.size < 2 || named.size > MAX_PARTITION_BYTES) return false;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(named, opened) || opened.size !== named.size) return false;
    const finalByte = Buffer.alloc(1);
    if (readSync(fd, finalByte, 0, 1, opened.size - 1) !== 1 || finalByte[0] !== 0x0a) return false;
    const after = fstatSync(fd);
    const rebound = lstatSync(path);
    return privateFile(after) && privateFile(rebound) && sameNode(opened, after) &&
      sameNode(after, rebound) && after.size === opened.size;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function listPartitions(directory: string): ActivityPartition[] | null {
  try {
    const partitions: ActivityPartition[] = [];
    for (const name of readdirSync(directory)) {
      const match = PARTITION_RE.exec(name);
      if (!match) continue;
      const day = match[1]!;
      const index = match[2] === undefined ? 0 : Number(match[2]);
      if (!canonicalDay(day) || !Number.isSafeInteger(index) || index < 0 || index > MAX_SEGMENT_INDEX ||
        (match[2] !== undefined && index === 0)) return null;
      partitions.push({ day, index, name, path: join(directory, name) });
    }
    partitions.sort((left, right) => left.day.localeCompare(right.day) || left.index - right.index);
    for (let index = 1; index < partitions.length; index++) {
      const prior = partitions[index - 1]!;
      const current = partitions[index]!;
      if (prior.day === current.day) {
        if (current.index !== prior.index + 1) return null;
      } else if (current.index !== 0) {
        return null;
      }
    }
    return partitions;
  } catch {
    return null;
  }
}

function stableDirectory(directory: string, expectedDirectory: Stats): boolean {
  try {
    const current = lstatSync(directory);
    return privateDirectory(current) && sameNode(current, expectedDirectory);
  } catch {
    return false;
  }
}

function fsyncStableDirectory(directory: string, expectedDirectory: Stats): boolean {
  try {
    if (!stableDirectory(directory, expectedDirectory)) return false;
    fsyncDirectory(directory);
    return stableDirectory(directory, expectedDirectory);
  } catch {
    return false;
  }
}

/**
 * Remove an identity-pinned file without unlinking its public pathname.
 *
 * Portable Node has no unlinkat(2) or fd-relative remove. Renaming the verified
 * inode to an unpredictable tombstone first prevents a pathname swap from
 * deleting a different public entry. A same-UID process could still discover
 * and replace the tombstone between the final lstat and unlink; the private
 * directory, random name, immediate recheck, and post-unlink nlink check narrow
 * that irreducible portable window, and any detected mismatch fails closed.
 */
function removeVerifiedFile(
  path: string,
  directory: string,
  expectedDirectory: Stats,
  allowedLinks: readonly number[] = [1],
): boolean {
  let fd: number | undefined;
  try {
    if (!stableDirectory(directory, expectedDirectory)) return false;
    const named = lstatSync(path);
    if (!privateFileWithLinks(named, allowedLinks)) return false;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!privateFileWithLinks(opened, allowedLinks) || !privateFileWithLinks(rebound, allowedLinks) ||
      !sameNode(named, opened) || !sameNode(opened, rebound)) return false;

    const tombstone = join(directory, `.activity-delete-${randomUUID()}.tmp`);
    if (existsSync(tombstone) || !stableDirectory(directory, expectedDirectory)) return false;
    renameSync(path, tombstone);
    if (!stableDirectory(directory, expectedDirectory)) return false;
    const moved = lstatSync(tombstone);
    const openedAfterMove = fstatSync(fd);
    if (!privateFileWithLinks(moved, allowedLinks) || !privateFileWithLinks(openedAfterMove, allowedLinks) ||
      !sameNode(opened, moved) || !sameNode(moved, openedAfterMove)) return false;
    const immediatelyBeforeUnlink = lstatSync(tombstone);
    if (!sameNode(openedAfterMove, immediatelyBeforeUnlink) ||
      !privateFileWithLinks(immediatelyBeforeUnlink, allowedLinks)) return false;
    unlinkSync(tombstone);
    const afterUnlink = fstatSync(fd);
    if (!sameNode(opened, afterUnlink) || afterUnlink.nlink !== opened.nlink - 1) return false;
    return fsyncStableDirectory(directory, expectedDirectory);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function prunePartitions(
  directory: string,
  expectedDirectory: Stats,
  partitions: ActivityPartition[],
  keepCount: number,
): boolean {
  try {
    const dropping = partitions.slice(0, Math.max(0, partitions.length - keepCount));
    for (const partition of dropping) {
      if (!removeVerifiedFile(partition.path, directory, expectedDirectory)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function recoverActivityTransactions(directory: string, expectedDirectory: Stats): boolean {
  try {
    const initialNames = readdirSync(directory);
    for (const name of initialNames.filter((entry) => DELETE_RE.test(entry)).sort()) {
      if (!removeVerifiedFile(join(directory, name), directory, expectedDirectory, [1, 2])) return false;
    }

    const stagingNames = readdirSync(directory).filter((name) => STAGING_RE.test(name)).sort();
    let publishedTransactions = 0;
    for (const name of stagingNames) {
      const match = STAGING_RE.exec(name);
      if (!match) return false;
      const day = match[1]!;
      const index = Number(match[2]);
      const expectedDigest = match[4]!;
      if (!canonicalDay(day) || !Number.isSafeInteger(index) || index < 0 || index > MAX_SEGMENT_INDEX) return false;
      const stagePath = join(directory, name);
      const stage = lstatSync(stagePath);
      if (!privateFileWithLinks(stage, [1, 2])) return false;
      const targetPath = daemonActivitySegmentPath(day, index);

      if (!existsSync(targetPath)) {
        if (stage.nlink !== 1 || !removeVerifiedFile(stagePath, directory, expectedDirectory)) return false;
        continue;
      }

      const target = lstatSync(targetPath);
      if (!sameNode(stage, target)) {
        if (stage.nlink !== 1 || !removeVerifiedFile(stagePath, directory, expectedDirectory)) return false;
        continue;
      }
      if (stage.nlink !== 2 || target.nlink !== 2 || ++publishedTransactions > 1) return false;
      const publishedBytes = readPartitionBytes(targetPath, expectedDirectory, [2]);
      if (!publishedBytes || createHash('sha256').update(publishedBytes).digest('hex') !== expectedDigest) return false;
      const rows = readPartition(targetPath, expectedDirectory, [2]);
      if (!rows || rows.length !== 1 || rows[0]!.observedAt.slice(0, 10) !== day) return false;
      const partitions = listPartitions(directory);
      if (!partitions || partitions.length > MAX_PARTITIONS + 1 || partitions.at(-1)?.path !== targetPath) return false;
      const predecessor = partitions.at(-2);
      if (predecessor) {
        const predecessorRows = readPartition(predecessor.path, expectedDirectory);
        if (!predecessorRows || predecessorRows.at(-1)!.observedAt > rows[0]!.observedAt) return false;
      }
      if (!prunePartitions(directory, expectedDirectory, partitions, MAX_PARTITIONS)) return false;
      if (!removeVerifiedFile(stagePath, directory, expectedDirectory, [2])) return false;
      const published = lstatSync(targetPath);
      if (!privateFile(published) || !sameNode(stage, published)) return false;
    }

    const recovered = listPartitions(directory);
    return recovered !== null && recovered.length <= MAX_PARTITIONS;
  } catch {
    return false;
  }
}

function publishStagedPartition(
  path: string,
  day: string,
  index: number,
  bytes: Buffer,
  directory: string,
  expectedDirectory: Stats,
): boolean {
  const stagePath = daemonActivityStagePath(day, index, bytes);
  let fd: number | undefined;
  try {
    if (!stableDirectory(directory, expectedDirectory) || existsSync(path)) return false;
    fd = openSync(
      stagePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!privateFile(opened) || opened.size !== 0) return false;
    if (writeSync(fd, bytes) !== bytes.length) return false;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    if (!privateFile(persisted) || !sameNode(opened, persisted) || persisted.size !== bytes.length) return false;
    closeSync(fd);
    fd = undefined;
    if (!fsyncStableDirectory(directory, expectedDirectory) || existsSync(path)) return false;

    // linkSync is an atomic no-overwrite publication: unlike renameSync it
    // refuses a raced target. The staging hard link remains the recovery marker
    // until the new partition is durable and retention pruning has completed.
    linkSync(stagePath, path);
    const stage = lstatSync(stagePath);
    const published = lstatSync(path);
    if (!privateFileWithLinks(stage, [2]) || !privateFileWithLinks(published, [2]) ||
      !sameNode(persisted, stage) || !sameNode(stage, published) || published.size !== bytes.length ||
      !fsyncStableDirectory(directory, expectedDirectory)) return false;
    const publishedBytes = readPartitionBytes(path, expectedDirectory, [2]);
    if (!publishedBytes || !publishedBytes.equals(bytes)) return false;

    const publishedPartitions = listPartitions(directory);
    if (!publishedPartitions || publishedPartitions.length > MAX_PARTITIONS + 1 ||
      publishedPartitions.at(-1)?.path !== path ||
      !prunePartitions(directory, expectedDirectory, publishedPartitions, MAX_PARTITIONS)) return false;
    if (!removeVerifiedFile(stagePath, directory, expectedDirectory, [2])) return false;
    const final = lstatSync(path);
    const finalBytes = readPartitionBytes(path, expectedDirectory);
    return privateFile(final) && sameNode(stage, final) && final.size === bytes.length &&
      finalBytes !== null && finalBytes.equals(bytes) && fsyncStableDirectory(directory, expectedDirectory);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
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
    const partitions = listPartitions(directoryPath);
    if (!partitions) return degraded;
    if (partitions.length === 0) return missing;
    if (partitions.length > MAX_PARTITIONS) return degraded;
    if (partitions.some((partition) => !inspectPartitionEnvelope(partition.path, directory))) return degraded;

    let activity: DaemonActivityRowV1 | null = null;
    let phaseStartedAt: string | null = null;
    let newerObservedAt: string | null = null;
    let remainingRows = MAX_PHASE_SCAN_ROWS;
    let continuityResolved = false;
    for (let partitionIndex = partitions.length - 1; partitionIndex >= 0 && !continuityResolved; partitionIndex--) {
      const partition = partitions[partitionIndex]!;
      const lines = partitionLines(partition.path, directory);
      if (!lines) return degraded;
      for (let rowIndex = lines.length - 1; rowIndex >= 0; rowIndex--) {
        if (remainingRows === 0) {
          // The latest heartbeat remains valid, but claiming a phase start
          // beyond the bounded evidence window would manufacture continuity.
          phaseStartedAt = null;
          continuityResolved = true;
          break;
        }
        let row: DaemonActivityRowV1 | null;
        try {
          row = parseRow(JSON.parse(lines[rowIndex]!));
        } catch {
          return degraded;
        }
        if (!row || (newerObservedAt !== null && row.observedAt > newerObservedAt)) return degraded;
        if (activity === null) activity = row;
        if (row.instanceId !== activity.instanceId || row.phase !== activity.phase) {
          continuityResolved = true;
          break;
        }
        phaseStartedAt = row.observedAt;
        newerObservedAt = row.observedAt;
        remainingRows--;
      }
    }
    if (!activity || !stableDirectory(directoryPath, directory)) return degraded;
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
    const day = observedAt.slice(0, 10);
    lock = acquireLocalStoreLock(join(daemonActivityDirectory(), '.activity.lock'), 2_000);
    if (!lock) return false;
    const directoryAfterLock = lstatSync(daemonActivityDirectory());
    if (!privateDirectory(directoryAfterLock) || !sameNode(directories.directory, directoryAfterLock)) return false;
    if (!recoverActivityTransactions(daemonActivityDirectory(), directories.directory)) return false;
    const partitions = listPartitions(daemonActivityDirectory());
    if (!partitions || partitions.length > MAX_PARTITIONS) return false;

    let prior: Stats | null = null;
    let path: string;
    const latest = partitions.at(-1);
    if (latest) {
      const priorRows = readPartition(latest.path, directories.directory);
      if (!priorRows || priorRows.length === 0) return false;
      if (observedAt < priorRows.at(-1)!.observedAt || day < latest.day) return false;
      prior = lstatSync(latest.path);
      if (!privateFile(prior)) return false;
      const canAppend = day === latest.day && priorRows.length < MAX_ROWS &&
        prior.size + bytes.length <= MAX_PARTITION_BYTES;
      if (canAppend) {
        path = latest.path;
      } else {
        const nextIndex = day === latest.day ? latest.index + 1 : 0;
        if (nextIndex > MAX_SEGMENT_INDEX) return false;
        path = daemonActivitySegmentPath(day, nextIndex);
        prior = null;
      }
    } else {
      path = daemonActivitySegmentPath(day, 0);
    }

    if (prior) {
      fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
    } else {
      return publishStagedPartition(
        path,
        day,
        latest && day === latest.day ? latest.index + 1 : 0,
        bytes,
        daemonActivityDirectory(),
        directories.directory,
      );
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
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    releaseLocalStoreLock(lock);
  }
}
