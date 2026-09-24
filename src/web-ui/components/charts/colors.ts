/**
 * components/charts/colors.ts — the one place a chart asks for a colour
 * (owner: unit C0, with chart-tokens.css; the chart components are C7's).
 * Every value is a `var(--chart-*)` / `var(--engine-*)` / `var(--status-*)`
 * reference, never a literal hex, so theming is automatic and light and dark
 * can never drift apart. The roles — quantity, categorical, unknown, queued,
 * engine, status — are explained in chart-tokens.css's header.
 */

/**
 * Identity slots in the categorical rotation. SIX (V3.10): the palette is
 * derived to stay clear of every engine, status and quantity hue, and no
 * seventh family clears that bar — see design/tokens.css.
 */
export const SERIES_SLOT_COUNT = 6;

/** The "Other"/overflow bucket colour — never part of the identity rotation. */
export const CHART_NEUTRAL = 'var(--chart-neutral)';

/**
 * Fixed-order categorical colour for series `slot` (0-based). Colour follows
 * the entity, never its row number: assign each series its slot once (e.g.
 * by a stable sort) and keep it even when others are filtered out — never
 * re-pack slots to "fill the gap" (dataviz anti-pattern: recolor-on-filter).
 *
 * Past the sixth slot this answers the NEUTRAL "Other" colour instead of
 * cycling: a repeated colour would tell the reader two series are one. A
 * chart with more than six series should fold its tail into "Other" and say
 * so in the legend and the table.
 */
export function seriesColor(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SERIES_SLOT_COUNT) return CHART_NEUTRAL;
  return `var(--chart-series-${slot + 1})`;
}

/** Default single hue for magnitude (sequential) and for one nominal series. */
export const CHART_SEQUENTIAL = 'var(--chart-sequential)';
export const CHART_SEQUENTIAL_SOFT = 'var(--chart-sequential-soft)';

/** Steps in the quantity ramp (`--chart-seq-1..7`, azure 214°). */
export const SEQ_STEP_COUNT = 7;

/** Quantity ramp step 1..7 (1 = least). Out-of-range steps clamp. */
export function seqColor(step: number): string {
  const n = Number.isFinite(step) ? Math.max(1, Math.min(SEQ_STEP_COUNT, Math.round(step))) : 1;
  return `var(--chart-seq-${n})`;
}

/**
 * A magnitude in [0, 1] → its quantity step. For a known value only: an
 * unknown (null / NaN) is the hatch below, never the lightest step — a pale
 * azure cell would claim "a little", which is a measurement nobody made.
 */
export function quantityColor(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  return seqColor(1 + f * (SEQ_STEP_COUNT - 1));
}

export const CHART_DIVERGING_POS = 'var(--chart-diverging-pos)';
export const CHART_DIVERGING_NEG = 'var(--chart-diverging-neg)';
export const CHART_DIVERGING_MID = 'var(--chart-diverging-mid)';

export const CHART_GRID = 'var(--chart-grid)';
export const CHART_AXIS = 'var(--chart-axis)';

/** Status tones (the StatusBadge vocabulary). Status colours carry STATE, never
 * identity, and always travel with a text label (legend, tooltip, table). */
export type ChartTone = 'neutral' | 'info' | 'running' | 'success' | 'warning' | 'danger' | 'unknown';

export function toneColor(tone: ChartTone): string {
  return `var(--status-${tone}-solid)`;
}

/** Sequential heat steps 0..4 (0 = a true zero, not "no data"). */
export function heatColor(step: number): string {
  const n = Math.max(0, Math.min(4, Math.round(step)));
  return `var(--chart-heat-${n})`;
}

/** Unfilled meter/gauge track: the lightest step of the quantity ramp, not a gray. */
export const CHART_TRACK = 'var(--chart-track)';

// ---------------------------------------------------------------------------
// Unknown, queued / parked
// ---------------------------------------------------------------------------

/** The unknown gray — for the hatch stroke and the outline around it. */
export const CHART_UNKNOWN = 'var(--chart-unknown)';

/** A CSS background that draws the 45° unknown hatch (HTML bars, tiles, cells). */
export const CHART_UNKNOWN_HATCH = 'var(--chart-unknown-hatch)';

/**
 * The SVG version of the same hatch, as data: render it once per chart as
 *
 *   <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse"
 *            patternTransform={`rotate(${angle})`}>
 *     <line x1={0} y1={0} x2={0} y2={size} stroke={stroke} strokeWidth={strokeWidth} />
 *   </pattern>
 *
 * with `id` from `hatchPatternId(useId())` — ids are document-global, so a
 * shared literal id would let one chart's unmount blank another's hatch —
 * and fill unknown marks with `url(#id)` plus a CHART_UNKNOWN outline.
 */
export const UNKNOWN_HATCH = Object.freeze({
  size: 6,
  angle: 45,
  strokeWidth: 1.5,
  stroke: CHART_UNKNOWN,
});

/** A document-safe pattern id from React's `useId()` (which contains `:`). */
export function hatchPatternId(reactId: string): string {
  return `chart-hatch-${reactId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** Queued / parked work: an outline in this colour, no fill. */
export const CHART_QUEUED_OUTLINE = 'var(--chart-queued-outline)';

// ---------------------------------------------------------------------------
// Engines (identity only)
// ---------------------------------------------------------------------------

export type ChartEngine = 'claude' | 'codex' | 'grok' | 'local';

/**
 * An engine's identity colour. ONLY for charts that show nothing but engines
 * (runs by engine, usage bars) and the 2px tick beside a lane label — pass it
 * explicitly per series; a chart never picks engine colours by index. When
 * status colour is on screen, show engines by position and monogram instead.
 */
export function engineColor(engine: ChartEngine): string {
  return `var(--engine-${engine})`;
}
