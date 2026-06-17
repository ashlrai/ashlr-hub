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
 * ROUTING HEURISTIC (documented):
 *  - LOW-effort / bulk classes — source 'doc'|'dep'|'todo'|'test', OR effort<=2
 *    — go to 'builtin' (local loop, unbounded, $0). No reason to spend a
 *    rate-limited frontier seat on cheap, mechanical work.
 *  - HIGH-difficulty / important classes — source 'security'|'issue', OR
 *    effort>=4, OR a high score — go to a FRONTIER backend (prefer 'claude',
 *    else 'codex') when it is allowed AND installed, else fall back to 'builtin'.
 *  - MEDIUM (everything else) stays on 'builtin' UNLESS a frontier backend is
 *    allowed+installed AND the item is src-touching (a 'test' or 'todo' that
 *    is not low-effort, or any non-bulk source) — then it gets a frontier seat.
 *  - When MULTIPLE frontier backends are allowed+installed, alternate
 *    DETERMINISTICALLY by a stable hash of item.id so 'claude' and 'codex'
 *    share the senior load evenly.
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

/** Bulk / low-difficulty sources that route to the local builtin loop. */
const BULK_SOURCES: ReadonlySet<string> = new Set(['doc', 'dep', 'todo', 'test']);

/** High-difficulty / important sources that warrant a frontier seat. */
const SENIOR_SOURCES: ReadonlySet<string> = new Set(['security', 'issue']);

/** Score at/above which an item is considered "important" (frontier-worthy). */
const HIGH_SCORE = 7;

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
 */
export function routeBackend(item: WorkItem, cfg: AshlrConfig): RouteDecision {
  const source = item.source;
  const effort = typeof item.effort === 'number' ? item.effort : 3;
  const score = typeof item.score === 'number' ? item.score : 0;

  // ── LOW-effort / bulk → builtin (local, unbounded, $0) ───────────────────
  if (BULK_SOURCES.has(source) || effort <= 2) {
    return decide('builtin', `bulk/low-effort (${source}, effort ${effort}) → local builtin`);
  }

  // ── HIGH-difficulty / important → frontier when available, else builtin ──
  const isSenior = SENIOR_SOURCES.has(source) || effort >= 4 || score >= HIGH_SCORE;
  if (isSenior) {
    const frontier = pickFrontier(item, cfg);
    if (frontier) {
      return decide(frontier, `senior (${source}, effort ${effort}, score ${score}) → frontier ${frontier}`);
    }
    return decide('builtin', `senior (${source}) but no frontier allowed+installed → local builtin`);
  }

  // ── MEDIUM → builtin unless a frontier is available (src-touching) ───────
  // Anything that reached here is a non-bulk source with effort 3 — treat it as
  // src-touching and give it a frontier seat when one is allowed+installed.
  const frontier = pickFrontier(item, cfg);
  if (frontier) {
    return decide(frontier, `medium src-touching (${source}, effort ${effort}) → frontier ${frontier}`);
  }
  return decide('builtin', `medium (${source}, effort ${effort}) → local builtin`);
}
