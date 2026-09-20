/**
 * routes/verse/chat/TranscriptNav.tsx — making a fifty-turn session
 * navigable.
 *
 * A long agentic session scrolls past the point where scrolling is a way to
 * find anything. This strip gives it three handles: an outline of the turns
 * (with what each one touched), a search over everything in the transcript —
 * prose, tool arguments and tool output alike — and a jump straight to the
 * first failure.
 *
 * It is chrome, so it obeys DESIGN §4: one hairline-bottomed row at
 * `--density-row`, ghost controls only, no filled buttons. It renders only
 * when the session is long enough to need it, so a two-turn chat stays as
 * bare as it is today.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronIcon, SearchIcon } from '../verse-icons.js';
import { turnTitle, type TurnBlock, type TurnMatch } from './turn-model.js';
import styles from './chat.module.css';

export interface TranscriptNavProps {
  turns: readonly TurnBlock[];
  query: string;
  onQuery: (value: string) => void;
  matches: readonly TurnMatch[];
  /** Index into `matches`, or -1 when nothing is selected yet. */
  matchIndex: number;
  onStepMatch: (delta: number) => void;
  errorCount: number;
  onJumpError: () => void;
  onJumpTurn: (turnKey: string) => void;
  /** Focus hand-off: the transcript raises this when ⌘F is pressed. */
  focusToken: number;
}

const STATUS_GLYPH: Record<TurnBlock['status'], string> = {
  running: '•',
  ok: '',
  error: '!',
  stopped: '×',
};

const STATUS_WORD: Record<TurnBlock['status'], string> = {
  running: 'running',
  ok: 'completed',
  error: 'failed',
  stopped: 'stopped',
};

export function TranscriptNav(props: TranscriptNavProps) {
  const { turns, query, onQuery, matches, matchIndex, onStepMatch, errorCount, onJumpError, onJumpTurn, focusToken } = props;
  const [outlineOpen, setOutlineOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const outlineId = useId();
  const searchId = useId();
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (focusToken > 0) {
      search.current?.focus();
      search.current?.select();
    }
  }, [focusToken]);

  // Close the outline on Escape from anywhere inside it.
  useEffect(() => {
    if (!outlineOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOutlineOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [outlineOpen]);

  const listed = searching
    ? turns.filter((turn) => matches.some((m) => m.turnKey === turn.key))
    : turns;
  const snippetFor = (key: string) => matches.find((m) => m.turnKey === key)?.snippet ?? null;

  return (
    <div className={styles.nav}>
      <button type="button" className={styles.navOutlineButton} aria-expanded={outlineOpen}
        aria-controls={outlineOpen ? outlineId : undefined} onClick={() => setOutlineOpen((v) => !v)}>
        <span className={styles.navChevron} data-open={outlineOpen ? 'true' : undefined} aria-hidden="true">
          <ChevronIcon size={12} />
        </span>
        <span className={styles.navCount}>{turns.length}</span>
        <span className={styles.navWord}>turn{turns.length === 1 ? '' : 's'}</span>
      </button>

      <label className={styles.navSearch} htmlFor={searchId}>
        <span className={styles.navSearchIcon} aria-hidden="true"><SearchIcon size={12} /></span>
        <span className="visually-hidden">Search this chat</span>
        <input ref={search} id={searchId} type="search" value={query} placeholder="Find in chat" autoComplete="off"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onStepMatch(event.shiftKey ? -1 : 1);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onQuery('');
            }
          }} />
      </label>

      {searching ? (
        <span className={styles.navMatches} role="status">
          {matches.length === 0
            ? 'no matches'
            : `${matchIndex < 0 ? 1 : matchIndex + 1} of ${matches.length}`}
        </span>
      ) : null}
      {searching && matches.length > 0 ? (
        <span className={styles.navStep}>
          <button type="button" onClick={() => onStepMatch(-1)} aria-label="Previous match" title="Previous match (Shift+Enter)">↑</button>
          <button type="button" onClick={() => onStepMatch(1)} aria-label="Next match" title="Next match (Enter)">↓</button>
        </span>
      ) : null}

      <span className={styles.navSpacer} />

      {errorCount > 0 ? (
        <button type="button" className={styles.navError} onClick={onJumpError}>
          <span className={styles.navErrorGlyph} aria-hidden="true">!</span>
          {errorCount} error{errorCount === 1 ? '' : 's'}
          <span className="visually-hidden"> — jump to the first one</span>
        </button>
      ) : null}

      {outlineOpen ? (
        <div id={outlineId} className={styles.outline} role="group" aria-label="Turns in this chat">
          {listed.length === 0 ? (
            <p className={styles.outlineEmpty}>No turn matches “{query.trim()}”.</p>
          ) : (
            <ol className={styles.outlineList}>
              {listed.map((turn) => {
                const index = turns.indexOf(turn) + 1;
                const snippet = snippetFor(turn.key);
                return (
                  <li key={turn.key}>
                    <button type="button" className={styles.outlineRow} data-status={turn.status}
                      onClick={() => { setOutlineOpen(false); onJumpTurn(turn.key); }}>
                      <span className={styles.outlineIndex}>{index}</span>
                      <span className={styles.outlineBody}>
                        <span className={styles.outlineTitle}>{turnTitle(turn)}</span>
                        {snippet ? <span className={styles.outlineSnippet}>{snippet}</span> : null}
                        <span className={styles.outlineMeta}>
                          {turn.toolCount > 0 ? `${turn.toolCount} tool${turn.toolCount === 1 ? '' : 's'}` : 'no tools'}
                          {turn.files.length > 0 ? ` · ${turn.files.length} file${turn.files.length === 1 ? '' : 's'}` : ''}
                          {turn.status !== 'ok' ? ` · ${STATUS_WORD[turn.status]}` : ''}
                        </span>
                      </span>
                      {STATUS_GLYPH[turn.status] ? (
                        <span className={styles.outlineStatus} aria-hidden="true">{STATUS_GLYPH[turn.status]}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
}
