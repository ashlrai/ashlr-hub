/** Real private storage, synthetic validated receipts. No tasks/providers execute. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readdirSync, writeFileSync, unlinkSync, chmodSync, renameSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolReceiptArchive, emptyResourcePoolReceiptArchiveRoot, ResourcePoolReceiptArchiveError } from '../src/core/resources/pool-receipt-archive.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import { createResourcePoolReceiptQuery } from '../src/core/resources/pool-receipt-query.js';
import { createArchivedResourcePoolReceiptQuery } from '../src/core/resources/pool-archived-receipt-query.js';
import type { ResourceTaskReceipt } from '../src/core/resources/pool-receipt-codec.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const assurance = vi.hoisted(() => ({ paths: [] as string[], deniedPath: null as string | null }));
vi.mock('../src/core/util/private-storage.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return { ...actual, assurePrivateStoragePath: (...args: Parameters<typeof actual.assurePrivateStoragePath>) => {
    assurance.paths.push(args[0]);
    return args[0] === assurance.deniedPath ? { ok: false, reason: 'fixture-acl-denied' } : actual.assurePrivateStoragePath(...args);
  } };
});

const pool: ResourcePool = { schemaVersion: 1, id: 'fixture', workers: [{ id: 'worker', provider: 'codex', model: 'fixture',
  maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] };
const bindings: ResourceBinding[] = [{ workerId: 'worker', capacityKey: 'account', kind: 'native-cli', command: ['/inert/worker'] }];
const epoch = resourcePoolConfigSnapshot(pool, bindings);
const nextPool = { ...pool, workers: [...pool.workers, { ...pool.workers[0]!, id: 'second' }] };
const nextBindings: ResourceBinding[] = [...bindings, { workerId: 'second', capacityKey: 'second-account', kind: 'native-cli', command: ['/inert/second'] }];
const nextEpoch = resourcePoolConfigSnapshot(nextPool, nextBindings);
const history = [epoch, nextEpoch];
const receipt = (patch: Partial<ResourceTaskReceipt> = {}): ResourceTaskReceipt => ({ schemaVersion: 1, id: 'task',
  taskDigest: 'a'.repeat(64), poolDigest: epoch.poolDigest, workerId: 'worker', capacityKey: 'account', status: 'completed',
  startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', outputDigest: 'b'.repeat(64),
  inputTokens: null, outputTokens: null, reason: 'worker-completed', verifiedAccepted: false, ...patch });
const roots: string[] = [];
function fixture() {
  const anchorPath = realpathSync(mkdtempSync(join(tmpdir(), 'receipt-archive-'))); roots.push(anchorPath);
  chmodSync(anchorPath, 0o700); const root = join(anchorPath, 'archive'); mkdirSync(root, { mode: 0o700 });
  const config = { root, anchorPath, configurationHistory: structuredClone(history) };
  return { ...config, archive: createResourcePoolReceiptArchive(config), reopen: () => createResourcePoolReceiptArchive(config) };
}
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(row => row.isDirectory() ? files(join(path, row.name)) : [join(path, row.name)]);
}
const noGuard = { guard() {} };
afterEach(() => {
  assurance.paths = []; assurance.deniedPath = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('terminal receipt archive backend (not activated)', () => {
  it('performs one fresh directory-pair assurance at every empty read boundary, with no permission cache', () => {
    const { archive, anchorPath, root } = fixture(); assurance.paths = [];
    expect(archive.get(emptyResourcePoolReceiptArchiveRoot(), 'missing').status).toBe('proven-absent');
    // Three existing boundaries, two directories each; old empty-index count
    // adaptation performed twelve checks for these same six observations.
    expect(assurance.paths).toEqual([anchorPath, root, anchorPath, root, anchorPath, root]);
    assurance.deniedPath = root;
    expect(() => archive.get(emptyResourcePoolReceiptArchiveRoot(), 'missing')).toThrow('evidence unavailable');
  });
  it('pins the lazily observed index directory across calls while retaining fresh ACL checks', () => {
    const { archive, root: path, reopen } = fixture();
    const saved = archive.stage(emptyResourcePoolReceiptArchiveRoot(), receipt(), noGuard).root;
    const indexPath = join(path, 'index'); assurance.deniedPath = indexPath;
    expect(() => archive.get(saved, 'task')).toThrow('evidence unavailable'); assurance.deniedPath = null;
    renameSync(indexPath, indexPath + '-old'); cpSync(indexPath + '-old', indexPath, { recursive: true });
    // cpSync creates directory ancestors using the process umask. Make this a
    // genuinely private byte-identical replacement, not an unsafe-mode fixture.
    const secureCopy = (directory: string) => {
      chmodSync(directory, 0o700);
      for (const row of readdirSync(directory, { withFileTypes: true })) {
        if (row.isDirectory()) secureCopy(join(directory, row.name));
        else chmodSync(join(directory, row.name), 0o600);
      }
    };
    secureCopy(indexPath);
    expect(() => archive.get(saved, 'task')).toThrow('evidence unavailable');
    expect(reopen().get(saved, 'task').status).toBe('found');
  });
  it('reads empty commitments without creating storage and distinguishes bounded batches from history', () => {
    const { root, archive } = fixture(); const empty = emptyResourcePoolReceiptArchiveRoot();
    expect(archive.get(empty, 'missing')).toEqual({ status: 'proven-absent', id: 'missing' });
    expect(archive.page(empty)).toEqual({ items: [], totalReceipts: 0, nextAfterId: null });
    expect(archive.getMany(empty, Array(4096).fill('missing'))).toHaveLength(4096);
    expect(() => archive.getMany(empty, Array(4097).fill('missing'))).toThrow(ResourcePoolReceiptArchiveError);
    expect(readdirSync(root)).toEqual([]);
  });
  it.each(['completed', 'failed', 'timed-out', 'cancelled'] as const)('durably archives %s and exactly replays after cold reopen', status => {
    const { archive, reopen, root } = fixture(); const row = receipt({ status, outputDigest: status === 'completed' ? 'b'.repeat(64) : null });
    const empty = emptyResourcePoolReceiptArchiveRoot(); const beforeStage = performance.now(); const saved = archive.stage(empty, row, noGuard);
    const stageMs = performance.now() - beforeStage;
    expect(saved.replayed).toBe(false); expect(saved.root.byId.count).toBe(1); expect(saved.root.byStart.count).toBe(1);
    const cold = reopen(); const beforeRead = performance.now();
    expect(cold.get(saved.root, row.id)).toEqual({ status: 'found', id: row.id, receipt: row });
    if (status === 'completed') process.stderr.write(JSON.stringify({ fixture: 'synthetic-receipt-archive', stageMs, coldGetMs: performance.now() - beforeRead }) + '\n');
    expect(reopen().stage(saved.root, row, noGuard)).toEqual({ root: saved.root, replayed: true });
    expect(files(root).filter(path => path.endsWith('.json')).length).toBeGreaterThanOrEqual(3);
    expect(archive.get(empty, row.id).status).toBe('proven-absent'); // Staging never selects a root.
    expect(() => archive.stage(saved.root, { ...row, taskDigest: 'c'.repeat(64) }, noGuard)).toThrow('identity conflict');
  });
  it.each(['reserved', 'uncertain'] as const)('never archives active %s rows', status => {
    const { archive, root } = fixture(); const guard = vi.fn();
    expect(() => archive.stage(emptyResourcePoolReceiptArchiveRoot(), receipt({ status, outputDigest: null,
      finishedAt: status === 'reserved' ? null : '2026-01-01T00:00:01.000Z' }), { guard })).toThrow('Invalid receipt archive input');
    expect(guard).not.toHaveBeenCalled(); expect(readdirSync(root)).toEqual([]);
  });
  it('joins historical epochs, preserves unknown metrics, pages IDs and refuses foreign epoch attribution', () => {
    const { archive, reopen } = fixture(); let root = emptyResourcePoolReceiptArchiveRoot();
    const rows = [receipt({ id: 'z' }), receipt({ id: 'a', poolDigest: nextEpoch.poolDigest, workerId: 'second', capacityKey: 'second-account' })];
    for (const row of rows) root = archive.stage(root, row, noGuard).root;
    const first = reopen().page(root, { limit: 1 }); expect(first.items).toEqual([rows[1]]); expect(first.nextAfterId).toBe('a');
    expect(archive.page(root, { afterId: first.nextAfterId!, limit: 1 })).toEqual({ items: [rows[0]], totalReceipts: 2, nextAfterId: null });
    expect(archive.getMany(root, ['z', 'missing', 'a', 'z']).map(row => row.status)).toEqual(['found', 'proven-absent', 'found', 'found']);
    expect(() => archive.stage(root, receipt({ id: 'bad', workerId: 'second', capacityKey: 'second-account' }), noGuard)).toThrow('Invalid receipt archive input');
    const found = archive.get(root, 'z'); if (found.status !== 'found') throw new Error('missing fixture');
    found.receipt.taskDigest = 'f'.repeat(64); expect(archive.get(root, 'z')).toEqual({ status: 'found', id: 'z', receipt: rows[0] });
  });
  it('matches strict account windows, rollback/future starts and exact cooldown exclusions', () => {
    const { archive } = fixture(); let root = emptyResourcePoolReceiptArchiveRoot();
    const rows = [0, 1, 2, 100].map((time, index) => receipt({ id: 'r' + index,
      startedAt: new Date(time).toISOString(), finishedAt: new Date(time + 1).toISOString(),
      status: index === 1 ? 'timed-out' : index === 2 ? 'failed' : 'completed',
      outputDigest: index === 1 || index === 2 ? null : 'b'.repeat(64),
      reason: index === 2 ? 'worker-dispatch-precondition-failed' : 'worker-completed' }));
    for (const row of rows) root = archive.stage(root, row, noGuard).root;
    const query = createResourcePoolReceiptQuery(rows);
    for (const now of [-1e30, -10, 1, 2, 2.5, 3, 100, 1e30]) {
      expect(archive.accountWindow(root, 'account', 1, now)).toEqual(query.accountWindow('account', 1, now));
    }
    expect(archive.accountWindow(root, 'account', 1, 2).latestCooldownFailureFinishedAtMs).toBe(2);
    expect(archive.accountWindow(root, 'second-account', 1, 0).recentReservationCount).toBe(0);
  });
  it.each(['missing-payload', 'corrupt-payload', 'missing-index', 'corrupt-index'] as const)('refuses %s instead of reporting absence', mode => {
    const { archive, root: path } = fixture(); const saved = archive.stage(emptyResourcePoolReceiptArchiveRoot(), receipt(), noGuard).root;
    const target = mode.endsWith('payload') ? files(join(path, 'payloads')).find(file => file.includes('/records/'))! :
      join(path, 'index', 'nodes', saved.byId.nodeDigest!.slice(0, 2), saved.byId.nodeDigest!.slice(2, 4), saved.byId.nodeDigest! + '.json');
    if (mode.startsWith('missing')) unlinkSync(target); else writeFileSync(target, '{}\n');
    expect(() => archive.get(saved, 'task')).toThrow('evidence unavailable');
  });
  it('refuses unsafe payload ancestors and exchanged archive root', () => {
    const { archive, root: path } = fixture(); const saved = archive.stage(emptyResourcePoolReceiptArchiveRoot(), receipt(), noGuard).root;
    const payloads = join(path, 'payloads'); chmodSync(payloads, 0o755);
    expect(() => archive.get(saved, 'task')).toThrow(); chmodSync(payloads, 0o700);
    renameSync(payloads, payloads + '-old'); symlinkSync(payloads + '-old', payloads);
    expect(() => archive.get(saved, 'task')).toThrow();
    renameSync(path, path + '-old'); mkdirSync(path, { mode: 0o700 });
    expect(() => archive.get(emptyResourcePoolReceiptArchiveRoot(), 'task')).toThrow();
  });
  it('captures caller data before guard effects and leaves interrupted staging unpublished', () => {
    const { archive, root: path } = fixture(); const row = receipt(); const empty = emptyResourcePoolReceiptArchiveRoot();
    const saved = archive.stage(empty, row, { guard() { row.id = 'mutated'; empty.byId.count = 999; } }).root;
    expect(archive.get(saved, 'task').status).toBe('found');
    const previous = structuredClone(saved);
    expect(() => archive.stage(saved, receipt({ id: 'second' }), { guard() {
      if (files(path).filter(file => file.includes('/records/')).length === 2) throw new Error('stop fixture');
    } })).toThrow('evidence unavailable');
    expect(archive.get(previous, 'task').status).toBe('found'); expect(archive.get(previous, 'second').status).toBe('proven-absent');
  });
  it('rechecks exact dependencies after the final replay guard', () => {
    const { archive, root: path } = fixture(); const saved = archive.stage(emptyResourcePoolReceiptArchiveRoot(), receipt(), noGuard).root;
    const file = files(path).find(file => file.includes('/records/'))!; let guards = 0;
    expect(() => archive.stage(saved, receipt(), { guard() { if (++guards === 3) unlinkSync(file); } })).toThrow('evidence unavailable');
    expect(guards).toBe(3);
  });
  it('refuses newly staged dependencies removed by the final callback, without activating the root', () => {
    const baseline = fixture(); let calls = 0;
    baseline.archive.stage(emptyResourcePoolReceiptArchiveRoot(), receipt(), { guard() { calls++; } });
    const { archive, root: path } = fixture(); let current = 0; const empty = emptyResourcePoolReceiptArchiveRoot();
    expect(() => archive.stage(empty, receipt(), { guard() {
      if (++current === calls) unlinkSync(files(path).find(file => file.includes('/records/'))!);
    } })).toThrow('evidence unavailable');
    expect(current).toBe(calls); expect(archive.get(empty, 'task').status).toBe('proven-absent');
  });
  it('checks ancestor privacy after the publication callback and before linking payload bytes', () => {
    const { archive, root: path } = fixture(); let changed = false;
    expect(() => archive.stage(emptyResourcePoolReceiptArchiveRoot(), receipt(), { guard() {
      if (files(path).some(file => file.endsWith('.stage'))) {
        chmodSync(join(path, 'payloads'), 0o755); changed = true;
      }
    } })).toThrow('evidence unavailable');
    expect(changed).toBe(true);
    expect(files(path).filter(file => file.includes('/records/'))).toEqual([]);
  });
  it('composes actual archived terminals with active reservations and uncertainty without paging history', () => {
    const { archive, root: path } = fixture(); let root = emptyResourcePoolReceiptArchiveRoot();
    const terminal = [receipt(), receipt({ id: 'failed', status: 'failed', outputDigest: null })];
    for (const row of terminal) root = archive.stage(root, row, noGuard).root;
    const active = [receipt({ id: 'reserved', status: 'reserved', finishedAt: null, outputDigest: null }),
      receipt({ id: 'uncertain', status: 'uncertain', outputDigest: null })];
    const page = vi.spyOn(archive, 'page'); const composed = createArchivedResourcePoolReceiptQuery({ active, archive, root });
    const expected = createResourcePoolReceiptQuery([...active, ...terminal]);
    expect(composed.getMany(['task', 'reserved', 'missing', 'uncertain', 'failed', 'task']))
      .toEqual(expected.getMany(['task', 'reserved', 'missing', 'uncertain', 'failed', 'task']));
    expect(composed.unresolved()).toEqual(active);
    const now = Date.parse(terminal[0]!.startedAt);
    expect(composed.accountWindow('account', 60_000, now)).toEqual(expected.accountWindow('account', 60_000, now));
    expect(composed.accountWindow('account', 1, now - 100)).toEqual(expected.accountWindow('account', 1, now - 100));
    expect(() => createArchivedResourcePoolReceiptQuery({ active: [{ ...active[0]!, id: 'task' }], archive, root })).toThrow();
    expect(page).not.toHaveBeenCalled();
    unlinkSync(files(path).find(file => file.includes('/records/'))!);
    expect(() => composed.getMany(['task', 'failed'])).toThrow('Resource receipt query unavailable');
  });
  it('refuses malformed/accessor/proxy inputs without executing caller properties or guard', () => {
    const { archive, root: path } = fixture(); const empty = emptyResourcePoolReceiptArchiveRoot(); const getter = vi.fn();
    for (const value of [null, [], 1, { limit: 0 }, { unknown: true }]) {
      expect(() => archive.page(empty, value as never)).toThrow('Invalid receipt archive input');
    }
    const row = Object.defineProperty(receipt(), 'id', { enumerable: true, get: getter });
    expect(() => archive.stage(empty, row, { guard: getter })).toThrow('Invalid receipt archive input');
    expect(() => archive.stage(empty, new Proxy(receipt(), { ownKeys: getter }), { guard: getter })).toThrow('Invalid receipt archive input');
    expect(() => archive.getMany(empty, new Array(1))).toThrow('Invalid receipt archive input');
    expect(getter).not.toHaveBeenCalled(); expect(readdirSync(path)).toEqual([]);
  });
  it('binds failure pointers to exact qualifying receipt and timestamp', () => {
    const { archive } = fixture(); const saved = archive.stage(emptyResourcePoolReceiptArchiveRoot(), receipt({ status: 'failed', outputDigest: null }), noGuard).root;
    expect(saved.latestFailures).toHaveLength(1);
    for (const patch of [{ id: 'missing' }, { finishedAtMs: 0 }, { capacityKey: 'second-account' }]) {
      const changed = structuredClone(saved); Object.assign(changed.latestFailures[0]!, patch);
      expect(() => archive.page(changed)).toThrow('evidence unavailable');
    }
  });
});
