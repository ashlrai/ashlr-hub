/**
 * routes/verse/chat/SourceList.tsx — what a turn drew on, as numbered
 * citations under the answer (V3.15).
 *
 *   Sources · 4
 *   1  Transcript.tsx:55-120        routes/verse         read ×2
 *   2  Vitest configuration         vitest.dev
 *   3  vitest maxWorkers            web search
 *   4  MEMORY.md                    memory
 *
 * Every row is PROVEN by the log: a file the agent read (with the line range
 * the call or its output states — never a guessed one), a page it fetched, a
 * search it ran, or context the engine / seat reported. Numbered in order of
 * first use, de-duplicated within the turn (core/verse/trace.ts
 * `collateSources`), so the same file read three times is one citation.
 *
 * A file opens in the operator's editor at its first cited line (server-side
 * confinement to the chat's own folders); when that is unavailable — the
 * console is read-only, the file moved — the row falls back to showing the
 * call that read it, which is always possible. A URL is an ordinary link.
 */
import { memo, useState } from 'react';
import { formatRanges, type VerseCitation } from '../../../../core/verse/trace.js';
import { useDisplayPath } from './path-display.js';
import { fileBasename, fileDirname } from './tool-semantics.js';
import styles from './sources.module.css';

/** Beyond this many the list folds behind "Show N more". */
export const SOURCES_COLLAPSE_AFTER = 5;

export interface SourceActions {
  /** Open a file at a line (resolves when opened; rejects when it could not be). */
  openFile?: (path: string, line: number | undefined) => Promise<void>;
  /** Scroll to the tool call that produced a source. */
  jumpToTool: (toolUseId: string) => void;
}

export interface SourceListProps extends SourceActions {
  citations: readonly VerseCitation[];
  /** Heading level context: the per-turn list says "Sources"; a pane may relabel. */
  label?: string;
}

const KIND_WORD: Record<VerseCitation['source']['kind'], string> = {
  file: '',
  doc: 'doc',
  memory: 'memory',
  knowledge: 'knowledge',
  url: '',
  search: 'web search',
};

/** `Transcript.tsx:55-120` — the location half of a citation row. */
export function citationLocation(citation: VerseCitation): string {
  return citation.ranges.length > 0 ? `:${formatRanges(citation.ranges)}` : '';
}

/** The accessible name of a row, in words. */
export function citationSentence(citation: VerseCitation, shownPath: string | null): string {
  const s = citation.source;
  switch (s.kind) {
    case 'url':
      return `Source ${citation.n}: ${s.title}${s.domain ? `, ${s.domain}` : ''} (opens in a new tab)`;
    case 'search':
      return `Source ${citation.n}: web search for ${s.query ?? s.title}`;
    default: {
      const where = citation.ranges.length > 0 ? `, lines ${formatRanges(citation.ranges)}` : '';
      return `Source ${citation.n}: ${KIND_WORD[s.kind] ? `${KIND_WORD[s.kind]} ` : ''}${shownPath ?? s.title}${where}`;
    }
  }
}

/**
 * The live turn rebuilds its citation objects on every streamed token; the
 * list re-renders only when what it SHOWS changed (the same rule the tool
 * cards and activity groups follow).
 */
function sameCitations(a: readonly VerseCitation[], b: readonly VerseCitation[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.source.ref !== y.source.ref || x.count !== y.count || x.source.title !== y.source.title
      || formatRanges(x.ranges) !== formatRanges(y.ranges)) return false;
  }
  return true;
}

export const SourceList = memo(function SourceList({ citations, openFile, jumpToTool, label = 'Sources' }: SourceListProps) {
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const show = useDisplayPath();
  if (citations.length === 0) return null;
  const visible = expanded || citations.length <= SOURCES_COLLAPSE_AFTER ? citations : citations.slice(0, SOURCES_COLLAPSE_AFTER);
  const hidden = citations.length - visible.length;

  function onFile(citation: VerseCitation) {
    const path = citation.source.path ?? citation.source.ref;
    const firstCall = citation.toolUseIds[0];
    const line = citation.ranges[0]?.start;
    if (!openFile) {
      if (firstCall) jumpToTool(firstCall);
      return;
    }
    setNotice(null);
    openFile(path, line).catch(() => {
      // Read-only console, a refused path, a file that moved: the call that
      // read it is still here, so show that instead of failing silently.
      setNotice('Couldn’t open that file in your editor — showing the call that read it.');
      if (firstCall) jumpToTool(firstCall);
    });
  }

  return (
    <section className={styles.sources} aria-label={`${label} for this answer`} data-count={citations.length}>
      <h3 className={styles.head}>
        <span className={styles.headLabel}>{label}</span>
        <span className={styles.headCount}>{citations.length}</span>
      </h3>
      <ol className={styles.list}>
        {visible.map((citation) => {
          const s = citation.source;
          const shownPath = s.path ? show(s.path) : null;
          const sentence = citationSentence(citation, shownPath);
          const kindWord = KIND_WORD[s.kind];
          const times = citation.count > 1 ? <span className={styles.times} aria-hidden="true">×{citation.count}</span> : null;
          if (s.kind === 'url' && s.url) {
            return (
              <li key={s.ref} data-kind={s.kind}>
                <a className={styles.row} href={s.url} target="_blank" rel="noopener noreferrer" aria-label={sentence} title={s.url}>
                  <span className={styles.num} aria-hidden="true">{citation.n}</span>
                  <span className={styles.main}><span className={styles.name}>{s.title}</span></span>
                  <span className={styles.meta} aria-hidden="true">{s.domain}</span>
                  {times}
                </a>
              </li>
            );
          }
          if (s.kind === 'search') {
            const call = citation.toolUseIds[0];
            return (
              <li key={s.ref} data-kind={s.kind}>
                <button type="button" className={styles.row} aria-label={sentence} disabled={!call}
                  onClick={() => { if (call) jumpToTool(call); }} title="Show the search">
                  <span className={styles.num} aria-hidden="true">{citation.n}</span>
                  <span className={styles.main}><span className={styles.name}>{s.query ?? s.title}</span></span>
                  <span className={styles.meta} aria-hidden="true">{kindWord}</span>
                  {times}
                </button>
              </li>
            );
          }
          const display = shownPath ?? s.title;
          return (
            <li key={s.ref} data-kind={s.kind}>
              <button type="button" className={styles.row} aria-label={sentence} onClick={() => onFile(citation)}
                title={`${s.path ?? s.ref}${citationLocation(citation)}${openFile ? ' — open in editor' : ''}`}>
                <span className={styles.num} aria-hidden="true">{citation.n}</span>
                <span className={styles.main}>
                  <span className={styles.name}>{fileBasename(display)}<span className={styles.loc}>{citationLocation(citation)}</span></span>
                  <span className={styles.dir}>{fileDirname(display)}</span>
                </span>
                <span className={styles.meta} aria-hidden="true">{kindWord}</span>
                {times}
              </button>
            </li>
          );
        })}
      </ol>
      {hidden > 0 || expanded ? (
        <button type="button" className={styles.more} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer sources' : `Show ${hidden} more source${hidden === 1 ? '' : 's'}`}
        </button>
      ) : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    </section>
  );
}, (a, b) => a.openFile === b.openFile && a.jumpToTool === b.jumpToTool && a.label === b.label && sameCitations(a.citations, b.citations));
