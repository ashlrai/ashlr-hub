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

export type ReadinessRead =
  | { state: 'ready'; available: true; value: ResourceReadinessResponse }
  | { state: 'unsupported'; available: false; value: null };

function record(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

function nullableText(raw: unknown): boolean { return raw === null || typeof raw === 'string'; }
function instant(raw: unknown): boolean { return typeof raw === 'string' && Number.isFinite(Date.parse(raw)); }

function isVerdict(raw: unknown): boolean {
  if (!record(raw) || typeof raw['ready'] !== 'boolean' || typeof raw['word'] !== 'string'
    || typeof raw['detail'] !== 'string' || (typeof raw['tone'] !== 'string' || !['ok', 'warn', 'off', 'blocked'].includes(raw['tone']))) return false;
  const fix = raw['fix'];
  return fix === null || (record(fix) && typeof fix['kind'] === 'string' && ['reconnect', 'check-again', 'command'].includes(fix['kind'])
    && typeof fix['label'] === 'string' && (fix['command'] === undefined || typeof fix['command'] === 'string')
    && (fix['seatId'] === undefined || typeof fix['seatId'] === 'string'));
}

function isReadiness(raw: unknown): raw is ResourceReadinessResponse {
  if (!record(raw) || raw['v'] !== 1 || !instant(raw['checkedAt']) || !Array.isArray(raw['resources'])
    || !(raw['capacitySnapshotAt'] === null || instant(raw['capacitySnapshotAt']))) return false;
  const autonomy = raw['autonomy'];
  if (!record(autonomy) || typeof autonomy['active'] !== 'boolean' || !nullableText(autonomy['stage'])
    || typeof autonomy['detail'] !== 'string') return false;
  const ids = new Set<string>();
  return raw['resources'].every((row: unknown) => {
    if (!record(row) || typeof row['id'] !== 'string' || !row['id'] || ids.has(row['id'])
      || typeof row['label'] !== 'string' || (typeof row['engine'] !== 'string' || !['claude', 'codex', 'grok', 'local', 'devin'].includes(row['engine']))
      || (typeof row['kind'] !== 'string' || !['subscription', 'local', 'cloud'].includes(row['kind'])) || !isVerdict(row['chat']) || !isVerdict(row['fleet'])) return false;
    ids.add(row['id']);
    const reading = row['reading']; const fleet = row['fleet'];
    return record(reading) && typeof reading['state'] === 'string' && ['live', 'last', 'none'].includes(reading['state'])
      && (reading['at'] === null || instant(reading['at'])) && nullableText(reading['note'])
      && record(fleet) && Array.isArray(fleet['roles']) && fleet['roles'].every((role: unknown) => typeof role === 'string')
      && (fleet['reservePercent'] === null || (typeof fleet['reservePercent'] === 'number'
        && Number.isFinite(fleet['reservePercent']) && fleet['reservePercent'] >= 0 && fleet['reservePercent'] <= 100));
  });
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
      if (!isReadiness(raw)) throw new Error('Readiness response unavailable.');
      return { state: 'ready', available: true, value: raw };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && err.code === null) {
        return { state: 'unsupported', available: false, value: null };
      }
      // Failures retain the cache's last result and error; they are not a new
      // successful observation. Session expiry and cancellation also propagate.
      throw err;
    }
  },
};

/** While the drawer is open: seats and health ride their own 30 s polls; these are the drawer's own. */
export const RESOURCES_POLL_MS = { cloud: 60_000, local: 30_000, runtime: 15_000, readiness: 30_000 } as const;
