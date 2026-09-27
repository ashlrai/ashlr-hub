/**
 * routes/verse/changes/ChangesPanel.tsx — the Changes pane: what the agent
 * changed, turn by turn, reviewed and undone in place (3.15; server:
 * core/verse/checkpoints-api.ts).
 *
 *   [Turn 3 · 4 files · 2:14 PM ▾] [repo ▾]  This turn | Since turn | All turns   Unified|Split ⟳
 *   4 files · +120 −8                              [Undo turn…] [Redo] [Commit…] [Open PR…]
 *   ┌ files, grouped by folder (accept · reject) ┬ patch: syntax, word diff, Accept/Reject per hunk ┐
 *
 * VIEWS
 *   This turn   the turn's own changes: its `pre` checkpoint → its `post`.
 *               The historical record; nothing to accept or reject.
 *   Since turn  `pre` of the turn → the files on disk now. Accept marks a file
 *               or hunk reviewed; Reject restores it from the checkpoint.
 *   All turns   the same, from the chat's FIRST checkpoint: everything the
 *               chat changed.
 *
 * SAFETY. Every write (reject, undo, redo, commit, PR) goes through the
 * mutation token, is refused by the server while a turn runs, and Undo/Redo
 * always opens a preview first (UndoDialog) — later edits are never silently
 * overwritten. A file reject asks for a second click.
 *
 * Self-contained: it needs only the chat id. `changes-pane.ts` adapts it to
 * a pane host.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
  VerseCheckpointDecision,
  VerseCheckpointDiffFile,
  VerseCheckpointDiffResponse,
  VerseCheckpointListResponse,
  VerseCheckpointPreviewResponse,
  VerseCheckpointTurn,
} from '../../../../core/verse/checkpoint-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button, IconButton } from '../../../components/primitives/Button.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { IconCheck, IconRefresh, IconX } from '../../../components/primitives/icons.js';
import { useTokenGate } from '../context/use-token-gate.js';
import { CommitDialog, CreatePrDialog } from '../git/GitDialogs.js';
import { describeGitError, type GitStatusView } from '../git/git-model.js';
import { commitGit, fetchGitStatus, openGitPr } from '../git/git-queries.js';
import {
  STATUS_WORD,
  groupByDirectory,
  plural,
  totals,
  turnCheckpointError,
  turnHasCheckpoint,
  turnLabel,
  type Resolutions,
} from './changes-model.js';
import { checkpointClient, describeCheckpointError, errorCode, type CheckpointClient } from './checkpoint-queries.js';
import { HunkPatch, type PatchLayout } from './HunkPatch.js';
import { UndoDialog } from './UndoDialog.js';
import chrome from '../dock/pane-chrome.module.css';
import review from '../git/DiffPane.module.css';
import styles from './ChangesPanel.module.css';

export type ChangesView = 'turn' | 'since' | 'all';

export interface ChangesPanelProps {
  /** The chat whose turns are reviewed. */
  sessionId: string;
  /** False while the pane is a background tab: nothing is fetched until shown. */
  visible?: boolean;
  /** Test seams. */
  client?: CheckpointClient;
  git?: {
    status: typeof fetchGitStatus;
    commit: typeof commitGit;
    openPr: typeof openGitPr;
  };
  /** Poll interval while a turn runs (ms). */
  pollMs?: number;
}

type Load<T> = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; message: string; code: string | null };

type UndoState = {
  kind: 'undo' | 'redo';
  turnLabel: string;
  preview: VerseCheckpointPreviewResponse | null;
  busy: boolean;
  error: string | null;
} | null;

type GitDialog = { kind: 'commit' | 'pr'; root: string; status: GitStatusView } | null;

const DEFAULT_GIT = { status: fetchGitStatus, commit: commitGit, openPr: openGitPr };

export function ChangesPanel({ sessionId, visible = true, client = checkpointClient, git = DEFAULT_GIT, pollMs = 3_000 }: ChangesPanelProps) {
  const [list, setList] = useState<Load<VerseCheckpointListResponse>>({ state: 'idle' });
  const [turnId, setTurnId] = useState<string | null>(null);
  const [rootId, setRootId] = useState<string | null>(null);
  const [view, setView] = useState<ChangesView>('since');
  const [layout, setLayout] = useState<PatchLayout>('unified');
  const [diff, setDiff] = useState<Load<VerseCheckpointDiffResponse>>({ state: 'idle' });
  const [file, setFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<Load<VerseCheckpointDiffResponse>>({ state: 'idle' });
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<{ file: string; hunk: string | null } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [undo, setUndo] = useState<UndoState>(null);
  const [gitDialog, setGitDialog] = useState<GitDialog>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const gate = useTokenGate();
  const turnSelectId = useId();
  const rootSelectId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const followLatest = useRef(true);

  const refresh = useCallback(() => setReload((n) => n + 1), []);

  // ---- the chat's turns ----------------------------------------------------

  useEffect(() => {
    if (!visible) return;
    const ctl = new AbortController();
    setList((prev) => (prev.state === 'ready' ? prev : { state: 'loading' }));
    client.list(sessionId, ctl.signal).then(
      (data) => setList({ state: 'ready', data }),
      (err: unknown) => {
        if (ctl.signal.aborted) return;
        setList({ state: 'error', message: describeCheckpointError(err), code: errorCode(err) });
      },
    );
    return () => ctl.abort();
  }, [client, sessionId, visible, reload]);

  const data = list.state === 'ready' ? list.data : null;
  const running = data?.running ?? false;

  // While a turn runs, watch for its end (a light list read).
  useEffect(() => {
    if (!visible || !running) return;
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [visible, running, pollMs, refresh]);

  const turns = useMemo(() => data?.turns ?? [], [data]);
  const withCheckpoint = useMemo(() => turns.filter(turnHasCheckpoint), [turns]);

  // Follow the newest turn until the operator picks one.
  useEffect(() => {
    if (turns.length === 0) {
      setTurnId(null);
      return;
    }
    const latest = turns[turns.length - 1]!;
    if (turnId === null || !turns.some((t) => t.turnId === turnId) || followLatest.current) setTurnId(latest.turnId);
  }, [turns, turnId]);

  const turn: VerseCheckpointTurn | null = turns.find((t) => t.turnId === turnId) ?? null;
  const baseTurn: VerseCheckpointTurn | null = view === 'all' ? withCheckpoint[0] ?? null : turn;
  const rootsForTurn = useMemo(
    () => (baseTurn ? baseTurn.roots.filter((r) => r.pre?.commit).map((r) => r.rootId) : []),
    [baseTurn],
  );
  const rootNames = useMemo(() => Object.fromEntries((data?.roots ?? []).map((r) => [r.rootId, r.name])), [data]);
  const rootPath = (id: string | null) => data?.roots.find((r) => r.rootId === id)?.path ?? null;

  useEffect(() => {
    if (rootId === null || !rootsForTurn.includes(rootId)) setRootId(rootsForTurn[0] ?? null);
  }, [rootsForTurn, rootId]);

  // ---- the file list ---------------------------------------------------------

  const mode = view === 'turn' ? 'turn' : 'since';
  useEffect(() => {
    if (!visible || !baseTurn || !rootId || !rootsForTurn.includes(rootId)) {
      setDiff({ state: 'idle' });
      return;
    }
    const ctl = new AbortController();
    setDiff((prev) => (prev.state === 'ready' ? prev : { state: 'loading' }));
    client.diff({ chatId: sessionId, turnId: baseTurn.turnId, rootId, mode }, ctl.signal).then(
      (d) => setDiff({ state: 'ready', data: d }),
      (err: unknown) => {
        if (ctl.signal.aborted) return;
        setDiff({ state: 'error', message: describeCheckpointError(err), code: errorCode(err) });
      },
    );
    return () => ctl.abort();
  }, [client, sessionId, baseTurn, rootId, rootsForTurn, mode, visible, reload]);

  const files = useMemo(() => (diff.state === 'ready' ? diff.data.files : []), [diff]);
  const groups = useMemo(() => groupByDirectory(files), [files]);
  const flat = useMemo(() => groups.flatMap((g) => g.files.map((f) => f.path)), [groups]);
  const actionable = diff.state === 'ready' && diff.data.actionable && !running;

  useEffect(() => {
    if (file === null || !flat.includes(file)) setFile(flat[0] ?? null);
  }, [flat, file]);

  // ---- the selected file's patch ---------------------------------------------

  useEffect(() => {
    if (!visible || !baseTurn || !rootId || file === null || diff.state !== 'ready') {
      setPatch({ state: 'idle' });
      return;
    }
    const ctl = new AbortController();
    setPatch((prev) => (prev.state === 'ready' && prev.data.patch?.path === file ? prev : { state: 'loading' }));
    client.diff({ chatId: sessionId, turnId: baseTurn.turnId, rootId, mode, file }, ctl.signal).then(
      (d) => setPatch({ state: 'ready', data: d }),
      (err: unknown) => {
        if (ctl.signal.aborted) return;
        setPatch({ state: 'error', message: describeCheckpointError(err), code: errorCode(err) });
      },
    );
    return () => ctl.abort();
  }, [client, sessionId, baseTurn, rootId, mode, file, diff, visible]);

  // ---- actions -----------------------------------------------------------------

  const say = (text: string, tone: 'ok' | 'error' = 'ok') => setNotice({ text, tone });

  const reviewAction = async (target: { file: string; hunk?: string }, decision: VerseCheckpointDecision) => {
    if (!baseTurn || !rootId) return;
    setBusy({ file: target.file, hunk: target.hunk ?? null });
    setArmed(null);
    setNotice(null);
    try {
      const reason = decision === 'reject'
        ? `Restore ${target.hunk ? 'one change in ' : ''}${target.file} from the checkpoint before ${turnLabelShort(baseTurn)}.`
        : `Mark ${target.file} reviewed.`;
      const result = await gate.run(reason, () => client.review({ chatId: sessionId, turnId: baseTurn.turnId, rootId, file: target.file, ...(target.hunk ? { hunk: target.hunk } : {}), decision }));
      if (result === null) return;
      say(decision === 'accept'
        ? `Accepted ${target.hunk ? 'the change in ' : ''}${target.file}.`
        : `Restored ${target.hunk ? 'the change in ' : ''}${target.file} from the checkpoint.`);
      refresh();
    } catch (err) {
      say(describeCheckpointError(err), 'error');
      if (errorCode(err) === 'VERSE_CHECKPOINT_STALE') refresh();
    } finally {
      setBusy(null);
    }
  };

  const rejectFile = (path: string) => {
    if (armed !== path) {
      setArmed(path);
      return;
    }
    void reviewAction({ file: path }, 'reject');
  };

  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => setArmed(null), 5_000);
    return () => clearTimeout(t);
  }, [armed]);

  const openUndo = async (kind: 'undo' | 'redo') => {
    const target = kind === 'undo' ? turn : turns.find((t) => t.turnId === data?.redo?.turnId) ?? null;
    if (!target) return;
    const label = turnLabelShort(target);
    setUndo({ kind, turnLabel: label, preview: null, busy: true, error: null });
    try {
      const preview = await gate.run(
        kind === 'undo' ? `Prepare to undo ${label}: take a snapshot and compare it with the checkpoint.` : `Prepare to redo ${label}.`,
        () => (kind === 'undo' ? client.previewUndo(sessionId, target.turnId) : client.previewRedo(sessionId)),
      );
      if (preview === null) {
        setUndo(null);
        return;
      }
      setUndo({ kind, turnLabel: label, preview, busy: false, error: null });
    } catch (err) {
      setUndo(null);
      say(describeCheckpointError(err), 'error');
    }
  };

  const confirmUndo = async (resolutions: Resolutions) => {
    if (!undo?.preview) return;
    const { preview, kind, turnLabel: label } = undo;
    setUndo({ ...undo, busy: true, error: null });
    try {
      const result = await gate.run(kind === 'undo' ? `Undo ${label}.` : `Redo ${label}.`, () => client.apply(sessionId, preview.previewId, resolutions));
      if (result === null) {
        setUndo((u) => (u ? { ...u, busy: false } : u));
        return;
      }
      const written = result.roots.reduce((n, r) => n + r.written.length + r.deleted.length + r.merged.length, 0);
      setUndo(null);
      say(kind === 'undo' ? `Undid ${label}: ${plural(written, 'file')} restored. Redo puts them back.` : `Redid ${label}: ${plural(written, 'file')} put back.`);
      refresh();
    } catch (err) {
      const stale = errorCode(err) === 'VERSE_CHECKPOINT_STALE';
      setUndo((u) => (u ? { ...u, busy: false, error: describeCheckpointError(err) + (stale ? ' Close this and open Undo again to review the new state.' : '') } : u));
    }
  };

  const openGit = async (kind: 'commit' | 'pr') => {
    const root = rootPath(rootId);
    if (!root) return;
    setGitError(null);
    try {
      const status = await git.status(root);
      setGitDialog({ kind, root, status });
    } catch (err) {
      say(describeGitError(err), 'error');
    }
  };

  const runGit = async (reason: string, action: () => Promise<{ status: GitStatusView; pr?: { number: number } | null }>, done: (r: { status: GitStatusView; pr?: { number: number } | null }) => string) => {
    setGitBusy(true);
    setGitError(null);
    try {
      const result = await gate.run(reason, action);
      if (result === null) return;
      setGitDialog(null);
      say(done(result));
      refresh();
    } catch (err) {
      setGitError(describeGitError(err));
    } finally {
      setGitBusy(false);
    }
  };

  // ---- keyboard: ↑ ↓ Home End walk the file list --------------------------------

  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    if (flat.length === 0) return;
    const at = file === null ? -1 : flat.indexOf(file);
    const go = (i: number) => {
      e.preventDefault();
      const next = flat[Math.max(0, Math.min(flat.length - 1, i))]!;
      setFile(next);
      listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next)}"]`)?.scrollIntoView?.({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(flat.length - 1);
  };

  // ---- render -------------------------------------------------------------------

  if (list.state === 'error') {
    return (
      <section className={`${review.pane} ${styles.panel}`} aria-label="Changes">
        <EmptyState
          compact
          tone="error"
          title="Changes are unavailable"
          body={list.message}
          action={<Button size="sm" variant="subtle" onClick={refresh}>Try again</Button>}
        />
      </section>
    );
  }

  if (list.state !== 'ready' || !data) {
    return (
      <section className={`${review.pane} ${styles.panel}`} aria-label="Changes" aria-busy="true">
        <div className={review.skeleton}><SkeletonLine /><SkeletonLine /><SkeletonLine /></div>
      </section>
    );
  }

  if (turns.length === 0) {
    return (
      <section className={`${review.pane} ${styles.panel}`} aria-label="Changes">
        <EmptyState
          compact
          title="No checkpoints yet"
          body="Before every turn Verse takes a checkpoint of this chat’s repositories. Send a message and the agent’s changes appear here, ready to review or undo."
        />
      </section>
    );
  }

  const stats = totals(files);
  const selected: VerseCheckpointDiffFile | null = files.find((f) => f.path === file) ?? null;
  const patchData = patch.state === 'ready' ? patch.data.patch : null;
  const canUndo = !running && turn !== null && turnHasCheckpoint(turn);
  const redoTurn = data.redo ? turns.find((t) => t.turnId === data.redo!.turnId) ?? null : null;
  const noCheckpoint = baseTurn && !turnHasCheckpoint(baseTurn) ? turnCheckpointError(baseTurn) ?? 'No checkpoint was taken before this turn.' : null;

  return (
    <section className={`${review.pane} ${styles.panel}`} aria-label="Changes">
      <div className={`${chrome.header} ${styles.head}`}>
        <label className={styles.visuallyHidden} htmlFor={turnSelectId}>Turn</label>
        <select
          id={turnSelectId}
          className={styles.select}
          value={turnId ?? ''}
          disabled={view === 'all'}
          onChange={(e) => {
            followLatest.current = e.target.value === turns[turns.length - 1]?.turnId;
            setTurnId(e.target.value);
          }}
        >
          {[...turns].reverse().map((t) => (
            <option key={t.turnId} value={t.turnId}>{turnLabel(t)}</option>
          ))}
        </select>
        {rootsForTurn.length > 1 ? (
          <>
            <label className={styles.visuallyHidden} htmlFor={rootSelectId}>Repository</label>
            <select id={rootSelectId} className={styles.select} value={rootId ?? ''} onChange={(e) => setRootId(e.target.value)}>
              {rootsForTurn.map((id) => <option key={id} value={id}>{rootNames[id] ?? id}</option>)}
            </select>
          </>
        ) : rootId ? <span className={chrome.title} title={rootPath(rootId) ?? undefined}>{rootNames[rootId]}</span> : null}
        <Segmented<ChangesView>
          size="sm"
          aria-label="Which changes"
          value={view}
          onChange={setView}
          options={[
            { value: 'turn', label: 'This turn' },
            { value: 'since', label: 'Since turn' },
            { value: 'all', label: 'All turns' },
          ]}
        />
        <div className={chrome.actions}>
          <Segmented<PatchLayout>
            size="sm"
            aria-label="Diff layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'unified', label: 'Unified' },
              { value: 'split', label: 'Split' },
            ]}
          />
          <IconButton size="sm" variant="ghost" icon={<IconRefresh />} aria-label="Refresh changes" onClick={refresh} />
        </div>
      </div>

      <div className={styles.toolbar}>
        <p className={review.summary} aria-live="polite">
          {diff.state === 'ready' ? (
            <>
              {plural(stats.files, 'file')} · <span className={review.add}>+{stats.additions.toLocaleString('en-US')}</span>{' '}
              <span className={review.del}>−{stats.deletions.toLocaleString('en-US')}</span>
              <span className={review.muted}>
                {view === 'turn' ? ` in ${turn ? turnLabelShort(turn) : 'this turn'}` : ` since ${baseTurn ? `before ${turnLabelShort(baseTurn)}` : 'the checkpoint'}`}
              </span>
            </>
          ) : null}
        </p>
        <div className={styles.toolbarActions}>
          <Button size="sm" variant="subtle" disabled={!canUndo} onClick={() => void openUndo('undo')}
            title={running ? 'Wait for the running turn to finish' : undefined}>
            {turn && turn.index < turns.length ? `Rewind to before ${turnLabelShort(turn)}…` : 'Undo turn…'}
          </Button>
          {redoTurn ? (
            <Button size="sm" variant="subtle" disabled={running} onClick={() => void openUndo('redo')}>
              Redo {turnLabelShort(redoTurn)}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={running || !rootId} onClick={() => void openGit('commit')}>Commit…</Button>
          <Button size="sm" variant="ghost" disabled={running || !rootId} onClick={() => void openGit('pr')}>Open PR…</Button>
        </div>
      </div>

      {running ? (
        <p className={styles.banner} role="status">A turn is running. Changes update when it ends; restoring waits until then.</p>
      ) : null}
      {notice ? (
        <p className={styles.notice} role={notice.tone === 'error' ? 'alert' : 'status'} data-tone={notice.tone}>{notice.text}</p>
      ) : null}

      {noCheckpoint ? (
        <EmptyState compact title="No checkpoint for this turn" body={noCheckpoint} />
      ) : diff.state === 'error' ? (
        <EmptyState compact tone="error" title="Could not read the changes" body={diff.message}
          action={<Button size="sm" variant="subtle" onClick={refresh}>Try again</Button>} />
      ) : diff.state !== 'ready' ? (
        <div className={review.skeleton}><SkeletonLine /><SkeletonLine /></div>
      ) : files.length === 0 ? (
        <EmptyState compact title="No changes" body={view === 'turn' ? 'This turn did not change any files.' : 'The files match the checkpoint.'} />
      ) : (
        <div className={`${review.body} ${styles.body}`}>
          <nav className={review.files} aria-label="Changed files">
            <ul ref={listRef} className={review.fileList} role="listbox" aria-label="Changed files" tabIndex={0} onKeyDown={onListKey}
              aria-activedescendant={file ? `cf-${cssId(file)}` : undefined}>
              {groups.map((g) => (
                <li key={g.dir || '.'} role="presentation" className={review.group}>
                  {g.dir ? <span className={review.dir} aria-hidden="true" title={g.dir}>{g.dir}</span> : null}
                  <ul role="presentation" className={review.groupFiles}>
                    {g.files.map((f) => (
                      <li
                        key={f.path}
                        id={`cf-${cssId(f.path)}`}
                        role="option"
                        aria-selected={f.path === file}
                        data-path={f.path}
                        data-status={f.status}
                        data-accepted={f.accepted ? 'true' : undefined}
                        className={review.file}
                        onClick={() => setFile(f.path)}
                        aria-label={`${f.path}, ${STATUS_WORD[f.status]}, ${f.additions} added, ${f.deletions} removed${f.editedAfterTurn ? ', edited after the agent' : ''}${f.accepted ? ', accepted' : ''}`}
                      >
                        <span className={review.fileStatus} aria-hidden="true">{f.status}</span>
                        <span className={review.fileName} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>{f.name}</span>
                        {f.editedAfterTurn ? <span className={styles.badge} title="Edited after the agent's turn">edited</span> : null}
                        {!f.captured ? <span className={styles.badge} title="Too large to checkpoint">not captured</span> : null}
                        <span className={review.fileCounts} aria-hidden="true">
                          {f.binary ? 'bin' : <><span className={review.add}>+{f.additions}</span> <span className={review.del}>−{f.deletions}</span></>}
                        </span>
                        {actionable && f.captured ? (
                          <span className={styles.fileActions}>
                            {!f.accepted ? (
                              <button type="button" className={styles.iconAction} disabled={busy !== null}
                                onClick={(e) => { e.stopPropagation(); void reviewAction({ file: f.path }, 'accept'); }}
                                aria-label={`Accept ${f.path}`} title="Accept (mark reviewed)"><IconCheck /></button>
                            ) : null}
                            <button type="button" className={styles.iconAction} data-tone="danger" data-armed={armed === f.path ? 'true' : undefined}
                              disabled={busy !== null}
                              onClick={(e) => { e.stopPropagation(); rejectFile(f.path); }}
                              aria-label={armed === f.path ? `Confirm: restore ${f.path} from the checkpoint` : `Reject ${f.path} (restore it from the checkpoint)`}
                              title={armed === f.path ? 'Click again to restore this file from the checkpoint' : 'Reject (restore from the checkpoint)'}>
                              {armed === f.path ? 'Restore?' : <IconX />}
                            </button>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>
          <div className={review.patchArea}>
            {selected ? (
              <p className={review.patchPath}>
                <code>{selected.oldPath && selected.oldPath !== selected.path ? `${selected.oldPath} → ${selected.path}` : selected.path}</code>
                <span className={review.muted}> · {STATUS_WORD[selected.status]}</span>
              </p>
            ) : null}
            {patch.state === 'error' ? (
              <p className={review.patchError} role="alert">{patch.message}</p>
            ) : patch.state !== 'ready' || !patchData ? (
              <div className={review.skeleton}><SkeletonLine /><SkeletonLine /><SkeletonLine /></div>
            ) : !selected?.captured ? (
              <p className={review.patchNotice}>This file was too large to checkpoint, so there is no diff and it cannot be restored.</p>
            ) : (
              <HunkPatch
                path={patchData.path}
                text={patchData.text}
                truncated={patchData.truncated}
                binary={patchData.binary}
                hunks={patchData.hunks}
                layout={layout}
                actionable={actionable}
                busyHunk={busy && busy.file === patchData.path ? busy.hunk : null}
                onHunk={(hash, decision) => void reviewAction({ file: patchData.path, hunk: hash }, decision)}
              />
            )}
          </div>
        </div>
      )}

      <UndoDialog
        open={undo !== null && undo.preview !== null}
        preview={undo?.preview ?? null}
        turnLabel={undo?.turnLabel ?? ''}
        rootNames={rootNames}
        busy={undo?.busy ?? false}
        error={undo?.error ?? null}
        onClose={() => setUndo(null)}
        onConfirm={(r) => void confirmUndo(r)}
      />
      {gitDialog?.kind === 'commit' ? (
        <CommitDialog
          open
          status={gitDialog.status}
          busy={gitBusy}
          error={gitError}
          onClose={() => setGitDialog(null)}
          onSubmit={(message) =>
            void runGit(`Commit ${gitDialog.status.dirty} changed files on ${gitDialog.status.branch ?? 'this branch'}.`,
              () => git.commit({ root: gitDialog.root, message }),
              (r) => `Committed on ${r.status.branch ?? 'the branch'}.`)
          }
        />
      ) : null}
      {gitDialog?.kind === 'pr' ? (
        <CreatePrDialog
          open
          draft={false}
          status={gitDialog.status}
          busy={gitBusy}
          error={gitError}
          onClose={() => setGitDialog(null)}
          onSubmit={(req) =>
            void runGit(`Push ${gitDialog.status.branch ?? 'this branch'} and open a pull request into ${req.base}.`,
              () => git.openPr({ root: gitDialog.root, title: req.title, base: req.base, ...(req.body.trim() ? { body: req.body } : {}), ...(req.draft ? { draft: true } : {}) }),
              (r) => (r.pr ? `Opened #${r.pr.number}.` : 'Opened the pull request.'))
          }
        />
      ) : null}
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </section>
  );
}

function turnLabelShort(t: VerseCheckpointTurn): string {
  return `turn ${t.index}`;
}

function cssId(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}-${path.length}`;
}
