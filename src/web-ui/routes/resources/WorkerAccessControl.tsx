import { useId, useState } from 'react';
import type { ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import { resourceTime } from './CapacityBoard.js';
import styles from './WorkerAccessControl.module.css';

export type WorkerAccessSnapshot = NonNullable<ResourceConsoleSnapshot['workerAccess']>;

export function WorkerAccessControl({ workers, policy, writable, disabled = false, historical = false, busy = false,
  error, notice, onSave }: {
  workers: ResourceConsoleSnapshot['pool']['workers'];
  policy: WorkerAccessSnapshot | undefined;
  writable: boolean;
  disabled?: boolean;
  historical?: boolean;
  busy?: boolean;
  error?: string | null;
  notice?: string | null;
  onSave: (pausedWorkerIds: string[], expectedRevision: number) => Promise<boolean>;
}) {
  const descriptionId = useId();
  const [draft, setDraft] = useState<{ pausedWorkerIds: string[]; revision: number } | null>(null);
  if (!policy) return null;
  const paused = draft?.pausedWorkerIds ?? policy.pausedWorkerIds;
  const conflict = draft !== null && draft.revision !== policy.revision;
  const unsaved = draft !== null && (paused.length !== policy.pausedWorkerIds.length ||
    paused.some((id) => !policy.pausedWorkerIds.includes(id)));
  const blocked = !writable || disabled || historical || busy;

  function change(workerId: string, allowed: boolean) {
    if (!policy || blocked || conflict) return;
    const next = new Set(paused);
    if (allowed) next.delete(workerId); else next.add(workerId);
    setDraft({ pausedWorkerIds: [...next].sort(), revision: draft?.revision ?? policy.revision });
  }
  async function save() {
    if (!policy || blocked || conflict || !unsaved) return;
    // A failed save keeps the original revision and the operator's exact draft.
    if (await onSave([...paused].sort(), draft?.revision ?? policy.revision)) setDraft(null);
  }

  return <section className={styles.panel} aria-label="Fleet account access">
    <div className={styles.heading}><div><h2>Fleet account access</h2>
      <p>Keep an account for your own work without disconnecting it.</p></div>
      <span className={styles.saved}>{historical ? 'Last reported access' : 'Saved access'} · revision {policy.revision}
        <small>{policy.updatedAt === null ? 'No individual pauses saved' : `Updated ${resourceTime(policy.updatedAt)}`}</small></span>
    </div>
    <div className={styles.workers} role="group" aria-label="Accounts permitted for fleet work" aria-describedby={descriptionId}>
      {workers.map((worker) => <label className={styles.worker} key={worker.id}>
        <input type="checkbox" checked={!paused.includes(worker.id)} disabled={blocked || conflict}
          aria-label={`Allow ${worker.id} for fleet work`} onChange={(event) => change(worker.id, event.target.checked)} />
        <span className={styles.identity}><strong>{worker.id}</strong><small>{worker.provider} / {worker.model}</small></span>
        <span className={styles.state}>{historical ? 'Last reported: ' : 'Saved: '}
          {policy.pausedWorkerIds.includes(worker.id) ? 'Paused for fleet' : 'Allowed by this setting'}</span>
      </label>)}
    </div>
    <div className={styles.actions}><span className={styles.note}>{unsaved ? 'Unsaved access changes' : 'No unsaved access changes'}</span>
      {writable ? <button type="button" className={styles.save} disabled={blocked || conflict || !unsaved}
        onClick={() => { void save(); }}>{busy ? 'Saving account access…' : 'Save account access'}</button> : null}</div>
    {conflict ? <div className={styles.conflict} role="alert"><p>Account access changed while you were editing. Your draft has not been applied.</p>
      <button type="button" disabled={busy} onClick={() => setDraft(null)}>Use latest account access</button></div> : null}
    {error ? <p className={styles.warning} role="alert">{error}</p> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {disabled || historical ? <p className={styles.warning}>A fresh, valid pool snapshot is required before account access changes.</p> : null}
    {!writable ? <p className={styles.note}>Account access changes are not enabled for this console.</p> : null}
    <p id={descriptionId} className={styles.note}>Uncheck an account and save to pause new fleet tasks. Running tasks are not stopped.
      {' '}This does not sign you out, change your usage ceiling, or hide connection and usage data. Other admission rules and shared-capacity pauses still apply.</p>
  </section>;
}
