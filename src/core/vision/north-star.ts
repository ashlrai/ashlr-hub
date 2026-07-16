/**
 * M162: North-star leverage metric for the ashlr fleet.
 *
 * The true north star for an autonomous engineering fleet is NOT proposal
 * volume — it is HUMAN LEVERAGE: how much substantive engineering work is
 * being done autonomously, and how many hours that frees for Mason to focus
 * on direction and vision.
 *
 * computeNorthStar(cfg) — reads quality metrics over the last 7d and derives:
 *   - substantiveMerges7d: merged proposals that are non-trivial
 *   - engHoursSaved7d:    estimated engineering hours freed
 *   - leverageScore:      0–100 composite (higher = more leverage)
 *   - trend:              week-over-week direction ('up'|'flat'|'down')
 *
 * northStarSummary() — one-paragraph briefing-ready string summarising
 *   the leverage metric. Never throws.
 */

import type { AshlrConfig } from '../types.js';
import { computeQualityMetrics as _computeQualityMetrics } from '../fleet/quality-metrics.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NorthStarMetric {
  /** Proposals merged in the last 7d that are non-trivial (>6 diff lines, non-doc title). */
  substantiveMerges7d: number;
  /** Estimated engineering hours freed (substantiveMerges × avgHoursPerMerge). */
  engHoursSaved7d: number;
  /**
   * Composite leverage score 0–100.
   * Derived from substantive merge rate, accept rate, and empty-diff rate.
   * Higher = more autonomous engineering leverage.
   */
  leverageScore: number;
  /** Week-over-week direction vs the prior 7d window. */
  trend: 'up' | 'flat' | 'down';
  /** Raw quality snapshot used for computation. */
  raw: {
    merged: number;
    trivialRatio: number;
    acceptRate: number;
    emptyRate: number;
    avgDiffLines: number;
    proposalsCreated: number;
  };
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Score thresholds.
 * A score >= 70 means the fleet is delivering real leverage.
 * A score < 30 means the fleet is mostly generating noise.
 */
export const LEVERAGE_SCORE_GOOD = 70;
export const LEVERAGE_SCORE_POOR = 30;

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute the north-star leverage metric from quality metrics.
 *
 * Uses computeQualityMetrics from fleet/quality-metrics with a 7d window
 * (current) and a 30d window (for trend). Best-effort — never throws.
 */
export function computeNorthStar(_cfg: AshlrConfig): NorthStarMetric {
  const computedAt = new Date().toISOString();

  const zero = (): NorthStarMetric => ({
    substantiveMerges7d: 0,
    engHoursSaved7d: 0,
    leverageScore: 0,
    trend: 'flat',
    raw: { merged: 0, trivialRatio: 0, acceptRate: 0, emptyRate: 0, avgDiffLines: 0, proposalsCreated: 0 },
    computedAt,
  });

  try {
    const computeQualityMetrics = _computeQualityMetrics;

    const m7 = computeQualityMetrics('7d');
    const m30 = computeQualityMetrics('30d');

    // Operational metrics below remain factual. Autonomous leverage, savings,
    // and trend claims stay dormant until post-merge credit has a proof verifier.
    const substantiveMerges7d = 0;
    const engHoursSaved7d = 0;
    const leverageScore = 0;
    const trend: 'up' | 'flat' | 'down' = 'flat';
    void m30;

    return {
      substantiveMerges7d,
      engHoursSaved7d,
      leverageScore,
      trend,
      raw: {
        merged: m7.merged,
        trivialRatio: m7.trivialRatio,
        acceptRate: m7.acceptRate,
        emptyRate: m7.emptyRate,
        avgDiffLines: m7.avgDiffLines,
        proposalsCreated: m7.proposalsCreated,
      },
      computedAt,
    };
  } catch {
    return zero();
  }
}

// ---------------------------------------------------------------------------
// Briefing summary
// ---------------------------------------------------------------------------

/**
 * Generate a one-paragraph briefing-ready summary of the leverage metric.
 * Safe to call with a pre-computed metric or it computes lazily.
 * Never throws.
 */
export function northStarSummary(metric: NorthStarMetric): string {
  try {
    const { raw } = metric;

    return `=== NORTH-STAR: HUMAN LEVERAGE (7d) ===
Positive post-merge leverage credit: unavailable pending authenticated release
Adaptive leverage score and trend: unavailable
Negative indicators: ${(raw.trivialRatio * 100).toFixed(0)}% trivial | ${(raw.emptyRate * 100).toFixed(1)}% empty-diff
Proposals created: ${raw.proposalsCreated}`;
  } catch {
    return '=== NORTH-STAR: HUMAN LEVERAGE ===\nMetric unavailable.';
  }
}
