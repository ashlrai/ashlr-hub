/** Terminal-only receipt archive. The host must authenticate and CAS-publish the
 * ENTIRE derived root, including failure pointers. Point/range checks validate
 * visited evidence, not completeness of arbitrarily supplied cross-index roots. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { types } from 'node:util';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readImmutablePrivateRecordPoint, writeImmutablePrivateRecord, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { captureOrderedImmutableIndexRoot, emptyOrderedImmutableIndexRoot, type OrderedImmutableIndexRoot } from '../util/ordered-immutable-index.js';
import { createOrderedImmutableIndexStore } from '../util/ordered-immutable-index-store.js';
import { checkedResourceTaskReceipt, type ResourceTaskReceipt } from './pool-receipt-codec.js';
import { validateResourcePoolConfigHistory } from './pool-evolution-policy.js';
import type { ResourcePoolConfigSnapshot } from './pool-evolution-types.js';
import type { ResourcePoolReceiptAccountWindow, ResourcePoolReceiptLookup } from './pool-receipt-query.js';
import { captureResourcePoolStateJson } from './pool-state-capture.js';

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_DATE = 8_640_000_000_000_000;
const DATE_OFFSET = 8_640_000_000_000_000n;
const TERMINAL = new Set(['completed', 'failed', 'timed-out', 'cancelled']);
export interface ResourcePoolReceiptArchiveRoot {
  schemaVersion: 1;
  byId: OrderedImmutableIndexRoot;
  byStart: OrderedImmutableIndexRoot;
  /** One exact qualifying failure pointer per historical capacity, never clock-pruned. */
  latestFailures: Array<{ capacityKey: string; id: string; finishedAtMs: number }>;
}
export interface ResourcePoolReceiptArchive {
  get(root: ResourcePoolReceiptArchiveRoot, id: string): ResourcePoolReceiptLookup;
  /** Bounded batch (at most 4096 IDs); not a lifetime archive limit. */
  getMany(root: ResourcePoolReceiptArchiveRoot, ids: readonly string[]): ResourcePoolReceiptLookup[];
  /** Archived terminal starts only. Runtime must add every reserved/uncertain root row. */
  accountWindow(root: ResourcePoolReceiptArchiveRoot, capacityKey: string, windowMs: number, nowMs: number): ResourcePoolReceiptAccountWindow;
  page(root: ResourcePoolReceiptArchiveRoot, options?: { afterId?: string; limit?: number }):
    { items: ResourceTaskReceipt[]; totalReceipts: number; nextAfterId: string | null };
  stage(root: ResourcePoolReceiptArchiveRoot, receipt: ResourceTaskReceipt, options: { guard(): void }):
    { root: ResourcePoolReceiptArchiveRoot; replayed: boolean };
}
export class ResourcePoolReceiptArchiveError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'UNAVAILABLE') {
    super(code === 'INVALID_INPUT' ? 'Invalid receipt archive input' : code === 'CONFLICT' ? 'Receipt archive identity conflict' : 'Receipt archive evidence unavailable');
    this.name = 'ResourcePoolReceiptArchiveError';
  }
}
function fail(code: ResourcePoolReceiptArchiveError['code'] = 'UNAVAILABLE'): never { throw new ResourcePoolReceiptArchiveError(code); }
function capture<T>(value: unknown): T {
  try { return JSON.parse(captureResourcePoolStateJson(value)) as T; } catch { return fail('INVALID_INPUT'); }
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function id(value: unknown): string {
  // Preserve existing receipt-ID semantics, including exact historically accepted bytes.
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) return fail('INVALID_INPUT');
  return value;
}
function hash(bytes: string): string { return createHash('sha256').update(bytes).digest('hex'); }
function idKey(value: string): string { return Buffer.from(id(value), 'utf8').toString('hex'); }
function capacityPrefix(value: string): string { return hash(`resource-receipt-capacity-v1\n${value}`) + '/'; }
function dateKey(value: number): string { return (BigInt(value) + DATE_OFFSET).toString().padStart(17, '0'); }
function startKey(receipt: ResourceTaskReceipt): string { return `${capacityPrefix(receipt.capacityKey)}${dateKey(Date.parse(receipt.startedAt))}:${idKey(receipt.id)}`; }
function qualifiesFailure(row: ResourceTaskReceipt): boolean {
  return (row.status === 'failed' || row.status === 'timed-out') &&
    !(row.status === 'failed' && row.reason === 'worker-dispatch-precondition-failed' && row.execution === undefined &&
      row.nativeProcess === undefined && row.outputDigest === null && row.inputTokens === null && row.outputTokens === null);
}
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; return fail(); }
}
function privateDirectory(path: string): BigIntStats {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) ||
      process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o700n ||
      !assurePrivateStoragePath(path, 'directory', 'inspect-existing', { anchorPath: dirname(path) }).ok) return fail();
    return stat;
  } catch { return fail(); }
}
/** Fresh directory checks, not cached permission evidence. The old empty-index
 * count adapter checked the identical pair twice without reading any nodes. */
function directoryFence(paths: readonly string[]): () => void {
  const identities = paths.map(privateDirectory);
  return () => {
    for (let index = 0; index < paths.length; index++) {
      const current = privateDirectory(paths[index]!); const original = identities[index]!;
      if (current.dev !== original.dev || current.ino !== original.ino) fail();
    }
  };
}
export function emptyResourcePoolReceiptArchiveRoot(): ResourcePoolReceiptArchiveRoot {
  return { schemaVersion: 1, byId: emptyOrderedImmutableIndexRoot(), byStart: emptyOrderedImmutableIndexRoot(), latestFailures: [] };
}

/** Existing private archive root only. Construction and every read have no storage effects. */
export function createResourcePoolReceiptArchive(input: { root: string; anchorPath: string; configurationHistory: ResourcePoolConfigSnapshot[] }): ResourcePoolReceiptArchive {
  const config = capture<typeof input>(input);
  if (!exact(config, ['root', 'anchorPath', 'configurationHistory'])) return fail('INVALID_INPUT');
  const history = validateResourcePoolConfigHistory(config.configurationHistory);
  const epochs = new Map(history.map(epoch => [epoch.poolDigest, epoch]));
  const capacities = new Set(history.flatMap(epoch => epoch.bindings.map(binding => binding.capacityKey)));
  // Retain the audited exact path/config validation; use an explicit fresh fence
  // rather than dispatching an empty index query at every archive boundary.
  createOrderedImmutableIndexStore({ root: config.root, anchorPath: config.anchorPath });
  const bound = directoryFence([config.anchorPath, config.root]);
  const indexRoot = join(config.root, 'index');
  let pinnedIndex: ReturnType<typeof createOrderedImmutableIndexStore> | undefined;
  // Only the handle is retained. Every index operation still checks private
  // storage afresh, and replacement of a previously observed index root refuses.
  const index = () => pinnedIndex ??= createOrderedImmutableIndexStore({ root: indexRoot, anchorPath: config.root });
  function terminal(value: unknown): ResourceTaskReceipt {
    const receipt = capture<ResourceTaskReceipt>(value);
    const epoch = epochs.get(receipt?.poolDigest);
    if (!epoch || !checkedResourceTaskReceipt(receipt, epoch.poolDigest, epoch.bindings, epoch.pool) || !TERMINAL.has(receipt.status)) return fail('INVALID_INPUT');
    if (Buffer.byteLength(payloadBytes(receipt)) > MAX_PAYLOAD_BYTES) return fail('INVALID_INPUT');
    return receipt;
  }
  function payloadBytes(receipt: ResourceTaskReceipt): string { return captureResourcePoolStateJson(receipt) + '\n'; }
  const payloadDigest = (receipt: ResourceTaskReceipt) => hash(`resource-terminal-receipt-v1\n${payloadBytes(receipt)}`);
  function payloadStore(expected: string): ImmutablePrivateRecordStoreConfig<ResourceTaskReceipt> {
    if (!/^[a-f0-9]{64}$/.test(expected)) return fail();
    const anchorPath = join(config.root, 'payloads', expected.slice(0, 2));
    const codec = {
      parse(value: unknown) { try { const receipt = terminal(value); return payloadDigest(receipt) === expected ? receipt : null; } catch { return null; } },
      serialize: payloadBytes, recordId: () => expected, recordFileName: () => `${expected}.json`,
      isRecordFileName: (name: string) => name === `${expected}.json`, stageToken: () => expected,
      equivalent: (left: ResourceTaskReceipt, right: ResourceTaskReceipt) => payloadBytes(left) === payloadBytes(right),
    };
    // One immutable object per bounded store, not a global historical file limit.
    return { label: 'Receipt archive payload', anchorPath, rootPath: join(anchorPath, expected), lockFileName: '.payload.lock',
      maxRecordBytes: MAX_PAYLOAD_BYTES, defaultMaxFiles: 1, hardMaxFiles: 1,
      defaultMaxBytes: MAX_PAYLOAD_BYTES, hardMaxBytes: MAX_PAYLOAD_BYTES, codecForRead: () => codec, codecForWrite: () => codec };
  }
  function payload(expected: string): ResourceTaskReceipt {
    bound();
    const store = payloadStore(expected);
    const ancestors = directoryFence([dirname(store.anchorPath), store.anchorPath]);
    const result = readImmutablePrivateRecordPoint(store, expected, `${expected}.json`);
    ancestors(); bound();
    if (result.sourceState !== 'healthy' || !result.exactReadComplete || !result.record) return fail();
    return result.record;
  }
  function rootValue(value: ResourcePoolReceiptArchiveRoot): ResourcePoolReceiptArchiveRoot {
    const root = capture<ResourcePoolReceiptArchiveRoot>(value);
    if (!exact(root, ['schemaVersion', 'byId', 'byStart', 'latestFailures']) || root.schemaVersion !== 1 || !Array.isArray(root.latestFailures) ||
      root.latestFailures.length > capacities.size) return fail('INVALID_INPUT');
    root.byId = captureOrderedImmutableIndexRoot(root.byId); root.byStart = captureOrderedImmutableIndexRoot(root.byStart);
    if (root.byId.count !== root.byStart.count) return fail('INVALID_INPUT');
    const seen = new Set<string>();
    for (const pointer of root.latestFailures) {
      if (!exact(pointer, ['capacityKey', 'id', 'finishedAtMs']) || !capacities.has(pointer.capacityKey) || seen.has(pointer.capacityKey) ||
        typeof pointer.finishedAtMs !== 'number' || !Number.isSafeInteger(pointer.finishedAtMs) || Math.abs(pointer.finishedAtMs) > MAX_DATE) return fail('INVALID_INPUT');
      id(pointer.id); seen.add(pointer.capacityKey);
    }
    return root;
  }
  function get(root: ResourcePoolReceiptArchiveRoot, requested: string): ResourcePoolReceiptLookup {
    const taskId = id(requested);
    if (root.byId.nodeDigest === null) return { status: 'proven-absent', id: taskId };
    const found = index().lookup(root.byId, idKey(taskId));
    if (!found.found) return { status: 'proven-absent', id: taskId };
    const receipt = payload(found.valueDigest);
    if (receipt.id !== taskId) return fail();
    const started = index().lookup(root.byStart, startKey(receipt));
    if (!started.found || started.valueDigest !== found.valueDigest) return fail();
    return { status: 'found', id: taskId, receipt };
  }
  function verifiedRoot(value: ResourcePoolReceiptArchiveRoot): ResourcePoolReceiptArchiveRoot {
    bound(); const root = rootValue(value);
    for (const pointer of root.latestFailures) {
      const found = get(root, pointer.id);
      if (found.status !== 'found' || found.receipt.capacityKey !== pointer.capacityKey || !qualifiesFailure(found.receipt) ||
        Date.parse(found.receipt.finishedAt!) !== pointer.finishedAtMs) return fail();
    }
    bound(); return root;
  }
  function read<T>(rootInput: ResourcePoolReceiptArchiveRoot, operation: (root: ResourcePoolReceiptArchiveRoot) => T): T {
    try { const result = operation(verifiedRoot(rootInput)); bound(); return result; }
    catch (error) { if (error instanceof ResourcePoolReceiptArchiveError) throw error; return fail(); }
  }
  return {
    get: (root, requested) => read(root, captured => get(captured, requested)),
    getMany(root, values) {
      const ids = capture<string[]>(values); if (!Array.isArray(ids) || ids.length > 4096) return fail('INVALID_INPUT');
      ids.forEach(id); return read(root, captured => ids.map(requested => get(captured, requested)));
    },
    accountWindow(rootInput, capacityKey, windowMs, nowMs) {
      if (!capacities.has(capacityKey) || !Number.isSafeInteger(windowMs) || windowMs < 1 || typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return fail('INVALID_INPUT');
      return read(rootInput, root => {
        let recentReservationCount = 0; let earliestRecentStartedAtMs: number | null = null;
        const cutoff = nowMs - windowMs;
        if (root.byStart.nodeDigest !== null && cutoff < MAX_DATE) {
          const prefix = capacityPrefix(capacityKey);
          const bounds = { gt: cutoff < -MAX_DATE ? prefix : `${prefix}${dateKey(Math.floor(cutoff))}:~`, lt: prefix.slice(0, -1) + '0' };
          const page = index().page(root.byStart, { ...bounds, limit: 1 });
          recentReservationCount = page.totalMatches;
          if (page.items[0]) {
            const receipt = payload(page.items[0].valueDigest);
            if (receipt.capacityKey !== capacityKey || page.items[0].key !== startKey(receipt)) return fail();
            const found = get(root, receipt.id);
            if (found.status !== 'found' || payloadDigest(found.receipt) !== page.items[0].valueDigest) return fail();
            earliestRecentStartedAtMs = Date.parse(receipt.startedAt);
          }
        }
        return { inFlightCount: 0, recentReservationCount, earliestRecentStartedAtMs,
          latestCooldownFailureFinishedAtMs: root.latestFailures.find(row => row.capacityKey === capacityKey)?.finishedAtMs ?? null };
      });
    },
    page(rootInput, value = {}) {
      const options = capture<{ afterId?: string; limit?: number }>(value);
      if (options === null || typeof options !== 'object' || Array.isArray(options)) return fail('INVALID_INPUT');
      if (!exact(options, ['afterId', 'limit'].filter(key => Object.hasOwn(options, key)))) return fail('INVALID_INPUT');
      const limit = options.limit ?? 64;
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) return fail('INVALID_INPUT');
      const after = options.afterId === undefined ? undefined : idKey(options.afterId);
      return read(rootInput, root => {
        if (root.byId.nodeDigest === null) return { items: [], totalReceipts: 0, nextAfterId: null };
        const page = index().page(root.byId, { ...(after === undefined ? {} : { gt: after }), limit });
        const items = page.items.map(row => {
          const receipt = payload(row.valueDigest); if (idKey(receipt.id) !== row.key) return fail();
          const found = get(root, receipt.id); if (found.status !== 'found') return fail(); return found.receipt;
        });
        return { items, totalReceipts: root.byId.count, nextAfterId: page.nextAfter === null ? null : items.at(-1)!.id };
      });
    },
    stage(rootInput, value, optionsInput) {
      const root = verifiedRoot(rootInput); const receipt = terminal(value);
      if (!optionsInput || typeof optionsInput !== 'object' || types.isProxy(optionsInput) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(optionsInput)) || Reflect.ownKeys(optionsInput).length !== 1) return fail('INVALID_INPUT');
      const guardDescriptor = Object.getOwnPropertyDescriptor(optionsInput, 'guard');
      if (!guardDescriptor?.enumerable || !('value' in guardDescriptor) || typeof guardDescriptor.value !== 'function') return fail('INVALID_INPUT');
      const hostGuard = guardDescriptor.value as () => unknown;
      function guarded() {
        bound(); let result: unknown;
        try { result = hostGuard(); } catch { return fail(); }
        if (types.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
        if (result !== undefined) return fail(); bound();
      }
      guarded();
      const lock = acquireLocalStoreLock(join(config.root, '.receipt-archive.lock'), 500, { anchorPath: config.anchorPath, exactPrivateStorage: true });
      if (!lock) return fail();
      let result: { root: ResourcePoolReceiptArchiveRoot; replayed: boolean } | undefined; let failed = false;
      try {
        const guard = () => { guarded(); if (!ownsLocalStoreLock(lock)) fail(); };
        guard(); verifiedRoot(root);
        const previous = get(root, receipt.id);
        if (previous.status === 'found') {
          if (payloadBytes(previous.receipt) !== payloadBytes(receipt)) fail('CONFLICT');
          result = { root, replayed: true };
        } else {
          const expected = payloadDigest(receipt); const store = payloadStore(expected);
          for (const directory of [indexRoot, join(config.root, 'payloads'), store.anchorPath]) {
            guard(); inspectPrivateDirectory(dirname(directory));
            if (!present(directory)) mkdirSync(directory, { mode: 0o700 });
            inspectPrivateDirectory(directory);
            privateDirectory(dirname(directory)); privateDirectory(directory);
            fsyncDirectory(dirname(directory)); guard();
          }
          const disposition = writeImmutablePrivateRecord(store, receipt, { prepublish: () => {
            guard();
            privateDirectory(dirname(store.anchorPath)); privateDirectory(store.anchorPath);
            return true;
          } });
          if (!['recorded', 'replayed'].includes(disposition) || present(join(store.rootPath, store.lockFileName))) fail();
          guard(); if (payloadBytes(payload(expected)) !== payloadBytes(receipt)) fail();
          const byId = index().stage(root.byId, { key: idKey(receipt.id), valueDigest: expected }, { guard }).root;
          const byStart = index().stage(root.byStart, { key: startKey(receipt), valueDigest: expected }, { guard }).root;
          const latestFailures = root.latestFailures.map(row => ({ ...row }));
          if (qualifiesFailure(receipt)) {
            const previousFailure = latestFailures.find(row => row.capacityKey === receipt.capacityKey);
            const finishedAtMs = Date.parse(receipt.finishedAt!);
            if (!previousFailure) latestFailures.push({ capacityKey: receipt.capacityKey, id: receipt.id, finishedAtMs });
            else if (finishedAtMs > previousFailure.finishedAtMs) Object.assign(previousFailure, { id: receipt.id, finishedAtMs });
          }
          latestFailures.sort((a, b) => a.capacityKey < b.capacityKey ? -1 : a.capacityKey > b.capacityKey ? 1 : 0);
          const next = verifiedRoot({ schemaVersion: 1, byId, byStart, latestFailures });
          const saved = get(next, receipt.id); if (saved.status !== 'found' || payloadBytes(saved.receipt) !== payloadBytes(receipt)) fail();
          guard(); result = { root: next, replayed: false };
        }
        guard();
        // No host callback follows this final dependency readback. A callback
        // may invalidate newly staged evidence even while root custody survives.
        if (result === undefined) fail();
        verifiedRoot(result.root);
        const finalReceipt = get(result.root, receipt.id);
        if (finalReceipt.status !== 'found' || payloadBytes(finalReceipt.receipt) !== payloadBytes(receipt)) fail();
      } catch (error) {
        if (error instanceof ResourcePoolReceiptArchiveError && error.code === 'CONFLICT') {
          if (!releaseLocalStoreLock(lock)) return fail(); throw error;
        }
        failed = true;
      }
      if (!releaseLocalStoreLock(lock) || failed || result === undefined) return fail();
      return result;
    },
  };
}
