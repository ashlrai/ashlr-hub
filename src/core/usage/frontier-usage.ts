/**
 * core/usage/frontier-usage.ts — M194: per-engine frontier usage aggregator.
 *
 * `getFrontierUsage(cfg)` aggregates per-engine spend/quota visibility for
 * the frontier engines (claude, codex, and any other frontier-tier backends)
 * by combining THREE data sources:
 *
 *   1. Quota ledger (src/core/fleet/quota.ts) — dispatch counts per engine,
 *      in the configured rate-limit window (or last 24h as default).
 *   2. Subscription tracker (src/core/fleet/subscription-usage.ts) — window
 *      utilization % + resetsAt from the real subscription (codex: from session
 *      files; claude: no local signal → null).
 *   3. Observability rollup (src/core/observability/rollup.ts) — token + cost
 *      totals today (last 1d window), aggregated per-model by buildRollup.
 *
 * Limits come from `cfg.foundry.limits?.[engine]` (max + window). When no
 * limit is configured, the engine shows as "unlimited". remainingEstimate is
 * limit.max - callsToday (best-effort, clearly labeled as an estimate). When a
 * real subscription window signal is available (codex), usedPct comes from that;
 * otherwise it is derived from calls vs. configured limit.
 *
 * Contract:
 *  - Async (I/O reads from quota.json + codex session files + rollup).
 *  - NEVER throws — every source is independently try/catched; missing data
 *    degrades to zero/null/unknown fields.
 *  - No writes, no mutations, no child-process spawns.
 *  - Bounded: reads ledger + session files only; no git, no network.
 */

import type { AshlrConfig, EngineId } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The subscription-window state for a single engine. */
export interface FrontierEngineWindowState {
  /** 'active' = within normal budget; 'near' = ≥80%; 'exhausted' = ≥configured max% */
  state: 'active' | 'near' | 'exhausted' | 'unknown';
  /** 0–100 usage percentage (from subscription tracker or derived from calls). */
  usedPct: number;
  /** Unix epoch seconds when the window resets, if known. */
  resetsAt?: number;
  /** Human-readable window label (e.g. '5h', '7d', '1d'). */
  windowLabel?: string;
}

/** Per-engine frontier usage record. */
export interface FrontierEngineUsage {
  /** Engine id (e.g. 'claude', 'codex'). */
  engine: EngineId;
  /** Dispatch calls recorded in the accounting window (from quota ledger). */
  callsToday: number;
  /** Estimated tokens used today (from observability rollup, best-effort). */
  tokensToday?: number;
  /** Estimated USD cost today (from observability rollup, best-effort). */
  costToday?: number;
  /** Subscription window state. */
  subscriptionWindow: FrontierEngineWindowState;
  /**
   * Estimated remaining calls before hitting the configured limit.
   * Only present when a limit is configured. Labeled as an estimate because
   * the quota ledger records dispatches, not subscription API call counts.
   */
  remainingEstimate?: number;
  /** Configured hard limit (max calls per window). */
  limit?: number;
  /** The configured window label (e.g. '1d', '1h'). */
  limitWindow?: string;
}

/** Aggregated frontier usage across all frontier engines. */
export interface FrontierUsage {
  /** ISO timestamp this snapshot was generated. */
  generatedAt: string;
  /** Per-engine usage records, one per frontier engine found in cfg. */
  engines: FrontierEngineUsage[];
}

// ---------------------------------------------------------------------------
// Engine classification helpers
// ---------------------------------------------------------------------------

/**
 * Determine which engines to report on. We always include 'claude' and 'codex'
 * when they appear in cfg.foundry.allowedBackends, plus any other engines whose
 * tier is 'frontier'. Falls back to ['claude', 'codex'] when allowedBackends is
 * not configured.
 */
function frontierEngines(cfg: AshlrConfig): EngineId[] {
  try {
    const allowed: EngineId[] = (cfg as unknown as Record<string, unknown>)['foundry'] != null
      ? ((cfg as unknown as { foundry?: { allowedBackends?: EngineId[] } }).foundry?.allowedBackends ?? [])
      : [];

    // Always include claude + codex as the canonical frontier engines; add
    // any other allowed backends that aren't purely local/builtin.
    const frontier = new Set<EngineId>(['claude', 'codex']);
    for (const e of allowed) {
      // Include explicitly configured allowed backends (the router already
      // gates non-frontier ones; we surface whatever the user has enabled).
      frontier.add(e);
    }

    // Filter down to only the engines that appear in allowed (when it's set),
    // but always keep claude + codex as they are the primary frontier engines.
    if (allowed.length > 0) {
      return Array.from(frontier).filter(
        (e) => e === 'claude' || e === 'codex' || allowed.includes(e),
      );
    }

    // No allowedBackends configured — default to the two canonical ones.
    return ['claude', 'codex'];
  } catch {
    return ['claude', 'codex'];
  }
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

function windowToMs(window: string): number {
  switch (window) {
    case '1m':  return 60_000;
    case '5m':  return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h':  return 3_600_000;
    case '1d':  return 86_400_000;
    case '7d':  return 7 * 86_400_000;
    case '30d': return 30 * 86_400_000;
    default:    return 86_400_000; // 1d fallback
  }
}

// ---------------------------------------------------------------------------
// Per-source reads (all never-throw, all synchronous)
// ---------------------------------------------------------------------------

/**
 * Read calls in the last `windowMs` for `engine` from the quota ledger.
 * Falls back to 0 on any error.
 */
function readQuotaCalls(engine: EngineId, windowMs: number): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy sync require avoids a load-time cycle
    const { usesInWindow } = require('../fleet/quota.js') as {
      usesInWindow: (backend: EngineId, windowMs: number, now?: number) => number;
    };
    return usesInWindow(engine, windowMs);
  } catch {
    return 0;
  }
}

/**
 * Read subscription window state for `engine`.
 * Returns null when no local signal is available (always null for claude).
 */
function readSubscriptionWindow(engine: EngineId, cfg: AshlrConfig): {
  usedPercent: number;
  windowLabel: string;
  resetsAt?: number;
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy sync require avoids a load-time cycle
    const { subscriptionUsage } = require('../fleet/subscription-usage.js') as {
      subscriptionUsage: (engine: EngineId, opts?: { cfg?: unknown }) => {
        usedPercent: number;
        windowLabel: string;
        resetsAt?: number;
      } | null;
    };
    return subscriptionUsage(engine, { cfg });
  } catch {
    return null;
  }
}

/** Map engine id to the model-prefix used in observability rollup keys. */
function engineToModelPrefix(engine: EngineId): string {
  switch (engine) {
    case 'claude': return 'claude';
    case 'codex':  return 'codex';
    default:       return String(engine);
  }
}

/**
 * Read today's (last 1d) token + cost totals for `engine` from the rollup.
 * Aggregates across all models whose name starts with the engine's prefix.
 */
function readRollupTotals(
  engine: EngineId,
  cfg: AshlrConfig,
): { tokensToday: number; costToday: number } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy sync require avoids a load-time cycle
    const { buildRollup } = require('../observability/rollup.js') as {
      buildRollup: (
        window: '1d' | '7d' | '30d',
        cfg: AshlrConfig,
      ) => { byModel: Array<{ model: string; tokensIn: number; tokensOut: number; estCostUsd: number; calls: number }> };
    };
    const rollup = buildRollup('1d', cfg);
    const prefix = engineToModelPrefix(engine).toLowerCase();
    let tokensToday = 0;
    let costToday = 0;
    for (const m of rollup.byModel) {
      if (m.model.toLowerCase().startsWith(prefix)) {
        tokensToday += m.tokensIn + m.tokensOut;
        costToday   += m.estCostUsd;
      }
    }
    return { tokensToday, costToday };
  } catch {
    return { tokensToday: 0, costToday: 0 };
  }
}

// ---------------------------------------------------------------------------
// Per-engine assembly
// ---------------------------------------------------------------------------

/** Default throttle threshold — matches subscription-usage.ts DEFAULT_MAX_PERCENT. */
const DEFAULT_MAX_PERCENT = 90;

function buildEngineUsage(engine: EngineId, cfg: AshlrConfig): FrontierEngineUsage {
  // ── Limit config ──────────────────────────────────────────────────────────
  const limitCfg = (cfg as unknown as {
    foundry?: { limits?: Record<string, { max: number; window: string }> };
  }).foundry?.limits?.[engine];

  const limitMax    = limitCfg?.max;
  const limitWindow = limitCfg?.window ?? '1d';
  const windowMs    = windowToMs(limitWindow);

  // ── Quota ledger — calls in the accounting window ────────────────────────
  const callsToday = readQuotaCalls(engine, windowMs);

  // ── Observability rollup — tokens + cost today ───────────────────────────
  const { tokensToday, costToday } = readRollupTotals(engine, cfg);

  // ── Subscription tracker — real window utilization ───────────────────────
  const subWindow = readSubscriptionWindow(engine, cfg);

  // ── Subscription window state ─────────────────────────────────────────────
  let windowState: FrontierEngineWindowState;

  if (subWindow !== null) {
    // Real signal from subscription tracker (codex).
    const pct = subWindow.usedPercent;
    const maxPct = DEFAULT_MAX_PERCENT;
    const state =
      pct >= maxPct ? 'exhausted' :
      pct >= 80    ? 'near' :
                     'active';
    windowState = {
      state,
      usedPct: pct,
      resetsAt: subWindow.resetsAt,
      windowLabel: subWindow.windowLabel,
    };
  } else if (limitMax !== undefined && limitMax > 0) {
    // No subscription signal — derive from calls vs limit.
    const pct = Math.round((callsToday / limitMax) * 100);
    const state =
      pct >= 100 ? 'exhausted' :
      pct >= 80  ? 'near' :
                   'active';
    windowState = {
      state,
      usedPct: Math.min(pct, 100),
      windowLabel: limitWindow,
    };
  } else {
    // No signal, no limit — completely unknown.
    windowState = { state: 'unknown', usedPct: 0, windowLabel: limitWindow };
  }

  // ── Remaining estimate ────────────────────────────────────────────────────
  const remainingEstimate = limitMax !== undefined
    ? Math.max(0, limitMax - callsToday)
    : undefined;

  return {
    engine,
    callsToday,
    tokensToday: tokensToday > 0 ? tokensToday : undefined,
    costToday:   costToday   > 0 ? costToday   : undefined,
    subscriptionWindow: windowState,
    ...(remainingEstimate !== undefined ? { remainingEstimate } : {}),
    ...(limitMax          !== undefined ? { limit: limitMax }   : {}),
    ...(limitMax          !== undefined ? { limitWindow }       : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Aggregate per-engine frontier usage from quota ledger + subscription tracker
 * + observability rollup. NEVER throws — each engine's record degrades
 * independently; the overall call always resolves.
 *
 * Sources:
 *  - cfg.foundry.allowedBackends / limits  (config, synchronous)
 *  - ~/.ashlr/fleet/quota.json             (dispatch ledger, synchronous read)
 *  - ~/.config/codex/sessions/*.jsonl      (subscription rate-limits, synchronous)
 *  - ~/.claude/projects/{project}/*.jsonl + runs  (observability rollup, synchronous)
 */
export async function getFrontierUsage(cfg: AshlrConfig): Promise<FrontierUsage> {
  const generatedAt = new Date().toISOString();
  const engines: FrontierEngineUsage[] = [];

  const engineIds = frontierEngines(cfg);

  for (const engine of engineIds) {
    try {
      engines.push(buildEngineUsage(engine, cfg));
    } catch {
      // Degrade to a zero record — never block the whole snapshot.
      engines.push({
        engine,
        callsToday: 0,
        subscriptionWindow: { state: 'unknown', usedPct: 0 },
      });
    }
  }

  return { generatedAt, engines };
}

// ---------------------------------------------------------------------------
// Snapshot-compatible helper (used by buildSnapshot + dashboard API)
// ---------------------------------------------------------------------------

/**
 * Synchronous wrapper that returns a promise — allows buildSnapshot (which is
 * async) to await frontier usage without blocking the event loop for I/O.
 * Identical semantics to getFrontierUsage; exported separately so tests can
 * mock at this boundary without touching the full cfg loading chain.
 */
export function getFrontierUsageSync(cfg: AshlrConfig): FrontierUsage {
  const generatedAt = new Date().toISOString();
  const engines: FrontierEngineUsage[] = [];
  const engineIds = frontierEngines(cfg);

  for (const engine of engineIds) {
    try {
      engines.push(buildEngineUsage(engine, cfg));
    } catch {
      engines.push({
        engine,
        callsToday: 0,
        subscriptionWindow: { state: 'unknown', usedPct: 0 },
      });
    }
  }

  return { generatedAt, engines };
}
