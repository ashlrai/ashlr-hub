/**
 * routes/verse/health/useSeatHealth.ts — the seat health reports, kept live
 * while the app is on screen.
 *
 * The SERVER sweeps every ten minutes whether or not anyone looks
 * (core/verse/account-health.ts) — that is what catches a sign-out while the
 * app is hidden, and it is what the desktop shell's notifications read. This
 * hook only has to keep a VISIBLE page current, so it polls a cheap cached
 * read every 30 s (no probe runs per request), skips ticks while hidden, and
 * re-reads the moment the page is looked at again.
 */
import { useEffect } from 'react';
import type { VerseHealthResponse } from '../../../../core/verse/health-types.js';
import type { QueryEntry } from '../../../data/cache.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { verseHealthQuery } from './health-queries.js';

/** The fastest poll the performance budget allows is 2 s; 30 s is plenty for a status line. */
export const HEALTH_POLL_MS = 30_000;

export function useSeatHealth(active = true): QueryEntry<VerseHealthResponse> {
  const entry = useQuery(verseHealthQuery);
  const refetch = useRefetch(verseHealthQuery);
  useEffect(() => {
    if (!active) return;
    const tick = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refetch();
    };
    const timer = window.setInterval(tick, HEALTH_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active, refetch]);
  return entry;
}
