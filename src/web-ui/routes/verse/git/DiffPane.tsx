/**
 * routes/verse/git/DiffPane.tsx — the dock's Review pane (unit C5; SPEC-310C
 * §3 "Diff/Review"). Mounted by C2 through the `diff-pane` slot with exactly
 * DiffPaneProps.
 *
 *   [repo ▾]  [This turn | Uncommitted | Branch]           [Unified|Split] ⟳
 *   12 files · +340 −20 against main
 *   ┌ file list (M/A/D/R/U + ± per file) ┐
 *   └ patch of the selected file (lazy, ≤ 256 KB) with "+" line comments ┘
 *   2 comments                                       [Add to message]
 *
 * SCOPES
 *   This turn    the files the chat's latest turn touched (C2 derives them
 *                from events), shown with their CURRENT uncommitted diff; a
 *                file the turn touched that has since been committed is listed
 *                as such rather than silently dropped.
 *   Uncommitted  working tree against HEAD, untracked files included.
 *   Branch       everything the branch would ship against its base.
 *
 * PATCHES LOAD LAZILY: the list is one request; a patch is fetched when its
 * file is selected, cached for the life of the listing, and capped by the
 * server at 256 KB. Nothing is fetched while the pane is a background tab
 * (`visible` false) — it catches up when shown.
 *
 * COMMENTS are drafts held here, per file, until "Add to message" hands them
 * to the composer as `path:line: note` lines (C2's onAddToMessage; ⌘Enter in
 * the composer sends). They survive switching files and scopes, not a reload.
 *
 * KEYBOARD: the scope and layout switches are radio groups (← →); the file
 * list is a listbox (↑ ↓ Home End select and load); the patch is a grid (see
 * PatchView). Tab moves between those four stops.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { IconRefresh } from '../../../components/primitives/icons.js';
import type { VerseGitDiffFile, VerseGitDiffScope, VerseReviewScope } from '../../../data/api-types.js';
import type { DiffPaneProps } from '../shell/slots.js';
import {
  FILE_STATUS_WORD,
  commentsToMessage,
  describeGitError,
  diffstatLabel,
  formatCount,
  groupFiles,
  type ReviewComment,
} from './git-model.js';
import { fetchGitDiff, isRootUnavailable, type GitDiffView } from './git-queries.js';
import { PatchView, type PatchLayout } from './PatchView.js';
import styles from './DiffPane.module.css';

export interface DiffPaneTestProps {
  /** Test seam for the diff reads. */
  fetchDiff?: typeof fetchGitDiff;
}

/** Below this pane width the split layout is offered but unified is the default. */
const SPLIT_MIN_WIDTH = 640;

type ListState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; data: GitDiffView; key: string }
  | { state: 'not-a-repo' }
  | { state: 'error'; message: string };

type PatchState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; text: string; truncated: boolean; totalBytes: number | null }
  | { state: 'error'; message: string };

/** One row of the file list: a real change, or a turn file that is no longer uncommitted. */
interface ListEntry {
  file: VerseGitDiffFile;
  /** "This turn" only: the turn touched it, but it has no uncommitted change now. */
  settled: boolean;
}

function rootName(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || root;
}

function serverScope(scope: VerseReviewScope): VerseGitDiffScope {
  return scope === 'branch' ? 'branch' : 'working';
}

export function DiffPane({ roots, request, turnFiles, onAddToMessage, visible, fetchDiff = fetchGitDiff }: DiffPaneProps & DiffPaneTestProps) {
  const [root, setRoot] = useState<string | null>(roots[0] ?? null);
  const [scope, setScope] = useState<VerseReviewScope>('working');
  const [file, setFile] = useState<string | null>(null);
  const [layout, setLayout] = useState<PatchLayout>('unified');
  const [rawList, setList] = useState<ListState>({ state: 'idle' });
  const [patch, setPatch] = useState<PatchState>({ state: 'idle' });
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [announce, setAnnounce] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [wide, setWide] = useState(true);
  const paneRef = useRef<HTMLDivElement>(null);
  const patchCache = useRef(new Map<string, PatchState & { state: 'ready' }>());
  const listRef = useRef<HTMLUListElement>(null);
  const nextCommentId = useRef(1);
  const handledNonce = useRef<number | null>(null);
  const listId = useId();
  const rootId = useId();

  // Keep the chosen root valid as the chat's roots change.
  useEffect(() => {
    if (root === null || !roots.includes(root)) setRoot(roots[0] ?? null);
  }, [roots, root]);

  // An open request from the bar's ± counts, the dock command, or a transcript link.
  useEffect(() => {
    if (!request || handledNonce.current === request.nonce) return;
    handledNonce.current = request.nonce;
    setRoot(request.root);
    setScope(request.scope);
    setFile(request.file ?? null);
  }, [request]);

  // The pane's own width (it lives in a resizable dock), for the split default.
  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWide(w >= SPLIT_MIN_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- the file list ------------------------------------------------------
  useEffect(() => {
    if (!visible || root === null) return;
    const controller = new AbortController();
    const key = `${root}\0${serverScope(scope)}`;
    patchCache.current.clear();
    // A refresh of the SAME listing keeps showing it while it reloads; a new
    // root or scope must not show the previous one's files under its name.
    setList((prev) => (prev.state === 'ready' && prev.key === key ? prev : { state: 'loading' }));
    fetchDiff(root, serverScope(scope), null, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setList({ state: 'ready', data, key });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (isRootUnavailable(err)) setList({ state: 'not-a-repo' });
        else {
          console.warn('[verse] review list failed', err);
          setList({ state: 'error', message: describeGitError(err) });
        }
      });
    return () => controller.abort();
  }, [root, scope, visible, reloadKey, fetchDiff]);

  // The listing as it applies to what is on screen NOW: in the render right
  // after a root or scope switch, the previous listing is still in state and
  // must read as loading, or the selection and patch effects would act on it.
  const currentKey = root === null ? '' : `${root}\0${serverScope(scope)}`;
  const list: ListState = useMemo(
    () => (rawList.state === 'ready' && rawList.key !== currentKey ? { state: 'loading' } : rawList),
    [rawList, currentKey],
  );

  const entries: ListEntry[] = useMemo(() => {
    if (list.state !== 'ready') return [];
    if (scope !== 'turn') return list.data.files.map((f) => ({ file: f, settled: false }));
    const touched = turnFiles.filter((t) => t.root === root).map((t) => t.path);
    const byPath = new Map(list.data.files.map((f) => [f.path, f]));
    return [...new Set(touched)].map((path) => {
      const change = byPath.get(path);
      return change
        ? { file: change, settled: false }
        : { file: { path, oldPath: null, status: 'M' as const, additions: 0, deletions: 0, binary: false }, settled: true };
    });
  }, [list, scope, turnFiles, root]);

  // Grouped exactly as the list draws them, so ↑/↓ and "the first file" follow what is on screen.
  const groups = useMemo(() => groupFiles(entries.map((e) => e.file)), [entries]);
  const selectable = useMemo(() => {
    const byPath = new Map(entries.map((e) => [e.file.path, e]));
    return groups.flatMap((g) => g.files.map((f) => byPath.get(f.path)!)).filter((e) => !e.settled);
  }, [groups, entries]);

  // Keep a valid selection: the requested file, else the first change.
  useEffect(() => {
    if (list.state !== 'ready') return;
    if (file !== null && selectable.some((e) => e.file.path === file)) return;
    setFile(selectable[0]?.file.path ?? null);
  }, [list, selectable, file]);

  // ---- the selected file's patch -------------------------------------------
  useEffect(() => {
    if (!visible || root === null || file === null || list.state !== 'ready') {
      setPatch({ state: 'idle' });
      return;
    }
    const entry = selectable.find((e) => e.file.path === file);
    if (!entry) return;
    const key = `${serverScope(scope)}\0${file}`;
    const hit = patchCache.current.get(key);
    if (hit) {
      setPatch(hit);
      return;
    }
    if (entry.file.binary) {
      setPatch({ state: 'ready', text: '', truncated: false, totalBytes: null });
      return;
    }
    const controller = new AbortController();
    setPatch({ state: 'loading' });
    fetchDiff(root, serverScope(scope), file, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const ready = { state: 'ready' as const, text: data.patch?.text ?? '', truncated: data.patch?.truncated ?? false, totalBytes: data.patchBytes ?? null };
        patchCache.current.set(key, ready);
        setPatch(ready);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn('[verse] review patch failed', err);
        setPatch({ state: 'error', message: describeGitError(err) });
      });
    return () => controller.abort();
  }, [root, scope, file, visible, list, selectable, fetchDiff]);

  // ---- comments ------------------------------------------------------------
  const addComment = useCallback((c: Omit<ReviewComment, 'id'>) => {
    setComments((prev) => [...prev, { ...c, id: `c${nextCommentId.current++}` }]);
    setAnnounce(`Comment added on line ${c.line}.`);
  }, []);
  const removeComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
    setAnnounce('Comment removed.');
  }, []);
  const sendComments = () => {
    if (comments.length === 0) return;
    onAddToMessage(commentsToMessage(comments));
    setAnnounce(`Added ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'} to the message.`);
    setComments([]);
  };

  // ---- file list keyboard (listbox) -----------------------------------------
  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    if (selectable.length === 0) return;
    const at = selectable.findIndex((x) => x.file.path === file);
    let next = at;
    if (e.key === 'ArrowDown') next = Math.min(selectable.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = selectable.length - 1;
    else return;
    e.preventDefault();
    const path = selectable[next]!.file.path;
    setFile(path);
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(path) : path.replace(/["\\]/g, '\\$&');
    listRef.current?.querySelector<HTMLElement>(`[data-path="${escaped}"]`)?.scrollIntoView?.({ block: 'nearest' });
  };

  // ---- render --------------------------------------------------------------
  const turnCount = turnFiles.filter((t) => t.root === root).length;
  const scopeOptions = [
    { value: 'turn' as const, label: 'This turn', disabled: turnCount === 0 },
    { value: 'working' as const, label: 'Uncommitted' },
    { value: 'branch' as const, label: 'Branch' },
  ];
  const layoutOptions = [
    { value: 'unified' as const, label: 'Unified' },
    { value: 'split' as const, label: 'Split' },
  ];
  const effectiveLayout: PatchLayout = layout === 'split' && !wide ? 'unified' : layout;
  const totals = entries.reduce(
    (acc, e) => (e.settled ? acc : { files: acc.files + 1, additions: acc.additions + e.file.additions, deletions: acc.deletions + e.file.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );
  const base = list.state === 'ready' ? list.data.base : null;
  const fileComments = comments.filter((c) => c.path === file);

  if (roots.length === 0 || root === null) {
    return (
      <div className={styles.pane} ref={paneRef}>
        <EmptyState compact title="No folder to review" body="This chat has no project folder." />
      </div>
    );
  }

  return (
    <div className={styles.pane} ref={paneRef} data-wide={wide ? 'true' : 'false'}>
      <header className={styles.head}>
        {roots.length > 1 ? (
          <label className={styles.rootPick}>
            <span className={styles.visuallyHidden}>Repository</span>
            <select id={rootId} value={root} onChange={(e) => { setRoot(e.target.value); setFile(null); }} className={styles.select}>
              {roots.map((r) => (
                <option key={r} value={r}>{rootName(r)}</option>
              ))}
            </select>
          </label>
        ) : (
          <span className={styles.rootName}>{rootName(root)}</span>
        )}
        <Segmented
          aria-label="What to review"
          size="sm"
          options={scopeOptions}
          value={scope}
          onChange={(next) => { setScope(next); setFile(null); }}
        />
        <span className={styles.headSpacer} />
        <Segmented
          aria-label="Diff layout"
          size="sm"
          options={layoutOptions.map((o) => (o.value === 'split' && !wide ? { ...o, disabled: true } : o))}
          value={effectiveLayout}
          onChange={setLayout}
        />
        <button type="button" className={styles.iconButton} onClick={() => setReloadKey((n) => n + 1)} aria-label="Refresh changes" title="Refresh changes">
          <IconRefresh width={14} height={14} aria-hidden="true" />
        </button>
      </header>

      <p className={styles.summary}>
        {list.state === 'ready' ? (
          totals.files === 0 ? (
            <span>{emptySentence(scope, base)}</span>
          ) : (
            <span aria-label={diffstatLabel(totals.files, totals.additions, totals.deletions)}>
              {formatCount(totals.files)} {totals.files === 1 ? 'file' : 'files'} · <span className={styles.add}>+{formatCount(totals.additions)}</span>{' '}
              <span className={styles.del}>{'\u2212'}{formatCount(totals.deletions)}</span>
              {scope === 'branch' && base ? <> against <code className={styles.ref}>{base}</code></> : null}
              {scope === 'working' ? ' uncommitted' : null}
            </span>
          )
        ) : list.state === 'loading' || list.state === 'idle' ? (
          <span className={styles.muted}>Reading changes…</span>
        ) : null}
      </p>

      {list.state === 'not-a-repo' ? (
        <EmptyState compact title="Not a git repository" body={`${rootName(root)} is not tracked by git, so there is nothing to review.`} />
      ) : list.state === 'error' ? (
        <EmptyState compact tone="error" title="Could not read the changes" body={list.message} />
      ) : list.state !== 'ready' ? (
        <div className={styles.skeleton} aria-hidden="true">
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
        </div>
      ) : entries.length === 0 ? null : (
        <div className={styles.body}>
          <nav className={styles.files} aria-label="Changed files">
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Changed files"
              className={styles.fileList}
              tabIndex={0}
              aria-activedescendant={file ? `${listId}-${encodeURIComponent(file)}` : undefined}
              onKeyDown={onListKey}
            >
              {groups.map((group) => (
                <li key={group.dir || '.'} role="presentation" className={styles.group}>
                  {/* RTL truncation keeps the tail of a long path visible; the LRM keeps
                      the trailing slash from being reordered to the front. */}
                  {group.dir ? <span className={styles.dir} role="presentation">{group.dir}/{'\u200E'}</span> : null}
                  <ul role="presentation" className={styles.groupFiles}>
                    {group.files.map((f) => {
                      const settled = entries.find((e) => e.file.path === f.path)?.settled ?? false;
                      const selected = f.path === file;
                      const count = comments.filter((c) => c.path === f.path).length;
                      return (
                        <li
                          key={f.path}
                          id={`${listId}-${encodeURIComponent(f.path)}`}
                          data-path={f.path}
                          role="option"
                          aria-selected={selected}
                          aria-disabled={settled || undefined}
                          className={styles.file}
                          data-status={f.status}
                          onClick={() => { if (!settled) setFile(f.path); }}
                          title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                        >
                          <span className={styles.fileStatus} aria-label={FILE_STATUS_WORD[f.status]}>{f.status}</span>
                          <span className={styles.fileName}>{f.name}</span>
                          {count > 0 ? <span className={styles.fileComments} aria-label={`${count} ${count === 1 ? 'comment' : 'comments'}`}>{count}</span> : null}
                          {settled ? (
                            <span className={styles.fileSettled}>committed</span>
                          ) : f.binary ? (
                            <span className={styles.fileCounts}>binary</span>
                          ) : (
                            <span className={styles.fileCounts}>
                              <span className={styles.add}>+{formatCount(f.additions)}</span> <span className={styles.del}>{'−'}{formatCount(f.deletions)}</span>
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>

          <section className={styles.patchArea} aria-label={file ? `Patch for ${file}` : 'Patch'}>
            {file === null ? (
              <p className={styles.patchNotice}>Choose a file.</p>
            ) : patch.state === 'loading' || patch.state === 'idle' ? (
              <div className={styles.skeleton} aria-hidden="true">
                <SkeletonLine />
                <SkeletonLine />
              </div>
            ) : patch.state === 'error' ? (
              <p className={styles.patchError} role="alert">{patch.message}</p>
            ) : (
              <>
                <h3 className={styles.patchPath} title={file}>{file}</h3>
                {selectable.find((e) => e.file.path === file)?.file.binary ? (
                  <p className={styles.patchNotice}>Binary file — no lines to show.</p>
                ) : (
                  <PatchView
                    path={file}
                    text={patch.text}
                    truncated={patch.truncated}
                    totalBytes={patch.totalBytes}
                    layout={effectiveLayout}
                    comments={fileComments}
                    onAddComment={addComment}
                    onRemoveComment={removeComment}
                  />
                )}
              </>
            )}
          </section>
        </div>
      )}

      {comments.length > 0 ? (
        <footer className={styles.foot}>
          <span className={styles.footCount}>
            {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
            {new Set(comments.map((c) => c.path)).size > 1 ? ` in ${new Set(comments.map((c) => c.path)).size} files` : ''}
          </span>
          <button type="button" className={styles.linkButton} onClick={() => { setComments([]); setAnnounce('Comments discarded.'); }}>
            Discard
          </button>
          <button type="button" className={styles.saveButton} onClick={sendComments}>
            Add to message
          </button>
        </footer>
      ) : null}
      <p className={styles.visuallyHidden} role="status" aria-live="polite">{announce}</p>
    </div>
  );
}

function emptySentence(scope: VerseReviewScope, base: string | null): string {
  if (scope === 'turn') return 'The latest turn changed no files here.';
  if (scope === 'working') return 'No uncommitted changes.';
  return base ? `This branch has no changes against ${base}.` : 'No changes on this branch.';
}
