import type { ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import { StatusBadge, type Tone } from '../../components/primitives/StatusBadge.js';
import { resourceTime } from './CapacityBoard.js';
import styles from './ResourcePoolView.module.css';

const STATES: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  refreshing: { label: 'Refreshing', tone: 'running' },
  observed: { label: 'Observed', tone: 'info' },
  failed: { label: 'Failed', tone: 'danger' },
  'timed-out': { label: 'Timed out', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  uncertain: { label: 'Uncertain', tone: 'unknown' },
  expired: { label: 'Expired', tone: 'warning' },
  closed: { label: 'Closed', tone: 'neutral' },
};
const REASONS: Record<string, string> = {
  'managed-quota-pending': 'Waiting for the first native metadata read.',
  'managed-quota-refreshing': 'A native metadata read is in progress.',
  'managed-quota-observed': 'Native account hint and quota sample received.',
  'managed-quota-failed': 'The latest native metadata read failed.',
  'managed-quota-timed-out': 'The native metadata read exceeded its time limit.',
  'managed-quota-cancelled': 'The native metadata read was cancelled.',
  'managed-quota-uncertain': 'Native process cleanup is unconfirmed. Further reads are stopped.',
  'managed-quota-expired': 'The retained quota sample has expired.',
  'managed-quota-closed': 'The foreground metadata collector has stopped.',
  'managed-quota-future': 'The recorded capture time is in the future.',
  'managed-quota-unavailable': 'The native worker is unavailable.',
  'managed-quota-unknown': 'A quota percentage or reset is unknown. Admission is withheld.',
  'managed-quota-reserve-reached': 'A native quota window reached its configured reserve. Admission is withheld.',
};

export function QuotaRefreshPanel({ refresh, selectedWorkerId, onSelect }: {
  refresh: ResourceConsoleSnapshot['quotaRefresh'];
  selectedWorkerId?: string | null;
  onSelect: (id: string) => void;
}) {
  if (!refresh) return null;
  return <section className={styles.board} aria-labelledby="quota-refresh-title">
    <div className={styles.sectionHeading}><div><h2 id="quota-refresh-title">Native quota reads</h2>
      <p>The foreground collector reads enrolled Codex metadata. Viewing this table does not start a provider request.</p></div></div>
    <div className={styles.performanceScroll} tabIndex={0} role="region" aria-label="Native quota read status">
      <table className={styles.performanceTable}>
        <caption>{refresh.state === 'closed' ? 'Collector stopped.' : 'Foreground collection enabled.'} Last collector snapshot: {resourceTime(refresh.sampledAt)}.</caption>
        <thead><tr><th scope="col">Worker</th><th scope="col">Native metadata status</th>
          <th scope="col">Last successful sample</th><th scope="col">Next attempt</th></tr></thead>
        <tbody>{refresh.workers.map((row) => {
          const state = row.status === 'observed' && row.reason === 'managed-quota-unknown'
            ? { label: 'Observed; quota unknown', tone: 'unknown' as const }
            : row.status === 'observed' && row.reason === 'managed-quota-reserve-reached'
              ? { label: 'Observed; reserve reached', tone: 'warning' as const }
            : Object.hasOwn(STATES, row.status) ? STATES[row.status]! : { label: 'Unknown', tone: 'unknown' as const };
          const reason = Object.hasOwn(REASONS, row.reason) ? REASONS[row.reason]! : 'Metadata status details are unavailable.';
          return <tr key={row.workerId}>
            <th scope="row"><button type="button" className={styles.performanceWorker}
              aria-pressed={selectedWorkerId === row.workerId} onClick={() => onSelect(row.workerId)}>{row.workerId}</button></th>
            <td><StatusBadge status={state.label} tone={state.tone}>{state.label}</StatusBadge><small>{reason}</small></td>
            <td>{row.lastSuccessAt ? resourceTime(row.lastSuccessAt) : 'No successful sample'}
              {row.lastAttemptAt ? <small>Last attempt: {resourceTime(row.lastAttemptAt)}</small> : null}</td>
            <td>{row.nextAttemptAt ? resourceTime(row.nextAttemptAt)
              : row.status === 'refreshing' ? 'Read in progress' : 'Not scheduled'}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className={styles.boardNote}>Native metadata does not prove independent accounts or readiness to execute. Every enrolled alias in shared capacity needs a current successful read. Unknown or expired quota still withholds admission; inspect the capacity board for all routing constraints.</p>
  </section>;
}
