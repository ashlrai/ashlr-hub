/**
 * components/charts/BurnDown.tsx — a quota window burning down to its reset:
 * remaining capacity over time (solid line + wash), the even-pace reference
 * from full at window start to empty at reset (thin dashed), a projection
 * from the recent slope (dashed), an optional reserve line (the headroom kept
 * for interactive use) and the reset marker.
 *
 * The verdict is written in words under the plot — "At this pace: reserve
 * reached 14:20, 3h 40m before reset" — so the chart's point never depends on
 * reading slopes. With fewer than two readings it says it cannot project,
 * rather than drawing a guess.
 */
import { useRef } from 'react';
import { CHART_SEQUENTIAL, toneColor } from './colors.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { ChartLegend } from './ChartParts.js';
import { TableView, type TableColumn } from './TableView.js';
import { areaPath, linePath, linearScale, niceTicks, projectBurnDown, splitRuns, type BurnPoint } from './chart-math.js';
import { formatCompact } from './format.js';
import { useChartWidth } from './useChartWidth.js';
import plot from './plot.module.css';

export interface BurnDownProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  points: BurnPoint[];
  /** Full capacity of the window (e.g. 100 for percent). */
  capacity: number;
  /** Window start and reset, epoch ms. */
  start: number;
  resetAt: number;
  now: number;
  /** Capacity to keep in reserve (same units as `remaining`). */
  reserve?: { value: number; label: string };
  height?: number;
  width?: number;
  formatValue?: (v: number) => string;
  formatTime?: (ms: number) => string;
  ariaLabel?: string;
}

const PAD_T = 16;
const PAD_B = 26;
const PAD_R = 14;

function defaultFormatTime(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function formatLead(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function burnVerdict(
  projection: ReturnType<typeof projectBurnDown>,
  resetAt: number,
  formatValue: (v: number) => string,
  formatTime: (ms: number) => string,
  reserveLabel?: string,
): { text: string; severity: 'ok' | 'warn' | 'danger' | 'unknown' } {
  // Already past a line: say where it IS, not a "projection" to a moment
  // that has passed (a used-up seat is not "running out at 3:02").
  if (projection.from && projection.from.remaining <= 0) {
    return { text: `Used up — resets ${formatTime(resetAt)}.`, severity: 'danger' };
  }
  if (projection.from && reserveLabel !== undefined && projection.reserveAt !== null && projection.reserveAt <= projection.from.t) {
    return { text: `Inside ${reserveLabel.toLowerCase()} — autonomy has stopped using this window until ${formatTime(resetAt)}.`, severity: 'warn' };
  }
  if (projection.slopePerMs === null) return { text: 'Not enough readings to project this window yet.', severity: 'unknown' };
  if (projection.exhaustAt !== null) {
    return {
      text: `At this pace: runs out ${formatTime(projection.exhaustAt)}, ${formatLead(resetAt - projection.exhaustAt)} before reset.`,
      severity: 'danger',
    };
  }
  if (projection.reserveAt !== null) {
    return {
      text: `At this pace: ${reserveLabel ?? 'reserve'} reached ${formatTime(projection.reserveAt)}, ${formatLead(resetAt - projection.reserveAt)} before reset.`,
      severity: 'warn',
    };
  }
  return {
    text: `At this pace: about ${formatValue(projection.remainingAtReset ?? 0)} left at reset.`,
    severity: 'ok',
  };
}

export function BurnDown({
  title,
  description,
  caveat,
  status,
  points,
  capacity,
  start,
  resetAt,
  now,
  reserve,
  height = 200,
  width: fixedWidth,
  formatValue = formatCompact,
  formatTime = defaultFormatTime,
  ariaLabel,
}: BurnDownProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const anyKnown = sorted.some((p) => p.remaining !== null);
  const resolvedStatus: ChartStatus = status ?? (sorted.length === 0 ? { kind: 'empty', message: 'No readings in this window yet.' } : anyKnown ? { kind: 'ready' } : { kind: 'unknown' });

  const projection = projectBurnDown(sorted, resetAt, { reserve: reserve?.value ?? null });
  const verdict = burnVerdict(projection, resetAt, formatValue, formatTime, reserve?.label);

  const ticks = niceTicks(0, Math.max(capacity, 1), 4);
  const top = ticks[ticks.length - 1]!;
  const padL = Math.min(56, Math.max(28, Math.max(...ticks.map((t) => formatValue(t).length)) * 7 + 10));
  const plotW = Math.max(40, width - padL - PAD_R);
  const plotH = height - PAD_T - PAD_B;
  const xEnd = Math.max(resetAt, start + 1);
  const xs = linearScale(start, xEnd, padL, padL + plotW);
  const ys = linearScale(0, top, PAD_T + plotH, PAD_T);
  const clampX = (t: number) => Math.min(xEnd, Math.max(start, t));

  const runs = splitRuns(sorted.map((p) => ({ x: clampX(p.t), y: p.remaining })))
    .map((run) => run.map((p) => ({ x: xs(p.x), y: ys(Math.max(0, p.y)) })));

  let projectionPath = '';
  if (projection.from && projection.slopePerMs !== null) {
    const endT = projection.exhaustAt ?? resetAt;
    const endR = projection.exhaustAt !== null ? 0 : projection.remainingAtReset ?? projection.from.remaining;
    if (endT > projection.from.t) {
      projectionPath = linePath([
        { x: xs(clampX(projection.from.t)), y: ys(projection.from.remaining) },
        { x: xs(clampX(endT)), y: ys(Math.max(0, endR)) },
      ]);
    }
  }
  const projectionColor = verdict.severity === 'danger' ? toneColor('danger') : verdict.severity === 'warn' ? toneColor('warning') : 'var(--text-tertiary)';

  const summary = ariaLabel ?? `${title}: ${projection.from ? `${formatValue(projection.from.remaining)} of ${formatValue(capacity)} left at ${formatTime(projection.from.t)}` : 'no readings'}; resets ${formatTime(resetAt)}. ${verdict.text}`;

  const columns: TableColumn<BurnPoint>[] = [
    { key: 't', label: 'When', render: (p) => formatTime(p.t) },
    { key: 'r', label: 'Remaining', numeric: true, render: (p) => (p.remaining === null ? '—' : formatValue(p.remaining)) },
  ];

  const legendItems = [
    { label: 'Remaining', color: CHART_SEQUENTIAL, kind: 'line' as const },
    { label: 'Even pace', color: 'var(--text-tertiary)', kind: 'line' as const },
    ...(projectionPath ? [{ label: 'Projection', color: projectionColor, kind: 'line' as const }] : []),
  ];

  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={resolvedStatus}
      table={<TableView caption={title} columns={columns} rows={sorted} rowKey={(p) => String(p.t)} />}
      footer={
        <>
          <p className={plot.note} data-severity={verdict.severity} role="status">{verdict.text}</p>
          <ChartLegend items={legendItems} />
        </>
      }
    >
      <div ref={wrapRef} className={plot.plotWrap}>
        <svg className={plot.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
          {ticks.map((t) => (
            <g key={t}>
              <line className={plot.grid} x1={padL} x2={padL + plotW} y1={ys(t)} y2={ys(t)} />
              <text className={plot.tick} x={padL - 6} y={ys(t)} dy="0.32em" textAnchor="end">{formatValue(t)}</text>
            </g>
          ))}
          <line className={plot.axis} x1={padL} x2={padL + plotW} y1={ys(0)} y2={ys(0)} />
          <text className={plot.tick} x={padL} y={height - 8} textAnchor="start">{formatTime(start)}</text>
          <text className={plot.tick} x={padL + plotW} y={height - 8} textAnchor="end">Resets {formatTime(resetAt)}</text>

          <path data-role="pace" className={plot.reference} d={linePath([{ x: xs(start), y: ys(capacity) }, { x: xs(xEnd), y: ys(0) }])} />
          {reserve ? (
            <g data-role="reserve">
              <line className={plot.reference} x1={padL} x2={padL + plotW} y1={ys(reserve.value)} y2={ys(reserve.value)} />
              {/* Above-left of the line, over a surface halo (SPEC-310C §6): the
                  window's start is the one place the remaining line is always
                  high, and the projection only ever runs to the right, so the
                  label never sits on the data. */}
              <text data-role="reserve-label" className={`${plot.tick} ${plot.halo}`} x={padL + 4} y={ys(reserve.value) - 5} textAnchor="start">
                {reserve.label} · {formatValue(reserve.value)}
              </text>
            </g>
          ) : null}
          {now > start && now < xEnd ? (
            <line className={plot.crosshair} x1={xs(now)} x2={xs(now)} y1={PAD_T} y2={PAD_T + plotH} />
          ) : null}
          {runs.map((run, i) => (
            <g key={i} data-role="remaining">
              <path className={plot.wash} fill={CHART_SEQUENTIAL} d={areaPath(run, run.map((p) => ({ x: p.x, y: ys(0) })))} />
              <path className={plot.line} stroke={CHART_SEQUENTIAL} d={linePath(run)} />
            </g>
          ))}
          {projectionPath ? (
            <path data-role="projection" className={plot.projection} stroke={projectionColor} d={projectionPath} />
          ) : null}
          {projection.from ? (
            <circle className={plot.marker} cx={xs(clampX(projection.from.t))} cy={ys(projection.from.remaining)} r={4} fill={CHART_SEQUENTIAL} />
          ) : null}
        </svg>
      </div>
    </ChartFrame>
  );
}
