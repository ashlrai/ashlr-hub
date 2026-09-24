/**
 * components/charts/StepBand.tsx — a value that changes in discrete steps,
 * with an uncertainty band around each step and markers for events (V3.10,
 * SPEC-310C §5 Growth: "Harness StepBand with CI band and ▼ rollbacks").
 *
 * The harness does not drift continuously — a version is adopted, holds,
 * and is replaced or rolled back — so a smoothed line would lie about WHEN
 * things changed. Each step holds its value flat from its own time until the
 * next step (the last one holds to `now`); the band is that step's 95%
 * interval, drawn as a soft wash of the quantity ramp; an event marker (▼ for
 * a rollback, ▲ for an adoption) sits on the top edge at its time, danger for
 * rollbacks, and every marker is also a row in the table.
 *
 * Honesty: a step whose value is null (a version with no measured lift yet)
 * is a GAP in the line with the unknown hatch across its span — never a
 * carried-over value. The baseline reference (usually 0 = "the compiled
 * defaults") is a labelled dashed line.
 *
 * Keyboard: one tab stop; ←/→ (Home/End) walk the steps, each announced
 * with its interval and span.
 */
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { CHART_DIVERGING_NEG, CHART_SEQUENTIAL, CHART_SEQUENTIAL_SOFT, hatchPatternId } from './colors.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { ChartLegend, ChartTooltip, HatchPattern, clampTooltipLeft } from './ChartParts.js';
import { TableView, type TableColumn } from './TableView.js';
import { linearScale, niceTicks } from './chart-math.js';
import { formatTimeLabel } from './format.js';
import { useChartWidth } from './useChartWidth.js';
import plot from './plot.module.css';

export interface StepPoint {
  id: string;
  /** Epoch ms the step took effect. */
  at: number;
  /** The level from `at` until the next step; null = not measured. */
  value: number | null;
  /** 95% interval for this step; null / absent = no band. */
  low?: number | null;
  high?: number | null;
  /** Short name ("h-0007"). */
  label: string;
  /** One qualifier for the table and tooltip ("adopted", "canary"). */
  detail?: string;
}

export interface StepMarker {
  id: string;
  at: number;
  kind: 'rollback' | 'adopt';
  label: string;
}

export interface StepBandProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  steps: StepPoint[];
  markers?: StepMarker[];
  /** Right edge of the last step (default: now). */
  now?: number;
  /** Left edge (default: the first step). */
  from?: number;
  baseline?: { value: number; label: string };
  /** Unit word ("pts"). */
  unit?: string;
  formatValue?: (v: number) => string;
  formatTime?: (ms: number) => string;
  height?: number;
  width?: number;
  ariaLabel?: string;
}

export interface StepSpan extends StepPoint {
  /** Where this step's flat segment ends (the next step's `at`, or `now`). */
  until: number;
}

/** Sort steps by time and give each the span it holds for. Pure. */
export function stepSpans(steps: ReadonlyArray<StepPoint>, now: number): StepSpan[] {
  const sorted = [...steps].filter((s) => Number.isFinite(s.at)).sort((a, b) => a.at - b.at);
  return sorted.map((s, i) => ({ ...s, until: Math.max(s.at, i + 1 < sorted.length ? sorted[i + 1]!.at : now) }));
}

const PAD_T = 18;
const PAD_B = 26;
const PAD_R = 14;

function signed(v: number, fmt: (v: number) => string): string {
  return v > 0 ? `+${fmt(v)}` : fmt(v);
}

export function StepBand({
  title,
  description,
  caveat,
  status,
  steps,
  markers = [],
  now: nowProp,
  from: fromProp,
  baseline,
  unit = '',
  formatValue = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)),
  formatTime = formatTimeLabel,
  height = 200,
  width: fixedWidth,
  ariaLabel,
}: StepBandProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const [active, setActive] = useState<number | null>(null);
  const liveId = useId();
  const hatchId = hatchPatternId(useId());
  const unitText = unit ? ` ${unit}` : '';
  const now = nowProp ?? Date.now();
  const spans = stepSpans(steps, now);
  const known = spans.filter((s) => s.value !== null);
  const resolvedStatus: ChartStatus = status ?? (spans.length === 0
    ? { kind: 'empty', message: 'No versions yet — the compiled defaults are in force.' }
    : known.length === 0 ? { kind: 'unknown', reason: 'no version has a measured value yet.' } : { kind: 'ready' });

  const x0 = fromProp ?? spans[0]?.at ?? now - 1;
  const x1 = Math.max(now, ...spans.map((s) => s.until), ...markers.map((m) => m.at), x0 + 1);
  const ys0 = known.flatMap((s) => [s.value!, s.low ?? s.value!, s.high ?? s.value!]);
  const lo = Math.min(baseline?.value ?? 0, ...ys0);
  const hi = Math.max(baseline?.value ?? 0, ...ys0);
  const ticks = niceTicks(lo, hi === lo ? lo + 1 : hi, 4);
  const padL = Math.min(56, Math.max(30, Math.max(...ticks.map((t) => signed(t, formatValue).length)) * 7 + 10));
  const plotW = Math.max(40, width - padL - PAD_R);
  const plotH = height - PAD_T - PAD_B;
  const xs = linearScale(x0, x1, padL, padL + plotW);
  const ys = linearScale(ticks[0]!, ticks[ticks.length - 1]!, PAD_T + plotH, PAD_T);
  const cx = (t: number) => Math.min(padL + plotW, Math.max(padL, xs(t)));

  // One path per run of known steps; a null step breaks the line.
  const runs: string[] = [];
  let current: string[] = [];
  let prevY: number | null = null;
  for (const s of spans) {
    if (s.value === null) {
      if (current.length) runs.push(current.join(' '));
      current = [];
      prevY = null;
      continue;
    }
    const y = ys(s.value);
    const a = cx(s.at);
    const b = cx(s.until);
    current.push(prevY === null ? `M${a.toFixed(1)},${y.toFixed(1)}` : `L${a.toFixed(1)},${y.toFixed(1)}`);
    current.push(`L${b.toFixed(1)},${y.toFixed(1)}`);
    prevY = y;
  }
  if (current.length) runs.push(current.join(' '));

  const spoken = (s: StepSpan): string =>
    `${s.label}${s.detail ? ` (${s.detail})` : ''}, ${formatTime(s.at)} to ${formatTime(s.until)}: ` +
    (s.value === null
      ? 'not measured'
      : `${signed(s.value, formatValue)}${unitText}` +
        (s.low !== null && s.low !== undefined && s.high !== null && s.high !== undefined
          ? `, 95% interval ${signed(s.low, formatValue)} to ${signed(s.high, formatValue)}`
          : ''));

  const last = known[known.length - 1];
  const rollbacks = markers.filter((m) => m.kind === 'rollback').length;
  const summary = ariaLabel ?? `${title}: ${spans.length} step${spans.length === 1 ? '' : 's'}` +
    (last ? `, now ${signed(last.value!, formatValue)}${unitText}` : '') +
    (rollbacks ? `, ${rollbacks} rollback${rollbacks === 1 ? '' : 's'}` : '') + '.';

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (spans.length === 0) return;
    const cur = active ?? spans.length - 1;
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? spans.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(spans.length - 1, next)));
  }

  interface Row { id: string; when: number; what: string; value: string; interval: string }
  const tableRows: Row[] = [
    ...spans.map((s) => ({
      id: `s:${s.id}`,
      when: s.at,
      what: `${s.label}${s.detail ? ` · ${s.detail}` : ''}`,
      value: s.value === null ? '—' : signed(s.value, formatValue),
      interval: s.low === null || s.low === undefined || s.high === null || s.high === undefined ? '—' : `${signed(s.low, formatValue)} to ${signed(s.high, formatValue)}`,
    })),
    ...markers.map((m) => ({ id: `m:${m.id}`, when: m.at, what: `${m.kind === 'rollback' ? '▼ Rolled back' : '▲ Adopted'}: ${m.label}`, value: '', interval: '' })),
  ].sort((a, b) => a.when - b.when);
  const columns: TableColumn<Row>[] = [
    { key: 'when', label: 'When', render: (r) => formatTime(r.when) },
    { key: 'what', label: 'Step', render: (r) => r.what },
    { key: 'value', label: `Level${unitText}`, numeric: true, render: (r) => r.value },
    { key: 'ci', label: '95% interval', numeric: true, render: (r) => r.interval },
  ];

  const activeSpan = active !== null ? spans[active] : undefined;

  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={resolvedStatus}
      table={<TableView caption={title} columns={columns} rows={tableRows} rowKey={(r) => r.id} />}
      footer={
        <ChartLegend
          items={[
            { label: 'Level', color: CHART_SEQUENTIAL, kind: 'line' },
            { label: '95% interval', color: CHART_SEQUENTIAL_SOFT },
            ...(rollbacks ? [{ label: '▼ rollback', color: CHART_DIVERGING_NEG }] : []),
            ...(spans.some((s) => s.value === null) ? [{ label: 'not measured', kind: 'hatch' as const }] : []),
          ]}
        />
      }
    >
      <div
        ref={wrapRef}
        className={`${plot.plotWrap} ${plot.focusable}`}
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the left and right arrow keys to read each step.`}
        aria-describedby={liveId}
        onFocus={() => setActive((a) => a ?? (spans.length ? spans.length - 1 : null))}
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
              <text className={plot.tick} x={padL - 6} y={ys(t)} dy="0.32em" textAnchor="end">{t === 0 ? '0' : signed(t, formatValue)}</text>
            </g>
          ))}
          <text className={plot.tick} x={padL} y={height - 8} textAnchor="start">{formatTime(x0)}</text>
          <text className={plot.tick} x={padL + plotW} y={height - 8} textAnchor="end">{formatTime(x1)}</text>
          {baseline ? (
            <g data-role="baseline">
              <line className={plot.reference} x1={padL} x2={padL + plotW} y1={ys(baseline.value)} y2={ys(baseline.value)} />
              <text className={`${plot.tick} ${plot.halo}`} x={padL + 4} y={ys(baseline.value) - 5}>{baseline.label}</text>
            </g>
          ) : null}
          {spans.map((s, i) => {
            const a = cx(s.at);
            const b = Math.max(a + 1, cx(s.until));
            if (s.value === null) {
              return (
                <rect key={s.id} data-step={s.id} data-unknown="true" className={plot.unknownMark} fill={`url(#${hatchId})`} x={a} y={PAD_T} width={b - a} height={plotH} opacity={0.6} />
              );
            }
            const hasBand = s.low !== null && s.low !== undefined && s.high !== null && s.high !== undefined;
            return (
              <g key={s.id} data-step={s.id} opacity={active !== null && active !== i ? 0.6 : 1}>
                {hasBand ? (
                  <rect data-role="band" x={a} y={ys(s.high!)} width={b - a} height={Math.max(1, ys(s.low!) - ys(s.high!))} fill={CHART_SEQUENTIAL_SOFT} opacity={0.35} />
                ) : null}
              </g>
            );
          })}
          {runs.map((d, i) => (
            <path key={i} data-role="level" className={plot.line} stroke={CHART_SEQUENTIAL} d={d} />
          ))}
          {spans.map((s) =>
            s.value === null ? null : <circle key={`p${s.id}`} className={plot.marker} cx={cx(s.at)} cy={ys(s.value)} r={3.5} fill={CHART_SEQUENTIAL} />,
          )}
          {markers.map((m) => {
            const x = cx(m.at);
            const y = PAD_T - 2;
            const d = m.kind === 'rollback' ? `M${x - 5},${y - 8} L${x + 5},${y - 8} L${x},${y} Z` : `M${x - 5},${y} L${x + 5},${y} L${x},${y - 8} Z`;
            return (
              <path key={m.id} data-marker={m.kind} d={d} fill={m.kind === 'rollback' ? CHART_DIVERGING_NEG : CHART_SEQUENTIAL}>
                <title>{`${m.kind === 'rollback' ? 'Rolled back' : 'Adopted'}: ${m.label} · ${formatTime(m.at)}`}</title>
              </path>
            );
          })}
        </svg>
        <span id={liveId} className={plot.srOnly} aria-live="polite">{activeSpan ? spoken(activeSpan) : ''}</span>
        {activeSpan ? (
          <ChartTooltip
            left={clampTooltipLeft((cx(activeSpan.at) + cx(activeSpan.until)) / 2, width)}
            top={activeSpan.value === null ? PAD_T + plotH / 2 : ys(activeSpan.high ?? activeSpan.value)}
            title={`${activeSpan.label}${activeSpan.detail ? ` · ${activeSpan.detail}` : ''}`}
            rows={[
              { key: 'v', label: 'Level', value: activeSpan.value === null ? null : `${signed(activeSpan.value, formatValue)}${unitText}` },
              {
                key: 'ci',
                label: '95% interval',
                value: activeSpan.low === null || activeSpan.low === undefined || activeSpan.high === null || activeSpan.high === undefined
                  ? null
                  : `${signed(activeSpan.low, formatValue)} to ${signed(activeSpan.high, formatValue)}`,
              },
              { key: 't', label: 'From', value: formatTime(activeSpan.at) },
            ]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
