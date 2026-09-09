import type { ResourceConsoleSnapshot, ResourceCollectorRecoveryDiagnosis } from '../../../core/resources/console-types.js';
import { RESOURCE_COLLECTOR_RECOVERY_MARKER_VERSIONS } from '../../../core/resources/console-types.js';
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
  'managed-allocation-unavailable': 'The saved usage allocation could not be read. Admission is withheld until allocation evidence is available.',
};
type Collector = NonNullable<ResourceConsoleSnapshot['metadataCollector']>;
const COLLECTOR_REASONS: Record<Collector['reasonCode'], string> = {
  'collector-running': 'This console established ownership for configured native metadata collection.',
  'collector-owned': 'Another foreground collector held metadata ownership when this console started. Close that collector normally, then restart this console with the same options.',
  'reconciliation-required': 'Prior native work has unconfirmed cleanup. Reconcile that work before restarting this console. The retained marker was not removed.',
  'collector-unavailable': 'Metadata ownership could not be established or retained. Inspect the local collector state before restarting this console with the same options.',
};
const RECOVERY: Record<ResourceCollectorRecoveryDiagnosis['reasonCode'], { title: string; detail: string; next: string }> = {
  'legacy-owner-evidence-missing': {
    title: 'Legacy record lacks ownership evidence',
    detail: 'This older record has no owner, boot or process-group identity. Its timestamp cannot prove that the original work stopped.',
    next: 'Preserve the record and reconcile it against the original collector’s shutdown evidence. Restarting this console or the computer alone cannot make this record automatically recoverable.',
  },
  'boot-identity-unavailable': {
    title: 'Boot identity could not be verified',
    detail: 'Recovery could not establish the current machine and boot session.',
    next: 'Restore the local operating-system identity check, then restart with the same configuration. An elapsed timestamp is not a replacement for verified boot evidence.',
  },
  'machine-identity-mismatch': {
    title: 'Record belongs to a different machine',
    detail: 'The recorded machine identity does not match this computer.',
    next: 'Reconcile the original collector on its source machine. Copying its ledger does not establish that its processes have stopped.',
  },
  'same-boot-owner-evidence-missing': {
    title: 'Record lacks same-boot recovery evidence',
    detail: 'This record identifies a boot but does not contain the activity evidence required for recovery on that same boot.',
    next: 'Reconcile the original work. This format supports recovery only after a verified reboot on the same machine; restarting this console alone is insufficient.',
  },
  'owner-not-confirmed-absent': {
    title: 'Previous owner is not confirmed absent',
    detail: 'The previous collector may still exist, or its absence could not be verified.',
    next: 'Close the known original collector normally and inspect its shutdown result before restarting. Do not terminate an unrelated process based on a stored identifier.',
  },
  'activity-evidence-unavailable': {
    title: 'Activity evidence is missing or inconsistent',
    detail: 'Recovery could not match the durable activity record to the pending operation.',
    next: 'Preserve both records and reconcile the original operation. Replacing or deleting a record would erase the evidence needed to determine what happened.',
  },
  'legacy-active-work-unverifiable': {
    title: 'Older active work has no process-group evidence',
    detail: 'This activity format records unfinished work but cannot identify its owned process groups.',
    next: 'Reconcile the original work or use verified same-machine reboot recovery where supported. A dead parent alone does not prove its child processes exited.',
  },
  'command-registration-incomplete': {
    title: 'Command launch was not fully recorded',
    detail: 'The collector stopped between preparing a command and recording whether its process group started.',
    next: 'Reconcile the original launch before another attempt. Automatic same-boot recovery cannot determine whether this command ran.',
  },
  'process-group-not-confirmed-absent': {
    title: 'Recorded process group is not confirmed absent',
    detail: 'A recorded group may still exist, or its absence could not be verified.',
    next: 'Allow known owned work to finish normally, then restart the configured collector. Recovery only observes stored groups; it never kills them.',
  },
  'pending-evidence-unavailable': {
    title: 'Pending record could not be verified',
    detail: 'The pending record is unavailable, malformed or does not satisfy the private-storage checks.',
    next: 'Inspect the local record and storage integrity without rewriting the evidence. No account or provider state was established by this check.',
  },
  'recovery-confirmation-failed': {
    title: 'Recovery could not be confirmed',
    detail: 'Recovery evidence changed or could not be durably confirmed.',
    next: 'Preserve the pending and recovery records for reconciliation. A recorded authorization is not proof that cleanup completed.',
  },
};

export function QuotaRefreshPanel({ refresh, collector, selectedWorkerId, onSelect, historical = false }: {
  refresh: ResourceConsoleSnapshot['quotaRefresh'];
  collector?: ResourceConsoleSnapshot['metadataCollector'];
  selectedWorkerId?: string | null;
  onSelect: (id: string) => void;
  historical?: boolean;
}) {
  if (!refresh && !collector) return null;
  const recovery = collector?.state === 'blocked' && collector.recovery && Object.hasOwn(RECOVERY, collector.recovery.reasonCode)
    && RESOURCE_COLLECTOR_RECOVERY_MARKER_VERSIONS[collector.recovery.reasonCode].some((version) => version === collector.recovery!.markerVersion)
    ? RECOVERY[collector.recovery.reasonCode] : undefined;
  return <section className={styles.board} aria-labelledby="quota-refresh-title">
    <div className={styles.sectionHeading}><div><h2 id="quota-refresh-title">{refresh ? 'Native quota reads' : 'Native metadata collection'}</h2>
      <p>{refresh ? 'The foreground collector reads enrolled Codex metadata.' : 'Configured quota and account monitoring share one foreground collector.'} Viewing this panel does not start a provider request.</p></div></div>
    {historical ? <p className={styles.warning}>Last successful read only. Current collector activity and quota freshness are unverified.</p> : null}
    {collector ? <div className={styles.collectorNotice} role="status">
      <StatusBadge status={historical ? 'unknown' : collector.state === 'blocked' ? 'warning' : 'info'} tone={historical ? 'unknown' : collector.state === 'blocked' ? 'warning' : 'info'}>
        {historical ? `Last reported: ${collector.state === 'blocked' ? 'Collection blocked' : 'Collector started'}` : collector.state === 'blocked' ? 'Collection blocked' : 'Collector started'}
      </StatusBadge>
      <p>{historical ? 'Last reported detail: ' : ''}{Object.hasOwn(COLLECTOR_REASONS, collector.reasonCode) ? COLLECTOR_REASONS[collector.reasonCode] : 'Collector details are unavailable.'}</p>
      {recovery ? <div className={styles.recoveryDetail}>
        <h3>{historical ? 'Last reported diagnosis: ' : 'Sampled diagnosis: '}{recovery.title}</h3>
        <p>{recovery.detail}</p>
        <details><summary>{historical ? 'Guidance for that recorded condition' : 'What to do next'}</summary>
          <p>{recovery.next}</p>
          <p>Diagnosis describes the startup check, not current process health or permission to clear evidence.</p>
        </details>
      </div> : null}
      <p className={styles.boardNote}>Collector lifecycle recorded: {resourceTime(collector.sampledAt)}.</p>
      {collector.state === 'blocked' ? <p className={styles.boardNote}>{historical
        ? 'At that sample, replacement metadata reads were not scheduled and enrolled quota workers were withheld.'
        : 'This console does not schedule replacement metadata reads. Enrolled quota workers remain withheld until collection is restored.'} Account connection and quota freshness are unknown; configured monitoring is not a successful sample. There is no automatic retry.</p> : null}
    </div> : null}
    {refresh ? <><div className={styles.performanceScroll} tabIndex={0} role="region" aria-label="Native quota read status">
      <table className={styles.performanceTable}>
        <caption>{historical ? `Last reported collector state: ${refresh.state === 'closed' ? 'stopped' : 'collection enabled'}.`
          : refresh.state === 'closed' ? 'Collector stopped.' : 'Foreground collection enabled.'} Last collector snapshot: {resourceTime(refresh.sampledAt)}.</caption>
        <thead><tr><th scope="col">Worker</th><th scope="col">Native metadata status</th>
          <th scope="col">Last successful sample</th><th scope="col">{historical ? 'Previously scheduled attempt' : 'Next attempt'}</th></tr></thead>
        <tbody>{refresh.workers.map((row) => {
          const state = row.status === 'observed' && row.reason === 'managed-quota-unknown'
            ? { label: 'Observed; quota unknown', tone: 'unknown' as const }
            : row.status === 'observed' && row.reason === 'managed-quota-reserve-reached'
              ? { label: 'Observed; reserve reached', tone: 'warning' as const }
            : row.status === 'observed' && row.reason === 'managed-allocation-unavailable'
              ? { label: 'Observed; allocation unavailable', tone: 'unknown' as const }
            : Object.hasOwn(STATES, row.status) ? STATES[row.status]! : { label: 'Unknown', tone: 'unknown' as const };
          const reason = Object.hasOwn(REASONS, row.reason) ? REASONS[row.reason]! : 'Metadata status details are unavailable.';
          return <tr key={row.workerId}>
            <th scope="row"><button type="button" className={styles.performanceWorker}
              aria-pressed={selectedWorkerId === row.workerId} onClick={() => onSelect(row.workerId)}>{row.workerId}</button></th>
            <td><StatusBadge status={historical ? 'unknown' : state.label} tone={historical ? 'unknown' : state.tone}>
              {historical ? `Last reported: ${state.label}` : state.label}</StatusBadge><small>{historical ? `Last reported detail: ${reason}` : reason}</small></td>
            <td>{row.lastSuccessAt ? resourceTime(row.lastSuccessAt) : 'No successful sample'}
              {row.lastAttemptAt ? <small>Last attempt: {resourceTime(row.lastAttemptAt)}</small> : null}</td>
            <td>{row.nextAttemptAt ? resourceTime(row.nextAttemptAt)
              : historical ? row.status === 'refreshing' ? 'Previously in progress' : 'Previously not scheduled'
                : row.status === 'refreshing' ? 'Read in progress' : 'Not scheduled'}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className={styles.boardNote}>Native metadata does not prove independent accounts or readiness to execute. Every enrolled alias in shared capacity needs a current successful read. Unknown or expired quota still withholds admission; inspect the capacity board for all routing constraints.</p></> : null}
  </section>;
}
