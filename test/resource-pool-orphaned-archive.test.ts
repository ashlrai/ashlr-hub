/** Real private filesystem refusal; inert worker observer, no provider contact. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '../src/core/resources/pool-runtime.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import * as workers from '../src/core/resources/worker.js';

const hooks = vi.hoisted(() => ({ afterSync: null as (() => void) | null }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
    const result = actual.fsyncSync(...args); hooks.afterSync?.(); return result;
  } };
});
const roots: string[] = [];
afterEach(() => {
  hooks.afterSync = null; vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(create = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pool-orphaned-archive-'))); roots.push(base);
  const root = join(base, 'ledger'); const cwd = join(base, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  if (create) mkdirSync(root, { mode: 0o700 });
  const pool: ResourcePool = { schemaVersion: 1, id: 'orphan-test', workers: [{ id: 'local', provider: 'local', model: 'inert',
    maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] };
  const bindings: workers.ResourceBinding[] = [{ workerId: 'local', capacityKey: 'local-account', kind: 'local-chat',
    endpoint: 'http://127.0.0.1:1/v1' }];
  const now = Date.now();
  const observations: ResourceObservation[] = [{ workerId: 'local', observedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(), health: 'ready', retryAfter: null, windows: [] }];
  const execute = vi.spyOn(workers, 'executeResourceWorker').mockImplementation(async () => { throw new Error('Unexpected worker contact'); });
  const evidence = vi.fn(() => ({ observations, unavailableWorkerIds: [] }));
  const reads = [
    () => runtime.resourcePoolStatus(root, pool, bindings, []),
    () => runtime.resourcePoolQueryStatus(root, pool, bindings, []),
    () => runtime.resourceAdmissionPreflight(root, pool, bindings, ['local'], evidence()),
    () => runtime.readResourcePoolHistory(root, pool, bindings),
    () => runtime.readResourcePoolAllocation(root, pool, bindings),
    () => runtime.readResourceWorkerAccess(root, pool, bindings),
    () => runtime.readResourceQuotaScopeAccess(root, pool, bindings),
  ];
  const writes = [
    () => runtime.setResourcePoolAllocation(root, pool, bindings, 75, 0),
    () => runtime.setResourceWorkerAccess(root, pool, bindings, ['local'], 0),
    () => runtime.setResourceQuotaScopeAccess(root, pool, bindings, [], 0),
  ];
  const run = (change: () => void = () => {}) => runtime.runResourceTask({ root, pool, bindings, observations,
    task: { schemaVersion: 1, id: 'task', prompt: 'inert', cwd, mode: 'read-only', allowedWorkerIds: ['local'], timeoutMs: 1000, maxOutputTokens: 32 },
    readAdmissionEvidence: () => { change(); return evidence(); } });
  return { root, pool, bindings, reads, writes, run, execute, evidence };
}
const names = ['receipt-archive', 'receipt-archive.key'] as const;
const kinds = ['directory', 'file', 'unsafe-file', 'dangling-link'] as const;
function residue(root: string, name: string, kind: typeof kinds[number]) {
  const file = join(root, name);
  if (kind === 'directory') mkdirSync(file, { mode: 0o700 });
  else if (kind === 'dangling-link') symlinkSync(join(root, 'missing-target'), file);
  else writeFileSync(file, 'PRIVATE_INERT_ARCHIVE_MARKER', { mode: kind === 'unsafe-file' ? 0o644 : 0o600 });
  const before = lstatSync(file, { bigint: true });
  return () => {
    const after = lstatSync(file, { bigint: true });
    for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const) expect(after[key]).toBe(before[key]);
    if (kind === 'dangling-link') expect(readlinkSync(file)).toBe(join(root, 'missing-target'));
    else if (kind !== 'directory') expect(readFileSync(file, 'utf8')).toBe('PRIVATE_INERT_ARCHIVE_MARKER');
    expect(readdirSync(root)).toEqual([name]);
  };
}

describe.skipIf(process.platform === 'win32')('orphaned receipt archive cannot become an empty pool', () => {
  for (const name of names) {
    it.each(kinds)('refuses every read, policy write and admission with ' + name + ' %s residue', async kind => {
      const f = fixture(); const unchanged = residue(f.root, name, kind);
      for (const read of f.reads) { expect(read).toThrow('Resource ledger incomplete'); unchanged(); }
      for (const write of f.writes) { expect(write).toThrow('Resource ledger incomplete'); unchanged(); }
      f.evidence.mockClear();
      await expect(f.run()).rejects.toThrow('Resource ledger incomplete');
      expect(f.evidence).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); unchanged();
    });
    it('refuses ' + name + ' created during fresh admission', async () => {
      const f = fixture(); let unchanged: (() => void) | undefined;
      await expect(f.run(() => { unchanged = residue(f.root, name, 'dangling-link'); })).rejects.toThrow('Resource ledger incomplete');
      expect(f.evidence).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled(); unchanged!();
    });
    it('refuses ' + name + ' created after header staging/fsync', async () => {
      const f = fixture(); let unchanged: (() => void) | undefined;
      hooks.afterSync = () => {
        if (!readdirSync(f.root).some(name => name.startsWith('.pool-state-'))) return;
        hooks.afterSync = null; unchanged = residue(f.root, name, 'file');
      };
      await expect(f.run()).rejects.toThrow('Resource ledger incomplete');
      expect(unchanged).toBeDefined(); expect(f.execute).not.toHaveBeenCalled(); unchanged!();
    });
  }
  it.each([false, true])('preserves ordinary missing-state defaults with existing root=%s and permits policy initialization', create => {
    const f = fixture(create);
    for (const read of f.reads) expect(read).not.toThrow();
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
    if (create) expect(readdirSync(f.root)).toEqual([]); else expect(existsSync(f.root)).toBe(false);
    expect(f.writes[0]!()).toMatchObject({ ceilingPercent: 75, revision: 1 });
    expect(runtime.resourcePoolStatus(f.root, f.pool, f.bindings, []).attempts).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('refuses a dangling active-state path rather than following it or creating an empty ledger', async () => {
    const f = fixture(); const unchanged = residue(f.root, 'pool-state.json', 'dangling-link');
    for (const read of f.reads) expect(read).toThrow();
    for (const write of f.writes) expect(write).toThrow();
    await expect(f.run()).rejects.toThrow(); unchanged(); expect(f.execute).not.toHaveBeenCalled();
  });
});
