/**
 * components/charts/CalendarHeatmap.tsx — one value per day on a weeks ×
 * weekdays grid (activity by day across months). Sequential: ONE hue, four
 * steps light → dark mixed from the theme's own tokens, with a Less → More
 * key. A TRUE ZERO is the faint step-0 cell; UNKNOWN (null, or a day missing
 * from the data) is an outlined empty cell with its own "no data" key entry —
 * the two are never the same colour.
 *
 * Width: the cell size adapts (8–16 px). When even 8 px cells cannot fit the
 * whole span at 375 px, the grid shows the most recent weeks that fit and says
 * how many are hidden; the Table view always has every day.
 *
 * Keyboard: the grid is one tab stop; ← → move a week, ↑ ↓ move a day (rows
 * are weekdays), Home/End jump to the ends; the focused day is announced.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { heatColor } from './colors.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { ChartTooltip, clampTooltipLeft } from './ChartParts.js';
import { TableView, type TableColumn } from './TableView.js';
import { calendarGrid, heatBucket, type CalendarCell } from './chart-math.js';
import { formatCompact, formatDayLabel } from './format.js';
import { useChartWidth } from './useChartWidth.js';
import plot from './plot.module.css';

export interface CalendarDatum {
  day: string;
  value: number | null;
}

export interface CalendarHeatmapProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  days: CalendarDatum[];
  /** 1 = Monday (ISO, default), 0 = Sunday. */
  weekStart?: 0 | 1;
  width?: number;
  formatValue?: (v: number) => string;
  /** Unit for the spoken/tooltip text, e.g. "runs". */
  unit?: string;
  ariaLabel?: string;
}

const MIN_CELL = 8;
const MAX_CELL = 16;
const GAP = 2;
const DAY_LABEL_W = 28;
const MONTH_H = 16;
const STEPS = 4;
const WEEKDAYS_MON = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const WEEKDAYS_SUN = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

export function CalendarHeatmap({
  title,
  description,
  caveat,
  status,
  days,
  weekStart = 1,
  width: fixedWidth,
  formatValue = formatCompact,
  unit = '',
  ariaLabel,
}: CalendarHeatmapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const liveId = useId();
  const grid = useMemo(() => calendarGrid(days, weekStart), [days, weekStart]);
  const [focus, setFocus] = useState<number | null>(null);

  const max = Math.max(0, ...days.map((d) => d.value ?? 0));
  const anyKnown = days.some((d) => d.value !== null);
  const resolvedStatus: ChartStatus = status ?? (days.length === 0 ? { kind: 'empty' } : anyKnown ? { kind: 'ready' } : { kind: 'unknown' });

  const avail = width - DAY_LABEL_W;
  const fitWeeks = Math.max(1, Math.floor((avail + GAP) / (MIN_CELL + GAP)));
  const shownWeeks = Math.min(grid.weeks, fitWeeks);
  const hiddenWeeks = grid.weeks - shownWeeks;
  const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor((avail + GAP) / Math.max(1, shownWeeks)) - GAP));
  const firstWeek = hiddenWeeks;
  const visible = grid.cells.filter((c) => c.week >= firstWeek);
  const svgW = DAY_LABEL_W + shownWeeks * (cell + GAP);
  const svgH = MONTH_H + 7 * (cell + GAP);
  const xOf = (c: CalendarCell) => DAY_LABEL_W + (c.week - firstWeek) * (cell + GAP);
  const yOf = (c: CalendarCell) => MONTH_H + c.weekday * (cell + GAP);
  const unitText = unit ? ` ${unit}` : '';
  const describe = (c: CalendarCell) => `${formatDayLabel(c.day)}: ${c.value === null ? 'no data' : `${formatValue(c.value)}${unitText}`}`;

  const monthLabels: { week: number; label: string }[] = [];
  for (const m of grid.months) {
    if (m.week < firstWeek) continue;
    const prev = monthLabels[monthLabels.length - 1];
    if (prev && m.week - prev.week < 3) continue;
    monthLabels.push(m);
  }

  const inside = visible.filter((c) => !c.outside);
  const focusCell = focus !== null ? inside[focus] : undefined;

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (inside.length === 0) return;
    const cur = focus ?? inside.length - 1;
    const delta = e.key === 'ArrowLeft' ? -7 : e.key === 'ArrowRight' ? 7 : e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : null;
    let next: number | null = null;
    if (delta !== null) next = cur + delta;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = inside.length - 1;
    if (next === null) return;
    e.preventDefault();
    setFocus(Math.max(0, Math.min(inside.length - 1, next)));
  }

  const knownDays = days.filter((d) => d.value !== null);
  const total = knownDays.reduce((s, d) => s + (d.value ?? 0), 0);
  const busiest = knownDays.reduce<CalendarDatum | null>((b, d) => (!b || (d.value ?? 0) > (b.value ?? 0) ? d : b), null);
  const summary = ariaLabel ?? `${title}: ${days.length} days, ${formatValue(total)}${unitText} in total` +
    (busiest && (busiest.value ?? 0) > 0 ? `, busiest ${formatDayLabel(busiest.day)} with ${formatValue(busiest.value!)}` : '') +
    (days.length - knownDays.length > 0 ? `, ${days.length - knownDays.length} days without data` : '') + '.';

  const columns: TableColumn<CalendarDatum>[] = [
    { key: 'day', label: 'Day', render: (d) => formatDayLabel(d.day) },
    { key: 'value', label: unit ? unit[0]!.toUpperCase() + unit.slice(1) : 'Value', numeric: true, render: (d) => (d.value === null ? '—' : formatValue(d.value)) },
  ];

  const legend = (
    <div className={plot.legend} aria-hidden="true">
      <span className={plot.legendItem}>Less</span>
      {Array.from({ length: STEPS + 1 }, (_, i) => (
        <span key={i} className={plot.swatch} style={{ background: heatColor(i) }} />
      ))}
      <span className={plot.legendItem}>More</span>
      <span className={plot.legendItem}>
        <span className={plot.swatchEmpty} />
        no data
      </span>
    </div>
  );

  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={resolvedStatus}
      table={<TableView caption={title} columns={columns} rows={[...days].sort((a, b) => a.day.localeCompare(b.day))} rowKey={(d) => d.day} />}
      footer={
        <>
          {legend}
          {hiddenWeeks > 0 ? (
            <p className={plot.note}>Showing the latest {shownWeeks} weeks; {hiddenWeeks} earlier weeks are in the table.</p>
          ) : null}
        </>
      }
    >
      <div
        ref={wrapRef}
        className={`${plot.plotWrap} ${plot.focusable}`}
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the arrow keys to move between days.`}
        aria-describedby={liveId}
        onFocus={() => setFocus((f) => f ?? (inside.length ? inside.length - 1 : null))}
        onBlur={() => setFocus(null)}
        onKeyDown={onKey}
      >
        <svg className={plot.svg} width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} role="img" aria-label={summary}>
          {monthLabels.map((m) => (
            <text key={`${m.week}${m.label}`} className={plot.tick} x={DAY_LABEL_W + (m.week - firstWeek) * (cell + GAP)} y={11}>
              {m.label}
            </text>
          ))}
          {(weekStart === 1 ? WEEKDAYS_MON : WEEKDAYS_SUN).map((label, i) =>
            label && cell >= 10 ? (
              <text key={i} className={plot.tick} x={0} y={MONTH_H + i * (cell + GAP) + cell / 2} dy="0.32em">{label}</text>
            ) : null,
          )}
          {visible.map((c) => {
            if (c.outside) return null;
            const bucket = heatBucket(c.value, max, STEPS);
            const isFocus = focusCell?.day === c.day;
            return (
              <rect
                key={c.day}
                data-day={c.day}
                data-bucket={bucket === null ? 'unknown' : bucket}
                x={xOf(c)}
                y={yOf(c)}
                width={cell}
                height={cell}
                rx={2}
                className={bucket === null ? plot.noData : undefined}
                fill={bucket === null ? 'none' : heatColor(bucket)}
                style={isFocus ? { stroke: 'var(--border-focus)', strokeWidth: 2, strokeDasharray: 'none' } : undefined}
                onPointerEnter={() => setFocus(inside.indexOf(c))}
                onPointerLeave={() => setFocus(null)}
              />
            );
          })}
        </svg>
        <span id={liveId} className={plot.srOnly} aria-live="polite">{focusCell ? describe(focusCell) : ''}</span>
        {focusCell ? (
          <ChartTooltip
            left={clampTooltipLeft(xOf(focusCell) + cell / 2, svgW, 60)}
            top={yOf(focusCell)}
            title={formatDayLabel(focusCell.day)}
            rows={[{ key: 'v', label: unit || 'Value', value: focusCell.value === null ? null : formatValue(focusCell.value) }]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
