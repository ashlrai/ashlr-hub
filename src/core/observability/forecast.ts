/**
 * forecast.ts — cost attribution + forward forecast for a recent usage window.
 *
 * M15: buildForecast reuses buildRollup for actual spend and wouldBeCloudCost
 * (from router.ts) to compute local savings. All numbers are ESTIMATES, clearly
 * labeled. Never throws — falls back to zeroed CostForecast on any error.
 */

import type { AshlrConfig, CostForecast } from '../types.js';
import { buildRollup, windowToMs, isLocalProviderModel } from './rollup.js';

// ---------------------------------------------------------------------------
// Local provider detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the model id belongs to a local (zero-cost) provider.
 *
 * Reuses rollup.ts `isLocalProviderModel` (built on the SAME `modelToProviderKey`
 * derivation rollup uses to compute cost) so the local/cloud split is identical
 * across rollup, savings, and forecast — instead of a fragile raw substring test
 * that only matched the run-source label format by coincidence.
 */
const isLocalModel = isLocalProviderModel;

// ---------------------------------------------------------------------------
// Cloud cost reference: representative cloud pricing used for savings estimate.
// Uses claude/anthropic as the reference cloud tier (conservative mid estimate).
// These are ESTIMATES only, never billed — reuse the same constants from budget.ts
// rather than re-importing to avoid circular deps (budget.ts is a pure util).
// ---------------------------------------------------------------------------

/** $/M input tokens — conservative mid-tier cloud reference (anthropic claude). */
const CLOUD_REF_PRICE_IN  = 3.0;
/** $/M output tokens — conservative mid-tier cloud reference (anthropic claude). */
const CLOUD_REF_PRICE_OUT = 15.0;

/**
 * Estimate what `tokensIn`/`tokensOut` would have cost on a representative
 * cloud model (conservative anthropic mid-tier).
 *
 * This is the same calculation as `wouldBeCloudCost` in router.ts — duplicated
 * here to avoid a circular dependency (forecast -> router -> budget -> forecast).
 * The function intentionally stays private; external callers use router.ts.
 *
 * Returns 0 when token counts are non-positive. Always >= 0. Clearly an estimate.
 */
function cloudRefCost(tokensIn: number, tokensOut: number): number {
  if (tokensIn <= 0 && tokensOut <= 0) return 0;
  const safeIn  = Math.max(0, tokensIn);
  const safeOut = Math.max(0, tokensOut);
  return (safeIn / 1_000_000) * CLOUD_REF_PRICE_IN +
         (safeOut / 1_000_000) * CLOUD_REF_PRICE_OUT;
}

// ---------------------------------------------------------------------------
// buildForecast
// ---------------------------------------------------------------------------

/**
 * Build a CostForecast for the given window.
 *
 * - `spentUsd`: actual cost from the rollup (local providers contribute $0).
 * - `localSavingsUsd`: estimated cloud cost for tokens served by LOCAL models —
 *   what you WOULD have paid if those same tokens ran on cloud.
 * - `projectedMonthlyUsd`: the window's daily average spend × 30 days.
 *
 * All figures are ESTIMATES. Never throws — returns a zeroed forecast on error.
 */
export function buildForecast(
  window: '7d' | '30d',
  cfg: AshlrConfig,
): CostForecast {
  try {
    const rollup = buildRollup(window, cfg);

    // Actual spend is already computed in the rollup totals.
    const spentUsd = Math.max(0, rollup.totals.estCostUsd);

    // ── Local savings ───────────────────────────────────────────────────────
    // Sum up the cloud-equivalent cost for every local model's token usage.
    // rollup.byModel lists per-model aggregates; we identify local models and
    // compute what cloud would have charged for the same token volume.
    let localSavingsUsd = 0;
    for (const mu of rollup.byModel) {
      if (isLocalModel(mu.model)) {
        localSavingsUsd += cloudRefCost(mu.tokensIn, mu.tokensOut);
      }
    }
    localSavingsUsd = Math.max(0, localSavingsUsd);

    // ── Monthly projection ──────────────────────────────────────────────────
    // Scale the window's spend to a 30-day equivalent.
    // windowToMs is already exported from rollup.ts.
    const windowDays = windowToMs(window) / 86_400_000; // exact days in window
    const dailyRate = windowDays > 0 ? spentUsd / windowDays : 0;
    const projectedMonthlyUsd = Math.max(0, dailyRate * 30);

    return {
      window,
      spentUsd,
      localSavingsUsd,
      projectedMonthlyUsd,
    };
  } catch {
    // Never throw — return a safe zeroed forecast on any error.
    return {
      window,
      spentUsd: 0,
      localSavingsUsd: 0,
      projectedMonthlyUsd: 0,
    };
  }
}
