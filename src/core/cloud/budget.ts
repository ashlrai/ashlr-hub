/**
 * Budget view + gates (unit C1). Spend = creditsSpentAdjustmentUsd + sum of
 * estimatedCostUsd over tasks that reached `running` or later (failed
 * launches cost nothing). "Today" = the operator's local calendar day.
 *
 * Pure: no clock, no disk — the caller passes the tasks, the budget and now.
 */
import { CLOUD_BALANCE_URL, DEFAULT_CLOUD_BUDGET, type CloudBudgetV1, type CloudBudgetView, type CloudGate, type CloudTaskV1 } from './types.js';

const OK: CloudGate = Object.freeze({ ok: true, reason: null });
const refuse = (reason: string): CloudGate => ({ ok: false, reason });

/**
 * Whether a task consumed a session. A session id is the proof; the states
 * cover a task recorded without one. A `closed` task with no session is a
 * dismissed failure, not spend.
 */
export function taskConsumedSession(task: CloudTaskV1): boolean {
  return task.sessionId !== null || task.state === 'running' || task.state === 'pr-open' || task.state === 'merged' || task.state === 'expired';
}

/** In flight: accepted and not yet resolved into a session or a failure. Counts toward the daily caps so a burst cannot overshoot them. */
const inFlight = (task: CloudTaskV1): boolean => task.state === 'queued' || task.state === 'launching';

/** `YYYY-MM-DD` of the operator's local calendar day. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** `$3`, `$2.50`, `$1,234` — whole dollars without cents. */
export function formatUsd(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const whole = Number.isInteger(rounded);
  return `$${rounded.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function cloudBudgetView(tasks: readonly CloudTaskV1[], budget: CloudBudgetV1, now: Date): CloudBudgetView {
  const today = localDayKey(now);
  let spent = budget.creditsSpentAdjustmentUsd;
  let sessionsToday = 0;
  let selfImproveToday = 0;
  let running = 0;
  let queued = 0;
  let selfImprovePrsOpen = 0;
  for (const task of tasks) {
    if (task.origin === 'self-improve' && task.state === 'pr-open') selfImprovePrsOpen += 1;
    const consumed = taskConsumedSession(task);
    if (consumed) spent += task.estimatedCostUsd;
    if (task.state === 'launching' || task.state === 'running') running += 1;
    if (task.state === 'queued') queued += 1;
    if (!consumed && !inFlight(task)) continue;
    const at = Date.parse(task.launchedAt ?? task.createdAt);
    if (!Number.isFinite(at) || localDayKey(new Date(at)) !== today) continue;
    sessionsToday += 1;
    if (task.origin === 'self-improve') selfImproveToday += 1;
  }
  const estimatedSpentUsd = Math.round(spent * 100) / 100;
  const estimatedRemainingUsd = Math.max(0, Math.round((budget.creditsTotalUsd - estimatedSpentUsd) * 100) / 100);
  const cost = budget.estimatedCostPerSessionUsd;

  let canLaunch: CloudGate = OK;
  if (estimatedRemainingUsd < cost || (cost === 0 && estimatedRemainingUsd <= 0)) {
    canLaunch = refuse(`About ${formatUsd(estimatedRemainingUsd)} of estimated credits is left — not enough for another session at ${formatUsd(cost)} each.`);
  } else if (sessionsToday >= budget.maxSessionsPerDay) {
    canLaunch = refuse(`${sessionsToday} of ${budget.maxSessionsPerDay} cloud ${plural(budget.maxSessionsPerDay, 'session', 'sessions')} used today.`);
  } else if (running + queued >= budget.maxConcurrent) {
    // Queued tasks are about to launch, so they hold a slot: otherwise two
    // launches accepted back to back (different repos) could both pass a cap of one.
    canLaunch = refuse(`${running + queued} of ${budget.maxConcurrent} cloud ${plural(budget.maxConcurrent, 'session is', 'sessions are')} already running.`);
  }

  let canSelfImprove: CloudGate = canLaunch;
  if (canLaunch.ok) {
    // A budget written before 3.13 has no maxOpenPrs: the default applies.
    const maxOpenPrs = budget.selfImprove.maxOpenPrs ?? DEFAULT_CLOUD_BUDGET.selfImprove.maxOpenPrs;
    if (!budget.selfImprove.enabled) {
      canSelfImprove = refuse('Self-improvement is turned off.');
    } else if (selfImprovePrsOpen >= maxOpenPrs) {
      // Review backpressure: Verse writes PRs faster than anyone reviews them,
      // so it waits for the queue to drain (Land or Close in Needs-you).
      canSelfImprove = refuse(`${selfImprovePrsOpen} self-improvement ${plural(selfImprovePrsOpen, 'PR is', 'PRs are')} waiting for review.`);
    } else if (selfImproveToday >= budget.selfImprove.maxPerDay) {
      canSelfImprove = refuse(`${selfImproveToday} of ${budget.selfImprove.maxPerDay} self-improvement ${plural(budget.selfImprove.maxPerDay, 'launch', 'launches')} used today.`);
    } else if (estimatedRemainingUsd - cost < budget.selfImprove.reserveUsd) {
      // The reserve is kept for the operator's own tasks: self-improvement
      // stops BEFORE a launch would take the estimate below it.
      canSelfImprove = refuse(`Another self-improvement session would take estimated credits below the ${formatUsd(budget.selfImprove.reserveUsd)} reserve.`);
    }
  }

  return {
    creditsTotalUsd: budget.creditsTotalUsd,
    estimatedSpentUsd,
    estimatedRemainingUsd,
    sessionsToday,
    selfImproveToday,
    running,
    canLaunch,
    canSelfImprove,
    estimateNote: `Estimated at ${formatUsd(cost)} per session — Claude doesn't expose the credit balance. Check it on claude.ai and adjust here.`,
    balanceUrl: CLOUD_BALANCE_URL,
    budget,
  };
}
