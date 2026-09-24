/**
 * routes/verse/useSeatsRefresh.ts — keep the seat roster live.
 *
 * THE BUG THIS CLOSES. `GET /api/verse/bootstrap` carries the seats, and it
 * has NO entry in sse.ts's `EVENT_TO_CACHE_KEYS`: nothing on the server can
 * push a new reading into it. It is re-read only on mount and after a write
 * (`invalidateVerseLists`). The account collector, meanwhile, needs roughly a
 * cycle and a half — about 75 seconds measured — before its first readings
 * exist. Open the app cold, as Mason does, and the one read that ever happens
 * lands BEFORE any reading exists. Every seat then shows "unknown" for the
 * rest of the session, on the surface he looks at all day, and no amount of
 * correct rendering downstream can fix that.
 *
 * So the chat surfaces poll. The cost is a cached JSON read, not a probe: the
 * collector spawns its processes on its own 30s cycle regardless of whether
 * anyone asks, and this only picks up what it already published. Owner S's
 * V2.1 bootstrap handler recomputes seat telemetry on every read
 * (`liveSeats` in core/verse/verse-api.ts), so a poll of this key genuinely
 * returns the collector's CURRENT state rather than a warm cache.
 *
 * V3.10 — POLL `GET /api/verse/seats`, NOT BOOTSTRAP. Bootstrap also
 * re-reads projects, preferences and the workspace registry; measured, it
 * blocked the server's event loop ~384 ms per poll (research r2/perf-server).
 * `/seats` is the same live seat list and nothing else. The seats still have
 * to land in the `verse-bootstrap` cache key, because that is what ChatSection
 * hands to the sidebar, workspace, seat selector and new-chat dialog — so the
 * poll MERGES `/seats` into the cached bootstrap (`mergeSeatsIntoBootstrap`)
 * instead of re-reading all of it.
 *
 * The cache remembers the last fetcher it ran for a key and re-runs it on
 * every later `invalidate` (after a write). A plain "/seats and merge" fetcher
 * would therefore turn every later full refresh into a seats-only one; the
 * poll registers a ONE-SHOT fetcher (health/health-queries.ts
 * `oneShotFetcher`) that merges once and falls back to the real bootstrap read.
 * With no bootstrap cached yet there is nothing to merge into, so the poll
 * reads bootstrap itself.
 *
 * Two deliberate choices:
 *
 *  - Refetch semantics, not refresh. A refetch collapses a burst of ticks (and
 *    a tick landing on a read that just started) into ONE request, which is
 *    what a poll wants. A forced refresh never joins, which is what a person
 *    pressing a button wants; the panel's own Refresh control uses that.
 *  - Nothing is requested while the document is hidden, and a read is issued
 *    the moment it becomes visible again. A backgrounded app polls zero times
 *    and is nonetheless correct the instant it is looked at.
 */
import { useCallback, useEffect } from 'react';
import type { VerseBootstrap } from '../../data/api-types.js';
import type { VerseSeatsResponse } from '../../../core/verse/types.js';
import { getQuerySnapshot, refetchQuery } from '../../data/cache.js';
import { apiGet } from '../../data/client.js';
import { oneShotFetcher } from './health/health-queries.js';
import { VERSE_BOOTSTRAP_KEY, verseBootstrapQuery } from './verse-queries.js';

/** Matches the collector's own publish cadence; there is nothing to gain from faster. */
export const SEATS_POLL_MS = 30_000;

export const VERSE_SEATS_URL = '/api/verse/seats';

/** The cached bootstrap with its seat list (and local runtime) replaced by a live `/seats` read. */
export function mergeSeatsIntoBootstrap(bootstrap: VerseBootstrap, live: VerseSeatsResponse): VerseBootstrap {
  return { ...bootstrap, seats: live.seats, localRuntime: live.localRuntime };
}

/** One poll tick: `/seats` merged into the cached bootstrap, or a full bootstrap when none is cached. */
export function pollSeats(): Promise<void> {
  const cached = getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data;
  const full = (): Promise<VerseBootstrap> => verseBootstrapQuery.fetch();
  if (cached === undefined) return refetchQuery(VERSE_BOOTSTRAP_KEY, full);
  const merged = async (): Promise<VerseBootstrap> => {
    const live = await apiGet<VerseSeatsResponse>(VERSE_SEATS_URL);
    // Merge into whatever is cached NOW, not at tick time: a write may have
    // refreshed the rest of the bootstrap while this read was in flight.
    const current = getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data ?? cached;
    return mergeSeatsIntoBootstrap(current, live);
  };
  return refetchQuery(VERSE_BOOTSTRAP_KEY, oneShotFetcher(merged, full));
}

export function useSeatsRefresh(active = true): void {
  const refetch = useCallback(() => { void pollSeats(); }, []);
  useEffect(() => {
    if (!active) return;
    const tick = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refetch();
    };
    const timer = window.setInterval(tick, SEATS_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active, refetch]);
}
