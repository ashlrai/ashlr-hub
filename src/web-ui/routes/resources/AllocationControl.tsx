import { useId, useState } from 'react';
import type { ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import { resourceTime } from './CapacityBoard.js';
import styles from './AllocationControl.module.css';

export type AllocationSnapshot = NonNullable<ResourceConsoleSnapshot['allocation']>;

export function AllocationControl({ allocation, writable, disabled = false, busy = false, onSave }: {
  allocation: AllocationSnapshot | undefined;
  writable: boolean;
  disabled?: boolean;
  busy?: boolean;
  onSave: (ceilingPercent: number, expectedRevision: number) => Promise<boolean>;
}) {
  const inputId = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState<{ value: number; revision: number } | null>(null);
  if (!allocation) return null;
  const value = draft?.value ?? allocation.ceilingPercent ?? 75;
  const conflict = draft !== null && draft.revision !== allocation.revision;
  const unsaved = allocation.ceilingPercent === null || draft !== null && value !== allocation.ceilingPercent;
  const blocked = !writable || disabled || busy;

  async function save() {
    if (!allocation || blocked || conflict || !unsaved) return;
    // Keep the edit on failed/denied writes. Successful writes are refreshed by
    // the parent before clearing it; polling never silently rebases a draft.
    if (await onSave(value, draft?.revision ?? allocation.revision)) setDraft(null);
  }

  return <section className={styles.panel} aria-label="Usage allocation">
    <div className={styles.heading}><div><h2>Usage allocation</h2>
      <p>A ceiling on total reported provider usage, including your manual work.</p></div>
      <div className={styles.saved}><strong>{allocation.ceilingPercent === null ? 'No pool-wide ceiling saved' : `Saved ceiling: ${allocation.ceilingPercent}%`}</strong>
        <span>{allocation.updatedAt === null ? 'Existing worker policies still apply' : `Updated ${resourceTime(allocation.updatedAt)} · revision ${allocation.revision}`}</span></div>
    </div>
    <div className={styles.controls}>
      <div className={styles.sliderArea}><div className={styles.sliderHeading}>
        <label htmlFor={inputId}>Provider usage ceiling</label><output htmlFor={inputId}>{value}% <span>{unsaved ? '(unsaved)' : '(saved)'}</span></output>
      </div>
        <input id={inputId} type="range" min="0" max="100" step="1" value={value} disabled={blocked || conflict}
          aria-describedby={descriptionId} aria-valuetext={`${value}% total usage ceiling; ${100 - value}% personal headroom target`}
          onChange={(event) => setDraft({ value: Number(event.target.value), revision: draft?.revision ?? allocation.revision })} />
        <div className={styles.rangeLabels} aria-hidden="true"><span>0 · Remote off</span><span>100 · Native caps</span></div>
      </div>
      <div className={styles.remainder}><strong>{100 - value}%</strong><span>personal headroom target</span></div>
      {writable ? <button type="button" className={styles.save} disabled={blocked || conflict || !unsaved}
        onClick={() => { void save(); }}>{busy ? 'Saving…' : 'Save allocation'}</button> : null}
    </div>
    {conflict ? <div className={styles.conflict} role="alert"><p>The saved allocation changed while you were editing. Your draft has not been applied.</p>
      <button type="button" disabled={busy} onClick={() => setDraft(null)}>Use latest allocation</button></div> : null}
    {disabled ? <p className={styles.warning}>A fresh, valid pool snapshot is required before allocation changes.</p> : null}
    {!writable ? <p className={styles.note}>Allocation changes are not enabled for this console.</p> : null}
    <p id={descriptionId} className={styles.note}>{value === 0 ? 'At 0%, new remote dispatch is off; local models are unaffected.'
      : value < 100 ? `Target ${100 - value}% for personal use. Unknown remote quota blocks new dispatch below a 100% ceiling.`
        : 'At 100%, native limits, task caps and other admission checks still apply. This does not authorize API overages.'}
      {' '}The ceiling is an admission cutoff, not a hard spend cap: in-flight tasks are not stopped and usage can overshoot.</p>
  </section>;
}
