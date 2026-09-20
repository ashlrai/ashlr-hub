/**
 * components/primitives/Meter.tsx — occupancy against a limit: context
 * window, daily spend against the cap, a plan's usage window.
 *
 * Two forms, one component:
 *   variant="line"     the 2px full-width rule the design language puts
 *                      directly under a header strip. No text of its own —
 *                      wrap it in <Tooltip> and put the numbers beside it.
 *   variant="labelled" a 4px bar with a label and a right-aligned
 *                      "18k / 66k" in the display face.
 *
 * Tone thresholds match the V1 context meter (amber >= 70%, danger >= 90%)
 * and are ALWAYS paired with the readable value, never color alone.
 * An unknown limit renders an honest empty track and the text "unknown" —
 * never a full bar, never zero (DESIGN.md §7).
 */
import type { ReactNode } from 'react';
import styles from './Meter.module.css';

export type MeterTone = 'accent' | 'neutral' | 'running' | 'warning' | 'danger' | 'engine';

export interface MeterProps {
  /** Current value. null = genuinely unknown. */
  value: number | null;
  /** Limit. null/0 = unknown limit; the meter says so instead of guessing. */
  max: number | null;
  variant?: 'line' | 'labelled';
  label?: ReactNode;
  /** Right-aligned readout. Defaults to `value / max` formatted compactly. */
  valueText?: ReactNode;
  /** Force a tone; by default it is derived from the percentage. */
  tone?: MeterTone;
  /** For tone="engine": the CSS color to paint the fill (an --engine-* var). */
  engineColor?: string;
  /** Accessible name when no visible label is rendered (the line variant). */
  'aria-label'?: string;
  className?: string;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function toneForPercent(percent: number): MeterTone {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warning';
  return 'accent';
}

export function Meter({
  value,
  max,
  variant = 'labelled',
  label,
  valueText,
  tone,
  engineColor,
  className,
  ...aria
}: MeterProps) {
  const known = value !== null && Number.isFinite(value) && max !== null && Number.isFinite(max) && max > 0;
  const percent = known ? Math.min(100, Math.max(0, (value! / max!) * 100)) : 0;
  const resolvedTone = tone ?? (known ? toneForPercent(percent) : 'neutral');
  const readout = known ? (valueText ?? `${compact(value!)} / ${compact(max!)}`) : (valueText ?? 'unknown');

  const track = (
    <div
      className={`${styles.track} ${variant === 'line' ? styles.line : styles.bar}`}
      role="meter"
      aria-valuenow={known ? Math.round(percent) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={known ? `${Math.round(percent)}%` : 'unknown'}
      {...aria}
    >
      <div
        className={`${styles.fill} ${styles[resolvedTone]}`}
        style={{
          width: `${percent}%`,
          ...(resolvedTone === 'engine' && engineColor ? { background: engineColor } : {}),
        }}
      />
    </div>
  );

  if (variant === 'line') return <div className={`${styles.lineWrap} ${className ?? ''}`}>{track}</div>;

  return (
    <div className={`${styles.wrap} ${className ?? ''}`}>
      {label || readout ? (
        <div className={styles.head}>
          {label ? <span className={styles.label}>{label}</span> : <span />}
          <span className={`${styles.value} ${known ? '' : styles.unknown}`}>{readout}</span>
        </div>
      ) : null}
      {track}
    </div>
  );
}
