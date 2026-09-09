/** Private resource ledgers and inert worker transport; no account, provider, or live configuration contact. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { readResourcePoolAllocation, readResourceWorkerAccess, resourcePoolStatus, runResourceTask, setResourcePoolAllocation,
  setResourceWorkerAccess, type ResourceTask } from '../src/core/resources/pool-runtime.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import * as workers from '../src/core/resources/worker.js';
import * as locks from '../src/core/fleet/local-store-lock.js';

let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-worker-access-'))); });
afterEach(() => { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });
function fixture(aliases = false) {
  const root = join(base, 'ledger'); const cwd = join(base, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  const pool: ResourcePool = { schemaVersion: 1, id: 'worker-access', workers: [
    'codex-personal', 'codex-cmp', ...(aliases ? ['personal-alias'] : []), 'local',
  ].map((id) => ({ id, provider: id === 'local' ? 'local' : 'codex', model: 'fixture', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: id === 'codex-personal' ? 10 : id === 'local' ? 0 : 1,
    allowUnknownQuota: false })) };
  const bindings: workers.ResourceBinding[] = pool.workers.map((worker) => worker.provider === 'local'
    ? { workerId: worker.id, capacityKey: worker.id, kind: 'local-chat', endpoint: 'http://127.0.0.1:23456/v1' }
    : { workerId: worker.id, capacityKey: worker.id === 'personal-alias' ? 'codex-personal' : worker.id,
      kind: 'native-cli', command: [`/test-owned/${worker.id}`] });
  const now = Date.now();
  const observations: ResourceObservation[] = pool.workers.map((worker) => ({ workerId: worker.id,
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), health: 'ready', retryAfter: null,
    windows: worker.provider === 'local' ? [] : [{ id: 'weekly', usedPercent: 10, resetsAt: new Date(now + 3_600_000).toISOString() }] }));
  const task = (id = 'fixture-task', allowedWorkerIds = ['codex-personal', 'codex-cmp']): ResourceTask => ({ schemaVersion: 1, id,
    allowedWorkerIds, prompt: 'Inert task', cwd, timeoutMs: 1000, maxOutputTokens: 100, mode: 'read-only' });
  const execute = vi.spyOn(workers, 'executeResourceWorker').mockResolvedValue({ status: 'completed', output: 'fixture',
    inputTokens: 7, outputTokens: 3, usageScope: 'codex-turn', reason: 'worker-completed' });
  const set = (paused = ['codex-personal'], revision = 0) => setResourceWorkerAccess(root, pool, bindings, paused, revision);
  const read = () => readResourceWorkerAccess(root, pool, bindings);
  const status = () => resourcePoolStatus(root, pool, bindings, observations);
  const run = (id?: string, allowedWorkerIds?: string[], readAdmissionEvidence?: () => { observations: ResourceObservation[]; unavailableWorkerIds: string[] }) =>
    runResourceTask({ root, pool, bindings, observations, task: task(id, allowedWorkerIds), ...(readAdmissionEvidence ? { readAdmissionEvidence } : {}) });
  return { root, cwd, pool, bindings, observations, task, execute, set, read, status, run, stateFile: join(root, 'pool-state.json') };
}

describe.skipIf(process.platform === 'win32')('durable per-worker task access', () => {
  it('defaults missing and legacy ledgers to no explicit pause without writing a policy', async () => {
    const f = fixture(); expect(f.read()).toEqual({ pausedWorkerIds: [], revision: 0, updatedAt: null });
    expect(existsSync(f.root)).toBe(false); expect(f.status().workerAccess).toEqual(f.read()); expect(existsSync(f.root)).toBe(false);
    await f.run(); const before = readFileSync(f.stateFile); expect(JSON.parse(before.toString())).not.toHaveProperty('workerAccess');
    expect(f.read()).toEqual({ pausedWorkerIds: [], revision: 0, updatedAt: null }); expect(readFileSync(f.stateFile)).toEqual(before);
  });

  it('pauses personal task admission while CMP remains selected with measured health intact', async () => {
    const f = fixture(); expect(f.status().plan.selectedWorkerId).toBe('codex-personal');
    expect(f.set()).toMatchObject({ pausedWorkerIds: ['codex-personal'], revision: 1 });
    expect(f.status().plan.selectedWorkerId).toBe('codex-cmp');
    expect(f.status().observations).toEqual(f.observations);
    expect((await f.run('personal-only', ['codex-personal'])).receipt).toBeNull();
    expect((await f.run('fleet')).receipt?.workerId).toBe('codex-cmp'); expect(f.execute).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(f.stateFile, 'utf8')).observations.every((row: ResourceObservation) => row.health === 'ready')).toBe(true);
  });

  it('blocks every shared-capacity alias without silently expanding the saved explicit selection', async () => {
    const f = fixture(true); f.set();
    expect((await f.run('alias', ['personal-alias'])).receipt).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
    expect(f.read().pausedWorkerIds).toEqual(['codex-personal']); expect(f.status().plan.selectedWorkerId).toBe('codex-cmp');
  });

  it('normalizes/detaches access lists and preserves enrollment, receipts, and independent allocation', async () => {
    const f = fixture(); await f.run(); const receipt = f.status().attempts[0];
    const allocation = setResourcePoolAllocation(f.root, f.pool, f.bindings, 75, 0);
    const enrolled = canonical({ pool: f.pool, bindings: f.bindings }); const paused = ['codex-personal', 'codex-cmp'];
    const saved = f.set(paused); paused.length = 0; saved.pausedWorkerIds.length = 0;
    expect(f.read().pausedWorkerIds).toEqual(['codex-cmp', 'codex-personal']);
    const again = f.read(); again.pausedWorkerIds.push('local'); expect(f.read().pausedWorkerIds).not.toContain('local');
    expect(f.status().attempts).toEqual([receipt]); expect(readResourcePoolAllocation(f.root, f.pool, f.bindings)).toEqual(allocation);
    expect(canonical({ pool: f.pool, bindings: f.bindings })).toBe(enrolled);
    expect(JSON.parse(readFileSync(f.stateFile, 'utf8')).poolDigest).toBe(digest(enrolled));
    expect(statSync(f.stateFile).mode & 0o777).toBe(0o600);
  });

  it('uses independent CAS revisions and supports explicit unpause', async () => {
    const f = fixture(); f.set(); const before = readFileSync(f.stateFile);
    expect(() => f.set([], 0)).toThrow('revision conflict'); expect(readFileSync(f.stateFile)).toEqual(before);
    expect(f.set([], 1)).toMatchObject({ pausedWorkerIds: [], revision: 2 });
    expect(f.status().plan.selectedWorkerId).toBe('codex-personal'); expect((await f.run()).receipt?.workerId).toBe('codex-personal');
  });

  it('uses the same admission lock and refuses concurrent policy writes', () => {
    const f = fixture(); f.set(); const lock = locks.acquireLocalStoreLock(join(f.root, '.pool.lock'), 500)!;
    try { expect(() => f.set([], 1)).toThrow('busy'); expect(f.read().pausedWorkerIds).toEqual(['codex-personal']); }
    finally { expect(locks.releaseLocalStoreLock(lock)).toBe(true); }
  });

  it.each([null, 'codex-personal', ['missing'], ['codex-personal', 'codex-personal'], Array(1)])('rejects invalid paused IDs %# before creating storage', (ids) => {
    const f = fixture(); expect(() => f.set(ids as string[])).toThrow('Invalid resource worker access policy'); expect(existsSync(f.root)).toBe(false);
  });

  it('rejects accessor lists without evaluating code', () => {
    const f = fixture(); const ids = ['codex-personal']; const getter = vi.fn(() => 'codex-personal');
    Object.defineProperty(ids, '0', { get: getter }); expect(() => f.set(ids)).toThrow('Invalid resource worker access policy');
    expect(getter).not.toHaveBeenCalled(); expect(existsSync(f.root)).toBe(false);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, '0', null])('rejects invalid CAS revision %#', (revision) => {
    const f = fixture(); expect(() => f.set([], revision as number)).toThrow('Invalid resource worker access policy'); expect(existsSync(f.root)).toBe(false);
  });

  it.each([{ pausedWorkerIds: ['missing'] }, { pausedWorkerIds: ['codex-personal', 'codex-personal'] }, { pausedWorkerIds: null },
    { revision: 0 }, { revision: 1.5 }, { updatedAt: null }, { extra: true }])('fails closed on corrupted access state %#', async (patch) => {
    const f = fixture(); f.set(); const state = JSON.parse(readFileSync(f.stateFile, 'utf8'));
    Object.assign(state.workerAccess, patch); writeFileSync(f.stateFile, JSON.stringify(state));
    expect(() => f.read()).toThrow('ledger invalid'); expect(() => f.status()).toThrow('ledger invalid');
    expect(() => f.set([], 1)).toThrow('ledger invalid'); await expect(f.run()).rejects.toThrow('ledger invalid');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('preserves private ledger and enrollment validation', () => {
    const f = fixture(); f.set(); chmodSync(f.stateFile, 0o644); expect(() => f.read()).toThrow(); chmodSync(f.stateFile, 0o600);
    const alias = join(base, 'ledger-alias'); symlinkSync(f.root, alias);
    expect(() => readResourceWorkerAccess(alias, f.pool, f.bindings)).toThrow();
    f.pool.workers[0]!.model = 'changed'; expect(() => f.read()).toThrow('configuration changed');
  });

  it('replays an existing personal receipt after pause without executing again', async () => {
    const f = fixture(); const first = await f.run(); f.set();
    const admission = vi.fn(() => { throw new Error('Must not inspect collector for replay'); });
    const replay = await f.run(undefined, undefined, admission);
    expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.receipt); expect(f.execute).toHaveBeenCalledOnce();
    expect(admission).not.toHaveBeenCalled();
  });

  it('cannot bypass a durable pause with fresh shared admission evidence', async () => {
    const f = fixture(); f.set(); const admission = vi.fn(() => ({ observations: f.observations, unavailableWorkerIds: [] }));
    expect((await f.run('personal-only', ['codex-personal'], admission)).receipt).toBeNull();
    expect(admission).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
  });

  it('rechecks a pause installed after preview and before atomic reservation', async () => {
    const f = fixture(); setResourcePoolAllocation(f.root, f.pool, f.bindings, 75, 0);
    expect(f.status().plan.selectedWorkerId).toBe('codex-personal');
    const acquire = locks.acquireLocalStoreLock; let saved = false;
    vi.spyOn(locks, 'acquireLocalStoreLock').mockImplementation((path, ...options) => {
      if (!saved && path === join(f.root, '.pool.lock')) { saved = true; f.set(); }
      return acquire(path, ...options);
    });
    expect((await f.run()).receipt?.workerId).toBe('codex-cmp'); expect(f.execute).toHaveBeenCalledOnce();
  });

  it('lets an already-reserved personal task settle without reverting the later pause or allocation', async () => {
    const f = fixture(); setResourcePoolAllocation(f.root, f.pool, f.bindings, 75, 0);
    let finish!: (result: workers.ResourceWorkerResult) => void;
    f.execute.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const running = f.run('in-flight', ['codex-personal']); expect(f.execute).toHaveBeenCalledOnce();
    const policy = f.set(); finish({ status: 'completed', output: 'fixture', inputTokens: 7, outputTokens: 3,
      usageScope: 'codex-turn', reason: 'worker-completed' });
    expect((await running).receipt?.status).toBe('completed'); expect(f.read()).toEqual(policy);
    expect(readResourcePoolAllocation(f.root, f.pool, f.bindings).ceilingPercent).toBe(75);
    expect((await f.run('next-personal', ['codex-personal'])).receipt).toBeNull(); expect(f.execute).toHaveBeenCalledOnce();
  });
});
