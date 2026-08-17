/**
 * routes/fleet-dashboard/RunsPanel.tsx — recent runs. Wrapped in a
 * <details data-state-key> so useScrollRestore's collapse-state capture
 * has a real thing to exercise on this reference view; rows carry
 * data-focus-key so keyboard focus survives a background refresh even
 * though the whole list re-renders with fresh objects every SSE tick.
 */
import type { DashboardSnapshot } from '../../data/api-types.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { SkeletonRow } from '../../components/primitives/Skeleton.js';
import panel from './Panel.module.css';
import styles from './RunsPanel.module.css';

export function RunsPanelSkeleton() {
  return (
    <details className={panel.panel} open data-state-key="fleet-dashboard-runs">
      <summary className={panel.panelHeader}>
        <span className={panel.panelTitle}>Recent runs</span>
      </summary>
      <div className={panel.panelBody}>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </details>
  );
}

export function RunsPanel({ runs }: { runs: DashboardSnapshot['runs'] }) {
  return (
    <details className={panel.panel} open data-state-key="fleet-dashboard-runs">
      <summary className={panel.panelHeader}>
        <span className={panel.panelTitle}>Recent runs</span>
        <span className="text-tertiary text-xs">{runs.length}</span>
      </summary>
      <div className={panel.panelBody}>
        {runs.length === 0 ? (
          <p className={panel.emptyState}>No runs yet.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Goal</th>
                <th scope="col" className={styles.statusCol}>
                  Status
                </th>
                <th scope="col" className={styles.tokensCol}>
                  Tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <a
                      href={`#/work/runs/${run.id}`}
                      data-focus-key={`run-${run.id}`}
                      className={styles.goalLink}
                      title={run.goal}
                    >
                      {run.goal}
                    </a>
                  </td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td className={styles.tokens}>{run.tokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}
