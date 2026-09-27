/**
 * What the Auto seat learns from Mason — PURE aggregation of the outcome log
 * (thumbs, retries, switches, Compare picks, overrides, escalations) into a
 * small per-(kind, seat) and per-(kind, engine) table, and the bounded TILT
 * that table applies to the router's ranking.
 *
 * Rules that keep it honest:
 *   - Evidence decays (half-life 14 days): last month's Codex outage should
 *     not keep Codex out of reviews forever.
 *   - Nothing tilts on fewer than MIN_SIGNALS decayed signals, and the score is
 *     shrunk toward zero (score / (n + PRIOR)), so one thumbs-down never moves
 *     a seat.
 *   - The tilt is bounded (±MAX_TILT positions): learning re-orders close
 *     calls, it never overrides eligibility — a spent or signed-out seat stays
 *     out no matter how much Mason likes it, and a local-only repo stays local.
 *   - Seat-level evidence wins over engine-level (two Codex accounts can
 *     behave differently); engine-level fills in for a seat never used.
 *
 * BROWSER-SAFE.
 */
import type { LearnedStat, LearnedTable, OutcomeSignal, PromptKind, SeatOutcome } from './types.js';

export const LEARNING_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
export const LEARNING_MIN_SIGNALS = 3;
/** Pseudo-count the score is shrunk toward zero with. */
const PRIOR = 2;
/** The most a learned preference can move a seat, in ranking positions. */
export const LEARNING_MAX_TILT = 1.5;

/** Signed weight of each signal, for the seat it names. */
export const SIGNAL_WEIGHT: Readonly<Record<OutcomeSignal, number>> = Object.freeze({
  up: 1,
  down: -1,
  retry: -0.5,
  'switch-away': -0.5,
  'switch-to': 0.5,
  'auto-followed': 0.1,
  'auto-overridden': -0.5,
  'compare-won': 1,
  'compare-lost': -0.25,
  escalated: -0.5,
  'draft-accepted': 1,
});

export function seatKey(kind: PromptKind, seatId: string): string {
  return `${kind}|seat:${seatId}`;
}

export function engineKey(kind: PromptKind, engine: string): string {
  return `${kind}|engine:${engine}`;
}

function add(table: LearnedTable, key: string, weight: number, decay: number): void {
  const stat: LearnedStat = table[key] ?? { score: 0, n: 0, up: 0, down: 0 };
  stat.score += weight * decay;
  stat.n += decay;
  if (weight > 0) stat.up += 1;
  if (weight < 0) stat.down += 1;
  table[key] = stat;
}

/** Fold outcomes into the table, newest evidence weighted most. Malformed rows are skipped. */
export function aggregateOutcomes(outcomes: readonly SeatOutcome[], nowMs: number): LearnedTable {
  const table: LearnedTable = {};
  for (const o of outcomes) {
    const weight = SIGNAL_WEIGHT[o.signal];
    const at = Date.parse(o.at);
    if (weight === undefined || !Number.isFinite(at) || typeof o.seatId !== 'string' || typeof o.kind !== 'string') continue;
    const age = Math.max(0, nowMs - at);
    const decay = Math.pow(0.5, age / LEARNING_HALF_LIFE_MS);
    add(table, seatKey(o.kind, o.seatId), weight, decay);
    if (typeof o.engine === 'string' && o.engine) add(table, engineKey(o.kind, o.engine), weight, decay);
  }
  // Round for a stable wire shape.
  for (const stat of Object.values(table)) {
    stat.score = Math.round(stat.score * 1000) / 1000;
    stat.n = Math.round(stat.n * 1000) / 1000;
  }
  return table;
}

export interface LearnedTilt {
  /** Added to the seat's ranking position: NEGATIVE moves it up. 0 = no evidence. */
  tilt: number;
  /** "you've rated Codex well for reviews (4 of 5 up)" — null when no tilt. */
  phrase: string | null;
}

const KIND_PLURAL: Record<PromptKind, string> = {
  question: 'questions',
  explain: 'explanations',
  code: 'code changes',
  debug: 'debugging',
  refactor: 'refactors',
  review: 'reviews',
  plan: 'planning',
  bulk: 'bulk edits',
};

/** The tilt learned evidence gives one seat for one kind of message. */
export function learnedTilt(table: LearnedTable | null | undefined, kind: PromptKind, seat: { seatId: string; engine: string; label: string }): LearnedTilt {
  if (!table) return { tilt: 0, phrase: null };
  const bySeat = table[seatKey(kind, seat.seatId)];
  const byEngine = table[engineKey(kind, seat.engine)];
  const stat = bySeat && bySeat.n >= LEARNING_MIN_SIGNALS ? bySeat : byEngine && byEngine.n >= LEARNING_MIN_SIGNALS ? byEngine : null;
  if (!stat) return { tilt: 0, phrase: null };
  const shrunk = stat.score / (stat.n + PRIOR);
  const tilt = -Math.max(-LEARNING_MAX_TILT, Math.min(LEARNING_MAX_TILT, shrunk * 2 * LEARNING_MAX_TILT));
  if (Math.abs(tilt) < 0.15) return { tilt: 0, phrase: null };
  const total = stat.up + stat.down;
  const tally = total > 0 ? ` (${stat.up} of ${total} signals positive)` : '';
  const phrase = tilt < 0
    ? `you've preferred ${seat.label} for ${KIND_PLURAL[kind]}${tally}`
    : `you've passed over ${seat.label} for ${KIND_PLURAL[kind]}${tally}`;
  return { tilt: Math.round(tilt * 1000) / 1000, phrase };
}

/**
 * The outcome rows one Compare pick produces: the winner `compare-won`, every
 * other answer `compare-lost`.
 */
export function compareOutcomes(
  winnerSessionId: string,
  entries: ReadonlyArray<{ sessionId: string; seatId: string; engine: string; model?: string }>,
  kind: PromptKind,
  at: string,
): SeatOutcome[] {
  return entries.map((e) => ({
    at,
    seatId: e.seatId,
    engine: e.engine,
    kind,
    signal: e.sessionId === winnerSessionId ? 'compare-won' : 'compare-lost',
    sessionId: e.sessionId,
    ...(e.model ? { model: e.model } : {}),
  }));
}
