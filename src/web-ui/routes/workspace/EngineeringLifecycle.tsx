import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceConsoleScope } from '../../../core/resources/console-types.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { closeResourceEngineering, readResourceEngineeringLifecycle } from '../../data/resource-pool-queries.js';
import styles from './EngineeringLifecycle.module.css';

type State = NonNullable<ResourceConsoleScope['engineeringLifecycle']> | 'checking' | 'unknown';
const labels: Record<State, string> = { running: 'Running', stopping: 'Closing', closed: 'Closed', held: 'Held', checking: 'Checking', unknown: 'Unknown' };

/** One console-wide control, independent of project drafts and task submission. */
export function EngineeringLifecycle({ scope, unlocked, onUnlock, onReadyChange }: {
  scope: ResourceConsoleScope; unlocked: boolean; onUnlock(): void; onReadyChange(ready: boolean): void;
}) {
  const [state, setState] = useState<State>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true); const pending = useRef(false); const attempted = useRef(false);
  const { root, poolId, workspace } = scope;
  const read = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (pending.current || document.visibilityState === 'hidden' || read.current) return;
    const abort = new AbortController(); read.current = abort;
    // A stalled observer must not keep the last running sample actionable forever.
    const timeout = window.setTimeout(() => {
      if (read.current === abort) { read.current = null; if (alive.current) setState('unknown'); }
      abort.abort();
    }, 10_000);
    abort.signal.addEventListener('abort', () => window.clearTimeout(timeout), { once: true });
    try {
      const value = await readResourceEngineeringLifecycle({ root, poolId, workspace }, abort.signal);
      if (!abort.signal.aborted && alive.current) { setState(value); if (value === 'closed') setError(false); }
    } catch { if (!abort.signal.aborted && alive.current) setState('unknown'); }
    finally { window.clearTimeout(timeout); if (read.current === abort) read.current = null; }
  }, [root, poolId, workspace]);
  useEffect(() => {
    alive.current = true; void refresh();
    const poll = () => { void refresh(); }; const timer = window.setInterval(poll, 3000);
    document.addEventListener('visibilitychange', poll);
    return () => { alive.current = false; read.current?.abort(); read.current = null; window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [refresh]);
  useEffect(() => { onReadyChange(state === 'running' && !busy && !attempted.current); }, [state, busy, onReadyChange]);
  async function close() {
    if (pending.current || state === 'closed' || state === 'stopping') return;
    if (!unlocked) { onUnlock(); return; }
    attempted.current = true; pending.current = true; read.current?.abort(); read.current = null;
    onReadyChange(false); setBusy(true); setState('stopping'); setError(false);
    try { const result = await closeResourceEngineering(); if (alive.current) setState(result); }
    catch { if (alive.current) { setState('unknown'); setError(true); } }
    finally { pending.current = false; if (alive.current) { setBusy(false); void refresh(); } }
  }
  return <section className={styles.panel} aria-label="Engineering lifecycle">
    <div className={styles.summary}><div className={styles.heading}><h2>Engineering runtime</h2>
      <StatusBadge status={labels[state]} tone={state === 'held' || state === 'unknown' ? 'unknown' : state === 'stopping' ? 'warning' : 'neutral'} /></div>
      <p>All engineering plans in this console. Human tasks and the workspace stay open.</p>
      {state === 'closed' ? <p role="status">Engineering is closed for this console session. No in-session restart is available.</p>
        : state === 'held' ? <p role="alert">Shutdown remains unresolved. Inspect retained engineering evidence before starting another console.</p>
          : state === 'stopping' ? <p role="status">Waiting for owned engineering work to settle. This does not undo delivered changes.</p>
            : <p>Close stops engineering producers and drains their work. It is not global KILL.</p>}
      {error ? <p role="alert">Close was not confirmed. Check status; a lost response does not mean the request stopped.</p> : null}
      {attempted.current && state === 'running' ? <p role="status">The console still reports running after a close attempt. Engineering controls remain withheld; check status or retry close explicitly.</p> : null}
      {state === 'unknown' ? <p role="status">Current lifecycle is unavailable. New engineering work remains withheld; human tasks are unaffected.</p> : null}
    </div>
    <div className={styles.actions}><button type="button" disabled={busy} onClick={() => { void refresh(); }}>Check engineering status</button>
      <button type="button" disabled={busy || state === 'closed' || state === 'stopping' || state === 'checking' || state === 'held'}
        onClick={() => { void close(); }}>{busy ? 'Closing engineering…' : unlocked ? 'Close engineering' : 'Unlock to close engineering'}</button></div>
  </section>;
}
