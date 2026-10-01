/**
 * routes/verse/jev/jev-queries.ts — GET /api/verse/jev (core/decide/jev-api.ts).
 *
 * OPTIONAL: a server without the route answers 404 and the views render
 * nothing. The optional call preference uses the existing mutation gate;
 * this page never takes a provider key or switches Jev on.
 */
import { VERSE_JEV_PATH, VERSE_JEV_CONFIG_PATH } from '../../../../core/decide/jev-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiPost } from '../../../data/client.js';
import { invalidate } from '../../../data/cache.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { optionalQuery } from '../command/surface-data.js';
import { narrowJevResponse } from './jev-model.js';

export const JEV_KEY = 'verse-jev';
export const JEV_POLL_MS = 60_000;

export const jevQuery = optionalQuery(JEV_KEY, VERSE_JEV_PATH, 'Jev', narrowJevResponse);

export async function updateJevCallPreference(value: number | null): Promise<number | null> {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Choose a nonnegative whole number or No preference limit.');
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const response = narrowJevResponse(await apiPost<unknown>(VERSE_JEV_CONFIG_PATH, { dailyCallBudget: value }, token));
  if (getMutationToken() !== token) throw new Error('Session changed. Review the preference again.');
  if (!response?.config || response.config.dailyCallBudget !== value) throw new Error('The server did not confirm this preference. Your choice is kept.');
  touchMutationHold();
  invalidate(JEV_KEY);
  return response.config.dailyCallBudget;
}
