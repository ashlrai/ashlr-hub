/** Standalone staging store. No supervisor state is removed or execution authorized here. */
import { lstatSync, mkdirSync, opendirSync, unlinkSync, type BigIntStats } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readImmutablePrivateRecordPoint, recoverImmutablePrivateRecordStore, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { readResourceJson } from './pool-runtime.js';
import { MAX_RESOURCE_CONSOLE_ARCHIVE_RECORD_BYTES, MAX_RESOURCE_CONSOLE_ARCHIVE_TEXT_BYTES,
  validateResourceConsoleArchiveRecord, validateResourceConsoleArchiveText,
  type ResourceConsoleArchiveRecord, type ResourceConsoleArchiveText } from './console-history-archive.js';

const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORDS = 4096;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_SNAPSHOT_TEXT_BYTES = 64 * 1024 * 1024;
const fail = (): never => { throw new Error('Resource console archive storage unavailable'); };
type Identity = { schemaVersion: 1; kind: 'resource-console-archive-task'; id: string; scopeDigest: string;
  jobId: string; taskDigest: string; metadataDigest: string; textDigest: string | null; firstRecordId: string };
type Tombstone = { schemaVersion: 1; kind: 'resource-console-archive-text-deletion'; id: string;
  scopeDigest: string; taskDigest: string };
export type ResourceConsoleArchiveRead =
  | { status: 'missing' | 'unavailable'; record: null; text: null; textState: 'unavailable' }
  | { status: 'staged'; record: ResourceConsoleArchiveRecord; text: ResourceConsoleArchiveText | null;
      textState: 'available' | 'not-retained' | 'deleted' | 'unavailable' };
export type ResourceConsoleArchiveSnapshot =
  | { status: 'complete'; entries: Array<Extract<ResourceConsoleArchiveRead, { status: 'staged' }>>;
      proofDigest: string; isCurrent: () => boolean }
  | { status: 'unavailable'; entries: []; proofDigest: null; isCurrent: () => false };
export interface ResourceConsoleHistoryArchiveStore {
  stage(entry: { record: ResourceConsoleArchiveRecord; text: ResourceConsoleArchiveText | null }): {
    status: 'staged' | 'replayed'; recordId: string; textState: 'available' | 'not-retained' | 'deleted' | 'unavailable';
  };
  read(recordId: string): ResourceConsoleArchiveRead;
  /** Read-only observation. Call isCurrent after joining any separately read source state. */
  readSnapshot(ids: string[]): ResourceConsoleArchiveSnapshot;
  /** Tombstone commits before unlink. A thrown cleanup may still have durably suppressed reads. */
  deleteText(recordId: string): { status: 'deleted' | 'not-retained'; recordId: string };
}

const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
const absent = (path: string): boolean => {
  try { lstatSync(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return fail();
  }
};
function names(path: string, limit: number): string[] {
  const dir = opendirSync(path); const result: string[] = [];
  try { for (let item = dir.readSync(); item; item = dir.readSync()) {
    if (result.length >= limit) fail(); result.push(item.name);
  } } finally { dir.closeSync(); }
  return result;
}
function privateFile(path: string, links = 1): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1n || stat.nlink > BigInt(links) ||
    (stat.mode & 0o777n) !== 0o600n || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) fail();
  return stat;
}
function slot(record: ResourceConsoleArchiveRecord): string {
  return digest(canonical({ scopeDigest: record.scopeDigest, jobId: record.job.id }));
}
function identity(record: ResourceConsoleArchiveRecord): Identity {
  return { schemaVersion: 1, kind: 'resource-console-archive-task', id: slot(record), scopeDigest: record.scopeDigest,
    jobId: record.job.id, taskDigest: record.job.taskDigest, metadataDigest: digest(canonical(record.job)), textDigest: record.textDigest,
    firstRecordId: record.id };
}
function fields(value: unknown, keys: string[]): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key =>
    !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, 'value') || !descriptors[key]!.enumerable)) return fail();
  return descriptors;
}

/** Existing dedicated 0700 root only. Cooperative same-user writers; not a hostile-user boundary. */
export function createResourceConsoleHistoryArchiveStore(options: { root: string; scopeDigest: string }): ResourceConsoleHistoryArchiveStore {
  const captured = fields(options, ['root', 'scopeDigest']);
  const rootValue: unknown = captured.root!.value; const scopeValue: unknown = captured.scopeDigest!.value;
  if (typeof scopeValue !== 'string' || !HASH.test(scopeValue) || typeof rootValue !== 'string' || resolve(rootValue) !== rootValue) return fail();
  const root = inspectPrivateDirectory(rootValue); const scopeDigest = scopeValue;
  const rootIdentity = lstatSync(root, { bigint: true }); const lockPath = join(root, '.archive.lock');
  const texts = join(root, 'texts');
  function fence(): void {
    inspectPrivateDirectory(root);
    if (!same(rootIdentity, lstatSync(root, { bigint: true }))) fail();
  }
  function config<T extends { id: string }>(name: string, parse: (value: unknown) => T, maxBytes: number): ImmutablePrivateRecordStoreConfig<T> {
    const codec: ImmutablePrivateRecordCodec<T> = {
      parse: value => { try { return parse(value); } catch { return null; } }, serialize: value => `${canonical(value)}\n`,
      recordId: value => value.id, recordFileName: value => `${value.id}.json`,
      isRecordFileName: name => /^[a-f0-9]{64}\.json$/.test(name), stageToken: value => digest(canonical(value)),
      equivalent: (a, b) => canonical(a) === canonical(b),
    };
    return { label: 'Resource console archive', anchorPath: root, rootPath: join(root, name), lockFileName: '.lock',
      maxRecordBytes: maxBytes + 1, defaultMaxFiles: MAX_RECORDS, hardMaxFiles: MAX_RECORDS,
      defaultMaxBytes: MAX_BYTES, hardMaxBytes: MAX_BYTES, codecForRead: () => codec, codecForWrite: () => codec };
  }
  const records = config('metadata', value => {
    const record = validateResourceConsoleArchiveRecord(value); if (record.scopeDigest !== scopeDigest) fail(); return record;
  }, MAX_RESOURCE_CONSOLE_ARCHIVE_RECORD_BYTES);
  function exact<T>(value: unknown, keys: string[], kind: string): T {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) fail();
    const entry = value as Record<string, unknown>;
    if (entry.schemaVersion !== 1 || entry.kind !== kind || entry.scopeDigest !== scopeDigest ||
      !HASH.test(String(entry.id)) || !HASH.test(String(entry.taskDigest))) fail();
    return value as T;
  }
  const tasks = config<Identity>('tasks', value => {
    const entry = exact<Identity>(value, ['schemaVersion', 'kind', 'id', 'scopeDigest', 'jobId', 'taskDigest', 'metadataDigest', 'textDigest', 'firstRecordId'], 'resource-console-archive-task');
    if (typeof entry.jobId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.jobId) ||
      !HASH.test(entry.metadataDigest) || entry.textDigest !== null && !HASH.test(entry.textDigest) || !HASH.test(entry.firstRecordId) ||
      entry.id !== digest(canonical({ scopeDigest, jobId: entry.jobId }))) fail();
    return entry;
  }, 2048);
  const tombstones = config<Tombstone>('tombstones', value => exact<Tombstone>(value,
    ['schemaVersion', 'kind', 'id', 'scopeDigest', 'taskDigest'], 'resource-console-archive-text-deletion'), 1024);
  // Bound all namespaces before work. Unexpected entries and links are never adopted or removed.
  function inventory(): { bytes: number; metadata: number; tasks: number; fingerprint: string } {
    fence(); let bytes = 0; const count = { metadata: 0, tasks: 0 };
    const observed: Array<[string, string[]]> = [];
    function observe(name: string, stat: BigIntStats): void {
      observed.push([name, [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.uid, stat.gid,
        stat.mtimeNs, stat.ctimeNs].map(value => value.toString())]);
    }
    const before = lstatSync(root, { bigint: true }); observe('.', before);
    for (const name of names(root, 5)) {
      if (name === '.archive.lock') { observe(name, privateFile(lockPath)); continue; }
      if (!['metadata', 'tasks', 'tombstones', 'texts'].includes(name)) fail();
      const path = join(root, name); inspectPrivateDirectory(path); observe(name, lstatSync(path, { bigint: true }));
      if (name === 'texts') {
        for (const file of names(path, MAX_RECORDS * 2)) {
          if (!/^(?:[a-f0-9]{64}\.json|\.[a-f0-9]{64}\.tmp)$/.test(file)) fail();
          const stat = privateFile(join(path, file));
          observe(`${name}/${file}`, stat);
          if (stat.size > BigInt(MAX_RESOURCE_CONSOLE_ARCHIVE_TEXT_BYTES + 1)) fail(); bytes += Number(stat.size);
        }
      } else for (const child of names(path, 3)) {
        if (child === '.lock') { observe(`${name}/${child}`, privateFile(join(path, child))); continue; }
        if (!['records', 'staging'].includes(child)) fail();
        const directory = join(path, child); inspectPrivateDirectory(directory); observe(`${name}/${child}`, lstatSync(directory, { bigint: true }));
        const files = names(directory, MAX_RECORDS);
        if (child === 'records' && (name === 'metadata' || name === 'tasks')) count[name] = files.length;
        for (const file of files) {
          const stat = privateFile(join(directory, file), 2); observe(`${name}/${child}/${file}`, stat);
          if (stat.size > BigInt(MAX_RESOURCE_CONSOLE_ARCHIVE_RECORD_BYTES + 1)) fail(); bytes += Number(stat.size);
        }
      }
      if (bytes > MAX_BYTES) fail();
    }
    fence(); const after = lstatSync(root, { bigint: true });
    if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail();
    observed.sort(([a], [b]) => a.localeCompare(b));
    return { bytes, ...count, fingerprint: digest(canonical(observed)) };
  }
  function point<T extends { id: string }>(store: ImmutablePrivateRecordStoreConfig<T>, id: string): T | null {
    // lstat prevents a dangling symlink being mistaken for an absent store by the generic point reader.
    if (absent(store.rootPath)) return null;
    const result = readImmutablePrivateRecordPoint(store, id, `${id}.json`);
    if (!result.exactReadComplete || result.sourceState !== 'healthy') fail(); return result.record;
  }
  function relation(record: ResourceConsoleArchiveRecord): { task: Identity; deleted: boolean } {
    const expected = identity(record); const task = point(tasks, expected.id); if (!task) return fail();
    if (task.taskDigest !== expected.taskDigest || task.metadataDigest !== expected.metadataDigest) fail();
    const tombstone = point(tombstones, expected.id);
    if (tombstone && tombstone.taskDigest !== task.taskDigest) fail();
    if (!tombstone && task.textDigest !== record.textDigest) fail();
    return { task, deleted: tombstone !== null };
  }
  function readInside(id: string): ResourceConsoleArchiveRead {
    const record = point(records, id);
    if (!record) return { status: 'missing', record: null, text: null, textState: 'unavailable' };
    const { task, deleted } = relation(record);
    if (deleted) return { status: 'staged', record, text: null, textState: 'deleted' };
    if (record.textDigest === null) return { status: 'staged', record, text: null, textState: 'not-retained' };
    try {
      if (!absent(join(texts, `.${task.id}.tmp`))) fail();
      const text = validateResourceConsoleArchiveText(readResourceJson(join(texts, `${task.id}.json`), MAX_RESOURCE_CONSOLE_ARCHIVE_TEXT_BYTES + 1), record);
      return { status: 'staged', record, text, textState: 'available' };
    } catch { return { status: 'staged', record, text: null, textState: 'unavailable' }; }
  }
  function locked<T>(action: (guard: () => void) => T): T {
    inventory();
    // Reuse the same proven-dead-owner recovery as the console; never force an unknown owner.
    const lock = acquireLocalStoreLock(lockPath, 0, { anchorPath: root, exactPrivateStorage: true });
    if (!lock) return fail();
    const guard = (): void => { fence(); if (!ownsLocalStoreLock(lock)) fail(); };
    try {
      guard();
      for (const store of [records, tasks, tombstones]) {
        const result = recoverImmutablePrivateRecordStore(store as ImmutablePrivateRecordStoreConfig<{ id: string }>, { lockWaitMs: 0 });
        if (!['clean', 'recovered', 'missing'].includes(result)) fail(); guard();
      }
      return action(guard);
    } finally {
      if (!releaseLocalStoreLock(lock)) fail();
    }
  }
  function publish<T extends { id: string }>(store: ImmutablePrivateRecordStoreConfig<T>, value: T, guard: () => void): void {
    guard(); const result = writeImmutablePrivateRecord(store, value, { lockWaitMs: 0, prepublish: () => { guard(); return true; } });
    if (result !== 'recorded' && result !== 'replayed') fail(); guard();
  }
  inventory();
  return {
    read(recordId) {
      try {
        if (typeof recordId !== 'string' || !HASH.test(recordId)) fail(); inventory(); if (!absent(lockPath)) fail();
        const before = lstatSync(root, { bigint: true }); const result = readInside(recordId);
        fence(); const after = lstatSync(root, { bigint: true });
        if (!absent(lockPath) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail();
        return result;
      } catch { return { status: 'unavailable', record: null, text: null, textState: 'unavailable' }; }
    },
    readSnapshot(ids) {
      try {
        // Capture plain dense array values without invoking index accessors or inherited hooks.
        if (!Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype) fail();
        const length: unknown = Object.getOwnPropertyDescriptor(ids, 'length')?.value;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > MAX_RECORDS) return fail();
        const descriptors = Object.getOwnPropertyDescriptors(ids);
        if (Reflect.ownKeys(descriptors).length !== length + 1) fail();
        const requested: string[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
            typeof descriptor.value !== 'string' || !HASH.test(descriptor.value)) fail();
          requested.push(descriptor.value as string);
        }
        if (new Set(requested).size !== requested.length || !absent(lockPath)) fail();
        const before = inventory().fingerprint;
        if (!absent(lockPath)) fail();
        const entries: Array<Extract<ResourceConsoleArchiveRead, { status: 'staged' }>> = [];
        let textBytes = 0;
        for (const id of requested) {
          const result = readInside(id);
          if (result.status !== 'staged' || result.textState === 'unavailable') return fail();
          textBytes += result.text === null ? 0 : Buffer.byteLength(canonical(result.text));
          if (textBytes > MAX_SNAPSHOT_TEXT_BYTES) fail(); entries.push(result);
        }
        const proof = (): string => digest(canonical({ kind: 'resource-console-archive-snapshot', schemaVersion: 1,
          scopeDigest, requested, entries: entries.map(entry => ({ record: entry.record, textState: entry.textState,
            textDigest: entry.text === null ? null : digest(canonical(entry.text)) })) }));
        const proofDigest = proof();
        const isCurrent = (): boolean => {
          try { return absent(lockPath) && inventory().fingerprint === before && absent(lockPath) && proof() === proofDigest; }
          catch { return false; }
        };
        if (!isCurrent()) fail();
        return { status: 'complete', entries, proofDigest, isCurrent };
      } catch { return { status: 'unavailable', entries: [], proofDigest: null, isCurrent: () => false }; }
    },
    stage(entry) {
      const input = fields(entry, ['record', 'text']);
      const record = validateResourceConsoleArchiveRecord(input.record!.value);
      if (record.scopeDigest !== scopeDigest) fail();
      const text = validateResourceConsoleArchiveText(input.text!.value, record);
      return locked(guard => {
        const limits = inventory(); const existing = point(records, record.id); const expected = identity(record);
        const prior = point(tasks, expected.id); const tombstone = point(tombstones, expected.id);
        if (tombstone && (!prior || tombstone.taskDigest !== expected.taskDigest)) fail();
        if (prior && (prior.taskDigest !== expected.taskDigest || prior.metadataDigest !== expected.metadataDigest ||
          !tombstone && prior.textDigest !== expected.textDigest)) fail();
        // A different source version must not bypass an interrupted initial publication.
        // Otherwise firstRecordId can remain absent after B commits, allowing a later A/C
        // retry to mistake a lost published transcript for an uncommitted initial payload.
        if (prior && prior.firstRecordId !== record.id && !point(records, prior.firstRecordId)) fail();
        if (!existing && limits.metadata >= MAX_RECORDS || !prior && limits.tasks >= MAX_RECORDS ||
          limits.bytes + Buffer.byteLength(canonical(record)) + (text ? Buffer.byteLength(canonical(text)) : 0) + 4096 > MAX_BYTES) fail();
        if (!prior) publish(tasks, expected, guard);
        if (text && !tombstone) {
          if (absent(texts)) { guard(); mkdirSync(texts, { mode: 0o700 }); fsyncDirectory(root); }
          inspectPrivateDirectory(texts); const path = join(texts, `${expected.id}.json`);
          if (!absent(path)) validateResourceConsoleArchiveText(readResourceJson(path, MAX_RESOURCE_CONSOLE_ARCHIVE_TEXT_BYTES + 1), record);
          else if (!existing && (!prior || prior.firstRecordId === record.id)) {
            guard(); writePrivateFileAtomically(join(texts, `.${expected.id}.tmp`), path, `${canonical(text)}\n`,
              { anchorPath: root, label: 'Resource console archive text' }); guard();
          }
          // Missing text behind published metadata is degraded, never reconstructed by replay.
        }
        publish(records, record, guard);
        const result = readInside(record.id); guard();
        if (result.status !== 'staged') return fail();
        return { status: existing ? 'replayed' : 'staged', recordId: record.id, textState: result.textState };
      });
    },
    deleteText(recordId) {
      if (typeof recordId !== 'string' || !HASH.test(recordId)) fail();
      return locked(guard => {
        const record = point(records, recordId); if (!record) return fail();
        const { task, deleted } = relation(record);
        if (!deleted && record.textDigest === null) return { status: 'not-retained', recordId };
        publish(tombstones, { schemaVersion: 1, kind: 'resource-console-archive-text-deletion', id: task.id,
          scopeDigest, taskDigest: task.taskDigest }, guard);
        if (!absent(texts)) for (const name of [`${task.id}.json`, `.${task.id}.tmp`]) {
          inspectPrivateDirectory(texts); const path = join(texts, name);
          if (!absent(path)) { const before = privateFile(path); guard(); if (!same(before, privateFile(path))) fail(); unlinkSync(path); fsyncDirectory(texts); }
        }
        guard(); return { status: 'deleted', recordId };
      });
    },
  };
}
