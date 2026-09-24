/**
 * Tick hooks — V3.10 Track B contract (unit B-U1, frozen day 0).
 *
 * The seam through which resident autonomy reaches the 9.6k-line daemon loop.
 * Unit U5 owns both sides of it: the ~8 seam edits in daemon/loop.ts and the
 * live implementation in fleet/tick-hooks-live.ts. Keeping everything new
 * behind this interface is what lets the loop change by a handful of lines
 * and lets other units build in parallel without touching loop.ts.
 *
 * Seam map (loop.ts @ bb9ee28c):
 *   effectiveConfig  — the per-tick config (standing overlay: claimIntegrity,
 *                      forced confinement, clamped caps, pushToRemote …).
 *   route            — replaces `routeBackend(item, routingCfg)` at :5070, :5806, :6381.
 *   seatAllows       — replaces `subscriptionAllows(backend, { maxPercent })` at :6403, :6574.
 *   beforeTick       — once per tick, before selection.
 *   afterDispatch    — after each dispatch attempt (dispatched or skipped).
 *   afterLanding     — after the fleet lands a merge or a revert.
 *
 * DEFAULT_TICK_HOOKS reproduce master's tick EXACTLY (U5's parity test): route
 * and seatAllows delegate to the very functions the loop calls today, with
 * the same arguments; everything else is a no-op. That is also why `route`
 * and `seatAllows` are synchronous — `diagnosticRoute` calls routeBackend
 * inside a synchronous .filter(); anything asynchronous (capacity snapshots,
 * GitHub, the ledger) belongs in beforeTick, cached for the tick.
 *
 * Failure contract for implementations (loop.ts wraps every call too):
 *   route / seatAllows / beforeTick throwing ⇒ the loop fails CLOSED (no
 *   dispatch this tick); afterDispatch / afterLanding throwing ⇒ logged,
 *   never allowed to fail the tick.
 *
 * NODE-ONLY: the defaults import the live routers. The browser-safe data
 * types these hooks exchange live in fleet/fleet-types.ts.
 */
import type { AshlrConfig, EngineId, WorkItem } from '../types.js';
import { routeBackend, type RouteDecision } from '../fleet/router.js';
import { subscriptionAllows, type SubscriptionAllowResult } from '../fleet/subscription-usage.js';
import type { SeatDecision } from '../routing/types.js';
import type { DaemonCapabilityKind } from '../authority/types.js';
import type { DispatchOutcome, FleetEngine, LandingRecord, RouteHold } from '../fleet/fleet-types.js';

/** What `route` returns: the loop's RouteDecision plus what the SeatRouter decided. */
export interface TickRouteDecision extends RouteDecision {
  /** The A9 SeatRouter decision behind this route ("why this seat"); null when none was consulted. */
  seatDecision: SeatDecision | null;
  /**
   * Non-null ⇒ do NOT dispatch this item this tick (parked until a seat
   * reopens, or too large for any eligible seat and must be split — never
   * sent to a local model instead). The loop treats it like a skip.
   */
  hold: RouteHold | null;
}

/** Exactly what loop.ts passes to subscriptionAllows today. */
export interface SeatAllowsOptions {
  maxPercent: number;
}

export interface TickHookContext {
  nowMs: number;
  /** The config this tick runs with — already passed through effectiveConfig. */
  cfg: AshlrConfig;
  dryRun: boolean;
  /** The activation capability this tick holds; null for dry-run ticks. */
  capabilityKind: DaemonCapabilityKind | null;
}

export interface BeforeTickResult {
  /** Enrolled repo PATHS (exactly `WorkItem.repo`) that must not be dispatched this tick. */
  pausedRepos: readonly string[];
  /** Per-lane slot caps for this tick; a lane absent here gets no hook-imposed cap. */
  laneCaps: Readonly<Partial<Record<FleetEngine, number>>>;
  /** Non-null ⇒ start no NEW production this tick (backpressure); verification and landing continue. The reason is audited. */
  holdProduction: string | null;
}

export interface TickHooks {
  effectiveConfig(cfg: AshlrConfig): AshlrConfig;
  route(item: WorkItem, cfg: AshlrConfig): TickRouteDecision;
  seatAllows(engine: EngineId, opts: SeatAllowsOptions): SubscriptionAllowResult;
  beforeTick(ctx: TickHookContext): Promise<BeforeTickResult>;
  afterDispatch(outcome: DispatchOutcome): Promise<void>;
  afterLanding(record: LandingRecord): Promise<void>;
}

const NO_TICK_CONSTRAINTS: BeforeTickResult = Object.freeze({
  pausedRepos: Object.freeze([]) as readonly string[],
  laneCaps: Object.freeze({}),
  holdProduction: null,
});

/**
 * Master's behavior, verbatim. Frozen so nothing can monkey-patch the
 * defaults at runtime — installing live hooks means passing a different
 * object (U5), never mutating this one.
 */
export const DEFAULT_TICK_HOOKS: TickHooks = Object.freeze({
  effectiveConfig: (cfg: AshlrConfig): AshlrConfig => cfg,
  route: (item: WorkItem, cfg: AshlrConfig): TickRouteDecision => ({
    ...routeBackend(item, cfg),
    seatDecision: null,
    hold: null,
  }),
  seatAllows: (engine: EngineId, opts: SeatAllowsOptions): SubscriptionAllowResult =>
    subscriptionAllows(engine, opts),
  beforeTick: async (): Promise<BeforeTickResult> => NO_TICK_CONSTRAINTS,
  afterDispatch: async (): Promise<void> => undefined,
  afterLanding: async (): Promise<void> => undefined,
});
