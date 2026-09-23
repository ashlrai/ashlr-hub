/**
 * routes/verse/context/SessionSearch.tsx — find a past chat by what was SAID
 * in it, not only by its title.
 *
 * The sidebar's field has always filtered chat titles and project paths on
 * the client, instantly. Titles are the first line of the first message, so
 * "where did we decide the retry policy?" was unanswerable without opening
 * chats one by one. This component answers it: a keyword search over every
 * session's user and assistant messages (GET /api/verse/search — a bounded
 * scan of events.jsonl on this machine; nothing is sent to a model).
 *
 * TWO WAYS TO MOUNT, one behaviour:
 *
 *  - Controlled (`query` given): the sidebar passes ITS field's value, so one
 *    box drives both the instant title filter above and the message matches
 *    below. No second box — two search fields stacked in a 240px sidebar
 *    would make the operator guess which one to type in.
 *  - Standalone (`query` absent): renders its own field, for any surface that
 *    has no search box of its own.
 *
 * One row per CHAT (the server ranks messages; the list ranks chats), with the
 * best-matching snippet and its terms marked. A query under two characters
 * asks nothing: a one-letter scan of every transcript is noise, not recall.
 * An older server without the route answers 404; the section then stays
 * silent rather than printing a permanent error for a feature that server
 * does not have — the title filter above still works.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { VerseSearchResponse } from '../../../../core/verse/types.js';
import { ApiError } from '../../../data/client.js';
import { formatRelative } from '../verse-model.js';
import {
  groupSearchHits,
  highlightSegments,
  searchTerms,
  SEARCH_DEBOUNCE_MS,
  SEARCH_LIMIT,
  SEARCH_MIN_CHARS,
} from './context-model.js';
import { searchSessions } from './context-queries.js';
import { describeContextError } from './use-token-gate.js';
import styles from './context.module.css';

export interface SessionSearchProps {
  onOpenSession: (id: string) => void;
  /**
   * The query, when a surrounding field owns it (the sidebar). Absent → this
   * component renders its own field.
   */
  query?: string;
  /** The chat that is open, marked with aria-current like the sidebar's rows. */
  selectedId?: string | null;
}

type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; previous: VerseSearchResponse | null }
  | { status: 'ready'; response: VerseSearchResponse }
  | { status: 'error'; message: string }
  | { status: 'unsupported' };

export function SessionSearch({ onOpenSession, query, selectedId = null }: SessionSearchProps) {
  const inputId = useId();
  const headingId = useId();
  const standalone = query === undefined;
  const [own, setOwn] = useState('');
  const q = (standalone ? own : query).trim();
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const [retry, setRetry] = useState(0);
  /** Once the server has said it has no search route, stop asking for this mount's lifetime. */
  const unsupported = useRef(false);

  useEffect(() => {
    if (unsupported.current) return undefined;
    if (q.length < SEARCH_MIN_CHARS) {
      setState({ status: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    // Keep the previous answer on screen while the next one is fetched: a list
    // that blanks on every keystroke is harder to read than a slightly stale one.
    setState((prev) => ({
      status: 'loading',
      previous: prev.status === 'ready' ? prev.response : prev.status === 'loading' ? prev.previous : null,
    }));
    const timer = setTimeout(() => {
      searchSessions(q, SEARCH_LIMIT, controller.signal)
        .then((response) => {
          if (!controller.signal.aborted) setState({ status: 'ready', response });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          if (err instanceof ApiError && err.status === 404) {
            unsupported.current = true;
            setState({ status: 'unsupported' });
          }
          else setState({ status: 'error', message: describeContextError(err) });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, retry]);

  const field = standalone ? (
    <label className={styles.searchBox} htmlFor={inputId}>
      <span className="visually-hidden">Search messages in every chat</span>
      <input id={inputId} type="search" className={styles.input} value={own} placeholder="Search messages"
        autoComplete="off" spellCheck={false} onChange={(event) => setOwn(event.target.value)} />
    </label>
  ) : null;

  // Controlled and idle (the sidebar's field is empty or too short), or a
  // server without the route: nothing to say — the title list above is the
  // whole answer. A standalone field has no title list, so it says why.
  if (state.status === 'unsupported') {
    return standalone ? (
      <div className={styles.search}>
        {field}
        <p className={`${styles.hint} ${styles.searchNote}`}>This server cannot search messages yet — update Ashlr and restart <code>ashlr verse</code>.</p>
      </div>
    ) : null;
  }
  if (state.status === 'idle' && !standalone) return null;

  const response = state.status === 'ready' ? state.response : state.status === 'loading' ? state.previous : null;
  const groups = response ? groupSearchHits(response.hits) : [];
  const terms = searchTerms(response?.query ?? q);
  const busy = state.status === 'loading';

  return (
    <section className={styles.search} aria-labelledby={headingId} aria-busy={busy ? true : undefined}>
      {field}
      <h2 id={headingId} className={styles.searchHead}>
        <span>In messages</span>
        {response && !busy ? (
          <span className={styles.searchCount} aria-hidden="true">{groups.length}</span>
        ) : null}
      </h2>

      {/* Announced once per answer, not per keystroke. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {state.status === 'ready'
          ? groups.length === 0 ? `No messages match ${q}.` : `${groups.length} ${groups.length === 1 ? 'chat has' : 'chats have'} matching messages.`
          : ''}
      </p>

      {state.status === 'idle' ? (
        <p className={`${styles.hint} ${styles.searchNote}`}>
          Searches what was said in every chat on this machine. Nothing is sent to a model.
        </p>
      ) : state.status === 'error' ? (
        <div className={styles.searchError} role="alert">
          <span>Could not search messages: {state.message}</span>
          <button type="button" className={`${styles.secondary} ${styles.small}`} onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : busy && !response ? (
        <p className={`${styles.hint} ${styles.searchNote}`}>Searching messages…</p>
      ) : groups.length === 0 ? (
        <p className={`${styles.hint} ${styles.searchNote}`}>No messages match “{q}”.</p>
      ) : (
        <ul className={styles.hits}>
          {groups.map((group) => {
            const segments = highlightSegments(group.top.snippet, terms);
            const who = group.top.kind === 'user' ? 'You' : 'Agent';
            const more = group.count > 1 ? ` · ${group.count} matches` : '';
            return (
              <li key={group.sessionId}>
                <button type="button" className={`${styles.hit} ${styles[`engine-${group.engine}`] ?? ''}`}
                  aria-current={group.sessionId === selectedId ? 'true' : undefined}
                  data-session={group.sessionId} data-engine={group.engine}
                  onClick={() => onOpenSession(group.sessionId)}>
                  <span className={styles.hitMarker} aria-hidden="true" />
                  <span className={styles.hitTitle}>{group.title || 'Untitled chat'}</span>
                  <time className={styles.hitTime} dateTime={group.latestAt}>{formatRelative(group.latestAt)}</time>
                  <span className={styles.hitSnippet}>
                    <span className={styles.hitWho}>{who}{more}: </span>
                    {segments.map((segment, index) => (segment.match
                      ? <mark key={index}>{segment.text}</mark>
                      : <span key={index}>{segment.text}</span>))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {response && state.status !== 'error' ? (
        <p className={`${styles.hint} ${styles.searchNote}`}>
          Searched {response.scannedSessions.toLocaleString()} {response.scannedSessions === 1 ? 'chat' : 'chats'}
          {response.truncated ? ' — the most recent ones only; older chats were not searched.' : '.'}
        </p>
      ) : null}
    </section>
  );
}
