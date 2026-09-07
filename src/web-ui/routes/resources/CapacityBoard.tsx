import type { ResourceConsoleSnapshot, ResourceConsoleGroup } from '../../../core/resources/console-types.js';
import type { ResourceObservation } from '../../../core/resources/pool-policy.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import styles from './ResourcePoolView.module.css';

export type ConsoleWorker = ResourceConsoleSnapshot['pool']['workers'][number];
export const resourceNumber = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString();
export function resourceTime(value: string | null | undefined): string {
  if (!value) return 'Not reported';
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toLocaleString() : 'Unknown';
}

const REASONS: Record<string, string> = {
  'worker-not-allowed': 'Not in this task’s worker allowlist', 'worker-unavailable': 'Shared capacity is unavailable',
  'provider-retry-after': 'Provider retry interval or failure cooldown', 'observation-missing': 'No quota observation',
  'observation-future': 'Observation capture time is in the future', 'observation-stale': 'Observation needs refreshing',
  'quota-windows-missing': 'Quota windows have not been observed', 'quota-window-unknown': 'A quota window is unknown',
  'quota-window-reset-passed': 'Reset passed; fresh quota evidence is still required', 'quota-reserve-reached': 'Quota reserve reached',
  'concurrency-exhausted': 'Shared capacity is occupied', 'operator-task-cap-reached': 'Operator task cap reached',
};
export const resourceReason = (reason: string) => REASONS[reason] ?? reason.replaceAll('-', ' ');

export function QuotaEvidence({ observation, sampledAt, workerId, historical = false }: {
  observation: ResourceObservation | undefined; sampledAt: string; workerId: string; historical?: boolean;
}) {
  if (!observation) return <p className={styles.muted}>No observation recorded. Unknown quota is not unused capacity.</p>;
  const stale = Date.parse(observation.expiresAt) <= Date.parse(sampledAt);
  const future = Date.parse(observation.updatedAt ?? observation.observedAt) > Date.parse(sampledAt);
  return <div className={styles.quotaEvidence}>
    <div className={styles.inline}><StatusBadge status={historical || stale || future ? 'unknown' : observation.health}
      tone={historical || stale || future ? 'unknown' : observation.health === 'ready' ? 'info' : 'warning'}>
      {historical ? 'Evidence at last successful read' : future ? 'Future capture time' : stale ? 'Stale observation' : observation.health === 'ready' ? 'Fresh observation' : 'Unavailable'}
    </StatusBadge></div>
    <dl className={styles.facts}>
      <div><dt>Oldest retained capture</dt><dd>{resourceTime(observation.observedAt)}</dd></div>
      <div><dt>Latest partial capture</dt><dd>{resourceTime(observation.updatedAt ?? observation.observedAt)}</dd></div>
      <div><dt>Evidence expires</dt><dd>{resourceTime(observation.expiresAt)}</dd></div>
      {observation.retryAfter ? <div><dt>Retry no earlier than</dt><dd>{resourceTime(observation.retryAfter)}</dd></div> : null}
    </dl>
    {observation.windows.length ? <ul className={styles.windows} aria-label={`${workerId} quota windows`}>
      {observation.windows.map((window) => <li key={window.id}>
        <div className={styles.windowTitle}><strong>{window.id === 'hub_observation_overflow' ? 'Quota inventory overflow' : window.id}</strong>
          <span>{window.usedPercent === null ? 'Unknown' : `${window.usedPercent}% reported used`}</span></div>
        {window.usedPercent === null ? <div className={styles.unknownMeter} aria-label="Utilization unknown" />
          : <meter className={styles.meter} min={0} max={100} value={window.usedPercent}
            aria-label={`${workerId} ${window.id} reported utilization`}>{window.usedPercent}%</meter>}
        <p className={styles.caption}>{window.id === 'hub_observation_overflow' ? 'Incomplete bucket inventory. Ordinary refresh cannot establish recovery.'
          : `Reset: ${resourceTime(window.resetsAt)}. Reset time alone does not reopen capacity.`}</p>
      </li>)}
    </ul> : <p className={styles.muted}>No provider quota windows reported. Local workers use fresh health and operator caps.</p>}
  </div>;
}

export function WorkerInspector({ worker, snapshot, historical = false }: { worker: ConsoleWorker; snapshot: ResourceConsoleSnapshot; historical?: boolean }) {
  const candidate = snapshot.plan?.candidates.find((item) => item.workerId === worker.id);
  const exclusion = snapshot.plan?.exclusions.find((item) => item.workerId === worker.id);
  return <section className={styles.inspector} aria-label={`Worker ${worker.id}`}>
    <div className={styles.sectionHeading}><div><h2 tabIndex={-1} data-inspector-heading>{worker.id}</h2><p>{worker.provider} · {worker.model}</p></div></div>
    {historical ? <p className={styles.warning}>Last successful read only. This routing preview and quota evidence do not establish current eligibility.</p> : null}
    {snapshot.sourceState === 'degraded' ? <p className={styles.warning}>Routing evidence is unavailable. No admission is implied.</p>
      : historical ? <p className={styles.muted}>{candidate ? 'Eligible in the last observed preview.' : 'Not eligible in the last observed preview.'}</p>
      : candidate ? <p className={styles.routeNote}>{candidate.reason === 'operator-capped-unknown-quota'
        ? 'Eligible under operator caps only. Provider quota is unknown.' : 'Eligible in the all-enrolled-worker preview. Actual tasks recheck capacity before reservation.'}</p>
        : <ul className={styles.reasonList}>{exclusion?.reasons.map((reason) => <li key={reason}>{resourceReason(reason)}</li>) ?? <li>Routing evidence unavailable</li>}</ul>}
    <dl className={styles.facts}>
      <div><dt>Shared capacity</dt><dd><code>{worker.capacityKey}</code></dd></div>
      <div><dt>Concurrent task cap</dt><dd>{worker.maxConcurrent}</dd></div>
      <div><dt>Operator task cap</dt><dd>{worker.maxTasksPerWindow} per {worker.taskWindowMs / 1000} seconds</dd></div>
      <div><dt>Provider reserve</dt><dd>{worker.reservePercent}%</dd></div>
      <div><dt>Routing priority</dt><dd>{worker.priority}</dd></div>
      <div><dt>Unknown-quota policy</dt><dd>{worker.allowUnknownQuota ? 'Explicit operator-capped dispatch' : 'Wait for known quota'}</dd></div>
    </dl>
    <h3>Quota evidence</h3>
    <QuotaEvidence observation={snapshot.observations.find((item) => item.workerId === worker.id)} sampledAt={snapshot.sampledAt} workerId={worker.id} historical={historical} />
  </section>;
}

function CapacityLane({ group, snapshot, selectedWorkerId, onSelect, historical }: {
  group: ResourceConsoleGroup; snapshot: ResourceConsoleSnapshot; selectedWorkerId: string | null; onSelect: (id: string) => void; historical: boolean;
}) {
  const workers = snapshot.pool.workers.filter((worker) => group.workerIds.includes(worker.id));
  return <section className={styles.capacityLane} aria-label={`Capacity group ${group.capacityKey}`}>
    <div className={styles.capacitySource}>
      <span className={styles.sourceGlyph} aria-hidden="true">⇄</span><h3>{group.capacityKey}</h3>
      <p className={styles.slotCount}><strong>{resourceNumber(group.occupiedSlots)}</strong> / {group.maxConcurrent} occupied</p>
      <p className={styles.caption}>{workers.length} {workers.length === 1 ? 'worker' : 'workers sharing capacity'}</p>
      <p className={styles.caption}>{resourceNumber(group.recentTaskCount)} / {group.maxTasksPerWindow} tasks in the operator window</p>
      {group.uncertainCount ? <p className={styles.warning}>{group.uncertainCount} unresolved reservation{group.uncertainCount === 1 ? '' : 's'}</p> : null}
    </div>
    <ul className={styles.workerLanes}>
      {workers.map((worker) => {
        const candidate = snapshot.plan?.candidates.find((item) => item.workerId === worker.id);
        const exclusion = snapshot.plan?.exclusions.find((item) => item.workerId === worker.id);
        const next = !historical && snapshot.sourceState !== 'degraded' && snapshot.plan?.selectedWorkerId === worker.id;
        const occupied = snapshot.activeAttempts.filter((attempt) => attempt.workerId === worker.id).length;
        return <li key={worker.id} className={styles.workerLane}>
          <button className={`${styles.workerButton} ${next ? styles.nextWorker : ''}`} type="button"
            aria-pressed={selectedWorkerId === worker.id} onClick={() => onSelect(worker.id)}>
            <span className={styles.workerHeading}><strong>{worker.id}</strong>
              <StatusBadge status={historical || snapshot.sourceState === 'degraded' ? 'unknown' : candidate ? 'eligible' : 'blocked'} tone={historical || snapshot.sourceState === 'degraded' ? 'unknown' : candidate ? 'info' : 'warning'}>
                {historical ? candidate ? 'Previously eligible' : 'Previously not eligible' : snapshot.sourceState === 'degraded' ? 'Evidence unavailable' : next ? 'Next eligible' : candidate ? 'Eligible' : 'Not eligible'}</StatusBadge></span>
            <span className={styles.muted}>{worker.provider} · {worker.model}</span>
            <span className={styles.caption}>{candidate?.reason === 'operator-capped-unknown-quota' ? 'Unknown quota · operator caps only'
              : candidate ? `${candidate.usedPercent === null ? 'Quota not measured' : `${candidate.usedPercent}% maximum window utilization`} · inspect all windows`
                : exclusion?.reasons.map(resourceReason).join('; ') || 'Routing evidence unavailable'}</span>
            {occupied ? <span className={styles.occupied}>{occupied} occupied task reservation{occupied === 1 ? '' : 's'}</span> : null}
          </button>
        </li>;
      })}
    </ul>
  </section>;
}

export function CapacityBoard({ snapshot, selectedWorkerId, onSelect, historical = false }: {
  snapshot: ResourceConsoleSnapshot; selectedWorkerId: string | null; onSelect: (id: string) => void; historical?: boolean;
}) {
  return <section className={styles.board} aria-labelledby="capacity-title">
    <div className={styles.sectionHeading}><div><h2 id="capacity-title">Routing board</h2>
      <p>Shared capacity → enrolled workers. Select a worker to inspect every quota window.</p></div></div>
    <div className={styles.preview}><span className={styles.routeDot} aria-hidden="true" />
      <span>{snapshot.sourceState === 'degraded' ? 'Routing evidence unavailable' : snapshot.plan?.selectedWorkerId
        ? <>{historical ? 'Last observed preview:' : 'Next eligible worker:'} <strong>{snapshot.plan.selectedWorkerId}</strong></>
        : historical ? 'No eligible worker in the last observed preview' : 'No worker is currently eligible'}</span>
      <small>All-enrolled preview, not a reserved assignment</small></div>
    {snapshot.groups.map((group) => <CapacityLane key={group.capacityKey} group={group} snapshot={snapshot}
      selectedWorkerId={selectedWorkerId} onSelect={onSelect} historical={historical} />)}
    {snapshot.groups.length === 0 ? <p className={styles.empty}>No capacity groups are available in this snapshot.</p> : null}
    <p className={styles.boardNote}>Configured workers are not proof of account login or live OS processes. Occupancy comes from task receipts; unresolved reservations retain their slot.</p>
  </section>;
}
