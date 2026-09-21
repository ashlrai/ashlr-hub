/**
 * src/core/fleet/agreement.ts — the single source of truth for Cohen's kappa,
 * the inter-rater agreement statistic used by judge calibration (judge verdict
 * vs. real merge outcome), prompt optimization, and counterfactual analysis.
 *
 * A leaf module with no imports, so any of those callers can depend on it
 * without pulling in the others.
 *
 * Pure. Never throws.
 */

/** One observation rated by two raters. Category labels are compared by string identity. */
export interface AgreementPair {
  a: string;
  b: string;
}

/**
 * Minimum number of paired observations kappa is defined for.
 *
 * Kappa is undefined on a single observation: with n = 1 the marginals are
 * degenerate and the statistic reports either 1.0 (raters agreed) or 0
 * (they did not) with no information behind it. Callers get `null` instead,
 * which every call site already handles as "not enough data".
 */
export const MIN_KAPPA_PAIRS = 2;

/**
 * Cohen's kappa between two categorical raters.
 *
 *   kappa = (p_o - p_e) / (1 - p_e)
 *     p_o = observed agreement (the confusion matrix diagonal, over n)
 *     p_e = agreement expected by chance (sum over categories of the product
 *           of the two raters' marginals)
 *
 * Returns 1.0 for perfect agreement, ~0 for chance-level agreement, and
 * negative values for systematic disagreement.
 *
 * Degenerate cases are handled explicitly rather than incidentally:
 *   - fewer than MIN_KAPPA_PAIRS observations (including an empty array, and
 *     including a non-array passed by an untyped caller) → null.
 *   - every observation from both raters in a single category → p_e is exactly
 *     1, so the denominator is exactly 0. Rather than dividing, this returns
 *     1.0: both raters assigned the same label to every observation, which is
 *     perfect (if uninformative) agreement. This is the ONLY input that can
 *     drive the denominator to 0 — with two or more distinct categories every
 *     marginal is strictly below 1, so p_e is strictly below 1. Consequently
 *     this function never returns NaN or Infinity.
 *
 * Never throws: any unexpected input shape is caught and reported as null.
 */
export function cohenKappa(pairs: readonly AgreementPair[] | null | undefined): number | null {
  try {
    if (!pairs || pairs.length < MIN_KAPPA_PAIRS) return null;
    const n = pairs.length;

    const categorySet = new Set<string>();
    for (const p of pairs) {
      categorySet.add(p.a);
      categorySet.add(p.b);
    }
    const categories = Array.from(categorySet);

    // Confusion matrix + per-rater marginals, zero-initialized over every
    // category either rater used (so the diagonal is always addressable).
    const matrix: Record<string, Record<string, number>> = {};
    const marginalA: Record<string, number> = {};
    const marginalB: Record<string, number> = {};
    for (const c of categories) {
      matrix[c] = {};
      marginalA[c] = 0;
      marginalB[c] = 0;
      for (const c2 of categories) matrix[c]![c2] = 0;
    }

    for (const p of pairs) {
      matrix[p.a]![p.b]! += 1;
      marginalA[p.a]! += 1;
      marginalB[p.b]! += 1;
    }

    let observed = 0;
    for (const c of categories) observed += matrix[c]?.[c] ?? 0;
    const p_o = observed / n;

    let p_e = 0;
    for (const c of categories) p_e += (marginalA[c]! / n) * (marginalB[c]! / n);

    // Denominator guard — see the degenerate-case note above.
    if (p_e >= 1) return 1;
    return (p_o - p_e) / (1 - p_e);
  } catch {
    return null;
  }
}
