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
 *   3. Rank. An explicit TIER order per (mode, task, difficulty) — see
 *      `tierPreference` and routing/tiers.ts (elite · fast · free) — then,
 *      inside a tier, more headroom first, then marginal cost (a subscription
 *      turn before a credits turn), then latency, then seat id. There is NO
 *      provider order: Claude, Codex and Devin are the same tier and nothing
 *      but their live numbers separates them (3.15, "equal partners"). The λ
 *      routing weights (`RouterWeights`, from the harness / Leader
 *      `router.tune`) tilt that order — see `seatScore`.
 *
 * Local models are never excluded for quality; the free tier is ranked after
 * the paid tiers where quality matters (high difficulty, leader work), so
 * work still flows when the paid seats are held back for Mason.
 *
 * DEVIN. Mason's own chats may be routed to a Devin seat like any other
 * elite seat. Autonomous (fleet) work never is: the fleet launches Devin
 * only through devin/fleet-launcher.ts under its grant and ACU reserve, and
 * the capacity snapshot refuses a Devin row — see `devinFleetVerdict`.
 */
import { assessSeat, HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from './headroom.js';
import { effectiveSeatPolicy } from './policy.js';
import { listSeatIds, reasonSentences } from './seat-reasons.js';
import { COST_BASIS_RANK, costBasisOf, engineTier, RESOURCE_TIERS, type ResourceTier } from './tiers.js';
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
 *   lambdaCost     — how hard to lean on COST against the mode's
 *                    quality/cost tier order. 1 = the mode's own balance;
 *                    above 1 leans toward cheaper tiers, below 1 toward
 *                    pricier (higher-quality) ones. Inside a tier it also
 *                    scales the marginal-cost term (subscription before
 *                    credits).
 *   lambdaPressure — how much a seat's remaining HEADROOM counts. 1 = the
 *                    deciding key inside one tier; higher lets a much
 *                    emptier seat of a less-preferred tier win; 0 ignores
 *                    headroom.
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
 * pins the two together). At these values `rank` orders seats by tier, then
 * headroom, then marginal cost, then latency.
 */
export const DEFAULT_ROUTER_WEIGHTS: Readonly<RouterWeights> = Object.freeze({
  lambdaCost: 1,
  lambdaPressure: 1,
  lambdaLatency: 0.25,
});

/** How a tier is named inside a `why` sentence. */
const TIER_WORDS: Readonly<Record<ResourceTier, string>> = { elite: 'elite', fast: 'fast', free: 'free' };

/** Best tier first — interactive work and hard autonomous work. */
const QUALITY_FIRST: readonly ResourceTier[] = RESOURCE_TIERS;
/** Cheapest rung first — the cost ladder (free → fast → elite). */
const CHEAP_FIRST: readonly ResourceTier[] = [...RESOURCE_TIERS].reverse();

/** A seat's tier: what its capacity says (per model), else its engine's. */
export function capacityTier(capacity: Pick<SeatCapacity, 'engine' | 'tier'>): ResourceTier {
  return capacity.tier ?? engineTier(capacity.engine);
}

/**
 * A seat's rung on the COST ladder: `free` when a turn costs nothing (every
 * local model — the elite Qwen included — and Devin's plan-included SWE),
 * otherwise its tier. Tier and cost only differ for those free-but-strong
 * seats, which is exactly why they are two axes.
 */
export function costRung(capacity: Pick<SeatCapacity, 'engine' | 'tier' | 'costBasis' | 'free'>): ResourceTier {
  if (capacity.free || (capacity.costBasis ?? costBasisOf(capacity.engine)) === 'free') return 'free';
  return capacityTier(capacity);
}

/** Relative cost step (0 = free). CHEAP_FIRST is exactly the cost ladder, so it doubles as the table. */
function costStep(capacity: SeatCapacity): number {
  return CHEAP_FIRST.indexOf(costRung(capacity));
}

/**
 * The mode's order for one request: over TIERS (quality) or over the COST
 * ladder, never over providers — which seat of a rung wins is decided by
 * headroom, marginal cost and latency (`seatScore`).
 */
export interface RankOrder {
  /** `tier` ranks a seat by what it can do; `cost` by what a turn costs. */
  by: 'tier' | 'cost';
  order: readonly ResourceTier[];
}

/**
 * Low-difficulty and bulk work always goes to the cheapest capable seat
 * first (the cost ladder — so the free elite Qwen and Devin's free SWE lead);
 * quality-first ordering is reserved for work that needs it. Interactive
 * requests are ordered for "what else can I use right now": the elite
 * partners, then fast, then free.
 */
export function tierPreference(mode: BudgetMode, req: RoutingRequest): RankOrder {
  const quality: RankOrder = { by: 'tier', order: QUALITY_FIRST };
  const cheap: RankOrder = { by: 'cost', order: CHEAP_FIRST };
  if (!req.autonomous) return quality;
  const difficulty: RoutingDifficulty = req.task === 'leader' && req.difficulty !== 'high' ? 'high' : req.difficulty;
  if (req.task === 'bulk' || difficulty === 'low') return cheap;
  if (mode === 'reserve') {
    // Free first for everything but genuinely hard work, and even that only
    // reaches the small paid slice the reserve-mode ceilings leave.
    return difficulty === 'high' ? { by: 'tier', order: ['fast', 'elite', 'free'] } : cheap;
  }
  if (difficulty === 'medium') {
    return mode === 'all-in'
      ? { by: 'tier', order: ['fast', 'elite', 'free'] }
      : { by: 'cost', order: ['fast', 'free', 'elite'] };
  }
  return quality;
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
 * is worth half a tier step, so at the default weight it can only order
 * seats of the SAME tier — where it is the deciding key.
 */
const PRESSURE_SCALE = 0.5;

/**
 * Scale of the latency term at λ = 1. Headroom percents are whole numbers
 * (headroom.ts rounds them), so one point of headroom is worth
 * PRESSURE_SCALE / 101 ≈ 0.00495 at λ = 1. At the default λ = 0.25 the whole
 * latency range (0.25 × 0.019 = 0.00475) stays below that, which keeps
 * latency a pure tie-breaker; at λ = 10 it is worth ~38 points of headroom
 * and still never a whole tier step (0.5 + 0.1 + 0.19 < 1).
 */
const LATENCY_SCALE = 0.019;

/** The headroom a windowless seat is ranked with: the middle of the range. */
const WINDOWLESS_HEADROOM = 50;

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
 *   position                                  quality: the mode's TIER order (fixed anchor)
 *   + (λcost − 1)   · costStep                cost:     one tier step per cost step per unit of λ
 *   + λpressure     · PRESSURE_SCALE · p      headroom: p = (100 − left%) / 101, unknown = 1
 *   + λcost         · MARGINAL_COST_SCALE · m marginal: m = 1 for credits / per-token, else 0
 *   + λlatency      · LATENCY_SCALE  · l      latency:  l from `latencyTerms`
 *
 * Why `λcost − 1`: the tier order ALREADY prices cost in for the mode
 * (CHEAP_FIRST is literally the cost ladder), so λcost = 1 must add nothing
 * across tiers. At λcost = 2 a quality-first order flattens (every tier ties
 * and headroom decides); at 0 a cheap-first order does. No term names a
 * provider.
 */
function seatScore(v: Verdict, position: number, w: RouterWeights, latency: number): number {
  // A windowless seat (Devin: ACUs / plan usage, no window) has no reading
  // BY DESIGN — neutral, not the worst. Only interactive work reaches here
  // with one (autonomous Devin is refused before ranking).
  const left = v.headroom?.autonomyHeadroomPercent ?? (v.capacity.windowless ? WINDOWLESS_HEADROOM : -1);
  const pressure = (100 - left) / 101;
  return position
    + (w.lambdaCost - 1) * costStep(v.capacity)
    + w.lambdaPressure * PRESSURE_SCALE * pressure
    + w.lambdaCost * MARGINAL_COST_SCALE * marginalCost(v.capacity)
    + w.lambdaLatency * LATENCY_SCALE * latency;
}

/**
 * Marginal cost of one more turn inside a tier: 0 for a subscription (its
 * window refills) or a free seat, 1 for a seat that spends a balance
 * (credits, ACUs, per-token). Worth a tenth of the headroom range at λ = 1 —
 * about 20 points of headroom — so a metered seat wins only when it has
 * clearly more room than a subscription seat of the same tier.
 */
const MARGINAL_COST_SCALE = 0.1;

function marginalCost(capacity: SeatCapacity): number {
  const basis = capacity.costBasis ?? costBasisOf(capacity.engine);
  return COST_BASIS_RANK[basis];
}

/**
 * Rank eligible verdicts by `seatScore`, then the caller's order (seat
 * discovery lists the operator's preferred local tags first —
 * `preferredLocalTags` in seats.ts — so two free local seats with equal
 * headroom resolve to the one he chose), then id. At the default weights this
 * is a lexicographic order — tier, then headroom / marginal cost / latency —
 * because those terms together stay under one tier step.
 */
function rank(verdicts: Verdict[], rankOrder: RankOrder, w: RouterWeights, latencyMs: RouteOptions['latencyMs']): Verdict[] {
  const position = (capacity: SeatCapacity): number => {
    const rung = rankOrder.by === 'cost' ? costRung(capacity) : capacityTier(capacity);
    const index = rankOrder.order.indexOf(rung);
    return index === -1 ? rankOrder.order.length : index;
  };
  const latency = latencyTerms(verdicts, latencyMs);
  const score = new Map(verdicts.map((v) => [
    v, seatScore(v, position(v.capacity), w, latency.get(v.capacity.seatId) ?? 0),
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
 * 3.15: a Devin seat is never a candidate for AUTONOMOUS work. The fleet
 * launches Devin only through devin/fleet-launcher.ts under its grant and its
 * own ACU reserve; the capacity snapshot refuses a `devin` seat
 * (budget-store.ts sanitizeSeatCapacity), and this is the second lock, so a
 * hand-built capacity list cannot route fleet work to it either. Mason's own
 * (interactive) work routes to Devin like any other elite seat.
 */
function devinFleetVerdict(capacity: SeatCapacity): Verdict {
  const details: SeatReason[] = [{
    kind: 'lane',
    text: 'The fleet runs Devin as its own session lane under the Devin budget, not through the seat router.',
  }];
  return { capacity, index: 0, headroom: null, eligible: false, details, nextEligibleAt: null };
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
    ...(req.autonomous && seat.engine === 'devin'
      ? devinFleetVerdict(seat)
      : applyFit(
        req.autonomous
          ? autonomousVerdict(seat, policy, opts.nowMs, readingMaxAgeMs)
          : interactiveVerdict(seat, opts.nowMs, readingMaxAgeMs),
        req.contextTokens,
      )),
    index,
  }));

  const order = tierPreference(policy.mode, req);
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
    const tier = TIER_WORDS[order.by === 'cost' ? costRung(chosen.capacity) : capacityTier(chosen.capacity)];
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
      + `${policy.mode} mode prefers the ${tier} tier first for this work${tuned}${held}.`;
    const lead = hasRoom
      ? ` — ${room}% of its ${windowWord} window left`
      : chosen.capacity.free ? ' — free, no usage window' : '';
    summary = lead
      ? `${chosen.capacity.label}${lead}; ${policy.mode} mode prefers the ${tier} tier for this work.`
      : `${chosen.capacity.label} — ${policy.mode} mode prefers the ${tier} tier for this work.`;
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
