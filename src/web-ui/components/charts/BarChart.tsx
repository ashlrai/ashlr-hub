/**
 * components/charts/BarChart.tsx — categorical magnitude comparison.
 * Single hue by default (nominal categories never get a value-ramp — see
 * dataviz anti-patterns "a value-ramp on nominal categories"). Vertical for
 * a handful of short-named categories, horizontal for many or long-named
 * ones (dataviz choosing-a-form.md). Null values render as an explicit
 * "no data" dash, never a silent zero-height bar indistinguishable from a
 * real zero.
 */
import { useId, useState } from 'react';
import type { CategoricalDatum } from './types.js';
import { CHART_SEQUENTIAL, CHART_AXIS, CHART_GRID } from './colors.js';
import './chart-tokens.css';
import styles from './BarChart.module.css';

const BAR_MAX = 24;
const GAP = 10;

export function BarChart({
  data,
  height = 160,
  orientation = 'vertical',
  color = CHART_SEQUENTIAL,
  formatValue = (v: number) => String(v),
  ariaLabel,
}: {
  data: CategoricalDatum[];
  height?: number;
  orientation?: 'vertical' | 'horizontal';
  color?: string;
  formatValue?: (v: number) => string;
  ariaLabel: string;
}) {
  const uid = useId();
  const [hover, setHover] = useState<number | null>(null);

  const known = data.map((d) => d.value).filter((v): v is number => v !== null);
  const maxVal = Math.max(0, ...known, 0.0001);
  const minVal = Math.min(0, ...known);
  const range = maxVal - minVal || 1;

  if (orientation === 'horizontal') {
    const LABEL_W = 120;
    const PAD_R = 48;
    const rowH = Math.min(BAR_MAX, Math.max(14, Math.floor((height - GAP) / data.length) - GAP));
    const plotW = 420;
    const svgH = data.length * (rowH + GAP) + GAP;
    const svgW = LABEL_W + plotW + PAD_R;

    return (
      <div className={styles.wrap}>
        <svg
          className={styles.svg}
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          role="img"
          aria-label={ariaLabel}
        >
          <line x1={LABEL_W} y1={0} x2={LABEL_W} y2={svgH} className={styles.baseline} stroke={CHART_AXIS} />
          {data.map((d, i) => {
            const y = GAP + i * (rowH + GAP);
            const barW = d.value !== null ? ((d.value - minVal) / range) * plotW : 0;
            return (
              <g key={d.label + i}>
                <text
                  x={LABEL_W - 8}
                  y={y + rowH / 2}
                  dy="0.32em"
                  textAnchor="end"
                  className={styles.categoryLabel}
                >
                  {d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label}
                </text>
                {d.value === null ? (
                  <line
                    x1={LABEL_W + 4}
                    y1={y + rowH / 2}
                    x2={LABEL_W + 14}
                    y2={y + rowH / 2}
                    stroke={CHART_GRID}
                    strokeWidth={2}
                    strokeDasharray="2 2"
                  />
                ) : (
                  <>
                    <rect
                      x={LABEL_W}
                      y={y}
                      width={Math.max(2, barW)}
                      height={rowH}
                      rx={4}
                      fill={color}
                      className={styles.bar}
                    />
                    <text
                      x={LABEL_W + Math.max(2, barW) + 6}
                      y={y + rowH / 2}
                      dy="0.32em"
                      className={styles.valueLabel}
                    >
                      {formatValue(d.value)}
                    </text>
                  </>
                )}
                <rect
                  className={styles.hitArea}
                  x={0}
                  y={y - GAP / 2}
                  width={svgW}
                  height={rowH + GAP}
                  tabIndex={0}
                  role="img"
                  aria-label={`${d.label}: ${d.value === null ? 'no data' : formatValue(d.value)}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover((h) => (h === i ? null : h))}
                />
              </g>
            );
          })}
        </svg>
        {hover !== null ? (
          <div
            className={styles.tooltip}
            style={{ left: LABEL_W + 8, top: GAP + hover * (rowH + GAP) - 4 }}
          >
            <span className={styles.tooltipValue}>
              {data[hover].value === null ? 'no data' : formatValue(data[hover].value as number)}
            </span>
            <span className={styles.tooltipLabel}>{data[hover].label}</span>
          </div>
        ) : null}
      </div>
    );
  }

  // Vertical orientation.
  const barSlot = data.length ? Math.max(BAR_MAX, 0) : BAR_MAX;
  const barW = Math.min(BAR_MAX, barSlot);
  const PAD_T = 20;
  const PAD_B = 30;
  const plotH = height;
  const svgH = plotH + PAD_T + PAD_B;
  const svgW = data.length * (barW + GAP) + GAP;
  const zeroY = PAD_T + plotH - ((0 - minVal) / range) * plotH;

  return (
    <div className={styles.wrap}>
      <svg
        className={styles.svg}
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        role="img"
        aria-label={ariaLabel}
      >
        <line x1={0} y1={zeroY} x2={svgW} y2={zeroY} className={styles.baseline} stroke={CHART_AXIS} />
        {data.map((d, i) => {
          const x = GAP + i * (barW + GAP);
          const barH = d.value !== null ? (Math.abs(d.value - minVal) / range) * plotH : 0;
          const top = d.value !== null && d.value >= 0 ? zeroY - barH : zeroY;
          return (
            <g key={d.label + i}>
              {d.value === null ? (
                <line
                  x1={x + barW / 2 - 5}
                  y1={zeroY}
                  x2={x + barW / 2 + 5}
                  y2={zeroY}
                  stroke={CHART_GRID}
                  strokeWidth={2}
                  strokeDasharray="2 2"
                />
              ) : (
                <>
                  <rect
                    x={x}
                    y={top}
                    width={barW}
                    height={Math.max(2, barH)}
                    rx={4}
                    fill={color}
                    className={styles.bar}
                  />
                  <text x={x + barW / 2} y={top - 4} textAnchor="middle" className={styles.valueLabel}>
                    {formatValue(d.value)}
                  </text>
                </>
              )}
              <text
                x={x + barW / 2}
                y={svgH - 8}
                textAnchor="middle"
                className={styles.axisLabel}
              >
                {d.label.length > 10 ? `${d.label.slice(0, 9)}…` : d.label}
              </text>
              <rect
                className={styles.hitArea}
                x={x - GAP / 2}
                y={0}
                width={barW + GAP}
                height={svgH}
                tabIndex={0}
                role="img"
                aria-label={`${d.label}: ${d.value === null ? 'no data' : formatValue(d.value)}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                onFocus={() => setHover(i)}
                onBlur={() => setHover((h) => (h === i ? null : h))}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null ? (
        <div
          className={styles.tooltip}
          style={{ left: GAP + hover * (barW + GAP), top: 0 }}
          id={`${uid}-tooltip`}
        >
          <span className={styles.tooltipValue}>
            {data[hover].value === null ? 'no data' : formatValue(data[hover].value as number)}
          </span>
          <span className={styles.tooltipLabel}>{data[hover].label}</span>
        </div>
      ) : null}
    </div>
  );
}
