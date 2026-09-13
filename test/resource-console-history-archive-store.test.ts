/** Real private filesystem staging, not active console compaction or provider execution. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

let base: string; let root: string;
const faults = vi.hoisted(() => ({ unlinkPath: null as string | null }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, unlinkSync(path: Parameters<typeof actual.unlinkSync>[0]) {
    if (path === faults.unlinkPath) { faults.unlinkPath = null; throw new Error('Fixture interruption after tombstone'); }
    return actual.unlinkSync(path);
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
afterEach(() => { faults.unlinkPath = null; rmSync(base, { recursive: true, force: true }); });

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
