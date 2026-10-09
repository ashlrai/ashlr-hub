import { completeReportedTokens } from '../run/token-evidence.js';
/** Advisory assembly from the existing capacity and bounded metadata ledger. */
import { assessResetOpportunity } from './reset-pressure.js';
import { isOuterAttemptIdentity, isSafeExecutionIdentity } from '../fleet/attempt-identity.js';
import { effectiveSeatPolicy } from './policy.js';
import type { SeatCapacity } from './headroom.js';
import type { BudgetPolicy } from './types.js';
import type { SchedulingView, TaskWorkForecast } from './scheduling-types.js';
import { forecastWork, type WorkHistorySample } from './work-estimates.js';
import type { WorkItem } from '../types.js';
import type { FleetJournalRecord } from '../fleet/fleet-runtime-journal.js';
import type { DispatchProductionEvent } from '../fleet/dispatch-production-ledger.js';

/** Completed metadata only; initialized zero counters and duplicate attempts are not samples. */
export function historySamples(events: readonly DispatchProductionEvent[], journal: readonly FleetJournalRecord[] = []): WorkHistorySample[] {
  // Correlate exact immutable attempt identity only; conflicting/missing rows never fabricate account attribution.
  const byRun = new Map<string, Extract<FleetJournalRecord, {type:'dispatch'}>[]>();
  for (const row of journal) if (row.type === 'dispatch' && row.dispatched && row.runId && isSafeExecutionIdentity(row.runId)) {
    byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row]);
  }
  return events.flatMap((event) => {
    const summary = event.runEventSummary;
    const id = isOuterAttemptIdentity(event.attemptId) ? event.attemptId
      : isSafeExecutionIdentity(event.runId) ? event.runId : null;
    if (!event.backend || summary?.status !== 'done' || id === null) return [];
    const input = summary.tokensIn; const output = summary.tokensOut;
    const rows = byRun.get(id) ?? [];
    const matches = rows.filter(row => row.itemId === event.itemId && row.backend === event.backend && (row.model ?? null) === (event.model ?? null));
    const attribution = matches.length > 0 && rows.length === matches.length && matches.every(row => row.seatId === matches[0]?.seatId && row.accountHint === matches[0]?.accountHint) ? matches[0] : null;
    const accountHint = attribution && typeof attribution.accountHint === 'string' && /^[a-f0-9]{64}$/.test(attribution.accountHint) ? attribution.accountHint : null;
    return [{ id, engine: event.backend, model: event.model ?? null,
      seatId: accountHint ? attribution!.seatId : null, accountHint, taskKind: event.source, completed: true,
      durationMs: typeof summary.durationMs === 'number' && summary.durationMs > 0 ? summary.durationMs : null,
      tokens: completeReportedTokens({ tokensIn: input as number, tokensOut: output as number, tokenEvidence: summary.tokenEvidence }) && typeof input === 'number' && typeof output === 'number' && Number.isSafeInteger(input) && Number.isSafeInteger(output) && input >= 0 && output >= 0 && Number.isSafeInteger(input + output) && input + output > 0
        ? input + output : null }];
  });
}

/** Called by selected-batch preparation, never by a startup GET. Existing reader bounds apply. */
export async function readWorkHistory(): Promise<WorkHistorySample[]> {
  try {
    const { readDispatchProductionEventsDetailed } = await import('../fleet/dispatch-production-ledger.js');
    const reading = readDispatchProductionEventsDetailed({ inspectionOnly: true });
    if (reading.sourceState !== 'healthy') return [];
    const { readJournalSince } = await import('../fleet/fleet-runtime-journal.js');
    let journal: FleetJournalRecord[] = [];
    try { journal = await readJournalSince(0); } catch { /* Missing attribution remains pooled. */ }
    return historySamples(reading.events,journal);
  } catch { return []; }
}

export function taskForecast(item: WorkItem, engine: string, model: string | null, history: readonly WorkHistorySample[], recordedAtMs?: number, seatId?: string, accountHint?: string | null): TaskWorkForecast {
  const attributed = typeof accountHint === 'string' && /^[a-f0-9]{64}$/.test(accountHint) && seatId && history.some(sample =>
    sample.completed && sample.engine === engine && sample.model === model && sample.taskKind === item.source &&
    sample.seatId === seatId && sample.accountHint === accountHint && typeof sample.durationMs === 'number' && sample.durationMs > 0);
  const comparable = attributed ? history.filter(sample => sample.accountHint === accountHint) : history;
  return {...forecastWork(item.id, { engine, model, seatId: attributed ? seatId : null, taskKind: item.source }, comparable),
    ...(typeof recordedAtMs==='number' && Number.isFinite(recordedAtMs) ? {recordedAt:new Date(recordedAtMs).toISOString()} : {})};
}

export function buildSchedulingView(seats: readonly SeatCapacity[], policy: BudgetPolicy, nowMs: number,
  forecasts: Readonly<Record<string, TaskWorkForecast>> = {}): SchedulingView {
  return { sourceState: 'ready', observedAt: new Date(nowMs).toISOString(), accounts: seats.map((seat) => {
    const recorded = forecasts[seat.seatId];
    const compatible = recorded && (recorded.cohort.engine === seat.engine || seat.engine === 'grok' && recorded.cohort.engine === 'grok-cli') &&
      (recorded.cohort.seatId === null || recorded.cohort.seatId === seat.seatId);
    return assessResetOpportunity(seat, effectiveSeatPolicy(policy, seat.seatId, seat.engine), nowMs, compatible ? recorded : null);
  }) };
}
