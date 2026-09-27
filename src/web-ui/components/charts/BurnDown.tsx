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
 *
 * Polish (verse-visual-quality): the reserve is a BAND from empty up to the
 * reserve line (the region autonomy stays out of), the remaining line is a
 * monotone curve over a gradient wash, "now" is a labelled dashed rule, and
 * the plot is hoverable and a keyboard stop — the crosshair snaps to each
 * reading and the tooltip gives its local time, the exact remaining and,
 * with a known reset, where even pace would have it.
 */
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CHART_SEQUENTIAL, gradientId, toneColor } from './colors.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { AreaGradient, ChartLegend, ChartTooltip, clampTooltipLeft, tooltipSide } from './ChartParts.js';
import { TableView, type TableColumn } from './TableView.js';
import {
  MIN_TIME_SPAN_MS,
  axisTicks,
  crisp,
  ensureSpan,
  isPlausibleTime,
  labelCharPx,
  layoutAxisLabels,
  linePath,
  linearScale,
  projectBurnDown,
  smoothAreaPath,
  smoothPath,
  splitRuns,
  tickGutter,
  type BurnPoint,
} from './chart-math.js';
import { formatCompact, formatTooltipInstant, timeLabelLadder } from './format.js';
import { useChartMotion } from './motion.js';
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
  const motion = useChartMotion();
  const gradKey = useId();
  const liveId = useId();
  const [active, setActive] = useState<number | null>(null);
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

  // Where even pace would have the window at `t`: full at the start, empty
  // at the reset — the same straight reference the dashed line draws.
  const paceAt = (t: number): number | null =>
    resetKnown && xEnd > x0 ? Math.max(0, Math.min(capacity, capacity * (1 - (t - x0) / (xEnd - x0)))) : null;

  function indexAt(clientX: number): number | null {
    const el = wrapRef.current;
    if (!el || sorted.length === 0) return null;
    const px = clientX - el.getBoundingClientRect().left;
    let best = 0;
    let bestD = Infinity;
    sorted.forEach((p, i) => {
      const d = Math.abs(xs(clampX(p.t)) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (sorted.length === 0) return;
    const cur = active ?? sorted.length - 1;
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? sorted.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(sorted.length - 1, next)));
  }

  const activePoint = active !== null ? sorted[active] : undefined;
  const activePace = activePoint ? paceAt(activePoint.t) : null;
  const nowX = now > x0 && now < xEnd ? xs(now) : null;
  // "Now" is labelled only where it cannot collide with the plot's edges.
  const nowLabel = nowX !== null && nowX - padL > 24 && padL + plotW - nowX > 24;

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
      skeleton="line"
      skeletonHeight={height}
      table={<TableView caption={title} columns={columns} rows={sorted} rowKey={(p) => String(p.t)} />}
      footer={
        <>
          <p className={plot.note} data-severity={verdict.severity} role="status">{verdict.text}</p>
          <ChartLegend items={legendItems} />
        </>
      }
    >
      <div
        ref={wrapRef}
        className={`${plot.plotWrap} ${plot.focusable}`}
        data-motion={motion}
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the left and right arrow keys to read each reading.`}
        aria-describedby={liveId}
        onFocus={() => setActive((a) => a ?? (sorted.length ? sorted.length - 1 : null))}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        <svg
          className={plot.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={summary}
          onPointerMove={(e: PointerEvent<SVGSVGElement>) => setActive(indexAt(e.clientX))}
          onPointerLeave={() => setActive(null)}
        >
          <defs>
            <AreaGradient id={gradientId(gradKey, 'remaining')} color={CHART_SEQUENTIAL} top={PAD_T} bottom={PAD_T + plotH} />
          </defs>
          {reserve && reserve.value > 0 ? (
            <rect
              data-role="reserve-band"
              className={`${plot.reserveBand} ${plot.fadeIn}`}
              x={padL}
              y={ys(Math.min(top, reserve.value))}
              width={plotW}
              height={Math.max(0, ys(0) - ys(Math.min(top, reserve.value)))}
            />
          ) : null}
          {ticks.map((t, i) => (
            <g key={t}>
              <line className={plot.grid} x1={padL} x2={padL + plotW} y1={crisp(ys(t))} y2={crisp(ys(t))} />
              <text className={plot.tick} x={padL - 6} y={ys(t)} dy="0.32em" textAnchor="end">{yAxis.labels[i]}</text>
            </g>
          ))}
          <line className={plot.axis} x1={padL} x2={padL + plotW} y1={crisp(ys(0))} y2={crisp(ys(0))} />
          {xLabels.map((l) => (
            <text key={l.key} data-axis-label={l.key} className={plot.tick} x={l.x} y={height - 8} textAnchor={l.anchor}>{l.text}</text>
          ))}

          {resetKnown ? (
            <path data-role="pace" className={plot.reference} d={linePath([{ x: xs(x0), y: ys(capacity) }, { x: xs(xEnd), y: ys(0) }])} />
          ) : null}
          {reserve ? (
            <g data-role="reserve">
              <line className={plot.reference} x1={padL} x2={padL + plotW} y1={crisp(ys(reserve.value))} y2={crisp(ys(reserve.value))} />
              {/* Above-left of the line, over a surface halo (SPEC-310C §6): the
                  window's start is the one place the remaining line is always
                  high, and the projection only ever runs to the right, so the
                  label never sits on the data. */}
              <text data-role="reserve-label" className={`${plot.tick} ${plot.halo}`} x={padL + 4} y={ys(reserve.value) - 5} textAnchor="start">
                {reserve.label} · {formatValue(reserve.value)}
              </text>
            </g>
          ) : null}
          {nowX !== null ? (
            <g data-role="now">
              <line className={plot.now} x1={crisp(nowX)} x2={crisp(nowX)} y1={PAD_T} y2={PAD_T + plotH} />
              {nowLabel ? (
                <text data-role="now-label" className={`${plot.tick} ${plot.halo}`} x={nowX} y={PAD_T - 4} textAnchor="middle">Now</text>
              ) : null}
            </g>
          ) : null}
          {runs.map((run, i) => (
            <g key={i} data-role="remaining">
              <path
                data-role="area"
                className={`${plot.area} ${plot.fadeIn}`}
                fill={`url(#${gradientId(gradKey, 'remaining')})`}
                d={smoothAreaPath(run, run.map((p) => ({ x: p.x, y: ys(0) })))}
              />
              {run.length > 1 ? (
                <path data-role="line" className={`${plot.line} ${plot.draw}`} pathLength={1} stroke={CHART_SEQUENTIAL} d={smoothPath(run)} />
              ) : null}
            </g>
          ))}
          {projectionPath ? (
            <path data-role="projection" className={plot.projection} stroke={projectionColor} d={projectionPath} />
          ) : null}
          {projection.from ? (
            <circle className={plot.marker} cx={xs(clampX(projection.from.t))} cy={ys(projection.from.remaining)} r={4} fill={CHART_SEQUENTIAL} />
          ) : null}
          {activePoint ? (
            <g data-role="hover">
              <line className={plot.crosshair} data-role="crosshair" x1={crisp(xs(clampX(activePoint.t)))} x2={crisp(xs(clampX(activePoint.t)))} y1={PAD_T} y2={PAD_T + plotH} />
              {activePoint.remaining !== null ? (
                <circle className={plot.marker} cx={xs(clampX(activePoint.t))} cy={ys(Math.max(0, activePoint.remaining))} r={4} fill={CHART_SEQUENTIAL} />
              ) : null}
            </g>
          ) : null}
        </svg>
        <span id={liveId} className={plot.srOnly} aria-live="polite">
          {activePoint
            ? `${formatTooltipInstant(activePoint.t)}: ${activePoint.remaining === null ? 'no reading' : `${formatValue(activePoint.remaining)} remaining`}` +
              (activePace !== null ? `; even pace ${formatValue(activePace)}` : '')
            : ''}
        </span>
        {activePoint ? (
          <ChartTooltip
            left={tooltipSide(xs(clampX(activePoint.t)), width) ? xs(clampX(activePoint.t)) : clampTooltipLeft(xs(clampX(activePoint.t)), width)}
            side={tooltipSide(xs(clampX(activePoint.t)), width)}
            top={PAD_T}
            title={formatTooltipInstant(activePoint.t)}
            rows={[
              { key: 'r', label: 'Remaining', value: activePoint.remaining === null ? null : formatValue(activePoint.remaining), color: CHART_SEQUENTIAL, kind: 'line' },
              ...(activePace !== null ? [{ key: 'p', label: 'Even pace', value: formatValue(activePace), color: 'var(--text-tertiary)', kind: 'line' as const }] : []),
            ]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
