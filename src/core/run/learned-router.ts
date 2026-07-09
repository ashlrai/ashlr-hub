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
import { readDecisions } from '../fleet/decisions-ledger.js';
import { engineTierOf as _engineTierOf } from './sandboxed-engine.js';
import { engineInstalled } from './engines.js';
import { canonicalModelTag, type ModelEntry } from './model-catalog.js';
import { readJudgeTraces } from '../fleet/judge-trace.js';
import {
  readDispatchProductionEvents,
  type DispatchProductionEvent,
} from '../fleet/dispatch-production-ledger.js';

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
  /**
   * Minimum recent proposal-yield rate for a backend before trying an allowed
   * same-tier alternative. Default 0.2; requires at least three samples.
   */
  minProposalYieldRate?: number;
  /** Window for dispatch-production yield priors, in hours. Default 24. */
  dispatchYieldWindowHours?: number;
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
 * Map a backend EngineId to its EngineTier via the declarative engine registry.
 *
 * M247 fix: the previous implementation hard-coded any non-builtin engine as
 * 'frontier', which meant M53's backendForTier('mid', ...) could never return
 * a mid backend (local-coder/nim/kimi/hermes all resolved to 'frontier' here,
 * making the mid pool appear empty). This caused M53's cost-saving nudge to
 * silently fall through to 'builtin' instead of a mid backend.
 *
 * Fix: delegate to _engineTierOf (sandboxed-engine.ts) which reads the merged
 * engine registry including any cfg.foundry.engines overrides. The registry
 * maps {claude, codex} → 'frontier', {local-coder, kimi, hermes, nim} → 'mid'
 * (or 'frontier' when nim.tier='frontier'), builtin → 'local'.
 *
 * cfg is optional for backward-compatibility with call sites that pass only
 * the engine id. Without cfg the builtin registry is used (same as before for
 * claude/codex; correctly returns 'mid' for local-coder/kimi/hermes/nim).
 */
function tierOf(backend: EngineId, cfg?: AshlrConfig): EngineTier {
  return _engineTierOf(backend, cfg);
}

/**
 * Find the best backend within the allowed set that matches the given tier.
 * Returns null when no allowed backend has that tier.
 *
 * M247: accepts optional cfg so tierOf can consult the engine registry (fixes
 * the mid-backend resolution bug — see tierOf comment above).
 */
function backendForTier(
  tier: EngineTier,
  allowed: Set<EngineId>,
  preferredOrder: readonly EngineId[],
  cfg?: AshlrConfig,
): EngineId | null {
  for (const e of preferredOrder) {
    if (allowed.has(e) && tierOf(e, cfg) === tier) return e;
  }
  // Fallback: scan the full allowed set.
  for (const e of allowed) {
    if (tierOf(e, cfg) === tier) return e;
  }
  return null;
}

/** The preferred frontier backend ordering (mirrors FRONTIER_PREFERENCE in router.ts). */
const FRONTIER_PREFERENCE: readonly EngineId[] = ['claude', 'codex'];
const MIN_DISPATCH_YIELD_SAMPLES = 3;
const DEFAULT_DISPATCH_YIELD_WINDOW_HOURS = 24;

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

interface DispatchYieldPrior {
  attempts: number;
  proposalsCreated: number;
  proposalRate: number;
  topReason?: string;
}

function clampRate(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function loadDispatchYieldEvents(
  intel: FoundryIntelligenceCfg,
  eventsOverride?: DispatchProductionEvent[],
): DispatchProductionEvent[] {
  if (eventsOverride !== undefined) return eventsOverride;
  try {
    const hours =
      typeof intel.dispatchYieldWindowHours === 'number' && intel.dispatchYieldWindowHours > 0
        ? intel.dispatchYieldWindowHours
        : DEFAULT_DISPATCH_YIELD_WINDOW_HOURS;
    return readDispatchProductionEvents({
      sinceMs: Date.now() - hours * 60 * 60 * 1000,
      limit: 1000,
      maxFiles: Math.max(1, Math.ceil(hours / 24) + 1),
    });
  } catch {
    return [];
  }
}

function dispatchYieldForBackend(
  events: DispatchProductionEvent[],
  backend: EngineId,
  source: WorkItem['source'],
): DispatchYieldPrior {
  const reasons = new Map<string, number>();
  let attempts = 0;
  let proposalsCreated = 0;
  for (const event of events) {
    if (event.backend !== backend) continue;
    if (event.source !== source) continue;
    attempts++;
    if (event.proposalCreated) proposalsCreated++;
    const reason = event.reason ?? event.routeReason ?? event.outcome;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const topReason = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return {
    attempts,
    proposalsCreated,
    proposalRate: attempts > 0 ? proposalsCreated / attempts : 1,
    ...(topReason ? { topReason } : {}),
  };
}

function installedSameTierAlternative(
  current: EngineId,
  tier: EngineTier,
  allowed: Set<EngineId>,
  cfg: AshlrConfig,
): EngineId | null {
  for (const backend of allowed) {
    if (backend === current) continue;
    if (backend === 'builtin') continue;
    if (tierOf(backend, cfg) !== tier) continue;
    if (!engineInstalled(backend, cfg)) continue;
    return backend;
  }
  return null;
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
    dispatchProductionEvents?: DispatchProductionEvent[];
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
    const midBackend = backendForTier('mid', allowed, FRONTIER_PREFERENCE, cfg);
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
      const midBackend = backendForTier('mid', allowed, FRONTIER_PREFERENCE, cfg);
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

  // ── Dispatch-production yield penalty ────────────────────────────────────
  // Uses the append-only no-diff/proposal-created ledger. This never escalates
  // tier and only fires with enough same-backend/source samples, so it is a
  // final same-tier nudge, not a safety authority. Lower-tier safety/cost
  // nudges above get priority.
  const dispatchEvents = loadDispatchYieldEvents(intel, opts?.dispatchProductionEvents);
  const yieldPrior = dispatchYieldForBackend(dispatchEvents, base.backend, item.source);
  const minProposalYieldRate = clampRate(intel.minProposalYieldRate, 0.2);
  if (
    yieldPrior.attempts >= MIN_DISPATCH_YIELD_SAMPLES &&
    yieldPrior.proposalRate < minProposalYieldRate
  ) {
    const alternate = installedSameTierAlternative(base.backend, base.tier, allowed, cfg);
    if (alternate !== null) {
      return {
        backend: alternate,
        tier: base.tier,
        reason:
          `learned-router: recent proposal yield for ${base.backend} ` +
          `${yieldPrior.proposalsCreated}/${yieldPrior.attempts} ` +
          `< threshold ${(minProposalYieldRate * 100).toFixed(0)}%` +
          `${yieldPrior.topReason ? ` (top: ${yieldPrior.topReason})` : ''} — ` +
          `same-tier reroute to ${alternate}`,
        confidence: Math.min(0.55 + (yieldPrior.attempts / 20) * 0.35, 0.9),
      };
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
  const cascadedBackend = backendForTier(targetTier, allowed, FRONTIER_PREFERENCE, cfg);
  if (cascadedBackend === null) {
    // Target tier has no allowed backend — try next tier.
    for (let i = targetTierIdx + 1; i < TIER_CASCADE.length; i++) {
      const fallbackTier = TIER_CASCADE[i] as EngineTier;
      const fb = backendForTier(fallbackTier, allowed, FRONTIER_PREFERENCE, cfg);
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

// ---------------------------------------------------------------------------
// M240: Learned-bias engine scoring from decisions ledger
// ---------------------------------------------------------------------------

/**
 * M240: The minimum number of judged decisions per (engine, model, taskClass)
 * key required before any bias is applied. Below this threshold the score is
 * returned as 0.5 (neutral) so cold-start falls back to static policy unchanged.
 */
export const LEARNED_ROUTING_MIN_SAMPLES = 5;

// Covers sub-second read-after-write skew only: at the 5-sample floor with the
// 7-day half-life, 1e-6 weighted sample units is about 175ms of decay.
const LEARNED_ROUTING_SAMPLE_FLOOR_EPSILON = 1e-6;

/**
 * M240: Recency half-life in milliseconds. Verdicts older than this are
 * down-weighted exponentially. Default: 7 days.
 */
export const LEARNED_ROUTING_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * M240: Positive verdict labels — a 'judged' entry with one of these verdicts
 * counts as a "ship" (positive outcome) for the engine.
 */
const SHIP_VERDICTS = new Set(['ship', 'applied', 'approved']);

/**
 * M240: Negative verdict labels — a 'judged' entry with one of these verdicts
 * counts as a "reject" (negative outcome).
 */
const REJECT_VERDICTS = new Set(['noise', 'review', 'harmful', 'decline', 'rejected']);

/**
 * M240: A single (engine, model, taskClass) score derived from historical judge
 * outcomes. `score` is in [0, 1]: higher = more "ship" outcomes. `samples` is
 * the recency-weighted sample count (may be fractional), snapped to
 * LEARNED_ROUTING_MIN_SAMPLES only when it is within the tiny clock-drift
 * epsilon described above.
 */
export interface EngineScore {
  /** Composite engine key: `<engine>:<model>` (e.g. 'claude:opus'). */
  key: string;
  /** Engine id (e.g. 'claude'). */
  engine: EngineId;
  /** Model tag (e.g. 'opus'), or null when the entry has no model. */
  model: string | null;
  /**
   * Learned ship-rate for this key over the given taskClass.
   * Value is in [0, 1]; 0.5 means no data / cold-start (neutral).
   * Higher values bias toward this engine/model; lower values bias away.
   */
  score: number;
  /**
   * Recency-weighted sample count. A value microscopically below
   * LEARNED_ROUTING_MIN_SAMPLES can be snapped to the threshold to avoid
   * immediate-read clock drift; below that, score is 0.5 (neutral).
   */
  samples: number;
}

/**
 * M240: All engine scores for a given taskClass, keyed by `<engine>:<model>`.
 * Built once per routeTask call and passed into `engineScoreFor`.
 */
export type EngineScoreMap = Map<string, EngineScore>;

function legacyTaskClassFromProposalId(proposalId?: string): string | null {
  const parts = (proposalId ?? '').split(':');
  return parts.length >= 2 && parts[1] ? parts[1] : null;
}

function taskClassFromWorkItemId(workItemId?: string): string | null {
  if (!workItemId) return null;
  const parts = workItemId.split(':');
  return parts.length >= 3 && parts[1] ? parts[1] : null;
}

function taskClassFromDecisionEntry(entry: {
  workSource?: string;
  workItemId?: string;
  proposalId?: string;
}): string {
  return (
    entry.workSource ||
    taskClassFromWorkItemId(entry.workItemId) ||
    legacyTaskClassFromProposalId(entry.proposalId) ||
    '*'
  );
}

function stableLearnedSampleCount(weightedTotal: number): number {
  const missing = LEARNED_ROUTING_MIN_SAMPLES - weightedTotal;
  return missing > 0 && missing <= LEARNED_ROUTING_SAMPLE_FLOOR_EPSILON
    ? LEARNED_ROUTING_MIN_SAMPLES
    : weightedTotal;
}

function scoreFromWeightedCounts(ship: number, reject: number): { samples: number; score: number } {
  const weightedTotal = ship + reject;
  const samples = stableLearnedSampleCount(weightedTotal);
  const score =
    samples >= LEARNED_ROUTING_MIN_SAMPLES && weightedTotal > 0
      ? ship / weightedTotal
      : 0.5;
  return { samples, score };
}

/**
 * M240: Build a score map for a given `taskClass` from the decisions ledger.
 *
 * Algorithm:
 *  1. Read recent 'judged' decisions (sinceMs = now - 90 days max).
 *  2. For each entry, extract engine + model + verdict + ts.
 *  3. Derive taskClass from canonical workSource/workItemId, with legacy
 *     proposalId parsing only for old ledgers.
 *  4. Apply recency weight: w = 2^(-(age_ms / HALF_LIFE_MS)).
 *  5. Accumulate weighted ship/reject counts per (engine:model, taskClass) key.
 *  6. ship_rate = weightedShip / (weightedShip + weightedReject); neutral 0.5
 *     when stabilized totalWeight < LEARNED_ROUTING_MIN_SAMPLES.
 *
 * PURE: reads ledger files but never mutates them. Never throws.
 * Cold-start (empty ledger or no matching entries) → returns an empty map
 * (all calls to `engineScoreFor` return 0.5).
 *
 * @param taskClass   The WorkItem.source string (e.g. 'issue', 'todo', 'lint').
 * @param nowMs       Injectable clock for deterministic tests (default Date.now()).
 * @param sinceMs     Optional lower bound; default = now - 90 days.
 */
export function buildEngineScores(
  taskClass: string,
  nowMs?: number,
  sinceMs?: number,
): EngineScoreMap {
  const map: EngineScoreMap = new Map();
  try {
    const now = nowMs ?? Date.now();
    const windowMs = sinceMs ?? now - 90 * 24 * 60 * 60 * 1000;

    const entries = readDecisions({ sinceMs: windowMs });

    // Accumulators: key → { ship: number, reject: number } (recency-weighted)
    const acc = new Map<string, { engine: EngineId; model: string | null; ship: number; reject: number }>();

    for (const entry of entries) {
      if (entry.action !== 'judged') continue;
      if (!entry.engine) continue;

      const verdict = entry.verdict ?? '';
      const isShip = SHIP_VERDICTS.has(verdict);
      const isReject = REJECT_VERDICTS.has(verdict);
      if (!isShip && !isReject) continue;

      const entryTaskClass = taskClassFromDecisionEntry(entry);

      // Only count entries that match the requested taskClass (or wildcard).
      if (entryTaskClass !== taskClass && entryTaskClass !== '*') continue;

      const engine = entry.engine as EngineId;
      const model = entry.model ?? null;
      const key = model ? `${engine}:${model}` : engine;

      // Recency weight: exponential decay
      const ageMs = now - Date.parse(entry.ts);
      const weight = Math.pow(2, -(Math.max(0, ageMs) / LEARNED_ROUTING_HALF_LIFE_MS));

      let slot = acc.get(key);
      if (!slot) {
        slot = { engine, model, ship: 0, reject: 0 };
        acc.set(key, slot);
      }
      if (isShip) slot.ship += weight;
      else slot.reject += weight;
    }

    // Convert accumulators to EngineScore
    for (const [key, { engine, model, ship, reject }] of acc) {
      const { samples, score } = scoreFromWeightedCounts(ship, reject);
      map.set(key, { key, engine, model, score, samples });
    }
  } catch {
    // Never throw — cold-start fallback is an empty map.
  }
  return map;
}

/**
 * M240: Look up the learned score for a given (engine, model) pair against a
 * pre-built EngineScoreMap. Returns 0.5 (neutral) when:
 *  - The map is empty (cold-start / learnedRouting disabled).
 *  - The key is not present (no history for this engine+model+taskClass).
 *  - The sample count is below LEARNED_ROUTING_MIN_SAMPLES.
 *
 * A score > 0.5 biases toward this engine (more ships than rejects).
 * A score < 0.5 biases away (more rejects than ships).
 *
 * @param scores   The map from buildEngineScores().
 * @param engine   The engine id to look up.
 * @param model    The model tag (e.g. 'opus'); or null to look up engine-only.
 */
export function engineScoreFor(
  scores: EngineScoreMap,
  engine: EngineId,
  model: string | null,
): number {
  if (scores.size === 0) return 0.5;
  // Try exact (engine:model) key first, then engine-only fallback.
  const exactKey = model ? `${engine}:${model}` : String(engine);
  const exact = scores.get(exactKey);
  if (exact !== undefined) return exact.score;
  // Engine-only fallback: aggregate all models for this engine
  let totalShip = 0;
  let totalReject = 0;
  let found = false;
  for (const s of scores.values()) {
    if (s.engine !== engine) continue;
    found = true;
    // Recover raw ship/reject from score × samples
    totalShip += s.score * s.samples;
    totalReject += (1 - s.score) * s.samples;
  }
  if (!found) return 0.5;
  const total = totalShip + totalReject;
  if (total < LEARNED_ROUTING_MIN_SAMPLES) return 0.5;
  return totalShip / total;
}

/**
 * M240: Sort a list of engine ids by their learned score for the given task,
 * highest score first. Engines with score < 0.5 are placed after those with
 * score ≥ 0.5 (neutral or better). Ties are stable (original order preserved).
 *
 * This is used by routeTask to reorder the tryEngine candidate list before
 * attempting each engine — the engine with the best history is tried first.
 * Hard constraints (capability/tier/quota/allowedBackends) are unchanged.
 *
 * @param engines  Ordered list of engine ids (existing static policy order).
 * @param scores   Score map from buildEngineScores().
 * @param model    Optional model hint for exact-key lookup (may be null).
 */
export function sortEnginesByScore(
  engines: readonly EngineId[],
  scores: EngineScoreMap,
  model: string | null = null,
): EngineId[] {
  if (scores.size === 0) return [...engines];
  // Stable sort: engines with higher score come first.
  const withScores = engines.map((e) => ({ e, s: engineScoreFor(scores, e, model) }));
  withScores.sort((a, b) => b.s - a.s);
  return withScores.map((x) => x.e);
}

// ---------------------------------------------------------------------------
// M323: producer-attributed scores + cost-aware model selection
// ---------------------------------------------------------------------------

/**
 * M323: Build a PRODUCER-attributed score map for `taskClass`.
 *
 * M240's buildEngineScores keys on the 'judged' entries' engine/model — which
 * is the JUDGE's identity (all three judged record sites write judgeEngine
 * into both fields), so producer engines never matched a key and the learned
 * bias stayed effectively neutral. This variant joins each judged verdict
 * back to its 'proposed' entry by proposalId and accumulates the
 * recency-weighted ship/reject counts onto the PRODUCER's
 * `${engine}:${canonicalTag}` key — canonicalModelTag collapses ledger
 * spelling variants ('claude:claude-sonnet-5' vs 'sonnet-5') onto one key.
 *
 * PURE read of the ledger; never throws; cold start → empty map.
 */
export function buildProducerScores(
  taskClass: string,
  nowMs?: number,
  sinceMs?: number,
): EngineScoreMap {
  const map: EngineScoreMap = new Map();
  try {
    const now = nowMs ?? Date.now();
    const windowStart = sinceMs ?? now - 90 * 24 * 60 * 60 * 1000;
    const entries = readDecisions({ sinceMs: windowStart });
    if (entries.length === 0) return map;

    // Pass 1: producer identity per proposal (from 'proposed' entries),
    // filtered to the requested taskClass. readDecisions returns newest-first,
    // so the map MUST be complete before verdicts are attributed (a judged
    // entry chronologically follows — and therefore precedes in this order —
    // its 'proposed').
    const producerOf = new Map<string, { engine: EngineId; tag: string }>();
    for (const e of entries) {
      if (e.action !== 'proposed' || !e.engine) continue;
      const entryTaskClass = taskClassFromDecisionEntry(e);
      if (entryTaskClass !== taskClass && entryTaskClass !== '*') continue;
      if (producerOf.has(e.proposalId)) continue;
      const tag = canonicalModelTag(e.engine, e.model ?? '');
      producerOf.set(e.proposalId, { engine: e.engine as EngineId, tag });
    }

    // Pass 2: judged verdicts joined back to the producer.
    const acc = new Map<
      string,
      { engine: EngineId; model: string | null; ship: number; reject: number }
    >();
    for (const e of entries) {
      if (e.action !== 'judged') continue;
      const producer = producerOf.get(e.proposalId);
      if (!producer) continue;
      const verdict = e.verdict ?? '';
      const isShip = SHIP_VERDICTS.has(verdict);
      const isReject = REJECT_VERDICTS.has(verdict);
      if (!isShip && !isReject) continue;
      const key = producer.tag ? `${producer.engine}:${producer.tag}` : String(producer.engine);
      const ageMs = now - Date.parse(e.ts);
      const weight = Math.pow(2, -(Math.max(0, ageMs) / LEARNED_ROUTING_HALF_LIFE_MS));
      let slot = acc.get(key);
      if (!slot) {
        slot = { engine: producer.engine, model: producer.tag || null, ship: 0, reject: 0 };
        acc.set(key, slot);
      }
      if (isShip) slot.ship += weight;
      else slot.reject += weight;
    }

    // Pass 3 (M332): real-world outcomes. A merge that was later REVERTED
    // counts as a full extra reject on the producer; a near-term FOLLOW-UP
    // fix counts as half a reject — the judge's moment-of-merge 'ship' is
    // corrected by what actually happened on main.
    try {
      const traces = readJudgeTraces({ outcomeOnly: true, sinceMs: windowStart });
      // M337 (review fix): cross-day linkOutcome appends PATCH records, so
      // one proposal's outcome can appear multiple times — count it ONCE.
      const seenOutcome = new Set<string>();
      for (const t of traces) {
        if (t.outcome !== 'reverted' && t.outcome !== 'followed-up') continue;
        if (seenOutcome.has(t.proposalId)) continue;
        seenOutcome.add(t.proposalId);
        const producer = producerOf.get(t.proposalId);
        if (!producer) continue;
        const key = producer.tag ? `${producer.engine}:${producer.tag}` : String(producer.engine);
        const slot = acc.get(key);
        if (!slot) continue;
        const ageMs = now - Date.parse(t.outcomeAt ?? t.ts);
        const weight = Math.pow(2, -(Math.max(0, ageMs) / LEARNED_ROUTING_HALF_LIFE_MS));
        slot.reject += weight * (t.outcome === 'reverted' ? 1 : 0.5);
      }
    } catch {
      // outcome enrichment is best-effort — scores fall back to verdict-only
    }

    for (const [key, { engine, model, ship, reject }] of acc) {
      const { samples, score } = scoreFromWeightedCounts(ship, reject);
      map.set(key, { key, engine, model, score, samples });
    }
  } catch {
    // Never throw — cold-start fallback is an empty map.
  }
  return map;
}

/**
 * M323: choose the CHEAPEST candidate whose learned producer ship-rate is
 * ≥ opts.minShipRate with ≥ LEARNED_ROUTING_MIN_SAMPLES samples.
 *
 * Returns null (→ caller falls back to the static pick, byte-identically)
 * when NO candidate has enough samples. When sampled candidates exist but
 * none clears the bar, the best-scoring sampled candidate wins ONLY if its
 * score ≥ 0.5 — we never learn INTO a bad model; static policy is the floor.
 *
 * PURE — imports no apply/merge primitives (CONTRACT-M53: learned decisions
 * never auto-apply). Hard constraints (availability, tier, quota, capability,
 * effort, claude5 gating) are the CALLER's responsibility via `candidates`.
 */
export function selectCostAwareModel(
  candidates: readonly ModelEntry[],
  scores: EngineScoreMap,
  opts: { minShipRate: number },
): ModelEntry | null {
  if (candidates.length === 0 || scores.size === 0) return null;
  const byCost = [...candidates].sort(
    (a, b) => a.costPerMTokIn + a.costPerMTokOut - (b.costPerMTokIn + b.costPerMTokOut),
  );
  let bestSampled: { entry: ModelEntry; score: number } | null = null;
  for (const entry of byCost) {
    const tag = canonicalModelTag(entry.engine, entry.id.slice(entry.id.indexOf(':') + 1));
    const s = scores.get(`${entry.engine}:${tag}`);
    if (!s || s.samples < LEARNED_ROUTING_MIN_SAMPLES) continue;
    if (s.score >= opts.minShipRate) return entry; // cheapest clearing the bar
    if (!bestSampled || s.score > bestSampled.score) bestSampled = { entry, score: s.score };
  }
  if (bestSampled && bestSampled.score >= 0.5) return bestSampled.entry;
  return null;
}
