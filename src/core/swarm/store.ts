/**
 * Swarm persistence store.
 *
 * Provides atomic-replacement persistence for SwarmRun records under
 * ~/.ashlr/swarms/.
 * All functions are synchronous (matching the RunState/config store pattern),
 * never throw, and never carry secret values in any logged/persisted output.
 *
 * Layout:
 *   ~/.ashlr/swarms/<id>.json   — pretty-printed SwarmRun (one file per run)
 *
 * Atomic write strategy: write to a collision-resistant .tmp sibling, then
 * rename over the target. If replacement fails, the prior record remains
 * untouched and the temporary file is removed.
 */

import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

import type { SwarmRun, SwarmTaskRun } from '../types.js';
import {
  assureStableRegularFiles,
  openStableDirectoryGuard,
  readStableRegularFile,
  type StableFileReadFailureReason,
} from '../util/stable-file-read.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import {
  addPersistenceMarker,
  bindPersistenceSnapshot,
  persistenceDigest,
  persistenceSnapshot,
  stripPersistenceMarker,
} from '../util/persistence-generation.js';
import {
  acquireCaseFoldedOwnership,
  CaseFoldedOwnershipConflictError,
  completeCaseFoldedOwnership,
  isCaseFoldedOwnershipMetadataEntry,
  MAX_CASE_OWNERSHIP_METADATA_ENTRIES,
  type CaseOwnershipClaim,
} from '../util/case-folded-ownership.js';

// ---------------------------------------------------------------------------
// Bounded list cap — never read more than this many swarm files at once.
// Prevents pathological I/O if the directory grows very large.
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 10_000;
const DEFAULT_MAX_CANDIDATES = DEFAULT_MAX_DIRECTORY_ENTRIES;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const MAX_PERSISTED_SWARM_BYTES = 64 * 1024 * 1024;

export type SwarmListStopReason =
  | 'directory-limit'
  | 'candidate-limit'
  | 'invalid-file'
  | 'per-file-byte-limit'
  | 'byte-limit'
  | 'unsafe-path'
  | 'unsafe-file'
  | 'changed-during-read'
  | 'io-error';

export interface ListSwarmsOptions {
  limit?: number;
  maxDirectoryEntries?: number;
  maxCandidates?: number;
  maxBytes?: number;
  maxFileBytes?: number;
}

export interface ListSwarmsDetailedResult {
  swarms: SwarmRun[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: SwarmListStopReason[];
  entriesExamined: number;
  filesDiscovered: number;
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  unreadableFiles: number;
  oversizedFiles: number;
}

// New task statuses must remain safe when a persisted run is read by an older
// Ashlr version. `pending` makes readers that predate explicit cancellation
// safely re-execute the task. The private snapshot keeps current-reader truth
// without exposing stale completion fields to the legacy task record.
const TASK_CANCELLED_MARKER = '_ashlrCancelled' as const;
const TASK_CANCELLED_SNAPSHOT_VERSION = 1 as const;

type CancelledTaskSnapshot = {
  version: typeof TASK_CANCELLED_SNAPSHOT_VERSION;
  task: SwarmTaskRun;
};

type PersistedSwarmTaskRun = Omit<SwarmTaskRun, 'status'> & {
  status: Exclude<SwarmTaskRun['status'], 'cancelled'>;
  [TASK_CANCELLED_MARKER]?: true | CancelledTaskSnapshot;
};

type PersistedSwarmRun = Omit<SwarmRun, 'tasks'> & {
  tasks: PersistedSwarmTaskRun[];
};

// ---------------------------------------------------------------------------
// swarmsDir
// ---------------------------------------------------------------------------

/**
 * Absolute path to the swarms persistence directory: `~/.ashlr/swarms`.
 * Re-resolved from `homedir()` on every call so tests that mutate HOME work.
 */
export function swarmsDir(): string {
  return join(homedir(), '.ashlr', 'swarms');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ensure the swarms directory exists with owner-only access. */
function ensureDir(dir: string): void {
  const root = join(homedir(), '.ashlr');
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  if (!lstatSync(root).isDirectory()) {
    throw new Error(`Refusing non-directory Ashlr state root: ${root}`);
  }
  chmodSync(root, 0o700);

  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) {
    throw new Error(`Refusing non-directory swarm store: ${dir}`);
  }
  chmodSync(dir, 0o700);
}

/**
 * Return the absolute path for a swarm record by id.
 *
 * Validates the id charset (mirrors orchestrator.ts runFilePath) so the store
 * is self-defending against path traversal / separator injection regardless of
 * how a caller derived the id (e.g. GET /api/swarm/:id). Allowed: word chars,
 * dot, hyphen. Anything else throws.
 */
function swarmPath(dir: string, id: string): string {
  if (!/^[\w.-]+$/.test(id)) {
    throw new Error('Invalid swarm id');
  }
  return join(dir, `${id}.json`);
}

function secureExistingSwarmDir(dir: string): boolean {
  const root = join(homedir(), '.ashlr');
  if (
    !existsSync(root) ||
    !lstatSync(root).isDirectory() ||
    !existsSync(dir) ||
    !lstatSync(dir).isDirectory()
  ) return false;
  return true;
}

function stateRoot(): string {
  return join(homedir(), '.ashlr');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Minimal common read guard for both direct loads and directory listings. */
function isValidPersistedSwarm(
  value: unknown,
  expectedId: string,
): value is Record<string, unknown> {
  if (!isRecord(value) || !/^[\w.-]+$/.test(expectedId)) return false;

  const tasks = value['tasks'];
  return (
    value['id'] === expectedId &&
    Array.isArray(tasks) &&
    tasks.every(isRecord)
  );
}

/** Build a downgrade-safe persistence copy without mutating caller state. */
function prepareForPersistence(swarm: SwarmRun): PersistedSwarmRun {
  return {
    ...swarm,
    tasks: swarm.tasks.map((task) => {
      const {
        [TASK_CANCELLED_MARKER]: _persistedMarker,
        ...semanticTask
      } = task as SwarmTaskRun & { [TASK_CANCELLED_MARKER]?: unknown };

      if (task.status !== 'cancelled') {
        return semanticTask as PersistedSwarmTaskRun;
      }

      const {
        result: _result,
        usage: _usage,
        error: _error,
        signature: _signature,
        ...legacyTask
      } = semanticTask;

      return {
        ...legacyTask,
        status: 'pending',
        [TASK_CANCELLED_MARKER]: {
          version: TASK_CANCELLED_SNAPSHOT_VERSION,
          task: semanticTask,
        },
      };
    }),
  };
}

function cancelledTaskFromSnapshot(
  value: unknown,
  publicTask: Record<string, unknown>,
): SwarmTaskRun | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const snapshot = value as Record<string, unknown>;
  const task = snapshot['task'];
  if (
    snapshot['version'] !== TASK_CANCELLED_SNAPSHOT_VERSION ||
    typeof task !== 'object' ||
    task === null ||
    Array.isArray(task)
  ) {
    return null;
  }

  const snapshotTask = task as Record<string, unknown>;
  if (
    snapshotTask['status'] !== 'cancelled' ||
    snapshotTask['id'] !== publicTask['id'] ||
    snapshotTask['phase'] !== publicTask['phase']
  ) {
    return null;
  }

  const {
    [TASK_CANCELLED_MARKER]: _nestedMarker,
    ...semanticTask
  } = snapshotTask;
  return semanticTask as unknown as SwarmTaskRun;
}

/** Restore the current semantic status and hide the persistence-only marker. */
function rehydrateFromPersistence(parsed: Record<string, unknown>): SwarmRun {
  if (!Array.isArray(parsed['tasks'])) {
    return parsed as unknown as SwarmRun;
  }

  const tasks = parsed['tasks'].map((task: unknown) => {
    if (typeof task !== 'object' || task === null || Array.isArray(task)) {
      return task;
    }

    const record = task as Record<string, unknown>;
    const {
      [TASK_CANCELLED_MARKER]: persistedMarker,
      ...publicTask
    } = record;

    // A legacy reader that has started or completed this task is authoritative.
    // Never let a preserved private snapshot overwrite its newer public state.
    if (publicTask['status'] !== 'pending') {
      return publicTask;
    }

    const snapshotTask = cancelledTaskFromSnapshot(persistedMarker, publicTask);
    if (snapshotTask !== null) {
      return snapshotTask;
    }

    // Read the boolean encoding emitted by the immediately preceding release.
    return persistedMarker === true
      ? { ...publicTask, status: 'cancelled' }
      : publicTask;
  });

  return { ...parsed, tasks } as unknown as SwarmRun;
}

function parsePersistedSwarm(raw: string, expectedId: string): SwarmRun | null {
  const parsed: unknown = JSON.parse(raw);
  if (!isValidPersistedSwarm(parsed, expectedId)) return null;
  const persisted = stripPersistenceMarker(parsed);
  const swarm = rehydrateFromPersistence(persisted.record);
  bindPersistenceSnapshot(swarm, raw, persisted.revision);
  return swarm;
}

// ---------------------------------------------------------------------------
// saveSwarm
// ---------------------------------------------------------------------------

/**
 * Persist a SwarmRun record to disk.
 *
 * Strategy:
 *   1. Ensure the swarms directory exists.
 *   2. Serialize to pretty-printed JSON (trailing newline for POSIX hygiene).
 *   3. Exclusively write to a collision-resistant `.tmp` sibling file.
 *   4. Rename the `.tmp` over the target path (atomic on POSIX).
 *   5. Clean up the temporary file whether replacement succeeds or fails.
 *
 * Never throws. The discriminated result lets each mutation boundary surface
 * generation conflicts and storage failures without exception-based store I/O.
 */
export type SwarmSaveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'conflict' | 'invalid' | 'unavailable' };

export function saveSwarm(s: SwarmRun): SwarmSaveResult {
  let semantic: PersistedSwarmRun;
  try {
    semantic = prepareForPersistence(s);
    const semanticPayload = JSON.stringify(semantic, null, 2) + '\n';
    if (Buffer.byteLength(semanticPayload, 'utf8') > MAX_PERSISTED_SWARM_BYTES) {
      return { ok: false, reason: 'invalid' };
    }
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  let tmp: string | undefined;
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  let ownershipClaim: CaseOwnershipClaim | null = null;
  try {
    const dir = swarmsDir();
    ensureDir(dir);

    const target = swarmPath(dir, s.id);
    const foldedId = createHash('sha256').update(s.id.toLowerCase()).digest('hex');
    lock = acquireLocalStoreLock(join(dir, `.write-lock-${foldedId}`));
    if (!lock) return { ok: false, reason: 'unavailable' };
    ownershipClaim = acquireCaseFoldedOwnership({
      anchorPath: stateRoot(),
      storeDir: dir,
      recordFile: target,
      id: s.id,
      label: 'Swarm',
    });

    let currentRaw: string | null = null;
    try {
      lstatSync(target);
      const loaded = readStableRegularFile(target, {
        anchorPath: stateRoot(),
        maxFileBytes: MAX_PERSISTED_SWARM_BYTES,
        remainingBytes: MAX_PERSISTED_SWARM_BYTES,
      });
      if (!loaded.ok) return { ok: false, reason: 'unavailable' };
      currentRaw = loaded.text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, reason: 'unavailable' };
      }
    }

    const expected = persistenceSnapshot(s);
    if (
      (currentRaw === null && expected !== undefined) ||
      (currentRaw !== null && (expected === undefined || persistenceDigest(currentRaw) !== expected.digest))
    ) {
      return { ok: false, reason: 'conflict' };
    }

    let currentRevision = 0;
    if (currentRaw !== null) {
      const parsed: unknown = JSON.parse(currentRaw);
      if (!isRecord(parsed)) return { ok: false, reason: 'unavailable' };
      currentRevision = stripPersistenceMarker(parsed).revision;
    }
    const revision = currentRevision + 1;
    const json = JSON.stringify(addPersistenceMarker(
      semantic as unknown as Record<string, unknown>,
      revision,
    ), null, 2) + '\n';
    if (Buffer.byteLength(json, 'utf8') > MAX_PERSISTED_SWARM_BYTES) {
      return { ok: false, reason: 'invalid' };
    }

    tmp = `${target}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    writeFileSync(tmp, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(tmp, target);
    tmp = undefined;
    completeCaseFoldedOwnership(ownershipClaim);
    ownershipClaim = null;
    bindPersistenceSnapshot(s, json, revision);
    return { ok: true, revision };
  } catch (error) {
    return error instanceof CaseFoldedOwnershipConflictError
      ? { ok: false, reason: 'conflict' }
      : { ok: false, reason: 'unavailable' };
  } finally {
    if (tmp !== undefined) {
      try {
        unlinkSync(tmp);
      } catch {
        // The rename succeeded or cleanup is not possible; never throw.
      }
    }
    releaseLocalStoreLock(lock);
  }
}

// ---------------------------------------------------------------------------
// loadSwarm
// ---------------------------------------------------------------------------

/**
 * Load and deserialise a single SwarmRun by id.
 *
 * Returns `null` when the record does not exist, cannot be read, or fails to
 * parse as a valid-looking SwarmRun.  Never throws.
 */
export function loadSwarm(id: string): SwarmRun | null {
  try {
    const dir = swarmsDir();
    const path = swarmPath(dir, id);

    if (!secureExistingSwarmDir(dir)) {
      return null;
    }

    const loaded = readStableRegularFile(path, {
      anchorPath: stateRoot(),
      maxFileBytes: MAX_PERSISTED_SWARM_BYTES,
      remainingBytes: MAX_PERSISTED_SWARM_BYTES,
    });
    if (!loaded.ok) return null;

    return parsePersistedSwarm(loaded.text, id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// listSwarms
// ---------------------------------------------------------------------------

function boundedOption(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function emptyDetailed(
  sourceState: ListSwarmsDetailedResult['sourceState'],
  overrides: Partial<ListSwarmsDetailedResult> = {},
): ListSwarmsDetailedResult {
  return {
    swarms: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    entriesExamined: 0,
    filesDiscovered: 0,
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
    oversizedFiles: 0,
    ...overrides,
  };
}

function pushStopReason(
  reasons: SwarmListStopReason[],
  reason: SwarmListStopReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function markReadFailure(
  result: ListSwarmsDetailedResult,
  reason: StableFileReadFailureReason,
): void {
  result.sourceState = 'degraded';
  pushStopReason(result.stopReasons, reason);
  if (reason === 'per-file-byte-limit') {
    result.oversizedFiles += 1;
  } else if (reason !== 'byte-limit') {
    result.unreadableFiles += 1;
  }
  result.complete = false;
}

interface SwarmFileCandidate {
  file: string;
  mtimeMs: number;
}

/**
 * Read a bounded, provenance-aware snapshot of recent persisted swarms.
 * Invalid records never consume the requested valid-record limit.
 */
function listSwarmsDetailedUnsafe(
  options: ListSwarmsOptions = {},
): ListSwarmsDetailedResult {
  const limit = boundedOption(options.limit, DEFAULT_LIST_LIMIT);
  const maxDirectoryEntries = boundedOption(
    options.maxDirectoryEntries,
    DEFAULT_MAX_DIRECTORY_ENTRIES,
  );
  const maxCandidates = boundedOption(options.maxCandidates, DEFAULT_MAX_CANDIDATES);
  const maxBytes = boundedOption(options.maxBytes, DEFAULT_MAX_BYTES);
  const maxFileBytes = boundedOption(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);

  const dir = swarmsDir();
  const directoryGuard = openStableDirectoryGuard(dir, { anchorPath: stateRoot() });
  if (!directoryGuard.ok) {
    return directoryGuard.reason === 'missing'
      ? emptyDetailed('missing')
      : emptyDetailed('degraded', {
          complete: false,
          stopReasons: [directoryGuard.reason],
          unreadableFiles: 1,
        });
  }

  const result = emptyDetailed('healthy');
  const candidates: SwarmFileCandidate[] = [];
  let ownershipMetadataEntries = 0;
  let directory;
  try {
    directory = opendirSync(dir);
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (isCaseFoldedOwnershipMetadataEntry(entry.name)) {
        ownershipMetadataEntries += 1;
        if (ownershipMetadataEntries > MAX_CASE_OWNERSHIP_METADATA_ENTRIES) {
          result.complete = false;
          result.sourceState = 'degraded';
          pushStopReason(result.stopReasons, 'directory-limit');
          break;
        }
        continue;
      }
      if (result.entriesExamined >= maxDirectoryEntries) {
        result.complete = false;
        result.sourceState = 'degraded';
        pushStopReason(result.stopReasons, 'directory-limit');
        break;
      }
      result.entriesExamined += 1;
      if (!entry.name.endsWith('.json')) continue;
      const expectedId = entry.name.slice(0, -'.json'.length);
      if (!/^[\w.-]+$/.test(expectedId)) {
        result.invalidFiles += 1;
        result.sourceState = 'degraded';
        pushStopReason(result.stopReasons, 'invalid-file');
        continue;
      }
      try {
        const stat = lstatSync(join(dir, entry.name));
        candidates.push({ file: entry.name, mtimeMs: stat.mtimeMs });
      } catch {
        result.unreadableFiles += 1;
        result.sourceState = 'degraded';
        result.complete = false;
        pushStopReason(result.stopReasons, 'io-error');
      }
    }
  } catch {
    result.complete = false;
    result.sourceState = 'degraded';
    result.unreadableFiles += 1;
    pushStopReason(result.stopReasons, 'io-error');
  } finally {
    try { directory?.closeSync(); } catch { /* never throw from observational reads */ }
  }

  const directoryFailure = directoryGuard.finish();
  if (directoryFailure !== null) {
    return emptyDetailed('degraded', {
      complete: false,
      stopReasons: [directoryFailure],
      entriesExamined: result.entriesExamined,
      filesDiscovered: candidates.length,
      unreadableFiles: result.unreadableFiles + 1,
    });
  }

  candidates.sort((left, right) =>
    right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file));
  result.filesDiscovered = candidates.length;
  const selected = candidates.slice(0, maxCandidates);
  if (candidates.length > selected.length) {
    result.complete = false;
    result.sourceState = 'degraded';
    pushStopReason(result.stopReasons, 'candidate-limit');
  }

  let byteLimitReached = false;
  for (let batchStart = 0; batchStart < selected.length; batchStart += 512) {
    const batch = selected.slice(batchStart, batchStart + 512);
    const batchAssurance = assureStableRegularFiles(
      batch.map((candidate) => join(dir, candidate.file)),
      stateRoot(),
    );
    if (!batchAssurance.ok) {
      return emptyDetailed('degraded', {
        complete: false,
        stopReasons: [batchAssurance.reason],
        entriesExamined: result.entriesExamined,
        filesDiscovered: result.filesDiscovered,
        unreadableFiles: batch.length,
      });
    }

    for (const candidate of batch) {
      const remainingBytes = maxBytes - result.bytesRead;
      if (remainingBytes <= 0) {
        result.complete = false;
        result.sourceState = 'degraded';
        pushStopReason(result.stopReasons, 'byte-limit');
        byteLimitReached = true;
        break;
      }

      result.filesRead += 1;
      const loaded = readStableRegularFile(join(dir, candidate.file), {
        anchorPath: stateRoot(),
        maxFileBytes,
        remainingBytes,
        batchAssurance: batchAssurance.token,
      });
      if (!loaded.ok) {
        markReadFailure(result, loaded.reason);
        if (loaded.reason === 'byte-limit') {
          byteLimitReached = true;
          break;
        }
        continue;
      }
      result.bytesRead += loaded.bytesRead;

      try {
        const expectedId = candidate.file.slice(0, -'.json'.length);
        const parsed = parsePersistedSwarm(loaded.text, expectedId);
        if (!parsed) {
          result.invalidFiles += 1;
          result.sourceState = 'degraded';
          pushStopReason(result.stopReasons, 'invalid-file');
          continue;
        }
        result.swarms.push(parsed);
      } catch {
        result.invalidFiles += 1;
        result.sourceState = 'degraded';
        pushStopReason(result.stopReasons, 'invalid-file');
      }
    }
    if (byteLimitReached) break;
  }

  result.swarms.sort((left, right) => {
    const leftUpdated = Date.parse(left.updatedAt);
    const rightUpdated = Date.parse(right.updatedAt);
    const leftFreshness = Number.isFinite(leftUpdated)
      ? leftUpdated
      : Date.parse(left.createdAt);
    const rightFreshness = Number.isFinite(rightUpdated)
      ? rightUpdated
      : Date.parse(right.createdAt);
    const normalizedLeft = Number.isFinite(leftFreshness)
      ? leftFreshness
      : Number.NEGATIVE_INFINITY;
    const normalizedRight = Number.isFinite(rightFreshness)
      ? rightFreshness
      : Number.NEGATIVE_INFINITY;
    const freshness = normalizedRight - normalizedLeft;
    return freshness || left.id.localeCompare(right.id);
  });
  result.swarms = result.swarms.slice(0, limit);
  return result;
}

export function listSwarmsDetailed(
  options: ListSwarmsOptions = {},
): ListSwarmsDetailedResult {
  try {
    return listSwarmsDetailedUnsafe(options);
  } catch {
    return emptyDetailed('degraded', {
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
  }
}

/**
 * List recent persisted SwarmRun records, sorted by `updatedAt` and id.
 *
 * Uses the same bounded defaults as `listSwarmsDetailed`.
 * - Never throws.
 */
export function listSwarms(options: ListSwarmsOptions = {}): SwarmRun[] {
  try {
    return listSwarmsDetailed(options).swarms;
  } catch {
    return [];
  }
}
