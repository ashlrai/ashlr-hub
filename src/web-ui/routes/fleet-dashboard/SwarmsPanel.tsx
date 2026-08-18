/**
 * routes/fleet-dashboard/SwarmsPanel.tsx — active/recent swarms with a live
 * task burndown bar and a PhaseDot for the current DAG phase, when known.
 */
import type { DashboardSnapshot } from '../../data/api-types.js';
import { StatusBadge, PhaseDot } from '../../components/primitives/StatusBadge.js';
import panel from './Panel.module.css';
import styles from './SwarmsPanel.module.css';

export function SwarmsPanel({ swarms }: { swarms: DashboardSnapshot['swarms'] }) {
  return (
    <details className={panel.panel} open data-state-key="fleet-dashboard-swarms">
      <summary className={panel.panelHeader}>
        <span className={panel.panelTitle}>Swarms</span>
        <span className="text-tertiary text-xs">{swarms.length}</span>
      </summary>
      <div className={panel.panelBody}>
        {swarms.length === 0 ? (
          <p className={panel.emptyState}>No active swarms.</p>
        ) : (
          <ul className={styles.list}>
            {swarms.map((swarm, i) => {
              const pct = swarm.tasksTotal > 0 ? Math.round((swarm.tasksDone / swarm.tasksTotal) * 100) : 0;
              return (
                <li key={swarm.id} className={styles.item}>
                  <a
                    href={`#/work/swarms/${swarm.id}`}
                    data-focus-key={`swarm-${swarm.id}`}
                    className={styles.itemHeader}
                    title={swarm.goal}
                  >
                    {swarm.phase ? <PhaseDot index={i} /> : null}
                    <span className={styles.goal}>{swarm.goal}</span>
                    <StatusBadge status={swarm.status} />
                  </a>
                  <div className={styles.burndown}>
                    <div className={styles.burndownTrack}>
                      <div className={styles.burndownFill} style={{ width: `${pct}%` }} />
                    </div>
                    <span className={styles.burndownLabel}>
                      {swarm.tasksDone}/{swarm.tasksTotal}
                      {swarm.phase ? ` · ${swarm.phase}` : ''}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
