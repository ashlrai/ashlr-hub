/**
 * components/charts/MatrixHeatmap.tsx — a rows × columns grid of counts
 * (V3.10, SPEC-310C §5 Mind: insight KIND × ENGINE, faceted per repo;
 * r5/visual.md §2 "MatrixHeatmap").
 *
 * Encoding, one meaning per mark:
 *   - a KNOWN value is a step of the fixed azure quantity ramp
 *     (colors.ts quantityColor) — a TRUE ZERO is the faint heat-0 cell;
 *   - an UNKNOWN value (null: nothing was measured for that cell, e.g. an
 *     engine with no recorded reasoning) is the 45° unknown hatch with an
 *     outline — never the palest step, which would claim "a little";
 *   - row and column TOTALS sit in the margins as bars (right and top), so
 *     "which kind dominates" reads without adding cells in your head.
 * A column may carry an engine: its header gets the 2px tick + monogram.
 *
 * Keyboard: the grid is one tab stop; arrows move a cell, Home/End jump
 * along the row; the focused cell is announced. The Table view has every
 * cell and both totals. At 375 px callers usually start on the table
 * (`defaultView="table"`, SPEC-310C §5 "Mind's matrix shows as a table").
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CHART_SEQUENTIAL_SOFT, hatchPatternId, heatColor, quantityColor, quantityInk, type ChartEngine } from './colors.js';
import { ChartFrame, type ChartStatus, type ChartView } from './ChartFrame.js';
import { ChartTooltip, EngineTick, HatchPattern, clampTooltipLeft } from './ChartParts.js';
import { TableView, type TableColumn } from './TableView.js';
import { formatCompact } from './format.js';
import { useChartWidth } from './useChartWidth.js';
import plot from './plot.module.css';
import styles from './MatrixHeatmap.module.css';

export interface MatrixAxisItem {
  id: string;
  label: string;
  /** Column-only: the engine this column stands for (tick + monogram in the header). */
  engine?: ChartEngine;
}

export interface MatrixHeatmapProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  rows: MatrixAxisItem[];
  columns: MatrixAxisItem[];
  /** values[rowIndex][columnIndex]; null = not measured. */
  values: ReadonlyArray<ReadonlyArray<number | null>>;
  /** Unit word for spoken text and the table ("insights"). */
  unit?: string;
  formatValue?: (v: number) => string;
  /** Row / column totals as margin bars (default true). */
  showTotals?: boolean;
  defaultView?: ChartView;
  /** Extra header controls (e.g. the repo facet picker). */
  actions?: ReactNode;
  width?: number;
  ariaLabel?: string;
}

interface Totals {
  rows: (number | null)[];
  columns: (number | null)[];
  max: number;
  grand: number | null;
}

/** Sum known values; a line with NO known value has an unknown (null) total, never 0. */
export function matrixTotals(values: ReadonlyArray<ReadonlyArray<number | null>>, rows: number, columns: number): Totals {
  const cell = (r: number, c: number): number | null => {
    const v = values[r]?.[c];
    return v === undefined || v === null || !Number.isFinite(v) ? null : v;
  };
  const sum = (xs: (number | null)[]): number | null => {
    const known = xs.filter((x): x is number => x !== null);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  const rowTotals = Array.from({ length: rows }, (_, r) => sum(Array.from({ length: columns }, (_, c) => cell(r, c))));
  const colTotals = Array.from({ length: columns }, (_, c) => sum(Array.from({ length: rows }, (_, r) => cell(r, c))));
  let max = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) max = Math.max(max, cell(r, c) ?? 0);
  return { rows: rowTotals, columns: colTotals, max, grand: sum(rowTotals) };
}

const HEADER_H = 26;
const MARGIN_BAR = 40;
const GAP = 2;
const MIN_CELL = 22;
const MAX_CELL = 56;

export function MatrixHeatmap({
  title,
  description,
  caveat,
  status,
  rows,
  columns,
  values,
  unit = '',
  formatValue = formatCompact,
  showTotals = true,
  defaultView,
  actions,
  width: fixedWidth,
  ariaLabel,
}: MatrixHeatmapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null);
  const liveId = useId();
  const hatchId = hatchPatternId(useId());
  const unitText = unit ? ` ${unit}` : '';

  const totals = matrixTotals(values, rows.length, columns.length);
  const anyKnown = totals.grand !== null;
  const resolvedStatus: ChartStatus = status ?? (rows.length === 0 || columns.length === 0
    ? { kind: 'empty' }
    : anyKnown ? { kind: 'ready' } : { kind: 'unknown', reason: 'no cell in this matrix was measured.' });

  const labelW = Math.max(72, Math.min(150, Math.round(width * 0.24)));
  const marginRight = showTotals ? MARGIN_BAR + 34 : 0;
  const marginTop = showTotals ? MARGIN_BAR * 0.6 : 0;
  const avail = width - labelW - marginRight;
  const cellW = Math.max(MIN_CELL, Math.min(MAX_CELL * 2, Math.floor(avail / Math.max(1, columns.length)) - GAP));
  const cellH = Math.max(MIN_CELL, Math.min(MAX_CELL, 30));
  const gridX = labelW;
  const gridY = marginTop + HEADER_H;
  const svgW = gridX + columns.length * (cellW + GAP) + marginRight;
  const svgH = gridY + rows.length * (cellH + GAP);
  const rowTotalMax = Math.max(1, ...totals.rows.map((t) => t ?? 0));
  const colTotalMax = Math.max(1, ...totals.columns.map((t) => t ?? 0));
  const showNumbers = cellW >= 28;
  const labelChars = Math.floor(labelW / 7);

  const cellValue = (r: number, c: number): number | null => {
    const v = values[r]?.[c];
    return v === undefined || v === null || !Number.isFinite(v) ? null : v;
  };
  const fraction = (v: number): number => (totals.max > 0 ? v / totals.max : 0);
  const fill = (v: number | null): string => (v === null ? `url(#${hatchId})` : v <= 0 ? heatColor(0) : quantityColor(fraction(v)));
  // A true zero sits on the faint heat-0 cell, the palest ground there is.
  const cellInk = (v: number): string => (v <= 0 ? quantityInk(0) : quantityInk(fraction(v)));
  const describe = (r: number, c: number): string => {
    const v = cellValue(r, c);
    return `${rows[r]!.label} × ${columns[c]!.label}: ${v === null ? 'not measured' : `${formatValue(v)}${unitText}`}`;
  };

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (rows.length === 0 || columns.length === 0) return;
    const cur = focus ?? { r: 0, c: 0 };
    let next: { r: number; c: number } | null = null;
    if (e.key === 'ArrowRight') next = { r: cur.r, c: cur.c + 1 };
    else if (e.key === 'ArrowLeft') next = { r: cur.r, c: cur.c - 1 };
    else if (e.key === 'ArrowDown') next = { r: cur.r + 1, c: cur.c };
    else if (e.key === 'ArrowUp') next = { r: cur.r - 1, c: cur.c };
    else if (e.key === 'Home') next = { r: cur.r, c: 0 };
    else if (e.key === 'End') next = { r: cur.r, c: columns.length - 1 };
    if (!next) return;
    e.preventDefault();
    setFocus({ r: Math.max(0, Math.min(rows.length - 1, next.r)), c: Math.max(0, Math.min(columns.length - 1, next.c)) });
  }

  let peak: { r: number; c: number; v: number } | null = null;
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < columns.length; c++) {
    const v = cellValue(r, c);
    if (v !== null && (!peak || v > peak.v)) peak = { r, c, v };
  }
  const unknownCells = rows.length * columns.length - values.flat().filter((v) => v !== null && v !== undefined).length;
  const summary = ariaLabel ?? `${title}: ${rows.length} × ${columns.length} grid, ${totals.grand === null ? 'nothing measured' : `${formatValue(totals.grand)}${unitText} in total`}` +
    (peak && peak.v > 0 ? `; most in ${rows[peak.r]!.label} × ${columns[peak.c]!.label} (${formatValue(peak.v)})` : '') +
    (unknownCells > 0 ? `; ${unknownCells} cell${unknownCells === 1 ? '' : 's'} not measured` : '') + '.';

  interface TableRow { id: string; label: string; index: number }
  const tableRows: TableRow[] = rows.map((r, index) => ({ id: r.id, label: r.label, index }));
  const tableColumns: TableColumn<TableRow>[] = [
    { key: '__row', label: '', render: (r) => r.label },
    ...columns.map((c, ci) => ({
      key: c.id,
      label: c.label,
      numeric: true,
      render: (r: TableRow) => {
        const v = cellValue(r.index, ci);
        return v === null ? '—' : formatValue(v);
      },
    })),
    { key: '__total', label: 'Total', numeric: true, render: (r) => (totals.rows[r.index] === null ? '—' : formatValue(totals.rows[r.index]!)) },
  ];

  const focusCell = focus;

  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={resolvedStatus}
      defaultView={defaultView}
      actions={actions}
      table={<TableView caption={title} columns={tableColumns} rows={tableRows} rowKey={(r) => r.id} />}
      footer={
        <div className={plot.legend} aria-hidden="true">
          <span className={plot.legendItem}>0</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={plot.swatch} style={{ background: i === 0 ? heatColor(0) : quantityColor(i / 4) }} />
          ))}
          <span className={plot.legendItem}>{totals.max > 0 ? formatValue(totals.max) : 'more'}</span>
          {unknownCells > 0 ? (
            <span className={plot.legendItem}>
              <span className={plot.swatchHatch} />
              not measured
            </span>
          ) : null}
        </div>
      }
    >
      <div
        ref={wrapRef}
        className={`${plot.plotWrap} ${plot.focusable} ${styles.scroll}`}
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the arrow keys to move between cells.`}
        aria-describedby={liveId}
        onFocus={() => setFocus((f) => f ?? { r: 0, c: 0 })}
        onBlur={() => setFocus(null)}
        onKeyDown={onKey}
      >
        <svg className={plot.svg} width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} role="img" aria-label={summary}>
          <defs>
            <HatchPattern id={hatchId} />
          </defs>
          {/* Column totals (top margin) */}
          {showTotals
            ? columns.map((c, ci) => {
                const t = totals.columns[ci] ?? null;
                const h = t === null ? 0 : Math.max(t > 0 ? 2 : 0, (t / colTotalMax) * (marginTop - 4));
                const x = gridX + ci * (cellW + GAP);
                return (
                  <g key={`ct-${c.id}`} data-col-total={c.id}>
                    {t === null ? null : <rect x={x + cellW * 0.2} y={marginTop - h} width={cellW * 0.6} height={h} rx={2} fill={CHART_SEQUENTIAL_SOFT} />}
                  </g>
                );
              })
            : null}
          {/* Column headers */}
          {columns.map((c, ci) => {
            const x = gridX + ci * (cellW + GAP);
            const chars = Math.max(2, Math.floor((cellW - (c.engine ? 16 : 0)) / 7));
            return (
              <g key={`ch-${c.id}`}>
                {c.engine ? <EngineTick engine={c.engine} x={x + 2} y={marginTop + 5} height={HEADER_H - 12} /> : null}
                <text className={plot.label} x={x + (c.engine ? 18 : cellW / 2)} y={marginTop + HEADER_H / 2} dy="0.32em" textAnchor={c.engine ? 'start' : 'middle'}>
                  {c.label.length > chars ? `${c.label.slice(0, chars - 1)}…` : c.label}
                </text>
              </g>
            );
          })}
          {rows.map((row, ri) => {
            const y = gridY + ri * (cellH + GAP);
            const t = totals.rows[ri] ?? null;
            const barW = t === null ? 0 : Math.max(t > 0 ? 2 : 0, (t / rowTotalMax) * MARGIN_BAR);
            const barX = gridX + columns.length * (cellW + GAP) + 6;
            return (
              <g key={row.id} data-row={row.id}>
                <text className={plot.label} x={labelW - 8} y={y + cellH / 2} dy="0.32em" textAnchor="end">
                  {row.label.length > labelChars ? `${row.label.slice(0, labelChars - 1)}…` : row.label}
                </text>
                {columns.map((col, ci) => {
                  const v = cellValue(ri, ci);
                  const x = gridX + ci * (cellW + GAP);
                  const isFocus = focusCell?.r === ri && focusCell.c === ci;
                  return (
                    <g key={col.id}>
                      <rect
                        data-cell={`${row.id}:${col.id}`}
                        data-value={v === null ? 'unknown' : v}
                        className={`${v === null ? plot.unknownMark : ''} ${isFocus ? styles.focus : ''}`}
                        x={v === null ? x + 0.5 : x}
                        y={v === null ? y + 0.5 : y}
                        width={v === null ? cellW - 1 : cellW}
                        height={v === null ? cellH - 1 : cellH}
                        rx={3}
                        fill={fill(v)}
                        onPointerEnter={() => setFocus({ r: ri, c: ci })}
                        onPointerLeave={() => setFocus(null)}
                      />
                      {showNumbers && v !== null ? (
                        // Plain fill picked by the cell's luminance (colors.ts
                        // quantityInk) — no halo: a surface stroke around text
                        // on a dark cell smeared "1" into a blob.
                        <text data-cell-value={`${row.id}:${col.id}`} className={styles.num} x={x + cellW / 2} y={y + cellH / 2} dy="0.32em" textAnchor="middle" fill={cellInk(v)}>
                          {formatValue(v)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
                {showTotals ? (
                  <g data-row-total={row.id}>
                    {t === null ? null : <rect x={barX} y={y + cellH * 0.25} width={barW} height={cellH * 0.5} rx={2} fill={CHART_SEQUENTIAL_SOFT} />}
                    <text className={plot.tick} x={barX + barW + 4} y={y + cellH / 2} dy="0.32em">
                      {t === null ? '—' : formatValue(t)}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </svg>
        <span id={liveId} className={plot.srOnly} aria-live="polite">
          {focusCell ? describe(focusCell.r, focusCell.c) : ''}
        </span>
        {focusCell ? (
          <ChartTooltip
            left={clampTooltipLeft(gridX + focusCell.c * (cellW + GAP) + cellW / 2, svgW, 80)}
            top={gridY + focusCell.r * (cellH + GAP)}
            title={`${rows[focusCell.r]!.label} × ${columns[focusCell.c]!.label}`}
            rows={[{ key: 'v', label: unit || 'Value', value: cellValue(focusCell.r, focusCell.c) === null ? null : formatValue(cellValue(focusCell.r, focusCell.c)!) }]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
