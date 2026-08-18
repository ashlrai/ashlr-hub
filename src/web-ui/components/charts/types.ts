/**
 * components/charts/types.ts — shared shapes for the chart layer. Kept
 * deliberately small: a chart component takes already-shaped points, never
 * a raw backend response — each view is responsible for projecting its
 * QueryDef's data into these before handing it to a chart.
 */

export interface SeriesPoint {
  /** X position. Epoch ms for a time series, or an ordinal index for a
   * categorical x-axis (bar charts index into `categories` instead). */
  x: number;
  /** Y value. `null` is an EXPLICIT, honest gap in the data — a day with no
   * activity, a window with no reading — and must render as a visible break
   * in the line, never as a silent zero. Never coerce a missing value to 0
   * to "fill" a series. */
  y: number | null;
}

export interface Series {
  id: string;
  label: string;
  points: SeriesPoint[];
}

export interface CategoricalDatum {
  label: string;
  /** `null` means "no data for this category" (rendered as an empty slot
   * with a dash, never as a zero-height bar indistinguishable from a real
   * zero value). */
  value: number | null;
}
