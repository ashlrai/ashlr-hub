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
import { useId } from 'react';
import { CHART_SEQUENTIAL, CHART_TRACK, toneColor } from './colors.js';
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
  /** Diameter in px. */
  size?: number;
  formatValue?: (fraction: number) => string;
}

const SEVERITY_LABEL: Record<GaugeSeverity, string> = {
  ok: 'within limits',
  warn: 'near the limit',
  danger: 'at the limit',
  unknown: 'unknown',
};

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
  size = 180,
  formatValue = (f) => formatPercent(f),
}: GaugeProps) {
  const captionId = useId();
  const severity = gaugeSeverity(value, warnAt, dangerAt);
  const stroke = Math.max(10, Math.round(size / 12));
  const r = size / 2 - stroke / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  const h = size / 2 + stroke / 2 + 4;
  const valueText = value === null ? 'unknown' : formatValue(value);
  const spoken = value === null ? `${title}: unknown` : `${title}: ${valueText}, ${SEVERITY_LABEL[severity]}`;

  const rows: Row[] = [
    { key: 'value', label: 'Used', value: valueText },
    { key: 'state', label: 'State', value: SEVERITY_LABEL[severity] },
    { key: 'warn', label: 'Warning at', value: formatValue(warnAt) },
    { key: 'danger', label: 'Limit at', value: formatValue(dangerAt) },
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
          <path d={gaugeArc(cx, cy, r, 0, 1)} fill="none" stroke={CHART_TRACK} strokeWidth={stroke} strokeLinecap="round" />
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
          {severity !== 'unknown' ? <span className={styles.state}>{SEVERITY_LABEL[severity]}</span> : null}
          {caption ? <span id={captionId} className={styles.caption}>{caption}</span> : null}
          {marker ? <span className={styles.caption}>{marker.label}: {formatValue(marker.value)}</span> : null}
        </div>
      </div>
    </ChartFrame>
  );
}
