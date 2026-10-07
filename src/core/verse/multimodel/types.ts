/**
 * Multi-model chat — the wire and data shapes (3.16 "every model working
 * together"): the Auto seat, Compare / cross-family review, cheap-first
 * escalation, one-click handoff, first-class local models and the per-chat
 * meter.
 *
 * WHERE THINGS RUN
 *   - Prompt classification and the Auto choice are PURE (classify.ts,
 *     advisor.ts) and run in the BROWSER, per keystroke, over the seat list the
 *     app already polls. The prompt never leaves the page to be classified.
 *   - The server contributes what only it knows, in ONE read
 *     (`GET /api/verse/multimodel/context`): what Mason's past choices taught
 *     (learning.ts over the outcome log), fleet model ROI per engine (M322/M335
 *     `computeModelStats`), whether the repo must stay on this machine, and
 *     local model badges.
 *   - Every turn — a Compare fan-out, a review, an escalation, an Auto
 *     re-route — goes through the EXISTING session routes (POST /sessions,
 *     POST /sessions/:id/turns), so the spend chokepoint, the readiness gate,
 *     the local-only gate and the mutation token apply exactly as they do to a
 *     turn typed by hand. Nothing here opens a second path to a model.
 *
 * INTERACTIVE ONLY. The router is called with `autonomous: false` (Mason's own
 * work: fleet reserves exist FOR him and do not bind him). Fleet dispatch
 * semantics are untouched — no routing file is edited and no fleet caller
 * changes.
 *
 * BROWSER-SAFE: type-only imports and plain consts.
 */
import type { RoutingDifficulty, RoutingTask } from '../../routing/types.js';

export const VERSE_MULTIMODEL_PATH = '/api/verse/multimodel';
export const VERSE_MULTIMODEL_CONTEXT_PATH = `${VERSE_MULTIMODEL_PATH}/context`;
export const VERSE_MULTIMODEL_OUTCOME_PATH = `${VERSE_MULTIMODEL_PATH}/outcome`;
export const VERSE_MULTIMODEL_LINK_PATH = `${VERSE_MULTIMODEL_PATH}/link`;
export const VERSE_MULTIMODEL_METER_PATH = `${VERSE_MULTIMODEL_PATH}/meter`;
export const VERSE_MULTIMODEL_WARM_PATH = `${VERSE_MULTIMODEL_PATH}/local/warm`;
export const VERSE_MULTIMODEL_LABEL_PATH = `${VERSE_MULTIMODEL_PATH}/label`;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** What a message asks for, in the words a person would use. */
export type PromptKind = 'question' | 'explain' | 'code' | 'debug' | 'refactor' | 'review' | 'plan' | 'bulk';

export const PROMPT_KINDS: readonly PromptKind[] = ['question', 'explain', 'code', 'debug', 'refactor', 'review', 'plan', 'bulk'];

export type PromptSize = 'small' | 'medium' | 'large';

export interface PromptClassification {
  kind: PromptKind;
  /** The router's task vocabulary. */
  task: RoutingTask;
  difficulty: RoutingDifficulty;
  size: PromptSize;
  /** chars / 4, rounded up — the estimator the fit badges and handoff stats use. */
  estTokens: number;
  /** Short human noun phrase: "quick question", "hard refactor". */
  label: string;
  /** What moved the verdict ("stack trace", "3 files named"), for the tooltip. */
  signals: string[];
  /**
   * Which path produced the label: `rules` (classify.ts, always available,
   * used for the live preview) or `jev` (the decision layer, asked ONCE per
   * sent message and accepted only above its confidence gate). Absent = rules.
   */
  decidedBy?: 'rules' | 'jev';
  /** The decision layer's confidence when it decided; null/absent for rules. */
  confidence?: number | null;
  /**
   * The decision layer's "needs a frontier model" probability (0–1), when it
   * was asked and answered above the gate. Drives cheap-first triage.
   */
  needsFrontier?: number | null;
}

/** POST /api/verse/multimodel/label — the once-per-send labelling call. */
export interface PromptLabelRequest {
  text: string;
  /** The chat: EVERY root it reaches is checked — a local-only repo is never sent to the decision layer. */
  sessionId?: string;
  /** A folder, when there is no chat yet. */
  projectPath?: string;
  contextTokens?: number;
}

export interface PromptLabelResponse {
  classification: PromptClassification;
  /** Why the rules were used instead of the decision layer (unkeyed, local-only, low confidence…). */
  fallbackReason: string | null;
}

// ---------------------------------------------------------------------------
// Auto seat
// ---------------------------------------------------------------------------

/**
 * `auto`        — the best seat for the message (quality where it matters).
 * `cheap-first` — local models draft and triage; a frontier seat only when
 *                 the message is hard or the draft is weak (escalation.ts).
 */
export type AutoMode = 'auto' | 'cheap-first';

export interface SeatAdviceOption {
  seatId: string;
  label: string;
  engine: string;
  model: string | null;
  /** Runs on this Mac: free and private. */
  local: boolean;
  /** One short clause: "free · private", "5-hour 88% used". */
  note: string;
  /** 3.15: the tier this seat competes in for this message (routing/tiers.ts); absent on older callers. */
  tier?: 'elite' | 'fast' | 'free';
}

export interface SeatAdvice {
  /** Null when no seat can take the message (every one blocked, or none allowed). */
  choice: SeatAdviceOption | null;
  /** True when the choice IS the chat's current seat. */
  stay: boolean;
  /** ONE line, shown under the composer: the choice and its main reason. */
  why: string;
  /** The factors, in order of weight, for the tooltip. */
  factors: string[];
  /** Ranked runners-up the operator can pick instead (never includes `choice`). */
  alternatives: SeatAdviceOption[];
  /** Seats that could not take it, each with its first reason. */
  held: Array<{ seatId: string; label: string; reason: string }>;
  classification: PromptClassification;
  mode: AutoMode;
  /** The repo may not leave this machine: only local seats were considered. */
  localOnly: { on: boolean; reason: string | null };
  /** The router's own sentence, verbatim (for the tooltip / logs). */
  routerWhy: string;
}

// ---------------------------------------------------------------------------
// Learning (outcomes)
// ---------------------------------------------------------------------------

/**
 * What Mason did with an answer or a suggestion. The advisor learns only from
 * these — explicit ratings and the choices he actually made.
 *
 *   up / down         — thumbs on an answer.
 *   retry             — asked another seat the same thing (against the first).
 *   switch-away / -to — moved a chat off one seat onto another.
 *   auto-overridden   — Auto suggested this seat and he chose another.
 *   auto-followed     — he sent where Auto suggested (weak evidence).
 *   compare-won/lost  — picked / passed over in a side-by-side Compare.
 *   escalated         — a local draft was not good enough.
 *   draft-accepted    — a local draft was good enough (cheap-first).
 */
export type OutcomeSignal =
  | 'up'
  | 'down'
  | 'retry'
  | 'switch-away'
  | 'switch-to'
  | 'auto-followed'
  | 'auto-overridden'
  | 'compare-won'
  | 'compare-lost'
  | 'escalated'
  | 'draft-accepted';

export const OUTCOME_SIGNALS: readonly OutcomeSignal[] = [
  'up', 'down', 'retry', 'switch-away', 'switch-to', 'auto-followed', 'auto-overridden',
  'compare-won', 'compare-lost', 'escalated', 'draft-accepted',
];

export interface SeatOutcome {
  at: string;
  seatId: string;
  engine: string;
  kind: PromptKind;
  signal: OutcomeSignal;
  sessionId?: string;
  model?: string;
}

/** POST /api/verse/multimodel/outcome */
export interface SeatOutcomeRequest {
  seatId: string;
  kind: PromptKind;
  signal: OutcomeSignal;
  sessionId?: string;
  model?: string;
}

/** Aggregated evidence for one (kind, seat-or-engine) pair. */
export interface LearnedStat {
  /** Decayed net score (positive = Mason prefers it for this kind). */
  score: number;
  /** Decayed number of signals behind `score`. */
  n: number;
  up: number;
  down: number;
}

/** Keyed `${kind}|seat:${seatId}` and `${kind}|engine:${engine}`. */
export type LearnedTable = Record<string, LearnedStat>;

// ---------------------------------------------------------------------------
// Fleet ROI (M322 / M335), per engine
// ---------------------------------------------------------------------------

export interface EngineRoi {
  dispatches: number;
  /** Judge ship rate 0–1 over judged proposals; null when never judged. */
  shipRate: number | null;
  avgLatencyMs: number | null;
}

// ---------------------------------------------------------------------------
// Local models
// ---------------------------------------------------------------------------

export interface LocalModelBadge {
  seatId: string;
  model: string;
  /** Resident right now (warm), installed only, or not reported. */
  state: 'loaded' | 'available' | 'unknown';
  contextWindow: number | null;
  /** Measured tokens per second; the scope below distinguishes decode from end-to-end speed. */
  tokPerSec: number | null;
  /** Legacy summary: `warm` is decode; `turn` is end to end. Prefer the exact scope when present. */
  tokPerSecSource: 'warm' | 'turn' | null;
  /** Original measurement time and scope; absent on older servers. Never readiness evidence. */
  tokPerSecObservedAt?: string | null;
  tokPerSecScope?: 'warm-decode' | 'warm-end-to-end' | 'turn-end-to-end' | null;
  /** The endpoint is loopback: nothing leaves this Mac. */
  private: boolean;
  /** Can drive an agentic session (edit files); null = the runtime did not say. */
  supportsTools: boolean | null;
}

/** POST /api/verse/multimodel/local/warm */
export interface LocalWarmRequest {
  seatId: string;
}

export interface LocalWarmResult {
  seatId: string;
  ok: boolean;
  /** Wall time of the warm-up call. */
  ms: number;
  /** Load time the runtime reported (cold start), when it said. */
  loadMs: number | null;
  tokPerSec: number | null;
  tokPerSecScope?: 'warm-decode' | 'warm-end-to-end' | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Context (the one read the composer makes)
// ---------------------------------------------------------------------------

/** GET /api/verse/multimodel/context?sessionId=<id> | ?projectPath=<abs> (every root of the chat is checked) */
export interface MultimodelContext {
  learned: LearnedTable;
  /** Keyed by engine (`claude`, `codex`, `grok`, `local`). */
  roi: Record<string, EngineRoi>;
  localOnly: { on: boolean; reason: string | null };
  local: LocalModelBadge[];
  sampledAt: string;
}

// ---------------------------------------------------------------------------
// Thread links + the per-chat meter
// ---------------------------------------------------------------------------

/**
 * How a session joined a chat's thread (beyond `handoffFrom`, which the
 * session record already carries):
 *   compare  — one answer of a side-by-side fan-out;
 *   review   — a cross-family reviewer asked about an answer or diff;
 *   draft    — a local draft in cheap-first mode;
 *   escalate — the frontier seat a weak draft escalated to.
 */
export type ThreadRelation = 'compare' | 'review' | 'draft' | 'escalate';

export const THREAD_RELATIONS: readonly ThreadRelation[] = ['compare', 'review', 'draft', 'escalate'];

export interface ThreadLink {
  parentSessionId: string;
  childSessionId: string;
  relation: ThreadRelation;
  at: string;
}

/** POST /api/verse/multimodel/link */
export interface ThreadLinkRequest {
  parentSessionId: string;
  childSessionId: string;
  relation: ThreadRelation;
}

export interface ChatMeterSession {
  sessionId: string;
  title: string;
  seatId: string;
  engine: string;
  model: string;
  /** How it joined the thread: `root`, `handoff`, or a ThreadRelation. */
  relation: 'root' | 'handoff' | ThreadRelation;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** What these tokens would cost at the provider's API list price; null for local or unknown prices. */
  listUsd: number | null;
  local: boolean;
}

export interface ChatMeterSeat {
  seatId: string;
  label: string;
  engine: string;
  /** "5-hour 62% used" — the binding window, or null with no reading (local: null). */
  window: string | null;
  /**
   * What the FLEET may take from this seat under the budget mode; the rest is
   * kept for Mason's chats (which may use all of it). Null for local seats.
   */
  fleetShare: string | null;
}

export interface ChatMeter {
  sessionId: string;
  sessions: ChatMeterSession[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    /** Sum of known list prices. Subscription seats are NOT billed this — it is an equivalent. */
    listUsd: number;
    /** Tokens answered on this Mac. */
    localTokens: number;
    /** Local tokens priced at the thread's frontier rate: what cheap-first saved. */
    savedUsd: number;
  };
  seats: ChatMeterSeat[];
  budgetMode: string;
  /** One honest sentence about what the dollars mean. */
  note: string;
}
