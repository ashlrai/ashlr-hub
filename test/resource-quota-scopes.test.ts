import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { validateResourcePool, validateResourceObservations, type ResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { resourceQuotaBuckets } from '../src/core/resources/quota-scope.js';
import { resourcePoolStatus, runResourceTask, setResourceWorkerAccess, type ResourceTask } from '../src/core/resources/pool-runtime.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import { createResourceQuotaRefresher, validateResourceQuotaRefreshConfig, type ResourceQuotaRefresher } from '../src/core/resources/quota-refresh.js';
import { acquireResourceQuotaRefreshLease, type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { publishSharedQuotaEvidence, readSharedQuotaEvidence } from '../src/core/resources/quota-shared-evidence.js';
import { waitForResourceCapacity } from '../src/core/resources/capacity-wait.js';
import { createResourceConsoleReader, unavailableManagedResourceWorkers, withholdResourceConsoleWorkers } from '../src/core/web/resource-console-reads.js';
import { projectResourceConsoleEvidence } from '../src/core/web/resource-console-public.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';

let root: string;
const handles: ResourceQuotaRefresher[] = [];
const leases: ResourceQuotaRefreshLease[] = [];
const time = (ms = Date.now()) => new Date(ms).toISOString();
beforeEach(() => { root = realpathSync(mkdtempSync(join(homedir(), 'independent-quota-'))); });
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close().catch(() => {});
  for (const lease of leases.splice(0)) lease.close();
  vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
});

function fixture(maxTasks = 10) {
  const pool = validateResourcePool({ schemaVersion: 1, id: 'independent-quota', workers: [
    { id: 'general', provider: 'codex', model: 'gpt-6-astra', quotaScope: 'codex-general-v1',
      maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: maxTasks, taskWindowMs: 60_000, priority: 1 },
    { id: 'spark', provider: 'codex', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1',
      maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: maxTasks, taskWindowMs: 60_000, priority: 1 },
  ] });
  const script = join(root, 'fixture-worker.mjs');
  // Inert local protocol fixture; ignores CLI model flags and never contacts a provider.
  writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture'}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));},150));`);
  const bindings: ResourceBinding[] = pool.workers.map((worker) => ({ workerId: worker.id, capacityKey: 'same-account',
    kind: 'native-cli', command: [process.execPath, script] }));
  const config = { schemaVersion: 1 as const, poolDigest: digest(canonical({ pool, bindings })), workers: pool.workers.map((worker) => ({
    workerId: worker.id, accountHint: 'a'.repeat(64), bucketIds: resourceQuotaBuckets(worker)! })) };
  const observations = pool.workers.map((worker): ResourceObservation => ({ workerId: worker.id, observedAt: time(), updatedAt: time(),
    expiresAt: time(Date.now() + 60_000), health: 'ready', retryAfter: null, windows: ['primary', 'secondary'].map((window) => ({
      id: `codex_${resourceQuotaBuckets(worker)![0]}_${window}`, usedPercent: 20, resetsAt: time(Date.now() + 3_600_000) })) }));
  return { root, pool, bindings, config, observations };
}
function task(id = 'first', allowedWorkerIds = ['general', 'spark']): ResourceTask {
  return { schemaVersion: 1, id, allowedWorkerIds, prompt: 'inert fixture', cwd: root,
    timeoutMs: 10_000, maxOutputTokens: 100, mode: 'read-only' };
}

describe('explicit independent quota scopes', () => {
  it('requires exact provider/model/scope and pinned collector buckets', () => {
    const f = fixture();
    expect(validateResourceQuotaRefreshConfig(f.config, f.pool, f.bindings).workers).toHaveLength(2);
    for (const patch of [{ model: 'unknown' }, { provider: 'claude' }, { quotaScope: 'codex-general-v1' }]) {
      expect(() => validateResourcePool({ ...f.pool, workers: [f.pool.workers[0], { ...f.pool.workers[1], ...patch }] })).toThrow();
    }
    const bad = structuredClone(f.config); bad.workers[1]!.bucketIds = ['codex'];
    expect(() => validateResourceQuotaRefreshConfig(bad, f.pool, f.bindings)).toThrow();
    bad.workers[1]!.bucketIds = ['codex_bengalfox']; bad.workers[1]!.accountHint = 'b'.repeat(64);
    expect(() => validateResourceQuotaRefreshConfig(bad, f.pool, f.bindings)).toThrow();
    const wrong = structuredClone(f.observations); wrong[1]!.windows = wrong[0]!.windows;
    expect(() => validateResourceObservations(wrong, f.pool)).toThrow('outside pinned quota scope');
  });

  it.each([0, 1])('blocks only exhausted scope %s and carries this through capacity waiting', async (index) => {
    const f = fixture(); f.observations[index]!.windows[0]!.usedPercent = 100;
    const blocked = f.pool.workers[index]!.id; const eligible = f.pool.workers[1 - index]!.id;
    const status = resourcePoolStatus(root, f.pool, f.bindings, f.observations);
    expect(status.plan.candidates.map((row) => row.workerId)).toEqual([eligible]);
    expect(status.plan.exclusions.find((row) => row.workerId === blocked)).toBeDefined();
    const waiting = await waitForResourceCapacity({ ...f, task: task('wait'), waitMs: 0,
      readEvidence: () => ({ observations: f.observations, unavailableWorkerIds: [], quotaUnavailableWorkerIds: [blocked] }) });
    expect(waiting.ready).toBe(true); expect(waiting.quotaUnavailableWorkerIds).toEqual([blocked]);
  });

  it('shares quota denial between same-bucket aliases and keeps unmapped aliases conservative', () => {
    const f = fixture();
    const generalAlias = { ...f.pool.workers[0]!, id: 'spark', model: 'gpt-5.6-sol' };
    const pool = { ...f.pool, workers: [f.pool.workers[0]!, generalAlias] };
    const observed = structuredClone(f.observations); observed[1]!.windows = structuredClone(observed[0]!.windows);
    observed[0]!.windows[0]!.usedPercent = 100;
    expect(resourcePoolStatus(root, pool, f.bindings, observed).plan.candidates).toEqual([]);
    const legacy: ResourcePool = { ...pool, workers: pool.workers.map(({ quotaScope: _scope, ...worker }) => worker) };
    expect(resourcePoolStatus(root, legacy, f.bindings, observed).plan.candidates).toEqual([]);
  });

  it.each(['missing', 'unknown', 'stale'])('holds Spark for %s quota without borrowing general headroom', (kind) => {
    const f = fixture();
    if (kind === 'missing') f.observations.pop();
    if (kind === 'unknown') f.observations[1]!.windows[0]!.usedPercent = null;
    if (kind === 'stale') {
      f.observations[1]!.observedAt = time(Date.now() - 120_000); f.observations[1]!.updatedAt = f.observations[1]!.observedAt;
      f.observations[1]!.expiresAt = time(Date.now() - 60_000);
    }
    expect(resourcePoolStatus(root, f.pool, f.bindings, f.observations).plan.candidates.map((row) => row.workerId)).toEqual(['general']);
  });

  it('retains account-wide health, retry, explicit exclusion and persisted pause across scopes', () => {
    const f = fixture();
    expect(resourcePoolStatus(root, f.pool, f.bindings, f.observations, ['general']).plan.candidates).toEqual([]);
    f.observations[0]!.health = 'unavailable';
    expect(resourcePoolStatus(root, f.pool, f.bindings, f.observations).plan.candidates).toEqual([]);
    f.observations[0]!.health = 'ready'; f.observations[0]!.retryAfter = time(Date.now() + 60_000);
    expect(resourcePoolStatus(root, f.pool, f.bindings, f.observations).plan.candidates).toEqual([]);
    f.observations[0]!.retryAfter = null;
    setResourceWorkerAccess(root, f.pool, f.bindings, ['general'], 0);
    expect(resourcePoolStatus(root, f.pool, f.bindings, f.observations).plan.candidates).toEqual([]);
  });

  it('preserves one shared execution slot and rolling task cap across General/Spark', async () => {
    const f = fixture(1);
    const first = runResourceTask({ ...f, task: task('first', ['spark']) });
    const during = resourcePoolStatus(root, f.pool, f.bindings, f.observations);
    expect(during.plan.candidates).toEqual([]);
    expect(during.attempts[0]!.capacityKey).toBe('same-account');
    expect((await first).receipt?.status).toBe('completed');
    const after = resourcePoolStatus(root, f.pool, f.bindings, f.observations);
    expect(after.plan.exclusions.every((row) => row.reasons.includes('operator-task-cap-reached'))).toBe(true);
  });

  it('rechecks scoped native veto under admission lock despite newer external zero', async () => {
    const f = fixture();
    const native = structuredClone(f.observations); native[0]!.windows[0]!.usedPercent = 100;
    const result = await runResourceTask({ ...f, task: task(),
      readAdmissionEvidence: () => ({ observations: native, unavailableWorkerIds: [], quotaUnavailableWorkerIds: ['general'] }) });
    expect(result.receipt?.workerId).toBe('spark'); expect(result.receipt?.status).toBe('completed');
  });

  it('collector separates quota exhaustion from account failure and keeps expired health failures account-wide', async () => {
    vi.useFakeTimers(); const f = fixture();
    let accountFailure = false;
    const handle = createResourceQuotaRefresher({ ...f, cwd: root, _probe: async (options) => {
      const observation = structuredClone(f.observations.find((row) => row.workerId === options.workerId)!);
      observation.observedAt = time(); observation.updatedAt = time(); observation.expiresAt = time(Date.now() + 60_000);
      if (options.workerId === 'general') { observation.windows[0]!.usedPercent = 100; if (accountFailure) observation.health = 'unavailable'; }
      return { schemaVersion: 1, scope: 'codex-native-metadata', workerId: options.workerId, poolDigest: f.config.poolDigest,
        status: 'observed', reason: 'fixture', startedAt: time(), finishedAt: time(), accountHint: options.expectedAccountHint!, planType: null, observation };
    } }); handles.push(handle);
    await vi.advanceTimersByTimeAsync(1);
    expect(handle.unavailableWorkerIds()).toEqual([]); expect(handle.quotaUnavailableWorkerIds()).toEqual(['general']);
    accountFailure = true; await vi.advanceTimersByTimeAsync(30_001);
    expect(handle.unavailableWorkerIds().toSorted()).toEqual(['general', 'spark']);
    vi.setSystemTime(Date.now() + 120_000);
    expect(handle.unavailableWorkerIds().toSorted()).toEqual(['general', 'spark']);
    expect(handle.quotaUnavailableWorkerIds()).not.toContain('general');
    const current = f.observations.map((row) => ({ ...row, observedAt: time(), updatedAt: time(), expiresAt: time(Date.now() + 60_000) }));
    expect(resourcePoolStatus(root, f.pool, f.bindings, handle.readObservations(current), handle.unavailableWorkerIds(),
      handle.quotaUnavailableWorkerIds()).plan.candidates).toEqual([]);
  });

  it('publishes and rereads independent quota denials with account veto remaining dominant', async () => {
    const f = fixture(); f.observations[0]!.windows[0]!.usedPercent = 100;
    const lease = await acquireResourceQuotaRefreshLease(root); leases.push(lease); lease.markPending();
    publishSharedQuotaEvidence({ ...f, lease, state: 'running', evidence: { observations: f.observations, unavailableWorkerIds: [] } });
    const evidence = readSharedQuotaEvidence(f);
    expect(evidence.unavailableWorkerIds).toEqual([]); expect(evidence.quotaUnavailableWorkerIds).toEqual(['general']);
    expect(resourcePoolStatus(root, f.pool, f.bindings, evidence.observations, evidence.unavailableWorkerIds,
      evidence.quotaUnavailableWorkerIds).plan.candidates.map((row) => row.workerId)).toEqual(['spark']);
    publishSharedQuotaEvidence({ ...f, lease, state: 'running', evidence: { observations: f.observations, unavailableWorkerIds: ['general'] } });
    expect(readSharedQuotaEvidence(f).unavailableWorkerIds).toEqual(['general', 'spark']);
  });

  it('keeps scoped denials through asynchronous console IPC and final projection', async () => {
    const f = fixture(); const observationsFile = join(root, 'observations.json');
    writeFileSync(observationsFile, JSON.stringify(f.observations), { mode: 0o600 });
    const scope = { root, pool: f.pool, bindings: f.bindings, observationsFile, managedWorkerIds: ['general', 'spark'] };
    const managed = { observations: f.observations, unavailableWorkerIds: [], quotaUnavailableWorkerIds: ['general'] };
    const quota = unavailableManagedResourceWorkers(scope, managed, Date.now(), true);
    const projected = projectResourceConsoleEvidence(f.pool, f.bindings, resourcePoolStatus(root, f.pool, f.bindings, f.observations));
    expect(withholdResourceConsoleWorkers(projected, [], quota).plan?.candidates.map((row) => row.workerId)).toEqual(['spark']);
    const reader = createResourceConsoleReader(scope);
    try { expect((await reader.snapshot(managed)).plan?.candidates.map((row) => row.workerId)).toEqual(['spark']); }
    finally { await reader.close(); }
  }, 30_000);

  it('dispatches Spark through the supervisor while the collector vetoes only General', async () => {
    const f = fixture(); const workspace = join(root, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
    const supervisor = await createResourcePoolSupervisor({ ...f, workspace, readObservations: () => f.observations,
      readUnavailableWorkerIds: () => [], readQuotaUnavailableWorkerIds: () => ['general'], pollIntervalMs: 20 });
    try {
      supervisor.submit({ id: 'supervised', prompt: 'inert fixture', allowedWorkerIds: ['general', 'spark'],
        mode: 'read-only', timeoutMs: 10_000, maxOutputTokens: 100 });
      await vi.waitFor(() => expect(supervisor.snapshot().jobs[0]?.state).toBe('settled'), { timeout: 10_000 });
      expect(supervisor.snapshot().jobs[0]).toMatchObject({ workerId: 'spark', outcome: 'completed' });
    } finally { await supervisor.close(); }
  }, 15_000);
});
