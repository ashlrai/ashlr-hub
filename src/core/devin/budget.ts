/**
 * Devin budget view + gates (3.15). Pure: no clock, no disk.
 *
 * Kept in ACUs, the unit Devin meters (SessionResponse.acus_consumed). Every
 * session is also launched with a hard `max_acu_limit` (budget.maxAcuPerSession),
 * so Devin itself stops a runaway session; these gates decide whether another
 * one may START.
 *
 *   used      = acuSpentAdjustment + Σ per task: acus_consumed when known; a
 *               finished session whose usage was never read counts its full
 *               cap (FAIL CLOSED — unknown spend is never zero).
 *   in flight = Σ over sessions still able to spend: cap − consumed so far.
 *   today     = Σ used by tasks launched today + all in-flight headroom.
 *
 * Gates, in order: a budget exists → not paused at pauseAtFraction →
 * room for one more session's cap after in-flight headroom → the daily ACU
 * cap → sessions per day → concurrency. The fleet's gate additionally keeps
 * `reserveAcu` for the operator.
 */
import { localDayKey } from '../cloud/budget.js';
import { DEVIN_USAGE_URL, type DevinBudgetV1, type DevinBudgetView, type DevinGate, type DevinTaskV1 } from './types.js';

const OK: DevinGate = Object.freeze({ ok: true, reason: null });
const refuse = (reason: string): DevinGate => ({ ok: false, reason });
const round2 = (value: number): number => Math.round(value * 100) / 100;
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const acu = (n: number): string => `${round2(n)} ACU${round2(n) === 1 ? '' : 's'}`;

const ACTIVE_SESSION_STATUSES = new Set(['new', 'claimed', 'running', 'resuming']);

/** The session may still spend: the task is in flight, or Devin says it is running. */
export function devinTaskActive(task: DevinTaskV1): boolean {
  if (task.state === 'queued' || task.state === 'launching' || task.state === 'running' || task.state === 'blocked') {
    // A blocked session that Devin suspended no longer spends until resumed.
    return !(task.state === 'blocked' && task.session?.status === 'suspended');
  }
  return task.session !== null && ACTIVE_SESSION_STATUSES.has(task.session.status) && !['merged', 'closed', 'failed', 'expired'].includes(task.state);
}

/** ACUs the task has used, fail-closed for a session whose usage was never read. */
export function devinTaskAcuUsed(task: DevinTaskV1): number {
  const known = task.session?.acusConsumed;
  if (typeof known === 'number' && Number.isFinite(known) && known >= 0) return known;
  if (task.sessionId === null) {
    // A create whose outcome was unknown may have started a session we never
    // heard back from: its full cap counts until the operator dismisses it.
    return task.state === 'failed' && (task.failure === 'network' || task.failure === 'unparsed') ? task.maxAcu : 0;
  }
  return devinTaskActive(task) ? 0 : task.maxAcu;
}

/** Headroom an active session still holds: its cap minus what it has used. */
export function devinTaskAcuHeadroom(task: DevinTaskV1): number {
  if (!devinTaskActive(task)) return 0;
  const known = task.session?.acusConsumed;
  return Math.max(0, task.maxAcu - (typeof known === 'number' && Number.isFinite(known) ? known : 0));
}

export function devinBudgetView(tasks: readonly DevinTaskV1[], budget: DevinBudgetV1, now: Date): DevinBudgetView {
  const today = localDayKey(now);
  let used = budget.acuSpentAdjustment;
  let inFlight = 0;
  let usedToday = 0;
  let sessionsToday = 0;
  let running = 0;
  let fleetRunning = 0;
  let fleetSessionsToday = 0;
  for (const task of tasks) {
    const taskUsed = devinTaskAcuUsed(task);
    const headroom = devinTaskAcuHeadroom(task);
    used += taskUsed;
    inFlight += headroom;
    const active = devinTaskActive(task);
    // Only sessions the FLEET launched count against the fleet's own caps;
    // Mason's (chat / CLI / operator) count against the ACU budget only.
    const fleet = task.origin === 'fleet';
    if (active) running += 1;
    if (active && fleet) fleetRunning += 1;
    const spentSession = task.sessionId !== null || active;
    const at = Date.parse(task.launchedAt ?? task.createdAt);
    if (spentSession && Number.isFinite(at) && localDayKey(new Date(at)) === today) {
      sessionsToday += 1;
      if (fleet) fleetSessionsToday += 1;
      usedToday += taskUsed;
    }
  }
  const acuUsed = round2(used);
  const acuInFlight = round2(inFlight);
  const acuRemaining = Math.max(0, round2(budget.acuBudgetTotal - acuUsed));
  const acuToday = round2(usedToday + inFlight);
  const perSession = budget.maxAcuPerSession;
  const paused = budget.acuBudgetTotal > 0 && acuUsed >= budget.acuBudgetTotal * budget.pauseAtFraction;
  const free = acuRemaining - acuInFlight;

  let canLaunch: DevinGate = OK;
  if (budget.acuBudgetTotal <= 0) {
    canLaunch = refuse('No Devin ACU budget is set. Set one with `ashlr devin budget --acu <n>`.');
  } else if (paused) {
    canLaunch = refuse(`Paused: ${acu(acuUsed)} of ${acu(budget.acuBudgetTotal)} used (the lane pauses at ${Math.round(budget.pauseAtFraction * 100)}%). Raise the budget to resume.`);
  } else if (free < perSession) {
    canLaunch = refuse(`About ${acu(Math.max(0, free))} is free after running sessions — not enough for another session capped at ${acu(perSession)}.`);
  } else if (acuToday + perSession > budget.maxAcuPerDay) {
    canLaunch = refuse(`Another session could take today past the ${acu(budget.maxAcuPerDay)} daily cap (${acu(acuToday)} used or held).`);
  } else if (sessionsToday >= budget.maxSessionsPerDay) {
    canLaunch = refuse(`${sessionsToday} of ${budget.maxSessionsPerDay} Devin ${plural(budget.maxSessionsPerDay, 'session', 'sessions')} used today.`);
  } else if (running >= budget.maxConcurrent) {
    canLaunch = refuse(`${running} of ${budget.maxConcurrent} Devin ${plural(budget.maxConcurrent, 'session is', 'sessions are')} already running.`);
  }

  let canFleetLaunch: DevinGate = canLaunch;
  if (canLaunch.ok && free - perSession < budget.reserveAcu) {
    // The reserve is the operator's: the fleet stops BEFORE a launch would dip into it.
    canFleetLaunch = refuse(`Another fleet session would dip into the ${acu(budget.reserveAcu)} kept for you.`);
  } else if (canLaunch.ok && fleetRunning >= budget.fleetMaxConcurrent) {
    canFleetLaunch = refuse(budget.fleetMaxConcurrent === 0
      ? 'The fleet may run no Devin sessions at once (fleet concurrency is 0).'
      : `${fleetRunning} of ${budget.fleetMaxConcurrent} fleet Devin ${plural(budget.fleetMaxConcurrent, 'session is', 'sessions are')} already running.`);
  } else if (canLaunch.ok && fleetSessionsToday >= budget.fleetMaxSessionsPerDay) {
    canFleetLaunch = refuse(budget.fleetMaxSessionsPerDay === 0
      ? 'The fleet may launch no Devin sessions today (fleet daily cap is 0).'
      : `${fleetSessionsToday} of ${budget.fleetMaxSessionsPerDay} fleet Devin ${plural(budget.fleetMaxSessionsPerDay, 'session', 'sessions')} used today.`);
  }

  return {
    acuBudgetTotal: budget.acuBudgetTotal,
    acuUsed,
    acuRemaining,
    acuToday,
    acuInFlight,
    estimatedUsdUsed: round2(acuUsed * budget.usdPerAcu),
    sessionsToday,
    running,
    paused,
    fleetRunning,
    fleetSessionsToday,
    canLaunch,
    canFleetLaunch,
    estimateNote: `ACUs come from Devin's own session readings; dollars are an estimate at $${round2(budget.usdPerAcu)} per ACU. Check real usage on app.devin.ai.`,
    usageUrl: DEVIN_USAGE_URL,
    budget,
  };
}
