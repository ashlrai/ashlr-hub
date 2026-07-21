/**
 * Append-only concurrent dispatch intent ledger.
 *
 * This is forensic intent only: it is not a queue, lease, retry source, or
 * merge gate. Reads and writes fail soft, but detailed reads report source
 * quality so incomplete history cannot silently become authoritative.
 */

import { randomUUID } from 'node:crypto';
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
  opendirSync,
  readSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { DaemonDispatchManifestSummary, EngineId, WorkItem } from '../types.js';
import type { DispatchPlan } from '../fabric/concurrent-dispatch.js';
import { scrubSecrets } from '../util/scrub.js';
import { canonicalFilesystemPathIdentity } from '../sandbox/policy.js';
import { fsyncDirectory } from '../util/durability.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DEFAULT_READ_MAX_FILES = 32;
const DEFAULT_READ_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_READ_MAX_ROWS = 100_000;
const HARD_READ_MAX_FILES = 366;
const HARD_READ_MAX_BYTES = 256 * 1024 * 1024;
const HARD_READ_MAX_ROWS = 1_000_000;
const MAX_READ_ROW_BYTES = 128 * 1024;
const MAX_PARTITION_BYTES = 16 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_048;
const MAX_WRITE_ROWS_PER_CALL = 10_000;
const MAX_WRITE_PARTITIONS_PER_CALL = 32;
const MAX_ITEMS = 24;
const MAX_MAP_KEYS = 128;
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes', 'kimi', 'nim', 'opencode', 'grok',
]);
const PERSISTED_WORK_SOURCES = new Set<string>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent',
  'backlog',
]);
const MAX_TEXT = {
  machineId: 120,
  itemId: 240,
  repo: 500,
  title: 160,
  reason: 240,
  model: 160,
};

export interface DispatchManifestAssignment {
  itemId: string;
  attemptId?: string;
  source: WorkItem['source'];
  repo: string;
  title: string;
  backend: EngineId;
  routeReason?: string;
  model?: string | null;
}

export interface DispatchManifestUnassigned {
  itemId: string;
  reason: 'no-slots';
}

export interface DispatchManifestEvent {
  schemaVersion: 1;
  manifestId: string;
  ts: string;
  machineId?: string;
  mode: 'concurrent';
  dryRun: boolean;
  claimedItemIds: string[];
  assignments: DispatchManifestAssignment[];
  unassigned: DispatchManifestUnassigned[];
  slots: Record<string, number>;
  backendCounts: Record<string, number>;
  resourceSnapshotAt?: string;
  counts: { claimed: number; assigned: number; unassigned: number };
}

export interface BuildDispatchManifestEventInput {
  ts: string;
  machineId?: string;
  plan: DispatchPlan;
  routeReasons?: ReadonlyMap<string, string>;
  routeModels?: ReadonlyMap<string, string | null>;
  attemptIds?: ReadonlyMap<string, string>;
  resourceSnapshotAt?: string;
  dryRun?: boolean;
}

export interface ReadDispatchManifestEventsOptions {
  limit?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxRows?: number;
  /** Stop once one event beyond limit proves the logical result is partial. */
  stopAfterLimit?: boolean;
  /** Return no events unless every selected row was read and validated. */
  requireComplete?: boolean;
  /** Inspect an already-private store without locks or permission migration. */
  inspectionOnly?: boolean;
}

export type DispatchManifestReadStopReason =
  | 'event-limit'
  | 'file-limit'
  | 'byte-limit'
  | 'row-limit'
  | 'io-error';

export interface DispatchManifestSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: DispatchManifestReadStopReason[];
  filesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface DispatchManifestEventsReadResult extends DispatchManifestSourceQuality {
  events: DispatchManifestEvent[];
}

/**
 * Latest metadata observation across the bounded durable history. This is
 * intentionally separate from any display aggregation: callers use it to
 * determine evidence freshness, never to make routing decisions.
 */
export interface DispatchManifestLatestObservationReadResult {
  latestAt?: string;
  sourceQuality: DispatchManifestSourceQuality;
}

export function dispatchManifestDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root = typeof configuredHome === 'string' && configuredHome.trim() !== '' && isAbsolute(configuredHome)
    ? configuredHome
    : join(homedir(), '.ashlr');
  return join(root, 'dispatch-manifests');
}

function dispatchManifestRoot(): string {
  return dirname(dispatchManifestDir());
}

function eventDateString(ts: string): string {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function eventTimestamp(ts: string): string {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function boundedText(value: unknown, max: number, fallback = ''): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const trimmed = scrubSecrets(text).trim();
  const chosen = trimmed.length > 0 ? trimmed : fallback;
  return chosen.length > max ? `${chosen.slice(0, max - 3)}...` : chosen;
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? boundedText(value, max) : undefined;
}

function boundedNullableText(value: unknown, max: number): string | null | undefined {
  return value === null ? null : boundedOptionalText(value, max);
}

function canonicalManifestRepoIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT.repo || !isAbsolute(value)) return null;
  if (scrubSecrets(value) !== value) return null;
  const canonical = canonicalFilesystemPathIdentity(value, { foldWindowsCase: false });
  return canonical !== null && canonical.length <= MAX_TEXT.repo && scrubSecrets(canonical) === canonical
    ? canonical
    : null;
}

function sanitizeCountMap(input: ReadonlyMap<EngineId, number> | Record<string, number> | undefined): Record<string, number> {
  if (!input) return {};
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input);
  const out: Record<string, number> = {};
  for (const [rawKey, value] of entries.slice(0, MAX_MAP_KEYS)) {
    const key = boundedText(rawKey, 80);
    if (key) out[key] = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }
  return out;
}

function assignmentBackendCounts(assignments: Array<{ backend: EngineId | string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const assignment of assignments) {
    const backend = boundedText(assignment.backend, 80, 'builtin');
    if (backend) out[backend] = (out[backend] ?? 0) + 1;
  }
  return out;
}

export function buildDispatchManifestEvent(input: BuildDispatchManifestEventInput): DispatchManifestEvent {
  const ts = eventTimestamp(input.ts);
  const claimedItemIds = input.plan.assignments.map(({ item }) => item.id).concat(input.plan.unassigned.map((item) => item.id));
  const assignments = input.plan.assignments.slice(0, MAX_ITEMS).map(({ item, backend }) => {
    const routeReason = boundedOptionalText(input.routeReasons?.get(item.id), MAX_TEXT.reason);
    const model = boundedNullableText(input.routeModels?.get(item.id), MAX_TEXT.model);
    const attemptId = boundedOptionalText(input.attemptIds?.get(item.id), 160);
    return {
      itemId: boundedText(item.id, MAX_TEXT.itemId, 'unknown'),
      ...(attemptId ? { attemptId } : {}),
      source: boundedText(item.source, 80, 'unknown') as WorkItem['source'],
      repo: item.repo,
      title: boundedText(item.title ?? item.id, MAX_TEXT.title, 'untitled'),
      backend: boundedText(backend, 80, 'builtin') as EngineId,
      ...(routeReason ? { routeReason } : {}),
      ...(model !== undefined ? { model } : {}),
    };
  });
  const unassigned = input.plan.unassigned.slice(0, MAX_ITEMS).map((item) => ({
    itemId: boundedText(item.id, MAX_TEXT.itemId, 'unknown'), reason: 'no-slots' as const,
  }));
  return sanitizeDispatchManifestEvent({
    schemaVersion: 1,
    manifestId: `dm-${ts.replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    ts,
    ...(input.machineId ? { machineId: input.machineId } : {}),
    mode: 'concurrent',
    dryRun: input.dryRun === true,
    claimedItemIds: claimedItemIds.map((id) => boundedText(id, MAX_TEXT.itemId, 'unknown')).slice(0, MAX_ITEMS),
    assignments,
    unassigned,
    slots: sanitizeCountMap(input.plan.slotsMap),
    backendCounts: assignmentBackendCounts(input.plan.assignments),
    ...(input.resourceSnapshotAt ? { resourceSnapshotAt: eventTimestamp(input.resourceSnapshotAt) } : {}),
    counts: { claimed: claimedItemIds.length, assigned: input.plan.assignments.length, unassigned: input.plan.unassigned.length },
  });
}

export function sanitizeDispatchManifestEvent(event: DispatchManifestEvent): DispatchManifestEvent {
  const ts = eventTimestamp(event.ts);
  const claimedItemIds = Array.isArray(event.claimedItemIds)
    ? event.claimedItemIds.map((id) => boundedText(id, MAX_TEXT.itemId, 'unknown')).slice(0, MAX_ITEMS) : [];
  const assignments = Array.isArray(event.assignments) ? event.assignments.slice(0, MAX_ITEMS).map((assignment) => {
    const attemptId = boundedOptionalText(assignment.attemptId, 160);
    const routeReason = boundedOptionalText(assignment.routeReason, MAX_TEXT.reason);
    const model = boundedNullableText(assignment.model, MAX_TEXT.model);
    const repo = canonicalManifestRepoIdentity(assignment.repo);
    if (repo === null) throw new Error('invalid dispatch manifest repository identity');
    return {
      itemId: boundedText(assignment.itemId, MAX_TEXT.itemId, 'unknown'),
      ...(attemptId ? { attemptId } : {}),
      source: boundedText(assignment.source, 80, 'unknown') as WorkItem['source'],
      repo,
      title: boundedText(assignment.title, MAX_TEXT.title, 'untitled'),
      backend: boundedText(assignment.backend, 80, 'builtin') as EngineId,
      ...(routeReason ? { routeReason } : {}),
      ...(model !== undefined ? { model } : {}),
    };
  }) : [];
  const unassigned = Array.isArray(event.unassigned) ? event.unassigned.slice(0, MAX_ITEMS).map((item) => ({
    itemId: boundedText(item.itemId, MAX_TEXT.itemId, 'unknown'), reason: 'no-slots' as const,
  })) : [];
  const finiteCount = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value)) : fallback;
  const backendCounts = sanitizeCountMap(event.backendCounts);
  const machineId = boundedOptionalText(event.machineId, MAX_TEXT.machineId);
  return {
    schemaVersion: 1,
    manifestId: boundedText(event.manifestId, 120, `dm-${ts.replace(/[^0-9]/g, '').slice(0, 14)}`),
    ts,
    ...(machineId ? { machineId } : {}),
    mode: 'concurrent',
    dryRun: event.dryRun === true,
    claimedItemIds,
    assignments,
    unassigned,
    slots: sanitizeCountMap(event.slots),
    backendCounts: Object.keys(backendCounts).length > 0 ? backendCounts : assignmentBackendCounts(assignments),
    ...(event.resourceSnapshotAt ? { resourceSnapshotAt: eventTimestamp(event.resourceSnapshotAt) } : {}),
    counts: {
      claimed: finiteCount(event.counts?.claimed, claimedItemIds.length),
      assigned: finiteCount(event.counts?.assigned, assignments.length),
      unassigned: finiteCount(event.counts?.unassigned, unassigned.length),
    },
  };
}

export function dispatchManifestSummary(event: DispatchManifestEvent, recorded: boolean): DaemonDispatchManifestSummary {
  return {
    schemaVersion: 1, manifestId: event.manifestId, ts: event.ts, mode: event.mode, recorded,
    claimed: event.counts.claimed, assigned: event.counts.assigned, unassigned: event.counts.unassigned,
    backends: event.backendCounts,
    ...(event.resourceSnapshotAt ? { resourceSnapshotAt: event.resourceSnapshotAt } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCountMap(value: unknown): value is Record<string, number> {
  if (!isPlainRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_MAP_KEYS && entries.every(([key, count]) => ENGINE_IDS.has(key as EngineId) && isCount(count));
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isAssignment(value: unknown): value is DispatchManifestAssignment {
  if (!isPlainRecord(value) || !onlyKeys(value, ['itemId', 'attemptId', 'source', 'repo', 'title', 'backend', 'routeReason', 'model'])) return false;
  return isBoundedString(value['itemId'], MAX_TEXT.itemId) &&
    (value['attemptId'] === undefined || isBoundedString(value['attemptId'], 160)) &&
    typeof value['source'] === 'string' && PERSISTED_WORK_SOURCES.has(value['source']) &&
    isBoundedString(value['repo'], MAX_TEXT.repo) && canonicalManifestRepoIdentity(value['repo']) === value['repo'] &&
    isBoundedString(value['title'], MAX_TEXT.title) &&
    typeof value['backend'] === 'string' && ENGINE_IDS.has(value['backend'] as EngineId) &&
    (value['routeReason'] === undefined || isBoundedString(value['routeReason'], MAX_TEXT.reason)) &&
    (value['model'] === undefined || value['model'] === null || isBoundedString(value['model'], MAX_TEXT.model));
}

function isDispatchManifestEvent(value: unknown): value is DispatchManifestEvent {
  if (!isPlainRecord(value) || !onlyKeys(value, [
    'schemaVersion', 'manifestId', 'ts', 'machineId', 'mode', 'dryRun', 'claimedItemIds',
    'assignments', 'unassigned', 'slots', 'backendCounts', 'resourceSnapshotAt', 'counts',
  ])) return false;
  if (value['schemaVersion'] !== 1 || value['mode'] !== 'concurrent' || typeof value['dryRun'] !== 'boolean' ||
    !isBoundedString(value['manifestId'], 120) || !isCanonicalTimestamp(value['ts']) ||
    (value['machineId'] !== undefined && !isBoundedString(value['machineId'], MAX_TEXT.machineId)) ||
    (value['resourceSnapshotAt'] !== undefined && !isCanonicalTimestamp(value['resourceSnapshotAt'])) ||
    !Array.isArray(value['claimedItemIds']) || value['claimedItemIds'].length > MAX_ITEMS ||
    !value['claimedItemIds'].every((id) => isBoundedString(id, MAX_TEXT.itemId)) ||
    !Array.isArray(value['assignments']) || value['assignments'].length > MAX_ITEMS || !value['assignments'].every(isAssignment) ||
    !Array.isArray(value['unassigned']) || value['unassigned'].length > MAX_ITEMS ||
    !value['unassigned'].every((item) => isPlainRecord(item) && onlyKeys(item, ['itemId', 'reason']) &&
      isBoundedString(item['itemId'], MAX_TEXT.itemId) && item['reason'] === 'no-slots') ||
    !isCountMap(value['slots']) || !isCountMap(value['backendCounts']) || !isPlainRecord(value['counts']) ||
    !onlyKeys(value['counts'], ['claimed', 'assigned', 'unassigned'])) return false;
  if (!isCount(value['counts']['claimed']) || !isCount(value['counts']['assigned']) ||
    !isCount(value['counts']['unassigned'])) return false;
  const claimed = value['counts']['claimed'];
  const assigned = value['counts']['assigned'];
  const unassigned = value['counts']['unassigned'];
  const backendTotal = Object.values(value['backendCounts']).reduce((sum, count) => sum + count, 0);
  return claimed === assigned + unassigned && backendTotal === assigned &&
    value['claimedItemIds'].length <= claimed && value['assignments'].length <= assigned &&
    value['unassigned'].length <= unassigned;
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownedByCurrentUser(stat: ReturnType<typeof fstatSync>): boolean {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

function unsafeFile(stat: ReturnType<typeof fstatSync>): boolean {
  return Number(stat.nlink) !== 1 || !ownedByCurrentUser(stat) ||
    (process.platform !== 'win32' && (Number(stat.mode) & 0o077) !== 0);
}

function migratableFile(stat: ReturnType<typeof fstatSync>): boolean {
  return Number(stat.nlink) === 1 && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function unsafeDirectory(stat: ReturnType<typeof fstatSync>): boolean {
  return !ownedByCurrentUser(stat) ||
    (process.platform !== 'win32' && (Number(stat.mode) & 0o077) !== 0);
}

function migratableDirectory(stat: ReturnType<typeof fstatSync>): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function secureDirectory(path: string, create: boolean): ReturnType<typeof lstatSync> | undefined {
  if (!existsSync(path)) {
    if (!create) return undefined;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const before = lstatSync(path);
  if (!migratableDirectory(before)) throw new Error('unsafe manifest directory');
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (unsafeDirectory(after) || !sameFile(before, after)) throw new Error('manifest directory changed');
  return after;
}

function inspectPrivateDirectory(path: string): ReturnType<typeof lstatSync> | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || unsafeDirectory(stat)) {
    throw new Error('unsafe manifest directory');
  }
  return stat;
}

function sameDirectorySnapshot(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return sameFile(left, right) && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('dispatch manifest append made no progress');
    offset += written;
  }
}

function appendManifestLine(
  path: string,
  line: string,
  dir: string,
  directorySnapshot: NonNullable<ReturnType<typeof lstatSync>>,
): void {
  let fd: number | undefined;
  try {
    const directoryBefore = lstatSync(dir);
    if (!sameFile(directorySnapshot, directoryBefore) || unsafeDirectory(directoryBefore)) throw new Error('manifest directory changed');
    let pathBefore: NonNullable<ReturnType<typeof lstatSync>> | undefined;
    try {
      pathBefore = lstatSync(path);
      if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || !migratableFile(pathBefore)) throw new Error('unsafe manifest path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fd = openSync(path, fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW |
      (pathBefore !== undefined ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL), 0o600);
    let opened = fstatSync(fd);
    if (!opened.isFile() || !migratableFile(opened) || (pathBefore !== undefined && !sameFile(pathBefore, opened))) throw new Error('unsafe manifest file');
    fchmodSync(fd, 0o600);
    opened = fstatSync(fd);
    if (unsafeFile(opened)) throw new Error('manifest mode migration failed');
    let separator = '';
    if (opened.size > 0) {
      const tail = Buffer.alloc(1);
      if (readSync(fd, tail, 0, 1, opened.size - 1) !== 1) throw new Error('unreadable manifest tail');
      if (tail[0] !== 0x0a) separator = '\n';
    }
    const bytes = Buffer.from(`${separator}${line}`, 'utf8');
    if (opened.size > MAX_PARTITION_BYTES || opened.size + bytes.length > MAX_PARTITION_BYTES) {
      throw new Error('manifest partition full');
    }
    writeAll(fd, bytes);
    fsyncSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    const directoryAfter = lstatSync(dir);
    if (!after.isFile() || unsafeFile(after) || !sameFile(opened, after) || pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() || !sameFile(after, pathAfter) || !sameFile(directorySnapshot, directoryAfter) ||
      unsafeDirectory(directoryAfter) || after.size !== opened.size + bytes.length) {
      throw new Error('manifest append identity changed');
    }
    if (!pathBefore) fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function recordDispatchManifest(eventOrEvents: DispatchManifestEvent | DispatchManifestEvent[]): DaemonDispatchManifestSummary | undefined {
  const firstInput = Array.isArray(eventOrEvents) ? eventOrEvents[0] : eventOrEvents;
  if (!firstInput) return undefined;
  let first: DispatchManifestEvent;
  try {
    first = sanitizeDispatchManifestEvent(firstInput);
  } catch {
    return dispatchManifestSummary(firstInput, false);
  }
  let lock: ReturnType<typeof acquireLocalStoreLock> | undefined;
  try {
    const input = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];
    if (input.length !== 1 || input.length > MAX_WRITE_ROWS_PER_CALL) return dispatchManifestSummary(first, false);
    const events = input.map(sanitizeDispatchManifestEvent);
    if (!events.every(isDispatchManifestEvent)) return dispatchManifestSummary(first, false);
    const partitions = new Set(events.map((event) => eventDateString(event.ts)));
    if (partitions.size > MAX_WRITE_PARTITIONS_PER_CALL) return dispatchManifestSummary(first, false);
    const lines = events.map((event) => JSON.stringify(event) + '\n');
    if (lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES)) return dispatchManifestSummary(first, false);
    const dir = dispatchManifestDir();
    const parentDir = dirname(dir);
    const parentCreated = !existsSync(parentDir);
    const directoryCreated = !existsSync(dir);
    const parentSnapshot = secureDirectory(parentDir, true)!;
    secureDirectory(dir, true);
    lock = acquireLocalStoreLock(join(dir, '.dispatch-manifests.lock'));
    if (!lock) return dispatchManifestSummary(first, false);
    const directorySnapshot = lstatSync(dir);
    if (directorySnapshot.isSymbolicLink() || !directorySnapshot.isDirectory() || unsafeDirectory(directorySnapshot)) {
      return dispatchManifestSummary(first, false);
    }
    for (let index = 0; index < events.length; index++) {
      const parentBefore = lstatSync(parentDir);
      if (unsafeDirectory(parentBefore) || !sameFile(parentSnapshot, parentBefore)) {
        throw new Error('manifest parent replaced');
      }
      appendManifestLine(join(dir, `${eventDateString(events[index]!.ts)}.jsonl`), lines[index]!, dir, directorySnapshot);
    }
    const parentAfter = lstatSync(parentDir);
    if (unsafeDirectory(parentAfter) || !sameFile(parentSnapshot, parentAfter)) throw new Error('manifest parent replaced');
    if (directoryCreated) {
      fsyncDirectory(parentDir);
      if (parentCreated) fsyncDirectory(dirname(parentDir));
    }
    return dispatchManifestSummary(first, true);
  } catch {
    return dispatchManifestSummary(first, false);
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function boundedReadOption(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value))) : fallback;
}

function emptyRead(sourceState: DispatchManifestSourceQuality['sourceState'], overrides: Partial<DispatchManifestEventsReadResult> = {}): DispatchManifestEventsReadResult {
  return { events: [], sourceState, sourcePresent: sourceState !== 'missing', complete: sourceState !== 'degraded', stopReasons: [],
    filesRead: 0, bytesRead: 0, rowsScanned: 0, invalidRows: 0, unreadableFiles: 0, ...overrides };
}

function pushStopReason(reasons: DispatchManifestReadStopReason[], reason: DispatchManifestReadStopReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function validDatePartition(file: string): boolean {
  const date = DATE_LEDGER_FILE_RE.exec(file)?.[1];
  if (!date) return false;
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}

function readManifestFile(
  path: string,
  maxBytes: number,
  inspectionOnly = false,
): { ok: true; text: string; bytesRead: number } | { ok: false; reason: 'byte-limit' | 'io-error' } {
  let fd: number | undefined;
  try {
    const pathBefore = lstatSync(path);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile() ||
      (inspectionOnly ? unsafeFile(pathBefore) : !migratableFile(pathBefore))) return { ok: false, reason: 'io-error' };
    if (pathBefore.size > maxBytes) return { ok: false, reason: 'byte-limit' };
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let before = fstatSync(fd);
    if (!before.isFile() || (inspectionOnly ? unsafeFile(before) : !migratableFile(before)) ||
      !sameFile(pathBefore, before)) return { ok: false, reason: 'io-error' };
    if (before.size > maxBytes) return { ok: false, reason: 'byte-limit' };
    if (!inspectionOnly) {
      fchmodSync(fd, 0o600);
      before = fstatSync(fd);
      if (unsafeFile(before)) return { ok: false, reason: 'io-error' };
    }
    const buffer = Buffer.alloc(before.size);
    const bytesRead = before.size > 0 ? readSync(fd, buffer, 0, before.size, 0) : 0;
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || !after.isFile() || unsafeFile(after) ||
      !sameFile(before, after) || !sameFile(after, pathAfter) || after.size !== before.size || bytesRead !== before.size) {
      return { ok: false, reason: 'io-error' };
    }
    return { ok: true, text: buffer.toString('utf8'), bytesRead };
  } catch {
    return { ok: false, reason: 'io-error' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

export function readDispatchManifestEventsDetailed(opts: ReadDispatchManifestEventsOptions = {}): DispatchManifestEventsReadResult {
  let lock: ReturnType<typeof acquireLocalStoreLock> | undefined;
  try {
    const maxFiles = boundedReadOption(opts.maxFiles, DEFAULT_READ_MAX_FILES, HARD_READ_MAX_FILES);
    const maxBytes = boundedReadOption(opts.maxBytes, DEFAULT_READ_MAX_BYTES, HARD_READ_MAX_BYTES);
    const maxRows = boundedReadOption(opts.maxRows, DEFAULT_READ_MAX_ROWS, HARD_READ_MAX_ROWS);
    const dir = dispatchManifestDir();
    if (!existsSync(dir)) return emptyRead('missing');
    const parentSnapshot = opts.inspectionOnly
      ? inspectPrivateDirectory(dispatchManifestRoot())
      : secureDirectory(dispatchManifestRoot(), false);
    if (!parentSnapshot) return emptyRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    if (opts.inspectionOnly) inspectPrivateDirectory(dir);
    else secureDirectory(dir, false);
    if (!opts.inspectionOnly) {
      lock = acquireLocalStoreLock(join(dir, '.dispatch-manifests.lock'), 250);
      if (!lock) return emptyRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    }
    const directorySnapshot = lstatSync(dir);
    if (directorySnapshot.isSymbolicLink() || !directorySnapshot.isDirectory() || unsafeDirectory(directorySnapshot)) {
      return emptyRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    }
    const handle = opendirSync(dir);
    const files: string[] = [];
    let entriesSeen = 0;
    let invalidPartition = false;
    try {
      let entry = handle.readSync();
      while (entry !== null) {
        entriesSeen++;
        if (entriesSeen > MAX_DIRECTORY_ENTRIES) return emptyRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['file-limit'] });
        if (entry.name.endsWith('.jsonl')) {
          if (!DATE_LEDGER_FILE_RE.test(entry.name) || !validDatePartition(entry.name)) invalidPartition = true;
          else files.push(entry.name);
        }
        entry = handle.readSync();
      }
    } finally { handle.closeSync(); }
    if (invalidPartition) return emptyRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    files.sort().reverse();
    if (files.length === 0) {
      const directoryAfter = lstatSync(dir);
      const parentAfter = lstatSync(dispatchManifestRoot());
      return unsafeDirectory(directoryAfter) || !sameDirectorySnapshot(directorySnapshot, directoryAfter) ||
        unsafeDirectory(parentAfter) || !sameFile(parentSnapshot, parentAfter)
        ? emptyRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['io-error'], unreadableFiles: 1 })
        : emptyRead('healthy', { sourcePresent: true });
    }

    const result = emptyRead('healthy', { sourcePresent: true });
    const eventLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : undefined;
    let stoppedAfterEventLimit = false;
    for (const file of files) {
      if (result.filesRead >= maxFiles) { pushStopReason(result.stopReasons, 'file-limit'); result.complete = false; break; }
      const remainingBytes = maxBytes - result.bytesRead;
      if (remainingBytes <= 0) { pushStopReason(result.stopReasons, 'byte-limit'); result.complete = false; break; }
      const loaded = readManifestFile(join(dir, file), remainingBytes, opts.inspectionOnly === true);
      result.filesRead++;
      if (!loaded.ok) {
        if (loaded.reason === 'io-error') result.unreadableFiles++;
        pushStopReason(result.stopReasons, loaded.reason); result.complete = false; break;
      }
      result.bytesRead += loaded.bytesRead;
      const lines = loaded.text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      for (const line of lines.reverse()) {
        if (result.rowsScanned >= maxRows) { pushStopReason(result.stopReasons, 'row-limit'); result.complete = false; break; }
        result.rowsScanned++;
        if (!line.trim()) continue;
        if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) { result.invalidRows++; continue; }
        try {
          const parsed: unknown = JSON.parse(line);
          const partition = DATE_LEDGER_FILE_RE.exec(file)?.[1];
          if (!isDispatchManifestEvent(parsed) || parsed.ts.slice(0, 10) !== partition) { result.invalidRows++; continue; }
          result.events.push(sanitizeDispatchManifestEvent(parsed));
          if (opts.stopAfterLimit === true && eventLimit !== undefined && result.events.length > eventLimit) {
            pushStopReason(result.stopReasons, 'event-limit'); result.complete = false; stoppedAfterEventLimit = true; break;
          }
        } catch { result.invalidRows++; }
      }
      if (!result.complete) break;
    }
    const directoryAfter = lstatSync(dir);
    const parentAfter = lstatSync(dispatchManifestRoot());
    if (directoryAfter.isSymbolicLink() || !directoryAfter.isDirectory() || unsafeDirectory(directoryAfter) ||
      !sameDirectorySnapshot(directorySnapshot, directoryAfter) || unsafeDirectory(parentAfter) ||
      !sameFile(parentSnapshot, parentAfter)) {
      pushStopReason(result.stopReasons, 'io-error'); result.complete = false; result.unreadableFiles++;
    }
    result.events.sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
    if (eventLimit !== undefined) {
      if (!stoppedAfterEventLimit && result.events.length > eventLimit) { pushStopReason(result.stopReasons, 'event-limit'); result.complete = false; }
      result.events = result.events.slice(0, eventLimit);
    }
    if (result.invalidRows > 0 || result.unreadableFiles > 0 || !result.complete) { result.complete = false; result.sourceState = 'degraded'; }
    return result;
  } catch {
    return emptyRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
  } finally { releaseLocalStoreLock(lock); }
}

export function readDispatchManifestEvents(opts: ReadDispatchManifestEventsOptions = {}): DispatchManifestEvent[] {
  const result = readDispatchManifestEventsDetailed({
    ...opts,
    limit: opts.limit ?? 100,
    stopAfterLimit: opts.stopAfterLimit ?? opts.requireComplete !== true,
  });
  const events = opts.requireComplete === true && (!result.complete || result.sourceState === 'degraded') ? [] : result.events;
  Object.defineProperty(events, 'sourceQuality', {
    value: {
      sourceState: result.sourceState, sourcePresent: result.sourcePresent, complete: result.complete,
      stopReasons: result.stopReasons, filesRead: result.filesRead, bytesRead: result.bytesRead,
      rowsScanned: result.rowsScanned, invalidRows: result.invalidRows, unreadableFiles: result.unreadableFiles,
    } satisfies DispatchManifestSourceQuality,
    enumerable: false,
  });
  return events;
}

/**
 * Read the newest durable manifest observation without applying a display or
 * analytics cutoff. Incomplete or degraded history withholds the timestamp so
 * consumers cannot label partial evidence as fresh.
 */
export function readDispatchManifestLatestObservationDetailed(): DispatchManifestLatestObservationReadResult {
  const read = readDispatchManifestEventsDetailed({
    maxFiles: HARD_READ_MAX_FILES,
    maxBytes: HARD_READ_MAX_BYTES,
    maxRows: HARD_READ_MAX_ROWS,
  });
  const { events, ...sourceQuality } = read;
  if (sourceQuality.sourceState !== 'healthy' || !sourceQuality.complete) {
    return { sourceQuality };
  }

  let latestAt: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const eventMs = Date.parse(event.ts);
    if (eventMs > latestMs) {
      latestMs = eventMs;
      latestAt = event.ts;
    }
  }
  return { ...(latestAt === undefined ? {} : { latestAt }), sourceQuality };
}
