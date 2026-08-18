/**
 * routes/journal/JournalView.tsx — "what did the fleet do overnight,
 * answerable in one glance; why, in one click" (build brief). Merges every
 * history source the read API exposes (see journal-model.ts's header
 * comment for the exact, honestly-stated window), makes it filterable and
 * scrubable, and surfaces a live-now strip for anything currently running.
 *
 * Follows DESIGN.md's view checklist: useQuery per resource (never apiGet
 * directly), 'loading' -> skeleton, 'error' -> inline banner (never blanks
 * the shell), 'refreshing' -> real content + <RefreshIndicator/>, every
 * sourceQuality-bearing field wrapped in <Epistemic/> (done inside
 * JournalEntryRow via <EpistemicBadge/>).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { controlLogsObservationQuery, fleetActivityQuery, runsQuery, inboxQuery } from '../../data/queries.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonRow } from '../../components/primitives/Skeleton.js';
import { LiveNowStrip } from './LiveNowStrip.js';
import { JournalFilters, ALL_JOURNAL_SOURCES } from './JournalFilters.js';
import { JournalTimeline } from './JournalTimeline.js';
import { JournalEntryRow } from './JournalEntryRow.js';
import { buildJournalEntries, filterJournalEntries, startOfTodayMs, type JournalSource } from './journal-model.js';

/** Command-palette "Open journal — today" navigates here with
 * `state: { windowToday: true }` (react-router's location.state, not a new
 * URL-param convention — this app is HashRouter'd with no useSearchParams
 * usage anywhere else). Read once on mount as the initial filter; the
 * operator can still change it from the normal filter bar afterward. */
interface JournalNavState {
  windowToday?: boolean;
}
import styles from './JournalView.module.css';

/** control-logs-observation isn't SSE-invalidated (its key isn't in
 * data/sse.ts's EVENT_TO_CACHE_KEYS) — poll it ourselves, same rationale as
 * the notification engine's summary poll. */
const LOGS_POLL_MS = 8000;

function formatRelative(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

export function JournalView() {
  const location = useLocation();
  const openedToToday = (location.state as JournalNavState | null)?.windowToday === true;

  const logsQuery = useQuery(controlLogsObservationQuery);
  const activityQuery = useQuery(fleetActivityQuery);
  const runsListQuery = useQuery(runsQuery);
  const inboxListQuery = useQuery(inboxQuery);
  const refetchLogs = useRefetch(controlLogsObservationQuery);

  useEffect(() => {
    const id = setInterval(refetchLogs, LOGS_POLL_MS);
    return () => clearInterval(id);
  }, [refetchLogs]);

  const [sources, setSources] = useState<Set<JournalSource>>(new Set(ALL_JOURNAL_SOURCES));
  const [query, setQuery] = useState('');
  const [windowValue, setWindowValue] = useState(openedToToday ? 'today' : '24h');
  const [windowMs, setWindowMs] = useState<number | null>(openedToToday ? startOfTodayMs() : 24 * 60 * 60 * 1000);

  const entries = useMemo(
    () =>
      buildJournalEntries({
        logs: logsQuery.data,
        fleetActivity: activityQuery.data,
        runs: runsListQuery.data,
        inbox: inboxListQuery.data,
      }),
    [logsQuery.data, activityQuery.data, runsListQuery.data, inboxListQuery.data],
  );

  const filtered = useMemo(
    () => filterJournalEntries(entries, { sources, query, windowMs }),
    [entries, sources, query, windowMs],
  );

  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  function scrubTo(bucketStartMs: number) {
    const hourMs = 60 * 60 * 1000;
    const target = filtered.find((e) => new Date(e.ts).getTime() <= bucketStartMs + hourMs);
    if (!target) return;
    rowRefs.current.get(target.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const anyLoading =
    logsQuery.status === 'loading' &&
    activityQuery.status === 'loading' &&
    runsListQuery.status === 'loading' &&
    inboxListQuery.status === 'loading';
  const anyRefreshing = [logsQuery, activityQuery, runsListQuery, inboxListQuery].some((q) => q.status === 'refreshing');
  const latestUpdatedAt = Math.max(
    logsQuery.updatedAt ?? 0,
    activityQuery.updatedAt ?? 0,
    runsListQuery.updatedAt ?? 0,
    inboxListQuery.updatedAt ?? 0,
  );

  const errors = [
    logsQuery.status === 'error' ? `daemon log: ${logsQuery.error?.message}` : null,
    activityQuery.status === 'error' ? `fleet activity: ${activityQuery.error?.message}` : null,
    runsListQuery.status === 'error' ? `runs: ${runsListQuery.error?.message}` : null,
    inboxListQuery.status === 'error' ? `inbox: ${inboxListQuery.error?.message}` : null,
  ].filter((e): e is string => e !== null);

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Work Journal</h1>
          <p className={styles.windowNote}>
            Merges the daemon log (last 200 lines), fleet activity (last ~20 merges/ticks/agent actions), recent runs
            (last 200), and the pending-proposal inbox. The read API does not expose the full on-disk history beyond
            this window.
          </p>
        </div>
        <div className={styles.freshness} aria-live="polite">
          {anyRefreshing ? <RefreshIndicator /> : null}
          {latestUpdatedAt > 0 ? <span className={styles.freshnessLabel}>Updated {formatRelative(latestUpdatedAt)}</span> : null}
        </div>
      </header>

      {errors.length > 0 ? (
        <div className={styles.errorBanner} role="alert">
          Some sources failed to load: {errors.join('; ')}
        </div>
      ) : null}

      <LiveNowStrip />

      {anyLoading ? (
        <div className={styles.panel}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : (
        <>
          <JournalTimeline entries={entries} hours={24} onScrubTo={scrubTo} />
          <JournalFilters
            sources={sources}
            onSourcesChange={setSources}
            query={query}
            onQueryChange={setQuery}
            windowValue={windowValue}
            onWindowChange={(value, ms) => {
              setWindowValue(value);
              setWindowMs(ms);
            }}
          />
          <div className={styles.panel}>
            {filtered.length === 0 ? (
              <p className={styles.empty}>Nothing matches the current filters in this window.</p>
            ) : (
              <ul className={styles.list}>
                {filtered.map((entry) => (
                  <li
                    key={entry.id}
                    ref={(el) => {
                      if (el) rowRefs.current.set(entry.id, el);
                      else rowRefs.current.delete(entry.id);
                    }}
                  >
                    <JournalEntryRow entry={entry} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
