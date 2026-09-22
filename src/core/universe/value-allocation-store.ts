/** Private durable allocation evidence; neither an allocation ID nor a signature is a lease. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { canonical, digest, inspectPrivateDirectory } from './artifacts.js';
import type { DecisionTraceKeyOptions, DecisionTraceV1 } from './decision-trace.js';
import { verifyValueAllocationReceipt, type ValueAllocationReceiptV1 } from './value-allocation.js';

const DOMAIN = 'ashlr:universe:value-allocation-store:v1\n';
const MAX_RECORDS = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
export interface StoredValueAllocationV1 {
  schemaVersion: 1;
  kind: 'stored-value-allocation';
  allocationId: string;
  receipt: ValueAllocationReceiptV1;
  trace: DecisionTraceV1;
  provenanceSig: string;
}
export interface ValueAllocationStoreRead {
  sourceState: 'healthy' | 'missing' | 'degraded';
  complete: boolean;
  records: StoredValueAllocationV1[];
  bytesRead: number;
  reasons: string[];
}
interface KeyContext { key: Buffer; options: DecisionTraceKeyOptions; current(): boolean }

function exact(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return required.every((key) => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === 'string' && [...required, ...optional].includes(key) && descriptor.enumerable && 'value' in descriptor;
  });
}
function rootPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value && parse(value).root !== value &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159);
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function snapshot(value: unknown): unknown {
  let nodes = 0;
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 30_000 || depth > 32) throw new Error('Allocation record exceeds bounds');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && Buffer.byteLength(item) <= MAX_RECORD_BYTES) return item;
    if (!item || typeof item !== 'object') throw new Error('Allocation data invalid');
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 4096 || Reflect.ownKeys(item).length !== item.length + 1) throw new Error('Allocation array invalid');
      return Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Allocation data invalid');
        return copy(descriptor.value, depth + 1);
      });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('Allocation data invalid');
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || key.length > 256 || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Allocation data invalid');
      output[key] = copy(descriptor.value, depth + 1);
    }
    return output;
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(canonical(result)) > MAX_RECORD_BYTES) throw new Error('Allocation record exceeds bounds');
  return result;
}
function keyContext(options?: DecisionTraceKeyOptions): KeyContext {
  if (options !== undefined && (!exact(options, [], ['testKey']) || Object.hasOwn(options, 'testKey') &&
    (!Buffer.isBuffer(options.testKey) || options.testKey.length !== 32))) throw new Error('Allocation key unavailable');
  const selected = options?.testKey ? { testKey: Buffer.from(options.testKey as Buffer) } : {};
  const read = (): Buffer | null => {
    try { return selected.testKey ? Buffer.from(selected.testKey) : loadExistingProvenanceKeyReadOnly(); } catch { return null; }
  };
  const key = read(); if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Allocation key unavailable');
  const pinned = digest(key);
  return { key: Buffer.from(key), options: selected, current: () => {
    try { const current = read(); return Buffer.isBuffer(current) && current.length === 32 && digest(current) === pinned; } catch { return false; }
  } };
}
function sign(payload: Omit<StoredValueAllocationV1, 'provenanceSig'>, key: Buffer): string {
  return createHmac('sha256', key).update(DOMAIN).update(canonical(payload)).digest('hex');
}
function codec(context: KeyContext): ImmutablePrivateRecordCodec<StoredValueAllocationV1> {
  return {
    parse(value) {
      try {
        const row = snapshot(value);
        if (!exact(row, ['schemaVersion', 'kind', 'allocationId', 'receipt', 'trace', 'provenanceSig']) || row.schemaVersion !== 1 ||
          row.kind !== 'stored-value-allocation' || typeof row.allocationId !== 'string' || !ID.test(row.allocationId) ||
          typeof row.provenanceSig !== 'string' || !HASH.test(row.provenanceSig) ||
          !verifyValueAllocationReceipt(row.receipt, row.trace, context.options)) return null;
        const { provenanceSig, ...payload } = row as unknown as StoredValueAllocationV1;
        return timingSafeEqual(Buffer.from(provenanceSig, 'hex'), Buffer.from(sign(payload, context.key), 'hex'))
          ? row as unknown as StoredValueAllocationV1 : null;
      } catch { return null; }
    },
    serialize: (record) => `${canonical(record)}\n`, recordId: (record) => record.allocationId,
    recordFileName: (record) => `${record.allocationId}.json`, isRecordFileName: (name) => /^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(name),
    stageToken: (record) => record.provenanceSig, equivalent: (left, right) => canonical(left) === canonical(right),
  };
}
function config(root: string, context: KeyContext): ImmutablePrivateRecordStoreConfig<StoredValueAllocationV1> {
  const domain = codec(context);
  return { label: 'Value allocation evidence', anchorPath: root, rootPath: join(root, 'value-allocations'), lockFileName: '.records.lock',
    maxRecordBytes: MAX_RECORD_BYTES, defaultMaxFiles: MAX_RECORDS, hardMaxFiles: MAX_RECORDS,
    defaultMaxBytes: MAX_BYTES, hardMaxBytes: MAX_BYTES, codecForRead: () => context.current() ? domain : null,
    codecForWrite: () => context.current() ? domain : null };
}
function unavailable(reason: string, sourceState: ValueAllocationStoreRead['sourceState'] = 'degraded'): ValueAllocationStoreRead {
  return { sourceState, complete: false, records: [], bytesRead: 0, reasons: [reason] };
}
function read(root: string, context: KeyContext, owned?: () => boolean): ValueAllocationStoreRead {
  try {
    inspectPrivateDirectory(root);
    if (owned ? !owned() : exists(join(root, '.value-allocations.lock'))) return unavailable('allocation-store-busy');
    const directory = join(root, 'value-allocations');
    if (!exists(directory)) return unavailable('allocation-store-missing', 'missing');
    inspectPrivateDirectory(directory);
    const result = readImmutablePrivateRecords(config(root, context), { requireComplete: true });
    if (result.sourceState !== 'healthy' || !result.complete || !context.current() || (owned ? !owned() : exists(join(root, '.value-allocations.lock')))) {
      return unavailable('allocation-evidence-unavailable');
    }
    return { sourceState: 'healthy', complete: true, records: result.records, bytesRead: result.bytesRead, reasons: [] };
  } catch { return unavailable('allocation-store-unavailable'); }
}

/** Whole-store read: no creation, repair, partial evidence or provider contact. */
export function readValueAllocations(options: { root: string }, keyOptions?: DecisionTraceKeyOptions): ValueAllocationStoreRead {
  try {
    if (!exact(options, ['root']) || !rootPath(options.root)) return unavailable('allocation-root-invalid');
    if (!exists(options.root)) return unavailable('allocation-root-missing', 'missing');
    return read(options.root, keyContext(keyOptions));
  } catch { return unavailable('allocation-evidence-unavailable'); }
}

/**
 * Persist an already-created receipt and trace without re-scoring or re-signing
 * either. Only the new storage wrapper is signed, binding the caller's ID.
 * Re-recording under another explicitly signed ID does not create more capacity.
 */
export function recordValueAllocation(options: { root: string; allocationId: string; receipt: ValueAllocationReceiptV1; trace: DecisionTraceV1 },
  keyOptions?: DecisionTraceKeyOptions): { disposition: 'recorded' | 'replayed'; record: StoredValueAllocationV1 } {
  if (!exact(options, ['root', 'allocationId', 'receipt', 'trace']) || !rootPath(options.root) ||
    typeof options.allocationId !== 'string' || !ID.test(options.allocationId)) throw new Error('Invalid allocation storage request');
  const context = keyContext(keyOptions);
  const supplied = snapshot({ receipt: options.receipt, trace: options.trace }) as Pick<StoredValueAllocationV1, 'receipt' | 'trace'>;
  if (!verifyValueAllocationReceipt(supplied.receipt, supplied.trace, context.options)) throw new Error('Allocation receipt verification unavailable');
  const payload = { schemaVersion: 1 as const, kind: 'stored-value-allocation' as const, allocationId: options.allocationId, ...supplied };
  const record = { ...payload, provenanceSig: sign(payload, context.key) };
  inspectPrivateDirectory(options.root);
  const lockPath = join(options.root, '.value-allocations.lock');
  // Stale/incomplete ownership is not healed by an evidence-recording API.
  if (exists(lockPath)) throw new Error('Allocation store ownership unavailable');
  const acquired = acquireLocalStoreLockWithOutcome(lockPath, 0, { anchorPath: options.root, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') throw new Error('Allocation store ownership unavailable');
  const owned = (): boolean => ownsLocalStoreLock(acquired.lock) && context.current();
  const publish = (): { disposition: 'recorded' | 'replayed'; record: StoredValueAllocationV1 } => {
    const current = read(options.root, context, owned);
    if (current.sourceState === 'degraded') throw new Error('Allocation store unavailable');
    const prior = current.records.find((entry) => entry.allocationId === options.allocationId);
    if (prior) {
      if (canonical(prior) !== canonical(record)) throw new Error('Allocation record conflicted');
      if (!owned()) throw new Error('Allocation store ownership unavailable');
      return { disposition: 'replayed', record: prior };
    }
    const domain = codec(context); const limits = config(options.root, context);
    const bytes = Buffer.byteLength(domain.serialize(record));
    const used = current.records.reduce((sum, entry) => sum + Buffer.byteLength(domain.serialize(entry)), 0);
    if (current.records.length >= MAX_RECORDS || bytes > MAX_RECORD_BYTES || used + bytes > MAX_BYTES) throw new Error('Allocation store capacity reached');
    let firstGuard = true;
    const disposition = writeImmutablePrivateRecord(limits, record, { lockWaitMs: 0, prepublish: () => {
      if (!owned()) return false;
      // The helper can recover staging; refuse any pre-existing staging before
      // it reaches recovery. Later guard calls may see this publication's stage.
      if (firstGuard) { firstGuard = false; return readdirSync(join(limits.rootPath, 'staging')).length === 0; }
      return true;
    } });
    if (disposition !== 'recorded' && disposition !== 'replayed') throw new Error('Allocation store publication unavailable');
    const after = read(options.root, context, owned);
    if (after.sourceState !== 'healthy' || !after.complete || !owned() ||
      !after.records.some((entry) => entry.allocationId === record.allocationId && canonical(entry) === canonical(record))) throw new Error('Allocation evidence unavailable after publication');
    return { disposition, record };
  };
  let result: ReturnType<typeof publish>; let released = false;
  try { result = publish(); } finally { released = releaseLocalStoreLock(acquired.lock); }
  if (!released) throw new Error('Allocation store ownership release unavailable');
  return result;
}
