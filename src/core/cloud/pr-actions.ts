/**
 * Cloud PR triage actions (3.13) — read a cloud task's pull request from
 * GitHub, preview it against the merge gates (pr-preview.ts), and let the
 * operator land it, close it or bring it up to date from Needs-you.
 *
 *   land           `gh pr ready` (a draft) then
 *                  `gh pr merge --squash --match-head-commit <sha>` — refused
 *                  when G1 hits a protected path or GitHub says it cannot merge
 *   close          `gh pr close --comment "<short>"`
 *   update-branch  PUT repos/<repo>/pulls/<n>/update-branch with expected_head_sha
 *
 * STRICT: every action names the head SHA the operator saw. It is compared
 * with GitHub's head before anything is sent, and the merge itself is pinned
 * to it (`--match-head-commit` / `expected_head_sha`), so a push between look
 * and click is a refusal, never a surprise landing. The PR must still be the
 * task's pinned delivery (same number, URL, head branch and base) — the same
 * identity rules the tracker applies.
 *
 * `gh` is injected (CloudPrActionDeps.gh) so tests never reach GitHub; the
 * default is the tracker's bounded, non-prompting runner. gh's stderr is
 * never forwarded: it is mapped to a fixed plain sentence.
 *
 * The preview cache lives here (in memory, keyed by task, with the diff
 * checks cached per head SHA so an unchanged branch is not re-downloaded):
 * cloud-api.ts refreshes it off the request path and Needs-you reads it.
 */
import { currentStandingPolicy } from '../authority/effective-config.js';
import type { EffectivePolicy } from '../authority/types.js';
import { repoPolicyFor } from '../fleet/merge-gates.js';
import {
  cloudPrDiffChecks,
  cloudPrPreview,
  landRefusal,
  type CloudPrCheck,
  type CloudPrChecksState,
  type CloudPrGithubState,
  type CloudPrPolicy,
  type CloudPrPreview,
} from './pr-preview.js';
import { readCloudTask, writeCloudTask } from './store.js';
import { defaultCloudGh } from './tracker.js';
import type { CloudTaskV1 } from './types.js';

export type CloudGh = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export interface CloudPrActionDeps {
  gh?: CloudGh;
  /** The live standing policy (null = no grant): the preview's scope caps. */
  policy?: () => EffectivePolicy | null;
  now?: () => Date;
}

export const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;
/** The comment `close` leaves on the PR. */
export const CLOUD_CLOSE_COMMENT = 'Closed from Ashlr Verse (Needs you) without landing.';
export const CLOUD_LANDED_REASON = (n: number): string => `Landed from Verse (#${n}).`;
export const CLOUD_CLOSED_REASON = 'Closed in Verse without landing.';

/** The one self repo rule the standing pass uses (defaultStandingPassDeps.isSelfRepo, minus proposal metadata a PR lacks). */
export function isCloudSelfRepo(repo: string, policy: EffectivePolicy | null): boolean {
  const repoPolicy = policy ? repoPolicyFor(policy, repo) : null;
  return (repoPolicy?.selfRepo ?? null) !== null || repo.toLowerCase() === 'ashlrai/ashlr-hub';
}

function policyFor(repo: string, policy: EffectivePolicy | null): CloudPrPolicy | null {
  const repoPolicy = policy ? repoPolicyFor(policy, repo) : null;
  return policy && repoPolicy ? { repo: repoPolicy, merge: policy.merge } : null;
}

function safePolicy(deps: CloudPrActionDeps): EffectivePolicy | null {
  try {
    return (deps.policy ?? currentStandingPolicy)();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading the PR
// ---------------------------------------------------------------------------

const PR_VIEW_FIELDS = 'number,url,state,isDraft,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,isCrossRepository';
/** Base branch names we will splice into an API path (argv, never a shell). */
const SAFE_REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * GitHub's required-checks rollup: any failure is red, anything unfinished is
 * pending, success / neutral / skipped are green, nothing reported is none.
 * An entry this cannot read counts as pending — never as green.
 */
export function rollupChecks(rollup: unknown): CloudPrChecksState {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let pending = false;
  for (const entry of rollup) {
    if (!isRecord(entry)) {
      pending = true;
      continue;
    }
    if (entry['__typename'] === 'StatusContext' || typeof entry['state'] === 'string') {
      const state = String(entry['state']);
      if (state === 'FAILURE' || state === 'ERROR') return 'red';
      if (state !== 'SUCCESS') pending = true;
      continue;
    }
    const status = String(entry['status'] ?? '');
    const conclusion = String(entry['conclusion'] ?? '');
    if (status !== 'COMPLETED') {
      pending = true;
      continue;
    }
    if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(conclusion)) return 'red';
    if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) pending = true;
  }
  return pending ? 'pending' : 'green';
}

export type CloudPrRead =
  | { ok: true; github: CloudPrGithubState; mergeBase: string | null }
  | { ok: false; status: 404 | 409 | 502; error: string };

/** The task's pinned, verified PR — or why it has none to act on. */
function actionablePr(task: CloudTaskV1): { number: number; url: string } | string {
  if (task.state !== 'pr-open') return 'This cloud task has no open pull request.';
  if (!task.pr) return "Verse can't verify this pull request right now. Refresh and try again.";
  const pin = task.deliveryPin ?? { number: task.pr.number, url: task.pr.url };
  if (pin.number !== task.pr.number || pin.url.toLowerCase() !== task.pr.url.toLowerCase()) {
    return "This task's pull request changed identity; review it on GitHub.";
  }
  return pin;
}

/** GitHub's view of the task's PR: identity-checked, then compared with its base. */
export async function readCloudPrGithub(task: CloudTaskV1, gh: CloudGh): Promise<CloudPrRead> {
  const pr = actionablePr(task);
  if (typeof pr === 'string') return { ok: false, status: 409, error: pr };
  let view: { ok: boolean; stdout: string };
  try {
    view = await gh(['pr', 'view', String(pr.number), '--repo', task.repo, '--json', PR_VIEW_FIELDS]);
  } catch {
    return { ok: false, status: 502, error: 'GitHub could not be reached.' };
  }
  const raw = view.ok ? parseJson(view.stdout) : undefined;
  if (!isRecord(raw)) return { ok: false, status: 502, error: 'GitHub did not describe the pull request.' };
  const state = raw['state'];
  const mergeable = raw['mergeable'];
  const headSha = raw['headRefOid'];
  if (raw['number'] !== pr.number
    || typeof raw['url'] !== 'string' || raw['url'].toLowerCase() !== pr.url.toLowerCase()
    || raw['headRefName'] !== task.branch
    || raw['baseRefName'] !== task.baseBranch
    || raw['isCrossRepository'] !== false) {
    return { ok: false, status: 409, error: "GitHub's pull request no longer matches this task; review it on GitHub." };
  }
  if ((state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED')
    || typeof raw['isDraft'] !== 'boolean'
    || typeof headSha !== 'string' || !HEAD_SHA_PATTERN.test(headSha)) {
    return { ok: false, status: 502, error: 'GitHub did not describe the pull request.' };
  }
  const github: CloudPrGithubState = {
    state,
    isDraft: raw['isDraft'],
    headSha,
    mergeable: mergeable === 'MERGEABLE' || mergeable === 'CONFLICTING' ? mergeable : 'UNKNOWN',
    mergeStateStatus: typeof raw['mergeStateStatus'] === 'string' ? raw['mergeStateStatus'].toUpperCase() : 'UNKNOWN',
    behindBy: null,
    checks: rollupChecks(raw['statusCheckRollup']),
  };
  let mergeBase: string | null = null;
  if (SAFE_REF_RE.test(task.baseBranch) && !task.baseBranch.includes('..')) {
    try {
      const cmp = await gh(['api', `repos/${task.repo}/compare/${task.baseBranch}...${headSha}`,
        '--jq', '{behind_by: .behind_by, merge_base: .merge_base_commit.sha}']);
      const parsed = cmp.ok ? parseJson(cmp.stdout) : undefined;
      if (isRecord(parsed)) {
        if (Number.isSafeInteger(parsed['behind_by']) && (parsed['behind_by'] as number) >= 0) github.behindBy = parsed['behind_by'] as number;
        if (typeof parsed['merge_base'] === 'string' && HEAD_SHA_PATTERN.test(parsed['merge_base'])) mergeBase = parsed['merge_base'];
      }
    } catch { /* not compared: behindBy stays null */ }
  }
  return { ok: true, github, mergeBase };
}

/**
 * The PR's diff pinned to two commits (merge base … head): exactly what the
 * head SHA changes, whatever is pushed while it downloads. Null when it
 * cannot be read in full (a truncated diff is never judged).
 */
export async function readPinnedDiff(task: CloudTaskV1, mergeBase: string | null, headSha: string, gh: CloudGh): Promise<string | null> {
  if (!mergeBase || !HEAD_SHA_PATTERN.test(mergeBase) || !HEAD_SHA_PATTERN.test(headSha)) return null;
  try {
    const result = await gh(['api', '-H', 'Accept: application/vnd.github.diff', `repos/${task.repo}/compare/${mergeBase}...${headSha}`]);
    return result.ok ? result.stdout : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Preview cache
// ---------------------------------------------------------------------------

/** A preview is re-read after this long (GitHub state: checks, behind, conflicts). */
export const CLOUD_PR_PREVIEW_TTL_MS = 5 * 60 * 1000;
/** Bound on PRs previewed per refresh (each is two or three `gh` calls). */
const MAX_PREVIEWS_PER_REFRESH = 12;

const previews = new Map<string, CloudPrPreview>();
const diffChecksBySha = new Map<string, { headSha: string; checks: CloudPrCheck[] }>();

export function cachedCloudPrPreviews(): ReadonlyMap<string, CloudPrPreview> {
  return previews;
}

export function forgetCloudPrPreview(taskId: string): void {
  previews.delete(taskId);
}

/** Test seam. */
export function resetCloudPrPreviewsForTest(): void {
  previews.clear();
  diffChecksBySha.clear();
}

export const previewable = (task: CloudTaskV1): boolean => task.state === 'pr-open' && task.pr !== null && task.pr.state === 'open';

/** Some open cloud PR has no preview, or one older than the TTL. */
export function cloudPrPreviewsStale(tasks: readonly CloudTaskV1[], nowMs: number): boolean {
  return tasks.some((task) => {
    if (!previewable(task)) return false;
    const cached = previews.get(task.id);
    return !cached || nowMs - Date.parse(cached.computedAt) >= CLOUD_PR_PREVIEW_TTL_MS;
  });
}

/** Read one PR and judge it; the diff checks are reused while the head SHA is unchanged. */
export async function previewCloudPr(task: CloudTaskV1, deps: CloudPrActionDeps = {}): Promise<CloudPrPreview | null> {
  const gh = deps.gh ?? defaultCloudGh;
  const read = await readCloudPrGithub(task, gh);
  if (!read.ok) return null;
  const { github } = read;
  let diffChecks = diffChecksBySha.get(task.id);
  if (!diffChecks || diffChecks.headSha !== github.headSha) {
    const policy = safePolicy(deps);
    const diff = await readPinnedDiff(task, read.mergeBase, github.headSha, gh);
    diffChecks = {
      headSha: github.headSha,
      checks: cloudPrDiffChecks({ repo: task.repo, diff, selfRepo: isCloudSelfRepo(task.repo, policy), report: task.report, policy: policyFor(task.repo, policy) }),
    };
    // An unreadable diff is retried on the next refresh, not cached.
    if (diff !== null) diffChecksBySha.set(task.id, diffChecks);
  }
  return cloudPrPreview({
    taskId: task.id,
    prNumber: task.pr!.number,
    baseBranch: task.baseBranch,
    github,
    diffChecks: diffChecks.checks,
    now: (deps.now ?? (() => new Date()))(),
  });
}

/**
 * Re-preview the stalest open cloud PRs (at most 12 per call). A PR that
 * cannot be read keeps no preview — Needs-you then offers only Dismiss, never
 * a Land built on an old answer.
 */
export async function refreshCloudPrPreviews(tasks: readonly CloudTaskV1[], deps: CloudPrActionDeps = {}): Promise<{ checked: number; updated: number }> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const open = tasks.filter(previewable);
  const openIds = new Set(open.map((t) => t.id));
  for (const id of [...previews.keys()]) if (!openIds.has(id)) previews.delete(id);
  for (const id of [...diffChecksBySha.keys()]) if (!openIds.has(id)) diffChecksBySha.delete(id);
  const age = (task: CloudTaskV1): number => {
    const cached = previews.get(task.id);
    return cached ? nowMs - Date.parse(cached.computedAt) : Number.POSITIVE_INFINITY;
  };
  const due = open.filter((t) => age(t) >= CLOUD_PR_PREVIEW_TTL_MS).sort((a, b) => age(b) - age(a)).slice(0, MAX_PREVIEWS_PER_REFRESH);
  let updated = 0;
  for (const task of due) {
    let preview: CloudPrPreview | null = null;
    try {
      preview = await previewCloudPr(task, deps);
    } catch {
      preview = null;
    }
    if (preview) {
      previews.set(task.id, preview);
      updated += 1;
    } else previews.delete(task.id);
  }
  return { checked: due.length, updated };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type CloudPrActionResult =
  | { ok: true; task: CloudTaskV1; message: string }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string };

/** gh's stderr → one fixed sentence. Never forwarded verbatim (it can quote URLs, paths, tokens). */
export function ghRefusal(stderr: string, fallback: string): string {
  const text = stderr.toLowerCase();
  if (/head (branch|commit|sha)|expected head|match-head-commit|was modified/.test(text)) return 'The branch moved since it was checked. Review it again.';
  if (/conflict|not mergeable/.test(text)) return 'GitHub cannot merge it: it conflicts with the base branch.';
  if (/required status|status check|review required|approving review|protected branch|base branch policy/.test(text)) {
    return 'Branch protection refused it: required checks or reviews are missing.';
  }
  if (/gh auth login|authentication|http 401|bad credentials/.test(text)) return 'gh is not signed in to GitHub on this machine.';
  if (/http 403|permission|not permitted|resource not accessible/.test(text)) return "GitHub says this account can't do that here.";
  if (/could not resolve|not found|http 404/.test(text)) return 'GitHub could not find that pull request.';
  return fallback;
}

const inFlight = new Set<string>();

async function withTask(
  taskId: string,
  headSha: string,
  deps: CloudPrActionDeps,
  run: (task: CloudTaskV1, read: Extract<CloudPrRead, { ok: true }>, gh: CloudGh) => Promise<CloudPrActionResult>,
): Promise<CloudPrActionResult> {
  if (!HEAD_SHA_PATTERN.test(headSha)) return { ok: false, status: 400, error: 'A full 40-character head commit is required.' };
  const task = readCloudTask(taskId);
  if (!task) return { ok: false, status: 404, error: 'No cloud task with that id.' };
  if (inFlight.has(taskId)) return { ok: false, status: 409, error: 'Another action on this pull request is still running.' };
  inFlight.add(taskId);
  try {
    const gh = deps.gh ?? defaultCloudGh;
    const read = await readCloudPrGithub(task, gh);
    if (!read.ok) return read;
    if (read.github.state !== 'OPEN') {
      return { ok: false, status: 409, error: `The pull request is ${read.github.state === 'MERGED' ? 'already merged' : 'closed'}. Refresh to update Verse.` };
    }
    if (read.github.headSha !== headSha) {
      return { ok: false, status: 409, error: `The branch moved since you looked (now ${read.github.headSha.slice(0, 7)}). Review it again.` };
    }
    return await run(task, read, gh);
  } finally {
    forgetCloudPrPreview(taskId);
    inFlight.delete(taskId);
  }
}

/** Record an outcome on the task unless something else changed it meanwhile. */
function recordOutcome(taskId: string, patch: (task: CloudTaskV1) => CloudTaskV1): CloudTaskV1 | null {
  const current = readCloudTask(taskId);
  if (!current || current.state !== 'pr-open') return current;
  const next = patch(current);
  try {
    writeCloudTask(next);
  } catch {
    return current;
  }
  return next;
}

/** `gh pr ready` — cloud PRs arrive as drafts, and GitHub will not merge a draft. */
export async function readyCloudPr(task: CloudTaskV1, prNumber: number, gh: CloudGh): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const result = await gh(['pr', 'ready', String(prNumber), '--repo', task.repo]);
    return result.ok ? { ok: true } : { ok: false, error: ghRefusal(result.stderr, 'GitHub would not mark the draft ready for review.') };
  } catch {
    return { ok: false, error: 'GitHub could not be reached.' };
  }
}

/**
 * Land: squash-merge exactly `headSha`. Refused when G1 hits a protected path
 * (the owner lane: those are landed on GitHub after review) or GitHub cannot
 * merge it. The diff is re-read and re-judged here — a preview is advice, the
 * refusal is made on the commit being merged.
 */
export async function landCloudPr(taskId: string, headSha: string, deps: CloudPrActionDeps = {}): Promise<CloudPrActionResult> {
  return withTask(taskId, headSha, deps, async (task, read, gh) => {
    const prNumber = task.pr!.number;
    const policy = safePolicy(deps);
    const diff = await readPinnedDiff(task, read.mergeBase, headSha, gh);
    const checks = cloudPrDiffChecks({ repo: task.repo, diff, selfRepo: isCloudSelfRepo(task.repo, policy), report: task.report, policy: policyFor(task.repo, policy) });
    const refusal = landRefusal(read.github, checks, task.baseBranch);
    if (refusal) return { ok: false, status: 409, error: refusal };
    if (read.github.isDraft) {
      const ready = await readyCloudPr(task, prNumber, gh);
      if (!ready.ok) return { ok: false, status: 502, error: ready.error };
    }
    let merged: { ok: boolean; stderr: string };
    try {
      merged = await gh(['pr', 'merge', String(prNumber), '--repo', task.repo, '--squash', '--match-head-commit', headSha]);
    } catch {
      return { ok: false, status: 502, error: 'GitHub could not be reached.' };
    }
    if (!merged.ok) return { ok: false, status: 409, error: ghRefusal(merged.stderr, 'GitHub refused the merge.') };
    const next = recordOutcome(taskId, (t) => ({
      ...t,
      state: 'merged',
      pr: t.pr ? { ...t.pr, state: 'merged', draft: false } : t.pr,
      stateReason: CLOUD_LANDED_REASON(prNumber),
    }));
    return { ok: true, task: next ?? task, message: `Landed #${prNumber}.` };
  });
}

/** Close without landing, leaving a short comment. The branch is kept. */
export async function closeCloudPr(taskId: string, headSha: string, deps: CloudPrActionDeps = {}): Promise<CloudPrActionResult> {
  return withTask(taskId, headSha, deps, async (task, _read, gh) => {
    const prNumber = task.pr!.number;
    let closed: { ok: boolean; stderr: string };
    try {
      closed = await gh(['pr', 'close', String(prNumber), '--repo', task.repo, '--comment', CLOUD_CLOSE_COMMENT]);
    } catch {
      return { ok: false, status: 502, error: 'GitHub could not be reached.' };
    }
    if (!closed.ok) return { ok: false, status: 409, error: ghRefusal(closed.stderr, 'GitHub would not close the pull request.') };
    const next = recordOutcome(taskId, (t) => ({
      ...t,
      state: 'closed',
      pr: t.pr ? { ...t.pr, state: 'closed' } : t.pr,
      stateReason: CLOUD_CLOSED_REASON,
    }));
    return { ok: true, task: next ?? task, message: `Closed #${prNumber}.` };
  });
}

/** Merge the base branch into the PR branch on GitHub (only if its head is still `headSha`). */
export async function updateCloudPrBranch(taskId: string, headSha: string, deps: CloudPrActionDeps = {}): Promise<CloudPrActionResult> {
  return withTask(taskId, headSha, deps, async (task, read, gh) => {
    const prNumber = task.pr!.number;
    if (read.github.behindBy === 0 && read.github.mergeStateStatus !== 'BEHIND') {
      return { ok: false, status: 409, error: `#${prNumber} is already up to date with ${task.baseBranch}.` };
    }
    let updated: { ok: boolean; stderr: string };
    try {
      updated = await gh(['api', '-X', 'PUT', `repos/${task.repo}/pulls/${prNumber}/update-branch`, '-f', `expected_head_sha=${headSha}`]);
    } catch {
      return { ok: false, status: 502, error: 'GitHub could not be reached.' };
    }
    if (!updated.ok) return { ok: false, status: 409, error: ghRefusal(updated.stderr, 'GitHub would not update the branch.') };
    return { ok: true, task, message: `Updating #${prNumber} from ${task.baseBranch}; checks will run again.` };
  });
}
