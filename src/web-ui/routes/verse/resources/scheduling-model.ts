/** Display-only scheduling evidence. Never infer quota tokens or change admission. */
import type { ObservedPercentiles } from '../../../../core/routing/scheduling-types.js';
import { formatDuration, percentText } from '../autonomy/format.js';

export interface SchedulingEvidenceView {
  state: 'ready' | 'stale' | 'unavailable';
  availability: string;
  timing: string;
  opportunity: string | null;
  freshness: string;
  forecast: string[];
  /** Compact presentation only; full historical provenance remains in forecast. */
  forecastSummary?: { recorded: string; duration: string | null; fit: string | null } | null;
}

const ADVICE_REASONS: Readonly<Record<string, string>> = {
  'signed-metered-unavailable': 'Current permissions do not allow a metered advice call.',
  'metered-allowance-exhausted': 'Metered allowance used up; no advice requested.',
  'no-comparable-pairs': 'No comparable eligible pairs; no advice requested.',
  'no-eligible-choice': 'No usable advice choice; deterministic routing kept.',
  'eligible-choice-returned': 'An eligible advice choice was returned; it may be cached.',
};
/** Last selected-batch advice only, never a call, dispatch or provider-health claim. */
export function lastSchedulingAdvice(budget: unknown, now: number): string | null {
  const advisory = field(field(budget, 'scheduling'), 'advisory');
  if (advisory === undefined) return null;
  const at = instant(field(advisory, 'observedAt')), reason = field(advisory, 'reason'), state = field(advisory, 'state');
  if (at === null || at > now || !Number.isFinite(now) || typeof reason !== 'string' || !Object.hasOwn(ADVICE_REASONS, reason)
    || typeof state !== 'string' || !['choice-returned', 'fallback', 'skipped'].includes(state)) return 'Last scheduling advice unavailable.';
  return `Last scheduling advice · ${formatDuration(now - at)} ago: ${ADVICE_REASONS[reason]} This is batch history, not a live connection or dispatch check.`;
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\w.:+-]+$/.test(value);
}
function modelLabel(value: unknown): string | null {
  if (!identifier(value) || /(?:secret|password|credential|api[-_]?key|bearer|^sk-)/i.test(value)
    || /^[a-z0-9]{24,}$/i.test(value) || /^[a-f0-9-]{24,}$/i.test(value)) return null;
  return value;
}
function percentiles(value: unknown): ObservedPercentiles | null {
  const p25 = field(value, 'p25'), p50 = field(value, 'p50'), p75 = field(value, 'p75'), samples = field(value, 'samples');
  if (typeof p25 !== 'number' || typeof p50 !== 'number' || typeof p75 !== 'number' || typeof samples !== 'number'
    || ![p25, p50, p75].every((n) => Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER)
    || p25 > p50 || p50 > p75 || !Number.isSafeInteger(samples) || samples <= 0) return null;
  return { p25, p50, p75, samples };
}
function unavailable(): SchedulingEvidenceView {
  return { state: 'unavailable', availability: 'Work capacity unavailable.', timing: 'Reset behavior not reported.', opportunity: null,
    freshness: 'No scheduling reading for this account.', forecast: ['Task completion estimate unavailable.'] };
}
/** Account binding precedes optional evidence; duplicate bindings fail closed.
 * Bounded metadata only: raw task IDs, reasons, paths, and limitations never leave this projection.
 */
export function schedulingEvidence(budget: unknown, seat: { seatId: string; engine: string }, now: number): SchedulingEvidenceView {
  const scheduling = field(budget, 'scheduling'), accounts = field(scheduling, 'accounts');
  if (field(scheduling, 'sourceState') !== 'ready' || instant(field(scheduling, 'observedAt')) === null
    || !Array.isArray(accounts)) return unavailable();
  // The transport owns byte bounds. Validate actual dense inventory without a
  // roster ceiling or iterating a malformed billion-element sparse length.
  let keys: string[];
  try { keys = Object.keys(accounts); } catch { return unavailable(); }
  if (keys.length !== accounts.length || keys.some((key, index) => key !== String(index))) return unavailable();
  let row: unknown = null;
  for (const key of keys) {
    const candidate = field(accounts, key);
    if (field(candidate, 'seatId') === seat.seatId) {
      if (row !== null) return unavailable();
      row = candidate;
    }
  }
  if (row === null || !Number.isFinite(now)) return unavailable();
  const sampled = instant(field(row, 'observedAt')), maxAge = field(budget, 'readingMaxAgeMs');
  const fresh = sampled !== null && sampled <= now && typeof maxAge === 'number' && Number.isFinite(maxAge) && maxAge > 0 && now - sampled <= maxAge;
  const admission = field(row, 'admission'), remaining = field(row, 'headroomPercent');
  // Local eligibility is the backend's runtime admission, not subscription
  // telemetry. A missing provider timestamp cannot make that quota stale.
  const localEligible = seat.engine === 'local' && admission === 'eligible';
  const evidenceAvailable = fresh || localEligible;
  const knownRemaining = typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100;
  const availability = localEligible ? 'Local throughput available under current runtime limits.'
    : !fresh ? 'Work capacity needs a fresh reading.' : admission === 'held' ? 'Held back by current account or reserve limits.'
    : admission === 'eligible' && knownRemaining ? `${percentText(remaining)} available after your reserve.` : 'Work capacity unknown.';
  const reset = field(row, 'reset'), resetAt = instant(field(reset, 'at')), startsAt = instant(field(reset, 'startsAt'));
  const reportedKind = field(reset, 'kind');
  const plan = field(reset, 'plan');
  const weeklyDeadline = reportedKind === 'weekly-deadline' && seat.engine === 'claude' && resetAt !== null
    && field(reset, 'startsAt') == null && field(reset, 'source') === 'claude-native-usage-report' && (plan === 'pro' || plan === 'max');
  const resetKind = reportedKind === 'weekly-deadline' && !weeklyDeadline ? 'unknown'
    : reportedKind === 'fixed-period' && (resetAt === null || startsAt === null || startsAt > now || startsAt >= resetAt || !identifier(field(reset, 'source')))
    ? 'unknown' : reportedKind;
  const hasDeadline = resetKind === 'fixed-period' || resetKind === 'weekly-deadline';
  const deadlineLabel = resetKind === 'weekly-deadline' ? 'deadline' : 'reset';
  const future = resetAt !== null && resetAt > now;
  let timing = 'Reset behavior not reported.';
  if (resetKind === 'fixed-period') timing = future ? `Allowance resets in ${formatDuration(resetAt - now)}.` : 'Reported reset has passed; waiting for a fresh reading.';
  else if (resetKind === 'weekly-deadline') timing = future ? `Reported weekly allowance deadline in ${formatDuration(resetAt - now)}.` : 'Reported weekly deadline has passed; waiting for a fresh reading.';
  else if (resetKind === 'rolling-release') timing = future ? `Capacity returns gradually · next reported release in ${formatDuration(resetAt - now)}.` : 'Capacity returns gradually; next release time unknown.';
  else if (resetKind === 'balance') timing = 'Balance-based resource · no expiring usage window reported.';
  if (localEligible) timing = 'Local work has no expiring subscription quota; runtime capacity still applies.';
  const opportunity = !localEligible && fresh && admission === 'eligible' && knownRemaining && remaining > 0 && hasDeadline && future
    && field(field(row, 'opportunity'), 'kind') === 'before-reset' ? `Opportunity to use available allowance before this ${deadlineLabel}.` : null;
  const forecast: string[] = [];
  let forecastSummary: SchedulingEvidenceView['forecastSummary'] = null;
  const rawForecast = field(row, 'forecast'), cohort = field(rawForecast, 'cohort'), model = modelLabel(field(cohort, 'model'));
  const engine = field(cohort, 'engine');
  // The resource roster names the provider; the native Grok executor has this
  // distinct registered ID. No generic/API/custom-engine alias is inferred.
  const engineMatches = engine === seat.engine || seat.engine === 'grok' && engine === 'grok-cli';
  const cohortSeat = field(cohort, 'seatId');
  const cohortMatches = identifier(field(rawForecast, 'taskId')) && (cohortSeat === seat.seatId || cohortSeat === null)
    && engineMatches && model !== null && identifier(field(cohort, 'taskKind'));
  if (evidenceAvailable && cohortMatches) {
    const duration = percentiles(field(rawForecast, 'durationMs')), tokens = percentiles(field(rawForecast, 'tokens'));
    const recordedAt = instant(field(rawForecast, 'recordedAt'));
    const recordingAge = recordedAt !== null && recordedAt <= now ? `recorded ${formatDuration(now - recordedAt)} ago` : 'recording time unknown';
    if (duration || tokens) {
      forecast.push(`Last selected task estimate · ${recordingAge} · recorded model ${model}. This is not the current task or model selection.`);
      forecastSummary = { recorded: `Last selected task · ${recordingAge}. Not the current task or model.`, duration: null, fit: null };
    }
    if (duration) {
      const line = `Middle half of observed durations ${formatDuration(duration.p25)}–${formatDuration(duration.p75)} · ${duration.samples} samples.`;
      forecast.push(line);
      forecastSummary!.duration = line;
    }
    if (tokens) forecast.push(`Observed task tokens ${Math.round(tokens.p25).toLocaleString()}–${Math.round(tokens.p75).toLocaleString()} · ${tokens.samples} samples; not remaining account tokens.`);
    if (duration || tokens) forecast.push(cohortSeat === null
      ? 'Historical engine/model/task-kind cohort pooled across accounts; account attribution unavailable. Estimates are not a completion guarantee.'
      : 'Historical engine/model/account/task-kind cohort. Estimates are not a completion guarantee.');
    const fit = field(rawForecast, 'fit');
    if (!localEligible && duration && hasDeadline && future && admission === 'eligible') {
      const line = fit === 'likely-before-reset' ? `Recorded task is estimated to fit before this ${deadlineLabel}.`
        : fit === 'unlikely-before-reset' ? `Recorded task may run past this ${deadlineLabel}.`
        : `Whether the recorded task fits before ${deadlineLabel} is uncertain.`;
      forecast.push(line);
      forecastSummary!.fit = line;
    }
  }
  if (forecast.length === 0) forecast.push('Task completion estimate unavailable.');
  return { state: evidenceAvailable ? 'ready' : 'stale', availability, timing, opportunity,
    freshness: localEligible ? 'Local runtime admission reported; no subscription quota reading applies.'
      : sampled === null ? 'Provider reading time unknown.' : `${fresh ? 'Reading' : 'Last reading'} ${formatDuration(Math.max(0, now - sampled))} ago.`, forecast, forecastSummary };
}
