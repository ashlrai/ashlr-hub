/**
 * core/fleet/shared-store.ts — M111: atomic shared state store for multi-machine fleets.
 *
 * Backs the SharedWorkQueueCoordinator. A single JSON file on a path visible to
 * all machines (iCloud Drive, Dropbox, NFS, etc.) serves as the rendezvous point.
 *
 * Atomicity + locking
 * -------------------
 *  - Writes: tmp-file + POSIX rename (O_EXCL-safe; avoids torn reads).
 *  - Claims: a `.lock` sentinel created with the `x` (exclusive) flag (O_EXCL).
 *    Only one writer holds the lock at a time. Stale locks (older than 2× leaseMs)
 *    are forcibly removed — this is the cross-machine failover path.
 *
 * Never-throws contract
 * ---------------------
 *  EVERY public method is try/catch-wrapped and returns a safe default on any
 *  error (missing path, permission denied, corrupt JSON, lock contention).
 *  The local fleet MUST keep working even when the shared folder is unavailable.
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';
import type { WorkedOutcome, WorkedEvent } from './worked-ledger.js';

// ---------------------------------------------------------------------------
// Shared store schema
// ---------------------------------------------------------------------------

/** One active claim (lease) held by a machine on an item. */
export interface ItemClaim {
  machineId: string;
  /** Absolute epoch ms when this lease expires; expired = reclaimable. */
  leaseUntil: number;
}

/** Cross-machine subscription/usage ledger entry (M114: cross-machine throttle). */
export interface UsageEntry {
  machineId: string;
  engine: string;
  ts: string;
  /** 0–100 subscription window utilisation at time of publish (M114). */
  usedPercent?: number;
  /** Human-readable window label, e.g. "5h", "7d" (M114). */
  windowLabel?: string;
  /** Unix epoch seconds when the window resets (M114). */
  resetsAt?: number;
}

/** The on-disk JSON schema for the shared fleet queue. */
export interface SharedFleetQueue {
  /** Active claims: itemId → claim. Expired claims are reclaimable. */
  claims: Record<string, ItemClaim>;
  /** Global worked outcomes — cross-machine cooldown. Bounded to ~2000 entries. */
  worked: WorkedEvent[];
  /** Cross-machine subscription/usage ledger. */
  usage: UsageEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_FILENAME = 'ashlr-fleet-queue.json';
const LOCK_FILENAME  = 'ashlr-fleet-queue.json.lock';
const MAX_WORKED     = 2000;
/** How long (ms) a lock file may be held before it is considered stale. */
const STALE_LOCK_MULTIPLIER = 2;
const DEFAULT_LEASE_MS = 5 * 60 * 1000; // 5 min

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyQueue(): SharedFleetQueue {
  return { claims: {}, worked: [], usage: [] };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseQueue(raw: string): SharedFleetQueue {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed)) return emptyQueue();
  const claims = isPlainObject(parsed['claims'])
    ? (parsed['claims'] as Record<string, unknown>)
    : {};
  const validClaims: Record<string, ItemClaim> = {};
  for (const [k, v] of Object.entries(claims)) {
    if (
      isPlainObject(v) &&
      typeof v['machineId'] === 'string' &&
      typeof v['leaseUntil'] === 'number'
    ) {
      validClaims[k] = { machineId: v['machineId'], leaseUntil: v['leaseUntil'] };
    }
  }
  const worked = Array.isArray(parsed['worked'])
    ? (parsed['worked'] as unknown[]).filter(
        (e): e is WorkedEvent =>
          isPlainObject(e) &&
          typeof (e as Record<string, unknown>)['itemId'] === 'string' &&
          typeof (e as Record<string, unknown>)['ts'] === 'string' &&
          ((e as Record<string, unknown>)['outcome'] === 'diff' ||
            (e as Record<string, unknown>)['outcome'] === 'empty'),
      )
    : [];
  const usage = Array.isArray(parsed['usage'])
    ? (parsed['usage'] as unknown[]).filter(
        (e): e is UsageEntry =>
          isPlainObject(e) &&
          typeof (e as Record<string, unknown>)['machineId'] === 'string' &&
          typeof (e as Record<string, unknown>)['engine'] === 'string' &&
          typeof (e as Record<string, unknown>)['ts'] === 'string',
      )
    : [];
  return { claims: validClaims, worked, usage };
}

// ---------------------------------------------------------------------------
// SharedStore
// ---------------------------------------------------------------------------

/**
 * Atomic, never-throws shared state store for multi-machine fleet coordination.
 *
 * All methods degrade safely when `dirPath` is missing or unwritable — they
 * return empty/no-op values instead of throwing.
 */
export class SharedStore {
  private readonly dirPath: string;
  private readonly leaseMs: number;

  constructor(dirPath: string, leaseMs: number = DEFAULT_LEASE_MS) {
    this.dirPath = dirPath;
    this.leaseMs = leaseMs;
  }

  private queuePath(): string {
    return join(this.dirPath, QUEUE_FILENAME);
  }

  private lockPath(): string {
    return join(this.dirPath, LOCK_FILENAME);
  }

  /** Ensure the shared directory exists. Returns false when not creatable. */
  private ensureDir(): boolean {
    try {
      if (!existsSync(this.dirPath)) {
        mkdirSync(this.dirPath, { recursive: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Read the queue from disk. Returns emptyQueue() on any error. */
  private readQueue(): SharedFleetQueue {
    try {
      const p = this.queuePath();
      if (!existsSync(p)) return emptyQueue();
      const raw = readFileSync(p, 'utf8');
      return parseQueue(raw);
    } catch {
      return emptyQueue();
    }
  }

  /**
   * Write the queue atomically (tmp + rename). Never throws.
   * Bounds worked events to MAX_WORKED.
   */
  private writeQueue(q: SharedFleetQueue): void {
    try {
      if (!this.ensureDir()) return;
      const bounded: SharedFleetQueue = {
        ...q,
        worked: q.worked.slice(-MAX_WORKED),
      };
      const dest = this.queuePath();
      const tmp = dest + '.tmp';
      writeFileSync(tmp, JSON.stringify(bounded, null, 2) + '\n', 'utf8');
      renameSync(tmp, dest);
    } catch {
      // Persistence failure must not crash the fleet.
    }
  }

  /**
   * Acquire the advisory .lock file using O_EXCL (atomic create-or-fail).
   * Removes stale locks older than 2× leaseMs. Returns true when lock was
   * acquired, false on contention or any error (fail-open for reads).
   *
   * Callers MUST call releaseLock() after acquiring.
   */
  private acquireLock(): boolean {
    try {
      if (!this.ensureDir()) return false;
      const lp = this.lockPath();
      // Remove stale lock if it exists and is old enough.
      if (existsSync(lp)) {
        try {
          const age = Date.now() - statSync(lp).mtimeMs;
          if (age > this.leaseMs * STALE_LOCK_MULTIPLIER) {
            unlinkSync(lp);
          } else {
            return false; // Lock is held by another process.
          }
        } catch {
          return false;
        }
      }
      // Create the lock file with O_EXCL — atomic on POSIX + most networked FS.
      const fd = openSync(lp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  private releaseLock(): void {
    try {
      const lp = this.lockPath();
      if (existsSync(lp)) unlinkSync(lp);
    } catch {
      // Best-effort.
    }
  }

  /**
   * Run a read-modify-write operation under the advisory lock.
   * `fn` receives the current queue and returns the modified queue.
   * If the lock cannot be acquired, returns `fallback`.
   */
  private withLock<T>(fn: (q: SharedFleetQueue) => { queue: SharedFleetQueue; result: T }, fallback: T): T {
    if (!this.acquireLock()) return fallback;
    try {
      const q = this.readQueue();
      const { queue, result } = fn(q);
      this.writeQueue(queue);
      return result;
    } finally {
      this.releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Atomically claim up to `count` unclaimed (or expired) items for `machineId`.
   * Returns the itemIds that were successfully claimed.
   * Items not in `candidates` are ignored. Never throws.
   */
  claimItems(candidateIds: string[], count: number, machineId: string): string[] {
    if (!this.ensureDir()) return [];
    return this.withLock((q) => {
      const now = Date.now();
      const claimed: string[] = [];
      for (const id of candidateIds) {
        if (claimed.length >= count) break;
        const existing = q.claims[id];
        // Claimable if: no existing claim, OR the lease has expired.
        if (!existing || existing.leaseUntil <= now) {
          q.claims[id] = { machineId, leaseUntil: now + this.leaseMs };
          claimed.push(id);
        }
      }
      return { queue: q, result: claimed };
    }, []);
  }

  /**
   * Release claims held by `machineId` on the given itemIds.
   * Silently ignores ids not claimed by this machine. Never throws.
   */
  releaseItems(itemIds: string[], machineId: string): void {
    if (!this.ensureDir()) return;
    this.withLock((q) => {
      for (const id of itemIds) {
        if (q.claims[id]?.machineId === machineId) {
          delete q.claims[id];
        }
      }
      return { queue: q, result: undefined };
    }, undefined);
  }

  /**
   * Append a worked outcome to the global shared ledger.
   * Also releases the claim if one exists. Never throws.
   */
  recordOutcome(itemId: string, outcome: WorkedOutcome, machineId: string): void {
    if (!this.ensureDir()) return;
    this.withLock((q) => {
      q.worked.push({ itemId, outcome, ts: new Date().toISOString() });
      // Release the claim when recording the outcome.
      if (q.claims[itemId]?.machineId === machineId) {
        delete q.claims[itemId];
      }
      return { queue: q, result: undefined };
    }, undefined);
  }

  /**
   * Returns true when the item's last global outcome was 'empty' AND was
   * recorded within the last `cooldownMs` ms. Never throws.
   */
  recentlyDeclined(itemId: string, cooldownMs: number, now?: number): boolean {
    try {
      const q = this.readQueue();
      let last: WorkedEvent | undefined;
      for (let i = q.worked.length - 1; i >= 0; i--) {
        if (q.worked[i]!.itemId === itemId) {
          last = q.worked[i];
          break;
        }
      }
      if (!last || last.outcome !== 'empty') return false;
      const eventMs = Date.parse(last.ts);
      if (Number.isNaN(eventMs)) return false;
      return (now ?? Date.now()) - eventMs < cooldownMs;
    } catch {
      return false;
    }
  }

  /**
   * Append a usage entry to the cross-machine subscription/usage ledger.
   * Called by the subscription-usage agent (other agent wires this). Never throws.
   */
  recordUsage(machineId: string, engine: string): void {
    if (!this.ensureDir()) return;
    this.withLock((q) => {
      q.usage.push({ machineId, engine, ts: new Date().toISOString() });
      return { queue: q, result: undefined };
    }, undefined);
  }

  /**
   * M114: Publish this machine's current subscription utilisation for `engine`.
   * Upserts (replaces any prior entry for machineId+engine) so the ledger holds
   * only the freshest reading per machine. Never throws.
   */
  publishUsage(entry: UsageEntry): void {
    try {
      if (!this.ensureDir()) return;
      this.withLock((q) => {
        // Upsert: replace the most-recent entry for this machineId+engine pair.
        let idx = -1;
        for (let i = q.usage.length - 1; i >= 0; i--) {
          const e = q.usage[i]!;
          if (e.machineId === entry.machineId && e.engine === entry.engine) {
            idx = i;
            break;
          }
        }
        if (idx !== -1) {
          q.usage.splice(idx, 1);
        }
        q.usage.push(entry);
        return { queue: q, result: undefined };
      }, undefined);
    } catch {
      // Best-effort — never propagate.
    }
  }

  /**
   * M114: Read all usage entries for a given engine, optionally filtered to
   * entries whose resetsAt is in the future (non-expired) and whose ts is within
   * `maxAgeMs` ms of `now`. Returns [] when the store is unavailable. Never throws.
   */
  readUsageEntries(
    engine: string,
    opts: { maxAgeMs?: number; now?: number } = {},
  ): UsageEntry[] {
    try {
      const q = this.readQueue();
      const now = opts.now ?? Date.now();
      return q.usage.filter((e) => {
        if (e.engine !== engine) return false;
        // Drop entries whose window has already reset (resetsAt is epoch seconds).
        if (e.resetsAt !== undefined && e.resetsAt * 1000 <= now) return false;
        // Drop entries older than maxAgeMs.
        if (opts.maxAgeMs !== undefined) {
          const entryMs = Date.parse(e.ts);
          if (Number.isNaN(entryMs) || now - entryMs > opts.maxAgeMs) return false;
        }
        return true;
      });
    } catch {
      return [];
    }
  }

  /**
   * Read the current queue state (no lock needed — read-only snapshot).
   * Returns emptyQueue() when the store is unavailable. Never throws.
   */
  readSnapshot(): SharedFleetQueue {
    return this.readQueue();
  }
}
