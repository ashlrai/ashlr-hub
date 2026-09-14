/** Internal composition over an immutable archive root and validated hot rows.
 * Storage owns epoch validation/root custody; this adapter grants no admission
 * authority and never treats a recent page as complete historical evidence. */
import { types } from 'node:util';
import type { ResourcePoolReceiptArchive, ResourcePoolReceiptArchiveRoot } from './pool-receipt-archive.js';
import type { ResourceTaskReceipt } from './pool-receipt-codec.js';
import { createResourcePoolReceiptQuery, type ResourcePoolReceiptAccountWindow,
  type ResourcePoolReceiptLookup, type ResourcePoolReceiptQuery } from './pool-receipt-query.js';
import { captureResourcePoolStateJson } from './pool-state-capture.js';

const unavailable = (): never => { throw new Error('Resource receipt query unavailable'); };
function capture<T>(value: unknown): T {
  try { return JSON.parse(captureResourcePoolStateJson(value)) as T; } catch { return unavailable(); }
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function call<T>(operation: () => T): T {
  try {
    const value = operation();
    if (types.isPromise(value)) { void Promise.prototype.then.call(value, undefined, () => {}); return unavailable(); }
    return value;
  } catch { return unavailable(); }
}
function result(value: unknown, id: string): ResourcePoolReceiptLookup {
  const row = capture<ResourcePoolReceiptLookup>(value);
  if (row?.id !== id) return unavailable();
  if (row.status === 'proven-absent' && exact(row, ['status', 'id'])) return row;
  if (row.status !== 'found' || !exact(row, ['status', 'id', 'receipt']) || row.receipt?.id !== id ||
    !['completed', 'failed', 'timed-out', 'cancelled'].includes(row.receipt.status)) return unavailable();
  // Indexing validation only; the archive is responsible for original-epoch proof.
  return createResourcePoolReceiptQuery([row.receipt]).get(id);
}
function batch(value: unknown, ids: readonly string[]): ResourcePoolReceiptLookup[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== ids.length || Reflect.ownKeys(value).length !== ids.length + 1) return unavailable();
  return ids.map((id, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return unavailable();
    return result(descriptor.value, id);
  });
}
function summary(value: unknown, cutoff: number): ResourcePoolReceiptAccountWindow {
  const row = capture<ResourcePoolReceiptAccountWindow>(value);
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
  if (!exact(row, ['inFlightCount', 'recentReservationCount', 'earliestRecentStartedAtMs', 'latestCooldownFailureFinishedAtMs']) ||
    row.inFlightCount !== 0 || !count(row.recentReservationCount) ||
    (row.recentReservationCount === 0 ? row.earliestRecentStartedAtMs !== null :
      !time(row.earliestRecentStartedAtMs) || row.earliestRecentStartedAtMs <= cutoff) ||
    row.latestCooldownFailureFinishedAtMs !== null && !time(row.latestCooldownFailureFinishedAtMs)) return unavailable();
  return row;
}

export function createArchivedResourcePoolReceiptQuery(input: {
  /** Compatibility name: the bounded hot projection may contain every receipt
   * status. Only reserved/uncertain rows contribute to unresolved occupancy. */
  active: readonly ResourceTaskReceipt[];
  archive: ResourcePoolReceiptArchive;
  root: ResourcePoolReceiptArchiveRoot;
}): ResourcePoolReceiptQuery {
  if (!input || typeof input !== 'object' || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 3) return unavailable();
  const fields = ['active', 'archive', 'root'].map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return unavailable();
    return descriptor.value;
  });
  const root = capture<ResourcePoolReceiptArchiveRoot>(fields[2]);
  const hotRows = capture<ResourceTaskReceipt[]>(fields[0]);
  if (!Array.isArray(hotRows) || hotRows.length > 4096) return unavailable();
  // Capture and validate the ENTIRE hot projection before any archive callback.
  // Storage still owns the receipt-domain/epoch validation of these rows.
  const hotReceipts = createResourcePoolReceiptQuery(hotRows);
  // The package-internal archive is a trusted synchronous implementation, not
  // a user plugin. Detach the root even from its per-call argument objects.
  const archive = fields[1] as ResourcePoolReceiptArchive;
  const ids = hotRows.map(row => row.id);
  const absence = batch(call(() => archive.getMany(structuredClone(root), [...ids])), ids);
  if (absence.some(row => row.status !== 'proven-absent')) return unavailable();

  const get = (id: string): ResourcePoolReceiptLookup => {
    const hot = hotReceipts.get(id);
    if (hot.status === 'found') return hot;
    return result(call(() => archive.get(structuredClone(root), id)), id);
  };
  return Object.freeze({
    get,
    getMany(requested: readonly string[]): ResourcePoolReceiptLookup[] {
      const hot = hotReceipts.getMany(requested); // Captures/validates IDs before archive calls.
      const missing = [...new Set(hot.filter(row => row.status === 'proven-absent').map(row => row.id))];
      if (!missing.length) return hot;
      const cold: ResourcePoolReceiptLookup[] = [];
      // This is a request-batch ceiling, never a lifetime history ceiling. All
      // chunks address the same captured immutable root, not moving pages.
      for (let offset = 0; offset < missing.length; offset += 4096) {
        const ids = missing.slice(offset, offset + 4096);
        cold.push(...batch(call(() => archive.getMany(structuredClone(root), [...ids])), ids));
      }
      const byId = new Map(cold.map(row => [row.id, row]));
      return hot.map(row => row.status === 'found' ? row : structuredClone(byId.get(row.id)!));
    },
    unresolved: hotReceipts.unresolved,
    accountWindow(capacityKey: string, windowMs: number, nowMs: number): ResourcePoolReceiptAccountWindow {
      const hot = hotReceipts.accountWindow(capacityKey, windowMs, nowMs);
      const cold = summary(call(() => archive.accountWindow(structuredClone(root), capacityKey, windowMs, nowMs)), nowMs - windowMs);
      const recentReservationCount = hot.recentReservationCount + cold.recentReservationCount;
      if (!Number.isSafeInteger(recentReservationCount)) return unavailable();
      const min = (left: number | null, right: number | null) => left === null ? right : right === null ? left : Math.min(left, right);
      const max = (left: number | null, right: number | null) => left === null ? right : right === null ? left : Math.max(left, right);
      return { inFlightCount: hot.inFlightCount, recentReservationCount,
        earliestRecentStartedAtMs: min(hot.earliestRecentStartedAtMs, cold.earliestRecentStartedAtMs),
        latestCooldownFailureFinishedAtMs: max(hot.latestCooldownFailureFinishedAtMs, cold.latestCooldownFailureFinishedAtMs) };
    },
  });
}
