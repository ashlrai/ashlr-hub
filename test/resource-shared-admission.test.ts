/** Independent private-ledger acceptance; only worker execution is replaced with an inert double. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLocalStoreLockWithOutcome } from '../src/core/fleet/local-store-lock.js';
import { readResourcePoolAllocation, resourcePoolStatus, runResourceTask, setResourcePoolAllocation,
  type ResourceTask } from '../src/core/resources/pool-runtime.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import * as workers from '../src/core/resources/worker.js';

let directory: string;
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-shared-admission-'))); });
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

type Evidence = { observations: ResourceObservation[]; unavailableWorkerIds: string[] };
function fixture(shared = false) {
  const root = join(directory, 'ledger'); const cwd = join(directory, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  const ids = shared ? ['codex-a', 'codex-alias'] : ['codex-a'];
  const pool: ResourcePool = { schemaVersion: 1, id: 'shared-admission', workers: ids.map((id) => ({ id,
    provider: 'codex', model: 'inert-fixture', maxConcurrent: 1, reservePercent: 10, priority: 1,
    maxTasksPerWindow: 10, taskWindowMs: 60_000, allowUnknownQuota: true })) };
  const bindings: workers.ResourceBinding[] = ids.map((workerId) => ({ workerId, capacityKey: 'codex-capacity',
    kind: 'native-cli', command: ['/fixture/never-executed'] }));
  const now = Date.now(); const at = (offset: number) => new Date(now + offset).toISOString();
  const observations = (used = 20, offset = -1000): ResourceObservation[] => ids.map((workerId) => ({ workerId,
    observedAt: at(offset), expiresAt: at(60_000), health: 'ready', retryAfter: null,
    windows: [{ id: 'weekly', usedPercent: used, resetsAt: at(3_600_000) }] }));
  const task: ResourceTask = { schemaVersion: 1, id: 'fixture-task', allowedWorkerIds: ['codex-a'],
    prompt: 'inert fixture request', cwd, timeoutMs: 1000, maxOutputTokens: 100, mode: 'read-only' };
  const execute = vi.spyOn(workers, 'executeResourceWorker').mockResolvedValue({ status: 'completed', output: 'fixture',
    inputTokens: null, outputTokens: null, reason: 'worker-completed' });
  const run = (readAdmissionEvidence: () => Evidence, patch: Partial<Parameters<typeof runResourceTask>[0]> = {}) =>
    runResourceTask({ root, pool, bindings, observations: observations(), task, readAdmissionEvidence, ...patch });
  const status = () => resourcePoolStatus(root, pool, bindings, []);
  const set = (ceiling: number, revision = 0) => setResourcePoolAllocation(root, pool, bindings, ceiling, revision);
  return { root, pool, bindings, task, execute, observations, at, run, status, set };
}

describe.skipIf(process.platform === 'win32')('shared collector evidence at atomic task admission', () => {
  it('reads fresh evidence while holding the exact ledger lock before executing', async () => {
    const f = fixture(); f.set(75);
    const read = vi.fn(() => {
      expect(f.execute).not.toHaveBeenCalled();
      expect(existsSync(join(f.root, '.pool.lock'))).toBe(true);
      expect(acquireLocalStoreLockWithOutcome(join(f.root, '.pool.lock'), 0).lock).toBeNull();
      return { observations: f.observations(), unavailableWorkerIds: [] };
    });
    expect((await f.run(read)).receipt?.status).toBe('completed');
    expect(read).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
    expect(existsSync(join(f.root, '.pool.lock'))).toBe(false);
  });

  it.each(['callback', 'static', 'alias'] as const)('retains the %s unavailable gate after observation merging', async (kind) => {
    const f = fixture(kind === 'alias'); f.set(75);
    const result = await f.run(() => ({ observations: f.observations(0),
      unavailableWorkerIds: kind === 'static' ? [] : [kind === 'alias' ? 'codex-alias' : 'codex-a'] }),
    { unavailableWorkerIds: kind === 'static' ? ['codex-a'] : [] });
    expect(result.receipt).toBeNull(); expect(f.status().attempts).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
  });

  it('does not reserve or persist a partial transaction when the evidence reader throws', async () => {
    const f = fixture(); f.set(75); const before = readFileSync(join(f.root, 'pool-state.json'));
    await expect(f.run(() => { throw new Error('Collector stopped'); })).rejects.toThrow();
    expect(readFileSync(join(f.root, 'pool-state.json'))).toEqual(before);
    expect(f.status().attempts).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, '.pool.lock'))).toBe(false);
  });

  it.each([null, {}, { observations: [], unavailableWorkerIds: ['missing'] },
    { observations: [{}], unavailableWorkerIds: [] }, Promise.resolve({ observations: [], unavailableWorkerIds: [] })])(
    'refuses invalid or asynchronous evidence %# without a reservation', async (value) => {
      const f = fixture(); f.set(75);
      await expect(f.run(() => value as Evidence)).rejects.toThrow();
      expect(f.status().attempts).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
      expect(existsSync(join(f.root, '.pool.lock'))).toBe(false);
    });

  it('retains an authoritative high measurement against a newer zero incoming reading', async () => {
    const f = fixture(); f.set(75);
    const result = await f.run(() => ({ observations: f.observations(85, -2000), unavailableWorkerIds: [] }),
      { observations: f.observations(0, -1000) });
    expect(result.receipt).toBeNull(); expect(f.status().attempts).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
  });

  it('uses the saved ceiling at reservation, not an earlier eligible preview', async () => {
    const f = fixture(); f.set(100); const rows = f.observations(80);
    expect(resourcePoolStatus(f.root, f.pool, f.bindings, rows).plan.selectedWorkerId).toBe('codex-a');
    f.set(75, 1);
    const result = await f.run(() => ({ observations: rows, unavailableWorkerIds: [] }));
    expect(result.receipt).toBeNull(); expect(f.execute).not.toHaveBeenCalled();
    expect(readResourcePoolAllocation(f.root, f.pool, f.bindings)).toMatchObject({ ceilingPercent: 75, revision: 2 });
  });

  it('does not turn temporary occupancy into a persistent admission health veto', async () => {
    const f = fixture(); f.set(75); let finish!: (value: workers.ResourceWorkerResult) => void;
    f.execute.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const read = () => ({ observations: f.observations(), unavailableWorkerIds: [] });
    const running = f.run(read);
    try {
      const next = await f.run(read, { task: { ...f.task, id: 'next-task' } });
      expect(next.receipt).toBeNull();
      expect(next.plan?.exclusions[0]?.reasons).toEqual(['concurrency-exhausted']);
      expect(f.execute).toHaveBeenCalledOnce();
    } finally {
      finish({ status: 'completed', output: 'fixture', inputTokens: null, outputTokens: null, reason: 'worker-completed' });
      await running;
    }
  });

  it('keeps task-cap denial distinct from collector health', async () => {
    const f = fixture(); f.pool.workers[0]!.maxTasksPerWindow = 1; f.set(75);
    const read = () => ({ observations: f.observations(), unavailableWorkerIds: [] });
    await f.run(read);
    const next = await f.run(read, { task: { ...f.task, id: 'next-task' } });
    expect(next.receipt).toBeNull();
    expect(next.plan?.exclusions[0]?.reasons).toEqual(['operator-task-cap-reached']);
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it('does not reserve if the evidence recheck observes cancellation', async () => {
    const f = fixture(); f.set(75); const controller = new AbortController();
    await expect(f.run(() => {
      controller.abort(); return { observations: f.observations(), unavailableWorkerIds: [] };
    }, { signal: controller.signal })).rejects.toThrow('cancelled before reservation');
    expect(f.status().attempts).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
  });

  it('replays an exact settled task without consulting the collector again', async () => {
    const f = fixture(); f.set(75);
    const first = await f.run(() => ({ observations: f.observations(), unavailableWorkerIds: [] }));
    const read = vi.fn((): Evidence => { throw new Error('Collector no longer running'); });
    const replay = await f.run(read);
    expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.receipt);
    expect(read).not.toHaveBeenCalled(); expect(f.execute).toHaveBeenCalledOnce();
  });

  it('rejects a conflicting task identity before consulting collector evidence', async () => {
    const f = fixture(); f.set(75);
    await f.run(() => ({ observations: f.observations(), unavailableWorkerIds: [] }));
    const read = vi.fn((): Evidence => { throw new Error('Must not read'); });
    await expect(f.run(read, { task: { ...f.task, prompt: 'different request' } })).rejects.toThrow('identity conflict');
    expect(read).not.toHaveBeenCalled(); expect(f.execute).toHaveBeenCalledOnce(); expect(f.status().attempts).toHaveLength(1);
  });
});
