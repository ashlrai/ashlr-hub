import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ResourceConsoleScope, ResourceConsoleSnapshot, ResourceConsoleTaskInput } from '../../../core/resources/console-types.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { runQuery } from '../../data/cache.js';
import { useMutationHold, useQuery } from '../../data/hooks.js';
import { cancelResourceTask, resourceConsoleSnapshotQuery, setResourceQueuePaused, submitResourceTask } from '../../data/resource-pool-queries.js';
import { CapacityBoard, resourceNumber, resourceTime, WorkerInspector } from './CapacityBoard.js';
import { TaskComposer } from './TaskComposer.js';
import { PerformancePanel } from './PerformancePanel.js';
import { TaskInspector, taskOwnership, taskState, taskTone, type ResourceTaskRow } from './TaskInspector.js';
import styles from './ResourcePoolView.module.css';

function taskRows(snapshot: ResourceConsoleSnapshot): ResourceTaskRow[] {
  const rows = new Map<string, ResourceTaskRow>();
  for (const job of snapshot.supervisor?.jobs ?? []) rows.set(job.id, { id: job.id, job });
  for (const receipt of [...snapshot.activeAttempts, ...snapshot.recentAttempts]) {
    rows.set(receipt.id, { ...rows.get(receipt.id), id: receipt.id, receipt });
  }
  return [...rows.values()].sort((a, b) => {
    const active = (row: ResourceTaskRow) => ['queued', 'dispatching', 'reserved', 'unresolved', 'uncertain'].includes(taskState(row));
    if (active(a) !== active(b)) return active(a) ? -1 : 1;
    return (b.job?.updatedAt ?? b.receipt?.startedAt ?? '').localeCompare(a.job?.updatedAt ?? a.receipt?.startedAt ?? '');
  });
}

export function ResourcePoolView({ scope }: { scope: ResourceConsoleScope }) {
  const definition = useMemo(() => resourceConsoleSnapshotQuery(scope.poolId), [scope.poolId]);
  const query = useQuery(definition);
  const refresh = useCallback(() => runQuery(definition.key, definition.fetch), [definition]);
  const hold = useMutationHold();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ kind: 'worker' | 'task'; id: string } | null>(null);
  const [tab, setTab] = useState<'inspect' | 'compose'>('compose');
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [showAllOwned, setShowAllOwned] = useState(false);
  const snapshot = query.data;
  const supervisor = snapshot?.supervisor;
  const rows = useMemo(() => snapshot ? taskRows(snapshot) : [], [snapshot]);
  const ownedRows = rows.filter((row) => row.job?.state === 'dispatching');
  const selectedWorker = snapshot?.pool.workers.find((worker) => worker.id === selection?.id && selection.kind === 'worker');
  const selectedTask = rows.find((row) => row.id === selection?.id && selection.kind === 'task');
  const stopEnabled = !scope.readOnly && !!supervisor && !supervisor.closing;
  const enabled = stopEnabled && !supervisor.error &&
    snapshot?.sourceState !== 'degraded' && query.status !== 'error' && query.status !== 'loading';

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
    return action(async () => { await submitResourceTask(task); setSelection({ kind: 'task', id: task.id }); },
      `Task ${task.id} queued. The supervisor will recheck capacity before dispatch.`);
  }

  const visibleRows = rows.filter((row) => filter === 'all' || (filter === 'active'
    ? ['queued', 'dispatching', 'reserved', 'unresolved', 'uncertain'].includes(taskState(row)) : taskState(row) === 'completed'));
  return <div className={styles.view}>
    <header className={styles.pageHeading}>
      <div><h1>Resource dispatch desk</h1><p>Route work across your enrolled accounts and local models.</p></div>
      <div className={styles.headerActions}>
        <button type="button" className={styles.secondaryButton} onClick={() => { void refresh(); }} disabled={query.status === 'loading' || query.status === 'refreshing'}>Refresh</button>
        {!scope.readOnly ? <button type="button" className={hold.hasHold ? styles.secondaryButton : styles.primaryButton}
          onClick={() => hold.hasHold ? hold.clear() : setUnlockOpen(true)}>{hold.hasHold ? 'Lock controls' : 'Unlock controls'}</button> : null}
      </div>
    </header>
    <div className={styles.freshness}>
      <strong>{scope.poolId}</strong>{snapshot ? <span>{query.status === 'error' ? 'Last successful read' : 'Observed'} {resourceTime(snapshot.sampledAt)}</span> : null}
      <span>Refreshes every 3 seconds while visible</span>{query.status === 'refreshing' ? <RefreshIndicator /> : null}
    </div>
    {query.status === 'error' ? <div className={styles.notice} role="alert"><strong>Resource records unavailable</strong>
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
            <span>{query.status === 'error' ? 'Last observed state' : 'This supervisor’s recorded assignments'}</span></div>
          <ul className={styles.ownedTasks}>{(showAllOwned ? ownedRows : ownedRows.slice(0, 4)).map((row) => <li key={row.id}>
            <button type="button" className={styles.ownedTask} aria-label={`Inspect owned dispatch ${row.id}`}
              aria-pressed={selection?.kind === 'task' && selection.id === row.id}
              onClick={() => { setSelection({ kind: 'task', id: row.id }); setTab('inspect'); }}>
              <strong>{row.id}</strong><span>{row.job?.workerId ?? row.receipt?.workerId ?? 'Assignment pending'}</span>
              <StatusBadge status="dispatching" tone="running" />
            </button>
          </li>)}</ul>
          {ownedRows.length > 4 ? <button type="button" className={styles.showOwned} onClick={() => setShowAllOwned((value) => !value)}>
            {showAllOwned ? 'Show first 4' : `Show ${ownedRows.length - 4} more owned dispatches`}</button> : null}
        </section> : null}
      </section>
      <div className={styles.workspaceGrid}>
        <div className={styles.mainColumn}>
          <CapacityBoard snapshot={snapshot} selectedWorkerId={selection?.kind === 'worker' ? selection.id : null}
            onSelect={(id) => { setSelection({ kind: 'worker', id }); setTab('inspect'); }} />
          <PerformancePanel report={snapshot.performance} onSelect={(id) => { setSelection({ kind: 'worker', id }); setTab('inspect'); }} />
          <section className={styles.tasks} aria-labelledby="tasks-title">
            <div className={styles.sectionHeading}><div><h2 id="tasks-title">Task activity</h2><p>Queue ownership and durable receipts, not inferred process liveness.</p></div>
              <label className={styles.filter}>Show<select aria-label="Task activity filter" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
                <option value="all">All tasks</option><option value="active">Queued / occupied</option><option value="completed">Completed</option></select></label></div>
            {visibleRows.length ? <ul className={styles.taskRows}>{visibleRows.map((row) => <li key={row.id}>
              <button type="button" className={styles.taskRow} aria-pressed={selection?.kind === 'task' && selection.id === row.id}
                onClick={() => { setSelection({ kind: 'task', id: row.id }); setTab('inspect'); }}>
                <span><strong>{row.id}</strong><small>{taskOwnership(row)}</small></span>
                <span className={styles.taskWorker}>{row.job?.workerId ?? row.receipt?.workerId ?? 'Waiting for assignment'}</span>
                <StatusBadge status={taskState(row)} tone={taskTone(row)} />
              </button></li>)}</ul> : <div className={styles.empty}><h3>{filter === 'all' ? 'No recorded tasks yet' : 'No matching tasks'}</h3>
                <p>{filter === 'all' ? 'Inspect a worker’s quota, then queue a concrete task when execution is enabled.' : 'Choose another filter to inspect the recorded task history.'}</p></div>}
            <p className={styles.boardNote}>{resourceNumber(snapshot.counts.total)} durable attempts. {resourceNumber(snapshot.counts.omittedHistory)} older terminal receipts omitted. All occupied reservations are shown.</p>
          </section>
          <section className={styles.accounting} aria-label="Reported usage coverage"><h2>Recorded usage</h2>
            <p>{snapshot.usage.complete ? 'Complete reported total' : 'Reported subtotal, not total consumption'}: <strong>{resourceNumber(snapshot.usage.reportedInputTokens)}</strong> input tokens · <strong>{resourceNumber(snapshot.usage.reportedOutputTokens)}</strong> output tokens.</p>
            <p className={styles.muted}>{resourceNumber(snapshot.usage.reportedAttempts)} attempts with reported usage; {resourceNumber(snapshot.usage.unknownAttempts)} without complete usage. No conversion into provider quota is inferred. Completed tasks are not verified accepted changes.</p>
          </section>
        </div>
        <aside className={styles.sideColumn} aria-label="Resource workspace">
          <div className={styles.tabs} role="group" aria-label="Workspace panel">
            <button type="button" aria-pressed={tab === 'compose'} onClick={() => setTab('compose')}>Compose task</button>
            <button type="button" aria-pressed={tab === 'inspect'} onClick={() => setTab('inspect')}>Inspect selection</button>
          </div>
          {/* Keep unsent text while inspecting evidence; hidden forms are not interactive. */}
          <div hidden={tab !== 'compose'}><TaskComposer scope={scope} workers={snapshot.pool.workers} enabled={enabled}
            unlocked={hold.hasHold} busy={busy} onUnlock={() => setUnlockOpen(true)} onSubmit={submit} /></div>
          {tab === 'inspect' ? selectedWorker ? <WorkerInspector worker={selectedWorker} snapshot={snapshot} /> : selectedTask
            ? <TaskInspector key={selectedTask.id} row={selectedTask} enabled={stopEnabled} busy={busy}
              onCancel={(id) => { void action(() => cancelResourceTask(id), `Cancellation requested for ${id}.`, true); }} />
            : <section className={styles.empty}><h2>Select a worker or task</h2><p>Inspect quota evidence, ownership, outcomes, and session-local output here.</p></section> : null}
        </aside>
      </div>
    </> : null}
    {unlockOpen ? <MutationTokenDialog open onClose={() => setUnlockOpen(false)} tokenLabel="Control token"
      tokenHelp="the control token this resource console printed" reason="This console’s separate control token enables queue, submit, and owned-task cancellation actions. Read access alone cannot dispatch work." /> : null}
  </div>;
}
