/**
 * router.ts — M46 + M115 + M128: capability-tiered backend router for the
 * autonomous fleet, now with model-granular routing.
 *
 * Maps a discovered WorkItem to the backend (EngineId) AND the concrete model
 * that should attempt it, honoring cfg.foundry.allowedBackends, PATH
 * availability, quota limits, and subscription windows.
 *
 * M128 adds: routeTask() enriches RouteDecision with {model, reason} by
 * delegating to run/router.ts#routeTask after the engine tier is selected.
 *
 * GUARDRAILS:
 *  - NEVER returns a backend not in allowedBackends (default ['builtin']).
 *  - NEVER returns an external backend that fails engineInstalled() — falls back
 *    to 'builtin' (which is always available).
 *  - Pure except for engineInstalled()'s PATH/URL probe (read-only, never throws).
 *  - local-coder (mid-tier) NEVER gains main-merge authority — only frontier
 *    backends (claude/codex) carry engineTier === 'frontier' which is the gate
 *    requirement for auto-merge to main.
 *
 * ROUTING HEURISTIC (M115) — LOCAL-FIRST BULK, FRONTIER FOR HARD/ESCALATION:
 *
 *  The 'builtin' engine plans work items but does NOT write code (0-diff).
 *  M115 introduces 'local-coder' (Ollama/qwen2.5:72b) as a free, unlimited
 *  mid-tier coding engine that runs the agent-loop with write tools in a
 *  sandboxed worktree, capturing real diffs like claude/codex do.
 *
 *  Three-tier policy (in evaluation order):
 *
 *  1. FRONTIER for hard/high-value items: when a frontier backend (claude/codex)
 *     is allowed+installed AND the item has effort ≥ FRONTIER_EFFORT_THRESHOLD
 *     OR score ≥ FRONTIER_SCORE_THRESHOLD, route to frontier. Frontier retains
 *     sole merge-to-main authority.
 *
 *  2. LOCAL-MID for bulk items: when a mid-tier backend (local-coder, nim, kimi,
 *     hermes …) is allowed+installed AND the item is below the frontier thresholds,
 *     route to the local-mid engine. This makes Ollama the FREE workhorse for the
 *     bulk of items.
 *
 *  3. FALLBACK FRONTIER for any item when no mid backend is available but a frontier
 *     is (preserves pre-M115 behavior when local-coder is absent/not allowed).
 *
 *  4. BUILTIN as last resort when no external backend qualifies.
 *
 *  Escalation: when a local-mid diff fails verify in the daemon, the daemon
 *  re-queues the item with source='escalation'; source==='escalation' forces
 *  frontier routing regardless of effort/score.
 *
 * M128 MODEL ENRICHMENT:
 *  After the engine tier is chosen, routeBackend calls routeTask() from
 *  run/router.ts to pick the optimal model within that engine. The model is
 *  returned in RouteDecision.model and a combined reason is surfaced.
 *  The judge/manager/strategist always get a STRONG model (opus/sonnet or the
 *  72b) — this is handled by callers setting the engine override; the router
 *  does not regress managerJudgeModel behavior.
 */

import type { AshlrConfig, EngineId, EngineTier, WorkItem } from '../types.js';
import { engineInstalled } from '../run/engines.js';
import { engineTierOf } from '../run/sandboxed-engine.js';
import { routeTask, isSubstantiveItem, SUBSTANTIVE_SOURCES, type RoutingContext } from '../run/router.js';
import {
  isTrustedCaptureRepairItem,
  isTrustedDiagnosticResliceItem,
  isTrustedGeneratedRepairItem,
} from './self-heal-trust.js';
import {
  generatedRepairBackendAllowed,
  generatedRepairGenerationId,
  generatedRepairRetryPolicy,
  type GeneratedRepairRetryPolicy,
} from './generated-repair-lifecycle.js';
import { withinLimit } from './quota.js';
import { isSubscriptionEngine, subscriptionAllows } from './subscription-usage.js';

/** The outcome of routing a WorkItem to a backend + model. */
export interface RouteDecision {
  /** Backend chosen to attempt the item. Always allowed + (if external) installed. */
  backend: EngineId;
  /** Tier of the chosen backend ('local' | 'mid' | 'frontier'). */
  tier: EngineTier;
  /**
   * M128: concrete model to pass as opts.model to the engine dispatch.
   * Null/absent means "use the engine's built-in default".
   */
  model?: string | null;
  /** Short human-readable rationale (engine tier + model selection). */
  reason: string;
}

/** Final candidate contract shared by gateway and concurrent repair routing. */
export function generatedRepairCandidateAllowed(
  item: WorkItem,
  backend: EngineId,
  cfg: AshlrConfig,
): boolean {
  if (!generatedRepairExecutionBackendAllowed(item, backend, cfg)) return false;
  if (!withinLimit(backend, cfg)) return false;
  if (isSubscriptionEngine(backend)) {
    const configuredMax = (cfg.foundry as Record<string, unknown> | undefined)?.['subscriptionMaxPercent'];
    const maxPercent = typeof configuredMax === 'number'
      ? Math.min(100, Math.max(1, configuredMax))
      : 90;
    if (!subscriptionAllows(backend, { maxPercent }).allowed) return false;
  }
  return true;
}

/** Post-execution authority check; excludes mutable capacity counters consumed by this run. */
export function generatedRepairExecutionBackendAllowed(
  item: WorkItem,
  backend: EngineId,
  cfg: AshlrConfig,
): boolean {
  const parentTierBoundCapture = isTrustedCaptureRepairItem(item) &&
    (item.repairParentSource === 'issue' || item.repairParentSource === 'goal');
  if (!isTrustedGeneratedRepairItem(item)) return true;
  const retryPolicy = generatedRepairRetryPolicy(item);
  if (!retryPolicy.available) return false;
  const requiredTier = retryPolicy.requiredTier ?? (
    isTrustedDiagnosticResliceItem(item) || parentTierBoundCapture
      ? item.repairParentTier ?? null
      : null
  );
  if (!generatedRepairBackendAllowed(item, backend) || backend === 'builtin') return false;
  const allowed = new Set<EngineId>(cfg.foundry?.allowedBackends ?? ['builtin']);
  if (!allowed.has(backend) || !engineInstalled(backend, cfg)) return false;
  return requiredTier === null
    ? !retryPolicy.requireAlternative
    : engineTierOf(backend, cfg) === requiredTier;
}

/**
 * Frontier backends in preference order — first allowed+installed wins ties.
 *
 * M195: 'nim' is appended LAST so that when NIM is config-promoted to frontier
 * (cfg.foundry.nim.tier='frontier' — running Kimi K2 as frontier ammo), it joins
 * the frontier rotation behind claude/codex. The actual frontier gate is the
 * resolved tier check in availableFrontier() (engineTierOf === 'frontier'), so a
 * 'nim' that is NOT promoted (default mid) is silently excluded here and still
 * routed via MID_PREFERENCE — byte-identical to pre-M195 for unpromoted NIM.
 */
const FRONTIER_PREFERENCE: readonly EngineId[] = ['claude', 'codex', 'nim'];

/**
 * M115: Mid-tier backends in preference order. Typed as string[] because
 * 'local-coder'/'nim'/'kimi' are config-registered engines not yet in the
 * EngineId union (types.ts is owned by another agent). The Set/filter in
 * allowedSet/availableFrom accept EngineId via string coercion — all valid at
 * runtime; the tier is determined by engineTierOf which reads the registry.
 */
const MID_PREFERENCE: readonly string[] = ['local-coder', 'nim', 'kimi', 'hermes'];

/** All editing engines eligible for exact-tier diagnostic repair retries. */
const REPAIR_PREFERENCE: readonly EngineId[] = [
  'claude', 'codex', 'nim', 'kimi', 'grok', 'local-coder', 'hermes',
  'opencode', 'ashlrcode', 'aw',
];

export type GeneratedRepairRouteReason =
  | 'feasible'
  | 'provenance-unavailable'
  | 'lifecycle-unavailable'
  | 'editing-backend-unavailable'
  | 'same-tier-backend-unavailable'
  | 'same-tier-alternative-unavailable'
  | 'route-capacity-unavailable';

export interface GeneratedRepairRouteFeasibility {
  feasible: boolean;
  requiredTier: EngineTier | null;
  requiresAlternative: boolean;
  backend: EngineId | null;
  reason: GeneratedRepairRouteReason;
}

/** Read-only route inspection using caller-supplied point-in-time lifecycle authority. */
export function inspectGeneratedRepairRouteFeasibility(
  item: WorkItem,
  cfg: AshlrConfig,
  policy: GeneratedRepairRetryPolicy,
): GeneratedRepairRouteFeasibility {
  const parentTierBoundCapture = isTrustedCaptureRepairItem(item) &&
    (item.repairParentSource === 'issue' || item.repairParentSource === 'goal');
  const requiredTier = policy.requiredTier ?? (
    isTrustedDiagnosticResliceItem(item) || parentTierBoundCapture
      ? item.repairParentTier ?? null
      : null
  );
  const unavailable = (reason: Exclude<GeneratedRepairRouteReason, 'feasible'>): GeneratedRepairRouteFeasibility => ({
    feasible: false,
    requiredTier,
    requiresAlternative: policy.requireAlternative,
    backend: null,
    reason,
  });
  if (!policy.applies || !policy.available) return unavailable('lifecycle-unavailable');
  if ((isTrustedDiagnosticResliceItem(item) || parentTierBoundCapture) && requiredTier === null) {
    return unavailable('provenance-unavailable');
  }
  const exactTierRepairRoute = policy.requireAlternative || requiredTier !== null;
  let routeCandidates: EngineId[];
  if (exactTierRepairRoute) {
    const allowed = new Set<EngineId>(cfg.foundry?.allowedBackends ?? ['builtin']);
    const installed = REPAIR_PREFERENCE.filter((backend) =>
      allowed.has(backend) && engineInstalled(backend, cfg));
    if (installed.length === 0) return unavailable('editing-backend-unavailable');
    routeCandidates = requiredTier === null
      ? installed
      : installed.filter((backend) => engineTierOf(backend, cfg) === requiredTier);
    if (routeCandidates.length === 0) return unavailable('same-tier-backend-unavailable');
    if (policy.requireAlternative) {
      routeCandidates = routeCandidates.filter((backend) => backend !== policy.excludedBackend);
      if (routeCandidates.length === 0) return unavailable('same-tier-alternative-unavailable');
    }
  } else {
    const frontiers = availableFrontier(cfg);
    const mids = availableMid(cfg);
    const qualityPolicy = cfg.foundry?.routingPolicy === 'quality';
    const frontierCandidate = isFrontierItem(item) ||
      isGeneratedNoDiffProposalRepair(item) ||
      isGeneratedCaptureProposalRepair(item) ||
      (qualityPolicy && isSubstantiveItem(item));
    routeCandidates = frontierCandidate && frontiers.length > 0
      ? frontiers
      : mids.length > 0 ? mids : frontiers;
    if (routeCandidates.length === 0) return unavailable('editing-backend-unavailable');
  }
  const capacityCandidates = exactTierRepairRoute
    ? routeCandidates
    : [pickFrom(routeCandidates, item)!];
  const candidates = capacityCandidates.filter((backend) => {
    if (!withinLimit(backend, cfg)) return false;
    if (!isSubscriptionEngine(backend)) return true;
    const configuredMax = (cfg.foundry as Record<string, unknown> | undefined)?.['subscriptionMaxPercent'];
    const maxPercent = typeof configuredMax === 'number'
      ? Math.min(100, Math.max(1, configuredMax))
      : 90;
    return subscriptionAllows(backend, { maxPercent }).allowed;
  });
  const backend = candidates[0] ?? null;
  if (backend === null) return unavailable('route-capacity-unavailable');
  return {
    feasible: true,
    requiredTier,
    requiresAlternative: policy.requireAlternative,
    backend,
    reason: 'feasible',
  };
}

/**
 * M115: Effort threshold above which frontier is preferred over local-mid.
 * Items with effort >= this value are considered "hard" and routed to frontier
 * (when available). Default: 4 (on a 1–5 scale, 4–5 are senior/complex tasks).
 */
const FRONTIER_EFFORT_THRESHOLD = 4;

/**
 * M115: Score threshold above which frontier is preferred over local-mid.
 * Items with score >= this value are routed to frontier when available.
 * Default: 8 (on a 1–10 scale, high-priority items warrant frontier attention).
 */
const FRONTIER_SCORE_THRESHOLD = 8;

/**
 * Stable, deterministic 32-bit FNV-1a hash of a string. Used to pick which
 * backend handles an item when multiple of the same tier are available —
 * NOT a security primitive.
 */
function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply (kept in unsigned 32-bit range).
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The allowed backends, defaulting to ['builtin'] when foundry is absent.
 * Always contains at least 'builtin' as a guaranteed fallback.
 */
function allowedSet(cfg: AshlrConfig): ReadonlySet<EngineId> {
  const allowed = cfg.foundry?.allowedBackends ?? ['builtin'];
  const set = new Set<EngineId>(allowed);
  set.add('builtin'); // builtin is always a valid fallback target
  return set;
}

/**
 * Filter a preference list to backends that are BOTH allowed and installed.
 * Preserves the preference order. Returns empty when none qualify.
 * Accepts `readonly string[]` so MID_PREFERENCE (which includes config-only
 * engine ids not yet in the EngineId union) can be passed without a cast.
 */
function availableFrom(preference: readonly string[], cfg: AshlrConfig): EngineId[] {
  const allowed = allowedSet(cfg);
  return preference.filter(
    (e) => allowed.has(e as EngineId) && engineInstalled(e as EngineId, cfg),
  ) as EngineId[];
}

/**
 * M195: frontier candidates = FRONTIER_PREFERENCE entries that are allowed,
 * installed, AND resolve to tier 'frontier'. The resolved-tier gate is what lets
 * 'nim' join the frontier rotation ONLY when promoted via cfg.foundry.nim.tier=
 * 'frontier' (engineTierOf reads the merged registry incl. the nim override).
 * An unpromoted (default mid) 'nim' is excluded here and handled by the mid path.
 * For claude/codex this is identical to the pre-M195 list (both are frontier).
 */
function availableFrontier(cfg: AshlrConfig): EngineId[] {
  return availableFrom(FRONTIER_PREFERENCE, cfg).filter(
    (e) => engineTierOf(e, cfg) === 'frontier',
  );
}

/**
 * M195: mid candidates = MID_PREFERENCE entries that are allowed + installed,
 * EXCLUDING any that resolved to frontier (e.g. a frontier-promoted 'nim' must
 * not be double-counted as a mid backend — it belongs to the frontier rotation).
 */
function availableMid(cfg: AshlrConfig): EngineId[] {
  return availableFrom(MID_PREFERENCE, cfg).filter(
    (e) => engineTierOf(e, cfg) !== 'frontier',
  );
}

/**
 * Pick one backend deterministically from a list. With one candidate returns
 * it directly; with multiple alternates by stable hash of item.id (no clock,
 * no randomness). Returns null when the list is empty.
 */
function pickFrom(candidates: EngineId[], item: WorkItem): EngineId | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  return candidates[stableHash(item.id) % candidates.length]!;
}

/**
 * True when the item should be escalated to frontier regardless of tier.
 * Escalation sources ('escalation') are always sent to frontier.
 * High-effort or high-score items are also frontier-eligible.
 */
function isFrontierItem(item: WorkItem): boolean {
  if ((item.source as string) === 'escalation') return true;
  const effort = typeof item.effort === 'number' ? item.effort : 3;
  const score = typeof item.score === 'number' ? item.score : 3;
  return effort >= FRONTIER_EFFORT_THRESHOLD || score >= FRONTIER_SCORE_THRESHOLD;
}

function isGeneratedNoDiffProposalRepair(item: WorkItem): boolean {
  return isTrustedDiagnosticResliceItem(item);
}

function isGeneratedCaptureProposalRepair(item: WorkItem): boolean {
  return isTrustedCaptureRepairItem(item);
}

/**
 * Build a decision for a concrete backend, deriving its tier.
 * M195: thread cfg so a config-promoted backend (e.g. cfg.foundry.nim.tier=
 * 'frontier') reports its RESOLVED tier — not the static builtin tier. Without
 * a cfg the resolved tier equals the builtin tier (byte-identical to pre-M195).
 */
function decide(backend: EngineId, reason: string, cfg?: AshlrConfig): Omit<RouteDecision, 'model'> {
  return { backend, tier: engineTierOf(backend, cfg), reason };
}

/**
 * Build the RoutingContext required by routeTask from the list of available engines.
 * The available engines are those already selected by availableFrom across all tiers.
 */
function buildRoutingContext(
  frontiers: EngineId[],
  mids: EngineId[],
): RoutingContext {
  return { availableEngines: [...frontiers, ...mids, 'builtin'] };
}

/**
 * Route a WorkItem to the backend AND model that should attempt it.
 *
 * M128: Extends the M115 engine-tier decision with model-granular selection
 * via routeTask(). The RouteDecision now includes a `model` field.
 *
 * PURE + DETERMINISTIC (modulo engineInstalled's read-only PATH/URL probe).
 * Never throws. Honors allowedBackends and availability — see module heuristic.
 *
 * M115 three-tier policy:
 *  1. Hard/high-value items → frontier (claude/codex) when available.
 *     M182 (quality policy only): ALSO routes substantive items (source ∈
 *     SUBSTANTIVE_SOURCES: goal/issue/security/feature/invent) to frontier.
 *     Under cost/absent policy the substantive widening is NOT applied —
 *     behavior is byte-identical to pre-M182 for non-quality policies.
 *  2. Bulk items → local-mid (local-coder/Ollama first, then nim/kimi/hermes).
 *  3. No mid available but frontier is → frontier (pre-M115 fallback behavior).
 *  4. Neither → builtin (0-diff, better than nothing).
 */
export function routeBackend(item: WorkItem, cfg: AshlrConfig): RouteDecision {
  const frontiers = availableFrontier(cfg);
  const mids = availableMid(cfg);
  const ctx = buildRoutingContext(frontiers, mids);
  const isNoDiffRepair = isGeneratedNoDiffProposalRepair(item);
  const isCaptureRepair = isGeneratedCaptureProposalRepair(item);
  const isParentTierBoundCapture = isCaptureRepair &&
    (item.repairParentSource === 'issue' || item.repairParentSource === 'goal');

  if (
    isCaptureRepair &&
    generatedRepairGenerationId(item) === null
  ) {
    return {
      ...decide('builtin', 'capture-repair-provenance-unavailable: durable handoff does not match queue metadata', cfg),
      model: null,
    };
  }

  if (isParentTierBoundCapture && !item.repairParentTier) {
    return {
      ...decide('builtin', 'capture-repair-provenance-missing: durable parent tier unavailable', cfg),
      model: null,
    };
  }

  if (isParentTierBoundCapture && item.repairParentTier) {
    const retryPolicy = generatedRepairRetryPolicy(item);
    if (!retryPolicy.available) {
      return {
        ...decide('builtin', 'capture-repair-lifecycle-unavailable: retry authority unavailable', cfg),
        model: null,
      };
    }
    const requiredTier = retryPolicy.requiredTier ?? item.repairParentTier;
    const sameTier = REPAIR_PREFERENCE.filter(
      (backend) => generatedRepairCandidateAllowed(item, backend, cfg),
    );
    const preferred = !retryPolicy.requireAlternative && item.repairParentBackend && sameTier.includes(item.repairParentBackend)
      ? item.repairParentBackend
      : pickFrom(sameTier, item);
    if (preferred) {
      return {
        ...decide(
          preferred,
          retryPolicy.requireAlternative
            ? `capture-repair-alternative-selected: moved ${retryPolicy.excludedBackend ?? 'unknown'}→${preferred} within ${requiredTier}`
            : `capture-repair-tier-preserved: generated ${item.repairParentSource} repair remains ${requiredTier} (parent=${item.repairParentBackend ?? 'unknown'})`,
          cfg,
        ),
        model: null,
      };
    }
    return {
      ...decide('builtin', retryPolicy.requireAlternative
        ? `capture-repair-alternative-unavailable: no installed ${requiredTier} backend differs from ${retryPolicy.excludedBackend ?? 'unknown'}`
        : `capture-repair-tier-unavailable: no installed ${requiredTier} backend`, cfg),
      model: null,
    };
  }

  if (isNoDiffRepair && !item.repairParentTier) {
    return {
      ...decide('builtin', 'repair-provenance-missing: durable parent tier unavailable', cfg),
      model: null,
    };
  }

  if (isNoDiffRepair && item.repairParentTier) {
    const retryPolicy = generatedRepairRetryPolicy(item);
    if (!retryPolicy.available) {
      return {
        ...decide('builtin', 'repair-lifecycle-unavailable: retry authority unavailable', cfg),
        model: null,
      };
    }
    const requiredTier = retryPolicy.requiredTier ?? item.repairParentTier;
    const sameTier = REPAIR_PREFERENCE.filter(
      (backend) => generatedRepairCandidateAllowed(item, backend, cfg),
    );
    const preferred = !retryPolicy.requireAlternative && item.repairParentBackend && sameTier.includes(item.repairParentBackend)
      ? item.repairParentBackend
      : pickFrom(sameTier, item);
    if (preferred) {
      return {
        ...decide(
          preferred,
          retryPolicy.requireAlternative
            ? `repair-alternative-selected: generated no-diff retry moved ${retryPolicy.excludedBackend ?? 'unknown'}→${preferred} within ${requiredTier}`
            : `repair-tier-preserved: generated no-diff repair remains ${requiredTier} (parent=${item.repairParentBackend ?? 'unknown'})`,
          cfg,
        ),
        model: null,
      };
    }
    return {
      ...decide(
        'builtin',
        retryPolicy.requireAlternative
          ? `repair-alternative-unavailable: no installed ${requiredTier} backend differs from ${retryPolicy.excludedBackend ?? 'unknown'}`
          : `repair-tier-unavailable: no installed ${requiredTier} backend for generated no-diff repair`,
        cfg,
      ),
      model: null,
    };
  }

  if (isTrustedGeneratedRepairItem(item)) {
    const retryPolicy = generatedRepairRetryPolicy(item);
    if (!retryPolicy.available) {
      return {
        ...decide('builtin', 'repair-lifecycle-unavailable: retry authority unavailable', cfg),
        model: null,
      };
    }
    if (retryPolicy.requireAlternative) {
      const preferred = pickFrom(
        REPAIR_PREFERENCE.filter((backend) => generatedRepairCandidateAllowed(item, backend, cfg)),
        item,
      );
      if (preferred) {
        return {
          ...decide(
            preferred,
            `repair-alternative-selected: generated retry moved ${retryPolicy.excludedBackend ?? 'unknown'}→${preferred} within ${retryPolicy.requiredTier}`,
            cfg,
          ),
          model: null,
        };
      }
      return {
        ...decide('builtin', `repair-alternative-unavailable: no installed ${retryPolicy.requiredTier} backend differs from ${retryPolicy.excludedBackend ?? 'unknown'}`, cfg),
        model: null,
      };
    }
  }

  // ── 1. Frontier for hard/escalation items (+ substantive under quality policy) ─
  //
  // M182: under routingPolicy='quality', substantive sources (goal/issue/security/
  // feature/invent) are also routed to frontier — these are the items Mason wants
  // frontier AI to handle end-to-end. Under cost/absent policy the extra condition
  // is NOT evaluated (byte-identical parity with pre-M182 for those policies).
  const qualityPolicy = cfg.foundry?.routingPolicy === 'quality';
  const isFrontierCandidate =
    isFrontierItem(item) ||
    isNoDiffRepair ||
    isCaptureRepair ||
    (qualityPolicy && isSubstantiveItem(item));
  if (isFrontierCandidate && frontiers.length > 0) {
    const chosen = pickFrom(frontiers, item)!;
    const effort = typeof item.effort === 'number' ? item.effort : 3;
    const score = typeof item.score === 'number' ? item.score : 3;
    let baseReason = `frontier: hard/escalation item (source=${item.source}, effort=${effort}, score=${score}) → ${chosen}`;
    if (qualityPolicy && !isFrontierItem(item) && SUBSTANTIVE_SOURCES.has(item.source as string)) {
      baseReason = `frontier: quality policy substantive item (source=${item.source}) → ${chosen}`;
    }
    if (isNoDiffRepair) {
      baseReason = `frontier: generated no-diff proposal repair (source=${item.source}) → ${chosen}`;
    }
    if (isCaptureRepair) {
      baseReason = `frontier: generated capture proposal repair (source=${item.source}) → ${chosen}`;
    }

    // M128: enrich with model selection
    const taskRoute = routeTask(item, cfg, { ...ctx, availableEngines: [chosen, ...ctx.availableEngines] });
    const engineReason = taskRoute.engine === chosen
      ? baseReason
      : baseReason; // engine from task routing may differ — use the tier-selected engine
    const modelTag = taskRoute.engine === chosen ? taskRoute.model : null;
    const modelSuffix = modelTag ? ` [model:${modelTag}]` : '';

    return {
      ...decide(chosen, `${engineReason}${modelSuffix}`, cfg),
      model: modelTag,
    };
  }

  // ── 2. Local-mid for bulk items ────────────────────────────────────────────
  // Free + unlimited; local-coder (Ollama) is preferred. Frontier reserves its
  // capacity for high-value items and escalation re-tries.
  if (mids.length > 0) {
    const chosen = pickFrom(mids, item)!;
    const effort = typeof item.effort === 'number' ? item.effort : 3;
    const baseReason = `local-mid bulk: ${chosen} (source=${item.source}, effort=${effort}) — frontier reserved for hard items`;

    // M128: enrich with model selection
    const taskRoute = routeTask(item, cfg, { ...ctx, availableEngines: [chosen, ...frontiers, 'builtin'] });
    const modelTag = taskRoute.engine === chosen ? taskRoute.model : null;
    const modelSuffix = modelTag ? ` [model:${modelTag}]` : '';

    return {
      ...decide(chosen, `${baseReason}${modelSuffix}`, cfg),
      model: modelTag,
    };
  }

  // ── 3. Fallback: any frontier when no mid backend is available ─────────────
  // Preserves pre-M115 behavior: frontier gets all items when local-coder is
  // absent or not in allowedBackends.
  if (frontiers.length > 0) {
    const chosen = pickFrom(frontiers, item)!;
    const baseReason = `frontier-fallback: no mid backend allowed+installed → ${chosen} (source=${item.source})`;

    // M128: enrich with model selection
    const taskRoute = routeTask(item, cfg, { ...ctx, availableEngines: [chosen, 'builtin'] });
    const modelTag = taskRoute.engine === chosen ? taskRoute.model : null;
    const modelSuffix = modelTag ? ` [model:${modelTag}]` : '';

    return {
      ...decide(chosen, `${baseReason}${modelSuffix}`, cfg),
      model: modelTag,
    };
  }

  // ── 4. Last resort: builtin (0-diff, plans only) ──────────────────────────
  return {
    ...decide('builtin', `no external backend allowed+installed → builtin (source=${item.source})`, cfg),
    model: null,
  };
}
