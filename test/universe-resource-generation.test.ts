/** Explicit private Git fixtures and inert/mock workers only; never vendor providers. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { generateResourceCompletion, type ResourceGenerationContext } from '../src/core/universe/resource-generation.js';
import { generateModelCandidate } from '../src/core/universe/model-candidate.js';
import { resourceGenerationTaskId, validGenerationReceipt } from '../src/core/universe/generation.js';
import { runResourceTask, type ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { refreshResourceQuotaOnce } from '../src/core/resources/quota-refresh.js';
import { waitForResourceCapacity } from '../src/core/resources/capacity-wait.js';
import * as poolRuntime from '../src/core/resources/pool-runtime.js';
import type { UniverseResourceGenerationConfig } from '../src/core/universe/types.js';

vi.mock('../src/core/resources/pool-runtime.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/resources/pool-runtime.js')>();
  return { ...original, runResourceTask: vi.fn() };
});
vi.mock('../src/core/resources/quota-refresh.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/resources/quota-refresh.js')>(), refreshResourceQuotaOnce: vi.fn(),
}));
vi.mock('../src/core/resources/capacity-wait.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/resources/capacity-wait.js')>(), waitForResourceCapacity: vi.fn(),
}));
type TaskOptions = Parameters<typeof runResourceTask>[0];
type Handoff = Awaited<ReturnType<typeof runResourceTask>>;
let base: string;
const output = JSON.stringify({ edits: [{ path: 'value.json', content: '1\n' }] });
const identity = { universeId: 'fixture', runId: '164f9f23-9e4c-4897-9243-71142ccf45d3', variantId: 'edit' };
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
function returned(options: TaskOptions, patch: Partial<ResourceTaskReceipt> = {}, text: string | null = output, replayed = false): Handoff {
  const receipt: ResourceTaskReceipt = { schemaVersion: 1, id: options.task.id, taskDigest: digest(canonical(options.task)),
    poolDigest: digest(canonical({ pool: options.pool, bindings: options.bindings })), workerId: 'native', capacityKey: 'account',
    status: 'completed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    outputDigest: digest(output), inputTokens: 7, outputTokens: 3, reason: 'worker-completed', verifiedAccepted: false,
    execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: 1, usageScope: 'codex-turn' }, ...patch };
  return { receipt, output: text, replayed, plan: null };
}
function fixture(aliases = false) {
  const universeRoot = join(base, 'universe'); const candidatePath = join(universeRoot, 'candidate');
  mkdirSync(universeRoot, { mode: 0o700 }); mkdirSync(candidatePath, { mode: 0o700 });
  writeFileSync(join(candidatePath, 'value.json'), '0\n');
  const workspace = join(base, 'empty-workspace'); mkdirSync(workspace, { mode: 0o700 });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', workspace], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
  const marker = join(base, 'native-invocations'); const script = join(base, 'inert.cjs');
  writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(marker)},'x');` +
    `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(output)}}}));` +
    "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:3}}));});", { mode: 0o600 });
  const worker = { id: 'native', provider: 'codex' as const, model: 'fixture', maxConcurrent: 1, reservePercent: 10,
    maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, allowUnknownQuota: true };
  const pool = validateResourcePool({ schemaVersion: 1, id: 'fixture-pool', workers: aliases ? [worker, { ...worker, id: 'alias' }] : [worker] });
  const bindings = validateResourceBindings(pool.workers.map((item) => ({ workerId: item.id, capacityKey: 'account',
    kind: 'native-cli', command: [process.execPath, script] })), pool);
  const observed = Date.now(); const at = (offset: number) => new Date(observed + offset).toISOString();
  const observations: ResourceObservation[] = pool.workers.map((item) => ({ workerId: item.id, observedAt: at(-1000),
    expiresAt: at(60_000), health: 'ready', retryAfter: null,
    windows: [{ id: 'weekly', usedPercent: 10, resetsAt: at(120_000) }] }));
  const runtime = { schemaVersion: 1, poolPath: join(base, 'pool.json'), bindingsPath: join(base, 'bindings.json'),
    observationsPath: join(base, 'observations.json'), root: join(base, 'resource-ledger'), workspace };
  const runtimePath = join(base, 'runtime.json');
  save(runtimePath, runtime); save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings); save(runtime.observationsPath, observations);
  const config: UniverseResourceGenerationConfig = { kind: 'resource-pool', poolId: pool.id,
    poolDigest: digest(canonical({ pool, bindings })), allowedWorkerIds: ['native'], files: ['value.json'], maxOutputTokens: 100 };
  const controller = new AbortController();
  const context: ResourceGenerationContext = { messages: [{ role: 'system', content: 'Return edits only' }, { role: 'user', content: 'fixture data' }],
    candidatePath, timeoutMs: 5000, signal: controller.signal, resourceRuntime: runtimePath,
    resourceUniverseRoot: universeRoot, resourceIdentity: identity };
  return { config, context, controller, runtime, runtimePath, observations, pool, bindings, at, marker, candidatePath,
    run: (patch: Partial<ResourceGenerationContext> = {}) => generateResourceCompletion(config, { ...context, ...patch }) };
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-resource-generation-')));
  vi.mocked(runResourceTask).mockReset().mockImplementation(async (options) => returned(options));
  vi.mocked(refreshResourceQuotaOnce).mockReset();
  vi.mocked(waitForResourceCapacity).mockReset().mockImplementation(async (options) => ({ ...options.readEvidence(), ready: true }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('resource candidate transport boundary', () => {
  it.each([null, -1, 60_001, 1.5, '1000'])('rejects invalid private capacity wait %s before contact', async (capacityWaitMs) => {
    const f = fixture(); save(f.runtimePath, { ...f.runtime, capacityWaitMs });
    expect(await f.run()).toMatchObject({ status: 'failed', resource: { dispatch: 'not-started' } });
    expect(waitForResourceCapacity).not.toHaveBeenCalled(); expect(runResourceTask).not.toHaveBeenCalled();
  });
  it.each([undefined, 0])('preserves the immediate path with wait %s', async (capacityWaitMs) => {
    const f = fixture(); save(f.runtimePath, { ...f.runtime, capacityWaitMs });
    expect((await f.run()).status).toBe('succeeded'); expect(waitForResourceCapacity).not.toHaveBeenCalled();
    expect(runResourceTask).toHaveBeenCalledOnce();
  });
  it('rechecks only a known empty concurrency race with the exact same task and decreasing budget', async () => {
    const f = fixture(); save(f.runtimePath, { ...f.runtime, capacityWaitMs: 1000 });
    let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.mocked(runResourceTask).mockImplementationOnce(async () => {
      elapsed = 100;
      return { receipt: null, output: null, replayed: false, plan: { schemaVersion: 1, poolId: f.pool.id,
        sampledAt: new Date().toISOString(), selectedWorkerId: null, candidates: [], nextEligibleAt: null,
        exclusions: [{ workerId: 'native', reasons: ['concurrency-exhausted'], nextEligibleAt: null }] } };
    }).mockImplementation(async (options) => returned(options));
    expect((await f.run()).status).toBe('succeeded');
    expect(waitForResourceCapacity).toHaveBeenCalledTimes(2); expect(runResourceTask).toHaveBeenCalledTimes(2);
    expect(vi.mocked(waitForResourceCapacity).mock.calls.map(([options]) => options.waitMs)).toEqual([1000, 900]);
    const tasks = vi.mocked(runResourceTask).mock.calls.map(([options]) => options.task);
    expect(tasks[1]).toEqual(tasks[0]); expect(tasks[0]!.timeoutMs).toBe(5000);
  });
  it.each(['throw', 'receipt', 'denial'])('does not retry a %s after capacity is observed', async (kind) => {
    const f = fixture(); save(f.runtimePath, { ...f.runtime, capacityWaitMs: 1000 });
    vi.mocked(runResourceTask).mockImplementation(async (options) => {
      if (kind === 'throw') throw new Error('PRIVATE_FAILURE');
      if (kind === 'receipt') return returned(options, { status: 'uncertain' }, null);
      return { receipt: null, output: null, replayed: false, plan: { schemaVersion: 1, poolId: f.pool.id,
        sampledAt: new Date().toISOString(), selectedWorkerId: null, candidates: [], nextEligibleAt: null,
        exclusions: [{ workerId: 'native', reasons: ['quota-reserve-reached'], nextEligibleAt: null }] } };
    });
    const result = await f.run(); expect(result.status).toBe('failed'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(waitForResourceCapacity).toHaveBeenCalledOnce(); expect(runResourceTask).toHaveBeenCalledOnce();
  });
  it('keeps cancellation during initial waiting known not-started with no task receipt', async () => {
    const f = fixture(); save(f.runtimePath, { ...f.runtime, capacityWaitMs: 1000 });
    vi.mocked(waitForResourceCapacity).mockImplementation(async () => { f.controller.abort(); throw new Error('PRIVATE_WAIT'); });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'cancelled', resource: { dispatch: 'not-started', taskId: null } });
    expect(runResourceTask).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('rechecks explicit file denial and freshness on every capacity poll', async () => {
    const f = fixture(); save(f.runtimePath, { ...f.runtime, capacityWaitMs: 1000 });
    vi.mocked(waitForResourceCapacity).mockImplementation(async (options) => {
      expect(options.readEvidence().unavailableWorkerIds).toEqual([]);
      save(f.runtime.observationsPath, [{ ...f.observations[0], health: 'unavailable' }]);
      const latest = options.readEvidence(); expect(latest.unavailableWorkerIds).toEqual(['native']);
      return { ...latest, ready: false };
    });
    expect(await f.run()).toMatchObject({ status: 'failed', resource: { dispatch: 'withheld' } });
    expect(runResourceTask).not.toHaveBeenCalled();
  });
  it('shares the allowance with metadata capture without repeating the probe during waiting', async () => {
    const f = fixture(); const quotaConfigPath = join(base, 'quota.json');
    save(quotaConfigPath, { schemaVersion: 1, poolDigest: f.config.poolDigest,
      workers: [{ workerId: 'native', accountHint: 'a'.repeat(64), bucketIds: ['weekly'] }] });
    save(f.runtimePath, { ...f.runtime, quotaConfigPath, capacityWaitMs: 1000 });
    let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.mocked(refreshResourceQuotaOnce).mockImplementation(async (options) => {
      expect(options.capacityWaitMs).toBe(1000); elapsed = 400;
      return { observations: f.observations, unavailableWorkerIds: [] };
    });
    expect((await f.run()).status).toBe('succeeded');
    expect(vi.mocked(waitForResourceCapacity).mock.calls[0]![0].waitMs).toBe(600);
    expect(refreshResourceQuotaOnce).toHaveBeenCalledOnce(); expect(runResourceTask).toHaveBeenCalledOnce();
  });
  it('forwards one checked positive quota wait snapshot instead of recomputing it as legacy zero', async () => {
    const f = fixture(); const quotaConfigPath = join(base, 'quota.json');
    save(quotaConfigPath, { schemaVersion: 1, poolDigest: f.config.poolDigest,
      workers: [{ workerId: 'native', accountHint: 'a'.repeat(64), bucketIds: ['weekly'] }] });
    save(f.runtimePath, { ...f.runtime, quotaConfigPath, capacityWaitMs: 1000 });
    let afterPreflight = false; let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => afterPreflight ? ++reads <= 2 ? 999 : 1001 : 0);
    const original = poolRuntime.resourcePoolStatus;
    vi.spyOn(poolRuntime, 'resourcePoolStatus').mockImplementation((...args) => {
      const status = original(...args); afterPreflight = true; return status;
    });
    vi.mocked(refreshResourceQuotaOnce).mockResolvedValue({ observations: f.observations, unavailableWorkerIds: [] });
    expect(await f.run()).toMatchObject({ status: 'failed', resource: { dispatch: 'withheld' } });
    expect(refreshResourceQuotaOnce).toHaveBeenCalledOnce();
    expect(vi.mocked(refreshResourceQuotaOnce).mock.calls[0]![0]).toMatchObject({ timeoutMs: 4001, capacityWaitMs: 1 });
    expect(runResourceTask).not.toHaveBeenCalled();
  });
  it.each(['health', 'reserve', 'retry'].flatMap((denial) => ['native', 'alias'].map((workerId) => ({ denial, workerId }))))(
    'retains observed $denial veto for $workerId after its row disappears while another capacity stays reserved', async ({ denial, workerId }) => {
      const f = fixture(true); const quotaConfigPath = join(base, 'quota.json');
      const pool = validateResourcePool({ ...f.pool, workers: [...f.pool.workers,
        { ...f.pool.workers[0], id: 'local', provider: 'local' }] });
      const bindings = validateResourceBindings([...f.bindings, { workerId: 'local', capacityKey: 'local',
        kind: 'local-chat', endpoint: 'http://127.0.0.1:12345/v1' }], pool);
      f.config.poolDigest = digest(canonical({ pool, bindings })); f.config.allowedWorkerIds = ['native', 'local'];
      const observations = [...f.observations, { ...f.observations[0]!, workerId: 'local', windows: [] }];
      save(f.runtime.poolPath, pool); save(f.runtime.bindingsPath, bindings); save(f.runtime.observationsPath, observations);
      save(quotaConfigPath, { schemaVersion: 1, poolDigest: f.config.poolDigest, workers: ['native', 'alias'].map((workerId) =>
        ({ workerId, accountHint: 'a'.repeat(64), bucketIds: ['weekly'] })) });
      save(f.runtimePath, { ...f.runtime, quotaConfigPath, capacityWaitMs: 1000 });
      const reservation: ResourceTaskReceipt = { schemaVersion: 1, id: 'other-task', taskDigest: digest('other-envelope'),
        poolDigest: f.config.poolDigest, workerId: 'local', capacityKey: 'local', status: 'reserved', startedAt: f.at(-100),
        finishedAt: null, outputDigest: null, inputTokens: null, outputTokens: null, reason: 'task-reserved', verifiedAccepted: false };
      mkdirSync(f.runtime.root, { mode: 0o700 });
      const ledgerPath = join(f.runtime.root, 'pool-state.json');
      save(ledgerPath, { schemaVersion: 1, poolDigest: f.config.poolDigest, observations, attempts: [reservation] });
      const before = readFileSync(ledgerPath);
      const captured = f.observations.map((row) => ({ ...row, observedAt: f.at(0) }));
      vi.mocked(refreshResourceQuotaOnce).mockResolvedValue({ observations: captured, unavailableWorkerIds: [] });
      vi.mocked(waitForResourceCapacity).mockImplementation(async (options) => {
        expect(options.readEvidence().unavailableWorkerIds).toEqual([]);
        const denied = structuredClone(observations);
        const row = denied.find((item) => item.workerId === workerId)!;
        if (denial === 'health') row.health = 'unavailable';
        if (denial === 'reserve') row.windows[0]!.usedPercent = 90;
        if (denial === 'retry') row.retryAfter = f.at(30_000);
        save(f.runtime.observationsPath, denied);
        const check = () => {
          const evidence = options.readEvidence(); expect(evidence.unavailableWorkerIds).toContain(workerId);
          const status = poolRuntime.resourcePoolStatus(f.runtime.root, pool, bindings, evidence.observations, evidence.unavailableWorkerIds);
          expect(status.plan.exclusions.find((item) => item.workerId === 'native')!.reasons).toContain('worker-unavailable');
          expect(status.plan.exclusions.find((item) => item.workerId === 'local')!.reasons).toEqual(['concurrency-exhausted']);
          return evidence;
        };
        check(); save(f.runtime.observationsPath, observations.filter((row) => row.workerId !== workerId));
        const evidence = check();
        expect(evidence.observations.find((row) => row.workerId === workerId)!.health).toBe('ready');
        return { ...evidence, ready: false };
      });
      expect(await f.run()).toMatchObject({ status: 'failed', resource: { dispatch: 'withheld' } });
      expect(refreshResourceQuotaOnce).toHaveBeenCalledOnce(); expect(waitForResourceCapacity).toHaveBeenCalledOnce();
      expect(runResourceTask).not.toHaveBeenCalled(); expect(readFileSync(ledgerPath)).toEqual(before);
    });
  it.each(['preflight', 'metadata', 'capacity'])('never restores immediate admission after positive budget expires during %s', async (phase) => {
    const f = fixture(); const quotaConfigPath = join(base, 'quota.json');
    save(quotaConfigPath, { schemaVersion: 1, poolDigest: f.config.poolDigest,
      workers: [{ workerId: 'native', accountHint: 'a'.repeat(64), bucketIds: ['weekly'] }] });
    save(f.runtimePath, { ...f.runtime, quotaConfigPath, capacityWaitMs: 1000 });
    let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const status = poolRuntime.resourcePoolStatus;
    vi.spyOn(poolRuntime, 'resourcePoolStatus').mockImplementation((...args) => {
      const value = status(...args); if (phase === 'preflight') elapsed = 1001; return value;
    });
    vi.mocked(refreshResourceQuotaOnce).mockImplementation(async () => {
      if (phase === 'metadata') elapsed = 1001;
      return { observations: f.observations, unavailableWorkerIds: [] };
    });
    vi.mocked(waitForResourceCapacity).mockImplementation(async (options) => {
      if (phase === 'capacity') elapsed = 1001;
      return { ...options.readEvidence(), ready: true };
    });
    expect(await f.run()).toMatchObject({ status: 'failed', resource: { dispatch: 'withheld' } });
    expect(runResourceTask).not.toHaveBeenCalled();
    expect(refreshResourceQuotaOnce).toHaveBeenCalledTimes(phase === 'preflight' ? 0 : 1);
    expect(waitForResourceCapacity).toHaveBeenCalledTimes(phase === 'capacity' ? 1 : 0);
  });
  it.each(['reserved', 'uncertain', 'completed'] as const)('allows only exact existing %s replay after wait expiry', async (status) => {
    const f = fixture(); save(f.runtimePath, { ...f.runtime, capacityWaitMs: 1000 });
    let elapsed = 0; let task!: TaskOptions['task'];
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.mocked(waitForResourceCapacity).mockImplementation(async (options) => {
      task = options.task; elapsed = 1001; return { ...options.readEvidence(), ready: true };
    });
    const read = poolRuntime.resourcePoolStatus;
    vi.spyOn(poolRuntime, 'resourcePoolStatus').mockImplementation((...args) => ({ ...read(...args),
      attempts: [returned({ root: f.runtime.root, pool: f.pool, bindings: f.bindings, observations: f.observations, task },
        { status }, null, true).receipt!] }));
    vi.mocked(runResourceTask).mockImplementation(async (options) => returned(options, { status }, null, true));
    expect(await f.run()).toMatchObject({ status: 'failed', usage: { state: 'unavailable' },
      resource: { dispatch: 'replayed', taskStatus: status } });
    expect(runResourceTask).toHaveBeenCalledOnce();
    expect(vi.mocked(runResourceTask).mock.calls[0]![0].task).toEqual(task);
  });
  it.each(['refresh', 'waiting'])('does not restore an unmanaged worker removed from the explicit file during %s', async (phase) => {
    const f = fixture(); const quotaConfigPath = join(base, 'quota.json');
    const pool = validateResourcePool({ ...f.pool, workers: [...f.pool.workers,
      { ...f.pool.workers[0], id: 'local', provider: 'local' }] });
    const bindings = validateResourceBindings([...f.bindings, { workerId: 'local', capacityKey: 'local',
      kind: 'local-chat', endpoint: 'http://127.0.0.1:12345/v1' }], pool);
    f.config.poolDigest = digest(canonical({ pool, bindings })); f.config.allowedWorkerIds = ['local'];
    const observations = [...f.observations, { ...f.observations[0]!, workerId: 'local', windows: [] }];
    save(f.runtime.poolPath, pool); save(f.runtime.bindingsPath, bindings); save(f.runtime.observationsPath, observations);
    save(quotaConfigPath, { schemaVersion: 1, poolDigest: f.config.poolDigest,
      workers: [{ workerId: 'native', accountHint: 'a'.repeat(64), bucketIds: ['weekly'] }] });
    save(f.runtimePath, { ...f.runtime, quotaConfigPath, capacityWaitMs: 1000 });
    vi.mocked(refreshResourceQuotaOnce).mockImplementation(async () => {
      if (phase === 'refresh') save(f.runtime.observationsPath, f.observations);
      return { observations, unavailableWorkerIds: [] };
    });
    vi.mocked(waitForResourceCapacity).mockImplementation(async (options) => {
      if (phase === 'waiting') {
        expect(options.readEvidence().unavailableWorkerIds).toEqual([]);
        save(f.runtime.observationsPath, f.observations);
      }
      const latest = options.readEvidence(); expect(latest.unavailableWorkerIds).toContain('local');
      expect(latest.observations.some((row) => row.workerId === 'local')).toBe(false);
      return { ...latest, ready: false };
    });
    expect(await f.run()).toMatchObject({ status: 'failed', resource: { dispatch: 'withheld' } });
    expect(runResourceTask).not.toHaveBeenCalled();
  });
  it.each([null, '', 'relative.json', '/private/../quota.json', 123])('rejects invalid optional quota locator %s', async (quotaConfigPath) => {
    const f = fixture(); save(f.runtimePath, { ...f.runtime, quotaConfigPath });
    expect(await f.run()).toMatchObject({ status: 'failed', resource: { dispatch: 'not-started' } });
    expect(refreshResourceQuotaOnce).not.toHaveBeenCalled(); expect(runResourceTask).not.toHaveBeenCalled();
  });
  it.each(['stale', 'file-denial', 'new-file-denial', 'managed-failure', 'expired-capture'])('merges bounded metadata without erasing %s constraints', async (kind) => {
    const f = fixture(); const quotaConfigPath = join(base, 'quota.json');
    save(quotaConfigPath, { schemaVersion: 1, poolDigest: f.config.poolDigest,
      workers: [{ workerId: 'native', accountHint: 'a'.repeat(64), bucketIds: ['weekly'] }] });
    save(f.runtimePath, { ...f.runtime, quotaConfigPath });
    const expired = structuredClone(f.observations);
    expired[0]!.observedAt = f.at(-120000); expired[0]!.expiresAt = f.at(-60000);
    if (kind === 'file-denial') expired[0]!.health = 'unavailable';
    save(f.runtime.observationsPath, expired);
    vi.mocked(refreshResourceQuotaOnce).mockImplementation(async (options) => {
      expect(options.timeoutMs).toBeGreaterThan(0); expect(options.timeoutMs).toBeLessThanOrEqual(f.context.timeoutMs);
      expect(options.cwd).toBe(f.runtime.root); expect(options.observations).toEqual(expired);
      if (kind === 'new-file-denial') save(f.runtime.observationsPath, [{ ...f.observations[0], health: 'unavailable' }]);
      return { observations: kind === 'expired-capture' ? expired : f.observations,
        unavailableWorkerIds: kind === 'managed-failure' ? ['native'] : [] };
    });
    vi.mocked(runResourceTask).mockImplementation(async (options) => {
      if (kind === 'stale') { expect(options.unavailableWorkerIds).toEqual([]); return returned(options); }
      expect(options.unavailableWorkerIds).toContain('native');
      return { receipt: null, output: null, replayed: false, plan: null };
    });
    expect((await f.run()).status).toBe(kind === 'stale' ? 'succeeded' : 'failed');
    expect(refreshResourceQuotaOnce).toHaveBeenCalledTimes(1); expect(runResourceTask).toHaveBeenCalledTimes(1);
  });
  it('uses canonical role messages, exact task identity, read-only workspace, and separate usage evidence', async () => {
    const f = fixture(); const result = await f.run();
    expect(result).toMatchObject({ status: 'succeeded', content: output, usage: { state: 'reported', inputTokens: 7, outputTokens: 3 },
      resource: { taskId: resourceGenerationTaskId(identity), dispatch: 'settled', workerId: 'native', workerProvider: 'codex',
        workerModel: 'fixture', usageScope: 'codex-turn', taskStatus: 'completed' } });
    const task = vi.mocked(runResourceTask).mock.calls[0]![0].task;
    expect(task).toMatchObject({ prompt: canonical(f.context.messages), cwd: f.runtime.workspace, mode: 'read-only', timeoutMs: 5000 });
    expect(result.resource.taskDigest).toBe(digest(canonical(task)));
    expect(result.resource.receiptDigest).toBe(digest(canonical((await vi.mocked(runResourceTask).mock.results[0]!.value).receipt)));
    expect(JSON.stringify(result)).not.toContain(base); expect(runResourceTask).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(f.candidatePath, 'value.json'), 'utf8')).toBe('0\n');
  });
  it.each(['runtime', 'universe-root', 'identity', 'insecure-runtime', 'unknown-field', 'pin', 'pool-id',
    'symlink', 'nonempty-workspace', 'insecure-workspace', 'fake-git', 'overlap-pool', 'overlap-universe', 'authority-in-universe'])(
    'refuses invalid private preflight before handoff: %s', async (kind) => {
      const f = fixture(); const patch: Partial<ResourceGenerationContext> = {};
      if (kind === 'runtime') patch.resourceRuntime = undefined;
      if (kind === 'universe-root') patch.resourceUniverseRoot = undefined;
      if (kind === 'identity') patch.resourceIdentity = undefined;
      if (kind === 'insecure-runtime') chmodSync(f.runtimePath, 0o644);
      if (kind === 'unknown-field') save(f.runtimePath, { ...f.runtime, apiKey: 'PRIVATE_DO_NOT_CAPTURE' });
      if (kind === 'pin') f.config.poolDigest = '0'.repeat(64);
      if (kind === 'pool-id') f.config.poolId = 'other-pool';
      if (kind === 'symlink') { const link = join(base, 'alias.json'); symlinkSync(f.runtimePath, link); patch.resourceRuntime = link; }
      if (kind === 'nonempty-workspace') writeFileSync(join(f.runtime.workspace, 'private.txt'), 'PRIVATE_SOURCE');
      if (kind === 'insecure-workspace') chmodSync(f.runtime.workspace, 0o755);
      if (kind === 'fake-git') { f.runtime.workspace = join(base, 'fake'); mkdirSync(f.runtime.workspace, { mode: 0o700 }); mkdirSync(join(f.runtime.workspace, '.git')); save(f.runtimePath, f.runtime); }
      if (kind === 'overlap-pool') { f.runtime.root = join(f.runtime.workspace, 'ledger'); save(f.runtimePath, f.runtime); }
      if (kind === 'overlap-universe') { f.runtime.workspace = f.context.resourceUniverseRoot!; save(f.runtimePath, f.runtime); }
      if (kind === 'authority-in-universe') { f.runtime.poolPath = join(f.context.resourceUniverseRoot!, 'pool.json'); save(f.runtime.poolPath, f.pool); save(f.runtimePath, f.runtime); }
      const result = await f.run(patch);
      expect(result).toMatchObject({ status: 'failed', content: null, resource: { dispatch: 'not-started', taskId: null } });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|\/ashlr-resource-generation-/); expect(runResourceTask).not.toHaveBeenCalled();
    });
  it.each(['missing', 'stale', 'future', 'unavailable', 'unknown', 'reset', 'reserve', 'retry'])('vetoes current %s evidence despite unknown-quota opt-in', async (kind) => {
    const f = fixture(); const current = structuredClone(f.observations);
    if (kind === 'missing') current.length = 0;
    if (kind === 'stale') { current[0]!.observedAt = f.at(-2000); current[0]!.expiresAt = f.at(-1000); }
    if (kind === 'future') { current[0]!.observedAt = f.at(1000); current[0]!.expiresAt = f.at(60_000); }
    if (kind === 'unavailable') current[0]!.health = 'unavailable';
    if (kind === 'unknown') current[0]!.windows[0]!.usedPercent = null;
    if (kind === 'reset') current[0]!.windows[0]!.resetsAt = f.at(-1000);
    if (kind === 'reserve') current[0]!.windows[0]!.usedPercent = 95;
    if (kind === 'retry') current[0]!.retryAfter = f.at(30_000);
    save(f.runtime.observationsPath, current);
    vi.mocked(runResourceTask).mockImplementation(async (options) => {
      expect(options.unavailableWorkerIds).toContain('native'); return { receipt: null, output: null, replayed: false, plan: null };
    });
    expect(await f.run()).toMatchObject({ status: 'failed', content: null, resource: { dispatch: 'withheld', taskDigest: null } });
  });
  it.each(['reserved', 'uncertain', 'completed'] as const)('never treats %s replay as recoverable response or new token usage', async (status) => {
    const f = fixture(); vi.mocked(runResourceTask).mockImplementation(async (options) => returned(options, { status }, null, true));
    expect(await f.run()).toMatchObject({ status: 'failed', content: null, usage: { state: 'unavailable', inputTokens: null, outputTokens: null },
      resource: { dispatch: 'replayed', taskStatus: status, usageScope: null } });
    expect(runResourceTask).toHaveBeenCalledTimes(1);
  });
  it.each([{ id: 'different' }, { taskDigest: '0'.repeat(64) }, { poolDigest: '0'.repeat(64) }, { workerId: 'other' },
    { capacityKey: 'other' }, { verifiedAccepted: true }, { status: 'reserved' }])('rejects mismatched handoff identity %#', async (patch) => {
    const f = fixture(); vi.mocked(runResourceTask).mockImplementation(async (options) => returned(options, patch as Partial<ResourceTaskReceipt>));
    expect(await f.run()).toMatchObject({ status: 'failed', content: null, resource: { dispatch: 'unavailable', taskDigest: null } });
  });
  it('preserves unknown handoff state without capturing a private thrown message', async () => {
    const f = fixture(); vi.mocked(runResourceTask).mockRejectedValue(new Error('PRIVATE_AUTH_FAILURE'));
    const result = await f.run(); expect(result.resource).toMatchObject({ dispatch: 'unavailable', taskDigest: null });
    expect(result.error).not.toContain('PRIVATE'); expect(runResourceTask).toHaveBeenCalledTimes(1);
  });
  it.each(['oversized', 'missing', 'digest'])('rejects %s output while retaining real settlement usage', async (kind) => {
    const f = fixture(); const text = kind === 'oversized' ? 'x'.repeat(256 * 1024 + 1) : kind === 'missing' ? null : output;
    vi.mocked(runResourceTask).mockImplementation(async (options) => returned(options,
      { outputDigest: kind === 'digest' ? '0'.repeat(64) : text ? digest(text) : null }, text));
    expect(await f.run()).toMatchObject({ status: 'failed', content: null, resource: { dispatch: 'settled', taskStatus: 'completed' },
      usage: { state: 'reported', inputTokens: 7, outputTokens: 3 } });
  });
  it.each([null, 'local-chat-completion'] as const)('does not invent accountable usage from missing/mismatched scope %s', async (usageScope) => {
    const f = fixture(); vi.mocked(runResourceTask).mockImplementation(async (options) => returned(options,
      { execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: 1, usageScope } }));
    expect(await f.run()).toMatchObject({ usage: { state: 'unavailable', inputTokens: null, outputTokens: null }, resource: { usageScope: null } });
  });
  it('keeps uncertain partial usage separate from usable candidate data', async () => {
    const f = fixture(); vi.mocked(runResourceTask).mockImplementation(async (options) => returned(options, { status: 'uncertain' }, null));
    expect(await f.run()).toMatchObject({ status: 'failed', content: null, resource: { dispatch: 'settled', taskStatus: 'uncertain' },
      usage: { state: 'reported', inputTokens: 7, outputTokens: 3 } });
  });
  it('cancels before contact and rejects a completed response received after owner cancellation', async () => {
    const f = fixture(); f.controller.abort(); expect((await f.run()).status).toBe('cancelled'); expect(runResourceTask).not.toHaveBeenCalled();
    const controller = new AbortController();
    vi.mocked(runResourceTask).mockImplementation(async (options) => { controller.abort(); return returned(options); });
    expect(await f.run({ signal: controller.signal })).toMatchObject({ status: 'cancelled', content: null,
      resource: { dispatch: 'settled', taskStatus: 'completed' } });
  });
  it('stops synchronous preflight at its monotonic budget before handoff', async () => {
    const f = fixture(); vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(5000);
    expect(await f.run()).toMatchObject({ status: 'timed-out', content: null, resource: { dispatch: 'not-started' } });
    expect(runResourceTask).not.toHaveBeenCalled();
  });
  it('passes only verified response data into the existing candidate parser without leaking runtime locators', async () => {
    const f = fixture(); const result = await generateModelCandidate(f.config, { ...f.context, objective: 'Improve the value',
      hypothesis: 'Try one', generation: 1, parentTrialId: null });
    expect(result).toMatchObject({ status: 'succeeded', provider: 'resource-pool', endpoint: null, model: null, requestStarted: false, changedFiles: ['value.json'] });
    expect(validGenerationReceipt(result)).toBe(true); expect(readFileSync(join(f.candidatePath, 'value.json'), 'utf8')).toBe('1\n');
    const prompt = vi.mocked(runResourceTask).mock.calls[0]![0].task.prompt;
    expect(prompt).not.toContain(base); expect(JSON.parse(prompt).map((message: { role: string }) => message.role)).toEqual(['system', 'user']);
    expect(result.promptDigest).toBe(digest(prompt));
  });
});

describe.skipIf(process.platform === 'win32')('current-file veto against an existing real resource ledger', () => {
  it.each(['missing', 'reserve', 'retry', 'alias-reserve', 'alias-retry'])('does not recontact after current %s evidence despite newer durable readiness', async (kind) => {
    const f = fixture(true); const original = await vi.importActual<typeof import('../src/core/resources/pool-runtime.js')>('../src/core/resources/pool-runtime.js');
    vi.mocked(runResourceTask).mockImplementation(original.runResourceTask);
    expect((await f.run()).status).toBe('succeeded'); expect(readFileSync(f.marker, 'utf8')).toBe('x');
    const older = structuredClone(f.observations); const denied = older[kind.startsWith('alias') ? 1 : 0]!;
    for (const row of older) row.observedAt = f.at(-2000);
    if (kind.includes('reserve')) denied.windows[0]!.usedPercent = 95;
    if (kind.includes('retry')) denied.retryAfter = f.at(30_000);
    save(f.runtime.observationsPath, kind === 'missing' ? [] : older);
    expect(await f.run({ resourceIdentity: { ...identity, variantId: 'second' } })).toMatchObject({ status: 'failed',
      content: null, resource: { dispatch: 'withheld', taskDigest: null } });
    expect(readFileSync(f.marker, 'utf8')).toBe('x');
  });
  it('does not require an absent unused alias and replays an exact task without contacting again', async () => {
    const f = fixture(true); const original = await vi.importActual<typeof import('../src/core/resources/pool-runtime.js')>('../src/core/resources/pool-runtime.js');
    vi.mocked(runResourceTask).mockImplementation(original.runResourceTask);
    save(f.runtime.observationsPath, [f.observations[0]]);
    expect((await f.run()).status).toBe('succeeded');
    expect(await f.run()).toMatchObject({ status: 'failed', content: null, resource: { dispatch: 'replayed' }, usage: { state: 'unavailable' } });
    expect(readFileSync(f.marker, 'utf8')).toBe('x');
    expect(await f.run({ timeoutMs: 4000 })).toMatchObject({ status: 'failed', resource: { dispatch: 'unavailable' } });
    expect(readFileSync(f.marker, 'utf8')).toBe('x'); expect(existsSync(join(f.runtime.root, 'pool-state.json'))).toBe(true);
  });
});
