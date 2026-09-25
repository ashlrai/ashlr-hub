/**
 * Delivery tracker (unit C1): for every non-terminal task, ask GitHub for a
 * PR whose head is `task.branch` (`gh pr list --repo <repo> --head <branch>
 * --state all --json number,url,state,isDraft,title,body --limit 1`), update
 * state/pr/report, and expire tasks with no PR after CLOUD_TASK_EXPIRY_MS.
 * `gh` failures leave tasks unchanged (never throw into callers).
 *
 * Transitions:
 *   running  → pr-open | merged | closed   (a PR appeared on the branch)
 *   pr-open  → merged | closed             (and pr/report stay current while open)
 *   running  → expired                     (no PR after CLOUD_TASK_EXPIRY_MS)
 *   expired  → pr-open | merged | closed   (a late PR, within EXPIRED_WATCH_MS)
 *   queued | launching → failed            (a launch interrupted by a restart)
 */
import { tmpdir } from 'node:os';

import { defaultGitRunner } from '../verse/git-ops.js';
import { parseCloudReport } from './delivery-contract.js';
import { listCloudTasks, readCloudTask, writeCloudTask } from './store.js';
import { CLOUD_LAUNCH_TIMEOUT_MS, CLOUD_TASK_EXPIRY_MS, type CloudTaskPr, type CloudTaskState, type CloudTaskV1 } from './types.js';

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
/**
 * A task still `queued`/`launching` this long after creation was orphaned by
 * a server restart mid-launch (a live launch finishes within the checkout +
 * CLOUD_LAUNCH_TIMEOUT_MS). Left alone it would hold a concurrency slot forever.
 */
export const STALE_LAUNCH_MS = 10 * CLOUD_LAUNCH_TIMEOUT_MS;
/** Bound on gh calls per refresh; newest tasks are checked first. */
const MAX_CHECKS_PER_REFRESH = 50;
const GH_TIMEOUT_MS = 30_000;

/** Production gh: argv only, bounded, never prompts (git-ops' runner and env). */
export async function defaultCloudGh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await defaultGitRunner('gh', args, { cwd: tmpdir(), timeoutMs: GH_TIMEOUT_MS, maxStdoutBytes: 2 * 1024 * 1024 });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
}

interface GhPr {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  title: string;
  body: string | null;
}

/** First PR of `gh pr list --json …` output; undefined when the output is not what gh prints (a failure, not "no PR"). */
function parseGhPrList(stdout: string): GhPr | null | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return null;
  const pr = value[0] as Record<string, unknown> | null;
  if (!pr || typeof pr !== 'object' || typeof pr['number'] !== 'number' || typeof pr['url'] !== 'string' || typeof pr['state'] !== 'string') return undefined;
  return {
    number: pr['number'],
    url: pr['url'],
    state: pr['state'],
    isDraft: pr['isDraft'] === true,
    title: typeof pr['title'] === 'string' ? pr['title'] : '',
    body: typeof pr['body'] === 'string' ? pr['body'] : null,
  };
}

function prFrom(gh: GhPr): CloudTaskPr | null {
  const state = gh.state.toUpperCase();
  const mapped: CloudTaskPr['state'] | null = state === 'OPEN' ? 'open' : state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : null;
  if (!mapped || !/^https:\/\/github\.com\//.test(gh.url)) return null;
  return { number: gh.number, url: gh.url, state: mapped, draft: gh.isDraft, title: gh.title.slice(0, 300) };
}

function stateFor(pr: CloudTaskPr): { state: CloudTaskState; reason: string } {
  if (pr.state === 'merged') return { state: 'merged', reason: `Pull request #${pr.number} was merged.` };
  if (pr.state === 'closed') return { state: 'closed', reason: `Pull request #${pr.number} was closed without merging.` };
  return { state: 'pr-open', reason: `${pr.draft ? 'Draft pull request' : 'Pull request'} #${pr.number} is open for review.` };
}

const watched = (task: CloudTaskV1, nowMs: number): boolean =>
  task.state === 'running' || task.state === 'pr-open'
  || (task.state === 'expired' && task.pr === null && nowMs - Date.parse(task.createdAt) < EXPIRED_WATCH_MS);

/** Writes `next` only when the task on disk is still the one this refresh read (a launch or dismiss in between wins). */
function commit(before: CloudTaskV1, next: CloudTaskV1): boolean {
  const current = readCloudTask(before.id);
  if (!current || current.updatedAt !== before.updatedAt || current.state !== before.state) return false;
  writeCloudTask(next);
  return true;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function refreshCloudTasks(deps: CloudTrackerDeps = {}): Promise<{ checked: number; updated: number }> {
  const gh = deps.gh ?? defaultCloudGh;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  let checked = 0;
  let updated = 0;
  let tasks: CloudTaskV1[];
  try {
    tasks = listCloudTasks();
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

  for (const task of tasks.filter((t) => watched(t, nowMs)).slice(0, MAX_CHECKS_PER_REFRESH)) {
    checked += 1;
    let result: { ok: boolean; stdout: string; stderr: string };
    try {
      result = await gh(['pr', 'list', '--repo', task.repo, '--head', task.branch, '--state', 'all',
        '--json', 'number,url,state,isDraft,title,body', '--limit', '1']);
    } catch {
      continue;
    }
    if (!result.ok) continue;
    const ghPr = parseGhPrList(result.stdout);
    if (ghPr === undefined) continue;

    let next: CloudTaskV1 | null = null;
    if (ghPr) {
      const pr = prFrom(ghPr);
      if (!pr) continue;
      const { state, reason } = stateFor(pr);
      // A PR edited to drop its report keeps the last good one.
      const report = parseCloudReport(ghPr.body) ?? task.report;
      if (state !== task.state || !same(pr, task.pr) || !same(report, task.report) || reason !== task.stateReason) {
        next = { ...task, state, pr, report, stateReason: reason, failure: null };
      }
    } else if (task.state === 'running' && nowMs - Date.parse(task.launchedAt ?? task.createdAt) > CLOUD_TASK_EXPIRY_MS) {
      next = { ...task, state: 'expired', stateReason: `No pull request arrived within ${Math.round(CLOUD_TASK_EXPIRY_MS / HOUR)} hours. The session link still works.` };
    }
    if (!next) continue;
    try {
      if (commit(task, next)) updated += 1;
    } catch { /* a failed write leaves the task as it was */ }
  }
  return { checked, updated };
}
