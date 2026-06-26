/**
 * feedback.ts — M125: Outcome feedback loop for the fleet.
 *
 * Aggregates per-source productivity stats from three ledgers:
 *   - decisions-ledger: Manager verdicts (ship/noise/harmful) + merged/rejected
 *   - inbox/store:      Proposal lifecycle (created, approved, rejected)
 *   - worked-ledger:    Per-item run outcomes (diff / empty)
 *
 * Exports:
 *   - `computeOutcomePriors(opts?)` — builds per-(source × repo) + global stats
 *   - `scoreAdjustment(item, priors)` — bounded multiplier [0.5, 1.5] on item score
 *
 * DESIGN INVARIANTS (mirror learned-router.ts):
 *   - PURE / DETERMINISTIC given the ledgers. Never throws.
 *   - Never zeros a source — floor multiplier ≥ 0.5 (keep exploration).
 *   - Confidence gate: < MIN_SAMPLES → multiplier 1.0 (no change).
 *   - NO side effects, NO imports of apply/merge/push primitives.
 *   - Flag-off: scoreAdjustment returns 1.0 when priors are empty.
 *   - `listProposals` is injectable for tests; falls back to inbox/store at runtime.
 */

import type { Proposal, WorkItem, WorkSource } from '../types.js';
import { readDecisions } from './decisions-ledger.js';
import { loadWorkedLedger } from './worked-ledger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum effective-sample count before we trust a prior enough to adjust.
 * Below this threshold scoreAdjustment returns 1.0 (no change).
 * Mirrors learned-router.ts's ">= 3 samples" confidence gate.
 */
export const MIN_SAMPLES = 3;

/** Floor multiplier — worst source still scores at 50% of its base value. */
export const MULTIPLIER_FLOOR = 0.5;

/** Ceiling multiplier — best source scores at most 1.5× its base value. */
export const MULTIPLIER_CEIL = 1.5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Productivity statistics for one (source, scope) bucket.
 * All rates are fractions in [0, 1]. Raw counts are non-negative integers.
 */
export interface SourceStats {
  /** Proposals created from this source. */
  created: number;
  /** Proposals that received a manager verdict (judged count). */
  judged: number;
  /** Proposals merged (action 'merged' or verdict 'approved'/'applied'). */
  merged: number;
  /** Proposals explicitly rejected. */
  rejected: number;
  /** Proposals where manager verdict was 'ship'. */
  shipCount: number;
  /** Proposals where manager verdict was 'noise' or 'harmful'. */
  noiseCount: number;
  /** Item runs that produced a real diff. */
  diffCount: number;
  /** Item runs that produced no diff (empty). */
  emptyCount: number;
  /** shipCount / judged  (0 when judged === 0). */
  shipRate: number;
  /** (merged + shipCount) / created  (0 when created === 0). */
  acceptRate: number;
  /** emptyCount / (diffCount + emptyCount)  (0 when no runs). */
  emptyRate: number;
  /** noiseCount / judged  (0 when judged === 0). */
  noiseRate: number;
}

/**
 * Full priors table from computeOutcomePriors.
 *
 * Layout:
 *   global   — per-source stats aggregated across all repos
 *   byRepo   — repo-path → per-source stats
 *
 * scoreAdjustment checks byRepo[item.repo][item.source] first, then falls
 * back to global[item.source].
 */
export interface OutcomePriors {
  global: Partial<Record<string, SourceStats>>;
  byRepo: Record<string, Partial<Record<string, SourceStats>>>;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// computeOutcomePriors options
// ---------------------------------------------------------------------------

export interface ComputeOutcomePriorsOpts {
  /**
   * Time window in ms. Entries older than now − windowMs are excluded.
   * Undefined → all history.
   */
  windowMs?: number;
  /**
   * Injectable listProposals function (for tests). When absent, the production
   * inbox/store is loaded lazily via a best-effort dynamic import.
   */
  listProposals?: () => Proposal[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyStats(): SourceStats {
  return {
    created: 0,
    judged: 0,
    merged: 0,
    rejected: 0,
    shipCount: 0,
    noiseCount: 0,
    diffCount: 0,
    emptyCount: 0,
    shipRate: 0,
    acceptRate: 0,
    emptyRate: 0,
    noiseRate: 0,
  };
}

function recomputeRates(s: SourceStats): SourceStats {
  const runs = s.diffCount + s.emptyCount;
  return {
    ...s,
    shipRate: s.judged > 0 ? s.shipCount / s.judged : 0,
    acceptRate: s.created > 0 ? (s.merged + s.shipCount) / s.created : 0,
    emptyRate: runs > 0 ? s.emptyCount / runs : 0,
    noiseRate: s.judged > 0 ? s.noiseCount / s.judged : 0,
  };
}

/** Mutable per-scope accumulator keyed by source string. */
type StatsMap = Map<string, SourceStats>;

function touch(map: StatsMap, source: string): SourceStats {
  let s = map.get(source);
  if (s === undefined) {
    s = emptyStats();
    map.set(source, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// computeOutcomePriors
// ---------------------------------------------------------------------------

/**
 * Compute per-(source × repo) and global productivity priors.
 *
 * Signal sources:
 *   1. decisions-ledger  — manager verdicts + merged/rejected lifecycle events.
 *      Each DecisionEntry is linked to a proposal via proposalId. We load
 *      proposals to resolve (proposalId → {source, repo}).
 *   2. inbox/store proposals — provide `created` counts per (source, repo).
 *      `source` is derived from proposal.kind via a best-effort mapping.
 *   3. worked-ledger — WorkedEvent.itemId encodes `${repo}:${source}:${rest}`.
 *      Provides diff/empty run counts per (source, repo).
 *
 * Never throws. Returns empty priors on any error.
 */
export async function computeOutcomePriors(
  opts?: ComputeOutcomePriorsOpts,
): Promise<OutcomePriors> {
  try {
    const windowMs = opts?.windowMs;
    const sinceMs = windowMs !== undefined ? Date.now() - windowMs : undefined;

    // ── 1. Load decisions ─────────────────────────────────────────────────────
    const decisions = readDecisions({ sinceMs });

    // ── 2. Resolve proposals (proposalId → {source, repo}) ────────────────────
    let proposals: Proposal[] = [];
    if (typeof opts?.listProposals === 'function') {
      try {
        proposals = opts.listProposals();
      } catch {
        proposals = [];
      }
    } else {
      // Production: lazy-import inbox/store (avoids circular dep at module load).
      try {
        const { listProposals } = await import('../inbox/store.js');
        proposals = listProposals();
      } catch {
        proposals = [];
      }
    }

    // Build proposalId → {source, repo} lookup.
    const proposalMeta = new Map<string, { source: string; repo: string | null }>();
    for (const p of proposals) {
      proposalMeta.set(p.id, {
        source: proposalSourceOf(p),
        repo: p.repo,
      });
    }

    // ── 3. Load worked-ledger ─────────────────────────────────────────────────
    const worked = loadWorkedLedger();

    // ── Accumulators ──────────────────────────────────────────────────────────
    const globalMap: StatsMap = new Map();
    const repoMap = new Map<string, StatsMap>();

    function gStats(source: string): SourceStats {
      return touch(globalMap, source);
    }
    function rStats(repo: string, source: string): SourceStats {
      let rm = repoMap.get(repo);
      if (rm === undefined) {
        rm = new Map();
        repoMap.set(repo, rm);
      }
      return touch(rm, source);
    }

    // ── Count proposals created per (source, repo) ────────────────────────────
    for (const p of proposals) {
      const source = proposalSourceOf(p);
      gStats(source).created++;
      if (p.repo) rStats(p.repo, source).created++;
    }

    // ── Process decisions ─────────────────────────────────────────────────────
    for (const d of decisions) {
      const meta = proposalMeta.get(d.proposalId);
      const source = meta?.source ?? 'unknown';
      const repo = meta?.repo ?? null;

      const action = d.action;
      const verdict = (d.verdict ?? '').toLowerCase();

      // Judged: has a verdict or is explicitly a judged/verified action.
      const isJudged =
        verdict === 'ship' ||
        verdict === 'noise' ||
        verdict === 'harmful' ||
        verdict === 'approved' ||
        verdict === 'rejected' ||
        verdict === 'applied' ||
        action === 'judged' ||
        action === 'verified';

      if (isJudged) {
        gStats(source).judged++;
        if (repo) rStats(repo, source).judged++;
      }

      if (action === 'merged' || verdict === 'approved' || verdict === 'applied') {
        gStats(source).merged++;
        if (repo) rStats(repo, source).merged++;
      }

      if (action === 'rejected' || verdict === 'rejected') {
        gStats(source).rejected++;
        if (repo) rStats(repo, source).rejected++;
      }

      if (verdict === 'ship') {
        gStats(source).shipCount++;
        if (repo) rStats(repo, source).shipCount++;
      }

      if (verdict === 'noise' || verdict === 'harmful') {
        gStats(source).noiseCount++;
        if (repo) rStats(repo, source).noiseCount++;
      }
    }

    // ── Process worked-ledger (diff/empty run counts) ─────────────────────────
    for (const ev of worked.events) {
      if (sinceMs !== undefined) {
        const evMs = Date.parse(ev.ts);
        if (!isNaN(evMs) && evMs < sinceMs) continue;
      }

      const parsed = parseItemId(ev.itemId);
      if (parsed === null) continue;
      const { source, repo } = parsed;

      if (ev.outcome === 'diff') {
        gStats(source).diffCount++;
        if (repo) rStats(repo, source).diffCount++;
      } else {
        gStats(source).emptyCount++;
        if (repo) rStats(repo, source).emptyCount++;
      }
    }

    // ── Finalize: recompute rates ─────────────────────────────────────────────
    const global: OutcomePriors['global'] = {};
    for (const [src, stats] of globalMap) {
      global[src] = recomputeRates(stats);
    }

    const byRepo: OutcomePriors['byRepo'] = {};
    for (const [repo, rm] of repoMap) {
      byRepo[repo] = {};
      for (const [src, stats] of rm) {
        byRepo[repo]![src] = recomputeRates(stats);
      }
    }

    return { global, byRepo, computedAt: new Date().toISOString() };
  } catch {
    return { global: {}, byRepo: {}, computedAt: new Date().toISOString() };
  }
}

// ---------------------------------------------------------------------------
// scoreAdjustment
// ---------------------------------------------------------------------------

/**
 * Return a bounded score multiplier for `item` based on its source's
 * historical productivity in `priors`.
 *
 * Productivity formula (weights sum to 1.0):
 *   productivity =
 *     shipRate   × 0.40   (manager explicitly called it good)
 *     acceptRate × 0.30   (work actually merged)
 *     (1 - emptyRate) × 0.20   (runs produce real diffs)
 *     (1 - noiseRate) × 0.10   (not noise/harmful)
 *
 * Multiplier mapping  [0, 1] → [FLOOR, CEIL]:
 *   multiplier = FLOOR + productivity × (CEIL − FLOOR)
 *              = 0.5  + productivity × 1.0
 *
 * Confidence gate:
 *   effectiveSamples = max(judged, created, diffCount + emptyCount)
 *   if effectiveSamples < MIN_SAMPLES → return 1.0 (no adjustment)
 *
 * Lookup: byRepo[item.repo][item.source] → global[item.source] → 1.0
 *
 * Never throws.
 */
export function scoreAdjustment(item: WorkItem, priors: OutcomePriors): number {
  try {
    const repoSpecific = priors.byRepo[item.repo]?.[item.source];
    const globalFallback = priors.global[item.source];
    const stats: SourceStats | undefined = repoSpecific ?? globalFallback;

    if (stats === undefined) return 1.0;

    const effectiveSamples = Math.max(
      stats.judged,
      stats.created,
      stats.diffCount + stats.emptyCount,
    );
    if (effectiveSamples < MIN_SAMPLES) return 1.0;

    const productivity =
      stats.shipRate * 0.4 +
      stats.acceptRate * 0.3 +
      (1 - stats.emptyRate) * 0.2 +
      (1 - stats.noiseRate) * 0.1;

    // Map [0,1] → [FLOOR, CEIL].
    const raw = MULTIPLIER_FLOOR + productivity * (MULTIPLIER_CEIL - MULTIPLIER_FLOOR);

    // Clamp for floating-point safety.
    return Math.max(MULTIPLIER_FLOOR, Math.min(MULTIPLIER_CEIL, raw));
  } catch {
    return 1.0;
  }
}

// ---------------------------------------------------------------------------
// Internal: WorkItem id parser
// ---------------------------------------------------------------------------

/**
 * Parse a WorkItem id `${repo}:${source}:${rest}` → {source, repo}.
 *
 * WorkItem ids are produced by scanners as `${repoAbsPath}:${source}:${hash}`.
 * Absolute paths on macOS/Linux contain no ':', so splitting by ':' is safe.
 * Returns null when the id doesn't match the expected format.
 */
function parseItemId(itemId: string): { source: string; repo: string } | null {
  try {
    const colonIdx = itemId.indexOf(':');
    if (colonIdx < 0) return null;
    const repo = itemId.slice(0, colonIdx);
    const rest = itemId.slice(colonIdx + 1);
    const colonIdx2 = rest.indexOf(':');
    if (colonIdx2 < 0) return null;
    const source = rest.slice(0, colonIdx2);
    if (repo === '' || source === '') return null;
    return { source, repo };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal: proposal → source label
// ---------------------------------------------------------------------------

/**
 * Map a Proposal's kind to a WorkSource-equivalent label for bucketing.
 * Proposals don't carry WorkItem.source directly, so proposal.kind is the
 * best available proxy.
 */
function proposalSourceOf(p: Proposal): string {
  const KIND_TO_SOURCE: Record<string, string> = {
    patch: 'todo',
    pr: 'todo',
    note: 'doc',
    tuning: 'self',
    security: 'security',
    dep: 'dep',
    issue: 'issue',
    test: 'test',
    lint: 'lint',
    refactor: 'todo',
  };
  return KIND_TO_SOURCE[p.kind] ?? p.kind;
}

// Re-export for consumers.
export type { WorkSource };
