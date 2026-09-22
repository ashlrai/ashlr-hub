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
 * WHY BOOTSTRAP AND NOT `GET /api/verse/seats`. S added that route precisely
 * to be polled, and it is the cheaper read. But `verse-bootstrap` is the cache
 * key ChatSection already subscribes to and hands down as the `seats` prop to
 * the sidebar, the workspace, the seat selector and the new-chat dialog.
 * Polling it updates all five surfaces with no change to the component that
 * owns them. Moving to `/api/verse/seats` means lifting seats out of the
 * bootstrap prop first; that is a worthwhile follow-up, not a prerequisite.
 *
 * Two deliberate choices:
 *
 *  - `useRefetch`, not `useRefresh`. Refetch collapses a burst of ticks (and a
 *    tick landing on a read that just started) into ONE request, which is what
 *    a poll wants. `useRefresh` never joins, which is what a person pressing a
 *    button wants; the panel's own Refresh control uses that.
 *  - Nothing is requested while the document is hidden, and a read is issued
 *    the moment it becomes visible again. A backgrounded app polls zero times
 *    and is nonetheless correct the instant it is looked at.
 */
import { useEffect } from 'react';
import { useRefetch } from '../../data/hooks.js';
import { verseBootstrapQuery } from './verse-queries.js';

/** Matches the collector's own publish cadence; there is nothing to gain from faster. */
export const SEATS_POLL_MS = 30_000;

export function useSeatsRefresh(active = true): void {
  const refetch = useRefetch(verseBootstrapQuery);
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
