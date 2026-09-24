/**
 * components/charts/chart-math.ts — the pure geometry and statistics behind
 * the V3.10 chart kit (AreaTrend, BarStack, Swimlane, Funnel, CalendarHeatmap,
 * BurnDown, Gauge). No React, no DOM: every function here is unit tested
 * directly, so a chart component is only layout glue around numbers that are
 * already proven.
 *
 * Honesty rule shared with types.ts: `null` is UNKNOWN and is never coerced to
 * 0 by anything in this file. Functions that need a number skip nulls and say
 * so in their return value.
 */
import { formatTick } from './format.js';

// ---------------------------------------------------------------------------
// Scales and ticks
// ---------------------------------------------------------------------------

export interface NiceTickOptions {
  /**
   * The data are whole counts: ticks land on integers only (a max of 1 run
   * gives 0 and 1, never 0 / 0.25 / 0.5 / 0.75 / 1 of a run).
   */
  integer?: boolean;
}

/**
 * "Nice" axis ticks: a step of 1, 2 or 5 × 10^n (and 25 × 10^n from 25 up)
 * chosen so there are about `count` intervals, starting at or below `min`
 * and ending at or above `max`. Clean numbers (0 / 250 / 500), never
 * 0 / 233.3 / 466.7.
 *
 * V3.10.1: a 2.5 step is only taken where it stays a whole number (25, 250,
 * …). 0.25 or 2.5 needs one more decimal than its magnitude, and every
 * one-decimal formatter in the app printed a 0–1 axis as
 * "0 / 0.3 / 0.5 / 0.8 / 1" — 0.2 steps say the same thing in clean numbers.
 */
export function niceTicks(min: number, max: number, count = 4, opts: NiceTickOptions = {}): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (max < min) [min, max] = [max, min];
  if (max === min) {
    if (max === 0) return [0, 1];
    const pad = Math.abs(max) * 0.5;
    return niceTicks(Math.min(0, min - pad), max + pad, count, opts);
  }
  const rawStep = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const allowQuarter = magnitude >= 10;
  const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? (allowQuarter ? 2.5 : 2) : residual <= 5 ? 5 : 10;
  let step = nice * magnitude;
  if (opts.integer && step < 1) step = 1;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const n = Math.round((end - start) / step);
  // Round away float drift (0.1 + 0.2) so labels stay clean; index-based so
  // the error never accumulates across a long axis.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const ticks: number[] = [];
  for (let i = 0; i <= n; i++) ticks.push(Number((start + i * step).toFixed(decimals)) || 0);
  return ticks;
}

/** True when every value is a whole number — counts, not measurements. */
export function allIntegers(values: ReadonlyArray<number>): boolean {
  return values.every((v) => Number.isInteger(v));
}

/**
 * Does a caller's tick formatter print these ticks honestly? A formatter
 * that rounds (`${Math.round(v)}%`, one decimal, "13K") can print two ticks
 * the same, or print 0.25 as "0.3". Each label's first number must equal
 * its tick up to a power-of-ten unit change (50 % of 0.5, 12.5K of 12500);
 * labels with no number in them are taken at their word.
 */
export function labelsFaithful(ticks: ReadonlyArray<number>, labels: ReadonlyArray<string>): boolean {
  if (new Set(labels).size !== labels.length) return false;
  return ticks.every((tick, i) => {
    if (tick === 0) return true;
    const match = /\d[\d,]*(?:\.\d+)?/.exec(labels[i] ?? '');
    if (!match) return true;
    const shown = Number(match[0].replace(/,/g, ''));
    if (!Number.isFinite(shown) || shown === 0) return false;
    const ratio = shown / Math.abs(tick);
    const unit = 10 ** Math.round(Math.log10(ratio));
    return Math.abs(ratio / unit - 1) < 1e-6;
  });
}

export interface AxisTicks {
  ticks: number[];
  labels: string[];
  step: number;
}

/**
 * Ticks AND their labels for a numeric axis. With no `format` the labels
 * take their precision from the step (format.ts formatTick). With a caller's
 * `format` (units: "%", "$", "pts") the ticks are coarsened until that
 * formatter prints every one of them faithfully — never a rounded label on
 * a precise tick.
 */
export function axisTicks(
  min: number,
  max: number,
  opts: { count?: number; integer?: boolean; format?: (v: number) => string } = {},
): AxisTicks {
  const count = Math.max(1, opts.count ?? 4);
  const build = (c: number, integer: boolean): AxisTicks => {
    const ticks = niceTicks(min, max, c, { integer });
    const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : 1;
    const labels = ticks.map((t) => (opts.format ? opts.format(t) : formatTick(t, step)));
    return { ticks, labels, step };
  };
  const first = build(count, opts.integer === true);
  if (!opts.format || labelsFaithful(first.ticks, first.labels)) return first;
  for (const integer of [opts.integer === true, true]) {
    for (let c = count; c >= 1; c--) {
      const candidate = build(c, integer);
      if (labelsFaithful(candidate.ticks, candidate.labels)) return candidate;
    }
  }
  return first;
}

/**
 * What a formatter's "%" means: 100 when it prints 50 as "50%" (values are
 * percent points), 1 when it prints 0.5 as "50%" (values are fractions),
 * null when it is not a percent formatter at all.
 */
export function percentScale(format: (v: number) => string): 100 | 1 | null {
  const asPercent = (v: number): number | null => {
    const s = format(v).trim();
    if (!s.endsWith('%')) return null;
    const n = Number(s.slice(0, -1).replace(/[,\s+]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  if (asPercent(50) === 50) return 100;
  if (asPercent(0.5) === 50) return 1;
  return null;
}

// ---------------------------------------------------------------------------
// Time domains (V3.10.1)
// ---------------------------------------------------------------------------

/**
 * 2000-01-01T00:00:00Z. On a time axis anything earlier — 0 from a null
 * timestamp, a NaN from a failed parse — is a leak, not data: it drew an
 * axis starting "Dec 31" (1969, in the viewer's zone) on the live Verse.
 */
export const MIN_PLAUSIBLE_TIME = 946_684_800_000;

export function isPlausibleTime(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_PLAUSIBLE_TIME;
}

/**
 * An x axis is a time axis when any of its values is a plausible epoch-ms
 * timestamp. Small ordinals (0, 1, 2 — an index axis) are not, and keep
 * every finite value.
 */
export function isTimeAxis(xs: ReadonlyArray<number>): boolean {
  return xs.some(isPlausibleTime);
}

/** A filter for x values: on a time axis only plausible timestamps, otherwise any finite value. */
export function xKeeper(xs: ReadonlyArray<number>): (x: number) => boolean {
  return isTimeAxis(xs) ? isPlausibleTime : Number.isFinite;
}

/**
 * The narrowest time domain a chart draws: 10 minutes. A burst of readings
 * a few seconds apart used to stretch across the full width with three
 * identical time labels stacked on each other; widened, it sits as the
 * short cluster it is, on an axis whose ends read as two different times.
 */
export const MIN_TIME_SPAN_MS = 10 * 60_000;

/**
 * Widen [min, max] to at least `minSpan`, around its middle ('center') or
 * keeping its right edge ('end' — for axes that end at now or a reset).
 */
export function ensureSpan(min: number, max: number, minSpan: number, align: 'center' | 'end' = 'center'): [number, number] {
  if (max < min) [min, max] = [max, min];
  if (max - min >= minSpan) return [min, max];
  if (align === 'end') return [max - minSpan, max];
  const mid = (min + max) / 2;
  return [mid - minSpan / 2, mid + minSpan / 2];
}

// ---------------------------------------------------------------------------
// Label layout (V3.10.1): collision-free axis labels and dodged end labels
// ---------------------------------------------------------------------------

/**
 * Estimated advance of one label character: --text-xs-size (12 px) × 0.6,
 * the UI sans's average advance at medium weight, rounded up so estimates
 * err wide rather than letting two labels touch.
 */
export const LABEL_CHAR_PX = 12 * 0.6;

export function estimateTextWidth(text: string, charPx = LABEL_CHAR_PX): number {
  return text.length * charPx;
}

export type LabelAnchor = 'start' | 'middle' | 'end';

export interface AxisLabelSpec {
  key: string;
  /** Where the label points. */
  x: number;
  /** How it would like to hang off `x`. */
  anchor: LabelAnchor;
  /** Higher survives a collision: a marker / reset > the end > the start > interior ticks. */
  priority: number;
  /** The label at each detail level, most detailed first; the last entry repeats for deeper levels. */
  variants: ReadonlyArray<string>;
  /**
   * Required labels (the ends, markers) decide how far down the detail
   * ladder the axis goes; optional ones (interior ticks) are simply dropped
   * when they collide.
   */
  required?: boolean;
}

export interface PlacedAxisLabel {
  key: string;
  text: string;
  x: number;
  anchor: LabelAnchor;
}

export interface AxisLabelBounds {
  /** Leftmost / rightmost extent a label may occupy. */
  min: number;
  max: number;
  /** Minimum clear space between two labels. */
  gap?: number;
  charPx?: number;
}

function placeLevel(specs: ReadonlyArray<AxisLabelSpec>, level: number, bounds: AxisLabelBounds): PlacedAxisLabel[] {
  const gap = bounds.gap ?? 8;
  const order = specs.map((s, i) => ({ s, i })).sort((a, b) => b.s.priority - a.s.priority || a.i - b.i);
  const boxes: { left: number; right: number; text: string; i: number; label: PlacedAxisLabel }[] = [];
  for (const { s, i } of order) {
    const text = s.variants[Math.min(level, s.variants.length - 1)] ?? '';
    if (!text) continue;
    const w = estimateTextWidth(text, bounds.charPx);
    if (w > bounds.max - bounds.min) continue;
    let left = s.anchor === 'start' ? s.x : s.anchor === 'end' ? s.x - w : s.x - w / 2;
    let x = s.x;
    let anchor: LabelAnchor = s.anchor;
    // Keep the label inside the axis: pinned to an edge, it hangs off that edge.
    if (left < bounds.min) {
      left = bounds.min;
      x = bounds.min;
      anchor = 'start';
    } else if (left + w > bounds.max) {
      left = bounds.max - w;
      x = bounds.max;
      anchor = 'end';
    }
    const right = left + w;
    // Two labels that say the same thing are one label too many, wherever they sit.
    const clash = boxes.some((b) => b.text === text || (left < b.right + gap && b.left < right + gap));
    if (clash) continue;
    boxes.push({ left, right, text, i, label: { key: s.key, text, x, anchor } });
  }
  return boxes.sort((a, b) => a.i - b.i).map((b) => b.label);
}

/**
 * Lay out one axis's labels so none overlap. Every label at a level uses
 * the same rung of its detail ladder; the chosen level is the most detailed
 * one that places as many REQUIRED labels as any level can. Within a level,
 * higher priority wins a collision and the loser is dropped — so a tight
 * burn-down keeps "Resets Sep 25" and shortens or drops the start, rather
 * than printing the two over each other.
 */
export function layoutAxisLabels(specs: ReadonlyArray<AxisLabelSpec>, bounds: AxisLabelBounds): PlacedAxisLabel[] {
  if (specs.length === 0) return [];
  const levels = Math.max(1, ...specs.map((s) => s.variants.length));
  const requiredKeys = new Set(specs.filter((s) => s.required !== false).map((s) => s.key));
  let best: PlacedAxisLabel[] = [];
  let bestScore = -1;
  for (let level = 0; level < levels; level++) {
    const placed = placeLevel(specs, level, bounds);
    const score = placed.filter((p) => requiredKeys.has(p.key)).length;
    if (score > bestScore) {
      best = placed;
      bestScore = score;
    }
    if (bestScore === requiredKeys.size) break;
  }
  return best;
}

/**
 * Spread direct labels (end-of-line series names) vertically so none
 * overlaps: labels closer than `gap` merge into a cluster centred on their
 * own targets, clamped inside [top, bottom]. Returns each key's y, or null
 * when they cannot all fit — the caller then falls back to the legend
 * alone rather than drawing labels over each other. Ties keep input order.
 */
export function dodgeLabels(
  items: ReadonlyArray<{ key: string; y: number }>,
  gap: number,
  top: number,
  bottom: number,
): Map<string, number> | null {
  if (items.length === 0) return new Map();
  if ((items.length - 1) * gap > bottom - top + 1e-9) return null;
  const sorted = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  interface Cluster { members: typeof sorted; top: number }
  const place = (members: typeof sorted): Cluster => {
    const mean = members.reduce((s, m) => s + m.y, 0) / members.length;
    const extent = (members.length - 1) * gap;
    return { members, top: clamp(mean - extent / 2, top, bottom - extent) };
  };
  let clusters: Cluster[] = sorted.map((m) => place([m]));
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i + 1 < clusters.length; i++) {
      const a = clusters[i]!;
      const b = clusters[i + 1]!;
      if (a.top + a.members.length * gap > b.top + 1e-9) {
        clusters = [...clusters.slice(0, i), place([...a.members, ...b.members]), ...clusters.slice(i + 2)];
        merged = true;
        break;
      }
    }
  }
  const out = new Map<string, number>();
  for (const c of clusters) c.members.forEach((m, k) => out.set(m.key, c.top + k * gap));
  return out;
}

/** Linear map from [d0, d1] to [r0, r1]; a zero-width domain maps to the range midpoint. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Evenly thinned indexes so at most `max` labels are drawn, always keeping the last one. */
export function thinIndexes(length: number, max: number): number[] {
  if (length <= 0) return [];
  if (max <= 1) return [length - 1];
  if (length <= max) return Array.from({ length }, (_, i) => i);
  const step = Math.ceil((length - 1) / (max - 1));
  const out: number[] = [];
  for (let i = length - 1; i >= 0; i -= step) out.push(i);
  return out.reverse();
}

/** Clamp to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// Runs (null-aware line segments)
// ---------------------------------------------------------------------------

export interface XY {
  x: number;
  y: number;
}

/** Split a series at nulls so a gap renders as a break, never as a dip to zero. */
export function splitRuns(points: ReadonlyArray<{ x: number; y: number | null }>): XY[][] {
  const runs: XY[][] = [];
  let current: XY[] = [];
  for (const p of points) {
    if (p.y === null || !Number.isFinite(p.y)) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    current.push({ x: p.x, y: p.y });
  }
  if (current.length) runs.push(current);
  return runs;
}

export function linePath(run: ReadonlyArray<XY>): string {
  return run.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)},${round(p.y)}`).join(' ');
}

/** Closed area under (or between) a run and a baseline run of equal length. */
export function areaPath(top: ReadonlyArray<XY>, bottom: ReadonlyArray<XY>): string {
  if (top.length === 0) return '';
  const back = [...bottom].reverse();
  return `${linePath(top)} ${back.map((p) => `L${round(p.x)},${round(p.y)}`).join(' ')} Z`;
}

export function round(v: number): number {
  return Math.round(v * 10) / 10;
}

// ---------------------------------------------------------------------------
// Stacking
// ---------------------------------------------------------------------------

export interface StackSegment {
  /** Segment index in the caller's segment list. */
  index: number;
  value: number;
  y0: number;
  y1: number;
}

export interface StackedColumn {
  segments: StackSegment[];
  /** Sum of known values. */
  total: number;
  /** True when at least one segment value is null (the total is a lower bound). */
  incomplete: boolean;
  /** True when every segment value is null (nothing is known). */
  unknown: boolean;
}

/** Stack one column's values bottom-up. Nulls are skipped and flagged, zeros take no height. */
export function stackColumn(values: ReadonlyArray<number | null>): StackedColumn {
  let acc = 0;
  let incomplete = false;
  let known = 0;
  const segments: StackSegment[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      incomplete = true;
      return;
    }
    known++;
    const v = Math.max(0, value);
    if (v > 0) segments.push({ index, value: v, y0: acc, y1: acc + v });
    acc += v;
  });
  return { segments, total: acc, incomplete, unknown: known === 0 && values.length > 0 };
}

// ---------------------------------------------------------------------------
// Rounded-end bars (4 px data end, square at the baseline)
// ---------------------------------------------------------------------------

/**
 * Path for a vertical bar whose TOP corners are rounded by `r` (the data end)
 * and whose bottom sits square on the baseline. `r` shrinks for short bars so
 * the corners never cross.
 */
export function roundedTopBar(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return [
    `M${round(x)},${round(y + h)}`,
    `L${round(x)},${round(y + rr)}`,
    `Q${round(x)},${round(y)} ${round(x + rr)},${round(y)}`,
    `L${round(x + w - rr)},${round(y)}`,
    `Q${round(x + w)},${round(y)} ${round(x + w)},${round(y + rr)}`,
    `L${round(x + w)},${round(y + h)}`,
    'Z',
  ].join(' ');
}

/** Horizontal twin: RIGHT corners rounded (the data end), left square on the baseline. */
export function roundedRightBar(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.max(0, Math.min(r, h / 2, w));
  return [
    `M${round(x)},${round(y)}`,
    `L${round(x + w - rr)},${round(y)}`,
    `Q${round(x + w)},${round(y)} ${round(x + w)},${round(y + rr)}`,
    `L${round(x + w)},${round(y + h - rr)}`,
    `Q${round(x + w)},${round(y + h)} ${round(x + w - rr)},${round(y + h)}`,
    `L${round(x)},${round(y + h)}`,
    'Z',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export interface FunnelStep {
  value: number | null;
  /** Share of the FIRST stage (0..1), null when either side is unknown or the first is 0. */
  ofFirst: number | null;
  /** Share of the PREVIOUS stage (0..1), null for the first stage or when unknown. */
  ofPrevious: number | null;
}

export function funnelSteps(values: ReadonlyArray<number | null>): FunnelStep[] {
  const first = values[0] ?? null;
  return values.map((value, i) => {
    const previous = i > 0 ? values[i - 1] ?? null : null;
    return {
      value,
      ofFirst: value !== null && first !== null && first > 0 ? value / first : null,
      ofPrevious: i > 0 && value !== null && previous !== null && previous > 0 ? value / previous : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Calendar heatmap
// ---------------------------------------------------------------------------

export interface CalendarCell {
  day: string;
  value: number | null;
  /** Column (week index from the first rendered week). */
  week: number;
  /** Row, 0 = weekStart. */
  weekday: number;
  /** True for days before the first datum / after the last (padding cells). */
  outside: boolean;
}

export interface CalendarGrid {
  cells: CalendarCell[];
  weeks: number;
  /** Week index where each month first appears, for the month labels. */
  months: { week: number; label: string }[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcDayMs(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms : null;
}

/**
 * Lay out consecutive days on a weeks × weekdays grid. Input days may be
 * sparse or unordered; missing days in the span become `value: null`
 * (unknown), never 0. `weekStart` 1 = Monday (ISO), 0 = Sunday.
 */
export function calendarGrid(
  days: ReadonlyArray<{ day: string; value: number | null }>,
  weekStart: 0 | 1 = 1,
): CalendarGrid {
  const byDay = new Map<string, number | null>();
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const d of days) {
    const ms = utcDayMs(d.day);
    // A pre-2000 day is a null/zero date that leaked through, not a datum —
    // one would stretch the grid back to 1970.
    if (ms === null || ms < MIN_PLAUSIBLE_TIME) continue;
    byDay.set(d.day, d.value);
    minMs = Math.min(minMs, ms);
    maxMs = Math.max(maxMs, ms);
  }
  if (!Number.isFinite(minMs)) return { cells: [], weeks: 0, months: [] };
  const DAY = 86_400_000;
  const firstWeekday = (new Date(minMs).getUTCDay() - weekStart + 7) % 7;
  const gridStart = minMs - firstWeekday * DAY;
  const lastWeekday = (new Date(maxMs).getUTCDay() - weekStart + 7) % 7;
  const gridEnd = maxMs + (6 - lastWeekday) * DAY;
  const cells: CalendarCell[] = [];
  const months: { week: number; label: string }[] = [];
  let lastMonth = -1;
  for (let ms = gridStart, i = 0; ms <= gridEnd; ms += DAY, i++) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const week = Math.floor(i / 7);
    const weekday = i % 7;
    const outside = ms < minMs || ms > maxMs;
    cells.push({ day, value: outside ? null : byDay.has(day) ? byDay.get(day)! : null, week, weekday, outside });
    const month = new Date(ms).getUTCMonth();
    // First rendered week of each month; the component drops a label that
    // would collide with the previous one.
    if (!outside && month !== lastMonth) {
      months.push({ week, label: MONTHS[month]! });
      lastMonth = month;
    }
  }
  return { cells, weeks: Math.floor((gridEnd - gridStart) / DAY / 7) + 1, months };
}

/**
 * Bucket a value into 0..steps for a sequential ramp: 0 is reserved for a
 * true zero, 1..steps split (0, max] evenly. null → null (unknown).
 */
export function heatBucket(value: number | null, max: number, steps = 4): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value <= 0 || max <= 0) return 0;
  return clamp(Math.ceil((value / max) * steps), 1, steps);
}

// ---------------------------------------------------------------------------
// Burn-down projection
// ---------------------------------------------------------------------------

export interface BurnPoint {
  t: number;
  remaining: number | null;
}

export interface BurnProjection {
  /** Units per millisecond (negative while burning). Null with fewer than two known points. */
  slopePerMs: number | null;
  /** When the projection crosses 0, if it does before `resetAt`. */
  exhaustAt: number | null;
  /** When it crosses `reserve`, if a reserve is set and it does before `resetAt`. */
  reserveAt: number | null;
  /** Projected remaining at reset (clamped at 0), or null when there is no slope. */
  remainingAtReset: number | null;
  /** The last known point the projection starts from. */
  from: { t: number; remaining: number } | null;
}

/**
 * Least-squares slope over the most recent `window` known points, projected
 * forward from the last known point. A flat or rising series never
 * "exhausts". Pure: the caller supplies `resetAt`.
 */
export function projectBurnDown(
  points: ReadonlyArray<BurnPoint>,
  resetAt: number,
  opts: { window?: number; reserve?: number | null } = {},
): BurnProjection {
  const known = points
    .filter((p): p is { t: number; remaining: number } => p.remaining !== null && Number.isFinite(p.remaining) && Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  const from = known.length ? known[known.length - 1]! : null;
  const recent = known.slice(-(opts.window ?? 6));
  if (!from || recent.length < 2) {
    return { slopePerMs: null, exhaustAt: null, reserveAt: null, remainingAtReset: null, from };
  }
  const n = recent.length;
  const meanT = recent.reduce((s, p) => s + p.t, 0) / n;
  const meanR = recent.reduce((s, p) => s + p.remaining, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of recent) {
    num += (p.t - meanT) * (p.remaining - meanR);
    den += (p.t - meanT) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const crossing = (level: number): number | null => {
    if (slope >= 0 || from.remaining <= level) return from.remaining <= level ? from.t : null;
    const at = from.t + (level - from.remaining) / slope;
    return at <= resetAt ? at : null;
  };
  const reserve = opts.reserve ?? null;
  return {
    slopePerMs: slope,
    exhaustAt: crossing(0),
    reserveAt: reserve === null ? null : crossing(reserve),
    remainingAtReset: Math.max(0, from.remaining + slope * Math.max(0, resetAt - from.t)),
    from,
  };
}

// ---------------------------------------------------------------------------
// Gauge arcs
// ---------------------------------------------------------------------------

/** Point on a circle; angle in radians, 0 = +x axis, measured counter-clockwise (SVG y flipped). */
export function polar(cx: number, cy: number, r: number, angle: number): XY {
  return { x: cx + r * Math.cos(angle), y: cy - r * Math.sin(angle) };
}

/**
 * SVG arc for a 180° gauge from fraction `f0` to `f1` (0 = left end, 1 =
 * right end, sweeping over the top). Fractions are clamped to [0, 1].
 */
export function gaugeArc(cx: number, cy: number, r: number, f0: number, f1: number): string {
  const a = clamp(f0, 0, 1);
  const b = clamp(f1, 0, 1);
  if (b <= a) return '';
  const start = polar(cx, cy, r, Math.PI * (1 - a));
  const end = polar(cx, cy, r, Math.PI * (1 - b));
  // A 180° gauge never needs the large-arc flag (the span is at most π).
  return `M${round(start.x)},${round(start.y)} A${r},${r} 0 0 1 ${round(end.x)},${round(end.y)}`;
}

export type GaugeSeverity = 'ok' | 'warn' | 'danger' | 'unknown';

export function gaugeSeverity(value: number | null, warn: number, danger: number): GaugeSeverity {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  if (value >= danger) return 'danger';
  if (value >= warn) return 'warn';
  return 'ok';
}
