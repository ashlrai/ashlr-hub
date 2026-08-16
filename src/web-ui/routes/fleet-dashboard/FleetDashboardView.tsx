/**
 * routes/fleet-dashboard/FleetDashboardView.tsx — the foundation's ONE
 * fully-implemented view (foundation brief deliverable). Read this file
 * plus its sub-panels as the pattern every other view should copy:
 *
 *   1. Pull each resource through useQuery(<queryDef>) from data/hooks.ts
 *      — never call apiGet directly from a view.
 *   2. Branch on `status`: 'loading' -> skeleton, 'error' -> inline error
 *      (never a full-page error, the rest of the shell stays usable),
 *      otherwise render real content — 'refreshing' additionally shows
 *      <RefreshIndicator/> next to the section it's stale for.
 *   3. Never blank the page. Even on 'refreshing' the last-good `data` is
 *      still there and still rendered.
 *   4. Wrap anything sourced from a `sourceQuality`-bearing field in
 *      <Epistemic/> (see DaemonPanel.tsx) instead of trusting it blindly.
 */
import { dashboardSnapshotQuery, controlSnapshotQuery } from '../../data/queries.js';
import { useQuery } from '../../data/hooks.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { StatGrid, StatGridSkeleton } from './StatGrid.js';
import { RunsPanel, RunsPanelSkeleton } from './RunsPanel.js';
import { SwarmsPanel } from './SwarmsPanel.js';
import { DaemonPanel, DaemonPanelSkeleton } from './DaemonPanel.js';
import styles from './FleetDashboardView.module.css';

export function FleetDashboardView() {
  const snapshotQuery = useQuery(dashboardSnapshotQuery);
  const controlQuery = useQuery(controlSnapshotQuery);

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Fleet Dashboard</h1>
        <div className={styles.freshness} aria-live="polite">
          {snapshotQuery.status === 'refreshing' ? <RefreshIndicator /> : null}
          {snapshotQuery.updatedAt ? (
            <span className={styles.freshnessLabel}>Updated {formatRelative(snapshotQuery.updatedAt)}</span>
          ) : null}
        </div>
      </header>

      {snapshotQuery.status === 'loading' ? (
        <StatGridSkeleton />
      ) : snapshotQuery.status === 'error' ? (
        <ErrorBanner message={snapshotQuery.error?.message ?? 'Failed to load snapshot.'} />
      ) : snapshotQuery.data ? (
        <StatGrid snapshot={snapshotQuery.data} />
      ) : null}

      <div className={styles.panels}>
        {snapshotQuery.status === 'loading' ? (
          <RunsPanelSkeleton />
        ) : snapshotQuery.data ? (
          <RunsPanel runs={snapshotQuery.data.runs} />
        ) : null}

        {snapshotQuery.data ? <SwarmsPanel swarms={snapshotQuery.data.swarms} /> : null}

        {controlQuery.status === 'loading' ? (
          <DaemonPanelSkeleton />
        ) : controlQuery.status === 'error' ? (
          <ErrorBanner message={controlQuery.error?.message ?? 'Failed to load control snapshot.'} />
        ) : controlQuery.data ? (
          <DaemonPanel daemon={controlQuery.data.daemon} />
        ) : null}
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className={styles.error} role="alert">
      {message}
    </div>
  );
}

function formatRelative(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}
