/**
 * Seat router — `routeSeat(req, capacity, policy): SeatDecision` (V3.10 unit A9).
 *
 * PURE and DETERMINISTIC: same inputs, same decision. No clock reads (pass
 * `nowMs`), no I/O, no model calls. That is what lets the fleet run it in
 * SHADOW mode (Track B) — every would-be dispatch is decided and logged next
 * to what actually ran, and the two can be compared before the router is
 * given any authority.
 *
 * STAGES
 *   1. Eligibility. Autonomous work goes through `assessSeat` (budget policy,
 *      reserves, live windows, "unknown usage is not headroom"). Mason's own
 *      interactive work ignores reserves — they exist FOR him — and is refused
 *      only by what would make a turn fail: signed out, spent, unreachable.
 *   2. Fit. A request whose context estimate exceeds 80% of a seat's window
 *      is not sent there; the router never truncates silently.
 *   3. Rank. An explicit engine order per (mode, task, difficulty) — see
 *      `enginePreference` — then more headroom first, then seat id. An
 *      explicit order is less clever than a weighted score, and that is the
 *      point: every decision has a one-sentence "why" a person can check.
 *
 * Local models are never excluded for quality; they are ranked after the paid
 * seats where quality matters (high difficulty, leader work), so work still
 * flows when the paid seats are held back for Mason.
 */
import { assessSeat, HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from './headroom.js';
import { effectiveSeatPolicy, type BudgetEngine } from './policy.js';
import type {
  BudgetMode,
  BudgetPolicy,
  RoutingDifficulty,
  RoutingRequest,
  SeatDecision,
  SeatExclusion,
  SeatHeadroom,
} from './types.js';

/** A request may use at most this share of a seat's context window. */
export const ROUTER_CONTEXT_FIT_FRACTION = 0.8;

export interface RouteOptions {
  nowMs: number;
  readingMaxAgeMs?: number;
}

const ENGINE_NAMES: Readonly<Record<BudgetEngine, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  local: 'local models',
};

const CHEAP_FIRST: readonly BudgetEngine[] = ['local', 'grok', 'codex', 'claude'];
const QUALITY_FIRST: readonly BudgetEngine[] = ['claude', 'codex', 'grok', 'local'];

/**
 * Engine order for one request. Low-difficulty and bulk work always goes to
 * the cheapest capable seat first; quality-first ordering is reserved for
 * work that needs it. Interactive requests are ordered for "what else can I
 * use right now": other subscription seats, then Grok, then local (the order
 * the account-health research recommends for a blocked seat).
 */
export function enginePreference(mode: BudgetMode, req: RoutingRequest): readonly BudgetEngine[] {
  if (!req.autonomous) return QUALITY_FIRST;
  const difficulty: RoutingDifficulty = req.task === 'leader' && req.difficulty !== 'high' ? 'high' : req.difficulty;
  if (req.task === 'bulk' || difficulty === 'low') return CHEAP_FIRST;
  if (mode === 'reserve') {
    // Free first for everything but genuinely hard work, and even that only
    // reaches the small paid slice the reserve-mode ceilings leave.
    return difficulty === 'high' ? ['grok', 'codex', 'claude', 'local'] : CHEAP_FIRST;
  }
  if (difficulty === 'medium') {
    return mode === 'all-in' ? ['grok', 'codex', 'claude', 'local'] : ['grok', 'local', 'codex', 'claude'];
  }
  return QUALITY_FIRST;
}

interface Verdict {
  capacity: SeatCapacity;
  /** Position in the caller's list — discovery order, which ranks the operator's preferred local tags first. */
  index: number;
  headroom: SeatHeadroom | null;
  eligible: boolean;
  reasons: string[];
  nextEligibleAt: string | null;
}

function interactiveVerdict(capacity: SeatCapacity, nowMs: number, readingMaxAgeMs: number): Verdict {
  const reasons: string[] = [];
  let nextEligibleAt: string | null = null;
  if (capacity.signedOut) reasons.push('Signed out — reconnect this account.');
  if (capacity.reachable === false && !capacity.signedOut) reasons.push('Not reachable right now.');
  // Reuse the autonomy assessment only for the facts it establishes about
  // the ACCOUNT (spent windows and their resets) — never its reserves.
  const facts = assessSeat(capacity, { seatId: capacity.seatId, enabled: true, reservePercent: 0 }, {
    nowMs,
    readingMaxAgeMs,
  });
  if (facts.exhausted) {
    reasons.push(...facts.spentReasons);
    nextEligibleAt = facts.reopensAt;
  }
  return { capacity, index: 0, headroom: facts.headroom, eligible: reasons.length === 0, reasons, nextEligibleAt };
}

function autonomousVerdict(capacity: SeatCapacity, policy: BudgetPolicy, nowMs: number, readingMaxAgeMs: number): Verdict {
  const seatPolicy = effectiveSeatPolicy(policy, capacity.seatId, capacity.engine);
  const assessed = assessSeat(capacity, seatPolicy, { nowMs, readingMaxAgeMs });
  return {
    capacity,
    index: 0,
    headroom: assessed.headroom,
    eligible: assessed.headroom.eligibleForAutonomy,
    // Blocked seats report the blockers; the "N% left" line is for eligible ones.
    reasons: assessed.headroom.eligibleForAutonomy ? [] : assessed.headroom.reasons,
    nextEligibleAt: assessed.headroom.eligibleForAutonomy ? null : assessed.reopensAt,
  };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function applyFit(verdict: Verdict, contextTokens: number | undefined): Verdict {
  if (contextTokens === undefined || !Number.isFinite(contextTokens) || contextTokens <= 0) return verdict;
  const window = verdict.capacity.contextWindow;
  if (window === null) return verdict;
  if (contextTokens <= window * ROUTER_CONTEXT_FIT_FRACTION) return verdict;
  return {
    ...verdict,
    eligible: false,
    reasons: [...verdict.reasons, `Needs about ${formatTokens(contextTokens)} tokens of context; this seat's window is `
      + `${formatTokens(window)} (at most ${Math.round(ROUTER_CONTEXT_FIT_FRACTION * 100)}% is used for a task).`],
    // A window does not grow back on a schedule.
    nextEligibleAt: null,
  };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rank eligible verdicts: engine order, then more headroom, then the caller's
 * order (seat discovery lists the operator's preferred local tags first —
 * `preferredLocalTags` in seats.ts — so two free local seats with equal
 * headroom resolve to the one he chose), then id.
 */
function rank(verdicts: Verdict[], order: readonly BudgetEngine[]): Verdict[] {
  const position = (engine: BudgetEngine): number => {
    const index = order.indexOf(engine);
    return index === -1 ? order.length : index;
  };
  return [...verdicts].sort((a, b) => {
    const byEngine = position(a.capacity.engine) - position(b.capacity.engine);
    if (byEngine !== 0) return byEngine;
    const ha = a.headroom?.autonomyHeadroomPercent ?? -1;
    const hb = b.headroom?.autonomyHeadroomPercent ?? -1;
    if (ha !== hb) return hb - ha;
    if (a.index !== b.index) return a.index - b.index;
    return compareIds(a.capacity.seatId, b.capacity.seatId);
  });
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function describeWork(req: RoutingRequest): string {
  return `${req.difficulty}-difficulty ${req.task} work`;
}

function describeExclusion(exclusion: SeatExclusion): string {
  const first = exclusion.reasons[0] ?? 'not eligible';
  return `${exclusion.seatId}: ${lowerFirst(first).replace(/\.$/, '')}`;
}

/**
 * Decide which seat `req` should use. Pure. Every seat in `capacity` ends up
 * in exactly one of `candidates` or `exclusions`.
 */
export function routeSeat(
  req: RoutingRequest,
  capacity: readonly SeatCapacity[],
  policy: BudgetPolicy,
  opts: RouteOptions,
): SeatDecision {
  const readingMaxAgeMs = opts.readingMaxAgeMs ?? HEADROOM_READING_MAX_AGE_MS;
  const verdicts = capacity.map((seat, index) => ({
    ...applyFit(
      req.autonomous
        ? autonomousVerdict(seat, policy, opts.nowMs, readingMaxAgeMs)
        : interactiveVerdict(seat, opts.nowMs, readingMaxAgeMs),
      req.contextTokens,
    ),
    index,
  }));

  const order = enginePreference(policy.mode, req);
  const eligible = rank(verdicts.filter((v) => v.eligible), order);
  const exclusions: SeatExclusion[] = verdicts
    .filter((v) => !v.eligible)
    .map((v) => ({ seatId: v.capacity.seatId, reasons: v.reasons, nextEligibleAt: v.nextEligibleAt }))
    .sort((a, b) => compareIds(a.seatId, b.seatId));

  const chosen = eligible[0] ?? null;
  const candidates = eligible.map((v) => v.capacity.seatId);
  const who = req.autonomous ? 'autonomous ' : '';

  let why: string;
  if (chosen) {
    const engine = ENGINE_NAMES[chosen.capacity.engine];
    const room = chosen.headroom?.autonomyHeadroomPercent;
    const roomText = req.autonomous && !chosen.capacity.free && typeof room === 'number'
      ? ` with ${room}% of its ${chosen.headroom?.bindingWindow === 'session' ? '5-hour' : 'weekly'} window left for autonomy`
      : chosen.capacity.free ? ' at no cost' : '';
    const held = exclusions.length === 0 ? ''
      : `; held back ${exclusions.length === 1 ? '1 seat' : `${exclusions.length} seats`} (${exclusions.slice(0, 2).map(describeExclusion).join('; ')}${exclusions.length > 2 ? '; …' : ''})`;
    why = `Routed ${who}${describeWork(req)} to ${chosen.capacity.label} (${chosen.capacity.seatId})${roomText}: `
      + `${policy.mode} mode prefers ${engine} first for this work${held}.`;
  } else if (capacity.length === 0) {
    why = `No seats are known, so ${who}${describeWork(req)} has nowhere to run.`;
  } else {
    const reopen = exclusions.flatMap((e) => (e.nextEligibleAt ? [e.nextEligibleAt] : []))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
    why = `No seat can take ${who}${describeWork(req)} in ${policy.mode} mode (${exclusions.slice(0, 3).map(describeExclusion).join('; ')}`
      + `${exclusions.length > 3 ? '; …' : ''})${reopen ? `; the earliest known reopening is ${reopen}` : ''}.`;
  }

  return {
    seatId: chosen?.capacity.seatId ?? null,
    candidates,
    exclusions,
    why,
    mode: policy.mode,
  };
}

/**
 * Ranked seats Mason could use INSTEAD of `blockedSeatId` for his own work
 * right now (reserves do not apply to him). For the readiness gate's
 * `SeatReadiness.alternatives`.
 */
export function rankAlternatives(
  blockedSeatId: string,
  capacity: readonly SeatCapacity[],
  policy: BudgetPolicy,
  opts: RouteOptions,
): string[] {
  const blocked = capacity.find((c) => c.seatId === blockedSeatId);
  const decision = routeSeat(
    { task: 'code', difficulty: 'medium', autonomous: false },
    capacity.filter((c) => c.seatId !== blockedSeatId),
    policy,
    opts,
  );
  if (!blocked) return decision.candidates;
  // Same engine first (a second account of the same provider is the least
  // surprising substitute), then the router's own order.
  const sameEngine = new Set(capacity.filter((c) => c.engine === blocked.engine).map((c) => c.seatId));
  return [
    ...decision.candidates.filter((id) => sameEngine.has(id)),
    ...decision.candidates.filter((id) => !sameEngine.has(id)),
  ];
}
