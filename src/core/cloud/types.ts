/**
 * Cloud lane (3.11) — FROZEN CONTRACTS.
 *
 * Ashlr Verse launches Claude Code cloud sessions (claude.ai/code) that run on
 * the operator's Claude account — including its cloud / usage credits once
 * the subscription window is spent — and tracks what they deliver.
 *
 * How a launch works (verified 2026-09-24 against Claude Code 2.1.280):
 *   - A NEW cloud session can only be created by the interactive CLI:
 *     `claude --cloud "<task>"` (with `-p` it is refused). Run under a
 *     pseudo-terminal it prints, then exits 0:
 *         Created cloud session: <title>
 *         View: https://claude.ai/code/session_<id>?from=cli&m=0
 *         Resume with: claude --teleport session_<id>
 *   - It must run as the `claude-a` seat's native-profile launcher, which is
 *     signed in with a claude.ai account; API-key auth is refused ("cloud
 *     sessions require authentication with a Claude.ai account").
 *   - The session clones the cwd's `origin` GitHub repo at the cwd's CURRENT
 *     branch, which must be pushed. The Claude GitHub app already has access
 *     to ashlrai/*.
 *   - Attaching to / reading an existing session from the CLI is NOT enabled
 *     for this account, so Verse never reads a session back. Every task is
 *     told to DELIVER to GitHub instead (see delivery-contract.ts): push
 *     branch `ashlr-cloud/<taskId>` and open a DRAFT PR whose body carries a
 *     fenced `ashlr-cloud-report` JSON block. Verse tracks tasks with `gh`.
 *   - The credit balance is not readable (neither `/usage` nor the CLI show
 *     it), so spend is an ESTIMATE the operator can calibrate; the UI always
 *     says so and links to https://claude.ai/settings/usage.
 *
 * Nothing here merges. A cloud PR is judged and merged by the existing merge
 * gates (custody) or by Mason — never by the cloud lane.
 */

export const CLOUD_TASK_SCHEMA_VERSION = 1 as const;
export const CLOUD_BUDGET_SCHEMA_VERSION = 1 as const;

/** Branch every cloud task delivers to: `ashlr-cloud/<taskId>`. */
export const CLOUD_BRANCH_PREFIX = 'ashlr-cloud/' as const;
/** Fenced block language tag carrying the task report in the PR body. */
export const CLOUD_REPORT_FENCE = 'ashlr-cloud-report' as const;
/** Draft PR title prefix, so tasks are recognisable in GitHub lists. */
export const CLOUD_PR_TITLE_PREFIX = '[ashlr-cloud]' as const;
/** Where the real credit balance lives (not readable programmatically). */
export const CLOUD_BALANCE_URL = 'https://claude.ai/settings/usage' as const;
/** The seat whose claude.ai login launches cloud sessions. */
export const CLOUD_SEAT_ID = 'claude-a' as const;
/** A task with no PR after this long is marked `expired` (still linkable). */
export const CLOUD_TASK_EXPIRY_MS = 6 * 60 * 60 * 1000;
/** Max prompt length accepted from any entry point (chars). */
export const CLOUD_PROMPT_MAX_CHARS = 20_000;
/** Launch timeout for the PTY-wrapped CLI (creation took < 10 s in testing). */
export const CLOUD_LAUNCH_TIMEOUT_MS = 90_000;

/** Task ids look like `ct_20260924T2331_k3f9q2` (sortable, branch-safe). */
export const CLOUD_TASK_ID_PATTERN = /^ct_\d{8}T\d{4}_[a-z0-9]{6}$/;

export type CloudTaskOrigin = 'chat' | 'operator' | 'leader' | 'self-improve' | 'cli';

/**
 * queued     accepted, waiting for its repo's launch slot (launches are
 *            serialised per checkout folder — two concurrent `--cloud` runs
 *            in one folder conflict).
 * launching  PTY launch in flight.
 * running    session created; no PR yet.
 * pr-open    draft/ready PR exists on `ashlr-cloud/<id>`.
 * merged     PR merged (by gates or Mason).
 * closed     PR closed without merge (or dismissed by the operator).
 * failed     launch failed (see stateReason / failure code).
 * expired    no PR after CLOUD_TASK_EXPIRY_MS — the session link still works.
 */
export type CloudTaskState = 'queued' | 'launching' | 'running' | 'pr-open' | 'merged' | 'closed' | 'failed' | 'expired';

export const CLOUD_TERMINAL_STATES: readonly CloudTaskState[] = ['merged', 'closed', 'failed', 'expired'];

export type CloudLaunchFailureCode =
  | 'seat-unavailable'   // claude-a launcher missing / not a native profile
  | 'auth'               // not signed in with a claude.ai account
  | 'not-enabled'        // cloud sessions not enabled for the account
  | 'rate-limited'       // provider refused (no credits left / limit)
  | 'no-remote'          // checkout has no GitHub origin / branch not pushed
  | 'checkout-failed'    // could not prepare the isolated checkout
  | 'budget'             // refused by the cloud budget before launching
  | 'timeout'            // CLI produced no session within CLOUD_LAUNCH_TIMEOUT_MS
  | 'unparsed'           // CLI exited but printed no recognisable session
  | 'unknown';

export interface CloudTaskReport {
  status: 'done' | 'partial' | 'blocked' | 'no-change';
  summary: string;
  testsRun: string[];
  risks: string[];
  filesChanged?: number;
}

export interface CloudTaskPr {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  title: string;
}

export interface CloudTaskV1 {
  v: typeof CLOUD_TASK_SCHEMA_VERSION;
  id: string;
  /** GitHub `owner/name`. */
  repo: string;
  /** Branch the session starts from (must exist on origin). */
  baseBranch: string;
  /** Always `${CLOUD_BRANCH_PREFIX}${id}`. */
  branch: string;
  /** Short human title (≤ 80 chars). */
  title: string;
  /** The operator's / Leader's task text — WITHOUT the delivery contract. */
  prompt: string;
  origin: CloudTaskOrigin;
  requestedBy: 'mason' | 'leader' | 'self-improve';
  seat: string;
  sessionId: string | null;
  sessionUrl: string | null;
  state: CloudTaskState;
  /** Plain-language reason for the current state (never raw ISO / paths). */
  stateReason: string | null;
  failure: CloudLaunchFailureCode | null;
  createdAt: string;
  launchedAt: string | null;
  updatedAt: string;
  pr: CloudTaskPr | null;
  report: CloudTaskReport | null;
  /** Budget accounting — an ESTIMATE fixed at launch. */
  estimatedCostUsd: number;
  /** Backlog item this task came from (self-improvement), if any. */
  backlogItemId: string | null;
  /** Needs-you item created for approval (Leader-suggested tasks), if any. */
  needsYouId: string | null;
}

export interface CloudBudgetV1 {
  v: typeof CLOUD_BUDGET_SCHEMA_VERSION;
  /** Credits the operator says the account has (default 250). */
  creditsTotalUsd: number;
  /**
   * Operator calibration: credits already spent BEFORE the tasks Verse
   * tracks (or a correction after checking claude.ai). Added to the estimate.
   */
  creditsSpentAdjustmentUsd: number;
  /** Flat per-session estimate used for accounting (default 3). */
  estimatedCostPerSessionUsd: number;
  /** Max sessions in `launching|running` at once (all origins). */
  maxConcurrent: number;
  /** Max sessions per local day from ANY origin. */
  maxSessionsPerDay: number;
  selfImprove: {
    /** Verse may launch its own self-improvement tasks without a click. */
    enabled: boolean;
    /** Repo self-improvement targets (default ashlrai/ashlr-hub). */
    repo: string;
    /** Max self-improvement launches per local day. */
    maxPerDay: number;
    /** Stop self-improvement when estimated remaining credits fall below this. */
    reserveUsd: number;
  };
  updatedAt: string;
}

export const DEFAULT_CLOUD_BUDGET: Omit<CloudBudgetV1, 'updatedAt'> = Object.freeze({
  v: CLOUD_BUDGET_SCHEMA_VERSION,
  creditsTotalUsd: 250,
  creditsSpentAdjustmentUsd: 0,
  estimatedCostPerSessionUsd: 3,
  maxConcurrent: 4,
  maxSessionsPerDay: 20,
  selfImprove: Object.freeze({ enabled: true, repo: 'ashlrai/ashlr-hub', maxPerDay: 4, reserveUsd: 40 }),
}) as Omit<CloudBudgetV1, 'updatedAt'>;

export interface CloudGate {
  ok: boolean;
  /** Plain sentence when !ok ("4 of 4 self-improvement launches used today."). */
  reason: string | null;
}

export interface CloudBudgetView {
  creditsTotalUsd: number;
  estimatedSpentUsd: number;
  estimatedRemainingUsd: number;
  sessionsToday: number;
  selfImproveToday: number;
  running: number;
  canLaunch: CloudGate;
  canSelfImprove: CloudGate;
  /** Always shown next to spend: why this is an estimate. */
  estimateNote: string;
  balanceUrl: typeof CLOUD_BALANCE_URL;
  budget: CloudBudgetV1;
}

export interface CloudSeatStatus {
  id: string;
  ready: boolean;
  /** Plain sentence when not ready. */
  reason: string | null;
}

/** One self-improvement item: built in (improvement-backlog.ts) or added by the operator/Leader (<cloudHome>/backlog.json). */
export interface CloudBacklogItem {
  id: string;
  title: string;
  /** Full task prompt handed to the cloud session. */
  prompt: string;
  area: string;
  priority: 1 | 2 | 3;
  /** Repo the item targets (default: budget.selfImprove.repo). */
  repo?: string;
}

export interface CloudBacklogView {
  items: Array<CloudBacklogItem & { claimedBy: string | null; lastState: CloudTaskState | null }>;
  nextUp: string | null;
}

// ---------------------------------------------------------------------------
// HTTP contract — mounted as the 'cloud' module (verse-api.ts)
// ---------------------------------------------------------------------------

export const VERSE_CLOUD_PATH = '/api/verse/cloud' as const;
export const VERSE_CLOUD_LAUNCH_PATH = '/api/verse/cloud/launch' as const;
export const VERSE_CLOUD_BUDGET_PATH = '/api/verse/cloud/budget' as const;
export const VERSE_CLOUD_REFRESH_PATH = '/api/verse/cloud/refresh' as const;
export const VERSE_CLOUD_IMPROVE_PATH = '/api/verse/cloud/improve' as const;
/** POST `${VERSE_CLOUD_TASKS_PATH}/<id>/dismiss` */
export const VERSE_CLOUD_TASKS_PATH = '/api/verse/cloud/tasks' as const;

/** GET /api/verse/cloud */
export interface CloudOverviewResponse {
  generatedAt: string;
  seat: CloudSeatStatus;
  budget: CloudBudgetView;
  /** Newest first, at most 100. */
  tasks: CloudTaskV1[];
  backlog: CloudBacklogView;
}

/** POST /api/verse/cloud/launch (write token + read session) */
export interface CloudLaunchRequest {
  repo: string;
  baseBranch?: string;
  title?: string;
  prompt: string;
  origin: Extract<CloudTaskOrigin, 'chat' | 'operator' | 'cli'>;
}

export interface CloudLaunchResponse {
  ok: boolean;
  task: CloudTaskV1 | null;
  /** Plain sentence on refusal/failure. */
  error: string | null;
  failure: CloudLaunchFailureCode | null;
}

/** POST /api/verse/cloud/budget — any subset; validated and clamped. */
export type CloudBudgetUpdate = Partial<Pick<CloudBudgetV1,
  'creditsTotalUsd' | 'creditsSpentAdjustmentUsd' | 'estimatedCostPerSessionUsd' | 'maxConcurrent' | 'maxSessionsPerDay'>> & {
  selfImprove?: Partial<CloudBudgetV1['selfImprove']>;
};

/** POST /api/verse/cloud/improve — launch up to `count` backlog items now. */
export interface CloudImproveRequest {
  count?: number;
}

export interface CloudImproveResponse {
  launched: CloudTaskV1[];
  skipped: Array<{ itemId: string; reason: string }>;
}
