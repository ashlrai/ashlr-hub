/**
 * components/charts/AreaTrend.tsx — change over time for 1–4 series, as lines
 * over a 10% wash (overlaid) or as a stacked composition (`stacked`).
 *
 * Honesty: a `null` y is a GAP — the line and wash break there, and in stacked
 * mode an unknown in any layer breaks the whole stack at that x (the total is
 * unknown), never a silent zero. One y-axis only; a threshold is a labelled
 * reference line, not a second scale.
 *
 * Interaction: crosshair + tooltip on hover; the plot is focusable and the
 * arrow keys (Home/End) walk the same crosshair, announced through a live
 * region. The Table view carries every value without hovering.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Series } from './types.js';
import { seriesColor } from './colors.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { ChartLegend, ChartTooltip, clampTooltipLeft } from './ChartParts.js';
import { TableView, type TableColumn } from './TableView.js';
import {
  MIN_TIME_SPAN_MS,
  allIntegers,
  areaPath,
  axisTicks,
  dodgeLabels,
  ensureSpan,
  isTimeAxis,
  layoutAxisLabels,
  linePath,
  linearScale,
  percentScale,
  splitRuns,
  thinIndexes,
  xKeeper,
  type XY,
} from './chart-math.js';
import { formatCompact, formatTimeLabel, timeLabelLadder } from './format.js';
import { useChartWidth } from './useChartWidth.js';
import plot from './plot.module.css';

export interface AreaTrendSeries extends Series {
  /** Override the identity colour (defaults to the fixed categorical slot by index). */
  color?: string;
}

export interface AreaTrendProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  series: AreaTrendSeries[];
  stacked?: boolean;
  /** Plot height in px, including the x-axis band. */
  height?: number;
  /** Fixed width (tests, print). Omit to fill the container. */
  width?: number;
  formatX?: (x: number) => string;
  formatY?: (y: number) => string;
  /** A labelled horizontal reference (a cap, a target). */
  threshold?: { value: number; label: string };
  /**
   * The y range to draw (widened, never clipped, if a value falls outside).
   * Default: a percent formatter (`formatY(50)` → "50%") gets 0–100 — or 0–1
   * for a fraction formatter — so percent cards share one scale; anything
   * else fits its data.
   */
  yDomain?: readonly [number, number];
  /** Accessible summary override. */
  ariaLabel?: string;
}

const PAD_T = 12;
const PAD_B = 26;
const PAD_R = 12;
const END_LABEL_CH = 6.6;
const END_LABEL_MAX = 120;
/** Line height of a direct end label: two closer than this overlap. */
const END_LABEL_GAP_Y = 14;

interface Row {
  x: number;
  values: (number | null)[];
  total: number | null;
}

export function AreaTrend({
  title,
  description,
  caveat,
  status,
  series,
  stacked = false,
  height = 200,
  width: fixedWidth,
  formatX: formatXProp,
  formatY: formatYProp,
  threshold,
  yDomain,
  ariaLabel,
}: AreaTrendProps) {
  const formatX = formatXProp ?? formatTimeLabel;
  const formatY = formatYProp ?? formatCompact;
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const [active, setActive] = useState<number | null>(null);
  const liveId = useId();

  const colors = series.map((s, i) => s.color ?? seriesColor(i));

  const rows: Row[] = useMemo(() => {
    // On a time axis a 0 / NaN / pre-2000 x is a null timestamp that leaked
    // through, not a moment — it would start the axis at "Dec 31" 1969.
    const all = series.flatMap((s) => s.points.map((p) => p.x));
    const keep = xKeeper(all);
    const xs = Array.from(new Set(all.filter(keep))).sort((a, b) => a - b);
    const lookup = series.map((s) => new Map(s.points.map((p) => [p.x, p.y])));
    return xs.map((x) => {
      const values = lookup.map((m) => (m.has(x) ? m.get(x)! : null));
      const total = values.some((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0);
      return { x, values, total };
    });
  }, [series]);

  const hasData = rows.some((r) => r.values.some((v) => v !== null));
  const resolvedStatus: ChartStatus = status ?? (hasData ? { kind: 'ready' } : { kind: 'empty' });

  // ── scales ─────────────────────────────────────────────────────────────
  const known = stacked
    ? rows.map((r) => r.total).filter((v): v is number => v !== null)
    : rows.flatMap((r) => r.values).filter((v): v is number => v !== null);
  const pctScale = formatYProp ? percentScale(formatYProp) : null;
  const inDomain = (d: readonly [number, number]) => known.every((v) => v >= d[0] && v <= d[1]);
  const baseDomain: readonly [number, number] | null = yDomain ?? (pctScale !== null && inDomain([0, pctScale]) ? [0, pctScale] : null);
  const yAxis = axisTicks(
    Math.min(0, baseDomain?.[0] ?? 0, ...known),
    Math.max(0, baseDomain?.[1] ?? 0, ...known, threshold?.value ?? 0),
    { count: 4, integer: known.length > 0 && allIntegers(known), format: formatYProp },
  );
  const ticksY = yAxis.ticks;
  const yMin = ticksY[0]!;
  const yMax = ticksY[ticksY.length - 1]!;
  const tickLabelW = Math.max(...yAxis.labels.map((l) => l.length)) * 7 + 10;
  const padL = Math.min(64, Math.max(28, tickLabelW));
  const plotH = height - PAD_T - PAD_B;
  const ys = linearScale(yMin, yMax, PAD_T + plotH, PAD_T);

  // Direct end labels (series names at each line's last point), dodged so
  // two lines ending on the same value ("Struggles" and "Wins" both at 3)
  // never print over each other. If they cannot all fit, the legend alone
  // names the series. Decided before the x scale: the gutter they need is
  // what plotW is measured against.
  const endLabelW = !stacked && series.length <= 4
    ? Math.max(0, ...series.map((s) => s.label.length)) * END_LABEL_CH + 6
    : 0;
  const endPoints = series.flatMap((s, si) => {
    for (let r = rows.length - 1; r >= 0; r--) {
      const v = rows[r]!.values[si];
      if (v !== null && v !== undefined) return [{ key: s.id, y: ys(v) }];
    }
    return [];
  });
  const dodged = endLabelW > 0 && endLabelW <= END_LABEL_MAX && width >= 420
    ? dodgeLabels(endPoints, END_LABEL_GAP_Y, PAD_T, PAD_T + plotH)
    : null;
  const showEndLabels = dodged !== null && endPoints.length > 0;
  const padR = PAD_R + (showEndLabels ? endLabelW : 0);
  const plotW = Math.max(40, width - padL - padR);

  const rawMin = rows.length ? rows[0]!.x : 0;
  const rawMax = rows.length ? rows[rows.length - 1]!.x : 1;
  const timeAxis = isTimeAxis(rows.map((r) => r.x));
  // A burst of readings seconds apart is widened to MIN_TIME_SPAN_MS around
  // itself, not stretched edge to edge (a lone point stays centred as before).
  const [xMin, xMax] = timeAxis && rawMax > rawMin ? ensureSpan(rawMin, rawMax, MIN_TIME_SPAN_MS) : [rawMin, rawMax];
  const xs = linearScale(xMin, xMax, padL, padL + plotW);

  // ── geometry ───────────────────────────────────────────────────────────
  // Recomputed per render on purpose: the scales depend on the measured width.
  const layers = (() => {
    if (stacked) {
      const acc = rows.map(() => 0);
      return series.map((_, si) => {
        const top = rows.map((r, ri) => {
          if (r.total === null) return { x: r.x, y: null as number | null, base: null as number | null };
          const base = acc[ri]!;
          acc[ri] = base + (r.values[si] ?? 0);
          return { x: r.x, y: acc[ri]!, base };
        });
        const runs = splitRuns(top.map((p) => ({ x: p.x, y: p.y })));
        return runs.map((run) => {
          const topPx: XY[] = run.map((p) => ({ x: xs(p.x), y: ys(p.y) }));
          const bottomPx: XY[] = run.map((p) => {
            const src = top.find((t) => t.x === p.x)!;
            return { x: xs(p.x), y: ys(src.base ?? 0) };
          });
          return { top: topPx, bottom: bottomPx };
        });
      });
    }
    return series.map((_, si) => {
      const runs = splitRuns(rows.map((r) => ({ x: r.x, y: r.values[si] ?? null })));
      return runs.map((run) => {
        const topPx = run.map((p) => ({ x: xs(p.x), y: ys(p.y) }));
        const bottomPx = run.map((p) => ({ x: xs(p.x), y: ys(Math.max(yMin, 0)) }));
        return { top: topPx, bottom: bottomPx };
      });
    });
  })();

  const xTickIdx = thinIndexes(rows.length, Math.max(2, Math.floor(plotW / 84)));
  // Collision-free x labels: the last point outranks the first, and both
  // outrank the interior ticks, which are simply dropped when they collide.
  // On a time axis the labels walk one shared detail ladder (caller's format
  // → shorter date/time; clock time only inside one day) until the ends fit.
  const ladder = timeAxis
    ? timeLabelLadder(rawMin, rawMax, formatXProp, xTickIdx.map((i) => rows[i]!.x))
    : [formatX];
  const xLabels = layoutAxisLabels(
    xTickIdx.map((i, n) => {
      const px = xs(rows[i]!.x);
      const isFirst = n === 0;
      const isLast = n === xTickIdx.length - 1;
      return {
        key: String(i),
        x: px,
        anchor: rows.length === 1 ? 'middle' as const : isFirst && px <= padL + 0.5 ? 'start' as const : isLast && px >= padL + plotW - 0.5 ? 'end' as const : 'middle' as const,
        priority: isLast ? 3 : isFirst ? 2 : 1,
        required: isFirst || isLast,
        variants: ladder.map((f) => f(rows[i]!.x)),
      };
    }),
    { min: padL, max: padL + plotW },
  );

  function indexAt(clientX: number): number | null {
    const el = wrapRef.current;
    if (!el || rows.length === 0) return null;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    rows.forEach((r, i) => {
      const d = Math.abs(xs(r.x) - px);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (rows.length === 0) return;
    const cur = active ?? rows.length - 1;
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(rows.length - 1, next)));
  }

  const activeRow = active !== null ? rows[active] : undefined;
  const latest = [...rows].reverse().find((r) => r.values.some((v) => v !== null));
  const summary = ariaLabel ?? (rows.length
    ? `${title}: ${rows.length} points from ${formatX(rawMin)} to ${formatX(rawMax)}.` +
      (latest ? ` Latest ${formatX(latest.x)}: ${series.map((s, i) => `${s.label} ${latest.values[i] === null ? 'no data' : formatY(latest.values[i]!)}`).join(', ')}.` : '')
    : `${title}: no data.`);

  const columns: TableColumn<Row>[] = [
    { key: 'x', label: 'When', render: (r) => formatX(r.x) },
    ...series.map((s, i) => ({
      key: s.id,
      label: s.label,
      numeric: true,
      render: (r: Row) => (r.values[i] === null ? '—' : formatY(r.values[i]!)),
    })),
    ...(stacked && series.length > 1
      ? [{ key: '__total', label: 'Total', numeric: true, render: (r: Row) => (r.total === null ? '—' : formatY(r.total)) }]
      : []),
  ];

  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={resolvedStatus}
      table={<TableView caption={title} columns={columns} rows={rows} rowKey={(r) => String(r.x)} />}
      footer={
        <ChartLegend
          items={series.map((s, i) => ({ label: s.label, color: colors[i], kind: stacked ? 'swatch' : 'line' }))}
        />
      }
    >
      <div
        ref={wrapRef}
        className={`${plot.plotWrap} ${plot.focusable}`}
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the left and right arrow keys to read values.`}
        aria-describedby={liveId}
        onFocus={() => setActive((a) => a ?? (rows.length ? rows.length - 1 : null))}
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
          {ticksY.map((t, i) => (
            <g key={t}>
              <line className={plot.grid} x1={padL} x2={padL + plotW} y1={ys(t)} y2={ys(t)} />
              <text className={plot.tick} x={padL - 6} y={ys(t)} dy="0.32em" textAnchor="end">{yAxis.labels[i]}</text>
            </g>
          ))}
          <line className={plot.axis} x1={padL} x2={padL + plotW} y1={ys(Math.max(yMin, 0))} y2={ys(Math.max(yMin, 0))} />
          {xLabels.map((l) => (
            <text key={l.key} data-axis-label={l.key} className={plot.tick} x={l.x} y={height - 8} textAnchor={l.anchor}>
              {l.text}
            </text>
          ))}

          {layers.map((runs, si) => (
            <g key={series[si]!.id} data-series={series[si]!.id}>
              {runs.map((run, ri) => (
                <path
                  key={`a${ri}`}
                  d={areaPath(run.top, run.bottom)}
                  fill={colors[si]}
                  className={stacked ? undefined : plot.wash}
                  opacity={stacked ? 0.85 : undefined}
                  stroke={stacked ? 'var(--chart-surface)' : undefined}
                  strokeWidth={stacked ? 2 : undefined}
                />
              ))}
              {!stacked
                ? runs.map((run, ri) =>
                    run.top.length === 1 ? (
                      <circle key={`p${ri}`} cx={run.top[0]!.x} cy={run.top[0]!.y} r={3} fill={colors[si]} />
                    ) : (
                      <path key={`l${ri}`} d={linePath(run.top)} stroke={colors[si]} className={plot.line} />
                    ),
                  )
                : null}
              {showEndLabels && runs.length ? (() => {
                const last = runs[runs.length - 1]!.top;
                const end = last[last.length - 1]!;
                return (
                  <text data-end-label={series[si]!.id} className={plot.label} x={end.x + 6} y={dodged!.get(series[si]!.id) ?? end.y} dy="0.32em">{series[si]!.label}</text>
                );
              })() : null}
            </g>
          ))}

          {threshold ? (
            <g>
              <line className={plot.reference} x1={padL} x2={padL + plotW} y1={ys(threshold.value)} y2={ys(threshold.value)} />
              <text className={plot.tick} x={padL + plotW} y={ys(threshold.value) - 4} textAnchor="end">
                {threshold.label} · {formatY(threshold.value)}
              </text>
            </g>
          ) : null}

          {activeRow ? (
            <g>
              <line className={plot.crosshair} x1={xs(activeRow.x)} x2={xs(activeRow.x)} y1={PAD_T} y2={PAD_T + plotH} />
              {series.map((s, si) => {
                const v = stacked
                  ? (activeRow.total === null ? null : activeRow.values.slice(0, si + 1).reduce<number>((a, b) => a + (b ?? 0), 0))
                  : activeRow.values[si];
                return v === null || v === undefined ? null : (
                  <circle key={s.id} className={plot.marker} cx={xs(activeRow.x)} cy={ys(v)} r={4} fill={colors[si]} />
                );
              })}
            </g>
          ) : null}

        </svg>
        <span id={liveId} className={plot.srOnly} aria-live="polite">
          {activeRow
            ? `${formatX(activeRow.x)}: ${series.map((s, i) => `${s.label} ${activeRow.values[i] === null ? 'no data' : formatY(activeRow.values[i]!)}`).join(', ')}`
            : ''}
        </span>
        {activeRow ? (
          <ChartTooltip
            left={clampTooltipLeft(xs(activeRow.x), width)}
            top={PAD_T}
            title={formatX(activeRow.x)}
            rows={[
              ...series.map((s, i) => ({
                key: s.id,
                label: s.label,
                value: activeRow.values[i] === null ? null : formatY(activeRow.values[i]!),
                color: colors[i],
              })),
              ...(stacked && series.length > 1
                ? [{ key: '__t', label: 'Total', value: activeRow.total === null ? null : formatY(activeRow.total) }]
                : []),
            ]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
