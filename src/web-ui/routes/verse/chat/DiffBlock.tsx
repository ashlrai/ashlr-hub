/**
 * routes/verse/chat/DiffBlock.tsx — a file change rendered as a change.
 *
 * The transcript's job here is narrow: ONE file, inside a 720px reading
 * column, inline in a tool card. The inbox `DiffViewer` is the right tool
 * for the other shape — a multi-file patch that wants a file tree and a
 * split toggle — so that component is imported and used verbatim for
 * multi-file diffs rather than reimplemented. The parser
 * (`routes/inbox/diff-parser.ts`) and the highlighter
 * (`routes/inbox/highlight.ts`) are shared by both paths; nothing about
 * either is rewritten here.
 *
 * Honesty (DESIGN §6): an `Edit` payload knows what was replaced but not
 * where it sat, so when `diff.anchored` is false the line-number gutter is
 * hidden and the header says the offsets are not the file's.
 */
import { useMemo, useState } from 'react';
import { DiffViewer } from '../../inbox/DiffViewer.js';
import { parseUnifiedDiff, type DiffFile, type DiffHunk } from '../../inbox/diff-parser.js';
import { languageForPath, tokenizeLine, type LangFamily } from '../../inbox/highlight.js';
import { useDisplayPath } from './path-display.js';
import type { ToolDiff } from './tool-semantics.js';
import styles from './chat.module.css';

/** Beyond this many rendered lines the block collapses to a preview. */
const COLLAPSE_AFTER_LINES = 28;
const PREVIEW_LINES = 18;
/**
 * Hard ceiling on rows materialised from one file's hunks. The text itself is
 * already capped in `readToolFacts`, but a capped diff can still be tens of
 * thousands of lines, and every row here becomes DOM. Past this the block says
 * how many it dropped rather than locking the tab building rows nobody asked to
 * see.
 */
const MAX_ROWS = 4000;

export interface DiffBlockProps {
  diff: ToolDiff;
  /** Falls back to the diff's own path when the payload named none. */
  path?: string | null;
}

export function DiffBlock({ diff, path = null }: DiffBlockProps) {
  const parsed = useMemo(() => parseUnifiedDiff(diff.text), [diff.text]);

  if (parsed.files.length === 0) return null;
  if (diff.multiFile || parsed.files.length > 1) {
    return (
      <div className={styles.diffMulti}>
        <DiffViewer diff={diff.text} proposalKind="tool call" />
      </div>
    );
  }

  const file = parsed.files[0]!;
  return <SingleFileDiff file={file} anchored={diff.anchored} path={path ?? file.displayPath} />;
}

/**
 * What happened to the file, when that is not simply "it was edited".
 *
 * A rename with no hunks is the case that made this necessary: it reached the
 * empty branch below and printed "No line-level changes in this call." under
 * the NEW path alone, telling the operator nothing happened while silently
 * dropping the old location — the one fact that makes a rename legible.
 */
function statusNote(file: DiffFile): string | null {
  switch (file.status) {
    case 'renamed':
      return 'Renamed. The contents did not change, so there are no lines to show.';
    case 'added':
      return 'New file. It was added with no contents to diff against.';
    case 'deleted':
      return 'Deleted. The file is gone, so there are no lines to show.';
    default:
      return null;
  }
}

function SingleFileDiff({ file, anchored, path }: { file: DiffFile; anchored: boolean; path: string }) {
  const [expanded, setExpanded] = useState(false);
  const lang = languageForPath(path);
  const rows = useMemo(() => flatten(file.hunks), [file.hunks]);
  const long = rows.length > COLLAPSE_AFTER_LINES;
  const visible = long && !expanded ? rows.slice(0, PREVIEW_LINES) : rows;
  const hidden = rows.length - visible.length;
  const renamedFrom = file.status === 'renamed' ? file.oldPath : null;
  const note = statusNote(file);
  // Drawn relative to the chat's roots; the full path is the tooltip.
  const show = useDisplayPath();

  return (
    <div className={styles.diff} data-anchored={anchored ? 'true' : 'false'} data-status={file.status}>
      <div className={styles.diffHead}>
        {renamedFrom ? (
          <span className={styles.diffOldPath} title={renamedFrom}>
            {show(renamedFrom)}
            <span className={styles.visuallyHidden}> renamed to</span>
          </span>
        ) : null}
        <span className={styles.diffPath} title={path}>{show(path)}</span>
        {file.status !== 'modified' ? (
          <span className={styles.diffStatus}>{file.status}</span>
        ) : null}
        <span className={styles.diffStats}>
          {file.additions > 0 ? <span className={styles.diffAdd}>+{file.additions}</span> : null}
          {file.deletions > 0 ? <span className={styles.diffDel}>−{file.deletions}</span> : null}
        </span>
      </div>
      {file.unparsedNotice ? <pre className={styles.diffNotice}>{file.unparsedNotice}</pre> : null}
      {rows.length === 0 ? (
        <p className={styles.diffEmpty}>
          {note ?? 'No line-level changes in this call.'}
        </p>
      ) : (
        <>
          <table className={styles.diffTable}>
            <tbody>
              {visible.map((row) =>
                row.kind === 'hunk' ? (
                  <tr key={row.key} className={styles.diffHunkRow}>
                    {anchored ? <td className={styles.diffNo} aria-hidden="true" /> : null}
                    <td className={styles.diffMarker} aria-hidden="true" />
                    <td className={styles.diffHunkHead}>{row.label}</td>
                  </tr>
                ) : (
                  <tr key={row.key} className={styles[`diffRow_${row.line.kind}`]}>
                    {anchored ? (
                      <td className={styles.diffNo}>{row.line.newLineNo ?? row.line.oldLineNo ?? ''}</td>
                    ) : null}
                    <td className={styles.diffMarker} aria-hidden="true">
                      {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ''}
                    </td>
                    <td className={styles.diffText}>
                      <CodeLine text={row.line.text} lang={lang} />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          {long ? (
            <button type="button" className={styles.diffMore} onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}>
              {expanded ? 'Collapse diff' : `Show ${hidden} more line${hidden === 1 ? '' : 's'}`}
            </button>
          ) : null}
        </>
      )}
      {!anchored ? (
        <p className={styles.diffUnanchored}>
          Line numbers are not shown — this tool call reported what it replaced, not where in the file.
        </p>
      ) : null}
    </div>
  );
}

type Row =
  | { kind: 'hunk'; key: string; label: string }
  | { kind: 'line'; key: string; line: DiffHunk['lines'][number] };

/** Hunks into one flat row list, with a separator row between hunks. */
function flatten(hunks: readonly DiffHunk[]): Row[] {
  const rows: Row[] = [];
  let truncated = false;
  hunks.forEach((hunk, h) => {
    if (truncated) return;
    // The `@@ -a,b +c,d @@` arithmetic is noise in a chat column; the free
    // text after it (`edit 2 of 3`, a function name) is the only part worth
    // a row, and a multi-hunk diff needs SOME separator regardless.
    const section = hunk.header.replace(/^@@[^@]*@@/, '').trim();
    if (section || hunks.length > 1) {
      rows.push({ kind: 'hunk', key: `h${h}`, label: section || `hunk ${h + 1}` });
    }
    for (let i = 0; i < hunk.lines.length; i++) {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        rows.push({ kind: 'hunk', key: 'truncated', label: `diff truncated at ${MAX_ROWS} lines` });
        return;
      }
      rows.push({ kind: 'line', key: `h${h}l${i}`, line: hunk.lines[i]! });
    }
  });
  return rows;
}

function CodeLine({ text, lang }: { text: string; lang: LangFamily }) {
  const tokens = tokenizeLine(text, lang);
  return (
    <code className={styles.diffCode}>
      {tokens.map((token, i) => (
        <span key={i} className={styles[`tok_${token.kind}`]}>{token.text}</span>
      ))}
    </code>
  );
}
