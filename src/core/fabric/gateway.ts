/**
 * gateway.ts — M247 / SPEC-INFERENCE-FABRIC Phase F1: InferenceGateway.
 *
 * Consolidates the scattered per-item routing overrides in daemon/loop.ts
 * (lines 705–770: routeBackend + quota guard + subscription throttle + M53
 * recommendRoute + recoverWithinBudget) into one pure function that returns a
 * single traceable GatewayDecision object.
 *
 * SAFETY CONTRACT:
 *  - When cfg.foundry.fabric?.gateway !== true (DEFAULT), decide() is a THIN
 *    PASS-THROUGH that returns exactly what routeBackend() already returns —
 *    byte-identical behavior. Zero new logic executes on the old path.
 *  - Never throws. Catch-all returns { backend: 'builtin', tier: 'local' }.
 *  - Never weakens any safety gate (M54/sandbox/judge/scope-cap).
 *  - Output always within cfg.foundry.allowedBackends (enforced by the
 *    underlying routeBackend / recommendRoute / recoverWithinBudget contracts).
 *  - Deterministic: no clock, no randomness in the decision (stableHash FNV-1a
 *    in routeBackend is preserved).
 *
 * LATENT BUG FIX (M247 prerequisite):
 *  learned-router.ts:tierOf (line 122) hard-codes any non-builtin engine as
 *  'frontier', so M53's mid-nudge via backendForTier('mid',...) can never
 *  resolve a mid backend — it silently falls through to builtin. The gateway
 *  does NOT call that tierOf; it calls engineTierOf from sandboxed-engine.ts
 *  which reads the declarative engine registry. Flag-gated: the fix only fires
 *  when cfg.foundry.fabric?.gateway === true.
 *
 * This file imports NO apply/merge/push/create-pr/deploy primitive — the same
 * contract enforced in learned-router.ts. Every output is a routing decision
 * object, never an outward action.
 */

import type { AshlrConfig, EngineId, EngineTier, WorkItem, CostForecast } from '../types.js';
import { routeBackend } from '../fleet/router.js';
import { withinLimit } from '../fleet/quota.js';
import { subscriptionAllows, isSubscriptionEngine } from '../fleet/subscription-usage.js';
import { recommendRoute, recoverWithinBudget } from '../run/learned-router.js';
import { engineTierOf } from '../run/sandboxed-engine.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One step in the routing decision trace. */
export interface GatewayTraceStep {
  stage: string;
  backend: EngineId;
  tier: EngineTier;
  reason: string;
}

/**
 * The unified routing decision returned by decide().
 *
 * On the flag-OFF path (default), trace is [] and source/reason are minimal.
 * On the flag-ON path, trace records every override step so decision history
 * is fully auditable.
 */
export interface GatewayDecision {
  /** Backend chosen to attempt this item. Always within allowedBackends. */
  backend: EngineId;
  /** Tier of the chosen backend. */
  tier: EngineTier;
  /** Concrete model (may be absent when engine picks its own default). */
  model?: string | null;
  /**
   * Origin: 'fleet' for WorkItem inputs (daemon path),
   * 'cli' for { goal, repo } inputs (orchestrator path).
   */
  source: 'fleet' | 'cli';
  /**
   * Ordered trace of every routing step. Empty on the flag-OFF pass-through
   * path. Populated on the flag-ON path for debuggability / dashboard display.
   */
  trace: GatewayTraceStep[];
  /** Final reason (last trace step's reason, or 'pass-through' on flag-OFF). */
  reason: string;
}

/** Context passed by the caller for budget / cost-recovery decisions. */
export interface GatewayCtx {
  /** USD spent so far this tick (used by recoverWithinBudget). */
  spentUsd?: number;
  /** Cost forecast (used by recoverWithinBudget). */
  forecast?: CostForecast;
  /**
   * Subscription max-percent threshold (0–100).
   * Mirrors loop.ts subscriptionMaxPercent logic. Default 90.
   */
  subscriptionMaxPercent?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the input is a full WorkItem (has 'id' and 'source'). */
function isWorkItem(input: WorkItem | { goal: string; repo: string }): input is WorkItem {
  return 'id' in input && 'source' in input;
}

/**
 * Minimal base decision for CLI-path inputs (no WorkItem context).
 * The CLI path doesn't have a WorkItem, so we use the config default backend.
 */
function cliBaseDecision(
  _input: { goal: string; repo: string },
  cfg: AshlrConfig,
): { backend: EngineId; tier: EngineTier; model?: string | null; reason: string } {
  // For CLI inputs: use the first allowed non-builtin backend when available,
  // else fall back to builtin. This mirrors what orchestrator.ts does today.
  const allowed = cfg.foundry?.allowedBackends ?? ['builtin'];
  const backend: EngineId = (allowed[0] as EngineId | undefined) ?? 'builtin';
  const tier = engineTierOf(backend, cfg);
  return { backend, tier, model: null, reason: 'cli-base: first allowed backend' };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Decide which backend/tier/model to use for this item.
 *
 * Flag-OFF (default): thin pass-through — returns exactly what routeBackend()
 * returns for WorkItem inputs, or cliBaseDecision for { goal, repo } inputs.
 * Zero new logic; byte-identical to pre-M247 routing.
 *
 * Flag-ON (cfg.foundry.fabric?.gateway === true): runs the full consolidated
 * routing sequence and returns a traced GatewayDecision.
 */
export async function decide(
  input: WorkItem | { goal: string; repo: string },
  cfg: AshlrConfig,
  ctx: GatewayCtx = {},
): Promise<GatewayDecision> {
  // ── FLAG-OFF: thin pass-through (DEFAULT) ────────────────────────────────
  if (cfg.foundry?.fabric?.gateway !== true) {
    if (isWorkItem(input)) {
      const d = routeBackend(input, cfg);
      return {
        backend: d.backend,
        tier: d.tier,
        model: d.model,
        source: 'fleet',
        trace: [],
        reason: 'pass-through',
      };
    }
    const d = cliBaseDecision(input, cfg);
    return { ...d, source: 'cli', trace: [], reason: 'pass-through' };
  }

  // ── FLAG-ON: full consolidated routing sequence ───────────────────────────
  try {
    const trace: GatewayTraceStep[] = [];

    // Step 1: Base routing via routeBackend (or cli-base for non-WorkItem).
    let current: { backend: EngineId; tier: EngineTier; model?: string | null; reason: string };
    if (isWorkItem(input)) {
      const d = routeBackend(input, cfg);
      current = { backend: d.backend, tier: d.tier, model: d.model, reason: d.reason };
    } else {
      current = cliBaseDecision(input, cfg);
    }
    trace.push({ stage: 'routeBackend', backend: current.backend, tier: current.tier, reason: current.reason });

    // Step 2: Quota guard — if backend over rolling rate limit, fall to builtin.
    if (current.backend !== 'builtin' && !withinLimit(current.backend, cfg)) {
      current = { backend: 'builtin', tier: 'local', model: null, reason: 'quota exceeded — fallback to builtin' };
      trace.push({ stage: 'quotaGuard', backend: current.backend, tier: current.tier, reason: current.reason });
    }

    // Step 3: Subscription throttle — skip when subscription window is at cap.
    if (isSubscriptionEngine(current.backend)) {
      const rawPct = (cfg.foundry as Record<string, unknown> | undefined)?.['subscriptionMaxPercent'];
      const maxPct: number =
        typeof ctx.subscriptionMaxPercent === 'number'
          ? Math.min(100, Math.max(1, ctx.subscriptionMaxPercent))
          : typeof rawPct === 'number'
            ? Math.min(100, Math.max(1, rawPct))
            : 90;
      const subCheck = subscriptionAllows(current.backend, { maxPercent: maxPct });
      if (!subCheck.allowed) {
        // Return a 'throttled' decision — caller handles the skip.
        current = {
          backend: current.backend,
          tier: current.tier,
          model: current.model,
          reason: `throttled: subscription window — ${subCheck.reason}`,
        };
        trace.push({ stage: 'subscriptionThrottle', backend: current.backend, tier: current.tier, reason: current.reason });
        // Return early — throttled items are not dispatched (caller checks reason prefix).
        return {
          backend: current.backend,
          tier: current.tier,
          model: current.model,
          source: isWorkItem(input) ? 'fleet' : 'cli',
          trace,
          reason: current.reason,
        };
      }
    }

    // Step 4: M53 learned-router recommend + budget cascade (WorkItem only).
    // Uses engineTierOf from the registry (fixes learned-router.ts:tierOf bug).
    if (isWorkItem(input)) {
      const intelRaw = cfg.foundry?.intelligence;
      if (intelRaw !== undefined && intelRaw !== null) {
        const nudge = await recommendRoute(input, cfg, {});
        // Only override when the nudge doesn't escalate a local decision.
        if (current.tier !== 'local' || nudge.tier === 'local') {
          if (nudge.backend !== current.backend) {
            // Verify the nudged backend tier via registry (fixes tierOf bug).
            const resolvedTier = engineTierOf(nudge.backend, cfg);
            current = { backend: nudge.backend, tier: resolvedTier, model: null, reason: nudge.reason };
            trace.push({ stage: 'm53Nudge', backend: current.backend, tier: current.tier, reason: current.reason });
          }
        }

        // Budget cascade: step down tier when near cap.
        const spentUsd = ctx.spentUsd ?? 0;
        const forecast = ctx.forecast ?? buildNullForecast();
        const recovery = recoverWithinBudget(
          { backend: current.backend, tier: current.tier, reason: current.reason },
          cfg,
          spentUsd,
          forecast,
        );
        if (recovery.action === 'pause') {
          // Signal pause via reason — caller checks for 'budget-pause' prefix.
          return {
            backend: current.backend,
            tier: current.tier,
            model: current.model,
            source: 'fleet',
            trace,
            reason: `budget-pause: ${recovery.reason}`,
          };
        } else if (recovery.decision.backend !== current.backend) {
          const resolvedTier = engineTierOf(recovery.decision.backend, cfg);
          current = {
            backend: recovery.decision.backend,
            tier: resolvedTier,
            model: null,
            reason: recovery.reason,
          };
          trace.push({ stage: 'budgetCascade', backend: current.backend, tier: current.tier, reason: current.reason });
        }
      }
    }

    return {
      backend: current.backend,
      tier: current.tier,
      model: current.model,
      source: isWorkItem(input) ? 'fleet' : 'cli',
      trace,
      reason: trace.at(-1)?.reason ?? current.reason,
    };
  } catch {
    // Never-throw: fail open to builtin on any error.
    return {
      backend: 'builtin',
      tier: 'local',
      model: null,
      source: isWorkItem(input) ? 'fleet' : 'cli',
      trace: [],
      reason: 'error-fallback: exception in gateway.decide — safe fallback to builtin',
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a null/zero CostForecast when the caller didn't provide one.
 * recoverWithinBudget is PURE and uses only spentUsd + dailyBudget; the
 * forecast fields are used for informational reasons only, not decision logic.
 */
function buildNullForecast(): CostForecast {
  return {
    window: '7d',
    spentUsd: 0,
    localSavingsUsd: 0,
    projectedMonthlyUsd: 0,
  };
}
