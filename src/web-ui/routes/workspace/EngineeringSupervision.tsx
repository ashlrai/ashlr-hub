import { useEffect, useRef, useState } from 'react';
import type { ResourceConsoleEngineeringSupervisionSnapshot as Snapshot } from '../../../core/resources/console-engineering-supervisor-types.js';
import type { ResourceConsoleEngineeringEnrollment as Enrollment } from '../../../core/resources/console-engineering-types.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { admitEngineeringSupervision, pauseEngineeringSupervision, readEngineeringSupervision } from '../../data/engineering-supervision.js';
import { readEngineeringAutomaticAdmission } from '../../data/engineering-automatic-admission.js';
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
type Recovery = Awaited<ReturnType<typeof readEngineeringAutomaticAdmission>>;
const recoveryStates: Record<Recovery['state'], string> = {
  idle: 'Awaiting recovery pass', reconciling: 'Checking pending registrations', ready: 'Last pass clear', held: 'Recovery held', closed: 'Recovery closed',
};
const recoveryReasons: Record<Recovery['pending'][number]['reason'], string> = {
  'binding-changed': 'Original queue binding changed', 'evidence-unavailable': 'Registration evidence unavailable',
  'verification-pending': 'Awaiting fresh verification', capacity: 'Lifetime enrollment cap reached',
  'admission-unavailable': 'Queue admission was not confirmed',
};

export function EngineeringSupervision({ available, unlocked, selectedPlan, onUnlock, onSelectedEvidenceChange }: {
  available: boolean; unlocked: boolean; selectedPlan?: Enrollment | null; onUnlock?(): void;
  onSelectedEvidenceChange?(): void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [recoveryError, setRecoveryError] = useState(false);
  const [recoveryStale, setRecoveryStale] = useState(false);
  const mutation = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const mutating = useRef(false);
  const identity = selectedPlan ? `${selectedPlan.projectId}:${selectedPlan.id}:${selectedPlan.enrollmentDigest}` : '';
  const onEvidence = useRef(onSelectedEvidenceChange); onEvidence.current = onSelectedEvidenceChange;
  const selectedEntry = snapshot?.entries.find(row => row.enrollmentId === selectedPlan?.id && row.enrollmentDigest === selectedPlan?.enrollmentDigest);
  const evidenceKey = selectedEntry ? JSON.stringify([identity, selectedEntry.state, selectedEntry.attempts, selectedEntry.reasons]) : '';
  useEffect(() => {
    // Observe automatic starts/settlement even when the selected plan was last
    // seen as ready. Never dispatch or retry work from this notification.
    if (available && !error && evidenceKey) onEvidence.current?.();
  }, [available, error, evidenceKey]);
  useEffect(() => {
    epoch.current++; mutation.current?.abort(); mutating.current = false; setBusy(false); setAdmissionError(null); setNotice(null);
    setRecovery(null); setRecoveryError(false); setRecoveryStale(false);
  }, [identity]);
  useEffect(() => {
    if (!available) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const observed = epoch.current;
      try {
        if (mutating.current) return;
        const value = await readEngineeringSupervision(abort.signal);
        const current = () => !abort.signal.aborted && !mutating.current && observed === epoch.current;
        if (!current()) return;
        // Supervision controls do not wait for the subordinate recovery read.
        setSnapshot(value); setError(null);
        setRecovery(previous => previous?.supervisionId === value.configId && previous.configDigest === value.configDigest && previous.deadlineAt === value.deadlineAt ? previous : null);
        if (!value.admission?.autoAdmitPrepared) { setRecovery(null); setRecoveryError(false); setRecoveryStale(false); return; }
        try {
          const report = await readEngineeringAutomaticAdmission(value, abort.signal);
          if (current()) { setRecovery(report); setRecoveryError(false); setRecoveryStale(false); }
        } catch {
          if (current()) { setRecoveryError(true); setRecoveryStale(true); }
        }
      } catch (cause) { if (!abort.signal.aborted && observed === epoch.current) setError(message(cause)); }
      finally { if (!abort.signal.aborted) timer = setTimeout(() => { void poll(); }, 3000); }
    }
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [available, revision, identity]);
  useEffect(() => {
    const interrupt = () => { epoch.current++; mutation.current?.abort(); };
    if ((!available || !unlocked) && mutating.current) { interrupt(); mutating.current = false; setBusy(false);
      setAdmissionError('Control access changed. Refresh supervision; an in-flight request may already have changed the queue.'); }
    return () => { if (mutating.current) interrupt(); };
  }, [available, unlocked]);
  async function toggle() {
    if (!snapshot || !available || !unlocked || error || mutating.current || snapshot.sourceState !== 'healthy') return;
    const abort = new AbortController(); mutation.current = abort;
    epoch.current++; mutating.current = true; setBusy(true); setRecoveryStale(true);
    try {
      const value = await pauseEngineeringSupervision(snapshot, !snapshot.paused, abort.signal);
      if (!abort.signal.aborted) { setSnapshot(value); setError(null); }
    } catch (cause) { if (!abort.signal.aborted) setError(message(cause)); }
    finally { if (!abort.signal.aborted) { epoch.current++; mutating.current = false; setBusy(false); } }
  }
  const terminal = snapshot && (['timed-out', 'closed', 'unavailable'].includes(snapshot.state) || snapshot.state === 'completed' && !snapshot.admission);
  const included = selectedPlan && snapshot?.entries.some(row => row.enrollmentId === selectedPlan.id);
  const expired = snapshot && Date.now() >= Date.parse(snapshot.deadlineAt);
  const completedAppendableQueue = available && !error && snapshot?.sourceState === 'healthy' && !!snapshot.admission &&
    !snapshot.paused && !expired &&
    ['running', 'completed'].includes(snapshot.state) && snapshot.entries.every(row => row.state === 'completed');
  const waitingForPlans = completedAppendableQueue && snapshot.admission!.remainingEnrollments > 0;
  const admissionLimitReached = completedAppendableQueue && snapshot.admission!.remainingEnrollments === 0;
  const admissionBlocked = !selectedPlan || !snapshot?.admission || snapshot.admission.remainingEnrollments === 0 || !!included ||
    !available || busy || !!error || !!admissionError || snapshot.sourceState !== 'healthy' || !!terminal || !!expired;
  async function admit() {
    if (admissionBlocked || !selectedPlan || !snapshot || mutating.current) return;
    if (!unlocked) { onUnlock?.(); return; }
    const abort = new AbortController(); mutation.current = abort;
    epoch.current++; mutating.current = true; setBusy(true); setNotice(null); setRecoveryStale(true);
    try {
      const value = await admitEngineeringSupervision(snapshot, [{ enrollmentId: selectedPlan.id, expectedEnrollmentDigest: selectedPlan.enrollmentDigest }], abort.signal);
      if (!abort.signal.aborted) { setSnapshot(value); setError(null); setAdmissionError(null);
        setNotice(value.paused ? 'Plan added. Automatic launches remain paused.' : 'Plan added to automatic work under the existing deadline. It may start as local readiness permits.');
        refresh(n => n + 1); }
    } catch (cause) { if (!abort.signal.aborted) setAdmissionError(message(cause)); }
    finally { if (!abort.signal.aborted) { epoch.current++; mutating.current = false; setBusy(false); } }
  }
  const recoveryHistorical = recoveryStale || recoveryError || !available || !!error;
  const matchingRecovery = recovery && snapshot && recovery.supervisionId === snapshot.configId &&
    recovery.configDigest === snapshot.configDigest && recovery.deadlineAt === snapshot.deadlineAt ? recovery : null;
  return <section className={styles.panel} aria-label="Automatic engineering supervision">
    <div className={styles.heading}><div><h3>Automatic engineering</h3><p>{snapshot?.admission ? 'Console-wide queue. Explicitly admitted plans use the original deadline and shared resource limits.' : 'Console-wide queue. Only the plans pinned at startup can run.'}</p></div>
      <StatusBadge status={!available ? 'Connection unavailable' : error ? 'Evidence unavailable' : admissionLimitReached ? 'Admission limit reached' : waitingForPlans ? 'Waiting for new plans' : snapshot?.state ?? 'Reading supervisor'}
        tone={!available || error ? 'unknown' : waitingForPlans || admissionLimitReached ? 'neutral' : snapshot?.state === 'running' ? 'info' : snapshot?.state === 'completed' ? 'success' : 'neutral'} /></div>
    {waitingForPlans ? <p>No engineering plan in this queue is active. The supervisor is waiting for new plans within its original deadline, not running workers.</p> : null}
    {admissionLimitReached ? <p>All current work is complete. The lifetime enrollment cap is exhausted, so no new plans can be added. Completed plans retain their slots; the original deadline is not renewed.</p> : null}
    {snapshot ? <><dl className={styles.facts}><div><dt>Original deadline</dt><dd>{resourceTime(snapshot.deadlineAt)}</dd></div>
      <div><dt>Queue</dt><dd>{snapshot.entries.length} pinned plans</dd></div><div><dt>Control revision</dt><dd>{snapshot.revision}</dd></div>
      {snapshot.admission ? <div><dt>Remaining admission slots</dt><dd>{snapshot.admission.remainingEnrollments} of {snapshot.admission.maxEnrollments}</dd></div> : null}</dl>
      <ul className={styles.entries} aria-label="Supervised plans">{snapshot.entries.map(row => <li key={row.enrollmentId}>
        <div><strong>{row.enrollmentId}</strong><StatusBadge status={row.state} tone={row.state === 'held' ? 'warning' : row.state === 'completed' ? 'success' : 'neutral'} /></div>
        <p>{row.reasons.map(reason => reasons[reason]).join('; ')}. {row.attempts} graph invocations; not model-request usage.</p>
      </li>)}</ul></> : null}
    {snapshot?.admission?.autoAdmitPrepared ? <section className={styles.recovery} aria-label="Automatic admission recovery">
      <div className={styles.heading}><h4>Automatic admission recovery</h4><StatusBadge
        status={recoveryHistorical ? matchingRecovery ? 'Historical recovery report' : 'Recovery unavailable' : matchingRecovery ? recoveryStates[matchingRecovery.state] : 'Reading recovery report'}
        tone={recoveryHistorical ? 'unknown' : matchingRecovery?.state === 'held' ? 'warning' : 'neutral'} /></div>
      <p>Only durably marked automatic registrations are retried. The original deadline, enrollment cap and pause above remain binding. This report is not worker health or a fresh bundle check.</p>
      {matchingRecovery ? <><dl className={styles.facts}><div><dt>Last recovery sample</dt><dd>{matchingRecovery.sampledAt ? <time dateTime={matchingRecovery.sampledAt}>{resourceTime(matchingRecovery.sampledAt)}</time> : 'Not sampled'}</dd></div></dl>
        {matchingRecovery.state === 'reconciling' ? <p>The last report recorded a recovery pass in progress; its sample and holds are from the preceding report.</p> : null}
        {matchingRecovery.reason ? <p>{recoveryReasons[matchingRecovery.reason]}. This report does not establish that no registrations remain pending.</p> : null}
        {matchingRecovery.pending.length ? <details className={styles.recoveryDetails}><summary>Review {matchingRecovery.pending.length} pending registrations</summary>
          <ul className={styles.entries} aria-label="Pending automatic registrations">{matchingRecovery.pending.map(row => <li key={row.enrollmentId}><strong>{row.enrollmentId}</strong><p>{recoveryReasons[row.reason]}.</p></li>)}</ul></details> : null}</> : null}
      {recoveryError ? <p role="status">Automatic admission recovery could not be verified. Retained details are historical; supervision controls remain available when their own evidence is valid.</p> : recoveryHistorical && matchingRecovery ? <p role="status">Retained recovery details are historical until the next successful read.</p> : null}
    </section> : null}
    <p className={styles.scope}>Pause affects new automatic launches across all projects. Active work keeps its original limits; use a plan’s Stop control to cancel it. Supervision resumes after console restart with the same deadline, not a renewed budget.</p>
    {snapshot?.admission ? <div className={styles.admission}><div><h4>{selectedPlan ? `Selected plan: ${selectedPlan.id}` : 'Select an enrolled plan to add it'}</h4>
      <p>Adding a plan authorizes automatic execution under the deadline above. It does not renew budgets or change account reserves.</p>
      {snapshot.paused ? <p>The queue is paused. Added plans remain paused until automatic launches resume.</p> : null}
      {included ? <p>This plan is already in the automatic queue.</p> : null}
      {snapshot.admission.remainingEnrollments === 0 ? <p>The admission limit is reached; completed plans still count toward it.</p> : null}
      {expired ? <p>The original deadline has expired. New plans cannot be admitted.</p> : null}</div>
      <button type="button" disabled={admissionBlocked || !unlocked && !onUnlock} onClick={() => { void admit(); }}>{unlocked ? 'Add plan to automatic work' : 'Unlock to add plan'}</button></div> : null}
    {!available ? <p role="status">Displayed evidence may be stale. Reconnect before changing supervision.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {admissionError ? <p role="alert">{admissionError} Refresh supervision before trying again.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className={styles.actions}><button type="button" disabled={!available || busy} onClick={() => { setSnapshot(null); setRecovery(null); setRecoveryError(false); setRecoveryStale(false); setAdmissionError(null); setNotice(null); refresh(value => value + 1); }}>Refresh supervision</button>
      <button type="button" disabled={!snapshot || !available || !unlocked && !onUnlock || busy || !!error || !!terminal}
        onClick={() => { if (!unlocked) onUnlock?.(); else void toggle(); }}>{busy ? 'Saving…' : !unlocked ? 'Unlock supervision controls' : snapshot?.paused ? 'Resume automatic launches' : 'Pause automatic launches'}</button></div>
  </section>;
}
