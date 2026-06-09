/**
 * budget-alert.ts — evaluate a budget cap against spent totals.
 *
 * Pure function, no I/O, never throws.
 * Privacy: reads only numeric caps from cfg.telemetry — no message content.
 */

import type { AshlrConfig, BudgetAlert } from "../types.js";

/**
 * Evaluate the budget cap for a window against spent totals.
 *
 * Caps are read from cfg.telemetry.budgetUsd / budgetTokens (either may be unset).
 * level: 'over' when any cap is exceeded; 'warn' when >= 80% of any cap; else 'ok'.
 * message is a concise human-readable status. Never throws.
 */
export function evalBudget(
  totals: { spentUsd: number; spentTokens: number },
  cfg: AshlrConfig,
  window: string,
): BudgetAlert {
  try {
    const capUsd = cfg.telemetry?.budgetUsd ?? null;
    const capTokens = cfg.telemetry?.budgetTokens ?? null;
    const { spentUsd, spentTokens } = totals;

    // No caps configured — always ok
    if (capUsd === null && capTokens === null) {
      return {
        level: "ok",
        window,
        spentUsd,
        capUsd: null,
        spentTokens,
        capTokens: null,
        message: "No budget cap configured.",
      };
    }

    // Determine level: 'over' if any cap exceeded, 'warn' if >= 80%, else 'ok'
    const usdOver = capUsd !== null && spentUsd >= capUsd;
    const tokensOver = capTokens !== null && spentTokens >= capTokens;
    const usdWarn = capUsd !== null && !usdOver && spentUsd >= capUsd * 0.8;
    const tokensWarn =
      capTokens !== null && !tokensOver && spentTokens >= capTokens * 0.8;

    let level: BudgetAlert["level"];
    if (usdOver || tokensOver) {
      level = "over";
    } else if (usdWarn || tokensWarn) {
      level = "warn";
    } else {
      level = "ok";
    }

    // Build message focusing on whichever cap is most relevant (tightest %)
    const parts: string[] = [];

    if (capUsd !== null) {
      const pct = capUsd > 0 ? Math.round((spentUsd / capUsd) * 100) : 0;
      parts.push(
        `$${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} (${pct}%) this ${window}`,
      );
    }

    if (capTokens !== null) {
      const pct =
        capTokens > 0 ? Math.round((spentTokens / capTokens) * 100) : 0;
      const spentK = formatTokens(spentTokens);
      const capK = formatTokens(capTokens);
      parts.push(`${spentK} of ${capK} tokens (${pct}%) this ${window}`);
    }

    const prefix =
      level === "over" ? "Over budget: " : level === "warn" ? "Warning: " : "";

    return {
      level,
      window,
      spentUsd,
      capUsd,
      spentTokens,
      capTokens,
      message: prefix + parts.join("; "),
    };
  } catch {
    // Never throws — return safe fallback
    return {
      level: "ok",
      window,
      spentUsd: totals.spentUsd,
      capUsd: null,
      spentTokens: totals.spentTokens,
      capTokens: null,
      message: "Budget evaluation unavailable.",
    };
  }
}

/** Format a token count as a compact string (e.g. 1500000 -> '1.5M', 42000 -> '42K'). */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
