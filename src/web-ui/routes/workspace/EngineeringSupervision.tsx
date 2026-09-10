import { useEffect, useRef, useState } from 'react';
import type { ResourceConsoleEngineeringSupervisionSnapshot as Snapshot } from '../../../core/resources/console-engineering-supervisor-types.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { pauseEngineeringSupervision, readEngineeringSupervision } from '../../data/engineering-supervision.js';
import { resourceTime } from '../resources/CapacityBoard.js';
import styles from './EngineeringSupervision.module.css';

const reasons: Record<Snapshot['entries'][number]['reasons'][number], string> = {
  'not-started': 'Awaiting supervisor start', 'waiting-for-readiness': 'Waiting for local admission',
  'supervisor-paused': 'Automatic launches paused', running: 'Graph invocation in progress', completed: 'Delivery recorded',
  cancelled: 'Durable stop recorded', 'deadline-exhausted': 'Original deadline exhausted',
  'unchanged-evidence': 'Unresolved evidence has not changed; no repeat invocation', 'attempt-limit': 'Invocation limit reached',
  'evidence-unavailable': 'Evidence unavailable; inspect this plan', 'launch-unavailable': 'Launch did not confirm; inspect this plan',
  'supervisor-closed': 'Supervisor closed',
};
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Supervision is unavailable.';

export function EngineeringSupervision({ available, unlocked }: { available: boolean; unlocked: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const mutating = useRef(false);
  useEffect(() => {
    if (!available) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const observed = epoch.current;
      try {
        if (mutating.current) return;
        const value = await readEngineeringSupervision(abort.signal);
        if (!abort.signal.aborted && !mutating.current && observed === epoch.current) { setSnapshot(value); setError(null); }
      } catch (cause) { if (!abort.signal.aborted && observed === epoch.current) setError(message(cause)); }
      finally { if (!abort.signal.aborted) timer = setTimeout(() => { void poll(); }, 3000); }
    }
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [available, revision]);
  useEffect(() => {
    const interrupt = () => { epoch.current++; mutation.current?.abort(); };
    if ((!available || !unlocked) && mutating.current) { interrupt(); mutating.current = false; setBusy(false); }
    return () => { if (mutating.current) interrupt(); };
  }, [available, unlocked]);
  async function toggle() {
    if (!snapshot || !available || !unlocked || error || mutating.current || snapshot.sourceState !== 'healthy') return;
    const abort = new AbortController(); mutation.current = abort;
    epoch.current++; mutating.current = true; setBusy(true);
    try {
      const value = await pauseEngineeringSupervision(snapshot, !snapshot.paused, abort.signal);
      if (!abort.signal.aborted) { setSnapshot(value); setError(null); }
    } catch (cause) { if (!abort.signal.aborted) setError(message(cause)); }
    finally { if (!abort.signal.aborted) { epoch.current++; mutating.current = false; setBusy(false); } }
  }
  const terminal = snapshot && ['completed', 'timed-out', 'closed', 'unavailable'].includes(snapshot.state);
  return <section className={styles.panel} aria-label="Automatic engineering supervision">
    <div className={styles.heading}><div><h3>Automatic engineering</h3><p>Console-wide queue. Only the plans pinned at startup can run.</p></div>
      <StatusBadge status={!available ? 'Connection unavailable' : error ? 'Evidence unavailable' : snapshot?.state ?? 'Reading supervisor'}
        tone={!available || error ? 'unknown' : snapshot?.state === 'running' ? 'info' : snapshot?.state === 'completed' ? 'success' : 'neutral'} /></div>
    {snapshot ? <><dl className={styles.facts}><div><dt>Original deadline</dt><dd>{resourceTime(snapshot.deadlineAt)}</dd></div>
      <div><dt>Queue</dt><dd>{snapshot.entries.length} pinned plans</dd></div><div><dt>Control revision</dt><dd>{snapshot.revision}</dd></div></dl>
      <ul className={styles.entries} aria-label="Supervised plans">{snapshot.entries.map(row => <li key={row.enrollmentId}>
        <div><strong>{row.enrollmentId}</strong><StatusBadge status={row.state} tone={row.state === 'held' ? 'warning' : row.state === 'completed' ? 'success' : 'neutral'} /></div>
        <p>{row.reasons.map(reason => reasons[reason]).join('; ')}. {row.attempts} graph invocations; not model-request usage.</p>
      </li>)}</ul></> : null}
    <p className={styles.scope}>Pause affects new automatic launches across all projects. Active work keeps its original limits; use a plan’s Stop control to cancel it. Supervision resumes after console restart with the same deadline, not a renewed budget.</p>
    {!available ? <p role="status">Displayed evidence may be stale. Reconnect before changing supervision.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className={styles.actions}><button type="button" disabled={!available || busy} onClick={() => refresh(value => value + 1)}>Refresh supervision</button>
      <button type="button" disabled={!snapshot || !available || !unlocked || busy || !!error || !!terminal}
        onClick={() => { void toggle(); }}>{busy ? 'Saving…' : !unlocked ? 'Unlock supervision controls' : snapshot?.paused ? 'Resume automatic launches' : 'Pause automatic launches'}</button></div>
  </section>;
}
