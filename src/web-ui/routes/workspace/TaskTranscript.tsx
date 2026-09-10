import { useEffect, useRef, useState } from 'react';
import type { ResourceConsoleTranscript } from '../../../core/resources/console-types.js';
import { readResourceTaskHistory } from '../../data/resource-pool-queries.js';
import styles from './WorkspaceView.module.css';

/** Mounted with a host/session/task key. Private text never enters the query cache. */
export function TaskTranscript({ id, canDelete, unlocked, onUnlock, onDelete }: {
  id: string; canDelete: boolean; unlocked: boolean; onUnlock(): void; onDelete(): Promise<boolean>;
}) {
  const [transcript, setTranscript] = useState<ResourceConsoleTranscript | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const deletingRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; request.current?.abort(); };
  }, []);
  async function read() {
    if (deletingRef.current) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const version = ++generation.current;
    setLoading(true); setError(null);
    try {
      const value = await readResourceTaskHistory(id, controller.signal);
      if (alive.current && generation.current === version && !controller.signal.aborted) setTranscript(value);
    } catch {
      if (alive.current && generation.current === version && !controller.signal.aborted) {
        setTranscript(null); setError('Transcript unavailable. It may have been deleted; refresh the task list before retrying.');
      }
    } finally { if (alive.current && generation.current === version) setLoading(false); }
  }
  async function remove() {
    if (!canDelete || deletingRef.current) return;
    if (!unlocked) { onUnlock(); return; }
    if (!confirm) { setConfirm(true); return; }
    deletingRef.current = true; setDeleting(true); setError(null);
    generation.current++; request.current?.abort(); setLoading(false); setTranscript(null);
    try {
      if (await onDelete()) { if (alive.current) setConfirm(false); }
      else if (alive.current) setError('Deletion was not confirmed. Refresh before retrying.');
    } catch { if (alive.current) setError('Deletion was not confirmed. Refresh before retrying.'); }
    finally { deletingRef.current = false; if (alive.current) setDeleting(false); }
  }
  return <section aria-label="Retained task transcript" className={styles.transcript}>
    <h3>Local transcript</h3>
    <p className={styles.caption}>Stored on this computer until deleted, including submitted attachment text. Not encrypted by Ashlrverse.</p>
    <div className={styles.transcriptActions}>
      <button type="button" className={styles.subtleButton} disabled={loading || deleting} onClick={() => { void read(); }}>
        {loading ? 'Reading transcript…' : transcript ? 'Reload transcript' : 'Read transcript'}
      </button>
      <button type="button" className={styles.subtleButton} disabled={!canDelete || deleting} onClick={() => { void remove(); }}>
        {deleting ? 'Deleting transcript…' : !unlocked ? 'Unlock to delete transcript' : confirm ? 'Confirm delete transcript' : 'Delete transcript'}
      </button>
      {confirm && !deleting ? <button type="button" className={styles.subtleButton} onClick={() => setConfirm(false)}>Keep transcript</button> : null}
    </div>
    {confirm ? <p className={styles.caption}>Removes active transcript and session text, not task records, backups or provider history. Not secure disk erasure. This cannot be undone here and does not rerun the task.</p> : null}
    {!canDelete ? <p className={styles.caption}>Deletion requires an unlocked, available console and a settled or cancelled task.</p> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {transcript ? <>
      <h4>Submitted request</h4><pre className={styles.responseText}>{transcript.prompt}</pre>
      <h4>Captured response</h4>
      {transcript.output ? <>{transcript.output.truncated ? <p className={styles.caption}>Truncated to the local retention limit.</p> : null}
        <pre className={styles.responseText}>{transcript.output.text}</pre></>
        : <p className={styles.caption}>No response was captured in this transcript. Work is never rerun to reconstruct it.</p>}
    </> : null}
  </section>;
}
