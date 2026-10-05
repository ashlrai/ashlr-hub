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
import { hasAmbiguousDevinCreate, previewDevinCreateRecovery } from './create-recovery.js';
import { devinReportFromStructuredOutput, parseDevinReport } from './delivery-contract.js';
import { connectedClient, recordDevinApiOutcome, snapshotOf, type DevinServiceDeps } from './service.js';
import { listDevinTasks, readDevinTask, writeDevinTask } from './store.js';
import { DEVIN_TASK_EXPIRY_MS, type DevinTaskV1 } from './types.js';
import { stateFromSession } from './session-state.js';

// Preserve the existing tracker API while keeping the shared mapper inert.
export { stateFromSession } from './session-state.js';

export interface DevinTrackerDeps extends DevinServiceDeps {
  /** A ready client (tests); default: the stored key + org. */
  client?: { client: Pick<DevinClient, 'getSession'> & Partial<Pick<DevinClient, 'listSessions'>>; orgId: string } | null;
}

const HOUR = 60 * 60 * 1000;
/** Expired tasks stay watched this long after creation so a late PR is not lost. */
export const DEVIN_EXPIRED_WATCH_MS = 48 * HOUR;
/** queued / launching this long means the launch was interrupted by a restart. */
export const DEVIN_STALE_LAUNCH_MS = 10 * 60 * 1000;
const MAX_CHECKS_PER_REFRESH = 30;

const watched = (task: DevinTaskV1, nowMs: number): boolean =>
  task.state === 'running' || task.state === 'blocked' || task.state === 'pr-open'
  || (task.state === 'expired' && task.pr === null && nowMs - Date.parse(task.createdAt) < DEVIN_EXPIRED_WATCH_MS);

/** Local dismissal/age/delivery does not establish that remote billing stopped. */
function unsettledRemoteUsage(task: DevinTaskV1): boolean {
  if (task.sessionId === null) return false;
  const observation = task.session;
  return observation === null || !['exit', 'error'].includes(observation.status)
    || typeof observation.acusConsumed !== 'number' || !Number.isFinite(observation.acusConsumed) || observation.acusConsumed < 0;
}

/** Shared scheduler/tracker eligibility, independent of local visibility and delivery age. */
export function devinTaskNeedsObservation(task: DevinTaskV1): boolean {
  return unsettledRemoteUsage(task) || (hasAmbiguousDevinCreate(task) && task.launchOrgId !== undefined);
}

/** Writes `next` only when the task on disk is still the one this refresh read. */
function commit(before: DevinTaskV1, next: DevinTaskV1): boolean {
  const current = readDevinTask(before.id);
  if (!current || current.updatedAt !== before.updatedAt || current.state !== before.state) return false;
  writeDevinTask(next);
  return true;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

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
  const list = tasks.filter((task) => watched(task, nowMs) || devinTaskNeedsObservation(task));
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
  let api: DevinTrackerDeps['client'] = null;
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
    if (hasAmbiguousDevinCreate(task)) {
      // Legacy holds are preview-only: today's saved login cannot prove which
      // organization accepted an older create, so do not poll all its history.
      if (task.launchOrgId === undefined) continue;
      if (!api?.client.listSessions) continue;
      const preview = await previewDevinCreateRecovery(task, {
        orgId: api.orgId,
        client: { listSessions: api.client.listSessions.bind(api.client), getSession: api.client.getSession.bind(api.client) },
      });
      if (preview.kind !== 'match' || !preview.launchAccountBound) continue;
      const session = preview.session;
      // A still-running/paused session is not proof of settled spend. Keep the
      // full create hold until a literal terminal status AND actual ACUs exist.
      if (!['exit', 'error'].includes(session.status)
        || typeof session.acusConsumed !== 'number' || !Number.isFinite(session.acusConsumed) || session.acusConsumed < 0) continue;
      const mapped = stateFromSession(task, session);
      if (!mapped) continue;
      try {
        const next: DevinTaskV1 = { ...task, sessionId: session.sessionId,
          sessionUrl: session.url, session: snapshotOf(session, clock()) };
        // Dismiss changes visibility, not billing evidence. Settle its usage
        // without reopening it or replacing the operator's dismissal reason.
        if (task.state !== 'closed') {
          next.state = mapped.state;
          next.stateReason = mapped.reason;
          next.failure = mapped.failure;
        }
        if (commit(task, next)) updated += 1;
      } catch { /* preserve the original hold when storage changed or failed */ }
      continue;
    }
    if (task.supersededBy && watched(task, nowMs)) {
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
    if (api && task.sessionId && (task.launchOrgId === undefined || task.launchOrgId === api.orgId)) {
      try {
        session = await api.client.getSession(api.orgId, task.sessionId);
        // Preserve legacy responses that omit org_id, but never let an explicit
        // foreign response replace this task's provider observation/ACU usage.
        if (session.orgId !== undefined && session.orgId !== api.orgId) session = null;
        recordDevinApiOutcome(null);
      } catch (error) {
        recordDevinApiOutcome(error);
        session = null;
      }
    }

    if (!watched(task, nowMs) && unsettledRemoteUsage(task)) {
      // Settlement-only observation: do not reopen a dismissed task, change
      // delivery admission, or turn a merged task into an expired task.
      if (session) {
        try {
          if (commit(task, { ...task, session: snapshotOf(session, clock()) })) updated += 1;
        } catch { /* keep the prior evidence/exposure until a later sweep */ }
      }
      continue;
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
