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
import './chart-tokens.css';
import styles from './LineChart.module.css';

const VBOX_W = 640;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;
const TICKS_Y = 4;

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

function niceTicks(min: number, max: number, count: number): number[] {
  if (max <= min) return [min];
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => min + step * i);
}

export function LineChart({
  series,
  height = 200,
  area = false,
  formatX = (x: number) => String(x),
  formatY = (y: number) => String(y),
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

  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  const knownY = series.flatMap((s) => s.points.map((p) => p.y)).filter((y): y is number => y !== null);
  if (allX.length === 0) {
    return <p>No data.</p>;
  }
  const xMin = Math.min(...allX);
  const xMax = Math.max(...allX);
  const yMin = Math.min(0, ...knownY);
  const yMax = Math.max(0.0001, ...knownY);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const plotW = VBOX_W - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;
  const xScale = (x: number) => PAD_L + ((x - xMin) / xRange) * plotW;
  const yScale = (y: number) => PAD_T + plotH - ((y - yMin) / yRange) * plotH;

  const yTicks = niceTicks(yMin, yMax, TICKS_Y);

  // Nearest-x lookup across a reference axis (the union of all distinct x
  // values, since series may not share every point).
  const xAxis = Array.from(new Set(allX)).sort((a, b) => a - b);

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

  const showLegend = series.length >= 2;
  const showEndLabels = series.length >= 1 && series.length <= 4;

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
              x2={VBOX_W - PAD_R}
              y1={yScale(t)}
              y2={yScale(t)}
              className={styles.gridline}
              stroke={CHART_GRID}
            />
            <text x={PAD_L - 6} y={yScale(t)} dy="0.32em" textAnchor="end" className={styles.axisLabel}>
              {formatY(t)}
            </text>
          </g>
        ))}
        <line
          x1={PAD_L}
          x2={VBOX_W - PAD_R}
          y1={height - PAD_B}
          y2={height - PAD_B}
          className={styles.axis}
          stroke={CHART_AXIS}
        />
        {xAxis.length > 1
          ? [xAxis[0], xAxis[xAxis.length - 1]].map((x, i) => (
              <text
                key={i}
                x={xScale(x)}
                y={height - 6}
                textAnchor={i === 0 ? 'start' : 'end'}
                className={styles.axisLabel}
              >
                {formatX(x)}
              </text>
            ))
          : null}

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
                      x={xScale(last.x) + 4}
                      y={yScale(last.y)}
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
