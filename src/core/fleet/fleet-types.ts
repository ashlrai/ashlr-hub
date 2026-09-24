/**
 * Resident fleet — V3.10 Track B contract (unit B-U1, frozen day 0).
 *
 * The vocabulary shared by the merge gates (U3), the post-merge watch (U4),
 * the fleet runtime and task source (U5), mirrors (U6), the Leader (U8), the
 * authority ledger (U1) and the Fleet / Command surfaces (C7). Every record
 * here that the authority ledger stores is immutable once written, so its
 * shape is frozen: add a new record type rather than reshaping one.
 *
 * Repo identity: GitHub `owner/name` ("nameWithOwner") everywhere in this
 * file, EXCEPT fields documented as an enrolled path. WHY two identities: the
 * daemon loop keys work by `WorkItem.repo` (the absolute path of the enrolled
 * checkout — under autonomy, the fleet's own mirror), while grants, holds,
 * PRs and merges are about the GitHub repo. Mixing them is how a hold on
 * `ashlrai/binshield` silently fails to pause `/…/mirrors/ashlrai__binshield`.
 *
 * Honesty rule: `null` means unknown / not measured — never zero or "none".
 *
 * BROWSER-SAFE: the Fleet and Command surfaces import this — type-only
 * imports and plain constants, no node: modules.
 */
import type { RoutingDifficulty, SeatDecision } from '../routing/types.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Engine families the fleet runs. They are also the fleet's LANES and the
 * values a standing grant's `engines` list may name. They are families, not
 * `EngineId`s: `local` is whichever local runtime the local fleet dispatches
 * through, `grok-cli` the SuperGrok CLI seat (never the per-token xAI API),
 * `claude-cli` the capped claude-a slice, `codex` the Codex CLI seats.
 */
export type FleetEngine = 'local' | 'grok-cli' | 'claude-cli' | 'codex';

export const FLEET_ENGINES: readonly FleetEngine[] = ['local', 'grok-cli', 'claude-cli', 'codex'];

/** `propose` = PRs only; `merge` = the fleet may land merges (subject to every gate). */
export type RepoStage = 'propose' | 'merge';

/** Ordering for min(): a stage can only ever be lowered by an outer bound. */
export const REPO_STAGE_RANK: Readonly<Record<RepoStage, number>> = Object.freeze({ propose: 0, merge: 1 });

/** The highest risk class autonomy may ever merge. `high` exists (merge.ts RiskClass) but is never mergeable. */
export type MergeRisk = 'low' | 'medium';

/** Ordering for risk comparisons, including merge.ts's unmergeable `high`. */
export const MERGE_RISK_RANK: Readonly<Record<MergeRisk | 'high', number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

/**
 * `server` = GitHub enforces required checks on the default branch (rulesets).
 * `local`  = the daemon enforces the gates itself (private free-plan repos,
 *            where protection is unavailable) — lower caps apply.
 */
export type RepoEnforcement = 'server' | 'local';

/**
 * Who caused a change. In-process attribution for the ledger and for hold
 * permissions (e.g. only `mason` clears an owner-hold) — NOT a security
 * boundary: agents never run this code, they only produce diffs.
 */
export type FleetActor = 'mason' | 'daemon' | 'leader' | 'post-merge-watch' | 'backpressure';

export const FLEET_ACTORS: readonly FleetActor[] = ['mason', 'daemon', 'leader', 'post-merge-watch', 'backpressure'];

/** A judge's identity, `<engine>:<model>` (SPEC-310B §7), e.g. `grok-cli:grok-4.7`. */
export type JudgeId = `${string}:${string}`;

/** Why an item was held back from dispatch this tick. */
export interface RouteHold {
  /**
   * - `park`  — no eligible seat right now; retry at `nextEligibleAt`.
   * - `split` — the work does not fit any eligible seat's context; it must be
   *             decomposed (it is NEVER sent to a local model instead).
   */
  kind: 'park' | 'split';
  /** One specific sentence (never a bare "parked"). */
  reason: string;
  /** ISO time the blocking condition should lift; null = unknown. */
  nextEligibleAt: string | null;
}

// ---------------------------------------------------------------------------
// Merge gates (U3) — one ledger row per gate evaluation
// ---------------------------------------------------------------------------

export type GateId = 'G0' | 'G1' | 'G1b' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7';

/** Gates run in exactly this order and fail closed (SPEC-310B §2). */
export const GATE_ORDER: readonly GateId[] = ['G0', 'G1', 'G1b', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

/**
 * - `pass`       — continue to the next gate.
 * - `refuse`     — the proposal stops here.
 * - `owner-lane` — a PR is opened and labelled `ashlr:owner-lane`; it is never auto-merged.
 * - `wait`       — retry later (e.g. no different-family judge seat has headroom; ≤ 24 h).
 */
export type GateVerdict = 'pass' | 'refuse' | 'owner-lane' | 'wait';

export interface GateResult {
  v: 1;
  gate: GateId;
  proposalId: string;
  /** nameWithOwner. */
  repo: string;
  /** PR head / proposal head SHA the verdict is bound to; null before a head exists. */
  headSha: string | null;
  verdict: GateVerdict;
  /** Stable machine reason (e.g. `protected-path`, `risk-over-cap`, `no-required-checks`) — the funnel groups on it. */
  code: string;
  /** One specific sentence for Mason. Scrubbed. */
  reason: string;
  at: string;
  /**
   * sha256 hex over this gate's canonical inputs + verdict. The combined
   * digest of a proposal's gate rows is its `Ashlr-Gates` commit trailer.
   */
  digest: string;
}

/**
 * Every gate passed but the merge was withheld (propose stage / propose
 * switch / shadow). Shadow-stage rollout criteria count these.
 */
export interface WouldMergeRecord {
  v: 1;
  proposalId: string;
  repo: string;
  headSha: string;
  gatesDigest: string;
  withheldBecause: 'stage-propose' | 'switch-propose' | 'shadow';
  risk: MergeRisk;
  files: number;
  linesAdded: number;
  linesDeleted: number;
  at: string;
}

// ---------------------------------------------------------------------------
// Pull requests and landings (U3 writes, U4/U1/U5/C7 read)
// ---------------------------------------------------------------------------

/** A PR the fleet (the `ashlr-fleet` GitHub App) opened. */
export interface FleetPrRecord {
  v: 1;
  repo: string;
  number: number;
  /** null for a revert PR. */
  proposalId: string | null;
  /** `ashlr/fleet/<id>`. */
  branch: string;
  headSha: string;
  kind: 'change' | 'revert';
  /** Labelled `ashlr:owner-lane` (never auto-merged). */
  ownerLane: boolean;
  at: string;
}

/** A close / reopen of a fleet PR. */
export interface FleetPrChange {
  repo: string;
  number: number;
  reason: string;
  actor: FleetActor;
  at: string;
}

/** Input to closeFleetPr / reopenFleetPr (fleet/host-merge.ts, U3). */
export interface FleetPrRequest {
  repo: string;
  number: number;
  /** Why, in one sentence (posted as the PR comment). */
  reason: string;
  actor: FleetActor;
}

export interface FleetPrResult {
  ok: boolean;
  /** Specific sentence — on refusal, why (e.g. "PR #12 was not authored by ashlr-fleet[bot]"). */
  reason: string;
  repo: string;
  number: number;
  /** PR state after the call; `unknown` when GitHub could not be read. */
  state: 'open' | 'closed' | 'merged' | 'unknown';
}

export interface LandingProducer {
  /** Engine id as dispatched (e.g. `grok-cli`, `local-coder`). */
  engine: string;
  model: string | null;
  /** Model family as reviewModelFamily() reports it (e.g. `xai`, `anthropic`, `local`); null = unknown. */
  family: string | null;
  seatId: string | null;
}

/**
 * One commit the fleet landed on a default branch through the GitHub App —
 * a squash merge of a fleet PR, or the auto-merged revert of one. The
 * post-merge watch, the rollout criteria and the Growth charts all read it.
 */
export interface LandingRecord {
  v: 1;
  /** Unique per landing (e.g. `${repo}#${prNumber}@${mergeSha.slice(0, 12)}`). */
  id: string;
  kind: 'merge' | 'revert';
  repo: string;
  baseBranch: string;
  prNumber: number;
  /** PR head SHA the merge call was pinned to (`PUT /pulls/{n}/merge {sha}`). */
  headSha: string;
  /** The resulting commit on the base branch. */
  mergeSha: string;
  /** Fleet proposal this landing carries; null for a revert. */
  proposalId: string | null;
  /** For a revert: the landing it reverts; null for a merge. */
  revertsLandingId: string | null;
  /** `Ashlr-Grant` trailer. */
  grantId: string;
  rolloutStageId: string;
  /** `Ashlr-Gates` trailer. */
  gatesDigest: string;
  /** `Ashlr-Ledger-Head` trailer: hash of the last ledger entry written before the merge call. */
  ledgerHead: string;
  enforcement: RepoEnforcement;
  risk: MergeRisk;
  files: number;
  linesAdded: number;
  linesDeleted: number;
  /** null for a revert (the daemon authors it). */
  producer: LandingProducer | null;
  /** null for a revert (reverts skip G6). */
  judgeId: JudgeId | null;
  /** When the proposal was created — cycle time = landedAt − proposedAt; null = unknown. */
  proposedAt: string | null;
  landedAt: string;
  /** End of the post-merge watch window (landedAt + 2 h). */
  watchUntil: string;
}

/**
 * The final verdict of one post-merge watch (U4). Only final verdicts are
 * ledgered; a watch still in progress writes nothing, so rollout criteria
 * never count a pending watch as green.
 */
export interface PostMergeResult {
  v: 1;
  landingId: string;
  repo: string;
  mergeSha: string;
  /** CI on the merge SHA. `none` = the repo has no checks (local enforcement). */
  ci: 'green' | 'red' | 'none' | 'unknown';
  /** The suite re-run in a fresh worktree at mergeSha. */
  suite: 'pass' | 'fail' | 'not-run';
  verdict: 'green' | 'red';
  /** Specific sentence (e.g. "CI `test` failed on 3f2a9c1"). */
  detail: string;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Repo holds (U4 owns the store; U3 G0, U5, U8 and C7 read)
// ---------------------------------------------------------------------------

/**
 * - `quarantine`   — red post-merge: 6 h, auto-expires at `until`.
 * - `owner-hold`   — escalation (failed revert, second quarantine in 7 d):
 *                    cleared ONLY by actor `mason` (one-click resume).
 * - `leader-pause` — a Leader class-A pause; the Leader may clear only this kind.
 * - `cooldown`     — backpressure: 3 consecutive rejects / reverts, 6 h.
 */
export type RepoHoldKind = 'quarantine' | 'owner-hold' | 'leader-pause' | 'cooldown';

export const REPO_HOLD_KINDS: readonly RepoHoldKind[] = ['quarantine', 'owner-hold', 'leader-pause', 'cooldown'];

/** At most one hold per (repo, kind); a repo is paused while ANY hold is active. */
export interface RepoHold {
  v: 1;
  repo: string;
  kind: RepoHoldKind;
  reason: string;
  since: string;
  /** ISO expiry; null = until explicitly cleared. */
  until: string | null;
  setBy: FleetActor;
  /** The landing that caused it (quarantine / owner-hold); null otherwise. */
  landingId: string | null;
}

export interface RepoHoldSpec {
  reason: string;
  until: string | null;
  landingId?: string | null;
}

/** Input to setRepoHold (fleet/quarantine.ts, U4). `hold: null` clears that kind. */
export interface SetRepoHoldRequest {
  repo: string;
  kind: RepoHoldKind;
  hold: RepoHoldSpec | null;
  actor: FleetActor;
}

/**
 * `before`/`after` are the (repo, kind) hold around the call, so a Leader
 * veto can restore the exact prior state.
 */
export interface RepoHoldChange {
  ok: boolean;
  /** Why a change was refused (e.g. the Leader clearing an owner-hold); null when ok. */
  reason: string | null;
  before: RepoHold | null;
  after: RepoHold | null;
}

// ---------------------------------------------------------------------------
// Safety signals that feed rollout criteria (ledgered)
// ---------------------------------------------------------------------------

/** A confined agent tried something its profile denies. Any one of these regresses the rollout. */
export interface SandboxViolationRecord {
  v: 1;
  engine: string;
  repo: string | null;
  runId: string | null;
  /** What was denied, e.g. `file-read ~/.ashlr/authority`. Scrubbed, home paths as `~`. */
  operation: string;
  at: string;
}

/** Autonomy used a seat past the line it had to stay under. Any one of these regresses the rollout. */
export interface ReserveBreachRecord {
  v: 1;
  seatId: string;
  window: 'session' | 'weekly';
  usedPercent: number;
  /** The line autonomy had to stay under (100 − reserve floor, or the session ceiling). */
  limitPercent: number;
  at: string;
}

// ---------------------------------------------------------------------------
// Task source (U5 owns the queue; U4 repairs and U8 dispatches enqueue)
// ---------------------------------------------------------------------------

export type FleetTaskSource = 'leader' | 'backlog' | 'repair' | 'insight' | 'revert' | 'manual';

export type FleetTaskStatus = 'queued' | 'parked' | 'dispatched' | 'done' | 'failed' | 'cancelled';

/** Input to enqueueTask (fleet/task-source.ts, U5). */
export interface FleetTaskInput {
  /** nameWithOwner. */
  repo: string;
  source: FleetTaskSource;
  /** Short, human-readable. Untrusted when it came from a model: scrubbed, rendered as text. */
  title: string;
  /** Context for the producer (no secrets). */
  detail: string;
  difficulty: RoutingDifficulty;
  /** 1 (low) .. 5 (high). */
  value: number;
  requestedBy: FleetActor;
  goalId?: string | null;
  /** repair / revert: the landing that caused it. */
  landingId?: string | null;
  /** insight: the A7 ReasoningInsight id it came from. */
  insightId?: string | null;
  /** Idempotency: an unfinished task with the same key is returned instead of a duplicate. */
  dedupeKey?: string | null;
}

export interface FleetTask {
  v: 1;
  id: string;
  repo: string;
  source: FleetTaskSource;
  title: string;
  detail: string;
  difficulty: RoutingDifficulty;
  value: number;
  requestedBy: FleetActor;
  goalId: string | null;
  landingId: string | null;
  insightId: string | null;
  dedupeKey: string | null;
  status: FleetTaskStatus;
  /** The size the task was sliced to fit (≤ the repo's effective caps). */
  sizeBudget: { files: number; lines: number };
  attempts: number;
  parkedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EnqueueTaskResult =
  | { ok: true; task: FleetTask; deduped: boolean }
  | { ok: false; reason: string };

/** Input to cancelTask (fleet/task-source.ts, U5). Only queued / parked tasks can be cancelled. */
export interface CancelTaskRequest {
  taskId: string;
  reason: string;
  actor: FleetActor;
}

export type CancelTaskResult = { ok: true; task: FleetTask } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Dispatch outcomes (TickHooks.afterDispatch payload — daemon/tick-hooks.ts)
// ---------------------------------------------------------------------------

export interface DispatchOutcome {
  itemId: string;
  /** Enrolled path — exactly `WorkItem.repo`. */
  repoPath: string;
  /** Engine id the loop dispatched (or would have). */
  backend: string;
  model: string | null;
  seatId: string | null;
  lane: FleetEngine | null;
  dispatched: boolean;
  /** Why not dispatched; null when dispatched. */
  skipReason: string | null;
  runId: string | null;
  proposalId: string | null;
  spentUsd: number;
  at: string;
}

// ---------------------------------------------------------------------------
// Fleet live API (U5) — GET /api/verse/fleet/live, /api/verse/overnight
// ---------------------------------------------------------------------------

export const VERSE_FLEET_LIVE_PATH = '/api/verse/fleet/live';

/** Served over daemon/overnight-status.ts's existing `OvernightStatus` wire shape. */
export const VERSE_OVERNIGHT_PATH = '/api/verse/overnight';

/** Swimlane phases, in pipeline order. `queued`/`parked` draw as outlines. */
export type FleetPhase =
  | 'queued'
  | 'parked'
  | 'producing'
  | 'verifying'
  | 'judging'
  | 'landing'
  | 'watching'
  | 'reverting';

export const FLEET_PHASES: readonly FleetPhase[] = [
  'queued',
  'parked',
  'producing',
  'verifying',
  'judging',
  'landing',
  'watching',
  'reverting',
];

export type FleetRunOutcome = 'merged' | 'proposed' | 'owner-lane' | 'refused' | 'failed' | 'reverted' | 'cancelled';

export interface FleetLiveRun {
  /** Attempt / run id. */
  id: string;
  taskId: string | null;
  /** nameWithOwner when known, else the enrolled directory's name. */
  repo: string;
  title: string;
  lane: FleetEngine | null;
  seatId: string | null;
  engine: string | null;
  model: string | null;
  phase: FleetPhase;
  startedAt: string | null;
  phaseStartedAt: string | null;
  endedAt: string | null;
  outcome: FleetRunOutcome | null;
  prNumber: number | null;
  /** Why it is parked / split (Gantt); null when not held. */
  hold: RouteHold | null;
  /** "Why this seat" — the SeatRouter decision behind the dispatch; null when none was made. */
  seatDecision: SeatDecision | null;
}

export interface FleetLaneState {
  lane: FleetEngine;
  /** Slots this lane may use right now. 0 = off. */
  slots: number;
  busy: number;
  /** Why `slots` differs from the lane's default (presence, Leader, budget, grant); null = default. */
  capReason: string | null;
}

export interface FleetFunnelStage {
  gate: GateId;
  entered: number;
  passed: number;
  refusals: { code: string; reason: string; count: number }[];
}

export interface FleetGateFunnel {
  from: string;
  to: string;
  stages: FleetFunnelStage[];
}

export interface FleetRepoRow {
  repo: string;
  /** Effective stage under the current standing policy; null = not in the grant / no standing authority. */
  stage: RepoStage | null;
  enforcement: RepoEnforcement | null;
  lastMergeAt: string | null;
  mergesToday: number | null;
  maxMergesPerDay: number | null;
  /** Post-merge green % over 7 days; null = no completed watches. */
  greenPct7d: number | null;
  /** Daily post-merge green % for the last 14 days, oldest first; null = no data that day. */
  greenTrend: (number | null)[];
  openFleetPrs: number | null;
  holds: RepoHold[];
}

export interface FleetLiveSummary {
  /** Runs producing / verifying / judging / landing right now. */
  building: number | null;
  queued: number | null;
  parked: number | null;
  waitingVerify: number | null;
  mergedToday: number | null;
  revertsToday: number | null;
  merged7d: number | null;
  postMergeGreenPct7d: number | null;
  cycleTimeP50Ms7d: number | null;
}

/**
 * - `dark`    — no standing authority / daemon not running (the designed "Fleet dark since …" state).
 * - `idle`    — running, nothing to do.
 * - `running` — work in flight.
 * - `paused`  — daemon.paused sentinel set.
 * - `stopped` — KILL set (Stop).
 */
export type FleetLiveState = 'dark' | 'idle' | 'running' | 'paused' | 'stopped';

export interface FleetLiveSnapshotV1 {
  v: 1;
  generatedAt: string;
  state: FleetLiveState;
  stateReason: string | null;
  /** When the fleet last did anything; null = never / unknown. */
  lastActivityAt: string | null;
  summary: FleetLiveSummary;
  lanes: FleetLaneState[];
  /** Live runs plus the last 12 h (Swimlane), newest first. */
  runs: FleetLiveRun[];
  funnel: FleetGateFunnel | null;
  repos: FleetRepoRow[];
}

/**
 * POST /api/verse/fleet/live — exactly one form per request (the Fleet repo
 * table's pause / resume, and Needs-you's one-click owner-hold resume). Both
 * act as `mason`: pause sets an `owner-hold`; resume clears `kind`, or every
 * active hold on the repo when `kind` is absent.
 */
export type FleetLiveActionRequest =
  | { action: 'pause-repo'; repo: string; reason: string }
  | { action: 'resume-repo'; repo: string; kind?: RepoHoldKind };
