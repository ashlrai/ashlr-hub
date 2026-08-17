/**
 * components/charts/colors.ts — the one place a chart asks for a color.
 * Every function returns a `var(--chart-*)` reference into chart-tokens.css
 * (never a literal hex) so theming is automatic and colors can never drift
 * out of sync between light and dark. See chart-tokens.css's header comment
 * for the palette-selection rationale — an exhaustive permutation search
 * clears the CVD adjacent floor (worst ΔE 13.8 light / 14.5 dark, target
 * 8.0) without changing which hues are used, only their series order.
 */

const SERIES_SLOTS = 7;

/** Fixed-order categorical color for series index `slot` (0-based). Color
 * follows the entity, never its row number — callers must assign a series
 * its slot once (e.g. by stable sort order) and keep it even if other
 * series are filtered out; never reassign slots to "fill the gap" left by
 * a removed series (see dataviz anti-patterns: "recolor-on-filter"). */
export function seriesColor(slot: number): string {
  const n = ((slot % SERIES_SLOTS) + SERIES_SLOTS) % SERIES_SLOTS;
  return `var(--chart-series-${n + 1})`;
}

/** The "Other"/overflow bucket color — never part of the identity rotation. */
export const CHART_NEUTRAL = 'var(--chart-neutral)';

/** Default single hue for magnitude (sequential) and for a single nominal
 * series (one series needs no legend box — every bar takes the same hue). */
export const CHART_SEQUENTIAL = 'var(--chart-sequential)';
export const CHART_SEQUENTIAL_SOFT = 'var(--chart-sequential-soft)';

export const CHART_DIVERGING_POS = 'var(--chart-diverging-pos)';
export const CHART_DIVERGING_NEG = 'var(--chart-diverging-neg)';
export const CHART_DIVERGING_MID = 'var(--chart-diverging-mid)';

export const CHART_GRID = 'var(--chart-grid)';
export const CHART_AXIS = 'var(--chart-axis)';
