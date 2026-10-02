/**
 * Devin lane HTTP module (3.15) — mounted as 'devin' in verse-api.ts.
 *
 *   GET  /api/verse/devin                       → DevinOverviewResponse
 *   GET  /api/verse/devin/previews              → CloudPrPreviewsResponse (Devin PRs, same shape as the cloud's)
 *   POST /api/verse/devin/launch                DevinLaunchRequest → DevinLaunchResponse (200 / 409 same body)
 *   POST /api/verse/devin/budget                DevinBudgetUpdate → DevinBudgetView
 *   POST /api/verse/devin/refresh               {} → { checked, updated }
 *   POST /api/verse/devin/tasks/<id>/dismiss    {} → { ok, task }
 *   POST /api/verse/devin/tasks/<id>/message    { message } → { ok, task }     (reply to a waiting session)
 *   POST /api/verse/devin/tasks/<id>/land|update-branch  { headSha } → { ok, task, message }
 *   POST /api/verse/devin/tasks/<id>/close      { headSha, reason? } → { ok, task, message }
 *   POST /api/verse/devin/cli-prs/<chat id>/<n>/dismiss  {} → { ok }         (a Devin CLI chat's PR, cli-prs.ts)
 *
 * Same posture as the cloud module (cloud-api.ts, whose strict helpers this
 * reuses): GETs behind the read session; POSTs 404 unless dispatch is allowed,
 * then the mutation token + JSON gate and a bounded, STRICT body. Responses go
 * through sendJson() (secret-scrubbed); service errors are never forwarded raw.
 *
 * There is deliberately NO route that accepts an API key: the key is entered
 * only in a terminal (`ashlr devin connect`, hidden input) and goes straight
 * to the Keychain. Nothing here merges on its own: Land / Close / Update
 * branch are the shared, head-pinned triage actions (cloud/pr-actions.ts),
 * taken only when Mason clicks.
 *
 * Also owned here: the Needs-you producer (Devin PRs ready for review, waiting
 * sessions, failed launches) and the background refresher (every 60 s while a
 * session is live; never in a test process; ASHLR_DEVIN_AUTO=0 turns it off).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CloudInputError,
  dismissAction,
  isValidBranchName,
  isValidCloudRepo,
  parseCloudPrActionBody,
  parseCloudPrCloseBody,
  readMutationBody,
  rejectQuery,
  rejectUnknownKeys,
  sendInvalid,
  triageActions,
} from '../cloud/cloud-api.js';
import {
  cachedCloudPrPreviews,
  closeCloudPr,
  cloudPrPreviewsStale,
  createCloudPrPreviewCache,
  landCloudPr,
  refreshCloudPrPreviews,
  updateCloudPrBranch,
  type CloudDeliveryStore,
  type CloudPrActionDeps,
  type CloudPrActionResult,
} from '../cloud/pr-actions.js';
import type { CloudPrPreview, CloudPrPreviewsResponse } from '../cloud/pr-preview.js';
import { scrubSecrets } from '../util/scrub.js';
import type { ApiModule } from '../verse/api-modules.js';
import { sendJson } from '../web/api.js';
import {
  isNeedsYouItem,
  NEEDS_YOU_DETAIL_MAX,
  NEEDS_YOU_TITLE_MAX,
  type NeedsYouItem,
} from '../verse/workbench-types.js';
import { devinBudgetView, devinTaskActive } from './budget.js';
import { DEVIN_CLI_PR_WINDOW_MS, devinCliPrKey, dismissDevinCliPr, listDevinCliPrs, readDismissedDevinCliPrs, type DevinCliChatPrs } from './cli-prs.js';
import { devinOverview, launchDevinTask, messageDevinTask, devinEnabled, type DevinServiceDeps } from './service.js';
import { listDevinTasks, readDevinTask, updateDevinBudget, writeDevinTask } from './store.js';
import { devinTaskNeedsObservation, refreshDevinTasks } from './tracker.js';
import {
  DEVIN_TASK_ID_PATTERN,
  VERSE_DEVIN_BUDGET_PATH,
  VERSE_DEVIN_LAUNCH_PATH,
  VERSE_DEVIN_PATH,
  VERSE_DEVIN_REFRESH_PATH,
  VERSE_DEVIN_TASKS_PATH,
  type DevinBudgetUpdate,
  type DevinLaunchRequest,
  type DevinTaskV1,
} from './types.js';
import { loadConfigReadOnly } from '../config.js';

export const VERSE_DEVIN_PREVIEWS_PATH = '/api/verse/devin/previews' as const;

const LAUNCH_BODY_MAX_BYTES = 128 * 1024;
const SMALL_BODY_MAX_BYTES = 4 * 1024;
const MESSAGE_BODY_MAX_BYTES = 24 * 1024;
const TITLE_MAX = 200;
const BUDGET_NUMBER_MAX = 1_000_000;

const LAUNCH_KEYS: ReadonlySet<string> = new Set(['repo', 'baseBranch', 'title', 'prompt', 'origin']);
const LAUNCH_ORIGINS: readonly DevinLaunchRequest['origin'][] = ['chat', 'operator', 'cli'];
const BUDGET_KEYS = ['acuBudgetTotal', 'acuSpentAdjustment', 'usdPerAcu', 'maxAcuPerSession', 'maxAcuPerDay', 'reserveAcu', 'pauseAtFraction', 'maxConcurrent', 'maxSessionsPerDay',
  'fleetMaxConcurrent', 'fleetMaxSessionsPerDay'] as const;
const BUDGET_WHOLE: ReadonlySet<string> = new Set(['maxAcuPerSession', 'maxConcurrent', 'maxSessionsPerDay', 'fleetMaxConcurrent', 'fleetMaxSessionsPerDay']);
const BUDGET_COUNTS: ReadonlySet<string> = new Set(['maxConcurrent', 'maxSessionsPerDay', 'fleetMaxConcurrent', 'fleetMaxSessionsPerDay']);

// ---------------------------------------------------------------------------
// Input validation (pure, exported for tests)
// ---------------------------------------------------------------------------

export function parseDevinLaunchBody(body: Record<string, unknown>): DevinLaunchRequest {
  rejectUnknownKeys(body, LAUNCH_KEYS);
  const { repo, baseBranch, title, prompt, origin } = body;
  if (!isValidCloudRepo(repo)) throw new CloudInputError('Repo must look like owner/name.');
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new CloudInputError('Describe the task to run.');
  const out: DevinLaunchRequest = { repo, prompt, origin: 'operator' };
  if (baseBranch !== undefined) {
    if (!isValidBranchName(baseBranch)) throw new CloudInputError('Base branch is not a valid branch name.');
    out.baseBranch = baseBranch;
  }
  if (title !== undefined) {
    if (typeof title !== 'string' || title.length > TITLE_MAX) throw new CloudInputError(`Title must be text of at most ${TITLE_MAX} characters.`);
    if (title.trim().length > 0) out.title = title.trim();
  }
  if (origin !== undefined) {
    // `fleet` is never accepted over HTTP: only the fleet's own code launches as the fleet.
    if (!(LAUNCH_ORIGINS as readonly unknown[]).includes(origin)) throw new CloudInputError(`Origin must be one of: ${LAUNCH_ORIGINS.join(', ')}.`);
    out.origin = origin as DevinLaunchRequest['origin'];
  }
  return out;
}

export function parseDevinBudgetBody(body: Record<string, unknown>): DevinBudgetUpdate {
  rejectUnknownKeys(body, new Set(BUDGET_KEYS));
  const out: DevinBudgetUpdate = {};
  for (const key of BUDGET_KEYS) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new CloudInputError(`${key} must be a number.`);
    if (value < 0) throw new CloudInputError(`${key} can't be negative.`);
    if (BUDGET_COUNTS.has(key)) {
      if (!Number.isSafeInteger(value)) throw new CloudInputError(`${key} must be a safe whole number.`);
    } else if (value > BUDGET_NUMBER_MAX) throw new CloudInputError(`${key} is too large.`);
    if (BUDGET_WHOLE.has(key) && !Number.isInteger(value)) throw new CloudInputError(`${key} must be a whole number.`);
    out[key] = value;
  }
  if (Object.keys(out).length === 0) throw new CloudInputError('Nothing to update.');
  return out;
}

export function parseDevinMessageBody(body: Record<string, unknown>): { message: string } {
  rejectUnknownKeys(body, new Set(['message']));
  const message = body['message'];
  if (typeof message !== 'string' || message.trim() === '' || message.length > 4000) {
    throw new CloudInputError('Message must be text of 1 to 4000 characters.');
  }
  return { message };
}

// ---------------------------------------------------------------------------
// Dismiss (local visibility only; remote exposure remains reserved)
// ---------------------------------------------------------------------------

export const DEVIN_DISMISS_REASON = 'Dismissed in Verse.';

export function dismissDevinTask(id: string, now: Date = new Date()): { ok: true; task: DevinTaskV1 } | { ok: false; status: 404 | 409; error: string } {
  const task = readDevinTask(id);
  if (!task) return { ok: false, status: 404, error: 'No Devin task with that id.' };
  if (task.state === 'closed') return { ok: true, task };
  if (task.state === 'merged') return { ok: false, status: 409, error: 'This task was merged; there is nothing to dismiss.' };
  if (task.state === 'queued' || task.state === 'launching') return { ok: false, status: 409, error: 'This task is still launching. Try again in a minute.' };
  // Keep provider observations and uncertain-create failure evidence intact.
  // Closing this local record neither terminates Devin nor settles its usage.
  const next: DevinTaskV1 = { ...task, state: 'closed', stateReason: DEVIN_DISMISS_REASON, updatedAt: now.toISOString() };
  writeDevinTask(next);
  return { ok: true, task: next };
}

// ---------------------------------------------------------------------------
// Shared triage, Devin store + Devin preview cache
// ---------------------------------------------------------------------------

const DEVIN_STORE: CloudDeliveryStore<DevinTaskV1> = { read: readDevinTask, write: writeDevinTask, noun: 'Devin task' };
const previewCache = createCloudPrPreviewCache();
let prActionDeps: CloudPrActionDeps<DevinTaskV1> = { store: DEVIN_STORE, cache: previewCache };
let serviceDeps: DevinServiceDeps = {};
let autoPreview = !(process.env['VITEST'] || process.env['NODE_ENV'] === 'test');

/** Test seam: `gh` / policy for triage + previews, service deps (null restores production and turns auto-preview off). */
export function setDevinApiDepsForTest(deps: { pr?: Omit<CloudPrActionDeps<DevinTaskV1>, 'store' | 'cache'>; service?: DevinServiceDeps; autoPreview?: boolean } | null): void {
  prActionDeps = { ...(deps?.pr ?? {}), store: DEVIN_STORE, cache: previewCache };
  serviceDeps = deps?.service ?? {};
  autoPreview = deps !== null && deps.autoPreview === true;
  previewCache.previews.clear();
  previewCache.diffChecksBySha.clear();
  needsYouCache = null;
  needsYouPending = false;
}

/** Land and Update branch; close carries Mason's optional reason and is dispatched on its own (cloud-api.ts parseCloudPrCloseBody). */
const TRIAGE: Readonly<Record<string, (id: string, headSha: string, deps: CloudPrActionDeps<DevinTaskV1>) => Promise<CloudPrActionResult<DevinTaskV1>>>> = {
  land: (id, sha, deps) => landCloudPr<DevinTaskV1>(id, sha, deps),
  'update-branch': (id, sha, deps) => updateCloudPrBranch<DevinTaskV1>(id, sha, deps),
};

// ---------------------------------------------------------------------------
// Needs-you producer
// ---------------------------------------------------------------------------

export const DEVIN_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;
const NEEDS_YOU_CACHE_MS = 15_000;
const PREVIEW_RETRY_MS = 60_000;

function clip(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const titleOf = (task: DevinTaskV1): string => clip(task.title ?? '', 80) || 'Untitled Devin task';
const isoOr = (value: string | null | undefined, fallback: string): string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback;

/**
 * PURE: Devin's Needs-you items. Same closed contract as the cloud lane
 * (workbench-types.ts §2 — no new kind): a verified Devin PR is an
 * `owner-lane-pr` (the fleet never merges Devin work on its own), with the
 * shared triage actions once previewed; a session waiting for Mason or a
 * failed launch is a `chats` item that opens the session.
 */
export function devinNeedsYouItems(tasks: readonly DevinTaskV1[], now: Date, previews: ReadonlyMap<string, CloudPrPreview> = new Map()): NeedsYouItem[] {
  const nowIso = now.toISOString();
  const out: NeedsYouItem[] = [];
  for (const task of tasks) {
    let item: NeedsYouItem | null = null;
    if (task.state === 'pr-open' && task.pr) {
      const report = task.report;
      const summary = report ? `Devin reports (unverified): ${scrubSecrets(report.summary)}` : 'No report yet: the pull request has no ashlr-devin-report block.';
      const status = report && report.status !== 'done' ? ` (${report.status})` : '';
      const cached = previews.get(task.id);
      const preview = cached && cached.prNumber === task.pr.number && cached.open ? cached : null;
      item = {
        id: `fleet:owner-lane-pr:devin-${task.id}`,
        source: 'fleet',
        kind: 'owner-lane-pr',
        severity: 'info',
        title: clip(`Devin task ready for review: ${titleOf(task)}`, NEEDS_YOU_TITLE_MAX),
        detail: clip(preview ? `${preview.reason} ${summary}${status}` : `${summary}${status}`, NEEDS_YOU_DETAIL_MAX) || null,
        since: isoOr(task.updatedAt, nowIso),
        expiresAt: null,
        // 3.15: a PR from a Devin CHAT names its chat, so Needs-you can open it.
        subject: { repo: task.repo, pr: task.pr.number, seatId: task.verseSessionId ? 'devin' : null, sessionId: task.verseSessionId ?? null, engine: null },
        target: { kind: 'url', url: task.pr.url },
        actions: preview
          ? [...triageActions(task, preview, VERSE_DEVIN_TASKS_PATH), dismissAction(task, true, VERSE_DEVIN_TASKS_PATH, 'Devin task')]
          : [dismissAction(task, true, VERSE_DEVIN_TASKS_PATH, 'Devin task')],
      };
    } else if (task.verseSessionId) {
      // 3.15: a Devin CHAT's waiting / failed states live in its own
      // transcript ("waiting for you" is how every chat turn ends); only its
      // pull requests are Needs-you items.
      continue;
    } else if (task.state === 'blocked' && task.sessionUrl) {
      item = {
        id: `chats:chat-failed:devin-${task.id}`,
        source: 'chats',
        kind: 'chat-failed',
        severity: 'warn',
        title: clip(`Devin is waiting: ${titleOf(task)}`, NEEDS_YOU_TITLE_MAX),
        detail: clip(scrubSecrets(task.stateReason ?? 'Devin is waiting for you.') + ' Reply from the Devin card or in Devin.', NEEDS_YOU_DETAIL_MAX) || null,
        since: isoOr(task.updatedAt, nowIso),
        expiresAt: null,
        subject: { repo: task.repo, pr: null, seatId: null, sessionId: null, engine: null },
        target: { kind: 'url', url: task.sessionUrl },
        actions: [dismissAction(task, true, VERSE_DEVIN_TASKS_PATH, 'Devin task')],
      };
    } else if (task.state === 'failed') {
      const at = Date.parse(task.updatedAt);
      if (Number.isNaN(at) || now.getTime() - at > DEVIN_FAILED_WINDOW_MS) continue;
      item = {
        id: `chats:chat-failed:devin-${task.id}`,
        source: 'chats',
        kind: 'chat-failed',
        severity: 'warn',
        title: clip(`Devin launch failed: ${titleOf(task)}`, NEEDS_YOU_TITLE_MAX),
        detail: clip(scrubSecrets(task.stateReason ?? 'The Devin session could not be started.'), NEEDS_YOU_DETAIL_MAX) || null,
        since: isoOr(task.updatedAt, nowIso),
        expiresAt: new Date(at + DEVIN_FAILED_WINDOW_MS).toISOString(),
        subject: { repo: task.repo, pr: null, seatId: null, sessionId: null, engine: null },
        target: task.sessionUrl ? { kind: 'url', url: task.sessionUrl } : { kind: 'section', section: 'command', anchor: 'devin' },
        actions: [dismissAction(task, false, VERSE_DEVIN_TASKS_PATH, 'Devin task')],
      };
    }
    if (item && isNeedsYouItem(item)) out.push(item);
  }
  return out;
}

export const VERSE_DEVIN_CLI_PRS_PATH = '/api/verse/devin/cli-prs' as const;

/**
 * PURE: a Devin (CLI) chat's pull requests as Needs-you items — the same
 * `owner-lane-pr` a cloud chat's PR is, naming its chat the same way (seat +
 * session), so the drawer and the chat list treat them alike. Verse did not
 * open, verify or track these (cli-prs.ts), so the only action is Dismiss and
 * an item leaves on its own after DEVIN_CLI_PR_WINDOW_MS.
 */
export function devinCliNeedsYouItems(chats: readonly DevinCliChatPrs[], dismissed: ReadonlySet<string>, now: Date): NeedsYouItem[] {
  const out: NeedsYouItem[] = [];
  for (const chat of chats) {
    for (const pr of chat.prs) {
      const seen = Date.parse(pr.seenAt);
      if (!Number.isFinite(seen) || now.getTime() - seen > DEVIN_CLI_PR_WINDOW_MS) continue;
      if (dismissed.has(devinCliPrKey(chat.sessionId, pr.url))) continue;
      const item: NeedsYouItem = {
        id: `fleet:owner-lane-pr:devin-cli-${chat.sessionId}-${pr.number}`,
        source: 'fleet',
        kind: 'owner-lane-pr',
        severity: 'info',
        title: clip(`Devin (CLI) pull request: ${pr.repo}#${pr.number}`, NEEDS_YOU_TITLE_MAX),
        detail: 'Seen in a Devin (CLI) chat’s output. Verse did not open, verify or track it — review it on GitHub.',
        since: new Date(seen).toISOString(),
        expiresAt: new Date(seen + DEVIN_CLI_PR_WINDOW_MS).toISOString(),
        subject: { repo: pr.repo, pr: pr.number, seatId: 'devin-cli', sessionId: chat.sessionId, engine: null },
        target: { kind: 'url', url: pr.url },
        actions: [{
          kind: 'done',
          label: 'Dismiss',
          request: { method: 'POST', path: `${VERSE_DEVIN_CLI_PRS_PATH}/${chat.sessionId}/${pr.number}/dismiss`, body: {} },
          confirm: null,
          destructive: false,
        }],
      };
      if (isNeedsYouItem(item)) out.push(item);
    }
  }
  return out;
}

let needsYouCache: { at: number; items: NeedsYouItem[] } | null = null;
let needsYouPending = false;
let lastPreviewStartedAt = Number.NEGATIVE_INFINITY;

function rebuildNeedsYou(): void {
  try {
    const tasks = listDevinTasks(200);
    const now = new Date();
    needsYouCache = {
      at: Date.now(),
      items: [...devinNeedsYouItems(tasks, now, cachedCloudPrPreviews(previewCache)), ...devinCliNeedsYouItems(listDevinCliPrs(), readDismissedDevinCliPrs(), now)],
    };
    if (autoPreview && Date.now() - lastPreviewStartedAt >= PREVIEW_RETRY_MS && cloudPrPreviewsStale(tasks, Date.now(), previewCache)) {
      lastPreviewStartedAt = Date.now();
      void guarded('preview', () => refreshCloudPrPreviews<DevinTaskV1>(tasks, prActionDeps)).catch(() => undefined);
    }
  } catch {
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

/** Needs-you producer (activity-api.ts): O(1) from a cache rebuilt off the caller's stack. */
export function needsYouItems(): NeedsYouItem[] {
  if (!needsYouCache || Date.now() - needsYouCache.at >= NEEDS_YOU_CACHE_MS) scheduleNeedsYouRebuild();
  return needsYouCache ? [...needsYouCache.items] : [];
}

function invalidateNeedsYou(): void {
  if (needsYouCache) needsYouCache = { ...needsYouCache, at: 0 };
  scheduleNeedsYouRebuild();
}

/** Run one preview sweep now (tests). */
export function refreshDevinPrPreviewsGuarded(): Promise<{ checked: number; updated: number }> {
  return guarded('preview', () => refreshCloudPrPreviews<DevinTaskV1>(listDevinTasks(200), prActionDeps));
}

// ---------------------------------------------------------------------------
// Guarded jobs + background refresher
// ---------------------------------------------------------------------------

type JobName = 'refresh' | 'preview';
const inFlight: Partial<Record<JobName, Promise<unknown>>> = {};

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

export function refreshDevinTasksGuarded(): Promise<{ checked: number; updated: number }> {
  return guarded('refresh', () => refreshDevinTasks({ ...serviceDeps, ...(prActionDeps.gh ? { gh: prActionDeps.gh } : {}) }));
}

/** The docs publish no webhook for session completion, so status is polled — gently, and only while something is live. */
export const DEVIN_REFRESH_EVERY_MS = 60_000;
/** Idle tasks (a PR waiting for review) are re-read less often. */
export const DEVIN_IDLE_REFRESH_EVERY_MS = 10 * 60_000;

export function devinSchedulerRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env['VITEST'] || env['NODE_ENV'] === 'test') return 'test process';
  if (env['ASHLR_DEVIN_AUTO'] === '0') return 'disabled by ASHLR_DEVIN_AUTO=0';
  return null;
}

let scheduler: ReturnType<typeof setInterval> | null = null;
let lastIdleRefreshAt = 0;

export function startDevinScheduler(env: NodeJS.ProcessEnv = process.env): boolean {
  if (scheduler) return true;
  if (devinSchedulerRefusal(env) !== null) return false;
  let lastError: string | null = null;
  scheduler = setInterval(() => {
    let enabled = false;
    try {
      enabled = devinEnabled(loadConfigReadOnly().devin);
    } catch {
      enabled = false;
    }
    if (!enabled) return;
    // The wake decision must not hide an older unsettled session behind a
    // display-list limit. Actual provider reads retain tracker round-robin caps.
    const tasks = listDevinTasks(Number.MAX_SAFE_INTEGER);
    const live = tasks.some((task) => devinTaskActive(task));
    const idleDue = tasks.some((task) => task.state === 'pr-open' || task.state === 'expired' || devinTaskNeedsObservation(task))
      && Date.now() - lastIdleRefreshAt >= DEVIN_IDLE_REFRESH_EVERY_MS;
    if (!live && !idleDue) return;
    if (idleDue) lastIdleRefreshAt = Date.now();
    void refreshDevinTasksGuarded()
      .then(() => { lastError = null; })
      .catch((err: unknown) => {
        const text = scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
        if (text !== lastError) {
          lastError = text;
          try { console.warn(`[ashlr] devin refresh failed (${text}); retrying on the next tick`); } catch { /* never throws */ }
        }
      });
  }, DEVIN_REFRESH_EVERY_MS);
  scheduler.unref?.();
  return true;
}

export function stopDevinScheduler(): void {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const TASK_DISMISS_RE = /^\/api\/verse\/devin\/tasks\/([^/]+)\/dismiss$/;
const TASK_MESSAGE_RE = /^\/api\/verse\/devin\/tasks\/([^/]+)\/message$/;
const TASK_TRIAGE_RE = /^\/api\/verse\/devin\/tasks\/([^/]+)\/(land|close|update-branch)$/;
const CLI_PR_DISMISS_RE = /^\/api\/verse\/devin\/cli-prs\/([A-Za-z0-9-]{1,80})\/(\d{1,9})\/dismiss$/;

function ownsPath(path: string): boolean {
  return path === VERSE_DEVIN_PATH || path.startsWith(`${VERSE_DEVIN_PATH}/`);
}

function taskIdOr400(res: ServerResponse, id: string): boolean {
  if (DEVIN_TASK_ID_PATTERN.test(id)) return true;
  sendInvalid(res, 'That is not a Devin task id.');
  return false;
}

export const handleDevinApi: ApiModule = async (ctx, req: IncomingMessage, res: ServerResponse, path, method) => {
  if (!ownsPath(path)) return false;
  try {
    if (path === VERSE_DEVIN_PATH || path === VERSE_DEVIN_PREVIEWS_PATH) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (rejectQuery(req, res)) return true;
      if (path === VERSE_DEVIN_PATH) {
        sendJson(res, 200, await devinOverview(serviceDeps));
      } else {
        const body: CloudPrPreviewsResponse = { generatedAt: new Date().toISOString(), previews: [...cachedCloudPrPreviews(previewCache).values()] };
        sendJson(res, 200, body);
      }
      return true;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    if (path === VERSE_DEVIN_LAUNCH_PATH) {
      const body = await readMutationBody(ctx, req, res, LAUNCH_BODY_MAX_BYTES);
      if (!body) return true;
      const result = await launchDevinTask(parseDevinLaunchBody(body), serviceDeps);
      invalidateNeedsYou();
      sendJson(res, result.ok ? 200 : 409, result);
      return true;
    }
    if (path === VERSE_DEVIN_BUDGET_PATH) {
      const body = await readMutationBody(ctx, req, res, SMALL_BODY_MAX_BYTES);
      if (!body) return true;
      const budget = updateDevinBudget(parseDevinBudgetBody(body));
      sendJson(res, 200, devinBudgetView(listDevinTasks(Number.MAX_SAFE_INTEGER), budget, new Date()));
      return true;
    }
    if (path === VERSE_DEVIN_REFRESH_PATH) {
      const body = await readMutationBody(ctx, req, res, SMALL_BODY_MAX_BYTES);
      if (!body) return true;
      rejectUnknownKeys(body, new Set());
      sendJson(res, 200, await refreshDevinTasksGuarded());
      return true;
    }

    const dismiss = TASK_DISMISS_RE.exec(path);
    if (dismiss) {
      const body = await readMutationBody(ctx, req, res, SMALL_BODY_MAX_BYTES);
      if (!body) return true;
      rejectUnknownKeys(body, new Set());
      if (!taskIdOr400(res, dismiss[1]!)) return true;
      const result = dismissDevinTask(dismiss[1]!);
      invalidateNeedsYou();
      if (!result.ok) sendJson(res, result.status, { error: result.error });
      else sendJson(res, 200, { ok: true, task: result.task });
      return true;
    }

    const cliPr = CLI_PR_DISMISS_RE.exec(path);
    if (cliPr) {
      const body = await readMutationBody(ctx, req, res, SMALL_BODY_MAX_BYTES);
      if (!body) return true;
      rejectUnknownKeys(body, new Set());
      const result = dismissDevinCliPr(cliPr[1]!, Number(cliPr[2]));
      invalidateNeedsYou();
      if (!result.ok) sendJson(res, result.status, { error: result.error });
      else sendJson(res, 200, { ok: true });
      return true;
    }

    const message = TASK_MESSAGE_RE.exec(path);
    if (message) {
      const body = await readMutationBody(ctx, req, res, MESSAGE_BODY_MAX_BYTES);
      if (!body) return true;
      if (!taskIdOr400(res, message[1]!)) return true;
      const parsed = parseDevinMessageBody(body);
      const result = await messageDevinTask(message[1]!, parsed.message, serviceDeps);
      invalidateNeedsYou();
      if (!result.ok) sendJson(res, result.status, { error: scrubSecrets(result.error) });
      else sendJson(res, 200, { ok: true, task: result.task });
      return true;
    }

    const triage = TASK_TRIAGE_RE.exec(path);
    if (triage) {
      const body = await readMutationBody(ctx, req, res, SMALL_BODY_MAX_BYTES);
      if (!body) return true;
      if (!taskIdOr400(res, triage[1]!)) return true;
      const verb = triage[2]!;
      let result: CloudPrActionResult<DevinTaskV1>;
      if (verb === 'close') {
        const parsed = parseCloudPrCloseBody(body);
        result = await closeCloudPr<DevinTaskV1>(triage[1]!, parsed.headSha, prActionDeps, parsed.reason);
      } else {
        result = await TRIAGE[verb]!(triage[1]!, parseCloudPrActionBody(body).headSha, prActionDeps);
      }
      invalidateNeedsYou();
      if (!result.ok) sendJson(res, result.status, { error: result.error });
      else sendJson(res, 200, { ok: true, task: result.task, message: result.message });
      return true;
    }

    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch (err) {
    if (err instanceof CloudInputError) {
      sendInvalid(res, err.message);
      return true;
    }
    if (!res.headersSent) sendJson(res, 500, { error: 'devin request failed' });
    return true;
  }
};

startDevinScheduler();
