/** Advisory assembly from the existing capacity and bounded metadata ledger. */
import { assessResetOpportunity } from './reset-pressure.js';
import { effectiveSeatPolicy } from './policy.js';
import type { SeatCapacity } from './headroom.js';
import type { BudgetPolicy } from './types.js';
import type { SchedulingView, TaskWorkForecast } from './scheduling-types.js';
import { forecastWork, type WorkHistorySample } from './work-estimates.js';
import type { WorkItem } from '../types.js';
import type { DispatchProductionEvent } from '../fleet/dispatch-production-ledger.js';

/** Completed metadata only; initialized zero counters and duplicate attempts are not samples. */
export function historySamples(events: readonly DispatchProductionEvent[]): WorkHistorySample[] {
  return events.flatMap((event) => {
    const summary = event.runEventSummary;
    if (!event.backend || summary?.status !== 'done' || !event.attemptId && !event.runId) return [];
    const input = summary.tokensIn; const output = summary.tokensOut;
    return [{ id: event.attemptId ?? event.runId!, engine: event.backend, model: event.model ?? null,
      seatId: null, taskKind: event.source, completed: true,
      durationMs: typeof summary.durationMs === 'number' && summary.durationMs > 0 ? summary.durationMs : null,
      tokens: typeof input === 'number' && typeof output === 'number' && Number.isSafeInteger(input) && Number.isSafeInteger(output) && input >= 0 && output >= 0 && Number.isSafeInteger(input + output) && input + output > 0
        ? input + output : null }];
  });
}

/** Called by selected-batch preparation, never by a startup GET. Existing reader bounds apply. */
export async function readWorkHistory(): Promise<WorkHistorySample[]> {
  try {
    const { readDispatchProductionEventsDetailed } = await import('../fleet/dispatch-production-ledger.js');
    const reading = readDispatchProductionEventsDetailed({ inspectionOnly: true });
    if (reading.sourceState !== 'healthy') return [];
    return historySamples(reading.events);
  } catch { return []; }
}

export function taskForecast(item: WorkItem, engine: string, model: string | null, history: readonly WorkHistorySample[], recordedAtMs?: number): TaskWorkForecast {
  return {...forecastWork(item.id, { engine, model, seatId: null, taskKind: item.source }, history),
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
