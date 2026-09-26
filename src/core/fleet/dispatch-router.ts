/**
 * Fleet dispatch router — V3.10 Track B unit U5 (SPEC-310B §3 "Routing" + "Lanes").
 *
 * Under a standing grant every fleet dispatch is decided HERE, by A9's pure
 * SeatRouter (`routeSeat`) over the budget policy clamped to the grant — never
 * by the legacy router alone. The legacy decision (`routeBackend`) is kept as
 * an input because it encodes item-specific rules (repair lineage, local-only
 * direction, allowedBackends); the SeatRouter decides WHICH LANE may spend on
 * the item, the legacy engine is kept when it already sits in that lane.
 *
 * PURE: no clock reads (`ctx.nowMs`), no I/O, no model calls. Everything
 * asynchronous — the capacity snapshot, presence, the local runtime probe, the
 * Leader's directives — is gathered once per tick by fleet/tick-hooks-live.ts
 * and handed in as a `DispatchRouterContext`. That is what lets `route` stay
 * synchronous (loop.ts calls it inside `.filter()`), and what makes every rule
 * below testable without a daemon.
 *
 * RULES (each has a test in test/dispatch-router-310b.test.ts):
 *  - Claude is excluded while its 5-hour window is above the grant's session
 *    ceiling (70% by decision) and whenever the weekly reserve is reached —
 *    A9's `assessSeat`, applied over the CLAMPED policy.
 *  - Codex runs only after the Leader enabled its lanes (class B, after the
 *    reset) AND the grant lists it; a spent Codex window parks work until its
 *    machine `resetsAt`.
 *  - An item that fits no seat's context is held as `split` — it is NEVER
 *    sent to a local model instead. An item that would fit a seat that is only
 *    budget-excluded is held as `park` until the earliest known reopening.
 *  - Presence caps: while Mason is present (a live Verse turn or a Claude Code
 *    transcript under 15 minutes old) the local lane runs at most 2 agents and
 *    the Claude producer slice is closed. Unknown presence counts as present.
 *  - A lane outside the grant's current rollout stage has zero slots.
 *  - A seat is a PRODUCER only when the grant gives it the `producer` role;
 *    claude-a is judge / Leader only by default.
 *
 * Honesty: `null` = unknown. Every exclusion carries a specific sentence, and
 * a hold always says why and (when a date is known) until when.
 */
import type { AshlrConfig, EngineId, EngineTier, WorkItem, WorkSource } from '../types.js';
import type { EffectivePolicy } from '../authority/types.js';
import { describeExclusions, routeSeat, ROUTER_CONTEXT_FIT_FRACTION, type RouterWeights } from '../routing/router.js';
import { engineOfSeatId } from '../routing/policy.js';
import { reasonSentences } from '../routing/seat-reasons.js';
import type { SeatCapacity } from '../routing/headroom.js';
import type {
  BudgetPolicy,
  RoutingDifficulty,
  RoutingRequest,
  RoutingTask,
  SeatDecision,
  SeatExclusion,
  SeatReason,
} from '../routing/types.js';
import { engineLocality, engineMeteredness } from '../policy/local-only.js';
import { LEADER_LIMITS, type LeaderDirectivesV1 } from '../vision/leader-types.js';
import type { HarnessRoutingWeights } from '../learn/harness-types.js';
import { registryEngineForFleetEngine, resolveEngineSpec } from '../run/engine-registry.js';
import { GROK_CLI_FAST_MODEL, pickModel } from '../run/model-catalog.js';
import { planAutonomousBestOfN, type AutonomousBestOfNPlan } from '../run/best-of-n-policy.js';
import { FLEET_ENGINES, type FleetEngine, type FleetLaneState, type RouteHold } from './fleet-types.js';

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/**
 * Default slots per lane (SPEC-310B §3 table). Codex is 2 once the Leader has
 * enabled it (it is 0 until then — see `planLanes`).
 */
export const LANE_DEFAULT_SLOTS: Readonly<Record<FleetEngine, number>> = Object.freeze({
  local: 4,
  'grok-cli': LEADER_LIMITS.grokLanes.default,
  'claude-cli': 1,
  codex: 2,
});

/** Local lane width while Mason is present. */
export const PRESENCE_LOCAL_SLOTS = 2;

/** A Claude Code transcript younger than this means Mason is at the keyboard. */
export const PRESENCE_WINDOW_MS = 15 * 60_000;

/**
 * The seat id the fleet's own local runtime (llama-server, or local-coder)
 * routes under. The grant's `spend.seats` names it too — a local seat absent
 * from the grant is unusable (fail closed), exactly like a paid one.
 */
export const FLEET_LOCAL_SEAT_ID = 'local';

/**
 * Context tokens of one local slot when the runtime does not report it.
 * llama-server is launched with 4 × 64k slots (docs/LOCAL-FLEET.md); using
 * the documented width keeps big items off local even when the probe is
 * mute — a null window would make the router skip the fit check entirely.
 */
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 65_536;

/**
 * Which fleet lane an engine id dispatches through, or null when it is not a
 * fleet engine at all (per-token APIs, agents whose spend we cannot read).
 *
 * `local` requires BOTH on-device inference AND provably free spend: an agent
 * that runs locally but reaches a vendor with credentials this hub hands it
 * (ashlrcode) is not local capacity, and one whose backend we cannot see (aw)
 * is not either — policy/local-only.ts owns both judgements.
 */
export function fleetLaneOf(engine: string | null | undefined, cfg?: AshlrConfig): FleetEngine | null {
  if (typeof engine !== 'string' || engine.length === 0) return null;
  const id = engine.trim().toLowerCase();
  if (id === 'grok-cli') return 'grok-cli';
  if (id === 'claude') return 'claude-cli';
  if (id === 'codex') return 'codex';
  // The per-token xAI API ('grok') is never a lane: the SuperGrok seat runs
  // only through grok-cli (SPEC-310B §3, "stays out of allowedBackends").
  if (id === 'grok') return null;
  try {
    if (engineLocality(engine, cfg) === 'local' && engineMeteredness(engine, cfg) === 'free') return 'local';
  } catch {
    // An engine the policy module cannot classify is not local capacity.
  }
  return null;
}

/** The lane a Verse / routing seat belongs to. */
export function laneOfSeat(seat: Pick<SeatCapacity, 'engine'>): FleetEngine {
  switch (seat.engine) {
    case 'claude':
      return 'claude-cli';
    case 'codex':
      return 'codex';
    case 'grok':
      return 'grok-cli';
    default:
      return 'local';
  }
}

export interface OperatorPresence {
  /** null = could not tell (treated as present). */
  present: boolean | null;
  /** One sentence: what showed presence, or why it is unknown. */
  reason: string;
  /** ISO time of the freshest evidence; null when none. */
  evidenceAt: string | null;
}

export interface LanePlanInput {
  policy: Pick<EffectivePolicy, 'engines' | 'spend'>;
  directives: LeaderDirectivesV1 | null;
  presence: OperatorPresence;
  /** Serving slots the local runtime reports (after the fleet's own derivation); null = unknown. */
  localServingSlots: number | null;
  /** Per lane: why its engine cannot run (not installed, not allowed); absent = available. */
  engineUnavailable: Readonly<Partial<Record<FleetEngine, string>>>;
}

export interface LanePlan {
  lane: FleetEngine;
  slots: number;
  /** Why `slots` differs from LANE_DEFAULT_SLOTS; null when it does not. */
  capReason: string | null;
}

function grantHasProducerFor(policy: LanePlanInput['policy'], lane: FleetEngine): boolean {
  for (const [seatId, seat] of Object.entries(policy.spend.seats)) {
    if (!seat.enabled || !seat.roles.includes('producer')) continue;
    if (laneOfSeat({ engine: engineOfSeatId(seatId) }) === lane) return true;
  }
  return false;
}

/**
 * The grant's policy for one seat: its own entry, or — for a local-runtime
 * seat only — the `local` wildcard entry; null when the grant does not name
 * it (autonomy may not use it — fail closed).
 *
 * This is authority/effective-config.ts `standingSeatFor` (B-U1), mirrored
 * rather than imported: loop.ts imports this module statically, and pulling
 * the grant verifier into master's module graph for one lookup is not worth
 * it. test/dispatch-router-310b.test.ts pins the two to the same answers.
 * (FLEET_LOCAL_SEAT_ID is B-U1's LOCAL_SEAT_WILDCARD — both are `local`.)
 */
export function grantSeatFor<T>(spend: { seats: Readonly<Record<string, T>> }, seatId: string): T | null {
  if (Object.prototype.hasOwnProperty.call(spend.seats, seatId)) return spend.seats[seatId] ?? null;
  if (engineOfSeatId(seatId) === 'local' && Object.prototype.hasOwnProperty.call(spend.seats, FLEET_LOCAL_SEAT_ID)) {
    return spend.seats[FLEET_LOCAL_SEAT_ID] ?? null;
  }
  return null;
}

/**
 * Lane names as the operator reads them — the same words the Verse lane chips
 * use. The machine-readable `lane` field keeps the ids (`grok-cli`); only the
 * sentences a person reads (`capReason`, held-back seat reasons) use these, so
 * the web UI and logs can print them as they are instead of re-translating.
 */
export const FLEET_LANE_LABEL: Readonly<Record<FleetEngine, string>> = {
  local: 'Local',
  'grok-cli': 'Grok',
  'claude-cli': 'Claude',
  codex: 'Codex',
};

/**
 * "1 slot", "2 slots", "1 local slot" — a count with its noun pluralised by
 * the count, so reasons never read "2 slot(s)". `noun` is the singular and may
 * carry leading words ("local slot"); only its last word gets the "s".
 */
export function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function clampGrokLanes(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(LEADER_LIMITS.grokLanes.min, Math.min(LEADER_LIMITS.grokLanes.max, Math.floor(value)));
}

/**
 * The slots each lane may use THIS tick. Only ever narrows the defaults,
 * except where a class-B Leader action (grok 3–4 lanes, Codex on) has already
 * passed its veto window — those are decisions the grant allows.
 */
export function planLanes(input: LanePlanInput): Record<FleetEngine, LanePlan> {
  const out = {} as Record<FleetEngine, LanePlan>;
  const presentOrUnknown = input.presence.present !== false;
  for (const lane of FLEET_ENGINES) {
    let slots = LANE_DEFAULT_SLOTS[lane];
    let capReason: string | null = null;
    const narrow = (to: number, why: string): void => {
      if (to < slots) {
        slots = to;
        capReason = why;
      }
    };

    if (lane === 'grok-cli') {
      const leader = clampGrokLanes(input.directives?.grokLanes);
      if (leader !== null && leader !== slots) {
        slots = leader;
        capReason = `The Leader set ${countOf(leader, `${FLEET_LANE_LABEL['grok-cli']} lane`)}.`;
      }
    }
    if (lane === 'codex') {
      if (input.directives?.codexEnabled !== true) {
        slots = 0;
        // Enabling Codex is a class-B Leader action: it waits out a veto
        // window, which is what the operator can act on — say that, not the
        // action class.
        capReason = 'Codex stays off until the Leader turns it on after the usage reset (you can veto it).';
      }
    }
    if (lane === 'local') {
      if (typeof input.localServingSlots === 'number' && Number.isFinite(input.localServingSlots)) {
        const serving = Math.max(0, Math.floor(input.localServingSlots));
        narrow(serving, `The local runtime serves ${countOf(serving, 'slot')}.`);
      }
      if (presentOrUnknown) {
        narrow(PRESENCE_LOCAL_SLOTS, input.presence.present === null
          ? `Presence is unknown (${lowerFirst(input.presence.reason)}), so the local lane is held to ${PRESENCE_LOCAL_SLOTS} as if you were here.`
          : `You are active (${lowerFirst(input.presence.reason)}), so the local lane is held to ${PRESENCE_LOCAL_SLOTS}.`);
      }
    }
    if (lane === 'claude-cli') {
      if (!grantHasProducerFor(input.policy, 'claude-cli')) {
        narrow(0, 'The grant gives claude-a no producer role — it judges and runs the Leader only.');
      } else if (presentOrUnknown) {
        narrow(0, 'You are active (or presence is unknown), so the Claude producer slice is held for your own session.');
      }
    } else if (lane !== 'local' && !grantHasProducerFor(input.policy, lane)) {
      narrow(0, `No ${FLEET_LANE_LABEL[lane]} seat has the producer role in the grant.`);
    }
    const unavailable = input.engineUnavailable[lane];
    if (unavailable) narrow(0, unavailable);
    if (!input.policy.engines.includes(lane)) {
      narrow(0, `The grant's current rollout stage does not include ${FLEET_LANE_LABEL[lane]}.`);
    }
    out[lane] = { lane, slots, capReason };
  }
  return out;
}

/** FleetLaneState rows for the API from a lane plan and live busy counts. */
export function laneStates(
  plan: Readonly<Record<FleetEngine, LanePlan>>,
  busy: Readonly<Partial<Record<FleetEngine, number>>>,
): FleetLaneState[] {
  return FLEET_ENGINES.map((lane) => ({
    lane,
    slots: plan[lane].slots,
    busy: Math.max(0, Math.floor(busy[lane] ?? 0)),
    capReason: plan[lane].capReason,
  }));
}

// ---------------------------------------------------------------------------
// Work item → routing request
// ---------------------------------------------------------------------------

/**
 * Working-set estimate by difficulty, before the item's own text. An
 * ESTIMATE (like context-math's overheads), never shown as a measurement.
 */
export const WORKING_SET_TOKENS: Readonly<Record<RoutingDifficulty, number>> = Object.freeze({
  low: 8_000,
  medium: 20_000,
  high: 48_000,
});

/**
 * Engine session overhead folded into the estimate. The largest per-engine
 * estimate (Claude's 25k) is used for every seat because routeSeat compares a
 * single request size against each seat — under-estimating is the direction
 * that would push an oversized item onto a small local window.
 */
export const ROUTING_SESSION_OVERHEAD_TOKENS = 25_000;

const CHARS_PER_TOKEN = 4;

const TAG_DIFFICULTY = /^difficulty:(low|medium|high)$/;
const TAG_CONTEXT = /^context:(\d{1,9})$/;

const BULK_SOURCES: ReadonlySet<WorkSource> = new Set<WorkSource>(['hygiene', 'lint']);

/** Difficulty of a work item: an explicit `difficulty:` tag, else its effort / source. */
export function difficultyOf(item: Pick<WorkItem, 'effort' | 'source' | 'tags'>): RoutingDifficulty {
  for (const tag of item.tags ?? []) {
    const match = TAG_DIFFICULTY.exec(tag);
    if (match) return match[1] as RoutingDifficulty;
  }
  const effort = typeof item.effort === 'number' && Number.isFinite(item.effort) ? item.effort : 3;
  if (item.source === 'invent') return 'high';
  if (effort >= 4) return 'high';
  if (item.source === 'security') return effort <= 2 ? 'medium' : 'high';
  return effort <= 2 ? 'low' : 'medium';
}

/** The SeatRouter request for one work item. Always autonomous. */
export function routingRequestFor(item: Pick<WorkItem, 'effort' | 'source' | 'tags' | 'title' | 'detail'>): RoutingRequest {
  const difficulty = difficultyOf(item);
  const task: RoutingTask = BULK_SOURCES.has(item.source) ? 'bulk' : 'code';
  let contextTokens: number | null = null;
  for (const tag of item.tags ?? []) {
    const match = TAG_CONTEXT.exec(tag);
    if (match) contextTokens = Number(match[1]);
  }
  if (contextTokens === null) {
    const text = `${item.title ?? ''}\n${item.detail ?? ''}`;
    contextTokens = WORKING_SET_TOKENS[difficulty] + ROUTING_SESSION_OVERHEAD_TOKENS
      + Math.ceil(text.length / CHARS_PER_TOKEN);
  }
  return { task, difficulty, contextTokens, autonomous: true };
}

// ---------------------------------------------------------------------------
// Route demotion (fed by fleet/backpressure.ts)
// ---------------------------------------------------------------------------

export interface RouteDemotion {
  /** Engine id as dispatched. */
  engine: string;
  /** nameWithOwner. */
  repo: string;
  /** WorkSource of the items the route failed on. */
  kind: string;
  since: string;
  until: string;
  reason: string;
}

export function routeKey(engine: string, repo: string, kind: string): string {
  return `${engine}|${repo}|${kind}`;
}

function activeDemotion(
  demotions: readonly RouteDemotion[],
  engine: string,
  repo: string | null,
  kind: string,
  nowMs: number,
): RouteDemotion | null {
  if (repo === null) return null;
  for (const d of demotions) {
    if (d.engine === engine && d.repo === repo && d.kind === kind && Date.parse(d.until) > nowMs) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The route decision
// ---------------------------------------------------------------------------

/** The legacy decision the loop would have made (fleet/router.ts RouteDecision). */
export interface LegacyRoute {
  backend: EngineId;
  tier: EngineTier | null;
  model?: string | null;
  reason: string;
}

export interface DispatchRouterContext {
  nowMs: number;
  /** The standing policy in force this tick. */
  policy: Pick<EffectivePolicy, 'engines' | 'spend' | 'repos'>;
  /** The A9 budget policy, already clamped to the grant (clampBudgetPolicy). */
  budget: BudgetPolicy;
  /** Seats the fleet may route over: paid seats from the capacity snapshot + the fleet's local seat. */
  capacity: readonly SeatCapacity[];
  lanes: Readonly<Record<FleetEngine, LanePlan>>;
  /** The engine each lane dispatches through; null when none is installed / allowed. */
  laneEngines: Readonly<Record<FleetEngine, EngineId | null>>;
  demotions: readonly RouteDemotion[];
  /**
   * The λ routing weights this tick (`resolveRoutingWeights`: Leader ›
   * harness › baseline). Absent = the router's defaults, which keep its
   * explicit engine order.
   */
  weights?: Partial<RouterWeights>;
  /** Enrolled path (WorkItem.repo) → GitHub nameWithOwner; null when unknown. */
  repoOf: (repoPath: string) => string | null;
  /** Engine tier (sandboxed-engine engineTierOf), injected so this module stays light. */
  tierOf: (engine: EngineId) => EngineTier | null;
  cfg?: AshlrConfig;
}

export interface DispatchRoute {
  backend: EngineId;
  tier: EngineTier;
  model?: string;
  reason: string;
  seatDecision: SeatDecision | null;
  hold: RouteHold | null;
  /** The lane the backend dispatches through; null when held before a lane was chosen. */
  lane: FleetEngine | null;
  /** nameWithOwner of the item's repo; null when unknown. */
  repo: string | null;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function earliest(times: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const t of times) {
    if (!t) continue;
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms < Date.parse(best)) best = t;
  }
  return best;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Does any seat with a known window have room for the request (budget aside)? */
function fitsSomeSeat(capacity: readonly SeatCapacity[], contextTokens: number | undefined): boolean {
  if (contextTokens === undefined) return true;
  let known = 0;
  for (const seat of capacity) {
    if (seat.contextWindow === null) continue;
    known += 1;
    if (contextTokens <= seat.contextWindow * ROUTER_CONTEXT_FIT_FRACTION) return true;
  }
  // No window is known anywhere: we cannot claim it fits nothing.
  return known === 0;
}

function legacyTier(legacy: LegacyRoute, ctx: DispatchRouterContext): EngineTier {
  return legacy.tier ?? ctx.tierOf(legacy.backend) ?? 'local';
}

function held(
  legacy: LegacyRoute,
  ctx: DispatchRouterContext,
  repo: string | null,
  decision: SeatDecision | null,
  hold: RouteHold,
): DispatchRoute {
  // The backend stays a valid EngineId the loop can reason about, but `hold`
  // is what the loop acts on: the item is skipped this tick.
  return {
    backend: legacy.backend,
    tier: legacyTier(legacy, ctx),
    ...(legacy.model ? { model: legacy.model } : {}),
    reason: `held (${hold.kind}): ${hold.reason}`,
    seatDecision: decision,
    hold,
    lane: null,
    repo,
  };
}

/**
 * Route one work item under the standing policy. Pure.
 *
 * Returns the backend to dispatch, the SeatRouter decision behind it ("why
 * this seat"), and — when nothing may run it now — a hold the loop treats as
 * a skip.
 */
export function routeWorkItem(item: WorkItem, legacy: LegacyRoute, ctx: DispatchRouterContext): DispatchRoute {
  const repo = ctx.repoOf(item.repo);
  if (repo === null) {
    return held(legacy, ctx, null, null, {
      kind: 'park',
      reason: 'Its repository has no GitHub identity the grant can be checked against.',
      nextEligibleAt: null,
    });
  }
  if (!ctx.policy.repos.some((r) => r.nameWithOwner.toLowerCase() === repo.toLowerCase())) {
    return held(legacy, ctx, repo, null, {
      kind: 'park',
      reason: `${repo} is not in the grant's current rollout stage.`,
      nextEligibleAt: null,
    });
  }

  const request = routingRequestFor(item);
  const decision = routeSeat(request, ctx.capacity, ctx.budget, {
    nowMs: ctx.nowMs,
    ...(ctx.weights ? { weights: ctx.weights } : {}),
  });
  const extra: SeatExclusion[] = [];
  const kind = item.source;
  let chosenSeat: string | null = null;
  let chosenLane: FleetEngine | null = null;
  let chosenEngine: EngineId | null = null;

  for (const seatId of decision.candidates) {
    const seat = ctx.capacity.find((s) => s.seatId === seatId);
    if (!seat) continue;
    const lane = laneOfSeat(seat);
    const grantSeat = grantSeatFor(ctx.policy.spend, seatId);
    // Each reason as data, plus the sentence the logs and CLI have always
    // printed (identical for all but a demotion, whose sentence keeps its
    // "until <ISO>" while the data carries that instant as `resetsAt`).
    const details: SeatReason[] = [];
    const reasons: string[] = [];
    const add = (detail: SeatReason, sentence?: string): void => {
      details.push(detail);
      reasons.push(sentence ?? reasonSentences([detail])[0]!);
    };
    if (!ctx.policy.engines.includes(lane)) add({ kind: 'grant', text: `The grant's current stage does not include ${FLEET_LANE_LABEL[lane]}.` });
    if (!grantSeat || !grantSeat.enabled) add({ kind: 'grant', text: 'The grant does not let autonomy use this seat.' });
    else if (!grantSeat.roles.includes('producer')) {
      add({ kind: 'grant', text: `The grant gives this seat no producer role (${grantSeat.roles.join(', ') || 'none'}).` });
    }
    const plan = ctx.lanes[lane];
    if (plan.slots <= 0) add({ kind: 'lane', text: plan.capReason ?? `The ${FLEET_LANE_LABEL[lane]} lane has no slots this tick.` });
    const engine = ctx.laneEngines[lane];
    if (engine === null) add({ kind: 'lane', text: `No ${FLEET_LANE_LABEL[lane]} engine is installed and allowed in this build.` });
    if (reasons.length === 0 && engine !== null) {
      // Keep the legacy engine when it already dispatches through this lane:
      // it may encode item-specific rules (a repair's parent engine, the
      // operator's preferred local runtime).
      const candidateEngine = fleetLaneOf(legacy.backend, ctx.cfg) === lane ? legacy.backend : engine;
      const demoted = activeDemotion(ctx.demotions, candidateEngine, repo, kind, ctx.nowMs);
      if (demoted) {
        // The string form keeps "demoted until <ISO>: <why>" (logs, CLI); the
        // data form carries the end as `resetsAt` so a UI can show it locally.
        const why = demoted.reason.trim().replace(/[.!?]?$/, '.');
        add(
          { kind: 'demoted', text: `This route (${candidateEngine} on ${repo} for ${kind} work) is demoted: ${why}`, resetsAt: demoted.until },
          `This route (${candidateEngine} on ${repo} for ${kind} work) is demoted until ${demoted.until}: ${demoted.reason}`,
        );
      } else {
        chosenSeat = seatId;
        chosenLane = lane;
        chosenEngine = candidateEngine;
        break;
      }
    }
    extra.push({ seatId, reasons, nextEligibleAt: null, details });
  }

  const exclusions = [...decision.exclusions, ...extra].sort((a, b) => (a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0));
  const candidates = chosenSeat === null
    ? []
    : decision.candidates.filter((id) => !extra.some((e) => e.seatId === id));

  if (chosenSeat === null || chosenLane === null || chosenEngine === null) {
    const seatDecision: SeatDecision = {
      seatId: null,
      candidates: [],
      exclusions,
      why: decision.seatId === null
        ? decision.why
        : `No seat the grant lets produce can take ${request.difficulty}-difficulty ${request.task} work right now `
          + `(${describeExclusions(exclusions)}).`,
      summary: decision.seatId === null && decision.summary
        ? decision.summary
        : `No seat the grant lets produce can take this ${request.difficulty}-difficulty ${request.task} work right now.`,
      mode: decision.mode,
    };
    if (!fitsSomeSeat(ctx.capacity, request.contextTokens)) {
      return held(legacy, ctx, repo, seatDecision, {
        kind: 'split',
        reason: `It needs about ${formatTokens(request.contextTokens ?? 0)} tokens of context, more than any seat's window can take — `
          + 'it must be split into smaller slices (it is never handed to a local model instead).',
        nextEligibleAt: null,
      });
    }
    return held(legacy, ctx, repo, seatDecision, {
      kind: 'park',
      reason: seatDecision.why,
      nextEligibleAt: earliest(exclusions.map((e) => e.nextEligibleAt)),
    });
  }

  const seatDecision: SeatDecision = chosenSeat === decision.seatId
    ? { ...decision, exclusions }
    : {
        seatId: chosenSeat,
        candidates,
        exclusions,
        why: `Routed autonomous ${request.difficulty}-difficulty ${request.task} work to ${chosenSeat} (${chosenLane}): `
          + `the router's first choice${decision.seatId ? ` (${decision.seatId})` : ''} is not a producer the grant allows right now.`,
        summary: `${ctx.capacity.find((c) => c.seatId === chosenSeat)?.label ?? chosenSeat} — the router's first choice`
          + `${decision.seatId ? ` (${decision.seatId})` : ''} is not a producer the grant allows right now.`,
        mode: decision.mode,
      };
  const tier = chosenEngine === legacy.backend ? legacyTier(legacy, ctx) : ctx.tierOf(chosenEngine) ?? 'local';
  const model = (chosenEngine === legacy.backend
    ? legacy.model ?? undefined
    : configuredModel(ctx.cfg, chosenEngine))
    // U7: low-difficulty grok-cli work takes the seat's faster sibling unless
    // the operator pinned a grok-cli model — the fast model spends the same
    // seat but returns sooner, which is what cheap work wants.
    ?? (chosenLane === 'grok-cli' && request.difficulty === 'low' ? grokFastModel() : undefined);
  return {
    backend: chosenEngine,
    tier,
    ...(model ? { model } : {}),
    reason: `standing router: ${seatDecision.why}`,
    seatDecision,
    hold: null,
    lane: chosenLane,
    repo,
  };
}

/**
 * The grok-cli model for low-difficulty work: the catalog's `fast` grok-cli
 * entry (ids are `grok-cli:<model>`; the engine takes the bare model), else
 * the compiled GROK_CLI_FAST_MODEL.
 */
export function grokFastModel(): string {
  const entry = pickModel({ engine: 'grok-cli', capability: 'fast', preferCheap: true });
  const id = entry?.id ?? '';
  const bare = id.startsWith('grok-cli:') ? id.slice('grok-cli:'.length) : '';
  return bare.length > 0 ? bare : GROK_CLI_FAST_MODEL;
}

function configuredModel(cfg: AshlrConfig | undefined, engine: EngineId): string | undefined {
  const models = cfg?.foundry?.models as Record<string, unknown> | undefined;
  const value = models?.[engine];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Lane engines
// ---------------------------------------------------------------------------

export interface LaneEngineInput {
  /** cfg.foundry.allowedBackends (the legacy router's default is ['builtin']). */
  allowedBackends: readonly string[];
  /** Is the engine registered and its binary / endpoint present? Injected (PATH probes are I/O). */
  installed: (engine: EngineId) => boolean;
  /** The local fleet runtime engine when the local fleet is enabled; null otherwise. */
  localFleetEngine: EngineId | null;
  cfg?: AshlrConfig;
}

/**
 * The engine each lane dispatches through, plus why a lane has none. The
 * local lane prefers the fleet runtime (parallel slots), then Ollama's
 * local-coder, then the in-process builtin loop — all three free and
 * on-device.
 */
export function resolveLaneEngines(input: LaneEngineInput): {
  engines: Record<FleetEngine, EngineId | null>;
  unavailable: Partial<Record<FleetEngine, string>>;
} {
  const allowed = new Set(input.allowedBackends);
  const engines = {} as Record<FleetEngine, EngineId | null>;
  const unavailable: Partial<Record<FleetEngine, string>> = {};
  const usable = (engine: EngineId): boolean => allowed.has(engine) && input.installed(engine);

  const localOrder: EngineId[] = [
    ...(input.localFleetEngine ? [input.localFleetEngine] : []),
    'local-coder' as EngineId,
    'builtin' as EngineId,
  ];
  engines.local = localOrder.find((e) => usable(e) && fleetLaneOf(e, input.cfg) === 'local') ?? null;
  if (engines.local === null) unavailable.local = 'No free local engine is allowed and installed.';

  // U7 owns the lane → registry engine mapping; restating it here would let
  // the two drift (e.g. a renamed grok-cli engine id).
  const single: [FleetEngine, EngineId][] = (['grok-cli', 'claude-cli', 'codex'] as const)
    .map((lane) => [lane, registryEngineForFleetEngine(lane) as EngineId]);
  for (const [lane, engine] of single) {
    if (!allowed.has(engine)) {
      engines[lane] = null;
      unavailable[lane] = `${engine} is not in foundry.allowedBackends.`;
    } else if (!input.installed(engine)) {
      engines[lane] = null;
      unavailable[lane] = `${engine} is not installed in this build.`;
    } else {
      engines[lane] = engine;
    }
  }
  return { engines, unavailable };
}

// ---------------------------------------------------------------------------
// Best-of-N (SPEC-310B §3: Grok plus 2 local candidates, from different engines)
// ---------------------------------------------------------------------------

/**
 * Candidate engines for a best-of-N attempt: at most one per engine, grok-cli
 * first when its lane is open, then distinct free local engines. Candidates
 * must be of DIFFERENT engines — two samples of the same engine are not
 * independent evidence. Returns [] when fewer than 2 distinct engines qualify
 * (best-of-N of one is just a dispatch).
 */
export function bestOfNCandidates(
  lanes: Readonly<Record<FleetEngine, LanePlan>>,
  laneEngines: Readonly<Record<FleetEngine, EngineId | null>>,
  localEngines: readonly EngineId[],
  max = 3,
): EngineId[] {
  const out: EngineId[] = [];
  const grok = laneEngines['grok-cli'];
  if (grok !== null && lanes['grok-cli'].slots > 0) out.push(grok);
  if (lanes.local.slots > 0) {
    for (const engine of localEngines) {
      if (out.length >= max) break;
      if (!out.includes(engine)) out.push(engine);
    }
  }
  const distinct = out.slice(0, Math.max(0, max));
  return distinct.length >= 2 ? distinct : [];
}

// ---------------------------------------------------------------------------
// Leader directives, routing weights and the autonomous best-of-N plan
// (B-U8 / B-U9 / U7 cross-unit wiring). All pure.
// ---------------------------------------------------------------------------

/**
 * The Leader's lane directives, clamped by the grant (B-U8): `codexEnabled`
 * only counts while the grant's current stage lists `codex`, and `grokLanes`
 * only while it lists `grok-cli`. A directive the grant does not cover is
 * dropped here rather than left for planLanes to zero, so every reader of the
 * tick (the journal, "why this lane") sees the same clamped value.
 * `routerTuning` is bounded by leader-apply's own validation and only ever
 * reorders within what the grant already admits, so it passes through.
 */
export function clampLeaderDirectives(
  directives: LeaderDirectivesV1 | null,
  policy: Pick<EffectivePolicy, 'engines'>,
): LeaderDirectivesV1 | null {
  if (directives === null) return null;
  return {
    ...directives,
    codexEnabled: policy.engines.includes('codex') ? directives.codexEnabled : null,
    grokLanes: policy.engines.includes('grok-cli') ? directives.grokLanes : null,
  };
}

const DIFFICULTY_RANK: Readonly<Record<RoutingDifficulty, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });

function isDifficulty(value: unknown): value is RoutingDifficulty {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isWeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The router's tunables this tick. Precedence (harness-types.ts): a Leader
 * `router.tune` override › the active harness › the compiled baseline
 * (`BASELINE_HARNESS_CONFIG.routing`, passed in so this module does not pull
 * the harness store into loop.ts's static graph). A malformed field falls
 * through to the next layer instead of poisoning the tick.
 */
export function resolveRoutingWeights(
  baseline: HarnessRoutingWeights,
  harness: Partial<HarnessRoutingWeights> | null,
  leader: Partial<HarnessRoutingWeights> | null,
): HarnessRoutingWeights {
  const pick = <K extends keyof HarnessRoutingWeights>(key: K, valid: (v: unknown) => boolean): HarnessRoutingWeights[K] => {
    if (leader && valid(leader[key])) return leader[key] as HarnessRoutingWeights[K];
    if (harness && valid(harness[key])) return harness[key] as HarnessRoutingWeights[K];
    return baseline[key];
  };
  return {
    lambdaCost: pick('lambdaCost', isWeight),
    lambdaPressure: pick('lambdaPressure', isWeight),
    lambdaLatency: pick('lambdaLatency', isWeight),
    bonThreshold: pick('bonThreshold', isDifficulty),
  };
}

/** Does `difficulty` reach the best-of-N threshold? */
export function meetsBonThreshold(difficulty: RoutingDifficulty, threshold: RoutingDifficulty): boolean {
  return DIFFICULTY_RANK[difficulty] >= DIFFICULTY_RANK[threshold];
}

export interface StandingBestOfNInput {
  item: Pick<WorkItem, 'effort' | 'source' | 'tags'>;
  /**
   * The route this tick chose for the item (a held route never fans out).
   * `lane` is the lane whose pool slot the item already holds.
   */
  route: Pick<DispatchRoute, 'hold'> & Partial<Pick<DispatchRoute, 'lane'>>;
  lanes: Readonly<Record<FleetEngine, LanePlan>>;
  laneEngines: Readonly<Record<FleetEngine, EngineId | null>>;
  mode: BudgetPolicy['mode'];
  weights: HarnessRoutingWeights;
  /** Earlier failed attempts at this item (fleet task attempts); 0 when unknown. */
  priorFailures: number;
  /** hooks.seatAllows verdicts for the frontier lanes, asked by the caller. */
  grokAllowed: boolean;
  claudeAllowed: boolean;
  /**
   * Review c15: extra lane turns still free for fan-out this tick
   * (`planFanoutReserve`, minus what earlier plans took). Absent = not
   * accounted (pure callers / tests of the plan shape only); the live hooks
   * always pass it.
   */
  fanoutBudget?: Readonly<Record<FleetEngine, number>>;
  cfg?: AshlrConfig;
}

/** A standing best-of-N plan plus the extra lane turns it takes beyond the item's own slot. */
export type StandingBestOfNPlan = AutonomousBestOfNPlan & { laneCharge: Record<FleetEngine, number> };

function zeroLanes(): Record<FleetEngine, number> {
  return Object.fromEntries(FLEET_ENGINES.map((lane) => [lane, 0])) as Record<FleetEngine, number>;
}

/**
 * Review c15: the pool (daemon/loop.ts TieredPool) charges ONE lane slot per
 * item, but a best-of-N item runs every candidate — so without this a hard
 * grok-routed item added two local turns on top of a full local lane (4
 * llama-server turns against Mason's presence cap of 2). The fix is a
 * reserve: beforeTick holds these slots back from the pool's lane caps when a
 * fan-out is plausible this tick, and plans may spend only that reserve. The
 * pool can then never start an item into a turn a fan-out is using.
 *
 * Reserve per lane (0 when no fan-out is plausible): local — up to the 2
 * extra local candidates, always leaving the pool at least one local slot;
 * grok-cli — one frontier candidate when the lane has 2+ slots; Claude and
 * Codex none (a Claude candidate runs only on a Claude-routed item's own
 * slot). Pure.
 */
export function planFanoutReserve(
  lanes: Readonly<Record<FleetEngine, LanePlan>>,
  fanoutPlausible: boolean,
): Record<FleetEngine, number> {
  const reserve = zeroLanes();
  if (!fanoutPlausible) return reserve;
  reserve.local = Math.min(FANOUT_LOCAL_EXTRA_MAX, Math.max(0, lanes.local.slots - 1));
  reserve['grok-cli'] = lanes['grok-cli'].slots >= 2 ? 1 : 0;
  return reserve;
}

/** planAutonomousBestOfN's local candidates per plan (best-of-n-policy.ts LOCAL_CANDIDATES). */
export const FANOUT_LOCAL_EXTRA_MAX = 2;

/**
 * Fit a plan into the lanes: each candidate runs on the item's own slot (one
 * candidate of the routed lane) or on a reserved extra turn; candidates with
 * neither are dropped. Engine diversity is still required after trimming
 * (the policy's own rule) — otherwise the item runs as one attempt. Pure.
 */
export function fitBestOfNToLanes(
  plan: AutonomousBestOfNPlan,
  routeLane: FleetEngine | null,
  budget: Readonly<Record<FleetEngine, number>>,
  cfg?: AshlrConfig,
): StandingBestOfNPlan {
  const laneCharge = zeroLanes();
  if (!plan.run) return { ...plan, laneCharge };
  let ownSlot = routeLane !== null ? 1 : 0;
  const kept: typeof plan.candidates = [];
  for (const candidate of plan.candidates) {
    const lane = fleetLaneOf(candidate.engine, cfg);
    if (lane === null) continue;
    if (lane === routeLane && ownSlot > 0) {
      ownSlot -= 1;
      kept.push(candidate);
    } else if ((budget[lane] ?? 0) - laneCharge[lane] > 0) {
      laneCharge[lane] += 1;
      kept.push(candidate);
    }
  }
  if (new Set(kept.map((c) => c.engine)).size < 2) {
    return { run: false, reason: 'no-engine-diversity', candidates: [], laneCharge: zeroLanes() };
  }
  return { ...plan, candidates: kept, laneCharge };
}

/**
 * The autonomous best-of-N plan for one standing dispatch (U7's
 * `planAutonomousBestOfN`, fed from this tick's lanes). The harness's
 * `bonThreshold` decides which difficulties count as "hard": an item at or
 * above it is planned as high difficulty, one below keeps its own. Only the
 * free local lane (llama-server / local-coder) supplies the paired local
 * candidates; the in-process builtin loop is not a distinct engine for
 * best-of-N's judge to separate.
 */
export function planStandingBestOfN(input: StandingBestOfNInput): StandingBestOfNPlan {
  if (input.route.hold !== null) return { run: false, reason: 'not-needed', candidates: [], laneCharge: zeroLanes() };
  const difficulty = difficultyOf(input.item);
  const planned: RoutingDifficulty = meetsBonThreshold(difficulty, input.weights.bonThreshold) ? 'high' : difficulty;
  const localEngine = input.laneEngines.local;
  // EngineId does not list the llama-server lane engine; compare as strings.
  const localId: string | null = localEngine;
  const localUsable = localEngine !== null && input.lanes.local.slots > 0 && (localId === 'llama-server' || localId === 'local-coder');
  const localModel = localUsable
    ? configuredModel(input.cfg, localEngine!) ?? resolveEngineSpec(localEngine!, input.cfg)?.api?.defaultModel ?? null
    : null;
  const grokEngine = input.laneEngines['grok-cli'];
  const claudeEngine = input.laneEngines['claude-cli'];
  const plan = planAutonomousBestOfN({
    difficulty: planned,
    priorFailures: input.priorFailures,
    mode: input.mode,
    grokEligible: input.grokAllowed && grokEngine !== null && input.lanes['grok-cli'].slots > 0,
    ...(grokEngine !== null && configuredModel(input.cfg, grokEngine) ? { grokModel: configuredModel(input.cfg, grokEngine)! } : {}),
    local: localUsable && localModel
      ? { engine: localId as 'llama-server' | 'local-coder', model: localModel }
      : null,
    claudeEligible: input.claudeAllowed && claudeEngine !== null && input.lanes['claude-cli'].slots > 0,
    ...(claudeEngine !== null && configuredModel(input.cfg, claudeEngine) ? { claudeModel: configuredModel(input.cfg, claudeEngine)! } : {}),
  });
  if (input.fanoutBudget === undefined) return { ...plan, laneCharge: zeroLanes() };
  return fitBestOfNToLanes(plan, input.route.lane ?? null, input.fanoutBudget, input.cfg);
}

/**
 * Could an item in `items` fan out this tick? The same threshold the plan
 * uses: difficulty at or above `bonThreshold`, or an earlier failed attempt.
 * Pure; `attemptsOf` returns 0 when unknown.
 */
export function anyFanoutCandidate(
  items: readonly Pick<WorkItem, 'id' | 'effort' | 'source' | 'tags'>[],
  threshold: RoutingDifficulty,
  attemptsOf: (item: Pick<WorkItem, 'id'>) => number,
): boolean {
  return items.some((item) => meetsBonThreshold(difficultyOf(item), threshold) || attemptsOf(item) > 0);
}
