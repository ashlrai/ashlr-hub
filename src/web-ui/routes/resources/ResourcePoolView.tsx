import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResourceConsoleScope, ResourceConsoleTaskInput } from '../../../core/resources/console-types.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { runQuery } from '../../data/cache.js';
import { ApiError } from '../../data/client.js';
import { useMutationHold, useQuery } from '../../data/hooks.js';
import { cancelResourceTask, resourceConsoleSnapshotQuery, setResourceAllocation, setResourceQueuePaused, setResourceWorkerAccessControl, submitResourceTask } from '../../data/resource-pool-queries.js';
import { CapacityBoard, resourceNumber, resourceTime, WorkerInspector } from './CapacityBoard.js';
import { TaskComposer } from './TaskComposer.js';
import { PerformancePanel } from './PerformancePanel.js';
import { QuotaRefreshPanel } from './QuotaRefreshPanel.js';
import { AccountConnections } from './AccountConnections.js';
import { AllocationControl } from './AllocationControl.js';
import { WorkerAccessControl } from './WorkerAccessControl.js';
import { TaskInspector, taskOwnership, taskState, taskTone } from './TaskInspector.js';
import { FleetMap } from './FleetMap.js';
import { buildResourceFleet } from './fleet-model.js';
import styles from './ResourcePoolView.module.css';

export function ResourcePoolView({ scope }: { scope: ResourceConsoleScope }) {
  const definition = useMemo(() => resourceConsoleSnapshotQuery(scope.poolId), [scope.poolId]);
  const query = useQuery(definition);
  const refresh = useCallback(() => runQuery(definition.key, definition.fetch), [definition]);
  const hold = useMutationHold();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [allocationBusy, setAllocationBusy] = useState(false);
  const [workerAccessBusy, setWorkerAccessBusy] = useState(false);
  const [workerAccessError, setWorkerAccessError] = useState<string | null>(null);
  const [workerAccessNotice, setWorkerAccessNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ kind: 'worker' | 'task'; id: string } | null>(null);
  const [tab, setTab] = useState<'inspect' | 'compose'>('compose');
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [showAllOwned, setShowAllOwned] = useState(false);
  const inspector = useRef<HTMLDivElement>(null);
  const fleetMapRegion = useRef<HTMLDivElement>(null);
  const focusVersion = useRef(0);
  const [inspectionRequest, setInspectionRequest] = useState(0);
  const snapshot = query.data;
  const supervisor = snapshot?.supervisor;
  // Share the map's conservative assignment interpretation with every inspector
  // and row. Independently sampled records may not yet agree on a worker.
  const historical = !!query.error;
  const fleet = useMemo(() => snapshot ? buildResourceFleet(snapshot, historical) : null, [snapshot, historical]);
  const rows = fleet?.tasks ?? [];
  const ownedRows = rows.filter((row) => row.job?.state === 'dispatching');
  const selectedWorker = snapshot?.pool.workers.find((worker) => worker.id === selection?.id && selection.kind === 'worker');
  const selectedTask = rows.find((row) => row.id === selection?.id && selection.kind === 'task');
  const stopEnabled = !scope.readOnly && !!supervisor && !supervisor.closing;
  // The cache retains its error during a retry. Starting that retry is not
  // evidence of recovery and must not reopen dispatch or hide stale labels.
  const enabled = stopEnabled && !supervisor.error &&
    snapshot?.sourceState !== 'degraded' && !historical && query.status !== 'loading';
  const allocationEnabled = scope.allocationWritable === true && !!snapshot?.allocation &&
    snapshot.sourceState !== 'degraded' && !historical && query.status !== 'loading';
  const workerAccessEnabled = scope.allocationWritable === true && !!snapshot?.workerAccess &&
    snapshot.sourceState !== 'degraded' && !historical && query.status !== 'loading';

  async function saveWorkerAccess(pausedWorkerIds: string[], expectedRevision: number): Promise<boolean> {
    if (!workerAccessEnabled || workerAccessBusy) return false;
    if (!hold.hasHold) { setUnlockOpen(true); return false; }
    setWorkerAccessBusy(true); setWorkerAccessError(null); setWorkerAccessNotice(null);
    try {
      await setResourceWorkerAccessControl(pausedWorkerIds, expectedRevision);
      setWorkerAccessNotice('Fleet account access saved. Running tasks and your usage ceiling are unchanged.');
      await refresh();
      return true;
    } catch (error) {
      setWorkerAccessError(error instanceof Error ? error.message : 'Account access could not be saved. Refresh before trying again.');
      if (error instanceof ApiError && error.status === 409) await refresh();
      return false;
    } finally { setWorkerAccessBusy(false); }
  }

  async function saveAllocation(ceilingPercent: number, expectedRevision: number): Promise<boolean> {
    if (!allocationEnabled || allocationBusy) return false;
    if (!hold.hasHold) { setUnlockOpen(true); return false; }
    setAllocationBusy(true); setActionError(null); setNotice(null);
    try {
      await setResourceAllocation(ceilingPercent, expectedRevision);
      setNotice(`Usage ceiling saved at ${ceilingPercent}%. This changes new admission; it does not stop in-flight tasks.`);
      await refresh();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Allocation could not be saved. Refresh before trying again.');
      if (error instanceof ApiError && error.status === 409) await refresh();
      return false;
    } finally { setAllocationBusy(false); }
  }

  function inspectSelection(next = selection) {
    setSelection(next); setTab('inspect'); setInspectionRequest((request) => request + 1);
  }

  useEffect(() => {
    // Only explicit inspection requests move focus. Polling must not pull the
    // keyboard away from the operator's current control or unsent draft.
    if (inspectionRequest > 0) inspector.current?.querySelector<HTMLElement>('[data-inspector-heading]')?.focus();
  }, [inspectionRequest]);

  useEffect(() => {
    const poll = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    const timer = window.setInterval(poll, 3_000);
    document.addEventListener('visibilitychange', poll);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [refresh]);

  async function action(operation: () => Promise<unknown>, success: string, stopping = false): Promise<boolean> {
    // Stale observation must not prevent pause/cancel; the server still checks
    // current ownership. Only new dispatch and resume depend on fresh evidence.
    if (!(stopping ? stopEnabled : enabled) || busy) return false;
    if (!hold.hasHold) { setUnlockOpen(true); return false; }
    setBusy(true); setActionError(null); setNotice(null);
    try { await operation(); setNotice(success); await refresh(); return true; }
    catch (error) { setActionError(error instanceof Error ? error.message : 'The action could not be completed. Refresh before trying again.'); return false; }
    finally { setBusy(false); }
  }

  async function submit(task: ResourceConsoleTaskInput): Promise<boolean> {
    const requestedAtFocus = focusVersion.current;
    const submitted = await action(() => submitResourceTask(task),
      `Task ${task.id} queued. The supervisor will recheck capacity before dispatch.`);
    if (submitted && requestedAtFocus === focusVersion.current) inspectSelection({ kind: 'task', id: task.id });
    return submitted;
  }

  async function cancel(id: string) {
    const requestedAtFocus = focusVersion.current;
    const succeeded = await action(() => cancelResourceTask(id), `Cancellation requested for ${id}.`, true);
    // Cancellation can remove its focused button. Repair that focus only when
    // the operator has not moved elsewhere during the request and refresh.
    if (succeeded && requestedAtFocus === focusVersion.current) inspectSelection({ kind: 'task', id });
  }

  const visibleRows = rows.filter((row) => filter === 'all' || (filter === 'active'
    ? row.active : taskState(row) === 'completed'));
  return <div className={styles.view} onFocusCapture={() => { focusVersion.current += 1; }}>
    <header className={styles.pageHeading}>
      <div><h1>Resource dispatch desk</h1><p>Route work across your enrolled accounts and local models.</p></div>
      <div className={styles.headerActions}>
        <button type="button" className={styles.secondaryButton} onClick={() => { void refresh(); }} disabled={query.status === 'loading' || query.status === 'refreshing'}>Refresh</button>
        {!scope.readOnly || scope.allocationWritable ? <button type="button" className={hold.hasHold ? styles.secondaryButton : styles.primaryButton}
          onClick={() => hold.hasHold ? hold.clear() : setUnlockOpen(true)}>{hold.hasHold ? 'Lock controls' : 'Unlock controls'}</button> : null}
      </div>
    </header>
    <div className={styles.statusBar}><div className={styles.freshness}>
      <strong>{scope.poolId}</strong>{snapshot ? <span>{historical ? 'Last successful read' : 'Observed'} {resourceTime(snapshot.sampledAt)}</span> : null}
      <span>Refreshes every 3 seconds while visible</span>{query.status === 'refreshing' ? <RefreshIndicator /> : null}
    </div>{snapshot ? <nav className={styles.sectionNav} aria-label="Resource sections">
      <a href="#resource-fleet">Fleet</a><a href="#resource-accounts">Accounts</a><a href="#resource-performance">Performance</a>
    </nav> : null}</div>
    {historical ? <div className={styles.notice} role="alert"><strong>Resource records unavailable</strong>
      <p>{query.error?.message} Any records below are from the last successful read. New tasks and queue resume wait for a fresh read; pause and owned-task cancellation remain available.</p></div> : null}
    {snapshot?.sourceState === 'degraded' ? <div className={styles.notice} role="alert"><strong>Resource evidence is incomplete</strong>
      <p>{snapshot.reasons.join('; ') || 'The selected records could not be verified.'} New tasks and queue resume are unavailable; pause and owned-task cancellation remain available.</p></div> : null}
    {actionError ? <div className={styles.notice} role="alert">{actionError}</div> : null}
    {notice ? <p className={styles.actionNotice} role="status">{notice}</p> : null}
    {query.status === 'loading' ? <section className={styles.loading} aria-label="Loading resource pool"><SkeletonLine width="50%" /><SkeletonLine /><SkeletonLine width="80%" /></section> : null}
    {snapshot ? <>
      <section className={styles.supervisor} aria-label="Foreground supervisor">
        <div><h2>{scope.readOnly ? 'Observation only' : supervisor?.paused ? 'Queue paused' : 'Foreground supervisor'}</h2>
          <p>{scope.readOnly ? 'No tasks are started or cancelled from this read-only session.' : supervisor
            ? `${supervisor.activeCount} console-owned dispatches · ${supervisor.queuedCount} queued · ${supervisor.maxParallel} parallel limit`
            : 'Task supervisor unavailable. No execution is implied.'}</p></div>
        {supervisor && !scope.readOnly ? <button type="button" className={styles.secondaryButton} disabled={!(supervisor.paused ? enabled : stopEnabled) || busy}
          onClick={() => { void action(() => setResourceQueuePaused(!supervisor.paused), supervisor.paused ? 'Queue resumed.' : 'Queue paused. Existing tasks continue.', !supervisor.paused); }}>
          {supervisor.paused ? 'Resume queue' : 'Pause queue'}</button> : null}
        {supervisor?.error || supervisor?.closing ? <p role="alert" className={styles.warning}>{supervisor.closing ? 'Supervisor is closing; new work is withheld.' : `Supervisor unavailable: ${supervisor.error}`}</p> : null}
        {ownedRows.length ? <section className={styles.ownedStrip} aria-label="Owned task dispatches">
          <div className={styles.ownedHeading}><h3>Owned task dispatches</h3>
            <span>{historical ? 'Last observed state' : 'This supervisor’s recorded assignments'}</span></div>
          <ul className={styles.ownedTasks}>{(showAllOwned ? ownedRows : ownedRows.slice(0, 4)).map((row) => <li key={row.id}>
            <button type="button" className={styles.ownedTask} aria-label={`Inspect owned dispatch ${row.id}`}
              aria-pressed={selection?.kind === 'task' && selection.id === row.id}
              onClick={() => inspectSelection({ kind: 'task', id: row.id })}>
              <strong>{row.id}</strong><span>{row.workerId ?? (row.assignment === 'conflict' ? 'Assignment evidence conflicts' : 'Assignment pending')}</span>
              <StatusBadge status="dispatching" tone="running" />
            </button>
          </li>)}</ul>
          {ownedRows.length > 4 ? <button type="button" className={styles.showOwned} onClick={() => setShowAllOwned((value) => !value)}>
            {showAllOwned ? 'Show first 4' : `Show ${ownedRows.length - 4} more owned dispatches`}</button> : null}
        </section> : null}
      </section>
      <section id="resource-fleet" tabIndex={-1} className={styles.workspaceGrid} aria-label="Fleet workspace">
        <div className={styles.mainColumn}>
          <div ref={fleetMapRegion}><FleetMap snapshot={snapshot} stale={historical} selection={selection} onSelect={inspectSelection} /></div>
          <section className={styles.tasks} aria-labelledby="tasks-title">
            <div className={styles.sectionHeading}><div><h2 id="tasks-title">Task activity</h2><p>Queue ownership and durable receipts, not inferred process liveness.</p></div>
              <label className={styles.filter}>Show<select aria-label="Task activity filter" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
                <option value="all">All tasks</option><option value="active">Queued / occupied</option><option value="completed">Completed</option></select></label></div>
            {visibleRows.length ? <ul className={styles.taskRows}>{visibleRows.map((row) => <li key={row.id}>
              <button type="button" className={styles.taskRow} aria-pressed={selection?.kind === 'task' && selection.id === row.id}
                onClick={() => inspectSelection({ kind: 'task', id: row.id })}>
                <span><strong>{row.id}</strong><small>{taskOwnership(row)}</small></span>
                <span className={styles.taskWorker}>{row.workerId ?? (row.assignment === 'conflict' ? 'Assignment evidence conflicts' : 'No confirmed assignment')}</span>
                <StatusBadge status={taskState(row)} tone={taskTone(row)} />
              </button></li>)}</ul> : <div className={styles.empty}><h3>{filter === 'all' ? 'No recorded tasks yet' : 'No matching tasks'}</h3>
                <p>{filter === 'all' ? 'Inspect a worker’s quota, then queue a concrete task when execution is enabled.' : 'Choose another filter to inspect the recorded task history.'}</p></div>}
            <p className={styles.boardNote}>{resourceNumber(snapshot.counts.total)} durable attempts. {resourceNumber(snapshot.counts.omittedHistory)} older terminal receipts omitted. All occupied reservations are shown.</p>
          </section>
        </div>
        <aside className={styles.sideColumn} aria-label="Resource workspace">
          <div className={styles.tabs} role="group" aria-label="Workspace panel">
            <button type="button" aria-pressed={tab === 'compose'} onClick={() => setTab('compose')}>Compose task</button>
            <button type="button" aria-pressed={tab === 'inspect'} onClick={() => inspectSelection()}>Inspect selection</button>
          </div>
          {tab === 'inspect' ? <button type="button" className={styles.returnToMap}
            onClick={() => fleetMapRegion.current?.querySelector<HTMLElement>('h2')?.focus()}>Back to fleet map</button> : null}
          {/* Keep unsent text while inspecting evidence; hidden forms are not interactive. */}
          <div hidden={tab !== 'compose'}><TaskComposer scope={scope} workers={snapshot.pool.workers} enabled={enabled}
            unlocked={hold.hasHold} busy={busy} onUnlock={() => setUnlockOpen(true)} onSubmit={submit} /></div>
          {tab === 'inspect' ? <div ref={inspector} className={styles.inspectionTarget}>{selectedWorker ? <WorkerInspector worker={selectedWorker} snapshot={snapshot} historical={historical} /> : selectedTask
            ? <TaskInspector key={`${supervisor?.instanceId ?? 'external'}:${selectedTask.id}`} row={selectedTask} fleetTask={selectedTask} enabled={stopEnabled} busy={busy}
              onCancel={(id) => { void cancel(id); }} />
            : <section className={styles.empty}><h2 tabIndex={-1} data-inspector-heading>{selection
              ? `${selection.kind === 'worker' ? 'Worker' : 'Task'} ${selection.id} is not in this snapshot`
              : 'Select a worker or task'}</h2><p>{selection
              ? 'It may have left the retained history or this console session. Select another record or refresh to check again; no outcome is inferred.'
              : 'Inspect quota evidence, ownership, outcomes, and session-local output here.'}</p></section>}</div> : null}
        </aside>
      </section>
      <section id="resource-accounts" tabIndex={-1} className={styles.detailSection} aria-labelledby="account-resources-title">
        <div className={styles.detailHeading}><h2 id="account-resources-title">Accounts and quota</h2>
          <p>Set your usage reserve and inspect the evidence behind each routing decision.</p></div>
        <WorkerAccessControl workers={snapshot.pool.workers} policy={snapshot.workerAccess} writable={scope.allocationWritable === true}
          disabled={!workerAccessEnabled && scope.allocationWritable === true} historical={historical} busy={workerAccessBusy}
          error={workerAccessError} notice={workerAccessNotice} onSave={saveWorkerAccess} />
        <AllocationControl allocation={snapshot.allocation} writable={scope.allocationWritable === true}
          disabled={!allocationEnabled && scope.allocationWritable === true} busy={allocationBusy} onSave={saveAllocation} />
        <AccountConnections connections={snapshot.connections} historical={historical} ceilingPercent={snapshot.allocation?.ceilingPercent} />
        <QuotaRefreshPanel refresh={snapshot.quotaRefresh} collector={snapshot.metadataCollector} selectedWorkerId={selection?.kind === 'worker' ? selection.id : null}
          historical={historical} onSelect={(id) => inspectSelection({ kind: 'worker', id })} />
        <CapacityBoard snapshot={snapshot} selectedWorkerId={selection?.kind === 'worker' ? selection.id : null}
          historical={historical} onSelect={(id) => inspectSelection({ kind: 'worker', id })} />
      </section>
      <section id="resource-performance" tabIndex={-1} className={styles.detailSection} aria-label="Performance and usage">
        <PerformancePanel report={snapshot.performance} onSelect={(id) => inspectSelection({ kind: 'worker', id })} />
        <section className={styles.accounting} aria-label="Reported usage coverage"><h2>Recorded usage</h2>
          <p>{snapshot.usage.complete ? 'Complete reported total' : 'Reported subtotal, not total consumption'}: <strong>{resourceNumber(snapshot.usage.reportedInputTokens)}</strong> input tokens · <strong>{resourceNumber(snapshot.usage.reportedOutputTokens)}</strong> output tokens.</p>
          <p className={styles.muted}>{resourceNumber(snapshot.usage.reportedAttempts)} attempts with reported usage; {resourceNumber(snapshot.usage.unknownAttempts)} without complete usage. No conversion into provider quota is inferred. Completed tasks are not verified accepted changes.</p>
        </section>
      </section>
    </> : null}
    {unlockOpen ? <MutationTokenDialog open onClose={() => setUnlockOpen(false)} tokenLabel="Control token"
      tokenHelp="the control token this resource console printed" reason={scope.readOnly
        ? `This console’s separate control token enables ${snapshot?.workerAccess ? 'allocation and fleet account access' : 'allocation'} changes only. Task execution remains disabled.`
        : `This console’s separate control token enables configured ${snapshot?.workerAccess ? 'account access, ' : ''}allocation, queue, submit, and owned-task cancellation actions. Read access alone cannot dispatch work.`} /> : null}
  </div>;
}
