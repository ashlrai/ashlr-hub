/**
 * subscription-usage.ts — M80/M114: subscription-window awareness for the fleet.
 *
 * M80: Frontier engines (claude / codex) run on SUBSCRIPTIONS, not API billing:
 *  - They have real rate-limit windows (e.g. codex's 5h + weekly token budgets).
 *  - Subscription runs must NOT be counted toward dailyBudgetUsd (not dollar-billed).
 *  - The fleet must respect the subscription window utilization and back off when
 *    a window is near-exhausted, rather than hammering it until forced rejection.
 *
 * M114: Cross-machine awareness.
 *  - When cfg.fleet?.sharedQueue?.mode === 'filesystem' and a path is set, each
 *    machine publishes its local % to the shared ledger and reads sibling readings
 *    before deciding whether to dispatch. The MOST-SATURATED reading across all
 *    non-expired ledger entries governs (shared account = shared window).
 *  - When sharedQueue is off/absent or the path is unwritable, behavior is
 *    byte-identical to the M80 local-only logic. Never throws either way.
 *
 * Public API (all pure, never-throws):
 *
 *   subscriptionUsage(engine, opts?)
 *     → { usedPercent, windowLabel, resetsAt? } | null
 *     Codex: real data from readCodexRateLimits() (higher of primary/secondary).
 *     Claude: null (no local utilization signal — don't block it proactively).
 *     Shared mode: also publishes the local reading to the shared ledger.
 *
 *   subscriptionAllows(engine, opts?)
 *     → { allowed: boolean; reason: string }
 *     false only when KNOWN utilization >= maxPercent (default 90).
 *     Shared mode: uses MAX across all non-expired ledger entries for the engine.
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
 *  - Separate-account-per-laptop = each points at no/its-own shared path → no
 *    contention. Shared mode only activates when explicitly configured.
 */

import * as os from 'node:os';
import { readCodexRateLimits } from '../observability/codex-source.js';
import { engineTierOf } from '../run/sandboxed-engine.js';
import type { EngineId } from '../types.js';
import { SharedStore } from './shared-store.js';

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

/**
 * M114: How long (ms) a shared ledger entry is considered fresh when no resetsAt
 * is available. Default 8 days (covers the 7-day codex window with margin).
 */
const DEFAULT_LEDGER_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shared-mode config shape — read defensively; never imported from types.ts
// to avoid touching that file.
// ---------------------------------------------------------------------------

interface SharedQueueCfg {
  mode?: string;
  path?: string;
  machineId?: string;
  trustedCoherentStorage?: boolean;
}

/** Extract sharedQueue config from whatever shape cfg happens to be. */
function sharedQueueCfg(cfg: unknown): SharedQueueCfg | null {
  try {
    if (typeof cfg !== 'object' || cfg === null) return null;
    const fleet = (cfg as Record<string, unknown>)['fleet'];
    if (typeof fleet !== 'object' || fleet === null) return null;
    const sq = (fleet as Record<string, unknown>)['sharedQueue'];
    if (typeof sq !== 'object' || sq === null) return null;
    return sq as SharedQueueCfg;
  } catch {
    return null;
  }
}

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
 * M114: When opts.cfg has sharedQueue.mode === 'filesystem' + a valid path,
 * also publishes the local reading to the shared ledger (best-effort, never
 * throws). For claude (no local %, usedPercent=0) we still publish so siblings
 * can see this machine is active on claude.
 *
 * Never throws; returns null on any error or missing data.
 */
export function subscriptionUsage(
  engine: EngineId,
  opts?: { cfg?: unknown },
): SubscriptionUsage | null {
  try {
    let local: SubscriptionUsage | null = null;

    if (engine === 'codex') {
      const limits = readCodexRateLimits();
      if (limits) {
        const { primary, secondary } = limits;
        let best: { usedPercent: number; windowMinutes: number; resetsAt: number } | null = null;
        for (const window of [primary, secondary]) {
          if (!window) continue;
          if (best === null || window.usedPercent > best.usedPercent) {
            best = window;
          }
        }
        if (best) {
          local = {
            usedPercent: best.usedPercent,
            windowLabel: minutesToLabel(best.windowMinutes),
            resetsAt: best.resetsAt,
          };
        }
      }
    }
    // Claude + other subscription engines: no local utilization signal.

    // M114: publish to shared ledger (best-effort).
    _maybePublish(engine, local, opts?.cfg);

    return local;
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
 * M114: In shared mode, the effective usedPercent is the MAX across all
 * non-expired ledger entries for this engine (most-saturated machine governs).
 * Falls back to local-only decision when the shared read fails or ledger is empty.
 *
 * maxPercent defaults to DEFAULT_MAX_PERCENT (90). Can be overridden per call
 * or via cfg.foundry (read as `(cfg.foundry as any)?.subscriptionMaxPercent`
 * in the caller to avoid touching types.ts).
 *
 * Never throws.
 */
export function subscriptionAllows(
  engine: EngineId,
  opts?: { maxPercent?: number; cfg?: unknown },
): SubscriptionAllowResult {
  try {
    if (!isSubscriptionEngine(engine)) {
      return {
        allowed: true,
        reason: `${engine} is not a subscription engine — no window throttle applied`,
      };
    }

    const maxPct = opts?.maxPercent ?? DEFAULT_MAX_PERCENT;

    // M114: attempt cross-machine aggregation first.
    const aggregate = _aggregateSharedUsage(engine, opts?.cfg);
    if (aggregate !== null) {
      if (aggregate.usedPercent >= maxPct) {
        const resetStr = aggregate.resetsAt
          ? ` (resets at ${new Date(aggregate.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
          : '';
        return {
          allowed: false,
          reason:
            `${engine} subscription window ${aggregate.usedPercent}% used` +
            ` (max ${maxPct}%, ${aggregate.windowLabel} window, cross-machine)${resetStr}`,
        };
      }
      return {
        allowed: true,
        reason:
          `${engine} subscription window ${aggregate.usedPercent}% used` +
          ` (max ${maxPct}%, ${aggregate.windowLabel} window, cross-machine) — within limit`,
      };
    }

    // Shared mode off / ledger empty / all-expired — fall back to local-only (M80).
    // NOTE: we call subscriptionUsage here for the local read AND side-effect publish.
    const usage = subscriptionUsage(engine, { cfg: opts?.cfg });

    if (!usage) {
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

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

/**
 * M114: Publish this machine's local usage reading to the shared ledger.
 * For claude (no local signal), publishes usedPercent=0 so siblings know the
 * machine is active. Best-effort — never throws.
 */
function _maybePublish(engine: EngineId, local: SubscriptionUsage | null, cfg: unknown): void {
  try {
    const sq = sharedQueueCfg(cfg);
    if (!sq || sq.mode !== 'filesystem' || !sq.path || sq.trustedCoherentStorage !== true) return;

    const machineId = sq.machineId ?? os.hostname();
    const store = new SharedStore(sq.path);

    if (local) {
      store.publishUsage({
        machineId,
        engine,
        ts: new Date().toISOString(),
        usedPercent: local.usedPercent,
        windowLabel: local.windowLabel,
        resetsAt: local.resetsAt,
      });
    } else {
      // No local signal (claude, or codex with no sessions) — publish presence
      // with usedPercent=0 so siblings see this machine is active.
      store.publishUsage({
        machineId,
        engine,
        ts: new Date().toISOString(),
        usedPercent: 0,
      });
    }
  } catch {
    // Never propagate — the fleet must keep working even if the shared folder
    // is unavailable.
  }
}

/**
 * M114: Read the shared ledger and return the most-saturated (MAX) reading
 * across all non-expired entries for `engine`. Returns null when shared mode
 * is off, the ledger is empty, all entries have expired, or on any error.
 * Never throws.
 */
function _aggregateSharedUsage(engine: EngineId, cfg: unknown): SubscriptionUsage | null {
  try {
    const sq = sharedQueueCfg(cfg);
    if (!sq || sq.mode !== 'filesystem' || !sq.path || sq.trustedCoherentStorage !== true) return null;

    const store = new SharedStore(sq.path);
    const entries = store.readUsageEntries(engine, { maxAgeMs: DEFAULT_LEDGER_MAX_AGE_MS });

    if (entries.length === 0) return null;

    // Take the entry with the highest usedPercent.
    let best: (typeof entries)[0] | null = null;
    for (const e of entries) {
      const pct = e.usedPercent ?? 0;
      if (best === null || pct > (best.usedPercent ?? 0)) {
        best = e;
      }
    }
    if (!best) return null;

    return {
      usedPercent: best.usedPercent ?? 0,
      windowLabel: best.windowLabel ?? 'unknown',
      resetsAt: best.resetsAt,
    };
  } catch {
    return null;
  }
}
