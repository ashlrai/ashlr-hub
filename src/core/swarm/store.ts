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
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

import type { SwarmRun, SwarmTaskRun } from '../types.js';

// ---------------------------------------------------------------------------
// Bounded list cap — never read more than this many swarm files at once.
// Prevents pathological I/O if the directory grows very large.
// ---------------------------------------------------------------------------

const MAX_LIST = 200;

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

function hasExactSwarmFilename(dir: string, file: string): boolean {
  return readdirSync(dir).includes(file);
}

function secureExistingSwarmDir(dir: string): boolean {
  const root = join(homedir(), '.ashlr');
  if (
    !existsSync(root) ||
    !lstatSync(root).isDirectory() ||
    !existsSync(dir) ||
    !lstatSync(dir).isDirectory()
  ) return false;
  chmodSync(root, 0o700);
  chmodSync(dir, 0o700);
  return true;
}

function secureExactSwarmFile(dir: string, file: string): boolean {
  if (!secureExistingSwarmDir(dir) || !hasExactSwarmFilename(dir, file)) return false;
  const persistedFile = join(dir, file);
  if (!lstatSync(persistedFile).isFile()) return false;
  chmodSync(persistedFile, 0o600);
  return true;
}

function assertCaseFoldedSwarmOwnership(dir: string, file: string, id: string): void {
  const folded = file.toLowerCase();
  const collision = readdirSync(dir).find(
    (entry) => entry !== file && entry.toLowerCase() === folded,
  );
  if (collision) {
    throw new Error(`Swarm id collides with existing persisted id: ${collision}`);
  }

  const claim = join(
    dir,
    `.id-claim-${createHash('sha256').update(id.toLowerCase()).digest('hex')}`,
  );
  try {
    writeFileSync(claim, id, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!lstatSync(claim).isFile() || readFileSync(claim, 'utf8') !== id) {
      throw new Error('Swarm id collides with an existing case-folded ownership claim');
    }
    chmodSync(claim, 0o600);
  }
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
 * Never throws; failures are silently swallowed so a persistence error never
 * crashes the swarm runner mid-execution.
 */
export function saveSwarm(s: SwarmRun): void {
  let tmp: string | undefined;
  try {
    const dir = swarmsDir();
    ensureDir(dir);

    const target = swarmPath(dir, s.id);
    assertCaseFoldedSwarmOwnership(dir, `${s.id}.json`, s.id);
    tmp = `${target}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    const json = JSON.stringify(prepareForPersistence(s), null, 2) + '\n';

    writeFileSync(tmp, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    // Never propagate persistence failures to the caller.
  } finally {
    if (tmp !== undefined) {
      try {
        unlinkSync(tmp);
      } catch {
        // The rename succeeded or cleanup is not possible; never throw.
      }
    }
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

    if (!secureExactSwarmFile(dir, `${id}.json`)) return null;

    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!isValidPersistedSwarm(parsed, id)) {
      return null;
    }

    return rehydrateFromPersistence(parsed);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// listSwarms
// ---------------------------------------------------------------------------

/**
 * List all persisted SwarmRun records, sorted by `updatedAt` descending
 * (most-recent first).
 *
 * - Reads at most `MAX_LIST` (200) files to bound I/O on large directories.
 * - Skips `.tmp` sidecars and any file that fails to parse.
 * - Never throws.
 */
export function listSwarms(): SwarmRun[] {
  try {
    const dir = swarmsDir();

    if (!secureExistingSwarmDir(dir)) return [];

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }

    // Filter to *.json (exclude .tmp sidecars and other artefacts), then cap.
    const jsonFiles = entries
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp.json'))
      .slice(0, MAX_LIST);

    const swarms: SwarmRun[] = [];

    for (const file of jsonFiles) {
      try {
        const persistedFile = join(dir, file);
        if (!lstatSync(persistedFile).isFile()) continue;
        chmodSync(persistedFile, 0o600);
        const raw = readFileSync(persistedFile, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        const expectedId = file.slice(0, -'.json'.length);

        if (!isValidPersistedSwarm(parsed, expectedId)) continue;

        swarms.push(rehydrateFromPersistence(parsed));
      } catch {
        // Skip unreadable / malformed records silently.
      }
    }

    // Sort: most-recently-updated first.
    swarms.sort((a, b) => {
      const ta = a.updatedAt ?? '';
      const tb = b.updatedAt ?? '';
      // ISO timestamps sort lexicographically; descending = b before a.
      if (tb > ta) return 1;
      if (tb < ta) return -1;
      return 0;
    });

    return swarms;
  } catch {
    return [];
  }
}
