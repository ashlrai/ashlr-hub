/**
 * Append-only metadata-only daemon activity journal.
 *
 * This source is explicitly observational (`authority: "none"`). It must never
 * authorize dispatch, readiness, learning labels, verification, or merges.
 */

import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fsyncDirectoryProven } from '../util/durability.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';

const MAX_PARTITION_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5_000;
const MAX_ROW_BYTES = 768;
const MAX_PARTITIONS = 8;
const MAX_SEGMENT_INDEX = 9_999;
const MAX_PHASE_SCAN_ROWS = 512;
const MAX_RETIRED_FILES = 1_024;
const MAX_OBSERVATIONAL_PARTITIONS = 32;
const FUTURE_TOLERANCE_MS = 5_000;
export const DAEMON_ACTIVITY_STALE_MS = 90_000;
const ACTIVITY_KEY_NAME = '.activity-auth-key';
const GENESIS_NAME = '.activity-genesis-v1.json';
const CONTINUITY_NAMES = ['.activity-continuity-v1.a.json', '.activity-continuity-v1.b.json'] as const;
const RETENTION_NAME = '.activity-retention-v1.json';
const TRUNCATION_ANCHOR_NAME = '.activity-truncated-v1';
const RETENTION_DOMAIN = 'ashlr:daemon-activity-retention:v1\0';
const GENESIS_DOMAIN = 'ashlr:daemon-activity-genesis:v1\0';
const CONTINUITY_DOMAIN = 'ashlr:daemon-activity-continuity:v1\0';
const PARTITION_CHAIN_DOMAIN = 'ashlr:daemon-activity-partition-chain:v1\0';
const MAX_AUTHORITY_BYTES = 32 * 1024;

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
  sourceState: 'missing' | 'healthy' | 'sampled' | 'degraded';
  complete: boolean;
  ownerHorizonComplete: boolean;
  durability: 'crash-durable' | 'observational';
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
const LEGACY_STAGING_RE = new RegExp(
  `^\\.activity-stage-(\\d{4}-\\d{2}-\\d{2})-(\\d{4})-(${UUID_RE_SOURCE})-([a-f0-9]{64})\\.tmp$`,
  'i',
);
const INTENT_RE = new RegExp(
  `^\\.activity-intent-(\\d{4}-\\d{2}-\\d{2})-(\\d{4})-(${UUID_RE_SOURCE})-([a-f0-9]{64})\\.tmp$`,
  'i',
);
const APPEND_INTENT_RE = new RegExp(
  `^\\.activity-append-(\\d{4}-\\d{2}-\\d{2})-(\\d{4})-(${UUID_RE_SOURCE})-(\\d+)-(\\d+)-([a-f0-9]{64})\\.tmp$`,
  'i',
);
const RETIRED_RE = new RegExp(`^\\.activity-retired-(${UUID_RE_SOURCE})-([a-f0-9]{64})\\.tmp$`, 'i');
const LEGACY_DELETE_RE = new RegExp(`^\\.activity-delete-(${UUID_RE_SOURCE})\\.tmp$`, 'i');

interface ActivityPartition {
  day: string;
  index: number;
  name: string;
  path: string;
}

interface RetentionMarkerV1 {
  schemaVersion: 1;
  authority: 'none';
  truncated: true;
  firstRemovedPartition: string;
  removedThrough: string;
  partitionDigest: string;
  mac: string;
}

interface ActivityGenesisV1 {
  schemaVersion: 1;
  authority: 'none';
  genesisId: string;
  createdAt: string;
  lifetimeComplete: boolean;
  mac: string;
}

interface ActivityPartitionCursorV1 {
  name: string;
  bytes: number;
  rows: number;
  firstObservedAt: string;
  lastObservedAt: string;
  chainDigest: string;
  dev: string;
  ino: string;
  mtimeNs: string;
  ctimeNs: string;
}

interface ActivityContinuityV1 {
  schemaVersion: 1;
  authority: 'none';
  genesisId: string;
  generation: number;
  lifetimeComplete: boolean;
  truncated: boolean;
  partitions: ActivityPartitionCursorV1[];
  pending: ActivityPendingV1 | null;
  mac: string;
}

interface ActivityAppendPendingV1 {
  kind: 'append';
  partition: string;
  preLength: number;
  row: string;
  rowDigest: string;
}

interface ActivityPublishPendingV1 {
  kind: 'publish';
  partition: string;
  row: string;
  rowDigest: string;
  recycle: string | null;
}

type ActivityPendingV1 = ActivityAppendPendingV1 | ActivityPublishPendingV1;

interface ActivityContinuityAuthority {
  key: Buffer;
  genesis: ActivityGenesisV1;
  state: ActivityContinuityV1;
}

interface ScannedPartition {
  rows: DaemonActivityRowV1[];
  cursor: ActivityPartitionCursorV1;
}

const exactDirectoryIdentities = new WeakMap<Stats, { dev: bigint; ino: bigint }>();
const completedContinuityGenerations = new Map<string, { genesisId: string; generation: number }>();

function rememberCompletedContinuity(directory: string, authority: ActivityContinuityAuthority): void {
  if (completedContinuityGenerations.size >= 32 && !completedContinuityGenerations.has(directory)) {
    const oldest = completedContinuityGenerations.keys().next().value as string | undefined;
    if (oldest) completedContinuityGenerations.delete(oldest);
  }
  completedContinuityGenerations.set(directory, {
    genesisId: authority.genesis.genesisId,
    generation: authority.state.generation,
  });
}

export type DaemonActivityNativeMode = 'crash-durable' | 'observational';

/** Windows directory-entry fsync is not portable, so its native mode is observational. */
export function selectDaemonActivityNativeMode(
  platform: NodeJS.Platform = process.platform,
): DaemonActivityNativeMode {
  return platform === 'win32' ? 'observational' : 'crash-durable';
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

function daemonActivityIntentPath(day: string, index: number, bytes: Buffer): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return join(
    daemonActivityDirectory(),
    `.activity-intent-${day}-${String(index).padStart(4, '0')}-${randomUUID()}-${digest}.tmp`,
  );
}

function daemonActivityAppendIntentPath(
  day: string,
  index: number,
  preLength: number,
  bytes: Buffer,
): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return join(
    daemonActivityDirectory(),
    `.activity-append-${day}-${String(index).padStart(4, '0')}-${randomUUID()}-${preLength}-${bytes.length}-${digest}.tmp`,
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
  const exactBefore = lstatSync(path, { bigint: true });
  const after = lstatSync(path);
  const exactAfter = lstatSync(path, { bigint: true });
  if (!privateDirectory(after) || !sameNode(before, after) || !exactBefore.isDirectory() ||
    exactBefore.isSymbolicLink() || exactBefore.dev !== exactAfter.dev || exactBefore.ino !== exactAfter.ino) {
    throw new Error('daemon activity directory changed');
  }
  exactDirectoryIdentities.set(after, { dev: exactAfter.dev, ino: exactAfter.ino });
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
    const expectedIdentity = exactDirectoryIdentities.get(expectedDirectory);
    if (!expectedIdentity) return false;
    const exactBefore = lstatSync(directory, { bigint: true });
    if (!exactBefore.isDirectory() || exactBefore.isSymbolicLink() || exactBefore.dev !== expectedIdentity.dev ||
      exactBefore.ino !== expectedIdentity.ino) {
      return false;
    }
    if (!fsyncDirectoryProven(directory, {
      expectedIdentity,
    })) return false;
    const exactAfter = lstatSync(directory, { bigint: true });
    return exactAfter.isDirectory() && !exactAfter.isSymbolicLink() &&
      exactAfter.dev === exactBefore.dev && exactAfter.ino === exactBefore.ino &&
      stableDirectory(directory, expectedDirectory);
  } catch {
    return false;
  }
}

function readExactPrivateFile(path: string, expectedDirectory: Stats, expectedSize: number): Buffer | null {
  let fd: number | undefined;
  try {
    if (!stableDirectory(daemonActivityDirectory(), expectedDirectory)) return null;
    const named = lstatSync(path);
    if (!privateFile(named) || named.size !== expectedSize) return null;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(named, opened) || opened.size !== expectedSize) return null;
    const bytes = readOpenedBytes(fd, expectedSize);
    const rebound = lstatSync(path);
    return bytes && privateFile(rebound) && sameNode(opened, rebound) ? bytes : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function activityKeyPath(directory: string): string {
  return join(directory, ACTIVITY_KEY_NAME);
}

function readActivityKey(directory: string, expectedDirectory: Stats): Buffer | null {
  const path = activityKeyPath(directory);
  return existsSync(path) ? readExactPrivateFile(path, expectedDirectory, 32) : null;
}

function loadOrCreateActivityKey(directory: string, expectedDirectory: Stats): Buffer | null {
  const existing = readActivityKey(directory, expectedDirectory);
  if (existing) return existing;
  const path = activityKeyPath(directory);
  let fd: number | undefined;
  try {
    if (existsSync(path) || !fsyncStableDirectory(directory, expectedDirectory)) return null;
    const key = randomBytes(32);
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, key) !== key.length) return null;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const created = fstatSync(fd);
    if (!privateFile(created) || created.size !== key.length) return null;
    if (!fsyncStableDirectory(directory, expectedDirectory)) return null;
    const persisted = readExactPrivateFile(path, expectedDirectory, key.length);
    return persisted?.equals(key) ? key : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function genesisPayload(genesis: Omit<ActivityGenesisV1, 'mac'>): string {
  return JSON.stringify([
    GENESIS_DOMAIN,
    genesis.schemaVersion,
    genesis.authority,
    genesis.genesisId,
    genesis.createdAt,
    genesis.lifetimeComplete,
  ]);
}

function continuityPayload(state: Omit<ActivityContinuityV1, 'mac'>): string {
  return JSON.stringify([
    CONTINUITY_DOMAIN,
    state.schemaVersion,
    state.authority,
    state.genesisId,
    state.generation,
    state.lifetimeComplete,
    state.truncated,
    state.partitions.map((partition) => [
      partition.name,
      partition.bytes,
      partition.rows,
      partition.firstObservedAt,
      partition.lastObservedAt,
      partition.chainDigest,
      partition.dev,
      partition.ino,
      partition.mtimeNs,
      partition.ctimeNs,
    ]),
    state.pending === null ? null : state.pending.kind === 'append'
      ? ['append', state.pending.partition, state.pending.preLength, state.pending.row, state.pending.rowDigest]
      : ['publish', state.pending.partition, state.pending.row, state.pending.rowDigest, state.pending.recycle],
  ]);
}

function parseGenesis(value: unknown, key: Buffer): ActivityGenesisV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !==
      'authority,createdAt,genesisId,lifetimeComplete,mac,schemaVersion' ||
    record['schemaVersion'] !== 1 || record['authority'] !== 'none' ||
    typeof record['genesisId'] !== 'string' || !INSTANCE_RE.test(record['genesisId']) ||
    !canonicalTimestamp(record['createdAt']) || typeof record['lifetimeComplete'] !== 'boolean' ||
    typeof record['mac'] !== 'string') return null;
  const unsigned = {
    schemaVersion: 1 as const,
    authority: 'none' as const,
    genesisId: record['genesisId'],
    createdAt: record['createdAt'],
    lifetimeComplete: record['lifetimeComplete'],
  };
  const expected = createHmac('sha256', key).update(genesisPayload(unsigned)).digest('hex');
  return equalMac(record['mac'], expected) ? { ...unsigned, mac: record['mac'] } : null;
}

function validDecimalBigInt(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value);
}

function parsePartitionCursor(value: unknown): ActivityPartitionCursorV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !==
      'bytes,chainDigest,ctimeNs,dev,firstObservedAt,ino,lastObservedAt,mtimeNs,name,rows' ||
    typeof record['name'] !== 'string' || !PARTITION_RE.test(record['name']) ||
    !Number.isSafeInteger(record['bytes']) || (record['bytes'] as number) < 2 ||
    (record['bytes'] as number) > MAX_PARTITION_BYTES ||
    !Number.isSafeInteger(record['rows']) || (record['rows'] as number) < 1 ||
    (record['rows'] as number) > MAX_ROWS ||
    !canonicalTimestamp(record['firstObservedAt']) || !canonicalTimestamp(record['lastObservedAt']) ||
    record['firstObservedAt'] > record['lastObservedAt'] ||
    typeof record['chainDigest'] !== 'string' || !START_REF_RE.test(record['chainDigest']) ||
    !validDecimalBigInt(record['dev']) || !validDecimalBigInt(record['ino']) ||
    !validDecimalBigInt(record['mtimeNs']) || !validDecimalBigInt(record['ctimeNs'])) return null;
  return record as unknown as ActivityPartitionCursorV1;
}

function parseContinuity(value: unknown, key: Buffer, genesisId: string): ActivityContinuityV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !==
      'authority,generation,genesisId,lifetimeComplete,mac,partitions,pending,schemaVersion,truncated' ||
    record['schemaVersion'] !== 1 || record['authority'] !== 'none' || record['genesisId'] !== genesisId ||
    !Number.isSafeInteger(record['generation']) || (record['generation'] as number) < 0 ||
    typeof record['lifetimeComplete'] !== 'boolean' || typeof record['truncated'] !== 'boolean' ||
    !Array.isArray(record['partitions']) || record['partitions'].length > MAX_PARTITIONS ||
    typeof record['mac'] !== 'string') return null;
  const partitions: ActivityPartitionCursorV1[] = [];
  for (const value of record['partitions']) {
    const partition = parsePartitionCursor(value);
    if (!partition) return null;
    partitions.push(partition);
  }
  const names = partitions.map((partition) => partition.name);
  if (new Set(names).size !== names.length) return null;
  let pending: ActivityPendingV1 | null = null;
  if (record['pending'] !== null) {
    if (!record['pending'] || typeof record['pending'] !== 'object' || Array.isArray(record['pending'])) return null;
    const candidate = record['pending'] as Record<string, unknown>;
    if (typeof candidate['partition'] !== 'string' ||
      !PARTITION_RE.test(candidate['partition']) ||
      typeof candidate['row'] !== 'string' || !candidate['row'].endsWith('\n') ||
      Buffer.byteLength(candidate['row'], 'utf8') < 2 || Buffer.byteLength(candidate['row'], 'utf8') > MAX_ROW_BYTES ||
      typeof candidate['rowDigest'] !== 'string' || !START_REF_RE.test(candidate['rowDigest']) ||
      createHash('sha256').update(candidate['row']).digest('hex') !== candidate['rowDigest']) return null;
    try {
      if (!parseRow(JSON.parse(candidate['row'].slice(0, -1)))) return null;
    } catch {
      return null;
    }
    if (candidate['kind'] === 'append') {
      if (Object.keys(candidate).sort().join(',') !== 'kind,partition,preLength,row,rowDigest' ||
        !Number.isSafeInteger(candidate['preLength']) || (candidate['preLength'] as number) < 2 ||
        (candidate['preLength'] as number) > MAX_PARTITION_BYTES) return null;
      pending = candidate as unknown as ActivityAppendPendingV1;
    } else if (candidate['kind'] === 'publish') {
      if (Object.keys(candidate).sort().join(',') !== 'kind,partition,recycle,row,rowDigest' ||
        !(candidate['recycle'] === null ||
          (typeof candidate['recycle'] === 'string' && PARTITION_RE.test(candidate['recycle'])))) return null;
      pending = candidate as unknown as ActivityPublishPendingV1;
    } else {
      return null;
    }
  }
  const unsigned = {
    schemaVersion: 1 as const,
    authority: 'none' as const,
    genesisId,
    generation: record['generation'] as number,
    lifetimeComplete: record['lifetimeComplete'] as boolean,
    truncated: record['truncated'] as boolean,
    partitions,
    pending,
  };
  if ((unsigned.truncated || !unsigned.lifetimeComplete) && unsigned.lifetimeComplete) return null;
  const expected = createHmac('sha256', key).update(continuityPayload(unsigned)).digest('hex');
  return equalMac(record['mac'], expected) ? { ...unsigned, mac: record['mac'] } : null;
}

function readBoundedPrivateJson(path: string, expectedDirectory: Stats): unknown | null {
  try {
    if (!existsSync(path)) return null;
    const named = lstatSync(path);
    if (!privateFile(named) || named.size < 2 || named.size > MAX_AUTHORITY_BYTES) return null;
    const bytes = readExactPrivateFile(path, expectedDirectory, named.size);
    return bytes ? JSON.parse(bytes.toString('utf8')) : null;
  } catch {
    return null;
  }
}

function writePinnedPrivateFile(
  path: string,
  bytes: Buffer,
  directory: string,
  expectedDirectory: Stats,
): boolean {
  let fd: number | undefined;
  try {
    if (bytes.length < 2 || bytes.length > MAX_AUTHORITY_BYTES) return false;
    const replacing = existsSync(path);
    if (replacing ? !stableDirectory(directory, expectedDirectory) :
      !fsyncStableDirectory(directory, expectedDirectory)) return false;
    if (replacing) {
      const named = lstatSync(path);
      if (!privateFile(named) || named.size > MAX_AUTHORITY_BYTES) return false;
      fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      const rebound = lstatSync(path);
      if (!privateFile(opened) || !privateFile(rebound) || !sameNode(named, opened) ||
        !sameNode(opened, rebound)) return false;
      ftruncateSync(fd, 0);
    } else {
      fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW, 0o600);
    }
    if (writeSync(fd, bytes) !== bytes.length) return false;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    if (!privateFile(persisted) || persisted.size !== bytes.length) return false;
    if (replacing ? !stableDirectory(directory, expectedDirectory) :
      !fsyncStableDirectory(directory, expectedDirectory)) return false;
    const observed = readExactPrivateFile(path, expectedDirectory, bytes.length);
    return observed?.equals(bytes) === true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function writeGenesis(
  directory: string,
  expectedDirectory: Stats,
  key: Buffer,
  createdAt: string,
  lifetimeComplete: boolean,
): ActivityGenesisV1 | null {
  const unsigned = {
    schemaVersion: 1 as const,
    authority: 'none' as const,
    genesisId: randomUUID(),
    createdAt,
    lifetimeComplete,
  };
  const genesis = {
    ...unsigned,
    mac: createHmac('sha256', key).update(genesisPayload(unsigned)).digest('hex'),
  };
  const bytes = Buffer.from(`${JSON.stringify(genesis)}\n`, 'utf8');
  return writePinnedPrivateFile(join(directory, GENESIS_NAME), bytes, directory, expectedDirectory)
    ? genesis
    : null;
}

function readGenesis(directory: string, expectedDirectory: Stats, key: Buffer): ActivityGenesisV1 | null {
  return parseGenesis(readBoundedPrivateJson(join(directory, GENESIS_NAME), expectedDirectory), key);
}

function readContinuity(
  directory: string,
  expectedDirectory: Stats,
  key: Buffer,
  genesis: ActivityGenesisV1,
): ActivityContinuityV1 | null {
  const states = CONTINUITY_NAMES.map((name) =>
    parseContinuity(readBoundedPrivateJson(join(directory, name), expectedDirectory), key, genesis.genesisId))
    .filter((state): state is ActivityContinuityV1 => state !== null)
    .sort((left, right) => right.generation - left.generation);
  return states[0] ?? null;
}

function writeContinuity(
  directory: string,
  expectedDirectory: Stats,
  authority: ActivityContinuityAuthority,
  update: Omit<ActivityContinuityV1, 'schemaVersion' | 'authority' | 'genesisId' | 'generation' | 'mac'>,
): ActivityContinuityAuthority | null {
  const prior = authority.state;
  const lifetimeComplete = prior.lifetimeComplete && authority.genesis.lifetimeComplete &&
    update.lifetimeComplete && !update.truncated;
  const unsigned = {
    schemaVersion: 1 as const,
    authority: 'none' as const,
    genesisId: authority.genesis.genesisId,
    generation: prior.generation + 1,
    lifetimeComplete,
    truncated: prior.truncated || update.truncated || !lifetimeComplete,
    partitions: update.partitions,
    pending: update.pending,
  };
  const state: ActivityContinuityV1 = {
    ...unsigned,
    mac: createHmac('sha256', authority.key).update(continuityPayload(unsigned)).digest('hex'),
  };
  const name = CONTINUITY_NAMES[state.generation % CONTINUITY_NAMES.length]!;
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
  return writePinnedPrivateFile(join(directory, name), bytes, directory, expectedDirectory)
    ? { ...authority, state }
    : null;
}

function initialPartitionChain(bytes: Buffer): string {
  return createHash('sha256').update(PARTITION_CHAIN_DOMAIN).update(bytes).digest('hex');
}

function extendPartitionChain(prior: string, bytes: Buffer): string {
  return createHash('sha256').update(PARTITION_CHAIN_DOMAIN).update(prior).update(bytes).digest('hex');
}

function exactPartitionIdentity(path: string): {
  dev: string;
  ino: string;
  mtimeNs: string;
  ctimeNs: string;
} | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
      (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) ||
      (process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n)) return null;
    return {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    };
  } catch {
    return null;
  }
}

function scanPartition(
  partition: ActivityPartition,
  expectedDirectory: Stats,
): ScannedPartition | null {
  const bytes = readPartitionBytes(partition.path, expectedDirectory);
  if (!bytes) return null;
  const raw = bytes.toString('utf8');
  if (!raw.endsWith('\n')) return null;
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.length > MAX_ROWS) return null;
  const rows: DaemonActivityRowV1[] = [];
  let chainDigest = '';
  for (const line of lines) {
    if (!line || Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) return null;
    let row: DaemonActivityRowV1 | null;
    try {
      row = parseRow(JSON.parse(line));
    } catch {
      return null;
    }
    const prior = rows.at(-1);
    if (!row || row.observedAt.slice(0, 10) !== partition.day ||
      (prior && row.observedAt < prior.observedAt)) return null;
    rows.push(row);
    const rowBytes = Buffer.from(`${line}\n`, 'utf8');
    chainDigest = chainDigest ? extendPartitionChain(chainDigest, rowBytes) : initialPartitionChain(rowBytes);
  }
  const identity = exactPartitionIdentity(partition.path);
  if (!identity) return null;
  return {
    rows,
    cursor: {
      name: partition.name,
      bytes: bytes.length,
      rows: rows.length,
      firstObservedAt: rows[0]!.observedAt,
      lastObservedAt: rows.at(-1)!.observedAt,
      chainDigest,
      ...identity,
    },
  };
}

function scanPartitions(
  partitions: ActivityPartition[],
  expectedDirectory: Stats,
): ScannedPartition[] | null {
  const scanned: ScannedPartition[] = [];
  let priorObservedAt: string | null = null;
  for (const partition of partitions) {
    const current = scanPartition(partition, expectedDirectory);
    if (!current || (priorObservedAt !== null && current.rows[0]!.observedAt < priorObservedAt)) return null;
    priorObservedAt = current.rows.at(-1)!.observedAt;
    scanned.push(current);
  }
  return scanned;
}

function cursorEquals(left: ActivityPartitionCursorV1, right: ActivityPartitionCursorV1): boolean {
  return left.name === right.name && left.bytes === right.bytes && left.rows === right.rows &&
    left.firstObservedAt === right.firstObservedAt && left.lastObservedAt === right.lastObservedAt &&
    left.chainDigest === right.chainDigest && left.dev === right.dev && left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function projectCompletedPending(
  state: ActivityContinuityV1,
  scanned: ScannedPartition[],
): ActivityContinuityV1 | null {
  const pending = state.pending;
  if (!pending) return state;
  const current = scanned.map((partition) => partition.cursor);
  if (pending.kind === 'append') {
    const prior = state.partitions.at(-1);
    const observed = current.at(-1);
    let row: DaemonActivityRowV1 | null;
    try {
      row = parseRow(JSON.parse(pending.row.slice(0, -1)));
    } catch {
      return null;
    }
    if (!prior || !observed || !row || prior.name !== pending.partition || observed.name !== pending.partition ||
      state.partitions.length !== current.length || prior.bytes !== pending.preLength ||
      !state.partitions.slice(0, -1).every((cursor, index) => cursorEquals(cursor, current[index]!))) return null;
    const rowBytes = Buffer.from(pending.row, 'utf8');
    const expected = {
      ...prior,
      bytes: prior.bytes + rowBytes.length,
      rows: prior.rows + 1,
      lastObservedAt: row.observedAt,
      chainDigest: extendPartitionChain(prior.chainDigest, rowBytes),
      dev: observed.dev,
      ino: observed.ino,
      mtimeNs: observed.mtimeNs,
      ctimeNs: observed.ctimeNs,
    };
    if (!cursorEquals(expected, observed)) return null;
  } else {
    let row: DaemonActivityRowV1 | null;
    try {
      row = parseRow(JSON.parse(pending.row.slice(0, -1)));
    } catch {
      return null;
    }
    const target = current.find((cursor) => cursor.name === pending.partition);
    const retained = state.partitions.filter((cursor) => cursor.name !== pending.recycle);
    if (!row || !target || target.rows !== 1 || target.bytes !== Buffer.byteLength(pending.row, 'utf8') ||
      target.firstObservedAt !== row.observedAt || target.lastObservedAt !== row.observedAt ||
      target.chainDigest !== initialPartitionChain(Buffer.from(pending.row, 'utf8')) ||
      current.length !== retained.length + 1 ||
      !retained.every((cursor) => current.some((candidate) => cursorEquals(cursor, candidate)))) return null;
  }
  return { ...state, partitions: current, pending: null };
}

function continuityFastMatches(
  state: ActivityContinuityV1,
  partitions: ActivityPartition[],
): boolean {
  if (state.partitions.length !== partitions.length) return false;
  return partitions.every((partition, index) => {
    const cursor = state.partitions[index];
    const identity = exactPartitionIdentity(partition.path);
    if (!cursor || !identity || cursor.name !== partition.name) return false;
    let size: number;
    try {
      size = lstatSync(partition.path).size;
    } catch {
      return false;
    }
    return cursor.bytes === size && cursor.dev === identity.dev && cursor.ino === identity.ino &&
      cursor.mtimeNs === identity.mtimeNs && cursor.ctimeNs === identity.ctimeNs;
  });
}

function loadOrAdoptContinuity(
  directory: string,
  expectedDirectory: Stats,
  partitions: ActivityPartition[],
  createdAt: string,
): ActivityContinuityAuthority | null {
  const key = loadOrCreateActivityKey(directory, expectedDirectory);
  if (!key) return null;
  let genesis = readGenesis(directory, expectedDirectory, key);
  if (!genesis) {
    genesis = writeGenesis(directory, expectedDirectory, key, createdAt, partitions.length === 0);
    if (!genesis) return null;
  }
  const existing = readContinuity(directory, expectedDirectory, key, genesis);
  if (existing) return { key, genesis, state: existing };
  const scanned = scanPartitions(partitions, expectedDirectory);
  if (!scanned) return null;
  const seed: ActivityContinuityAuthority = {
    key,
    genesis,
    state: {
      schemaVersion: 1,
      authority: 'none',
      genesisId: genesis.genesisId,
      generation: 0,
      lifetimeComplete: genesis.lifetimeComplete && partitions.length === 0,
      truncated: !genesis.lifetimeComplete || partitions.length > 0,
      partitions: [],
      pending: null,
      mac: '',
    },
  };
  return writeContinuity(directory, expectedDirectory, seed, {
    lifetimeComplete: seed.state.lifetimeComplete,
    truncated: seed.state.truncated,
    partitions: scanned.map((partition) => partition.cursor),
    pending: null,
  });
}

function partitionPrefixMatchesCursor(
  bytes: Buffer,
  partition: ActivityPartition,
  cursor: ActivityPartitionCursorV1,
): boolean {
  try {
    if (bytes.length !== cursor.bytes || !bytes.toString('utf8').endsWith('\n')) return false;
    const lines = bytes.toString('utf8').slice(0, -1).split('\n');
    if (lines.length !== cursor.rows) return false;
    let chainDigest = '';
    let firstObservedAt: string | null = null;
    let lastObservedAt: string | null = null;
    for (const line of lines) {
      const row = parseRow(JSON.parse(line));
      if (!row || row.observedAt.slice(0, 10) !== partition.day ||
        (lastObservedAt !== null && row.observedAt < lastObservedAt)) return false;
      firstObservedAt ??= row.observedAt;
      lastObservedAt = row.observedAt;
      const rowBytes = Buffer.from(`${line}\n`, 'utf8');
      chainDigest = chainDigest ? extendPartitionChain(chainDigest, rowBytes) : initialPartitionChain(rowBytes);
    }
    return firstObservedAt === cursor.firstObservedAt && lastObservedAt === cursor.lastObservedAt &&
      chainDigest === cursor.chainDigest;
  } catch {
    return false;
  }
}

function recoverContinuityAppend(
  authority: ActivityContinuityAuthority,
  partitions: ActivityPartition[],
  trustedCompleted: boolean,
): ActivityContinuityAuthority | null {
  const pending = authority.state.pending;
  if (!pending) return authority;
  if (pending.kind !== 'append') return null;
  const target = partitions.find((partition) => partition.name === pending.partition);
  const priorCursor = authority.state.partitions.find((partition) => partition.name === pending.partition);
  if (!target || !priorCursor || priorCursor.bytes !== pending.preLength ||
    authority.state.partitions.at(-1)?.name !== pending.partition) return null;
  if (!authority.state.partitions.slice(0, -1).every((cursor, index) => {
    const partition = partitions[index];
    const identity = partition ? exactPartitionIdentity(partition.path) : null;
    if (!partition || !identity || partition.name !== cursor.name) return false;
    return cursor.dev === identity.dev && cursor.ino === identity.ino &&
      cursor.mtimeNs === identity.mtimeNs && cursor.ctimeNs === identity.ctimeNs &&
      lstatSync(partition.path).size === cursor.bytes;
  })) return null;
  const rowBytes = Buffer.from(pending.row, 'utf8');
  let fd: number | undefined;
  try {
    const named = lstatSync(target.path);
    if (!privateFile(named) || named.size < pending.preLength ||
      named.size > pending.preLength + rowBytes.length) return null;
    const identity = exactPartitionIdentity(target.path);
    if (!identity || identity.dev !== priorCursor.dev || identity.ino !== priorCursor.ino) return null;
    fd = openSync(target.path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(named, opened) || opened.size !== named.size) return null;
    const trailingLength = opened.size - pending.preLength;
    if (trailingLength > 0) {
      const trailing = Buffer.alloc(trailingLength);
      if (readSync(fd, trailing, 0, trailing.length, pending.preLength) !== trailing.length ||
        !rowBytes.subarray(0, trailing.length).equals(trailing)) return null;
    }
    if (trailingLength !== rowBytes.length || !trustedCompleted) {
      const prefix = readOpenedBytes(fd, pending.preLength);
      if (!prefix || !partitionPrefixMatchesCursor(prefix, target, priorCursor)) return null;
      if (trailingLength !== rowBytes.length) {
        ftruncateSync(fd, pending.preLength);
        if (writeSync(fd, rowBytes, 0, rowBytes.length, pending.preLength) !== rowBytes.length) return null;
      }
      fsyncSync(fd);
    }
    const persisted = fstatSync(fd);
    if (!privateFile(persisted) || !sameNode(opened, persisted) ||
      persisted.size !== pending.preLength + rowBytes.length) return null;
    closeSync(fd);
    fd = undefined;
    const finalIdentity = exactPartitionIdentity(target.path);
    if (!finalIdentity) return null;
    const row = parseRow(JSON.parse(pending.row.slice(0, -1)));
    if (!row || row.observedAt < priorCursor.lastObservedAt || row.observedAt.slice(0, 10) !== target.day) return null;
    const updated: ActivityPartitionCursorV1 = {
      ...priorCursor,
      bytes: pending.preLength + rowBytes.length,
      rows: priorCursor.rows + 1,
      lastObservedAt: row.observedAt,
      chainDigest: extendPartitionChain(priorCursor.chainDigest, rowBytes),
      ...finalIdentity,
    };
    return {
      ...authority,
      state: {
        ...authority.state,
        partitions: [...authority.state.partitions.slice(0, -1), updated],
        pending: null,
      },
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function materializePendingPublish(
  directory: string,
  expectedDirectory: Stats,
  authority: ActivityContinuityAuthority,
  pending: ActivityPublishPendingV1,
  forceFsync = false,
): boolean {
  const targetPath = join(directory, pending.partition);
  const rowBytes = Buffer.from(pending.row, 'utf8');
  const recycledCursor = pending.recycle === null
    ? null
    : authority.state.partitions.find((partition) => partition.name === pending.recycle) ?? null;
  const recycledPath = pending.recycle === null ? null : join(directory, pending.recycle);
  let fd: number | undefined;
  let namespaceChanged = false;
  let namespaceSynced = false;
  let contentChanged = false;
  try {
    if (!stableDirectory(directory, expectedDirectory)) return false;
    if (recycledCursor) {
      if (existsSync(targetPath)) {
        if (existsSync(recycledPath!)) return false;
        const identity = exactPartitionIdentity(targetPath);
        if (!identity || identity.dev !== recycledCursor.dev || identity.ino !== recycledCursor.ino) return false;
      } else {
        if (!existsSync(recycledPath!)) return false;
        const identity = exactPartitionIdentity(recycledPath!);
        if (!identity || identity.dev !== recycledCursor.dev || identity.ino !== recycledCursor.ino) return false;
        renameSync(recycledPath!, targetPath);
        if (!fsyncStableDirectory(directory, expectedDirectory)) return false;
        namespaceChanged = true;
        namespaceSynced = true;
      }
    } else if (!existsSync(targetPath)) {
      fd = openSync(targetPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW, 0o600);
      namespaceChanged = true;
    }

    if (fd === undefined) fd = openSync(targetPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const rebound = lstatSync(targetPath);
    if (!privateFile(opened) || !privateFile(rebound) || !sameNode(opened, rebound) ||
      opened.size > MAX_PARTITION_BYTES) return false;
    const existing = readOpenedBytes(fd, opened.size);
    if (!existing) return false;
    if (!existing.equals(rowBytes)) {
      if (existing.length > rowBytes.length || !rowBytes.subarray(0, existing.length).equals(existing)) {
        if (!recycledCursor) return false;
      }
      ftruncateSync(fd, 0);
      if (writeSync(fd, rowBytes, 0, rowBytes.length, 0) !== rowBytes.length) return false;
      contentChanged = true;
    }
    if (contentChanged || namespaceChanged || forceFsync) {
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    }
    const persisted = fstatSync(fd);
    if (!privateFile(persisted) || !sameNode(opened, persisted) || persisted.size !== rowBytes.length) return false;
    closeSync(fd);
    fd = undefined;
    const observed = readPartitionBytes(targetPath, expectedDirectory);
    if (!observed?.equals(rowBytes)) return false;
    return namespaceChanged && !namespaceSynced
      ? fsyncStableDirectory(directory, expectedDirectory)
      : stableDirectory(directory, expectedDirectory);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function recoverContinuityPending(
  directory: string,
  expectedDirectory: Stats,
  authority: ActivityContinuityAuthority,
  partitions: ActivityPartition[],
  trustedCompleted: boolean,
): ActivityContinuityAuthority | null {
  const pending = authority.state.pending;
  if (!pending) return authority;
  if (pending.kind === 'append') {
    return recoverContinuityAppend(authority, partitions, trustedCompleted);
  }
  if (!materializePendingPublish(
    directory, expectedDirectory, authority, pending, !trustedCompleted,
  )) return null;
  const published = listPartitions(directory);
  if (!published || published.length > MAX_PARTITIONS) return null;
  const scanned = scanPartitions(published, expectedDirectory);
  if (!scanned) return null;
  return {
    ...authority,
    state: {
      ...authority.state,
      partitions: scanned.map((partition) => partition.cursor),
      pending: null,
    },
  };
}

function retentionPayload(marker: Omit<RetentionMarkerV1, 'mac'>): string {
  return JSON.stringify([
    RETENTION_DOMAIN,
    marker.schemaVersion,
    marker.authority,
    marker.truncated,
    marker.firstRemovedPartition,
    marker.removedThrough,
    marker.partitionDigest,
  ]);
}

function equalMac(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function parseRetentionMarker(value: unknown, key: Buffer): RetentionMarkerV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  if (keys.join(',') !== 'authority,firstRemovedPartition,mac,partitionDigest,removedThrough,schemaVersion,truncated' ||
    marker['schemaVersion'] !== 1 || marker['authority'] !== 'none' || marker['truncated'] !== true ||
    typeof marker['firstRemovedPartition'] !== 'string' || !PARTITION_RE.test(marker['firstRemovedPartition']) ||
    !canonicalTimestamp(marker['removedThrough']) ||
    typeof marker['partitionDigest'] !== 'string' || !START_REF_RE.test(marker['partitionDigest']) ||
    typeof marker['mac'] !== 'string') return null;
  const unsigned = {
    schemaVersion: 1 as const,
    authority: 'none' as const,
    truncated: true as const,
    firstRemovedPartition: marker['firstRemovedPartition'],
    removedThrough: marker['removedThrough'],
    partitionDigest: marker['partitionDigest'],
  };
  const expected = createHmac('sha256', key).update(retentionPayload(unsigned)).digest('hex');
  return equalMac(marker['mac'], expected) ? { ...unsigned, mac: marker['mac'] } : null;
}

function readRetentionMarker(
  directory: string,
  expectedDirectory: Stats,
): { state: 'absent' | 'valid' | 'invalid'; marker: RetentionMarkerV1 | null } {
  const path = join(directory, RETENTION_NAME);
  if (!existsSync(path)) return { state: 'absent', marker: null };
  const key = readActivityKey(directory, expectedDirectory);
  if (!key) return { state: 'invalid', marker: null };
  try {
    const named = lstatSync(path);
    if (!privateFile(named) || named.size < 2 || named.size > 1_024) return { state: 'invalid', marker: null };
    const bytes = readExactPrivateFile(path, expectedDirectory, named.size);
    const marker = bytes ? parseRetentionMarker(JSON.parse(bytes.toString('utf8')), key) : null;
    return marker ? { state: 'valid', marker } : { state: 'invalid', marker: null };
  } catch {
    return { state: 'invalid', marker: null };
  }
}

function readTruncationAnchor(
  directory: string,
  expectedDirectory: Stats,
): 'absent' | 'valid' | 'invalid' {
  const path = join(directory, TRUNCATION_ANCHOR_NAME);
  if (!existsSync(path)) return 'absent';
  try {
    if (!stableDirectory(directory, expectedDirectory)) return 'invalid';
    const marker = lstatSync(path);
    return privateFile(marker) && marker.size === 0 ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

function ensureTruncationAnchor(directory: string, expectedDirectory: Stats): boolean {
  const existing = readTruncationAnchor(directory, expectedDirectory);
  if (existing === 'valid') return true;
  if (existing === 'invalid') return false;
  const path = join(directory, TRUNCATION_ANCHOR_NAME);
  let fd: number | undefined;
  try {
    if (!fsyncStableDirectory(directory, expectedDirectory) || existsSync(path)) return false;
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const marker = fstatSync(fd);
    if (!privateFile(marker) || marker.size !== 0 || !fsyncStableDirectory(directory, expectedDirectory)) {
      return false;
    }
    return readTruncationAnchor(directory, expectedDirectory) === 'valid';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function readOpenedBytes(fd: number, size: number): Buffer | null {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) return null;
    offset += count;
  }
  return bytes;
}

function finishRetiredFile(
  path: string,
  directory: string,
  expectedDirectory: Stats,
  expectedDigest?: string,
): boolean {
  let fd: number | undefined;
  try {
    if (!stableDirectory(directory, expectedDirectory)) return false;
    const named = lstatSync(path);
    if (!privateFileWithLinks(named, [1, 2]) || named.size > MAX_PARTITION_BYTES) return false;
    fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!privateFileWithLinks(opened, [1, 2]) || !privateFileWithLinks(rebound, [1, 2]) ||
      !sameNode(named, opened) || !sameNode(opened, rebound)) return false;
    if (opened.size > 0) {
      const bytes = readOpenedBytes(fd, opened.size);
      if (!bytes || (expectedDigest && createHash('sha256').update(bytes).digest('hex') !== expectedDigest)) {
        return false;
      }
      ftruncateSync(fd, 0);
      fsyncSync(fd);
    }
    const retired = fstatSync(fd);
    const finalPath = lstatSync(path);
    return privateFileWithLinks(retired, [1, 2]) && privateFileWithLinks(finalPath, [1, 2]) &&
      sameNode(opened, retired) && sameNode(retired, finalPath) && retired.size === 0 &&
      stableDirectory(directory, expectedDirectory);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

/**
 * Retire only the inode already opened and verified by this process. The public
 * pathname is renamed to an unpredictable marker, the rename is proven durable,
 * and content is erased through the pinned descriptor. Markers stay zero-byte:
 * portable Node has no compare-and-unlink primitive that is safe from a same-UID
 * pathname swap after validation.
 */
function retireVerifiedFile(
  path: string,
  directory: string,
  expectedDirectory: Stats,
  allowedLinks: readonly number[] = [1],
): boolean {
  let fd: number | undefined;
  try {
    // Probe directory-entry durability before changing the namespace. Windows
    // filesystems that cannot prove it fail without pruning anything.
    if (!fsyncStableDirectory(directory, expectedDirectory)) return false;
    const named = lstatSync(path);
    if (!privateFileWithLinks(named, allowedLinks) || named.size > MAX_PARTITION_BYTES) return false;
    fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!privateFileWithLinks(opened, allowedLinks) || !privateFileWithLinks(rebound, allowedLinks) ||
      !sameNode(named, opened) ||
      !sameNode(opened, rebound)) return false;
    const bytes = readOpenedBytes(fd, opened.size);
    if (!bytes) return false;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const retiredPath = join(directory, `.activity-retired-${randomUUID()}-${digest}.tmp`);
    if (existsSync(retiredPath) || !stableDirectory(directory, expectedDirectory)) return false;
    renameSync(path, retiredPath);
    if (!fsyncStableDirectory(directory, expectedDirectory)) return false;
    const moved = lstatSync(retiredPath);
    const pinned = fstatSync(fd);
    if (!privateFileWithLinks(moved, allowedLinks) || !privateFileWithLinks(pinned, allowedLinks) ||
      !sameNode(opened, moved) ||
      !sameNode(moved, pinned)) return false;
    ftruncateSync(fd, 0);
    fsyncSync(fd);
    const erased = fstatSync(fd);
    const finalPath = lstatSync(retiredPath);
    return privateFileWithLinks(erased, allowedLinks) && privateFileWithLinks(finalPath, allowedLinks) &&
      sameNode(opened, erased) &&
      sameNode(erased, finalPath) && erased.size === 0 && stableDirectory(directory, expectedDirectory);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function retiredMarkerCount(directory: string): number | null {
  try {
    return readdirSync(directory).filter((name) => RETIRED_RE.test(name) || LEGACY_DELETE_RE.test(name)).length;
  } catch {
    return null;
  }
}

function reuseRetiredMarker(
  intentPath: string,
  directory: string,
  expectedDirectory: Stats,
  directoryDurable: boolean,
): 'reused' | 'absent' | 'invalid' {
  let fd: number | undefined;
  try {
    const reusableNames = readdirSync(directory).filter((name) => RETIRED_RE.test(name)).sort();
    const reusableName = reusableNames.find((name) => {
      try {
        const candidate = lstatSync(join(directory, name));
        return privateFile(candidate) && candidate.size === 0;
      } catch {
        return false;
      }
    });
    if (!reusableName) return 'absent';
    const reusablePath = join(directory, reusableName);
    const named = lstatSync(reusablePath);
    if (!privateFile(named) || named.size !== 0 || existsSync(intentPath) ||
      !stableDirectory(directory, expectedDirectory)) return 'invalid';
    fd = openSync(reusablePath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const rebound = lstatSync(reusablePath);
    if (!privateFile(opened) || !privateFile(rebound) || !sameNode(named, opened) ||
      !sameNode(opened, rebound)) return 'invalid';
    renameSync(reusablePath, intentPath);
    if (directoryDurable && !fsyncStableDirectory(directory, expectedDirectory)) return 'invalid';
    const moved = lstatSync(intentPath);
    return privateFile(moved) && sameNode(opened, moved) && moved.size === 0 &&
      stableDirectory(directory, expectedDirectory) ? 'reused' : 'invalid';
  } catch {
    return 'invalid';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function hasRetiredTwin(directory: string, expected: Stats): boolean {
  try {
    return readdirSync(directory).some((name) => {
      if (!RETIRED_RE.test(name)) return false;
      try {
        const candidate = lstatSync(join(directory, name));
        return candidate.size === 0 && privateFileWithLinks(candidate, [2]) && sameNode(candidate, expected);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function createIntentMarker(
  intentPath: string,
  directory: string,
  expectedDirectory: Stats,
): boolean {
  let fd: number | undefined;
  try {
    if (!fsyncStableDirectory(directory, expectedDirectory) || existsSync(intentPath)) return false;
    const reused = reuseRetiredMarker(intentPath, directory, expectedDirectory, true);
    if (reused !== 'absent') return reused === 'reused';
    const retired = retiredMarkerCount(directory);
    if (retired === null || retired >= MAX_RETIRED_FILES) return false;
    fd = openSync(
      intentPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!privateFile(opened) || opened.size !== 0) return false;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    return fsyncStableDirectory(directory, expectedDirectory);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function createAppendIntentMarker(
  intentPath: string,
  directory: string,
  expectedDirectory: Stats,
  directoryDurable: boolean,
): boolean {
  let fd: number | undefined;
  try {
    if ((directoryDurable && !fsyncStableDirectory(directory, expectedDirectory)) || existsSync(intentPath) ||
      !stableDirectory(directory, expectedDirectory)) return false;
    const reused = reuseRetiredMarker(intentPath, directory, expectedDirectory, directoryDurable);
    if (reused !== 'absent') return reused === 'reused';
    const retired = retiredMarkerCount(directory);
    if (retired === null || retired >= MAX_RETIRED_FILES) return false;
    fd = openSync(intentPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const marker = fstatSync(fd);
    return privateFile(marker) && marker.size === 0 &&
      (!directoryDurable || fsyncStableDirectory(directory, expectedDirectory));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function ensureRetentionMarker(
  directory: string,
  expectedDirectory: Stats,
  dropping: ActivityPartition,
): boolean {
  const existing = readRetentionMarker(directory, expectedDirectory);
  if (existing.state === 'valid') return ensureTruncationAnchor(directory, expectedDirectory);
  const bytes = readPartitionBytes(dropping.path, expectedDirectory);
  const rows = readPartition(dropping.path, expectedDirectory);
  const key = loadOrCreateActivityKey(directory, expectedDirectory);
  if (!bytes || !rows || rows.length === 0 || !key ||
    !ensureTruncationAnchor(directory, expectedDirectory)) return false;
  const unsigned = {
    schemaVersion: 1 as const,
    authority: 'none' as const,
    truncated: true as const,
    firstRemovedPartition: dropping.name,
    removedThrough: rows.at(-1)!.observedAt,
    partitionDigest: createHash('sha256').update(bytes).digest('hex'),
  };
  const marker: RetentionMarkerV1 = {
    ...unsigned,
    mac: createHmac('sha256', key).update(retentionPayload(unsigned)).digest('hex'),
  };
  const markerBytes = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
  const path = join(directory, RETENTION_NAME);
  let fd: number | undefined;
  try {
    if (!fsyncStableDirectory(directory, expectedDirectory)) return false;
    if (existing.state === 'invalid') {
      const named = lstatSync(path);
      if (!privateFile(named) || named.size > 1_024) return false;
      fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      const rebound = lstatSync(path);
      if (!privateFile(opened) || !privateFile(rebound) || !sameNode(named, opened) ||
        !sameNode(opened, rebound)) return false;
      ftruncateSync(fd, 0);
    } else {
      if (existsSync(path)) return false;
      fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW, 0o600);
    }
    if (writeSync(fd, markerBytes) !== markerBytes.length) return false;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || opened.size !== markerBytes.length) return false;
    if (!fsyncStableDirectory(directory, expectedDirectory)) return false;
    return readRetentionMarker(directory, expectedDirectory).state === 'valid';
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
    if (dropping.length > 0 && !ensureRetentionMarker(directory, expectedDirectory, dropping[0]!)) return false;
    for (const partition of dropping) {
      const retired = retiredMarkerCount(directory);
      // Reserve one marker for retiring the active intent after pruning.
      if (retired === null || retired >= MAX_RETIRED_FILES - 1 ||
        !retireVerifiedFile(partition.path, directory, expectedDirectory)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function recoverAppendIntent(
  name: string,
  directory: string,
  expectedDirectory: Stats,
  directoryDurable: boolean,
): boolean {
  const match = APPEND_INTENT_RE.exec(name);
  if (!match) return false;
  const day = match[1]!;
  const index = Number(match[2]);
  const preLength = Number(match[4]);
  const rowLength = Number(match[5]);
  const expectedDigest = match[6]!;
  if (!canonicalDay(day) || !Number.isSafeInteger(index) || index < 0 || index > MAX_SEGMENT_INDEX ||
    !Number.isSafeInteger(preLength) || preLength < 2 || preLength > MAX_PARTITION_BYTES ||
    !Number.isSafeInteger(rowLength) || rowLength < 2 || rowLength > MAX_ROW_BYTES) return false;
  const intentPath = join(directory, name);
  const intent = lstatSync(intentPath);
  if (!privateFile(intent) || intent.size !== 0) return false;
  const targetPath = daemonActivitySegmentPath(day, index);
  if (!existsSync(targetPath)) return false;
  let fd: number | undefined;
  try {
    const named = lstatSync(targetPath);
    if (!privateFile(named) || named.size < preLength || named.size > preLength + rowLength) return false;
    fd = openSync(targetPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(named, opened) || opened.size !== named.size) return false;
    const prefix = readOpenedBytes(fd, preLength);
    if (!prefix || !prefix.toString('utf8').endsWith('\n')) return false;
    const prefixLines = prefix.toString('utf8').slice(0, -1).split('\n');
    let priorObservedAt: string | null = null;
    for (const line of prefixLines) {
      const row = parseRow(JSON.parse(line));
      if (!row || row.observedAt.slice(0, 10) !== day ||
        (priorObservedAt !== null && row.observedAt < priorObservedAt)) return false;
      priorObservedAt = row.observedAt;
    }
    if (opened.size === preLength + rowLength) {
      const appended = Buffer.alloc(rowLength);
      if (readSync(fd, appended, 0, rowLength, preLength) !== rowLength ||
        createHash('sha256').update(appended).digest('hex') !== expectedDigest) return false;
      const raw = appended.toString('utf8');
      const appendedRow = raw.endsWith('\n') ? parseRow(JSON.parse(raw.slice(0, -1))) : null;
      if (!appendedRow || appendedRow.observedAt.slice(0, 10) !== day ||
        (priorObservedAt !== null && appendedRow.observedAt < priorObservedAt)) return false;
    } else {
      // The durable intent proves all bytes after preLength belong to one torn append.
      ftruncateSync(fd, preLength);
      fsyncSync(fd);
      const repaired = fstatSync(fd);
      if (!privateFile(repaired) || !sameNode(opened, repaired) || repaired.size !== preLength) return false;
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
  if (directoryDurable) return retireVerifiedFile(intentPath, directory, expectedDirectory);
  try {
    const named = lstatSync(intentPath);
    if (!privateFile(named) || named.size !== 0 || !stableDirectory(directory, expectedDirectory)) return false;
    const retiredPath = join(directory, `.activity-retired-${randomUUID()}-${createHash('sha256').digest('hex')}.tmp`);
    renameSync(intentPath, retiredPath);
    const moved = lstatSync(retiredPath);
    return privateFile(moved) && sameNode(named, moved) && moved.size === 0;
  } catch {
    return false;
  }
}

function recoverObservationalTrailingAppend(
  directory: string,
  expectedDirectory: Stats,
): boolean {
  const partitions = listPartitions(directory);
  const latest = partitions?.at(-1);
  if (!partitions || !latest) return partitions !== null;
  if (readPartition(latest.path, expectedDirectory)) return true;
  let fd: number | undefined;
  try {
    const named = lstatSync(latest.path);
    if (!privateFile(named) || named.size > MAX_PARTITION_BYTES) return false;
    fd = openSync(latest.path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(named, opened) || opened.size !== named.size) return false;
    const bytes = readOpenedBytes(fd, opened.size);
    if (!bytes || bytes.at(-1) === 0x0a) return false;
    const finalNewline = bytes.lastIndexOf(0x0a);
    if (finalNewline < 1) {
      const digest = createHash('sha256').update(bytes).digest('hex');
      const retiredPath = join(directory, `.activity-retired-${randomUUID()}-${digest}.tmp`);
      if (existsSync(retiredPath) || !stableDirectory(directory, expectedDirectory)) return false;
      renameSync(latest.path, retiredPath);
      const moved = lstatSync(retiredPath);
      const pinned = fstatSync(fd);
      if (!privateFile(moved) || !privateFile(pinned) || !sameNode(opened, moved) ||
        !sameNode(moved, pinned)) return false;
      ftruncateSync(fd, 0);
      fsyncSync(fd);
      const erased = fstatSync(fd);
      const finalPath = lstatSync(retiredPath);
      return privateFile(erased) && privateFile(finalPath) && sameNode(opened, erased) &&
        sameNode(erased, finalPath) && erased.size === 0 && stableDirectory(directory, expectedDirectory);
    }
    const prefix = bytes.subarray(0, finalNewline + 1).toString('utf8');
    let priorObservedAt: string | null = null;
    for (const line of prefix.slice(0, -1).split('\n')) {
      const row = parseRow(JSON.parse(line));
      if (!row || row.observedAt.slice(0, 10) !== latest.day ||
        (priorObservedAt !== null && row.observedAt < priorObservedAt)) return false;
      priorObservedAt = row.observedAt;
    }
    ftruncateSync(fd, finalNewline + 1);
    fsyncSync(fd);
    const repaired = fstatSync(fd);
    return privateFile(repaired) && sameNode(opened, repaired) && repaired.size === finalNewline + 1;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function recoverActivityTransactions(
  directory: string,
  expectedDirectory: Stats,
  partitionLimit = MAX_PARTITIONS,
  directoryDurable = true,
): boolean {
  try {
    const initialNames = readdirSync(directory);
    const appendIntents = initialNames.filter((entry) => APPEND_INTENT_RE.test(entry)).sort();
    if (appendIntents.length > 1) return false;
    for (const name of appendIntents) {
      if (!recoverAppendIntent(name, directory, expectedDirectory, directoryDurable)) return false;
    }
    if (!directoryDurable && appendIntents.length === 0 &&
      !recoverObservationalTrailingAppend(directory, expectedDirectory)) return false;
    for (const name of initialNames.filter((entry) => RETIRED_RE.test(entry)).sort()) {
      const digest = RETIRED_RE.exec(name)?.[2];
      if (!digest || !finishRetiredFile(join(directory, name), directory, expectedDirectory, digest)) return false;
    }
    for (const name of initialNames.filter((entry) => LEGACY_DELETE_RE.test(entry)).sort()) {
      if (!finishRetiredFile(join(directory, name), directory, expectedDirectory)) return false;
    }
    const retired = retiredMarkerCount(directory);
    if (retired === null || retired > MAX_RETIRED_FILES) return false;
    const retention = readRetentionMarker(directory, expectedDirectory);
    if (retention.state === 'invalid') {
      const pendingPartitions = listPartitions(directory);
      if (!directoryDurable || !pendingPartitions || pendingPartitions.length <= MAX_PARTITIONS) return false;
    }
    if (retention.state === 'valid' && directoryDurable &&
      !ensureTruncationAnchor(directory, expectedDirectory)) return false;

    // A hard-linked legacy stage cannot be unlinked safely against a same-UID
    // pathname swap. Migrate a valid published pair by retiring the target
    // through its descriptor; both legacy links become zero-byte inert markers.
    const legacyStageNames = readdirSync(directory).filter((entry) => LEGACY_STAGING_RE.test(entry)).sort();
    if (!directoryDurable && legacyStageNames.length > 0) return false;
    for (const name of legacyStageNames) {
      const match = LEGACY_STAGING_RE.exec(name);
      if (!match) return false;
      const stagePath = join(directory, name);
      const stage = lstatSync(stagePath);
      const targetPath = daemonActivitySegmentPath(match[1]!, Number(match[2]));
      if (!privateFileWithLinks(stage, [1, 2])) return false;
      if (stage.nlink === 2 && stage.size === 0 && hasRetiredTwin(directory, stage)) continue;
      if (stage.nlink === 2 && existsSync(targetPath) && sameNode(stage, lstatSync(targetPath))) {
        const bytes = readPartitionBytes(targetPath, expectedDirectory, [2]);
        const rows = readPartition(targetPath, expectedDirectory, [2]);
        if (!bytes || createHash('sha256').update(bytes).digest('hex') !== match[4] ||
          !rows || rows.length !== 1 || rows[0]!.observedAt.slice(0, 10) !== match[1] ||
          !retireVerifiedFile(targetPath, directory, expectedDirectory, [2])) return false;
        continue;
      }
      if (stage.nlink !== 1 || !retireVerifiedFile(stagePath, directory, expectedDirectory)) return false;
    }

    const intentNames = readdirSync(directory).filter((name) => INTENT_RE.test(name)).sort();
    if (intentNames.length > 1) return false;
    if (!directoryDurable && intentNames.length > 0) return false;
    for (const name of intentNames) {
      const match = INTENT_RE.exec(name);
      if (!match) return false;
      const day = match[1]!;
      const index = Number(match[2]);
      const expectedDigest = match[4]!;
      if (!canonicalDay(day) || !Number.isSafeInteger(index) || index < 0 || index > MAX_SEGMENT_INDEX) return false;
      const intentPath = join(directory, name);
      const intent = lstatSync(intentPath);
      if (!privateFile(intent) || intent.size !== 0) return false;
      const targetPath = daemonActivitySegmentPath(day, index);

      if (!existsSync(targetPath)) {
        if (!retireVerifiedFile(intentPath, directory, expectedDirectory)) return false;
        continue;
      }
      const publishedBytes = readPartitionBytes(targetPath, expectedDirectory);
      const rows = readPartition(targetPath, expectedDirectory);
      if (!publishedBytes || createHash('sha256').update(publishedBytes).digest('hex') !== expectedDigest) {
        const partitions = listPartitions(directory);
        if (!partitions || partitions.length > MAX_PARTITIONS + 1 || partitions.at(-1)?.path !== targetPath) {
          return false;
        }
        // A malformed target paired with the durable intent is a torn create,
        // not an append to an established partition. Retire only that inode.
        if (!rows && !retireVerifiedFile(targetPath, directory, expectedDirectory)) return false;
        if (!retireVerifiedFile(intentPath, directory, expectedDirectory)) return false;
        continue;
      }
      if (!rows || rows.length !== 1 || rows[0]!.observedAt.slice(0, 10) !== day) return false;
      const partitions = listPartitions(directory);
      if (!partitions || partitions.length > MAX_PARTITIONS + 1 || partitions.at(-1)?.path !== targetPath) return false;
      const predecessor = partitions.at(-2);
      if (predecessor) {
        const predecessorRows = readPartition(predecessor.path, expectedDirectory);
        if (!predecessorRows || predecessorRows.at(-1)!.observedAt > rows[0]!.observedAt) return false;
      }
      if (!prunePartitions(directory, expectedDirectory, partitions, MAX_PARTITIONS)) return false;
      if (!retireVerifiedFile(intentPath, directory, expectedDirectory)) return false;
      const published = lstatSync(targetPath);
      if (!privateFile(published)) return false;
    }

    let recovered = listPartitions(directory);
    if (recovered && directoryDurable && recovered.length > MAX_PARTITIONS) {
      if (recovered.length > MAX_PARTITIONS + 1 ||
        !prunePartitions(directory, expectedDirectory, recovered, MAX_PARTITIONS)) return false;
      recovered = listPartitions(directory);
    }
    return recovered !== null && recovered.length <= partitionLimit;
  } catch {
    return false;
  }
}

function publishPartition(
  path: string,
  day: string,
  index: number,
  bytes: Buffer,
  directory: string,
  expectedDirectory: Stats,
  directoryDurable: boolean,
): boolean {
  const intentPath = daemonActivityIntentPath(day, index, bytes);
  let fd: number | undefined;
  try {
    if (!directoryDurable) {
      if (existsSync(path)) return false;
      const partitions = listPartitions(directory);
      if (!partitions || partitions.length >= MAX_OBSERVATIONAL_PARTITIONS) return false;
      fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW, 0o600);
      const opened = fstatSync(fd);
      if (!privateFile(opened) || opened.size !== 0 || writeSync(fd, bytes) !== bytes.length) return false;
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
      const persisted = fstatSync(fd);
      if (!privateFile(persisted) || !sameNode(opened, persisted) || persisted.size !== bytes.length) return false;
      closeSync(fd);
      fd = undefined;
      const rebound = lstatSync(path);
      const observed = readPartitionBytes(path, expectedDirectory);
      return privateFile(rebound) && sameNode(persisted, rebound) && observed?.equals(bytes) === true;
    }
    // An intent is independent from the target inode, so it can be retired by
    // descriptor without ever unlinking a potentially swapped pathname.
    if (existsSync(path) || !createIntentMarker(intentPath, directory, expectedDirectory) || existsSync(path)) {
      return false;
    }

    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const targetOpened = fstatSync(fd);
    if (!privateFile(targetOpened) || targetOpened.size !== 0 || writeSync(fd, bytes) !== bytes.length) return false;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const targetPersisted = fstatSync(fd);
    if (!privateFile(targetPersisted) || !sameNode(targetOpened, targetPersisted) ||
      targetPersisted.size !== bytes.length) return false;
    closeSync(fd);
    fd = undefined;
    if (!fsyncStableDirectory(directory, expectedDirectory)) return false;
    const published = lstatSync(path);
    if (!privateFile(published) || !sameNode(targetPersisted, published)) return false;
    const publishedBytes = readPartitionBytes(path, expectedDirectory);
    if (!publishedBytes || !publishedBytes.equals(bytes)) return false;

    const publishedPartitions = listPartitions(directory);
    if (!publishedPartitions || publishedPartitions.length > MAX_PARTITIONS + 1 ||
      publishedPartitions.at(-1)?.path !== path ||
      !prunePartitions(directory, expectedDirectory, publishedPartitions, MAX_PARTITIONS)) return false;
    if (!retireVerifiedFile(intentPath, directory, expectedDirectory)) return false;
    const final = lstatSync(path);
    const finalBytes = readPartitionBytes(path, expectedDirectory);
    return privateFile(final) && sameNode(targetPersisted, final) && final.size === bytes.length &&
      finalBytes !== null && finalBytes.equals(bytes) && fsyncStableDirectory(directory, expectedDirectory);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function refreshContinuityFromDisk(
  directory: string,
  expectedDirectory: Stats,
  authority: ActivityContinuityAuthority,
  partitions: ActivityPartition[],
  truncated = authority.state.truncated,
): ActivityContinuityAuthority | null {
  const scanned = scanPartitions(partitions, expectedDirectory);
  if (!scanned) return null;
  return writeContinuity(directory, expectedDirectory, authority, {
    lifetimeComplete: authority.state.lifetimeComplete && !truncated,
    truncated,
    partitions: scanned.map((partition) => partition.cursor),
    pending: null,
  });
}

export function readDaemonActivity(options: {
  nowMs?: number;
  staleMs?: number;
  platform?: NodeJS.Platform;
} = {}): DaemonActivityReadResult {
  const durability = selectDaemonActivityNativeMode(options.platform);
  const missing: DaemonActivityReadResult = {
    sourceState: 'missing', complete: false, ownerHorizonComplete: false, durability,
    freshness: 'unknown', ownerState: 'unknown',
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
    const partitionLimit = durability === 'crash-durable' ? MAX_PARTITIONS : MAX_OBSERVATIONAL_PARTITIONS;
    if (partitions.length > partitionLimit) return degraded;
    if (partitions.some((partition) => !inspectPartitionEnvelope(partition.path, directory))) return degraded;
    const retention = readRetentionMarker(directoryPath, directory);
    const truncationAnchor = readTruncationAnchor(directoryPath, directory);
    if (retention.state === 'invalid' || truncationAnchor === 'invalid') return degraded;
    const key = readActivityKey(directoryPath, directory);
    const genesis = key ? readGenesis(directoryPath, directory, key) : null;
    const continuity = key && genesis ? readContinuity(directoryPath, directory, key, genesis) : null;
    const scanned = scanPartitions(partitions, directory);
    const effectiveContinuity = scanned && continuity ? projectCompletedPending(continuity, scanned) : null;
    const continuityMatches = scanned !== null && effectiveContinuity !== null &&
      effectiveContinuity.partitions.length === scanned.length &&
      scanned.every((partition, index) => cursorEquals(partition.cursor, effectiveContinuity.partitions[index]!));

    let activity: DaemonActivityRowV1 | null = null;
    let phaseStartedAt: string | null = null;
    let newerObservedAt: string | null = null;
    let remainingRows = MAX_PHASE_SCAN_ROWS;
    let phaseContinuityResolved = false;
    let historyComplete = continuityMatches && genesis?.lifetimeComplete === true &&
      effectiveContinuity?.lifetimeComplete === true && !effectiveContinuity.truncated && retention.state === 'absent' &&
      truncationAnchor === 'absent' && durability === 'crash-durable';
    let scanComplete = true;
    let ownerHorizonComplete = false;
    let oldestObservedAt: string | null = null;
    let oldestRow: DaemonActivityRowV1 | null = null;
    scan: for (let partitionIndex = partitions.length - 1; partitionIndex >= 0; partitionIndex--) {
      const partition = partitions[partitionIndex]!;
      const rows = scanned?.[partitionIndex]?.rows ?? null;
      const fallbackLines = rows ? null : partitionLines(partition.path, directory);
      if (!rows && !fallbackLines) return degraded;
      const rowCount = rows?.length ?? fallbackLines!.length;
      for (let rowIndex = rowCount - 1; rowIndex >= 0; rowIndex--) {
        if (remainingRows === 0) {
          historyComplete = false;
          scanComplete = false;
          if (!phaseContinuityResolved) phaseStartedAt = null;
          break scan;
        }
        let row = rows?.[rowIndex] ?? null;
        if (!row) {
          try {
            row = parseRow(JSON.parse(fallbackLines![rowIndex]!));
          } catch {
            return degraded;
          }
        }
        if (!row || row.observedAt.slice(0, 10) !== partition.day ||
          (newerObservedAt !== null && row.observedAt > newerObservedAt)) return degraded;
        if (activity === null) activity = row;
        const sameOwner = row.instanceId === activity.instanceId && row.pid === activity.pid &&
          row.processStartRef === activity.processStartRef && row.daemonStartedAt === activity.daemonStartedAt;
        if (!ownerHorizonComplete && (!sameOwner || row.phase === 'starting')) ownerHorizonComplete = true;
        if (!phaseContinuityResolved) {
          if (row.instanceId !== activity.instanceId || row.phase !== activity.phase) {
            phaseContinuityResolved = true;
          } else {
            phaseStartedAt = row.observedAt;
          }
        }
        newerObservedAt = row.observedAt;
        oldestObservedAt = row.observedAt;
        oldestRow = row;
        remainingRows--;
      }
    }
    if (!activity || !stableDirectory(directoryPath, directory)) return degraded;
    const oldestPartition = partitions[0]!;
    if (oldestPartition.index > 0 ||
      (oldestRow && oldestRow.daemonStartedAt.slice(0, 10) < oldestPartition.day)) historyComplete = false;
    if (scanComplete && historyComplete) ownerHorizonComplete = true;
    if (retention.marker && oldestObservedAt && retention.marker.removedThrough > oldestObservedAt) return degraded;
    const nowMs = options.nowMs ?? Date.now();
    const observedMs = Date.parse(activity.observedAt);
    const delta = Number.isFinite(nowMs) ? nowMs - observedMs : NaN;
    const ageMs = Number.isFinite(delta) ? Math.max(0, delta) : null;
    const staleMs = Math.max(1_000, options.staleMs ?? DAEMON_ACTIVITY_STALE_MS);
    const freshness: DaemonActivityFreshness = !Number.isFinite(delta)
      ? 'unknown'
      : delta < -FUTURE_TOLERANCE_MS ? 'future' : delta > staleMs ? 'stale' : 'fresh';
    return {
      sourceState: historyComplete ? 'healthy' : 'sampled',
      complete: historyComplete,
      ownerHorizonComplete,
      durability,
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
  runtime?: {
    platform?: NodeJS.Platform;
    directoryDurability?: 'native' | 'unproven';
  };
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
  let appendIntentPath: string | null = null;
  let directoryDurable = false;
  try {
    const directories = ensurePrivateDirectories();
    const day = observedAt.slice(0, 10);
    lock = acquireLocalStoreLock(join(daemonActivityDirectory(), '.activity.lock'), 2_000);
    if (!lock) return false;
    const directoryAfterLock = lstatSync(daemonActivityDirectory());
    if (!privateDirectory(directoryAfterLock) || !sameNode(directories.directory, directoryAfterLock)) return false;
    const nativeMode = selectDaemonActivityNativeMode(input.runtime?.platform);
    const directoryDurabilityAllowed = input.runtime?.directoryDurability !== 'unproven';
    directoryDurable = nativeMode === 'crash-durable' && directoryDurabilityAllowed &&
      stableDirectory(daemonActivityDirectory(), directories.directory);
    if (!directoryDurable && nativeMode !== 'observational') return false;
    const partitionLimit = nativeMode === 'crash-durable' ? MAX_PARTITIONS : MAX_OBSERVATIONAL_PARTITIONS;
    const transactionNames = readdirSync(daemonActivityDirectory());
    const hadRecoveryTransaction = transactionNames.some((name) =>
      APPEND_INTENT_RE.test(name) || INTENT_RE.test(name) || LEGACY_STAGING_RE.test(name));
    if (!recoverActivityTransactions(
      daemonActivityDirectory(), directories.directory, partitionLimit, directoryDurable,
    )) return false;
    const partitions = listPartitions(daemonActivityDirectory());
    if (!partitions || partitions.length > partitionLimit) return false;

    let continuity: ActivityContinuityAuthority | null = null;
    if (directoryDurable) {
      continuity = loadOrAdoptContinuity(
        daemonActivityDirectory(), directories.directory, partitions, observedAt,
      );
      if (!continuity) return false;
      if (continuity.state.pending) {
        const completed = completedContinuityGenerations.get(daemonActivityDirectory());
        continuity = recoverContinuityPending(
          daemonActivityDirectory(),
          directories.directory,
          continuity,
          partitions,
          completed?.genesisId === continuity.genesis.genesisId &&
            completed.generation === continuity.state.generation,
        );
        if (!continuity) return false;
      }
      if (!continuityFastMatches(continuity.state, partitions)) {
        const refreshed = refreshContinuityFromDisk(
          daemonActivityDirectory(),
          directories.directory,
          continuity,
          partitions,
          continuity.state.truncated || !hadRecoveryTransaction,
        );
        if (!refreshed) return false;
        continuity = refreshed;
      }
    }

    let prior: Stats | null = null;
    let path: string;
    const latest = partitions.at(-1);
    if (latest) {
      const cursor = continuity?.state.partitions.at(-1);
      const priorRows = cursor && cursor.name === latest.name
        ? { length: cursor.rows, lastObservedAt: cursor.lastObservedAt }
        : (() => {
            const rows = readPartition(latest.path, directories.directory);
            return rows && rows.length > 0
              ? { length: rows.length, lastObservedAt: rows.at(-1)!.observedAt }
              : null;
          })();
      if (!priorRows || observedAt < priorRows.lastObservedAt || day < latest.day) return false;
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
      if (directoryDurable) {
        if (!continuity || continuity.state.pending) return false;
        continuity = writeContinuity(
          daemonActivityDirectory(),
          directories.directory,
          continuity,
          {
            lifetimeComplete: continuity.state.lifetimeComplete,
            truncated: continuity.state.truncated,
            partitions: continuity.state.partitions,
            pending: {
              kind: 'append',
              partition: latest!.name,
              preLength: prior.size,
              row: bytes.toString('utf8'),
              rowDigest: createHash('sha256').update(bytes).digest('hex'),
            },
          },
        );
        if (!continuity) return false;
      } else {
        appendIntentPath = daemonActivityAppendIntentPath(day, latest!.index, prior.size, bytes);
        if (!createAppendIntentMarker(
          appendIntentPath, daemonActivityDirectory(), directories.directory, false,
        )) return false;
      }
      fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
    } else {
      const nextIndex = latest && day === latest.day ? latest.index + 1 : 0;
      let published: boolean;
      if (directoryDurable) {
        if (!continuity) return false;
        const recycling = partitions.length >= MAX_PARTITIONS ? partitions[0]! : null;
        if (recycling && !ensureRetentionMarker(
          daemonActivityDirectory(), directories.directory, recycling,
        )) return false;
        continuity = writeContinuity(
          daemonActivityDirectory(),
          directories.directory,
          continuity,
          {
            lifetimeComplete: recycling === null && continuity.state.lifetimeComplete,
            truncated: recycling !== null || continuity.state.truncated,
            partitions: continuity.state.partitions,
            pending: {
              kind: 'publish',
              partition: basename(path),
              row: bytes.toString('utf8'),
              rowDigest: createHash('sha256').update(bytes).digest('hex'),
              recycle: recycling?.name ?? null,
            },
          },
        );
        if (!continuity || continuity.state.pending?.kind !== 'publish') return false;
        published = materializePendingPublish(
          daemonActivityDirectory(), directories.directory, continuity, continuity.state.pending,
        );
      } else {
        published = publishPartition(
          path,
          day,
          nextIndex,
          bytes,
          daemonActivityDirectory(),
          directories.directory,
          directoryDurable,
        );
      }
      if (!published) return false;
      const publishStable = directoryDurable
        ? stableDirectory(daemonActivityDirectory(), directories.directory)
        : true;
      if (publishStable && directoryDurable && continuity) {
        rememberCompletedContinuity(daemonActivityDirectory(), continuity);
      }
      return publishStable;
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
    closeSync(fd);
    fd = undefined;
    if (directoryDurable) {
      if (!continuity || !continuity.state.pending) return false;
      const priorCursor = continuity.state.partitions.at(-1);
      const identity = exactPartitionIdentity(path);
      if (!priorCursor || priorCursor.name !== latest!.name || !identity) return false;
      if (priorCursor.rows >= MAX_ROWS || expectedSize !== priorCursor.bytes + bytes.length ||
        identity.dev !== priorCursor.dev || identity.ino !== priorCursor.ino) return false;
    } else if (!appendIntentPath || !recoverAppendIntent(
      basename(appendIntentPath), daemonActivityDirectory(), directories.directory, false,
    )) return false;
    const appendStable = directoryDurable
      ? stableDirectory(daemonActivityDirectory(), directories.directory)
      : true;
    if (appendStable && directoryDurable && continuity) {
      rememberCompletedContinuity(daemonActivityDirectory(), continuity);
    }
    return appendStable;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    releaseLocalStoreLock(lock);
  }
}
