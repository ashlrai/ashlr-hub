/**
 * fleet-status-cache.ts — shared, single-flight, stale-while-refresh cache
 * for `buildFleetStatus(cfg)`.
 *
 * WHY THIS EXISTS (perf incident, measured live against a 239-repo fleet):
 *   /api/snapshot went from 2.4s idle to 69.4s under concurrent load;
 *   /api/control went from fine to 79.0s. Profiling found `buildFleetStatus`
 *   — a large, multi-source aggregator (goals, decisions ledger, judge
 *   traces, skill records, phantom status, dispatch manifest, queue
 *   coverage, autonomy evidence, etc.) — was being invoked with ZERO caching
 *   from up to six independent call sites across dashboard.ts, control.ts,
 *   and api.ts. `buildCachedSnapshot` (api.ts) already had a 5s TTL +
 *   in-flight-dedup cache for the outer DashboardSnapshot, but that cache
 *   did nothing for the other call sites, and every one of THEM triggered
 *   its own full recompute. Under concurrent load (SSE poll + /api/control
 *   poll + /api/fleet poll, all firing close together) many full
 *   `buildFleetStatus` computations ran concurrently, each fanning out to
 *   dozens of file reads, and the resulting I/O + CPU contention is exactly
 *   why the endpoints were fine idle and catastrophic under load.
 *
 * FIX: one shared cache entry per `cfg`, reused by every READ call site.
 *   - Cold call (no value yet): caller awaits a real computation (correct,
 *     unavoidable — there is nothing honest to serve yet).
 *   - Call within the TTL: return the cached value immediately, `stale: false`.
 *   - Call after the TTL but before FLEET_STATUS_MAX_STALE_MS: return the
 *     last good value immediately with `stale: true` and kick a background
 *     refresh (deduped — concurrent callers during the refresh share the
 *     same in-flight promise, so load does not multiply the recompute cost).
 *   - Call after FLEET_STATUS_MAX_STALE_MS: the cached value is too old to
 *     serve honestly, so the caller waits for a fresh (or already in-flight)
 *     computation instead.
 *
 * This NEVER presents old data as current — every result reports `stale`
 * and `ageMs` so callers can propagate honest freshness (mirroring the
 * existing sourceQuality provenance discipline elsewhere in the web layer)
 * instead of silently serving cached numbers as live.
 *
 * Mutation-adjacent call sites (POST /api/fleet/pause|resume, POST
 * /api/daemon/service/repair) intentionally do NOT use this cache — they
 * must observe the effect of the mutation they just made, so they keep
 * calling `buildFleetStatus` directly.
 */

import type { AshlrConfig } from '../types.js';
import { buildFleetStatus, type FleetStatus } from '../fleet/status.js';

const FLEET_STATUS_CACHE_MS = 5_000;

/**
 * Upper bound on how long a stale value may be served while a refresh is
 * (or should be) in flight. Guards against serving arbitrarily old data if a
 * refresh gets stuck or starts failing repeatedly.
 */
const FLEET_STATUS_MAX_STALE_MS = 60_000;

export interface CachedFleetStatus {
  status: FleetStatus;
  /** True when this value is older than the cache TTL — a background refresh may be in flight. */
  stale: boolean;
  /** Milliseconds since this value was actually computed. */
  ageMs: number;
}

interface FleetStatusCacheEntry {
  value: FleetStatus | null;
  computedAt: number;
  expiresAt: number;
  inFlight: Promise<FleetStatus> | null;
}

const fleetStatusCache = new WeakMap<AshlrConfig, FleetStatusCacheEntry>();

function getEntry(cfg: AshlrConfig): FleetStatusCacheEntry {
  let entry = fleetStatusCache.get(cfg);
  if (!entry) {
    entry = { value: null, computedAt: 0, expiresAt: 0, inFlight: null };
    fleetStatusCache.set(cfg, entry);
  }
  return entry;
}

/** Start (or reuse) a single in-flight recompute for this cache entry. */
function refresh(cfg: AshlrConfig, entry: FleetStatusCacheEntry): Promise<FleetStatus> {
  if (entry.inFlight) return entry.inFlight;
  entry.inFlight = buildFleetStatus(cfg)
    .then((value) => {
      entry.value = value;
      entry.computedAt = Date.now();
      entry.expiresAt = entry.computedAt + FLEET_STATUS_CACHE_MS;
      return value;
    })
    .finally(() => {
      entry.inFlight = null;
    });
  return entry.inFlight;
}

/**
 * Cached, single-flight, stale-while-refresh accessor for buildFleetStatus.
 * Use this for READ paths (dashboard fleet section, /api/control, /api/fleet,
 * /api/fleet-activity). Never throws — buildFleetStatus itself never throws,
 * and a rejected refresh simply leaves the previous entry.value in place for
 * the next call to retry against.
 */
export async function getCachedFleetStatus(cfg: AshlrConfig): Promise<CachedFleetStatus> {
  const entry = getEntry(cfg);
  const now = Date.now();

  if (entry.value === null) {
    // Cold start — nothing honest to serve yet, must compute.
    const status = await refresh(cfg, entry);
    return { status, stale: false, ageMs: 0 };
  }

  if (now < entry.expiresAt) {
    return { status: entry.value, stale: false, ageMs: now - entry.computedAt };
  }

  const ageMs = now - entry.computedAt;
  if (ageMs > FLEET_STATUS_MAX_STALE_MS) {
    // Too old to serve honestly — wait for a fresh (or already in-flight) value.
    const status = await refresh(cfg, entry);
    return { status, stale: false, ageMs: 0 };
  }

  // Serve the last good value now; refresh in the background. Concurrent
  // callers in this window share the same in-flight promise via refresh().
  refresh(cfg, entry);
  return { status: entry.value, stale: true, ageMs };
}

/**
 * Prime the cache with a value the caller ALREADY computed fresh — used by
 * mutation routes (POST /api/fleet/pause|resume) that must call
 * buildFleetStatus directly (they need to observe the effect of the mutation
 * they just made, so they cannot use the possibly-stale getCachedFleetStatus
 * path). Without this, a GET /api/fleet immediately after a mutation could
 * serve a pre-mutation cached value for up to the TTL window.
 */
export function primeFleetStatusCache(cfg: AshlrConfig, status: FleetStatus): void {
  const entry = getEntry(cfg);
  const now = Date.now();
  entry.value = status;
  entry.computedAt = now;
  entry.expiresAt = now + FLEET_STATUS_CACHE_MS;
}
