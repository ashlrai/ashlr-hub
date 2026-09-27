/**
 * routes/verse/command/KpiRow.tsx — five StatTiles (SPEC-310B §6: merged in
 * 7 days, post-merge green %, cycle time, spend vs cap, lift), each with a
 * "vs prior 7d" delta when both weeks are fully known. Five across at 1440,
 * two per row at 375.
 *
 * Each sparkline also SPEAKS its trend (first → latest, range) in the unit
 * the tile prints, so the glance is not image-only for a screen reader.
 * Cycle time and lift carry no sparkline on purpose: their sources hold one
 * current figure, not a daily series, and none is invented for the glance.
 */
import { StatTile } from '../../../components/charts/StatTile.js';
import type { Kpi } from './command-model.js';
import styles from './command.module.css';

const DESCRIBE_TREND: Partial<Record<Kpi['id'], (v: number) => string>> = {
  merged: (v) => `${Math.round(v)} merged`,
  green: (v) => `${Math.round(v)}%`,
  spend: (v) => `$${v.toFixed(2)}`,
};

export function KpiRow({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className={styles.kpis} role="group" aria-label="Key numbers">
      {kpis.map((k) => (
        <StatTile
          key={k.id}
          label={k.label}
          value={k.value}
          delta={k.delta}
          trend={k.trend}
          trendLabel={k.trendLabel}
          describeTrend={DESCRIBE_TREND[k.id]}
          caption={k.caption}
        />
      ))}
    </div>
  );
}
