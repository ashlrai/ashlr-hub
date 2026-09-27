/**
 * Devin lane (3.15) — FROZEN CONTRACTS.
 *
 * Ashlr Verse launches Devin (Cognition) sessions through the Devin REST API
 * and tracks what they deliver, exactly like the Claude cloud lane
 * (cloud/types.ts): every task is told to DELIVER to GitHub — push branch
 * `ashlr-devin/<taskId>` and open a PR against the repo's default branch whose
 * body ends with a fenced `ashlr-devin-report` JSON block. GitHub is the only
 * channel the gates trust; the Devin API is read for session status, ACU
 * usage and a PR hint.
 *
 * API surface (verified 2026-09-27 against the official docs; nothing else is
 * called):
 *   Base URL   https://api.devin.ai/v3
 *              https://docs.devin.ai/api-reference/overview
 *   Auth       `Authorization: Bearer cog_…` — a service-user API key or a
 *              personal access token (both `cog_`; legacy `apk_` keys are v1/v2
 *              only and are refused by v3).
 *              https://docs.devin.ai/api-reference/authentication
 *   GET    /v3/self                                              who the key is (+ org_id, null for org-scoped service users)
 *              https://docs.devin.ai/api-reference/v3/self/self
 *   POST   /v3/organizations/{org_id}/sessions                   create a session (SessionCreateRequest → SessionResponse)
 *              https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions
 *   GET    /v3/organizations/{org_id}/sessions/{devin_id}        one session (SessionResponse)
 *              https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session
 *   GET    /v3/organizations/{org_id}/sessions?first=&after=     list (PaginatedResponse[SessionResponse], cursor-based)
 *              https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions
 *              https://docs.devin.ai/api-reference/concepts/pagination
 *   POST   /v3/organizations/{org_id}/sessions/{devin_id}/messages   send a message (auto-resumes a suspended session)
 *              https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages
 *   Schemas: https://docs.devin.ai/v3-openapi.yaml
 *
 * Rate limits: the docs name `429 Too Many Requests` but publish no numbers
 * or Retry-After contract (https://docs.devin.ai/api-reference/overview#error-handling),
 * so the client backs off on 429/5xx and honours a Retry-After header only
 * when one is present and sane.
 *
 * ACUs: `acus_consumed` on SessionResponse is the per-session usage. The docs
 * publish no dollar price per ACU for self-serve plans
 * (https://docs.devin.ai/admin/billing/self-serve), so dollars are an ESTIMATE
 * the operator calibrates; the budget itself is kept in ACUs.
 *
 * Nothing here merges. A Devin PR is judged and merged by the standing gates
 * (fleet/cloud-intake.ts → standing pass) or by Mason — never by this lane.
 */
import type { CloudDeliveryPin, CloudIntakeMemo, CloudSupersededBy, CloudTaskPr, CloudTaskReport } from '../cloud/types.js';
import type { FleetReadinessVerdict, ReadinessVerdict } from '../routing/readiness-types.js';
import type { PlaybookRef } from '../playbooks/types.js';

export const DEVIN_TASK_SCHEMA_VERSION = 1 as const;
export const DEVIN_BUDGET_SCHEMA_VERSION = 1 as const;
export const DEVIN_CONNECTION_SCHEMA_VERSION = 1 as const;

/** https://docs.devin.ai/api-reference/overview — "Base URL: https://api.devin.ai/v3/organizations/*". */
export const DEVIN_API_BASE_URL = 'https://api.devin.ai/v3' as const;
/** Where the operator creates a key and finds the org id (Settings > Devin API). */
export const DEVIN_SETTINGS_URL = 'https://app.devin.ai/settings' as const;
/** Where real usage lives (Settings > Usage & limits). https://docs.devin.ai/admin/billing/usage */
export const DEVIN_USAGE_URL = 'https://app.devin.ai/settings/usage' as const;

/** Branch every Devin task delivers to: `ashlr-devin/<taskId>`. */
export const DEVIN_BRANCH_PREFIX = 'ashlr-devin/' as const;
/** Fenced block language tag carrying the task report in the PR body. */
export const DEVIN_REPORT_FENCE = 'ashlr-devin-report' as const;
/** PR title prefix, so tasks are recognisable in GitHub lists. */
export const DEVIN_PR_TITLE_PREFIX = '[ashlr-devin]' as const;
/** Tag put on every session Verse creates (SessionCreateRequest.tags). */
export const DEVIN_SESSION_TAG = 'ashlr-verse' as const;
/** A task with no PR after this long is marked `expired` (the session link still works). */
export const DEVIN_TASK_EXPIRY_MS = 12 * 60 * 60 * 1000;
/** Max prompt length accepted from any entry point (chars). */
export const DEVIN_PROMPT_MAX_CHARS = 20_000;

/** Task ids look like `dv_20260927T0412_k3f9q2` (sortable, branch-safe, never a `ct_` cloud id). */
export const DEVIN_TASK_ID_PATTERN = /^dv_\d{8}T\d{4}_[a-z0-9]{6}$/;
/** Devin session ids (docs: "Devin session ID (prefix: devin-)"). Tolerant of the body, strict on the charset. */
export const DEVIN_SESSION_ID_PATTERN = /^devin-[A-Za-z0-9_-]{1,120}$/;
/** Organization ids (docs: "Organization ID (prefix: org-)"). */
export const DEVIN_ORG_ID_PATTERN = /^org-[A-Za-z0-9_-]{1,120}$/;
/** v3 credentials: "All API credentials use the `cog_` prefix format." */
export const DEVIN_KEY_PATTERN = /^cog_[A-Za-z0-9_-]{8,512}$/;

export type DevinTaskOrigin = 'chat' | 'operator' | 'cli' | 'fleet';

/**
 * queued     accepted and persisted; the API call has not returned yet.
 * launching  create-session call in flight.
 * running    session created; working, no PR yet.
 * blocked    Devin is waiting (for the operator, an approval, or credits) —
 *            Needs-you links the session; a message resumes it.
 * pr-open    a PR on `ashlr-devin/<id>` against the base was verified on GitHub.
 * merged     PR merged (by the gates or Mason).
 * closed     PR closed without merge (or dismissed by the operator).
 * failed     the launch or the session failed.
 * expired    the session finished (or DEVIN_TASK_EXPIRY_MS passed) with no PR.
 */
export type DevinTaskState = 'queued' | 'launching' | 'running' | 'blocked' | 'pr-open' | 'merged' | 'closed' | 'failed' | 'expired';

export const DEVIN_TERMINAL_STATES: readonly DevinTaskState[] = ['merged', 'closed', 'failed', 'expired'];

export type DevinFailureCode =
  | 'not-enabled'     // devin.enabled is off
  | 'not-connected'   // no key in custody / Keychain, or no org id
  | 'auth'            // 401: key invalid, expired or revoked
  | 'forbidden'       // 403: the key's role can't create sessions in this org
  | 'rate-limited'    // 429 after retries
  | 'budget'          // refused by the Devin budget before launching
  | 'invalid-request' // 400/404/409/422 — the API refused the request itself
  | 'server'          // 5xx after retries
  | 'network'         // unreachable / timed out
  | 'unparsed'        // the API answered with a shape the docs don't describe
  | 'session-error'   // the session itself ended in `error`
  | 'unknown';

/** Session status as the API reports it (SessionResponse.status). */
export type DevinSessionStatus = 'new' | 'claimed' | 'running' | 'exit' | 'error' | 'suspended' | 'resuming';

/** Last-read session facts (SessionResponse, reduced). Never the prompt, never messages. */
export interface DevinSessionSnapshot {
  status: DevinSessionStatus;
  /** SessionResponse.status_detail (e.g. working, waiting_for_user, finished, out_of_credits) or null. */
  statusDetail: string | null;
  /** null when the API omitted it — the budget then counts the session's full cap (fail closed). */
  acusConsumed: number | null;
  /** PRs Devin itself reports (pull_requests[].pr_url) — a HINT; GitHub decides. */
  prUrls: string[];
  readAt: string;
}

export interface DevinTaskV1 {
  v: typeof DEVIN_TASK_SCHEMA_VERSION;
  id: string;
  /** GitHub `owner/name`. */
  repo: string;
  /** Default branch the session starts from and the PR targets. */
  baseBranch: string;
  /** Always `${DEVIN_BRANCH_PREFIX}${id}`. */
  branch: string;
  title: string;
  /** The operator's task text — WITHOUT the delivery contract. */
  prompt: string;
  origin: DevinTaskOrigin;
  requestedBy: 'mason' | 'fleet';
  sessionId: string | null;
  sessionUrl: string | null;
  state: DevinTaskState;
  /** Plain-language reason for the current state (never raw ISO / paths / keys). */
  stateReason: string | null;
  failure: DevinFailureCode | null;
  createdAt: string;
  launchedAt: string | null;
  updatedAt: string;
  /** Last session read, or null before the first poll. */
  session: DevinSessionSnapshot | null;
  /** Hard cap sent as SessionCreateRequest.max_acu_limit. */
  maxAcu: number;
  /** SessionCreateRequest.devin_mode, pinned at launch; the intake signs `devin:<mode>`. */
  devinMode: 'normal' | 'fast' | 'lite' | 'ultra';
  /** Same shapes as the cloud lane so the shared PR triage / intake read both. */
  pr: CloudTaskPr | null;
  /** Head SHA GitHub reported for the verified PR at the last refresh (40 hex) or null. */
  headSha: string | null;
  report: CloudTaskReport | null;
  deliveryPin?: CloudDeliveryPin;
  supersededBy?: CloudSupersededBy;
  intake?: CloudIntakeMemo;
  /** 3.15: the playbook version this task runs under (playbooks/); absent = none. */
  playbookRef?: PlaybookRef;
  /** Backlog / fleet work item this task came from, if any. */
  backlogItemId: string | null;
  /**
   * 3.15: messages Mason sent to the session from Verse (messageDevinTask).
   * Absent on tasks written before 3.15 (read as 0). A count only — the
   * message text is never stored.
   */
  messagesSent?: number;
}

export interface DevinBudgetV1 {
  v: typeof DEVIN_BUDGET_SCHEMA_VERSION;
  /** ACUs the operator allots Verse for the current cycle (default 50). */
  acuBudgetTotal: number;
  /** Operator calibration: ACUs already used outside what Verse tracks. */
  acuSpentAdjustment: number;
  /** ESTIMATE only — the docs publish no $/ACU for self-serve plans. */
  usdPerAcu: number;
  /** Hard per-session cap sent to Devin as max_acu_limit (default 10). */
  maxAcuPerSession: number;
  /** Launches stop when today's used + in-flight headroom would pass this. */
  maxAcuPerDay: number;
  /** ACUs kept for the operator: fleet launches stop before the remainder falls below this. */
  reserveAcu: number;
  /** Every launch pauses once this fraction of acuBudgetTotal is used (0.5–1). */
  pauseAtFraction: number;
  maxConcurrent: number;
  maxSessionsPerDay: number;
  /**
   * 3.15 fleet launcher: at most this many FLEET-launched sessions in flight
   * at once (default 1). Mason's own sessions (chat / CLI / operator) never
   * count against it — only against the ACU budget itself.
   */
  fleetMaxConcurrent: number;
  /** 3.15 fleet launcher: at most this many fleet-launched sessions per local day (default 3). 0 = none. */
  fleetMaxSessionsPerDay: number;
  updatedAt: string;
}

export const DEFAULT_DEVIN_BUDGET: Omit<DevinBudgetV1, 'updatedAt'> = Object.freeze({
  v: DEVIN_BUDGET_SCHEMA_VERSION,
  acuBudgetTotal: 50,
  acuSpentAdjustment: 0,
  usdPerAcu: 2.25,
  maxAcuPerSession: 10,
  maxAcuPerDay: 30,
  reserveAcu: 10,
  pauseAtFraction: 0.9,
  maxConcurrent: 2,
  maxSessionsPerDay: 10,
  fleetMaxConcurrent: 1,
  fleetMaxSessionsPerDay: 3,
});

export interface DevinGate {
  ok: boolean;
  reason: string | null;
}

export interface DevinBudgetView {
  acuBudgetTotal: number;
  acuUsed: number;
  acuRemaining: number;
  acuToday: number;
  /** Headroom still reserved by sessions in flight (their cap minus what they used). */
  acuInFlight: number;
  estimatedUsdUsed: number;
  sessionsToday: number;
  running: number;
  /** Paused at the threshold (pauseAtFraction). */
  paused: boolean;
  /** 3.15: fleet-launched sessions in flight / launched today (subsets of running / sessionsToday). */
  fleetRunning: number;
  fleetSessionsToday: number;
  canLaunch: DevinGate;
  /** The fleet's gate: canLaunch plus the operator's reserve and the fleet's own concurrency / daily caps. */
  canFleetLaunch: DevinGate;
  estimateNote: string;
  usageUrl: typeof DEVIN_USAGE_URL;
  budget: DevinBudgetV1;
}

/** Non-secret connection facts (`<ashlr home>/devin/connection.json`). The key never lives here. */
export interface DevinConnectionV1 {
  v: typeof DEVIN_CONNECTION_SCHEMA_VERSION;
  orgId: string;
  principal: 'service_user' | 'pat_user' | 'other';
  /** Display name the API reported for the key's principal (service_user_name / user_name). */
  principalName: string | null;
  /** Where the key is held: 'custody' (ashlr custody daemon) or 'keychain' (macOS login keychain). */
  keyStore: 'custody' | 'keychain';
  connectedAt: string;
  updatedAt: string;
}

export type DevinConnectionState = 'disabled' | 'not-connected' | 'ready' | 'unreachable';

export interface DevinStatus {
  enabled: boolean;
  connected: boolean;
  state: DevinConnectionState;
  /** Plain sentence for the card / CLI. */
  reason: string;
  orgId: string | null;
  principal: DevinConnectionV1['principal'] | null;
  principalName: string | null;
  keyStore: DevinConnectionV1['keyStore'] | null;
  /** "Chat: n/a — Devin works in sessions" (always). */
  chatLine: string;
  /** "Fleet: ready" or "Fleet: … — why". */
  fleetLine: string;
  fleetReady: boolean;
  /** The same verdict shapes the Resources drawer renders for every resource (routing/readiness-types.ts). */
  chat: ReadinessVerdict;
  fleet: FleetReadinessVerdict;
}

// ---------------------------------------------------------------------------
// HTTP contract — mounted as the 'devin' module (verse-api.ts)
// ---------------------------------------------------------------------------

export const VERSE_DEVIN_PATH = '/api/verse/devin' as const;
export const VERSE_DEVIN_LAUNCH_PATH = '/api/verse/devin/launch' as const;
export const VERSE_DEVIN_BUDGET_PATH = '/api/verse/devin/budget' as const;
export const VERSE_DEVIN_REFRESH_PATH = '/api/verse/devin/refresh' as const;
/** POST `${VERSE_DEVIN_TASKS_PATH}/<id>/dismiss` */
export const VERSE_DEVIN_TASKS_PATH = '/api/verse/devin/tasks' as const;

/** GET /api/verse/devin */
export interface DevinOverviewResponse {
  generatedAt: string;
  status: DevinStatus;
  budget: DevinBudgetView;
  /** Newest first, at most 100. */
  tasks: DevinTaskV1[];
}

/** POST /api/verse/devin/launch (write token + read session) */
export interface DevinLaunchRequest {
  repo: string;
  baseBranch?: string;
  title?: string;
  prompt: string;
  origin: Extract<DevinTaskOrigin, 'chat' | 'operator' | 'cli'>;
  /** 3.15: a playbook to run under — `id`, `!macro` or `id@v3` (in-process callers; the CLI). */
  playbook?: string;
}

export interface DevinLaunchResponse {
  ok: boolean;
  task: DevinTaskV1 | null;
  error: string | null;
  failure: DevinFailureCode | null;
}

/** POST /api/verse/devin/budget — any subset; validated and clamped. */
export type DevinBudgetUpdate = Partial<Pick<DevinBudgetV1,
  'acuBudgetTotal' | 'acuSpentAdjustment' | 'usdPerAcu' | 'maxAcuPerSession' | 'maxAcuPerDay' | 'reserveAcu' | 'pauseAtFraction'
  | 'maxConcurrent' | 'maxSessionsPerDay' | 'fleetMaxConcurrent' | 'fleetMaxSessionsPerDay'>>;
