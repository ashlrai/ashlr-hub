/**
 * Shared request validation for the fleet-history worker (V3.10, A8). Lives in
 * its own tiny module so the worker entry does not import fleet-history.ts
 * (and with it the HTTP helpers) just to validate one message.
 */

export interface FleetHistoryWorkerPayload {
  /** Append a scorecard snapshot first if one is due. */
  snapshot: boolean;
  /** Trend points per window. */
  limit: number;
}

export const FLEET_HISTORY_WORKER_KIND = 'scorecard';
export const FLEET_HISTORY_WORKER_MAX_LIMIT = 400;

/** Throws on anything but `{snapshot: boolean, limit: 1..400}` for kind `scorecard`. */
export function normalizeFleetHistoryWorkerRequest(kind: unknown, payload: unknown): FleetHistoryWorkerPayload {
  if (kind !== FLEET_HISTORY_WORKER_KIND) throw new Error('unsupported fleet-history operation');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid payload');
  const value = payload as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'snapshot' && key !== 'limit')) throw new Error('invalid payload');
  if (typeof value.snapshot !== 'boolean') throw new Error('invalid payload');
  const limit = value.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > FLEET_HISTORY_WORKER_MAX_LIMIT) {
    throw new Error('invalid payload');
  }
  return { snapshot: value.snapshot, limit };
}
