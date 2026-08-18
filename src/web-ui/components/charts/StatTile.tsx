/**
 * components/charts/StatTile.tsx — value + delta + optional sparkline, the
 * figure contract from marks-and-anatomy.md. Use for a single current value
 * (a one-bar bar chart is never the answer — this is). `value` takes a
 * ReactNode (not just a string) so callers can wrap a sourceQuality-bearing
 * field in <Epistemic/> and pass that straight through.
 */
import type { ReactNode } from 'react';
import { formatSignedCompact } from './format.js';
import { Sparkline } from './Sparkline.js';
import styles from './StatTile.module.css';

export interface StatTileDelta {
  /** Signed raw value, e.g. +12 or -3. */
  value: number;
  /** Whether a positive delta reads as good (green) or bad (red). Omit for
   * a neutral, non-judgmental delta (e.g. "goals in flight" — more isn't
   * inherently good or bad). */
  goodWhenPositive?: boolean;
  /** vs which period, e.g. "vs yesterday". */
  versus?: string;
}

export function StatTile({
  label,
  value,
  caption,
  delta,
  trend,
  trendLabel,
}: {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  delta?: StatTileDelta | null;
  trend?: (number | null)[];
  trendLabel?: string;
}) {
  const deltaTone =
    delta == null || delta.goodWhenPositive === undefined
      ? styles.deltaNeutral
      : delta.value === 0
        ? styles.deltaNeutral
        : (delta.value > 0) === delta.goodWhenPositive
          ? styles.deltaGood
          : styles.deltaBad;

  return (
    <div className={styles.tile}>
      <span className={styles.label}>{label}</span>
      <div className={styles.row}>
        <span className={styles.value}>{value}</span>
      </div>
      <div className={styles.trendRow}>
        {caption ? <span className={styles.caption}>{caption}</span> : <span />}
        {trend ? <Sparkline points={trend} ariaLabel={trendLabel ?? `${label} trend`} /> : null}
      </div>
      {delta ? (
        <span className={`${styles.delta} ${deltaTone}`}>
          {formatSignedCompact(delta.value)}
          {delta.versus ? ` ${delta.versus}` : ''}
        </span>
      ) : null}
    </div>
  );
}
