/** Pure provenance-aware reset opportunity, independent of dispatch authority. */
import { assessSeat, classifyWindow, HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from './headroom.js';
import { costBasisOf } from './tiers.js';
import type { SeatBudgetPolicy } from './types.js';
import type { AccountSchedulingView, ResetProvenance, TaskWorkForecast } from './scheduling-types.js';
import { narrowClaudeApiGrantReadView } from '../resources/claude-api-grant-types.js';

export const UNKNOWN_RESET: Readonly<ResetProvenance> = Object.freeze({ kind: 'unknown', at: null, description: null, source: null });

/** Refuse inconsistent timestamps/semantics; a date alone never proves expiry. */
export function validResetProvenance(value: unknown): value is ResetProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as ResetProvenance;
  if (!['fixed-period', 'weekly-deadline', 'rolling-release', 'balance', 'unknown'].includes(v.kind) ||
    v.description !== null && typeof v.description !== 'string' || v.source !== null && typeof v.source !== 'string') return false;
  const instant = (s: unknown): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  if (v.at !== null && !instant(v.at) || v.startsAt != null && !instant(v.startsAt)) return false;
  if (v.kind === 'fixed-period' && (!instant(v.at) || !instant(v.startsAt) || v.startsAt >= v.at || !v.source)) return false;
  if (v.kind === 'weekly-deadline' && (!instant(v.at) || v.startsAt != null ||
    !(v.source === 'claude-native-usage-report' && ['pro', 'max'].includes(v.plan ?? '') && v.windowDurationMins === undefined ||
      v.source === 'codex-native-rate-limits' && ['plus', 'pro'].includes(v.plan ?? '') && v.windowDurationMins === 10080))) return false;
  return !(v.kind === 'balance' && v.at !== null);
}

/** A qualified account deadline, not a promise of no allowance carryover. */
export function hasResetDeadline(reset: ResetProvenance): boolean {
  return reset.kind === 'fixed-period' || reset.kind === 'weekly-deadline';
}

export function forecastFit(forecast: { durationMs: Pick<NonNullable<TaskWorkForecast['durationMs']>, 'p25' | 'p75'> | null } | null, resetAt: string | null, nowMs: number): TaskWorkForecast['fit'] {
  const duration = forecast?.durationMs;
  const slack = resetAt === null ? NaN : Date.parse(resetAt) - nowMs;
  if (!duration || !Number.isFinite(slack) || slack <= 0) return 'unknown';
  return duration.p75 <= slack ? 'likely-before-reset' : duration.p25 > slack ? 'unlikely-before-reset' : 'uncertain';
}

export function assessResetOpportunity(seat: SeatCapacity, policy: SeatBudgetPolicy, nowMs: number,
  forecast: TaskWorkForecast | null = null): AccountSchedulingView {
  if (seat.engine === 'claude-api' || seat.seatId.toLowerCase() === 'claude-api') {
    const grant = narrowClaudeApiGrantReadView({ v: 1, state: 'healthy', rows: [seat.claudeApiGrant] })?.rows[0];
    const captured = grant?.capturedAt === null ? NaN : Date.parse(grant?.capturedAt ?? '');
    const cutoff = grant?.admissionCutoff ?? null;
    const fresh = Number.isFinite(captured) && captured <= nowMs && nowMs - captured <= HEADROOM_READING_MAX_AGE_MS;
    const duration = forecast?.durationMs;
    const knownDuration = forecast?.cohort.engine === 'claude-api' &&
      (forecast.cohort.seatId === null || forecast.cohort.seatId === seat.seatId) && duration !== null && duration !== undefined &&
      Number.isFinite(duration.p25) && Number.isFinite(duration.p75) && duration.p25 > 0 && duration.p75 >= duration.p25;
    const hasBalance = grant?.remainingUsdMicros != null && grant.totalUsdMicros !== null && BigInt(grant.remainingUsdMicros) > 0n;
    const fit = fresh && hasBalance && knownDuration ? forecastFit(forecast, cutoff, nowMs) : 'unknown';
    // Expiry fit is an estimate against a conservative cutoff, not a reset or
    // permission to spend. Current signed grants contain no Claude API lane.
    return { seatId: seat.seatId, observedAt: grant?.capturedAt ?? null, admission: 'held', headroomPercent: null,
      reset: { kind: 'balance', at: null, description: cutoff === null ? 'API credit expiry is unknown.'
        : `API admission cutoff: ${cutoff}.`, source: 'claude-api-grant-display' },
      opportunity: { kind: 'held', reason: 'Claude API is not commissioned in the signed grant; credit history does not authorize spending.' },
      forecast: forecast === null ? null : { ...forecast, fit } };
  }
  const assessment = assessSeat(seat, policy, { nowMs });
  const observed = seat.observedAt === null ? NaN : Date.parse(seat.observedAt);
  const fresh = seat.free || Number.isFinite(observed) && observed <= nowMs && nowMs - observed <= HEADROOM_READING_MAX_AGE_MS;
  // Every account-wide window must still be current. An expired conflicting
  // window cannot be ignored simply because another period looks attractive.
  const accountWindows = seat.windows.filter((w) => classifyWindow(seat.engine,w,nowMs) !== 'model');
  const outsidePeriod = accountWindows.some((w) => w.resetProvenance?.kind === 'fixed-period' &&
    validResetProvenance(w.resetProvenance) && (Date.parse(w.resetProvenance.startsAt!) > nowMs || Date.parse(w.resetProvenance.at!) <= nowMs));
  const expired = accountWindows.some((w) => w.resetsAt !== null && Date.parse(w.resetsAt) <= nowMs);
  // A billing date is not proof that paid credits expire. Only the actual
  // effective subscription lane qualifies for allowance-deadline preference.
  // Other lanes retain ordinary admission; verified gift expiry is a separate
  // provider/account evidence contract that this projection does not invent.
  const subscription = (seat.costBasis ?? costBasisOf(seat.engine)) === 'subscription';
  const finitePeriods = accountWindows.filter((w) => subscription && w.resetProvenance && validResetProvenance(w.resetProvenance) &&
    w.resetsAt === w.resetProvenance.at && Date.parse(w.resetProvenance.at!) > nowMs &&
    (w.resetProvenance.kind === 'fixed-period' && Date.parse(w.resetProvenance.startsAt!) <= nowMs ||
      w.resetProvenance.kind === 'weekly-deadline' && (seat.engine === 'claude' && w.id === 'seven_day' && w.resetProvenance.source === 'claude-native-usage-report' ||
        seat.engine === 'codex' && w.id === 'codex_codex_secondary' && w.resetProvenance.source === 'codex-native-rate-limits')));
  const earliest = finitePeriods.sort((a, b) => Date.parse(a.resetProvenance!.at!) - Date.parse(b.resetProvenance!.at!))[0];
  const unknownWindow = seat.windows.find((w) => w.resetDescription || w.resetsAt);
  const reported = accountWindows.find((w) => w.resetProvenance && !hasResetDeadline(w.resetProvenance) && validResetProvenance(w.resetProvenance));
  const reset: ResetProvenance = earliest?.resetProvenance ?? reported?.resetProvenance ?? (seat.windowless ? {
    kind: 'balance', at: null, description: 'No expiring quota window reported.', source: 'seat-cost-contract',
  } : { ...UNKNOWN_RESET, at: unknownWindow?.resetsAt ?? null, description: unknownWindow?.resetDescription ?? null });
  const admission = !fresh || expired || outsidePeriod || assessment.unknownUsage ? 'unknown'
    : assessment.headroom.eligibleForAutonomy ? 'eligible' : 'held';
  const fit = forecastFit(forecast, hasResetDeadline(reset) ? reset.at : null, nowMs);
  const qualified = forecast === null ? null : { ...forecast, fit };
  return { seatId: seat.seatId, observedAt: seat.observedAt, admission,
    headroomPercent: assessment.headroom.autonomyHeadroomPercent, reset,
    opportunity: { kind: admission === 'unknown' ? 'unknown' : admission === 'held' ? 'held'
      : hasResetDeadline(reset) && fit !== 'unlikely-before-reset' ? 'before-reset' : 'ordinary',
    reason: admission === 'unknown' ? 'A fresh, current account-window observation is required.'
      : admission === 'held' ? assessment.headroom.reasons[0] ?? 'Current policy holds this account.'
      : hasResetDeadline(reset) ? fit === 'unlikely-before-reset' ? 'Observed work duration exceeds this period; prefer shorter useful work.'
        : reset.kind === 'weekly-deadline' ? 'Qualified native subscription weekly deadline has admitted headroom; work fit remains an estimate.'
          : 'Provider-reported fixed period ends with admitted headroom; work fit remains an estimate.'
      : 'Use ordinary admitted routing; allowance expiry is not established.' }, forecast: qualified };
}

/** Only compare opportunities after the caller has enforced eligibility and tier. */
export function opportunityPriority(view: AccountSchedulingView, nowMs: number): number {
  if (view.admission !== 'eligible' || view.opportunity.kind !== 'before-reset') return 0;
  if (!hasResetDeadline(view.reset) || !validResetProvenance(view.reset) || !Number.isFinite(nowMs)) return 0;
  const duration = view.forecast?.durationMs?.p75;
  const remaining = view.reset.at === null ? NaN : Date.parse(view.reset.at) - nowMs;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(remaining) || remaining <= 0) return 0;
  // Continuous proximity, not a fixed urgency horizon: it increases as the
  // reported deadline approaches this work's observed upper-quartile duration.
  // Fit bands preserve likely-over-uncertain preference; no estimate means no
  // priority. Explicit time also prevents a recorded fit surviving its reset.
  const proximity = 1 / (1 + remaining / duration);
  const fit = forecastFit(view.forecast, view.reset.at, nowMs);
  return fit === 'likely-before-reset' ? 1 + proximity : fit === 'uncertain' ? proximity : 0;
}
