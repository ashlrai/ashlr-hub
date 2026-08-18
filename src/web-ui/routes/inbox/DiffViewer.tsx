/**
 * routes/inbox/DiffViewer.tsx — the core review interaction (operator-
 * console brief item 2). A multi-file unified diff gets a file tree plus a
 * syntax-highlighted, split/unified-toggleable hunk view instead of one
 * escaped <pre> block (the old UI's approach). No diff/highlighting
 * dependency: diff-parser.ts and highlight.ts are both hand-rolled per the
 * foundation's "keep new runtime deps minimal" constraint — checked
 * package.json first; nothing suitable was already a dependency.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseUnifiedDiff, toSplitRows, type DiffHunk } from './diff-parser.js';
import { languageForPath, tokenizeLine, type LangFamily } from './highlight.js';
import styles from './DiffViewer.module.css';

type ViewMode = 'unified' | 'split';

export function DiffViewer({ diff, proposalKind }: { diff: string | undefined; proposalKind: string }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [selectedId, setSelectedId] = useState<string | null>(parsed.files[0]?.id ?? null);
  const [mode, setMode] = useState<ViewMode>('unified');

  // Diff identity changed (a different proposal is now shown) — reset the
  // selected file rather than holding on to a stale id from the last one.
  useEffect(() => {
    setSelectedId(parsed.files[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on diff content change only
  }, [diff]);

  if (parsed.files.length === 0) {
    return (
      <div className={styles.empty}>No diff attached to this proposal (kind: {proposalKind}).</div>
    );
  }

  const selected = parsed.files.find((f) => f.id === selectedId) ?? parsed.files[0]!;

  function onTreeKeyDown(e: React.KeyboardEvent) {
    const idx = parsed.files.findIndex((f) => f.id === selected.id);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedId(parsed.files[Math.min(idx + 1, parsed.files.length - 1)]!.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedId(parsed.files[Math.max(idx - 1, 0)]!.id);
    }
  }

  return (
    <div className={styles.viewer}>
      {parsed.malformed ? (
        <p className={styles.malformedNotice}>Could not parse this as a unified diff — showing raw content.</p>
      ) : null}
      <div className={styles.tree} role="tree" aria-label="Changed files" onKeyDown={onTreeKeyDown}>
        {parsed.files.map((f) => (
          <button
            key={f.id}
            type="button"
            role="treeitem"
            aria-selected={f.id === selected.id}
            tabIndex={f.id === selected.id ? 0 : -1}
            className={`${styles.treeItem} ${f.id === selected.id ? styles.treeItemActive : ''}`}
            onClick={() => setSelectedId(f.id)}
          >
            <span className={`${styles.statusDot} ${styles[`status_${f.status}`]}`} aria-hidden="true" />
            <span className={styles.treePath} title={f.displayPath}>
              {f.displayPath}
            </span>
            <span className={styles.treeStats}>
              {f.additions > 0 ? <span className={styles.add}>+{f.additions}</span> : null}
              {f.deletions > 0 ? <span className={styles.del}>-{f.deletions}</span> : null}
            </span>
          </button>
        ))}
      </div>

      <div className={styles.body}>
        <div className={styles.fileHeader}>
          <span className={styles.filePath}>{selected.displayPath}</span>
          <div className={styles.modeToggle} role="group" aria-label="Diff view mode">
            <button
              type="button"
              aria-pressed={mode === 'unified'}
              className={mode === 'unified' ? styles.modeActive : ''}
              onClick={() => setMode('unified')}
            >
              Unified
            </button>
            <button
              type="button"
              aria-pressed={mode === 'split'}
              className={mode === 'split' ? styles.modeActive : ''}
              onClick={() => setMode('split')}
            >
              Split
            </button>
          </div>
        </div>
        {selected.unparsedNotice ? <pre className={styles.notice}>{selected.unparsedNotice}</pre> : null}
        {selected.hunks.length === 0 && !selected.unparsedNotice ? (
          <p className={styles.emptyFile}>No line-level changes captured for this file.</p>
        ) : (
          selected.hunks.map((hunk, i) => <Hunk key={i} hunk={hunk} mode={mode} path={selected.displayPath} />)
        )}
      </div>
    </div>
  );
}

function Hunk({ hunk, mode, path }: { hunk: DiffHunk; mode: ViewMode; path: string }) {
  const lang = languageForPath(path);
  if (mode === 'split') {
    const rows = toSplitRows(hunk.lines);
    return (
      <table className={`${styles.hunkTable} ${styles.hunkTableSplit}`}>
        <caption className={styles.hunkCaption}>{hunk.header}</caption>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className={styles.lineNo}>{row.left?.oldLineNo ?? ''}</td>
              <td className={`${styles.lineText} ${row.left ? styles[`row_${row.left.kind}`] : styles.rowBlank}`}>
                {row.left ? <CodeLine text={row.left.text} lang={lang} /> : null}
              </td>
              <td className={styles.lineNo}>{row.right?.newLineNo ?? ''}</td>
              <td className={`${styles.lineText} ${row.right ? styles[`row_${row.right.kind}`] : styles.rowBlank}`}>
                {row.right ? <CodeLine text={row.right.text} lang={lang} /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className={styles.hunkTable}>
      <caption className={styles.hunkCaption}>{hunk.header}</caption>
      <tbody>
        {hunk.lines.map((line, i) => (
          <tr key={i} className={styles[`row_${line.kind}`]}>
            <td className={styles.lineNo}>{line.oldLineNo ?? ''}</td>
            <td className={styles.lineNo}>{line.newLineNo ?? ''}</td>
            <td className={styles.lineMarker} aria-hidden="true">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
            </td>
            <td className={styles.lineText}>
              <CodeLine text={line.text} lang={lang} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CodeLine({ text, lang }: { text: string; lang: LangFamily }): ReactNode {
  const tokens = tokenizeLine(text, lang);
  return (
    <code className={styles.code}>
      {tokens.map((t, i) => (
        <span key={i} className={styles[`tok_${t.kind}`]}>
          {t.text}
        </span>
      ))}
    </code>
  );
}
