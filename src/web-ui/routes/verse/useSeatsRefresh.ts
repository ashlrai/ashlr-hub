/**
 * routes/verse/useSeatsRefresh.ts — keep the seat roster live.
 *
 * THE BUG THIS CLOSES. `GET /api/verse/bootstrap` carries the seats, and it
 * has NO entry in sse.ts's `EVENT_TO_CACHE_KEYS`: nothing on the server can
 * push a new reading into it. It is re-read only on mount and after a write
 * (`invalidateVerseLists`). The historical startup investigation found first collector readings
 * only after roughly a cycle and a half (about 75 seconds in that run). That
 * observation explains the original bug; it is not a current latency promise. Open the app cold, as Mason does, and the one read that ever happens
 * lands BEFORE any reading exists. Every seat then shows "unknown" for the
 * rest of the session, on the surface he looks at all day, and no amount of
 * correct rendering downstream can fix that.
 *
 * Visible surfaces now share a startup catch-up and steady-state poll. The
 * cost is a cached JSON read, not a probe: the
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
 *  - A shared, bounded startup burst picks up independent initial checks;
 *    reliable completion returns to the 30s cadence. Older servers receive
 *    only the bounded burst, never an infinite wait for missing quota.
 *  - Current servers also send metadata-only publication notifications over
 *    the existing shared stream: late accounts trigger one cheap seats read.
 *  - Nothing is requested while the document is hidden, and a read is issued
 *    the moment it becomes visible again. A backgrounded app polls zero times
 *    and is nonetheless correct the instant it is looked at.
 */
import { useEffect } from 'react';
import { getAuthSnapshot, subscribeAuth } from '../../data/auth-store.js';
import type { VerseBootstrap } from '../../data/api-types.js';
import type { VerseSeatsResponse } from '../../../core/verse/types.js';
import { getQuerySnapshot, refetchQuery, runQuery } from '../../data/cache.js';
import { apiGet } from '../../data/client.js';
import { oneShotFetcher } from './health/health-queries.js';
import { VERSE_BOOTSTRAP_KEY, verseBootstrapQuery } from './verse-queries.js';
import { onVerseAccountReadingsChanged } from './verse-list-channel.js';

/** Steady-state cached reads follow the collector's cadence. */
export const SEATS_POLL_MS = 30_000;
/** Bounded startup catch-up reads snapshots only, never triggers a provider probe. */
export const SEATS_STARTUP_POLL_MS = 2_000;
export const SEATS_STARTUP_WINDOW_MS = 30_000;

export const VERSE_SEATS_URL = '/api/verse/seats';

/** The cached bootstrap with its seat list (and local runtime) replaced by a live `/seats` read. */
export function mergeSeatsIntoBootstrap(bootstrap: VerseBootstrap, live: VerseSeatsResponse): VerseBootstrap {
  return { ...bootstrap, seats: live.seats, localRuntime: live.localRuntime, accountTelemetry: live.accountTelemetry };
}

/** One poll tick: `/seats` merged into the cached bootstrap, or a full bootstrap when none is cached. */
function readSeats(force: boolean): Promise<void> {
  const cached = getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data;
  const full = (): Promise<VerseBootstrap> => verseBootstrapQuery.fetch();
  // Polls join any outstanding snapshot, including a person's newer refresh.
  const read = (fetcher: () => Promise<VerseBootstrap>) => force
    ? refetchQuery(VERSE_BOOTSTRAP_KEY, fetcher, true)
    : runQuery(VERSE_BOOTSTRAP_KEY, fetcher);
  if (cached === undefined) return read(full);
  const merged = async (): Promise<VerseBootstrap> => {
    const live = await apiGet<VerseSeatsResponse>(VERSE_SEATS_URL);
    // Merge into whatever is cached NOW, not at tick time: a write may have
    // refreshed the rest of the bootstrap while this read was in flight.
    const current = getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data ?? cached;
    return mergeSeatsIntoBootstrap(current, live);
  };
  return read(oneShotFetcher(merged, full));
}

/** Polls coalesce; a person's refresh always supersedes an older read. */
export function pollSeats(): Promise<void> { return readSeats(false); }
export function refreshSeats(): Promise<void> { return readSeats(true); }

// One visible-page scheduler, shared by the rail, chat, drawer and selectors.
// Initial collector checks are a pending signal; missing quota never is.
// Older servers get a bounded catch-up burst, then normal cadence.
let readers = 0;
let stopSharedRefresh: (() => void) | null = null;

function startSharedRefresh(): () => void {
  let timer: number | undefined;
  let generation = 0;
  let startedAt = Date.now();
  let alive = true;
  let reading = false;
  let publicationPending = false;
  let notificationQueued = false;
  let phase = getAuthSnapshot().phase;
  const visible = () => alive && phase !== 'unauthenticated' && document.visibilityState !== 'hidden';
  const cancelTimer = () => { window.clearTimeout(timer); timer = undefined; };
  const tick = () => {
    if (!visible() || reading) return;
    reading = true;
    publicationPending = false;
    const ownGeneration = generation;
    void pollSeats().finally(() => {
      reading = false;
      if (!visible()) return;
      if (publicationPending || ownGeneration !== generation) { tick(); return; }
      const telemetry = getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data?.accountTelemetry;
      const pending = telemetry == null || !Array.isArray(telemetry.pendingAccountIds) || telemetry.pendingAccountIds.length > 0;
      const delay = pending && Date.now() - startedAt < SEATS_STARTUP_WINDOW_MS ? SEATS_STARTUP_POLL_MS : SEATS_POLL_MS;
      timer = window.setTimeout(tick, delay);
    });
  };
  const unsubscribeReadings = onVerseAccountReadingsChanged(() => {
    if (!visible()) return;
    publicationPending = true;
    cancelTimer();
    if (notificationQueued) return;
    notificationQueued = true;
    queueMicrotask(() => {
      notificationQueued = false;
      if (visible() && publicationPending) tick();
    });
  });
  const restart = () => {
    cancelTimer();
    generation += 1;
    startedAt = Date.now();
    tick();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') { cancelTimer(); generation += 1; }
    else restart();
  };
  const unsubscribeAuth = subscribeAuth(() => {
    const next = getAuthSnapshot().phase;
    if (next === phase) return;
    phase = next;
    restart(); // expired identities stop; the next authenticated session starts fresh.
  });
  document.addEventListener('visibilitychange', onVisibility);
  tick();
  return () => {
    alive = false;
    generation += 1;
    cancelTimer();
    unsubscribeAuth();
    unsubscribeReadings();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export function useSeatsRefresh(active = true): void {
  useEffect(() => {
    if (!active) return undefined;
    readers += 1;
    if (readers === 1) stopSharedRefresh = startSharedRefresh();
    return () => {
      readers -= 1;
      if (readers === 0) { stopSharedRefresh?.(); stopSharedRefresh = null; }
    };
  }, [active]);
}
