/**
 * routes/verse/context/MemoryPanel.tsx — shared project memory, as a section
 * of the resources panel.
 *
 * Every seat on a project — Claude, Codex, Grok, local, any account — is
 * pointed at ONE Verse-owned `MEMORY.md` for that project
 * (`~/.ashlr/verse/memory/<project>-<hash>/`). The agents keep it current;
 * this panel is where the operator sees what they wrote, corrects it, clears
 * it, or turns it off for the project.
 *
 * Three facts are stated rather than implied, because each one changes what
 * the operator should do:
 *
 *  - SCOPE. The file is per PROJECT, shared across seats and accounts — not
 *    per chat. Clearing it clears it for every chat on the project.
 *  - WHO CAN WRITE. Claude, Codex and local seats are given the directory;
 *    Grok's CLI can reach only its cwd, so a Grok seat gets the text and
 *    cannot edit the file.
 *  - WHEN IT APPLIES. A chat snapshots the memory block into its instructions
 *    when it is CREATED (so the prompt prefix — and the provider's prompt
 *    cache — stays byte-identical every turn). Chats already open see an edit
 *    when they next read the file; the on/off switch affects new chats only.
 *
 * Saving is guarded against the one race this surface has: an agent can
 * write the file while the operator is editing it. The current file is
 * re-read before every save, and a change since editing began is shown as a
 * conflict instead of being silently overwritten.
 *
 * And against the one LOSSY read it has: every API response is sanitized, so
 * the text shown can have `~` for the home folder and `[REDACTED]` over
 * secret-shaped values that are still in the file (`contentSanitized`). Saving
 * that text back would write the placeholders over the real values — the
 * server refuses it (409 VERSE_MEMORY_REDACTED), and the editor says so first
 * and keeps Save off while any placeholder remains.
 *
 * The panel itself spends nothing (memory is a file on this machine), but
 * USING memory does on paid seats — the block rides in every new chat's
 * system prompt — and the panel says so (MEMORY_SPEND_NOTE).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { VERSE_MEMORY_MAX_BYTES } from '../../../../core/verse/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import { projectName } from '../verse-model.js';
import {
  formatBytes,
  jsonBodyBytes,
  MEMORY_BODY_MAX_BYTES,
  MEMORY_SPEND_NOTE,
  REDACTION_MARKER,
  redactionMarkers,
  relativePhrase,
  secretLike,
  utf8Bytes,
} from './context-model.js';
import {
  fetchProjectMemory,
  updatePreferences,
  versePreferencesQuery,
  verseProjectMemoryQuery,
  writeProjectMemory,
  type VerseProjectMemoryView,
} from './context-queries.js';
import { describeContextError, useTokenGate } from './use-token-gate.js';
import styles from './context.module.css';

export interface MemoryPanelProps {
  /** The project whose memory to show — the open chat's primary folder. Null when no chat is open. */
  projectPath: string | null;
  /**
   * Bump to re-read the file — e.g. the open chat's `turnCount`, since agents
   * write memory during turns. Optional; the panel also has a Refresh button.
   */
  refreshKey?: number | string;
}

export function MemoryPanel({ projectPath, refreshKey }: MemoryPanelProps) {
  const headingId = useId();
  if (!projectPath) {
    return (
      <section className={styles.memory} aria-labelledby={headingId}>
        <h3 id={headingId} className={styles.memoryHead}>Project memory</h3>
        <p className={styles.hint}>Open a chat to see the memory its project shares across seats.</p>
      </section>
    );
  }
  // Keyed by path: switching projects discards any half-finished edit of the
  // previous project's file instead of letting it be saved onto the new one.
  return <MemoryPanelBody key={projectPath} projectPath={projectPath} refreshKey={refreshKey} />;
}

type Mode = 'view' | 'edit' | 'confirm-clear';
type Busy = 'saving' | 'clearing' | 'toggling' | null;

const SAVE_REASON = 'Saving writes MEMORY.md for this project. Every seat on it reads this file.';
const CLEAR_REASON = 'Clearing empties MEMORY.md for every chat on this project.';
const TOGGLE_REASON = 'This changes whether new chats on this project are given shared memory.';
const GLOBAL_REASON = 'This changes whether new chats on ANY project are given shared memory.';

function MemoryPanelBody({ projectPath, refreshKey }: { projectPath: string; refreshKey?: number | string }) {
  const headingId = useId();
  const editorId = useId();
  const counterId = useId();
  const def = useMemo(() => verseProjectMemoryQuery(projectPath), [projectPath]);
  const memory = useQuery(def);
  const refresh = useRefresh(def);
  const prefs = useQuery(versePreferencesQuery);
  const gate = useTokenGate();
  const name = projectName(projectPath);

  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState('');
  /** The file as it was when editing began — what a save must still find on disk. */
  const [base, setBase] = useState('');
  /** Whether the text editing began from was sanitized — a placeholder in it stands for a real value on disk. */
  const [baseSanitized, setBaseSanitized] = useState(false);
  const [conflict, setConflict] = useState<VerseProjectMemoryView | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // A finished turn may have changed the file; re-read on the caller's signal
  // (never on first render — useQuery already read it).
  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === firstKey.current) return;
    firstKey.current = refreshKey;
    refresh();
  }, [refreshKey, refresh]);

  // Entering the editor lands the caret at the END: the common edit is adding
  // a line, and a caret at offset 0 would prepend it above the heading.
  useEffect(() => {
    const editor = editorRef.current;
    if (mode !== 'edit' || !editor) return;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, [mode]);

  // The record a write just returned, shown until the re-read it triggered
  // lands — otherwise "Saved." would sit over the OLD text for a round trip.
  const [lastWritten, setLastWritten] = useState<VerseProjectMemoryView | null>(null);
  useEffect(() => {
    if (lastWritten !== null && memory.status === 'success') setLastWritten(null);
  }, [lastWritten, memory.status]);
  const data = lastWritten !== null && memory.status !== 'success' ? lastWritten : memory.data;
  const unsupported = memory.error instanceof ApiError && memory.error.status === 404;
  const globalOff = prefs.data ? !prefs.data.memory.enabled : false;
  const draftBytes = useMemo(() => utf8Bytes(draft), [draft]);
  const overCap = draftBytes > VERSE_MEMORY_MAX_BYTES;
  // Under the memory cap is not enough: the request that carries it must fit
  // POST /memory's body cap once JSON-escaped. That route's cap is sized for
  // a full 64 KB file (MEMORY_BODY_MAX_BYTES, the server's own figure) — the
  // 64 KB default every other POST uses would block saves the server accepts.
  // In practice this only trips on text that escapes to more than 2 bytes a
  // character (control characters), which the server would refuse too.
  const requestBytes = useMemo(() => jsonBodyBytes({ projectPath, content: draft }), [projectPath, draft]);
  const overBody = !overCap && requestBytes > MEMORY_BODY_MAX_BYTES;
  const secret = mode === 'edit' ? secretLike(draft) : null;
  // Only a sanitized base makes a placeholder dangerous: in an unsanitized
  // file a literal "[REDACTED]" is just text the file already had.
  const placeholders = mode === 'edit' && baseSanitized ? redactionMarkers(draft) : 0;

  function startEdit(from: string, sanitized: boolean) {
    setDraft(from);
    setBase(from);
    setBaseSanitized(sanitized);
    setConflict(null);
    setError(null);
    setNotice(null);
    setMode('edit');
  }

  async function save(overwrite = false) {
    if (busy) return;
    setBusy('saving');
    setError(null);
    try {
      // Re-read first: an agent may have written the file since editing began.
      const latest = await fetchProjectMemory(projectPath);
      if (!overwrite && latest.content !== base) {
        setConflict(latest);
        return;
      }
      const saved = await gate.run(SAVE_REASON, () => writeProjectMemory(projectPath, draft));
      if (saved === null) return;
      setLastWritten(saved);
      setConflict(null);
      setMode('view');
      setNotice(saved.content.length === 0 ? 'Saved — MEMORY.md is now empty.' : 'Saved.');
    } catch (err) {
      setError(describeContextError(err));
    } finally {
      setBusy(null);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy('clearing');
    setError(null);
    try {
      const saved = await gate.run(CLEAR_REASON, () => writeProjectMemory(projectPath, ''));
      if (saved === null) return;
      setLastWritten(saved);
      setMode('view');
      setNotice('Cleared. Agents start MEMORY.md afresh on their next write.');
    } catch (err) {
      setError(describeContextError(err));
    } finally {
      setBusy(null);
    }
  }

  async function setProjectEnabled(next: boolean) {
    if (busy) return;
    setBusy('toggling');
    setError(null);
    setNotice(null);
    try {
      const result = await gate.run(TOGGLE_REASON, () => updatePreferences({ projectPath, memoryEnabled: next }));
      if (result !== null) {
        setNotice(next
          ? `New chats on ${name} will get shared memory. Chats already open keep what they started with.`
          : `New chats on ${name} will start without shared memory. The file is kept.`);
      }
    } catch (err) {
      setError(describeContextError(err));
    } finally {
      setBusy(null);
    }
  }

  async function setGlobalEnabled(next: boolean) {
    if (busy) return;
    setBusy('toggling');
    setError(null);
    setNotice(null);
    try {
      await gate.run(GLOBAL_REASON, () => updatePreferences({ memoryEnabled: next }));
    } catch (err) {
      setError(describeContextError(err));
    } finally {
      setBusy(null);
    }
  }

  const state = data ? (globalOff ? 'off everywhere' : data.enabled ? 'on' : 'off') : null;

  return (
    <section className={styles.memory} aria-labelledby={headingId} data-project={projectPath}>
      <h3 id={headingId} className={styles.memoryHead}>
        <span>Project memory</span>
        {state ? <span className={styles.memoryState}>{state}</span> : null}
        {unsupported ? null : (
          <button type="button" className={styles.memoryHeadAction} onClick={refresh}
            aria-label="Refresh project memory">Refresh</button>
        )}
      </h3>

      <p className={styles.hint}>
        One <code>MEMORY.md</code> shared by every chat on <strong>{name}</strong>, whichever seat runs it. Agents keep it
        current — decisions and why, conventions, gotchas, plan status.
      </p>

      {unsupported ? (
        <p className={styles.hint}>This server has no project memory yet — update Ashlr and restart <code>ashlr verse</code>.</p>
      ) : memory.status === 'loading' || (memory.status === 'idle' && !data) ? (
        <div aria-busy="true"><SkeletonLine width="80%" /><SkeletonLine width="60%" /><SkeletonLine width="70%" /></div>
      ) : !data ? (
        <div className={styles.searchError} role="alert">
          <span>Could not read this project’s memory: {describeContextError(memory.error)}</span>
          <button type="button" className={`${styles.secondary} ${styles.small}`} onClick={refresh}>Retry</button>
        </div>
      ) : (
        <>
          {/* ---- on / off ---- */}
          {globalOff ? (
            <div className={styles.field}>
              <p className={styles.hint}>Shared memory is off for every project, so new chats start without it.</p>
              <div className={styles.memoryActions}>
                <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={busy !== null}
                  onClick={() => void setGlobalEnabled(true)}>Turn memory on</button>
              </div>
            </div>
          ) : (
            <Switch checked={data.enabled} disabled={busy !== null || !prefs.data}
              onChange={(next) => void setProjectEnabled(next)}
              label={`Give new chats on ${name} this memory`} />
          )}

          {/* ---- the file ---- */}
          {mode === 'edit' ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={editorId}>Edit MEMORY.md</label>
              <textarea id={editorId} ref={editorRef} className={styles.textarea} value={draft} rows={12} spellCheck={false}
                aria-describedby={counterId} aria-invalid={overCap || overBody ? true : undefined}
                onChange={(event) => setDraft(event.target.value)} />
              <p id={counterId} className={`${styles.hint} ${styles.counter} ${overCap || overBody ? styles.counterOver : ''}`}>
                {formatBytes(draftBytes)} of {formatBytes(VERSE_MEMORY_MAX_BYTES)}
                {overCap ? ' — over the limit; trim it to save.' : ''}
                {overBody ? ` — ${formatBytes(requestBytes)} once line breaks and quotes are encoded for sending, over the ${formatBytes(MEMORY_BODY_MAX_BYTES)} request limit; trim it to save.` : ''}
              </p>
              {secret ? (
                <p className={styles.warn} role="alert">
                  This looks like it contains {secret}. MEMORY.md is sent to every seat’s model — remove it before saving.
                </p>
              ) : null}
              {placeholders > 0 ? (
                <p className={styles.warn} role="alert">
                  {placeholders === 1 ? 'One' : placeholders} <code>{REDACTION_MARKER}</code> placeholder{placeholders === 1 ? ' stands' : 's stand'} in
                  for secret-looking text that is still in MEMORY.md. Saving {placeholders === 1 ? 'it' : 'them'} would replace the real
                  value{placeholders === 1 ? '' : 's'}, so Save stays off until {placeholders === 1 ? 'it is' : 'they are'} gone. Deleting a
                  placeholder drops that value from the file; to keep it, edit MEMORY.md directly under <code>~/.ashlr/verse/memory</code>.
                </p>
              ) : baseSanitized ? (
                <p className={styles.hint}>
                  This copy was sanitized for the browser, so a home-folder path appears as <code>~</code>. Saving writes the text as
                  shown; <code>~</code> names the same folder for every reader.
                </p>
              ) : null}
              {conflict ? (
                <div className={styles.warn} role="alert">
                  <p className={styles.hint}>
                    An agent changed MEMORY.md while you were editing
                    {relativePhrase(conflict.updatedAt) ? ` (${relativePhrase(conflict.updatedAt)})` : ''}.
                  </p>
                  <div className={styles.memoryActions}>
                    <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={busy !== null || placeholders > 0}
                      onClick={() => void save(true)}>Overwrite with mine</button>
                    <button type="button" className={`${styles.cancel} ${styles.small}`} disabled={busy !== null}
                      onClick={() => startEdit(conflict.content, conflict.contentSanitized === true)}>Start over from theirs</button>
                  </div>
                </div>
              ) : null}
              <div className={styles.memoryActions}>
                <button type="button" className={`${styles.primary} ${styles.small}`}
                  disabled={busy !== null || overCap || overBody || draft === base || conflict !== null || placeholders > 0}
                  onClick={() => void save(false)}>{busy === 'saving' ? 'Saving…' : 'Save'}</button>
                <button type="button" className={`${styles.cancel} ${styles.small}`} disabled={busy === 'saving'}
                  onClick={() => { setMode('view'); setConflict(null); setError(null); }}>Cancel</button>
              </div>
            </div>
          ) : data.content.length === 0 ? (
            <div className={styles.field}>
              <p className={styles.hint}>
                MEMORY.md is empty. Agents add to it as they work, or write the first entries yourself.
              </p>
              <div className={styles.memoryActions}>
                <button type="button" className={`${styles.secondary} ${styles.small}`} onClick={() => startEdit('', false)}>Write it</button>
              </div>
            </div>
          ) : (
            <div className={styles.field}>
              <pre className={styles.memoryBody} tabIndex={0} aria-label={`MEMORY.md for ${name}`}>{data.content}</pre>
              <p className={`${styles.hint} ${styles.memoryMeta}`}>
                <span>{formatBytes(data.bytes)}</span>
                {relativePhrase(data.updatedAt) ? <span>updated {relativePhrase(data.updatedAt)}</span> : null}
              </p>
              {data.contentSanitized ? (
                <p className={styles.hint}>
                  Shown sanitized for the browser: a home-folder path appears as <code>~</code> and secret-looking text as{' '}
                  <code>{REDACTION_MARKER}</code>.{redactionMarkers(data.content) > 0 ? ' The real values are still in the file.' : ''}
                </p>
              ) : null}
              {mode === 'confirm-clear' ? (
                <div className={styles.warn} role="alert">
                  <p className={styles.hint}>Clear MEMORY.md for {name}? Every chat on this project loses what it says. Other files in the folder stay.</p>
                  <div className={styles.memoryActions}>
                    <button type="button" className={`${styles.secondary} ${styles.small} ${styles.danger}`} disabled={busy !== null}
                      onClick={() => void clear()}>{busy === 'clearing' ? 'Clearing…' : 'Clear it'}</button>
                    <button type="button" className={`${styles.cancel} ${styles.small}`} onClick={() => setMode('view')}>Keep</button>
                  </div>
                </div>
              ) : (
                <div className={styles.memoryActions}>
                  <button type="button" className={`${styles.secondary} ${styles.small}`}
                    onClick={() => startEdit(data.content, data.contentSanitized === true)}>Edit</button>
                  <button type="button" className={`${styles.cancel} ${styles.small}`}
                    onClick={() => { setNotice(null); setMode('confirm-clear'); }}>Clear…</button>
                </div>
              )}
            </div>
          )}

          {data.files.length > 0 ? (
            <div className={styles.field}>
              <span className={styles.label}>Also in this folder</span>
              <ul className={styles.memoryFiles}>
                {data.files.map((file) => <li key={file}><code>{file}</code></li>)}
              </ul>
            </div>
          ) : null}

          {notice ? <p className={styles.hint} role="status">{notice}</p> : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}

          <details>
            <summary className={styles.hint}>How project memory works</summary>
            <div className={styles.field}>
              <p className={styles.hint}>
                Claude, Codex and local seats can read and edit the file. Grok’s CLI can reach only its working folder, so a
                Grok seat is given the text and can only read it.
              </p>
              <p className={styles.hint}>
                A chat copies the memory into its instructions when it starts, so every turn re-sends the same prefix and the
                provider’s prompt cache keeps working. Chats already open see your edits when they next read the file; the
                switch above applies to new chats.
              </p>
              <p className={styles.hint}>
                It lives on this machine under <code>~/.ashlr/verse/memory</code>, readable only by you. It is sent to every
                seat’s model, so never put secrets in it.
              </p>
              <p className={styles.hint}>{MEMORY_SPEND_NOTE}</p>
              {globalOff ? null : (
                <p className={styles.hint}>
                  Memory is on for every project unless switched off per project.{' '}
                  <button type="button" className={styles.link} disabled={busy !== null}
                    onClick={() => void setGlobalEnabled(false)}>Turn it off for every project</button>
                </p>
              )}
            </div>
          </details>
        </>
      )}

      <MutationTokenDialog open={gate.dialog.open} reason={gate.dialog.reason} tokenLabel="Mutation token"
        tokenHelp="the mutation token ashlr verse printed" onClose={gate.dialog.onClose} onUnlocked={gate.dialog.onUnlocked} />
    </section>
  );
}
