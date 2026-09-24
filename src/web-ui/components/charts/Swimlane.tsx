/**
 * components/charts/Swimlane.tsx — who ran what, when: one row (lane) per repo
 * or agent, one bar per run from its start to its end, coloured by STATUS
 * (the StatusBadge tones — state, not identity — always with a text legend).
 *
 * Open-ended work: a bar with `end: null` extends to `now` and gets an open
 * right edge; a `stale` one (running on disk, silent for a long time) is drawn
 * faded and says so in its tooltip and the table.
 *
 * V3.10: a lane may carry its ENGINE — drawn as the 2px identity tick and
 * the C/X/G/L monogram beside the label (never a vendor logo, and never the
 * bar fill: bars keep STATUS colour). Queued and parked work draws as a
 * neutral OUTLINE with no fill ("not running yet" must not look like a
 * status), and an unknown status draws as the 45° unknown hatch.
 *
 * Scale: past VIRTUALIZE_AFTER lanes the body becomes a fixed-height scroller
 * that renders only the rows in view (plus overscan), so a 500-lane history
 * costs the same DOM as a 20-lane one. Each lane is a keyboard stop with a
 * spoken summary; every run is in the Table view.
 */
import { useId, useMemo, useRef, useState, type UIEvent } from 'react';
import { CHART_QUEUED_OUTLINE, hatchPatternId, toneColor, type ChartEngine, type ChartTone } from './colors.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { ChartLegend, ChartTooltip, EngineTick, HatchPattern, clampTooltipLeft, type ChartLegendItem } from './ChartParts.js';
import { TableView, type TableColumn } from './TableView.js';
import { MIN_TIME_SPAN_MS, ensureSpan, isPlausibleTime, labelCharPx, layoutAxisLabels, linearScale } from './chart-math.js';
import { useChartWidth } from './useChartWidth.js';
import { useTextScale } from './useTextScale.js';
import plot from './plot.module.css';
import styles from './Swimlane.module.css';

export interface SwimlaneItem {
  id: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms; null while still running. */
  end: number | null;
  /** Free-form status string (done / failed / aborted / running …). */
  status: string;
  /** Optional short text for tooltip and table (e.g. the engine). */
  detail?: string;
  stale?: boolean;
  /**
   * Draw as an outline with no fill — queued / parked work that holds a place
   * in line but is not running. Defaults to true for the statuses in
   * OUTLINE_STATUSES.
   */
  outline?: boolean;
}

export interface SwimlaneLane {
  id: string;
  label: string;
  items: SwimlaneItem[];
  /** The lane's engine: a 2px identity tick + monogram beside the label. */
  engine?: ChartEngine;
}

/** Statuses that draw as an outline by default (they hold a place; nothing runs). */
export const OUTLINE_STATUSES: ReadonlySet<string> = new Set(['queued', 'parked', 'waiting']);

function isOutline(item: SwimlaneItem): boolean {
  return item.outline ?? OUTLINE_STATUSES.has(item.status.toLowerCase());
}

export interface SwimlaneProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  lanes: SwimlaneLane[];
  /** Visible time window, epoch ms. */
  from: number;
  to: number;
  /** "Now" for open-ended bars (defaults to `to`). */
  now?: number;
  width?: number;
  /** Map a status string to a tone. Defaults to the StatusBadge vocabulary subset below. */
  toneOf?: (status: string) => ChartTone;
  /** Full timestamp for tooltip and table. */
  formatTime?: (ms: number) => string;
  /** Axis tick label. Defaults to a span-aware short form (dates past 36 h, clock times below). */
  formatTick?: (ms: number) => string;
  ariaLabel?: string;
}

export const ROW_H = 24;
export const VIRTUALIZE_AFTER = 50;
const VIEWPORT_ROWS = 14;
const OVERSCAN = 6;
const AXIS_H = 22;
const MIN_BAR_W = 3;

const DEFAULT_TONES: Record<string, ChartTone> = {
  done: 'success',
  success: 'success',
  merged: 'success',
  failed: 'danger',
  error: 'danger',
  aborted: 'neutral',
  cancelled: 'neutral',
  running: 'running',
  queued: 'neutral',
  parked: 'neutral',
};

function defaultToneOf(status: string): ChartTone {
  return DEFAULT_TONES[status.toLowerCase()] ?? 'unknown';
}

function defaultFormatTime(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Short axis labels: long windows get dates, short ones get clock times — full timestamps collide. */
export function spanTickFormatter(from: number, to: number): (ms: number) => string {
  const long = to - from > 36 * 3_600_000;
  return (ms) => {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return long
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
}

function truncateLabel(label: string, chars: number): string {
  return label.length > chars ? `${label.slice(0, Math.max(1, chars - 1))}…` : label;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}

interface FlatItem extends SwimlaneItem {
  lane: string;
  engine: ChartEngine | undefined;
}

export function Swimlane({
  title,
  description,
  caveat,
  status,
  lanes,
  from: fromProp,
  to: toProp,
  now,
  width: fixedWidth,
  toneOf = defaultToneOf,
  formatTime = defaultFormatTime,
  formatTick,
  ariaLabel,
}: SwimlaneProps) {
  // A window bound of 0 / NaN / pre-2000 is a null timestamp that leaked
  // through; fall back to the runs themselves (then to a day ending now), and
  // widen a degenerate window so its ticks are distinct times.
  const itemTimes = lanes.flatMap((l) => l.items.flatMap((i) => [i.start, i.end ?? Number.NaN])).filter(isPlausibleTime);
  const toBound = isPlausibleTime(toProp)
    ? toProp
    : now !== undefined && isPlausibleTime(now) ? now : itemTimes.length ? Math.max(...itemTimes) : Date.now();
  const fromBound = isPlausibleTime(fromProp) ? fromProp : itemTimes.length ? Math.min(...itemTimes) : toBound - 86_400_000;
  const [from, to] = ensureSpan(fromBound, toBound, MIN_TIME_SPAN_MS, 'end');
  const tickLabel = formatTick ?? spanTickFormatter(from, to);
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const textScale = useTextScale();
  const [scrollTop, setScrollTop] = useState(0);
  const [hover, setHover] = useState<{ lane: number; item: number } | null>(null);
  const liveId = useId();
  const hatchId = hatchPatternId(useId());
  const nowMs = now ?? to;

  const itemCount = lanes.reduce((n, l) => n + l.items.length, 0);
  const resolvedStatus: ChartStatus = status ?? (itemCount === 0 ? { kind: 'empty', message: 'No runs in this window.' } : { kind: 'ready' });

  // Narrow screens give the labels less room, never less than a readable 72 px
  // (plus room for the engine tick and monogram when lanes carry one).
  const tickW = lanes.some((l) => l.engine !== undefined) ? 18 : 0;
  const labelW = Math.max(72, Math.min(160, Math.round(width * 0.24))) + tickW;
  // 7 px a character at 12 px text, scaled to the Display size.
  const labelChars = Math.floor((labelW - tickW) / (7 * textScale));
  const plotW = Math.max(40, width - labelW - 8);
  const xs = linearScale(from, Math.max(to, from + 1), labelW, labelW + plotW);
  const virtual = lanes.length > VIRTUALIZE_AFTER;
  const first = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0;
  const last = virtual ? Math.min(lanes.length, Math.ceil(scrollTop / ROW_H) + VIEWPORT_ROWS + OVERSCAN) : lanes.length;
  const bodyH = lanes.length * ROW_H;

  // Legend: one entry per drawn style — a status tone, the outline (queued /
  // parked) or the unknown hatch — each named by the statuses it stands for.
  const legendItems = useMemo((): ChartLegendItem[] => {
    const seen = new Map<string, { item: Omit<ChartLegendItem, 'label'>; names: Set<string> }>();
    for (const lane of lanes) for (const item of lane.items) {
      const tone = toneOf(item.status);
      const key = isOutline(item) ? 'outline' : tone === 'unknown' ? 'hatch' : tone;
      const style: Omit<ChartLegendItem, 'label'> = key === 'outline' ? { kind: 'empty' } : key === 'hatch' ? { kind: 'hatch' } : { color: toneColor(tone) };
      if (!seen.has(key)) seen.set(key, { item: style, names: new Set() });
      seen.get(key)!.names.add(item.status.toLowerCase());
    }
    return [...seen.values()].map(({ item, names }) => ({ ...item, label: [...names].sort().join(' / ') }));
  }, [lanes, toneOf]);
  const anyEngine = lanes.some((l) => l.engine !== undefined);

  const ticks = useMemo(() => {
    const count = Math.max(2, Math.floor(plotW / 90));
    const step = (to - from) / Math.max(1, count);
    return Array.from({ length: count + 1 }, (_, i) => from + step * i);
  }, [from, to, plotW]);

  const flat: FlatItem[] = useMemo(
    () => lanes.flatMap((lane) => lane.items.map((item) => ({ ...item, lane: lane.label, engine: lane.engine }))),
    [lanes],
  );

  function laneSummary(lane: SwimlaneLane): string {
    const counts = new Map<string, number>();
    for (const item of lane.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} ${s}`);
    const engine = lane.engine ? ` (${lane.engine})` : '';
    return `${lane.label}${engine}: ${lane.items.length} run${lane.items.length === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  }

  const summary = ariaLabel ?? `${title}: ${itemCount} runs across ${lanes.length} lanes from ${formatTime(from)} to ${formatTime(to)}.`;

  const columns: TableColumn<FlatItem>[] = [
    { key: 'lane', label: 'Lane', render: (r) => r.lane },
    ...(anyEngine ? [{ key: 'engine', label: 'Engine', render: (r: FlatItem) => r.engine ?? '—' }] : []),
    { key: 'status', label: 'Status', render: (r) => `${r.status}${r.stale ? ' (stale)' : ''}` },
    { key: 'start', label: 'Started', render: (r) => formatTime(r.start) },
    { key: 'dur', label: 'Duration', numeric: true, render: (r) => (r.end === null ? `${formatDuration(nowMs - r.start)}+` : formatDuration(r.end - r.start)) },
    { key: 'detail', label: 'Detail', render: (r) => r.detail ?? '' },
  ];

  const hovered = hover ? lanes[hover.lane]?.items[hover.item] : undefined;

  function renderLane(lane: SwimlaneLane, index: number) {
    const y = index * ROW_H;
    return (
      <g key={lane.id} data-lane={lane.id}>
        {index % 2 === 1 ? <rect className={styles.band} x={0} y={y} width={width} height={ROW_H} /> : null}
        {lane.engine ? <EngineTick engine={lane.engine} x={2} y={y + 5} height={ROW_H - 10} /> : null}
        <text className={plot.label} x={labelW - 8} y={y + ROW_H / 2} dy="0.32em" textAnchor="end">
          {truncateLabel(lane.label, labelChars)}
        </text>
        {lane.items.map((item, itemIndex) => {
          const start = Math.max(from, item.start);
          const endMs = Math.min(to, item.end ?? nowMs);
          if (endMs < from || start > to) return null;
          const x0 = xs(start);
          const w = Math.max(MIN_BAR_W, xs(Math.max(endMs, start)) - x0);
          const tone = toneOf(item.status);
          const outline = isOutline(item);
          const unknown = !outline && tone === 'unknown';
          return (
            <rect
              key={item.id}
              data-item={item.id}
              data-status={item.status}
              data-open={item.end === null ? 'true' : undefined}
              data-style={outline ? 'outline' : unknown ? 'hatch' : 'fill'}
              className={`${styles.bar} ${item.stale ? styles.stale : ''} ${item.end === null ? styles.open : ''} ${outline ? styles.outline : ''} ${unknown ? plot.unknownMark : ''}`}
              x={outline ? x0 + 0.5 : x0}
              y={outline ? y + 5.5 : y + 5}
              width={outline ? Math.max(MIN_BAR_W, w - 1) : w}
              height={outline ? ROW_H - 11 : ROW_H - 10}
              rx={3}
              fill={outline ? 'none' : unknown ? `url(#${hatchId})` : toneColor(tone)}
              stroke={outline ? CHART_QUEUED_OUTLINE : undefined}
              onPointerEnter={() => setHover({ lane: index, item: itemIndex })}
              onPointerLeave={() => setHover((h) => (h && h.lane === index && h.item === itemIndex ? null : h))}
            />
          );
        })}
      </g>
    );
  }

  // Tick labels never overprint: the window's end outranks its start, and an
  // interior tick whose label would touch a neighbour is dropped (its
  // gridline stays).
  const tickLabels = layoutAxisLabels(
    ticks.map((t, i) => ({
      key: String(i),
      x: xs(t),
      anchor: i === 0 ? 'start' as const : i === ticks.length - 1 ? 'end' as const : 'middle' as const,
      priority: i === ticks.length - 1 ? 3 : i === 0 ? 2 : 1,
      required: i === 0 || i === ticks.length - 1,
      variants: [tickLabel(t)],
    })),
    { min: labelW, max: labelW + plotW, charPx: labelCharPx(textScale) },
  );

  const axis = (
    <svg className={plot.svg} width={width} height={AXIS_H} viewBox={`0 0 ${width} ${AXIS_H}`} aria-hidden="true">
      <line className={plot.axis} x1={labelW} x2={labelW + plotW} y1={AXIS_H - 1} y2={AXIS_H - 1} />
      {tickLabels.map((l) => (
        <text key={l.key} data-axis-label={l.key} className={plot.tick} x={l.x} y={AXIS_H - 7} textAnchor={l.anchor}>
          {l.text}
        </text>
      ))}
    </svg>
  );

  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={resolvedStatus}
      table={<TableView caption={title} columns={columns} rows={flat} rowKey={(r) => r.id} />}
      footer={<ChartLegend min={1} items={legendItems} />}
    >
      <div ref={wrapRef} className={plot.plotWrap}>
        {axis}
        <div
          className={virtual ? styles.scroller : undefined}
          style={virtual ? { height: VIEWPORT_ROWS * ROW_H } : undefined}
          onScroll={virtual ? (e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop) : undefined}
          data-virtualized={virtual ? 'true' : undefined}
        >
          <svg className={plot.svg} width={width} height={bodyH} viewBox={`0 0 ${width} ${bodyH}`} role="img" aria-label={summary}>
            <defs>
              <HatchPattern id={hatchId} />
            </defs>
            {ticks.map((t) => (
              <line key={t} className={plot.grid} x1={xs(t)} x2={xs(t)} y1={0} y2={bodyH} />
            ))}
            {nowMs >= from && nowMs <= to ? (
              <line className={styles.now} x1={xs(nowMs)} x2={xs(nowMs)} y1={0} y2={bodyH} />
            ) : null}
            {lanes.slice(first, last).map((lane, i) => renderLane(lane, first + i))}
          </svg>
          {/* Keyboard + screen-reader lane list, overlaid on the rows it describes. */}
          <ul className={styles.laneStops} style={{ height: bodyH }} aria-label={`${title} lanes`} aria-describedby={liveId}>
            {lanes.slice(first, last).map((lane, i) => (
              <li
                key={lane.id}
                tabIndex={0}
                className={`${styles.laneStop} ${plot.focusable}`}
                style={{ top: (first + i) * ROW_H, height: ROW_H }}
                aria-label={laneSummary(lane)}
                onFocus={() => setHover(lane.items.length ? { lane: first + i, item: lane.items.length - 1 } : null)}
                onBlur={() => setHover(null)}
              />
            ))}
          </ul>
        </div>
        <span id={liveId} className={plot.srOnly}>Each lane lists its runs by status; open the Table view for every run.</span>
        {hover && hovered ? (
          <ChartTooltip
            left={clampTooltipLeft(xs(Math.max(from, hovered.start)), width)}
            top={AXIS_H + hover.lane * ROW_H - (virtual ? scrollTop : 0)}
            title={lanes[hover.lane]!.label}
            rows={[
              {
                key: 's',
                label: 'Status',
                value: `${hovered.status}${hovered.stale ? ' (stale)' : ''}`,
                ...(isOutline(hovered) || toneOf(hovered.status) === 'unknown' ? {} : { color: toneColor(toneOf(hovered.status)) }),
              },
              { key: 't', label: 'Started', value: formatTime(hovered.start) },
              {
                key: 'd',
                label: 'Duration',
                value: hovered.end === null ? `${formatDuration(nowMs - hovered.start)} so far` : formatDuration(hovered.end - hovered.start),
              },
              ...(hovered.detail ? [{ key: 'x', label: 'Detail', value: hovered.detail }] : []),
            ]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
