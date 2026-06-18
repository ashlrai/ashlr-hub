/**
 * router.ts — M46: capability-tiered backend router for the autonomous fleet.
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
 *  - Pure except for engineInstalled()'s PATH probe (read-only, never throws).
 *
 * ROUTING HEURISTIC (documented) — FRONTIER-FIRST:
 *  The 'builtin' engine plans work items but does NOT write code: every
 *  proposal it produces is a 0-diff. Routing everything to 'builtin' means
 *  frontier coders (claude/codex, which DO edit files) receive zero dispatches.
 *
 *  New policy: frontier backends are preferred for ALL items whenever one is
 *  allowed AND installed.
 *  - If a FRONTIER backend is available (allowed + installed): route to it.
 *    The $5/day budget cap is enforced by the daemon quota layer — the router
 *    does NOT ration frontier seats. With no frontier, 'builtin' is the only
 *    option even if it produces no diff.
 *  - If NO frontier is available: fall back to 'builtin'.
 *  - When MULTIPLE frontier backends are allowed+installed, alternate
 *    DETERMINISTICALLY by a stable hash of item.id so 'claude' and 'codex'
 *    share the load evenly.
 */

import type { AshlrConfig, EngineId, EngineTier, WorkItem } from '../types.js';
import { engineInstalled } from '../run/engines.js';
import { engineTierOf } from '../run/sandboxed-engine.js';

/** The outcome of routing a WorkItem to a backend. */
export interface RouteDecision {
  /** Backend chosen to attempt the item. Always allowed + (if external) installed. */
  backend: EngineId;
  /** Tier of the chosen backend ('local' | 'frontier'). */
  tier: EngineTier;
  /** Short human-readable rationale. */
  reason: string;
}

/** Frontier backends in preference order — first allowed+installed wins ties. */
const FRONTIER_PREFERENCE: readonly EngineId[] = ['claude', 'codex'];

/**
 * Stable, deterministic 32-bit FNV-1a hash of a string. Used only to pick which
 * frontier backend handles an item — NOT a security primitive.
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
 * The frontier backends that are BOTH allowed and installed, in preference
 * order. Empty when none qualify (caller then falls back to 'builtin').
 */
function availableFrontiers(cfg: AshlrConfig): EngineId[] {
  const allowed = allowedSet(cfg);
  return FRONTIER_PREFERENCE.filter(
    (e) => allowed.has(e) && engineInstalled(e),
  );
}

/**
 * Pick a frontier backend deterministically. With one candidate, returns it;
 * with multiple, alternates by a stable hash of item.id so the senior load is
 * split predictably (no clock, no randomness). Returns null when none qualify.
 */
function pickFrontier(item: WorkItem, cfg: AshlrConfig): EngineId | null {
  const frontiers = availableFrontiers(cfg);
  if (frontiers.length === 0) return null;
  if (frontiers.length === 1) return frontiers[0]!;
  const idx = stableHash(item.id) % frontiers.length;
  return frontiers[idx]!;
}

/** Build a decision for a concrete backend, deriving its tier. */
function decide(backend: EngineId, reason: string): RouteDecision {
  return { backend, tier: engineTierOf(backend), reason };
}

/**
 * Route a WorkItem to the backend that should attempt it.
 *
 * PURE + DETERMINISTIC (modulo engineInstalled's read-only PATH probe). Never
 * throws. Honors allowedBackends and PATH availability — see module heuristic.
 *
 * FRONTIER-FIRST: routes every item to the best available frontier backend
 * (claude/codex). Falls back to 'builtin' only when no frontier is
 * allowed+installed, because builtin produces 0-diff proposals (no code edits).
 */
export function routeBackend(item: WorkItem, cfg: AshlrConfig): RouteDecision {
  // ── Frontier-first: prefer any allowed+installed frontier backend ──────────
  // builtin plans but does NOT write code (0-diff proposals). The $5/day quota
  // cap is enforced by the daemon quota layer, not here.
  const frontier = pickFrontier(item, cfg);
  if (frontier) {
    return decide(
      frontier,
      `frontier-first: builtin produces no diffs → frontier ${frontier} (source=${item.source}, effort=${typeof item.effort === 'number' ? item.effort : 3})`,
    );
  }

  // ── No frontier available → fall back to builtin ──────────────────────────
  return decide(
    'builtin',
    `no frontier allowed+installed → local builtin (source=${item.source})`,
  );
}
