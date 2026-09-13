import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineeringMissionSnapshot } from '../../../core/resources/engineering-mission-manager-types.js';
import { controlResourceEngineeringMission, readResourceEngineeringMission } from '../../data/resource-pool-queries.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import styles from './EngineeringMission.module.css';

const phases = ['preparing', 'executing', 'draining', 'verifying', 'proposing'] as const;
const labels = { preparing: 'Prepare', executing: 'Build', draining: 'Settle', verifying: 'Verify', proposing: 'Improve' };
export function EngineeringMission({ unlocked, onUnlock }: { unlocked: boolean; onUnlock(): void }) {
  const [sample, setSample] = useState<EngineeringMissionSnapshot | null>(null);
  const [fresh, setFresh] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [checked, setChecked] = useState(false);
  const alive = useRef(false), pending = useRef<AbortController | null>(null), reading = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (reading.current || pending.current || document.visibilityState === 'hidden') return;
    const abort = new AbortController(); reading.current = abort;
    const timer = window.setTimeout(() => { abort.abort(); if (reading.current === abort) reading.current = null;
      if (alive.current) { setFresh(false); setChecked(true); } }, 10_000);
    try {
      const next = await readResourceEngineeringMission(abort.signal);
      if (!abort.signal.aborted && alive.current) { setSample(next); setFresh(true); setChecked(true); }
    } catch { if (alive.current && !abort.signal.aborted) { setFresh(false); setChecked(true); } }
    finally { window.clearTimeout(timer); if (reading.current === abort) reading.current = null; }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh(); const poll = () => { void refresh(); };
    const timer = window.setInterval(poll, 3000); document.addEventListener('visibilitychange', poll);
    return () => { alive.current = false; reading.current?.abort(); reading.current = null; pending.current?.abort(); pending.current = null;
      window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [refresh]);
  async function act(action: 'start' | 'stop') {
    if (pending.current || !sample || !fresh) return;
    if (!unlocked) { onUnlock(); return; }
    reading.current?.abort(); reading.current = null;
    const abort = new AbortController(); pending.current = abort; setBusy(true); setFresh(false); setUncertain(false);
    const timer = window.setTimeout(() => { abort.abort();
      if (pending.current === abort) { pending.current = null; if (alive.current) { setBusy(false); setUncertain(true); void refresh(); } }
    }, 10_000);
    try {
      const next = await controlResourceEngineeringMission(action, { expectedControllerId: sample.controllerId,
        expectedConfigDigest: sample.configDigest, expectedRevision: sample.revision }, abort.signal);
      if (alive.current && !abort.signal.aborted) { setSample(next); setFresh(true); }
    } catch { if (alive.current && pending.current === abort) setUncertain(true); }
    finally { window.clearTimeout(timer); if (pending.current === abort) pending.current = null;
      if (alive.current && !pending.current) { setBusy(false); void refresh(); } }
  }
  const state = fresh ? sample?.state ?? 'checking' : checked ? 'unknown' : 'checking';
  const canStart = fresh && sample && ['idle', 'stopped'].includes(sample.state) && sample.remainingMs > 0;
  const canStop = fresh && sample && (sample.enabled || sample.state === 'running') && sample.state !== 'stopping';
  return <section className={styles.panel} aria-label="Standing mission">
    <div className={styles.title}><h2>Standing mission</h2><StatusBadge status={state} tone={state === 'held' || state === 'unknown' ? 'unknown' : state === 'running' ? 'info' : 'neutral'} />
      {sample ? <span className={styles.identity}>{sample.missionId}</span> : null}</div>
    <ol className={styles.phases} aria-label="Mission improvement loop">{phases.map(phase => <li key={phase}
      aria-current={fresh && sample?.state === 'running' && sample.phase === phase ? 'step' : undefined}>
      {labels[phase]}</li>)}</ol>
    <div className={styles.details}>{sample ? <>
      <p>Scope {sample.scope} of {sample.maxScopes}. Deadline <time dateTime={sample.deadlineAt}>{new Date(sample.deadlineAt).toLocaleString()}</time>.</p>
      <p>{sample.autoStart ? sample.enabled ? 'Automatic start enabled on console restart.' : sample.revision ? 'Automatic start will respect the saved stop.' : 'Automatic startup is configured; no saved command yet.' : 'Start from this workspace; automatic startup is off.'}</p>
      {sample.phase === 'startup' || sample.phase === 'reconciling' ? <p>Current phase: {sample.phase}.</p> : null}
      {sample.lastOutcome ? <p>Last observed outcome: {sample.lastOutcome.state}. {sample.lastOutcome.reason.replaceAll('-', ' ')}.</p>
        : <p>No completed invocation observed by this console yet. Recorded history is separate from live status.</p>}
    </> : <p>{checked ? 'The host-selected mission could not be observed.' : 'Checking the host-selected mission.'}</p>}
      <p>Stop persists across restarts and drains mission work. Your chats, tasks and account reserves stay intact.</p>
      {state === 'held' ? <p role="alert">Mission held. Inspect its recorded evidence before restarting; no automatic retry is running.</p> : null}
      {state === 'stopping' ? <p role="status">Stop saved. Waiting for mission-owned work to settle.</p> : null}
      {!fresh && checked ? <p role="status">Live status unavailable. Controls wait for a fresh observation.</p> : null}
      {uncertain ? <p role="alert">The control response was not confirmed. Check status before acting; the request may have reached the host.</p> : null}
    </div>
    <div className={styles.actions}><button type="button" disabled={busy} onClick={() => { void refresh(); }}>Check mission status</button>
      <button type="button" disabled={busy || !canStart} onClick={() => { void act('start'); }}>{unlocked ? 'Start mission' : 'Unlock to start mission'}</button>
      <button type="button" disabled={busy || !canStop} onClick={() => { void act('stop'); }}>{unlocked ? 'Stop mission' : 'Unlock to stop mission'}</button></div>
  </section>;
}
