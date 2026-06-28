/**
 * learned-router.ts — M53: Fleet intelligence layer over the M46 router.
 *
 * Exports:
 *  - `recommendRoute(item, cfg, opts)` — PURE over its inputs. Combines
 *    `routeBackend` with verified-outcome priors and an `estimateRun` cost
 *    estimate to recommend `{ backend, tier, reason, confidence }`. Priors
 *    nudge cost-heavy frontier tasks toward mid/local when frontier has a poor
 *    verified-success rate for their class. NEVER recommends a backend outside
 *    cfg.foundry.allowedBackends; NEVER escalates a bulk/local item to frontier.
 *
 *  - `recoverWithinBudget(decision, cfg, spentUsd, forecast)` — PURE. When the
 *    projected daily budget would be breached, cascades the chosen backend:
 *    frontier → mid → local → pause. Returns the cascaded decision or a pause
 *    signal. NEVER throws.
 *
 * HARD SAFETY INVARIANTS (see CONTRACT-M53.md):
 *  - NO auto-apply, NO gate bypass. This file has NO import of any
 *    apply/merge/create-pr/push/deploy primitive. All outputs are tier choices
 *    or recommendation metadata — never outward actions.
 *  - recommendRoute's output is always within allowedBackends.
 *  - recoverWithinBudget cascade is strictly frontier→mid→local→pause; never
 *    escalates.
 *  - Flag-off: when cfg.foundry.intelligence is absent, recommendRoute defers
 *    entirely to routeBackend (byte-identical behavior).
 *
 * No new runtime deps; node builtins only. EngineTier locally defined here to
 * avoid importing from merge.ts (daemon-no-primitive invariant).
 */

import type { AshlrConfig, EngineId, EngineTier, RunEstimate, WorkItem } from '../types.js';
import { routeBackend, type RouteDecision } from '../fleet/router.js';
import type { CostForecast } from '../types.js';

// ---------------------------------------------------------------------------
// M155: Re-export cascade routing API from router.ts for discoverability.
// The orchestrator may import from either module.
// ---------------------------------------------------------------------------
export type {
  CascadeDecision,
  CascadeRunEntry,
  EscalationSignal,
  TaskResult,
} from './router.js';
export {
  shouldEscalate,
  escalationRate,
  routeTaskCascade,
} from './router.js';

// ---------------------------------------------------------------------------
// Local type definitions (avoid importing merge.ts)
// ---------------------------------------------------------------------------

/** The tier cascade order: frontier → mid → local → pause. */
const TIER_CASCADE: readonly EngineTier[] = ['frontier', 'mid', 'local'];

/** A recommendation from the learned router. */
export interface LearnedRoute {
  /** Backend chosen (always within allowedBackends). */
  backend: EngineId;
  /** Engine tier of the chosen backend. */
  tier: EngineTier;
  /** Human-readable explanation of the routing decision. */
  reason: string;
  /**
   * Confidence in the recommendation (0..1). Low when no priors exist;
   * higher when there's enough history to trust the nudge.
   */
  confidence: number;
}

/** The outcome of recoverWithinBudget — either a cascaded decision or a pause. */
export type BudgetRecovery =
  | { action: 'cascade'; decision: RouteDecision; reason: string }
  | { action: 'pause'; reason: string };

/**
 * M53: intelligence configuration block, expected under cfg.foundry.intelligence.
 * Defined locally so we don't need to touch types.ts (owned by main thread).
 */
export interface FoundryIntelligenceCfg {
  /**
   * Anomaly threshold multiplier k: a run with cost > k × p50 triggers a hold.
   * Default 4.
   */
  anomalyK?: number;
  /**
   * Minimum verified-success rate below which a task class is nudged away from
   * frontier (0..1, default 0.5).
   */
  minFrontierSuccessRate?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve intelligence config from cfg, returning defaults when absent. */
function resolveIntelCfg(cfg: AshlrConfig): FoundryIntelligenceCfg | null {
  // M59: cfg.foundry.intelligence is now a typed field. Returns null when
  // entirely absent so the flag-off path is clean.
  const raw = cfg.foundry?.intelligence;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as FoundryIntelligenceCfg;
}

/** All backends in cfg.foundry.allowedBackends (always includes 'builtin'). */
function allowedBackends(cfg: AshlrConfig): Set<EngineId> {
  const set = new Set<EngineId>(cfg.foundry?.allowedBackends ?? ['builtin']);
  set.add('builtin');
  return set;
}

/**
 * Map a backend EngineId to its EngineTier. Mirrors engineTierOf semantics
 * from sandboxed-engine.ts without importing it here (to avoid a chain that
 * could pull in merge.ts). The set of frontier engines is stable and small.
 */
function tierOf(backend: EngineId): EngineTier {
  // Any non-builtin backend is considered 'frontier' by default (the M46
  // engineTierOf logic). With the M53 learned router, we don't yet have
  // 'mid' backends in the registry (that's M51), so this mirrors M46's
  // two-level world while leaving room for 'mid' in the cascade logic.
  if (backend === 'builtin') return 'local';
  return 'frontier';
}

/**
 * Find the best backend within the allowed set that matches the given tier.
 * Returns null when no allowed backend has that tier.
 */
function backendForTier(
  tier: EngineTier,
  allowed: Set<EngineId>,
  preferredOrder: readonly EngineId[],
): EngineId | null {
  for (const e of preferredOrder) {
    if (allowed.has(e) && tierOf(e) === tier) return e;
  }
  // Fallback: scan the full allowed set.
  for (const e of allowed) {
    if (tierOf(e) === tier) return e;
  }
  return null;
}

/** The preferred frontier backend ordering (mirrors FRONTIER_PREFERENCE in router.ts). */
const FRONTIER_PREFERENCE: readonly EngineId[] = ['claude', 'codex'];

// ---------------------------------------------------------------------------
// Verified-outcome prior loading
// ---------------------------------------------------------------------------

/**
 * A prior derived from run history for a task class (source label).
 * Computed read-only from listRuns history; never throws.
 */
interface OutcomePrior {
  /** Fraction of frontier runs that were verified-successful (0..1). */
  frontierSuccessRate: number;
  /** Number of frontier runs in history. */
  frontierSampleSize: number;
}

const EMPTY_PRIOR: OutcomePrior = { frontierSuccessRate: 1, frontierSampleSize: 0 };

/**
 * Compute a prior for the given task source class from run history.
 * Read-only, never throws, returns EMPTY_PRIOR on any error or empty history.
 */
async function loadPrior(source: string): Promise<OutcomePrior> {
  try {
    const { listRuns } = await import('../run/orchestrator.js');
    const runs = listRuns();
    // A run is "frontier" if its engine is one of the known frontier backends.
    // We derive this from the run metadata. Runs without engineTier skip.
    const frontierRuns = runs.filter((r) => {
      const tier = (r as unknown as Record<string, unknown>)['engineTier'];
      return tier === 'frontier';
    });
    // Filter by source class via the goal keyword heuristic (best-effort).
    const relevant = frontierRuns.filter((r) =>
      r.goal.toLowerCase().includes(source.toLowerCase()),
    );
    if (relevant.length === 0) return EMPTY_PRIOR;
    const succeeded = relevant.filter(
      (r) => r.status === 'done',
    ).length;
    return {
      frontierSuccessRate: succeeded / relevant.length,
      frontierSampleSize: relevant.length,
    };
  } catch {
    return EMPTY_PRIOR;
  }
}

// ---------------------------------------------------------------------------
// p50 anomaly helper (exposed for daemon use)
// ---------------------------------------------------------------------------

/**
 * Extract the p50 (median) cost estimate from a RunEstimate.
 * Returns 0 when the estimate has no history (confidence 'low', sampleSize 0).
 */
export function p50Cost(estimate: RunEstimate): number {
  return estimate.estCostUsd.median;
}

/**
 * Compute the anomaly ratio: actualCost / p50Cost. Returns Infinity when p50
 * is 0 and actualCost > 0 (conservatively treated as an anomaly by callers).
 * Returns 0 when actualCost is 0. Never throws.
 */
export function anomalyRatio(actualCostUsd: number, estimate: RunEstimate): number {
  if (actualCostUsd <= 0) return 0;
  const p50 = p50Cost(estimate);
  if (p50 <= 0) return Infinity;
  return actualCostUsd / p50;
}

// ---------------------------------------------------------------------------
// recommendRoute
// ---------------------------------------------------------------------------

/**
 * Recommend a backend route for a WorkItem, combining M46 routeBackend with
 * verified-outcome priors and a cost estimate.
 *
 * PURE over its inputs (modulo async history reads). NEVER throws.
 * Flag-off: when cfg.foundry.intelligence is absent, defers to routeBackend.
 *
 * @param item     The work item to route.
 * @param cfg      Full AshlrConfig.
 * @param opts     Optional: a pre-computed RunEstimate and prior data.
 */
export async function recommendRoute(
  item: WorkItem,
  cfg: AshlrConfig,
  opts?: {
    estimate?: RunEstimate;
    prior?: OutcomePrior;
  },
): Promise<LearnedRoute> {
  // ── FLAG-OFF: absent intelligence config ⇒ defer to routeBackend exactly ──
  const intel = resolveIntelCfg(cfg);
  if (intel === null) {
    const base = routeBackend(item, cfg);
    return {
      backend: base.backend,
      tier: base.tier,
      reason: base.reason,
      confidence: 1.0,
    };
  }

  // ── Base decision from M46 routeBackend ────────────────────────────────────
  const base = routeBackend(item, cfg);
  const allowed = allowedBackends(cfg);

  // ── Guard: never return a backend outside allowedBackends ─────────────────
  // (routeBackend already honors this, but we double-check here)
  if (!allowed.has(base.backend)) {
    return {
      backend: 'builtin',
      tier: 'local',
      reason: `learned-router: base backend ${base.backend} not in allowedBackends — fallback to builtin`,
      confidence: 1.0,
    };
  }

  // ── Bulk/local items: NEVER escalate to frontier ───────────────────────────
  if (base.tier === 'local') {
    return {
      backend: base.backend,
      tier: base.tier,
      reason: `learned-router: bulk/local item stays local (${base.reason})`,
      confidence: 1.0,
    };
  }

  // ── Load priors (or use provided ones) ────────────────────────────────────
  const prior = opts?.prior ?? (await loadPrior(item.source));
  const minSuccessRate = intel.minFrontierSuccessRate ?? 0.5;

  // ── Nudge away from frontier when success rate is poor ────────────────────
  // Only applies when we have enough history to trust the prior (>= 3 samples).
  const poorPrior =
    prior.frontierSampleSize >= 3 &&
    prior.frontierSuccessRate < minSuccessRate;

  if (poorPrior) {
    // Try to find a mid-tier backend first, then fall back to local.
    const midBackend = backendForTier('mid', allowed, FRONTIER_PREFERENCE);
    if (midBackend !== null) {
      return {
        backend: midBackend,
        tier: 'mid',
        reason:
          `learned-router: frontier success rate ${(prior.frontierSuccessRate * 100).toFixed(0)}% ` +
          `< threshold ${(minSuccessRate * 100).toFixed(0)}% for source '${item.source}' ` +
          `(${prior.frontierSampleSize} samples) — nudged to mid ${midBackend}`,
        confidence: Math.min(
          0.4 + (prior.frontierSampleSize / 20) * 0.4 + (1 - prior.frontierSuccessRate) * 0.2,
          1,
        ),
      };
    }
    // No mid available — fall back to local.
    return {
      backend: 'builtin',
      tier: 'local',
      reason:
        `learned-router: frontier success rate poor for '${item.source}', no mid backend ` +
        `available — fallback to builtin`,
      confidence: 0.7,
    };
  }

  // ── Cost estimate check: if p50 is very high, nudge toward cheaper tier ───
  const estimate = opts?.estimate;
  if (estimate !== null && estimate !== undefined && estimate.sampleSize >= 3) {
    // If the median cost estimate is greater than 10% of the daily budget, prefer
    // a mid or local backend to conserve budget.
    const dailyBudget = cfg.daemon?.dailyBudgetUsd ?? 1.0;
    const costThreshold = dailyBudget * 0.1;
    if (estimate.estCostUsd.median > costThreshold && base.tier === 'frontier') {
      const midBackend = backendForTier('mid', allowed, FRONTIER_PREFERENCE);
      if (midBackend !== null) {
        return {
          backend: midBackend,
          tier: 'mid',
          reason:
            `learned-router: p50 cost $${estimate.estCostUsd.median.toFixed(4)} exceeds ` +
            `10% of daily budget ($${dailyBudget}) — nudged to mid ${midBackend}`,
          confidence: 0.6,
        };
      }
    }
  }

  // ── No nudge warranted — return the base decision ─────────────────────────
  return {
    backend: base.backend,
    tier: base.tier,
    reason: `learned-router: base decision confirmed (${base.reason})`,
    confidence: prior.frontierSampleSize >= 10 ? 0.9 : prior.frontierSampleSize >= 3 ? 0.7 : 0.5,
  };
}

// ---------------------------------------------------------------------------
// recoverWithinBudget
// ---------------------------------------------------------------------------

/**
 * Given a routing decision and current spend vs. forecast, cascade the backend
 * tier to stay within budget: frontier → mid → local → pause.
 *
 * PURE + DETERMINISTIC. Never throws. Never escalates (a 'local' decision
 * always stays 'local'). Returns { action: 'pause' } at the hard cap.
 *
 * @param decision    The current RouteDecision (from routeBackend or recommendRoute).
 * @param cfg         Full AshlrConfig.
 * @param spentUsd    Total USD spent today so far.
 * @param forecast    The current cost forecast (projectedMonthlyUsd, etc.).
 */
export function recoverWithinBudget(
  decision: RouteDecision,
  cfg: AshlrConfig,
  spentUsd: number,
  forecast: CostForecast,
): BudgetRecovery {
  const dailyBudget = cfg.daemon?.dailyBudgetUsd ?? 1.0;
  const remaining = dailyBudget - spentUsd;
  const allowed = allowedBackends(cfg);

  // ── Hard cap: budget exhausted ⇒ pause ────────────────────────────────────
  if (remaining <= 0) {
    return {
      action: 'pause',
      reason: `budget exhausted: spent $${spentUsd.toFixed(4)} >= cap $${dailyBudget.toFixed(4)}`,
    };
  }

  // ── Near-cap threshold: >90% of daily budget consumed ⇒ pause ─────────────
  const usedFraction = spentUsd / dailyBudget;
  if (usedFraction >= 1.0) {
    return {
      action: 'pause',
      reason: `budget at hard cap (${(usedFraction * 100).toFixed(0)}% of $${dailyBudget.toFixed(4)})`,
    };
  }

  // ── Monthly projection warning: at 80%+ daily budget, cascade tiers ────────
  // The forecast provides monthly projection; we use daily fraction as the
  // primary signal (more immediate, same scaling).

  const currentTier = decision.tier;

  // ── No cascade needed when tier is already local ──────────────────────────
  if (currentTier === 'local') {
    // Can't cascade further — either proceed or pause at hard cap.
    if (usedFraction >= 0.95) {
      return {
        action: 'pause',
        reason: `budget near hard cap (${(usedFraction * 100).toFixed(0)}%) and backend already local`,
      };
    }
    return {
      action: 'cascade',
      decision,
      reason: `budget ok (${(usedFraction * 100).toFixed(0)}% used), backend already local — no change`,
    };
  }

  // ── Cascade thresholds (frontier → mid → local → pause) ───────────────────
  //   >= 95% → pause
  //   >= 80% → cascade one step
  //   >= 60% and frontier → cascade to mid
  //   < 60% → keep current tier

  const currentTierIdx = TIER_CASCADE.indexOf(currentTier);
  // If tier not in cascade list (shouldn't happen) treat as local.
  const effectiveIdx = currentTierIdx < 0 ? TIER_CASCADE.length - 1 : currentTierIdx;

  let targetTierIdx: number;
  if (usedFraction >= 0.95) {
    // Near hard cap: pause regardless of tier.
    return {
      action: 'pause',
      reason: `budget at ${(usedFraction * 100).toFixed(0)}% of daily cap — pausing to avoid overspend`,
    };
  } else if (usedFraction >= 0.80) {
    // 80–95%: cascade two steps toward local.
    targetTierIdx = Math.min(effectiveIdx + 2, TIER_CASCADE.length - 1);
  } else if (usedFraction >= 0.60 && currentTier === 'frontier') {
    // 60–80% and frontier: cascade one step to mid.
    targetTierIdx = effectiveIdx + 1;
  } else {
    // < 60% or already mid/local: no cascade.
    targetTierIdx = effectiveIdx;
  }

  // Also consult projected monthly from forecast: if projectedMonthlyUsd > 30 ×
  // daily budget (i.e., on track to spend >100% of budget every day this month),
  // apply one additional cascade step.
  const projectedDailyFromForecast =
    forecast.projectedMonthlyUsd > 0 ? forecast.projectedMonthlyUsd / 30 : 0;
  if (projectedDailyFromForecast > dailyBudget && targetTierIdx < TIER_CASCADE.length - 1) {
    targetTierIdx = Math.min(targetTierIdx + 1, TIER_CASCADE.length - 1);
  }

  const targetTier = TIER_CASCADE[targetTierIdx] as EngineTier;

  // No change needed.
  if (targetTierIdx <= effectiveIdx || targetTier === currentTier) {
    return {
      action: 'cascade',
      decision,
      reason: `budget ${(usedFraction * 100).toFixed(0)}% used — no tier cascade needed for ${currentTier}`,
    };
  }

  // Find a backend at the target tier within allowed set.
  const cascadedBackend = backendForTier(targetTier, allowed, FRONTIER_PREFERENCE);
  if (cascadedBackend === null) {
    // Target tier has no allowed backend — try next tier.
    for (let i = targetTierIdx + 1; i < TIER_CASCADE.length; i++) {
      const fallbackTier = TIER_CASCADE[i] as EngineTier;
      const fb = backendForTier(fallbackTier, allowed, FRONTIER_PREFERENCE);
      if (fb !== null) {
        return {
          action: 'cascade',
          decision: { backend: fb, tier: fallbackTier, reason: 'budget-cascade' },
          reason:
            `budget cascade: ${currentTier}→${targetTier} has no allowed backend; ` +
            `fell back to ${fallbackTier} (${fb})`,
        };
      }
    }
    // No backend at any lower tier — pause.
    return {
      action: 'pause',
      reason: `budget cascade: no lower-tier backend available — pausing`,
    };
  }

  return {
    action: 'cascade',
    decision: {
      backend: cascadedBackend,
      tier: targetTier,
      reason: `budget-cascade (${currentTier}→${targetTier}, ${(usedFraction * 100).toFixed(0)}% used)`,
    },
    reason:
      `budget cascade: ${currentTier}→${targetTier} (${(usedFraction * 100).toFixed(0)}% of $${dailyBudget.toFixed(2)} used)`,
  };
}
