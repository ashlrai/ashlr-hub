/**
 * components/charts/BarStack.tsx — stacked columns over ordered categories
 * (usually days): e.g. runs per day split into done / failed / aborted.
 *
 * Marks follow the kit spec: columns ≤ 24 px, a 4 px rounded data end on the
 * top segment only, square on the baseline, a 2 px surface gap between
 * segments. `normalize` shows each column as 100% (composition, not volume).
 *
 * Honesty: a null segment is UNKNOWN. A column with every segment null draws
 * a dashed "no data" placeholder; a column with some nulls stacks what is
 * known and marks the total as a lower bound (hollow cap + "≥" in the
 * tooltip and table). Nothing unknown ever renders as a zero-height bar.
 *
 * V3.10: every segment names its colour. The old fallback — categorical slot
 * by INDEX — meant an engine chart silently painted Claude in whatever ink
 * slot 0 held; engine charts must pass engineColor(), status charts
 * toneColor(), identity charts seriesColor(slot) with a slot fixed per entity
 * (SPEC-310C §6). An all-unknown column is drawn with the unknown hatch.
 */
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { hatchPatternId } from './colors.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { ChartLegend, ChartTooltip, HatchPattern, clampTooltipLeft } from './ChartParts.js';
import { TableView, type TableColumn } from './TableView.js';
import { linearScale, niceTicks, roundedTopBar, stackColumn, thinIndexes, type StackedColumn } from './chart-math.js';
import { formatCompact, formatPercent } from './format.js';
import { useChartWidth } from './useChartWidth.js';
import plot from './plot.module.css';

export interface BarStackSegment {
  id: string;
  label: string;
  /**
   * Required (V3.10): seriesColor(fixedSlot) for identity, toneColor(...) for
   * status, engineColor(...) for engines. Never picked by index.
   */
  color: string;
}

export interface BarStackProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  /** Category labels in display order (e.g. formatted days). */
  categories: string[];
  segments: BarStackSegment[];
  /** values[categoryIndex][segmentIndex]; null = unknown. */
  values: ReadonlyArray<ReadonlyArray<number | null>>;
  normalize?: boolean;
  height?: number;
  width?: number;
  formatValue?: (v: number) => string;
  ariaLabel?: string;
}

const PAD_T = 14;
const PAD_B = 26;
const PAD_R = 8;
const BAR_MAX = 24;
const GAP = 2;

interface Row {
  label: string;
  values: ReadonlyArray<number | null>;
  stack: StackedColumn;
}

export function BarStack({
  title,
  description,
  caveat,
  status,
  categories,
  segments,
  values,
  normalize = false,
  height = 200,
  width: fixedWidth,
  formatValue = formatCompact,
  ariaLabel,
}: BarStackProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const [active, setActive] = useState<number | null>(null);
  const liveId = useId();
  const hatchId = hatchPatternId(useId());
  const colors = segments.map((s) => s.color);

  const rows: Row[] = categories.map((label, i) => {
    const vals = values[i] ?? segments.map(() => null);
    return { label, values: vals, stack: stackColumn(vals) };
  });
  const anyKnown = rows.some((r) => !r.stack.unknown);
  const maxTotal = Math.max(0, ...rows.map((r) => r.stack.total));
  const anyIncomplete = rows.some((r) => r.stack.incomplete);
  // A window of known zeros is a designed empty state, not empty axes.
  const resolvedStatus: ChartStatus = status ?? (
    rows.length === 0 || (anyKnown && maxTotal === 0 && !anyIncomplete)
      ? { kind: 'empty' }
      : anyKnown ? { kind: 'ready' } : { kind: 'unknown' }
  );

  const ticks = normalize ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(0, Math.max(maxTotal, 1), 4);
  const top = ticks[ticks.length - 1]!;
  const fmtTick = normalize ? (v: number) => formatPercent(v) : formatValue;
  const padL = Math.min(60, Math.max(28, Math.max(...ticks.map((t) => fmtTick(t).length)) * 7 + 10));
  const plotW = Math.max(40, width - padL - PAD_R);
  const plotH = height - PAD_T - PAD_B;
  const slot = rows.length ? plotW / rows.length : plotW;
  const barW = Math.max(2, Math.min(BAR_MAX, slot * 0.66));
  const ys = linearScale(0, top, PAD_T + plotH, PAD_T);
  const xOf = (i: number) => padL + slot * i + (slot - barW) / 2;
  const labelIdx = thinIndexes(rows.length, Math.max(2, Math.floor(plotW / 64)));

  const fmtTotal = (r: Row) => `${r.stack.incomplete && !r.stack.unknown ? '≥ ' : ''}${r.stack.unknown ? '—' : formatValue(r.stack.total)}`;

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (rows.length === 0) return;
    const cur = active ?? rows.length - 1;
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(rows.length - 1, next)));
  }

  const busiest = rows.reduce<Row | null>((best, r) => (!r.stack.unknown && (!best || r.stack.total > best.stack.total) ? r : best), null);
  const summary = ariaLabel ?? `${title}: ${rows.length} columns of ${segments.map((s) => s.label).join(', ')}.` +
    (busiest ? ` Highest: ${busiest.label} with ${fmtTotal(busiest)}.` : '');

  const columns: TableColumn<Row>[] = [
    { key: 'label', label: 'Category', render: (r) => r.label },
    ...segments.map((s, i) => ({
      key: s.id,
      label: s.label,
      numeric: true,
      render: (r: Row) => (r.values[i] === null || r.values[i] === undefined ? '—' : formatValue(r.values[i]!)),
    })),
    { key: '__total', label: 'Total', numeric: true, render: fmtTotal },
  ];

  const activeRow = active !== null ? rows[active] : undefined;

  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={resolvedStatus}
      table={<TableView caption={title} columns={columns} rows={rows} rowKey={(r, i) => `${i}:${r.label}`} />}
      footer={
        <ChartLegend
          items={[
            ...segments.map((s, i) => ({ label: s.label, color: colors[i] })),
            ...(rows.some((r) => r.stack.unknown) ? [{ label: 'no data', kind: 'hatch' as const }] : []),
          ]}
        />
      }
    >
      <div
        ref={wrapRef}
        className={`${plot.plotWrap} ${plot.focusable}`}
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the left and right arrow keys to read each column.`}
        aria-describedby={liveId}
        onFocus={() => setActive((a) => a ?? (rows.length ? rows.length - 1 : null))}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        <svg className={plot.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
          <defs>
            <HatchPattern id={hatchId} />
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line className={plot.grid} x1={padL} x2={padL + plotW} y1={ys(t)} y2={ys(t)} />
              <text className={plot.tick} x={padL - 6} y={ys(t)} dy="0.32em" textAnchor="end">{fmtTick(t)}</text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = xOf(i);
            const scaleTotal = normalize ? r.stack.total || 1 : 1;
            if (r.stack.unknown) {
              return (
                <rect
                  key={i}
                  data-unknown="true"
                  className={plot.unknownMark}
                  fill={`url(#${hatchId})`}
                  x={x + 0.5}
                  y={PAD_T + plotH - 12.5}
                  width={Math.max(1, barW - 1)}
                  height={12}
                  rx={2}
                />
              );
            }
            const last = r.stack.segments[r.stack.segments.length - 1];
            return (
              <g key={i} data-column={i} opacity={active !== null && active !== i ? 0.55 : 1}>
                {r.stack.segments.map((seg) => {
                  const y1 = ys(seg.y1 / scaleTotal);
                  const y0 = ys(seg.y0 / scaleTotal);
                  const isTop = seg === last;
                  // 2 px surface gap above every segment but the top one.
                  const h = Math.max(0, y0 - y1 - (isTop ? 0 : GAP));
                  const y = isTop ? y1 : y1 + GAP;
                  return isTop ? (
                    <path key={seg.index} d={roundedTopBar(x, y, barW, h)} fill={colors[seg.index]} data-segment={segments[seg.index]!.id} />
                  ) : (
                    <rect key={seg.index} x={x} y={y} width={barW} height={h} fill={colors[seg.index]} data-segment={segments[seg.index]!.id} />
                  );
                })}
                {r.stack.incomplete ? (
                  <rect data-incomplete="true" className={plot.noData} x={x} y={ys(r.stack.total / scaleTotal) - 8} width={barW} height={6} rx={2} />
                ) : null}
              </g>
            );
          })}
          <line className={plot.axis} x1={padL} x2={padL + plotW} y1={PAD_T + plotH} y2={PAD_T + plotH} />
          {labelIdx.map((i) => (
            <text key={i} className={plot.tick} x={xOf(i) + barW / 2} y={height - 8} textAnchor="middle">{rows[i]!.label}</text>
          ))}
          {rows.map((_, i) => (
            <rect
              key={`hit${i}`}
              className={plot.hit}
              x={padL + slot * i}
              y={PAD_T}
              width={slot}
              height={plotH}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((a) => (a === i ? null : a))}
            />
          ))}
        </svg>
        <span id={liveId} className={plot.srOnly} aria-live="polite">
          {activeRow
            ? `${activeRow.label}: ${segments.map((s, i) => `${s.label} ${activeRow.values[i] === null ? 'no data' : formatValue(activeRow.values[i]!)}`).join(', ')}; total ${fmtTotal(activeRow)}`
            : ''}
        </span>
        {activeRow && active !== null ? (
          <ChartTooltip
            left={clampTooltipLeft(xOf(active) + barW / 2, width)}
            top={activeRow.stack.unknown ? PAD_T + plotH - 12 : ys(normalize ? 1 : activeRow.stack.total)}
            title={activeRow.label}
            rows={[
              ...segments.map((s, i) => ({
                key: s.id,
                label: s.label,
                value: activeRow.values[i] === null || activeRow.values[i] === undefined ? null : formatValue(activeRow.values[i]!),
                color: colors[i],
              })),
              { key: '__t', label: 'Total', value: activeRow.stack.unknown ? null : fmtTotal(activeRow) },
            ]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
