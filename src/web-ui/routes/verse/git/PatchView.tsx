/**
 * routes/verse/git/PatchView.tsx — one file's patch in the Review pane,
 * unified or split, with line comments (unit C5; SPEC-310C §3 "Diff/Review").
 *
 * Reuses the inbox parser (`parseUnifiedDiff`, `toSplitRows`) and highlighter
 * (`tokenizeLine`) verbatim — the same pieces DiffBlock renders the
 * transcript's inline diffs with — plus `intralineSpans` (chat/line-diff.ts)
 * to emphasise the part of a changed line that changed.
 *
 * KEYBOARD. The patch is ONE tab stop (a grid with an active line, announced
 * through aria-activedescendant — thousands of focusable rows would make Tab
 * useless): ↑ ↓ move a line, PageUp PageDown move twenty, Home End jump,
 * Enter opens a comment on the active line. In the comment box ⌘/Ctrl+Enter
 * saves and Escape cancels, returning focus to the patch. The pointer gets a
 * "+" in the gutter of the hovered line, as on GitHub.
 *
 * A patch the server cut at 256 KB says so, and rows past ROW_LIMIT are
 * behind "Show all" — every row is DOM.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { parseUnifiedDiff, toSplitRows, type DiffLine } from '../../inbox/diff-parser.js';
import { languageForPath, tokenizeLine, type LangFamily } from '../../inbox/highlight.js';
import { intralineSpans } from '../chat/line-diff.js';
import { formatCount, type ReviewComment } from './git-model.js';
import styles from './DiffPane.module.css';

export type PatchLayout = 'unified' | 'split';

/** Rows rendered before "Show all". */
export const ROW_LIMIT = 3_000;
const PAGE = 20;

export interface PatchViewProps {
  path: string;
  text: string;
  truncated: boolean;
  /** Bytes of the whole patch before the cut (for "showing 256 KB of 1.2 MB"). */
  totalBytes: number | null;
  layout: PatchLayout;
  comments: readonly ReviewComment[];
  onAddComment: (c: Omit<ReviewComment, 'id'>) => void;
  onRemoveComment: (id: string) => void;
}

/** One commentable line, in display order. */
interface Anchor {
  key: string;
  line: number;
  side: 'new' | 'old';
}

type UnifiedRow =
  | { kind: 'hunk'; key: string; label: string }
  | { kind: 'line'; key: string; line: DiffLine; anchor: Anchor; emphasis: [number, number] | null };

type SplitRowView =
  | { kind: 'hunk'; key: string; label: string }
  | {
      kind: 'pair';
      key: string;
      left: DiffLine | null;
      right: DiffLine | null;
      anchor: Anchor;
      leftEmphasis: [number, number] | null;
      rightEmphasis: [number, number] | null;
    };

function anchorFor(line: DiffLine, key: string): Anchor {
  if (line.kind === 'del') return { key, line: line.oldLineNo ?? 0, side: 'old' };
  return { key, line: line.newLineNo ?? line.oldLineNo ?? 0, side: 'new' };
}

function hunkLabel(header: string, index: number): string {
  const section = header.replace(/^@@[^@]*@@/, '').trim();
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  const where = m ? `line ${m[2]}` : `hunk ${index + 1}`;
  return section ? `${where} · ${section}` : where;
}

function buildRows(text: string): { unified: UnifiedRow[]; split: SplitRowView[]; notice: string | null; status: string } {
  const parsed = parseUnifiedDiff(text);
  const file = parsed.files[0];
  if (!file) return { unified: [], split: [], notice: null, status: 'modified' };
  const unified: UnifiedRow[] = [];
  const split: SplitRowView[] = [];
  file.hunks.forEach((hunk, h) => {
    const label = hunkLabel(hunk.header, h);
    unified.push({ kind: 'hunk', key: `h${h}`, label });
    split.push({ kind: 'hunk', key: `h${h}`, label });
    // Pair each run of deletions with the run of additions after it, for emphasis in both layouts.
    const pairs = toSplitRows(hunk.lines);
    const emphasisOf = new Map<DiffLine, [number, number] | null>();
    for (const p of pairs) {
      if (p.left && p.right && p.left.kind === 'del' && p.right.kind === 'add') {
        const spans = intralineSpans(p.left.text, p.right.text);
        emphasisOf.set(p.left, spans ? spans.old : null);
        emphasisOf.set(p.right, spans ? spans.new : null);
      }
    }
    hunk.lines.forEach((line, i) => {
      const key = `h${h}l${i}`;
      unified.push({ kind: 'line', key, line, anchor: anchorFor(line, key), emphasis: emphasisOf.get(line) ?? null });
    });
    pairs.forEach((p, i) => {
      const key = `h${h}p${i}`;
      const anchorLine = p.right ?? p.left!;
      split.push({
        kind: 'pair',
        key,
        left: p.left,
        right: p.right,
        anchor: anchorFor(anchorLine, key),
        leftEmphasis: p.left ? emphasisOf.get(p.left) ?? null : null,
        rightEmphasis: p.right ? emphasisOf.get(p.right) ?? null : null,
      });
    });
  });
  return { unified, split, notice: file.unparsedNotice, status: file.status };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function PatchView({ path, text, truncated, totalBytes, layout, comments, onAddComment, onRemoveComment }: PatchViewProps) {
  const lang = languageForPath(path);
  const built = useMemo(() => buildRows(text), [text]);
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<Anchor | null>(null);
  const gridRef = useRef<HTMLTableElement>(null);
  const idBase = useId();

  const rows = layout === 'split' ? built.split : built.unified;
  const limited = !showAll && rows.length > ROW_LIMIT;
  const visible = limited ? rows.slice(0, ROW_LIMIT) : rows;
  /** Indexes (into `visible`) of commentable rows — what the arrow keys walk. */
  const lineIndexes = useMemo(() => visible.flatMap((r, i) => (r.kind === 'hunk' ? [] : [i])), [visible]);

  useEffect(() => {
    setActive(0);
    setEditing(null);
    setShowAll(false);
  }, [text, layout]);

  const activeRowIndex = lineIndexes[Math.min(active, Math.max(0, lineIndexes.length - 1))] ?? -1;
  const activeRow = activeRowIndex >= 0 ? visible[activeRowIndex] : undefined;
  const activeAnchor = activeRow && activeRow.kind !== 'hunk' ? activeRow.anchor : null;
  const cellId = (key: string) => `${idBase}-${key}`;

  useEffect(() => {
    if (activeAnchor === null) return;
    const el = document.getElementById(cellId(activeAnchor.key));
    el?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAnchor?.key]);

  const onKey = (e: ReactKeyboardEvent<HTMLTableElement>) => {
    if (e.target !== e.currentTarget) return;
    const last = lineIndexes.length - 1;
    const go = (n: number) => {
      e.preventDefault();
      setActive(Math.max(0, Math.min(last, n)));
    };
    switch (e.key) {
      case 'ArrowDown': go(active + 1); break;
      case 'ArrowUp': go(active - 1); break;
      case 'PageDown': go(active + PAGE); break;
      case 'PageUp': go(active - PAGE); break;
      case 'Home': go(0); break;
      case 'End': go(last); break;
      case 'Enter':
        if (activeAnchor) {
          e.preventDefault();
          setEditing(activeAnchor);
        }
        break;
      default:
        break;
    }
  };

  const commentsAt = (anchor: Anchor) => comments.filter((c) => c.line === anchor.line && c.side === anchor.side);
  const startComment = (anchor: Anchor, rowIndex: number) => {
    const at = lineIndexes.indexOf(rowIndex);
    if (at >= 0) setActive(at);
    setEditing(anchor);
  };
  const closeEditor = () => {
    setEditing(null);
    gridRef.current?.focus();
  };

  if (built.notice && rows.length === 0) {
    return <p className={styles.patchNotice}>{/binary/i.test(built.notice) ? 'Binary file — no lines to show.' : built.notice}</p>;
  }
  if (rows.length === 0) {
    return (
      <p className={styles.patchNotice}>
        {built.status === 'renamed' ? 'Renamed with no content changes.' : 'No line changes (a mode or permission change).'}
      </p>
    );
  }

  // Both layouts are five columns: two numbers + gutter + marker + code, or number + half + gutter + number + half.
  const colSpan = 5;
  return (
    <div className={styles.patch}>
      {truncated ? (
        <p className={styles.truncated} role="note">
          Showing the first 256 KB{totalBytes ? ` of ${formatBytes(totalBytes)}` : ''}. Open the file in your editor for the rest.
        </p>
      ) : null}
      <table
        ref={gridRef}
        role="grid"
        className={styles.grid}
        data-layout={layout}
        tabIndex={0}
        aria-label={`Changes in ${path}. Arrow keys move between lines; Enter adds a comment.`}
        aria-activedescendant={activeAnchor ? cellId(activeAnchor.key) : undefined}
        aria-rowcount={visible.length}
        onKeyDown={onKey}
      >
        <tbody>
          {visible.map((row, index) => {
            if (row.kind === 'hunk') {
              return (
                <tr key={row.key} className={styles.hunkRow}>
                  <td colSpan={colSpan} className={styles.hunkCell} role="gridcell">
                    {row.label}
                  </td>
                </tr>
              );
            }
            const isActive = index === activeRowIndex;
            // A split row shows two lines; a comment made on either side (in
            // either layout) belongs under it.
            const thread = row.kind === 'pair' && row.left && row.left.kind === 'del' && row.right
              ? [...commentsAt(row.anchor), ...commentsAt(anchorFor(row.left, row.key))]
              : commentsAt(row.anchor);
            const isEditing = editing?.key === row.anchor.key;
            return (
              <FragmentRows key={row.key}>
                {row.kind === 'line' ? (
                  <tr className={styles.lineRow} data-kind={row.line.kind} data-active={isActive ? 'true' : undefined}>
                    <td className={styles.no} aria-hidden="true">{row.line.oldLineNo ?? ''}</td>
                    <td className={styles.no} aria-hidden="true">{row.line.newLineNo ?? ''}</td>
                    <td className={styles.gutter}>
                      <AddButton onClick={() => startComment(row.anchor, index)} line={row.anchor.line} />
                    </td>
                    <td className={styles.marker} aria-hidden="true">
                      {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ''}
                    </td>
                    <td id={cellId(row.key)} role="gridcell" className={styles.code} aria-label={lineLabel(row.line)}>
                      <Code text={row.line.text} lang={lang} emphasis={row.emphasis} kind={row.line.kind} />
                    </td>
                  </tr>
                ) : (
                  <tr className={styles.lineRow} data-kind="pair" data-active={isActive ? 'true' : undefined}>
                    <td className={styles.no} aria-hidden="true">{row.left?.oldLineNo ?? ''}</td>
                    <td className={styles.half} data-kind={row.left?.kind ?? 'empty'}>
                      {row.left ? <Code text={row.left.text} lang={lang} emphasis={row.leftEmphasis} kind={row.left.kind} /> : null}
                    </td>
                    <td className={styles.gutter}>
                      <AddButton onClick={() => startComment(row.anchor, index)} line={row.anchor.line} />
                    </td>
                    <td className={styles.no} aria-hidden="true">{row.right?.newLineNo ?? ''}</td>
                    <td
                      id={cellId(row.key)}
                      role="gridcell"
                      className={styles.half}
                      data-kind={row.right?.kind ?? 'empty'}
                      aria-label={[row.left ? lineLabel(row.left) : null, row.right && row.right !== row.left ? lineLabel(row.right) : null].filter(Boolean).join('; ')}
                    >
                      {row.right ? <Code text={row.right.text} lang={lang} emphasis={row.rightEmphasis} kind={row.right.kind} /> : null}
                    </td>
                  </tr>
                )}
                {thread.length > 0 || isEditing ? (
                  <tr className={styles.threadRow}>
                    <td colSpan={colSpan} role="gridcell">
                      {thread.map((c) => (
                        <div key={c.id} className={styles.comment}>
                          <span className={styles.commentWhere}>
                            {c.side === 'old' ? 'Removed line' : 'Line'} {c.line}
                          </span>
                          <p className={styles.commentText}>{c.note}</p>
                          <button type="button" className={styles.commentRemove} onClick={() => onRemoveComment(c.id)} aria-label={`Remove the comment on line ${c.line}`}>
                            Remove
                          </button>
                        </div>
                      ))}
                      {isEditing ? (
                        <CommentEditor
                          anchor={row.anchor}
                          onCancel={closeEditor}
                          onSave={(note) => {
                            onAddComment({ path, line: row.anchor.line, side: row.anchor.side, note });
                            closeEditor();
                          }}
                        />
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </FragmentRows>
            );
          })}
        </tbody>
      </table>
      {limited ? (
        <button type="button" className={styles.showAll} onClick={() => setShowAll(true)}>
          Show all {formatCount(rows.length)} lines
        </button>
      ) : null}
    </div>
  );
}

function FragmentRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function lineLabel(line: DiffLine): string {
  const n = line.kind === 'del' ? line.oldLineNo : line.newLineNo;
  const what = line.kind === 'add' ? 'added' : line.kind === 'del' ? 'removed' : 'unchanged';
  return `Line ${n ?? '—'}, ${what}: ${line.text}`;
}

function AddButton({ onClick, line }: { onClick: () => void; line: number }) {
  return (
    <button type="button" className={styles.gutterAdd} tabIndex={-1} onClick={onClick} aria-label={`Add a comment on line ${line}`}
      title={`Add a comment on line ${line}`}>
      +
    </button>
  );
}

function Code({ text, lang, emphasis, kind }: { text: string; lang: LangFamily; emphasis: [number, number] | null; kind: DiffLine['kind'] }) {
  const tokens = tokenizeLine(text, lang);
  if (!emphasis || kind === 'context') {
    return (
      <code className={styles.codeText}>
        {tokens.map((t, i) => (
          <span key={i} className={styles[`tok_${t.kind}`]}>{t.text}</span>
        ))}
      </code>
    );
  }
  // Split tokens at the emphasis boundaries so highlighting and emphasis compose.
  const [from, to] = emphasis;
  const parts: Array<{ text: string; kind: string; em: boolean }> = [];
  let at = 0;
  for (const t of tokens) {
    const start = at;
    const end = at + t.text.length;
    const cuts = [start, Math.max(start, Math.min(end, from)), Math.max(start, Math.min(end, to)), end];
    for (let c = 0; c < 3; c++) {
      const a = cuts[c]!;
      const b = cuts[c + 1]!;
      if (b > a) parts.push({ text: text.slice(a, b), kind: t.kind, em: c === 1 });
    }
    at = end;
  }
  return (
    <code className={styles.codeText}>
      {parts.map((p, i) => (
        <span key={i} className={`${styles[`tok_${p.kind}`] ?? ''} ${p.em ? styles.em : ''}`}>{p.text}</span>
      ))}
    </code>
  );
}

function CommentEditor({ anchor, onSave, onCancel }: { anchor: Anchor; onSave: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const save = () => {
    if (note.trim()) onSave(note.trim());
  };
  return (
    <div className={styles.editor}>
      <label htmlFor={id} className={styles.editorLabel}>
        Comment on {anchor.side === 'old' ? 'removed line' : 'line'} {anchor.line}
      </label>
      <textarea
        id={id}
        ref={ref}
        className={styles.editorInput}
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="What should change here?"
        maxLength={4_000}
      />
      <div className={styles.editorActions}>
        <span className={styles.editorHint}>⌘Enter saves · Esc cancels</span>
        <button type="button" className={styles.linkButton} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={styles.saveButton} onClick={save} disabled={!note.trim()}>
          Save comment
        </button>
      </div>
    </div>
  );
}
