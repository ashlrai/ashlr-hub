/**
 * routes/verse/health/health-queries.ts — the `/api/verse/health*` calls
 * (V3.10, unit A2). Server: core/verse/health-api.ts.
 *
 * Nothing here ever carries a launcher, a profile path or a credential: the
 * server withholds them, and Reconnect sends only the seat id — the server
 * resolves the seat's own login command privately and opens it in Terminal.
 */
import type { VerseHealthResponse } from '../../../../core/verse/health-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { refetchQuery } from '../../../data/cache.js';
import { apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const VERSE_HEALTH_KEY = 'verse-health';
export const VERSE_HEALTH_URL = '/api/verse/health';

export const verseHealthQuery: QueryDef<VerseHealthResponse> = {
  key: VERSE_HEALTH_KEY,
  fetch: (signal) => apiGet<VerseHealthResponse>(VERSE_HEALTH_URL, signal),
};

/**
 * A fetcher that answers ONCE with `first`, then behaves like `fallback`.
 *
 * The cache (data/cache.ts) remembers the last fetcher it ran for a key and
 * re-runs it on every later invalidation. Writing a value we already hold
 * through a constant fetcher would freeze the key on that value forever;
 * this hands the cache the value now and the real read afterwards.
 */
export function oneShotFetcher<T>(first: () => Promise<T>, fallback: () => Promise<T>): () => Promise<T> {
  let used = false;
  return () => {
    if (used) return fallback();
    used = true;
    return first();
  };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

/** Run a health sweep now and publish its result to every health reader. */
export async function refreshSeatHealth(): Promise<VerseHealthResponse> {
  const body = await post<VerseHealthResponse>(`${VERSE_HEALTH_URL}/refresh`, {});
  await refetchQuery(VERSE_HEALTH_KEY, oneShotFetcher(() => Promise.resolve(body), () => verseHealthQuery.fetch()), true);
  return body;
}

/**
 * Open the seat's own sign-in in Terminal (macOS). Resolves once the window
 * was asked to open; the sign-in itself is the operator's, in that window.
 */
export async function reconnectSeat(seatId: string): Promise<void> {
  await post<{ ok: true; seatId: string }>(`${VERSE_HEALTH_URL}/reconnect`, { seatId });
}
