/**
 * governance.ts — spend-governance evaluation for a configured budget window.
 *
 * M19: evalGovernance compares actual spend (from buildForecast/buildRollup)
 * against the configured budget cap and returns an advisory GovernanceStatus.
 *
 * Design rules:
 *  - ADVISORY ONLY: this function is pure-ish — it never blocks, throws, or
 *    mutates any state. Callers decide how to act on the verdict.
 *  - METADATA ONLY: no prompts, completions, tool args, file contents, or
 *    secrets are ever read or emitted here.
 *  - NEVER THROWS: all errors are caught; falls back to ok/null-cap verdict.
 */

import type { AshlrConfig, GovernanceStatus } from '../types.js';
import { buildForecast } from './forecast.js';
import { buildRollup } from './rollup.js';

// ---------------------------------------------------------------------------
// Governance thresholds
// ---------------------------------------------------------------------------

/** Fraction of cap at which the level escalates from 'ok' to 'warn'. */
const WARN_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// evalGovernance
// ---------------------------------------------------------------------------

/**
 * Evaluate the spend-governance verdict for the current budget window.
 *
 * - When no `cfg.telemetry.budgetUsd` is configured: returns level 'ok' with
 *   capUsd null and a message indicating no cap is set.
 * - When a cap is set: uses buildForecast (preferred, also uses buildRollup
 *   internally) for '7d' and '30d' windows, and falls back to buildRollup
 *   directly for the '1d' window (buildForecast does not support '1d').
 * - Levels: 'over' when spentUsd >= cap, 'warn' when >= 80% of cap, else 'ok'.
 *
 * Pure-ish: reads local JSONL usage data but never modifies state, never
 * throws, and never surfaces PAT or secret values.
 */
export function evalGovernance(cfg: AshlrConfig): GovernanceStatus {
  try {
    const cap = cfg.telemetry?.budgetUsd;

    // No cap configured — governance has nothing to enforce.
    if (cap === undefined || cap === null) {
      return {
        level: 'ok',
        spentUsd: 0,
        capUsd: null,
        window: cfg.telemetry?.budgetWindow ?? '7d',
        message: 'No spend cap set.',
      };
    }

    const rawWindow = cfg.telemetry?.budgetWindow ?? '7d';

    // Obtain actual spend for the window. buildForecast supports '7d'|'30d';
    // for '1d' we fall back to buildRollup directly (same underlying source).
    let spentUsd = 0;
    if (rawWindow === '1d') {
      const rollup = buildRollup('1d', cfg);
      spentUsd = Math.max(0, rollup.totals.estCostUsd);
    } else {
      // rawWindow is now '7d' | '30d' — safe cast (type guard above handles '1d').
      const forecastWindow = rawWindow as '7d' | '30d';
      const forecast = buildForecast(forecastWindow, cfg);
      spentUsd = Math.max(0, forecast.spentUsd);
    }

    const capUsd = Math.max(0, cap);
    const ratio = capUsd > 0 ? spentUsd / capUsd : (spentUsd > 0 ? Infinity : 0);

    let level: GovernanceStatus['level'];
    let message: string;

    if (ratio >= 1) {
      level = 'over';
      message =
        `Spend $${spentUsd.toFixed(4)} has exceeded the ${rawWindow} cap ` +
        `of $${capUsd.toFixed(2)}. Use --over-budget to proceed when govAction is 'block'.`;
    } else if (ratio >= WARN_THRESHOLD) {
      level = 'warn';
      const pct = (ratio * 100).toFixed(1);
      message =
        `Spend $${spentUsd.toFixed(4)} is at ${pct}% of the ${rawWindow} cap ` +
        `of $${capUsd.toFixed(2)}.`;
    } else {
      level = 'ok';
      const pct = capUsd > 0 ? (ratio * 100).toFixed(1) : '0.0';
      message =
        `Spend $${spentUsd.toFixed(4)} is within the ${rawWindow} cap ` +
        `of $${capUsd.toFixed(2)} (${pct}% used).`;
    }

    return { level, spentUsd, capUsd, window: rawWindow, message };
  } catch {
    // Best-effort fallback — governance must never throw or block a run.
    return {
      level: 'ok',
      spentUsd: 0,
      capUsd: null,
      window: cfg.telemetry?.budgetWindow ?? '7d',
      message: 'Governance evaluation unavailable (internal error).',
    };
  }
}
