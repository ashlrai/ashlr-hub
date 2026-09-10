import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { canonical, digest, inspectPrivateDirectory, privateDirectory } from './artifacts.js';

const MAX_ENTRIES = 256;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_BYTES = 16 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
export interface DailyMemoryEntry {
  schemaVersion: 1; kind: 'daily'; date: string; id: string; content: string; inputTraceDigest: string;
}
export interface FirmMemoryVersion {
  schemaVersion: 1; kind: 'master'; sequence: number; id: string; content: string; inputTraceDigest: string;
  previousDigest: string | null; sourceDailyDigests: Array<{ date: string; digest: string }>;
}
export interface FirmMemoryWriteResult {
  status: 'recorded' | 'replayed' | 'conflicted' | 'unavailable'; entryDigest: string | null;
}
interface ReadResult<T> { sourceState: 'missing' | 'healthy' | 'degraded'; complete: boolean; entries: T[]; digest: string | null }
interface MemoryStore<T> extends ImmutablePrivateRecordStoreConfig<T> { firmRoot: string }
export interface DailyMemoryInput { root: string; date: string; id: string; content: string; inputTraceDigest: string }
export interface FirmMemoryConsolidationInput {
  root: string; id: string; content: string; inputTraceDigest: string; expectedPriorDigest: string | null;
  sourceDailyDigests: Array<{ date: string; digest: string }>;
}

function invalid(): never { throw new Error('Invalid explicit firm memory request'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some((key) => typeof key !== 'string' ||
        !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) invalid();
  return value as Record<string, unknown>;
}
function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function id(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) invalid(); return value; }
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) invalid(); return value; }
function content(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_CONTENT_BYTES ||
      Buffer.from(value, 'utf8').toString('utf8') !== value || [...value].some((character) => {
        const code = character.charCodeAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127;
      })) invalid();
  return value;
}
function rootPath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || parsePath(value).root === value ||
      Buffer.byteLength(value) > 4_096 || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid();
  return value;
}
function sources(value: unknown): FirmMemoryVersion['sourceDailyDigests'] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 31 ||
      Reflect.ownKeys(value).length !== value.length + 1 || Array.from({ length: value.length }, (_, i) =>
        Object.getOwnPropertyDescriptor(value, String(i))).some((entry) => !entry || !Object.hasOwn(entry, 'value'))) invalid();
  const result = value.map((entry) => { const row = object(entry, ['date', 'digest']); return { date: day(row.date), digest: hash(row.digest) }; });
  if (new Set(result.map((entry) => entry.date)).size !== result.length) invalid();
  return result.sort((a, b) => a.date.localeCompare(b.date));
}
function daily(value: unknown): DailyMemoryEntry {
  const row = object(value, ['schemaVersion', 'kind', 'date', 'id', 'content', 'inputTraceDigest']);
  if (row.schemaVersion !== 1 || row.kind !== 'daily') invalid();
  return { schemaVersion: 1, kind: 'daily', date: day(row.date), id: id(row.id), content: content(row.content), inputTraceDigest: hash(row.inputTraceDigest) };
}
function master(value: unknown): FirmMemoryVersion {
  const row = object(value, ['schemaVersion', 'kind', 'sequence', 'id', 'content', 'inputTraceDigest', 'previousDigest', 'sourceDailyDigests']);
  if (row.schemaVersion !== 1 || row.kind !== 'master' || !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 0 || Number(row.sequence) >= MAX_ENTRIES) invalid();
  return { schemaVersion: 1, kind: 'master', sequence: row.sequence as number, id: id(row.id), content: content(row.content),
    inputTraceDigest: hash(row.inputTraceDigest), previousDigest: row.previousDigest === null ? null : hash(row.previousDigest), sourceDailyDigests: sources(row.sourceDailyDigests) };
}
function config<T extends { id: string }>(root: string, path: string, validate: (value: unknown) => T,
  compare: (a: T, b: T) => number): MemoryStore<T> {
  const codec: ImmutablePrivateRecordCodec<T> = {
    parse(value) { try { return validate(value); } catch { return null; } }, serialize: (value) => `${canonical(value)}\n`,
    recordId: (value) => value.id, recordFileName: (value) => `${value.id}.json`, isRecordFileName: (name) => /^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(name),
    stageToken: (value) => digest(canonical(value)), equivalent: (a, b) => canonical(a) === canonical(b), compare,
  };
  return { label: 'Firm memory', firmRoot: root, anchorPath: dirname(path), rootPath: path, lockFileName: '.records.lock', maxRecordBytes: 24 * 1024,
    defaultMaxFiles: MAX_ENTRIES, hardMaxFiles: MAX_ENTRIES, defaultMaxBytes: MAX_BYTES, hardMaxBytes: MAX_BYTES,
    codecForRead: () => codec, codecForWrite: () => codec };
}
function dailyConfig(root: string, date: string) {
  return config(root, join(root, 'firm-memory', 'daily', date), (value) => {
    const entry = daily(value); if (entry.date !== date) invalid(); return entry;
  }, (a, b) => a.id.localeCompare(b.id));
}
function masterConfig(root: string) { return config(root, join(root, 'firm-memory', 'master'), master, (a, b) => a.sequence - b.sequence); }
function empty<T>(sourceState: 'missing' | 'degraded'): ReadResult<T> {
  return { sourceState, complete: sourceState === 'missing', entries: [], digest: null };
}
function read<T extends { id: string }>(store: MemoryStore<T>): ReadResult<T> {
  try {
    try { lstatSync(store.firmRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty('missing'); throw error; }
    inspectPrivateDirectory(store.firmRoot);
    // Check intermediate paths too: a missing final ledger cannot hide an
    // unsafe existing ancestor from the underlying store's early missing path.
    const parts = store.rootPath.slice(store.firmRoot.length + 1).split(sep);
    let at = store.firmRoot;
    for (const part of parts) {
      at = join(at, part);
      try { lstatSync(at); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty('missing'); throw error; }
      inspectPrivateDirectory(at);
    }
    const result = readImmutablePrivateRecords(store, { requireComplete: true });
    if (result.sourceState !== 'healthy' || !result.complete) return empty(result.sourceState === 'missing' ? 'missing' : 'degraded');
    return { sourceState: 'healthy', complete: true, entries: result.records, digest: digest(canonical(result.records)) };
  } catch { return empty('degraded'); }
}
/** Read-only; never initializes or repairs memory. Missing is not a measured empty history. */
export function readDailyMemory(input: { root: string; date: string }): ReadResult<DailyMemoryEntry> {
  const row = object(input, ['root', 'date']); return read(dailyConfig(rootPath(row.root), day(row.date)));
}
export function readFirmMemory(input: { root: string }): ReadResult<FirmMemoryVersion> & { current: FirmMemoryVersion | null } {
  const row = object(input, ['root']); const result = read(masterConfig(rootPath(row.root)));
  let previous: string | null = null;
  for (const [sequence, version] of result.entries.entries()) {
    if (version.sequence !== sequence || version.previousDigest !== previous) return { ...empty<FirmMemoryVersion>('degraded'), current: null };
    previous = digest(canonical(version));
  }
  return { ...result, digest: previous, current: result.entries.at(-1) ?? null };
}
function transaction(root: string, action: (owned: () => boolean) => FirmMemoryWriteResult): FirmMemoryWriteResult {
  try {
    inspectPrivateDirectory(root);
    const acquired = acquireLocalStoreLockWithOutcome(join(root, '.firm-memory.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') return { status: 'unavailable', entryDigest: null };
    try { return action(() => ownsLocalStoreLock(acquired.lock)); } finally { releaseLocalStoreLock(acquired.lock); }
  } catch { return { status: 'unavailable', entryDigest: null }; }
}
function publish<T extends { id: string }>(store: MemoryStore<T>, entry: T, owned: () => boolean): FirmMemoryWriteResult {
  privateDirectory(store.rootPath);
  const status = writeImmutablePrivateRecord(store, entry, { lockWaitMs: 0, prepublish: owned });
  return { status: status === 'recorded' || status === 'replayed' || status === 'conflicted' ? status : 'unavailable',
    entryDigest: status === 'recorded' || status === 'replayed' ? digest(canonical(entry)) : null };
}

/** Appends only immutable daily entries. No parameter or code path targets MEMORY.md/master. */
export function appendDailyMemory(input: DailyMemoryInput): FirmMemoryWriteResult {
  const row = object(input, ['root', 'date', 'id', 'content', 'inputTraceDigest']); const root = rootPath(row.root);
  const entry = daily({ schemaVersion: 1, kind: 'daily', date: row.date, id: row.id, content: row.content, inputTraceDigest: row.inputTraceDigest });
  return transaction(root, (owned) => {
    const store = dailyConfig(root, entry.date); const current = read(store);
    if (current.sourceState === 'degraded') return { status: 'unavailable', entryDigest: null };
    const prior = current.entries.find((value) => value.id === entry.id);
    if (prior) return canonical(prior) === canonical(entry) ? { status: 'replayed', entryDigest: digest(canonical(prior)) } : { status: 'conflicted', entryDigest: null };
    if (current.entries.length >= MAX_ENTRIES || Buffer.byteLength(canonical([...current.entries, entry])) > MAX_BYTES) return { status: 'unavailable', entryDigest: null };
    return publish(store, entry, owned);
  });
}

/**
 * Separate consolidation API: immutable versions, expected-prior CAS and exact
 * source links. Digests establish lineage, not truth or authenticated authority.
 * Same-user arbitrary code remains able to alter files outside this API.
 */
export function consolidateFirmMemory(input: FirmMemoryConsolidationInput): FirmMemoryWriteResult {
  const row = object(input, ['root', 'id', 'content', 'inputTraceDigest', 'expectedPriorDigest', 'sourceDailyDigests']);
  const root = rootPath(row.root);
  const base = { schemaVersion: 1 as const, kind: 'master' as const, id: id(row.id), content: content(row.content), inputTraceDigest: hash(row.inputTraceDigest),
    previousDigest: row.expectedPriorDigest === null ? null : hash(row.expectedPriorDigest), sourceDailyDigests: sources(row.sourceDailyDigests) };
  return transaction(root, (owned) => {
    const current = readFirmMemory({ root });
    if (current.sourceState === 'degraded') return { status: 'unavailable', entryDigest: null };
    const prior = current.entries.find((value) => value.id === base.id);
    if (prior) return canonical(prior) === canonical({ ...base, sequence: prior.sequence })
      ? { status: 'replayed', entryDigest: digest(canonical(prior)) } : { status: 'conflicted', entryDigest: null };
    if (current.digest !== base.previousDigest) return { status: 'conflicted', entryDigest: null };
    for (const source of base.sourceDailyDigests) {
      const dailyRead = readDailyMemory({ root, date: source.date });
      if (dailyRead.sourceState !== 'healthy' || dailyRead.digest !== source.digest) return { status: 'conflicted', entryDigest: null };
    }
    if (current.entries.length >= MAX_ENTRIES) return { status: 'unavailable', entryDigest: null };
    const entry: FirmMemoryVersion = { ...base, sequence: current.entries.length };
    if (Buffer.byteLength(canonical([...current.entries, entry])) > MAX_BYTES) return { status: 'unavailable', entryDigest: null };
    return publish(masterConfig(root), entry, owned);
  });
}
