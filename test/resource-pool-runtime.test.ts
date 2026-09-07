/** Independent real-filesystem/loopback acceptance; no account, model provider, or default store. */
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { mergeResourceObservations, readResourceJson, resourcePoolStatus, runResourceTask, type ResourceTask } from '../src/core/resources/pool-runtime.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import { validateResourceObservations, type ResourceObservation, type ResourcePool, type ResourceWorker } from '../src/core/resources/pool-policy.js';
import { mergeClaudeResourceObservation } from '../src/core/resources/provider-observations.js';

let fixtureRoot: string;
let cleanups: Array<() => Promise<void>>;
beforeEach(() => { fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-resource-runtime-'))); cleanups = []; });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function worker(id = 'local-a', patch: Partial<ResourceWorker> = {}): ResourceWorker {
  return { id, provider: 'local', model: `fixture-${id}`, maxConcurrent: 1, reservePercent: 10,
    maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, ...patch };
}
function observation(workerId: string, patch: Partial<ResourceObservation> = {}): ResourceObservation {
  const now = Date.now();
  return { workerId, observedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    health: 'ready', windows: [], retryAfter: null, ...patch };
}
function writeJson(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function completion(output = 'MODEL_TEXT_DO_NOT_PERSIST', usage: unknown = { prompt_tokens: 12, completion_tokens: 4 }) {
  return { choices: [{ message: { content: output } }], usage };
}

async function fixture(options: { workers?: ResourceWorker[]; shared?: boolean;
  respond?: (res: ServerResponse, request: Record<string, unknown>) => void } = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const pendingRuns: Array<Promise<unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push(request);
      if (options.respond) options.respond(res, request); else res.end(JSON.stringify(completion()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(pendingRuns);
  });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture endpoint unavailable');
  const cwd = join(fixtureRoot, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  const root = join(fixtureRoot, 'ledger');
  const pool: ResourcePool = { schemaVersion: 1, id: 'fixture-pool', workers: options.workers ?? [worker()] };
  const bindings: ResourceBinding[] = pool.workers.map((item) => ({ workerId: item.id,
    capacityKey: options.shared ? 'shared-account' : item.id, kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }));
  const observations = pool.workers.map((item) => observation(item.id));
  const task = (id = 'task-a', patch: Partial<ResourceTask> = {}): ResourceTask => ({ schemaVersion: 1, id,
    allowedWorkerIds: pool.workers.map((item) => item.id), prompt: `TASK_REQUEST_KEEP_PRIVATE ${id}`,
    cwd, timeoutMs: 5_000, maxOutputTokens: 100, mode: 'read-only', ...patch });
  const run = (id = 'task-a', patch: Partial<ResourceTask> = {}, incoming = observations, signal?: AbortSignal) => {
    const pending = runResourceTask({ root, pool, bindings, observations: incoming, task: task(id, patch), signal });
    // Held-request assertions may fail before awaiting the run. Keep teardown
    // attached immediately while preserving the original rejection for callers.
    pendingRuns.push(pending); void pending.catch(() => {});
    return pending;
  };
  const status = (incoming: ResourceObservation[] = []) => resourcePoolStatus(root, pool, bindings, incoming);
  const ledger = () => readFileSync(join(root, 'pool-state.json'), 'utf8');
  return { root, cwd, pool, bindings, observations, requests, task, run, status, ledger };
}

async function quotaFixture(provider: 'codex' | 'claude' = 'codex', allowUnknownQuota = true) {
  const f = await fixture(); const id = `${provider}-a`;
  const definition: ResourcePool = { schemaVersion: 1, id: 'quota-pool', workers: [worker(id, { provider, allowUnknownQuota })] };
  // This inert executable is never contacted: quota cases persist a denied
  // admission and use read-only status to inspect potential recovery.
  const bindings: ResourceBinding[] = [{ workerId: id, capacityKey: 'quota-account', kind: 'native-cli', command: [process.execPath] }];
  const now = Date.now(); const at = (delta: number) => new Date(now + delta).toISOString();
  const captured: ResourceObservation = { workerId: id, observedAt: at(-5_000), updatedAt: at(-5_000), expiresAt: at(60_000),
    health: 'ready', retryAfter: null, windows: [{ id: 'seven_day', usedPercent: 100, resetsAt: at(3_600_000) }] };
  const persist = (incoming: ResourceObservation) => runResourceTask({ root: f.root, pool: definition, bindings,
    observations: [incoming], task: f.task('denied-task', { allowedWorkerIds: [id] }) });
  const inspect = (incoming: ResourceObservation[]) => resourcePoolStatus(f.root, definition, bindings, incoming);
  return { ...f, id, now, at, captured, persist, inspect };
}

describe.skipIf(process.platform === 'win32')('durable resource task runtime acceptance', () => {
  it('reads missing explicit stores without creating directories, locks, or contacting workers', async () => {
    const f = await fixture();
    expect(f.status(f.observations)).toMatchObject({ sourceState: 'missing', attempts: [], plan: { selectedWorkerId: 'local-a' } });
    expect(existsSync(f.root)).toBe(false); expect(f.requests).toHaveLength(0);
    expect(readdirSync(fixtureRoot)).toEqual(['workspace']);
  });

  it('persists a private exact receipt before returning text but never stores prompt or output content', async () => {
    const f = await fixture(); const request = f.task(); const result = await f.run();
    expect(result).toMatchObject({ replayed: false, output: 'MODEL_TEXT_DO_NOT_PERSIST', receipt: {
      status: 'completed', id: request.id, workerId: 'local-a', capacityKey: 'local-a', verifiedAccepted: false,
      inputTokens: 12, outputTokens: 4, taskDigest: digest(canonical(request)), outputDigest: digest('MODEL_TEXT_DO_NOT_PERSIST'),
    } });
    expect(result.receipt?.poolDigest).toBe(digest(canonical({ pool: f.pool, bindings: f.bindings })));
    expect(f.status().attempts).toEqual([result.receipt]); expect(f.requests).toHaveLength(1);
    expect(f.ledger()).not.toContain('TASK_REQUEST_KEEP_PRIVATE'); expect(f.ledger()).not.toContain('MODEL_TEXT_DO_NOT_PERSIST');
    expect(statSync(f.root).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.root, 'pool-state.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(f.cwd)).toEqual([]);
  });

  it('replays an exact terminal task without another request or fabricated recoverable output', async () => {
    const f = await fixture(); const first = await f.run(); const before = f.ledger();
    const second = await f.run('task-a', {}, []);
    expect(second).toEqual({ receipt: first.receipt, plan: null, replayed: true, output: null });
    expect(f.requests).toHaveLength(1); expect(f.status().attempts).toHaveLength(1); expect(f.ledger()).toBe(before);
  });

  it('rejects task identity reuse with a changed prompt without modifying prior evidence', async () => {
    const f = await fixture(); await f.run(); const before = f.ledger();
    await expect(f.run('task-a', { prompt: 'different task' })).rejects.toThrow('identity conflict');
    expect(f.requests).toHaveLength(1); expect(f.ledger()).toBe(before);
  });

  it('rejects changed pool or binding identity before additional worker contact', async () => {
    const f = await fixture(); await f.run(); const before = f.ledger();
    const changed = { ...f.pool, workers: f.pool.workers.map((item) => ({ ...item, model: 'changed-model' })) };
    await expect(runResourceTask({ root: f.root, pool: changed, bindings: f.bindings,
      observations: f.observations, task: f.task('task-b') })).rejects.toThrow('configuration changed');
    const bindings = f.bindings.map((binding) => ({ ...binding, capacityKey: 'different-capacity' }));
    expect(() => resourcePoolStatus(f.root, f.pool, bindings, [])).toThrow('configuration changed');
    expect(f.requests).toHaveLength(1); expect(f.ledger()).toBe(before);
  });

  it('cancels before admission without creating the selected store or reserving capacity', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.run('task-a', {}, f.observations, controller.signal)).rejects.toThrow('cancelled before reservation');
    expect(existsSync(f.root)).toBe(false); expect(f.requests).toHaveLength(0);
  });

  it('rejects an invalid workspace before creating the selected store', async () => {
    const f = await fixture();
    await expect(f.run('task-a', { cwd: join(fixtureRoot, 'absent') })).rejects.toThrow();
    expect(existsSync(f.root)).toBe(false); expect(f.requests).toHaveLength(0);
  });

  it('rejects a writable workspace containing its accounting root before creating files or contacting a worker', async () => {
    const f = await fixture();
    for (const root of [f.cwd, join(f.cwd, 'ledger')]) {
      await expect(runResourceTask({ root, pool: f.pool, bindings: f.bindings, observations: f.observations,
        task: f.task('task-a', { mode: 'workspace-write' }) })).rejects.toThrow('must not contain its accounting store');
    }
    expect(readdirSync(f.cwd)).toEqual([]); expect(f.requests).toHaveLength(0);
  });

  it('persists admission before contact and refuses a concurrent duplicate without replay', async () => {
    const held: ServerResponse[] = []; const f = await fixture({ respond: (res) => held.push(res) });
    const pending = f.run(); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.status().attempts).toMatchObject([{ id: 'task-a', status: 'reserved', finishedAt: null }]);
    const duplicate = await f.run('task-a', {}, []);
    expect(duplicate).toMatchObject({ replayed: true, output: null, receipt: { status: 'reserved' } });
    expect(f.requests).toHaveLength(1);
    held[0]!.end(JSON.stringify(completion()));
    expect((await pending).receipt?.status).toBe('completed'); expect(f.status().attempts).toHaveLength(1);
  });

  it('conserves one shared-capacity active slot across model aliases and new task IDs', async () => {
    const held: ServerResponse[] = [];
    const f = await fixture({ workers: [worker('local-a'), worker('local-b')], shared: true, respond: (res) => held.push(res) });
    const pending = f.run('task-a', { allowedWorkerIds: ['local-a'] });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const blocked = await f.run('task-b', { allowedWorkerIds: ['local-b'] });
    expect(blocked.receipt).toBeNull(); expect(blocked.plan?.exclusions.find((row) => row.workerId === 'local-b')?.reasons).toContain('concurrency-exhausted');
    expect(f.requests).toHaveLength(1);
    held[0]!.end(JSON.stringify(completion())); await pending;
    const next = f.run('task-b', { allowedWorkerIds: ['local-b'] });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2)); held[1]!.end(JSON.stringify(completion()));
    expect((await next).receipt?.workerId).toBe('local-b');
  });

  it('limits a shared two-slot capacity exactly while allowing two active tasks', async () => {
    const held: ServerResponse[] = [];
    const f = await fixture({ workers: [worker('local-a', { maxConcurrent: 2 }), worker('local-b', { maxConcurrent: 2 })],
      shared: true, respond: (res) => held.push(res) });
    const a = f.run('task-a', { allowedWorkerIds: ['local-a'] });
    const b = f.run('task-b', { allowedWorkerIds: ['local-b'] });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.status().attempts.filter((row) => row.status === 'reserved')).toHaveLength(2);
    const blocked = await f.run('task-c'); expect(blocked.receipt).toBeNull(); expect(f.requests).toHaveLength(2);
    held.forEach((res) => res.end(JSON.stringify(completion())));
    expect((await Promise.all([a, b])).every((result) => result.receipt?.status === 'completed')).toBe(true);
  });

  it('overlaps distinct independent one-slot workers without treating them as one global capacity', async () => {
    const held: ServerResponse[] = [];
    const f = await fixture({ workers: [worker('local-a'), worker('local-b')], respond: (res) => held.push(res) });
    const a = f.run('task-a', { allowedWorkerIds: ['local-a'] }); const b = f.run('task-b', { allowedWorkerIds: ['local-b'] });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(new Set(f.status().attempts.map((row) => row.capacityKey))).toEqual(new Set(['local-a', 'local-b']));
    held.forEach((res) => res.end(JSON.stringify(completion())));
    expect((await Promise.all([a, b])).every((result) => result.receipt?.status === 'completed')).toBe(true);
  });

  it('charges rolling task caps across aliases even after successful completion', async () => {
    const f = await fixture({ workers: [worker('local-a', { maxTasksPerWindow: 1 }), worker('local-b', { maxTasksPerWindow: 1 })], shared: true });
    await f.run('task-a', { allowedWorkerIds: ['local-a'] });
    const result = await f.run('task-b', { allowedWorkerIds: ['local-b'] });
    expect(result.receipt).toBeNull(); expect(result.plan?.exclusions.find((row) => row.workerId === 'local-b')?.reasons).toContain('operator-task-cap-reached');
    expect(result.plan?.nextEligibleAt).not.toBeNull(); expect(f.requests).toHaveLength(1);
  });

  it('persists known no-capacity denial and cannot erase it with an omitted observation file', async () => {
    const f = await fixture();
    const denied = [observation('local-a', { health: 'unavailable' })];
    expect((await f.run('task-a', {}, denied)).receipt).toBeNull();
    const before = f.ledger(); expect((await f.run('task-a', {}, [])).receipt).toBeNull();
    expect(f.status().attempts).toHaveLength(0); expect(f.requests).toHaveLength(0); expect(f.ledger()).toBe(before);
  });

  it('keeps quota exhaustion from one account alias binding all aliases despite unknown opt-in', async () => {
    const f = await fixture();
    const poolValue: ResourcePool = { schemaVersion: 1, id: 'vendor-pool', workers: [
      worker('codex-a', { provider: 'codex', allowUnknownQuota: true }), worker('codex-b', { provider: 'codex', allowUnknownQuota: true }),
    ] };
    const bindings: ResourceBinding[] = poolValue.workers.map((item) => ({ workerId: item.id, capacityKey: 'one-account', kind: 'native-cli', command: [process.execPath] }));
    const denied = [observation('codex-a', { windows: [{ id: 'weekly', usedPercent: 100, resetsAt: new Date(Date.now() - 1_000).toISOString() }] })];
    const result = await runResourceTask({ root: f.root, pool: poolValue, bindings, observations: denied,
      task: f.task('task-a', { allowedWorkerIds: ['codex-b'] }) });
    expect(result.receipt).toBeNull(); expect(result.plan?.selectedWorkerId).toBeNull();
    expect(resourcePoolStatus(f.root, poolValue, bindings, []).plan.selectedWorkerId).toBeNull();
    expect(f.requests).toHaveLength(0);
  });

  it('requires newer capture evidence to recover and never clears denial from same-capture conflicts', async () => {
    const f = await fixture(); const denied = observation('local-a', { health: 'unavailable' });
    await f.run('task-a', {}, [denied]);
    expect((await f.run('task-a', {}, [{ ...denied, health: 'ready' }])).receipt).toBeNull();
    expect(JSON.parse(f.ledger()).observations[0].health).toBe('unavailable'); expect(f.requests).toHaveLength(0);
    const old = { ...denied, health: 'ready' as const, observedAt: new Date(Date.parse(denied.observedAt) - 1_000).toISOString() };
    expect((await f.run('task-a', {}, [old])).receipt).toBeNull();
    const newer = observation('local-a', { observedAt: new Date(Date.parse(denied.observedAt) + 1).toISOString() });
    expect((await f.run('task-a', {}, [newer])).receipt?.status).toBe('completed'); expect(f.requests).toHaveLength(1);
  });

  it('does not persist new observation input during status inspection', async () => {
    const f = await fixture(); await f.run(); const before = f.ledger(); const file = join(f.root, 'pool-state.json');
    const identity = statSync(file); const newer = observation('local-a', { health: 'unavailable', observedAt: new Date().toISOString() });
    expect(f.status([newer]).plan.selectedWorkerId).toBeNull();
    expect(f.ledger()).toBe(before); expect(statSync(file).ino).toBe(identity.ino); expect(statSync(file).mtimeMs).toBe(identity.mtimeMs);
    expect(f.status().plan.selectedWorkerId).toBe('local-a');
  });

  it('does not clear exhaustion from newer partial capture carrying an older low utilization', async () => {
    const f = await quotaFixture(); expect((await f.persist(f.captured)).receipt).toBeNull(); const before = f.ledger();
    const partial: ResourceObservation = { ...f.captured, updatedAt: f.at(-1_000), windows: [
      { id: 'seven_day', usedPercent: 25, resetsAt: f.at(3_600_000) },
      { id: 'five_hour', usedPercent: 0, resetsAt: f.at(600_000) },
    ] };
    expect(f.inspect([partial]).plan.selectedWorkerId).toBeNull();
    expect(f.ledger()).toBe(before); expect(f.requests).toHaveLength(0);
  });

  it('does not treat zero with a missing or elapsed reset as recovery from known exhaustion', async () => {
    const f = await quotaFixture(); await f.persist(f.captured); const before = f.ledger();
    for (const resetsAt of [null, f.at(-100)]) {
      const incomplete: ResourceObservation = { ...f.captured, observedAt: f.at(-1_000), updatedAt: f.at(-1_000),
        windows: [{ id: 'seven_day', usedPercent: 0, resetsAt }] };
      expect(f.inspect([incomplete]).plan.selectedWorkerId).toBeNull();
    }
    expect(f.ledger()).toBe(before); expect(f.requests).toHaveLength(0);
  });

  it('does not clear exhaustion from a newer full but already expired snapshot under unknown-quota opt-in', async () => {
    const f = await quotaFixture(); await f.persist(f.captured); const before = f.ledger();
    const expired: ResourceObservation = { ...f.captured, observedAt: f.at(-4_000), updatedAt: f.at(-4_000),
      expiresAt: f.at(-100), windows: [{ id: 'seven_day', usedPercent: 0, resetsAt: f.at(3_600_000) }] };
    expect(f.inspect([expired]).plan.selectedWorkerId).toBeNull();
    expect(f.inspect([expired]).plan.exclusions[0]?.reasons).toContain('worker-unavailable');
    expect(f.ledger()).toBe(before); expect(f.requests).toHaveLength(0);
  });

  it.each(['partial', 'expired'] as const)('does not clear unavailable health from a newer %s ready snapshot', async (kind) => {
    const f = await quotaFixture();
    const unavailable: ResourceObservation = { ...f.captured, health: 'unavailable',
      windows: [{ id: 'seven_day', usedPercent: 0, resetsAt: f.at(3_600_000) }] };
    await f.persist(unavailable); const before = f.ledger();
    const ready: ResourceObservation = { ...unavailable, health: 'ready', updatedAt: f.at(-1_000),
      ...(kind === 'expired' ? { observedAt: f.at(-1_000), expiresAt: f.at(-100) } : {}) };
    const inspected = f.inspect([ready]);
    expect(inspected.plan.selectedWorkerId).toBeNull();
    expect(inspected.plan.exclusions[0]?.reasons).toContain('worker-unavailable');
    expect(f.ledger()).toBe(before); expect(f.requests).toHaveLength(0);
  });

  it('allows a same-capture known rejection to raise an unknown window without clearing other evidence', async () => {
    const f = await quotaFixture('codex', false);
    const unknown: ResourceObservation = { ...f.captured, windows: [{ id: 'seven_day', usedPercent: null, resetsAt: null }] };
    expect((await f.persist(unknown)).receipt).toBeNull();
    expect((await f.persist(f.captured)).receipt).toBeNull();
    expect(JSON.parse(f.ledger()).observations[0].windows).toEqual(f.captured.windows);
    expect(f.inspect([]).plan.exclusions[0]?.reasons).toContain('worker-unavailable'); expect(f.requests).toHaveLength(0);
  });

  it('retains omitted exhausted windows when a different named window receives a fully fresh update', async () => {
    const f = await quotaFixture();
    const original = { ...f.captured, windows: [...f.captured.windows, { id: 'five_hour', usedPercent: 30, resetsAt: f.at(600_000) }] };
    await f.persist(original); const before = f.ledger();
    const refresh: ResourceObservation = { ...f.captured, observedAt: f.at(-1_000), updatedAt: f.at(-1_000),
      windows: [{ id: 'five_hour', usedPercent: 0, resetsAt: f.at(600_000) }] };
    expect(f.inspect([refresh]).plan.selectedWorkerId).toBeNull(); expect(f.ledger()).toBe(before); expect(f.requests).toHaveLength(0);
  });

  it('bounds a ninth quota bucket with a sticky denial without losing older evidence age or retry', async () => {
    const f = await quotaFixture();
    const original: ResourceObservation = { ...f.captured, retryAfter: f.at(120_000),
      windows: Array.from({ length: 8 }, (_, index) => ({ id: `bucket_${index}`,
        usedPercent: index === 7 ? null : 100 - index * 10, resetsAt: f.at(3_600_000) })) };
    const refresh: ResourceObservation = { ...f.captured, observedAt: f.at(-1_000), updatedAt: f.at(-1_000),
      expiresAt: f.at(90_000), retryAfter: f.at(60_000),
      windows: [{ id: 'new_bucket', usedPercent: 5, resetsAt: f.at(600_000) }] };
    const originalBytes = canonical(original); const refreshBytes = canonical(refresh);
    const validatedPool: ResourcePool = { schemaVersion: 1, id: 'overflow-pool',
      workers: [worker(f.id, { provider: 'codex', allowUnknownQuota: true })] };
    const previous = validateResourceObservations([original], validatedPool);
    const incoming = validateResourceObservations([refresh], validatedPool);
    const merged = mergeResourceObservations(previous, incoming);
    expect(validateResourceObservations(merged, validatedPool)).toEqual(merged);
    expect(merged[0]).toMatchObject({ health: 'unavailable', observedAt: original.observedAt,
      expiresAt: original.expiresAt, updatedAt: refresh.updatedAt, retryAfter: original.retryAfter });
    expect(merged[0]?.windows).toEqual([
      ...original.windows.slice(0, 7), { id: 'hub_observation_overflow', usedPercent: 100, resetsAt: null },
    ]);
    expect(canonical(original)).toBe(originalBytes); expect(canonical(refresh)).toBe(refreshBytes);

    expect((await f.persist(original)).receipt).toBeNull(); const before = f.ledger();
    expect(f.inspect([refresh]).plan.selectedWorkerId).toBeNull(); expect(f.ledger()).toBe(before);
    expect((await f.persist(refresh)).receipt).toBeNull();
    expect(JSON.parse(f.ledger()).observations).toEqual(merged);
    expect(f.inspect([])).toMatchObject({ sourceState: 'healthy', attempts: [], plan: { selectedWorkerId: null } });

    // An ordinary fresh refresh cannot establish recovery of the discarded bucket.
    const recovery: ResourceObservation = { ...refresh, observedAt: f.at(0), updatedAt: f.at(0), retryAfter: null,
      windows: original.windows.map((window) => ({ ...window, usedPercent: 0 })) };
    expect((await f.persist(recovery)).receipt).toBeNull();
    const blocked = f.inspect([]);
    expect(blocked.sourceState).toBe('healthy'); expect(blocked.plan.selectedWorkerId).toBeNull();
    expect(blocked.plan.exclusions[0]?.reasons).toContain('worker-unavailable');
    expect(blocked.observations[0]?.windows).toHaveLength(8);
    expect(blocked.observations[0]?.windows).toContainEqual({ id: 'hub_observation_overflow', usedPercent: 100, resetsAt: null });
    expect(f.requests).toHaveLength(0);
  });

  it('allows genuinely fresh named zero utilization with a future reset to recover without dispatching during inspection', async () => {
    const f = await quotaFixture(); await f.persist(f.captured); const before = f.ledger();
    const refreshed: ResourceObservation = { ...f.captured, observedAt: f.at(-1_000), updatedAt: f.at(-1_000),
      windows: [{ id: 'seven_day', usedPercent: 0, resetsAt: f.at(3_600_000) }] };
    expect(f.inspect([refreshed]).plan.selectedWorkerId).toBe('codex-a');
    expect(f.inspect([]).plan.selectedWorkerId).toBeNull(); // Inspection did not publish that refresh.
    expect(f.ledger()).toBe(before); expect(f.requests).toHaveLength(0);
  });

  it('accepts a later Claude partial update with retained oldest capture and persists its newly observed rejection', async () => {
    const f = await quotaFixture('claude');
    const event = (rateLimitType: string) => ({ type: 'rate_limit_event', rate_limit_info: {
      rateLimitType, status: 'rejected', resetsAt: Math.floor(f.now / 1000) + 3600,
    } });
    const previous = mergeClaudeResourceObservation(f.id, event('seven_day'), null, { nowMs: f.now - 5_000, ttlMs: 60_000 })!;
    expect((await f.persist(previous)).receipt).toBeNull();
    const updated = mergeClaudeResourceObservation(f.id, event('five_hour'), previous, { nowMs: f.now - 1_000, ttlMs: 60_000 })!;
    expect(updated.observedAt).toBe(previous.observedAt); expect(updated.updatedAt).not.toBe(previous.updatedAt);
    expect((await f.persist(updated)).receipt).toBeNull();
    expect(JSON.parse(f.ledger()).observations[0].windows).toMatchObject([
      { id: 'seven_day', usedPercent: 100 }, { id: 'five_hour', usedPercent: 100 },
    ]);
    expect(f.inspect([]).plan.selectedWorkerId).toBeNull(); expect(f.requests).toHaveLength(0);
  });

  it('retains null usage as unknown and never estimates it during later replay', async () => {
    const f = await fixture({ respond: (res) => res.end(JSON.stringify(completion('unknown usage', {}))) });
    expect((await f.run()).receipt).toMatchObject({ status: 'completed', inputTokens: null, outputTokens: null });
    expect((await f.run()).receipt).toMatchObject({ inputTokens: null, outputTokens: null }); expect(f.requests).toHaveLength(1);
  });

  it('persists a replayable unknown pair when separately valid reported counts would overflow together', async () => {
    const f = await fixture({ respond: (res) => res.end(JSON.stringify(completion('overflow', {
      prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1,
    }))) });
    expect((await f.run()).receipt).toMatchObject({ status: 'completed', inputTokens: null, outputTokens: null });
    expect(f.status().attempts).toMatchObject([{ status: 'completed', inputTokens: null, outputTokens: null }]);
    expect((await f.run()).replayed).toBe(true); expect(f.requests).toHaveLength(1);
  });

  it('persists native Claude quota metadata and blocks the next task without retaining raw events', async () => {
    const f = await fixture(); const script = join(fixtureRoot, 'quota-worker.cjs');
    const rows = [{ type: 'rate_limit_event', session_id: 'PRIVATE_SESSION_MARKER', rate_limit_info: {
      status: 'rejected', rateLimitType: 'seven_day', resetsAt: Math.floor(Date.now() / 1000) + 3600,
    } }, { type: 'result', subtype: 'success', is_error: false, result: 'PRIVATE_NATIVE_OUTPUT',
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } }];
    writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')}));`, { mode: 0o600 });
    const poolValue: ResourcePool = { schemaVersion: 1, id: 'claude-pool', workers: [worker('claude-a', { provider: 'claude', allowUnknownQuota: true })] };
    const bindings: ResourceBinding[] = [{ workerId: 'claude-a', capacityKey: 'claude-account', kind: 'native-cli', command: [process.execPath, script] }];
    const taskValue = f.task('task-a', { allowedWorkerIds: ['claude-a'] });
    const first = await runResourceTask({ root: f.root, pool: poolValue, bindings, observations: [], task: taskValue });
    expect(first.receipt?.status).toBe('completed');
    const second = await runResourceTask({ root: f.root, pool: poolValue, bindings, observations: [],
      task: { ...taskValue, id: 'task-b' } });
    expect(second.receipt).toBeNull();
    const status = resourcePoolStatus(f.root, poolValue, bindings, []);
    expect(status.attempts).toHaveLength(1); expect(status.plan.selectedWorkerId).toBeNull();
    expect(f.ledger()).not.toContain('PRIVATE_SESSION_MARKER'); expect(f.ledger()).not.toContain('PRIVATE_NATIVE_OUTPUT');
    expect(JSON.parse(f.ledger()).observations[0].windows).toMatchObject([{ id: 'seven_day', usedPercent: 100 }]);
  });

  it('settles a native ninth-bucket observation into a bounded readable ledger and refuses further admission', async () => {
    const f = await fixture(); const script = join(fixtureRoot, 'overflow-quota-worker.cjs');
    const now = Date.now(); const at = (delta: number) => new Date(now + delta).toISOString();
    const original: ResourceObservation = { workerId: 'claude-a', observedAt: at(-5_000), updatedAt: at(-5_000),
      expiresAt: at(60_000), health: 'ready', retryAfter: at(-1_000),
      windows: Array.from({ length: 8 }, (_, index) => ({ id: `bucket_${index}`,
        usedPercent: (index + 1) * 10, resetsAt: at(3_600_000) })) };
    const rows = [{ type: 'rate_limit_event', session_id: 'PRIVATE_OVERFLOW_EVENT', rate_limit_info: {
      status: 'rejected', rateLimitType: 'seven_day', resetsAt: Math.floor(now / 1000) + 3600,
    } }, { type: 'result', subtype: 'success', is_error: false, result: 'PRIVATE_OVERFLOW_OUTPUT',
      usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } }];
    writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')}));`, { mode: 0o600 });
    const poolValue: ResourcePool = { schemaVersion: 1, id: 'claude-overflow-pool',
      workers: [worker('claude-a', { provider: 'claude', allowUnknownQuota: true })] };
    const bindings: ResourceBinding[] = [{ workerId: 'claude-a', capacityKey: 'claude-account',
      kind: 'native-cli', command: [process.execPath, script] }];
    const taskValue = f.task('task-a', { allowedWorkerIds: ['claude-a'] });
    expect(validateResourceObservations([original], poolValue)[0]?.windows).toHaveLength(8);
    const first = await runResourceTask({ root: f.root, pool: poolValue, bindings, observations: [original], task: taskValue });
    expect(first.receipt).toMatchObject({ status: 'completed', inputTokens: 2, outputTokens: 3, verifiedAccepted: false });
    const status = resourcePoolStatus(f.root, poolValue, bindings, []);
    expect(status).toMatchObject({ sourceState: 'healthy', attempts: [first.receipt], plan: { selectedWorkerId: null } });
    const settled = status.observations[0]!;
    expect(settled).toMatchObject({ health: 'unavailable', observedAt: original.observedAt,
      expiresAt: original.expiresAt, retryAfter: original.retryAfter });
    expect(Date.parse(settled.updatedAt!)).toBeGreaterThan(Date.parse(original.updatedAt!));
    expect(settled.windows.map((window) => window.id)).toEqual([
      'seven_day', 'bucket_7', 'bucket_6', 'bucket_5', 'bucket_4', 'bucket_3', 'bucket_2', 'hub_observation_overflow',
    ]);
    expect(validateResourceObservations(status.observations, poolValue)).toEqual(status.observations);
    expect(f.ledger()).not.toContain('PRIVATE_OVERFLOW_EVENT'); expect(f.ledger()).not.toContain('PRIVATE_OVERFLOW_OUTPUT');

    const second = await runResourceTask({ root: f.root, pool: poolValue, bindings, observations: [],
      task: { ...taskValue, id: 'task-b' } });
    expect(second.receipt).toBeNull();
    const replay = await runResourceTask({ root: f.root, pool: poolValue, bindings, observations: [], task: taskValue });
    expect(replay).toMatchObject({ receipt: first.receipt, replayed: true, output: null });
    expect(resourcePoolStatus(f.root, poolValue, bindings, []).attempts).toEqual([first.receipt]);
    expect(f.requests).toHaveLength(0); // The only execution was the explicitly authored inert native fixture.
  });

  it('retains failed request evidence and a durable cooldown without retrying a different worker alias', async () => {
    const f = await fixture({ workers: [worker('local-a'), worker('local-b')], shared: true,
      respond: (res) => { res.statusCode = 429; res.end('PRIVATE_VENDOR_ERROR'); } });
    const result = await f.run('task-a', { allowedWorkerIds: ['local-a'] });
    expect(result.receipt).toMatchObject({ status: 'failed', inputTokens: null, outputTokens: null, verifiedAccepted: false });
    expect(result.output).toBeNull(); expect(f.ledger()).not.toContain('PRIVATE_VENDOR_ERROR');
    const blocked = await f.run('task-b', { allowedWorkerIds: ['local-b'] }, []);
    expect(blocked.receipt).toBeNull(); expect(f.requests).toHaveLength(1);
    expect(blocked.plan?.exclusions.find((row) => row.workerId === 'local-b')?.reasons).toContain('provider-retry-after');
  });

  it('settles cancellation after an actual local request and never replays the consumed task', async () => {
    const f = await fixture({ respond: () => {} }); const controller = new AbortController();
    const pending = f.run('task-a', {}, f.observations, controller.signal);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1)); controller.abort();
    const result = await pending;
    expect(result.receipt).toMatchObject({ status: 'cancelled', inputTokens: null, outputTokens: null });
    expect(f.status().attempts).toEqual([result.receipt]); expect((await f.run()).replayed).toBe(true);
    expect(f.requests).toHaveLength(1);
  });

  it('settles timeout with unknown spend and retains the pessimistic consumed reservation', async () => {
    const f = await fixture({ respond: () => {} });
    const result = await f.run('task-a', { timeoutMs: 40 });
    expect(result.receipt).toMatchObject({ status: 'timed-out', inputTokens: null, outputTokens: null });
    expect(f.status().attempts).toHaveLength(1); expect(f.requests).toHaveLength(1);
    expect((await f.run('task-a', { timeoutMs: 40 })).replayed).toBe(true); expect(f.requests).toHaveLength(1);
  });

  it('leaves corrupted or substituted ledger evidence intact and refuses all new work', async () => {
    const f = await fixture(); await f.run(); const path = join(f.root, 'pool-state.json');
    writeFileSync(path, '{incomplete', { mode: 0o600 });
    expect(() => f.status()).toThrow('malformed');
    await expect(f.run('task-b')).rejects.toThrow('malformed');
    expect(readFileSync(path, 'utf8')).toBe('{incomplete'); expect(f.requests).toHaveLength(1);
  });

  it('rejects forged accepted status and inconsistent token-pair receipts during replay', async () => {
    const f = await fixture(); await f.run(); const original = JSON.parse(f.ledger()); const path = join(f.root, 'pool-state.json');
    for (const patch of [{ verifiedAccepted: true }, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
      { inputTokens: null, outputTokens: 4 }, { finishedAt: null }, { outputDigest: null }]) {
      const changed = structuredClone(original); Object.assign(changed.attempts[0], patch); writeJson(path, changed);
      expect(() => f.status()).toThrow('ledger invalid');
      await expect(f.run('task-b')).rejects.toThrow('ledger invalid');
    }
    expect(f.requests).toHaveLength(1);
  });

  it('refuses unsafe or malformed JSON inputs without repairing permissions or following aliases', async () => {
    const path = join(fixtureRoot, 'input.json'); writeJson(path, { schemaVersion: 1 });
    expect(readResourceJson(path)).toEqual({ schemaVersion: 1 });
    chmodSync(path, 0o644); expect(() => readResourceJson(path)).toThrow('unsafe'); expect(statSync(path).mode & 0o777).toBe(0o644);
    chmodSync(path, 0o600); const alias = join(fixtureRoot, 'alias.json'); symlinkSync(path, alias);
    expect(() => readResourceJson(alias)).toThrow('unsafe');
    const linked = join(fixtureRoot, 'linked.json'); linkSync(path, linked); expect(() => readResourceJson(path)).toThrow('unsafe');
    const malformed = join(fixtureRoot, 'malformed.json'); writeFileSync(malformed, '{invalid', { mode: 0o600 });
    expect(() => readResourceJson(malformed)).toThrow('malformed');
    const oversized = join(fixtureRoot, 'large.json'); writeJson(oversized, { text: 'too long' });
    expect(() => readResourceJson(oversized, 2)).toThrow('oversized');
  });
});
