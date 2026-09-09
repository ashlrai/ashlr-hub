/** Private fixture ledgers and injected inert worker; no provider/account traffic. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { readResourcePoolAllocation, resourcePoolStatus, runResourceTask, setResourcePoolAllocation, type ResourceTask } from '../src/core/resources/pool-runtime.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import * as workers from '../src/core/resources/worker.js';
import * as locks from '../src/core/fleet/local-store-lock.js';

let fixture: string;
beforeEach(() => { fixture = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-allocation-test-'))); });
afterEach(() => { vi.restoreAllMocks(); rmSync(fixture, { recursive: true, force: true }); });
function setup(shared = false) {
  const root = join(fixture, 'ledger'); const cwd = join(fixture, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  const pool: ResourcePool = { schemaVersion: 1, id: 'allocation-fixture', workers: ['codex-a', 'codex-b', 'local'].map((id) => ({
    id, provider: id === 'local' ? 'local' : 'codex', model: 'fixture-model', maxConcurrent: 2,
    reservePercent: 20, maxTasksPerWindow: 20, taskWindowMs: 60_000, priority: id === 'local' ? 0 : 1, allowUnknownQuota: true })) };
  const bindings: workers.ResourceBinding[] = pool.workers.map((worker) => worker.provider === 'local'
    ? { workerId: worker.id, capacityKey: worker.id, kind: 'local-chat', endpoint: 'http://127.0.0.1:23456/v1' }
    : { workerId: worker.id, capacityKey: shared ? 'shared-codex' : worker.id, kind: 'native-cli', command: ['/fixture/native'] });
  const observations = (used = 50): ResourceObservation[] => pool.workers.map((worker) => ({ workerId: worker.id,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    health: 'ready', retryAfter: null, windows: worker.provider === 'local' ? [] : [
      { id: 'five_hour', usedPercent: used, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
      { id: 'seven_day', usedPercent: used, resetsAt: new Date(Date.now() + 7200_000).toISOString() }] }));
  const task = (id = 'fixture-task', allowedWorkerIds = ['codex-a']): ResourceTask => ({ schemaVersion: 1, id, allowedWorkerIds,
    prompt: 'inert fixture', cwd, timeoutMs: 1000, maxOutputTokens: 100, mode: 'read-only' });
  const set = (value: number, revision = 0) => setResourcePoolAllocation(root, pool, bindings, value, revision);
  const read = () => readResourcePoolAllocation(root, pool, bindings);
  const status = (rows = observations()) => resourcePoolStatus(root, pool, bindings, rows);
  const run = (rows = observations(), id?: string, allowed?: string[]) => runResourceTask({ root, pool, bindings, observations: rows, task: task(id, allowed) });
  const execute = vi.spyOn(workers, 'executeResourceWorker').mockResolvedValue({ status: 'completed', output: 'fixture',
    inputTokens: null, outputTokens: null, reason: 'worker-completed' });
  return { root, cwd, pool, bindings, observations, task, set, read, status, run, execute };
}

describe('durable allocation policy identity and concurrency', () => {
  it('reads absent and legacy policy without creating storage', async () => {
    const f = setup(); expect(f.read()).toEqual({ ceilingPercent: null, revision: 0, updatedAt: null }); expect(existsSync(f.root)).toBe(false);
    await f.run(); const state = JSON.parse(readFileSync(join(f.root, 'pool-state.json'), 'utf8'));
    expect(state).not.toHaveProperty('allocation'); expect(f.read()).toEqual({ ceilingPercent: null, revision: 0, updatedAt: null });
  });
  it('saves private atomic policy with stable enrollment digest and monotonic revisions', async () => {
    const f = setup(); const before = canonical({ pool: f.pool, bindings: f.bindings });
    const completed = await f.run(); const originalReceipt = structuredClone(completed.receipt);
    expect(f.set(75)).toMatchObject({ ceilingPercent: 75, revision: 1 });
    expect(f.set(75, 1)).toMatchObject({ ceilingPercent: 75, revision: 2 });
    expect(f.set(100, 2)).toMatchObject({ ceilingPercent: 100, revision: 3 });
    expect(canonical({ pool: f.pool, bindings: f.bindings })).toBe(before);
    const state = JSON.parse(readFileSync(join(f.root, 'pool-state.json'), 'utf8'));
    expect(state.poolDigest).toBe(digest(before)); expect(state.attempts).toEqual([originalReceipt]);
    expect(statSync(join(f.root, 'pool-state.json')).mode & 0o777).toBe(0o600);
    expect(f.status().allocation).toEqual(f.read());
  });
  it('rejects stale revision without overwriting or contacting a worker', () => {
    const f = setup(); f.set(75); const before = readFileSync(join(f.root, 'pool-state.json'), 'utf8');
    expect(() => f.set(100)).toThrow('revision conflict'); expect(f.read().ceilingPercent).toBe(75);
    expect(readFileSync(join(f.root, 'pool-state.json'), 'utf8')).toBe(before); expect(f.execute).not.toHaveBeenCalled();
  });
  it('shares the exact admission lock and refuses updates while another owner holds it', () => {
    const f = setup(); f.set(75); const lock = locks.acquireLocalStoreLock(join(f.root, '.pool.lock'), 500)!;
    try { expect(() => f.set(100, 1)).toThrow('busy'); expect(f.read().ceilingPercent).toBe(75); }
    finally { expect(locks.releaseLocalStoreLock(lock)).toBe(true); }
  });
  it.each([-1, 101, 75.5, NaN, Infinity, null, '75'])('rejects invalid ceiling %# before creating storage', (value) => {
    const f = setup(); expect(() => f.set(value as number)).toThrow('Invalid resource allocation policy'); expect(existsSync(f.root)).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, '0'])('rejects invalid revision %#', (value) => {
    const f = setup(); expect(() => f.set(75, value as number)).toThrow('Invalid resource allocation policy');
  });
  it('rejects changed enrollment rather than silently applying another pool policy', () => {
    const f = setup(); f.set(75); f.pool.workers[0]!.model = 'different';
    expect(() => f.read()).toThrow('configuration changed'); expect(() => f.set(80, 1)).toThrow('configuration changed');
  });
  it.each([{ ceilingPercent: 101 }, { revision: 0 }, { revision: 1.5 }, { updatedAt: null }, { ceilingPercent: null }, { extra: true }])(
    'fails closed on malformed durable allocation %#', (patch) => {
      const f = setup(); f.set(75); const file = join(f.root, 'pool-state.json'); const state = JSON.parse(readFileSync(file, 'utf8'));
      Object.assign(state.allocation, patch); writeFileSync(file, JSON.stringify(state));
      expect(() => f.read()).toThrow(); expect(() => f.status()).toThrow();
    });
  it('rejects unsafe ledger mode and symlink rather than following it', () => {
    const f = setup(); f.set(75); const file = join(f.root, 'pool-state.json'); chmodSync(file, 0o644);
    expect(() => f.read()).toThrow(); chmodSync(file, 0o600);
    const link = join(fixture, 'alias'); symlinkSync(f.root, link);
    expect(() => readResourcePoolAllocation(link, f.pool, f.bindings)).toThrow();
  });
});

describe('allocation admission enforcement', () => {
  it('stops exactly at75% rather than allowing75% additional usage', async () => {
    const f = setup(); f.set(75); expect((await f.run(f.observations(74))).receipt?.status).toBe('completed');
    const denied = await f.run(f.observations(75), 'at-ceiling'); expect(denied.receipt).toBeNull(); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('100 overrides an80% static cutoff but never native100% exhaustion', async () => {
    const f = setup(); expect(f.status(f.observations(85)).plan.candidates.map((row) => row.workerId)).not.toContain('codex-a');
    f.set(100); expect((await f.run(f.observations(99))).receipt?.status).toBe('completed');
    expect((await f.run(f.observations(100), 'full')).receipt).toBeNull();
  });
  it('zero stops remote admission without affecting local-model work', async () => {
    const f = setup(); f.set(0); expect((await f.run(f.observations(0))).receipt).toBeNull();
    expect((await f.run(f.observations(0), 'local-task', ['local'])).receipt?.workerId).toBe('local');
  });
  it.each(['missing', 'empty', 'unknown', 'stale', 'reset', 'future'])('a ceiling requires actual complete known quota: %s', async (kind) => {
    const f = setup(); f.set(75); const rows = f.observations(); const row = rows[0]!;
    if (kind === 'missing') rows.shift(); if (kind === 'empty') row.windows = [];
    if (kind === 'unknown') row.windows[1]!.usedPercent = null;
    if (kind === 'stale') row.expiresAt = new Date(Date.now() - 1).toISOString();
    if (kind === 'reset') row.windows[1]!.resetsAt = new Date(Date.now() - 1).toISOString();
    if (kind === 'future') { row.observedAt = new Date(Date.now() + 1000).toISOString(); }
    expect((await f.run(rows)).receipt).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
  });
  it('preserves explicitly configured unknown-quota bootstrap at100', async () => {
    const f = setup(); f.set(100); const rows = f.observations(); rows[0]!.windows = [];
    expect((await f.run(rows)).receipt?.status).toBe('completed');
  });
  it('applies every shared-account alias/window and does not sum independent-account usage', async () => {
    const f = setup(true); f.set(75); const rows = f.observations(10); rows[1]!.windows[1]!.usedPercent = 75;
    expect((await f.run(rows)).receipt).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
  });
  it('does not sum independent accounts or windows', async () => {
    const f = setup(); f.set(75); expect((await f.run(f.observations(60))).receipt?.status).toBe('completed');
  });
  it('blocks a shared account with an unmeasured alias under a reserve', async () => {
    const f = setup(true); f.set(75); const rows = f.observations(); rows.splice(1, 1);
    expect((await f.run(rows)).receipt).toBeNull();
  });
  it('rechecks persisted policy after a previously eligible status snapshot', async () => {
    const f = setup(); f.set(100); expect(f.status(f.observations(80)).plan.selectedWorkerId).toBe('codex-a');
    f.set(75, 1); expect((await f.run(f.observations(80))).receipt).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
  });
  it('does not cancel in-flight work and its settlement retains the newly saved policy', async () => {
    const f = setup(); f.set(100); let finish!: (value: workers.ResourceWorkerResult) => void;
    f.execute.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const running = f.run(); expect(f.execute).toHaveBeenCalledOnce(); f.set(0, 1);
    finish({ status: 'completed', output: 'fixture', inputTokens: null, outputTokens: null, reason: 'worker-completed' });
    expect((await running).receipt?.status).toBe('completed'); expect(f.read()).toMatchObject({ ceilingPercent: 0, revision: 2 });
    expect((await f.run(f.observations(), 'next')).receipt).toBeNull();
  });
  it('preserves replay identity after a policy change without another invocation', async () => {
    const f = setup(); const original = await f.run(); f.set(0);
    const replay = await f.run(); expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(original.receipt); expect(f.execute).toHaveBeenCalledOnce();
  });
});
