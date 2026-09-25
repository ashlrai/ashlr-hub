/**
 * Budget modes + seat routing — V3.10 contract (unit A0, frozen once written).
 *
 * Decides WHICH seat autonomous (and optionally interactive) work may use,
 * under the operator's budget mode, so the fleet never eats the headroom
 * Mason needs for his own live sessions.
 *
 *   all-in   — autonomy may use all available usage.
 *   balanced — autonomy stops at a per-seat reserve (default).
 *   reserve  — autonomy uses free local models plus only a small paid cap.
 *
 * Honesty rule: unknown usage is NOT headroom. A seat whose window reading is
 * null is ineligible for autonomy (closes the old Claude fail-open).
 *
 * BROWSER-SAFE: the budget UI imports this — type-only imports, plain consts.
 */

export type BudgetMode = 'all-in' | 'balanced' | 'reserve';

export const BUDGET_MODES: readonly BudgetMode[] = ['all-in', 'balanced', 'reserve'];

export interface SeatBudgetPolicy {
  seatId: string;
  /** false = autonomy never uses this seat (e.g. codex while it has no usage). */
  enabled: boolean;
  /** Percent (0–100) of the BINDING window kept back for Mason's interactive use. */
  reservePercent: number;
  /**
   * Autonomy may not touch the seat while its short (5-hour) window is above
   * this percent used — protects a live session. Absent = no session ceiling.
   */
  maxSessionWindowPercent?: number;
  /** Hard daily spend cap in USD for metered seats. Absent = no USD cap. */
  dailyUsdCap?: number;
}

export interface BudgetPolicy {
  mode: BudgetMode;
  /** Keyed by seat id; a seat absent here gets the mode's default policy. */
  seats: Record<string, SeatBudgetPolicy>;
  /** ISO time of the last change. */
  updatedAt: string;
}

/**
 * What a seat reason is about (3.10.1) — lets a reader derive "eligible again"
 * from data instead of parsing prose. Blockers lift on a CONDITION (switch
 * autonomy on, reconnect, a fresh reading, the grant) or at a TIME (a window
 * reset, a demotion's end); `headroom` and `model-window` are notes, never
 * blockers. Readers must treat an unrecognised kind as `other` (a newer
 * server may add kinds).
 */
export type SeatReasonKind =
  | 'headroom'
  | 'switched-off'
  | 'signed-out'
  | 'unreachable'
  | 'spent'
  | 'reserve'
  | 'session-ceiling'
  | 'unknown-usage'
  | 'spend-cap'
  | 'model-window'
  | 'context'
  | 'grant'
  | 'lane'
  | 'demoted'
  | 'other';

/** One reason, as data: the sentence and — separately — when it lifts. */
export interface SeatReason {
  kind: SeatReasonKind;
  /** One complete sentence ending in a period, WITHOUT a reset clause. */
  text: string;
  /**
   * Machine-readable instant this blocker lifts on its own (a window reset, a
   * demotion's end). Readers format it in the viewer's zone; null = none known.
   */
  resetsAt?: string | null;
  /**
   * The provider's own reset wording when it publishes no instant (Claude) —
   * rendered verbatim, never parsed into a time.
   */
  resetDescription?: string | null;
}

export interface SeatExclusion {
  seatId: string;
  /**
   * Complete sentences, each carrying its own reset clause — the form the
   * CLI, logs and pre-3.10.1 readers print. `details` is the same list as data.
   */
  reasons: string[];
  /** ISO time the seat is expected to become eligible again; null when unknown / never. */
  nextEligibleAt: string | null;
  /** Structured twin of `reasons`, same order (3.10.1+; absent on older records). */
  details?: SeatReason[];
}

/** Output of the pure `routeSeat(req, capacity, policy)`. */
export interface SeatDecision {
  /** Chosen seat; null when no seat is eligible. */
  seatId: string | null;
  /** Eligible seat ids, ranked best-first (the chosen one first when non-null). */
  candidates: string[];
  exclusions: SeatExclusion[];
  /** One plain-language sentence explaining the choice (or why nothing was chosen). */
  why: string;
  /**
   * One SHORT sentence for a headline (3.10.1+): the choice and its reason,
   * without the per-seat detail `exclusions` already carries. Absent on older
   * records — readers fall back to `why`.
   */
  summary?: string;
  mode: BudgetMode;
}

export type RoutingTask = 'code' | 'review' | 'plan' | 'bulk' | 'leader';
export type RoutingDifficulty = 'low' | 'medium' | 'high';

export interface RoutingRequest {
  task: RoutingTask;
  difficulty: RoutingDifficulty;
  /** Estimated context the work needs; absent when unknown. */
  contextTokens?: number;
  /** true = fleet/autonomous work (reserves apply); false = Mason's own interactive request. */
  autonomous: boolean;
}

/**
 * Live headroom for one seat, as shown next to its budget policy. Every
 * percent is 0–100 of that window; null = unknown (and therefore ineligible).
 */
export interface SeatHeadroom {
  seatId: string;
  /** Short (5-hour) window used percent; null when unknown / not applicable. */
  sessionUsedPercent: number | null;
  /** Weekly window used percent; null when unknown / not applicable. */
  weeklyUsedPercent: number | null;
  /** Which window currently binds autonomy; null when none applies (local) or unknown. */
  bindingWindow: 'session' | 'weekly' | null;
  /** Percent of the binding window autonomy may still use after the reserve; null when unknown. */
  autonomyHeadroomPercent: number | null;
  /** ISO reset time of the binding window; null when unknown. */
  resetAt: string | null;
  eligibleForAutonomy: boolean;
  /** Plain-language "why" for this seat's eligibility. */
  reasons: string[];
}

/** GET /api/verse/budget (and the POST response): the policy plus live headroom per seat. */
export interface BudgetResponse extends BudgetPolicy {
  headroom: SeatHeadroom[];
}

/**
 * POST /api/verse/budget — exactly ONE form per request, so a body can never
 * change more than the operator clicked.
 */
export type BudgetUpdateRequest =
  | { mode: BudgetMode }
  | { seatId: string; policy: Partial<Omit<SeatBudgetPolicy, 'seatId'>> };

export const VERSE_BUDGET_PATH = '/api/verse/budget';
