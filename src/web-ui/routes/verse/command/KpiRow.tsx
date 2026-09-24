/**
 * routes/verse/command/KpiRow.tsx — five StatTiles (SPEC-310B §6: merged in
 * 7 days, post-merge green %, cycle time, spend vs cap, lift), each with a
 * "vs prior 7d" delta when both weeks are fully known. Five across at 1440,
 * two per row at 375.
 */
import { StatTile } from '../../../components/charts/StatTile.js';
import type { Kpi } from './command-model.js';
import styles from './command.module.css';

export function KpiRow({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className={styles.kpis} role="group" aria-label="Key numbers">
      {kpis.map((k) => (
        <StatTile key={k.id} label={k.label} value={k.value} delta={k.delta} trend={k.trend} trendLabel={k.trendLabel} caption={k.caption} />
      ))}
    </div>
  );
}
