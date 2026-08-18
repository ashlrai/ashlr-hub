/**
 * routes/control/daemon/DaemonView.tsx — autonomous operator state, spend,
 * and direction mode (GET /api/control's `.daemon`/`.daemonObservation`).
 *
 * Every field here traces back to `daemon.sourceQuality` (a real
 * `{sourceState, complete, reason}` — src/core/web/control.ts `ControlDaemon`)
 * and is wrapped in <Epistemic/>: when the source is degraded this renders
 * "unknown", not a guess.
 *
 * The recovery callout below is the one thing this view adds beyond
 * DaemonPanel's dashboard-compact version: when sourceQuality.reason is
 * 'unreadable', src/core/daemon/state.ts's loadDaemonStateStrict() shows
 * that reason both for a plain read failure AND for the specific case where
 * a daemon-state-recovery marker file is present ("daemon state recovery is
 * in progress", state.ts:437-450) — the API does not currently disambiguate
 * the two, so this view surfaces the real CLI remedy for BOTH as a single
 * conditional next step (verbatim from `ashlr daemon recover-state --help` /
 * `resolve-state --help`, src/cli/daemon.ts:82-86) rather than asserting a
 * diagnosis the response can't actually confirm. This was previously
 * undiscoverable — the old UI had no daemon page at all, only a compact
 * dashboard panel with no failure-mode guidance.
 */
import { useRef } from 'react';
import { controlSnapshotQuery, daemonObservationQuery } from '../../../data/queries.js';
import { useQuery } from '../../../data/hooks.js';
import { useScrollRestore } from '../../../hooks/useScrollRestore.js';
import { Epistemic, isKnown } from '../../../components/primitives/Epistemic.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import type { DaemonSourceQuality } from '../../../data/api-types.js';
import styles from './DaemonView.module.css';

const REASON_COPY: Record<string, string> = {
  missing: 'No daemon state file has been written yet — the daemon may never have run on this machine.',
  malformed: 'The daemon state file exists but failed to parse.',
  unreadable:
    'The daemon state file could not be read. This is also the exact signal produced when a state-recovery ' +
    'marker is present (a prior repair left a quarantine in progress) — the API does not distinguish the two ' +
    'cases, so treat this as "inspect before trusting displayed daemon state."',
  inconsistent: 'The daemon state file and the live lock/activity check disagree — the daemon may be mid-restart.',
  unavailable: 'The daemon state read path itself failed (I/O error or similar).',
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function RecoveryCallout({ quality }: { quality: DaemonSourceQuality }) {
  const reason = quality.reason;
  const copy = REASON_COPY[reason] ?? 'Daemon state could not be verified.';
  return (
    <section className={styles.callout} role="alert">
      <p className={styles.calloutTitle}>Daemon state is unknown ({reason})</p>
      <p className={styles.calloutBody}>{copy}</p>
      <p className={styles.calloutBody}>
        Real remedy — preview or execute a state recovery from a terminal on this machine:
      </p>
      <pre className={styles.calloutCommand}>
        {'ashlr daemon recover-state --dry-run --expected-sha256 <sha256> [--json]\n' +
          'ashlr daemon recover-state --execute --plan-id <uuid> --plan-sha256 <sha256> --authorize <plan-sha256> [--json]'}
      </pre>
      <p className={styles.calloutBody}>If a quarantine already exists and needs resolving instead:</p>
      <pre className={styles.calloutCommand}>
        {'ashlr daemon resolve-state --dry-run --quarantine-plan-id <uuid> --quarantine-receipt-sha256 <sha256> [--json]\n' +
          'ashlr daemon resolve-state --execute --plan-id <uuid> --plan-sha256 <sha256> --authorize <plan-sha256> --confirm <plan-sha256> [--json]'}
      </pre>
    </section>
  );
}

export function DaemonView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/control/daemon', containerRef);

  const controlQuery = useQuery(controlSnapshotQuery);
  const observationQuery = useQuery(daemonObservationQuery);

  const daemon = controlQuery.data?.daemon;
  const observation = observationQuery.data;

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Daemon</h1>
        <div className={styles.freshness} aria-live="polite">
          {controlQuery.status === 'refreshing' || observationQuery.status === 'refreshing' ? (
            <RefreshIndicator />
          ) : null}
          {daemon ? (
            <Epistemic quality={daemon.sourceQuality} label="daemon state">
              <StatusBadge status={daemon.running ? 'running' : 'pending'}>
                {daemon.running ? 'running' : 'stopped'}
              </StatusBadge>
            </Epistemic>
          ) : null}
        </div>
      </header>

      {controlQuery.status === 'loading' ? (
        <SkeletonLine width="60%" />
      ) : controlQuery.status === 'error' || !daemon ? (
        <p className={styles.error} role="alert">
          {controlQuery.error?.message ?? 'Failed to load control snapshot.'}
        </p>
      ) : (
        <>
          {!isKnown(daemon.sourceQuality) ? <RecoveryCallout quality={daemon.sourceQuality} /> : null}

          <dl className={styles.metaGrid}>
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
              <dt>Last tick</dt>
              <dd>
                <Epistemic quality={daemon.sourceQuality} label="last tick">
                  {formatDate(daemon.lastTickAt)}
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
            <div>
              <dt>Direction reason</dt>
              <dd>
                <Epistemic quality={daemon.sourceQuality} label="direction reason">
                  {daemon.activeDirectionReason ?? '—'}
                </Epistemic>
              </dd>
            </div>
            <div>
              <dt>Autonomy control loop</dt>
              <dd>
                <Epistemic quality={daemon.sourceQuality} label="autonomy control loop">
                  {daemon.autonomyControlLoop ? 'enabled' : 'disabled'}
                </Epistemic>
              </dd>
            </div>
            <div>
              <dt>Autonomy control mode</dt>
              <dd>
                <Epistemic quality={daemon.sourceQuality} label="autonomy control mode">
                  {daemon.autonomyControlMode}
                </Epistemic>
              </dd>
            </div>
          </dl>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>OS service</h2>
            <dl className={styles.metaGrid}>
              <div>
                <dt>Registration state</dt>
                <dd>{daemon.service.registrationState}</dd>
              </div>
              <div>
                <dt>Installed</dt>
                <dd>{daemon.service.installed ? 'yes' : 'no'}</dd>
              </div>
              <div>
                <dt>Running</dt>
                <dd>{daemon.service.running ? 'yes' : 'no'}</dd>
              </div>
              <div>
                <dt>Runtime state</dt>
                <dd>{daemon.service.runtimeState ?? 'unknown'}</dd>
              </div>
              <div>
                <dt>Platform</dt>
                <dd>{daemon.service.platformSpec}</dd>
              </div>
            </dl>
            {daemon.service.errorLog ? (
              <p className={styles.serviceError} role="alert">
                {daemon.service.errorLog}
              </p>
            ) : null}
          </section>
        </>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Recent ticks</h2>
        {observationQuery.status === 'loading' ? (
          <SkeletonLine width="80%" />
        ) : !observation || !observation.ticks || observation.ticks.length === 0 ? (
          <p className={styles.empty}>No tick history available.</p>
        ) : (
          <div className={styles.tickTableWrap}>
            <table className={styles.tickTable}>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Items</th>
                  <th scope="col">Proposals</th>
                  <th scope="col">Spend</th>
                </tr>
              </thead>
              <tbody>
                {[...observation.ticks]
                  .reverse()
                  .slice(0, 20)
                  .map((tick, i) => (
                    <tr key={`${tick.ts}-${i}`}>
                      <td className={styles.date}>{formatDate(tick.ts)}</td>
                      <td>
                        {tick.reason}
                        {tick.dryRun ? <span className={styles.dryRun}> (dry-run)</span> : null}
                      </td>
                      <td className={styles.numeric}>{tick.itemsConsidered}</td>
                      <td className={styles.numeric}>{tick.proposalsCreated}</td>
                      <td className={styles.numeric}>${tick.spentUsd.toFixed(4)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
