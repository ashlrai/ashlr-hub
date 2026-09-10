import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ResourceConsoleFileListing, ResourceConsoleFilePreview } from '../../../core/resources/console-files-types.js';
import { listWorkspaceFiles, readWorkspaceFile } from '../../data/workspace-files.js';
import { MAX_WORKSPACE_ATTACHMENT_BYTES, parseWorkspaceTextAttachment, type WorkspaceTextAttachment } from './workspace-attachments.js';
import styles from './WorkspaceView.module.css';

export function WorkspaceFiles({ projectId, unlocked, available, canAttach, onUnlock, onAttach }: {
  projectId: string; unlocked: boolean; available: boolean; canAttach: boolean;
  onUnlock(): void; onAttach(attachment: WorkspaceTextAttachment): void;
}) {
  const [directory, setDirectory] = useState('');
  const [listing, setListing] = useState<ResourceConsoleFileListing | null>(null);
  const [preview, setPreview] = useState<ResourceConsoleFilePreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current++; request.current?.abort(); setListing(null); setPreview(null); setPending(false); setError(null); setNotice(null); setDirectory('');
    return () => { sequence.current++; request.current?.abort(); };
  }, [projectId, unlocked, available]);

  async function load(path: string, kind: 'directory' | 'file') {
    if (!unlocked || !available) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const generation = ++sequence.current; setPending(true); setError(null); setNotice(null); setPreview(null);
    if (kind === 'directory') setListing(null);
    try {
      if (kind === 'directory') {
        const value = await listWorkspaceFiles(projectId, path, controller.signal);
        if (sequence.current === generation && !controller.signal.aborted) { setListing(value); setDirectory(value.path); }
      } else {
        const value = await readWorkspaceFile(projectId, path, controller.signal);
        if (sequence.current === generation && !controller.signal.aborted) setPreview(value);
      }
    } catch (cause) {
      if (sequence.current === generation && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Project files are unavailable.');
    } finally { if (sequence.current === generation) setPending(false); }
  }
  function browse(event: FormEvent) { event.preventDefault(); void load(directory, 'directory'); }
  function attach() {
    if (!preview || !unlocked || !available || !canAttach || preview.truncated || preview.byteLength > MAX_WORKSPACE_ATTACHMENT_BYTES) return;
    try {
      const parsed = parseWorkspaceTextAttachment(preview.path.split('/').at(-1)!, new TextEncoder().encode(preview.text));
      onAttach({ ...parsed, source: { projectId, path: preview.path, digest: preview.digest } });
      setError(null); setNotice('Snapshot attached to this project’s draft. Sending is a separate action.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This snapshot cannot be attached.'); }
  }
  if (!available) return <p className={styles.caption}>Project files are unavailable for this disabled or disconnected workspace.</p>;
  if (!unlocked) return <><h3>Project files</h3><p className={styles.caption}>Unlock controls to browse source files. Browsing never sends file content to a model.</p>
    <button type="button" className={styles.subtleButton} onClick={onUnlock}>Unlock file access</button></>;
  return <div className={styles.files}>
    <h3>Project files</h3><p className={styles.caption}>Preview source, then attach the exact viewed snapshot. Known private paths and unsafe file types are excluded; this is not secret detection.</p>
    <form aria-label="Browse project directory" onSubmit={browse} className={styles.fileBrowse}>
      <label>Project-relative directory<input aria-label="Project-relative directory" value={directory} placeholder="Project root" onChange={(event) => setDirectory(event.target.value)} /></label>
      <button type="submit" className={styles.subtleButton} disabled={pending}>Browse files</button>
    </form>
    {pending ? <p role="status">Reading project files…</p> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
    {listing ? <section aria-label="Directory listing"><div className={styles.fileHeading}><strong>{listing.path || 'Project root'}</strong>
      {listing.path ? <button type="button" className={styles.subtleButton} disabled={pending} onClick={() => void load(listing.path.split('/').slice(0, -1).join('/'), 'directory')}>Parent directory</button> : null}</div>
      {listing.entries.length ? <ul className={styles.fileList}>{listing.entries.map((entry) => <li key={entry.path}>
        <button type="button" disabled={pending} aria-label={`${entry.kind === 'directory' ? 'Open directory' : 'Preview file'} ${entry.path}`} onClick={() => void load(entry.path, entry.kind)}>
          <span aria-hidden="true">{entry.kind === 'directory' ? '▸' : '◇'}</span><span>{entry.name}</span><small>{entry.kind === 'directory' ? 'Directory' : `${entry.sizeBytes} B`}</small>
        </button></li>)}</ul> : <p className={styles.caption}>No readable entries in this directory.</p>}
    </section> : null}
    {preview ? <section aria-label="File preview"><h4>{preview.path}</h4>
      <p className={styles.caption}>{preview.byteLength.toLocaleString()} of {preview.sizeBytes.toLocaleString()} bytes. {preview.truncated ? 'Partial preview; cannot attach.' : 'Complete snapshot.'}</p>
      <pre className={styles.filePreview}>{preview.text || '(Empty file)'}</pre>
      <details className={styles.options}><summary>Snapshot identity</summary><code>{preview.digest}</code></details>
      <button type="button" className={styles.subtleButton} disabled={!canAttach || preview.truncated || preview.byteLength > MAX_WORKSPACE_ATTACHMENT_BYTES} onClick={attach}>Attach viewed snapshot</button>
      {preview.byteLength > MAX_WORKSPACE_ATTACHMENT_BYTES ? <p className={styles.caption}>Attachments are limited to 16 KiB each. No partial file will be added to your task.</p> : null}
    </section> : null}
  </div>;
}
