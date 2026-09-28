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
 * REVIEW COMMENTS. Comment on a hunk or a line (HunkPatch + ReviewThread);
 * drafts persist per chat + turn (review-comments.ts). "Send N comments" is
 * ONE turn to this chat's own seat with `path:line — comment` anchors and
 * short excerpts; "Re-review with…" asks ANOTHER seat for a read-only review
 * of the diff (plus the drafts as context) in a new, linked chat. Both go
 * through ask-seat.ts, so the spend chokepoint, readiness gate and mutation
 * token apply exactly as to a typed message.
 *
 * Self-contained: it needs only the chat id (sending needs the chat record
 * and seats too). register.ts registers it with the pane registry (⇧⌘D)
 * through ChangesPaneHost.
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
import type { VerseSeat, VerseSession } from '../../../data/api-types.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { askableSeats, askSeat, type AskSeatResult } from '../multimodel/ask-seat.js';
import { DEFAULT_FLOW_API, type FlowTarget } from '../multimodel/multimodel-flows.js';
import type { ThreadRelation } from '../../../../core/verse/multimodel/types.js';
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
import { HunkPatch, type HunkReview, type PatchLayout } from './HunkPatch.js';
import { ReReviewMenu } from './ReReviewMenu.js';
import {
  MESSAGE_MAX_BYTES,
  anchorLabel,
  buildCommentsMessage,
  buildReReviewMessage,
  loadComments,
  newCommentId,
  saveComments,
  sortComments,
  utf8Bytes,
  type CommentAnchor,
  type ReviewComment,
  type ReviewFilePatch,
} from './review-comments.js';
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
  /** The chat's record — needed to send review comments (its seat, folders, title). */
  session?: VerseSession | null;
  /** The bootstrap's seats: labels, and the "Re-review with…" menu. */
  seats?: readonly VerseSeat[];
  /** Open another chat (the reviewer's) — PaneHost.openSession. */
  onOpenSession?: (sessionId: string) => void;
  /** Test seam: sends a message to a seat (default: ask-seat.ts over the real session calls). */
  ask?: AskFn;
}

export type AskFn = (input: { source: VerseSession; target: FlowTarget; text: string; title?: string; relation?: ThreadRelation }) => Promise<AskSeatResult>;

const defaultAsk: AskFn = (input) => askSeat(DEFAULT_FLOW_API, input);

const NO_SEATS: readonly VerseSeat[] = [];
const NO_COMMENTS: readonly ReviewComment[] = [];
/** Files fetched for one "Re-review with…" before the rest are only named. */
const REVIEW_MAX_FILES = 60;

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

export function ChangesPanel({
  sessionId,
  visible = true,
  client = checkpointClient,
  git = DEFAULT_GIT,
  pollMs = 3_000,
  session = null,
  seats = NO_SEATS,
  onOpenSession,
  ask = defaultAsk,
}: ChangesPanelProps) {
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
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error'; open?: { sessionId: string; label: string } } | null>(null);
  /** Drafted review comments, tagged with the turn they belong to (loaded from storage on a turn change). */
  const [drafts, setDrafts] = useState<{ turnId: string | null; list: readonly ReviewComment[] }>({ turnId: null, list: NO_COMMENTS });
  const [sending, setSending] = useState<'comments' | 'review' | null>(null);
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

  // ---- review comments -----------------------------------------------------------

  useEffect(() => {
    if (turnId === null || drafts.turnId === turnId) return;
    setDrafts({ turnId, list: loadComments(sessionId, turnId) });
  }, [sessionId, turnId, drafts.turnId]);

  const comments = turnId !== null && drafts.turnId === turnId ? drafts.list : NO_COMMENTS;

  /**
   * Change the drafts of turn `t` — the one on screen or, after a send that
   * outlived a turn switch, the one that was: its stored list is edited then.
   */
  const updateDrafts = useCallback((t: string, fn: (list: readonly ReviewComment[]) => readonly ReviewComment[]) => {
    setDrafts((prev) => {
      const base = prev.turnId === t ? prev.list : loadComments(sessionId, t);
      const next = fn(base);
      // A refused write (private window, full quota) only loses persistence.
      saveComments(sessionId, t, next);
      return prev.turnId === t ? { turnId: t, list: next } : prev;
    });
  }, [sessionId]);

  const hunkReview = (path: string): HunkReview | undefined => {
    if (turnId === null) return undefined;
    const t = turnId;
    return {
      comments: comments.filter((c) => c.path === path),
      onAdd: (anchor: CommentAnchor, body: string) =>
        updateDrafts(t, (list) => [...list, { ...anchor, id: newCommentId(), body, at: new Date().toISOString() }]),
      onEdit: (id, body) => updateDrafts(t, (list) => list.map((c) => (c.id === id ? { ...c, body } : c))),
      onDelete: (id) => updateDrafts(t, (list) => list.filter((c) => c.id !== id)),
    };
  };

  const ownLabel = (session ? seats.find((s) => s.id === session.seatId)?.label : null) ?? 'this chat’s agent';
  const reviewers = useMemo(
    () => (session ? askableSeats(seats).filter((s) => s.seatId !== session.seatId) : []),
    [seats, session],
  );

  const sendComments = async () => {
    if (!session || turnId === null || comments.length === 0) return;
    const t = turnId;
    const built = buildCommentsMessage(comments, { turnLabel: turn ? turnLabelShort(turn) : 'the last turn' });
    if (built.included.length === 0) {
      say('These comments are too long to send in one message. Shorten them and send again.', 'error');
      return;
    }
    // The chat's own seat: a turn cannot change seats, so this is the next turn of this chat.
    const target: FlowTarget = { seatId: session.seatId, model: session.model || null, label: ownLabel, engine: session.engine };
    const n = built.included.length;
    setSending('comments');
    setNotice(null);
    try {
      const result = await gate.run(
        `Send ${plural(n, 'review comment')} to ${ownLabel} as the next turn in this chat.`,
        () => ask({ source: session, target, text: built.text }),
      );
      if (result === null) return;
      const sent = new Set(built.included);
      updateDrafts(t, (list) => list.filter((c) => !sent.has(c.id)));
      say(built.omitted > 0
        ? `Sent ${plural(n, 'comment')} to ${ownLabel}. ${plural(built.omitted, 'comment')} did not fit in one message and ${built.omitted === 1 ? 'is' : 'are'} still drafted — send again for the rest.`
        : `Sent ${plural(n, 'comment')} to ${ownLabel}.`);
      refresh();
    } catch (err) {
      say(describeContextError(err), 'error');
    } finally {
      setSending(null);
    }
  };

  const reReview = async (target: FlowTarget) => {
    if (!session || !baseTurn || !rootId || diff.state !== 'ready') return;
    const scope = view === 'turn'
      ? turnLabelShort(baseTurn)
      : view === 'all' ? 'everything this chat changed' : `everything since before ${turnLabelShort(baseTurn)}`;
    setSending('review');
    setNotice(null);
    // The diff, file by file in list order, until the message budget is spent;
    // the rest are only named (the reviewer is on the same folders).
    const patches: ReviewFilePatch[] = [];
    const unshown: string[] = [];
    try {
      let bytes = 0;
      const byPath = new Map(files.map((f) => [f.path, f]));
      for (const path of flat) {
        const f = byPath.get(path);
        if (!f) continue;
        if (f.binary || !f.captured || bytes > MESSAGE_MAX_BYTES || patches.length >= REVIEW_MAX_FILES) {
          unshown.push(path);
          continue;
        }
        const cached = patch.state === 'ready' && patch.data.patch?.path === path ? patch.data.patch : null;
        const p = cached ?? (await client.diff({ chatId: sessionId, turnId: baseTurn.turnId, rootId, mode, file: path })).patch;
        if (!p || p.binary || !p.text.trim()) {
          unshown.push(path);
          continue;
        }
        patches.push({ path, text: p.text });
        bytes += utf8Bytes(p.text);
      }
    } catch (err) {
      say(describeCheckpointError(err), 'error');
      setSending(null);
      return;
    }
    const built = buildReReviewMessage({ authorLabel: ownLabel, scopeLabel: scope, patches, unshown, totals: totals(files), comments });
    try {
      const title = `Review · ${session.title.trim().slice(0, 80) || scope}`;
      const result = await gate.run(
        `Ask ${target.label} for a read-only review of ${scope}, in a new chat on the same folders.`,
        () => ask({ source: session, target, text: built.text, relation: 'review', title }),
      );
      if (result === null) return;
      const partial = built.shownFiles < files.length ? ` (${plural(built.shownFiles, 'file')} of ${files.length} in the message; it can read the rest)` : '';
      setNotice({
        text: `Asked ${result.label} to review ${scope} in a new chat${partial}.`,
        tone: 'ok',
        open: { sessionId: result.sessionId, label: result.label },
      });
    } catch (err) {
      say(describeContextError(err), 'error');
    } finally {
      setSending(null);
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
          {session ? (
            <ReReviewMenu
              seats={reviewers}
              onPick={(seat) => void reReview(seat)}
              disabled={sending !== null || diff.state !== 'ready' || files.length === 0}
              busy={sending === 'review'}
              disabledReason={reviewers.length === 0 ? 'No other seat is available to review' : files.length === 0 ? 'No changes to review' : undefined}
            />
          ) : null}
        </div>
      </div>

      {running ? (
        <p className={styles.banner} role="status">A turn is running. Changes update when it ends; restoring waits until then.</p>
      ) : null}
      {notice ? (
        <p className={styles.notice} role={notice.tone === 'error' ? 'alert' : 'status'} data-tone={notice.tone}>
          {notice.text}
          {notice.open && onOpenSession ? (
            <>
              {' '}
              <button type="button" className={review.linkButton} onClick={() => onOpenSession(notice.open!.sessionId)}>
                Open {notice.open.label}’s review
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {comments.length > 0 ? (
        <div className={styles.drafts} role="region" aria-label="Draft review comments">
          <details className={styles.draftList}>
            <summary>{plural(comments.length, 'draft comment')}{turn ? ` on ${turnLabelShort(turn)}` : ''}</summary>
            <ul>
              {sortComments(comments).map((c) => (
                <li key={c.id}>
                  <button type="button" className={review.linkButton} disabled={!flat.includes(c.path)}
                    onClick={() => setFile(c.path)} aria-label={`Show ${anchorLabel(c)}`} title={flat.includes(c.path) ? undefined : 'Not in this view'}>
                    <code>{anchorLabel(c)}</code>
                  </button>
                  <span className={styles.draftBody}>{c.body}</span>
                  <button type="button" className={review.linkButton} data-tone="danger"
                    onClick={() => turnId !== null && updateDrafts(turnId, (list) => list.filter((x) => x.id !== c.id))}
                    aria-label={`Delete the comment at ${anchorLabel(c)}`}>Delete</button>
                </li>
              ))}
            </ul>
          </details>
          <Button
            size="sm"
            variant="primary"
            disabled={!session || running || sending !== null}
            busy={sending === 'comments'}
            title={!session ? 'Open the chat to send comments' : running ? 'Wait for the running turn to finish' : `Send them to ${ownLabel} as the next turn`}
            onClick={() => void sendComments()}
          >
            Send {plural(comments.length, 'comment')}
          </Button>
        </div>
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
                review={hunkReview(patchData.path)}
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
