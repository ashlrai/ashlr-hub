import { useEffect, useRef, useState } from 'react';
import type { ResourceConsoleOutput, ResourceSupervisorJob } from '../../../core/resources/console-types.js';
import type { ResourceTaskReceipt } from '../../../core/resources/pool-runtime.js';
import { StatusBadge, type Tone } from '../../components/primitives/StatusBadge.js';
import { readResourceTaskOutput } from '../../data/resource-pool-queries.js';
import { resourceNumber, resourceReason, resourceTime } from './CapacityBoard.js';
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

export function TaskInspector({ row, enabled, busy, onCancel }: {
  row: ResourceTaskRow; enabled: boolean; busy: boolean; onCancel: (id: string) => void;
}) {
  const [output, setOutput] = useState<ResourceConsoleOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function loadOutput() {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(null);
    try { const result = await readResourceTaskOutput(row.id, controller.signal); if (!controller.signal.aborted) setOutput(result); }
    catch { if (!controller.signal.aborted) setError('Output is unavailable. It is retained only by the console session that produced it.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <section className={styles.inspector} aria-label={`Task ${row.id}`}>
    <div className={styles.sectionHeading}><div><h2>{row.id}</h2><p>{taskOwnership(row)}</p></div><StatusBadge status={taskState(row)} tone={taskTone(row)} /></div>
    <dl className={styles.facts}>
      <div><dt>Worker</dt><dd>{row.job?.workerId ?? row.receipt?.workerId ?? 'Not assigned'}</dd></div>
      {row.job ? <><div><dt>Allowed workers</dt><dd>{row.job.allowedWorkerIds.join(', ')}</dd></div><div><dt>Workspace access</dt><dd>{row.job.mode}</dd></div>
        <div><dt>Queued</dt><dd>{resourceTime(row.job.enqueuedAt)}</dd></div><div><dt>Last supervisor update</dt><dd>{resourceTime(row.job.updatedAt)}</dd></div></> : null}
      {row.receipt ? <><div><dt>Reserved</dt><dd>{resourceTime(row.receipt.startedAt)}</dd></div><div><dt>Finished</dt><dd>{resourceTime(row.receipt.finishedAt)}</dd></div>
        <div><dt>Reported input tokens</dt><dd>{resourceNumber(row.receipt.inputTokens)}</dd></div><div><dt>Reported output tokens</dt><dd>{resourceNumber(row.receipt.outputTokens)}</dd></div></> : null}
      <div><dt>Reason</dt><dd>{resourceReason(row.job?.reason ?? row.receipt?.reason ?? 'not-yet-dispatched')}</dd></div>
      <div><dt>Verified accepted work</dt><dd>Not measured</dd></div>
    </dl>
    {['unresolved', 'uncertain', 'reserved'].includes(taskState(row)) ? <p className={styles.warning}>This reservation is occupancy evidence, not a process heartbeat. The console cannot cancel work it does not currently own.</p> : null}
    {row.job?.cancellable ? <button type="button" className={styles.secondaryButton} disabled={!enabled || busy}
      onClick={() => onCancel(row.id)}>{row.job.state === 'queued' ? 'Cancel queued task' : 'Cancel owned task'}</button> : null}
    <div className={styles.outputSection}><h3>Task output</h3>
      {row.job?.outputAvailable ? <button type="button" className={styles.secondaryButton} disabled={loading}
        onClick={() => { void loadOutput(); }}>{loading ? 'Loading output…' : output ? 'Reload output' : 'Read task output'}</button>
        : <p className={styles.muted}>No output is available in this console session. Prompt and output text are not part of the pool ledger.</p>}
      {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
      {output ? <><p className={styles.caption}>{output.truncated ? 'Output truncated to the session limit.' : 'Session-local output.'} Rendered as plain text; never executed.</p>
        <pre className={styles.output} aria-label="Task output"><code>{output.text}</code></pre></> : null}
    </div>
  </section>;
}
