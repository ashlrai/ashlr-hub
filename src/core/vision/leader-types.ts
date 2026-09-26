/**
 * Leader ("Visionary" persona) — V3.10 Track B contract (unit B-U1, frozen day 0).
 *
 * The Leader (unit U8) extends the Strategist: it reads deterministic digests
 * (never raw reasoning), writes a LeaderMemo, and ACTS within the standing
 * grant through LeaderActions:
 *
 *   class A — applies now; Mason can veto any time.
 *   class B — applies after a veto window (grant `leader.vetoMinutes`, 30 min
 *             by decision), with a notification. A spend-raising class-B
 *             action whose window would end in local quiet hours (00:00–07:00)
 *             waits for the window to end, unless the budget mode is all-in.
 *   class C — outside the grant: never applied; goes to Needs-you with the
 *             Leader's argument attached.
 *
 * Every applied action records its `inverse`; a veto runs it and restores the
 * previous state exactly (byte-for-byte for file-backed state), then writes a
 * playbook delta. Class is decided by U8's pure policy check from kind AND
 * params (e.g. `budget.mode` toward reserve is A, toward all-in is B).
 *
 * All memo / action free text is untrusted model output: scrubbed before it
 * is stored, rendered as plain text, never replayed as instructions.
 *
 * Honesty rule: `null` = unknown / not measured.
 *
 * BROWSER-SAFE: the Command and Mind surfaces import this — type-only imports
 * and plain constants, no node: modules.
 */
import type { BudgetMode, BudgetPolicy } from '../routing/types.js';
import type { GoalStatus } from '../types.js';
import type { FleetTaskInput, RepoHold } from '../fleet/fleet-types.js';
import type { HarnessHypothesis, HarnessRoutingWeights } from '../learn/harness-types.js';

export const VERSE_LEADER_PATH = '/api/verse/leader';

/**
 * Frozen Leader limits (SPEC-310B §4 + addendum §6). Grants and config can
 * only tighten these.
 */
export const LEADER_LIMITS = Object.freeze({
  maxGoalsPerMemo: 3,
  maxNewGoalsPerDay: 3,
  maxActiveGoals: 4,
  maxHypothesesPerMemo: 3,
  maxRunsPerDay: 3,
  defaultVetoMinutes: 30,
  /** Local-time quiet window for spend-raising class-B actions (addendum §6). */
  quietHours: Object.freeze({ startHour: 0, endHour: 7 }),
  /** grok-cli lanes: the Leader may set min..max; above `maxClassA` is class B. */
  grokLanes: Object.freeze({ min: 1, max: 4, default: 2, maxClassA: 2 }),
  /** A soft-archived goal stays restorable this long. */
  archiveRestoreDays: 30,
  /** Each move is graded this many days after it was made. */
  outcomeGradeDays: 7,
} as const);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type LeaderActionClass = 'A' | 'B' | 'C';

/**
 * Class by kind (U8 decides from kind + params):
 *   A: goal.focus, goal.pause, goal.reorder, goal.archive (soft, 30 d), work.dispatch,
 *      standard.add, router.tune (within bounds), experiment.start, repo.pause,
 *      repo.resume (leader-pause only), pr.close (fleet-authored only),
 *      budget.mode toward reserve, lanes.grok at or below grokLanes.maxClassA.
 *   B: goal.create (≤ 3/day, ≤ 4 active), budget.mode toward all-in (≤ grant maxMode),
 *      lanes.grok above maxClassA, lanes.codex (after resetsAt, only if the grant
 *      lists codex), harness.adopt (gate passed).
 *   C: escalate — anything outside the grant.
 */
export type LeaderActionKind =
  | 'goal.focus'
  | 'goal.pause'
  | 'goal.reorder'
  | 'goal.archive'
  | 'goal.create'
  | 'work.dispatch'
  | 'standard.add'
  | 'router.tune'
  | 'experiment.start'
  | 'repo.pause'
  | 'repo.resume'
  | 'pr.close'
  | 'budget.mode'
  | 'lanes.grok'
  | 'lanes.codex'
  | 'harness.adopt'
  | 'escalate';

export const LEADER_ACTION_KINDS: readonly LeaderActionKind[] = [
  'goal.focus',
  'goal.pause',
  'goal.reorder',
  'goal.archive',
  'goal.create',
  'work.dispatch',
  'standard.add',
  'router.tune',
  'experiment.start',
  'repo.pause',
  'repo.resume',
  'pr.close',
  'budget.mode',
  'lanes.grok',
  'lanes.codex',
  'harness.adopt',
  'escalate',
];

/** A goal the Leader proposes (maps onto the strategist's ProposedGoal for adoption). */
export interface LeaderGoalProposal {
  objective: string;
  rationale: string;
  /** nameWithOwner; null = ecosystem-wide. */
  targetRepo: string | null;
  deliverable: string | null;
  acceptanceEvidence: string[];
}

export interface LeaderStandard {
  id: string;
  rule: string;
  /** What it applies to, e.g. `judge`, `producer`, a repo, or `*`. */
  appliesTo: string;
  evidence: string | null;
  source: 'leader' | 'mason';
  addedAt: string;
  retiredAt: string | null;
}

/** Parameters per action kind. */
export interface LeaderActionParamsMap {
  'goal.focus': { goalId: string };
  'goal.pause': { goalId: string; until: string | null };
  /** The new priority order of active goal ids. */
  'goal.reorder': { goalIds: string[] };
  'goal.archive': { goalId: string };
  'goal.create': { goal: LeaderGoalProposal };
  'work.dispatch': { task: FleetTaskInput };
  'standard.add': { rule: string; appliesTo: string; evidence: string | null };
  'router.tune': { tuning: Partial<HarnessRoutingWeights> };
  'experiment.start': { hypothesisId: string };
  'repo.pause': { repo: string; reason: string; until: string | null };
  'repo.resume': { repo: string };
  'pr.close': { repo: string; number: number; reason: string };
  'budget.mode': { to: BudgetMode };
  'lanes.grok': { slots: number };
  'lanes.codex': { enabled: boolean };
  'harness.adopt': { versionId: string; experimentId: string };
  /** Class C: what the Leader wants and its argument, for Mason. */
  'escalate': { request: string; argument: string };
}

/**
 * The Leader's standing settings that other units read (U5's dispatch router
 * reads lanes and tuning; see vision/leader-apply.ts readLeaderDirectives).
 * One small file the Leader owns, so a veto restores it byte-for-byte.
 */
export interface LeaderDirectivesV1 {
  v: 1;
  updatedAt: string;
  /** Partial override of the active harness's routing weights; null = none. */
  routerTuning: Partial<HarnessRoutingWeights> | null;
  /** grok-cli lane slots (LEADER_LIMITS.grokLanes); null = the lane default. */
  grokLanes: number | null;
  /** Codex lanes enabled by a class-B action after resetsAt; null = default (off). */
  codexEnabled: boolean | null;
}

/**
 * How to undo an applied action exactly. Recorded at apply time (it needs
 * the prior state), written to the ledger with the action, executed by a veto.
 */
export type LeaderInverse =
  /** router.tune, lanes.grok, lanes.codex */
  | { op: 'restore-directives'; before: LeaderDirectivesV1 | null }
  /**
   * goal.focus / pause / reorder / archive — per touched goal. Since 3.10.1
   * `record` is null and the prior bytes live ONLY in the local restore
   * snapshot (actions.json); the inverse carries their sha256 and the prior
   * status. WHY: this inverse is written to the authority ledger, whose lines
   * are capped at 64 KB — ten whole goal records overflowed it and every
   * reorder was undone at once (review 310 d5). A veto restores the snapshot
   * bytes only when they hash to `recordSha256`; otherwise it puts back the
   * status. Rows written before 3.10.1 still carry the whole `record`.
   */
  | { op: 'restore-goals'; before: { goalId: string; record: string | null; recordSha256?: string; priorStatus?: GoalStatus }[] }
  /** goal.create */
  | { op: 'archive-goal'; goalId: string }
  /** work.dispatch (only while the task is still queued / parked) */
  | { op: 'cancel-task'; taskId: string }
  /** standard.add */
  | { op: 'retire-standard'; standardId: string }
  /** experiment.start */
  | { op: 'cancel-experiment'; experimentId: string }
  /** repo.pause / repo.resume — the prior leader-pause hold (null = none) */
  | { op: 'restore-repo-hold'; repo: string; before: RepoHold | null }
  /** pr.close */
  | { op: 'reopen-pr'; repo: string; number: number }
  /** budget.mode — the exact prior BudgetPolicy */
  | { op: 'restore-budget'; before: BudgetPolicy }
  /** harness.adopt — back to the prior active version (null = baseline) */
  | { op: 'rollback-harness'; toVersionId: string | null };

/**
 * - `scheduled` — class B inside its veto window (see `applyAfter`).
 * - `applied`   — in force; `inverse` is set.
 * - `vetoed`    — undone by Mason (or never applied, if vetoed while scheduled).
 * - `refused`   — the policy check said no (e.g. exceeds the grant) — nothing changed.
 * - `failed`    — applying threw; nothing changed.
 * - `escalated` — class C, sent to Needs-you.
 */
export type LeaderActionStatus = 'scheduled' | 'applied' | 'vetoed' | 'refused' | 'failed' | 'escalated';

export interface LeaderActionOf<K extends LeaderActionKind> {
  v: 1;
  id: string;
  memoId: string;
  kind: K;
  class: LeaderActionClass;
  params: LeaderActionParamsMap[K];
  /** Plain-language line for the action log, e.g. "Pause goal ‘Router cleanup’ for 7 days". */
  summary: string;
  /** The Leader's argument (untrusted text). */
  why: string;
  createdAt: string;
  /**
   * Earliest time it may apply: class A = createdAt; class B = end of the veto
   * window (already deferred past quiet hours when needed); class C = null.
   */
  applyAfter: string | null;
  /** True when applyAfter was pushed past local quiet hours (addendum §6). */
  deferredForQuietHours: boolean;
  status: LeaderActionStatus;
  /** Why refused / failed / escalated; null otherwise. */
  statusReason: string | null;
  appliedAt: string | null;
  vetoedAt: string | null;
  vetoNote: string | null;
  /** Set when applied; null before, and for refused / failed / escalated actions. */
  inverse: LeaderInverse | null;
}

/** Discriminated on `kind`, so narrowing the kind narrows `params`. */
export type LeaderAction = { [K in LeaderActionKind]: LeaderActionOf<K> }[LeaderActionKind];

// ---------------------------------------------------------------------------
// Memo
// ---------------------------------------------------------------------------

/**
 * - `ok`                — a memo was produced.
 * - `no-seat`           — no eligible seat (fails closed; never falls back to cloud).
 * - `skipped-unchanged` — evidence digest unchanged since the last memo.
 * - `failed`            — the model call failed.
 * - `parse-failed`      — output did not parse; fails closed with no actions.
 */
export type LeaderRunOutcome = 'ok' | 'no-seat' | 'skipped-unchanged' | 'failed' | 'parse-failed';

/**
 * `retry` (3.14): a bounded re-run after a failed / no-seat run, instead of
 * waiting for tomorrow's slot. `checkin` (3.14): the cheap working-hours
 * check-in (LeaderRunMode 'checkin').
 */
export type LeaderTrigger = 'schedule' | 'merges' | 'revert' | 'seat-reset' | 'insight' | 'manual' | 'retry' | 'checkin';

/**
 * 3.14: `full` is the daily memo (and trigger / manual runs); `checkin` is the
 * lightweight working-hours check-in — local or grok only, short output, and
 * ADVISORY: its actions, goals and hypotheses are never enacted.
 */
export type LeaderRunMode = 'full' | 'checkin';

/**
 * 3.14: one seat the run tried or passed over. `served` answered (its output
 * may still have failed to parse — then `parse-failed`); `skipped` was never
 * called (the reason says why: the router, the Leader's seat rules, the mode).
 */
export type LeaderAttemptOutcome = 'served' | 'failed' | 'timeout' | 'parse-failed' | 'skipped';

export interface LeaderSeatAttempt {
  seatId: string;
  engine: string;
  model: string | null;
  outcome: LeaderAttemptOutcome;
  reason: string | null;
  /** Wall-clock of the call; null when skipped. */
  ms: number | null;
  /** The per-attempt limit it ran under; null when skipped. */
  timeoutMs: number | null;
}

/**
 * 3.14: Leader health for the UI / Telegram — "Leader: healthy / degraded (why)".
 * Derived from the run state (no model call, no seat probe on the read path).
 */
export interface LeaderHealth {
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  /** One plain sentence: why the status is what it is. */
  summary: string;
  lastRunAt: string | null;
  lastRunOutcome: LeaderRunOutcome | null;
  lastSuccessAt: string | null;
  /** The last failed / no-seat / parse-failed run's reason; null when none since the last success. */
  lastFailure: { at: string; outcome: LeaderRunOutcome; reason: string | null } | null;
  /** Consecutive runs without a memo (failed, no-seat, parse-failed). */
  consecutiveFailures: number;
  nextDueAt: string | null;
  nextDueReason: string | null;
  /** A scheduled bounded retry, if one is pending. */
  retry: { attempt: number; maxAttempts: number; at: string } | null;
  /** Seats as the most recent run found them (served / failed / skipped + why). */
  seats: LeaderSeatAttempt[];
  seatsObservedAt: string | null;
  /** The seat that served the most recent memo. */
  servedBy: { seatId: string; model: string | null; at: string } | null;
  runsToday: number;
  checkinsToday: number;
  checkinHours: number;
}

export interface LeaderExpectedDelta {
  metric: string;
  delta: number;
  byDate: string;
}

export interface LeaderMemo {
  v: 1;
  id: string;
  at: string;
  status: LeaderRunOutcome;
  statusReason: string | null;
  trigger: LeaderTrigger;
  /** Shadow runs (rollout Phase 1): actions are computed and shown, never applied. */
  dryRun: boolean;
  seatId: string | null;
  model: string | null;
  /** 3.14: absent on older memos (= 'full'). */
  mode?: LeaderRunMode;
  /** 3.14: every seat tried or passed over, in order (absent on older memos). */
  attempts?: LeaderSeatAttempt[];
  /** sha256 hex of the digests the memo was written from (unchanged ⇒ skip). */
  evidenceDigest: string;
  bottleneck: { statement: string; metric: string | null; evidence: string[] } | null;
  move: { statement: string; why: string; expectedDelta: LeaderExpectedDelta | null } | null;
  killList: { target: { kind: 'goal' | 'pr' | 'lane' | 'experiment'; id: string }; why: string }[];
  /** ≤ LEADER_LIMITS.maxGoalsPerMemo. */
  goals: LeaderGoalProposal[];
  priorityChanges: { goalId: string; action: 'focus' | 'pause' | 'archive' | 'reorder'; why: string }[];
  standards: { rule: string; appliesTo: string; evidence: string | null }[];
  critiques: { subject: string; standard: string; finding: string; evidenceRef: string | null }[];
  seatPlan: { role: 'producer' | 'judge' | 'leader'; seatId: string; share: number; rationale: string }[];
  /** ≤ LEADER_LIMITS.maxHypothesesPerMemo. */
  hypotheses: HarnessHypothesis[];
  questionsForMason: string[];
  actions: LeaderAction[];
}

// ---------------------------------------------------------------------------
// Ledger payloads (authority/types.ts LedgerPayloads)
// ---------------------------------------------------------------------------

export interface LeaderMemoRecord {
  memoId: string;
  status: LeaderRunOutcome;
  statusReason: string | null;
  trigger: LeaderTrigger;
  dryRun: boolean;
  evidenceDigest: string;
  seatId: string | null;
  model: string | null;
  actionIds: string[];
  at: string;
}

export interface LeaderVetoRecord {
  actionId: string;
  memoId: string;
  note: string | null;
  /** The inverse that ran; null when the action was still scheduled (nothing to undo). */
  inverse: LeaderInverse | null;
  /** True when the prior state was restored exactly. */
  restored: boolean;
  detail: string;
  at: string;
}

/** The 7-day grade of a memo's move — feeds the Leader's hit-rate. */
export interface LeaderOutcomeRecord {
  memoId: string;
  metric: string;
  expectedDelta: number;
  /** null = could not be measured. */
  actualDelta: number | null;
  byDate: string;
  /** null = ungradeable. */
  hit: boolean | null;
  gradedAt: string;
}

// ---------------------------------------------------------------------------
// Leader API (U8) — GET / POST /api/verse/leader
// ---------------------------------------------------------------------------

export interface LeaderHitRate {
  windowDays: number;
  graded: number;
  hits: number;
  /** hits / graded; null when nothing is graded yet. */
  rate: number | null;
}

export interface LeaderMemoSummary {
  id: string;
  at: string;
  status: LeaderRunOutcome;
  bottleneck: string | null;
  move: string | null;
  expectedDelta: LeaderExpectedDelta | null;
  /** null until graded. */
  outcome: LeaderOutcomeRecord | null;
  actionCount: number;
}

export interface LeaderStateV1 {
  v: 1;
  generatedAt: string;
  lastRun: { at: string; outcome: LeaderRunOutcome; reason: string | null } | null;
  nextRunAt: string | null;
  runsToday: number;
  latest: LeaderMemo | null;
  /** Newest first. */
  timeline: LeaderMemoSummary[];
  /** Recent actions, newest first, including scheduled class-B actions (countdown to applyAfter). */
  actions: LeaderAction[];
  hitRate: LeaderHitRate;
  standards: LeaderStandard[];
  directives: LeaderDirectivesV1 | null;
  /** 3.14 (additive): run health for the UI / Telegram. */
  health?: LeaderHealth;
}

/** POST /api/verse/leader — exactly one form per request. */
export type LeaderActionRequest =
  | { action: 'run' }
  | { action: 'veto'; actionId: string; note?: string }
  | { action: 'veto-memo'; memoId: string; note?: string };
