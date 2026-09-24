/**
 * components/charts/index.ts — barrel export for the shared chart layer.
 * See DESIGN.md and this directory's individual files for conventions;
 * chart-tokens.css's header comment has the palette-derivation rationale.
 */
export { ChartContainer } from './ChartContainer.js';
export { Legend, type LegendItem } from './Legend.js';
export { LineChart } from './LineChart.js';
export { BarChart } from './BarChart.js';
export { Sparkline, sparklineSummary } from './Sparkline.js';
export { StatTile, type StatTileDelta } from './StatTile.js';
export { TableView, type TableColumn } from './TableView.js';
export type { Series, SeriesPoint, CategoricalDatum } from './types.js';
export {
  seriesColor,
  toneColor,
  heatColor,
  CHART_NEUTRAL,
  CHART_SEQUENTIAL,
  CHART_SEQUENTIAL_SOFT,
  CHART_TRACK,
  type ChartTone,
} from './colors.js';
export * as chartFormat from './format.js';

// V3.10 chart kit — every chart below renders in ChartFrame (Chart | Table
// toggle, designed empty / dark / unknown states) and sizes to its container.
export { ChartFrame, sinceLabel, type ChartStatus, type ChartView } from './ChartFrame.js';
export { AreaTrend, type AreaTrendSeries, type AreaTrendProps } from './AreaTrend.js';
export { BarStack, type BarStackSegment, type BarStackProps } from './BarStack.js';
export { Swimlane, type SwimlaneItem, type SwimlaneLane, type SwimlaneProps } from './Swimlane.js';
export { Funnel, type FunnelStage, type FunnelProps } from './Funnel.js';
export { CalendarHeatmap, type CalendarDatum, type CalendarHeatmapProps } from './CalendarHeatmap.js';
export { BurnDown, burnVerdict, type BurnDownProps } from './BurnDown.js';
export { Gauge, type GaugeProps } from './Gauge.js';
export * as chartMath from './chart-math.js';

// V3.10 Track C (unit C7) — charts v2.
export { ForestPlot, forestVerdict, type ForestRow, type ForestPlotProps, type ForestVerdict } from './ForestPlot.js';
export { MatrixHeatmap, matrixTotals, type MatrixAxisItem, type MatrixHeatmapProps } from './MatrixHeatmap.js';
export { StepBand, stepSpans, type StepPoint, type StepMarker, type StepBandProps, type StepSpan } from './StepBand.js';
export { HatchPattern, EngineTick, engineLetter, type ChartLegendItem } from './ChartParts.js';
export { deltaText } from './StatTile.js';
export { OUTLINE_STATUSES } from './Swimlane.js';
export { gaugeDiameter, MIN_GAUGE_SIZE } from './Gauge.js';
export {
  engineColor,
  quantityColor,
  seqColor,
  hatchPatternId,
  CHART_UNKNOWN,
  CHART_UNKNOWN_HATCH,
  CHART_QUEUED_OUTLINE,
  CHART_DIVERGING_POS,
  CHART_DIVERGING_NEG,
  CHART_DIVERGING_MID,
  UNKNOWN_HATCH,
  type ChartEngine,
} from './colors.js';
