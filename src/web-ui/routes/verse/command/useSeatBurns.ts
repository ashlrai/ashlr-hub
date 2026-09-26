/**
 * routes/verse/command/useSeatBurns.ts — the per-seat burn-down lines: the
 * budget route's live reading, merged over the server's recorded seat
 * history (GET /api/verse/budget/history) and the readings this page has seen
 * since Verse opened (command-model `recordReading` / `mergeSeatHistory`).
 *
 * Lifted out of CommandSection when the burn-down charts moved to Usage
 * (audit 14): Command now shows one compact seat strip and no longer reads
 * the up-to-2 MiB history file at all.
 *
 * The history rides a 5-minute poll — never the 30 s budget poll — and is
 * fetched on mount. The seat roster (for Claude's reset WORDS; the budget
 * route carries only machine instants, which Claude never publishes) is read
 * from the cache WITHOUT fetching: a bootstrap read costs the server ~384 ms
 * (useSeatsRefresh.ts), and the shell keeps it live anyway.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { VerseBootstrap } from '../../../data/api-types.js';
import { getQuerySnapshot, subscribeQuery } from '../../../data/cache.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { VERSE_BOOTSTRAP_KEY } from '../verse-queries.js';
import { mergeSeatHistory, recordReading, seatBurns, type SeatBurn, type SeatReading } from './command-model.js';
import { seatHistoryQuery } from './surface-data.js';

/**
 * History changes by a row per seat window every few minutes; its newest end
 * is the live budget reading, so this slow refresh only fills in the middle.
 */
export const SEAT_HISTORY_POLL_MS = 300_000;

// Readings observed since the page opened (module scope: they survive the
// keep-alive shell unmounting the surface that shows them). Merged with the
// server's recorded history, so a reload keeps the window.
let seatReadings: Record<string, SeatReading[]> = {};

/** Test hygiene: forget the readings a previous test recorded. */
export function resetSeatReadingsForTest(): void {
  seatReadings = {};
}

/** `view` is the caller's budget read (it owns that poll); null before it answers. */
export function useSeatBurns(view: BudgetView | null): SeatBurn[] {
  const seatHistory = useQuery(seatHistoryQuery, { freshMs: 60_000 });
  const refetchHistory = useRefetch(seatHistoryQuery);
  usePollWhileVisible(refetchHistory, SEAT_HISTORY_POLL_MS);

  const roster = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeQuery(VERSE_BOOTSTRAP_KEY, listener), []),
    () => getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY),
    () => getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY),
  );
  const seats = roster.data?.seats ?? null;

  const [readings, setReadings] = useState(seatReadings);
  useEffect(() => {
    if (!view) return;
    seatReadings = recordReading(seatReadings, view);
    setReadings(seatReadings);
  }, [view]);

  const recorded = seatHistory.data?.value ?? null;
  const merged = useMemo(() => mergeSeatHistory(readings, recorded), [readings, recorded]);
  return useMemo(() => seatBurns(view, merged.readings, seats, merged.recorded), [view, merged, seats]);
}
