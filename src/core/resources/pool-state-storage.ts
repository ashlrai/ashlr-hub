/** Versioned receipt storage projection. Only the owning runtime may select a
 * header, under its source/lease guard; staging alone never migrates a ledger. */
import { createHash } from 'node:crypto';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { types } from 'node:util';
import { decodeResourcePoolState, type ResourcePoolState } from './pool-runtime.js';
import { resourcePoolConfigSnapshot } from './pool-evolution-policy.js';
import { captureResourcePoolStateJson } from './pool-state-capture.js';
import { createResourcePoolReceiptQuery, type ResourcePoolReceiptQuery } from './pool-receipt-query.js';
import { createArchivedResourcePoolReceiptQuery } from './pool-archived-receipt-query.js';
import { createResourcePoolReceiptArchive } from './pool-receipt-archive.js';
import { createResourcePoolReceiptArchiveCertifier, type ResourcePoolReceiptArchiveCertificate } from './pool-receipt-archive-certificate.js';
import type { ResourcePool } from './pool-policy.js';
import type { ResourceBinding } from './worker.js';

const MAX_BYTES = 4 * 1024 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'timed-out', 'cancelled']);
export interface ResourcePoolArchiveHeader {
  schemaVersion: 3;
  kind: 'resource-pool-archive-header';
  /** Bounded mixed projection: every unarchived receipt, not only active work. */
  hotState: ResourcePoolState;
  archiveCertificate: ResourcePoolReceiptArchiveCertificate;
}
export type ResourcePoolStoredState = ResourcePoolState | ResourcePoolArchiveHeader;
export interface ResourcePoolStorageOptions {
  root: string;
  pool: ResourcePool;
  bindings: ResourceBinding[];
  /** Explicit existing private key; never discovered, created or repaired. */
  archiveKeyFile?: string;
}
export interface ResourcePoolStorageView {
  readonly source: ResourcePoolStoredState;
  readonly sourceDigest: string;
  readonly hotState: ResourcePoolState;
  readonly receipts: ResourcePoolReceiptQuery;
  /** Archive/key custody only, NOT current source-header identity or authority. */
  isCurrent(): boolean;
}
type Capture = { sourceJson: string; options: ResourcePoolStorageOptions; current(): boolean };
const captures = new WeakMap<ResourcePoolStorageView, Capture>();
function fail(): never { throw new Error('Resource pool storage unavailable'); }
function encode(value: unknown): string {
  try {
    const text = captureResourcePoolStateJson(value);
    if (Buffer.byteLength(text + '\n') > MAX_BYTES) return fail();
    return text;
  } catch { return fail(); }
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value &&
    value !== parse(value).root && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
function options(value: ResourcePoolStorageOptions): ResourcePoolStorageOptions {
  const copy = JSON.parse(encode(value)) as ResourcePoolStorageOptions;
  if (!exact(copy, ['root', 'pool', 'bindings', ...(Object.hasOwn(copy, 'archiveKeyFile') ? ['archiveKeyFile'] : [])]) ||
    !path(copy.root) || Object.hasOwn(copy, 'archiveKeyFile') && !path(copy.archiveKeyFile)) return fail();
  const active = resourcePoolConfigSnapshot(copy.pool, copy.bindings);
  return { root: copy.root, pool: active.pool, bindings: active.bindings,
    ...(copy.archiveKeyFile === undefined ? {} : { archiveKeyFile: copy.archiveKeyFile }) };
}
function archiveConfig(config: ResourcePoolStorageOptions, state: ResourcePoolState) {
  if (!config.archiveKeyFile || !state.configurationHistory) return fail();
  return { root: join(config.root, 'receipt-archive'), anchorPath: config.root, poolId: config.pool.id,
    configurationHistory: state.configurationHistory, keyFile: config.archiveKeyFile };
}
function guardedQuery(query: ResourcePoolReceiptQuery, current: () => boolean, capacities: ReadonlySet<string>): ResourcePoolReceiptQuery {
  const empty = createResourcePoolReceiptQuery([]);
  const read = <T>(action: () => T): T => {
    if (!current()) return fail();
    const result = action();
    if (!current()) return fail();
    return result;
  };
  return Object.freeze({
    get: (id: string) => read(() => query.get(id)),
    getMany: (ids: readonly string[]) => read(() => query.getMany(ids)),
    unresolved: (capacity?: string) => read(() => query.unresolved(capacity)),
    // Every hot/cold receipt is checked against the captured configuration
    // history. An unknown capacity is therefore proven empty; retain the
    // legacy query's argument validation without asking the archive to accept
    // a capacity outside its enrolled inventory.
    accountWindow: (capacity: string, window: number, now: number) => read(() =>
      (capacities.has(capacity) ? query : empty).accountWindow(capacity, window, now)),
  });
}

/** Reads caller-supplied header bytes. The caller still pins the active file and
 * owns source freshness. Neither legacy reads nor archive reads provision storage. */
export function readResourcePoolStorage(value: unknown, settings: ResourcePoolStorageOptions): ResourcePoolStorageView {
  try {
    const config = options(settings); const sourceJson = encode(value);
    const source = JSON.parse(sourceJson) as ResourcePoolStoredState;
    let hotState: ResourcePoolState; let query: ResourcePoolReceiptQuery; let current = () => true;
    if (source.schemaVersion === 3) {
      if (!exact(source, ['schemaVersion', 'kind', 'hotState', 'archiveCertificate']) ||
        source.kind !== 'resource-pool-archive-header' || source.hotState?.schemaVersion !== 2) return fail();
      hotState = decodeResourcePoolState(source.hotState, config.pool, config.bindings);
      const enrollment = archiveConfig(config, hotState);
      const certifier = createResourcePoolReceiptArchiveCertifier(enrollment);
      const certificate = certifier.verify(source.archiveCertificate);
      const archive = createResourcePoolReceiptArchive({ root: enrollment.root, anchorPath: enrollment.anchorPath,
        configurationHistory: enrollment.configurationHistory });
      query = createArchivedResourcePoolReceiptQuery({ active: hotState.attempts, archive, root: certificate.archiveRoot });
      current = () => { try { certifier.verify(certificate); return true; } catch { return false; } };
      query = guardedQuery(query, current, new Set(enrollment.configurationHistory.flatMap(epoch => epoch.bindings.map(row => row.capacityKey))));
    } else {
      hotState = decodeResourcePoolState(source, config.pool, config.bindings);
      query = createResourcePoolReceiptQuery(hotState.attempts);
    }
    const view: ResourcePoolStorageView = Object.freeze({ source: structuredClone(source),
      sourceDigest: createHash('sha256').update(sourceJson).digest('hex'), hotState: structuredClone(hotState),
      receipts: query, isCurrent: current });
    captures.set(view, { sourceJson, options: config, current });
    return view;
  } catch { return fail(); }
}

/** Stage at most eight exact hot terminal rows. Unselected rows, including
 * unfinished work, remain byte-equivalent and in order. The returned header is
 * NOT installed. Host must recheck source/lease and settlement headroom at CAS. */
export function stageResourcePoolReceiptCompaction(view: ResourcePoolStorageView, selectedIds: readonly string[],
  hooks: { guard(): void }): ResourcePoolArchiveHeader {
  try {
    const captured = captures.get(view); if (!captured || !captured.current()) return fail();
    const ids = JSON.parse(encode(selectedIds)) as string[];
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 ||
      ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) return fail();
    if (!hooks || typeof hooks !== 'object' || types.isProxy(hooks) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(hooks)) || Reflect.ownKeys(hooks).length !== 1) return fail();
    const descriptor = Object.getOwnPropertyDescriptor(hooks, 'guard');
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') return fail();
    const callback = descriptor.value as () => unknown;
    const guard = () => {
      if (!captured.current()) return fail();
      const result = callback();
      if (types.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      if (result !== undefined) fail();
      if (!captured.current()) fail();
    };
    const original = readResourcePoolStorage(JSON.parse(captured.sourceJson), captured.options);
    const source = original.source; const hot = original.hotState;
    const byId = new Map(hot.attempts.map(row => [row.id, row]));
    const receipts = ids.map(id => {
      const row = byId.get(id); if (!row || !TERMINAL.has(row.status)) return fail();
      return row;
    });
    const history = hot.configurationHistory ?? [resourcePoolConfigSnapshot(captured.options.pool, captured.options.bindings)];
    const selected = new Set(ids);
    // Validate the actual compacted projection, not an oversized intermediate
    // that adds epoch metadata before releasing the selected terminal rows.
    const next = decodeResourcePoolState({ ...hot, schemaVersion: 2, configurationHistory: history,
      attempts: hot.attempts.filter(row => !selected.has(row.id)) },
      captured.options.pool, captured.options.bindings);
    const certifier = createResourcePoolReceiptArchiveCertifier(archiveConfig(captured.options, next));
    const certificate = certifier.derive({ previous: source.schemaVersion === 3 ? source.archiveCertificate : null,
      sourceStateDigest: original.sourceDigest, receipts }, { guard });
    const candidate: ResourcePoolArchiveHeader = { schemaVersion: 3, kind: 'resource-pool-archive-header',
      hotState: next, archiveCertificate: certificate };
    // Final host callback precedes final dependency readback. Never accept a
    // candidate whose archive or key changed while its source guard ran.
    guard();
    certifier.verify(certificate);
    const checked = readResourcePoolStorage(candidate, captured.options);
    for (const row of receipts) {
      const found = checked.receipts.get(row.id);
      if (found.status !== 'found' || encode(found.receipt) !== encode(row)) return fail();
    }
    certifier.verify(certificate);
    if (!captured.current() || !checked.isCurrent()) return fail();
    return structuredClone(candidate);
  } catch { return fail(); }
}
