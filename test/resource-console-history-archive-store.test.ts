/** Real private filesystem staging, not active console compaction or provider execution. */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { prepareResourceConsoleHistoryArchive, restoreResourceConsoleArchiveJob } from '../src/core/resources/console-history-archive.js';
import { createResourceConsoleHistoryArchiveStore } from '../src/core/resources/console-history-archive-store.js';
import type { ResourceConsoleDurableState } from '../src/core/resources/console-state-codec.js';
import type { ImmutablePrivateRecordStoreConfig } from '../src/core/util/immutable-private-record-store.js';

let base: string; let root: string;
const faults = vi.hoisted(() => ({ unlinkPath: null as string | null, linkPath: null as string | null,
  readId: null as string | null, afterRead: null as (() => void) | null }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, linkSync(existing: Parameters<typeof actual.linkSync>[0], target: Parameters<typeof actual.linkSync>[1]) {
    if (target === faults.linkPath) { faults.linkPath = null; throw new Error('Fixture interruption before metadata publication'); }
    return actual.linkSync(existing, target);
  }, unlinkSync(path: Parameters<typeof actual.unlinkSync>[0]) {
    if (path === faults.unlinkPath) { faults.unlinkPath = null; throw new Error('Fixture interruption after tombstone'); }
    return actual.unlinkSync(path);
  } };
});
vi.mock('../src/core/util/immutable-private-record-store.js', async original => {
  const actual = await original<typeof import('../src/core/util/immutable-private-record-store.js')>();
  return { ...actual, readImmutablePrivateRecordPoint<T>(config: ImmutablePrivateRecordStoreConfig<T>, id: string, name: string) {
    const result = actual.readImmutablePrivateRecordPoint(config, id, name);
    if (config.rootPath.endsWith('/metadata') && id === faults.readId && faults.afterRead) {
      const callback = faults.afterRead; faults.afterRead = null; faults.readId = null; callback();
    }
    return result;
  } };
});
const workspace = '/private/fixture/archive-workspace';
const pool = validateResourcePool({ schemaVersion: 1, id: 'archive', workers: [{ id: 'local', provider: 'local',
  model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 10 }] });
const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }], pool);
const scopeDigest = digest(canonical({ pool, bindings, workspace }));
const at = '2026-09-13T00:00:00.000Z';
function entry(paused = true, retained = true) {
  const state: ResourceConsoleDurableState = { schemaVersion: 2, scopeDigest, paused, jobs: [{
    id: 'finished', state: 'settled', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['local'], mode: 'read-only',
    workerId: 'local', outcome: 'completed', reason: null, taskDigest: digest('finished-task'), input: null,
    ...(retained ? { retainHistory: true, history: { prompt: 'private-retained-prompt', output: { text: 'private-retained-output', truncated: false } } } : {}),
  }] };
  return prepareResourceConsoleHistoryArchive(state, { pool, bindings, workspace }, ['finished']).entries[0]!;
}
function store() { return createResourceConsoleHistoryArchiveStore({ root, scopeDigest }); }
const textPath = () => join(root, 'texts', `${digest(canonical({ scopeDigest, jobId: 'finished' }))}.json`);
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'console-archive-store-'))); root = join(base, 'archive'); mkdirSync(root, { mode: 0o700 }); });
afterEach(() => { faults.unlinkPath = null; faults.linkPath = null; faults.readId = null; faults.afterRead = null;
  rmSync(base, { recursive: true, force: true }); });

describe('standalone resource console archive storage', () => {
  it('does not initialize state, folders or tasks merely by constructing and reading a missing record', () => {
    const archive = store(); expect(readdirSync(root)).toEqual([]);
    expect(archive.read(entry().record.id)).toMatchObject({ status: 'missing', textState: 'unavailable' });
    expect(readdirSync(root)).toEqual([]); expect(existsSync(join(root, 'resource-console-state.json'))).toBe(false);
  });

  it('stages and reopens an exact private transcript, keeping plaintext out of immutable namespaces', () => {
    const selected = entry(); const archive = store();
    expect(archive.stage(selected)).toMatchObject({ status: 'staged', textState: 'available' });
    const reopened = store().read(selected.record.id);
    expect(reopened).toEqual({ status: 'staged', record: selected.record, text: selected.text, textState: 'available' });
    for (const directory of ['metadata', 'tasks']) for (const name of readdirSync(join(root, directory, 'records'))) {
      const bytes = readFileSync(join(root, directory, 'records', name), 'utf8');
      expect(bytes).not.toContain('private-retained'); expect(bytes).not.toContain('"history":'); expect(bytes).not.toContain('"context":');
    }
    expect(readFileSync(textPath(), 'utf8')).toContain('private-retained');
    expect(archive.stage(selected)).toMatchObject({ status: 'replayed', textState: 'available' });
    expect(existsSync(join(root, '.archive.lock'))).toBe(false);
  });

  it('shares text across source-state versions and permanently suppresses all versions after deletion', () => {
    const first = entry(true); const second = entry(false); expect(first.record.id).not.toBe(second.record.id);
    const archive = store(); archive.stage(first); archive.stage(second);
    expect(readdirSync(join(root, 'texts'))).toHaveLength(1);
    expect(archive.deleteText(first.record.id)).toMatchObject({ status: 'deleted' });
    expect(existsSync(textPath())).toBe(false);
    for (const selected of [first, second]) {
      expect(store().read(selected.record.id)).toMatchObject({ status: 'staged', textState: 'deleted', text: null });
      expect(store().stage(selected)).toMatchObject({ status: 'replayed', textState: 'deleted' });
    }
    expect(existsSync(textPath())).toBe(false);
    expect(restoreResourceConsoleArchiveJob(first.record, null, { deleted: true })).toMatchObject({ retainHistory: true, history: null });
  });

  it('does not resurrect deleted text when a new source version is first staged after deletion', () => {
    const archive = store(); const first = entry(true); archive.stage(first); archive.deleteText(first.record.id);
    const next = entry(false);
    expect(store().stage(next)).toMatchObject({ status: 'staged', textState: 'deleted' });
    expect(store().read(next.record.id)).toMatchObject({ textState: 'deleted', text: null });
    expect(existsSync(textPath())).toBe(false);
  });

  it('preserves a committed deletion across interrupted payload cleanup and finishes exact cleanup on retry', () => {
    const archive = store(); const selected = entry(); archive.stage(selected);
    faults.unlinkPath = textPath();
    expect(() => archive.deleteText(selected.record.id)).toThrow('Fixture interruption after tombstone');
    // Cleanup failure is not disk-erasure success, but the committed tombstone
    // must already suppress private reads and all later record variants.
    expect(existsSync(textPath())).toBe(true);
    expect(store().read(selected.record.id)).toMatchObject({ textState: 'deleted', text: null });
    expect(store().stage(entry(false))).toMatchObject({ textState: 'deleted' });
    expect(store().deleteText(selected.record.id)).toMatchObject({ status: 'deleted' });
    expect(existsSync(textPath())).toBe(false);
  });

  it('distinguishes missing published text from deletion and never reconstructs it on any replay', () => {
    const archive = store(); const first = entry(true); archive.stage(first); unlinkSync(textPath());
    expect(archive.read(first.record.id)).toMatchObject({ status: 'staged', textState: 'unavailable', text: null });
    expect(archive.stage(first)).toMatchObject({ status: 'replayed', textState: 'unavailable' });
    expect(archive.stage(entry(false))).toMatchObject({ status: 'staged', textState: 'unavailable' });
    expect(existsSync(textPath())).toBe(false);
  });

  it('holds a different source version after interrupted first publication and permits only exact first-record recovery', () => {
    const archive = store(); const first = entry(true); const second = entry(false);
    faults.linkPath = join(root, 'metadata', 'records', `${first.record.id}.json`);
    expect(() => archive.stage(first)).toThrow();
    expect(readdirSync(join(root, 'tasks', 'records'))).toHaveLength(1);
    expect(existsSync(join(root, 'metadata', 'records', `${first.record.id}.json`))).toBe(false);
    expect(existsSync(textPath())).toBe(true);
    expect(() => store().stage(second)).toThrow();
    expect(existsSync(join(root, 'metadata', 'records', `${second.record.id}.json`))).toBe(false);
    // The orphan text is not committed history; exact A recovery can complete its initial payload.
    unlinkSync(textPath());
    expect(store().stage(first)).toMatchObject({ status: 'staged', textState: 'available' });
    expect(store().stage(second)).toMatchObject({ status: 'staged', textState: 'available' });
    unlinkSync(textPath());
    for (const selected of [first, second]) expect(store().stage(selected)).toMatchObject({ textState: 'unavailable' });
    const { id: _id, ...body } = first.record; body.sourceStateDigest = digest('third-source-version');
    expect(store().stage({ record: { ...body, id: digest(canonical(body)) }, text: first.text })).toMatchObject({ textState: 'unavailable' });
    expect(existsSync(textPath())).toBe(false);
  });

  it('returns an ordered scope-bound snapshot without writing or retaining a lock', () => {
    const archive = store(); const empty = archive.readSnapshot([]);
    expect(empty.status).toBe('complete'); expect(empty.isCurrent()).toBe(true); expect(readdirSync(root)).toEqual([]);
    const otherScope = createResourceConsoleHistoryArchiveStore({ root, scopeDigest: digest('other-scope') }).readSnapshot([]);
    expect(otherScope.proofDigest).not.toBe(empty.proofDigest);
    const first = entry(true); const second = entry(false); archive.stage(first); archive.stage(second);
    expect(empty.isCurrent()).toBe(false);
    const snapshot = archive.readSnapshot([second.record.id, first.record.id]);
    expect(snapshot.status).toBe('complete'); expect(snapshot.entries.map(value => value.record.id)).toEqual([second.record.id, first.record.id]);
    expect(snapshot.isCurrent()).toBe(true); expect(snapshot.proofDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(archive.readSnapshot([first.record.id, second.record.id]).proofDigest).not.toBe(snapshot.proofDigest);
    expect(archive.readSnapshot([second.record.id, first.record.id]).proofDigest).toBe(snapshot.proofDigest);
    expect(existsSync(join(root, '.archive.lock'))).toBe(false);
  });

  it('deletes orphan text by exact task identity before any metadata publication, then suppresses A and a new B', () => {
    const selected = entry(true); const next = entry(false); const archive = store();
    faults.linkPath = join(root, 'metadata', 'records', `${selected.record.id}.json`);
    expect(() => archive.stage(selected)).toThrow();
    expect(existsSync(join(root, 'metadata', 'records', `${selected.record.id}.json`))).toBe(false);
    expect(existsSync(textPath())).toBe(true);
    expect(archive.readTaskDeletionState(selected.record.job.id, selected.record.job.taskDigest)).toBe('retained');
    // An interrupted atomic payload can leave this second deletable name; neither
    // private copy may survive a successfully completed task-identity deletion.
    const temporary = join(root, 'texts', `.${digest(canonical({ scopeDigest, jobId: selected.record.job.id }))}.tmp`);
    writeFileSync(temporary, `${canonical(selected.text)}\n`, { mode: 0o600, flag: 'wx' });
    expect(store().deleteTaskText(selected.record.job.id, selected.record.job.taskDigest)).toEqual({ status: 'deleted' });
    expect(store().readTaskDeletionState(selected.record.job.id, selected.record.job.taskDigest)).toBe('deleted');
    expect(existsSync(textPath())).toBe(false); expect(existsSync(temporary)).toBe(false);
    expect(store().stage(next)).toMatchObject({ status: 'staged', textState: 'deleted' });
    expect(existsSync(join(root, 'metadata', 'records', `${selected.record.id}.json`))).toBe(false);
    expect(store().stage(selected)).toMatchObject({ status: 'staged', textState: 'deleted' });
    expect(store().deleteTaskText(selected.record.job.id, selected.record.job.taskDigest)).toEqual({ status: 'deleted' });
    expect(store().readSnapshot([selected.record.id, next.record.id])).toMatchObject({ status: 'complete',
      entries: [{ textState: 'deleted', text: null }, { textState: 'deleted', text: null }] });
    expect(existsSync(textPath())).toBe(false);
  });

  it('refuses foreign task digests without tombstoning or deleting a retained orphan', () => {
    const selected = entry(); const archive = store();
    faults.linkPath = join(root, 'metadata', 'records', `${selected.record.id}.json`);
    expect(() => archive.stage(selected)).toThrow(); const before = readFileSync(textPath(), 'utf8');
    expect(() => archive.deleteTaskText(selected.record.job.id, digest('different-task'))).toThrow();
    expect(readFileSync(textPath(), 'utf8')).toBe(before); expect(existsSync(join(root, 'tombstones'))).toBe(false);
    expect(store().stage(selected)).toMatchObject({ textState: 'available' });
  });

  it('keeps missing and unretained task deletion distinct without manufacturing a tombstone', () => {
    const archive = store(); const selected = entry(true, false);
    expect(archive.deleteTaskText('missing', digest('missing'))).toEqual({ status: 'missing' });
    expect(readdirSync(root)).toEqual([]); archive.stage(selected);
    expect(archive.deleteTaskText(selected.record.job.id, selected.record.job.taskDigest)).toEqual({ status: 'not-retained' });
    expect(existsSync(join(root, 'tombstones'))).toBe(false); expect(existsSync(join(root, 'texts'))).toBe(false);
    for (const [id, hash] of [['../unsafe', digest('x')], ['finished', 'invalid']]) {
      expect(() => archive.deleteTaskText(id!, hash!)).toThrow();
    }
  });

  it('keeps orphan deletion durable across an interrupted unlink and finishes cleanup on retry', () => {
    const selected = entry(); const archive = store();
    faults.linkPath = join(root, 'metadata', 'records', `${selected.record.id}.json`);
    expect(() => archive.stage(selected)).toThrow(); faults.unlinkPath = textPath();
    expect(() => archive.deleteTaskText(selected.record.job.id, selected.record.job.taskDigest)).toThrow('Fixture interruption after tombstone');
    expect(existsSync(textPath())).toBe(true);
    expect(store().readTaskDeletionState(selected.record.job.id, selected.record.job.taskDigest)).toBe('deleted');
    expect(store().stage(entry(false))).toMatchObject({ textState: 'deleted' });
    expect(store().deleteTaskText(selected.record.job.id, selected.record.job.taskDigest)).toEqual({ status: 'deleted' });
    expect(existsSync(textPath())).toBe(false);
  });

  it('reads exact task deletion evidence without writes or conflating retention intent with payload availability', () => {
    const selected = entry(); const archive = store();
    expect(archive.readTaskDeletionState('missing', digest('missing'))).toBe('missing'); expect(readdirSync(root)).toEqual([]);
    archive.stage(selected); const before = readFileSync(textPath(), 'utf8');
    const snapshot = archive.readSnapshot([]);
    expect(archive.readTaskDeletionState(selected.record.job.id, selected.record.job.taskDigest)).toBe('retained');
    expect(archive.readTaskDeletionState(selected.record.job.id, digest('wrong'))).toBe('unavailable');
    expect(snapshot.isCurrent()).toBe(true); expect(readFileSync(textPath(), 'utf8')).toBe(before);
    writeFileSync(textPath(), '{}\n', { mode: 0o600 });
    expect(archive.readTaskDeletionState(selected.record.job.id, selected.record.job.taskDigest)).toBe('retained');
    expect(archive.read(selected.record.id)).toMatchObject({ textState: 'unavailable' });
    unlinkSync(textPath());
    expect(archive.readTaskDeletionState(selected.record.job.id, selected.record.job.taskDigest)).toBe('retained');
    expect(archive.read(selected.record.id)).toMatchObject({ textState: 'unavailable' });
    expect(existsSync(textPath())).toBe(false);
  });

  it('invalidates a complete snapshot after deletion, while freshly deleted and no-retention snapshots remain complete', () => {
    const archive = store(); const selected = entry(); archive.stage(selected);
    const before = archive.readSnapshot([selected.record.id]); expect(before.status).toBe('complete');
    archive.deleteText(selected.record.id); expect(before.isCurrent()).toBe(false);
    const deleted = archive.readSnapshot([selected.record.id]); expect(deleted.status).toBe('complete');
    expect(deleted.entries[0]).toMatchObject({ textState: 'deleted', text: null }); expect(deleted.isCurrent()).toBe(true);
    expect(deleted.proofDigest).not.toBe(before.proofDigest);
    const separateRoot = join(base, 'unretained'); mkdirSync(separateRoot, { mode: 0o700 });
    const unretained = createResourceConsoleHistoryArchiveStore({ root: separateRoot, scopeDigest });
    const plain = entry(true, false); unretained.stage(plain);
    expect(unretained.readSnapshot([plain.record.id])).toMatchObject({ status: 'complete', entries: [{ textState: 'not-retained', text: null }] });
  });

  it('refuses the entire batch when real deletion happens between metadata reads, rather than returning earlier private text', () => {
    const archive = store(); const first = entry(true); const second = entry(false); archive.stage(first); archive.stage(second);
    faults.readId = second.record.id; faults.afterRead = () => { archive.deleteText(first.record.id); };
    const result = archive.readSnapshot([first.record.id, second.record.id]);
    expect(result).toMatchObject({ status: 'unavailable', entries: [], proofDigest: null }); expect(result.isCurrent()).toBe(false);
    expect(archive.read(first.record.id)).toMatchObject({ textState: 'deleted', text: null });
  });

  it('refuses the entire batch when another record is really staged during reading', () => {
    const archive = store(); const first = entry(true); const second = entry(false); archive.stage(first);
    faults.readId = first.record.id; faults.afterRead = () => { archive.stage(second); };
    expect(archive.readSnapshot([first.record.id])).toMatchObject({ status: 'unavailable', entries: [], proofDigest: null });
    expect(archive.read(second.record.id)).toMatchObject({ status: 'staged', textState: 'available' });
  });

  it('detects nested payload mutation even when the root timestamp is unchanged', () => {
    const archive = store(); const selected = entry(); archive.stage(selected);
    const snapshot = archive.readSnapshot([selected.record.id]); const before = lstatSync(root, { bigint: true });
    writeFileSync(textPath(), '{}\n', { mode: 0o600 });
    expect(lstatSync(root, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    expect(snapshot.isCurrent()).toBe(false);
    expect(archive.readSnapshot([selected.record.id])).toMatchObject({ status: 'unavailable', entries: [], proofDigest: null });
  });

  it('rejects invalid, duplicate, sparse, accessor and oversized requests without invoking getters', () => {
    const archive = store(); const selected = entry(); archive.stage(selected); let calls = 0;
    const accessor = [selected.record.id]; Object.defineProperty(accessor, '0', { enumerable: true, get: () => { calls++; return selected.record.id; } });
    const extra = [selected.record.id]; Object.defineProperty(extra, 'extra', { value: true });
    const invalid = [null, {}, [selected.record.id, selected.record.id], new Array(1), accessor, extra,
      Array.from({ length: 4097 }, () => selected.record.id), [digest('absent')], ['../bad']];
    for (const ids of invalid) {
      const result = archive.readSnapshot(ids as string[]);
      expect(result).toMatchObject({ status: 'unavailable', entries: [], proofDigest: null }); expect(result.isCurrent()).toBe(false);
    }
    expect(calls).toBe(0); expect(existsSync(join(root, '.archive.lock'))).toBe(false);
  });

  it('does not return an incomplete snapshot or resurrect missing text', () => {
    const archive = store(); const selected = entry(); archive.stage(selected); unlinkSync(textPath());
    expect(archive.readSnapshot([selected.record.id])).toMatchObject({ status: 'unavailable', entries: [], proofDigest: null });
    expect(existsSync(textPath())).toBe(false);
  });

  it('bounds returned transcript bytes even when many metadata versions share one small on-disk payload', () => {
    const archive = store(); const selected = entry();
    // Escaped output is valid retained text and approaches the serialized per-payload bound,
    // keeping the real 64 MiB boundary exercise to fewer independent metadata reads.
    selected.text!.history = { prompt: 'p'.repeat(32 * 1024), output: { text: '\u0001'.repeat(56 * 1024), truncated: false } };
    const { id: _id, ...body } = selected.record; body.textDigest = digest(canonical(selected.text));
    selected.record = { ...body, id: digest(canonical(body)) }; archive.stage(selected);
    const copies = Math.floor(64 * 1024 * 1024 / Buffer.byteLength(canonical(selected.text))) + 1;
    const ids: string[] = [];
    // Populate canonical private immutable-record fixtures directly: this tests bounded reads,
    // not publication throughput or proof that these synthetic source states ever executed.
    for (let index = 0; index < copies; index++) {
      const version = { ...body, sourceStateDigest: digest(`fixture-source-${index}`) };
      const record = { ...version, id: digest(canonical(version)) }; ids.push(record.id);
      writeFileSync(join(root, 'metadata', 'records', `${record.id}.json`), `${canonical(record)}\n`, { flag: 'wx', mode: 0o600 });
    }
    expect(readdirSync(join(root, 'texts'))).toHaveLength(1);
    expect(archive.readSnapshot(ids.slice(0, -1)).status).toBe('complete');
    const result = archive.readSnapshot(ids);
    expect(result).toMatchObject({ status: 'unavailable', entries: [], proofDigest: null }); expect(result.isCurrent()).toBe(false);
  }, 30_000);

  it('invalidates proof when a caller mutates the returned record or text', () => {
    const archive = store(); const selected = entry(); archive.stage(selected);
    const snapshot = archive.readSnapshot([selected.record.id]); expect(snapshot.status).toBe('complete');
    snapshot.entries[0]!.text!.history.prompt = 'caller-mutated'; expect(snapshot.isCurrent()).toBe(false);
  });

  it('preserves no-retention records without creating a text payload or false deletion evidence', () => {
    const selected = entry(true, false); const archive = store();
    expect(archive.stage(selected)).toMatchObject({ textState: 'not-retained' });
    expect(archive.deleteText(selected.record.id)).toMatchObject({ status: 'not-retained' });
    expect(existsSync(join(root, 'texts'))).toBe(false);
  });

  it('rejects a changed task identity even when the proposed record digest is recomputed', () => {
    const selected = entry(); const archive = store(); archive.stage(selected);
    const { id: _id, ...body } = structuredClone(selected.record); body.job.taskDigest = digest('another-task');
    const conflicting = { ...body, id: digest(canonical(body)) };
    expect(() => archive.stage({ record: conflicting, text: selected.text })).toThrow();
    expect(archive.read(selected.record.id)).toMatchObject({ textState: 'available' });
    expect(existsSync(join(root, 'metadata', 'records', `${conflicting.id}.json`))).toBe(false);
  });

  it('refuses corrupt payloads without rewriting them during replay', () => {
    const selected = entry(); const archive = store(); archive.stage(selected);
    writeFileSync(textPath(), '{}\n', { mode: 0o600 });
    expect(archive.read(selected.record.id)).toMatchObject({ status: 'staged', textState: 'unavailable' });
    expect(() => archive.stage(selected)).toThrow(); expect(readFileSync(textPath(), 'utf8')).toBe('{}\n');
  });

  it('refuses live ownership contention without reclaiming the owner or creating records', () => {
    const archive = store(); const lock = acquireLocalStoreLock(join(root, '.archive.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    expect(lock).not.toBeNull();
    try {
      expect(() => archive.stage(entry())).toThrow(); expect(archive.read(entry().record.id).status).toBe('unavailable');
      expect(existsSync(join(root, 'metadata'))).toBe(false);
    } finally { expect(releaseLocalStoreLock(lock)).toBe(true); }
  });

  it('refuses dangling payload links without following or deleting the target', () => {
    const selected = entry(); const archive = store(); archive.stage(selected); unlinkSync(textPath());
    const outside = join(base, 'untouched'); symlinkSync(outside, textPath());
    expect(archive.read(selected.record.id).status).toBe('unavailable');
    expect(() => archive.stage(selected)).toThrow(); expect(existsSync(outside)).toBe(false);
  });

  it('rejects broad permissions and unknown root content without repairing or deleting it', () => {
    chmodSync(root, 0o755); expect(() => store()).toThrow(); chmodSync(root, 0o700);
    writeFileSync(join(root, 'unknown'), 'untouched', { mode: 0o600 }); expect(() => store()).toThrow();
    expect(readFileSync(join(root, 'unknown'), 'utf8')).toBe('untouched');
  });

  it('rejects constructor and staging getters without invoking them', () => {
    let calls = 0; const getter = () => { calls++; return root; };
    expect(() => createResourceConsoleHistoryArchiveStore({ get root() { return getter(); }, scopeDigest })).toThrow();
    const archive = store(); const selected = entry();
    expect(() => archive.stage({ get record() { calls++; return selected.record; }, text: selected.text })).toThrow();
    expect(calls).toBe(0); expect(readdirSync(root)).toEqual([]);
  });
});
