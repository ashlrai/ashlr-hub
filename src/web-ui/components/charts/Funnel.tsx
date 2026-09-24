/**
 * components/charts/Funnel.tsx — an ordered pipeline (filed → verified →
 * passed → judged ship → merged). One series, so ONE hue for every bar (no
 * value ramp on stages); each bar's length is its share of the first stage,
 * and the step-to-step conversion is written out in words beside it. A zero
 * stage is an empty neutral track (never a full pale bar that reads 100%).
 *
 * Honesty: an unknown stage (null) draws a dashed placeholder and "unknown",
 * and the conversions on either side of it are "—", never a guessed rate.
 * Works at 375 px: below 480 px the stage label moves above its bar.
 */
import { useRef } from 'react';
import { CHART_SEQUENTIAL } from './colors.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { TableView, type TableColumn } from './TableView.js';
import { funnelSteps, roundedRightBar, type FunnelStep } from './chart-math.js';
import { formatCompact, formatPercent } from './format.js';
import { useChartWidth } from './useChartWidth.js';
import plot from './plot.module.css';

export interface FunnelStage {
  id: string;
  label: string;
  value: number | null;
}

export interface FunnelProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  stages: FunnelStage[];
  width?: number;
  color?: string;
  formatValue?: (v: number) => string;
  ariaLabel?: string;
}

const BAR_H = 20;
const NARROW = 480;

interface Row extends FunnelStep {
  stage: FunnelStage;
}

function conversionText(step: FunnelStep, index: number): string {
  if (index === 0) return '';
  return step.ofPrevious === null ? '— of previous' : `${formatPercent(step.ofPrevious, step.ofPrevious < 0.1 && step.ofPrevious > 0 ? 1 : 0)} of previous`;
}

export function Funnel({
  title,
  description,
  caveat,
  status,
  stages,
  width: fixedWidth,
  color = CHART_SEQUENTIAL,
  formatValue = formatCompact,
  ariaLabel,
}: FunnelProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const steps = funnelSteps(stages.map((s) => s.value));
  const rows: Row[] = stages.map((stage, i) => ({ ...steps[i]!, stage }));
  const first = stages[0]?.value ?? null;
  const resolvedStatus: ChartStatus = status ?? (
    stages.length === 0 || first === null
      ? (stages.length === 0 ? { kind: 'empty' } : { kind: 'unknown', reason: `the first stage (${stages[0]!.label}) is unknown` })
      : first === 0 ? { kind: 'empty', message: `No ${stages[0]!.label.toLowerCase()} in this window.` } : { kind: 'ready' }
  );

  // Bar length is a share of the widest stage — the first, in any real
  // funnel; the max only guards a later stage that out-counts it (it would
  // overflow the track). When that is 0 every bar is 0: an all-zero window
  // is a row of EMPTY tracks, never full bars that read as 100%.
  const scaleMax = Math.max(0, ...stages.map((s) => (s.value !== null && Number.isFinite(s.value) ? s.value : 0)));

  const narrow = width < NARROW;
  const labelW = narrow ? 0 : Math.min(170, Math.round(width * 0.28));
  const valueW = narrow ? 150 : 180;
  const plotW = Math.max(40, width - labelW - valueW);
  const rowH = narrow ? BAR_H + 22 : BAR_H + 14;
  const height = rows.length * rowH + 4;

  const summary = ariaLabel ?? `${title}: ` + rows
    .map((r, i) => `${r.stage.label} ${r.value === null ? 'unknown' : formatValue(r.value)}${i > 0 ? ` (${conversionText(r, i)})` : ''}`)
    .join(', ') + '.';

  const columns: TableColumn<Row>[] = [
    { key: 'stage', label: 'Stage', render: (r) => r.stage.label },
    { key: 'value', label: 'Count', numeric: true, render: (r) => (r.value === null ? '—' : formatValue(r.value)) },
    { key: 'prev', label: 'Of previous', numeric: true, render: (r) => (r.ofPrevious === null ? '—' : formatPercent(r.ofPrevious, 1)) },
    { key: 'first', label: 'Of first', numeric: true, render: (r) => (r.ofFirst === null ? '—' : formatPercent(r.ofFirst, 1)) },
  ];

  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={resolvedStatus}
      table={<TableView caption={title} columns={columns} rows={rows} rowKey={(r) => r.stage.id} />}
    >
      <div ref={wrapRef} className={plot.plotWrap}>
        <svg className={plot.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
          {rows.map((r, i) => {
            const y = i * rowH + (narrow ? 18 : 7);
            const barW = r.value === null || !(r.value > 0) || scaleMax <= 0 ? 0 : Math.max(3, (r.value / scaleMax) * plotW);
            const textY = y + BAR_H / 2;
            return (
              <g key={r.stage.id} data-stage={r.stage.id}>
                <text className={plot.label} x={narrow ? 0 : labelW - 10} y={narrow ? y - 5 : textY} dy={narrow ? undefined : '0.32em'} textAnchor={narrow ? 'start' : 'end'}>
                  {r.stage.label}
                </text>
                {/* The track is the neutral true-zero ground (heat-0), not the
                    pale azure meter track: at 0 it must read as empty. */}
                <rect data-role="track" className={plot.trackEmpty} x={labelW} y={y} width={plotW} height={BAR_H} rx={4} />
                {r.value === null ? (
                  <rect data-unknown="true" className={plot.noData} x={labelW} y={y} width={Math.min(plotW, 48)} height={BAR_H} rx={4} />
                ) : barW > 0 ? (
                  <path data-role="bar" d={roundedRightBar(labelW, y, barW, BAR_H)} fill={color} />
                ) : null}
                <text className={plot.labelStrong} x={labelW + plotW + 10} y={textY} dy="0.32em">
                  {r.value === null ? 'unknown' : formatValue(r.value)}
                  {i > 0 ? <tspan className={plot.tick} dx={8}>{conversionText(r, i)}</tspan> : null}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </ChartFrame>
  );
}
