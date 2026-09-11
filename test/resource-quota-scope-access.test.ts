/** Private ledger fixtures and mocked inert worker transport; no account contact. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { excludedResourceQuotaScopeWorkerIds, validateResourceQuotaScopeExclusions } from '../src/core/resources/quota-scope-access.js';
import { readResourceQuotaScopeAccess, resourcePoolStatus, runResourceTask, setResourcePoolAllocation, setResourceQuotaScopeAccess,
  setResourceWorkerAccess, type ResourceTask } from '../src/core/resources/pool-runtime.js';
import { applyResourcePoolEvolution, checkResourcePoolEvolution } from '../src/core/resources/pool-evolution.js';
import * as workers from '../src/core/resources/worker.js';
import * as locks from '../src/core/fleet/local-store-lock.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const GENERAL = { capacityKey: 'personal', quotaScope: 'codex-general-v1' as const };
function fixture(maxTasks = 10) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'scope-access-'))); roots.push(base);
  const root = join(base, 'ledger'); const workspace = join(base, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  const bounds = { provider: 'codex' as const, maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: maxTasks, taskWindowMs: 60_000, priority: 1 };
  const pool = validateResourcePool({ schemaVersion: 1, id: 'pool', workers: [
    { ...bounds, id: 'general', model: 'gpt-6-astra', quotaScope: 'codex-general-v1' },
    { ...bounds, id: 'spark', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' },
    { ...bounds, id: 'unknown', model: 'fixture' },
    { ...bounds, id: 'other', model: 'gpt-6-astra', quotaScope: 'codex-general-v1' },
  ] });
  const bindings = workers.validateResourceBindings(pool.workers.map(worker => ({ workerId: worker.id,
    capacityKey: worker.id === 'other' ? 'business' : 'personal', kind: 'native-cli',
    command: [worker.id === 'other' ? '/test-owned/business' : '/test-owned/inert'] })), pool);
  const at = Date.now();
  const observations: ResourceObservation[] = pool.workers.map(worker => ({ workerId: worker.id, health: 'ready',
    observedAt: new Date(at).toISOString(), expiresAt: new Date(at + 60_000).toISOString(), retryAfter: null,
    windows: [{ id: worker.quotaScope === 'codex-spark-v1' ? 'codex_codex_bengalfox_primary' : 'codex_codex_primary',
      usedPercent: 10, resetsAt: new Date(at + 3_600_000).toISOString() }] }));
  const execute = vi.spyOn(workers, 'executeResourceWorker').mockResolvedValue({ status: 'completed', output: 'fixture',
    inputTokens: 1, outputTokens: 1, usageScope: 'codex-turn', reason: 'worker-completed' });
  const set = (exclusions = [GENERAL], expectedRevision = 0) => setResourceQuotaScopeAccess(root, pool, bindings, exclusions, expectedRevision);
  const read = () => readResourceQuotaScopeAccess(root, pool, bindings);
  const status = () => resourcePoolStatus(root, pool, bindings, observations);
  const task = (id: string, allowedWorkerIds = ['general', 'spark', 'unknown']): ResourceTask => ({ schemaVersion: 1, id,
    prompt: 'fixture', cwd: workspace, allowedWorkerIds, timeoutMs: 1000, maxOutputTokens: 128, mode: 'read-only' });
  const run = (id: string, ids?: string[], fresh = false) => runResourceTask({ root, pool, bindings, observations, task: task(id, ids),
    ...(fresh ? { readAdmissionEvidence: () => ({ observations, unavailableWorkerIds: [], quotaUnavailableWorkerIds: [] }) } : {}) });
  return { base, root, workspace, pool, bindings, observations, execute, set, read, status, run, stateFile: join(root, 'pool-state.json') };
}

describe('durable quota-scope access', () => {
  it('defaults missing and legacy state without writes or changed receipts', async () => {
    const f = fixture(); expect(f.read()).toEqual({ exclusions: [], revision: 0, updatedAt: null }); expect(existsSync(f.root)).toBe(false);
    await f.run('old', ['general']); const before = readFileSync(f.stateFile);
    expect(f.read().revision).toBe(0); expect(f.status().quotaScopeAccess).toEqual(f.read());
    expect(readFileSync(f.stateFile)).toEqual(before); expect(JSON.parse(before.toString())).not.toHaveProperty('quotaScopeAccess');
  });
  it('blocks General and unknown aliases without spilling its policy into fresh Spark quota', async () => {
    const f = fixture(); f.set();
    expect(excludedResourceQuotaScopeWorkerIds(f.pool, f.bindings, [GENERAL])).toEqual(['general', 'unknown']);
    expect(f.status().plan.candidates.map(row => row.workerId)).toEqual(['other', 'spark']);
    for (const id of ['general', 'unknown']) {
      expect(f.status().plan.exclusions.find(row => row.workerId === id)?.reasons).toContain('operator-quota-scope-excluded');
      expect((await f.run(`denied-${id}`, [id], true)).receipt).toBeNull();
    }
    expect((await f.run('spark', ['spark'], true)).receipt?.workerId).toBe('spark'); expect(f.execute).toHaveBeenCalledOnce();
    expect(f.status().observations).toEqual(f.observations);
  });
  it('keeps account pause and allocation dominant even after scope removal', async () => {
    const f = fixture(); f.set(); setResourceWorkerAccess(f.root, f.pool, f.bindings, ['general'], 0);
    expect((await f.run('paused', ['spark'], true)).receipt).toBeNull(); f.set([], 1);
    expect((await f.run('still-paused', ['spark'])).receipt).toBeNull();
    setResourceWorkerAccess(f.root, f.pool, f.bindings, [], 1); setResourcePoolAllocation(f.root, f.pool, f.bindings, 0, 0);
    expect((await f.run('zero-allocation', ['spark'])).receipt).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
  });
  it('preserves shared task counters and exact excluded receipt replay', async () => {
    const f = fixture(1); const old = await f.run('old', ['general']); f.set();
    const replay = await f.run('old', ['general']); expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(old.receipt);
    expect((await f.run('new', ['spark'])).receipt).toBeNull();
    expect(f.status().plan.exclusions.find(row => row.workerId === 'spark')?.reasons).toContain('operator-task-cap-reached');
    expect(f.status().plan.exclusions.find(row => row.workerId === 'general')).toMatchObject({
      reasons: expect.arrayContaining(['operator-quota-scope-excluded', 'operator-task-cap-reached']), nextEligibleAt: null });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it('uses independent CAS and detached data while preserving other policy and pool identities', () => {
    const f = fixture(); const allocation = setResourcePoolAllocation(f.root, f.pool, f.bindings, 75, 0);
    const access = setResourceWorkerAccess(f.root, f.pool, f.bindings, ['other'], 0);
    const input = [{ ...GENERAL }]; const saved = f.set(input); input[0]!.capacityKey = 'business'; saved.exclusions.length = 0;
    expect(f.read()).toMatchObject({ exclusions: [GENERAL], revision: 1 }); const before = readFileSync(f.stateFile);
    expect(() => f.set([], 0)).toThrow('revision conflict'); expect(readFileSync(f.stateFile)).toEqual(before);
    expect(f.set([], 1)).toMatchObject({ exclusions: [], revision: 2 });
    expect(f.status()).toMatchObject({ allocation, workerAccess: access });
  });
  it('observes an exclusion installed after preview but before reservation', async () => {
    const f = fixture(); expect(f.status().plan.selectedWorkerId).toBe('general');
    const acquire = locks.acquireLocalStoreLock; let installed = false;
    vi.spyOn(locks, 'acquireLocalStoreLock').mockImplementation((file, ...args) => {
      if (!installed && file === join(f.root, '.pool.lock')) { installed = true; f.set(); }
      return acquire(file, ...args);
    });
    expect((await f.run('race', ['general', 'spark'])).receipt?.workerId).toBe('spark');
  });
  it('preserves policy revision across offline evolution and excludes new aliases', () => {
    const f = fixture(); const access = f.set();
    const nextPool = validateResourcePool({ ...f.pool, workers: [...f.pool.workers, { ...f.pool.workers[0]!, id: 'new-general' }] });
    const nextBindings = workers.validateResourceBindings([...f.bindings, { ...f.bindings[0]!, workerId: 'new-general' }], nextPool);
    const options = { root: f.root, workspace: f.workspace, pool: f.pool, bindings: f.bindings, nextPool, nextBindings };
    applyResourcePoolEvolution({ ...options, expectedPlanDigest: checkResourcePoolEvolution(options).planDigest });
    expect(readResourceQuotaScopeAccess(f.root, nextPool, nextBindings)).toEqual(access);
    expect(excludedResourceQuotaScopeWorkerIds(nextPool, nextBindings, access.exclusions)).toEqual(['general', 'unknown', 'new-general']);
  });
  it.each([null, {}, [GENERAL, GENERAL], [{ ...GENERAL, capacityKey: 'missing' }], [{ ...GENERAL, quotaScope: 'invented' }],
    [{ ...GENERAL, extra: true }], Array(1)])('rejects malformed exclusions before any storage %#', input => {
    const f = fixture(); expect(() => validateResourceQuotaScopeExclusions(input, f.pool, f.bindings)).toThrow();
    expect(() => setResourceQuotaScopeAccess(f.root, f.pool, f.bindings, input as never, 0)).toThrow(); expect(existsSync(f.root)).toBe(false);
  });
  it('does not invoke nested getters during validation', () => {
    const f = fixture(); const getter = vi.fn(() => 'personal');
    expect(() => f.set([{ get capacityKey() { return getter(); }, quotaScope: GENERAL.quotaScope }])).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(existsSync(f.root)).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, null])('rejects invalid revisions without effects %#', revision => {
    const f = fixture(); expect(() => f.set([], revision as number)).toThrow(); expect(existsSync(f.root)).toBe(false);
  });
  it.each([{ revision: 0 }, { updatedAt: null }, { exclusions: [GENERAL, GENERAL] }, { extra: true }])('refuses malformed persisted policy at every read/admission %#', patch => {
    const f = fixture(); f.set(); const state = JSON.parse(readFileSync(f.stateFile, 'utf8'));
    Object.assign(state.quotaScopeAccess, patch); writeFileSync(f.stateFile, canonical(state));
    expect(() => f.read()).toThrow('ledger invalid'); expect(() => f.status()).toThrow('ledger invalid'); expect(() => f.set([], 1)).toThrow('ledger invalid');
    expect(f.execute).not.toHaveBeenCalled();
  });
});
