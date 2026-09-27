/**
 * components/charts/LineChart.tsx — trend over time. A gap (`null` y) is
 * split into a separate path segment so it renders as a visible break in
 * the line, never as a straight line through a missing value and never as
 * a silent zero. Single series gets an optional soft area fill; two-plus
 * series always render a legend (never color-matching alone).
 *
 * Sizing (after 3.11.3): the chart draws at its MEASURED pixel width and a fixed
 * pixel `height` — one user unit is one CSS pixel — like the V3.10 kit
 * (useChartWidth). It used to draw into a fixed 640-unit viewBox stretched
 * with `width: 100%; height: auto`, so on a 1900 px window the whole figure,
 * text included, scaled ~2.8×: 12 px tick labels rendered at ~34 px, the
 * 200 px chart stood ~560 px tall, and the end label ("Tokens in") dwarfed
 * the card. Now the coordinate system scales and the text never does.
 *
 * Polish (verse-visual-quality), matching the V3.10 kit's AreaTrend:
 *   - monotone curves through every reading (chart-math monotoneSegments:
 *     they never overshoot, so smoothing cannot invent a peak or a dip);
 *   - `area` fills a gradient of the series ink (up to three series, on one
 *     shared scale), not a flat 10% wash;
 *   - interior x ticks at the same density as the kit (~one per 84 px);
 *   - gridlines snapped to the pixel grid (crisp 1 px), tabular numerals;
 *   - the latest reading carries a ringed dot;
 *   - hover crosshair + the kit's ChartTooltip with EXACT values and the
 *     local day / instant; the plot is a keyboard stop too (arrow keys,
 *     Home/End) and announces each reading through a live region;
 *   - it draws itself in once on mount, unless reduced motion (motion.ts).
 */
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Series } from './types.js';
import { gradientId, seriesColor, CHART_GRID, CHART_AXIS } from './colors.js';
import { AreaGradient, ChartTooltip, clampTooltipLeft } from './ChartParts.js';
import { Legend } from './Legend.js';
import {
  MIN_TIME_SPAN_MS,
  allIntegers,
  axisTicks,
  crisp,
  dodgeLabels,
  ensureSpan,
  isTimeAxis,
  labelCharPx,
  layoutAxisLabels,
  smoothAreaPath,
  smoothPath,
  thinIndexes,
  xKeeper,
} from './chart-math.js';
import { formatExact, formatTimeLabel, timeLabelLadder, tooltipTimeFormatter } from './format.js';
import { useChartMotion } from './motion.js';
import { useChartWidth } from './useChartWidth.js';
import { useTextScale } from './useTextScale.js';
import './chart-tokens.css';
import styles from './LineChart.module.css';
import plot from './plot.module.css';

/** Width drawn at before the container is measured (jsdom, first paint). */
const FALLBACK_W = 640;
/** Minimum left gutter; it widens when the y tick labels need more (see padL). */
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;
const TICKS_Y = 4;
/* Direct end-of-line labels need a gutter of their own. User units are CSS
   pixels here (the viewBox matches the measured width), and `--text-xs-size`
   is 12 px, where the UI sans averages a shade over 6 px per character at
   medium weight. 6.4 rounds that up so the reserve errs
   wide rather than clipping. Without the reserve the label was drawn at
   `width - PAD_R + 4` with only PAD_R (12 px) of room and the svg's own
   `overflow: hidden` cropped it to its first glyph — "Estimated spend"
   rendered as a lone "E".
   Every text measure here (END_LABEL_CH, END_LABEL_GAP_Y, the axis label
   advance) is for 12 px text and is multiplied by the operator's Display
   size (useTextScale): --text-xs-size is 12px × --ui-text-scale, so at
   XLarge the same label is 15 units tall and 25% wider. END_LABEL_MAX is a
   budget of plot width, not a text measure, and stays as it is. */
const END_LABEL_CH = 6.4;
const END_LABEL_GAP = 4;
/* Past this the gutter would cost more plot than the label is worth, so the
   label is dropped rather than shrinking the chart around it. Nothing is lost:
   Legend.tsx deliberately renders nothing below two series because the panel
   heading already names a lone series, and two-plus series always have the
   legend regardless. */
const END_LABEL_MAX = 150;
/** Line height of a direct end label at 12 px (user units): two closer than this overlap. */
const END_LABEL_GAP_Y = 14;

interface Run {
  x: number;
  y: number;
}

function splitRuns(points: Series['points']): Run[][] {
  const runs: Run[][] = [];
  let current: Run[] = [];
  for (const p of points) {
    if (p.y === null) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    current.push({ x: p.x, y: p.y });
  }
  if (current.length) runs.push(current);
  return runs;
}

export function LineChart({
  series: seriesProp,
  height = 200,
  area = false,
  formatX: formatXProp,
  formatY: formatYProp,
  formatTooltip: formatTooltipProp,
  formatTooltipX: formatTooltipXProp,
  ariaLabel,
  width: fixedWidth,
}: {
  series: Series[];
  /** Plot height in px, including the x-axis band. Fixed at every width. */
  height?: number;
  /** Fixed width in px (tests, print). Omit to fill the container. */
  width?: number;
  /** A gradient wash under each line (up to three series). */
  area?: boolean;
  formatX?: (x: number) => string;
  formatY?: (y: number) => string;
  /** Tooltip value format. Default: `formatY` when given, else formatExact ("12,934", not "13K"). */
  formatTooltip?: (y: number) => string;
  /** Tooltip title format. Default: `formatX` when given, else the local day / instant on a time axis. */
  formatTooltipX?: (x: number) => string;
  ariaLabel: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth, FALLBACK_W);
  const textScale = useTextScale();
  const motion = useChartMotion();
  const gradKey = useId();
  const liveId = useId();
  /* Axis labels' estimated advance per character, at the size they render. */
  const axisLabelCh = labelCharPx(textScale);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const formatTip = formatTooltipProp ?? formatYProp ?? formatExact;
  /* On a time axis a 0 / NaN / pre-2000 x is a null timestamp that leaked
     through, not a moment: it would start the axis at "Dec 31" 1969. Such
     points are left out of the domain AND the drawing. */
  const keepX = xKeeper(seriesProp.flatMap((s) => s.points.map((p) => p.x)));
  const series = seriesProp.map((s) => ({ ...s, points: s.points.filter((p) => keepX(p.x)) }));
  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  const knownY = series.flatMap((s) => s.points.map((p) => p.y)).filter((y): y is number => y !== null && Number.isFinite(y));
  if (allX.length === 0) {
    return (
      <div ref={wrapRef} className={styles.wrap}>
        <p>No data.</p>
      </div>
    );
  }
  const rawXMin = Math.min(...allX);
  const rawXMax = Math.max(...allX);
  const timeAxis = isTimeAxis(allX);
  // An epoch-ms x printed with String() read "1758960000000" in the tooltip.
  const formatX = formatXProp ?? (timeAxis ? formatTimeLabel : (x: number) => String(x));
  const formatTipX = formatTooltipXProp ?? formatXProp ?? (timeAxis ? tooltipTimeFormatter(allX) : formatX);
  // A burst of points seconds apart is widened to MIN_TIME_SPAN_MS around
  // itself instead of stretched edge to edge under identical labels.
  const [xMin, xMax] = timeAxis && rawXMax > rawXMin ? ensureSpan(rawXMin, rawXMax, MIN_TIME_SPAN_MS) : [rawXMin, rawXMax];
  const xRange = xMax - xMin || 1;

  // Nice ticks whose labels are exact: integer data get integer ticks, and a
  // caller's formatter never prints a rounded label on a precise tick.
  const yAxis = axisTicks(Math.min(0, ...knownY), Math.max(0, ...knownY), {
    count: TICKS_Y,
    integer: knownY.length > 0 && allIntegers(knownY),
    format: formatYProp,
  });
  const yTicks = yAxis.ticks;
  const yMin = yTicks[0]!;
  const yMax = yTicks[yTicks.length - 1]!;
  const yRange = yMax - yMin || 1;
  const plotH = height - PAD_T - PAD_B;
  const yScale = (y: number) => PAD_T + plotH - ((y - yMin) / yRange) * plotH;
  /* The y labels hang right-aligned 6 units left of the plot, and the svg
     clips at its edge: the gutter grows to fit the widest one (+2 of air) —
     44 still fits five 12 px characters, a larger Display size fewer. */
  const padL = Math.max(PAD_L, Math.ceil(Math.max(0, ...yAxis.labels.map((l) => l.length)) * axisLabelCh) + 8);

  /* Decided before the x scale, because the reserved gutter is what plotW is
     measured against — and the gridlines and x-axis stop at the same edge.
     End labels are dodged vertically so two lines ending on one value never
     print their names over each other; if they cannot all fit, the legend
     (always present for 2+ series) names them instead. */
  const wantEndLabels = series.length >= 1 && series.length <= 4;
  const endLabelW = wantEndLabels
    ? Math.max(...series.map((s) => s.label.length)) * END_LABEL_CH * textScale
    : 0;
  const endPoints = series.flatMap((s) => {
    for (let i = s.points.length - 1; i >= 0; i--) {
      const y = s.points[i]!.y;
      if (y !== null && Number.isFinite(y)) return [{ key: s.id, y: yScale(y) }];
    }
    return [];
  });
  const dodged = wantEndLabels && endLabelW <= END_LABEL_MAX ? dodgeLabels(endPoints, END_LABEL_GAP_Y * textScale, PAD_T, PAD_T + plotH) : null;
  const showEndLabels = dodged !== null && endPoints.length > 0;
  const padR = PAD_R + (showEndLabels ? END_LABEL_GAP + endLabelW : 0);
  const showLegend = series.length >= 2;

  const plotW = Math.max(40, width - padL - padR);
  const xScale = (x: number) => padL + ((x - xMin) / xRange) * plotW;

  // Nearest-x lookup across a reference axis (the union of all distinct x
  // values, since series may not share every point).
  const xAxis = Array.from(new Set(allX)).sort((a, b) => a - b);

  /* X labels, collision-free, at the kit's density (about one per 84 px —
     the same as AreaTrend, so sibling cards read alike): the end outranks
     the start and both outrank the interior ticks, which are simply dropped
     when they collide. On a time axis every label walks one detail ladder
     (the caller's format → a shorter date/time; clock time only inside one
     day) until the ends fit. */
  const tickIdx = xAxis.length > 1 ? thinIndexes(xAxis.length, Math.max(2, Math.floor(plotW / 84))) : [];
  const ladder = timeAxis ? timeLabelLadder(rawXMin, rawXMax, formatXProp, tickIdx.map((i) => xAxis[i]!)) : [formatX];
  const xLabels = layoutAxisLabels(
    tickIdx.map((idx, n) => {
      const x = xAxis[idx]!;
      const px = xScale(x);
      const isFirst = n === 0;
      const isLast = n === tickIdx.length - 1;
      const anchor = isFirst && px <= padL + 0.5 ? 'start' as const : isLast && px >= width - padR - 0.5 ? 'end' as const : 'middle' as const;
      return {
        key: isFirst ? 'start' : isLast ? 'end' : `t${idx}`,
        x: px,
        anchor,
        priority: isLast ? 3 : isFirst ? 2 : 1,
        required: isFirst || isLast,
        variants: ladder.map((f) => f(x)),
      };
    }),
    { min: padL, max: width - padR, charPx: axisLabelCh },
  );

  function nearestX(clientX: number): number | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    // rect.width equals `width` once measured; the ratio only matters while the
    // fallback width is still being drawn (or a CSS max-width squeezes it).
    const svgX = ((clientX - rect.left) / (rect.width || width)) * width;
    const dataX = xMin + ((svgX - padL) / plotW) * xRange;
    let nearest = xAxis[0];
    let best = Infinity;
    for (const x of xAxis) {
      const d = Math.abs(x - dataX);
      if (d < best) {
        best = d;
        nearest = x;
      }
    }
    return nearest;
  }

  function handleMove(e: PointerEvent<SVGSVGElement>) {
    const x = nearestX(e.clientX);
    if (x === null) return;
    setHoverX(x);
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (xAxis.length === 0) return;
    const cur = hoverX === null ? xAxis.length - 1 : Math.max(0, xAxis.indexOf(hoverX));
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? xAxis.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setHoverX(xAxis[Math.max(0, Math.min(xAxis.length - 1, next))]!);
  }

  const areaOn = area && series.length <= 3;

  const hoverPoints =
    hoverX !== null
      ? series.map((s) => ({
          series: s,
          point: s.points.find((p) => p.x === hoverX) ?? null,
        }))
      : null;

  return (
    <div
      ref={wrapRef}
      className={`${styles.wrap} ${plot.focusable}`}
      data-motion={motion}
      tabIndex={0}
      role="group"
      aria-label={`${ariaLabel}. Use the left and right arrow keys to read values.`}
      aria-describedby={liveId}
      onFocus={() => setHoverX((h) => h ?? xAxis[xAxis.length - 1] ?? null)}
      onBlur={() => setHoverX(null)}
      onKeyDown={onKey}
    >
      <svg
        ref={svgRef}
        className={styles.svg}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverX(null)}
      >
        {areaOn ? (
          <defs>
            {series.map((s, si) => (
              <AreaGradient key={s.id} id={gradientId(gradKey, s.id)} color={seriesColor(si)} top={PAD_T} bottom={height - PAD_B} from={series.length > 1 ? 0.16 : 0.22} />
            ))}
          </defs>
        ) : null}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={padL}
              x2={width - padR}
              y1={crisp(yScale(t))}
              y2={crisp(yScale(t))}
              className={styles.gridline}
              stroke={CHART_GRID}
            />
            <text x={padL - 6} y={yScale(t)} dy="0.32em" textAnchor="end" className={styles.axisLabel}>
              {yAxis.labels[i]}
            </text>
          </g>
        ))}
        <line
          x1={padL}
          x2={width - padR}
          y1={crisp(height - PAD_B)}
          y2={crisp(height - PAD_B)}
          className={styles.axis}
          stroke={CHART_AXIS}
        />
        {xLabels.map((l) => (
          <text key={l.key} data-axis-label={l.key} x={l.x} y={height - 6} textAnchor={l.anchor} className={styles.axisLabel}>
            {l.text}
          </text>
        ))}

        {series.map((s, si) => {
          const color = seriesColor(si);
          const runs = splitRuns(s.points);
          return (
            <g key={s.id}>
              {areaOn
                ? runs.map((run, ri) => {
                    const top = run.map((p) => ({ x: xScale(p.x), y: yScale(p.y) }));
                    const base = top.map((p) => ({ x: p.x, y: yScale(Math.max(yMin, 0)) }));
                    return (
                      <path
                        key={ri}
                        data-role="area"
                        d={smoothAreaPath(top, base)}
                        fill={`url(#${gradientId(gradKey, s.id)})`}
                        className={`${styles.area} ${plot.fadeIn}`}
                      />
                    );
                  })
                : null}
              {runs.map((run, ri) =>
                run.length === 1 ? (
                  <circle key={ri} cx={xScale(run[0].x)} cy={yScale(run[0].y)} r={3} fill={color} />
                ) : (
                  <path
                    key={ri}
                    data-role="line"
                    d={smoothPath(run.map((p) => ({ x: xScale(p.x), y: yScale(p.y) })))}
                    pathLength={1}
                    stroke={color}
                    className={`${styles.line} ${plot.draw}`}
                  />
                ),
              )}
              {hoverX === null && runs.length && runs[runs.length - 1].length > 1 ? (() => {
                // The latest reading, ringed — the "you are here" of a trend.
                const lastRun = runs[runs.length - 1];
                const last = lastRun[lastRun.length - 1];
                return <circle data-role="end-dot" className={`${plot.endDot} ${plot.fadeIn}`} cx={xScale(last.x)} cy={yScale(last.y)} r={3.5} fill={color} />;
              })() : null}
              {showEndLabels && runs.length ? (
                (() => {
                  const lastRun = runs[runs.length - 1];
                  const last = lastRun[lastRun.length - 1];
                  return (
                    <text
                      data-end-label={s.id}
                      x={xScale(last.x) + END_LABEL_GAP}
                      y={dodged?.get(s.id) ?? yScale(last.y)}
                      dy="0.32em"
                      className={styles.endLabel}
                      fill={color}
                    >
                      {s.label}
                    </text>
                  );
                })()
              ) : null}
            </g>
          );
        })}

        {hoverX !== null ? (
          <line
            data-role="crosshair"
            x1={crisp(xScale(hoverX))}
            x2={crisp(xScale(hoverX))}
            y1={PAD_T}
            y2={height - PAD_B}
            className={styles.crosshairLine}
          />
        ) : null}
        {hoverX !== null
          ? series.map((s, si) => {
              const p = s.points.find((pt) => pt.x === hoverX);
              if (!p || p.y === null) return null;
              return (
                <circle
                  key={s.id}
                  cx={xScale(p.x)}
                  cy={yScale(p.y)}
                  r={4}
                  fill={seriesColor(si)}
                  className={styles.marker}
                />
              );
            })
          : null}

        <rect
          x={padL}
          y={PAD_T}
          width={plotW}
          height={plotH}
          className={styles.overlay}
        />
      </svg>
      <span id={liveId} className={plot.srOnly} aria-live="polite">
        {hoverPoints
          ? `${formatTipX(hoverX as number)}: ${hoverPoints.map(({ series: s, point }) => `${s.label} ${point && point.y !== null ? formatTip(point.y) : 'no data'}`).join(', ')}`
          : ''}
      </span>
      {hoverPoints && hoverX !== null ? (
        <ChartTooltip
          left={clampTooltipLeft(xScale(hoverX), width)}
          top={PAD_T}
          title={formatTipX(hoverX)}
          rows={hoverPoints.map(({ series: s, point }, i) => ({
            key: s.id,
            label: s.label,
            value: point && point.y !== null ? formatTip(point.y) : null,
            color: seriesColor(i),
            kind: 'line' as const,
          }))}
        />
      ) : null}
      {showLegend ? (
        <Legend items={series.map((s, i) => ({ label: s.label, color: seriesColor(i), kind: 'line' }))} />
      ) : null}
    </div>
  );
}
