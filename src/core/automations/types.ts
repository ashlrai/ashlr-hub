/**
 * Automations (3.15) — work that arrives on its own.
 *
 * An automation is a standing instruction: WHEN a trigger fires (a labelled
 * GitHub issue, a red default branch, a schedule, a local webhook, a Telegram
 * `/task`), route ONE task to ONE lane (fleet queue, Claude cloud session,
 * Devin session, or a review item in Needs-you) through that lane's EXISTING
 * entry point. Nothing here decides what the fleet may do: the standing grant,
 * KILL/Stop, the lane budgets and the merge gates all still apply, and a
 * firing that one of them refuses stays queued (or is recorded as refused) —
 * it never goes around them.
 *
 * Pure types + constants: no I/O, importable from the web UI.
 */

export const AUTOMATION_SCHEMA_VERSION = 1 as const;
export const AUTOMATION_STATE_SCHEMA_VERSION = 1 as const;

/** Where a fired automation's task goes. */
export const AUTOMATION_LANES = ['fleet', 'cloud', 'devin', 'leader-review'] as const;
export type AutomationLane = (typeof AUTOMATION_LANES)[number];

export const AUTOMATION_TRIGGER_KINDS = ['github-issues', 'ci-red', 'schedule', 'webhook', 'telegram'] as const;
export type AutomationTriggerKind = (typeof AUTOMATION_TRIGGER_KINDS)[number];

/** Issues (and optionally PRs) carrying ALL of `labels`, or matching a search `query`, on the automation's repos. */
export interface GithubIssuesTrigger {
  kind: 'github-issues';
  /** Every label must be present (GitHub's `labels=` semantics). Empty only when `query` is set. */
  labels: string[];
  /**
   * Optional GitHub search qualifiers (`is:issue is:open` and `repo:` are
   * added). With NO labels, only issues by the repo's owner, members or
   * collaborators fire — a label is endorsement, a query is not.
   */
  query: string | null;
  /** Also fire for pull requests carrying the labels (default false: issues only). */
  includePrs: boolean;
  /** Minutes between polls per repo (5–1440). */
  pollMinutes: number;
}

/** A failing check run on the head of the repo's default branch (or `branch`). */
export interface CiRedTrigger {
  kind: 'ci-red';
  /** null = the repo's default branch. */
  branch: string | null;
  pollMinutes: number;
}

/** An RFC 5545 RRULE subset (see rrule.ts), evaluated in local time. */
export interface ScheduleTrigger {
  kind: 'schedule';
  rrule: string;
}

/** POST /api/verse/automations/<id>/webhook on the local Verse server (loopback + mutation token). */
export interface WebhookTrigger {
  kind: 'webhook';
}

/** Telegram `/task <owner/repo> <text>` from the configured chat. */
export interface TelegramTrigger {
  kind: 'telegram';
}

export type AutomationTrigger = GithubIssuesTrigger | CiRedTrigger | ScheduleTrigger | WebhookTrigger | TelegramTrigger;

/** `repos: ['*']` = every repo in the standing grant (resolved at firing time). */
export const AUTOMATION_ALL_GRANT_REPOS = '*' as const;

export interface AutomationV1 {
  v: typeof AUTOMATION_SCHEMA_VERSION;
  /** `au_<slug>` — stable, url/branch safe. */
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  lane: AutomationLane;
  /**
   * A playbook (src/core/playbooks) every task runs under: `id` (latest) or
   * `id@vN` (pinned). Checked to exist on create/update; the lane resolves
   * and injects it (cloud/Devin explicitly, fleet via its `!macro`).
   */
  playbookId: string | null;
  /** owner/name list, or `['*']` for every repo in the standing grant. */
  repos: string[];
  /** The standing instruction put in front of every task this automation creates. */
  instructions: string;
  /** Firings in flight at once (dispatched and not yet settled, or awaiting review). */
  maxConcurrent: number;
  /** Firings dispatched per local calendar day. */
  maxPerDay: number;
  /** Firings allowed to wait in this automation's queue; more are dropped (and recorded). */
  queueDepth: number;
  /** Estimated USD this automation may spend per local calendar month (0 = only free lanes). */
  spendCapUsd: number;
  /**
   * Dedupe template: one task per rendered key, ever (within retention).
   * Placeholders: {repo} {number} {sha} {occurrence} {key}. null = the
   * trigger's default (issues `{repo}#{number}`, CI `{repo}@{sha}`,
   * schedule `{repo}@{occurrence}`, webhook `{key}`, telegram `{repo}:{key}`).
   */
  dedupeKey: string | null;
  /**
   * Optional triage (Jev decision layer, see triage.ts): per new firing, may
   * pick a lane from `lanes` and a playbook from `playbooks` when its
   * confidence ≥ `minConfidence`; below that — or offline/unkeyed — the
   * configured `lane`/`playbookId` apply. It can also ESCALATE a doubtful
   * item to leader-review; it can never drop work or pick a lane outside
   * `lanes`. null = deterministic (the configured lane, always).
   */
  triage: AutomationTriageConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTriageConfig {
  /** Lanes triage may choose between (must include the automation's `lane`). */
  lanes: AutomationLane[];
  /** Playbook ids triage may choose between (empty = keep `playbookId`). */
  playbooks: string[];
  /** 0.5–1; default 0.75 (same as the other Jev call sites). */
  minConfidence: number;
}

/** How a firing's lane/playbook was decided. */
export interface AutomationTriageRecord {
  source: 'rules' | 'jev';
  /** Jev's confidence in the chosen lane; null on the rules path. */
  confidence: number | null;
  /** P(worth working) from Jev; null when not asked / unavailable. */
  worth: number | null;
  /** Plain sentence ("Jev picked devin at 0.91", "rules: Jev unavailable (no-key)"). */
  note: string;
}

/** What a create/update carries (server fills id/v/timestamps). */
export type AutomationInput = Omit<AutomationV1, 'v' | 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const AUTOMATION_LIMITS = Object.freeze({
  maxAutomations: 50,
  maxRepos: 20,
  maxLabels: 5,
  nameMaxChars: 80,
  instructionsMaxChars: 4_000,
  queryMaxChars: 200,
  /** Body text taken from an issue / webhook / Telegram message. */
  eventTextMaxChars: 4_000,
  eventTitleMaxChars: 160,
  pollMinutesMin: 5,
  pollMinutesMax: 1_440,
  maxConcurrentMax: 20,
  maxPerDayMax: 200,
  queueDepthMax: 100,
  spendCapUsdMax: 100_000,
  /** Issues read per repo per poll (one page). */
  issuesPerPoll: 50,
  /** Firings kept in state (open ones are always kept). */
  firingsKept: 1_000,
  /** Dedupe keys are remembered this long. */
  dedupeRetentionMs: 30 * 24 * 60 * 60_000,
  /** A queued firing older than this is dropped as stale. */
  queuedExpiryMs: 7 * 24 * 60 * 60_000,
  /** A firing stuck in `dispatching` this long (crash mid-launch) is marked failed, never re-sent. */
  dispatchingStaleMs: 15 * 60_000,
  /** Window for the success rate. */
  successWindowMs: 30 * 24 * 60 * 60_000,
});

export const AUTOMATION_TRIAGE_DEFAULT_CONFIDENCE = 0.75;
/** Below this P(worth working) at confidence, triage escalates to leader-review. */
export const AUTOMATION_TRIAGE_DOUBT = 0.2;

export const AUTOMATION_DEFAULTS = Object.freeze({
  pollMinutes: 15,
  maxConcurrent: 2,
  maxPerDay: 5,
  queueDepth: 10,
  spendCapUsd: 50,
});

export const AUTOMATION_ID_PATTERN = /^au_[a-z0-9][a-z0-9-]{1,47}$/;
export const AUTOMATION_FIRING_ID_PATTERN = /^af_\d{8}T\d{6}_[a-z0-9]{6}$/;
export const AUTOMATION_REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
export const AUTOMATION_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 :._/+-]{0,49}$/;
/** A playbook ref as src/core/playbooks writes it: `id` or `id@vN` (validate.ts canonicalises `!macro` / `id@N`). */
export const AUTOMATION_PLAYBOOK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}(?:@v\d{1,6})?$/;

// ---------------------------------------------------------------------------
// Firings
// ---------------------------------------------------------------------------

/**
 * queued          accepted; waiting for a slot (concurrency, per-day, spend,
 *                 lane budget, grant, KILL) — retried every tick until
 *                 AUTOMATION_LIMITS.queuedExpiryMs.
 * dispatching     the lane call is in flight (claimed, never sent twice).
 * dispatched      the lane accepted it (task id in laneRef); watched until it settles.
 * awaiting-review leader-review lane: waiting in Needs-you for Approve / Reject.
 * succeeded       the lane's task finished well (PR merged, fleet task done).
 * failed          the lane's task failed, or the launch itself failed.
 * refused         a lane refused it for good (lane off, repo outside the grant…).
 * dropped         the queue was full, or it waited too long.
 * rejected        leader-review: rejected in Needs-you.
 */
export type AutomationFiringState =
  | 'queued'
  | 'dispatching'
  | 'dispatched'
  | 'awaiting-review'
  | 'succeeded'
  | 'failed'
  | 'refused'
  | 'dropped'
  | 'rejected';

export const AUTOMATION_OPEN_STATES: readonly AutomationFiringState[] = ['queued', 'dispatching', 'dispatched', 'awaiting-review'];
/** Count against maxConcurrent. */
export const AUTOMATION_ACTIVE_STATES: readonly AutomationFiringState[] = ['dispatching', 'dispatched', 'awaiting-review'];

export type AutomationSourceKind = AutomationTriggerKind | 'manual';

/** Where the work came from — always linkable back when there is a URL. */
export interface AutomationFiringSource {
  kind: AutomationSourceKind;
  /** https URL of the issue / PR / check run / webhook-supplied link; null when there is none. */
  url: string | null;
  /** Short ref: `#12`, a sha, an occurrence time, a webhook key. */
  ref: string;
}

export interface AutomationLaneRef {
  lane: Exclude<AutomationLane, 'leader-review'>;
  /** Cloud `ct_…`, Devin `dv_…`, or a fleet task uuid. */
  id: string;
  /** Session / PR link when the lane gave one. */
  url: string | null;
}

export interface AutomationFiringV1 {
  v: 1;
  id: string;
  automationId: string;
  /** The rendered dedupe key (unique per automation within retention). */
  dedupeKey: string;
  source: AutomationFiringSource;
  repo: string;
  /** One line, ≤ 160 chars. */
  title: string;
  /** The event text (untrusted DATA) — never the instructions. */
  text: string;
  lane: AutomationLane;
  playbookId: string | null;
  /** Absent on firings written before triage existed. */
  triage?: AutomationTriageRecord;
  state: AutomationFiringState;
  /** Plain sentence for the current state. */
  reason: string | null;
  laneRef: AutomationLaneRef | null;
  /** Estimated spend charged to the automation when the lane accepted it. */
  spendUsd: number;
  attempts: number;
  createdAt: string;
  dispatchedAt: string | null;
  settledAt: string | null;
  updatedAt: string;
}

/** Per-automation poll bookkeeping (bounded GitHub reads). */
export interface AutomationCursor {
  lastPolledAt: string | null;
  /** schedule: the next occurrence (ISO). */
  nextRunAt: string | null;
  /** github-issues: newest `updated_at` seen, per repo (the `since` cursor). */
  since: Record<string, string>;
  /** Last ETag per repo+endpoint, sent as If-None-Match. */
  etags: Record<string, string>;
  /** ci-red: default branch per repo (read once). */
  branches: Record<string, string>;
  /** Last poll error, plain sentence; null when the last poll worked. */
  lastError: string | null;
}

export interface AutomationStateV1 {
  v: typeof AUTOMATION_STATE_SCHEMA_VERSION;
  cursors: Record<string, AutomationCursor>;
  firings: AutomationFiringV1[];
  /** `<automationId>\u0000<dedupeKey>` → first seen (ms). */
  seen: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Views + HTTP contract (workbench family 'automations')
// ---------------------------------------------------------------------------

export interface AutomationStats {
  lastFiredAt: string | null;
  /** schedule: next occurrence; polling triggers: next poll; null for push triggers. */
  nextRunAt: string | null;
  queued: number;
  active: number;
  firedToday: number;
  spentThisMonthUsd: number;
  /** succeeded / (succeeded + failed) over 30 days; null when nothing settled. */
  successRate: number | null;
  succeeded: number;
  failed: number;
  lastError: string | null;
}

export interface AutomationView {
  automation: AutomationV1;
  stats: AutomationStats;
  /** Human sentence of the trigger ("Issues labelled ashlr on 2 repos, every 15 min"). */
  triggerSummary: string;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  blurb: string;
  input: AutomationInput;
}

export const VERSE_AUTOMATIONS_PATH = '/api/verse/automations' as const;

/** GET /api/verse/automations */
export interface AutomationsOverviewResponse {
  generatedAt: string;
  automations: AutomationView[];
  /** Newest first, at most 100. */
  firings: AutomationFiringV1[];
  templates: AutomationTemplate[];
  /** Why nothing will dispatch right now (KILL, no grant, scheduler off); null when clear. */
  blocked: string | null;
  schedulerRunning: boolean;
}

/** POST /api/verse/automations/<id>/fire  { dryRun?, repo?, text?, title? } */
export interface AutomationFireRequest {
  dryRun?: boolean;
  repo?: string;
  title?: string;
  text?: string;
}

export interface AutomationPlannedTask {
  dedupeKey: string;
  repo: string;
  title: string;
  lane: AutomationLane;
  /** What would happen: `dispatch`, `queue`, `dedupe`, `drop`, `defer: <reason>`. */
  verdict: string;
}

export interface AutomationFireResponse {
  ok: boolean;
  dryRun: boolean;
  planned: AutomationPlannedTask[];
  firings: AutomationFiringV1[];
  error: string | null;
}

/** POST /api/verse/automations/<id>/webhook  — a local tool (n8n, a Linear bridge) hands over work. */
export interface AutomationWebhookRequest {
  repo?: string;
  title?: string;
  text: string;
  /** Caller's idempotency key (e.g. the Linear issue id). */
  key?: string;
  /** https link back to the source. */
  url?: string;
}
