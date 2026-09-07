import { useId, useMemo, useState } from 'react';
import type { ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { resourceNumber, resourceReason, resourceTime } from './CapacityBoard.js';
import { buildResourceFleet, type ResourceFleetGroup, type ResourceFleetTask, type ResourceFleetWorker } from './fleet-model.js';
import { taskTone } from './TaskInspector.js';
import styles from './FleetMap.module.css';

type Selection = { kind: 'worker' | 'task'; id: string } | null;
interface FleetMapProps {
  snapshot: ResourceConsoleSnapshot;
  stale: boolean;
  selection: Selection;
  onSelect: (selection: Exclude<Selection, null>) => void;
}
const WORKERS_PER_PAGE = 8;
const TASKS_PER_PAGE = 3;
const RAIL_PER_PAGE = 8;
const matches = (query: string, ...values: string[]) => !query || values.some((value) => value.toLowerCase().includes(query));
const selected = (selection: Selection, kind: 'worker' | 'task', id: string) => selection?.kind === kind && selection.id === id;
const pageIndex = (page: number, length: number, size: number) => Math.min(page, Math.max(0, Math.ceil(length / size) - 1));
const FLEET_REASONS: Record<string, string> = {
  'eligible': 'Eligible in the all-enrolled preview; dispatch rechecks capacity',
  'operator-capped-unknown-quota': 'Unknown provider quota; explicit operator caps apply',
  'last-successful-read': 'Awaiting a fresh snapshot before evaluating new work',
  'resource-evidence-unavailable': 'Routing evidence is unavailable',
  'supervisor-not-enabled': 'This console does not own a task supervisor',
  'supervisor-closing': 'The supervisor is closing; no new dispatches will start',
  'supervisor-unavailable': 'The supervisor cannot establish safe admission',
  'queue-paused': 'The queue is paused; recorded work remains inspectable',
  'parallel-limit-reached': 'The supervisor has reached its concurrent dispatch limit',
  'no-queued-tasks': 'No queued tasks in this snapshot',
  'eligible-allowlist-preview': 'An allowed worker is eligible in preview; actual dispatch rechecks and reserves capacity',
  'no-eligible-allowed-workers': 'No allowed worker is eligible in the current preview',
  'assignment-evidence-conflict': 'Assignment evidence disagrees; no worker relationship is asserted',
  'queued-without-assignment': 'Queued; no worker assignment has been recorded',
  'assignment-pending': 'Dispatch requested; worker assignment is not yet recorded',
  'assignment-not-recorded': 'No worker assignment has been recorded',
  'assigned-worker-not-enrolled': 'Recorded worker is not enrolled in this pool',
};
const fleetReason = (reason: string) => FLEET_REASONS[reason] ?? resourceReason(reason);

function Pager({ page, length, size, label, onChange }: {
  page: number; length: number; size: number; label: string; onChange: (page: number) => void;
}) {
  if (length <= size) return null;
  return <div className={styles.pager} aria-label={`${label} pages`}>
    <button type="button" aria-label={`Previous ${label}`} disabled={page === 0} onClick={() => onChange(page - 1)}>Previous</button>
    <span>{page + 1} / {Math.ceil(length / size)}</span>
    <button type="button" aria-label={`Next ${label}`} disabled={(page + 1) * size >= length} onClick={() => onChange(page + 1)}>Next</button>
  </div>;
}

function TaskNode({ task, selection, onSelect, connected = false }: {
  task: ResourceFleetTask; selection: Selection; onSelect: FleetMapProps['onSelect']; connected?: boolean;
}) {
  return <button type="button" className={`${styles.taskNode} ${connected ? styles.connectedTask : ''} ${task.active ? styles.activeTask : ''}`}
    aria-label={`Inspect map task ${task.id}`} aria-pressed={selected(selection, 'task', task.id)}
    onClick={() => onSelect({ kind: 'task', id: task.id })}>
    <span className={styles.nodeHeading}><strong>{task.id}</strong><StatusBadge status={task.state} tone={taskTone(task)} /></span>
    <span className={styles.nodeDetail}>{task.ownership}</span>
    {task.assignment === 'recorded' ? <span className={styles.provenance}>{task.active ? 'Recorded occupancy' : 'Recorded history'}; not a process heartbeat</span>
      : <span className={styles.provenance}>{fleetReason(task.assignmentReason)}</span>}
    {task.stateDisagreement ? <span className={styles.queueReason}>Supervisor and receipt states differ; sources sampled separately.</span> : null}
    {task.queuePreview ? <span className={styles.queueReason}>
      {task.queuePreview.state === 'ready' ? `${task.queuePreview.eligibleWorkerIds.length} eligible in preview; not assigned`
        : task.queuePreview.reasons.map(fleetReason).join('; ') || 'Waiting for eligible capacity'}
    </span> : null}
  </button>;
}

function WorkerBranch({ worker, selection, onSelect, query }: {
  worker: ResourceFleetWorker; selection: Selection; onSelect: FleetMapProps['onSelect']; query: string;
}) {
  const [page, setPage] = useState(0);
  const matchingTasks = worker.tasks.filter((task) => matches(query, task.id) || matches(query, worker.id, worker.model, worker.provider, worker.capacityKey));
  const currentPage = pageIndex(page, matchingTasks.length, TASKS_PER_PAGE);
  const shownTasks = matchingTasks.slice(currentPage * TASKS_PER_PAGE, (currentPage + 1) * TASKS_PER_PAGE);
  const highlighted = selected(selection, 'worker', worker.id) || worker.tasks.some((task) => selected(selection, 'task', task.id));
  const activeCount = worker.tasks.filter((task) => task.active).length;
  return <li className={`${styles.workerBranch} ${highlighted ? styles.highlightedBranch : ''}`}>
    <button type="button" className={`${styles.workerNode} ${shownTasks.length ? styles.assignedWorker : ''}`} aria-label={`Inspect map worker ${worker.id}`}
      aria-pressed={selected(selection, 'worker', worker.id)} onClick={() => onSelect({ kind: 'worker', id: worker.id })}>
      <span className={styles.nodeHeading}><strong>{worker.id}</strong><StatusBadge status={worker.eligibility}
        tone={worker.eligibility === 'eligible' ? 'info' : worker.eligibility === 'blocked' ? 'warning' : 'unknown'}>
        {worker.eligibility === 'eligible' ? 'Eligible preview' : worker.eligibility === 'blocked' ? 'Not eligible' : 'Unknown eligibility'}
      </StatusBadge></span>
      <span className={styles.nodeDetail}>{worker.provider} / {worker.model}</span>
      <span className={styles.workerReason}>{worker.reasons.map(fleetReason).join('; ') || 'All-enrolled preview; rechecked before dispatch'}</span>
      <span className={styles.provenance}>{activeCount} recorded occupanc{activeCount === 1 ? 'y' : 'ies'}; {worker.tasks.length - activeCount} historical</span>
    </button>
    <div className={styles.assignments}>
      {shownTasks.length ? <ul className={styles.taskList} aria-label={`Assignments for ${worker.id}`}>
        {shownTasks.map((task) => <li key={task.id}><TaskNode task={task} selection={selection} onSelect={onSelect} connected /></li>)}
      </ul> : <p className={styles.noAssignment}>{query && worker.tasks.length ? 'No matching recorded assignment' : 'No recorded assignment'}<span>Configuration does not prove a running agent.</span></p>}
      {matchingTasks.length > TASKS_PER_PAGE ? <div className={styles.assignmentFooter}>
        <span>{currentPage * TASKS_PER_PAGE + 1}–{Math.min((currentPage + 1) * TASKS_PER_PAGE, matchingTasks.length)} of {matchingTasks.length} assignments</span>
        <Pager page={currentPage} length={matchingTasks.length} size={TASKS_PER_PAGE} label={`${worker.id} assignments`} onChange={setPage} />
      </div> : null}
    </div>
  </li>;
}

function CapacityTrunk({ group, selection, onSelect, query, filteredWorkerCount }: {
  group: ResourceFleetGroup; selection: Selection; onSelect: FleetMapProps['onSelect']; query: string; filteredWorkerCount: number;
}) {
  const highlighted = group.workers.some((worker) => selected(selection, 'worker', worker.id) || worker.tasks.some((task) => selected(selection, 'task', task.id)));
  return <section className={`${styles.capacityTrunk} ${highlighted ? styles.highlightedTrunk : ''}`} aria-label={`Fleet capacity ${group.capacityKey}`}>
    <div className={styles.capacityNode}>
      <span className={styles.capacityGlyph} aria-hidden="true"><i /><i /><i /></span>
      <h3>{group.capacityKey}</h3>
      <p className={styles.capacityCount}><strong>{resourceNumber(group.occupiedSlots)}</strong><span>/ {group.maxConcurrent} shared slots occupied</span></p>
      {group.occupiedSlots === null ? <div className={styles.unknownMeter} aria-label={`${group.capacityKey} occupancy unknown`}>Occupancy unknown</div>
        : <meter className={styles.meter} min={0} max={group.maxConcurrent} value={Math.min(group.occupiedSlots, group.maxConcurrent)}
          aria-label={`${group.capacityKey} occupied shared slots`}>{group.occupiedSlots} of {group.maxConcurrent}</meter>}
      <p className={styles.provenance}>{group.workerIds.length} enrolled {group.workerIds.length === 1 ? 'worker' : 'aliases'} sharing this cap</p>
      {filteredWorkerCount > group.workers.length ? <p className={styles.provenance}>{group.workers.length} of {filteredWorkerCount} matching workers on this page</p> : null}
      {group.uncertainCount ? <p className={styles.uncertain}>{group.uncertainCount} unresolved; slots retained</p> : null}
      <p className={styles.provenance}>Declared sharing, not verified account identity</p>
    </div>
    <ul className={styles.workerBranches} aria-label={`Workers sharing ${group.capacityKey}`}>
      {group.workers.map((worker) => <WorkerBranch key={worker.id} worker={worker} selection={selection} onSelect={onSelect} query={query} />)}
    </ul>
  </section>;
}

function TaskRail({ title, description, tasks, selection, onSelect, query }: {
  title: string; description: string; tasks: ResourceFleetTask[]; selection: Selection; onSelect: FleetMapProps['onSelect']; query: string;
}) {
  const [page, setPage] = useState(0);
  const filtered = tasks.filter((task) => matches(query, task.id, ...(task.job?.allowedWorkerIds ?? [])));
  const currentPage = pageIndex(page, filtered.length, RAIL_PER_PAGE);
  const shown = filtered.slice(currentPage * RAIL_PER_PAGE, (currentPage + 1) * RAIL_PER_PAGE);
  return <section className={styles.rail} aria-label={title}>
    <div className={styles.railHeader}><div><h3>{title} <span>{tasks.length}</span></h3><p>{description}</p></div>
      <Pager page={currentPage} length={filtered.length} size={RAIL_PER_PAGE} label={title.toLowerCase()} onChange={setPage} /></div>
    {shown.length ? <><p className={styles.provenance}>Showing {currentPage * RAIL_PER_PAGE + 1}–{Math.min((currentPage + 1) * RAIL_PER_PAGE, filtered.length)} of {filtered.length}{query ? ` matching; ${tasks.length} included in snapshot` : ' included in snapshot'}</p>
      <ul className={styles.railTasks}>{shown.map((task) => <li key={task.id}><TaskNode task={task} selection={selection} onSelect={onSelect} /></li>)}</ul></>
      : <p className={styles.emptyRail}>{query && tasks.length ? 'No matching tasks.' : 'No tasks in this lane in the supplied snapshot.'}</p>}
  </section>;
}

/** Read-only topology: all links come from recorded assignment evidence, never allowlists. */
export function FleetMap({ snapshot, stale, selection, onSelect }: FleetMapProps) {
  const titleId = useId();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const fleet = useMemo(() => buildResourceFleet(snapshot, stale), [snapshot, stale]);
  const normalizedQuery = query.trim().toLowerCase();
  const workers = fleet.groups.flatMap((group) => group.workers);
  const matchingWorkers = workers.filter((worker) => matches(normalizedQuery, worker.id, worker.provider, worker.model, worker.capacityKey, ...worker.tasks.map((task) => task.id)));
  const currentPage = pageIndex(page, matchingWorkers.length, WORKERS_PER_PAGE);
  const visibleIds = new Set(matchingWorkers.slice(currentPage * WORKERS_PER_PAGE, (currentPage + 1) * WORKERS_PER_PAGE).map((worker) => worker.id));
  const visibleGroups = fleet.groups.map((group) => ({ ...group, workers: group.workers.filter((worker) => visibleIds.has(worker.id)) })).filter((group) => group.workers.length);
  const selectedWorker = workers.find((worker) => selected(selection, 'worker', worker.id) || worker.tasks.some((task) => selected(selection, 'task', task.id)));
  return <section className={styles.fleetMap} aria-labelledby={titleId}>
    <header className={styles.header}><div><h2 id={titleId} tabIndex={-1}>Fleet map</h2><p>Follow shared capacity into enrolled workers and their recorded work.</p></div>
      <div className={styles.sample}><StatusBadge status={stale ? 'unknown' : fleet.evidenceAvailable ? 'info' : 'unknown'} tone={fleet.evidenceAvailable ? 'info' : 'unknown'}>
        {stale ? 'Previous snapshot' : fleet.evidenceAvailable ? 'Local evidence' : 'Evidence unavailable'}
      </StatusBadge><span>Sampled {resourceTime(snapshot.sampledAt)}</span></div></header>
    <div className={styles.summary}>
      <span><strong>{fleet.counts.capacityGroups}</strong> capacity groups</span><span><strong>{fleet.counts.workers}</strong> enrolled workers</span>
      <span><strong>{resourceNumber(fleet.counts.occupiedSlots)}</strong> / {fleet.counts.slotLimit} shared slots occupied</span>
      <span><strong>{resourceNumber(fleet.counts.ownedDispatches)}</strong> console-owned dispatches</span>
    </div>
    {stale || !fleet.evidenceAvailable ? <p className={styles.evidenceNotice}>{stale ? 'This is the last successful snapshot. Eligibility and queue previews are withheld until a fresh read succeeds.' : 'Routing evidence is unavailable. Known configuration and retained assignments do not establish current capacity.'}</p> : null}
    <div className={styles.toolbar}><div className={styles.search}><label htmlFor={searchId}>Find a worker or task</label>
      <input id={searchId} type="search" value={query} maxLength={160} placeholder="Worker, model, provider, capacity or task ID"
        onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></div>
      <div className={styles.workerPaging}><span>{matchingWorkers.length ? `${currentPage * WORKERS_PER_PAGE + 1}–${Math.min((currentPage + 1) * WORKERS_PER_PAGE, matchingWorkers.length)}` : '0'} of {matchingWorkers.length} matching workers; {workers.length} enrolled</span>
        <Pager page={currentPage} length={matchingWorkers.length} size={WORKERS_PER_PAGE} label="workers" onChange={setPage} /></div></div>
    <div className={styles.laneHeadings} aria-hidden="true"><span>Shared capacity</span><span>Enrolled workers</span><span>Recorded assignments</span></div>
    <div className={styles.topology}>
      {visibleGroups.map((group) => <CapacityTrunk key={group.capacityKey} group={group} selection={selection} onSelect={onSelect} query={normalizedQuery}
        filteredWorkerCount={matchingWorkers.filter((worker) => worker.capacityKey === group.capacityKey).length} />)}
      {!visibleGroups.length ? <p className={styles.empty}>{workers.length ? 'No workers match this search. Waiting and unassigned task matches appear below.' : 'No enrolled workers are present in this snapshot. Configure a resource pool to establish the fleet topology.'}</p> : null}
    </div>
    {selectedWorker ? <p className={styles.selectionPath}>Selected path: <strong>{selectedWorker.capacityKey}</strong><span aria-hidden="true"> / </span><strong>{selectedWorker.id}</strong>{selection?.kind === 'task' ? <> / <strong>{selection.id}</strong></> : null}
      {!visibleIds.has(selectedWorker.id) ? <span> (worker is outside the current search or page)</span> : null}</p> : null}
    <div className={styles.queueState}><StatusBadge status={fleet.queue.state} tone={fleet.queue.state === 'ready' ? 'info' : fleet.queue.state === 'unavailable' ? 'unknown' : 'neutral'}>
      Queue {fleet.queue.state}</StatusBadge><p>{fleetReason(fleet.queue.reason)}</p>
      {fleet.queue.nextRecheckAt ? <span>Recorded quota recheck hint: {resourceTime(fleet.queue.nextRecheckAt)}; not a promised start.</span> : null}</div>
    <TaskRail title="Waiting for assignment" description="Allowed workers indicate possibilities, not task assignments. No worker edges are drawn here."
      tasks={fleet.queued} selection={selection} onSelect={onSelect} query={normalizedQuery} />
    {fleet.unassigned.length ? <TaskRail title="Unassigned or unresolved placement" description="These records do not establish a worker relationship. Inspect a task for its recorded evidence."
      tasks={fleet.unassigned} selection={selection} onSelect={onSelect} query={normalizedQuery} /> : null}
    <footer className={styles.footer}><span>{fleet.counts.includedTasks} task records included; {resourceNumber(fleet.counts.omittedHistory)} historical records omitted by the source.</span>
      <span>Lines mean configured sharing or recorded assignments. They do not attest account independence, process liveness or accepted engineering yield.</span></footer>
  </section>;
}
