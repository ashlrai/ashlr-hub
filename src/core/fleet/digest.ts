/**
 * fleet/digest.ts — M88: pure fleet-activity digest builder.
 *
 * Aggregates per-repo proposal stats from the inbox store + daemon state for
 * inclusion in `ashlr digest`. READ-ONLY — never throws, degrades gracefully
 * to empty when no fleet activity exists or stores are unavailable.
 *
 * Owned by the digest surface. Do NOT edit loop.ts / merge.ts / store.ts /
 * state.ts directly — this module calls them read-only.
 */

import type { DigestWindow } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-repo proposal activity within the digest window. */
export interface FleetRepoRow {
  /** Absolute repo path (or the raw origin string if non-path). */
  repo: string;
  /** Proposals filed in window. */
  proposed: number;
  /** Auto-merged (status 'applied') in window. */
  autoMerged: number;
  /** Awaiting review (status 'pending'). Window-unfiltered — these are live. */
  pending: number;
  /** Declined/rejected in window. */
  declined: number;
}

/** Fleet activity digest — aggregated across all repos for the window. */
export interface FleetDigest {
  /** Whether the fleet is currently running (from daemon state). */
  running: boolean;
  /** ISO timestamp of the last daemon tick, or null when never ticked. */
  lastTickAt: string | null;
  /** Today's fleet spend in USD (from daemon state). */
  todaySpentUsd: number;
  /** Total items processed lifetime by the daemon. */
  itemsProcessed: number;
  /** Per-repo rows, sorted by (proposed + autoMerged) desc. */
  repos: FleetRepoRow[];
  /** Total proposals filed in window across all repos. */
  totalProposed: number;
  /** Total auto-merged in window. */
  totalAutoMerged: number;
  /** Total pending (live, window-unfiltered). */
  totalPending: number;
  /** Total declined in window. */
  totalDeclined: number;
}

// ---------------------------------------------------------------------------
// Window helper
// ---------------------------------------------------------------------------

/** Return a Date that is `window` ago from `now`. */
function windowStart(window: DigestWindow, now: Date): Date {
  const days = window === '30d' ? 30 : 7;
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d;
}

// ---------------------------------------------------------------------------
// Lazy imports — read-only calls only; degrade on missing modules
// ---------------------------------------------------------------------------

interface ProposalLike {
  repo: string | null;
  status: string;
  createdAt: string;
  decidedAt?: string;
}

/** Load all proposals. Returns [] on any error or missing module. */
async function safeListProposals(): Promise<ProposalLike[]> {
  try {
    const mod = await import('../inbox/store.js') as {
      listProposals: (filter?: { status?: string }) => ProposalLike[];
    };
    return mod.listProposals();
  } catch {
    return [];
  }
}

interface DaemonStateLike {
  running: boolean;
  lastTickAt: string | null;
  todaySpentUsd: number;
  itemsProcessed: number;
}

/** Load daemon state. Returns zeroed state on any error. */
async function safeLoadDaemonState(): Promise<DaemonStateLike> {
  try {
    const mod = await import('../daemon/state.js') as {
      loadDaemonState: () => DaemonStateLike;
    };
    return mod.loadDaemonState();
  } catch {
    return { running: false, lastTickAt: null, todaySpentUsd: 0, itemsProcessed: 0 };
  }
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/**
 * Build a FleetDigest for the given window. Aggregates:
 *  - inbox proposals (status pending/applied/rejected/approved/failed) per-repo
 *  - daemon state (running, lastTickAt, todaySpentUsd, itemsProcessed)
 *  - worked ledger (best-effort; degrades gracefully if absent)
 *
 * Rules:
 *  - 'applied' = auto-merged (filtered by createdAt in window)
 *  - 'pending' = awaiting review (live count, not window-filtered)
 *  - 'rejected' = declined (filtered by createdAt in window)
 *  - 'proposed' = total filed in window (all statuses with createdAt in window)
 *
 * NEVER throws. Returns an empty FleetDigest on any failure.
 *
 * @param window  - The digest window ('7d' | '30d').
 * @param now     - Injectable for deterministic tests. Defaults to new Date().
 */
export async function buildFleetDigest(
  window: DigestWindow,
  opts?: { now?: Date },
): Promise<FleetDigest> {
  const empty: FleetDigest = {
    running: false,
    lastTickAt: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
    repos: [],
    totalProposed: 0,
    totalAutoMerged: 0,
    totalPending: 0,
    totalDeclined: 0,
  };

  try {
    const now = opts?.now ?? new Date();
    const cutoff = windowStart(window, now);

    // Load sources concurrently — both degrade gracefully.
    const [proposals, daemonState] = await Promise.all([
      safeListProposals(),
      safeLoadDaemonState(),
    ]);

    // Per-repo accumulator.
    const repoMap = new Map<string, FleetRepoRow>();

    function row(repo: string): FleetRepoRow {
      let r = repoMap.get(repo);
      if (!r) {
        r = { repo, proposed: 0, autoMerged: 0, pending: 0, declined: 0 };
        repoMap.set(repo, r);
      }
      return r;
    }

    for (const p of proposals) {
      const repoKey = p.repo ?? '(unscoped)';
      const r = row(repoKey);

      // 'pending' is live — not window-filtered (still actionable regardless of age).
      if (p.status === 'pending') {
        r.pending += 1;
        continue;
      }

      // For all other statuses, filter by createdAt within window.
      let createdMs: number;
      try {
        createdMs = Date.parse(p.createdAt);
      } catch {
        continue;
      }
      if (Number.isNaN(createdMs) || createdMs < cutoff.getTime()) continue;

      r.proposed += 1;
      if (p.status === 'applied') {
        r.autoMerged += 1;
      } else if (p.status === 'rejected') {
        r.declined += 1;
      }
    }

    // Sort repos by activity (proposed + autoMerged) descending.
    const repos = Array.from(repoMap.values()).sort(
      (a, b) => b.proposed + b.autoMerged - (a.proposed + a.autoMerged),
    );

    // Totals.
    let totalProposed = 0;
    let totalAutoMerged = 0;
    let totalPending = 0;
    let totalDeclined = 0;
    for (const r of repos) {
      totalProposed += r.proposed;
      totalAutoMerged += r.autoMerged;
      totalPending += r.pending;
      totalDeclined += r.declined;
    }

    return {
      running: daemonState.running,
      lastTickAt: daemonState.lastTickAt,
      todaySpentUsd: daemonState.todaySpentUsd,
      itemsProcessed: daemonState.itemsProcessed,
      repos,
      totalProposed,
      totalAutoMerged,
      totalPending,
      totalDeclined,
    };
  } catch {
    // Never throws — return empty digest.
    return empty;
  }
}
