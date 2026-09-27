/**
 * Devin tracker (3.15): poll each watched task's session (GET
 * /v3/organizations/{org}/sessions/{id}) for status and ACUs, and ask GitHub
 * — the only authority for delivery — for the PR on `ashlr-devin/<id>`, with
 * EXACTLY the cloud lane's identity rules (cloud/tracker.ts parseGhPrList /
 * matchesTask: canonical URL, head ref, base ref, same repository).
 *
 * A PR URL Devin reports (pull_requests[].pr_url) is a HINT, never delivery:
 * a PR that is not on the task's branch is surfaced in the reason ("review it
 * on GitHub") and never pinned, so it can never reach the gates.
 *
 * Session → task state (no PR yet):
 *   running + working | new | claimed | resuming      → running
 *   running + waiting_for_user | waiting_for_approval  → blocked (Needs-you)
 *   suspended (credits, quota, usage limits, inactivity, user request)
 *                                                      → blocked, reason says why
 *   exit | running + finished                          → expired ("finished without a PR")
 *   error                                              → failed (session-error)
 * A verified PR decides the state (pr-open / merged / closed) whatever the
 * session says. A superseded task follows its fleet App PR (cloud tracker's
 * readSupersedingState). An unreadable API or GitHub answer changes nothing.
 */
import {
  GH_PR_LIMIT,
  GH_PR_LIST_FIELDS,
  defaultCloudGh,
  matchesTask,
  parseGhPrList,
  prFrom,
  readSupersedingState,
  stateFor,
} from '../cloud/tracker.js';
import type { CloudTaskReport } from '../cloud/types.js';
import type { DevinClient, DevinSession } from './client.js';
import { devinReportFromStructuredOutput, parseDevinReport } from './delivery-contract.js';
import { connectedClient, recordDevinApiOutcome, snapshotOf, type DevinServiceDeps } from './service.js';
import { listDevinTasks, readDevinTask, writeDevinTask } from './store.js';
import { DEVIN_TASK_EXPIRY_MS, type DevinTaskState, type DevinTaskV1 } from './types.js';

export interface DevinTrackerDeps extends DevinServiceDeps {
  /** A ready client (tests); default: the stored key + org. */
  client?: { client: Pick<DevinClient, 'getSession'>; orgId: string } | null;
}

const HOUR = 60 * 60 * 1000;
/** Expired tasks stay watched this long after creation so a late PR is not lost. */
export const DEVIN_EXPIRED_WATCH_MS = 48 * HOUR;
/** queued / launching this long means the launch was interrupted by a restart. */
export const DEVIN_STALE_LAUNCH_MS = 10 * 60 * 1000;
const MAX_CHECKS_PER_REFRESH = 30;

const WAITING_DETAILS = new Set(['waiting_for_user', 'waiting_for_approval']);
const SUSPEND_REASONS: Readonly<Record<string, string>> = {
  inactivity: 'Devin went to sleep after a quiet spell. Reply to wake it.',
  user_request: 'The session was paused from Devin. Reply to resume it.',
  usage_limit_exceeded: 'Devin stopped: a usage limit was reached.',
  out_of_credits: 'Devin stopped: the account is out of credits.',
  out_of_quota: 'Devin stopped: the plan quota is used up.',
  no_quota_allocation: 'Devin stopped: this user has no quota allocation.',
  payment_declined: 'Devin stopped: a payment was declined.',
  org_usage_limit_exceeded: "Devin stopped: the organization's usage limit was reached.",
  user_usage_limit_exceeded: "Devin stopped: this user's usage limit was reached.",
  total_session_limit_exceeded: 'Devin stopped: the session hit its ACU cap.',
  contract_expired: 'Devin stopped: the contract has expired.',
  error: 'Devin suspended the session after an error.',
};

const watched = (task: DevinTaskV1, nowMs: number): boolean =>
  task.state === 'running' || task.state === 'blocked' || task.state === 'pr-open'
  || (task.state === 'expired' && task.pr === null && nowMs - Date.parse(task.createdAt) < DEVIN_EXPIRED_WATCH_MS);

/** Writes `next` only when the task on disk is still the one this refresh read. */
function commit(before: DevinTaskV1, next: DevinTaskV1): boolean {
  const current = readDevinTask(before.id);
  if (!current || current.updatedAt !== before.updatedAt || current.state !== before.state) return false;
  writeDevinTask(next);
  return true;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Session facts → the state the task would have with no PR. Null: leave the state alone. */
export function stateFromSession(task: DevinTaskV1, session: DevinSession): { state: DevinTaskState; reason: string; failure: DevinTaskV1['failure'] } | null {
  const detail = session.statusDetail ?? '';
  switch (session.status) {
    case 'new':
    case 'claimed':
    case 'resuming':
      return { state: 'running', reason: 'Devin is starting up.', failure: null };
    case 'running':
      if (WAITING_DETAILS.has(detail)) {
        return {
          state: 'blocked',
          reason: detail === 'waiting_for_approval' ? 'Devin is waiting for an approval in the session.' : 'Devin is waiting for your reply.',
          failure: null,
        };
      }
      if (detail === 'finished') {
        return { state: 'expired', reason: `Devin finished without a pull request on ${task.branch}. The session link still works.`, failure: null };
      }
      return { state: 'running', reason: 'Devin is working. Its pull request will appear here.', failure: null };
    case 'suspended':
      return { state: 'blocked', reason: SUSPEND_REASONS[detail] ?? 'Devin paused the session.', failure: null };
    case 'exit':
      return { state: 'expired', reason: `Devin finished without a pull request on ${task.branch}. The session link still works.`, failure: null };
    case 'error':
      return { state: 'failed', reason: 'The Devin session ended in an error.', failure: 'session-error' };
    default:
      return null;
  }
}

/** A PR Devin reports that is NOT the task's delivery (another branch, repo or a fork). */
function strayPrHint(task: DevinTaskV1, session: DevinSession | null): string | null {
  if (!session) return null;
  const canonical = new RegExp(`^https://github\\.com/${task.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/\\d+$`, 'i');
  const stray = session.pullRequests.find((pr) => !(task.pr && pr.url.toLowerCase() === task.pr.url.toLowerCase()));
  if (!stray) return null;
  return canonical.test(stray.url)
    ? `Devin reports a pull request that is not on ${task.branch}, so it cannot go through the gates. Review it on GitHub.`
    : 'Devin reports a pull request outside this repository; it is ignored.';
}

let lastCheckedTaskId: string | null = null;
function watchedForRefresh(tasks: readonly DevinTaskV1[], nowMs: number): DevinTaskV1[] {
  const list = tasks.filter((task) => watched(task, nowMs));
  if (list.length <= MAX_CHECKS_PER_REFRESH) {
    lastCheckedTaskId = list.at(-1)?.id ?? null;
    return list;
  }
  const prior = list.findIndex((task) => task.id === lastCheckedTaskId);
  const start = prior >= 0 ? (prior + 1) % list.length : 0;
  const selected = Array.from({ length: MAX_CHECKS_PER_REFRESH }, (_, i) => list[(start + i) % list.length]!);
  lastCheckedTaskId = selected.at(-1)!.id;
  return selected;
}

export function resetDevinTrackerCursorForTest(): void {
  lastCheckedTaskId = null;
}

export async function refreshDevinTasks(deps: DevinTrackerDeps = {}): Promise<{ checked: number; updated: number }> {
  const gh = deps.gh ?? defaultCloudGh;
  const clock = deps.now ?? (() => new Date());
  const nowMs = clock().getTime();
  let checked = 0;
  let updated = 0;
  let tasks: DevinTaskV1[];
  try {
    tasks = listDevinTasks(Number.MAX_SAFE_INTEGER);
  } catch {
    return { checked, updated };
  }

  for (const task of tasks) {
    if ((task.state === 'queued' || task.state === 'launching') && nowMs - Date.parse(task.createdAt) > DEVIN_STALE_LAUNCH_MS) {
      try {
        // `network`: the create may have gone out, so its cap keeps counting (budget.ts).
        if (commit(task, { ...task, state: 'failed', failure: 'network', stateReason: 'The launch was interrupted before Devin answered. Check app.devin.ai.' })) updated += 1;
      } catch { /* never throw into callers */ }
    }
  }

  const due = watchedForRefresh(tasks, nowMs);
  if (due.length === 0) return { checked, updated };

  // One client for the sweep; without one the GitHub half still runs.
  let api: { client: Pick<DevinClient, 'getSession'>; orgId: string } | null = null;
  if (deps.client !== undefined) api = deps.client;
  else {
    try {
      const connected = await connectedClient(deps);
      api = 'error' in connected ? null : connected;
    } catch {
      api = null;
    }
  }

  for (const task of due) {
    checked += 1;
    if (task.supersededBy) {
      const next = await readSupersedingState(task, gh);
      if (next && (next.state !== task.state || next.reason !== task.stateReason)) {
        try {
          if (commit(task, { ...task, state: next.state, stateReason: next.reason, failure: null })) updated += 1;
        } catch { /* unchanged */ }
      }
      continue;
    }

    // ── Devin: status + ACUs ─────────────────────────────────────────────
    let session: DevinSession | null = null;
    if (api && task.sessionId) {
      try {
        session = await api.client.getSession(api.orgId, task.sessionId);
        recordDevinApiOutcome(null);
      } catch (error) {
        recordDevinApiOutcome(error);
        session = null;
      }
    }

    // ── GitHub: the delivery ─────────────────────────────────────────────
    let ghPrs: ReturnType<typeof parseGhPrList>;
    try {
      const result = await gh(['pr', 'list', '--repo', task.repo, '--head', task.branch, '--state', 'all',
        '--json', `${GH_PR_LIST_FIELDS},headRefOid`, '--limit', String(GH_PR_LIMIT)]);
      ghPrs = result.ok ? parseGhPrList(result.stdout) : undefined;
    } catch {
      ghPrs = undefined;
    }
    const matches = ghPrs ? ghPrs.filter((pr) => matchesTask(pr, task)) : [];
    const ambiguous = ghPrs !== undefined && (matches.length > 1 || (ghPrs.length > 0 && matches.length === 0));
    const ghPr = ghPrs !== undefined && !ambiguous ? matches[0] : undefined;

    let next: DevinTaskV1 = { ...task };
    if (session) next.session = snapshotOf(session, clock());
    const structured = session ? devinReportFromStructuredOutput(session.structuredOutput) : null;

    if (ghPr) {
      const pr = prFrom(ghPr);
      const pin = task.deliveryPin ?? null;
      if (pin && (pin.number !== pr.number || pin.url.toLowerCase() !== pr.url.toLowerCase())) {
        // A different PR on the branch: hide the old delivery, keep the pin (same rule as the cloud lane).
        next = { ...next, pr: null, report: null, headSha: null, stateReason: 'A different pull request was found; the previously verified delivery is hidden.' };
      } else {
        const { state, reason } = stateFor(pr);
        const report: CloudTaskReport | null = parseDevinReport(ghPr.body) ?? structured;
        const headSha = typeof ghPr.headRefOid === 'string' && /^[0-9a-f]{40}$/.test(ghPr.headRefOid) ? ghPr.headRefOid : null;
        next = { ...next, state, stateReason: reason, pr, report, headSha, deliveryPin: pin ?? { number: pr.number, url: pr.url }, failure: null };
      }
    } else if (task.state === 'pr-open') {
      // A verified PR we can no longer see: hide it until it verifies again (never guess).
      const reason = ghPrs === undefined
        ? 'Pull request verification is unavailable; the previously verified delivery is hidden.'
        : 'Previously recorded pull request could not be verified on GitHub.';
      next = { ...next, pr: null, report: null, headSha: null, stateReason: reason };
    } else if (session) {
      const mapped = stateFromSession(task, session);
      if (mapped) {
        const stray = mapped.state === 'expired' ? strayPrHint(task, session) : null;
        next = { ...next, state: mapped.state, stateReason: stray ? `${mapped.reason} ${stray}` : mapped.reason, failure: mapped.failure };
      }
      if (structured && !next.report) next.report = structured;
    }
    if (next.state === 'running' && !ghPr && nowMs - Date.parse(task.launchedAt ?? task.createdAt) > DEVIN_TASK_EXPIRY_MS) {
      next = { ...next, state: 'expired', stateReason: `No pull request arrived within ${Math.round(DEVIN_TASK_EXPIRY_MS / HOUR)} hours. The session link still works.` };
    }

    // `session.readAt` changes every read: compare without it so an idle task is not rewritten each sweep.
    const strip = (t: DevinTaskV1): unknown => ({ ...t, updatedAt: null, session: t.session ? { ...t.session, readAt: null } : null });
    if (same(strip(next), strip(task))) continue;
    try {
      if (commit(task, next)) updated += 1;
    } catch { /* a failed write leaves the task as it was */ }
  }
  return { checked, updated };
}
