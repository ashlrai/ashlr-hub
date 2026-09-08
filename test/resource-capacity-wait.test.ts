/** Read-only private ledger fixtures; no worker, account, model, or quota probe is contacted. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForResourceCapacity, type ResourceCapacityWaitOptions } from '../src/core/resources/capacity-wait.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import * as runtime from '../src/core/resources/pool-runtime.js';
import type { ResourceTask, ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import * as workers from '../src/core/resources/worker.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

let base: string; let root: string; let cwd: string; let clock: number;
let pool: ResourcePool; let bindings: ResourceBinding[]; let task: ResourceTask;
let observations: ResourceObservation[];
let readEvidence: ReturnType<typeof vi.fn>;
const now = Date.parse('2026-09-07T12:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
const ledgerPath = () => join(root, 'pool-state.json');
const ledger = () => readFileSync(ledgerPath(), 'utf8');
const options = (patch: Partial<ResourceCapacityWaitOptions> = {}): ResourceCapacityWaitOptions =>
  ({ root, pool, bindings, task, waitMs: 1_000, readEvidence: () => readEvidence(), ...patch });
function receipt(status: ResourceTaskReceipt['status'] = 'reserved', workerId = 'a', id = 'other-task'): ResourceTaskReceipt {
  return { schemaVersion: 1, id, taskDigest: digest(canonical(task)), poolDigest: digest(canonical({ pool, bindings })),
    workerId, capacityKey: bindings.find((binding) => binding.workerId === workerId)!.capacityKey,
    status, startedAt: iso(-100), finishedAt: status === 'reserved' ? null : iso(0),
    outputDigest: status === 'completed' ? digest('fixture-result') : null,
    inputTokens: null, outputTokens: null, reason: 'fixture-status', verifiedAccepted: false };
}
function seed(attempts: ResourceTaskReceipt[], stored: ResourceObservation[] = observations): void {
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  writeFileSync(ledgerPath(), canonical({ schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
    observations: stored, attempts }), { mode: 0o600 });
}
async function advance(ms = 250): Promise<void> { clock += ms; await vi.advanceTimersByTimeAsync(ms); }

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-capacity-wait-')));
  root = join(base, 'ledger'); cwd = join(base, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(now); clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(workers, 'executeResourceWorker').mockImplementation(() => { throw new Error('Worker must not run'); });
  vi.spyOn(runtime, 'runResourceTask').mockImplementation(() => { throw new Error('Admission must not run'); });
  pool = { schemaVersion: 1, id: 'capacity-fixture', workers: ['a', 'b', 'c'].map((id) => ({ id,
    provider: 'local', model: `fixture-${id}`, maxConcurrent: 1, reservePercent: 10,
    maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 })) };
  bindings = pool.workers.map(({ id }) => ({ workerId: id, capacityKey: id, kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }));
  task = { schemaVersion: 1, id: 'new-task', allowedWorkerIds: ['a'], prompt: 'PRIVATE_FIXTURE_PROMPT',
    cwd, timeoutMs: 5_000, maxOutputTokens: 100, mode: 'read-only' };
  observations = pool.workers.map(({ id }) => ({ workerId: id, observedAt: iso(-1_000), expiresAt: iso(60_000),
    health: 'ready', windows: [], retryAfter: null }));
  readEvidence = vi.fn(() => ({ observations, unavailableWorkerIds: [] as string[] }));
});
afterEach(() => {
  expect(workers.executeResourceWorker).not.toHaveBeenCalled(); expect(runtime.runResourceTask).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('bounded read-only resource capacity wait', () => {
  it.each([0, 60_000])('checks an eligible missing store once without creating it (budget=%s)', async (waitMs) => {
    const result = await waitForResourceCapacity(options({ waitMs }));
    expect(result).toEqual({ ready: true, observations, unavailableWorkerIds: [] });
    expect(readEvidence).toHaveBeenCalledTimes(1); expect(existsSync(root)).toBe(false);
    expect(readdirSync(base)).toEqual(['workspace']);
  });

  it('does one immediate check, without waiting or writing, when zero budget is occupied', async () => {
    seed([receipt()]); const before = ledger();
    expect((await waitForResourceCapacity(options({ waitMs: 0 }))).ready).toBe(false);
    expect(readEvidence).toHaveBeenCalledTimes(1); expect(ledger()).toBe(before); expect(readdirSync(root)).toEqual(['pool-state.json']);
  });

  it('ignores globally eligible but disallowed workers and observes reserved-to-completed capacity', async () => {
    seed([receipt()]); let settled = false;
    const pending = waitForResourceCapacity(options()).then((result) => { settled = true; return result; });
    await advance(); expect(settled).toBe(false); expect(readEvidence).toHaveBeenCalledTimes(2);
    seed([receipt('completed')]); const before = ledger();
    await advance(); expect((await pending).ready).toBe(true);
    expect(ledger()).toBe(before); expect(readdirSync(root)).toEqual(['pool-state.json']);
  });

  it('shares occupancy across aliases, including a non-allowlisted reservation owner', async () => {
    bindings[1]!.capacityKey = 'a'; seed([receipt('reserved', 'b')]);
    const pending = waitForResourceCapacity(options());
    await advance(); seed([receipt('completed', 'b')]); await advance();
    expect((await pending).ready).toBe(true); expect(readEvidence).toHaveBeenCalledTimes(3);
  });

  it.each(['uncertain', 'failed', 'timed-out'] as const)('stops when a held reservation becomes %s', async (status) => {
    seed([receipt()]); const pending = waitForResourceCapacity(options());
    seed([receipt(status)]); const before = ledger(); await advance();
    expect((await pending).ready).toBe(false); expect(ledger()).toBe(before); expect(clock).toBe(250);
  });

  it('does not wait when uncertain occupancy shares the otherwise reserved capacity', async () => {
    bindings[1]!.capacityKey = 'a'; seed([receipt(), receipt('uncertain', 'b', 'uncertain-task')]);
    const before = ledger(); expect((await waitForResourceCapacity(options())).ready).toBe(false);
    expect(readEvidence).toHaveBeenCalledTimes(1); expect(ledger()).toBe(before);
  });

  it('can wait for an independent clean reserved capacity despite an uncertain alternative', async () => {
    task.allowedWorkerIds = ['a', 'b']; seed([receipt('uncertain'), receipt('reserved', 'b', 'clean-task')]);
    const pending = waitForResourceCapacity(options());
    seed([receipt('uncertain'), receipt('completed', 'b', 'clean-task')]); await advance();
    expect((await pending).ready).toBe(true);
  });

  it.each(['reserved', 'uncertain', 'completed', 'failed', 'timed-out', 'cancelled'] as const)(
    'returns an existing own %s receipt to atomic replay/conflict without waiting', async (status) => {
      seed([{ ...receipt(status, 'a', task.id), taskDigest: digest('different-envelope') }]);
      readEvidence.mockReturnValue({ observations: [], unavailableWorkerIds: ['a'] });
      const before = ledger(); expect((await waitForResourceCapacity(options())).ready).toBe(true);
      expect(readEvidence).toHaveBeenCalledTimes(1); expect(ledger()).toBe(before);
    });

  it.each(['unavailable', 'retry', 'expired', 'missing', 'task-cap'])(
    'does not wait through concurrency plus an independent %s denial', async (kind) => {
      if (kind === 'unavailable') observations[0]!.health = 'unavailable';
      if (kind === 'retry') observations[0]!.retryAfter = iso(500);
      if (kind === 'expired') observations[0]!.expiresAt = iso(-1);
      if (kind === 'missing') observations = observations.slice(1);
      if (kind === 'task-cap') pool.workers[0]!.maxTasksPerWindow = 1;
      seed([receipt()]); const before = ledger();
      expect((await waitForResourceCapacity(options())).ready).toBe(false);
      expect(readEvidence).toHaveBeenCalledTimes(1); expect(ledger()).toBe(before);
    });

  it('preserves own-task replay/conflict precedence when its read consumes the capacity budget', async () => {
    seed([receipt('uncertain', 'a', task.id)]);
    readEvidence.mockImplementation(() => { clock = 500; return { observations, unavailableWorkerIds: [] }; });
    expect((await waitForResourceCapacity(options({ waitMs: 500 }))).ready).toBe(true);
    expect(readEvidence).toHaveBeenCalledTimes(1);
  });

  it('re-reads explicit evidence and stops on a new invocation-only alias veto', async () => {
    bindings[1]!.capacityKey = 'a'; seed([receipt()]); const before = ledger();
    const pending = waitForResourceCapacity(options());
    readEvidence.mockReturnValue({ observations, unavailableWorkerIds: ['b'] }); await advance();
    const result = await pending; expect(result.ready).toBe(false); expect(result.unavailableWorkerIds).toEqual(['b']);
    expect(readEvidence).toHaveBeenCalledTimes(2); expect(ledger()).toBe(before);
  });

  it('stops when fresh evidence expires while waiting, despite an unrelated eligible worker', async () => {
    observations[0]!.expiresAt = iso(200); seed([receipt()]); const before = ledger();
    const pending = waitForResourceCapacity(options()); await advance();
    expect((await pending).ready).toBe(false); expect(ledger()).toBe(before); expect(readEvidence).toHaveBeenCalledTimes(2);
  });

  it('does not accept an eligible status without an allowed candidate or invent reserved occupancy', async () => {
    const actual = runtime.resourcePoolStatus(root, pool, bindings, observations);
    vi.spyOn(runtime, 'resourcePoolStatus').mockReturnValue({ ...actual, plan: { ...actual.plan,
      candidates: actual.plan.candidates.filter((candidate) => candidate.workerId !== 'a'),
      exclusions: [{ workerId: 'a', reasons: ['concurrency-exhausted'], nextEligibleAt: iso(100) }] } });
    expect((await waitForResourceCapacity(options())).ready).toBe(false);
    expect(readEvidence).toHaveBeenCalledTimes(1); expect(existsSync(root)).toBe(false);
  });

  it('uses one monotonic deadline and ignores wall-clock rollback or retry hints', async () => {
    seed([receipt()]); const before = ledger(); const pending = waitForResourceCapacity(options({ waitMs: 600 }));
    await advance(); vi.setSystemTime(now - 1_000);
    await advance(); await advance(100);
    expect((await pending).ready).toBe(false); expect(clock).toBe(600); expect(ledger()).toBe(before);
    expect(readEvidence).toHaveBeenCalledTimes(4);
  });

  it('does not return new capacity when a polling read consumes the original wait deadline', async () => {
    seed([receipt()]); const pending = waitForResourceCapacity(options({ waitMs: 500 }));
    readEvidence.mockImplementation(() => { clock = 500; return { observations, unavailableWorkerIds: [] }; });
    seed([receipt('completed')]); await advance();
    expect((await pending).ready).toBe(false);
  });

  it('counts synchronous initial evidence reading against a positive wait deadline', async () => {
    readEvidence.mockImplementation(() => { clock = 500; return { observations, unavailableWorkerIds: [] }; });
    expect((await waitForResourceCapacity(options({ waitMs: 500 }))).ready).toBe(false);
    expect(readEvidence).toHaveBeenCalledTimes(1); expect(existsSync(root)).toBe(false);
  });

  it('cancels its timer/listener without touching another reservation or exposing abort reasons', async () => {
    seed([receipt()]); const before = ledger(); const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener'); const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = waitForResourceCapacity(options({ signal: controller.signal }));
    const assertion = expect(pending).rejects.toThrow(/^Resource capacity wait cancelled$/);
    controller.abort(new Error('PRIVATE_ABORT_REASON')); await assertion;
    expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1); expect(ledger()).toBe(before);
  });

  it('removes every listener after successful polling and respects a previously cancelled signal', async () => {
    const controller = new AbortController(); const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener'); seed([receipt()]);
    const pending = waitForResourceCapacity(options({ signal: controller.signal }));
    await advance(); seed([receipt('completed')]); await advance(); expect((await pending).ready).toBe(true);
    expect(add).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledTimes(2);
    controller.abort('PRIVATE'); readEvidence.mockClear();
    await expect(waitForResourceCapacity(options({ signal: controller.signal }))).rejects.toThrow('Resource capacity wait cancelled');
    expect(readEvidence).not.toHaveBeenCalled();
  });

  it('honors cancellation from a synchronous evidence read before a ready result', async () => {
    const controller = new AbortController();
    readEvidence.mockImplementation(() => { controller.abort(); return { observations, unavailableWorkerIds: [] }; });
    const status = vi.spyOn(runtime, 'resourcePoolStatus');
    await expect(waitForResourceCapacity(options({ signal: controller.signal }))).rejects.toThrow('Resource capacity wait cancelled');
    expect(status).not.toHaveBeenCalled();
  });

  it('snapshots identity/options before waiting and returns detached evidence', async () => {
    seed([receipt()]); const original = structuredClone({ pool, bindings, task });
    const controller = new AbortController(); const selected = options({ signal: controller.signal });
    const pending = waitForResourceCapacity(selected);
    selected.root = join(base, 'not-used'); selected.waitMs = 0; selected.signal = AbortSignal.abort();
    selected.readEvidence = () => { throw new Error('Replacement callback'); };
    pool.workers[0]!.maxConcurrent = 9; bindings[0]!.capacityKey = 'changed'; task.allowedWorkerIds[0] = 'c';
    await advance();
    pool = original.pool; bindings = original.bindings; task = original.task; seed([receipt('completed')]);
    await advance(); const result = await pending; expect(result.ready).toBe(true);
    observations[0]!.health = 'unavailable'; expect(result.observations[0]!.health).toBe('ready');
    expect(Object.isFrozen(result.observations)).toBe(true); expect(existsSync(selected.root)).toBe(false);
  });

  it.each([-1, 60_001, 0.5, NaN, Infinity, '250', null])('rejects invalid waitMs %j before evidence reads', async (waitMs) => {
    await expect(waitForResourceCapacity(options({ waitMs: waitMs as number }))).rejects.toThrow('Invalid resource capacity wait');
    expect(readEvidence).not.toHaveBeenCalled(); expect(existsSync(root)).toBe(false);
  });

  it.each(['', 'relative', '/', '/invalid/../root', '/invalid\0root', '/invalid\u0080root'])(
    'rejects invalid root %j before evidence reads', async (value) => {
      await expect(waitForResourceCapacity(options({ root: value }))).rejects.toThrow('Invalid resource capacity wait');
      expect(readEvidence).not.toHaveBeenCalled(); expect(existsSync(root)).toBe(false);
    });

  it.each(['pool', 'bindings', 'task', 'unknown-worker', 'callback', 'signal'])(
    'rejects invalid %s before evidence reads', async (kind) => {
      const selected = options();
      if (kind === 'pool') selected.pool = { ...pool, schemaVersion: 2 } as unknown as ResourcePool;
      if (kind === 'bindings') selected.bindings = [];
      if (kind === 'task') selected.task = { ...task, timeoutMs: 0 };
      if (kind === 'unknown-worker') selected.task = { ...task, allowedWorkerIds: ['unknown'] };
      if (kind === 'callback') selected.readEvidence = null as unknown as ResourceCapacityWaitOptions['readEvidence'];
      if (kind === 'signal') selected.signal = {} as AbortSignal;
      await expect(waitForResourceCapacity(selected)).rejects.toThrow();
      expect(readEvidence).not.toHaveBeenCalled(); expect(existsSync(root)).toBe(false);
    });

  it.each(['observations', 'veto', 'throw', 'ledger'])(
    'does not retry invalid or unavailable %s evidence', async (kind) => {
      seed([receipt()]); const pending = waitForResourceCapacity(options());
      const assertion = expect(pending).rejects.toThrow();
      if (kind === 'observations') readEvidence.mockReturnValue({ observations: [{}], unavailableWorkerIds: [] });
      if (kind === 'veto') readEvidence.mockReturnValue({ observations, unavailableWorkerIds: ['unknown'] });
      if (kind === 'throw') readEvidence.mockImplementation(() => { throw new Error('Fixture read unavailable'); });
      if (kind === 'ledger') writeFileSync(ledgerPath(), '{}');
      const before = ledger(); await advance(); await assertion;
      expect(readEvidence).toHaveBeenCalledTimes(2); expect(ledger()).toBe(before);
    });

  it.each(['permissions', 'symlink'])('rejects an unsafe %s root without repair or state creation', async (kind) => {
    if (kind === 'permissions') { mkdirSync(root, { mode: 0o700 }); chmodSync(root, 0o755); }
    else symlinkSync(cwd, root);
    await expect(waitForResourceCapacity(options())).rejects.toThrow();
    expect(existsSync(ledgerPath())).toBe(false); expect(readdirSync(cwd)).toEqual([]);
  });
});
