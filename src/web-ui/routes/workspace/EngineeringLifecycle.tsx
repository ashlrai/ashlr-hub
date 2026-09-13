import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceConsoleScope } from '../../../core/resources/console-types.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { closeResourceEngineering, readResourceEngineeringScope } from '../../data/resource-pool-queries.js';
import styles from './EngineeringLifecycle.module.css';

type State = NonNullable<ResourceConsoleScope['engineeringLifecycle']> | 'checking' | 'unknown' | 'unconfigured';
const labels: Record<State, string> = { running: 'Running', stopping: 'Closing', closed: 'Closed', held: 'Held', checking: 'Checking', unknown: 'Unknown', unconfigured: 'Not attached' };
const identity = (scope: ResourceConsoleScope) => scope.engineeringAttachmentId ?? 'legacy';

/** One console-wide control, independent of project drafts and task submission. */
export function EngineeringLifecycle({ scope, unlocked, onUnlock, onReadyChange, onScopeChange }: {
  scope: ResourceConsoleScope; unlocked: boolean; onUnlock(): void; onReadyChange(ready: boolean, attachmentId?: string): void;
  onScopeChange?(scope: ResourceConsoleScope): void;
}) {
  const [state, setState] = useState<State>('checking');
  const [observed, setObserved] = useState(scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  const pending = useRef<{ key: string; abort: AbortController } | null>(null);
  const attempted = useRef<string | null>(null);
  const current = useRef(scope);
  const publish = useRef(onScopeChange); publish.current = onScopeChange;
  const { root, poolId, workspace } = scope;
  const attachmentSupported = scope.engineeringAttachmentSupported === true;
  const read = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (document.visibilityState === 'hidden' || read.current) return;
    const abort = new AbortController(); read.current = abort;
    // A stalled observer must not keep the last running sample actionable forever.
    const timeout = window.setTimeout(() => {
      if (read.current === abort) { read.current = null; if (alive.current) setState('unknown'); }
      abort.abort();
    }, 10_000);
    abort.signal.addEventListener('abort', () => window.clearTimeout(timeout), { once: true });
    try {
      const value = await readResourceEngineeringScope({ root, poolId, workspace }, abort.signal);
      if (attachmentSupported && value.engineeringAttachmentSupported !== true ||
        current.current.engineeringAttachmentId !== undefined && value.engineeringAttachmentId === undefined ||
        value.engineeringLifecycle === undefined && value.engineeringAttachmentSupported !== true) throw new Error('Engineering scope unavailable');
      if (!abort.signal.aborted && alive.current) {
        const changed = identity(value) !== identity(current.current);
        current.current = value; setObserved(value); publish.current?.(value);
        // A confirmed successor is independent of an old request's transport.
        if (pending.current && pending.current.key !== identity(value)) {
          pending.current.abort.abort(); pending.current = null; setBusy(false);
        }
        const next = value.engineeringLifecycle ?? 'unconfigured';
        setState(pending.current?.key === identity(value) && next === 'running' ? 'stopping' : next);
        if (next === 'closed' || changed) setError(false);
      }
    } catch { if (!abort.signal.aborted && alive.current) setState('unknown'); }
    finally { window.clearTimeout(timeout); if (read.current === abort) read.current = null; }
  }, [root, poolId, workspace, attachmentSupported]);
  useEffect(() => {
    alive.current = true; void refresh();
    const poll = () => { void refresh(); }; const timer = window.setInterval(poll, 3000);
    document.addEventListener('visibilitychange', poll);
    return () => { alive.current = false; read.current?.abort(); read.current = null; pending.current?.abort.abort(); pending.current = null;
      window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [refresh]);
  const attemptedCurrent = attempted.current === identity(observed);
  useEffect(() => {
    const ready = state === 'running' && !busy && !attemptedCurrent;
    if (observed.engineeringAttachmentId === undefined) onReadyChange(ready);
    else onReadyChange(ready, observed.engineeringAttachmentId);
  }, [state, busy, attemptedCurrent, observed.engineeringAttachmentId, onReadyChange]);
  async function close() {
    if (pending.current || state === 'closed' || state === 'stopping' || state === 'unconfigured' ||
      attachmentSupported && current.current.engineeringAttachmentId === undefined) return;
    if (!unlocked) { onUnlock(); return; }
    const selected = current.current, key = identity(selected), abort = new AbortController();
    const operation = { key, abort }; attempted.current = key; pending.current = operation;
    read.current?.abort(); read.current = null;
    onReadyChange(false, selected.engineeringAttachmentId); setBusy(true); setState('stopping'); setError(false);
    const timeout = window.setTimeout(() => abort.abort(), 10_000);
    abort.signal.addEventListener('abort', () => window.clearTimeout(timeout), { once: true });
    try { const result = await closeResourceEngineering(selected.engineeringAttachmentId, abort.signal);
      if (alive.current && identity(current.current) === key) setState(result); }
    catch { if (alive.current && identity(current.current) === key) { setState('unknown'); setError(true); } }
    finally {
      window.clearTimeout(timeout);
      if (pending.current === operation) { pending.current = null; if (alive.current) { setBusy(false); void refresh(); } }
    }
  }
  return <section className={styles.panel} aria-label="Engineering lifecycle">
    <div className={styles.summary}><div className={styles.heading}><h2>Engineering runtime</h2>
      <StatusBadge status={labels[state]} tone={state === 'held' || state === 'unknown' ? 'unknown' : state === 'stopping' ? 'warning' : 'neutral'} /></div>
      <p>All engineering plans in this console. Human tasks and the workspace stay open.</p>
      {state === 'unconfigured' ? <p role="status">No engineering scope is attached. Host-managed work will appear here without interrupting your tasks.</p>
        : state === 'closed' ? <p role="status">{attachmentSupported
          ? 'This engineering scope is closed. A new host-managed scope will appear automatically; your workspace stays open.'
          : 'This engineering scope is closed. This host does not support in-session replacement.'}</p>
        : state === 'held' ? <p role="alert">Shutdown remains unresolved. Inspect retained engineering evidence before starting another console.</p>
          : state === 'stopping' ? <p role="status">Waiting for owned engineering work to settle. This does not undo delivered changes.</p>
            : <p>Close stops engineering producers and drains their work. It is not global KILL.</p>}
      {error ? <p role="alert">Close was not confirmed. Check status; a lost response does not mean the request stopped.</p> : null}
      {attemptedCurrent && state === 'running' ? <p role="status">The console still reports running after a close attempt. Engineering controls remain withheld; check status or retry close explicitly.</p> : null}
      {state === 'unknown' ? <p role="status">Current lifecycle is unavailable. New engineering work remains withheld; human tasks are unaffected.</p> : null}
    </div>
    <div className={styles.actions}><button type="button" disabled={busy} onClick={() => { void refresh(); }}>Check engineering status</button>
      <button type="button" disabled={busy || state === 'closed' || state === 'stopping' || state === 'checking' || state === 'held' || state === 'unconfigured' || attachmentSupported && !observed.engineeringAttachmentId}
        onClick={() => { void close(); }}>{busy ? 'Closing engineering…' : unlocked ? 'Close engineering' : 'Unlock to close engineering'}</button></div>
  </section>;
}
