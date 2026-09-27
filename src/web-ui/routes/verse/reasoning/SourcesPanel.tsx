/**
 * routes/verse/reasoning/SourcesPanel.tsx — every source a chat drew on, in
 * one list (V3.15).
 *
 * The per-answer citation lists (chat/SourceList) answer "where did THIS
 * answer come from"; this pane answers "what has this whole chat looked at":
 * files with the line ranges actually seen, pages fetched, searches run, docs
 * and wiki pages, shared memory Verse injected — de-duplicated across turns,
 * numbered in order of first use, each naming the turns that cited it.
 *
 * Two exports:
 *  - `SourcesPanel` — presentational, over already-derived turns (the
 *    transcript's sheet passes its own, so nothing is derived twice);
 *  - the dock pane (dock-panes.tsx `SourcesDockPane`), registered for the
 *    `sources` id by reasoning.pane.tsx.
 */
import { useMemo, useState } from 'react';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import type { VerseSession, VerseSourceKind } from '../../../../core/verse/types.js';
import { formatRanges } from '../../../../core/verse/trace.js';
import { useDisplayPath } from '../chat/path-display.js';
import { fileBasename, fileDirname } from '../chat/tool-semantics.js';
import type { SourceActions } from '../chat/SourceList.js';
import type { TurnBlock } from '../chat/turn-model.js';
import { buildChatSources, injectedSources, type ChatSourceEntry } from './reasoning-model.js';
import styles from './reasoning.module.css';

type Filter = 'all' | 'files' | 'web' | 'docs';

const FILTER_KINDS: Record<Exclude<Filter, 'all'>, readonly VerseSourceKind[]> = {
  files: ['file'],
  web: ['url', 'search'],
  docs: ['doc', 'memory', 'knowledge'],
};

const FILTER_LABEL: Record<Filter, string> = { all: 'All', files: 'Files', web: 'Web', docs: 'Docs & memory' };

const KIND_WORD: Record<VerseSourceKind, string> = {
  file: 'file', url: 'page', search: 'web search', doc: 'doc', memory: 'memory', knowledge: 'knowledge',
};

export interface SourcesPanelProps extends SourceActions {
  turns: readonly TurnBlock[];
  session?: Pick<VerseSession, 'memoryEnabled' | 'projectPath'> | null;
  jumpToTurn: (turnKey: string) => void;
  /** "Cite" a source into the message being written (the dock's `host.addToMessage`). Absent → no Cite action. */
  onCite?: (text: string) => void;
}

export function SourcesPanel({ turns, session = null, openFile, jumpToTool, jumpToTurn, onCite }: SourcesPanelProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const show = useDisplayPath();
  const model = useMemo(() => buildChatSources(turns, injectedSources(session)), [turns, session]);
  const turnIndex = useMemo(() => new Map(turns.map((t, i) => [t.key, i + 1])), [turns]);

  const counts: Record<Filter, number> = {
    all: model.entries.length,
    files: model.byKind.file,
    web: model.byKind.url + model.byKind.search,
    docs: model.byKind.doc + model.byKind.memory + model.byKind.knowledge,
  };
  const needle = query.trim().toLowerCase();
  const visible = model.entries.filter((entry) => {
    if (filter !== 'all' && !FILTER_KINDS[filter].includes(entry.citation.source.kind)) return false;
    if (!needle) return true;
    const s = entry.citation.source;
    return `${s.title} ${s.path ?? ''} ${s.url ?? ''} ${s.query ?? ''}`.toLowerCase().includes(needle);
  });

  if (model.entries.length === 0) {
    return (
      <div className={styles.panel}>
        <EmptyState compact title="No sources yet"
          body="Files the agent reads (with the lines it saw), pages it fetches, searches it runs and docs it consults are listed here as it works — so you can check what an answer rests on." />
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.filters} role="group" aria-label="Show sources of kind">
          {(Object.keys(FILTER_LABEL) as Filter[]).filter((f) => f === 'all' || counts[f] > 0).map((f) => (
            <button key={f} type="button" className={styles.filter} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]} <span className={styles.filterCount}>{counts[f]}</span>
            </button>
          ))}
        </div>
        <input className={styles.search} type="search" value={query} placeholder="Filter sources" aria-label="Filter sources"
          onChange={(e) => setQuery(e.target.value)} />
      </div>
      {visible.length === 0 ? <p className={styles.empty}>No source matches.</p> : (
        <ol className={styles.sourceList}>
          {visible.map((entry) => (
            <SourceRow key={entry.citation.source.ref} entry={entry} show={show} turnIndex={turnIndex}
              openFile={openFile} jumpToTool={jumpToTool} jumpToTurn={jumpToTurn} onCite={onCite} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** What "Cite" puts in the message: `@path:12-40` for a file, the address for a page. Null = nothing citable. */
export function citeText(entry: ChatSourceEntry, show: (path: string) => string): string | null {
  const s = entry.citation.source;
  if (s.url) return s.url;
  if (s.path) return `@${show(s.path)}${entry.citation.ranges.length > 0 ? `:${formatRanges(entry.citation.ranges)}` : ''}`;
  return null;
}

function SourceRow({ entry, show, turnIndex, openFile, jumpToTool, jumpToTurn, onCite }: {
  entry: ChatSourceEntry;
  show: (path: string) => string;
  turnIndex: ReadonlyMap<string, number>;
  jumpToTurn: (turnKey: string) => void;
  onCite?: (text: string) => void;
} & SourceActions) {
  const { citation, turnKeys } = entry;
  const s = citation.source;
  const loc = citation.ranges.length > 0 ? `:${formatRanges(citation.ranges)}` : '';
  const shown = s.path ? show(s.path) : null;
  const firstCall = citation.toolUseIds[0];

  let primary;
  if (s.kind === 'url' && s.url) {
    primary = (
      <a className={styles.sourceMain} href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>
        <span className={styles.sourceName}>{s.title}</span>
        <span className={styles.sourceSub}>{s.domain}</span>
      </a>
    );
  } else if (s.kind === 'search') {
    primary = (
      <button type="button" className={styles.sourceMain} disabled={!firstCall} onClick={() => { if (firstCall) jumpToTool(firstCall); }}>
        <span className={styles.sourceName}>{s.query ?? s.title}</span>
      </button>
    );
  } else if (s.path) {
    const path = s.path;
    primary = (
      <button type="button" className={styles.sourceMain} title={`${path}${loc}`}
        onClick={() => {
          if (openFile) openFile(path, citation.ranges[0]?.start).catch(() => { if (firstCall) jumpToTool(firstCall); });
          else if (firstCall) jumpToTool(firstCall);
        }}>
        <span className={styles.sourceName}>{fileBasename(shown ?? path)}<span className={styles.sourceLoc}>{loc}</span></span>
        <span className={styles.sourceSub}>{fileDirname(shown ?? path)}</span>
      </button>
    );
  } else {
    primary = (
      <span className={styles.sourceMain}>
        <span className={styles.sourceName}>{s.title}</span>
        {s.detail ? <span className={styles.sourceSub}>{s.detail}</span> : null}
      </span>
    );
  }

  const cite = onCite ? citeText(entry, show) : null;
  return (
    <li className={styles.sourceRow} data-kind={s.kind}>
      <span className={styles.sourceNum} aria-hidden="true">{citation.n}</span>
      {primary}
      <span className={styles.sourceKind}>
        {KIND_WORD[s.kind]}{citation.count > 1 ? ` ×${citation.count}` : ''}
        {cite && onCite ? (
          <button type="button" className={styles.cite} onClick={() => onCite(cite)} aria-label={`Cite ${s.title} in your message`}>Cite</button>
        ) : null}
      </span>
      {turnKeys.length > 0 ? (
        <span className={styles.sourceTurns}>
          {turnKeys.slice(0, 4).map((key) => (
            <button key={key} type="button" className={styles.turnChip} onClick={() => jumpToTurn(key)}
              aria-label={`Go to turn ${turnIndex.get(key) ?? ''}`}>
              {`T${turnIndex.get(key) ?? '?'}`}
            </button>
          ))}
          {turnKeys.length > 4 ? <span className={styles.turnMore}>+{turnKeys.length - 4}</span> : null}
        </span>
      ) : null}
    </li>
  );
}
