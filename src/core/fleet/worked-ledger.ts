/**
 * worked-ledger.ts — M85: per-item worked-outcome ledger.
 *
 * Tracks whether each WorkItem produced a real diff ('diff') or an empty run
 * ('empty') so the daemon can skip recently-declined items and avoid re-clogging
 * on work that has already been attempted with no result.
 *
 * Persistence discipline mirrors quota.ts EXACTLY:
 *  - Atomic writes (tmp file + POSIX rename).
 *  - NEVER throws — load returns a fresh empty ledger on missing/corrupt file;
 *    record swallows any persistence error.
 *  - mkdir -p the parent dir.
 *  - Bounded history (last ~2000 entries).
 *  - Homedir re-resolved at call time so tests can relocate HOME.
 *
 * No new runtime deps; node builtins only.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of outcome events retained in worked.json. */
const MAX_EVENTS = 2000;

/** Default cooldown window: 6 hours in milliseconds. */
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** The outcome of a single item run. */
export type WorkedOutcome = 'diff' | 'empty';

/** A single recorded item outcome. */
export interface WorkedEvent {
  /** The WorkItem id that was run. */
  itemId: string;
  /** Whether the run produced a real diff ('diff') or nothing ('empty'). */
  outcome: WorkedOutcome;
  /** ISO timestamp of the outcome. */
  ts: string;
}

/** The persisted worked ledger. */
export interface WorkedLedger {
  /** Bounded list of recent outcome events (oldest first). */
  events: WorkedEvent[];
}

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

function fleetDir(): string {
  return join(homedir(), '.ashlr', 'fleet');
}

/** Absolute path to the fleet worked ledger file. */
export function workedLedgerPath(): string {
  return join(fleetDir(), 'worked.json');
}

// ---------------------------------------------------------------------------
// Fresh default
// ---------------------------------------------------------------------------

function freshLedger(): WorkedLedger {
  return { events: [] };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read and parse workedLedgerPath(). NEVER throws.
 * Returns a fresh empty ledger when the file is missing or malformed.
 */
export function loadWorkedLedger(): WorkedLedger {
  const p = workedLedgerPath();
  if (!existsSync(p)) return freshLedger();
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return freshLedger();
    }
    const obj = parsed as Record<string, unknown>;
    const events = Array.isArray(obj['events'])
      ? (obj['events'] as unknown[]).filter(
          (e): e is WorkedEvent =>
            typeof e === 'object' &&
            e !== null &&
            !Array.isArray(e) &&
            typeof (e as Record<string, unknown>)['itemId'] === 'string' &&
            typeof (e as Record<string, unknown>)['outcome'] === 'string' &&
            typeof (e as Record<string, unknown>)['ts'] === 'string' &&
            ((e as Record<string, unknown>)['outcome'] === 'diff' ||
              (e as Record<string, unknown>)['outcome'] === 'empty'),
        )
      : [];
    return { events };
  } catch {
    // Corrupt JSON or any other read error — return a fresh empty ledger.
    return freshLedger();
  }
}

// ---------------------------------------------------------------------------
// Save (atomic) — internal
// ---------------------------------------------------------------------------

/**
 * Atomically write the ledger via tmp-file + rename (POSIX-atomic).
 * Creates ~/.ashlr/fleet recursively. Bounds events. Never throws.
 */
function saveWorkedLedger(l: WorkedLedger): void {
  try {
    const dir = fleetDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const bounded: WorkedLedger = {
      events: l.events.slice(-MAX_EVENTS),
    };
    const dest = workedLedgerPath();
    const tmp = dest + '.tmp';
    writeFileSync(tmp, JSON.stringify(bounded, null, 2) + '\n', 'utf8');
    renameSync(tmp, dest);
  } catch {
    // Persistence failure must not crash the fleet — swallow silently.
  }
}

// ---------------------------------------------------------------------------
// Record an outcome
// ---------------------------------------------------------------------------

/**
 * Append an outcome event for `itemId` and persist. Never throws.
 *
 * @param itemId   - The WorkItem id.
 * @param outcome  - 'diff' when the run produced a real diff; 'empty' when not.
 * @param ts       - Optional ISO timestamp; defaults to now. Injectable for tests.
 */
export function recordOutcome(
  itemId: string,
  outcome: WorkedOutcome,
  ts?: string,
): void {
  try {
    const l = loadWorkedLedger();
    l.events.push({ itemId, outcome, ts: ts ?? new Date().toISOString() });
    saveWorkedLedger(l);
  } catch {
    // Never throws.
  }
}

// ---------------------------------------------------------------------------
// Cooldown check
// ---------------------------------------------------------------------------

/**
 * Returns true when the item's LAST recorded outcome was 'empty' AND that
 * outcome occurred within the last `cooldownMs` milliseconds.
 *
 * - Returns false (not declined) when the item has no recorded outcome.
 * - Returns false when the last outcome was 'diff' (real work was done).
 * - Returns false when the last 'empty' outcome is older than cooldownMs.
 * - `now` is injectable for deterministic tests (defaults to Date.now()).
 * - NEVER throws.
 */
export function recentlyDeclined(
  itemId: string,
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
  now?: number,
): boolean {
  try {
    const l = loadWorkedLedger();
    // Find the LAST event for this itemId (events are oldest-first, so scan backwards).
    let lastEvent: WorkedEvent | undefined;
    for (let i = l.events.length - 1; i >= 0; i--) {
      if (l.events[i]!.itemId === itemId) {
        lastEvent = l.events[i];
        break;
      }
    }
    if (!lastEvent) return false;
    if (lastEvent.outcome !== 'empty') return false;
    const eventMs = Date.parse(lastEvent.ts);
    if (Number.isNaN(eventMs)) return false;
    const nowMs = now ?? Date.now();
    return nowMs - eventMs < cooldownMs;
  } catch {
    // Never throws — fail open (not declined).
    return false;
  }
}
