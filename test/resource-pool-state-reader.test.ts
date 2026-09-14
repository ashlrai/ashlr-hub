/** Read-only snapshots over private synthetic fixtures; no providers or enrollment. */
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourcePoolState } from '../src/core/resources/pool-runtime.js';
import { readResourcePoolStorageSnapshot } from '../src/core/resources/pool-state-reader.js';
import { compareResourcePoolStorageReceipts, readResourcePoolStorage, stageResourcePoolReceiptCompaction } from '../src/core/resources/pool-state-storage.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const hooks = vi.hoisted(() => ({ afterAssurance: null as ((path: string) => void) | null, afterRead: null as (() => void) | null }));
vi.mock('../src/core/util/private-storage.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return { ...actual, assurePrivateStoragePath: (...args: Parameters<typeof actual.assurePrivateStoragePath>) => {
    const result = actual.assurePrivateStoragePath(...args); hooks.afterAssurance?.(args[0]); return result;
  } };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: (...args: Parameters<typeof actual.readSync>) => {
    const result = actual.readSync(...args); hooks.afterRead?.(); return result;
  } };
});
const pool: ResourcePool = { schemaVersion: 1, id: 'reader-fixture', workers: [{ id: 'worker', provider: 'codex', model: 'fixture',
  maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] };
const bindings: ResourceBinding[] = [{ workerId: 'worker', capacityKey: 'account', kind: 'native-cli', command: ['/inert/worker'] }];
const epoch = resourcePoolConfigSnapshot(pool, bindings);
const state = (): ResourcePoolState => ({ schemaVersion: 2, poolDigest: epoch.poolDigest, configurationHistory: [structuredClone(epoch)],
  observations: [], allocation: { ceilingPercent: 75, revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' }, attempts: [{
    schemaVersion: 1, id: 'done', taskDigest: 'a'.repeat(64), poolDigest: epoch.poolDigest, workerId: 'worker', capacityKey: 'account',
    status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
    outputDigest: 'b'.repeat(64), inputTokens: null, outputTokens: null, reason: 'worker-completed', verifiedAccepted: false,
  }] });
const roots: string[] = [];
function fixture(rootPresent = true, headerPresent = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pool-state-reader-'))); roots.push(base); chmodSync(base, 0o700);
  const root = join(base, 'ledger'); const file = join(root, 'pool-state.json'); const source = state(); const bytes = canonical(source) + '\n';
  if (rootPresent) mkdirSync(root, { mode: 0o700 });
  if (rootPresent && headerPresent) writeFileSync(file, bytes, { mode: 0o600 });
  return { base, root, file, source, bytes, read: () => readResourcePoolStorageSnapshot(root, pool, bindings) };
}
function archiveFixture() {
  const f = fixture(); mkdirSync(join(f.root, 'receipt-archive'), { mode: 0o700 });
  const key = join(f.root, 'receipt-archive.key'); writeFileSync(key, '11'.repeat(32) + '\n', { mode: 0o600 });
  const header = stageResourcePoolReceiptCompaction(readResourcePoolStorage(f.source, { root: f.root, pool, bindings, archiveKeyFile: key }), ['done'], { guard() {} });
  const bytes = canonical(header) + '\n'; writeFileSync(f.file, bytes);
  return { ...f, key, header, bytes, read: () => readResourcePoolStorageSnapshot(f.root, pool, bindings, key) };
}
function replace(file: string) {
  const next = file + '-replacement'; writeFileSync(next, readFileSync(file), { mode: 0o600 }); renameSync(next, file);
}
afterEach(() => {
  hooks.afterAssurance = null; hooks.afterRead = null; vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('fresh read-only resource storage snapshots', () => {
  it.each([false, true])('preserves empty legacy defaults without creating root/header, existing root=%s', existing => {
    const f = fixture(existing, false); const snapshot = f.read();
    expect(snapshot.view.hotState).toEqual({ schemaVersion: 1, poolDigest: epoch.poolDigest, attempts: [], observations: [] });
    expect(snapshot.view.receipts.get('absent')).toEqual({ status: 'proven-absent', id: 'absent' });
    expect(compareResourcePoolStorageReceipts(snapshot.view, snapshot.view, { maxNodes: 1, maxChanges: 0 }).equal).toBe(true);
    expect(snapshot.isCurrent()).toBe(true); expect(existsSync(f.file)).toBe(false);
    if (existing) expect(readdirSync(f.root)).toEqual([]); else expect(existsSync(f.root)).toBe(false);
    if (!existing) mkdirSync(f.root, { mode: 0o700 }); else writeFileSync(f.file, f.bytes, { mode: 0o600 });
    expect(snapshot.isCurrent()).toBe(false); expect(snapshot.view.hotState.attempts).toEqual([]);
  });

  it.each(['receipt-archive', 'receipt-archive.key'])('refuses orphan fixed identity %s, including dangling links, without repair', name => {
    const f = fixture(true, false); const marker = join(f.root, name); symlinkSync(join(f.root, 'absent'), marker);
    const before = lstatSync(marker, { bigint: true }); expect(f.read).toThrow();
    expect(lstatSync(marker, { bigint: true })).toMatchObject({ ino: before.ino, mode: before.mode, size: before.size });
    expect(readdirSync(f.root)).toEqual([name]); expect(existsSync(f.file)).toBe(false);
  });

  it('invalidates a captured empty state when orphan evidence appears without a header', () => {
    const f = fixture(true, false); const snapshot = f.read();
    writeFileSync(join(f.root, 'receipt-archive.key'), '11'.repeat(32) + '\n', { mode: 0o600 });
    expect(snapshot.isCurrent()).toBe(false); expect(f.read).toThrow(); expect(existsSync(f.file)).toBe(false);
  });

  it.each(['mode', 'file', 'symlink', 'dangling-link'] as const)('refuses unsafe root %s instead of interpreting it as empty', kind => {
    const f = fixture(false, false);
    if (kind === 'mode') { mkdirSync(f.root, { mode: 0o700 }); chmodSync(f.root, 0o755); }
    if (kind === 'file') writeFileSync(f.root, '{}', { mode: 0o600 });
    if (kind === 'symlink') { const target = join(f.base, 'actual'); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, f.root); }
    if (kind === 'dangling-link') symlinkSync(join(f.base, 'absent'), f.root);
    const before = lstatSync(f.root, { bigint: true }); expect(f.read).toThrow();
    expect(lstatSync(f.root, { bigint: true })).toMatchObject({ ino: before.ino, mode: before.mode });
  });

  it.each(['mode', 'directory', 'symlink', 'hardlink', 'malformed', 'oversized'] as const)('refuses unsafe active file %s without repair', kind => {
    const f = fixture();
    if (kind === 'mode') chmodSync(f.file, 0o644);
    if (kind === 'directory') { unlinkSync(f.file); mkdirSync(f.file, { mode: 0o700 }); }
    if (kind === 'symlink') { renameSync(f.file, f.file + '-actual'); symlinkSync(f.file + '-actual', f.file); }
    if (kind === 'hardlink') linkSync(f.file, f.file + '-alias');
    if (kind === 'malformed') writeFileSync(f.file, '{');
    if (kind === 'oversized') writeFileSync(f.file, Buffer.alloc(4 * 1024 * 1024 + 1, ' '));
    const before = lstatSync(f.file, { bigint: true }); expect(f.read).toThrow();
    expect(lstatSync(f.file, { bigint: true })).toMatchObject({ ino: before.ino, mode: before.mode, size: before.size, nlink: before.nlink });
  });

  it('refuses pending evolution and wrong configuration instead of exposing a partial legacy view', () => {
    const f = fixture(); writeFileSync(f.file, canonical({ ...f.source, pendingEvolution: { planDigest: 'c'.repeat(64) } }) + '\n');
    const bytes = readFileSync(f.file, 'utf8'); expect(f.read).toThrow(); expect(readFileSync(f.file, 'utf8')).toBe(bytes);
    writeFileSync(f.file, f.bytes); const changed = structuredClone(pool); changed.workers[0]!.model = 'different';
    expect(() => readResourcePoolStorageSnapshot(f.root, changed, bindings)).toThrow(); expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('keeps an explicit alternate key lazy for legacy state but rejects a key outside the captured root', () => {
    const f = fixture(); const key = join(f.root, 'alternate.key');
    expect(readResourcePoolStorageSnapshot(f.root, pool, bindings, key).isCurrent()).toBe(true); expect(existsSync(key)).toBe(false);
    writeFileSync(key, 'not-a-key', { mode: 0o600 }); chmodSync(key, 0o644);
    expect(readResourcePoolStorageSnapshot(f.root, pool, bindings, key).isCurrent()).toBe(true);
    expect(readFileSync(key, 'utf8')).toBe('not-a-key'); expect(lstatSync(key).mode & 0o777).toBe(0o644);
    expect(() => readResourcePoolStorageSnapshot(f.root, pool, bindings, join(f.base, 'other.key'))).toThrow();
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('returns an authentic private view while keeping source freshness separate from archive-only freshness', () => {
    const f = fixture(); const snapshot = f.read();
    expect(snapshot.view.hotState).toEqual(f.source); expect(snapshot.isCurrent()).toBe(true);
    expect(compareResourcePoolStorageReceipts(snapshot.view, snapshot.view, { maxNodes: 1, maxChanges: 0 }).equal).toBe(true);
    snapshot.view.hotState.attempts.length = 0;
    expect(snapshot.view.receipts.get('done')).toMatchObject({ status: 'found', receipt: f.source.attempts[0] });
    writeFileSync(join(f.root, 'unrelated'), 'inert', { mode: 0o600 }); expect(snapshot.isCurrent()).toBe(true);
    replace(f.file); expect(snapshot.isCurrent()).toBe(false); expect(snapshot.view.isCurrent()).toBe(true);
    expect(snapshot.isCurrent()).toBe(false); expect(f.read().isCurrent()).toBe(true);
  });

  it.each([false, true])('retains custody across safe header replacement without renewing source freshness, archived=%s', archived => {
    const f = archived ? archiveFixture() : fixture(); const snapshot = f.read();
    expect(snapshot.isCustodyCurrent()).toBe(true);
    replace(f.file);
    expect(snapshot.isCustodyCurrent()).toBe(true); expect(snapshot.isCurrent()).toBe(false);
    const fresh = f.read();
    expect(compareResourcePoolStorageReceipts(snapshot.view, fresh.view, { maxNodes: 4096, maxChanges: 0 }).equal).toBe(true);
    expect(fresh.isCurrent()).toBe(true);
  });

  it.each(['root-swap', 'mode', 'symlink'] as const)('custody does not survive original root %s', kind => {
    const f = fixture(); const snapshot = f.read();
    if (kind === 'mode') chmodSync(f.root, 0o755);
    else {
      renameSync(f.root, f.root + '-old');
      if (kind === 'symlink') symlinkSync(f.root + '-old', f.root);
      else { mkdirSync(f.root, { mode: 0o700 }); writeFileSync(f.file, f.bytes, { mode: 0o600 }); }
    }
    expect(snapshot.isCustodyCurrent()).toBe(false); expect(snapshot.isCurrent()).toBe(false);
  });

  it.each(['directory', 'archive-key'] as const)('rechecks root identity after %s custody assurance callbacks', boundary => {
    const f = archiveFixture(); const snapshot = f.read(); let changed = false;
    hooks.afterAssurance = path => {
      if (path !== (boundary === 'directory' ? f.root : f.key) || changed) return;
      changed = true; hooks.afterAssurance = null;
      renameSync(f.root, f.root + '-old'); mkdirSync(f.root, { mode: 0o700 });
      writeFileSync(f.file, f.bytes, { mode: 0o600 });
    };
    expect(snapshot.isCustodyCurrent()).toBe(false); expect(changed).toBe(true);
    expect(snapshot.isCurrent()).toBe(false);
  });

  it('does not confuse custody with current header contents or receipt equality', () => {
    const f = fixture(); const snapshot = f.read(); const changed = state(); changed.attempts = [];
    const next = f.file + '-next'; writeFileSync(next, canonical(changed) + '\n', { mode: 0o600 }); renameSync(next, f.file);
    expect(snapshot.isCustodyCurrent()).toBe(true); expect(snapshot.isCurrent()).toBe(false);
    expect(compareResourcePoolStorageReceipts(snapshot.view, f.read().view, { maxNodes: 1, maxChanges: 1 }))
      .toMatchObject({ equal: false, preservesBefore: false });
  });

  it('refuses lost archive key custody even when the header is untouched', () => {
    const f = archiveFixture(); const snapshot = f.read(); unlinkSync(f.key);
    expect(snapshot.isCustodyCurrent()).toBe(false); expect(snapshot.isCurrent()).toBe(false);
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it.each(['in-place', 'delete', 'root-swap'] as const)('invalidates rather than renewing an existing snapshot after %s', kind => {
    const f = fixture(); const snapshot = f.read();
    if (kind === 'in-place') writeFileSync(f.file, f.bytes.replace('75', '74'));
    if (kind === 'delete') unlinkSync(f.file);
    if (kind === 'root-swap') { renameSync(f.root, f.root + '-old'); mkdirSync(f.root, { mode: 0o700 }); writeFileSync(f.file, f.bytes, { mode: 0o600 }); }
    expect(snapshot.isCurrent()).toBe(false); expect(snapshot.isCurrent()).toBe(false);
  });

  it.each(['before-open', 'after-read'] as const)('refuses even one safe atomic replacement during snapshot acquisition: %s', stage => {
    const f = fixture(); let changed = false;
    if (stage === 'before-open') hooks.afterAssurance = path => {
      if (path === f.file && !changed) { changed = true; hooks.afterAssurance = null; replace(f.file); }
    };
    else hooks.afterRead = () => { if (!changed) { changed = true; hooks.afterRead = null; replace(f.file); } };
    expect(f.read).toThrow(); expect(changed).toBe(true); expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('checks the captured source after freshness ACL callbacks rather than trusting pre-callback inode metadata', () => {
    const f = fixture(); const snapshot = f.read(); let changed = false;
    hooks.afterAssurance = path => { if (path === f.file && !changed) { changed = true; hooks.afterAssurance = null; replace(f.file); } };
    expect(snapshot.isCurrent()).toBe(false); expect(changed).toBe(true); expect(snapshot.isCurrent()).toBe(false);
  });

  it('captures caller configuration before filesystem callbacks and never evaluates hostile input getters', () => {
    const f = fixture(); const suppliedPool = structuredClone(pool); const suppliedBindings = structuredClone(bindings); let changed = false;
    hooks.afterAssurance = () => { if (!changed) { changed = true; suppliedPool.workers.length = 0; suppliedBindings.length = 0; } };
    const snapshot = readResourcePoolStorageSnapshot(f.root, suppliedPool, suppliedBindings);
    expect(changed).toBe(true); expect(snapshot.isCurrent()).toBe(true); expect(snapshot.view.hotState).toEqual(f.source);
    const getter = vi.fn(); const assurance = vi.fn(); hooks.afterAssurance = assurance;
    const hostile = Object.defineProperty(structuredClone(pool), 'workers', { enumerable: true, get: getter });
    expect(() => readResourcePoolStorageSnapshot(f.root, hostile, bindings)).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(assurance).not.toHaveBeenCalled();
    expect(() => readResourcePoolStorageSnapshot(f.root + '/../ledger', pool, bindings)).toThrow();
    expect(assurance).not.toHaveBeenCalled();
  });

  it('reads a schema3 header only with its explicit key, and same-byte key replacement invalidates the old snapshot', () => {
    const f = archiveFixture(); expect(() => readResourcePoolStorageSnapshot(f.root, pool, bindings)).toThrow();
    const snapshot = f.read(); expect(snapshot.isCurrent()).toBe(true); expect(snapshot.view.hotState.attempts).toEqual([]);
    expect(snapshot.view.receipts.get('done')).toEqual({ status: 'found', id: 'done', receipt: f.source.attempts[0] });
    replace(f.key); expect(snapshot.isCurrent()).toBe(false); expect(snapshot.view.isCurrent()).toBe(false);
    expect(snapshot.isCustodyCurrent()).toBe(false);
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('rechecks the header after archive custody callbacks before reporting snapshot freshness', () => {
    const f = archiveFixture(); const snapshot = f.read(); let changed = false;
    hooks.afterAssurance = path => { if (path === f.key && !changed) { changed = true; hooks.afterAssurance = null; replace(f.file); } };
    expect(snapshot.isCurrent()).toBe(false); expect(changed).toBe(true); expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });
});
