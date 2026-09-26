/**
 * Delivery tracker (unit C1): for active and recently closed tasks, ask GitHub for a
 * PR whose repository, head and base match the task (`gh pr list --repo <repo>
 * --head <branch> --state all`), update
 * state/pr/report, and expire tasks with no PR after CLOUD_TASK_EXPIRY_MS.
 * A failed lookup hides a previously shown PR/report while retaining its pin;
 * an unknown lookup never expires a running task or throws into callers.
 *
 * Transitions:
 *   running  → pr-open | merged | closed   (a PR appeared on the branch)
 *   pr-open  → merged | closed             (and pr/report stay current while verified)
 *   pr-open  → pr-open without visible PR (verification unavailable or changed)
 *   running  → expired                     (no PR after CLOUD_TASK_EXPIRY_MS)
 *   expired  → pr-open | merged | closed   (a late PR, within EXPIRED_WATCH_MS)
 *   closed   → pr-open                      (the same verified PR reopened within the watch window)
 *   queued | launching → failed            (a launch interrupted by a restart)
 */
import { tmpdir } from 'node:os';

import { defaultGitRunner } from '../verse/git-ops.js';
import { parseCloudReport } from './delivery-contract.js';
import { listCloudTasks, readCloudTask, writeCloudTask } from './store.js';
import { CLOUD_LAUNCH_TIMEOUT_MS, CLOUD_TASK_EXPIRY_MS, type CloudDeliveryPin, type CloudTaskPr, type CloudTaskState, type CloudTaskV1 } from './types.js';

export interface CloudTrackerDeps {
  gh?: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  now?: () => Date;
}

const HOUR = 60 * 60 * 1000;
/**
 * `expired` only means Verse stopped waiting: the session keeps running on
 * claude.ai and may still open its PR. Expired tasks stay watched this long
 * after creation so a late delivery is not lost, then are left alone.
 */
export const EXPIRED_WATCH_MS = 48 * HOUR;
/** A verified unmerged PR can reopen; recheck it for one week after its last recorded change. */
export const CLOSED_REOPEN_WATCH_MS = 7 * 24 * HOUR;
/**
 * A task still `queued`/`launching` this long after creation was orphaned by
 * a server restart mid-launch (a live launch finishes within the checkout +
 * CLOUD_LAUNCH_TIMEOUT_MS). Left alone it would hold a concurrency slot forever.
 */
export const STALE_LAUNCH_MS = 10 * CLOUD_LAUNCH_TIMEOUT_MS;
/** Bound on gh calls per refresh; a cursor rotates through the watched tasks. */
const MAX_CHECKS_PER_REFRESH = 50;
const GH_TIMEOUT_MS = 30_000;
/** A full page is uncertain: another matching PR might have been truncated. */
const GH_PR_LIMIT = 100;

/** Production gh: argv only, bounded, never prompts (git-ops' runner and env). */
export async function defaultCloudGh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await defaultGitRunner('gh', args, { cwd: tmpdir(), timeoutMs: GH_TIMEOUT_MS, maxStdoutBytes: 2 * 1024 * 1024 });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
}

interface GhPr {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  title: string;
  body: string | null;
  headRefName: string;
  baseRefName: string;
  headRepository: { name: string };
  headRepositoryOwner: { login: string };
  isCrossRepository: false;
}

/** A malformed or full result is unknown, never evidence that a task has no PR. */
function parseGhPrList(stdout: string): GhPr[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length >= GH_PR_LIMIT) return undefined;
  const parsed: GhPr[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const pr = item as Record<string, unknown>;
    const headRepository = pr['headRepository'];
    const headRepositoryOwner = pr['headRepositoryOwner'];
    if (!Number.isSafeInteger(pr['number']) || (pr['number'] as number) < 1
      || typeof pr['url'] !== 'string'
      || !['OPEN', 'MERGED', 'CLOSED'].includes(pr['state'] as string)
      || typeof pr['isDraft'] !== 'boolean'
      || typeof pr['title'] !== 'string'
      || (pr['body'] !== null && typeof pr['body'] !== 'string')
      || typeof pr['headRefName'] !== 'string'
      || typeof pr['baseRefName'] !== 'string'
      || !headRepository || typeof headRepository !== 'object' || typeof (headRepository as Record<string, unknown>)['name'] !== 'string'
      || !headRepositoryOwner || typeof headRepositoryOwner !== 'object' || typeof (headRepositoryOwner as Record<string, unknown>)['login'] !== 'string'
      || pr['isCrossRepository'] !== false) return undefined;
    parsed.push(pr as unknown as GhPr);
  }
  return parsed;
}

/** The URL and both refs must be the task's, even if gh's branch filter returned it. */
function matchesTask(gh: GhPr, task: CloudTaskV1): boolean {
  const [owner, repo] = task.repo.split('/');
  return gh.url.toLowerCase() === `https://github.com/${task.repo}/pull/${gh.number}`.toLowerCase()
    && gh.headRefName === task.branch
    && gh.baseRefName === task.baseBranch
    && gh.headRepositoryOwner.login.toLowerCase() === owner!.toLowerCase()
    && gh.headRepository.name.toLowerCase() === repo!.toLowerCase();
}

function prFrom(gh: GhPr): CloudTaskPr {
  const state: CloudTaskPr['state'] = gh.state === 'OPEN' ? 'open' : gh.state === 'MERGED' ? 'merged' : 'closed';
  return { number: gh.number, url: gh.url, state, draft: gh.isDraft, title: gh.title.slice(0, 300) };
}

function stateFor(pr: CloudTaskPr): { state: CloudTaskState; reason: string } {
  if (pr.state === 'merged') return { state: 'merged', reason: `Pull request #${pr.number} was merged.` };
  if (pr.state === 'closed') return { state: 'closed', reason: `Pull request #${pr.number} was closed without merging.` };
  return { state: 'pr-open', reason: `${pr.draft ? 'Draft pull request' : 'Pull request'} #${pr.number} is open for review.` };
}

const watched = (task: CloudTaskV1, nowMs: number): boolean =>
  task.state === 'running' || task.state === 'pr-open'
  || (task.state === 'expired' && task.pr === null && nowMs - Date.parse(task.createdAt) < EXPIRED_WATCH_MS)
  || (task.state === 'closed' && task.pr?.state === 'closed' && deliveryPin(task) !== null
    && nowMs - Date.parse(task.updatedAt) < CLOSED_REOPEN_WATCH_MS);

/** Writes `next` only when the task on disk is still the one this refresh read (a launch or dismiss in between wins). */
function commit(before: CloudTaskV1, next: CloudTaskV1): boolean {
  const current = readCloudTask(before.id);
  if (!current || current.updatedAt !== before.updatedAt || current.state !== before.state) return false;
  writeCloudTask(next);
  return true;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const PR_UNVERIFIED_REASON = 'Previously recorded pull request could not be verified on GitHub.';
const PR_LOOKUP_UNAVAILABLE_REASON = 'Pull request verification is unavailable; the previously verified delivery is hidden.';
const PR_REPLACEMENT_REASON = 'A different pull request was found; the previously verified delivery is hidden.';

function canonicalPrUrl(task: CloudTaskV1, number: number): string {
  return `https://github.com/${task.repo}/pull/${number}`;
}

/** Old v1 records have no pin; carry their canonical previously shown PR forward. */
function deliveryPin(task: CloudTaskV1): CloudDeliveryPin | null {
  if (task.deliveryPin) return task.deliveryPin;
  const pr = task.pr;
  return pr && Number.isSafeInteger(pr.number) && pr.number > 0
    && pr.url.toLowerCase() === canonicalPrUrl(task, pr.number).toLowerCase()
    ? { number: pr.number, url: pr.url }
    : null;
}

/** Keep the task watched, but stop surfacing an unverified PR or its old report. */
function clearUnverifiedDelivery(task: CloudTaskV1, reason: string): boolean {
  const pin = deliveryPin(task);
  if (task.state !== 'pr-open'
    || (task.pr === null && task.report === null && task.stateReason === reason && same(task.deliveryPin ?? null, pin))) return false;
  try {
    return commit(task, { ...task, pr: null, report: null, stateReason: reason, ...(pin ? { deliveryPin: pin } : {}) });
  } catch {
    return false;
  }
}

/** A stable last-id cursor prevents the newest 50 persistent tasks from starving older tasks. */
let lastCheckedTaskId: string | null = null;
function watchedForRefresh(tasks: readonly CloudTaskV1[], nowMs: number): CloudTaskV1[] {
  const watchedTasks = tasks.filter((task) => watched(task, nowMs));
  if (watchedTasks.length <= MAX_CHECKS_PER_REFRESH) {
    lastCheckedTaskId = watchedTasks.at(-1)?.id ?? null;
    return watchedTasks;
  }
  const prior = watchedTasks.findIndex((task) => task.id === lastCheckedTaskId);
  // After a process restart, the ten-minute scheduler slot selects a cohort;
  // subsequent manual refreshes advance from the last checked task.
  const start = prior >= 0 ? (prior + 1) % watchedTasks.length
    : (Math.floor(nowMs / (10 * 60_000)) * MAX_CHECKS_PER_REFRESH) % watchedTasks.length;
  const selected = Array.from({ length: MAX_CHECKS_PER_REFRESH }, (_, index) => watchedTasks[(start + index) % watchedTasks.length]!);
  lastCheckedTaskId = selected.at(-1)!.id;
  return selected;
}

export async function refreshCloudTasks(deps: CloudTrackerDeps = {}): Promise<{ checked: number; updated: number }> {
  const gh = deps.gh ?? defaultCloudGh;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  let checked = 0;
  let updated = 0;
  let tasks: CloudTaskV1[];
  try {
    // The store already reads every task before applying its default 500-item
    // presentation cap. Rotate across the full watched set, not just that cap.
    tasks = listCloudTasks(Number.MAX_SAFE_INTEGER);
  } catch {
    return { checked, updated };
  }

  for (const task of tasks) {
    if ((task.state === 'queued' || task.state === 'launching') && nowMs - Date.parse(task.createdAt) > STALE_LAUNCH_MS) {
      try {
        if (commit(task, { ...task, state: 'failed', failure: 'unknown', stateReason: 'The launch was interrupted before a cloud session started.' })) updated += 1;
      } catch { /* never throw into callers */ }
    }
  }

  for (const task of watchedForRefresh(tasks, nowMs)) {
    checked += 1;
    let result: { ok: boolean; stdout: string; stderr: string };
    try {
      result = await gh(['pr', 'list', '--repo', task.repo, '--head', task.branch, '--state', 'all',
        '--json', 'number,url,state,isDraft,title,body,headRefName,baseRefName,headRepository,headRepositoryOwner,isCrossRepository',
        '--limit', String(GH_PR_LIMIT)]);
    } catch {
      if (clearUnverifiedDelivery(task, PR_LOOKUP_UNAVAILABLE_REASON)) updated += 1;
      continue;
    }
    if (!result.ok) {
      if (clearUnverifiedDelivery(task, PR_LOOKUP_UNAVAILABLE_REASON)) updated += 1;
      continue;
    }
    const results = parseGhPrList(result.stdout);
    if (results === undefined) {
      if (clearUnverifiedDelivery(task, PR_LOOKUP_UNAVAILABLE_REASON)) updated += 1;
      continue;
    }
    const matches = results.filter((pr) => matchesTask(pr, task));
    // A non-empty result with no exact match is an ambiguous lookup, not
    // evidence that the cloud session failed to deliver a PR.
    if (matches.length > 1 || (results.length > 0 && matches.length === 0)) {
      if (clearUnverifiedDelivery(task, PR_UNVERIFIED_REASON)) updated += 1;
      continue;
    }
    const ghPr = matches[0];

    let next: CloudTaskV1 | null = null;
    if (ghPr) {
      const pr = prFrom(ghPr);
      const pin = deliveryPin(task);
      if (pin && (pin.number !== pr.number || pin.url.toLowerCase() !== pr.url.toLowerCase())) {
        if (clearUnverifiedDelivery(task, PR_REPLACEMENT_REASON)) updated += 1;
        continue;
      }
      const { state, reason } = stateFor(pr);
      // The report is a claim in the PR's current body. A removed or changed
      // body cannot keep an earlier self-report visible as current evidence.
      const report = parseCloudReport(ghPr.body);
      if (state !== task.state || !same(pr, task.pr) || !same(report, task.report) || reason !== task.stateReason) {
        next = { ...task, state, pr, report, deliveryPin: pin ?? { number: pr.number, url: pr.url }, stateReason: reason, failure: null };
      } else if (!task.deliveryPin) {
        next = { ...task, deliveryPin: pin ?? { number: pr.number, url: pr.url } };
      }
    } else if (task.state === 'running' && nowMs - Date.parse(task.launchedAt ?? task.createdAt) > CLOUD_TASK_EXPIRY_MS) {
      next = { ...task, state: 'expired', stateReason: `No pull request arrived within ${Math.round(CLOUD_TASK_EXPIRY_MS / HOUR)} hours. The session link still works.` };
    } else if (task.state === 'pr-open') {
      if (clearUnverifiedDelivery(task, PR_UNVERIFIED_REASON)) updated += 1;
      continue;
    }
    if (!next) continue;
    try {
      if (commit(task, next)) updated += 1;
    } catch { /* a failed write leaves the task as it was */ }
  }
  return { checked, updated };
}
