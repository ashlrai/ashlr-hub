/**
 * components/charts/StatTile.tsx — value + delta + optional sparkline, the
 * figure contract from marks-and-anatomy.md. Use for a single current value
 * (a one-bar bar chart is never the answer — this is). `value` takes a
 * ReactNode (not just a string) so callers can wrap a sourceQuality-bearing
 * field in <Epistemic/> and pass that straight through.
 *
 * V3.10 (SPEC-310C §6 "StatTile: sparkline goes under the number; deltas show
 * units"): the 72×24 sparkline used to float top-right, disconnected from the
 * number it explains; it now sits directly under it. A delta reads as a
 * sentence fragment with its unit and its comparison — "+5 merges vs prior
 * 7d", never a bare "-1". In dark the tile gets the 4% top hairline
 * (`--hairline-lift`, transparent in light) so a KPI row lifts off the canvas.
 *
 * Polish (verse-visual-quality): the sparkline spans the tile (`fill`), in
 * the quantity ink with a gradient wash; a judged delta sits on a tinted pill
 * with a direction arrow (the arrow is decoration — the signed number and
 * its words still say which way it went).
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
  /** vs which period, e.g. "vs prior 7d". */
  versus?: string;
  /** Unit after the number: "merges", "pts", "min". Plural is the caller's call. */
  unit?: string;
  /** Formats the SIGNED value (default: "+12" / "-3"). Use for percent points, durations, dollars. */
  format?: (signed: number) => string;
}

/** "+5 merges vs prior 7d" — the whole delta as one readable phrase. */
export function deltaText(delta: StatTileDelta): string {
  const n = delta.format ? delta.format(delta.value) : formatSignedCompact(delta.value);
  return [n, delta.unit, delta.versus].filter((part) => part !== undefined && part !== '').join(' ');
}

export function StatTile({
  label,
  value,
  caption,
  delta,
  trend,
  trendLabel,
  describeTrend,
}: {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  delta?: StatTileDelta | null;
  trend?: (number | null)[];
  trendLabel?: string;
  /** Spoken summary formatter for the sparkline (first → latest, range). */
  describeTrend?: (v: number) => string;
}) {
  const deltaTone =
    delta == null || delta.goodWhenPositive === undefined
      ? styles.deltaNeutral
      : delta.value === 0
        ? styles.deltaNeutral
        : (delta.value > 0) === delta.goodWhenPositive
          ? styles.deltaGood
          : styles.deltaBad;

  const arrow = delta == null || delta.value === 0 || !Number.isFinite(delta.value) ? null : delta.value > 0 ? '↑' : '↓';

  return (
    <div className={styles.tile} data-stat-tile="">
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
      {trend ? (
        <span className={styles.trend}>
          <Sparkline points={trend} width="fill" height={28} area ariaLabel={trendLabel ?? `${label} trend`} describe={describeTrend} />
        </span>
      ) : null}
      {delta || caption ? (
        <div className={styles.meta}>
          {delta ? (
            <span className={`${styles.delta} ${deltaTone}`} data-delta-tone={deltaTone === styles.deltaGood ? 'good' : deltaTone === styles.deltaBad ? 'bad' : 'neutral'}>
              {arrow ? <span className={styles.arrow} aria-hidden="true">{arrow}</span> : null}
              <span>{deltaText(delta)}</span>
            </span>
          ) : null}
          {caption ? <span className={styles.caption}>{caption}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A stat tile's loading placeholder in the tile's own shape — label, number
 * and sparkline bars on the same box — so a KPI row does not jump when its
 * figures land. Uses the app's shared `.skeleton` shimmer (design/global.css),
 * which already stops under reduced motion. Presentation only: the caller
 * announces the loading state once for the whole row.
 */
export function StatTileSkeleton({ trend = true }: { trend?: boolean }) {
  return (
    <div className={styles.tile} data-stat-tile-skeleton="" aria-hidden="true">
      <span className={`skeleton ${styles.skLabel}`} />
      <span className={`skeleton ${styles.skValue}`} />
      {trend ? <span className={`skeleton ${styles.skTrend}`} /> : null}
      <span className={`skeleton ${styles.skMeta}`} />
    </div>
  );
}
