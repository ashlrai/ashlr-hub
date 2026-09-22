/**
 * src/core/portfolio/scoring.ts — the single source of truth for WorkItem
 * priority scoring: the raw value/effort heuristic and the source-tier
 * weighting applied on top of it.
 *
 * A leaf module with no imports. It exists so that both the scanners (which
 * stamp a provisional score onto each item they emit) and backlog.ts (which
 * recomputes the authoritative score during `buildBacklog`) can share one
 * implementation. Previously scanners.ts re-inlined the formula to avoid a
 * cycle with backlog.ts and kept a comment promising the two stayed in sync;
 * they had already diverged. A leaf module removes the cycle risk that made
 * the copy seem necessary.
 *
 * backlog.ts re-exports `scoreItem` and `sourceTierMultiplier` so existing
 * importers keep working.
 *
 * Pure and deterministic.
 */

/**
 * Priority score; higher = do first.
 * Heuristic: value / effort (both clamped to 1..5, so effort can never be 0
 * and the result is always finite and > 0).
 *
 * NOT rounded: callers that want a display value round at the edge. Rounding
 * here loses ordering information between items whose scores differ in the
 * third decimal.
 */
export function scoreItem(value: number, effort: number): number {
  const v = Math.max(1, Math.min(5, value));
  const e = Math.max(1, Math.min(5, effort));
  return v / e;
}

/**
 * Source priority tiers. Higher tier = more substantive work.
 *
 * Tier 3 (highest) — goal, issue: directive goals and tracked bugs drive real
 *   feature/fix work; the fleet should always prefer these.
 * Tier 2 (high)    — security, test: security vulnerabilities and failing tests
 *   are urgent and produce concrete diffs.
 * Tier 1 (normal)  — self, plugin, doc: useful but not fleet-critical.
 * Tier 0 (low)     — dep, lint, hygiene, todo: often noisy / low yield; should
 *   rank below substantive work when both are present.
 *
 * Multipliers are chosen so that a tier-3 item with value=2 outranks a tier-0
 * item with value=5 (2 * 1.8 = 3.6 > 5/5 * 0.6 = 0.6, even at effort=1).
 */
const SOURCE_TIER_MULTIPLIER: Record<string, number> = {
  goal:     1.8,
  issue:    1.8,
  security: 1.4,
  test:     1.4,
  self:     1.0,
  plugin:   1.0,
  doc:      1.0,
  todo:     0.6,
  dep:      0.6,
  lint:     0.6,
  hygiene:  0.6,
};

/** Returns the source-tier multiplier for an item's source. Unknown sources → 1.0. */
export function sourceTierMultiplier(source: string): number {
  return SOURCE_TIER_MULTIPLIER[source] ?? 1.0;
}
