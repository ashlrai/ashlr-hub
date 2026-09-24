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
 * V3.10 (unit A9) — THE CLAUDE FAIL-OPEN IS CLOSED.
 *  Before 3.10 `subscriptionAllows('claude')` returned allowed:true because
 *  "no local signal" was read as "go ahead" — the exact path by which a lit
 *  fleet would have burned the Claude headroom Mason needs for his own
 *  sessions. Now:
 *   - Unknown usage is NOT headroom. A subscription engine with no reading
 *     (Claude with no Verse capacity snapshot, Codex with no session files),
 *     a stale reading, or a check that throws → allowed:FALSE.
 *   - Claude readings come from the Verse capacity snapshot
 *     (~/.ashlr/routing/capacity.json, written by the Verse server from its
 *     account collector — core/routing/budget-store.ts). Readings older than
 *     HEADROOM_READING_MAX_AGE_MS are stale, i.e. unknown.
 *   - The operator's budget policy (~/.ashlr/budget.json) is applied: a seat
 *     switched off for autonomy, or at its reserve / 5-hour ceiling, blocks.
 *     These gates only ever NARROW the old rule (known usage ≥ maxPercent
 *     still blocks); nothing here can allow what 3.9 refused.
 *   - When an engine has several seats (two Codex accounts), the fleet cannot
 *     choose which account its CLI hits, so EVERY seat of that engine in the
 *     snapshot must be eligible.
 *
 * Public API (all never-throw):
 *
 *   subscriptionUsage(engine, opts?)
 *     → { usedPercent, windowLabel, resetsAt? } | null
 *     Codex: real data from readCodexRateLimits() (higher of primary/secondary).
 *     Claude: null — this is the LOCAL-signal reader, used for display by
 *     frontier-usage.ts; it has no Claude signal and never invents one.
 *     Shared mode: also publishes the local reading to the shared ledger.
 *
 *   subscriptionAllows(engine, opts?)
 *     → { allowed: boolean; reason: string }
 *     Non-subscription engines: allowed. Subscription engines, AUTONOMOUS
 *     (the default — opts.autonomous !== false): allowed ONLY when a known,
 *     fresh reading is under maxPercent (default 90) AND the budget policy
 *     leaves headroom. INTERACTIVE (opts.autonomous === false): the pre-3.10
 *     rule — blocked only when a KNOWN window is at/above maxPercent; unknown
 *     usage is allowed and the budget reserves do not apply (they exist to
 *     keep headroom FOR interactive use). Shared mode: the MAX across
 *     non-expired ledger READINGS governs (presence-only entries are not
 *     readings).
 *
 *   isSubscriptionEngine(engine)
 *     → boolean
 *     True for frontier-tier CLI agents (claude / codex). Reuses engineTierOf.
 *
 * Why the gate defaults to AUTONOMOUS while routing defaults to interactive
 * (V3.10 integration, IB2): every direct caller of subscriptionAllows is a
 * daemon / fleet / fabric-gateway dispatch gate, so a caller that forgets the
 * flag must fail closed — forgetting it must never re-open the Claude
 * fail-open. The one shared entry point, run/router.ts#routeTask, passes
 * `autonomous: ctx.autonomous === true`, so plain `ashlr run` / goal / universe
 * routing keeps the pre-3.10 behaviour for npm users without the Verse
 * account collector.
 *
 * Design constraints:
 *  - Never throws — every error degrades to allowed:FALSE for a subscription
 *    engine on the autonomous path (unknown → closed), allowed:true on the
 *    interactive path (pre-3.10 contract), and allowed:true for a
 *    non-subscription engine.
 *  - maxPercent is read defensively from cfg.foundry with a default of 90.
 *  - Separate-account-per-laptop = each points at no/its-own shared path → no
 *    contention. Shared mode only activates when explicitly configured.
 */

import * as os from 'node:os';
import { readCodexRateLimits } from '../observability/codex-source.js';
import { loadBudgetPolicy, readCapacitySnapshot } from '../routing/budget-store.js';
import { assessSeat, type SeatCapacity } from '../routing/headroom.js';
import { defaultSeatPolicy, effectiveSeatPolicy, engineOfSeatId } from '../routing/policy.js';
import type { BudgetPolicy } from '../routing/types.js';
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
 * Decide whether the subscription window for `engine` permits a new
 * AUTONOMOUS dispatch.
 *
 * Returns allowed:false (fail CLOSED) whenever usage is unknown:
 *  - no reading at all (Claude without a Verse capacity snapshot, Codex with
 *    no session files and no snapshot),
 *  - a stale reading,
 *  - an unexpected error.
 *
 * Returns allowed:false when a KNOWN window is at or above maxPercent, or when
 * the budget policy (~/.ashlr/budget.json) holds the seat back (switched off,
 * at its reserve, above its 5-hour ceiling, spent).
 *
 * Returns allowed:true only when every applicable reading is known, fresh,
 * under maxPercent and inside the budget policy.
 *
 * M114: In shared mode, the effective usedPercent is the MAX across all
 * non-expired ledger READINGS for this engine (most-saturated machine governs).
 *
 * `opts.autonomous === false` switches to the INTERACTIVE rule instead
 * (`_interactiveAllows`: only a known window ≥ maxPercent blocks). Only
 * run/router.ts#routeTask passes it, derived from RoutingContext.autonomous.
 *
 * Never throws.
 */
export function subscriptionAllows(
  engine: EngineId,
  opts?: {
    maxPercent?: number;
    cfg?: unknown;
    nowMs?: number;
    /**
     * false = an INTERACTIVE dispatch (a person asked for it): pre-3.10 rule.
     * Absent/true = AUTONOMOUS: fail closed on unknown usage + budget policy.
     * See the module header for why the default is the closed one here.
     */
    autonomous?: boolean;
    /**
     * The budget policy to judge the seat by, in place of the stored
     * ~/.ashlr/budget.json (AUTONOMOUS rule only; the interactive rule never
     * reads a budget). WHY: a Leader class-B directive can switch a Codex
     * seat on for ONE tick — that budget exists only in the tick
     * (fleet/tick-hooks-live.ts applyCodexDirective). Judged by the stored
     * policy (Codex off by default) the seat was refused every tick, so the
     * tick skipped this whole gate for such seats and with it the M114
     * cross-machine reading. Passing the tick's budget here keeps every
     * check (capacity snapshot, cross-machine ledger, local reading) and
     * swaps only the policy. It can never widen past the grant: the caller
     * passes a budget the grant already clamped.
     */
    budget?: BudgetPolicy;
  },
): SubscriptionAllowResult {
  if (opts?.autonomous === false) return _interactiveAllows(engine, opts);
  const policyOf = (): BudgetPolicy => opts?.budget ?? loadBudgetPolicy();
  try {
    if (!isSubscriptionEngine(engine)) {
      return {
        allowed: true,
        reason: `${engine} is not a subscription engine — no window throttle applied`,
      };
    }

    const maxPct = opts?.maxPercent ?? DEFAULT_MAX_PERCENT;
    const nowMs = opts?.nowMs ?? Date.now();

    // V3.10: the Verse capacity snapshot + budget policy. Consulted first
    // because it is the only source that knows Claude's windows, the
    // operator's reserves, and whether the seat is switched off.
    const budget = _budgetVerdict(engine, maxPct, nowMs, policyOf);
    if (budget && !budget.allowed) return budget;

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
      if (budget) return budget;
      const gated = _localPolicyGate(engine, aggregate, policyOf);
      if (gated) return gated;
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

    if (usage && usage.usedPercent >= maxPct) {
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

    // A fresh, in-policy snapshot reading is enough on its own (Claude has no
    // local signal by construction).
    if (budget) return budget;

    if (!usage) {
      return {
        allowed: false,
        reason:
          `${engine} subscription usage unknown (no reading from the Verse account collector or local sessions) — ` +
          'unknown usage is not headroom, so autonomy stays off this engine',
      };
    }

    // Local reading known and under the cap, but no snapshot to apply the
    // budget policy to: apply what can be applied without seat ids.
    const gated = _localPolicyGate(engine, usage, policyOf);
    if (gated) return gated;

    return {
      allowed: true,
      reason:
        `${engine} subscription window ${usage.usedPercent}% used` +
        ` (max ${maxPct}%, ${usage.windowLabel} window) — within limit`,
    };
  } catch {
    // Unknown is not headroom: an unexpected error closes a subscription engine.
    return {
      allowed: false,
      reason: `${engine} subscription check failed unexpectedly — blocking (unknown usage is not headroom)`,
    };
  }
}

// ---------------------------------------------------------------------------
// Interactive gate — the pre-3.10 rule, kept for dispatches a person asked for
// ---------------------------------------------------------------------------

/**
 * The pre-3.10 subscription rule, for INTERACTIVE dispatch only.
 *
 * Blocks only when a KNOWN window (cross-machine ledger reading, else the
 * local Codex session reading) is at or above maxPercent; unknown usage and
 * errors allow. The budget policy and the capacity snapshot are deliberately
 * NOT consulted: the reserves exist to keep headroom for exactly this kind of
 * dispatch, and a missing snapshot (no Verse collector — every plain npm
 * install) must not turn `ashlr run` into a builtin-only tool.
 *
 * The one difference from 3.9: shared-ledger presence entries (Claude's
 * 0%-"unknown" markers) are not readings — `_aggregateSharedUsage` filters
 * them. They could never block (0 < maxPercent), so allow/block decisions are
 * identical to 3.9; only the wording of an unknown-usage reason changes.
 *
 * Never throws.
 */
function _interactiveAllows(
  engine: EngineId,
  opts: { maxPercent?: number; cfg?: unknown },
): SubscriptionAllowResult {
  try {
    if (!isSubscriptionEngine(engine)) {
      return { allowed: true, reason: `${engine} is not a subscription engine` };
    }
    const maxPct = opts.maxPercent ?? DEFAULT_MAX_PERCENT;
    const known = _aggregateSharedUsage(engine, opts.cfg) ?? subscriptionUsage(engine, { cfg: opts.cfg });
    if (!known) {
      return {
        allowed: true,
        reason: `${engine} subscription usage unknown — allowing (interactive dispatch; autonomy would stay off)`,
      };
    }
    if (known.usedPercent >= maxPct) {
      const resetStr = known.resetsAt
        ? ` (resets at ${new Date(known.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
        : '';
      return {
        allowed: false,
        reason:
          `${engine} subscription window ${known.usedPercent}% used` +
          ` (max ${maxPct}%, ${known.windowLabel} window)${resetStr}`,
      };
    }
    return {
      allowed: true,
      reason: `${engine} subscription window ${known.usedPercent}% used (max ${maxPct}%, ${known.windowLabel} window) — within limit`,
    };
  } catch {
    // Pre-3.10 contract for a person-initiated dispatch: an unexpected error
    // in the usage READER is not evidence the window is full. (A throw one
    // layer up, in engineAvailable, still closes — that is a bug, not usage.)
    return { allowed: true, reason: `${engine} subscription check failed unexpectedly — allowing (interactive)` };
  }
}

// ---------------------------------------------------------------------------
// V3.10 budget gate (Verse capacity snapshot + operator budget policy)
// ---------------------------------------------------------------------------

/** Engines whose seats appear in the Verse capacity snapshot. */
function _snapshotEngine(engine: EngineId): 'claude' | 'codex' | null {
  return engine === 'claude' || engine === 'codex' ? engine : null;
}

/**
 * The budget verdict for `engine` from the capacity snapshot, or null when
 * the snapshot has no seat of that engine (the caller then decides from the
 * local signal — and fails closed if there is none).
 *
 * allowed:true means EVERY seat of the engine is eligible for autonomy under
 * the current policy AND its binding reading is under maxPercent.
 */
function _budgetVerdict(
  engine: EngineId,
  maxPct: number,
  nowMs: number,
  policyOf: () => BudgetPolicy = loadBudgetPolicy,
): SubscriptionAllowResult | null {
  const snapEngine = _snapshotEngine(engine);
  if (!snapEngine) return null;
  const snapshot = readCapacitySnapshot();
  const seats: SeatCapacity[] = snapshot ? snapshot.seats.filter((s) => s.engine === snapEngine) : [];
  if (seats.length === 0) return null;
  const policy = policyOf();
  const parts: string[] = [];
  for (const seat of seats) {
    const assessed = assessSeat(seat, effectiveSeatPolicy(policy, seat.seatId, seat.engine), { nowMs });
    const h = assessed.headroom;
    if (!h.eligibleForAutonomy) {
      return {
        allowed: false,
        reason: `${engine} seat ${seat.seatId} is held back by the ${policy.mode} budget: ${h.reasons[0] ?? 'not eligible'}`,
      };
    }
    const used = Math.max(h.sessionUsedPercent ?? 0, h.weeklyUsedPercent ?? 0);
    if (used >= maxPct) {
      return {
        allowed: false,
        reason: `${engine} seat ${seat.seatId} window ${Math.round(used)}% used (max ${maxPct}%)`,
      };
    }
    parts.push(`${seat.seatId}: ${h.reasons[0] ?? 'eligible'}`);
  }
  return {
    allowed: true,
    reason: `${engine} within the ${policy.mode} budget — ${parts.join('; ')}`,
  };
}

/**
 * The budget policy applied to a LOCAL reading when there is no capacity
 * snapshot (the Verse server is not running). Seat ids are unknown here, so
 * the engine's seats are judged together, conservatively: any stored seat of
 * this engine switched off closes it, and with no stored seat the mode's
 * default for the engine decides (Codex is OFF by default — Mason, 2026-09-24).
 * The strictest stored reserve applies to the local reading.
 */
function _localPolicyGate(
  engine: EngineId,
  usage: SubscriptionUsage,
  policyOf: () => BudgetPolicy = loadBudgetPolicy,
): SubscriptionAllowResult | null {
  const snapEngine = _snapshotEngine(engine);
  if (!snapEngine) return null;
  const policy = policyOf();
  const stored = Object.values(policy.seats).filter((p) => engineOfSeatId(p.seatId) === snapEngine);
  const applicable = stored.length > 0 ? stored : [defaultSeatPolicy(policy.mode, snapEngine, snapEngine)];
  if (applicable.some((p) => !p.enabled)) {
    return {
      allowed: false,
      reason: `${engine} is switched off for autonomy in the ${policy.mode} budget (Verse → Budget)`,
    };
  }
  const reserve = Math.max(...applicable.map((p) => p.reservePercent));
  const ceiling = 100 - reserve;
  if (usage.usedPercent >= ceiling) {
    return {
      allowed: false,
      reason:
        `${engine} subscription window ${usage.usedPercent}% used; the ${policy.mode} budget keeps ${reserve}% ` +
        `for interactive use, so autonomy stops at ${ceiling}%`,
    };
  }
  return null;
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
    // V3.10: an entry with no window label is a PRESENCE marker (published
    // for claude, or codex with no sessions, as usedPercent 0). Zero there is
    // "no reading", not "0% used" — letting it govern re-opened the fail-open.
    // Claude never publishes a reading at all (it has no local signal), so no
    // claude ledger entry can be one — whatever label a sibling wrote.
    if (engine === 'claude') return null;
    const entries = store.readUsageEntries(engine, { maxAgeMs: DEFAULT_LEDGER_MAX_AGE_MS })
      .filter((e) => typeof e.windowLabel === 'string' && e.windowLabel.length > 0 && e.windowLabel !== 'unknown'
        && typeof e.usedPercent === 'number');

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
