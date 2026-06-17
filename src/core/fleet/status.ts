/**
 * M49: fleet control plane + observability — read-only aggregation.
 *
 * `buildFleetStatus(cfg)` is a single READ-ONLY snapshot of the whole fleet:
 * the daemon's liveness + today's spend, per-backend recent dispatch counts and
 * quota status, the backlog queue size, the inbox proposal counts (pending /
 * frontier-pending / applied), recent auto-merges, and whether the global kill
 * switch is engaged.
 *
 * SAFETY: this NEVER mutates anything and NEVER throws. Every underlying source
 * is wrapped in its own try/catch with a sane fallback, so a single broken
 * source (corrupt daemon state, absent backlog, etc.) degrades only its own
 * slice — the rest of the snapshot still resolves. It adds NO capability: it
 * only reads what the daemon/quota/inbox/backlog modules already persist.
 */

import type { AshlrConfig, EngineId } from '../types.js';

/** A single backend's recent activity + quota standing. */
export interface FleetBackendStatus {
  /** The backend id (e.g. 'builtin', 'claude', 'codex'). */
  backend: EngineId;
  /** Dispatches recorded for this backend in the recent window (last 24h). */
  dispatchesRecent: number;
  /** Quota standing: 'unlimited' when no rate limit is configured. */
  quota: 'ok' | 'warn' | 'over' | 'unlimited';
}

/** One whole-fleet read-only snapshot. */
export interface FleetStatus {
  /** ISO timestamp this snapshot was generated. */
  generatedAt: string;
  daemon: {
    running: boolean;
    lastTickAt: string | null;
    todaySpentUsd: number;
  };
  backends: FleetBackendStatus[];
  queue: {
    backlogItems: number;
  };
  proposals: {
    pending: number;
    frontierPending: number;
    applied: number;
  };
  merges: {
    recent: number;
  };
  /** True when the global kill switch is engaged (fleet paused). */
  killed: boolean;
}

/** Recent window for dispatch + merge counting: the last 24 hours. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Build a read-only snapshot of the fleet. Async because the backlog scan is
 * async. NEVER throws — each source is independently guarded.
 */
export async function buildFleetStatus(cfg: AshlrConfig): Promise<FleetStatus> {
  const generatedAt = new Date().toISOString();

  // ── daemon ────────────────────────────────────────────────────────────────
  let daemon: FleetStatus['daemon'] = {
    running: false,
    lastTickAt: null,
    todaySpentUsd: 0,
  };
  // Recent ticks are reused for merge counting below.
  let recentTicks: Array<{ ts?: string; merged?: number; backends?: Record<string, number> }> = [];
  try {
    const { loadDaemonState } = await import('../daemon/state.js');
    const ds = loadDaemonState();
    daemon = {
      running: ds.running === true,
      lastTickAt: ds.lastTickAt ?? null,
      todaySpentUsd: typeof ds.todaySpentUsd === 'number' ? ds.todaySpentUsd : 0,
    };
    recentTicks = Array.isArray(ds.ticks) ? ds.ticks : [];
  } catch {
    // leave fallback
  }

  // ── backends ────────────────────────────────────────────────────────────────
  const allowed: EngineId[] = cfg.foundry?.allowedBackends ?? ['builtin'];
  const backends: FleetBackendStatus[] = [];
  for (const backend of allowed) {
    let dispatchesRecent = 0;
    let quota: FleetBackendStatus['quota'] = 'unlimited';
    try {
      const { usesInWindow, evalQuota } = await import('./quota.js');
      // Prefer the quota ledger (authoritative for rate-limit accounting).
      dispatchesRecent = usesInWindow(backend, RECENT_WINDOW_MS);
      // Quota standing: 'unlimited' when no limit is configured for this backend.
      const limit = cfg.foundry?.limits?.[backend];
      quota = limit ? evalQuota(backend, cfg) : 'unlimited';
    } catch {
      // Ledger unavailable — fall back to summing recent tick.backends counts.
      try {
        dispatchesRecent = sumRecentBackend(recentTicks, backend);
      } catch {
        dispatchesRecent = 0;
      }
      quota = 'unlimited';
    }
    backends.push({ backend, dispatchesRecent, quota });
  }

  // ── queue (backlog size) ──────────────────────────────────────────────────
  let backlogItems = 0;
  try {
    const { buildBacklog } = await import('../portfolio/backlog.js');
    const backlog = await buildBacklog();
    backlogItems = Array.isArray(backlog.items) ? backlog.items.length : 0;
  } catch {
    backlogItems = 0;
  }

  // ── proposals (pending / frontier-pending / applied) ──────────────────────
  let pending = 0;
  let frontierPending = 0;
  let applied = 0;
  try {
    const { listProposals } = await import('../inbox/store.js');
    const all = listProposals();
    for (const p of all) {
      if (p.status === 'pending') {
        pending++;
        if (p.engineTier === 'frontier') frontierPending++;
      } else if (p.status === 'applied') {
        applied++;
      }
    }
  } catch {
    pending = 0;
    frontierPending = 0;
    applied = 0;
  }

  // ── merges (recent auto-merges across recent ticks) ───────────────────────
  let mergesRecent = 0;
  try {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    for (const t of recentTicks) {
      if (typeof t.merged !== 'number' || t.merged <= 0) continue;
      const ts = t.ts ? Date.parse(t.ts) : NaN;
      // Count when within the recent window, or when the tick has no parseable
      // timestamp (be inclusive rather than silently drop a real merge).
      if (Number.isNaN(ts) || ts >= cutoff) mergesRecent += t.merged;
    }
  } catch {
    mergesRecent = 0;
  }

  // ── kill switch ───────────────────────────────────────────────────────────
  let killed = false;
  try {
    const { killSwitchOn } = await import('../sandbox/policy.js');
    killed = killSwitchOn() === true;
  } catch {
    killed = false;
  }

  return {
    generatedAt,
    daemon,
    backends,
    queue: { backlogItems },
    proposals: { pending, frontierPending, applied },
    merges: { recent: mergesRecent },
    killed,
  };
}

/**
 * Sum `tick.backends[backend]` across recent ticks (within RECENT_WINDOW_MS).
 * Pure fallback for when the quota ledger is unavailable.
 */
function sumRecentBackend(
  ticks: Array<{ ts?: string; backends?: Record<string, number> }>,
  backend: EngineId,
): number {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  let sum = 0;
  for (const t of ticks) {
    const n = t.backends?.[backend];
    if (typeof n !== 'number' || n <= 0) continue;
    const ts = t.ts ? Date.parse(t.ts) : NaN;
    if (Number.isNaN(ts) || ts >= cutoff) sum += n;
  }
  return sum;
}
