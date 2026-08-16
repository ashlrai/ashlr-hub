/**
 * routes/fleet-dashboard/DaemonPanel.tsx — the reference use of the
 * epistemic-honesty primitive (foundation brief item 7). ControlSnapshot's
 * `daemon.sourceQuality` is a real `{sourceState, complete, reason}` on the
 * backend (src/core/web/control.ts buildDaemon/fallbackDaemon) — when it's
 * degraded, this panel shows "unknown" for state/pid/spend and WITHHOLDS
 * the pause/resume affordance entirely, rather than rendering a button
 * wired to a guess.
 */
import type { ControlSnapshot } from '../../data/api-types.js';
import { Epistemic } from '../../components/primitives/Epistemic.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import panel from './Panel.module.css';
import styles from './DaemonPanel.module.css';

export function DaemonPanelSkeleton() {
  return (
    <details className={panel.panel} open data-state-key="fleet-dashboard-daemon">
      <summary className={panel.panelHeader}>
        <span className={panel.panelTitle}>Daemon</span>
      </summary>
      <div className={panel.panelBody}>
        <SkeletonLine width="40%" />
      </div>
    </details>
  );
}

export function DaemonPanel({ daemon }: { daemon: ControlSnapshot['daemon'] }) {
  return (
    <details className={panel.panel} open data-state-key="fleet-dashboard-daemon">
      <summary className={panel.panelHeader}>
        <span className={panel.panelTitle}>Daemon</span>
        <Epistemic quality={daemon.sourceQuality} label="daemon state">
          <StatusBadge status={daemon.running ? 'running' : 'pending'}>
            {daemon.running ? 'running' : 'stopped'}
          </StatusBadge>
        </Epistemic>
      </summary>
      <div className={panel.panelBody}>
        <dl className={styles.grid}>
          <div>
            <dt>Runtime state</dt>
            <dd>
              <Epistemic quality={daemon.sourceQuality} label="runtime state">
                {daemon.runtimeState}
              </Epistemic>
            </dd>
          </div>
          <div>
            <dt>PID</dt>
            <dd>
              <Epistemic quality={daemon.sourceQuality} label="pid">
                {daemon.pid ?? '—'}
              </Epistemic>
            </dd>
          </div>
          <div>
            <dt>Today's spend</dt>
            <dd>
              <Epistemic quality={daemon.sourceQuality} label="spend">
                ${daemon.todaySpentUsd.toFixed(2)}
              </Epistemic>
            </dd>
          </div>
          <div>
            <dt>Direction mode</dt>
            <dd>
              <Epistemic quality={daemon.sourceQuality} label="direction mode">
                {daemon.activeDirectionMode ?? 'none'}
              </Epistemic>
            </dd>
          </div>
        </dl>
      </div>
    </details>
  );
}
