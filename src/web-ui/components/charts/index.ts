/**
 * components/charts/index.ts — barrel export for the shared chart layer.
 * See DESIGN.md and this directory's individual files for conventions;
 * chart-tokens.css's header comment has the palette-derivation rationale.
 */
export { ChartContainer } from './ChartContainer.js';
export { Legend, type LegendItem } from './Legend.js';
export { LineChart } from './LineChart.js';
export { BarChart } from './BarChart.js';
export { Sparkline } from './Sparkline.js';
export { StatTile, type StatTileDelta } from './StatTile.js';
export { TableView, type TableColumn } from './TableView.js';
export type { Series, SeriesPoint, CategoricalDatum } from './types.js';
export { seriesColor, CHART_NEUTRAL, CHART_SEQUENTIAL, CHART_SEQUENTIAL_SOFT } from './colors.js';
export * as chartFormat from './format.js';
