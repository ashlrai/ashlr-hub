/**
 * Leader health (3.14) — PURE, from the run state only.
 *
 * "Leader: healthy / degraded (why)" for the Command surface and Telegram,
 * served as the additive `health` field of GET /api/verse/leader (and
 * `ashlr leader show`). No seat is probed and no model is called on the read
 * path: seat viability is what the most recent run found (every seat it
 * tried or passed over, with why), which is also what the next run will
 * most likely find.
 *
 *   unknown  — the Leader has never run.
 *   healthy  — the last run wrote a memo on the first seat it tried.
 *   degraded — a memo was written only after a fallback, OR the last run
 *              failed and a bounded retry is pending, OR the last memo is
 *              more than 36 h old.
 *   down     — no seat at all, or the retries are spent.
 */
import type {
  LeaderHealth,
  LeaderRunOutcome,
  LeaderSeatAttempt,
  LeaderTrigger,
} from './leader-types.js';
import {
  LEADER_MAX_RETRY_ATTEMPTS,
  isWorkingHour,
  nextCheckinAt,
  type LeaderCadence,
} from './leader-cadence.js';

export interface LeaderHealthInput {
  lastRun: { at: string; outcome: LeaderRunOutcome; reason: string | null; trigger: LeaderTrigger } | null;
  lastMemoAt: string | null;
  lastCheckinEvalAt?: string | null;
  lastSuccessAt?: string | null;
  retry?: { attempt: number; at: string } | null;
  consecutiveFailures?: number;
  lastFailure?: { at: string; outcome: LeaderRunOutcome; reason: string | null } | null;
  lastAttempts?: LeaderSeatAttempt[];
  lastAttemptsAt?: string | null;
  lastServed?: { seatId: string; model: string | null; at: string } | null;
}

const STALE_MS = 36 * 3_600_000;
const FAILED: ReadonlySet<LeaderRunOutcome> = new Set<LeaderRunOutcome>(['failed', 'no-seat', 'parse-failed']);

function nextWorkingStart(fromMs: number, wh: { start: number; end: number }): number {
  const d = new Date(fromMs);
  let candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), wh.start, 0, 0, 0).getTime();
  if (candidate <= fromMs) {
    const t = new Date(fromMs + 86_400_000);
    candidate = new Date(t.getFullYear(), t.getMonth(), t.getDate(), wh.start, 0, 0, 0).getTime();
  }
  return candidate;
}

function seatLine(a: LeaderSeatAttempt): string {
  const what = a.outcome === 'timeout' ? 'timed out' : a.outcome === 'parse-failed' ? 'answered unparseably' : a.outcome;
  return `${a.seatId} ${what}`;
}

export function buildLeaderHealth(
  state: LeaderHealthInput,
  nowMs: number,
  ctx: { cadence: LeaderCadence; nextScheduledAt: number; runsToday: number; checkinsToday: number },
): LeaderHealth {
  // A pre-3.14 state file has no failure counter: its last run still speaks.
  const legacyFailure = state.consecutiveFailures === undefined && state.lastRun !== null && FAILED.has(state.lastRun.outcome);
  const consecutiveFailures = legacyFailure ? 1 : state.consecutiveFailures ?? 0;
  const lastFailure = legacyFailure && state.lastRun
    ? { at: state.lastRun.at, outcome: state.lastRun.outcome, reason: state.lastRun.reason }
    : state.lastFailure ?? null;
  state = { ...state, lastFailure };
  const seats = state.lastAttempts ?? [];
  const retry = state.retry ? { attempt: state.retry.attempt, maxAttempts: LEADER_MAX_RETRY_ATTEMPTS, at: state.retry.at } : null;

  // Next due: the earliest of the daily slot, a pending retry and the next check-in window.
  const options: { at: number; why: string }[] = [{ at: ctx.nextScheduledAt, why: 'the daily 06:30 memo' }];
  if (retry) options.push({ at: Date.parse(retry.at), why: `retry ${retry.attempt} of ${retry.maxAttempts}` });
  const checkin = nextCheckinAt({ lastMemoAt: state.lastMemoAt, lastCheckinEvalAt: state.lastCheckinEvalAt ?? null }, ctx.cadence);
  if (checkin !== null && ctx.runsToday < ctx.cadence.maxRunsPerDayTotal) {
    const earliest = Math.max(checkin, nowMs);
    const at = isWorkingHour(earliest, ctx.cadence.workingHours) ? earliest : nextWorkingStart(earliest, ctx.cadence.workingHours);
    options.push({ at, why: 'a check-in, if the evidence changed' });
  }
  const valid = options.filter((o) => Number.isFinite(o.at)).sort((a, b) => a.at - b.at);
  const next = valid[0] ?? null;

  const lastRunOutcome = state.lastRun?.outcome ?? null;
  let status: LeaderHealth['status'];
  let summary: string;
  const failedSeats = seats.filter((a) => a.outcome === 'failed' || a.outcome === 'timeout' || a.outcome === 'parse-failed');
  const lastSuccessMs = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : NaN;
  if (!state.lastRun) {
    status = 'unknown';
    summary = 'The Leader has not run yet.';
  } else if (consecutiveFailures > 0) {
    const why = state.lastFailure?.reason ?? 'no reason recorded';
    if (lastRunOutcome === 'no-seat' || (!retry && consecutiveFailures >= LEADER_MAX_RETRY_ATTEMPTS + 1)) {
      status = 'down';
      summary = lastRunOutcome === 'no-seat'
        ? `No seat can serve the Leader: ${why}`
        : `The last ${consecutiveFailures} runs failed and the retries are spent: ${why}`;
    } else {
      status = 'degraded';
      summary = `The last run failed (${why})${retry ? `; retry ${retry.attempt} of ${retry.maxAttempts} is scheduled` : ''}.`;
    }
  } else if (failedSeats.length > 0 && state.lastServed) {
    status = 'degraded';
    summary = `Served by ${state.lastServed.seatId} after a fallback: ${failedSeats.map(seatLine).join('; ')}.`;
  } else if (Number.isFinite(lastSuccessMs) && nowMs - lastSuccessMs > STALE_MS) {
    status = 'degraded';
    summary = `The last memo is ${Math.round((nowMs - lastSuccessMs) / 3_600_000)} h old.`;
  } else {
    status = 'healthy';
    summary = state.lastServed ? `Serving on ${state.lastServed.seatId}.` : 'Nothing has failed since the last memo.';
  }

  return {
    status,
    summary: summary.slice(0, 400),
    lastRunAt: state.lastRun?.at ?? null,
    lastRunOutcome,
    lastSuccessAt: state.lastSuccessAt ?? null,
    lastFailure: consecutiveFailures > 0 ? state.lastFailure ?? null : null,
    consecutiveFailures,
    nextDueAt: next ? new Date(next.at).toISOString() : null,
    nextDueReason: next?.why ?? null,
    retry,
    seats,
    seatsObservedAt: state.lastAttemptsAt ?? null,
    servedBy: state.lastServed ?? null,
    runsToday: ctx.runsToday,
    checkinsToday: ctx.checkinsToday,
    checkinHours: ctx.cadence.checkinHours,
  };
}
