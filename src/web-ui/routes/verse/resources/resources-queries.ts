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
import { VERSE_RESOURCE_READINESS_PATH, type ResourceReadinessResponse } from '../../../../core/routing/readiness-types.js';
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

export const RESOURCES_READINESS_KEY = 'verse-resources-readiness';

export interface ReadinessRead {
  /** False when this server has no readiness route (404) or it could not answer. */
  available: boolean;
  /** Null when absent, or when the body was not a readiness response. */
  value: ResourceReadinessResponse | null;
}

function isReadiness(raw: unknown): raw is ResourceReadinessResponse {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return r['v'] === 1 && Array.isArray(r['resources']) && typeof r['autonomy'] === 'object' && r['autonomy'] !== null;
}

/**
 * GET /api/verse/budget/readiness (3.14): per resource, "ready for chat?" and
 * "ready for the fleet?" with the one fix. An older server answers 404 — the
 * drawer then simply shows no readiness lines, never a false "not ready".
 */
export const resourceReadinessQuery: QueryDef<ReadinessRead> = {
  key: RESOURCES_READINESS_KEY,
  fetch: async (signal) => {
    try {
      const raw = await apiGet<unknown>(VERSE_RESOURCE_READINESS_PATH, signal);
      return { available: true, value: isReadiness(raw) ? raw : null };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return { available: false, value: null };
    }
  },
};

/** While the drawer is open: seats and health ride their own 30 s polls; these are the drawer's own. */
export const RESOURCES_POLL_MS = { cloud: 60_000, local: 30_000, runtime: 15_000, readiness: 30_000 } as const;
