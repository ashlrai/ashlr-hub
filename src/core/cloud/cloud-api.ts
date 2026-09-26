/**
 * Cloud lane HTTP module (3.11, unit C2) — mounted as 'cloud' in verse-api.ts.
 *
 *   GET  /api/verse/cloud                     → CloudOverviewResponse
 *   POST /api/verse/cloud/launch              CloudLaunchRequest → CloudLaunchResponse
 *                                              (200 launched; 409 refused or failed, same body)
 *   POST /api/verse/cloud/budget              CloudBudgetUpdate → CloudBudgetView
 *   POST /api/verse/cloud/refresh             {} → { checked, updated }
 *   POST /api/verse/cloud/improve             CloudImproveRequest → CloudImproveResponse
 *   POST /api/verse/cloud/tasks/<id>/dismiss  {} → { ok: true, task }
 *   GET  /api/verse/cloud/previews            → CloudPrPreviewsResponse (pr-preview.ts)
 *   POST /api/verse/cloud/tasks/<id>/land           { headSha } → { ok: true, task, message }
 *   POST /api/verse/cloud/tasks/<id>/close          { headSha } → { ok: true, task, message }
 *   POST /api/verse/cloud/tasks/<id>/update-branch  { headSha } → { ok: true, task, message }
 *                                              (409 refused / moved, 502 GitHub unreachable; body { error })
 *
 * Posture matches every Verse module (budget-api.ts): GETs sit behind the
 * read-session boundary in server.ts; every POST is 404 unless the server
 * allows dispatch, then the constant-time mutation token + JSON Content-Type
 * gate, then a bounded body. Bodies and queries are STRICT — an unknown key
 * is a 400 with a plain sentence, never ignored. Every response goes through
 * sendJson() → sanitizePublicJson() (home → `~`, secret-shaped text
 * scrubbed); errors from the service are never forwarded verbatim, because
 * their messages can carry checkout paths.
 *
 * NOTHING HERE MERGES ON ITS OWN. Dismiss only marks the local task record
 * `closed`, and refresh is the tracker's read-only `gh pr list`. The three
 * triage routes (3.13) act on GitHub only when the operator asks, with the
 * mutation token, on the exact head SHA they saw (pr-actions.ts).
 *
 * Also owned here (spec C2):
 *   - the BACKGROUND SCHEDULER, started on this module's first load (never
 *     under a test runner; ASHLR_CLOUD_AUTO=0 turns it off): refresh every
 *     10 min, self-improvement 2 min after start and then hourly;
 *   - the Needs-you producer `needsYouItems()` that activity-api.ts merges:
 *     PR-open tasks ("ready for review") and launches that failed in the last
 *     24 h. Pure and served from a cache refreshed off the caller's stack. A
 *     PR-open item carries the gates' preview of its PR (pr-preview.ts) and,
 *     once previewed, Land / Close / Update branch.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiModule } from '../verse/api-modules.js';
import type { VerseApiContext } from '../verse/verse-api.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  isNeedsYouItem,
  NEEDS_YOU_DETAIL_MAX,
  NEEDS_YOU_TITLE_MAX,
  type NeedsYouAction,
  type NeedsYouItem,
} from '../verse/workbench-types.js';
import { cloudBudgetView } from './budget.js';
import { cloudOverview, launchCloudTask, runSelfImprove } from './service.js';
import { listCloudTasks, readCloudTask, updateCloudBudget, writeCloudTask } from './store.js';
import { refreshCloudTasks } from './tracker.js';
import {
  cachedCloudPrPreviews,
  closeCloudPr,
  cloudPrPreviewsStale,
  HEAD_SHA_PATTERN,
  landCloudPr,
  refreshCloudPrPreviews,
  updateCloudPrBranch,
  type CloudPrActionDeps,
  type CloudPrActionResult,
} from './pr-actions.js';
import { VERSE_CLOUD_PREVIEWS_PATH, type CloudPrPreview, type CloudPrPreviewsResponse } from './pr-preview.js';
import {
  CLOUD_TASK_ID_PATTERN,
  VERSE_CLOUD_BUDGET_PATH,
  VERSE_CLOUD_IMPROVE_PATH,
  VERSE_CLOUD_LAUNCH_PATH,
  VERSE_CLOUD_PATH,
  VERSE_CLOUD_REFRESH_PATH,
  VERSE_CLOUD_TASKS_PATH,
  type CloudBudgetUpdate,
  type CloudBudgetV1,
  type CloudImproveResponse,
  type CloudLaunchRequest,
  type CloudTaskV1,
} from './types.js';

// ---------------------------------------------------------------------------
// Input validation (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Same shape the service validates (spec C1); checked here too so bad input is a 400, not a failed task. */
export const CLOUD_REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/**
 * A conservative git branch name: what `git check-ref-format --branch`
 * accepts minus the exotic parts. The session clones this branch, so a
 * typo'd or hostile name must stop at the door, not in a PTY.
 */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** Launch bodies carry a prompt of up to CLOUD_PROMPT_MAX_CHARS (20 000) chars — up to 80 KB of UTF-8. */
const LAUNCH_BODY_MAX_BYTES = 128 * 1024;
const SMALL_BODY_MAX_BYTES = 4 * 1024;
const TITLE_MAX = 200;
const IMPROVE_MAX_COUNT = 5;
/** Budget figures above this are typos, not budgets ($1M of credits, a million sessions). */
const BUDGET_NUMBER_MAX = 1_000_000;

const LAUNCH_KEYS: ReadonlySet<string> = new Set(['repo', 'baseBranch', 'title', 'prompt', 'origin']);
const LAUNCH_ORIGINS: readonly CloudLaunchRequest['origin'][] = ['chat', 'operator', 'cli'];
const BUDGET_NUMBER_KEYS = ['creditsTotalUsd', 'creditsSpentAdjustmentUsd', 'estimatedCostPerSessionUsd'] as const;
const BUDGET_COUNT_KEYS = ['maxConcurrent', 'maxSessionsPerDay'] as const;
const BUDGET_KEYS: ReadonlySet<string> = new Set([...BUDGET_NUMBER_KEYS, ...BUDGET_COUNT_KEYS, 'selfImprove']);
const SELF_IMPROVE_KEYS: ReadonlySet<string> = new Set(['enabled', 'repo', 'maxPerDay', 'reserveUsd', 'maxOpenPrs']);

export class CloudInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>, where = ''): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new CloudInputError(`Unknown field ${where}${key}.`);
  }
}

export function isValidCloudRepo(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && CLOUD_REPO_PATTERN.test(value);
}

export function isValidBranchName(value: unknown): value is string {
  return typeof value === 'string'
    && BRANCH_RE.test(value)
    && !value.includes('..')
    && !value.includes('//')
    && !value.endsWith('/')
    && !value.endsWith('.')
    && !value.endsWith('.lock');
}

/** Strict parse of a launch body; throws CloudInputError with a plain sentence. `origin` defaults to operator. */
export function parseCloudLaunchBody(body: Record<string, unknown>): CloudLaunchRequest {
  rejectUnknownKeys(body, LAUNCH_KEYS);
  const { repo, baseBranch, title, prompt, origin } = body;
  if (!isValidCloudRepo(repo)) throw new CloudInputError('Repo must look like owner/name.');
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new CloudInputError('Describe the task to run.');
  const out: CloudLaunchRequest = { repo, prompt, origin: 'operator' };
  if (baseBranch !== undefined) {
    if (!isValidBranchName(baseBranch)) throw new CloudInputError('Base branch is not a valid branch name.');
    out.baseBranch = baseBranch;
  }
  if (title !== undefined) {
    if (typeof title !== 'string' || title.length > TITLE_MAX) {
      throw new CloudInputError(`Title must be text of at most ${TITLE_MAX} characters.`);
    }
    if (title.trim().length > 0) out.title = title.trim();
  }
  if (origin !== undefined) {
    if (!(LAUNCH_ORIGINS as readonly unknown[]).includes(origin)) {
      throw new CloudInputError(`Origin must be one of: ${LAUNCH_ORIGINS.join(', ')}.`);
    }
    out.origin = origin as CloudLaunchRequest['origin'];
  }
  return out;
}

function budgetNumber(key: string, value: unknown, whole: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CloudInputError(`${key} must be a number.`);
  if (value < 0) throw new CloudInputError(`${key} can't be negative.`);
  if (value > BUDGET_NUMBER_MAX) throw new CloudInputError(`${key} is too large.`);
  if (whole && !Number.isInteger(value)) throw new CloudInputError(`${key} must be a whole number.`);
  return value;
}

/**
 * Strict parse of a budget update: types and signs only. Clamping to sane
 * maxima is the store's job (updateCloudBudget), so the two never disagree
 * about what "sane" means.
 */
export function parseCloudBudgetBody(body: Record<string, unknown>): CloudBudgetUpdate {
  rejectUnknownKeys(body, BUDGET_KEYS);
  const out: CloudBudgetUpdate = {};
  for (const key of BUDGET_NUMBER_KEYS) {
    if (body[key] !== undefined) out[key] = budgetNumber(key, body[key], false);
  }
  for (const key of BUDGET_COUNT_KEYS) {
    if (body[key] !== undefined) out[key] = budgetNumber(key, body[key], true);
  }
  if (body['selfImprove'] !== undefined) {
    const raw = body['selfImprove'];
    if (!isRecord(raw)) throw new CloudInputError('selfImprove must be an object.');
    rejectUnknownKeys(raw, SELF_IMPROVE_KEYS, 'selfImprove.');
    const self: Partial<CloudBudgetV1['selfImprove']> = {};
    if (raw['enabled'] !== undefined) {
      if (typeof raw['enabled'] !== 'boolean') throw new CloudInputError('selfImprove.enabled must be true or false.');
      self.enabled = raw['enabled'];
    }
    if (raw['repo'] !== undefined) {
      if (!isValidCloudRepo(raw['repo'])) throw new CloudInputError('selfImprove.repo must look like owner/name.');
      self.repo = raw['repo'];
    }
    if (raw['maxPerDay'] !== undefined) self.maxPerDay = budgetNumber('selfImprove.maxPerDay', raw['maxPerDay'], true);
    if (raw['reserveUsd'] !== undefined) self.reserveUsd = budgetNumber('selfImprove.reserveUsd', raw['reserveUsd'], false);
    if (raw['maxOpenPrs'] !== undefined) self.maxOpenPrs = budgetNumber('selfImprove.maxOpenPrs', raw['maxOpenPrs'], true);
    if (Object.keys(self).length > 0) out.selfImprove = self;
  }
  if (Object.keys(out).length === 0) throw new CloudInputError('Nothing to update.');
  return out;
}

export function parseCloudImproveBody(body: Record<string, unknown>): { count: number } {
  rejectUnknownKeys(body, new Set(['count']));
  const count = body['count'];
  if (count === undefined) return { count: 1 };
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > IMPROVE_MAX_COUNT) {
    throw new CloudInputError(`Count must be a whole number from 1 to ${IMPROVE_MAX_COUNT}.`);
  }
  return { count };
}

/** Strict body of land / close / update-branch: exactly the head commit the operator saw. */
export function parseCloudPrActionBody(body: Record<string, unknown>): { headSha: string } {
  rejectUnknownKeys(body, new Set(['headSha']));
  const headSha = body['headSha'];
  if (typeof headSha !== 'string' || !HEAD_SHA_PATTERN.test(headSha)) {
    throw new CloudInputError('headSha must be the full 40-character head commit you reviewed.');
  }
  return { headSha };
}

// ---------------------------------------------------------------------------
// Dismiss (local record only — never GitHub)
// ---------------------------------------------------------------------------

export const CLOUD_DISMISS_REASON = 'Dismissed in Verse.';

export type CloudDismissResult =
  | { ok: true; task: CloudTaskV1 }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Mark a task `closed` with "Dismissed in Verse." — idempotent for a task
 * already closed. Refused for a MERGED task (closing it would rewrite what
 * happened) and while a launch is still in flight (the service would then
 * overwrite the dismissal with `running`).
 */
export function dismissCloudTask(id: string, now: Date = new Date()): CloudDismissResult {
  const task = readCloudTask(id);
  if (!task) return { ok: false, status: 404, error: 'No cloud task with that id.' };
  if (task.state === 'closed') return { ok: true, task };
  if (task.state === 'merged') return { ok: false, status: 409, error: 'This task was merged; there is nothing to dismiss.' };
  if (task.state === 'queued' || task.state === 'launching') {
    return { ok: false, status: 409, error: 'This task is still launching. Try again in a minute.' };
  }
  const next: CloudTaskV1 = { ...task, state: 'closed', stateReason: CLOUD_DISMISS_REASON, updatedAt: now.toISOString() };
  writeCloudTask(next);
  return { ok: true, task: next };
}

// ---------------------------------------------------------------------------
// Needs-you producer
// ---------------------------------------------------------------------------

/** Failed launches stay in Needs-you this long (spec C2). */
export const CLOUD_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The cache behind needsYouItems() is rebuilt, off the caller's stack, when older than this. */
const NEEDS_YOU_CACHE_MS = 15_000;
/** Newest tasks considered for Needs-you — PR-open and fresh failures are always among recent ones. */
const NEEDS_YOU_TASK_SCAN = 200;

function clip(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function taskTitle(task: CloudTaskV1): string {
  const t = clip(task.title ?? '', 80);
  return t.length > 0 ? t : 'Untitled cloud task';
}

function dismissAction(task: CloudTaskV1, confirmFirst: boolean): NeedsYouAction {
  return {
    kind: 'done',
    label: 'Dismiss',
    request: { method: 'POST', path: `${VERSE_CLOUD_TASKS_PATH}/${task.id}/dismiss`, body: {} },
    confirm: confirmFirst
      ? {
        title: 'Stop tracking this cloud task?',
        body: 'Verse marks it closed. The pull request on GitHub is not touched.',
        confirmLabel: 'Dismiss',
      }
      : null,
    destructive: false,
  };
}

function taskRoute(task: CloudTaskV1, verb: 'land' | 'close' | 'update-branch', headSha: string): NeedsYouAction['request'] {
  return { method: 'POST', path: `${VERSE_CLOUD_TASKS_PATH}/${task.id}/${verb}`, body: { headSha } };
}

/** Land / Close / Update branch for a previewed PR, pinned to the previewed head. */
export function triageActions(task: CloudTaskV1, preview: CloudPrPreview): NeedsYouAction[] {
  const n = preview.prNumber;
  const sha7 = preview.headSha.slice(0, 7);
  const out: NeedsYouAction[] = [];
  if (preview.landable.ok) {
    out.push({
      kind: 'approve',
      label: 'Land',
      request: taskRoute(task, 'land', preview.headSha),
      confirm: {
        title: `Land #${n} on ${preview.baseBranch}?`,
        body: clip(`${preview.reason} Squash-merges exactly ${sha7}; GitHub refuses if the branch has moved.`, NEEDS_YOU_DETAIL_MAX),
        confirmLabel: 'Land',
      },
      destructive: false,
    });
  }
  out.push({
    kind: 'reject',
    label: 'Close',
    request: taskRoute(task, 'close', preview.headSha),
    confirm: {
      title: `Close #${n} without landing?`,
      body: 'Closes the pull request on GitHub with a short comment. The branch is kept.',
      confirmLabel: 'Close PR',
    },
    destructive: true,
  });
  if (preview.behind) {
    out.push({
      kind: 'fix',
      label: 'Update branch',
      request: taskRoute(task, 'update-branch', preview.headSha),
      confirm: null,
      destructive: false,
    });
  }
  return out;
}

function isoOr(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback;
}

/**
 * PURE: the Needs-you items for `tasks` at `now`.
 *
 * WHY THESE SOURCES AND KINDS: the Needs-you contract (workbench-types.ts
 * §2) has a closed set of sources and kinds, and the web drawer and the
 * desktop shell switch on both exhaustively, so a new one is not additive.
 * A cloud PR is exactly an `owner-lane-pr` — a PR that is never merged
 * automatically and waits for Mason — filed under `fleet`, the source the
 * drawer already reads for that kind. A failed launch is a failed piece of
 * work the operator started (often from a chat's "Run in cloud"), so it is a
 * `chats` / `chat-failed` item with no session to open.
 *
 * TRIAGE (3.13) maps onto the kinds the drawer already knows, so the
 * contract does not change: approve = Land, reject = Close, fix = Update
 * branch, done = Dismiss. They appear only once the PR has a preview (it
 * carries the head SHA every action is pinned to); Land only when the
 * preview says Land would not be refused; Update branch only when behind.
 */
export function cloudNeedsYouItems(
  tasks: readonly CloudTaskV1[],
  now: Date,
  previews: ReadonlyMap<string, CloudPrPreview> = new Map(),
): NeedsYouItem[] {
  const nowIso = now.toISOString();
  const out: NeedsYouItem[] = [];
  for (const task of tasks) {
    let item: NeedsYouItem | null = null;
    if (task.state === 'pr-open' && task.pr) {
      const report = task.report;
      const summary = report ? `Cloud session reports (unverified): ${scrubSecrets(report.summary)}` : 'No report yet: the pull request has no ashlr-cloud-report block.';
      const status = report && report.status !== 'done' ? ` (${report.status})` : '';
      // Only a preview of THIS pull request counts: its number is the task's pinned one.
      const cached = previews.get(task.id);
      const preview = cached && cached.prNumber === task.pr.number && cached.open ? cached : null;
      item = {
        id: `fleet:owner-lane-pr:cloud-${task.id}`,
        source: 'fleet',
        kind: 'owner-lane-pr',
        severity: 'info',
        title: clip(`Cloud task ready for review: ${taskTitle(task)}`, NEEDS_YOU_TITLE_MAX),
        detail: clip(preview ? `${preview.reason} ${summary}${status}` : `${summary}${status}`, NEEDS_YOU_DETAIL_MAX) || null,
        since: isoOr(task.updatedAt, nowIso),
        expiresAt: null,
        subject: { repo: task.repo, pr: task.pr.number, seatId: null, sessionId: null, engine: 'claude' },
        target: { kind: 'url', url: task.pr.url },
        actions: preview ? [...triageActions(task, preview), dismissAction(task, true)] : [dismissAction(task, true)],
      };
    } else if (task.state === 'failed') {
      const at = Date.parse(task.updatedAt);
      if (Number.isNaN(at) || now.getTime() - at > CLOUD_FAILED_WINDOW_MS) continue;
      const reason = task.stateReason ? scrubSecrets(task.stateReason) : 'The cloud session could not be started.';
      item = {
        id: `chats:chat-failed:cloud-${task.id}`,
        source: 'chats',
        kind: 'chat-failed',
        severity: 'warn',
        title: clip(`Cloud launch failed: ${taskTitle(task)}`, NEEDS_YOU_TITLE_MAX),
        detail: clip(reason, NEEDS_YOU_DETAIL_MAX) || null,
        since: isoOr(task.updatedAt, nowIso),
        expiresAt: new Date(at + CLOUD_FAILED_WINDOW_MS).toISOString(),
        subject: { repo: task.repo, pr: null, seatId: null, sessionId: null, engine: 'claude' },
        target: { kind: 'section', section: 'command', anchor: 'cloud' },
        actions: [dismissAction(task, false)],
      };
    }
    // The same boundary activity applies to Track B producers: a task record
    // with a non-https PR url or a malformed time never reaches the drawer.
    if (item && isNeedsYouItem(item)) out.push(item);
  }
  return out;
}

let needsYouCache: { at: number; items: NeedsYouItem[] } | null = null;
let needsYouPending = false;
let needsYouReadTasks: () => readonly CloudTaskV1[] = () => listCloudTasks(NEEDS_YOU_TASK_SCAN);

/** Injected `gh` / policy for the triage routes and previews (tests); {} = production. */
let prActionDeps: CloudPrActionDeps = {};
/**
 * Previews read GitHub (`gh`, read-only) off the request path. Never from a
 * test process unless a test injected its own `gh` — the same rule as the
 * scheduler, for the same reason.
 */
let autoPreview = !(process.env['VITEST'] || process.env['NODE_ENV'] === 'test');
/** A preview sweep starts at most this often, so an unreachable GitHub is not hammered on every rebuild. */
const PREVIEW_RETRY_MS = 60_000;
let lastPreviewStartedAt = Number.NEGATIVE_INFINITY;

function maybeRefreshPreviews(tasks: readonly CloudTaskV1[]): void {
  if (!autoPreview) return;
  const now = Date.now();
  if (now - lastPreviewStartedAt < PREVIEW_RETRY_MS || !cloudPrPreviewsStale(tasks, now)) return;
  lastPreviewStartedAt = now;
  void guarded('preview', () => refreshCloudPrPreviews(tasks, prActionDeps)).catch(() => undefined);
}

function rebuildNeedsYou(): void {
  try {
    const tasks = needsYouReadTasks();
    needsYouCache = { at: Date.now(), items: cloudNeedsYouItems(tasks, new Date(), cachedCloudPrPreviews()) };
    maybeRefreshPreviews(tasks);
  } catch {
    // Keep the last good answer: a transient store error must not flash an
    // empty drawer. Stamp it so the next rebuild waits a cache period.
    needsYouCache = { at: Date.now(), items: needsYouCache?.items ?? [] };
  }
}

function scheduleNeedsYouRebuild(): void {
  if (needsYouPending) return;
  needsYouPending = true;
  setImmediate(() => {
    needsYouPending = false;
    rebuildNeedsYou();
  });
}

/**
 * Needs-you producer (activity-api.ts calls it on every poll). Returns the
 * cached items in O(1) and, when the cache is stale, rebuilds it on a later
 * tick — the task store is file I/O and never runs on the poll's stack. The
 * first call answers [] (cloud items are additive to sources that vouch for
 * themselves) and has the real answer ready for the next poll.
 */
export function needsYouItems(): NeedsYouItem[] {
  if (!needsYouCache || Date.now() - needsYouCache.at >= NEEDS_YOU_CACHE_MS) scheduleNeedsYouRebuild();
  return needsYouCache ? [...needsYouCache.items] : [];
}

/** After a mutation: the next poll should see it without waiting out the cache. */
function invalidateNeedsYou(): void {
  if (needsYouCache) needsYouCache = { ...needsYouCache, at: 0 };
  scheduleNeedsYouRebuild();
}

/** Test seam: replace the task reader (null restores) and drop the cache. */
export function setCloudNeedsYouReaderForTest(read: (() => readonly CloudTaskV1[]) | null): void {
  needsYouReadTasks = read ?? (() => listCloudTasks(NEEDS_YOU_TASK_SCAN));
  needsYouCache = null;
  needsYouPending = false;
}

/** Test seam: the triage routes' and previews' `gh` / policy (null restores production and turns auto-preview off). */
export function setCloudPrActionDepsForTest(deps: CloudPrActionDeps | null, opts: { autoPreview?: boolean } = {}): void {
  prActionDeps = deps ?? {};
  autoPreview = deps !== null && opts.autoPreview === true;
  lastPreviewStartedAt = Number.NEGATIVE_INFINITY;
}

/** Run one preview sweep now (tests; the drawer's rebuild does it on its own). */
export function refreshCloudPrPreviewsGuarded(): Promise<{ checked: number; updated: number }> {
  return guarded('preview', () => refreshCloudPrPreviews(needsYouReadTasks(), prActionDeps));
}

// ---------------------------------------------------------------------------
// Guarded jobs (shared by the scheduler and the POST routes)
// ---------------------------------------------------------------------------

type JobName = 'refresh' | 'improve' | 'preview';
const inFlight: Partial<Record<JobName, Promise<unknown>>> = {};

/**
 * One run of `name` at a time across the scheduler AND the routes: a POST
 * /refresh during a scheduled refresh joins it instead of racing a second
 * `gh` sweep over the same task files.
 */
function guarded<T>(name: JobName, run: () => Promise<T>): Promise<T> {
  const current = inFlight[name];
  if (current) return current as Promise<T>;
  const next = run().finally(() => {
    delete inFlight[name];
    invalidateNeedsYou();
  });
  inFlight[name] = next;
  return next;
}

export function refreshCloudTasksGuarded(): Promise<{ checked: number; updated: number }> {
  return guarded('refresh', () => refreshCloudTasks());
}

/**
 * The operator's "Improve Verse" must not be answered with the scheduler's
 * auto run (different gate, different count), so it waits for a run in
 * flight to settle and then starts its own — still one at a time.
 */
async function improveGuarded(opts: { count: number; auto: boolean }): Promise<CloudImproveResponse> {
  const current = inFlight.improve;
  if (current) await current.catch(() => undefined);
  return guarded('improve', () => runSelfImprove(opts));
}

// ---------------------------------------------------------------------------
// Background scheduler
// ---------------------------------------------------------------------------

export const CLOUD_REFRESH_EVERY_MS = 10 * 60 * 1000;
export const CLOUD_IMPROVE_EVERY_MS = 60 * 60 * 1000;
export const CLOUD_IMPROVE_FIRST_DELAY_MS = 2 * 60 * 1000;

/** Why this process must not run the scheduler; null when it may. */
export function cloudSchedulerRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  // Never from a test run: a timer that outlives a test could launch a real
  // (paid) cloud session or write under whatever HOME the next test set.
  if (env['VITEST'] || env['NODE_ENV'] === 'test') return 'test process';
  if (env['ASHLR_CLOUD_AUTO'] === '0') return 'disabled by ASHLR_CLOUD_AUTO=0';
  return null;
}

export interface CloudSchedulerDeps {
  refresh?: () => Promise<unknown>;
  improve?: () => Promise<unknown>;
  log?: (message: string) => void;
}

interface SchedulerState {
  timers: Array<ReturnType<typeof setInterval>>;
  running: Partial<Record<JobName, boolean>>;
  lastError: Partial<Record<JobName, string>>;
}

let scheduler: SchedulerState | null = null;

function errorText(err: unknown): string {
  // Scrubbed: the log line may be read by anyone who can read the server's
  // stderr, and a gh / git error can quote a token-bearing URL.
  return scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/**
 * Start the process-wide scheduler once (idempotent, never throws). True when
 * it runs. Jobs are guarded against overlapping runs — a tick that finds its
 * previous run still going is skipped, not queued — and a failure is logged
 * once per DISTINCT error, then stays quiet until it changes or clears.
 */
export function startCloudScheduler(env: NodeJS.ProcessEnv = process.env, deps: CloudSchedulerDeps = {}): boolean {
  if (scheduler) return true;
  if (cloudSchedulerRefusal(env) !== null) return false;
  const refresh = deps.refresh ?? (() => refreshCloudTasksGuarded());
  const improve = deps.improve ?? (() => improveGuarded({ count: 1, auto: true }));
  const log = deps.log ?? ((message: string) => { console.warn(`[ashlr] ${message}`); });
  const state: SchedulerState = { timers: [], running: {}, lastError: {} };

  const tick = (name: JobName, job: () => Promise<unknown>): void => {
    if (state.running[name]) return;
    state.running[name] = true;
    let promise: Promise<unknown>;
    try {
      promise = job();
    } catch (err) {
      promise = Promise.reject(err);
    }
    void promise
      .then(() => { delete state.lastError[name]; })
      .catch((err: unknown) => {
        const text = errorText(err);
        if (state.lastError[name] !== text) {
          state.lastError[name] = text;
          try { log(`cloud ${name} failed (${text}); retrying on the next tick`); } catch { /* never throws */ }
        }
      })
      .finally(() => { state.running[name] = false; });
  };

  try {
    const every = (ms: number, fn: () => void): void => {
      const t = setInterval(fn, ms);
      t.unref?.();
      state.timers.push(t);
    };
    every(CLOUD_REFRESH_EVERY_MS, () => tick('refresh', refresh));
    every(CLOUD_IMPROVE_EVERY_MS, () => tick('improve', improve));
    const first = setTimeout(() => tick('improve', improve), CLOUD_IMPROVE_FIRST_DELAY_MS);
    first.unref?.();
    state.timers.push(first);
  } catch {
    for (const t of state.timers) clearInterval(t);
    return false;
  }
  scheduler = state;
  return true;
}

/** Stop the scheduler (tests, shutdown). Safe to call when it never started. */
export function stopCloudScheduler(): void {
  if (!scheduler) return;
  // clearInterval clears a setTimeout handle too (one timer id space).
  for (const t of scheduler.timers) clearInterval(t);
  scheduler = null;
}

export function cloudSchedulerRunning(): boolean {
  return scheduler !== null;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function rejectQuery(req: IncomingMessage, res: ServerResponse): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'Invalid query string.');
    return true;
  }
  const first = params.keys().next();
  if (first.done) return false;
  sendInvalid(res, `Unknown query parameter: ${first.value}.`);
  return true;
}

async function readMutationBody(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  // The mount already gated this POST; re-checking keeps the module safe if
  // it is ever mounted or called some other way.
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  if (rejectQuery(req, res)) return null;
  let raw: string;
  try {
    raw = await readBody(req, maxBytes);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'Request body too large.' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.trim().length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'Invalid JSON body.');
    return null;
  }
  if (!isRecord(parsed)) {
    sendInvalid(res, 'Body must be a JSON object.');
    return null;
  }
  return parsed;
}

const TASK_DISMISS_RE = /^\/api\/verse\/cloud\/tasks\/([^/]+)\/dismiss$/;
const TASK_TRIAGE_RE = /^\/api\/verse\/cloud\/tasks\/([^/]+)\/(land|close|update-branch)$/;
const TRIAGE: Readonly<Record<string, (id: string, headSha: string, deps: CloudPrActionDeps) => Promise<CloudPrActionResult>>> = {
  land: landCloudPr,
  close: closeCloudPr,
  'update-branch': updateCloudPrBranch,
};

function ownsPath(path: string): boolean {
  return path === VERSE_CLOUD_PATH || path.startsWith(`${VERSE_CLOUD_PATH}/`);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleCloudApi: ApiModule = async (ctx, req, res, path, method) => {
  if (!ownsPath(path)) return false;
  try {
    if (path === VERSE_CLOUD_PATH) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (rejectQuery(req, res)) return true;
      sendJson(res, 200, await cloudOverview());
      return true;
    }

    if (path === VERSE_CLOUD_PREVIEWS_PATH) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (rejectQuery(req, res)) return true;
      const body: CloudPrPreviewsResponse = { generatedAt: new Date().toISOString(), previews: [...cachedCloudPrPreviews().values()] };
      sendJson(res, 200, body);
      return true;
    }

    // Every other cloud route is a POST.
    if (method !== 'POST') {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    if (path === VERSE_CLOUD_LAUNCH_PATH) {
      const body = await readMutationBody(ctx, req, res, LAUNCH_BODY_MAX_BYTES);
      if (!body) return true;
      const request = parseCloudLaunchBody(body);
      const result = await launchCloudTask(request);
      invalidateNeedsYou();
      // A refusal or failed launch keeps the full CloudLaunchResponse body, so
      // a client that only reads `error` on a non-2xx still shows the reason.
      sendJson(res, result.ok ? 200 : 409, result);
      return true;
    }

    if (path === VERSE_CLOUD_BUDGET_PATH) {
      const body = await readMutationBody(ctx, req, res, SMALL_BODY_MAX_BYTES);
      if (!body) return true;
      // Validate BEFORE any write: a malformed body touches nothing.
      const update = parseCloudBudgetBody(body);
      const budget = updateCloudBudget(update);
      sendJson(res, 200, cloudBudgetView(listCloudTasks(), budget, new Date()));
      return true;
    }

    if (path === VERSE_CLOUD_REFRESH_PATH) {
      const body = await readMutationBody(ctx, req, res, SMALL_BODY_MAX_BYTES);
      if (!body) return true;
      rejectUnknownKeys(body, new Set());
      sendJson(res, 200, await refreshCloudTasksGuarded());
      return true;
    }

    if (path === VERSE_CLOUD_IMPROVE_PATH) {
      const body = await readMutationBody(ctx, req, res, SMALL_BODY_MAX_BYTES);
      if (!body) return true;
      const { count } = parseCloudImproveBody(body);
      // The operator's "Improve Verse" button: canLaunch gate only (auto: false).
      sendJson(res, 200, await improveGuarded({ count, auto: false }));
      return true;
    }

    const dismiss = TASK_DISMISS_RE.exec(path);
    if (dismiss) {
      const body = await readMutationBody(ctx, req, res, SMALL_BODY_MAX_BYTES);
      if (!body) return true;
      rejectUnknownKeys(body, new Set());
      const id = dismiss[1]!;
      if (!CLOUD_TASK_ID_PATTERN.test(id)) {
        sendInvalid(res, 'That is not a cloud task id.');
        return true;
      }
      const result = dismissCloudTask(id);
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return true;
      }
      invalidateNeedsYou();
      sendJson(res, 200, { ok: true, task: result.task });
      return true;
    }

    const triage = TASK_TRIAGE_RE.exec(path);
    if (triage) {
      const body = await readMutationBody(ctx, req, res, SMALL_BODY_MAX_BYTES);
      if (!body) return true;
      const id = triage[1]!;
      if (!CLOUD_TASK_ID_PATTERN.test(id)) {
        sendInvalid(res, 'That is not a cloud task id.');
        return true;
      }
      const { headSha } = parseCloudPrActionBody(body);
      const result = await TRIAGE[triage[2]!]!(id, headSha, prActionDeps);
      invalidateNeedsYou();
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return true;
      }
      sendJson(res, 200, { ok: true, task: result.task, message: result.message });
      return true;
    }

    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch (err) {
    if (err instanceof CloudInputError) {
      sendInvalid(res, err.message);
      return true;
    }
    // Never the raw message: service errors can carry checkout paths.
    if (!res.headersSent) sendJson(res, 500, { error: 'cloud request failed' });
    return true;
  }
};

// The scheduler starts with the module (spec C2). The Verse server loads this
// module on the first activity poll (activity-api.ts reads needsYouItems) or
// the first /api/verse/cloud request; a test runner never starts it.
startCloudScheduler();
