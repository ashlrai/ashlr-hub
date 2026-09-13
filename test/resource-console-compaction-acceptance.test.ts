/** Actual supervisor admissions and private durability; only loopback or explicitly mocked transport. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolSupervisor, readResourceSupervisorCustody, type ResourcePoolSupervisor,
  type ResourcePoolSupervisorOptions } from '../src/core/resources/pool-supervisor.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceQuotaScopeAccess,
  type ResourcePoolState } from '../src/core/resources/pool-runtime.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceConsoleHistoryDescriptor } from '../src/core/resources/console-history-view.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import * as workers from '../src/core/resources/worker.js';

const cleanups: Array<() => Promise<void>> = [];
function reportTiming(scenario: 'local' | 'quota', phase: string, started: number): void {
  console.info(JSON.stringify({ schemaVersion: 1, kind: 'console-compaction-test-timing', scenario, phase,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100 }));
}
function timed<T>(scenario: 'local' | 'quota', phase: string, operation: () => T): T {
  const started = performance.now();
  try { return operation(); } finally { reportTiming(scenario, phase, started); }
}
async function timedAsync<T>(scenario: 'local' | 'quota', phase: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await operation(); } finally { reportTiming(scenario, phase, started); }
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(quota = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'console-compaction-acceptance-')));
  const root = join(base, 'pool'); const workspace = join(base, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const responseText = 'PRIVATE_COMPACTION_RESPONSE';
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.end(JSON.stringify({ choices: [{ message: { content: responseText } }],
        usage: { prompt_tokens: 8, completion_tokens: 4 } }));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  const bounds = { maxConcurrent: 1, maxTasksPerWindow: quota ? 1 : 100, taskWindowMs: 600_000, priority: 1, reservePercent: 25 };
  const pool: ResourcePool = { schemaVersion: 1, id: 'compaction-acceptance', workers: quota ? [
    { ...bounds, id: 'general', provider: 'codex', model: 'gpt-6-astra', quotaScope: 'codex-general-v1' },
    { ...bounds, id: 'spark', provider: 'codex', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' },
  ] : [{ ...bounds, id: 'local', provider: 'local', model: 'fixture' }] };
  const bindings: ResourceBinding[] = pool.workers.map(worker => quota
    ? { workerId: worker.id, capacityKey: 'personal', kind: 'native-cli', command: ['/test-owned/inert-never-spawned'] }
    : { workerId: worker.id, capacityKey: 'local', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` });
  const now = Date.now();
  const observations: ResourceObservation[] = pool.workers.map(worker => ({ workerId: worker.id, health: 'ready', retryAfter: null,
    observedAt: new Date(now - 100).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    windows: quota ? [{ id: worker.quotaScope === 'codex-spark-v1' ? 'codex_codex_bengalfox_primary' : 'codex_codex_primary',
      usedPercent: 10, resetsAt: new Date(now + 3_600_000).toISOString() }] : [] }));
  const owners: ResourcePoolSupervisor[] = [];
  cleanups.push(async () => {
    try { for (const owner of owners) await owner.close(); }
    finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      rmSync(base, { recursive: true, force: true });
    }
  });
  const start = async (archiveHistory?: boolean) => {
    const options: ResourcePoolSupervisorOptions = { root, workspace, pool, bindings, readObservations: () => observations,
      pollIntervalMs: 20, ...(archiveHistory === undefined ? {} : { archiveHistory }) };
    const owner = await createResourcePoolSupervisor(options); owners.push(owner); return owner;
  };
  const task = (id: string, patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id,
    prompt: `PRIVATE_COMPACTION_REQUEST_${id}`, allowedWorkerIds: [quota ? 'spark' : 'local'], mode: 'read-only',
    timeoutMs: 5000, maxOutputTokens: 100, retainHistory: true, ...patch });
  const statePath = join(root, 'resource-console-state.json'); const ledgerPath = join(root, 'pool-state.json');
  const archiveRoot = join(root, 'resource-console-history');
  return { root, pool, bindings, observations, requests, responseText, start, task, statePath, ledgerPath, archiveRoot,
    descriptor: () => JSON.parse(readFileSync(statePath, 'utf8')) as ResourceConsoleHistoryDescriptor,
    ledger: () => JSON.parse(readFileSync(ledgerPath, 'utf8')) as ResourcePoolState,
    status: () => resourcePoolStatus(root, pool, bindings, observations) };
}
async function settled(owner: ResourcePoolSupervisor, id: string) {
  await vi.waitFor(() => expect(owner.snapshot().jobs.find(job => job.id === id)).toMatchObject({ state: 'settled', outcome: 'completed' }),
    { timeout: 5000, interval: 20 });
}
function fillCancelled(owner: ResourcePoolSupervisor,
  task: (id: string, patch?: Partial<ResourceConsoleTaskInput>) => ResourceConsoleTaskInput) {
  // All 255 filler identities are admitted/cancelled through the real owner API.
  // They are not fabricated settled receipts and consume no provider task quota.
  for (let index = 0; index < 255; index++) {
    const id = `filler-${index}`;
    expect(owner.submit(task(id, { retainHistory: false, prompt: `filler ${index}` })).state).toBe('queued');
    expect(owner.cancel(id).state).toBe('cancelled');
  }
}
function immutableText(root: string): string {
  return ['metadata', 'tasks', 'tombstones'].flatMap(namespace => {
    const path = join(root, namespace, 'records');
    return existsSync(path) ? readdirSync(path).map(file => readFileSync(join(path, file), 'utf8')) : [];
  }).join('\n');
}

describe.skipIf(process.platform === 'win32')('opt-in console compaction acceptance', () => {
  it('admits task257, restarts before dispatch, preserves archived replay and parent deletion, then refuses damaged archive evidence', async () => {
    const f = await timedAsync('local', 'fixture', () => fixture()); const first = await f.start(true);
    const parentTask = f.task('parent'); first.submit(parentTask);
    await timedAsync('local', 'parent-settlement', () => settled(first, parentTask.id));
    const parentHistory = first.history(parentTask.id)!;
    expect(parentHistory.transcriptDigest).toMatch(/^[a-f0-9]{64}$/);
    const parentReceipt = structuredClone(f.ledger().attempts[0]!);
    first.setPaused(true); timed('local', 'fixture-fill', () => fillCancelled(first, f.task));
    expect(first.snapshot().jobs).toHaveLength(256); expect(f.requests).toHaveLength(1);
    const child = f.task('child257', { parent: { taskId: parentTask.id, expectedTranscriptDigest: parentHistory.transcriptDigest! } });
    timed('local', 'compaction', () => expect(first.submit(child)).toMatchObject({ id: child.id, state: 'queued' }));
    expect(first.snapshot().jobs).toHaveLength(257);
    const persisted = f.descriptor();
    expect(persisted).toMatchObject({ schemaVersion: 1, kind: 'resource-console-history-descriptor' });
    expect(persisted.order).toHaveLength(257); expect(persisted.currentJobs.length).toBeLessThanOrEqual(256);
    expect(persisted.currentJobs.some(job => job.id === parentTask.id)).toBe(false);
    expect(persisted.order.filter(row => row.source === 'archive').length).toBeGreaterThan(0);
    expect(persisted.order.filter(row => row.source === 'archive').length).toBeLessThanOrEqual(8);
    expect(f.ledger().attempts).toEqual([parentReceipt]);
    expect(immutableText(f.archiveRoot)).not.toContain('PRIVATE_COMPACTION');
    await first.close();

    // Opening a committed descriptor requires no repeated opt-in; further
    // archive publication still does. No replay or startup dispatch is allowed.
    const next = await timedAsync('local', 'predispatch-restart', () => f.start()); expect(next.snapshot().paused).toBe(true);
    expect(next.snapshot().jobs).toHaveLength(257); expect(next.history(parentTask.id)).toEqual(parentHistory);
    expect(next.submit(parentTask)).toMatchObject({ id: parentTask.id, state: 'settled' });
    expect(() => next.submit({ ...parentTask, prompt: 'changed archived request' })).toThrow();
    expect(() => readResourceSupervisorCustody(next)).toThrow('Resource supervisor custody unavailable');
    expect(next.history(child.id)?.context).toEqual([{ taskId: parentTask.id, prompt: parentTask.prompt,
      output: parentHistory.output, outcome: 'completed' }]);
    next.deleteHistory(parentTask.id);
    expect(next.history(parentTask.id)).toBeNull(); expect(next.output(parentTask.id)).toBeNull();
    expect(next.history(child.id)?.context?.[0]?.prompt).toBe(parentTask.prompt);
    expect(() => next.submit(f.task('new-child-of-deleted', { parent: child.parent }))).toThrow();
    expect(next.submit(child)).toMatchObject({ id: child.id, state: 'queued' });
    expect(f.requests).toHaveLength(1); expect(f.ledger().attempts).toEqual([parentReceipt]);
    next.setPaused(false);
    expect(readResourceSupervisorCustody(next).ownsReceipt(parentReceipt)).toBe(true);
    await timedAsync('local', 'child-settlement', () => settled(next, child.id));
    expect(f.requests).toHaveLength(2); expect(f.requests[1]!.messages[0]!.content).toContain(parentTask.prompt);
    expect(f.ledger().attempts.map(receipt => receipt.id)).toEqual([parentTask.id, child.id]);
    const receipts = structuredClone(f.ledger().attempts);
    next.deleteHistory(child.id); next.submit(parentTask); next.submit(child); await next.close();
    const reopened = await timedAsync('local', 'deleted-history-restart', () => f.start());
    expect(reopened.snapshot().jobs).toHaveLength(257); expect(reopened.history(parentTask.id)).toBeNull();
    expect(reopened.history(child.id)).toBeNull(); expect(reopened.output(child.id)).toBeNull();
    reopened.submit(parentTask); reopened.submit(child);
    expect(f.ledger().attempts).toEqual(receipts); expect(f.requests).toHaveLength(2);
    expect(readFileSync(f.statePath, 'utf8')).not.toContain('PRIVATE_COMPACTION');
    expect(immutableText(f.archiveRoot)).not.toContain('PRIVATE_COMPACTION');
    const texts = join(f.archiveRoot, 'texts');
    if (existsSync(texts)) for (const file of readdirSync(texts)) expect(readFileSync(join(texts, file), 'utf8')).not.toContain('PRIVATE_COMPACTION');
    await reopened.close();

    // Damage only this fixture's required immutable archive record. Startup
    // must not turn unavailable identity into absence and redispatch it.
    const archived = f.descriptor().order.find(row => row.source === 'archive');
    if (!archived || archived.source !== 'archive') throw new Error('Fixture archive reference unavailable');
    unlinkSync(join(f.archiveRoot, 'metadata', 'records', `${archived.recordId}.json`));
    const beforeState = readFileSync(f.statePath); const beforeLedger = readFileSync(f.ledgerPath);
    await timedAsync('local', 'damaged-archive-restart', () => expect(f.start()).rejects.toThrow());
    expect(readFileSync(f.statePath)).toEqual(beforeState); expect(readFileSync(f.ledgerPath)).toEqual(beforeLedger);
    expect(f.requests).toHaveLength(2);
  }, 32_000);

  it('preserves 75 percent allocation, reserved Personal General and exhausted shared Spark quota through compaction and restart', async () => {
    // Native worker dispatch is mocked explicitly; the supervisor and quota
    // ledger are real. No provider command or account is contacted.
    const execute = vi.spyOn(workers, 'executeResourceWorker').mockResolvedValue({ status: 'completed', output: 'fixture',
      inputTokens: 1, outputTokens: 1, usageScope: 'codex-turn', reason: 'worker-completed' });
    const f = await timedAsync('quota', 'fixture', () => fixture(true));
    const allocation = setResourcePoolAllocation(f.root, f.pool, f.bindings, 75, 0);
    const access = setResourceQuotaScopeAccess(f.root, f.pool, f.bindings,
      [{ capacityKey: 'personal', quotaScope: 'codex-general-v1' }], 0);
    const first = await f.start(true); first.submit(f.task('used-spark'));
    await timedAsync('quota', 'initial-settlement', () => settled(first, 'used-spark'));
    const before = f.ledger(); const statusBefore = f.status();
    expect(execute).toHaveBeenCalledOnce(); expect(before.attempts[0]?.workerId).toBe('spark');
    const sparkBefore = statusBefore.plan.exclusions.find(row => row.workerId === 'spark');
    expect(sparkBefore?.reasons).toContain('operator-task-cap-reached');
    expect(statusBefore.plan.exclusions.find(row => row.workerId === 'general')?.reasons).toContain('operator-quota-scope-excluded');
    first.setPaused(true); timed('quota', 'fixture-fill', () => fillCancelled(first, f.task));
    timed('quota', 'compaction', () => first.submit(f.task('capacity-held257')));
    expect(f.descriptor().kind).toBe('resource-console-history-descriptor');
    first.setPaused(false);
    await vi.waitFor(() => expect(first.snapshot().jobs.find(job => job.id === 'capacity-held257')).toMatchObject({
      state: 'queued', reason: 'no-eligible-capacity' }), { timeout: 5000, interval: 20 });
    await first.close(); const next = await timedAsync('quota', 'capacity-held-restart', () => f.start());
    await vi.waitFor(() => expect(next.snapshot().jobs.find(job => job.id === 'capacity-held257')).toMatchObject({
      state: 'queued', reason: 'no-eligible-capacity' }), { timeout: 5000, interval: 20 });
    const after = f.status();
    expect(after.allocation).toEqual(allocation); expect(after.quotaScopeAccess).toEqual(access);
    expect(after.attempts).toEqual(before.attempts); expect(after.observations).toEqual(before.observations);
    expect(after.plan.exclusions.find(row => row.workerId === 'spark')).toEqual(sparkBefore);
    expect(after.plan.exclusions.find(row => row.workerId === 'general')?.reasons).toContain('operator-quota-scope-excluded');
    expect(f.ledger()).toEqual(before); expect(execute).toHaveBeenCalledOnce(); expect(f.requests).toEqual([]);
    next.cancel('capacity-held257'); await next.close();
  }, 32_000);
});
