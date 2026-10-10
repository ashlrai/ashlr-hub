/** Historical receipt reads only; no native CLI, provider, account or default ledger. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { resourceGenerationTaskId as reexportedTaskId } from '../src/core/universe/generation.js';
import { resourceGenerationTaskId, validResourceTaskOrigin, type ResourceTaskOrigin } from '../src/core/resources/task-origin.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import { decodeResourcePoolState, resourcePoolStatus, runResourceTask, validateResourceTask,
  type ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';

const execution = vi.hoisted(() => vi.fn());
vi.mock('../src/core/resources/worker.js', async original => ({ ...await original<object>(), executeResourceWorker: execution }));
const identity = { universeId: 'fixture-universe', runId: '11111111-2222-3333-4444-555555555555', variantId: 'fixture-variant' };
const taskId = 'u-ed3dbe9e3a7e96952c36e9c0204874-527e5c5e36b957abf5a3bf505aaed1';
const origin: ResourceTaskOrigin = { kind: 'universe-generation', ...identity };
const roots: string[] = [];
afterEach(() => { execution.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(schemaVersion: 1 | 2 = 1, status: ResourceTaskReceipt['status'] = 'completed') {
  const oldPool = validateResourcePool({ schemaVersion: 1, id: 'origin-fixture', workers: [{ id: 'codex-a', provider: 'codex',
    model: 'gpt-6-astra', quotaScope: 'codex-general-v1', maxConcurrent: 1, reservePercent: 25,
    maxTasksPerWindow: 6, taskWindowMs: 3_600_000, priority: 1 }] });
  const oldBindings = validateResourceBindings([{ workerId: 'codex-a', capacityKey: 'account', kind: 'native-cli', command: [process.execPath] }], oldPool);
  const pool = schemaVersion === 1 ? oldPool : validateResourcePool({ ...oldPool, workers: [...oldPool.workers,
    { ...oldPool.workers[0]!, id: 'codex-spark', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' }] });
  const bindings = schemaVersion === 1 ? oldBindings : validateResourceBindings([...oldBindings,
    { ...oldBindings[0]!, workerId: 'codex-spark' }], pool);
  const oldSnapshot = resourcePoolConfigSnapshot(oldPool, oldBindings); const active = resourcePoolConfigSnapshot(pool, bindings);
  const at = new Date(Date.now() - 1_000).toISOString();
  const receipt: ResourceTaskReceipt = { schemaVersion: 1, id: taskId, taskDigest: '1'.repeat(64), poolDigest: oldSnapshot.poolDigest,
    workerId: 'codex-a', capacityKey: 'account', status, startedAt: at, finishedAt: status === 'reserved' ? null : at,
    outputDigest: status === 'completed' ? '2'.repeat(64) : null, inputTokens: status === 'reserved' ? null : 123,
    outputTokens: status === 'reserved' ? null : 45, reason: 'fixture', verifiedAccepted: false, origin: { ...origin },
    ...(status === 'reserved' ? {} : { execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: 10, usageScope: 'codex-turn' },
      nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: 0, signal: null, stderrPresent: false, outputTruncated: false } }) };
  const legacy = { ...receipt, id: 'legacy-task', origin: undefined };
  delete legacy.origin;
  const state = { schemaVersion, poolDigest: active.poolDigest, observations: [], attempts: [receipt, legacy],
    allocation: { ceilingPercent: 75, revision: 3, updatedAt: at },
    workerAccess: { pausedWorkerIds: ['codex-a'], revision: 2, updatedAt: at },
    quotaScopeAccess: { exclusions: [{ capacityKey: 'account', quotaScope: 'codex-general-v1' }], revision: 1, updatedAt: at },
    ...(schemaVersion === 2 ? { configurationHistory: [oldSnapshot, active] } : {}) };
  return { pool, bindings, receipt, state };
}
function badOrigins(): unknown[] {
  const accessor = Object.defineProperty({ ...origin }, 'variantId', { enumerable: true, get() { throw new Error('must not invoke'); } });
  const hidden = Object.defineProperty({ ...origin }, 'variantId', { enumerable: false, value: identity.variantId });
  return [null, [], new Date(), Object.assign(Object.create({}), origin), { ...origin, extra: true },
    { kind: origin.kind, universeId: identity.universeId, runId: identity.runId },
    { ...origin, [Symbol('extra')]: true }, accessor, hidden, { ...origin, kind: 'successor-proposal' },
    { ...origin, runId: '' }, { ...origin, runId: 'x'.repeat(65) }, { ...origin, universeId: '../bad' },
    { ...origin, variantId: 2 }, { ...origin, variantId: 'different' }];
}

describe('strict historical origin compatibility', () => {
  it('preserves an independently computed valid JSON task ID and the existing export', () => {
    expect(resourceGenerationTaskId(identity)).toBe(taskId); expect(reexportedTaskId(identity)).toBe(taskId);
    expect(resourceGenerationTaskId(Object.assign(Object.create(null), identity))).toBe(taskId);
    expect(validResourceTaskOrigin(Object.assign(Object.create(null), origin), taskId)).toBe(true);
    expect(validResourceTaskOrigin(origin, 'unrelated-task')).toBe(false);
  });
  it('rejects hidden or accessor identities without invoking their getters', () => {
    const getter = vi.fn(() => identity.runId);
    const accessor = Object.defineProperty({ ...identity }, 'runId', { enumerable: true, get: getter });
    const hidden = Object.defineProperty({ ...identity }, 'runId', { enumerable: false, value: identity.runId });
    expect(() => resourceGenerationTaskId(accessor)).toThrow(); expect(() => resourceGenerationTaskId(hidden)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('never invokes an origin accessor in the direct validator or ledger decoder', () => {
    const getter = vi.fn(() => identity.variantId);
    const value = Object.defineProperty({ ...origin }, 'variantId', { enumerable: true, get: getter });
    expect(validResourceTaskOrigin(value, taskId)).toBe(false);
    const f = fixture(); f.state.attempts[0]!.origin = value;
    expect(() => decodeResourcePoolState(f.state, f.pool, f.bindings)).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(execution).not.toHaveBeenCalled();
  });
  it.each([1, 2] as const)('preserves schema%s canonical receipts, history, controls and usage without writing or invoking', schema => {
    const f = fixture(schema); const before = canonical(f.state);
    const decoded = decodeResourcePoolState(f.state, f.pool, f.bindings);
    expect(canonical(decoded)).toBe(before); expect(decoded.attempts).toEqual(f.state.attempts);
    expect(canonical(decoded.attempts[1])).toBe(canonical(f.state.attempts[1]));
    expect(Object.hasOwn(decoded.attempts[1]!, 'origin')).toBe(false);
    expect(decoded.attempts[0]?.taskDigest).toBe('1'.repeat(64)); expect(decoded.attempts[0]?.verifiedAccepted).toBe(false);
    expect(decoded.attempts.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0)).toBe(246);
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'origin-read-'))); roots.push(base);
    const root = join(base, 'ledger'); mkdirSync(root, { mode: 0o700 });
    const file = join(root, 'pool-state.json'); writeFileSync(file, before + '\n', { mode: 0o600 });
    const status = resourcePoolStatus(root, f.pool, f.bindings, []);
    expect(status).toMatchObject({ allocation: f.state.allocation, workerAccess: f.state.workerAccess,
      quotaScopeAccess: f.state.quotaScopeAccess, attempts: f.state.attempts });
    expect(status.plan.selectedWorkerId).toBeNull(); expect(readFileSync(file, 'utf8')).toBe(before + '\n');
    expect(execution).not.toHaveBeenCalled();
  });
  it.each(['reserved', 'completed'] as const)('validates origin before the %s receipt return', status => {
    const f = fixture(1, status); expect(() => decodeResourcePoolState(f.state, f.pool, f.bindings)).not.toThrow();
    for (const value of badOrigins()) {
      const candidate = structuredClone(f.state); candidate.attempts[0]!.origin = value as ResourceTaskOrigin;
      expect(() => decodeResourcePoolState(candidate, f.pool, f.bindings)).toThrow();
      expect(validResourceTaskOrigin(value, taskId)).toBe(false);
    }
    expect(execution).not.toHaveBeenCalled();
  });
  it('retains historical epoch, binding, acceptance and measurement refusals', () => {
    const f = fixture(2);
    const patches = [{ verifiedAccepted: true }, { workerId: 'codex-spark' }, { capacityKey: 'different' },
      { poolDigest: 'f'.repeat(64) }, { inputTokens: null }, { outputTokens: -1 },
      { execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: 10, usageScope: 'claude-main-loop' } },
      { nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: 126, signal: null, stderrPresent: false, outputTruncated: false } }];
    for (const patch of patches) {
      const state = structuredClone(f.state); Object.assign(state.attempts[0]!, patch);
      expect(() => decodeResourcePoolState(state, f.pool, f.bindings)).toThrow();
    }
    expect(execution).not.toHaveBeenCalled();
  });
  it('keeps the new task API closed to origin before any store write or worker invocation', async () => {
    const f = fixture(); const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'origin-task-'))); roots.push(cwd);
    const root = join(cwd, 'unused-ledger');
    const task = { schemaVersion: 1, id: taskId, allowedWorkerIds: ['codex-a'], prompt: 'Review supplied fixture text only.',
      cwd, timeoutMs: 180_000, maxOutputTokens: 1500, mode: 'read-only', origin };
    expect(() => validateResourceTask(task)).toThrow('Invalid resource task');
    await expect(runResourceTask({ root, pool: f.pool, bindings: f.bindings, observations: [],
      task: task as Parameters<typeof runResourceTask>[0]['task'] })).rejects.toThrow('Invalid resource task');
    expect(existsSync(root)).toBe(false); expect(execution).not.toHaveBeenCalled();
  });
  it('holds a persisted malformed origin before dispatch and preserves the ledger bytes', async () => {
    const f = fixture(); const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'origin-held-'))); roots.push(cwd);
    const root = join(cwd, 'ledger'); mkdirSync(root, { mode: 0o700 });
    f.state.attempts[0]!.origin = { ...origin, variantId: 'mismatched' };
    const before = canonical(f.state) + '\n'; const file = join(root, 'pool-state.json'); writeFileSync(file, before, { mode: 0o600 });
    await expect(runResourceTask({ root, pool: f.pool, bindings: f.bindings, observations: [],
      task: { schemaVersion: 1, id: 'new-review', allowedWorkerIds: ['codex-a'], prompt: 'Review supplied fixture.',
        cwd, timeoutMs: 180_000, maxOutputTokens: 1500, mode: 'read-only' } })).rejects.toThrow('ledger invalid');
    expect(readFileSync(file, 'utf8')).toBe(before); expect(execution).not.toHaveBeenCalled();
  });
  it('holds an origin-free replay of the original historical digest without redispatch or rewriting provenance', async () => {
    const f = fixture(2); const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'origin-replay-'))); roots.push(cwd);
    const root = join(cwd, 'ledger'); mkdirSync(root, { mode: 0o700 });
    const task = validateResourceTask({ schemaVersion: 1, id: taskId, allowedWorkerIds: ['codex-a'],
      prompt: 'Review supplied fixture.', cwd, timeoutMs: 180_000, maxOutputTokens: 1500, mode: 'read-only' });
    const historicalDigest = digest(canonical({ ...task, origin })); f.state.attempts[0]!.taskDigest = historicalDigest;
    expect(digest(canonical(task))).not.toBe(historicalDigest);
    const before = canonical(f.state) + '\n'; const file = join(root, 'pool-state.json'); writeFileSync(file, before, { mode: 0o600 });
    await expect(runResourceTask({ root, pool: f.pool, bindings: f.bindings, observations: [], task })).rejects.toThrow('task identity conflict');
    expect(readFileSync(file, 'utf8')).toBe(before); expect(execution).not.toHaveBeenCalled();
    expect(resourcePoolStatus(root, f.pool, f.bindings, []).attempts[0]).toMatchObject({ taskDigest: historicalDigest, origin, verifiedAccepted: false });
  });
});
