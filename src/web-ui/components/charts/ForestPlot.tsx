/**
 * components/charts/ForestPlot.tsx — one row per experiment: the point
 * estimate with its 95% confidence interval as a whisker, against a zero line
 * (V3.10, SPEC-310C §5 Growth; r5/visual.md §2 "ForestPlot").
 *
 * The question it answers is "which changes REALLY helped?", so the encoding
 * is about the interval, not the dot:
 *   - interval entirely above zero → the positive diverging pole (azure),
 *   - entirely below zero          → the negative pole (danger),
 *   - straddling zero              → neutral ink ("no detectable effect"),
 * and the verdict is also written in words in every row's spoken label and
 * in the table — colour is never the only carrier.
 *
 * Honesty: a row whose estimate is still null (fewer pairs than the gate
 * needs) draws the unknown hatch across the plot with "not enough pairs yet",
 * never a dot at zero. An optional `gate` draws the adoption threshold as a
 * labelled dashed reference (the gate is "CI low > gate", SPEC-310B §5).
 *
 * Keyboard: the plot is one tab stop; ↑/↓ (Home/End) walk the rows and the
 * focused row is announced. Works at 375 px: the numeric column folds away
 * (it is in the table) and labels truncate with the full text spoken.
 */
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { CHART_DIVERGING_MID, CHART_DIVERGING_NEG, CHART_DIVERGING_POS, hatchPatternId } from './colors.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { ChartLegend, HatchPattern } from './ChartParts.js';
import { TableView, type TableColumn } from './TableView.js';
import { allIntegers, axisTicks, linearScale } from './chart-math.js';
import { useChartWidth } from './useChartWidth.js';
import plot from './plot.module.css';
import styles from './ForestPlot.module.css';

export interface ForestRow {
  id: string;
  label: string;
  /** Point estimate (e.g. lift in percentage points); null = not estimable yet. */
  estimate: number | null;
  /** 95% CI bounds; null when the estimate is null. */
  low: number | null;
  high: number | null;
  /** Sample size behind the row (pairs); null = unknown. */
  n?: number | null;
  /** One short qualifier for the table ("adopted", "running", "rejected"). */
  detail?: string;
}

export interface ForestPlotProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  rows: ForestRow[];
  /** Unit word after numbers in words and the table ("pts"). */
  unit?: string;
  /** A labelled reference the CI low must clear, e.g. { value: 0, label: 'Adoption gate' }. Drawn only when ≠ 0. */
  gate?: { value: number; label: string };
  formatValue?: (v: number) => string;
  /** What an unknown row says (default "not enough pairs yet"). */
  unknownText?: string;
  width?: number;
  ariaLabel?: string;
}

export type ForestVerdict = 'positive' | 'negative' | 'none' | 'unknown';

/** Where a row's interval sits relative to zero. */
export function forestVerdict(row: Pick<ForestRow, 'estimate' | 'low' | 'high'>): ForestVerdict {
  if (row.estimate === null || row.low === null || row.high === null) return 'unknown';
  if (row.low > 0) return 'positive';
  if (row.high < 0) return 'negative';
  return 'none';
}

const VERDICT_WORDS: Record<ForestVerdict, string> = {
  positive: 'helped (interval above zero)',
  negative: 'hurt (interval below zero)',
  none: 'no clear effect (interval crosses zero)',
  unknown: 'unknown',
};

function verdictColor(verdict: ForestVerdict): string {
  if (verdict === 'positive') return CHART_DIVERGING_POS;
  if (verdict === 'negative') return CHART_DIVERGING_NEG;
  return 'var(--text-secondary)';
}

function signed(v: number, fmt: (v: number) => string): string {
  return v > 0 ? `+${fmt(v)}` : fmt(v);
}

const defaultFormatValue = (v: number): string => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));

const ROW_H = 28;
const AXIS_H = 22;
const PAD_R = 12;
const NARROW = 480;

export function ForestPlot({
  title,
  description,
  caveat,
  status,
  rows,
  unit = '',
  gate,
  formatValue: formatValueProp,
  unknownText = 'not enough pairs yet',
  width: fixedWidth,
  ariaLabel,
}: ForestPlotProps) {
  const formatValue = formatValueProp ?? defaultFormatValue;
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const [active, setActive] = useState<number | null>(null);
  const liveId = useId();
  const hatchId = hatchPatternId(useId());
  const unitText = unit ? ` ${unit}` : '';

  const known = rows.filter((r) => forestVerdict(r) !== 'unknown');
  const resolvedStatus: ChartStatus = status ?? (rows.length === 0 ? { kind: 'empty', message: 'No experiments have run yet.' } : { kind: 'ready' });

  const narrow = width < NARROW;
  const labelW = Math.max(84, Math.min(180, Math.round(width * (narrow ? 0.3 : 0.26))));
  const valueW = narrow ? 0 : 118;
  const plotX0 = labelW + 8;
  const plotX1 = Math.max(plotX0 + 40, width - valueW - PAD_R);
  const bounds = known.flatMap((r) => [r.low!, r.high!]);
  const lo = Math.min(0, gate?.value ?? 0, ...bounds);
  const hi = Math.max(0, gate?.value ?? 0, ...bounds);
  // Tick labels at the step's own precision (a lift axis of 0.25 steps
  // printed at one decimal read "+0.3 / +0.8"); a caller's formatter is
  // held to printing every tick faithfully.
  const xAxis = axisTicks(lo, hi === lo ? lo + 1 : hi, {
    count: narrow ? 3 : 5,
    integer: allIntegers([...bounds, gate?.value ?? 0]),
    format: formatValueProp ? (t) => (t === 0 ? '0' : signed(t, formatValueProp)) : undefined,
  });
  const ticks = xAxis.ticks;
  const tickLabels = formatValueProp ? xAxis.labels : xAxis.labels.map((l, i) => (ticks[i]! > 0 ? `+${l}` : l));
  const xs = linearScale(ticks[0]!, ticks[ticks.length - 1]!, plotX0, plotX1);
  const bodyH = rows.length * ROW_H;
  const svgH = bodyH + AXIS_H;

  const spoken = (r: ForestRow): string => {
    const v = forestVerdict(r);
    if (v === 'unknown') return `${r.label}: ${unknownText}`;
    return `${r.label}: ${signed(r.estimate!, formatValue)}${unitText}, 95% interval ${signed(r.low!, formatValue)} to ${signed(r.high!, formatValue)}; ${VERDICT_WORDS[v]}`;
  };

  const positive = known.filter((r) => forestVerdict(r) === 'positive').length;
  const summary = ariaLabel ?? `${title}: ${rows.length} experiment${rows.length === 1 ? '' : 's'}, ${positive} with an interval above zero.`;

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (rows.length === 0) return;
    const cur = active ?? 0;
    const next = e.key === 'ArrowDown' ? cur + 1 : e.key === 'ArrowUp' ? cur - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(rows.length - 1, next)));
  }

  const columns: TableColumn<ForestRow>[] = [
    { key: 'label', label: 'Experiment', render: (r) => r.label },
    { key: 'est', label: `Estimate${unitText}`, numeric: true, render: (r) => (r.estimate === null ? '—' : signed(r.estimate, formatValue)) },
    {
      key: 'ci',
      label: '95% interval',
      numeric: true,
      render: (r) => (r.low === null || r.high === null ? '—' : `${signed(r.low, formatValue)} to ${signed(r.high, formatValue)}`),
    },
    { key: 'n', label: 'Pairs', numeric: true, render: (r) => (r.n === null || r.n === undefined ? '—' : String(r.n)) },
    { key: 'verdict', label: 'Reading', render: (r) => (forestVerdict(r) === 'unknown' ? unknownText : VERDICT_WORDS[forestVerdict(r)]) },
    ...(rows.some((r) => r.detail) ? [{ key: 'detail', label: 'Status', render: (r: ForestRow) => r.detail ?? '' }] : []),
  ];

  const activeRow = active !== null ? rows[active] : undefined;
  const labelChars = Math.floor(labelW / 7);

  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={resolvedStatus}
      table={<TableView caption={title} columns={columns} rows={rows} rowKey={(r) => r.id} />}
      footer={
        <ChartLegend
          min={1}
          items={[
            { label: 'Helped', color: CHART_DIVERGING_POS },
            { label: 'Hurt', color: CHART_DIVERGING_NEG },
            { label: 'No clear effect', color: 'var(--text-secondary)' },
            ...(rows.length > known.length ? [{ label: unknownText, kind: 'hatch' as const }] : []),
          ]}
        />
      }
    >
      <div
        ref={wrapRef}
        className={`${plot.plotWrap} ${plot.focusable}`}
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the up and down arrow keys to read each experiment.`}
        aria-describedby={liveId}
        onFocus={() => setActive((a) => a ?? (rows.length ? 0 : null))}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        <svg className={plot.svg} width={width} height={svgH} viewBox={`0 0 ${width} ${svgH}`} role="img" aria-label={summary}>
          <defs>
            <HatchPattern id={hatchId} />
          </defs>
          {ticks.map((t, i) => (
            <g key={t}>
              <line className={plot.grid} x1={xs(t)} x2={xs(t)} y1={0} y2={bodyH} />
              <text className={plot.tick} x={xs(t)} y={svgH - 6} textAnchor="middle">
                {tickLabels[i]}
              </text>
            </g>
          ))}
          <line data-role="zero" x1={xs(0)} x2={xs(0)} y1={0} y2={bodyH} stroke={CHART_DIVERGING_MID} strokeWidth={1.5} />
          {gate && gate.value !== 0 ? (
            <g data-role="gate">
              <line className={plot.reference} x1={xs(gate.value)} x2={xs(gate.value)} y1={0} y2={bodyH} />
            </g>
          ) : null}
          {rows.map((r, i) => {
            const y = i * ROW_H + ROW_H / 2;
            const v = forestVerdict(r);
            const color = verdictColor(v);
            const isActive = active === i;
            return (
              <g key={r.id} data-row={r.id} data-verdict={v} opacity={active !== null && !isActive ? 0.55 : 1}>
                {i % 2 === 1 ? <rect className={styles.band} x={0} y={i * ROW_H} width={width} height={ROW_H} /> : null}
                <text className={plot.label} x={labelW} y={y} dy="0.32em" textAnchor="end">
                  {r.label.length > labelChars ? `${r.label.slice(0, labelChars - 1)}…` : r.label}
                </text>
                {v === 'unknown' ? (
                  <g data-role="unknown">
                    <rect
                      className={plot.unknownMark}
                      fill={`url(#${hatchId})`}
                      x={plotX0 + 0.5}
                      y={y - 5}
                      width={Math.max(1, plotX1 - plotX0 - 1)}
                      height={10}
                      rx={2}
                    />
                    {!narrow ? (
                      <text className={plot.tick} x={width - PAD_R} y={y} dy="0.32em" textAnchor="end">{unknownText}</text>
                    ) : null}
                  </g>
                ) : (
                  <g>
                    <line data-role="ci" x1={xs(r.low!)} x2={xs(r.high!)} y1={y} y2={y} stroke={color} strokeWidth={2} strokeLinecap="round" />
                    <line x1={xs(r.low!)} x2={xs(r.low!)} y1={y - 5} y2={y + 5} stroke={color} strokeWidth={1.5} />
                    <line x1={xs(r.high!)} x2={xs(r.high!)} y1={y - 5} y2={y + 5} stroke={color} strokeWidth={1.5} />
                    <rect
                      data-role="estimate"
                      className={plot.marker}
                      x={xs(r.estimate!) - 5}
                      y={y - 5}
                      width={10}
                      height={10}
                      rx={2}
                      fill={color}
                    />
                    {!narrow ? (
                      <text className={plot.tick} x={width - PAD_R} y={y} dy="0.32em" textAnchor="end">
                        {signed(r.estimate!, formatValue)} [{signed(r.low!, formatValue)}, {signed(r.high!, formatValue)}]
                      </text>
                    ) : null}
                  </g>
                )}
                {isActive ? <rect className={styles.focusRing} x={1} y={i * ROW_H + 1} width={width - 2} height={ROW_H - 2} rx={3} /> : null}
              </g>
            );
          })}
        </svg>
        <span id={liveId} className={plot.srOnly} aria-live="polite">
          {activeRow ? spoken(activeRow) : ''}
        </span>
      </div>
    </ChartFrame>
  );
}
