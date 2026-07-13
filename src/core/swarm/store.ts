/**
 * Swarm persistence store.
 *
 * Provides atomic-ish read/write for SwarmRun records to ~/.ashlr/swarms/.
 * All functions are synchronous (matching the RunState/config store pattern),
 * never throw, and never carry secret values in any logged/persisted output.
 *
 * Layout:
 *   ~/.ashlr/swarms/<id>.json   — pretty-printed SwarmRun (one file per run)
 *
 * Atomic-ish write strategy: write to a .tmp sibling, then rename over the
 * target.  On POSIX this is an atomic rename; on Windows it is best-effort
 * (rename over existing file may fail, in which case we fall back to a direct
 * write).  Avoids leaving a partially-written record visible to readers.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';

import type { SwarmRun, SwarmTaskRun } from '../types.js';

// ---------------------------------------------------------------------------
// Bounded list cap — never read more than this many swarm files at once.
// Prevents pathological I/O if the directory grows very large.
// ---------------------------------------------------------------------------

const MAX_LIST = 200;

// New task statuses must remain safe when a persisted run is read by an older
// Ashlr version. The boolean marker carries no user content, while `pending`
// makes readers that predate explicit cancellation safely re-execute the task.
const TASK_CANCELLED_MARKER = '_ashlrCancelled' as const;

type PersistedSwarmTaskRun = Omit<SwarmTaskRun, 'status'> & {
  status: Exclude<SwarmTaskRun['status'], 'cancelled'>;
  [TASK_CANCELLED_MARKER]?: true;
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

/** Ensure the swarms directory exists, silently creating it if needed. */
function ensureDir(dir: string): void {
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    // Best-effort; if we can't create the dir the subsequent write will fail
    // gracefully in saveSwarm's try/catch.
  }
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

      return {
        ...semanticTask,
        status: 'pending',
        [TASK_CANCELLED_MARKER]: true,
      };
    }),
  };
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
    if (record[TASK_CANCELLED_MARKER] !== true) {
      return task;
    }

    const {
      [TASK_CANCELLED_MARKER]: _persistedMarker,
      ...semanticTask
    } = record;

    return semanticTask['status'] === 'pending'
      ? { ...semanticTask, status: 'cancelled' }
      : semanticTask;
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
 *   3. Write to a `.tmp` sibling file.
 *   4. Rename the `.tmp` over the target path (atomic on POSIX).
 *   5. If the rename fails (e.g. Windows cross-device), fall back to a direct
 *      overwrite.
 *
 * Never throws; failures are silently swallowed so a persistence error never
 * crashes the swarm runner mid-execution.
 */
export function saveSwarm(s: SwarmRun): void {
  try {
    const dir = swarmsDir();
    ensureDir(dir);

    const target = swarmPath(dir, s.id);
    const tmp = `${target}.tmp`;
    const json = JSON.stringify(prepareForPersistence(s), null, 2) + '\n';

    writeFileSync(tmp, json, 'utf8');

    try {
      renameSync(tmp, target);
    } catch {
      // Rename failed (Windows cross-device, or race) — direct overwrite.
      try {
        writeFileSync(target, json, 'utf8');
      } catch {
        // Last-resort: swallow; the .tmp may be readable for recovery.
      }
    }
  } catch {
    // Never propagate persistence failures to the caller.
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

    if (!existsSync(path)) return null;

    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    // Basic shape guard: must be an object with a matching id field.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>)['id'] !== id
    ) {
      return null;
    }

    return rehydrateFromPersistence(parsed as Record<string, unknown>);
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

    if (!existsSync(dir)) return [];

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
        const raw = readFileSync(join(dir, file), 'utf8');
        const parsed: unknown = JSON.parse(raw);

        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          continue;
        }

        swarms.push(rehydrateFromPersistence(parsed as Record<string, unknown>));
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
