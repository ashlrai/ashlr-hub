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

// ---------------------------------------------------------------------------
// Scales and ticks
// ---------------------------------------------------------------------------

/**
 * "Nice" axis ticks: a step of 1, 2, 2.5 or 5 × 10^n chosen so there are
 * about `count` intervals, starting at or below `min` and ending at or above
 * `max`. Clean numbers (0 / 250 / 500), never 0 / 233.3 / 466.7.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (max < min) [min, max] = [max, min];
  if (max === min) {
    if (max === 0) return [0, 1];
    const pad = Math.abs(max) * 0.5;
    return niceTicks(Math.min(0, min - pad), max + pad, count);
  }
  const rawStep = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  const step = nice * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Round away float drift (0.1 + 0.2) so labels stay clean.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(decimals)));
  return ticks;
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
    if (ms === null) continue;
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
