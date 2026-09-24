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
 * rather than drawing a guess — and with no plausible reset (0 / NaN /
 * pre-2000) it draws neither pace nor projection and says the reset is
 * unknown, rather than projecting to an invented one.
 */
import { useRef } from 'react';
import { CHART_SEQUENTIAL, toneColor } from './colors.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { ChartLegend } from './ChartParts.js';
import { TableView, type TableColumn } from './TableView.js';
import {
  MIN_TIME_SPAN_MS,
  areaPath,
  axisTicks,
  ensureSpan,
  isPlausibleTime,
  labelCharPx,
  layoutAxisLabels,
  linePath,
  linearScale,
  projectBurnDown,
  splitRuns,
  tickGutter,
  type BurnPoint,
} from './chart-math.js';
import { formatCompact, timeLabelLadder } from './format.js';
import { useChartWidth } from './useChartWidth.js';
import { useTextScale } from './useTextScale.js';
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

/**
 * The verdict in words. `resetAt` null (or non-finite) is an UNKNOWN reset:
 * what the window has already crossed is still said, but nothing is
 * projected — "about 40% left at reset" needs a reset (V3.10.1 review: an
 * epoch-0 reset printed a green verdict for a seat burning 10%/h, and a NaN
 * one printed "about NaN% left at reset").
 */
export function burnVerdict(
  projection: ReturnType<typeof projectBurnDown>,
  resetAt: number | null,
  formatValue: (v: number) => string,
  formatTime: (ms: number) => string,
  reserveLabel?: string,
): { text: string; severity: 'ok' | 'warn' | 'danger' | 'unknown' } {
  const reset = resetAt !== null && Number.isFinite(resetAt) ? resetAt : null;
  // Already past a line: say where it IS, not a "projection" to a moment
  // that has passed (a used-up seat is not "running out at 3:02").
  if (projection.from && projection.from.remaining <= 0) {
    return { text: reset === null ? 'Used up — reset time unknown.' : `Used up — resets ${formatTime(reset)}.`, severity: 'danger' };
  }
  if (projection.from && reserveLabel !== undefined && projection.reserveAt !== null && projection.reserveAt <= projection.from.t) {
    const until = reset === null ? 'until it resets (reset time unknown)' : `until ${formatTime(reset)}`;
    return { text: `Inside ${reserveLabel.toLowerCase()} — autonomy has stopped using this window ${until}.`, severity: 'warn' };
  }
  if (reset === null) return { text: 'Reset time unknown — not projecting this window.', severity: 'unknown' };
  if (projection.slopePerMs === null) return { text: 'Not enough readings to project this window yet.', severity: 'unknown' };
  if (projection.exhaustAt !== null) {
    return {
      text: `At this pace: runs out ${formatTime(projection.exhaustAt)}, ${formatLead(reset - projection.exhaustAt)} before reset.`,
      severity: 'danger',
    };
  }
  if (projection.reserveAt !== null) {
    return {
      text: `At this pace: ${reserveLabel ?? 'reserve'} reached ${formatTime(projection.reserveAt)}, ${formatLead(reset - projection.reserveAt)} before reset.`,
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
  formatValue: formatValueProp,
  formatTime: formatTimeProp,
  ariaLabel,
}: BurnDownProps) {
  const formatValue = formatValueProp ?? formatCompact;
  const formatTime = formatTimeProp ?? defaultFormatTime;
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const textScale = useTextScale();
  // A reading stamped 0 / NaN / pre-2000 is a null timestamp that leaked
  // through: it is not on this window's time axis, and it would drag both
  // the axis and the projection's slope back to 1970.
  const sorted = points.filter((p) => isPlausibleTime(p.t)).sort((a, b) => a.t - b.t);
  const anyKnown = sorted.some((p) => p.remaining !== null);
  const resolvedStatus: ChartStatus = status ?? (sorted.length === 0 ? { kind: 'empty', message: 'No readings in this window yet.' } : anyKnown ? { kind: 'ready' } : { kind: 'unknown' });

  // A reset of 0 / NaN / pre-2000 is a null that leaked through (an epoch-0
  // machine reset parses as a finite 0). It is UNKNOWN, not a moment: the
  // axis ends at the latest reading or now with no "Resets" on it, no even
  // pace or projection is drawn toward it, and the verdict says the reset is
  // unknown instead of inventing one (V3.10.1 review).
  const resetKnown = isPlausibleTime(resetAt);
  const reset = resetKnown ? resetAt : null;
  const projection = projectBurnDown(sorted, reset, { reserve: reserve?.value ?? null });
  const verdict = burnVerdict(projection, reset, formatValue, formatTime, reserve?.label);

  // Always 0 → capacity (100 for percent seats), so sibling cards share one
  // scale; widened only if a reading overshoots, never clipped.
  const known = sorted.flatMap((p) => (p.remaining !== null && Number.isFinite(p.remaining) ? [p.remaining] : []));
  const yAxis = axisTicks(0, Math.max(capacity, ...known, 1), {
    count: 4,
    integer: Number.isInteger(capacity) && known.every((v) => Number.isInteger(v)),
    format: formatValueProp,
  });
  const ticks = yAxis.ticks;
  const top = ticks[ticks.length - 1]!;
  const padL = tickGutter(yAxis.labels, 28, 56, textScale);
  const plotW = Math.max(40, width - padL - PAD_R);
  const plotH = height - PAD_T - PAD_B;
  // The window runs start → reset. An implausible bound (0 / NaN) falls back
  // to the readings; a degenerate one widens to MIN_TIME_SPAN_MS, keeping the
  // right edge where it is.
  const lastT = sorted.length ? sorted[sorted.length - 1]!.t : now;
  const rawEnd = reset ?? Math.max(now, lastT);
  const rawStart = isPlausibleTime(start) ? start : sorted[0]?.t ?? rawEnd;
  const [x0, xEnd] = ensureSpan(rawStart, rawEnd, MIN_TIME_SPAN_MS, 'end');
  const xs = linearScale(x0, xEnd, padL, padL + plotW);
  const ys = linearScale(0, top, PAD_T + plotH, PAD_T);
  const clampX = (t: number) => Math.min(xEnd, Math.max(x0, t));

  // x labels: the reset marker outranks the window start. Both walk the same
  // detail ladder (the caller's format → "Fri 11:46 PM" → "Sep 18"; clock
  // time only inside one day) until they fit side by side; if even the
  // shortest pair collides, the start is dropped rather than overprinted.
  // Widths are budgeted at the operator's Display size. With no known reset
  // the right edge is only the latest reading / now, and says just its time.
  const ladder = timeLabelLadder(x0, xEnd, formatTimeProp ?? defaultFormatTime, [x0, xEnd]);
  const xLabels = layoutAxisLabels(
    [
      { key: 'start', x: padL, anchor: 'start', priority: 2, variants: ladder.map((f) => f(x0)) },
      resetKnown
        ? { key: 'reset', x: padL + plotW, anchor: 'end', priority: 3, variants: ladder.map((f) => `Resets ${f(xEnd)}`) }
        : { key: 'end', x: padL + plotW, anchor: 'end', priority: 3, variants: ladder.map((f) => f(xEnd)) },
    ],
    { min: padL, max: padL + plotW, charPx: labelCharPx(textScale) },
  );

  const runs = splitRuns(sorted.map((p) => ({ x: clampX(p.t), y: p.remaining })))
    .map((run) => run.map((p) => ({ x: xs(p.x), y: ys(Math.max(0, p.y)) })));

  let projectionPath = '';
  if (reset !== null && projection.from && projection.slopePerMs !== null) {
    const endT = projection.exhaustAt ?? reset;
    const endR = projection.exhaustAt !== null ? 0 : projection.remainingAtReset ?? projection.from.remaining;
    if (endT > projection.from.t) {
      projectionPath = linePath([
        { x: xs(clampX(projection.from.t)), y: ys(projection.from.remaining) },
        { x: xs(clampX(endT)), y: ys(Math.max(0, endR)) },
      ]);
    }
  }
  const projectionColor = verdict.severity === 'danger' ? toneColor('danger') : verdict.severity === 'warn' ? toneColor('warning') : 'var(--text-tertiary)';

  const summary = ariaLabel ?? `${title}: ${projection.from ? `${formatValue(projection.from.remaining)} of ${formatValue(capacity)} left at ${formatTime(projection.from.t)}` : 'no readings'}; ${reset === null ? 'reset time unknown' : `resets ${formatTime(reset)}`}. ${verdict.text}`;

  const columns: TableColumn<BurnPoint>[] = [
    { key: 't', label: 'When', render: (p) => formatTime(p.t) },
    { key: 'r', label: 'Remaining', numeric: true, render: (p) => (p.remaining === null ? '—' : formatValue(p.remaining)) },
  ];

  const legendItems = [
    { label: 'Remaining', color: CHART_SEQUENTIAL, kind: 'line' as const },
    // Even pace runs from full at the window's start to empty AT RESET: with
    // no reset there is no pace to draw.
    ...(resetKnown ? [{ label: 'Even pace', color: 'var(--text-tertiary)', kind: 'line' as const }] : []),
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
          {ticks.map((t, i) => (
            <g key={t}>
              <line className={plot.grid} x1={padL} x2={padL + plotW} y1={ys(t)} y2={ys(t)} />
              <text className={plot.tick} x={padL - 6} y={ys(t)} dy="0.32em" textAnchor="end">{yAxis.labels[i]}</text>
            </g>
          ))}
          <line className={plot.axis} x1={padL} x2={padL + plotW} y1={ys(0)} y2={ys(0)} />
          {xLabels.map((l) => (
            <text key={l.key} data-axis-label={l.key} className={plot.tick} x={l.x} y={height - 8} textAnchor={l.anchor}>{l.text}</text>
          ))}

          {resetKnown ? (
            <path data-role="pace" className={plot.reference} d={linePath([{ x: xs(x0), y: ys(capacity) }, { x: xs(xEnd), y: ys(0) }])} />
          ) : null}
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
          {now > x0 && now < xEnd ? (
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
