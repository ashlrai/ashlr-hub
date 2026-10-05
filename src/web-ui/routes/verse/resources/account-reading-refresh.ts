/** Selected-account mutation is loaded only after an operator requests a check. */
import type { VerseAccountReadingRefresh, VerseSeatsResponse } from '../../../../core/verse/types.js';
import { normalizeCodexCredits } from '../../../../core/resources/codex-credits.js';
import { getAuthSnapshot, getMutationToken, subscribeAuth, touchMutationHold } from '../../../data/auth-store.js';
import type { VerseBootstrap } from '../../../data/api-types.js';
import { getQuerySnapshot, refetchQuery } from '../../../data/cache.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { oneShotFetcher } from '../health/health-queries.js';
import { VERSE_BOOTSTRAP_KEY, verseBootstrapQuery, VerseMutationLockedError } from '../verse-queries.js';
import { mergeSeatsIntoBootstrap, VERSE_SEATS_URL } from '../useSeatsRefresh.js';

/** The POST acknowledges a real check; only a fresh target readback confirms display data. */
export async function refreshAccountReading(seatId: string, isCurrent: () => boolean = () => true): Promise<VerseAccountReadingRefresh> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const phase = getAuthSnapshot().phase;
  let lost = false;
  const unsubscribe = subscribeAuth(() => {
    if (getMutationToken() !== token || getAuthSnapshot().phase !== phase) lost = true;
  });
  const check = () => {
    if (lost || !isCurrent()) throw new Error('Usage confirmation interrupted. Refresh before trying again.');
  };
  try {
    check();
    const result = await apiPost<VerseAccountReadingRefresh>(`${VERSE_SEATS_URL}/refresh`, { seatId }, token);
    check();
    if (!result || result.seatId !== seatId || !['completed', 'cached', 'held'].includes(result.state) ||
      !['current', 'unknown'].includes(result.reading) || typeof result.reason !== 'string' || !result.reason ||
      typeof result.joined !== 'boolean' ||
      ![result.observedAt, result.expiresAt, result.nextCheckAt].every(value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value))) ||
      result.reading === 'unknown' && (result.observedAt !== null || result.expiresAt !== null)) throw new Error('The usage check reply could not be confirmed.');
    touchMutationHold();
    const live = await apiGet<VerseSeatsResponse>(VERSE_SEATS_URL);
    check();
    if (!live || !Array.isArray(live.seats)) throw new Error('The usage reading could not be confirmed.');
    if (result.reading === 'current') {
      const seat = live.seats.find(row => row?.id === seatId);
      const capacity = seat?.capacity;
      const at = result.observedAt === null ? NaN : Date.parse(result.observedAt);
      const expires = result.expiresAt === null ? NaN : Date.parse(result.expiresAt);
      const readAt = capacity?.observedAt ? Date.parse(capacity.observedAt) : NaN;
      const now = Date.now();
      if (result.state === 'held' || !Number.isFinite(at) || at > now || !Number.isFinite(expires) || expires <= now ||
        seat?.health.state !== 'ready' || capacity?.evidenceSource !== 'collector' || !Number.isFinite(readAt) || readAt < at || readAt > now ||
        !(capacity.windows?.some(window => typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100) ||
          normalizeCodexCredits(capacity.credits) !== null && typeof capacity.creditsExpiresAt === 'string' && Date.parse(capacity.creditsExpiresAt) > now && Date.parse(capacity.creditsExpiresAt) >= expires)) {
        throw new Error('The fresh reading does not confirm current usage. Refresh before trying again.');
      }
    }
    const full = (): Promise<VerseBootstrap> => verseBootstrapQuery.fetch();
    let merged = false;
    await refetchQuery(VERSE_BOOTSTRAP_KEY, oneShotFetcher(async () => {
      check();
      const current = getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data;
      // Never restore an old bootstrap after eviction/auth reset.
      if (!current) throw new Error('Usage confirmation interrupted. Refresh before trying again.');
      merged = true;
      return mergeSeatsIntoBootstrap(current, live);
    }, full), true);
    check();
    const published = getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY);
    // The shared query cache records fetch errors without rejecting its promise.
    // A completed Promise is not evidence that this readback was published.
    if (!merged || published.status !== 'success' || !published.data ||
      JSON.stringify(published.data.seats) !== JSON.stringify(live.seats)) {
      throw new Error('Usage confirmation interrupted. Refresh before trying again.');
    }
    return result;
  } finally { unsubscribe(); }
}

