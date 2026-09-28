/**
 * routes/verse/fleet/fleet-control-queries.ts — reads and writes behind the
 * Fleet control surface (3.15):
 *
 *   GET  /api/verse/fleet/control               FleetControlStateV1
 *   GET  /api/verse/fleet/control/queue         FleetControlQueueV1
 *   GET  /api/verse/fleet/control/runs/<id>/log FleetRunLogV1
 *   POST /api/verse/fleet/control               one FleetControlAction
 *   POST /api/verse/leader/directives           a Leader directive
 *
 * Reads are optional like every surface read (a server without the route is
 * "not available here", never a broken page). Writes pull the held mutation
 * token and invalidate exactly what they change.
 */
import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { refreshActivity } from '../shell/useActivity.js';
import { SURFACE_KEYS, optionalQuery } from '../command/surface-data.js';
import type {
  FleetControlAction,
  FleetControlActionResultV1,
  FleetControlQueueV1,
  FleetControlStateV1,
  FleetRunLogV1,
} from '../../../../core/fleet/fleet-control-types.js';

export const FLEET_CONTROL_PATH = '/api/verse/fleet/control';
export const FLEET_CONTROL_QUEUE_PATH = '/api/verse/fleet/control/queue';
export const LEADER_DIRECTIVES_PATH = '/api/verse/leader/directives';

export const FLEET_CONTROL_KEYS = Object.freeze({
  state: 'verse-fleet-control',
  queue: 'verse-fleet-control-queue',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function narrowFleetControl(raw: unknown): FleetControlStateV1 | null {
  return isRecord(raw) && raw['v'] === 1 && typeof raw['state'] === 'string' && typeof raw['headline'] === 'string'
    && isRecord(raw['controls']) && isRecord(raw['grant']) && isRecord(raw['daemon'])
    ? (raw as unknown as FleetControlStateV1)
    : null;
}

export function narrowFleetQueue(raw: unknown): FleetControlQueueV1 | null {
  return isRecord(raw) && raw['v'] === 1 && Array.isArray(raw['tasks']) && Array.isArray(raw['goals']) && isRecord(raw['targets'])
    ? (raw as unknown as FleetControlQueueV1)
    : null;
}

export const fleetControlQuery = optionalQuery(FLEET_CONTROL_KEYS.state, FLEET_CONTROL_PATH, 'The fleet controls', narrowFleetControl);
export const fleetQueueQuery = optionalQuery(FLEET_CONTROL_KEYS.queue, FLEET_CONTROL_QUEUE_PATH, 'The fleet queue', narrowFleetQueue);

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

/** One control action; the answer carries the state READ BACK after it. */
export async function postFleetControl(action: FleetControlAction): Promise<FleetControlActionResultV1> {
  const result = await post<FleetControlActionResultV1>(FLEET_CONTROL_PATH, action);
  invalidate(FLEET_CONTROL_KEYS.state);
  invalidate(FLEET_CONTROL_KEYS.queue);
  invalidate(SURFACE_KEYS.fleetLive);
  invalidate(SURFACE_KEYS.authority);
  void refreshActivity();
  return result;
}

export async function fetchRunLog(runId: string, signal?: AbortSignal): Promise<FleetRunLogV1> {
  return apiGet<FleetRunLogV1>(`${FLEET_CONTROL_PATH}/runs/${encodeURIComponent(runId)}/log`, signal);
}

export async function postLeaderDirective(text: string): Promise<unknown> {
  const result = await post<unknown>(LEADER_DIRECTIVES_PATH, { text });
  invalidate(SURFACE_KEYS.leader);
  return result;
}
