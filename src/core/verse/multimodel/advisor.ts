/**
 * The Auto seat — which seat should THIS message go to, and why, in one line.
 *
 * NOT A NEW ROUTER. It asks the seat router (routing/router.ts `routeSeat`)
 * the question the router already answers for Mason's own work
 * (`autonomous: false`: fleet reserves do not bind him, only a signed-out,
 * spent or unreachable seat is refused, and a request that would not fit a
 * seat's window is never sent there). What it adds is the INPUT the router
 * needs and the explanation a person reads:
 *
 *   1. Task + difficulty from classify.ts (or the decision layer, once per send).
 *   2. The router's own λ weights, set per message: a quick question leans on
 *      cost (λcost 3 → local and Grok first), hard work keeps the quality order
 *      (λcost 1). Cheap-first mode leans harder (λcost 4) and only hard work
 *      keeps quality. Latency comes from fleet ROI (M322 avgLatencyMs).
 *   3. Bounded re-ranking of the router's eligible list by:
 *        - stickiness: mid-conversation, the current seat gets a head start —
 *          moving re-sends the context and loses the provider’s prompt cache (a weak head start for hard work and in cheap-first);
 *        - what Mason taught it (learning.ts; at most ±1.5 positions);
 *        - fleet ship rate per engine for code work (M335; at most ±0.75);
 *        - a local model that cannot use tools is last for edit work.
 *      None of these can make an ineligible seat eligible.
 *   4. Privacy: a local-only repo is routed over LOCAL seats only — the
 *      filter runs before the router sees anything.
 *
 * PURE and deterministic (callers pass `nowMs`). BROWSER-SAFE: the composer
 * runs it per pause in typing over the seat list it already polls.
 */
import { assessSeat, type SeatCapacity } from '../../routing/headroom.js';
import type { BudgetEngine } from '../../routing/policy.js';
import { DEFAULT_ROUTER_WEIGHTS, routeSeat, type RouterWeights } from '../../routing/router.js';
import type { BudgetPolicy, SeatDecision } from '../../routing/types.js';
import { learnedTilt } from './learning.js';
import type {
  AutoMode,
  EngineRoi,
  LearnedTable,
  PromptClassification,
  PromptKind,
  SeatAdvice,
  SeatAdviceOption,
} from './types.js';

/** Engines the seat router ranks. Devin and the cloud lane are asynchronous agents, not chat seats: never auto-picked. */
export const ROUTABLE_ENGINES: readonly BudgetEngine[] = ['claude', 'codex', 'grok', 'local'];

/**
 * Mid-conversation head start for the current seat, in ranking positions.
 * Moving re-sends the context as a note and drops the provider's prompt
 * cache, so ordinary work stays put (STICKINESS covers the whole engine
 * ladder at the low-difficulty cost weight). It is small where moving is
 * the point: hard work on a weaker seat, and cheap-first, whose purpose is to
 * come back down to the free seat once the hard turn is done.
 */
export const STICKINESS = 3.5;
export const STICKINESS_WEAK = 1.25;
/** Bound on the fleet-ROI tilt, in ranking positions. */
export const ROI_MAX_TILT = 0.75;
/** Fleet evidence below this many dispatches per engine is ignored. */
export const ROI_MIN_DISPATCHES = 10;
/** Where a tool-less local model lands for edit work: behind everything. */
const NO_TOOLS_PENALTY = 3;

const EDIT_KINDS: ReadonlySet<PromptKind> = new Set(['code', 'debug', 'refactor', 'bulk']);
const ROI_KINDS: ReadonlySet<PromptKind> = new Set(['code', 'debug', 'refactor', 'bulk', 'review']);

export interface AdvisorSeat {
  seatId: string;
  engine: string;
  label: string;
  /** The model a new chat on this seat would use (first runnable); null = none runnable. */
  model: string | null;
  /** Runs on this Mac (a local runtime seat). */
  local: boolean;
  /** Local AND its endpoint is loopback — nothing leaves the machine. */
  private: boolean;
  /** Can drive an agentic session; null = the runtime did not say (not "no"). */
  supportsTools: boolean | null;
  capacity: SeatCapacity;
}

export interface AdviseInput {
  classification: PromptClassification;
  seats: readonly AdvisorSeat[];
  policy: BudgetPolicy;
  mode: AutoMode;
  nowMs: number;
  /** The chat's seat, when there is a chat. */
  currentSeatId?: string | null;
  /** Turns the chat already has; stickiness applies only mid-conversation. */
  turnCount?: number;
  /** What the chat already holds — the router refuses seats it would not fit. */
  contextTokens?: number | null;
  localOnly?: { on: boolean; reason: string | null } | null;
  learned?: LearnedTable | null;
  roi?: Readonly<Record<string, EngineRoi>> | null;
  /** The operator's override: honoured whenever that seat is eligible. */
  pinnedSeatId?: string | null;
}

/**
 * The λ weights for one message. Only `lambdaCost` moves; pressure and
 * latency keep the router's defaults so headroom stays a tie-breaker inside
 * an engine and latency a tie-breaker inside that.
 */
export function weightsFor(classification: PromptClassification, mode: AutoMode): RouterWeights {
  const hard = classification.difficulty === 'high' || (classification.needsFrontier ?? 0) >= 0.7;
  let lambdaCost: number;
  if (mode === 'cheap-first') lambdaCost = hard ? 1 : 4;
  else lambdaCost = hard ? 1 : classification.difficulty === 'low' ? 3 : 1.5;
  return { ...DEFAULT_ROUTER_WEIGHTS, lambdaCost };
}

function roiTilt(roi: AdviseInput['roi'], engine: string, kind: PromptKind): number {
  if (!roi || !ROI_KINDS.has(kind)) return 0;
  const rows = Object.values(roi).filter((r) => r.dispatches >= ROI_MIN_DISPATCHES && r.shipRate !== null);
  const mine = roi[engine];
  if (!mine || mine.dispatches < ROI_MIN_DISPATCHES || mine.shipRate === null || rows.length < 2) return 0;
  const mean = rows.reduce((sum, r) => sum + (r.shipRate ?? 0), 0) / rows.length;
  return -Math.max(-ROI_MAX_TILT, Math.min(ROI_MAX_TILT, (mine.shipRate - mean) * 2));
}

function latencyFromRoi(seats: readonly AdvisorSeat[], roi: AdviseInput['roi']): Record<string, number> | undefined {
  if (!roi) return undefined;
  const out: Record<string, number> = {};
  for (const seat of seats) {
    const ms = roi[seat.engine]?.avgLatencyMs;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) out[seat.seatId] = ms;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function windowWord(binding: 'session' | 'weekly' | null): string {
  return binding === 'session' ? '5-hour' : 'weekly';
}

/** "free · private on this Mac" / "62% of its 5-hour window left" / "no usage reading". */
export function seatNote(seat: AdvisorSeat, nowMs: number): string {
  if (seat.local) return seat.private ? 'free · private on this Mac' : 'free · local runtime';
  const assessed = assessSeat(seat.capacity, { seatId: seat.seatId, enabled: true, reservePercent: 0 }, { nowMs });
  const left = assessed.headroom.autonomyHeadroomPercent;
  if (assessed.exhausted) return 'usage spent';
  if (typeof left !== 'number') return 'no usage reading';
  return `${Math.max(0, left)}% of its ${windowWord(assessed.headroom.bindingWindow)} window left`;
}

function option(seat: AdvisorSeat, nowMs: number): SeatAdviceOption {
  return { seatId: seat.seatId, label: seat.label, engine: seat.engine, model: seat.model, local: seat.local, note: seatNote(seat, nowMs) };
}

interface Ranked {
  seat: AdvisorSeat;
  base: number;
  learned: ReturnType<typeof learnedTilt>;
  roi: number;
  sticky: number;
  tools: number;
}

function total(r: Ranked, withLearned = true, withSticky = true): number {
  return r.base + (withLearned ? r.learned.tilt : 0) + r.roi + (withSticky ? r.sticky : 0) + r.tools;
}

function order(rows: Ranked[], withLearned = true, withSticky = true): Ranked[] {
  // Stable: equal totals keep the router's order.
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (total(a.r, withLearned, withSticky) - total(b.r, withLearned, withSticky)) || a.i - b.i).map((x) => x.r);
}

function clip(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Which seat this message should go to. Never throws; `choice: null` says why nothing can. */
export function adviseSeat(input: AdviseInput): SeatAdvice {
  const { classification: cls, mode, nowMs } = input;
  const localOnly = { on: input.localOnly?.on === true, reason: input.localOnly?.reason ?? null };
  const known = input.seats.filter((s) => (ROUTABLE_ENGINES as readonly string[]).includes(s.engine) && s.model !== null);
  const pool = localOnly.on ? known.filter((s) => s.local && s.private) : known;
  const byId = new Map(pool.map((s) => [s.seatId, s]));
  const factors: string[] = [];
  if (localOnly.on) factors.push(`This repo is local-only${localOnly.reason ? ` — ${localOnly.reason.replace(/\.$/, '')}` : ''}.`);
  factors.push(`Read as ${cls.label}${cls.decidedBy === 'jev' ? ` (labelled by Jev, ${Math.round((cls.confidence ?? 0) * 100)}% sure)` : ''}${cls.signals.length > 0 ? `: ${cls.signals.slice(0, 3).join(', ')}` : ''}.`);

  const weights = weightsFor(cls, mode);
  const context = Math.max(0, input.contextTokens ?? 0) + cls.estTokens;
  const latencyMs = latencyFromRoi(pool, input.roi);
  const decision: SeatDecision = routeSeat(
    { task: cls.task, difficulty: (cls.needsFrontier ?? 0) >= 0.7 && cls.difficulty !== 'high' ? 'high' : cls.difficulty, contextTokens: context, autonomous: false },
    pool.map((s) => s.capacity),
    input.policy,
    { nowMs, weights, ...(latencyMs ? { latencyMs } : {}) },
  );

  const held = decision.exclusions.map((e) => ({
    seatId: e.seatId,
    label: byId.get(e.seatId)?.label ?? e.seatId,
    reason: (e.details?.[0]?.text ?? e.reasons[0] ?? 'Not available right now.').replace(/\s+$/, ''),
  }));

  const midChat = (input.turnCount ?? 0) > 0 && typeof input.currentSeatId === 'string';
  const hard = cls.difficulty === 'high' || (cls.needsFrontier ?? 0) >= 0.7;
  const stickiness = mode === 'cheap-first' || hard ? STICKINESS_WEAK : STICKINESS;
  const rows: Ranked[] = decision.candidates.flatMap((id, index) => {
    const seat = byId.get(id);
    if (!seat) return [];
    return [{
      seat,
      base: index,
      learned: learnedTilt(input.learned, cls.kind, seat),
      roi: roiTilt(input.roi, seat.engine, cls.kind),
      sticky: midChat && id === input.currentSeatId ? -stickiness : 0,
      tools: seat.local && seat.supportsTools === false && EDIT_KINDS.has(cls.kind) ? NO_TOOLS_PENALTY : 0,
    }];
  });

  const empty = (why: string): SeatAdvice => ({
    choice: null, stay: false, why, factors, alternatives: [], held, classification: cls, mode, localOnly, routerWhy: decision.why,
  });
  if (rows.length === 0) {
    if (localOnly.on && pool.length === 0) {
      return empty('This repo is local-only and no local model is running — start Ollama or LM Studio, or pick a seat yourself.');
    }
    return empty(clip(decision.summary ?? decision.why));
  }

  const ranked = order(rows);
  const pinned = input.pinnedSeatId ? ranked.find((r) => r.seat.seatId === input.pinnedSeatId) ?? null : null;
  const winner = pinned ?? ranked[0]!;
  const seat = winner.seat;
  const stay = typeof input.currentSeatId === 'string' && seat.seatId === input.currentSeatId;

  // The ONE reason that decided it — the most specific that actually moved the result.
  const withoutLearned = order(rows, false)[0]!.seat.seatId;
  const withoutSticky = order(rows, true, false)[0]!.seat.seatId;
  const toollessId = order(rows.map((r) => ({ ...r, tools: 0 })))[0]!.seat.seatId;
  const toolless = rows.find((r) => r.seat.seatId === toollessId)!;
  let reason: string;
  if (pinned) {
    reason = 'you pinned this seat';
  } else if (localOnly.on) {
    reason = `${cls.label} on a local-only repo — stays on this Mac`;
  } else if (stay && midChat && withoutSticky !== seat.seatId) {
    reason = `${cls.label}, mid-conversation — moving would re-send the whole context`;
  } else if (winner.learned.phrase && withoutLearned !== seat.seatId) {
    reason = `${cls.label}; ${winner.learned.phrase}`;
  } else if (toolless.seat.seatId !== seat.seatId && toolless.tools > 0) {
    reason = `${cls.label} edits files, and ${toolless.seat.label} cannot use tools`;
  } else if (seat.local) {
    reason = mode === 'cheap-first' ? `${cls.label} — local drafts first, escalates only if the draft is weak` : `${cls.label} — free and private on this Mac`;
  } else if (cls.difficulty === 'high' || (cls.needsFrontier ?? 0) >= 0.7) {
    reason = `${cls.label} needs the strongest model`;
  } else {
    reason = cls.label;
  }
  const note = seat.local ? '' : `; ${seatNote(seat, nowMs)}`;
  const why = clip(`${stay ? `Staying on ${seat.label}` : seat.label} — ${reason}${note}.`);

  factors.push(`Router (${decision.mode} mode, interactive — fleet reserves do not apply to you): ${decision.summary ?? decision.why}`);
  if (weights.lambdaCost !== DEFAULT_ROUTER_WEIGHTS.lambdaCost) {
    factors.push(`Cost weight ×${weights.lambdaCost} for ${cls.difficulty}-difficulty work${mode === 'cheap-first' ? ' in cheap-first mode' : ''}.`);
  }
  if (winner.learned.phrase) factors.push(`Learned: ${winner.learned.phrase}.`);
  if (winner.roi !== 0) factors.push(`Fleet record: ${seat.engine} ships ${winner.roi < 0 ? 'above' : 'below'} the average for code work.`);
  if (held.length > 0) factors.push(`Held back: ${held.map((h) => `${h.label} (${h.reason.replace(/\.$/, '').toLowerCase()})`).join('; ')}.`);

  return {
    choice: option(seat, nowMs),
    stay,
    why,
    factors,
    alternatives: ranked.filter((r) => r !== winner).slice(0, 4).map((r) => option(r.seat, nowMs)),
    held,
    classification: cls,
    mode,
    localOnly,
    routerWhy: decision.why,
  };
}
