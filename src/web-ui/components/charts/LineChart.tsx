/**
 * components/charts/LineChart.tsx — trend over time. A gap (`null` y) is
 * split into a separate path segment so it renders as a visible break in
 * the line, never as a straight line through a missing value and never as
 * a silent zero. Single series gets an optional soft area fill; two-plus
 * series always render a legend (never color-matching alone).
 */
import { useRef, useState } from 'react';
import type { Series } from './types.js';
import { seriesColor, CHART_GRID, CHART_AXIS } from './colors.js';
import { Legend } from './Legend.js';
import {
  MIN_TIME_SPAN_MS,
  allIntegers,
  axisTicks,
  dodgeLabels,
  ensureSpan,
  isTimeAxis,
  layoutAxisLabels,
  xKeeper,
} from './chart-math.js';
import { timeLabelLadder } from './format.js';
import './chart-tokens.css';
import styles from './LineChart.module.css';

const VBOX_W = 640;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;
const TICKS_Y = 4;
/* Direct end-of-line labels need a gutter of their own. They are drawn in USER
   units — the viewBox scales the font along with the geometry, so a reserve
   measured in user units holds at every rendered width — and `--text-xs-size`
   resolves to 12 user units here, where the UI sans averages a shade over 6
   units per character at medium weight. 6.4 rounds that up so the reserve errs
   wide rather than clipping. Without the reserve the label was drawn at
   `VBOX_W - PAD_R + 4` with only PAD_R (12u) of room and the svg's own
   `overflow: hidden` cropped it to its first glyph — "Estimated spend"
   rendered as a lone "E". */
const END_LABEL_CH = 6.4;
const END_LABEL_GAP = 4;
/* Past this the gutter would cost more plot than the label is worth, so the
   label is dropped rather than shrinking the chart around it. Nothing is lost:
   Legend.tsx deliberately renders nothing below two series because the panel
   heading already names a lone series, and two-plus series always have the
   legend regardless. */
const END_LABEL_MAX = 150;
/** Line height of a direct end label (user units): two closer than this overlap. */
const END_LABEL_GAP_Y = 14;
/* The x-axis labels are 12 user units tall (see END_LABEL_CH); this is their
   estimated advance per character for collision checks. */
const AXIS_LABEL_CH = 12 * 0.6;

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
  ariaLabel,
}: {
  series: Series[];
  height?: number;
  area?: boolean;
  formatX?: (x: number) => string;
  formatY?: (y: number) => string;
  ariaLabel: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);

  const formatX = formatXProp ?? ((x: number) => String(x));
  const formatY = formatYProp ?? ((y: number) => String(y));
  /* On a time axis a 0 / NaN / pre-2000 x is a null timestamp that leaked
     through, not a moment: it would start the axis at "Dec 31" 1969. Such
     points are left out of the domain AND the drawing. */
  const keepX = xKeeper(seriesProp.flatMap((s) => s.points.map((p) => p.x)));
  const series = seriesProp.map((s) => ({ ...s, points: s.points.filter((p) => keepX(p.x)) }));
  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  const knownY = series.flatMap((s) => s.points.map((p) => p.y)).filter((y): y is number => y !== null && Number.isFinite(y));
  if (allX.length === 0) {
    return <p>No data.</p>;
  }
  const rawXMin = Math.min(...allX);
  const rawXMax = Math.max(...allX);
  const timeAxis = isTimeAxis(allX);
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

  /* Decided before the x scale, because the reserved gutter is what plotW is
     measured against — and the gridlines and x-axis stop at the same edge.
     End labels are dodged vertically so two lines ending on one value never
     print their names over each other; if they cannot all fit, the legend
     (always present for 2+ series) names them instead. */
  const wantEndLabels = series.length >= 1 && series.length <= 4;
  const endLabelW = wantEndLabels
    ? Math.max(...series.map((s) => s.label.length)) * END_LABEL_CH
    : 0;
  const endPoints = series.flatMap((s) => {
    for (let i = s.points.length - 1; i >= 0; i--) {
      const y = s.points[i]!.y;
      if (y !== null && Number.isFinite(y)) return [{ key: s.id, y: yScale(y) }];
    }
    return [];
  });
  const dodged = wantEndLabels && endLabelW <= END_LABEL_MAX ? dodgeLabels(endPoints, END_LABEL_GAP_Y, PAD_T, PAD_T + plotH) : null;
  const showEndLabels = dodged !== null && endPoints.length > 0;
  const padR = PAD_R + (showEndLabels ? END_LABEL_GAP + endLabelW : 0);
  const showLegend = series.length >= 2;

  const plotW = VBOX_W - PAD_L - padR;
  const xScale = (x: number) => PAD_L + ((x - xMin) / xRange) * plotW;

  // Nearest-x lookup across a reference axis (the union of all distinct x
  // values, since series may not share every point).
  const xAxis = Array.from(new Set(allX)).sort((a, b) => a - b);

  /* First and last x labels, collision-free: the end outranks the start;
     on a time axis both walk one detail ladder (the caller's format → a
     shorter date/time; clock time only inside one day) until they fit. */
  const xEnds = xAxis.length > 1 ? [xAxis[0]!, xAxis[xAxis.length - 1]!] : [];
  const ladder = timeAxis ? timeLabelLadder(rawXMin, rawXMax, formatXProp, xEnds) : [formatX];
  const xLabels = layoutAxisLabels(
    xEnds.map((x, i) => {
      const px = xScale(x);
      const edge = i === 0 ? px <= PAD_L + 0.5 : px >= VBOX_W - padR - 0.5;
      return {
        key: i === 0 ? 'start' : 'end',
        x: px,
        anchor: edge ? (i === 0 ? 'start' as const : 'end' as const) : 'middle' as const,
        priority: i === 0 ? 2 : 3,
        variants: ladder.map((f) => f(x)),
      };
    }),
    { min: PAD_L, max: VBOX_W - padR, charPx: AXIS_LABEL_CH },
  );

  function nearestX(clientX: number): number | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * VBOX_W;
    const dataX = xMin + ((svgX - PAD_L) / plotW) * xRange;
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

  function handleMove(e: React.PointerEvent<SVGSVGElement>) {
    const x = nearestX(e.clientX);
    if (x === null) return;
    setHoverX(x);
    const svg = svgRef.current;
    if (svg) {
      const rect = svg.getBoundingClientRect();
      const px = (xScale(x) / VBOX_W) * rect.width;
      setTooltipPos({ left: px, top: 0 });
    }
  }

  const hoverPoints =
    hoverX !== null
      ? series.map((s) => ({
          series: s,
          point: s.points.find((p) => p.x === hoverX) ?? null,
        }))
      : null;

  return (
    <div className={styles.wrap}>
      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={`0 0 ${VBOX_W} ${height}`}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverX(null)}
      >
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={VBOX_W - padR}
              y1={yScale(t)}
              y2={yScale(t)}
              className={styles.gridline}
              stroke={CHART_GRID}
            />
            <text x={PAD_L - 6} y={yScale(t)} dy="0.32em" textAnchor="end" className={styles.axisLabel}>
              {yAxis.labels[i]}
            </text>
          </g>
        ))}
        <line
          x1={PAD_L}
          x2={VBOX_W - padR}
          y1={height - PAD_B}
          y2={height - PAD_B}
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
              {area && series.length === 1
                ? runs.map((run, ri) => {
                    const d =
                      run.map((p, j) => `${j === 0 ? 'M' : 'L'}${xScale(p.x)},${yScale(p.y)}`).join(' ') +
                      ` L${xScale(run[run.length - 1].x)},${yScale(yMin)} L${xScale(run[0].x)},${yScale(yMin)} Z`;
                    return <path key={ri} d={d} fill={color} className={styles.area} />;
                  })
                : null}
              {runs.map((run, ri) => (
                <path
                  key={ri}
                  d={run.map((p, j) => `${j === 0 ? 'M' : 'L'}${xScale(p.x)},${yScale(p.y)}`).join(' ')}
                  stroke={color}
                  className={styles.line}
                />
              ))}
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
            x1={xScale(hoverX)}
            x2={xScale(hoverX)}
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
          x={PAD_L}
          y={PAD_T}
          width={plotW}
          height={plotH}
          className={styles.overlay}
          onFocus={() => setHoverX(xAxis[xAxis.length - 1] ?? null)}
        />
      </svg>
      {hoverPoints && tooltipPos ? (
        <div className={styles.tooltip} style={{ left: tooltipPos.left, top: tooltipPos.top }}>
          <div className={styles.tooltipDate}>{formatX(hoverX as number)}</div>
          {hoverPoints.map(({ series: s, point }, i) => (
            <div className={styles.tooltipRow} key={s.id}>
              <span className={styles.tooltipKey} style={{ background: seriesColor(i) }} aria-hidden="true" />
              {point && point.y !== null ? (
                <>
                  <span className={styles.tooltipValue}>{formatY(point.y)}</span>
                  {showLegend ? <span>{s.label}</span> : null}
                </>
              ) : (
                <span className={styles.tooltipGap}>no data{showLegend ? ` — ${s.label}` : ''}</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {showLegend ? (
        <Legend items={series.map((s, i) => ({ label: s.label, color: seriesColor(i), kind: 'line' }))} />
      ) : null}
    </div>
  );
}
