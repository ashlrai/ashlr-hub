/**
 * components/charts/format.ts — number formatting shared by every chart and
 * stat tile. Proportional figures everywhere EXCEPT columns that must align
 * vertically (table cells, axis ticks) — see marks-and-anatomy.md "Proportional
 * figures for big numbers; tabular only in columns." Callers apply
 * `font-variant-numeric: tabular-nums` via CSS where that applies; these
 * functions only produce the string.
 */

/** Auto-compact a count: 1,284 / 12.9K / 4.2M. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}K`;
  if (abs >= 1_000) return n.toLocaleString('en-US');
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Auto-compact USD: $4.20 / $1.2K / $4.2M. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Fraction (0..1) as a percentage. */
export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Signed delta for a stat tile: "+12" / "-3" / "0". */
export function formatSignedCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const s = formatCompact(Math.abs(n));
  if (n > 0) return `+${s}`;
  if (n < 0) return `-${s}`;
  return s;
}

/** YYYY-MM-DD -> short label, e.g. "Aug 14". Local-independent (UTC parse). */
export function formatDayLabel(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const d = new Date(`${day}T00:00:00Z`);
  // Date normalizes impossible dates; compare the padded UTC date to reject rollover.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return day;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Epoch ms -> short label for axis ticks. */
export function formatTimeLabel(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Axis tick precision (V3.10.1)
// ---------------------------------------------------------------------------

/**
 * Decimals needed to print `step` exactly: 1 → 0, 0.2 → 1, 0.25 → 2, 0.05 → 2.
 * An axis label's precision comes from the STEP between ticks, never from a
 * fixed one-decimal format — a 0.25 step printed at one decimal read
 * "0 / 0.3 / 0.5 / 0.8 / 1" on the live Verse cards.
 */
export function stepDecimals(step: number): number {
  const s = Math.abs(step);
  if (!Number.isFinite(s) || s === 0) return 0;
  for (let d = 0; d <= 10; d++) {
    const scaled = s * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return d;
  }
  return 10;
}

/**
 * A tick label at the precision its step needs: every tick on one axis
 * carries the same number of decimals (0.0 / 0.2 / … / 1.0 reads as a scale;
 * 0 / 0.3 / 0.5 misreads as rounded data). Zero is always "0". Large values
 * compact like formatCompact (12.5K, 1.25M), again at the step's precision.
 */
export function formatTick(value: number, step: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < Math.abs(step) * 1e-9 || value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(Math.min(3, stepDecimals(step / 1_000_000)))}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(Math.min(3, stepDecimals(step / 1_000)))}K`;
  const d = stepDecimals(step);
  return d === 0 ? Math.round(value).toLocaleString('en-US') : value.toFixed(d);
}

// ---------------------------------------------------------------------------
// Time labels for axes (V3.10.1)
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function localeFormatter(opts: Intl.DateTimeFormatOptions): (ms: number) => string {
  return (ms) => {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', opts);
  };
}

/** "11:46 PM" — a clock time with no date. */
export const formatClockTime = localeFormatter({ hour: 'numeric', minute: '2-digit' });

/** "Fri 11:46 PM" — weekday and clock time (unambiguous inside a week). */
export const formatWeekdayTime = localeFormatter({ weekday: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * True when a time span sits inside one day — both ends on the same local
 * calendar day, or under 12 h apart (a 5-hour window across midnight) — so a
 * date on every label would only repeat itself. A zero span is NOT "within a
 * day": a single daily bucket keeps its date, never becomes "8:00 PM".
 */
export function withinOneDay(from: number, to: number): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false;
  return to - from < 12 * HOUR_MS || new Date(from).toDateString() === new Date(to).toDateString();
}

/**
 * The detail ladder for the labels on one time axis, most detailed first;
 * the label layout (chart-math layoutAxisLabels) walks down it only until
 * the labels fit. Level by level every label on the axis uses the same rung,
 * so an axis never mixes "Fri, Sep 18 at 11:46 PM" with "Sep 25".
 *
 *   within one day   → clock time only ("11:46 PM"), whatever the caller's format;
 *   caller's format  → it first, then "Fri 11:46 PM" (spans under ~a week
 *                      whose labels differ in time of day), then "Sep 18";
 *   no caller format → "Sep 18" (the kit's day label).
 *
 * `from`/`to` are the DATA extent (not a widened domain); `stamps` are the
 * labelled instants — when they all share one time of day (daily buckets,
 * a 7-day window) the clock time says nothing and is skipped.
 */
export function timeLabelLadder(
  from: number,
  to: number,
  custom?: (ms: number) => string,
  stamps: readonly number[] = [from, to],
): Array<(ms: number) => string> {
  if (withinOneDay(from, to)) return [formatClockTime];
  if (!custom) return [formatTimeLabel];
  const distinctTimeOfDay = new Set(stamps.map(formatClockTime)).size > 1;
  return to - from < 6.5 * DAY_MS && distinctTimeOfDay ? [custom, formatWeekdayTime, formatTimeLabel] : [custom, formatTimeLabel];
}
