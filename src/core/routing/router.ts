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
 *      The λ routing weights (`RouterWeights`, from the harness / Leader
 *      `router.tune`) tilt that order — see `seatScore` — and at their
 *      defaults they reproduce it exactly.
 *
 * Local models are never excluded for quality; they are ranked after the paid
 * seats where quality matters (high difficulty, leader work), so work still
 * flows when the paid seats are held back for Mason.
 */
import { assessSeat, HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from './headroom.js';
import { effectiveSeatPolicy, type BudgetEngine } from './policy.js';
import { listSeatIds, reasonSentences } from './seat-reasons.js';
import type {
  BudgetMode,
  BudgetPolicy,
  RoutingDifficulty,
  RoutingRequest,
  SeatDecision,
  SeatExclusion,
  SeatHeadroom,
  SeatReason,
} from './types.js';

/** A request may use at most this share of a seat's context window. */
export const ROUTER_CONTEXT_FIT_FRACTION = 0.8;

export interface RouteOptions {
  nowMs: number;
  readingMaxAgeMs?: number;
  /** The λ objective weights; absent = `DEFAULT_ROUTER_WEIGHTS` (today's explicit order). */
  weights?: Partial<RouterWeights>;
  /**
   * Observed turn latency per seat id, in ms (e.g. a recent median). Only
   * `lambdaLatency` reads it; a seat absent here is scored neutral. Absent =
   * no latency evidence, so latency cannot move anything.
   */
  latencyMs?: Readonly<Record<string, number>>;
}

/**
 * The router's λ objective weights — the same three numbers as
 * learn/harness-types.ts `HarnessRoutingWeights` (restated structurally so
 * this browser-safe module does not import the harness). Each λ is ≥ 0.
 *
 *   lambdaCost     — how hard to lean on engine COST against the mode's
 *                    quality/cost order. 1 = the mode's own balance; above 1
 *                    leans toward cheaper engines, below 1 toward pricier
 *                    (higher-quality) ones.
 *   lambdaPressure — how much a seat's remaining HEADROOM counts. 1 = a
 *                    tie-breaker inside one engine (today); higher lets a
 *                    much emptier seat of a less-preferred engine win; 0
 *                    ignores headroom.
 *   lambdaLatency  — how much observed LATENCY (`RouteOptions.latencyMs`)
 *                    counts. At the default 0.25 it only separates seats
 *                    whose headroom is equal.
 */
export interface RouterWeights {
  lambdaCost: number;
  lambdaPressure: number;
  lambdaLatency: number;
}

/**
 * Defaults = the compiled baseline (`BASELINE_HARNESS_CONFIG.routing`; a test
 * pins the two together). At these values `rank` orders seats exactly as the
 * pre-λ router did.
 */
export const DEFAULT_ROUTER_WEIGHTS: Readonly<RouterWeights> = Object.freeze({
  lambdaCost: 1,
  lambdaPressure: 1,
  lambdaLatency: 0.25,
});

const ENGINE_NAMES: Readonly<Record<BudgetEngine, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  local: 'local models',
};

const CHEAP_FIRST: readonly BudgetEngine[] = ['local', 'grok', 'codex', 'claude'];
const QUALITY_FIRST: readonly BudgetEngine[] = ['claude', 'codex', 'grok', 'local'];

/**
 * Relative cost step per engine (0 = free). CHEAP_FIRST is exactly the cost
 * ladder, so it doubles as the table — one fact, not two.
 */
function costStep(engine: BudgetEngine): number {
  return CHEAP_FIRST.indexOf(engine);
}

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
  /** The blockers as data; `SeatExclusion.reasons` is derived from them. */
  details: SeatReason[];
  nextEligibleAt: string | null;
}

function interactiveVerdict(capacity: SeatCapacity, nowMs: number, readingMaxAgeMs: number): Verdict {
  const details: SeatReason[] = [];
  let nextEligibleAt: string | null = null;
  if (capacity.signedOut) details.push({ kind: 'signed-out', text: 'Signed out — reconnect this account.' });
  if (capacity.reachable === false && !capacity.signedOut) details.push({ kind: 'unreachable', text: 'Not reachable right now.' });
  // Reuse the autonomy assessment only for the facts it establishes about
  // the ACCOUNT (spent windows and their resets) — never its reserves.
  const facts = assessSeat(capacity, { seatId: capacity.seatId, enabled: true, reservePercent: 0 }, {
    nowMs,
    readingMaxAgeMs,
  });
  if (facts.exhausted) {
    details.push(...facts.spentDetails);
    nextEligibleAt = facts.reopensAt;
  }
  return { capacity, index: 0, headroom: facts.headroom, eligible: details.length === 0, details, nextEligibleAt };
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
    details: assessed.headroom.eligibleForAutonomy ? [] : assessed.details,
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
    details: [...verdict.details, {
      kind: 'context',
      text: `Needs about ${formatTokens(contextTokens)} tokens of context; this seat's window is `
        + `${formatTokens(window)} (at most ${Math.round(ROUTER_CONTEXT_FIT_FRACTION * 100)}% is used for a task).`,
    }],
    // A window does not grow back on a schedule.
    nextEligibleAt: null,
  };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Scale of the headroom term at λ = 1: its whole range (100% left vs unknown)
 * is worth half an engine step, so at the default weight it can only order
 * seats of the SAME engine — exactly the old "then more headroom" key.
 */
const PRESSURE_SCALE = 0.5;

/**
 * Scale of the latency term at λ = 1. Headroom percents are whole numbers
 * (headroom.ts rounds them), so one point of headroom is worth
 * PRESSURE_SCALE / 101 ≈ 0.00495 at λ = 1. At the default λ = 0.25 the whole
 * latency range (0.25 × 0.019 = 0.00475) stays below that, which keeps
 * latency a pure tie-breaker; at λ = 10 it is worth ~38 points of headroom
 * and still never a whole engine step (0.5 + 0.19 < 1).
 */
const LATENCY_SCALE = 0.019;

/** Scores closer than this are a tie (they fall through to caller order, then id). */
const SCORE_EPSILON = 1e-9;

/**
 * The largest λ the router honours — the harness registry's own bound
 * (HARNESS_CONFIG_BOUNDS.lambdaMax; a test pins the two together, restated so
 * this browser-safe module does not import the harness). A larger value is
 * clamped here, so every score stays finite: an unbounded λ could overflow to
 * Infinity, and Infinity − Infinity = NaN would make the comparator
 * inconsistent (the sort order would then depend on the engine's algorithm).
 */
export const ROUTER_LAMBDA_MAX = 10;

function resolveWeights(weights: Partial<RouterWeights> | undefined): RouterWeights {
  // A malformed λ (NaN, ±Infinity, negative, not a number) falls back to its
  // default rather than poisoning the ranking; an over-large one is clamped
  // to ROUTER_LAMBDA_MAX (it keeps its direction, bounded).
  const pick = (key: keyof RouterWeights): number => {
    const v = weights?.[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, ROUTER_LAMBDA_MAX) : DEFAULT_ROUTER_WEIGHTS[key];
  };
  return { lambdaCost: pick('lambdaCost'), lambdaPressure: pick('lambdaPressure'), lambdaLatency: pick('lambdaLatency') };
}

function isDefaultWeights(w: RouterWeights): boolean {
  return w.lambdaCost === DEFAULT_ROUTER_WEIGHTS.lambdaCost
    && w.lambdaPressure === DEFAULT_ROUTER_WEIGHTS.lambdaPressure
    && w.lambdaLatency === DEFAULT_ROUTER_WEIGHTS.lambdaLatency;
}

/**
 * Latency per seat normalised to [0, 1] across the seats with evidence
 * (fastest 0, slowest 1). A seat without evidence gets 0.5: unknown latency
 * is neither rewarded nor punished. No evidence anywhere = all 0.
 */
function latencyTerms(verdicts: readonly Verdict[], latencyMs: RouteOptions['latencyMs']): Map<string, number> {
  const out = new Map<string, number>();
  const known = verdicts.flatMap((v) => {
    const ms = latencyMs?.[v.capacity.seatId];
    return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? [ms] : [];
  });
  if (known.length === 0) return out;
  const min = Math.min(...known);
  const span = Math.max(...known) - min;
  for (const v of verdicts) {
    const ms = latencyMs?.[v.capacity.seatId];
    const has = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;
    out.set(v.capacity.seatId, !has ? 0.5 : span === 0 ? 0 : (ms - min) / span);
  }
  return out;
}

/**
 * The λ objective for one seat — LOWER is better:
 *
 *   position                              quality: the mode's engine order (fixed anchor)
 *   + (λcost − 1)   · costStep            cost:    one engine step per cost step per unit of λ
 *   + λpressure     · PRESSURE_SCALE · p  headroom: p = (100 − left%) / 101, unknown = 1
 *   + λlatency      · LATENCY_SCALE  · l  latency: l from `latencyTerms`
 *
 * Why `λcost − 1`: the engine order ALREADY prices cost in for the mode
 * (CHEAP_FIRST is literally the cost ladder), so λcost = 1 must add nothing —
 * the harness baseline documents "λ = 1 for cost and pressure keeps the A9
 * router's own ordering". At λcost = 2 a quality-first order flattens (every
 * engine ties and headroom decides); at 0 a cheap-first order does.
 */
function seatScore(v: Verdict, position: number, w: RouterWeights, latency: number): number {
  const left = v.headroom?.autonomyHeadroomPercent ?? -1;
  const pressure = (100 - left) / 101;
  return position
    + (w.lambdaCost - 1) * costStep(v.capacity.engine)
    + w.lambdaPressure * PRESSURE_SCALE * pressure
    + w.lambdaLatency * LATENCY_SCALE * latency;
}

/**
 * Rank eligible verdicts by `seatScore`, then the caller's order (seat
 * discovery lists the operator's preferred local tags first —
 * `preferredLocalTags` in seats.ts — so two free local seats with equal
 * headroom resolve to the one he chose), then id. At the default weights this
 * is the old lexicographic order — engine, then more headroom — because the
 * headroom and latency terms together stay under one engine step.
 */
function rank(verdicts: Verdict[], order: readonly BudgetEngine[], w: RouterWeights, latencyMs: RouteOptions['latencyMs']): Verdict[] {
  const position = (engine: BudgetEngine): number => {
    const index = order.indexOf(engine);
    return index === -1 ? order.length : index;
  };
  const latency = latencyTerms(verdicts, latencyMs);
  const score = new Map(verdicts.map((v) => [
    v, seatScore(v, position(v.capacity.engine), w, latency.get(v.capacity.seatId) ?? 0),
  ]));
  return [...verdicts].sort((a, b) => {
    const diff = score.get(a)! - score.get(b)!;
    if (Math.abs(diff) > SCORE_EPSILON) return diff;
    if (a.index !== b.index) return a.index - b.index;
    return compareIds(a.capacity.seatId, b.capacity.seatId);
  });
}

function formatWeight(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function describeWork(req: RoutingRequest): string {
  return `${req.difficulty}-difficulty ${req.task} work`;
}

/**
 * "codex-cmp: autonomy is switched off for this seat" — the FIRST reason, as
 * text without its reset clause, so a list of these never nests parentheses.
 */
export function describeExclusion(exclusion: SeatExclusion): string {
  const first = exclusion.details?.[0]?.text ?? exclusion.reasons[0] ?? 'not eligible';
  return `${exclusion.seatId}: ${lowerFirst(first).replace(/\.$/, '')}`;
}

/** Up to `max` exclusions described, then "and N more" — never a bare "…". */
export function describeExclusions(exclusions: readonly SeatExclusion[], max = 3): string {
  const shown = exclusions.slice(0, max).map(describeExclusion).join('; ');
  return exclusions.length > max ? `${shown}; and ${exclusions.length - max} more` : shown;
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
  const weights = resolveWeights(opts.weights);
  const eligible = rank(verdicts.filter((v) => v.eligible), order, weights, opts.latencyMs);
  const exclusions: SeatExclusion[] = verdicts
    .filter((v) => !v.eligible)
    .map((v) => ({
      seatId: v.capacity.seatId,
      reasons: reasonSentences(v.details),
      nextEligibleAt: v.nextEligibleAt,
      details: v.details,
    }))
    .sort((a, b) => compareIds(a.seatId, b.seatId));

  const chosen = eligible[0] ?? null;
  const candidates = eligible.map((v) => v.capacity.seatId);
  const who = req.autonomous ? 'autonomous ' : '';

  // `why` is the full sentence the logs and the CLI print; `summary` is the
  // short headline a UI shows above its own per-seat list. Neither repeats
  // the per-seat reasons — `exclusions` carries those as data.
  let why: string;
  let summary: string;
  if (chosen) {
    const engine = ENGINE_NAMES[chosen.capacity.engine];
    const room = chosen.headroom?.autonomyHeadroomPercent;
    const windowWord = chosen.headroom?.bindingWindow === 'session' ? '5-hour' : 'weekly';
    const hasRoom = req.autonomous && !chosen.capacity.free && typeof room === 'number';
    const roomText = hasRoom
      ? ` with ${room}% of its ${windowWord} window left for autonomy`
      : chosen.capacity.free ? ' at no cost' : '';
    const held = exclusions.length === 0 ? ''
      : `; held back ${exclusions.length === 1 ? '1 seat' : `${exclusions.length} seats`} (${listSeatIds(exclusions.map((e) => e.seatId))})`;
    // Tuned weights can put a seat ahead of the mode's own order, so the
    // sentence names them; at the defaults it stays byte-identical.
    const tuned = isDefaultWeights(weights) ? ''
      : `; routing weights cost ×${formatWeight(weights.lambdaCost)}, headroom ×${formatWeight(weights.lambdaPressure)}, `
        + `latency ×${formatWeight(weights.lambdaLatency)}`;
    why = `Routed ${who}${describeWork(req)} to ${chosen.capacity.label} (${chosen.capacity.seatId})${roomText}: `
      + `${policy.mode} mode prefers ${engine} first for this work${tuned}${held}.`;
    const lead = hasRoom
      ? ` — ${room}% of its ${windowWord} window left`
      : chosen.capacity.free ? ' — free, no usage window' : '';
    summary = lead
      ? `${chosen.capacity.label}${lead}; ${policy.mode} mode prefers ${engine} for this work.`
      : `${chosen.capacity.label} — ${policy.mode} mode prefers ${engine} for this work.`;
  } else if (capacity.length === 0) {
    why = `No seats are known, so ${who}${describeWork(req)} has nowhere to run.`;
    summary = 'No seats are known, so this work has nowhere to run.';
  } else {
    const reopen = exclusions.flatMap((e) => (e.nextEligibleAt ? [e.nextEligibleAt] : []))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
    why = `No seat can take ${who}${describeWork(req)} in ${policy.mode} mode (${describeExclusions(exclusions)})`
      + `${reopen ? `; the earliest known reopening is ${reopen}` : ''}.`;
    summary = `No seat can take this ${describeWork(req)} in ${policy.mode} mode right now.`;
  }

  return {
    seatId: chosen?.capacity.seatId ?? null,
    candidates,
    exclusions,
    why,
    summary,
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
