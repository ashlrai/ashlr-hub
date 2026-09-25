/**
 * routes/verse/resources/resources-queries.ts — the one read the Resources
 * drawer adds (unit 3.11 C6). Seats, health, budget, local models and the
 * serving runtime are read through their owners' QueryDefs (usage/, health/,
 * budget/, autonomy/fleet-queries); only the cloud lane's overview is new.
 *
 * GET /api/verse/cloud lands in parallel with this drawer. Until it does the
 * server answers 404, and that is a designed state ("Cloud lane not available
 * yet"), not an error: the fetcher resolves `{ available: false }` instead of
 * throwing. A 401 still propagates — an expired session is the whole app's
 * problem, not this panel's.
 */
import { VERSE_CLOUD_PATH } from '../../../../core/cloud/types.js';
import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { projectCloudCredits, type CloudCreditsView } from './resources-model.js';

export const RESOURCES_CLOUD_KEY = 'verse-resources-cloud';

export interface CloudCreditsRead {
  /** False when the route is absent (404) or unreachable. */
  available: boolean;
  /** Null when absent, or when the body was not a cloud overview. */
  credits: CloudCreditsView | null;
}

export const cloudCreditsQuery: QueryDef<CloudCreditsRead> = {
  key: RESOURCES_CLOUD_KEY,
  fetch: async (signal) => {
    try {
      const raw = await apiGet<unknown>(VERSE_CLOUD_PATH, signal);
      return { available: true, credits: projectCloudCredits(raw) };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return { available: false, credits: null };
    }
  },
};

/** While the drawer is open: seats and health ride their own 30 s polls; these are the drawer's own. */
export const RESOURCES_POLL_MS = { cloud: 60_000, local: 30_000, runtime: 15_000 } as const;
