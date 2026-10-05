import { optionalQuery } from '../command/surface-data.js';
import { apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { VERSE_ADOPTION_PATH, VERSE_ADOPTION_REFRESH_PATH } from '../../../../core/verse/adoption-types.js';
import { narrowAdoption } from './adoption-model.js';
export const ADOPTION_KEY = 'verse-adoption';
export const adoptionQuery = optionalQuery(ADOPTION_KEY, VERSE_ADOPTION_PATH, 'Adoption', narrowAdoption);
export async function refreshAdoption(): Promise<{ ok: true }> {
  const token = getMutationToken(); if (!token) throw new VerseControlLockedError();
  const result = await apiPost<{ ok: true }>(VERSE_ADOPTION_REFRESH_PATH, {}, token);
  touchMutationHold(); invalidate(ADOPTION_KEY); return result;
}
