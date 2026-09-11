import { useEffect, useRef, useState } from 'react';
import type { ResourceConsoleEngineeringEnrollment as Enrollment } from '../../../core/resources/console-engineering-types.js';
import type { ResourceEngineeringSuccessorCoordinatorSnapshot as Snapshot } from '../../../core/resources/engineering-successor-coordinator-types.js';
import { StatusBadge, type Tone } from '../../components/primitives/StatusBadge.js';
import { engineeringSuccessorReasons, readEngineeringSuccessors } from '../../data/engineering-successors.js';
import { resourceTime } from '../resources/CapacityBoard.js';
import styles from './EngineeringSuccessors.module.css';

type Phase = Snapshot['entries'][number]['state'];
const phases: Record<Phase, { label: string; tone: Tone }> = {
  proposing: { label: 'Requesting proposal', tone: 'running' },
  'waiting-for-capacity': { label: 'Waiting for shared capacity', tone: 'warning' },
  preparing: { label: 'Preparing plan', tone: 'running' },
  admitting: { label: 'Queue admission in progress', tone: 'running' },
  held: { label: 'Held for inspection', tone: 'warning' },
  proposed: { label: 'Proposal recorded', tone: 'neutral' },
  prepared: { label: 'Plan prepared', tone: 'neutral' },
  admitted: { label: 'Queued', tone: 'neutral' },
  stopped: { label: 'No successor proposed', tone: 'neutral' },
};
const states: Record<Snapshot['state'], string> = {
  idle: 'Coordinator not started', running: 'Coordinator running', closed: 'Coordinator closed',
  'timed-out': 'Original deadline exhausted', unavailable: 'Coordinator unavailable',
};
const identity = (value: Snapshot) => JSON.stringify([value.supervisionId, value.profileId, value.configDigest, value.deadlineAt, value.maxSuccessors]);

/** Observes the console-wide successor loop. Inspection changes selection only. */
export function EngineeringSuccessors({ available, projectId, catalog, onInspectEnrollment, onRegisteredEnrollments }: {
  available: boolean; projectId: string; catalog: Enrollment[] | null;
  onInspectEnrollment(id: string): void; onRegisteredEnrollments(ids: string[]): void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const boundIdentity = useRef<string | null>(null);
  const identityChanged = useRef(false);
  const notified = useRef(new Set<string>());
  const callbacks = useRef({ onInspectEnrollment, onRegisteredEnrollments });
  callbacks.current = { onInspectEnrollment, onRegisteredEnrollments };
  useEffect(() => {
    setFresh(false);
    if (!available || identityChanged.current) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const value = await readEngineeringSuccessors(abort.signal);
        if (abort.signal.aborted) return;
        const nextIdentity = identity(value);
        if (boundIdentity.current !== null && nextIdentity !== boundIdentity.current) {
          identityChanged.current = true; setFresh(false);
          setError('Coordinator identity changed. Reload this console before inspecting successor work.'); return;
        }
        boundIdentity.current = nextIdentity;
        setSnapshot(value); setError(null); setFresh(value.state !== 'unavailable');
        if (value.state !== 'unavailable') {
          const additions = [...new Set(value.entries.filter(row => row.state === 'prepared' || row.state === 'admitted')
            .map(row => row.successorId))].filter(id => !notified.current.has(id));
          if (additions.length) {
            for (const id of additions) notified.current.add(id);
            callbacks.current.onRegisteredEnrollments(additions);
          }
        }
      } catch {
        if (!abort.signal.aborted) { setFresh(false); setError('Successor evidence could not be verified. Retained status may be stale.'); }
      } finally {
        // Schedule after settlement, never on an interval: slow reads cannot overlap.
        if (!abort.signal.aborted && !identityChanged.current) timer = setTimeout(() => { void poll(); }, 3000);
      }
    }
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [available]);
  const current = available && fresh && !error;
  function inspect(id: string) {
    if (current && catalog?.some(row => row.id === id && row.projectId === projectId)) callbacks.current.onInspectEnrollment(id);
  }
  function enrollment(id: string, label: string) {
    const local = catalog?.find(row => row.id === id && row.projectId === projectId);
    const foreign = catalog?.find(row => row.id === id && row.projectId !== projectId);
    return <div className={styles.enrollment}><span className={styles.label}>{label}</span><code>{id}</code>
      {local ? <button type="button" className={styles.inspect} disabled={!current} onClick={() => inspect(id)} aria-label={`Inspect ${id}`}>Inspect plan</button>
        : <span className={styles.availability}>{foreign ? 'Another project' : 'Not in the current catalog'}</span>}</div>;
  }
  return <section className={styles.panel} aria-label="Successor planning">
    <div className={styles.heading}><div><h3>Successor planning</h3><p>Console-wide lineage from local delivery to a proposed next objective.</p></div>
      <StatusBadge status={!available ? 'Connection unavailable' : error ? 'Evidence unavailable' : snapshot ? states[snapshot.state] : 'Reading successor evidence'}
        tone={!available || error || snapshot?.state === 'unavailable' ? 'unknown' : 'neutral'} /></div>
    {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
    {!available ? <p className={styles.warning}>Connection unavailable. Displayed evidence may be stale; inspection is disabled.</p> : null}
    {snapshot ? <>
      <dl className={styles.facts}><div><dt>Profile</dt><dd>{snapshot.profileId}</dd></div>
        <div><dt>Original deadline</dt><dd><time dateTime={snapshot.deadlineAt}>{resourceTime(snapshot.deadlineAt)}</time></dd></div>
        <div><dt>Consumed intent slots</dt><dd>{snapshot.entries.length} / {snapshot.maxSuccessors}</dd></div></dl>
      {!snapshot.entries.length ? <p className={styles.empty}>No successor intent recorded. This view does not create objectives or start work.</p> :
        <ol className={styles.lineage} aria-label="Recorded successor lineage">{snapshot.entries.map(row => <li key={row.proposalTaskId}>
          <div className={styles.relationship}>
            {enrollment(row.sourceEnrollmentId, 'Source enrollment')}
            <div className={styles.phase}><span className={styles.connector} aria-hidden="true" /><StatusBadge status={phases[row.state].label} tone={current ? phases[row.state].tone : 'unknown'} />
              <span className={styles.label}>Proposal task</span><code>{row.proposalTaskId}</code></div>
            {enrollment(row.successorId, ['prepared', 'admitted', 'admitting'].includes(row.state) || catalog?.some(item => item.id === row.successorId) ? 'Successor plan' : 'Reserved successor ID')}
          </div>
          {row.state === 'admitted' ? <p className={styles.explanation}>Queued for automatic engineering. Admission is not execution, evaluation, or delivery.</p> : null}
          {row.state === 'stopped' ? <p className={styles.explanation}>The recorded proposal chose no next objective. This does not cancel other engineering work.</p> : null}
          {row.reason ? <p className={styles.reason}>{Object.hasOwn(engineeringSuccessorReasons, row.reason) ? engineeringSuccessorReasons[row.reason] : 'Recorded evidence needs inspection.'}</p> : null}
        </li>)}</ol>}
    </> : !error && available ? <p role="status" className={styles.empty}>Reading the bounded successor queue…</p> : null}
    <p className={styles.scope}>This view only reads recorded relationships and current coordinator phases. Inspect a registered plan for its evaluation and local delivery evidence. Existing automatic supervision owns execution and pause controls.</p>
  </section>;
}
