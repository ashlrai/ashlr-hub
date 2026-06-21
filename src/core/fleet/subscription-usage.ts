/**
 * subscription-usage.ts — M80: subscription-window awareness for the autonomous fleet.
 *
 * Frontier engines (claude / codex) run on SUBSCRIPTIONS, not API billing:
 *  - They have real rate-limit windows (e.g. codex's 5h + weekly token budgets).
 *  - Subscription runs must NOT be counted toward dailyBudgetUsd (not dollar-billed).
 *  - The fleet must respect the subscription window utilization and back off when
 *    a window is near-exhausted, rather than hammering it until forced rejection.
 *
 * Public API (all pure, never-throws):
 *
 *   subscriptionUsage(engine)
 *     → { usedPercent, windowLabel, resetsAt? } | null
 *     Codex: real data from readCodexRateLimits() (higher of primary/secondary).
 *     Claude: null (no local utilization signal — don't block it proactively).
 *
 *   subscriptionAllows(engine, opts?)
 *     → { allowed: boolean; reason: string }
 *     false only when KNOWN utilization >= maxPercent (default 90).
 *     allowed:true when utilization is unknown or under the cap.
 *
 *   isSubscriptionEngine(engine)
 *     → boolean
 *     True for frontier-tier CLI agents (claude / codex). Reuses engineTierOf.
 *
 * Design constraints:
 *  - Never throws — all errors degrade to allowed:true (unknown → permissive).
 *  - Never blocks claude proactively (no local signal → assume allowed).
 *  - maxPercent is read defensively from cfg.foundry with a default of 90.
 */

import { readCodexRateLimits } from '../observability/codex-source.js';
import { engineTierOf } from '../run/sandboxed-engine.js';
import type { EngineId } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SubscriptionUsage {
  /** 0–100 usage percentage in the most-utilized window. */
  usedPercent: number;
  /** Human-readable window label, e.g. "5h", "7d". */
  windowLabel: string;
  /** Unix epoch seconds when the window resets (when available). */
  resetsAt?: number;
}

export interface SubscriptionAllowResult {
  allowed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Default throttle threshold — overridable via cfg.foundry as an escape hatch.
// We intentionally do NOT add a new field to types.ts; read it defensively.
// ---------------------------------------------------------------------------

/** Default maximum subscription utilization percent before throttling (inclusive). */
const DEFAULT_MAX_PERCENT = 90;

// ---------------------------------------------------------------------------
// minutesToLabel — convert raw windowMinutes to a readable label
// (mirrors the identical helper in limits.ts — kept local to avoid a dep)
// ---------------------------------------------------------------------------

function minutesToLabel(mins: number): string {
  if (mins % (60 * 24 * 7) === 0) return `${mins / (60 * 24 * 7)}w`;
  if (mins % (60 * 24) === 0)     return `${mins / (60 * 24)}d`;
  if (mins % 60 === 0)            return `${mins / 60}h`;
  return `${mins}m`;
}

// ---------------------------------------------------------------------------
// isSubscriptionEngine
// ---------------------------------------------------------------------------

/**
 * True when `engine` is a frontier-tier CLI agent (runs on a subscription, not
 * API billing). Reuses engineTierOf from sandboxed-engine.ts (single source of
 * truth from the engine registry). Never throws.
 */
export function isSubscriptionEngine(engine: EngineId): boolean {
  try {
    return engineTierOf(engine) === 'frontier';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// subscriptionUsage
// ---------------------------------------------------------------------------

/**
 * Return the current subscription window utilization for `engine`, or null
 * when no local signal is available (always null for claude).
 *
 * For codex: reads the most recent session file via readCodexRateLimits() and
 * returns the HIGHER of primary/secondary utilization (most conservative).
 *
 * Never throws; returns null on any error or missing data.
 */
export function subscriptionUsage(engine: EngineId): SubscriptionUsage | null {
  try {
    if (engine === 'codex') {
      const limits = readCodexRateLimits();
      if (!limits) return null;

      const { primary, secondary } = limits;

      // Pick the window with the higher utilization (most conservative).
      let best: { usedPercent: number; windowMinutes: number; resetsAt: number } | null = null;
      for (const window of [primary, secondary]) {
        if (!window) continue;
        if (best === null || window.usedPercent > best.usedPercent) {
          best = window;
        }
      }
      if (!best) return null;

      return {
        usedPercent: best.usedPercent,
        windowLabel: minutesToLabel(best.windowMinutes),
        resetsAt: best.resetsAt,
      };
    }

    // Claude: no local utilization signal — return null (don't block proactively).
    // Other subscription engines: no local signal either.
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// subscriptionAllows
// ---------------------------------------------------------------------------

/**
 * Decide whether the subscription window for `engine` permits a new dispatch.
 *
 * Returns allowed:true in ALL ambiguous / unknown cases (fail-open):
 *  - Engine is not a subscription engine (no subscription window to check).
 *  - No local utilization signal (claude, or codex with no session files).
 *  - Data is stale / unreadable.
 *
 * Returns allowed:false ONLY when a KNOWN window is at or above maxPercent.
 *
 * maxPercent defaults to DEFAULT_MAX_PERCENT (90). Can be overridden per call
 * or via cfg.foundry (read as `(cfg.foundry as any)?.subscriptionMaxPercent`
 * in the caller to avoid touching types.ts).
 *
 * Never throws.
 */
export function subscriptionAllows(
  engine: EngineId,
  opts?: { maxPercent?: number },
): SubscriptionAllowResult {
  try {
    if (!isSubscriptionEngine(engine)) {
      return {
        allowed: true,
        reason: `${engine} is not a subscription engine — no window throttle applied`,
      };
    }

    const maxPct = opts?.maxPercent ?? DEFAULT_MAX_PERCENT;
    const usage = subscriptionUsage(engine);

    if (!usage) {
      // No local signal — fail open (never block on missing data).
      return {
        allowed: true,
        reason: `${engine} subscription usage unknown (no local signal) — allowing`,
      };
    }

    if (usage.usedPercent >= maxPct) {
      const resetStr = usage.resetsAt
        ? ` (resets at ${new Date(usage.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
        : '';
      return {
        allowed: false,
        reason:
          `${engine} subscription window ${usage.usedPercent}% used` +
          ` (max ${maxPct}%, ${usage.windowLabel} window)${resetStr}`,
      };
    }

    return {
      allowed: true,
      reason:
        `${engine} subscription window ${usage.usedPercent}% used` +
        ` (max ${maxPct}%, ${usage.windowLabel} window) — within limit`,
    };
  } catch {
    // Never block on an unexpected error — fail open.
    return {
      allowed: true,
      reason: `${engine} subscription check failed unexpectedly — allowing`,
    };
  }
}
