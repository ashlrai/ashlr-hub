import { useEffect, useRef, useState } from 'react';
import type { ResourceConsoleOutput, ResourceSupervisorJob } from '../../../core/resources/console-types.js';
import type { ResourceTaskReceipt } from '../../../core/resources/pool-runtime.js';
import { executionTime, usageScopeLabel } from './PerformancePanel.js';
import { StatusBadge, type Tone } from '../../components/primitives/StatusBadge.js';
import { readResourceTaskOutput } from '../../data/resource-pool-queries.js';
import { resourceNumber, resourceReason, resourceTime } from './CapacityBoard.js';
import type { ResourceFleetTask } from './fleet-model.js';
import { TaskDiagnosis, taskReasonLabel } from './TaskDiagnosis.js';
import styles from './ResourcePoolView.module.css';

export interface ResourceTaskRow { id: string; job?: ResourceSupervisorJob; receipt?: ResourceTaskReceipt }
export function taskState(row: ResourceTaskRow): string { return row.job?.state === 'settled' ? row.job.outcome ?? 'settled' : row.job?.state ?? row.receipt?.status ?? 'unknown'; }
export function taskTone(row: ResourceTaskRow): Tone {
  const state = taskState(row);
  return ['dispatching', 'reserved'].includes(state) ? 'running' : ['unresolved', 'uncertain'].includes(state) ? 'unknown'
    : ['failed', 'timed-out'].includes(state) ? 'danger' : state === 'completed' ? 'info' : 'neutral';
}
export function taskOwnership(row: ResourceTaskRow): string {
  if (row.job?.state === 'dispatching') return 'Console-owned dispatch';
  if (row.job?.state === 'queued') return 'Queued in this supervisor';
  if (row.job?.state === 'unresolved') return 'Unresolved prior dispatch';
  if (row.job) return 'Supervisor task';
  if (row.receipt?.status === 'uncertain') return 'Unresolved external reservation';
  if (row.receipt?.status === 'reserved') return 'External reservation';
  return 'Recorded external task';
}

export function TaskInspector({ row, fleetTask, enabled, busy, onCancel }: {
  row: ResourceTaskRow; fleetTask?: ResourceFleetTask; enabled: boolean; busy: boolean; onCancel: (id: string) => void;
}) {
  const [output, setOutput] = useState<ResourceConsoleOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function loadOutput() {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(null);
    try { const result = await readResourceTaskOutput(row.id, controller.signal); if (!controller.signal.aborted) { setOutput(result); setLoadedAt(new Date().toISOString()); } }
    catch { if (!controller.signal.aborted) setError('Output is unavailable. It is retained only by the console session that produced it.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <section className={styles.inspector} aria-label={`Task ${row.id}`}>
    <div className={styles.sectionHeading}><div><h2 tabIndex={-1} data-inspector-heading>{row.id}</h2><p>{taskOwnership(row)}</p></div><StatusBadge status={taskState(row)} tone={taskTone(row)} /></div>
    <dl className={styles.facts}>
      <div><dt>Worker</dt><dd>{fleetTask ? fleetTask.workerId ?? 'No confirmed assignment' : row.job?.workerId ?? row.receipt?.workerId ?? 'Not assigned'}</dd></div>
      {fleetTask ? <div><dt>Assignment evidence</dt><dd>{resourceReason(fleetTask.assignmentReason)}</dd></div> : null}
      {fleetTask && ['pending', 'conflict'].includes(fleetTask.assignment) ? <>
        <div><dt>Supervisor worker record</dt><dd>{row.job?.workerId ?? 'Not assigned'}</dd></div>
        <div><dt>Receipt worker record</dt><dd>{row.receipt?.workerId ?? 'No receipt'}</dd></div>
      </> : null}
      {fleetTask?.queuePreview ? <>
        <div><dt>Queue preview</dt><dd>{fleetTask.queuePreview.reasons.map(resourceReason).join('; ')}</dd></div>
        <div><dt>Eligible allowed workers</dt><dd>{fleetTask.queuePreview.eligibleWorkerIds.join(', ') || 'None in this preview'}. Not an assignment; rechecked before dispatch.</dd></div>
        {fleetTask.queuePreview.nextRecheckAt ? <div><dt>Recorded recheck hint</dt><dd>{resourceTime(fleetTask.queuePreview.nextRecheckAt)}; not a promised start time.</dd></div> : null}
      </> : null}
      {row.job ? <><div><dt>Allowed workers</dt><dd>{row.job.allowedWorkerIds.join(', ')}</dd></div><div><dt>Workspace access</dt><dd>{row.job.mode}</dd></div>
        <div><dt>Queued</dt><dd>{resourceTime(row.job.enqueuedAt)}</dd></div><div><dt>Last supervisor update</dt><dd>{resourceTime(row.job.updatedAt)}</dd></div></> : null}
      {row.receipt ? <><div><dt>Reserved</dt><dd>{resourceTime(row.receipt.startedAt)}</dd></div><div><dt>Finished</dt><dd>{resourceTime(row.receipt.finishedAt)}</dd></div>
        <div><dt>Receipt state</dt><dd>{row.receipt.status}</dd></div>
        <div><dt>Worker execution</dt><dd>{executionTime(row.receipt.execution?.durationMs)}</dd></div>
        <div><dt>Token scope</dt><dd>{usageScopeLabel(row.receipt.execution?.usageScope)}</dd></div>
        <div><dt>Reported input tokens</dt><dd>{resourceNumber(row.receipt.inputTokens)}</dd></div><div><dt>Reported output tokens</dt><dd>{resourceNumber(row.receipt.outputTokens)}</dd></div></> : null}
      <div><dt>{row.job ? 'Supervisor reason' : 'Receipt reason'}</dt><dd>{taskReasonLabel(row.job ? row.job.reason : row.receipt?.reason)}</dd></div>
      <div><dt>Verified accepted work</dt><dd>Not measured</dd></div>
    </dl>
    {fleetTask?.stateDisagreement ? <p className={styles.warning}>Supervisor and receipt states differ in this snapshot. These sources are sampled separately; refresh to reconcile them.</p> : null}
    <TaskDiagnosis receipt={row.receipt} />
    {['unresolved', 'uncertain', 'reserved'].includes(taskState(row)) ? <p className={styles.warning}>This reservation is occupancy evidence, not a process heartbeat. The console cannot cancel work it does not currently own.</p> : null}
    {row.job?.cancellable ? <button type="button" className={styles.secondaryButton} disabled={!enabled || busy}
      onClick={() => onCancel(row.id)}>{row.job.state === 'queued' ? 'Cancel queued task' : 'Cancel owned task'}</button> : null}
    <div className={styles.outputSection}><h3>Task output</h3>
      {row.job?.outputAvailable ? <button type="button" className={styles.secondaryButton} disabled={loading}
        onClick={() => { void loadOutput(); }}>{loading ? 'Loading output…' : output ? 'Reload output' : 'Read task output'}</button>
        : <p className={styles.muted}>No output is available in this console session. Prompt and output text are not part of the pool ledger.</p>}
      {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
      {output ? <><p className={styles.caption}>{error ? 'Previous output from the last successful read.' : 'Output snapshot, not a live stream.'} Read {resourceTime(loadedAt)}.</p>
        <p className={styles.caption}>{output.truncated ? 'Output truncated to the session limit.' : 'Session-local output.'} Rendered as plain text; never executed.</p>
        <pre className={styles.output} aria-label="Task output"><code>{output.text}</code></pre></> : null}
    </div>
  </section>;
}
