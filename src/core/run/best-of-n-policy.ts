/** Hard process/cost containment for one best-of-N selection. */
export const MAX_BEST_OF_N_CANDIDATES = 8;

/**
 * A best-of-N call already consumes one outer daemon slot. Keep its internal
 * producer and critic fan-out smaller so it cannot bypass the fleet governor.
 */
export const MAX_BEST_OF_N_CONCURRENCY = 2;

/** Maximum configured candidate specs inspected before dispatch. */
export const MAX_BEST_OF_N_CANDIDATE_SPECS_INSPECTED = 64;

/**
 * Resolve an untrusted/configured candidate count conservatively.
 * Invalid values fail closed to one candidate; valid values are floored and
 * clamped to the hard maximum.
 */
export function resolveBestOfNCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_BEST_OF_N_CANDIDATES, Math.floor(value));
}
