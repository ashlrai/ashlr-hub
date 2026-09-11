import { useId, useState } from 'react';
import type { ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import { resourceTime } from './CapacityBoard.js';
import styles from './QuotaScopeAccessControl.module.css';

export type QuotaScopeAccessSnapshot = NonNullable<ResourceConsoleSnapshot['quotaScopeAccess']>;
type Exclusion = QuotaScopeAccessSnapshot['exclusions'][number];
const key = (row: Exclusion) => `${row.capacityKey}/${row.quotaScope}`;
const sorted = (rows: Exclusion[]) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));

export function QuotaScopeAccessControl({ workers, policy, accountPolicy, writable, disabled = false, historical = false,
  busy = false, error, notice, onSave }: {
  workers: ResourceConsoleSnapshot['pool']['workers'];
  policy: QuotaScopeAccessSnapshot | undefined;
  accountPolicy: ResourceConsoleSnapshot['workerAccess'];
  writable: boolean; disabled?: boolean; historical?: boolean; busy?: boolean;
  error?: string | null; notice?: string | null;
  onSave: (exclusions: Exclusion[], expectedRevision: number) => Promise<boolean>;
}) {
  const descriptionId = useId();
  const [draft, setDraft] = useState<{ exclusions: Exclusion[]; revision: number } | null>(null);
  if (!policy) return null;
  // Only explicit enrollment pins create controls. Model names do not infer quota authority.
  const scopes = sorted([...new Map(workers.flatMap((worker) => worker.quotaScope === 'codex-general-v1' || worker.quotaScope === 'codex-spark-v1'
    ? [[key({ capacityKey: worker.capacityKey, quotaScope: worker.quotaScope }),
      { capacityKey: worker.capacityKey, quotaScope: worker.quotaScope }] as const] : [])).values()]);
  const selected = draft?.exclusions ?? policy.exclusions;
  const conflict = draft !== null && draft.revision !== policy.revision;
  const unsaved = sorted(selected).map(key).join('\n') !== sorted(policy.exclusions).map(key).join('\n');
  const blocked = !writable || disabled || historical || busy;
  const accountPauses = new Set(workers.filter((worker) => accountPolicy?.pausedWorkerIds.includes(worker.id)).map((worker) => worker.capacityKey));
  function change(row: Exclusion, reserved: boolean) {
    if (!policy || blocked || conflict) return;
    const next = selected.filter((entry) => key(entry) !== key(row));
    if (reserved) next.push({ ...row });
    setDraft({ exclusions: sorted(next), revision: draft?.revision ?? policy.revision });
  }
  async function save() {
    if (!policy || blocked || conflict || !unsaved) return;
    if (await onSave(sorted(selected).map((row) => ({ ...row })), draft?.revision ?? policy.revision)) setDraft(null);
  }
  return <section className={styles.panel} aria-label="Quota reservations">
    <div className={styles.heading}><div><h2>Quota reservations</h2><p>Reserve General or Spark for your own work without pausing the other quota scope.</p></div>
      <span className={styles.saved}>{historical ? 'Last reported reservations' : 'Saved reservations'} · revision {policy.revision}
        <small>{policy.updatedAt === null ? 'No quota reservations saved' : `Updated ${resourceTime(policy.updatedAt)}`}</small></span></div>
    {scopes.length ? <div className={styles.rows} role="group" aria-label="Reserved account quota scopes" aria-describedby={descriptionId}>
      {scopes.map((row) => {
        const label = row.quotaScope === 'codex-general-v1' ? 'General' : 'Spark';
        const reserved = policy.exclusions.some((entry) => key(entry) === key(row));
        return <label className={styles.row} key={key(row)}>
          <input type="checkbox" aria-label={`Reserve ${label} on ${row.capacityKey} for your work`}
            checked={selected.some((entry) => key(entry) === key(row))} disabled={blocked || conflict}
            onChange={(event) => change(row, event.target.checked)} />
          <span className={styles.identity}><strong>{label}</strong><small>{row.capacityKey}</small>
            <small>{workers.filter((worker) => worker.capacityKey === row.capacityKey && worker.quotaScope === row.quotaScope).map((worker) => worker.id).join(', ')}</small></span>
          <span className={styles.state}><span>{historical ? 'Last reported: ' : 'Saved: '}{reserved ? 'Reserved for your work' : 'Not reserved by this setting'}</span>
            {accountPauses.has(row.capacityKey) ? <strong>Whole-account pause still blocks this scope</strong> : null}</span>
        </label>;
      })}</div> : <p className={styles.note}>No General or Spark quota scopes are explicitly enrolled. Model names alone do not enable these controls.</p>}
    <div className={styles.actions}><span className={styles.note}>{unsaved ? 'Unsaved quota reservations' : 'No unsaved quota reservations'}</span>
      {writable && scopes.length > 0 ? <button type="button" className={styles.save} disabled={blocked || conflict || !unsaved}
        onClick={() => { void save(); }}>{busy ? 'Saving quota reservations…' : 'Save quota reservations'}</button> : null}</div>
    {conflict ? <div className={styles.conflict} role="alert"><p>Quota reservations changed while you were editing. Your draft has not been applied.</p>
      <button type="button" disabled={busy} onClick={() => setDraft(null)}>Use latest quota reservations</button></div> : null}
    {error ? <p className={styles.warning} role="alert">{error}</p> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {disabled || historical ? <p className={styles.warning}>A fresh, valid pool snapshot is required before quota reservation changes.</p> : null}
    {!writable ? <p className={styles.note}>Quota reservation changes are not enabled for this console.</p> : null}
    <p id={descriptionId} className={styles.note}>Save the General reservation first, then release any whole-account pause above if you want Spark available to the fleet.
      {' '}Saving here never clears an account pause, stops running tasks, or changes the usage ceiling. Global pause, account health, shared slots and quota checks still apply.</p>
    <p className={styles.note}>An unreserved scope is not a readiness claim. Unmapped models on a reserved account remain blocked conservatively.</p>
  </section>;
}
