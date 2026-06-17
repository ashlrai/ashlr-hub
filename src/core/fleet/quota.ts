/**
 * quota.ts — M46: per-backend rolling-window rate/quota ledger.
 *
 * Subscription frontier backends (Claude / Codex) are flat-fee but RATE-LIMITED
 * (not token-billed), so the fleet must throttle dispatches per backend. This
 * ledger records each dispatch and answers "how many in the last window?" and
 * "are we still under the configured cap?".
 *
 * Persistence discipline mirrors daemon/state.ts EXACTLY:
 *  - Atomic writes (tmp file + POSIX rename).
 *  - NEVER throws — load returns a fresh empty ledger on missing/corrupt file;
 *    record swallows any persistence error.
 *  - mkdir -p the parent dir.
 *  - Bounded history (last ~2000 events).
 *  - Homedir re-resolved at call time so tests can relocate HOME.
 *
 * No new runtime deps; node builtins only. evalQuota mirrors evalBudget's
 * three-level (ok/warn/over) semantics with a null-cap-disabled path.
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
import type { AshlrConfig, EngineId } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of dispatch events retained in quota.json. */
const MAX_EVENTS = 2000;

/** A single recorded backend dispatch. */
export interface FleetQuotaEvent {
  /** Backend that was dispatched. */
  backend: EngineId;
  /** ISO timestamp of the dispatch. */
  ts: string;
}

/** The persisted fleet quota ledger. */
export interface FleetQuota {
  /** Bounded list of recent dispatch events (oldest first). */
  events: FleetQuotaEvent[];
}

// ---------------------------------------------------------------------------
// windowToMs — EXTENDS rollup's vocabulary with sub-day windows (local copy)
// ---------------------------------------------------------------------------

/**
 * Convert a window label to milliseconds. Extends rollup.ts's day-granularity
 * vocabulary with sub-day windows used by rate limits. Unknown labels fall back
 * to 1h (the most conservative useful default for rate caps).
 */
export function windowToMs(window: string): number {
  switch (window) {
    case '1m':  return 60_000;
    case '5m':  return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h':  return 3_600_000;
    case '1d':  return 86_400_000;
    case '7d':  return 7 * 86_400_000;
    case '30d': return 30 * 86_400_000;
    default:    return 3_600_000;
  }
}

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

function fleetDir(): string {
  return join(homedir(), '.ashlr', 'fleet');
}

/** Absolute path to the fleet quota ledger file. */
export function fleetQuotaPath(): string {
  return join(fleetDir(), 'quota.json');
}

// ---------------------------------------------------------------------------
// Fresh default
// ---------------------------------------------------------------------------

function freshQuota(): FleetQuota {
  return { events: [] };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read and parse fleetQuotaPath(). NEVER throws.
 * Returns a fresh empty ledger when the file is missing or malformed.
 */
export function loadFleetQuota(): FleetQuota {
  const p = fleetQuotaPath();
  if (!existsSync(p)) return freshQuota();
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return freshQuota();
    }
    const obj = parsed as Record<string, unknown>;
    const events = Array.isArray(obj['events'])
      ? (obj['events'] as unknown[]).filter(
          (e): e is FleetQuotaEvent =>
            typeof e === 'object' &&
            e !== null &&
            !Array.isArray(e) &&
            typeof (e as Record<string, unknown>)['backend'] === 'string' &&
            typeof (e as Record<string, unknown>)['ts'] === 'string',
        )
      : [];
    return { events };
  } catch {
    // Corrupt JSON or any other read error — return a fresh empty ledger.
    return freshQuota();
  }
}

// ---------------------------------------------------------------------------
// Save (atomic) — internal
// ---------------------------------------------------------------------------

/**
 * Atomically write the ledger via tmp-file + rename (POSIX-atomic).
 * Creates ~/.ashlr/fleet recursively. Bounds events. Never throws.
 */
function saveFleetQuota(q: FleetQuota): void {
  try {
    const dir = fleetDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const bounded: FleetQuota = {
      events: q.events.slice(-MAX_EVENTS),
    };
    const dest = fleetQuotaPath();
    const tmp = dest + '.tmp';
    writeFileSync(tmp, JSON.stringify(bounded, null, 2) + '\n', 'utf8');
    renameSync(tmp, dest);
  } catch {
    // Persistence failure must not crash the fleet — swallow silently.
  }
}

// ---------------------------------------------------------------------------
// Record a dispatch
// ---------------------------------------------------------------------------

/**
 * Append a dispatch event for `backend` (ts = now) and persist. Never throws.
 */
export function recordUse(backend: EngineId): void {
  try {
    const q = loadFleetQuota();
    q.events.push({ backend, ts: new Date().toISOString() });
    saveFleetQuota(q);
  } catch {
    // Never throws.
  }
}

// ---------------------------------------------------------------------------
// Window counting
// ---------------------------------------------------------------------------

/**
 * Count events for `backend` whose ts is within the last `windowMs`
 * (ts >= now - windowMs). Reads the ledger internally; `now` is injectable for
 * deterministic tests (defaults to Date.now()).
 */
export function usesInWindow(
  backend: EngineId,
  windowMs: number,
  now?: number,
): number {
  const nowMs = now ?? Date.now();
  const cutoff = nowMs - windowMs;
  const q = loadFleetQuota();
  let count = 0;
  for (const ev of q.events) {
    if (ev.backend !== backend) continue;
    const t = Date.parse(ev.ts);
    if (Number.isNaN(t)) continue;
    if (t >= cutoff) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Limit check
// ---------------------------------------------------------------------------

/**
 * True when `backend` is still UNDER its configured rate limit (or unlimited).
 *
 * Mirrors evalBudget's null-cap-disabled logic: when no
 * cfg.foundry.limits[backend] is configured, the backend is unlimited ⇒ always
 * within limit. Otherwise true iff usesInWindow(...) < limit.max. `now` is
 * injectable for tests.
 */
export function withinLimit(
  backend: EngineId,
  cfg: AshlrConfig,
  now?: number,
): boolean {
  const limit = cfg.foundry?.limits?.[backend];
  if (!limit) return true; // no cap configured ⇒ unlimited
  const used = usesInWindow(backend, windowToMs(limit.window), now);
  return used < limit.max;
}

// ---------------------------------------------------------------------------
// Three-level quota evaluation (mirrors evalBudget)
// ---------------------------------------------------------------------------

/**
 * Evaluate a backend's rate-limit status as 'ok' | 'warn' | 'over', mirroring
 * evalBudget: 'over' at >= 100% of the cap, 'warn' at >= 80%, else 'ok'. When no
 * cap is configured the backend is unlimited ⇒ always 'ok'. `now` is injectable.
 */
export function evalQuota(
  backend: EngineId,
  cfg: AshlrConfig,
  now?: number,
): 'ok' | 'warn' | 'over' {
  const limit = cfg.foundry?.limits?.[backend];
  if (!limit || limit.max <= 0) return 'ok'; // unlimited (or nonsensical cap)
  const used = usesInWindow(backend, windowToMs(limit.window), now);
  if (used >= limit.max) return 'over';
  if (used >= limit.max * 0.8) return 'warn';
  return 'ok';
}
