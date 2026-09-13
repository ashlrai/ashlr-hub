/** Epoch codec and offline publication tests; no workers/providers are invoked. */
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { applyResourcePoolEvolution, checkResourcePoolEvolution, ResourcePoolEvolutionError } from '../src/core/resources/pool-evolution.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import { decodeResourcePoolState, readResourcePoolHistory, resourcePoolStatus, type ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import * as writes from '../src/core/util/private-file-write.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function fixture(status: ResourceTaskReceipt['status'] = 'completed') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pool-epoch-core-'))); roots.push(base);
  const root = join(base, 'ledger'); const workspace = join(base, 'project');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  const worker = { id: 'old', provider: 'local' as const, model: 'inert', maxConcurrent: 1, reservePercent: 25,
    maxTasksPerWindow: 1, taskWindowMs: 60_000, priority: 1 };
  const pool = validateResourcePool({ schemaVersion: 1, id: 'pool', workers: [worker] });
  const bindings = validateResourceBindings([{ workerId: 'old', capacityKey: 'account', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }], pool);
  const nextPool = validateResourcePool({ ...pool, workers: [...pool.workers, { ...worker, id: 'new', model: 'other' }] });
  const nextBindings = validateResourceBindings([...bindings, { ...bindings[0]!, workerId: 'new' }], nextPool);
  const at = new Date(Date.now() - 1000).toISOString();
  const receipt: ResourceTaskReceipt = { schemaVersion: 1, id: 'old-task', taskDigest: '1'.repeat(64), poolDigest: digest(canonical({ pool, bindings })),
    workerId: 'old', capacityKey: 'account', status, startedAt: at, finishedAt: status === 'reserved' ? null : at,
    outputDigest: status === 'completed' ? '2'.repeat(64) : null, inputTokens: null, outputTokens: null, reason: 'fixture', verifiedAccepted: false };
  const state = { schemaVersion: 1, poolDigest: receipt.poolDigest, observations: [], attempts: [receipt],
    allocation: { ceilingPercent: 65, revision: 7, updatedAt: at }, workerAccess: { pausedWorkerIds: ['old'], revision: 4, updatedAt: at } };
  const file = join(root, 'pool-state.json'); save(file, state);
  return { base, root, workspace, pool, bindings, nextPool, nextBindings, receipt, state, file,
    options: { root, workspace, pool, bindings, nextPool, nextBindings } };
}
function tree(root: string): unknown {
  const visit = (file: string): unknown => { const stat = lstatSync(file, { bigint: true }); return {
    mode: String(stat.mode), ino: String(stat.ino), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isFile() ? digest(readFileSync(file)) : Object.fromEntries(readdirSync(file).sort().map(name => [name, visit(join(file, name))])) }; };
  return visit(root);
}
describe('pool epoch receipts and offline publication', () => {
  it('preserves exact unknown-token receipts, revisions and account-wide pauses without creating a console', () => {
    const f = fixture(); const before = tree(f.base); const plan = checkResourcePoolEvolution(f.options);
    expect(tree(f.base)).toEqual(before);
    const result = applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest });
    expect(result).toMatchObject({ status: 'applied', disposition: 'created', historyCount: 2, preservedReceiptCount: 1, preservedJobCount: 0 });
    const after = JSON.parse(readFileSync(f.file, 'utf8'));
    expect(after.attempts).toEqual([f.receipt]); expect(after.allocation).toEqual(f.state.allocation); expect(after.workerAccess).toEqual(f.state.workerAccess);
    expect(existsSync(join(f.root, 'resource-console-state.json'))).toBe(false);
    expect(readResourcePoolHistory(f.root, f.nextPool, f.nextBindings)).toHaveLength(2);
    expect(() => resourcePoolStatus(f.root, f.pool, f.bindings, [])).toThrow(/configuration/);
    const status = resourcePoolStatus(f.root, f.nextPool, f.nextBindings, []);
    expect(status.configurationDigests).toEqual(after.configurationHistory.map((row: { poolDigest: string }) => row.poolDigest));
    expect(status.plan.exclusions.find(row => row.workerId === 'new')?.reasons).toContain('worker-unavailable');
    const replayBefore = tree(f.base);
    expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest }).disposition).toBe('replayed');
    expect(tree(f.base)).toEqual(replayBefore);
  });
  it.each(['reserved', 'uncertain'] as const)('refuses %s custody without changing any files', status => {
    const f = fixture(status); const before = tree(f.base);
    expect(() => checkResourcePoolEvolution(f.options)).toThrow(/reserved or uncertain/); expect(tree(f.base)).toEqual(before);
  });
  it('validates every historical receipt against its exact recorded origin, not the active digest', () => {
    const f = fixture(); const plan = checkResourcePoolEvolution(f.options); applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest });
    const state = JSON.parse(readFileSync(f.file, 'utf8'));
    state.attempts[0].poolDigest = 'a'.repeat(64);
    expect(() => decodeResourcePoolState(state, f.nextPool, f.nextBindings)).toThrow(/ledger invalid/);
    state.attempts[0].poolDigest = f.receipt.poolDigest; state.attempts[0].workerId = 'new';
    expect(() => decodeResourcePoolState(state, f.nextPool, f.nextBindings)).toThrow(/ledger invalid/);
  });
  it('retains task-window counts for new aliases across epochs', () => {
    const f = fixture(); delete (f.state as Partial<typeof f.state>).workerAccess; save(f.file, f.state);
    const plan = checkResourcePoolEvolution(f.options); applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest });
    const now = Date.now(); const observations: ResourceObservation[] = f.nextPool.workers.map(worker => ({ workerId: worker.id,
      health: 'ready', observedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), windows: [], retryAfter: null }));
    expect(resourcePoolStatus(f.root, f.nextPool, f.nextBindings, observations).plan.exclusions.find(row => row.workerId === 'new')?.reasons)
      .toContain('operator-task-cap-reached');
  });
  it.each(['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock'])('refuses observed %s ownership without reclaiming it', name => {
    const f = fixture(); const lock = acquireLocalStoreLock(join(f.root, name), 0, { anchorPath: f.root, exactPrivateStorage: true });
    expect(lock).not.toBeNull();
    try { const before = tree(f.base); expect(() => checkResourcePoolEvolution(f.options)).toThrow(/ownership is present/); expect(tree(f.base)).toEqual(before); }
    finally { if (lock) releaseLocalStoreLock(lock); }
  });
  it('refuses and preserves unknown quota contact markers', () => {
    const f = fixture(); save(join(f.root, '.resource-quota-refresh-pending.json'), { opaque: 'do-not-repair' }); const before = tree(f.base);
    expect(() => checkResourcePoolEvolution(f.options)).toThrow(/Uncertain quota/); expect(tree(f.base)).toEqual(before);
  });
  it('holds an interrupted pool barrier until exact explicit resume and never invents a new ledger', () => {
    const f = fixture(); const plan = checkResourcePoolEvolution(f.options); const original = writes.writePrivateFileAtomically;
    let injected = false;
    vi.spyOn(writes, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
      original(temporary, target, bytes, options);
      if (!injected && target === f.file && String(bytes).includes('pendingEvolution')) { injected = true; throw new Error('injected after durable barrier'); }
    });
    expect(() => applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow(/injected/);
    vi.restoreAllMocks(); expect(() => resourcePoolStatus(f.root, f.nextPool, f.nextBindings, [])).toThrow(/pending/);
    expect(checkResourcePoolEvolution(f.options).planDigest).toBe(plan.planDigest);
    expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest }).disposition).toBe('resumed');
    expect(resourcePoolStatus(f.root, f.nextPool, f.nextBindings, []).attempts).toEqual([f.receipt]);
  });
  it('supports another additive epoch when no console exists and retains all prior origins', () => {
    const f = fixture(); applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: checkResourcePoolEvolution(f.options).planDigest });
    const nextPool = validateResourcePool({ ...f.nextPool, workers: [...f.nextPool.workers, { ...f.nextPool.workers[1]!, id: 'third' }] });
    const nextBindings = validateResourceBindings([...f.nextBindings, { ...f.nextBindings[1]!, workerId: 'third' }], nextPool);
    const second = { ...f.options, pool: f.nextPool, bindings: f.nextBindings, nextPool, nextBindings };
    applyResourcePoolEvolution({ ...second, expectedPlanDigest: checkResourcePoolEvolution(second).planDigest });
    expect(readResourcePoolHistory(f.root, nextPool, nextBindings)).toHaveLength(3);
    expect(resourcePoolStatus(f.root, nextPool, nextBindings, []).attempts).toEqual([f.receipt]);
  });
  it.each(['complete', 'partial', 'wrong', 'hardlink'] as const)('handles only an exact complete pinned console temporary (%s)', kind => {
    const f = fixture(); const at = new Date().toISOString();
    const input = { id: 'waiting', prompt: 'private-orphan-sentinel', allowedWorkerIds: ['old'], mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 128 };
    const consoleFile = join(f.root, 'resource-console-state.json');
    save(consoleFile, { schemaVersion: 3, scopeDigest: digest(canonical({ pool: f.pool, bindings: f.bindings, workspace: f.workspace })),
      paused: true, jobs: [{ id: input.id, state: 'queued', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['old'], mode: 'read-only',
        workerId: null, outcome: null, reason: null, input, taskDigest: digest(canonical({ ...input, schemaVersion: 1, cwd: f.workspace })) }] });
    const plan = checkResourcePoolEvolution(f.options); const original = writes.writePrivateFileAtomically; let orphan = '';
    vi.spyOn(writes, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
      if (target !== consoleFile) return original(temporary, target, bytes, options);
      orphan = temporary;
      writeFileSync(temporary, kind === 'partial' ? String(bytes).slice(0, 30) : kind === 'wrong' ? '{}\n' : bytes, { mode: 0o600 });
      if (kind === 'hardlink') linkSync(temporary, join(f.base, 'unexpected-link'));
      throw new Error('simulated crash before console rename');
    });
    expect(() => applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow('simulated crash');
    vi.restoreAllMocks(); expect(existsSync(orphan)).toBe(true);
    const before = tree(f.base);
    expect(checkResourcePoolEvolution(f.options).planDigest).toBe(plan.planDigest); expect(tree(f.base)).toEqual(before);
    if (kind === 'complete') {
      expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest }).disposition).toBe('resumed');
      expect(existsSync(orphan)).toBe(false);
      expect(readdirSync(f.root).filter(name => name.includes('.tmp'))).toEqual([]);
      const after = tree(f.base); expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest }).disposition).toBe('replayed');
      expect(tree(f.base)).toEqual(after);
    } else {
      expect(() => applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow(ResourcePoolEvolutionError);
      expect(existsSync(orphan)).toBe(true); expect(JSON.parse(readFileSync(f.file, 'utf8')).pendingEvolution).toBeDefined();
      expect(JSON.parse(readFileSync(consoleFile, 'utf8')).schemaVersion).toBe(3);
    }
  });
  it('rejects accessors before inspection and detaches returned history', () => {
    const f = fixture(); let called = false;
    expect(() => checkResourcePoolEvolution({ ...f.options, get pool() { called = true; return f.pool; } })).toThrow(); expect(called).toBe(false);
    const snapshot = resourcePoolConfigSnapshot(f.pool, f.bindings);
    expect(snapshot.pool).not.toBe(f.pool); expect(snapshot.pool.workers[0]).not.toBe(f.pool.workers[0]);
    expect(() => { snapshot.pool.workers[0]!.model = 'changed'; }).toThrow();
    expect(f.pool.workers[0]!.model).toBe('inert');
  });
});
