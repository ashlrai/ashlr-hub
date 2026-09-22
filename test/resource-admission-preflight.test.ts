/** Real private ledger fixtures; transport is inert and never invokes a provider. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import * as runtime from '../src/core/resources/pool-runtime.js';
import * as workers from '../src/core/resources/worker.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Evidence = { observations: ResourceObservation[]; unavailableWorkerIds: string[]; quotaUnavailableWorkerIds?: string[] };
function fixture(maxTasks = 10) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'resource-preflight-'))); roots.push(base);
  const root = join(base, 'ledger'); const cwd = join(base, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  const bounds = { provider: 'codex', maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: maxTasks, taskWindowMs: 60_000, priority: 1 };
  const pool = validateResourcePool({ schemaVersion: 1, id: 'preflight', workers: [
    { ...bounds, id: 'general', model: 'gpt-6-astra', quotaScope: 'codex-general-v1' },
    { ...bounds, id: 'spark', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' },
    { ...bounds, id: 'spark-alias', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' },
    { ...bounds, id: 'other', model: 'gpt-6-astra', quotaScope: 'codex-general-v1' },
  ] });
  const bindings = workers.validateResourceBindings(pool.workers.map(worker => ({ workerId: worker.id, kind: 'native-cli',
    capacityKey: worker.id === 'other' ? 'business' : 'personal', command: [worker.id === 'other' ? '/fixture/business-never-called' : '/fixture/personal-never-called'] })), pool);
  const now = Date.now(); const at = (offset: number) => new Date(now + offset).toISOString();
  const observations = (used = 10, stale = false): ResourceObservation[] => pool.workers.map(worker => ({ workerId: worker.id,
    observedAt: at(stale ? -120_000 : -1000), expiresAt: at(stale ? -60_000 : 60_000), health: 'ready', retryAfter: null,
    windows: [{ id: worker.quotaScope === 'codex-spark-v1' ? 'codex_codex_bengalfox_primary' : 'codex_codex_primary',
      usedPercent: used, resetsAt: at(3_600_000) }] }));
  const execute = vi.spyOn(workers, 'executeResourceWorker').mockResolvedValue({ status: 'completed', output: 'inert',
    inputTokens: 1, outputTokens: 1, usageScope: 'codex-turn', reason: 'worker-completed' });
  const stateFile = join(root, 'pool-state.json');
  const persistReady = (used = 10) => {
    runtime.setResourcePoolAllocation(root, pool, bindings, 75, 0);
    const state = JSON.parse(readFileSync(stateFile, 'utf8')); state.observations = observations(used);
    writeFileSync(stateFile, canonical(state) + '\n');
    expect(runtime.resourcePoolStatus(root, pool, bindings, []).plan.candidates).toHaveLength(4);
  };
  const bytes = () => existsSync(root) ? Object.fromEntries(readdirSync(root).sort().map(name => [name, readFileSync(join(root, name)).toString('hex')])) : null;
  const run = (evidence: Evidence, allowedWorkerIds = ['spark'], id = 'new-task') => runtime.runResourceTask({ root, pool, bindings, observations: observations(),
    task: { schemaVersion: 1, id, mode: 'read-only', cwd, prompt: 'inert fixture', timeoutMs: 1000, maxOutputTokens: 128, allowedWorkerIds },
    readAdmissionEvidence: () => evidence });
  const preflight = (evidence: unknown, allowed = ['spark']) => runtime.resourceAdmissionPreflight(root, pool, bindings, allowed, evidence);
  return { root, pool, bindings, observations, execute, persistReady, bytes, run, preflight };
}

describe('read-only fresh resource admission preflight', () => {
  it.each(['empty', 'stale', 'missing-alias', 'high'] as const)('does not rescue %s fresh evidence with persisted ready quota', async kind => {
    const f = fixture(); f.persistReady(); const before = f.bytes();
    const evidence: Evidence = { observations: kind === 'empty' ? [] : kind === 'missing-alias'
      ? f.observations().filter(row => row.workerId !== 'spark-alias') : f.observations(kind === 'high' ? 90 : 10, kind === 'stale'),
    unavailableWorkerIds: [] };
    const plan = f.preflight(evidence); expect(plan.selectedWorkerId).toBeNull(); expect(plan.candidates).toEqual([]);
    expect(f.bytes()).toEqual(before); expect(f.execute).not.toHaveBeenCalled();
    const final = await f.run(evidence); expect(final.receipt).toBeNull();
    expect(final.plan?.exclusions).toEqual(plan.exclusions); expect(f.execute).not.toHaveBeenCalled();
    expect(runtime.resourcePoolStatus(f.root, f.pool, f.bindings, []).attempts).toEqual([]);
  });
  it('keeps a fresh authoritative high reading despite a newer persisted zero', async () => {
    const f = fixture(); f.persistReady(0);
    const evidence = { observations: f.observations(90).map(row => ({ ...row, observedAt: new Date(Date.now() - 2000).toISOString() })), unavailableWorkerIds: [] };
    const before = f.bytes(); expect(f.preflight(evidence).selectedWorkerId).toBeNull(); expect(f.bytes()).toEqual(before);
    expect((await f.run(evidence)).receipt).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
  });
  it('does not create a missing ledger or reserve work for a healthy preview', () => {
    const f = fixture(); const evidence = { observations: f.observations(), unavailableWorkerIds: [] };
    expect(f.preflight(evidence).selectedWorkerId).toBe('spark'); expect(f.bytes()).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('recovers only with a later complete fresh sample and leaves persisted bytes unchanged', () => {
    const f = fixture(); f.persistReady(); const before = f.bytes();
    expect(f.preflight({ observations: [], unavailableWorkerIds: [] }).selectedWorkerId).toBeNull();
    expect(f.preflight({ observations: f.observations(), unavailableWorkerIds: [] }).selectedWorkerId).toBe('spark');
    expect(f.bytes()).toEqual(before); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(['account', 'spark-alias', 'general-only'] as const)('preserves %s veto scope independently of the allowed list', async kind => {
    const f = fixture(); f.persistReady(); const before = f.bytes();
    const evidence: Evidence = { observations: f.observations(), unavailableWorkerIds: kind === 'account' ? ['general'] : [],
      quotaUnavailableWorkerIds: kind === 'spark-alias' ? ['spark-alias'] : kind === 'general-only' ? ['general'] : [] };
    const plan = f.preflight(evidence);
    expect(plan.selectedWorkerId).toBe(kind === 'general-only' ? 'spark' : null); expect(f.bytes()).toEqual(before);
    // An unrelated healthy business worker cannot satisfy this personal Spark task.
    expect(plan.candidates.every(row => row.workerId === 'spark')).toBe(true);
    if (kind !== 'general-only') {
      expect((await f.run(evidence)).receipt).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
    }
  });
  it('preserves General reservation without making it a cross-scope Spark veto', () => {
    const f = fixture(); f.persistReady();
    runtime.setResourceQuotaScopeAccess(f.root, f.pool, f.bindings, [{ capacityKey: 'personal', quotaScope: 'codex-general-v1' }], 0);
    const before = f.bytes(); const evidence = { observations: f.observations(), unavailableWorkerIds: [] };
    expect(f.preflight(evidence, ['general']).exclusions.find(row => row.workerId === 'general')?.reasons).toContain('operator-quota-scope-excluded');
    expect(f.preflight(evidence, ['spark']).selectedWorkerId).toBe('spark'); expect(f.bytes()).toEqual(before);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(['pause', 'ceiling'] as const)('reads current %s policy and agrees with final denial without invoking transport', async kind => {
    const f = fixture(); f.persistReady();
    if (kind === 'pause') runtime.setResourceWorkerAccess(f.root, f.pool, f.bindings, ['general'], 0);
    else runtime.setResourcePoolAllocation(f.root, f.pool, f.bindings, 0, 1);
    const before = f.bytes(); const evidence = { observations: f.observations(), unavailableWorkerIds: [] };
    const plan = f.preflight(evidence); expect(plan.selectedWorkerId).toBeNull(); expect(f.bytes()).toEqual(before);
    expect((await f.run(evidence)).receipt).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
  });
  it('does not treat a successful preflight as authority after the saved ceiling changes', async () => {
    const f = fixture(); f.persistReady(); const evidence = { observations: f.observations(), unavailableWorkerIds: [] };
    expect(f.preflight(evidence).selectedWorkerId).toBe('spark');
    runtime.setResourcePoolAllocation(f.root, f.pool, f.bindings, 0, 1);
    expect((await f.run(evidence)).receipt).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
  });
  it('keeps occupied capacity waitable and reads it without reserving another task', async () => {
    const f = fixture(); f.persistReady(); const evidence = { observations: f.observations(), unavailableWorkerIds: [] };
    let finish!: (result: workers.ResourceWorkerResult) => void;
    f.execute.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const running = f.run(evidence);
    try {
      await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce()); const before = f.bytes();
      const plan = f.preflight(evidence); expect(plan.selectedWorkerId).toBeNull();
      expect(plan.exclusions.find(row => row.workerId === 'spark')?.reasons).toEqual(['concurrency-exhausted']);
      expect(f.bytes()).toEqual(before);
      expect((await f.run(evidence, ['spark'], 'denied-next')).receipt).toBeNull(); expect(f.execute).toHaveBeenCalledOnce();
    } finally { finish({ status: 'completed', output: 'inert', inputTokens: 1, outputTokens: 1, usageScope: 'codex-turn', reason: 'worker-completed' }); await running; }
    expect(f.preflight(evidence).selectedWorkerId).toBe('spark');
  });
  it('preserves lifetime-window task counts without converting a cap into a health veto', async () => {
    const f = fixture(1); f.persistReady(); const evidence = { observations: f.observations(), unavailableWorkerIds: [] };
    expect((await f.run(evidence)).receipt?.status).toBe('completed'); const before = f.bytes();
    const plan = f.preflight(evidence); expect(plan.selectedWorkerId).toBeNull();
    expect(plan.exclusions.find(row => row.workerId === 'spark')?.reasons).toEqual(['operator-task-cap-reached']);
    expect(f.bytes()).toEqual(before); expect((await f.run(evidence, ['spark'], 'denied-next')).receipt).toBeNull();
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { observations: [], unavailableWorkerIds: ['missing'] },
    { observations: [{}], unavailableWorkerIds: [] }, { observations: [], unavailableWorkerIds: [], extra: true }])(
    'rejects malformed evidence without writing %#', value => {
      const f = fixture(); f.persistReady(); const before = f.bytes();
      expect(() => f.preflight(value)).toThrow(); expect(f.bytes()).toEqual(before); expect(f.execute).not.toHaveBeenCalled();
    });
  it.each([{ ids: [] }, { ids: ['missing'] }, { ids: ['spark', 'spark'] }])('rejects invalid allowed workers without creating a ledger %#', ({ ids }) => {
    const f = fixture(); expect(() => f.preflight({ observations: f.observations(), unavailableWorkerIds: [] }, ids)).toThrow();
    expect(f.bytes()).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
  });
});
