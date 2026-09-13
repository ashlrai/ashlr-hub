/** Internal queries over a caller-validated, complete receipt snapshot.
 * This is not a decoder, storage reader, custody proof, or admission authority.
 * In particular, proven-absent means absent from this captured input only: the
 * caller must separately establish that the input is the complete legacy ledger.
 */
import { types } from 'node:util';
import type { ResourceTaskReceipt } from './pool-receipt-codec.js';

export type ResourcePoolReceiptLookup =
  | { status: 'found'; id: string; receipt: ResourceTaskReceipt }
  | { status: 'proven-absent'; id: string };
export interface ResourcePoolReceiptAccountWindow {
  inFlightCount: number;
  recentReservationCount: number;
  earliestRecentStartedAtMs: number | null;
  latestCooldownFailureFinishedAtMs: number | null;
}
export interface ResourcePoolReceiptQuery {
  get(id: string): ResourcePoolReceiptLookup;
  /** One result per requested ID, in request order (including repeated IDs). */
  getMany(ids: readonly string[]): ResourcePoolReceiptLookup[];
  /** Complete reserved/uncertain set from this snapshot, in original order. */
  unresolved(capacityKey?: string): ResourceTaskReceipt[];
  accountWindow(capacityKey: string, windowMs: number, nowMs: number): ResourcePoolReceiptAccountWindow;
}
type Account = { starts: number[]; unresolved: ResourceTaskReceipt[]; latestFailure: number | null };
function invalid(): never { throw new Error('Resource receipt query unavailable'); }
// Match the existing receipt codec; query extraction does not migrate identities.
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const statuses = new Set(['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain']);

/** No whole-history byte/node/count ceiling. Depth bounds JSON receipt shape,
 * not lifetime execution. Inspect descriptors before cloning can evaluate them. */
function assertData(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 32) invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return; }
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalid();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) invalid();
  ancestors.add(value);
  try {
    if (array) {
      const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) invalid();
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
        assertData(descriptor.value, depth + 1, ancestors);
      }
    } else for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      assertData(descriptor.value, depth + 1, ancestors);
    }
  } finally { ancestors.delete(value); }
}

function firstAfter(sorted: readonly number[], exclusive: number): number {
  let low = 0; let high = sorted.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (sorted[middle]! <= exclusive) low = middle + 1; else high = middle;
  }
  return low;
}

/** Pure legacy-array adapter; all indexes are built once. Returned receipts are
 * detached again, so neither input nor result mutation changes later queries.
 * Epoch/domain validation remains with checkedResourceTaskReceipt/storage. */
export function createResourcePoolReceiptQuery(receipts: readonly ResourceTaskReceipt[]): ResourcePoolReceiptQuery {
  const byId = new Map<string, ResourceTaskReceipt>();
  const accounts = new Map<string, Account>();
  const unresolved: ResourceTaskReceipt[] = [];
  try {
    assertData(receipts);
    if (!Array.isArray(receipts)) invalid();
    const captured = structuredClone(receipts);
    for (const row of captured) {
      // Indexing preconditions only; do not imply fresh receipt/epoch proof.
      if (!row || !validId(row.id) || !validId(row.capacityKey) || byId.has(row.id) || !statuses.has(row.status) ||
        !validTime(row.startedAt) || row.finishedAt !== null && !validTime(row.finishedAt) ||
        (row.status === 'failed' || row.status === 'timed-out') && row.finishedAt === null) invalid();
      byId.set(row.id, row);
      let account = accounts.get(row.capacityKey);
      if (!account) { account = { starts: [], unresolved: [], latestFailure: null }; accounts.set(row.capacityKey, account); }
      account.starts.push(Date.parse(row.startedAt));
      if (row.status === 'reserved' || row.status === 'uncertain') { unresolved.push(row); account.unresolved.push(row); }
      // Preserve the exact exception: reservation still counts, but a pristine
      // host dispatch-precondition veto does not create a provider cooldown.
      if ((row.status === 'failed' || row.status === 'timed-out') &&
        !(row.status === 'failed' && row.reason === 'worker-dispatch-precondition-failed' && row.execution === undefined &&
          row.nativeProcess === undefined && row.outputDigest === null && row.inputTokens === null && row.outputTokens === null)) {
        const finished = Date.parse(row.finishedAt!);
        account.latestFailure = account.latestFailure === null ? finished : Math.max(account.latestFailure, finished);
      }
    }
    for (const account of accounts.values()) account.starts.sort((left, right) => left - right);
  } catch { invalid(); }
  const get = (id: string): ResourcePoolReceiptLookup => {
    if (!validId(id)) invalid();
    const receipt = byId.get(id);
    return receipt ? { status: 'found', id, receipt: structuredClone(receipt) } : { status: 'proven-absent', id };
  };
  return Object.freeze({
    get,
    getMany(ids: readonly string[]): ResourcePoolReceiptLookup[] {
      try { assertData(ids); if (!Array.isArray(ids) || !ids.every(validId)) invalid(); }
      catch { invalid(); }
      return ids.map(get);
    },
    unresolved(capacityKey?: string): ResourceTaskReceipt[] {
      if (capacityKey !== undefined && !validId(capacityKey)) invalid();
      return structuredClone(capacityKey === undefined ? unresolved : accounts.get(capacityKey)?.unresolved ?? []);
    },
    accountWindow(capacityKey: string, windowMs: number, nowMs: number): ResourcePoolReceiptAccountWindow {
      if (!validId(capacityKey) || !Number.isSafeInteger(windowMs) || windowMs < 1 || typeof nowMs !== 'number' || !Number.isFinite(nowMs)) invalid();
      const account = accounts.get(capacityKey);
      const first = account ? firstAfter(account.starts, nowMs - windowMs) : 0;
      return { inFlightCount: account?.unresolved.length ?? 0, recentReservationCount: account ? account.starts.length - first : 0,
        earliestRecentStartedAtMs: account?.starts[first] ?? null, latestCooldownFailureFinishedAtMs: account?.latestFailure ?? null };
    },
  });
}
