/**
 * components/charts/Gauge.tsx — one fraction on a 180° arc: how much of a
 * window is used, how close a cap is. The fill carries SEVERITY (accent →
 * warning → danger at the thresholds) over a track that is a lighter step of
 * the same ramp; an optional marker shows a line that matters (e.g. the
 * reserve kept for interactive use). The number and a words-first state label
 * sit under the arc, so severity is never colour alone.
 *
 * Honesty: `null` is UNKNOWN — an empty track and "unknown", never 0%. Values
 * past 100% are drawn full and printed as they are ("112%").
 *
 * Semantics: role="meter" with aria-valuenow/min/max/valuetext.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { CHART_SEQUENTIAL, CHART_TRACK, hatchPatternId, toneColor } from './colors.js';
import { HatchPattern } from './ChartParts.js';
import { ChartFrame, type ChartStatus } from './ChartFrame.js';
import { TableView, type TableColumn } from './TableView.js';
import { gaugeArc, gaugeSeverity, polar, type GaugeSeverity } from './chart-math.js';
import { formatPercent } from './format.js';
import plot from './plot.module.css';
import styles from './Gauge.module.css';

export interface GaugeProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  /** Fraction used, 0..1 (may exceed 1). null = unknown. */
  value: number | null;
  /** Severity thresholds as fractions (defaults 0.7 / 0.9). */
  warnAt?: number;
  dangerAt?: number;
  /** A reference line on the arc, e.g. { value: 0.6, label: 'Autonomy cap' }. */
  marker?: { value: number; label: string };
  /** Words under the number, e.g. "resets in 2h". */
  caption?: string;
  /**
   * The LARGEST diameter in px (default 180). V3.10: the gauge fits its
   * container — two gauges side by side at 375 px each shrink (never below
   * MIN_GAUGE_SIZE) instead of widening the page.
   */
  size?: number;
  formatValue?: (fraction: number) => string;
  /**
   * Print the severity words ("near the limit"). Default true. Set false for
   * a fraction where higher is BETTER (a hit rate): the fill stays one
   * quantity hue and no limit language is used.
   */
  showState?: boolean;
}

const SEVERITY_LABEL: Record<GaugeSeverity, string> = {
  ok: 'within limits',
  warn: 'near the limit',
  danger: 'at the limit',
  unknown: 'unknown',
};

/** Smallest diameter a gauge draws at; below it the readout would collide with the arc. */
export const MIN_GAUGE_SIZE = 112;

/** The container's measured width (0 until laid out: jsdom, a hidden tab). */
function useContainerWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  // Track the node: the gauge mounts after a loading frame (see useChartWidth).
  const [node, setNode] = useState<HTMLElement | null>(null);
  // Runs after every render on purpose (ref.current is not a dependency React
  // can see); the equality guard makes it settle in one pass, never a loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (ref.current !== node) setNode(ref.current);
  });
  useLayoutEffect(() => {
    const el = node;
    if (!el) return undefined;
    const read = (): void => {
      const w = Math.floor(el.getBoundingClientRect().width);
      setWidth((prev) => (prev === w ? prev : w));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [node]);
  return width;
}

/** Diameter for a container: the largest that fits, clamped to [MIN_GAUGE_SIZE, max]. */
export function gaugeDiameter(containerWidth: number, max: number): number {
  if (!(containerWidth > 0)) return max;
  return Math.max(MIN_GAUGE_SIZE, Math.min(max, Math.floor(containerWidth)));
}

function severityColor(severity: GaugeSeverity): string {
  if (severity === 'danger') return toneColor('danger');
  if (severity === 'warn') return toneColor('warning');
  return CHART_SEQUENTIAL;
}

interface Row {
  key: string;
  label: string;
  value: string;
}

export function Gauge({
  title,
  description,
  caveat,
  status,
  value,
  warnAt = 0.7,
  dangerAt = 0.9,
  marker,
  caption,
  size: maxSize = 180,
  formatValue = (f) => formatPercent(f),
  showState = true,
}: GaugeProps) {
  const captionId = useId();
  const hatchId = hatchPatternId(useId());
  const fitRef = useRef<HTMLDivElement>(null);
  const size = gaugeDiameter(useContainerWidth(fitRef), maxSize);
  const severity = showState ? gaugeSeverity(value, warnAt, dangerAt) : value === null ? 'unknown' : 'ok';
  const stroke = Math.max(10, Math.round(size / 12));
  const r = size / 2 - stroke / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  const h = size / 2 + stroke / 2 + 4;
  const valueText = value === null ? 'unknown' : formatValue(value);
  const spoken = value === null ? `${title}: unknown` : showState ? `${title}: ${valueText}, ${SEVERITY_LABEL[severity]}` : `${title}: ${valueText}`;

  const rows: Row[] = [
    { key: 'value', label: 'Used', value: valueText },
    ...(showState
      ? [
          { key: 'state', label: 'State', value: SEVERITY_LABEL[severity] },
          { key: 'warn', label: 'Warning at', value: formatValue(warnAt) },
          { key: 'danger', label: 'Limit at', value: formatValue(dangerAt) },
        ]
      : []),
    ...(marker ? [{ key: 'marker', label: marker.label, value: formatValue(marker.value) }] : []),
  ];
  const columns: TableColumn<Row>[] = [
    { key: 'label', label: 'Measure', render: (row) => row.label },
    { key: 'value', label: 'Value', numeric: true, render: (row) => row.value },
  ];

  const markerOuter = marker ? polar(cx, cy, r + stroke / 2 + 3, Math.PI * (1 - Math.min(1, Math.max(0, marker.value)))) : null;
  const markerInner = marker ? polar(cx, cy, r - stroke / 2 - 3, Math.PI * (1 - Math.min(1, Math.max(0, marker.value)))) : null;

  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={status ?? { kind: 'ready' }}
      table={<TableView caption={title} columns={columns} rows={rows} rowKey={(row) => row.key} />}
    >
      <div ref={fitRef} className={styles.fit}>
      <div
        className={styles.gauge}
        role="meter"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={value === null ? undefined : Math.min(1, Math.max(0, value))}
        aria-valuetext={spoken}
        aria-describedby={caption ? captionId : undefined}
        data-severity={severity}
      >
        <svg className={plot.svg} width={size} height={h} viewBox={`0 0 ${size} ${h}`} aria-hidden="true">
          <defs>
            <HatchPattern id={hatchId} />
          </defs>
          {/* Unknown: the track is hatched, not the pale ramp step a "little" value would get. */}
          <path
            data-role="track"
            d={gaugeArc(cx, cy, r, 0, 1)}
            fill="none"
            stroke={value === null ? `url(#${hatchId})` : CHART_TRACK}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
          {value !== null && value > 0 ? (
            <path
              data-role="fill"
              d={gaugeArc(cx, cy, r, 0, Math.min(1, value))}
              fill="none"
              stroke={severityColor(severity)}
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          ) : null}
          {markerOuter && markerInner ? (
            <line
              data-role="marker"
              x1={markerInner.x}
              y1={markerInner.y}
              x2={markerOuter.x}
              y2={markerOuter.y}
              stroke="var(--text-primary)"
              strokeWidth={2}
              strokeLinecap="round"
            />
          ) : null}
        </svg>
        <div className={styles.readout}>
          <span className={value === null ? styles.unknownValue : styles.value}>{valueText}</span>
          {showState && severity !== 'unknown' ? <span className={styles.state}>{SEVERITY_LABEL[severity]}</span> : null}
          {caption ? <span id={captionId} className={styles.caption}>{caption}</span> : null}
          {marker ? <span className={styles.caption}>{marker.label}: {formatValue(marker.value)}</span> : null}
        </div>
      </div>
      </div>
    </ChartFrame>
  );
}
