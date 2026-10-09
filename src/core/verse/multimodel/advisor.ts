/** Auto applies the shared account rank, then explicit user pins/preferences,
 * conversation stickiness and tool/privacy facts. Aggregate provider ROI stays
 * diagnostic-only: it is not exact model/account/task performance evidence. */
import { assessSeat, type SeatCapacity } from '../../routing/headroom.js';
import type { BudgetEngine } from '../../routing/policy.js';
import { COST_BASIS_LABELS, type CostBasis } from '../../routing/tiers.js';
import { capacityTier, DEFAULT_ROUTER_WEIGHTS, routeSeat, type RouterWeights } from '../../routing/router.js';
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

/**
 * Engines the Auto seat may pick — every chat engine (3.15: Devin is a chat
 * seat and an equal partner, so it is routable like Claude and Codex).
 */
export const ROUTABLE_ENGINES: readonly BudgetEngine[] = ['claude', 'codex', 'devin', 'grok', 'local'];

/** Existing conversation continuity preference in ranking positions.
 * Hard and cheap-first work retain the weaker configured preference. */
export const STICKINESS = 3.5;
export const STICKINESS_WEAK = 1.25;
/** Legacy readable bound; provider-aggregate ROI no longer tilts selection. */
export const ROI_MAX_TILT = 0.75;
/** Legacy readable diagnostic threshold; it does not establish exact-model evidence. */
export const ROI_MIN_DISPATCHES = 10;
/** Where a tool-less local model lands for edit work: behind everything. */
const NO_TOOLS_PENALTY = 3;
const EDIT_KINDS: ReadonlySet<PromptKind> = new Set(['code', 'debug', 'refactor', 'bulk']);

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
  /** Explicitly supplied runnable alternative with independent funding category.
   * Used for cheap work only when that category establishes lower marginal
   * funding consumption. Catalog family/tier labels never create this variant. */
  cheaper?: { model: string; capacity: SeatCapacity } | null;
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

/** Existing per-message funding weights. Headroom keeps its existing weight;
 * legacy aggregate latency remains unqualified and does not steer ranking. */
export function weightsFor(classification: PromptClassification, mode: AutoMode): RouterWeights {
  const hard = classification.difficulty === 'high' || (classification.needsFrontier ?? 0) >= 0.7;
  let lambdaCost: number;
  if (mode === 'cheap-first') lambdaCost = hard ? 1 : 4;
  else lambdaCost = hard ? 1 : classification.difficulty === 'low' ? 3 : 1.5;
  return { ...DEFAULT_ROUTER_WEIGHTS, lambdaCost };
}

function windowWord(binding: 'session' | 'weekly' | null): string {
  return binding === 'session' ? '5-hour' : 'weekly';
}

/** How a windowless seat is described: it has no window to be "N% left" of. */
function windowlessNote(basis: CostBasis | undefined): string {
  if (basis === 'free') return 'free on your plan';
  if (basis === 'credits') return 'spends credits (ACUs)';
  return `${basis ? COST_BASIS_LABELS[basis] : 'funding category unknown'} · no usage window reported`;
}

/** "free · private on this Mac" / "62% of its 5-hour window left" / "no usage reading". */
export function seatNote(seat: AdvisorSeat, nowMs: number): string {
  if (seat.local) return seat.private ? 'free · private on this Mac' : 'free · local runtime';
  if (seat.capacity.windowless) return windowlessNote(seat.capacity.costBasis);
  const assessed = assessSeat(seat.capacity, { seatId: seat.seatId, enabled: true, reservePercent: 0 }, { nowMs });
  const left = assessed.headroom.autonomyHeadroomPercent;
  if (assessed.exhausted) return 'usage spent';
  if (typeof left !== 'number') return 'no usage reading';
  return `${Math.max(0, left)}% of its ${windowWord(assessed.headroom.bindingWindow)} window left`;
}

function option(seat: AdvisorSeat, nowMs: number): SeatAdviceOption {
  return {
    seatId: seat.seatId, label: seat.label, engine: seat.engine, model: seat.model, local: seat.local, note: seatNote(seat, nowMs),
    tier: capacityTier(seat.capacity),
  };
}

interface Ranked {
  seat: AdvisorSeat;
  base: number;
  learned: ReturnType<typeof learnedTilt>;
  sticky: number;
  tools: number;
}

function total(r: Ranked, withLearned = true, withSticky = true): number {
  return r.base + (withLearned ? r.learned.tilt : 0) + (withSticky ? r.sticky : 0) + r.tools;
}

/** Use an explicitly supplied cheaper funding variant only for cheap work.
 * Independent admission remains mandatory for the resulting resource. */
function forMessage(seat: AdvisorSeat, cheap: boolean): AdvisorSeat {
  if (!cheap || !seat.cheaper) return seat;
  const current = seat.capacity.costBasis;
  const alternative = seat.cheaper.capacity;
  // Only an explicitly supplied independent funding category establishes a
  // cheaper variant. A family/display tier alone cannot change the model.
  const cheaper = !seat.capacity.free && (alternative.free || alternative.costBasis === 'free') ||
    (current === 'credits' || current === 'per-token') && alternative.costBasis === 'subscription';
  return cheaper ? { ...seat, model: seat.cheaper.model, capacity: alternative } : seat;
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
  const hard = cls.difficulty === 'high' || (cls.needsFrontier ?? 0) >= 0.7;
  // Cheap work may use an explicitly supplied lower-consumption funding variant;
  // a provider or model-family tier alone never supplies one.
  const cheap = !hard && (mode === 'cheap-first' || cls.difficulty === 'low' || cls.task === 'bulk');
  const known = input.seats
    .filter((s) => (ROUTABLE_ENGINES as readonly string[]).includes(s.engine) && s.model !== null)
    .map((s) => forMessage(s, cheap));
  const pool = localOnly.on ? known.filter((s) => s.local && s.private) : known;
  const byId = new Map(pool.map((s) => [s.seatId, s]));
  const factors: string[] = [];
  if (localOnly.on) factors.push(`This repo is local-only${localOnly.reason ? ` — ${localOnly.reason.replace(/\.$/, '')}` : ''}.`);
  factors.push(`Read as ${cls.label}${cls.decidedBy === 'jev' ? ` (labelled by Jev, ${Math.round((cls.confidence ?? 0) * 100)}% sure)` : ''}${cls.signals.length > 0 ? `: ${cls.signals.slice(0, 3).join(', ')}` : ''}.`);

  const weights = weightsFor(cls, mode);
  const context = Math.max(0, input.contextTokens ?? 0) + cls.estTokens;
  const decision: SeatDecision = routeSeat(
    { task: cls.task, difficulty: (cls.needsFrontier ?? 0) >= 0.7 && cls.difficulty !== 'high' ? 'high' : cls.difficulty, contextTokens: context, autonomous: false },
    pool.map((s) => s.capacity),
    input.policy,
    { nowMs, weights },
  );

  const held = decision.exclusions.map((e) => ({
    seatId: e.seatId,
    label: byId.get(e.seatId)?.label ?? e.seatId,
    // Codex selection here uses subscription windows, without authorizing credit spending.
    reason: byId.get(e.seatId)?.engine === 'codex' && e.details?.[0]?.kind === 'spent'
      ? 'Subscription window spent; Auto does not select Codex credit-funded turns. Credit balance and manual access are separate.'
      : (e.details?.[0]?.text ?? e.reasons[0] ?? 'Not available right now.').replace(/\s+$/, ''),
  }));

  const midChat = (input.turnCount ?? 0) > 0 && typeof input.currentSeatId === 'string';
  const stickiness = mode === 'cheap-first' || hard ? STICKINESS_WEAK : STICKINESS;
  const rows: Ranked[] = decision.candidates.flatMap((id, index) => {
    const seat = byId.get(id);
    if (!seat) return [];
    return [{
      seat,
      base: index,
      learned: learnedTilt(input.learned, cls.kind, seat),
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
    return empty(clip(held.some((entry) => byId.get(entry.seatId)?.engine === 'codex' &&
      decision.exclusions.find((excluded) => excluded.seatId === entry.seatId)?.details?.[0]?.kind === 'spent')
      ? 'Auto cannot route this work. Codex credit balance and manual access are separate.'
      : decision.summary ?? decision.why));
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
    reason = mode === 'cheap-first' ? `${cls.label} — local resource with admitted capacity` : `${cls.label} — no provider token charge on this Mac`;
  } else if (hard) {
    reason = `${cls.label} — eligible task fit; model quality is unmeasured`;
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
