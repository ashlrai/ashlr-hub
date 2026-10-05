/** Task-scoped allowance policy. It never changes a grant, provider billing or saved reserve. */
import { standingSeatFor } from '../authority/effective-config.js';
import type { EffectivePolicy } from '../authority/types.js';
import { assessSeat, type SeatCapacity } from './headroom.js';
import { effectiveSeatPolicy } from './policy.js';
import { assessResetOpportunity, forecastFit, hasResetDeadline } from './reset-pressure.js';
import type { BudgetPolicy } from './types.js';
import type { TaskWorkForecast } from './scheduling-types.js';
import type { ResetSpendingAccountStatus, ResetSpendingStatus } from './reset-spending-types.js';

import { subscriptionOnlyCurrent } from './subscription-only.js';

export function resetPriorityEnabled(policy: BudgetPolicy, seatId?: string): boolean {
  return policy.resetSpending?.enabled !== false && (seatId === undefined || policy.seats[seatId]?.resetSpending !== false);
}
export function reserveTaperEnabled(policy: BudgetPolicy, seatId: string): boolean {
  return policy.resetSpending?.enabled === true && policy.seats[seatId]?.resetSpending !== false;
}
export interface ResetSpendingProjectionOptions {
  authorityState?: ResetSpendingStatus['authorityState'];
  /** Preserve the actual native gate; this feature cannot silently raise it. */
  maxPercent?: number;
}
/** No forecast on a GET means no current task-derived effective reserve is claimed. */
export function projectResetSpendingStatus(policy: BudgetPolicy, seats: readonly SeatCapacity[],
  standing: Pick<EffectivePolicy, 'spend'> | null, nowMs: number,
  forecasts: Readonly<Record<string, TaskWorkForecast>> = {}, options: ResetSpendingProjectionOptions = {}): ResetSpendingStatus {
  const authorityState = options.authorityState ?? (standing ? 'active' : 'unknown');
  const mode = policy.resetSpending?.enabled === true ? 'enabled' : policy.resetSpending?.enabled === false ? 'disabled' : 'legacy-priority';
  const accounts: ResetSpendingStatus['accounts'] = Object.create(null) as ResetSpendingStatus['accounts'];
  for (const seat of seats) {
    const saved = effectiveSeatPolicy(policy, seat.seatId, seat.engine);
    const granted = standing ? standingSeatFor(standing.spend, seat.seatId) : undefined;
    const floor = granted?.reserveFloorPercent ?? null;
    const forecast = forecasts[seat.seatId];
    const status: ResetSpendingAccountStatus = {
      mode: saved.resetSpending === undefined ? 'inherit' : saved.resetSpending ? 'enabled' : 'disabled',
      enabled: reserveTaperEnabled(policy, seat.seatId), savedReservePercent: saved.reservePercent,
      signedFloorPercent: floor, effectiveReservePercent: null, state: 'ordinary', reason: 'Use the saved reserve.',
      constraints: [], deadline: null, forecastBasis: null,
      subscriptionOnly: subscriptionOnlyCurrent(seat, nowMs) ? 'verified' : 'unknown',
    };
    accounts[seat.seatId] = status;
    if (floor !== null && floor > 0 && floor >= saved.reservePercent) status.constraints.push(`Signed reserve minimum is ${floor}%.`);
    if (granted && !granted.roles.includes('producer')) status.constraints.push('This account has no signed coding-producer role.');
    if (saved.maxSessionWindowPercent !== undefined) status.constraints.push(`Short-window usage ceiling is ${saved.maxSessionWindowPercent}%.`);
    const maxPercent = options.maxPercent ?? 90;
    if (seat.engine === 'claude' || seat.engine === 'codex') status.constraints.push(`Native dispatch usage ceiling is ${maxPercent}%.`);
    if (status.subscriptionOnly !== 'verified') status.constraints.push('A current provider-enforced subscription-only billing boundary is not verified.');
    const finish = (state: ResetSpendingAccountStatus['state'], reason: string): void => { status.state = state; status.reason = reason; };
    if (!resetPriorityEnabled(policy, seat.seatId)) { finish('disabled', 'Allowance before resets is off; new work uses the saved reserve.'); continue; }
    if (!status.enabled) { finish('legacy-priority', 'Existing reset-aware routing remains on; reserve shrinking is not enrolled.'); continue; }
    if (seat.free || seat.costBasis === 'credits' || seat.costBasis === 'per-token') {
      status.subscriptionOnly = 'unsupported'; status.constraints = [];
      finish('unqualified', 'No expiring subscription allowance; ordinary work remains available.'); continue;
    }
    if (authorityState !== 'active' || !standing) { finish('authority-paused', 'Configured on; autonomous authority is not active.'); continue; }
    if (!saved.enabled || !granted?.enabled) { finish('account-disabled', 'This account is disabled in the saved policy or signed grant.'); continue; }
    if (!granted.roles.includes('producer')) { finish('producer-not-granted', 'The signed grant does not give this account a coding-producer role.'); continue; }
    if (saved.reservePercent === 0 && floor === 0) {
      finish('ordinary', 'There is no saved reserve to release; ordinary work remains available.'); continue;
    }
    if (floor === null || floor >= saved.reservePercent) { finish('signed-floor', 'The signed minimum holds the reserve; review the existing grant to allow a lower minimum.'); continue; }
    const probePolicy = { ...saved, reservePercent: Math.max(0, floor) };
    const opportunity = assessResetOpportunity(seat, probePolicy, nowMs, forecast ?? null);
    if (!hasResetDeadline(opportunity.reset) || opportunity.admission === 'unknown') {
      finish('unqualified', 'Fresh account-matched subscription allowance and a qualified future reset are required.'); continue;
    }
    status.deadline = opportunity.reset.at;
    if (status.subscriptionOnly !== 'verified') { finish('overage-unverified', 'Reserve shrinking is held until this account has a verified subscription-only billing boundary.'); continue; }
    const duration = forecast?.durationMs;
    const recorded = forecast?.recordedAt ? Date.parse(forecast.recordedAt) : NaN;
    if (!forecast || !duration || !Number.isFinite(recorded) || recorded > nowMs ||
      !forecast.cohort.model || !Number.isFinite(duration.p75) || duration.p75 <= 0 || duration.samples < 1 ||
      !(forecast.cohort.engine === seat.engine || seat.engine === 'grok' && forecast.cohort.engine === 'grok-cli') ||
      forecast.cohort.seatId !== null && forecast.cohort.seatId !== seat.seatId) {
      finish('waiting-for-estimate', 'Waiting for a compatible current task estimate; ordinary admitted work can collect observations.'); continue;
    }
    status.forecastBasis = { taskId: forecast.taskId, ...forecast.cohort, model: forecast.cohort.model,
      p75Ms: duration.p75, samples: duration.samples, pooled: forecast.cohort.seatId === null };
    if (forecastFit(forecast, status.deadline, nowMs) === 'unlikely-before-reset') { finish('cannot-fit', 'Observed work is unlikely to finish before this reset; choose a shorter useful task.'); continue; }
    const remaining = Date.parse(status.deadline!) - nowMs;
    // Work-duration slack controls the taper, not an arbitrary number of hours.
    const fraction = Math.max(0, Math.min(1, (remaining - duration.p75) / duration.p75));
    const reserve = floor + (saved.reservePercent - floor) * fraction;
    const assessment = assessSeat(seat, { ...saved, reservePercent: reserve }, { nowMs });
    const used = Math.max(assessment.headroom.sessionUsedPercent ?? 0, assessment.headroom.weeklyUsedPercent ?? 0);
    status.effectiveReservePercent = reserve;
    if (!assessment.headroom.eligibleForAutonomy || (seat.engine === 'claude' || seat.engine === 'codex') && used >= maxPercent) {
      finish('held', assessment.headroom.reasons[0] ?? `Native usage is at its ${maxPercent}% ceiling.`); continue;
    }
    finish(reserve < saved.reservePercent ? 'ready' : 'ordinary', reserve < saved.reservePercent
      ? 'Current task fit releases saved reserve toward the signed minimum; all other usage constraints remain binding.'
      : 'This reset is outside the current work-duration taper; use the saved reserve.');
  }
  return { mode, checkedAt: new Date(nowMs).toISOString(), authorityState, accounts };
}
/** The same result is used by planning and re-evaluated immediately before each new contact. */
export function taskResetBudget(policy: BudgetPolicy, seats: readonly SeatCapacity[], standing: Pick<EffectivePolicy, 'spend'>,
  nowMs: number, forecasts: Readonly<Record<string, TaskWorkForecast>>, options: ResetSpendingProjectionOptions = {}): {
  budget: BudgetPolicy; status: ResetSpendingStatus;
} {
  const status = projectResetSpendingStatus(policy, seats, standing, nowMs, forecasts, options);
  const entries = { ...policy.seats };
  for (const seat of seats) {
    const projection = status.accounts[seat.seatId]!;
    if (projection.state === 'ready' && projection.effectiveReservePercent !== null) {
      entries[seat.seatId] = { ...effectiveSeatPolicy(policy, seat.seatId, seat.engine), reservePercent: projection.effectiveReservePercent };
    }
  }
  return { budget: { ...policy, seats: entries }, status };
}
/** Earliest work-derived taper boundary. Never schedules a new task by itself. */
export function nextResetSpendingWake(status: ResetSpendingStatus, nowMs: number): number | null {
  const times = Object.values(status.accounts).flatMap(account => {
    if (!account.enabled || account.subscriptionOnly !== 'verified' || !account.deadline || !account.forecastBasis ||
      !['ready', 'ordinary', 'held'].includes(account.state)) return [];
    const deadline = Date.parse(account.deadline); const p75 = account.forecastBasis.p75Ms;
    return [deadline - 2 * p75, deadline - p75, deadline].filter(at => Number.isFinite(at) && at > nowMs);
  });
  return times.length ? Math.min(...times) : null;
}
