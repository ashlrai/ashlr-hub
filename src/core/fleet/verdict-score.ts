/**
 * src/core/fleet/verdict-score.ts — the single source of truth for collapsing a
 * ManagerVerdict's four rubric dimensions into one comparable number.
 *
 * Lives in its own leaf module rather than in manager.ts on purpose: best-of-n
 * imports manager.js *lazily* (so a missing/unavailable manager degrades to
 * unjudged candidates instead of failing the run). A static value-import of
 * manager.js would defeat that, so the formula gets a dependency-free home and
 * takes only a type-import from manager.ts.
 *
 * Pure. Never throws.
 */

import type { ManagerVerdict } from './manager.js';

/**
 * The subset of a ManagerVerdict this formula reads. Every field is optional
 * so callers holding a loosely-typed/partial verdict (e.g. one reconstructed
 * from a ledger record) can score it without a cast.
 */
export type ScorableVerdict = Partial<
  Pick<ManagerVerdict, 'value' | 'correctness' | 'scope' | 'alignment'>
>;

/**
 * Lowest score a fully-populated verdict can produce: 1 + 1 + (6 - 5) + 1.
 * 0 is reserved as the "no considered verdict" sentinel and is deliberately
 * below this floor, so `score === 0` stays distinguishable from a real verdict.
 */
export const MIN_VERDICT_SCORE = 4;

/** Highest score a fully-populated verdict can produce: 5 + 5 + (6 - 1) + 5. */
export const MAX_VERDICT_SCORE = 20;

/** Clamp a rubric dimension into the 1..5 range the rubric defines. */
function clampDimension(n: number): number {
  return Math.min(5, Math.max(1, n));
}

/**
 * Derive a single number from a ManagerVerdict:
 *
 *   value + correctness + (6 - scope) + alignment
 *
 * Each dimension is on the judge's 1..5 rubric, so the sum runs 4..20.
 * `scope` is INVERTED because it measures blast radius — 1 = tiny (good),
 * 5 = huge (bad) — and `6 - scope` maps that back onto 1..5 "higher is better"
 * like the other three. Getting this backwards silently rewards the most
 * invasive candidate, which is why it is pinned by test.
 *
 * A null/undefined verdict scores 0 — the sentinel every caller already uses
 * for "no considered verdict" (judge failure, unjudged candidate, failed run).
 * Missing individual dimensions fall back to the rubric's own neutral defaults
 * (1 for the "higher is better" dimensions, 3 for scope).
 */
export function scoreVerdict(v: ScorableVerdict | null | undefined): number {
  if (!v) return 0;
  const value = v.value ?? 1;
  const correctness = v.correctness ?? 1;
  const scope = clampDimension(v.scope ?? 3);
  const alignment = v.alignment ?? 1;
  return value + correctness + (6 - scope) + alignment;
}
