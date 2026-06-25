/**
 * router.ts — M46 + M115: capability-tiered backend router for the autonomous fleet.
 *
 * Maps a discovered WorkItem to the backend (EngineId) that should attempt it,
 * honoring cfg.foundry.allowedBackends and PATH availability. The policy is a
 * pure, DETERMINISTIC heuristic (no Math.random, no clock): the same item +
 * config always routes the same way, so the decision is unit-testable and the
 * senior load is split predictably across frontier backends.
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
 */

import type { AshlrConfig, EngineId, EngineTier, WorkItem } from '../types.js';
import { engineInstalled } from '../run/engines.js';
import { engineTierOf } from '../run/sandboxed-engine.js';

/** The outcome of routing a WorkItem to a backend. */
export interface RouteDecision {
  /** Backend chosen to attempt the item. Always allowed + (if external) installed. */
  backend: EngineId;
  /** Tier of the chosen backend ('local' | 'mid' | 'frontier'). */
  tier: EngineTier;
  /** Short human-readable rationale. */
  reason: string;
}

/** Frontier backends in preference order — first allowed+installed wins ties. */
const FRONTIER_PREFERENCE: readonly EngineId[] = ['claude', 'codex'];

/**
 * M115: Mid-tier backends in preference order. Typed as string[] because
 * 'local-coder'/'nim'/'kimi' are config-registered engines not yet in the
 * EngineId union (types.ts is owned by another agent). The Set/filter in
 * allowedSet/availableFrom accept EngineId via string coercion — all valid at
 * runtime; the tier is determined by engineTierOf which reads the registry.
 */
const MID_PREFERENCE: readonly string[] = ['local-coder', 'nim', 'kimi', 'hermes'];

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

/** Build a decision for a concrete backend, deriving its tier. */
function decide(backend: EngineId, reason: string): RouteDecision {
  return { backend, tier: engineTierOf(backend), reason };
}

/**
 * Route a WorkItem to the backend that should attempt it.
 *
 * PURE + DETERMINISTIC (modulo engineInstalled's read-only PATH/URL probe).
 * Never throws. Honors allowedBackends and availability — see module heuristic.
 *
 * M115 three-tier policy:
 *  1. Hard/high-value items → frontier (claude/codex) when available.
 *  2. Bulk items → local-mid (local-coder/Ollama first, then nim/kimi/hermes).
 *  3. No mid available but frontier is → frontier (pre-M115 fallback behavior).
 *  4. Neither → builtin (0-diff, better than nothing).
 */
export function routeBackend(item: WorkItem, cfg: AshlrConfig): RouteDecision {
  const frontiers = availableFrom(FRONTIER_PREFERENCE, cfg);
  const mids = availableFrom(MID_PREFERENCE, cfg);

  // ── 1. Frontier for hard/escalation items ─────────────────────────────────
  if (isFrontierItem(item) && frontiers.length > 0) {
    const chosen = pickFrom(frontiers, item)!;
    const effort = typeof item.effort === 'number' ? item.effort : 3;
    const score = typeof item.score === 'number' ? item.score : 3;
    return decide(
      chosen,
      `frontier: hard/escalation item (source=${item.source}, effort=${effort}, score=${score}) → ${chosen}`,
    );
  }

  // ── 2. Local-mid for bulk items ────────────────────────────────────────────
  // Free + unlimited; local-coder (Ollama) is preferred. Frontier reserves its
  // capacity for high-value items and escalation re-tries.
  if (mids.length > 0) {
    const chosen = pickFrom(mids, item)!;
    const effort = typeof item.effort === 'number' ? item.effort : 3;
    return decide(
      chosen,
      `local-mid bulk: ${chosen} (source=${item.source}, effort=${effort}) — frontier reserved for hard items`,
    );
  }

  // ── 3. Fallback: any frontier when no mid backend is available ─────────────
  // Preserves pre-M115 behavior: frontier gets all items when local-coder is
  // absent or not in allowedBackends.
  if (frontiers.length > 0) {
    const chosen = pickFrom(frontiers, item)!;
    return decide(
      chosen,
      `frontier-fallback: no mid backend allowed+installed → ${chosen} (source=${item.source})`,
    );
  }

  // ── 4. Last resort: builtin (0-diff, plans only) ──────────────────────────
  return decide(
    'builtin',
    `no external backend allowed+installed → builtin (source=${item.source})`,
  );
}
