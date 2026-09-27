/**
 * routes/verse/changes/HunkPatch.tsx — one file's changes in the Changes pane:
 * unified or side-by-side, syntax-highlighted, with WORD-level emphasis, and
 * an Accept / Reject bar on every hunk.
 *
 * Reuses the inbox parser (`parseUnifiedDiff`, `toSplitRows`) and highlighter
 * (`tokenizeLine`) and the Review pane's table styles, so a change looks the
 * same here, in Review, and in the transcript.
 *
 * Hunks are matched to the server's by position AND header: the server hashes
 * each hunk and a Reject names that hash, so a hunk that moved since the diff
 * was read is refused by the server instead of misapplied.
 *
 * REVIEW COMMENTS (optional `review`): "Comment" on a hunk's bar opens an
 * editor with a line picker (keyboard path); the pointer gets a "+" in the
 * gutter of the hovered line. Threads render under their line (or the hunk
 * bar for a whole-hunk comment); comments whose hunk is no longer in this
 * diff are listed above it, still editable.
 */
import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { VerseCheckpointDecision, VerseCheckpointHunkInfo } from '../../../../core/verse/checkpoint-types.js';
import { parseUnifiedDiff, toSplitRows, type DiffLine } from '../../inbox/diff-parser.js';
import { languageForPath, tokenizeLine, type LangFamily } from '../../inbox/highlight.js';
import { wordDiff, type Span } from './changes-model.js';
import { CommentEditor, ReviewThread, type ThreadActions } from './ReviewThread.js';
import {
  anchorWhere,
  excerptFor,
  groupThreads,
  hunkCore,
  lineAnchor,
  lineKey,
  type CommentAnchor,
  type ReviewComment,
} from './review-comments.js';
import review from '../git/DiffPane.module.css';
import styles from './ChangesPanel.module.css';

export type PatchLayout = 'unified' | 'split';

/** Rows rendered before "Show all" (every row is DOM). */
export const HUNK_ROW_LIMIT = 3_000;

export interface HunkPatchProps {
  path: string;
  text: string;
  truncated: boolean;
  binary: boolean;
  hunks: readonly VerseCheckpointHunkInfo[];
  layout: PatchLayout;
  /** Accept/Reject are offered (a `since` view with no turn running). */
  actionable: boolean;
  /** The hunk hash whose action is in flight. */
  busyHunk: string | null;
  onHunk: (hash: string, decision: VerseCheckpointDecision) => void;
  /** Review comments on this file; absent = no commenting. */
  review?: HunkReview;
}

export interface HunkReview {
  /** This file's drafted comments. */
  comments: readonly ReviewComment[];
  onAdd: (anchor: CommentAnchor, body: string) => void;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}

/** An open "new comment" editor: where it is drawn, and what it is anchored to. */
type Composer =
  /** From the hunk bar or a gutter "+": the line is picked (null = the whole hunk). */
  | { kind: 'new'; hunk: string; at: string; index: number | null }
  /** "Add a comment" under a thread: the thread's own anchor. */
  | { kind: 'reply'; at: string; anchor: CommentAnchor };

interface HunkView {
  key: string;
  label: string;
  /** Header core, the comment anchor. */
  core: string;
  lines: DiffLine[];
  info: VerseCheckpointHunkInfo | null;
  unified: Array<{ key: string; line: DiffLine; spans: Span[] }>;
  split: Array<{ key: string; left: DiffLine | null; right: DiffLine | null; leftSpans: Span[]; rightSpans: Span[] }>;
}

const HEADER_CORE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

function hunkLabel(header: string, index: number): string {
  const section = header.replace(/^@@[^@]*@@/, '').trim();
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  const where = m ? `Line ${m[2]}` : `Hunk ${index + 1}`;
  return section ? `${where} · ${section}` : where;
}

function build(text: string, infos: readonly VerseCheckpointHunkInfo[]): { hunks: HunkView[]; notice: string | null; status: string } {
  const file = parseUnifiedDiff(text).files[0];
  if (!file) return { hunks: [], notice: null, status: 'modified' };
  const hunks = file.hunks.map((hunk, h): HunkView => {
    const candidate = infos[h];
    const core = HEADER_CORE.exec(hunk.header)?.[0];
    const info = candidate && core && candidate.header.startsWith(core) ? candidate : null;
    const pairs = toSplitRows(hunk.lines);
    const spansOf = new Map<DiffLine, Span[]>();
    for (const p of pairs) {
      if (p.left && p.right && p.left.kind === 'del' && p.right.kind === 'add') {
        const w = wordDiff(p.left.text, p.right.text);
        if (w) {
          spansOf.set(p.left, w.old);
          spansOf.set(p.right, w.new);
        }
      }
    }
    return {
      key: `h${h}`,
      label: hunkLabel(hunk.header, h),
      core: hunkCore(hunk.header),
      lines: hunk.lines,
      info,
      unified: hunk.lines.map((line, i) => ({ key: `h${h}l${i}`, line, spans: spansOf.get(line) ?? [] })),
      split: pairs.map((p, i) => ({
        key: `h${h}p${i}`,
        left: p.left,
        right: p.right,
        leftSpans: p.left ? spansOf.get(p.left) ?? [] : [],
        rightSpans: p.right ? spansOf.get(p.right) ?? [] : [],
      })),
    };
  });
  return { hunks, notice: file.unparsedNotice, status: file.status };
}

export function HunkPatch({ path, text, truncated, binary, hunks, layout, actionable, busyHunk, onHunk, review: commenting }: HunkPatchProps) {
  const lang = languageForPath(path);
  const built = useMemo(() => build(text, hunks), [text, hunks]);
  const [showAll, setShowAll] = useState(false);
  const [composer, setComposer] = useState<Composer | null>(null);
  const pickerId = useId();

  // A new layout or a new diff redraws every row: an open editor would point nowhere.
  useEffect(() => setComposer(null), [layout, text]);

  /** Where each thread is drawn: under its line's row, else its hunk's bar; else above the grid (its hunk is gone). */
  const placed = useMemo(() => {
    const at = new Map<string, ReviewComment[][]>();
    const orphans: ReviewComment[][] = [];
    if (!commenting) return { at, orphans };
    const byCore = new Map<string, HunkView>();
    for (const h of built.hunks) if (!byCore.has(h.core)) byCore.set(h.core, h);
    for (const thread of groupThreads(commenting.comments)) {
      const head = thread[0]!;
      const hunk = byCore.get(head.hunk);
      if (!hunk) {
        orphans.push(thread);
        continue;
      }
      let loc = barKey(hunk);
      if (head.line !== null) {
        const want = lineKey(head);
        const row = layout === 'split'
          ? hunk.split.find((r) => (r.right && lineKey(lineAnchor(r.right)) === want) || (r.left && lineKey(lineAnchor(r.left)) === want))
          : hunk.unified.find((r) => lineKey(lineAnchor(r.line)) === want);
        if (row) loc = row.key;
      }
      at.set(loc, [...(at.get(loc) ?? []), thread]);
    }
    return { at, orphans };
  }, [built, commenting, layout]);

  if (binary) return <p className={review.patchNotice}>Binary file — accept or reject it as a whole.</p>;
  if (built.hunks.length === 0) {
    if (built.notice) return <p className={review.patchNotice}>{built.notice}</p>;
    return (
      <p className={review.patchNotice}>
        {built.status === 'renamed' ? 'Renamed with no content changes.' : 'No line changes (a mode or permission change).'}
      </p>
    );
  }

  let budget = showAll ? Number.POSITIVE_INFINITY : HUNK_ROW_LIMIT;
  let cut = false;
  const totalRows = built.hunks.reduce((n, h) => n + (layout === 'split' ? h.split.length : h.unified.length), 0);

  const close = () => setComposer(null);
  const startAt = (hunk: HunkView, at: string, index: number | null) => setComposer({ kind: 'new', hunk: hunk.key, at, index });

  const actionsAt = (loc: string): ThreadActions | null => (commenting
    ? {
      onEdit: commenting.onEdit,
      onDelete: commenting.onDelete,
      onReply: (head) => setComposer({ kind: 'reply', at: loc, anchor: anchorOf(head) }),
    }
    : null);

  const editorAt = (hunk: HunkView, loc: string): ReactNode => {
    if (!commenting || !composer || composer.at !== loc) return null;
    if (composer.kind === 'reply') {
      const anchor = composer.anchor;
      return (
        <CommentEditor
          label={`Another comment on ${anchorWhere(anchor).toLowerCase()} of ${path}`}
          submitLabel="Add comment"
          onCancel={close}
          onSave={(body) => {
            commenting.onAdd(anchor, body);
            close();
          }}
        />
      );
    }
    if (composer.hunk !== hunk.key) return null;
    const index = composer.index;
    const line = index === null ? null : hunk.lines[index] ?? null;
    const anchor = line ? lineAnchor(line) : { line: null, side: 'new' as const };
    const where = anchorWhere({ hunk: hunk.core, ...anchor });
    const picker = (
      <div className={styles.picker}>
        <label htmlFor={pickerId} className={review.editorLabel}>Anchor</label>
        <select
          id={pickerId}
          className={styles.select}
          value={line ? String(index) : ''}
          onChange={(e) => setComposer({ ...composer, index: e.target.value === '' ? null : Number(e.target.value) })}
        >
          <option value="">Whole change · {anchorWhere({ hunk: hunk.core, line: null, side: 'new' })}</option>
          {hunk.lines.map((l, i) => {
            const a = lineAnchor(l);
            if (a.line === null) return null;
            return (
              <option key={i} value={i}>
                {anchorWhere({ hunk: hunk.core, ...a })}: {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}{l.text.trim().slice(0, 60)}
              </option>
            );
          })}
        </select>
      </div>
    );
    return (
      <CommentEditor
        label={`Comment on ${where.toLowerCase()} of ${path}`}
        submitLabel="Add comment"
        picker={picker}
        onCancel={close}
        onSave={(body) => {
          commenting.onAdd({ path, hunk: hunk.core, line: anchor.line, side: anchor.side, ...excerptFor(hunk.lines, line ? index : null) }, body);
          close();
        }}
      />
    );
  };

  /** The row under a line (or a hunk bar) holding its threads and any open editor. */
  const threadRow = (hunk: HunkView, loc: string): ReactNode => {
    const actions = actionsAt(loc);
    if (!actions) return null;
    const threads = placed.at.get(loc) ?? [];
    const editor = editorAt(hunk, loc);
    if (threads.length === 0 && !editor) return null;
    return (
      <tr className={review.threadRow}>
        <td colSpan={5}>
          {threads.map((t) => (
            <ReviewThread
              key={t[0]!.id}
              path={path}
              comments={t}
              actions={actions}
              replying={composer?.kind === 'reply' && composer.at === loc && sameAnchor(composer.anchor, t[0]!)}
            />
          ))}
          {editor}
        </td>
      </tr>
    );
  };

  const gutter = (hunk: HunkView, rowKey: string, line: DiffLine | null): ReactNode => {
    const a = line ? lineAnchor(line) : null;
    if (!commenting || !line || !a || a.line === null) return <td className={review.gutter} aria-hidden="true" />;
    const where = anchorWhere({ hunk: hunk.core, ...a }).toLowerCase();
    return (
      <td className={review.gutter}>
        {/* The pointer's path. One tab stop per line would bury the keyboard; the hunk bar's Comment is its path. */}
        <button
          type="button"
          className={review.gutterAdd}
          tabIndex={-1}
          onClick={() => startAt(hunk, rowKey, hunk.lines.indexOf(line))}
          aria-label={`Comment on ${where} of ${path}`}
          title={`Comment on ${where}`}
        >
          +
        </button>
      </td>
    );
  };

  const orphanActions = actionsAt('orphans');
  return (
    <div className={review.patch}>
      {truncated ? (
        <p className={review.truncated} role="note">
          Showing the first 256 KB of this file’s changes. Reject it as a whole, or open it in your editor for the rest.
        </p>
      ) : null}
      {orphanActions && placed.orphans.length > 0 ? (
        <div className={styles.orphans}>
          <p className={styles.orphansTitle}>Comments on changes no longer in this diff</p>
          {placed.orphans.map((t) => (
            <ReviewThread key={t[0]!.id} path={path} comments={t} actions={orphanActions} replying />
          ))}
        </div>
      ) : null}
      <table className={review.grid} data-layout={layout} aria-label={`Changes in ${path}`}>
        {built.hunks.map((hunk) => {
          if (budget <= 0) {
            cut = true;
            return null;
          }
          const rows = layout === 'split' ? hunk.split : hunk.unified;
          const shown = rows.slice(0, Math.max(0, budget));
          budget -= shown.length;
          if (shown.length < rows.length) cut = true;
          const accepted = hunk.info?.accepted ?? false;
          const busy = hunk.info !== null && busyHunk === hunk.info.hash;
          return (
            <tbody key={hunk.key} className={styles.hunk} data-accepted={accepted ? 'true' : undefined}>
              <tr className={review.hunkRow}>
                <td colSpan={5}>
                  <div className={styles.hunkBar}>
                    <span className={styles.hunkLabel}>{hunk.label}</span>
                    {accepted ? <span className={styles.reviewed}>Accepted</span> : null}
                    {commenting ? (
                      <button
                        type="button"
                        className={styles.hunkButton}
                        onClick={() => startAt(hunk, barKey(hunk), null)}
                        aria-label={`Comment on the change at ${hunk.label} in ${path}`}
                      >
                        Comment
                      </button>
                    ) : null}
                    {actionable && hunk.info ? (
                      <span className={styles.hunkActions}>
                        {!accepted ? (
                          <button
                            type="button"
                            className={styles.hunkButton}
                            disabled={busyHunk !== null}
                            onClick={() => onHunk(hunk.info!.hash, 'accept')}
                            aria-label={`Accept the change at ${hunk.label} in ${path}`}
                          >
                            Accept
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={styles.hunkButton}
                          data-tone="danger"
                          disabled={busyHunk !== null}
                          aria-busy={busy || undefined}
                          onClick={() => onHunk(hunk.info!.hash, 'reject')}
                          aria-label={`Reject the change at ${hunk.label} in ${path} (restore it from the checkpoint)`}
                        >
                          {busy ? 'Restoring…' : 'Reject'}
                        </button>
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
              {threadRow(hunk, barKey(hunk))}
              {layout === 'unified'
                ? (shown as HunkView['unified']).map((row) => (
                  <Fragment key={row.key}>
                    <tr className={review.lineRow} data-kind={row.line.kind}>
                      <td className={review.no} aria-hidden="true">{row.line.oldLineNo ?? ''}</td>
                      <td className={review.no} aria-hidden="true">{row.line.newLineNo ?? ''}</td>
                      {gutter(hunk, row.key, row.line)}
                      <td className={review.marker} aria-hidden="true">
                        {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ''}
                      </td>
                      <td className={review.code} aria-label={lineLabel(row.line)}>
                        <Code text={row.line.text} lang={lang} spans={row.line.kind === 'context' ? [] : row.spans} />
                      </td>
                    </tr>
                    {threadRow(hunk, row.key)}
                  </Fragment>
                ))
                : (shown as HunkView['split']).map((row) => (
                  <Fragment key={row.key}>
                    <tr className={review.lineRow} data-kind="pair">
                      <td className={review.no} aria-hidden="true">{row.left?.oldLineNo ?? ''}</td>
                      <td className={review.half} data-kind={row.left?.kind ?? 'empty'} aria-label={row.left ? lineLabel(row.left) : undefined}>
                        {row.left ? <Code text={row.left.text} lang={lang} spans={row.left.kind === 'context' ? [] : row.leftSpans} /> : null}
                      </td>
                      {gutter(hunk, row.key, row.right ?? row.left)}
                      <td className={review.no} aria-hidden="true">{row.right?.newLineNo ?? ''}</td>
                      <td className={review.half} data-kind={row.right?.kind ?? 'empty'} aria-label={row.right && row.right !== row.left ? lineLabel(row.right) : undefined}>
                        {row.right ? <Code text={row.right.text} lang={lang} spans={row.right.kind === 'context' ? [] : row.rightSpans} /> : null}
                      </td>
                    </tr>
                    {threadRow(hunk, row.key)}
                  </Fragment>
                ))}
            </tbody>
          );
        })}
      </table>
      {cut ? (
        <button type="button" className={review.showAll} onClick={() => setShowAll(true)}>
          Show all {totalRows.toLocaleString('en-US')} lines
        </button>
      ) : null}
    </div>
  );
}

function barKey(hunk: HunkView): string {
  return `${hunk.key}:bar`;
}

function anchorOf(c: CommentAnchor): CommentAnchor {
  return { path: c.path, hunk: c.hunk, line: c.line, side: c.side, excerpt: c.excerpt, excerptAt: c.excerptAt };
}

function sameAnchor(a: CommentAnchor, b: CommentAnchor): boolean {
  return a.path === b.path && a.hunk === b.hunk && lineKey(a) === lineKey(b);
}

function lineLabel(line: DiffLine): string {
  const n = line.kind === 'del' ? line.oldLineNo : line.newLineNo;
  const what = line.kind === 'add' ? 'added' : line.kind === 'del' ? 'removed' : 'unchanged';
  return `Line ${n ?? '—'}, ${what}: ${line.text}`;
}

/** Highlighted tokens, cut at the word-diff spans so highlighting and emphasis compose. */
function Code({ text, lang, spans }: { text: string; lang: LangFamily; spans: readonly Span[] }) {
  const tokens = tokenizeLine(text, lang);
  if (spans.length === 0) {
    return (
      <code className={review.codeText}>
        {tokens.map((t, i) => (
          <span key={i} className={review[`tok_${t.kind}`]}>{t.text}</span>
        ))}
      </code>
    );
  }
  const inSpan = (at: number) => spans.some(([a, b]) => at >= a && at < b);
  const cuts = new Set<number>([0, text.length]);
  for (const [a, b] of spans) {
    cuts.add(a);
    cuts.add(b);
  }
  const parts: Array<{ text: string; kind: string; em: boolean }> = [];
  let at = 0;
  for (const t of tokens) {
    const start = at;
    const end = at + t.text.length;
    const points = [start, ...[...cuts].filter((c) => c > start && c < end).sort((x, y) => x - y), end];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      if (b > a) parts.push({ text: text.slice(a, b), kind: t.kind, em: inSpan(a) });
    }
    at = end;
  }
  return (
    <code className={review.codeText}>
      {parts.map((p, i) => (
        <span key={i} className={`${review[`tok_${p.kind}`] ?? ''} ${p.em ? review.em : ''}`} data-em={p.em ? 'true' : undefined}>{p.text}</span>
      ))}
    </code>
  );
}
