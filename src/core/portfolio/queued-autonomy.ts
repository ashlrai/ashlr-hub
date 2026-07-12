/**
 * queued-autonomy.ts — read-only access to generated autonomy work.
 *
 * Self-heal stores work in ~/.ashlr/self-heal-queue.json and invent may append
 * source:"invent" work to ~/.ashlr/backlog.json. These queues are observational
 * inputs only: this module never refreshes scanners or writes state.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { EngineId, EngineTier, RepairTreatment, WorkItem, WorkSource } from '../types.js';
import {
  REJECTED_CAPTURE_REPAIR_MAX_AGE_MS,
  isActionableSelfHealItem,
} from '../fleet/self-heal-trust.js';
import { generatedRepairGenerationId } from '../fleet/generated-repair-lifecycle.js';
import { repairTreatmentForUnitId, repairTreatmentUnitId } from '../fleet/generated-repair-identity.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';

const WORK_SOURCES = new Set<WorkSource>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent',
]);
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes', 'kimi', 'nim', 'opencode', 'grok',
]);
const ENGINE_TIERS = new Set<EngineTier>(['local', 'mid', 'frontier']);
const REPAIR_TREATMENTS = new Set<RepairTreatment>(['baseline-reslice', 'target-localization']);
const QUEUED_AUTONOMY_FILES = ['self-heal-queue.json', 'backlog.json'] as const;
const MAX_QUEUED_AUTONOMY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_AUTONOMY_ROWS_PER_FILE = 10_000;

export interface QueuedAutonomyReadResult {
  items: WorkItem[];
  sourceState: 'complete' | 'unavailable';
  filesPresent: number;
  filesMissing: number;
  filesUnavailable: number;
  rowsScanned: number;
  itemsLoaded: number;
  limitExceeded: boolean;
}

function validRepairParentMetadata(item: Partial<WorkItem>): boolean {
  const hasMetadata =
    item.repairParentItemId !== undefined ||
    item.repairParentSource !== undefined ||
    item.repairParentBackend !== undefined ||
    item.repairParentTier !== undefined ||
    item.repairParentObjectiveHash !== undefined;
  if (!hasMetadata) return true;
  return (
    typeof item.repairParentItemId === 'string' &&
    item.repairParentItemId.length > 0 &&
    item.repairParentItemId.length <= 180 &&
    typeof item.repairParentSource === 'string' &&
    WORK_SOURCES.has(item.repairParentSource as WorkSource) &&
    (item.repairParentBackend === null ||
      (typeof item.repairParentBackend === 'string' && ENGINE_IDS.has(item.repairParentBackend as EngineId))) &&
    (item.repairParentTier === null ||
      (typeof item.repairParentTier === 'string' && ENGINE_TIERS.has(item.repairParentTier as EngineTier))) &&
    typeof item.repairParentObjectiveHash === 'string' &&
    /^[a-f0-9]{64}$/.test(item.repairParentObjectiveHash)
  );
}

function isWorkItemLike(value: unknown): value is WorkItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkItem>;
  return (
    typeof item.id === 'string' &&
    typeof item.repo === 'string' &&
    typeof item.source === 'string' &&
    typeof item.title === 'string' &&
    typeof item.detail === 'string' &&
    typeof item.value === 'number' &&
    typeof item.effort === 'number' &&
    typeof item.score === 'number' &&
    Array.isArray(item.tags) &&
    item.tags.every((tag) => typeof tag === 'string') &&
    typeof item.ts === 'string' &&
    validRepairParentMetadata(item)
  );
}

function sanitizeStrictWorkItem(value: unknown): WorkItem | null {
  if (!isWorkItemLike(value)) return null;
  if (!(value.id.length > 0 && value.id.length <= 180 &&
    isAbsolute(value.repo) && value.repo.length <= 4096 &&
    WORK_SOURCES.has(value.source) &&
    value.title.length > 0 && value.title.length <= 240 &&
    value.detail.length > 0 && value.detail.length <= 4_000 &&
    Number.isInteger(value.value) && value.value >= 1 && value.value <= 5 &&
    Number.isInteger(value.effort) && value.effort >= 1 && value.effort <= 5 &&
    Number.isFinite(value.score) && value.score >= 0 && value.score <= 25 &&
    value.tags.length <= 50 && value.tags.every((tag) => tag.length > 0 && tag.length <= 80) &&
    value.ts.length <= 40 && Number.isFinite(Date.parse(value.ts)))) return null;

  const hasHandoff = value.repairHandoffId !== undefined || value.repairGenerationId !== undefined;
  if (value.source === 'invent' && (hasHandoff || value.repairParentItemId !== undefined)) return null;
  if (hasHandoff && !(
    typeof value.repairHandoffId === 'string' && value.repairHandoffId.length > 0 && value.repairHandoffId.length <= 180 &&
    typeof value.repairGenerationId === 'string' && value.repairGenerationId.length > 0 && value.repairGenerationId.length <= 180
  )) return null;
  const treatmentMetadataPresent = value.repairTreatmentUnitId !== undefined || value.repairTreatment !== undefined;
  if (treatmentMetadataPresent && (
    typeof value.repairTreatmentUnitId !== 'string' || !/^[a-f0-9]{64}$/.test(value.repairTreatmentUnitId) ||
    !REPAIR_TREATMENTS.has(value.repairTreatment as RepairTreatment) ||
    !/:proposal-repair-nodiff:[0-9a-f]{12}$/i.test(value.id) ||
    !value.tags.includes('diagnostic-reslice') ||
    typeof value.repairParentItemId !== 'string' ||
    typeof value.repairParentObjectiveHash !== 'string' ||
    repairTreatmentUnitId({
      kind: 'no-diff-reslice',
      repo: value.repo,
      parentItemId: value.repairParentItemId,
      parentObjectiveHash: value.repairParentObjectiveHash,
    }) !== value.repairTreatmentUnitId ||
    repairTreatmentForUnitId(value.repairTreatmentUnitId) !== value.repairTreatment
  )) return null;

  return {
    id: value.id,
    repo: resolve(value.repo),
    source: value.source,
    title: value.title,
    detail: value.detail,
    value: value.value,
    effort: value.effort,
    score: value.score,
    tags: [...value.tags],
    ts: value.ts,
    ...(value.repairHandoffId !== undefined ? { repairHandoffId: value.repairHandoffId } : {}),
    ...(value.repairGenerationId !== undefined ? { repairGenerationId: value.repairGenerationId } : {}),
    ...(value.repairTreatmentUnitId !== undefined ? { repairTreatmentUnitId: value.repairTreatmentUnitId } : {}),
    ...(value.repairTreatment !== undefined ? { repairTreatment: value.repairTreatment } : {}),
    ...(value.repairParentItemId !== undefined ? { repairParentItemId: value.repairParentItemId } : {}),
    ...(value.repairParentSource !== undefined ? { repairParentSource: value.repairParentSource } : {}),
    ...(value.repairParentBackend !== undefined ? { repairParentBackend: value.repairParentBackend } : {}),
    ...(value.repairParentTier !== undefined ? { repairParentTier: value.repairParentTier } : {}),
    ...(value.repairParentObjectiveHash !== undefined ? { repairParentObjectiveHash: value.repairParentObjectiveHash } : {}),
  };
}

function readWorkItemsFile(filePath: string): WorkItem[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (Array.isArray(raw)) return raw.filter(isWorkItemLike);
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { items?: unknown }).items)
    ) {
      return (raw as { items: unknown[] }).items.filter(isWorkItemLike);
    }
    return [];
  } catch {
    return [];
  }
}

interface StrictWorkItemsFileRead {
  state: 'complete' | 'missing' | 'unavailable';
  items: WorkItem[];
  rowsScanned: number;
  limitExceeded: boolean;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs;
}

function strictUnavailable(rowsScanned = 0, limitExceeded = false): StrictWorkItemsFileRead {
  return { state: 'unavailable', items: [], rowsScanned, limitExceeded };
}

function readWorkItemsFileStrict(filePath: string): StrictWorkItemsFileRead {
  let before: BigIntStats;
  try {
    before = lstatSync(filePath, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing', items: [], rowsScanned: 0, limitExceeded: false }
      : strictUnavailable();
  }
  if (before.isSymbolicLink() || !before.isFile()) return strictUnavailable();
  if (before.nlink !== 1n) return strictUnavailable();
  if (process.platform !== 'win32') {
    const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
    if (
      (currentUid !== null && before.uid !== currentUid) ||
      (before.mode & 0o400n) === 0n ||
      (before.mode & 0o022n) !== 0n
    ) return strictUnavailable();
  }
  if (before.size > BigInt(MAX_QUEUED_AUTONOMY_FILE_BYTES)) return strictUnavailable(0, true);

  let fd: number | undefined;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!openedBefore.isFile() || !sameFileSnapshot(before, openedBefore)) return strictUnavailable();

    const size = Number(openedBefore.size);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
      if (bytesRead <= 0) return strictUnavailable();
      offset += bytesRead;
    }

    const openedAfter = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(filePath, { bigint: true });
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameFileSnapshot(openedBefore, openedAfter) ||
      !sameFileSnapshot(openedAfter, pathAfter)
    ) return strictUnavailable();

    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    } catch {
      return strictUnavailable();
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
        ? (parsed as { items: unknown[] }).items
        : undefined;
    if (!rows) return strictUnavailable();
    if (rows.length > MAX_QUEUED_AUTONOMY_ROWS_PER_FILE) {
      return strictUnavailable(MAX_QUEUED_AUTONOMY_ROWS_PER_FILE, true);
    }
    const items = rows.map(sanitizeStrictWorkItem);
    if (items.some((item) => item === null)) return strictUnavailable(rows.length);
    return { state: 'complete', items: items as WorkItem[], rowsScanned: rows.length, limitExceeded: false };
  } catch {
    return strictUnavailable();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort read */ }
    }
  }
}

function isQueuedAutonomyItem(item: WorkItem): boolean {
  if (item.source === 'invent') return true;
  if (!item.tags.includes('self-heal')) return false;
  const generationId = generatedRepairGenerationId(item);
  if ((item.repairHandoffId !== undefined || item.repairGenerationId !== undefined) && !generationId) return false;
  const maxAgeMs = item.tags.includes('rejected-capture-recovery')
    ? REJECTED_CAPTURE_REPAIR_MAX_AGE_MS
    : generationId
      ? Number.MAX_SAFE_INTEGER
      : undefined;
  return isActionableSelfHealItem(item, maxAgeMs === undefined ? undefined : { maxAgeMs });
}

/** Return all queued self-heal/invent items without mutating any state. */
export function loadQueuedAutonomyItems(): WorkItem[] {
  const root = join(homedir(), '.ashlr');
  const queued = [
    ...readWorkItemsFile(join(root, 'self-heal-queue.json')),
    ...readWorkItemsFile(join(root, 'backlog.json')),
  ];
  const seen = new Set<string>();
  const result: WorkItem[] = [];
  for (const item of queued) {
    if (!isQueuedAutonomyItem(item)) continue;
    const key = `${resolve(item.repo)}\0${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * Strictly read the complete queued-autonomy corpus. Missing files are a
 * complete empty observation; any unsafe or invalid present file fails closed.
 */
export function loadQueuedAutonomyItemsDetailed(): QueuedAutonomyReadResult {
  const root = join(homedir(), '.ashlr');
  const lock = acquireLocalStoreLock(join(root, '.self-heal-queue.lock'));
  if (!lock) {
    return {
      items: [],
      sourceState: 'unavailable',
      filesPresent: 0,
      filesMissing: 0,
      filesUnavailable: QUEUED_AUTONOMY_FILES.length,
      rowsScanned: 0,
      itemsLoaded: 0,
      limitExceeded: false,
    };
  }
  let reads: StrictWorkItemsFileRead[];
  try {
    reads = QUEUED_AUTONOMY_FILES.map((file) => readWorkItemsFileStrict(join(root, file)));
  } finally {
    releaseLocalStoreLock(lock);
  }
  const filesPresent = reads.filter((read) => read.state !== 'missing').length;
  const filesMissing = reads.length - filesPresent;
  const filesUnavailable = reads.filter((read) => read.state === 'unavailable').length;
  const rowsScanned = reads.reduce((total, read) => total + read.rowsScanned, 0);
  const limitExceeded = reads.some((read) => read.limitExceeded);
  const seen = new Set<string>();
  const items: WorkItem[] = [];
  for (const read of reads) {
    if (read.state !== 'complete') continue;
    for (const item of read.items) {
      if (!isQueuedAutonomyItem(item)) continue;
      const key = `${resolve(item.repo)}\0${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return {
    items,
    sourceState: filesUnavailable > 0 ? 'unavailable' : 'complete',
    filesPresent,
    filesMissing,
    filesUnavailable,
    rowsScanned,
    itemsLoaded: items.length,
    limitExceeded,
  };
}

/** Return queued self-heal/invent work for a single enrolled repo. */
export function loadQueuedAutonomyItemsForRepo(repo: string, limit = 25): WorkItem[] {
  const repoKey = resolve(repo);
  const result: WorkItem[] = [];
  for (const item of loadQueuedAutonomyItems()) {
    if (resolve(item.repo) !== repoKey) continue;
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}
