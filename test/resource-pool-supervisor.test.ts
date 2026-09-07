/** Native foreground queue acceptance using private files and test-owned transports only. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolSupervisor, ResourceSupervisorError, type ResourcePoolSupervisor,
  type ResourcePoolSupervisorOptions } from '../src/core/resources/pool-supervisor.js';
import { runResourceTask } from '../src/core/resources/pool-runtime.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourceObservation, ResourcePool, ResourceWorker } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';

let base: string;
const supervisors: ResourcePoolSupervisor[] = [];
let cleanup: Array<() => Promise<void>>;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-supervisor-test-'))); cleanup = []; });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const supervisor of supervisors.splice(0)) await supervisor.close().catch(() => {});
  for (const close of cleanup.reverse()) await close();
  rmSync(base, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
function save(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function worker(id = 'local', provider: ResourceWorker['provider'] = 'local'): ResourceWorker {
  return { id, provider, model: `fixture-${id}`, maxConcurrent: 1, maxTasksPerWindow: 100,
    taskWindowMs: 1000, priority: 1, reservePercent: 10, ...(provider === 'local' ? {} : { allowUnknownQuota: true }) };
}
function observed(workerId: string, patch: Partial<ResourceObservation> = {}): ResourceObservation {
  const now = Date.now(); return { workerId, observedAt: new Date(now - 100).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(), health: 'ready', windows: [], retryAfter: null, ...patch };
}
const result = (text = 'PRIVATE_OUTPUT', usage: unknown = { prompt_tokens: 12, completion_tokens: 4 }) =>
  JSON.stringify({ choices: [{ message: { content: text } }], usage });

async function fixture(config: { workers?: ResourceWorker[]; hold?: boolean; output?: string; shared?: boolean } = {}) {
  const requests: unknown[] = []; const held: ServerResponse[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (config.hold) held.push(res); else res.end(result(config.output)); });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const workspace = join(base, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  const root = join(base, 'pool');
  const pool: ResourcePool = { schemaVersion: 1, id: 'supervisor-fixture', workers: config.workers ?? [worker()] };
  const bindings: ResourceBinding[] = pool.workers.map((item) => ({ workerId: item.id,
    capacityKey: config.shared ? 'shared' : item.id, kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }));
  let observations = pool.workers.map((item) => observed(item.id));
  const options: ResourcePoolSupervisorOptions = { root, workspace, pool, bindings, readObservations: () => observations, pollIntervalMs: 20 };
  const start = async (patch: Partial<ResourcePoolSupervisorOptions> = {}) => {
    const supervisor = await createResourcePoolSupervisor({ ...options, ...patch }); supervisors.push(supervisor); return supervisor;
  };
  const task = (id = 'task-a', patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id,
    prompt: `PRIVATE_PROMPT ${id}`, allowedWorkerIds: pool.workers.map((item) => item.id), mode: 'read-only',
    timeoutMs: 5000, maxOutputTokens: 100, ...patch });
  return { root, workspace, pool, bindings, options, requests, held, start, task,
    observations: (value: ResourceObservation[]) => { observations = value; },
    state: () => json(join(root, 'resource-console-state.json')), ledger: () => json(join(root, 'pool-state.json')) };
}
async function settled(supervisor: ResourcePoolSupervisor, id = 'task-a') {
  await vi.waitFor(() => expect(supervisor.snapshot().jobs.find((job) => job.id === id)?.state).toBe('settled'));
  return supervisor.snapshot().jobs.find((job) => job.id === id)!;
}

/** Build only test-owned valid queued records; escaped prompts exercise serialized, not raw, limits. */
async function nearCapacityFixture(f: Awaited<ReturnType<typeof fixture>>, reserveTransitions: boolean) {
  const first = await f.start(); first.setPaused(true); first.submit(f.task('template')); await first.close();
  const state = f.state(); const template = state.jobs[0];
  const row = (input: ResourceConsoleTaskInput) => ({ ...template, id: input.id, input,
    taskDigest: digest(canonical({ ...input, schemaVersion: 1, cwd: f.workspace })) });
  state.jobs = Array.from({ length: 22 }, (_, index) => row(f.task(`filler-${index}`, { prompt: 'x' })));
  const input = f.task('near-limit');
  const measure = () => {
    const next = { ...state, jobs: [...state.jobs, row(input)] };
    if (reserveTransitions) {
      next.paused = false;
      next.jobs = next.jobs.map((job) => ({ ...job, state: 'dispatching', workerId: 'w'.repeat(64),
        outcome: 'completed', reason: 'r'.repeat(120), updatedAt: '+275760-09-13T00:00:00.000Z' }));
    }
    return Buffer.byteLength(canonical(next) + '\n');
  };
  const target = 4 * 1024 * 1024;
  let remaining = target - measure();
  for (const job of state.jobs) {
    if (remaining === 0) break;
    const escaped = Math.min(32 * 1024, Math.floor((remaining + 1) / 6));
    const plain = Math.min(32 * 1024 - escaped, remaining + 1 - 6 * escaped);
    job.input.prompt = '\u0001'.repeat(escaped) + 'x'.repeat(plain);
    remaining -= escaped * 6 + plain - 1;
    job.taskDigest = digest(canonical({ ...job.input, schemaVersion: 1, cwd: f.workspace }));
  }
  expect(remaining).toBe(0); expect(measure()).toBe(target);
  save(join(f.root, 'resource-console-state.json'), state);
  return { input, statePath: join(f.root, 'resource-console-state.json'), target };
}

describe.skipIf(process.platform === 'win32')('durable foreground resource supervisor', () => {
  it('queues gated aliases, uses independent capacity, and recovers without durable quota poisoning', async () => {
    const f = await fixture({ workers: [worker('one'), worker('two'), worker('three')] });
    f.bindings[0]!.capacityKey = 'shared'; f.bindings[1]!.capacityKey = 'shared';
    let unavailable = ['one']; const supervisor = await f.start({ readUnavailableWorkerIds: () => unavailable });
    const blocked = f.task('blocked', { allowedWorkerIds: ['two'] }); supervisor.submit(blocked);
    supervisor.submit(f.task('independent', { allowedWorkerIds: ['three'] })); await settled(supervisor, 'independent');
    expect(f.requests).toHaveLength(1); expect(supervisor.snapshot().jobs.find((job) => job.id === 'blocked')?.state).toBe('queued');
    expect(f.ledger().observations.every((row: ResourceObservation) => row.health === 'ready')).toBe(true);
    unavailable = []; await settled(supervisor, 'blocked'); expect(f.requests).toHaveLength(2);
    expect(f.ledger().attempts.find((row: { id: string }) => row.id === 'blocked').taskDigest)
      .toBe(digest(canonical({ ...blocked, schemaVersion: 1, cwd: f.workspace })));
    expect(JSON.stringify(f.ledger())).not.toContain('unavailableWorkerIds');
    expect(JSON.stringify(f.state())).not.toContain('unavailableWorkerIds');
  });

  it.each(['throw', 'invalid'] as const)('recovers a %s admission callback without aborting active work or blocking controls', async (failure) => {
    const f = await fixture({ workers: [worker('one'), worker('two')], hold: true }); let failed = false;
    const supervisor = await f.start({ readUnavailableWorkerIds() {
      if (!failed) return [];
      if (failure === 'throw') throw new Error('PRIVATE_CALLBACK_DIAGNOSTIC');
      return ['not-enrolled'];
    } });
    supervisor.submit(f.task('one', { allowedWorkerIds: ['one'] })); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    failed = true; supervisor.submit(f.task('two', { allowedWorkerIds: ['two'] }));
    await vi.waitFor(() => expect(supervisor.snapshot().error).toBe('supervisor-admission-constraint-unavailable'));
    expect(f.held[0]!.destroyed).toBe(false); expect(f.ledger().attempts[0].status).toBe('reserved');
    supervisor.setPaused(true); supervisor.setPaused(false);
    supervisor.submit(f.task('cancel', { allowedWorkerIds: ['two'] })); expect(supervisor.cancel('cancel').state).toBe('cancelled');
    expect(JSON.stringify(supervisor.snapshot())).not.toContain('PRIVATE_CALLBACK_DIAGNOSTIC');
    f.held[0]!.end(result()); await settled(supervisor, 'one'); expect(f.requests).toHaveLength(1);
    failed = false; await vi.waitFor(() => expect(f.requests).toHaveLength(2)); expect(supervisor.snapshot().error).toBeNull();
    f.held[1]!.end(result()); await settled(supervisor, 'two');
  });

  it('keeps initially unavailable admission evidence recoverable without starting queued work', async () => {
    const f = await fixture(); let failed = true;
    const supervisor = await f.start({ readUnavailableWorkerIds() { if (failed) throw new Error('unavailable'); return []; } });
    supervisor.submit(f.task()); await vi.waitFor(() => expect(supervisor.snapshot().error).toBe('supervisor-admission-constraint-unavailable'));
    expect(f.requests).toHaveLength(0); expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
    failed = false; await settled(supervisor); expect(supervisor.snapshot().error).toBeNull(); expect(f.requests).toHaveLength(1);
  });

  it('rejects a non-function admission source and prior cancellation before store creation', async () => {
    const f = await fixture();
    await expect(f.start({ readUnavailableWorkerIds: null as unknown as () => string[] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const read = vi.fn(() => []);
    await expect(f.start({ readUnavailableWorkerIds: read, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(read).not.toHaveBeenCalled(); expect(existsSync(f.root)).toBe(false); expect(f.requests).toHaveLength(0);
  });

  it('pins the callback function while reading its current gate for every task admission', async () => {
    const f = await fixture({ workers: [worker('one'), worker('two')], hold: true });
    let firstHeld = false; const replacement = vi.fn(() => []);
    const options = { ...f.options, readUnavailableWorkerIds: () => {
      firstHeld = existsSync(join(f.root, 'pool-state.json')) && f.ledger().attempts.some((row: { id: string; status: string }) => row.id === 'one' && row.status === 'reserved');
      return firstHeld ? ['two'] : [];
    } };
    const supervisor = await createResourcePoolSupervisor(options); supervisors.push(supervisor);
    options.readUnavailableWorkerIds = replacement;
    supervisor.submit(f.task('one', { allowedWorkerIds: ['one'] })); supervisor.submit(f.task('two', { allowedWorkerIds: ['two'] }));
    await vi.waitFor(() => expect(f.requests).toHaveLength(1)); await sleep(60);
    expect(firstHeld).toBe(true); expect(f.requests).toHaveLength(1); expect(replacement).not.toHaveBeenCalled();
    f.held[0]!.end(result()); await settled(supervisor, 'one'); await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    f.held[1]!.end(result()); await settled(supervisor, 'two');
  });

  it('does not dispatch if the admission callback aborts its owner synchronously', async () => {
    const f = await fixture(); const controller = new AbortController(); let reads = 0;
    const supervisor = await f.start({ signal: controller.signal, readUnavailableWorkerIds() {
      if (++reads === 2) controller.abort(); return [];
    } });
    supervisor.submit(f.task()); await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    await expect(supervisor.close()).resolves.toBeUndefined(); expect(f.requests).toHaveLength(0);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  });

  it('creates one private queue owner and no runtime assignment until a task is submitted', async () => {
    const f = await fixture(); const supervisor = await f.start();
    expect(supervisor.snapshot()).toMatchObject({ paused: false, activeCount: 0, queuedCount: 0, jobs: [] });
    expect(lstatSync(f.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(f.root, 'resource-console-state.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
    await expect(f.start()).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.requests).toHaveLength(0);
  });

  it('durably queues, assigns, settles and scrubs private prompts while retaining output only in memory', async () => {
    const f = await fixture({ hold: true }); const supervisor = await f.start();
    const queued = supervisor.submit(f.task()); expect(queued.state).toBe('queued');
    expect(f.state().jobs[0].input.prompt).toBe(f.task().prompt);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.state().jobs[0].state).toBe('dispatching'); expect(f.ledger().attempts[0].status).toBe('reserved');
    expect(supervisor.snapshot()).toMatchObject({ activeCount: 1, jobs: [{ workerId: 'local', cancellable: true }] });
    f.held[0]!.end(result()); const job = await settled(supervisor);
    expect(job).toMatchObject({ outcome: 'completed', cancellable: false, outputAvailable: true });
    expect(f.state().jobs[0].input).toBeNull(); expect(JSON.stringify(f.state())).not.toContain('PRIVATE_PROMPT');
    expect(JSON.stringify(f.ledger())).not.toContain('PRIVATE_PROMPT'); expect(JSON.stringify(f.ledger())).not.toContain('PRIVATE_OUTPUT');
    expect(JSON.stringify(supervisor.snapshot())).not.toContain('PRIVATE_OUTPUT');
    expect(supervisor.output('task-a')).toEqual({ id: 'task-a', text: 'PRIVATE_OUTPUT', truncated: false, retention: 'this-console-session' });
    await supervisor.close(); expect(supervisor.output('task-a')).toBeNull();
    const next = await f.start(); expect(next.snapshot().jobs[0]).toMatchObject({ state: 'settled', outputAvailable: false });
    expect(f.requests).toHaveLength(1);
  });

  it('returns detached snapshots, output and submitted fields without exposing private task text', async () => {
    const f = await fixture(); const supervisor = await f.start(); const input = f.task();
    supervisor.submit(input); input.prompt = 'CHANGED'; input.allowedWorkerIds[0] = 'unknown';
    await settled(supervisor); const view = supervisor.snapshot(); view.jobs[0]!.allowedWorkerIds[0] = 'edited';
    const output = supervisor.output('task-a')!; output.text = 'changed';
    expect(supervisor.snapshot().jobs[0]!.allowedWorkerIds).toEqual(['local']); expect(supervisor.output('task-a')!.text).toBe('PRIVATE_OUTPUT');
    expect(f.requests[0]).toMatchObject({ messages: [{ content: 'PRIVATE_PROMPT task-a' }] });
  });

  it('deduplicates pending and completed task ids and rejects changed task identity', async () => {
    const f = await fixture({ hold: true }); const supervisor = await f.start();
    supervisor.submit(f.task()); supervisor.submit(f.task()); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(() => supervisor.submit(f.task('task-a', { prompt: 'different' }))).toThrow(ResourceSupervisorError);
    f.held[0]!.end(result()); await settled(supervisor); supervisor.submit(f.task());
    await sleep(60); expect(f.requests).toHaveLength(1); expect(supervisor.snapshot().jobs).toHaveLength(1);
  });

  it('skips blocked earlier workers while preserving denied observations and permitting another worker', async () => {
    const f = await fixture({ workers: [worker('blocked'), worker('ready')], hold: true });
    f.observations([observed('blocked', { health: 'unavailable' }), observed('ready')]);
    const supervisor = await f.start({ maxParallel: 1 });
    supervisor.submit(f.task('blocked-task', { allowedWorkerIds: ['blocked'] }));
    supervisor.submit(f.task('ready-task', { allowedWorkerIds: ['ready'] }));
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]).toMatchObject({ model: 'fixture-ready' });
    expect(supervisor.snapshot().jobs.find((job) => job.id === 'blocked-task')?.state).toBe('queued');
    expect(f.ledger().observations.find((row: ResourceObservation) => row.workerId === 'blocked')?.health).toBe('unavailable');
    f.held[0]!.end(result()); await settled(supervisor, 'ready-task');
  });

  it('automatically admits a queued task after a fresh health observation restores eligibility', async () => {
    const f = await fixture(); f.observations([observed('local', { health: 'unavailable' })]);
    const supervisor = await f.start(); supervisor.submit(f.task());
    await vi.waitFor(() => expect(existsSync(join(f.root, 'pool-state.json'))).toBe(true));
    expect(f.requests).toHaveLength(0); expect(supervisor.snapshot().queuedCount).toBe(1);
    f.observations([observed('local', { observedAt: new Date().toISOString() })]);
    await settled(supervisor); expect(f.requests).toHaveLength(1);
  });

  it('keeps admitted work and controls alive through deleted/corrupt observations, then resumes the queue', async () => {
    const f = await fixture({ workers: [worker('one'), worker('two')], hold: true });
    const observationsFile = join(base, 'observations.json'); save(observationsFile, [observed('one'), observed('two')]);
    const supervisor = await f.start({ readObservations: () => json(observationsFile) });
    supervisor.submit(f.task('one', { allowedWorkerIds: ['one'] }));
    await vi.waitFor(() => expect(f.requests).toHaveLength(1)); unlinkSync(observationsFile);
    supervisor.submit(f.task('two', { allowedWorkerIds: ['two'] }));
    await vi.waitFor(() => expect(supervisor.snapshot().error).toBe('supervisor-observations-unavailable'));
    expect(f.ledger().attempts[0].status).toBe('reserved'); expect(f.held[0]!.destroyed).toBe(false);
    supervisor.setPaused(true); supervisor.setPaused(false);
    supervisor.submit(f.task('cancel-queued', { allowedWorkerIds: ['two'] }));
    expect(supervisor.cancel('cancel-queued').state).toBe('cancelled');
    writeFileSync(observationsFile, '{', { mode: 0o600 }); await sleep(60); expect(f.requests).toHaveLength(1);
    f.held[0]!.end(result()); await settled(supervisor, 'one');
    save(observationsFile, [observed('one', { observedAt: new Date().toISOString() }), observed('two', { observedAt: new Date().toISOString() })]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(2)); expect(supervisor.snapshot().error).toBeNull();
    f.held[1]!.end(result()); await settled(supervisor, 'two');
  });

  it('enforces supervisor parallel limit across independent workers and starts queued work after settlement', async () => {
    const f = await fixture({ workers: [worker('one'), worker('two'), worker('three')], hold: true });
    const supervisor = await f.start({ maxParallel: 2 });
    for (const id of ['one', 'two', 'three']) supervisor.submit(f.task(id, { allowedWorkerIds: [id] }));
    await vi.waitFor(() => expect(f.requests).toHaveLength(2)); await sleep(60);
    expect(supervisor.snapshot()).toMatchObject({ activeCount: 2, queuedCount: 1 });
    f.held[0]!.end(result()); await vi.waitFor(() => expect(f.requests).toHaveLength(3));
    f.held[1]!.end(result()); f.held[2]!.end(result()); await settled(supervisor, 'three');
  });

  it('uses the runtime shared-account limit even when supervisor parallelism permits more', async () => {
    const f = await fixture({ workers: [worker('one'), worker('two')], shared: true, hold: true });
    const supervisor = await f.start({ maxParallel: 2 });
    supervisor.submit(f.task('one', { allowedWorkerIds: ['one'] })); supervisor.submit(f.task('two', { allowedWorkerIds: ['two'] }));
    await vi.waitFor(() => expect(f.requests).toHaveLength(1)); await sleep(60); expect(f.requests).toHaveLength(1);
    expect(supervisor.snapshot().jobs.find((job) => job.id === 'two')?.state).toBe('queued');
    f.held[0]!.end(result()); await vi.waitFor(() => expect(f.requests).toHaveLength(2)); f.held[1]!.end(result());
    await settled(supervisor, 'two');
  });

  it('preserves queued intents and explicit pause across restart, then resumes without caller resubmission', async () => {
    const f = await fixture(); const first = await f.start(); first.setPaused(true); first.submit(f.task());
    await first.close(); const next = await f.start(); await sleep(60);
    expect(next.snapshot()).toMatchObject({ paused: true, queuedCount: 1 }); expect(f.requests).toHaveLength(0);
    next.setPaused(false); await settled(next); expect(f.requests).toHaveLength(1);
  });

  it('never replays a prior dispatch intent even when no runtime ledger exists', async () => {
    const f = await fixture(); const first = await f.start(); first.setPaused(true); first.submit(f.task()); await first.close();
    const prior = f.state(); prior.jobs[0].state = 'dispatching'; save(join(f.root, 'resource-console-state.json'), prior);
    const next = await f.start(); next.setPaused(false); await sleep(60);
    expect(next.snapshot().jobs[0]).toMatchObject({ state: 'unresolved', outcome: null, cancellable: false, reason: 'previous-dispatch-unresolved' });
    expect(f.state().jobs[0].input).toBeNull(); expect(f.requests).toHaveLength(0);
    expect(() => next.cancel('task-a')).toThrow(ResourceSupervisorError);
  });

  it('recovers an exact terminal runtime receipt after an interrupted supervisor settlement', async () => {
    const f = await fixture(); const first = await f.start(); first.submit(f.task()); await settled(first); await first.close();
    const prior = f.state(); Object.assign(prior.jobs[0], { state: 'dispatching', outcome: null, input: f.task(), workerId: null });
    save(join(f.root, 'resource-console-state.json'), prior); const next = await f.start();
    expect(next.snapshot().jobs[0]).toMatchObject({ state: 'settled', outcome: 'completed', outputAvailable: false });
    expect(f.state().jobs[0].input).toBeNull(); expect(f.requests).toHaveLength(1);
  });

  it('marks an external runtime reservation unresolved and never aborts it on supervisor close', async () => {
    const f = await fixture({ hold: true }); const task = f.task();
    const external = runResourceTask({ root: f.root, pool: f.pool, bindings: f.bindings,
      observations: f.pool.workers.map((row) => observed(row.id)), task: { ...task, schemaVersion: 1, cwd: f.workspace } });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1)); const supervisor = await f.start(); supervisor.submit(task);
    await vi.waitFor(() => expect(supervisor.snapshot().jobs[0]?.state).toBe('unresolved'));
    expect(() => supervisor.cancel(task.id)).toThrow(ResourceSupervisorError); await supervisor.close();
    expect(f.ledger().attempts[0].status).toBe('reserved'); f.held[0]!.end(result());
    expect((await external).receipt?.status).toBe('completed'); expect(f.requests).toHaveLength(1);
  });

  it('rejects an external same-id conflict before queue writes without aborting unrelated owned work', async () => {
    const f = await fixture({ workers: [worker('one'), worker('two')], hold: true });
    const externalTask = f.task('external', { allowedWorkerIds: ['one'] });
    const external = runResourceTask({ root: f.root, pool: f.pool, bindings: f.bindings,
      observations: [observed('one'), observed('two')], task: { ...externalTask, schemaVersion: 1, cwd: f.workspace } });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1)); const supervisor = await f.start();
    supervisor.submit(f.task('owned', { allowedWorkerIds: ['two'] })); await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    const before = f.state();
    expect(() => supervisor.submit(f.task('external', { prompt: 'conflicting', allowedWorkerIds: ['one'] }))).toThrow(ResourceSupervisorError);
    expect(f.state()).toEqual(before); expect(supervisor.snapshot().error).toBeNull();
    expect(f.ledger().attempts.every((row: { status: string }) => row.status === 'reserved')).toBe(true);
    f.held[0]!.end(result()); f.held[1]!.end(result()); await external; await settled(supervisor, 'owned');
    await supervisor.close(); const next = await f.start(); expect(next.snapshot().error).toBeNull();
  });

  it('isolates a conflicting runtime identity appearing after enqueue and keeps other queued work usable', async () => {
    const f = await fixture({ workers: [worker('one'), worker('two')], hold: true }); const supervisor = await f.start();
    supervisor.setPaused(true); supervisor.submit(f.task('raced', { allowedWorkerIds: ['one'] }));
    supervisor.submit(f.task('owned', { allowedWorkerIds: ['two'] }));
    const external = runResourceTask({ root: f.root, pool: f.pool, bindings: f.bindings,
      observations: [observed('one'), observed('two')],
      task: { ...f.task('raced', { prompt: 'external different intent', allowedWorkerIds: ['one'] }), schemaVersion: 1, cwd: f.workspace } });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1)); supervisor.setPaused(false);
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(supervisor.snapshot().jobs.find((job) => job.id === 'raced')).toMatchObject({ state: 'unresolved', outcome: null, reason: 'task-identity-conflict' });
    expect(supervisor.snapshot().error).toBeNull(); f.held[0]!.end(result()); f.held[1]!.end(result());
    await external; await settled(supervisor, 'owned'); await supervisor.close();
    const next = await f.start(); expect(next.snapshot().jobs.find((job) => job.id === 'raced')?.state).toBe('unresolved');
    expect(next.snapshot().error).toBeNull();
  });

  it('cancels queued work without contacting a worker and retains idempotent metadata', async () => {
    const f = await fixture(); const supervisor = await f.start(); supervisor.setPaused(true); supervisor.submit(f.task());
    expect(supervisor.cancel('task-a')).toMatchObject({ state: 'cancelled', outcome: 'cancelled', cancellable: false });
    expect(f.state().jobs[0].input).toBeNull(); supervisor.setPaused(false); await sleep(60);
    expect(f.requests).toHaveLength(0); expect(supervisor.cancel('task-a').state).toBe('cancelled');
    expect(() => supervisor.cancel('absent')).toThrow(ResourceSupervisorError);
  });

  it('cancels an owned actual local request, waits settlement and never runs it again', async () => {
    const f = await fixture({ hold: true }); const supervisor = await f.start(); supervisor.submit(f.task());
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(supervisor.cancel('task-a')).toMatchObject({ state: 'dispatching', reason: 'cancellation-requested' });
    expect(await settled(supervisor)).toMatchObject({ outcome: 'cancelled' });
    expect(f.ledger().attempts[0]).toMatchObject({ status: 'cancelled', inputTokens: null, outputTokens: null });
    supervisor.submit(f.task()); await sleep(60); expect(f.requests).toHaveLength(1);
  });

  it('awaits owned work on idempotent shutdown and refuses new submissions', async () => {
    const f = await fixture({ hold: true }); const supervisor = await f.start(); supervisor.submit(f.task());
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const close = supervisor.close(); expect(supervisor.close()).toBe(close);
    expect(() => supervisor.submit(f.task('later'))).toThrow(ResourceSupervisorError); await close;
    expect(supervisor.snapshot()).toMatchObject({ closing: true, activeCount: 0 });
    expect(f.ledger().attempts[0].status).toBe('cancelled'); expect(existsSync(join(f.root, '.resource-console.lock'))).toBe(false);
  });

  it('settles actual timeout without fabricating known token usage', async () => {
    const f = await fixture({ hold: true }); const supervisor = await f.start(); supervisor.submit(f.task('task-a', { timeoutMs: 40 }));
    expect(await settled(supervisor)).toMatchObject({ outcome: 'timed-out' });
    expect(f.ledger().attempts[0]).toMatchObject({ status: 'timed-out', inputTokens: null, outputTokens: null });
  });

  it('honors pre-aborted startup without a store write and links later abort to full close', async () => {
    const f = await fixture({ hold: true }); const before = new AbortController(); before.abort();
    await expect(f.start({ signal: before.signal })).rejects.toMatchObject({ code: 'UNAVAILABLE' }); expect(existsSync(f.root)).toBe(false);
    const active = new AbortController(); const supervisor = await f.start({ signal: active.signal }); supervisor.submit(f.task());
    await vi.waitFor(() => expect(f.requests).toHaveLength(1)); active.abort();
    await supervisor.close(); expect(f.ledger().attempts[0].status).toBe('cancelled');
  });

  it('does not start recovered queued work when startup observation reading aborts the signal', async () => {
    const f = await fixture(); const first = await f.start(); first.setPaused(true); first.submit(f.task()); await first.close();
    const controller = new AbortController(); const before = readFileSync(join(f.root, 'resource-console-state.json'));
    await expect(f.start({ signal: controller.signal, readObservations: () => { controller.abort(); return []; } })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(readFileSync(join(f.root, 'resource-console-state.json'))).toEqual(before); expect(f.requests).toHaveLength(0);
  });

  it('truncates output on UTF-8 boundaries and evicts old output at the total memory ceiling', async () => {
    const text = '€'.repeat(100_000); const workers = Array.from({ length: 18 }, (_, index) => worker(`local-${index}`));
    const f = await fixture({ output: text, workers }); const supervisor = await f.start({ maxQueued: 64, maxParallel: 16 });
    for (let index = 0; index < 18; index++) supervisor.submit(f.task(`task-${index}`, { allowedWorkerIds: [`local-${index}`] }));
    await vi.waitFor(() => expect(supervisor.snapshot().jobs.filter((job) => job.state === 'settled')).toHaveLength(18), { timeout: 10_000 });
    const retained = supervisor.snapshot().jobs.filter((job) => job.outputAvailable);
    expect(retained.length).toBeLessThan(18); expect(supervisor.output('task-0')).toBeNull();
    let bytes = 0;
    for (const job of retained) { const output = supervisor.output(job.id)!;
      expect(output.truncated).toBe(true); expect(output.text).not.toContain('�');
      expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(256 * 1024); bytes += Buffer.byteLength(output.text); }
    expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it.each([
    { id: 'bad/id' }, { prompt: 'x'.repeat(32 * 1024 + 1) }, { allowedWorkerIds: ['unknown'] },
    { allowedWorkerIds: [] }, { allowedWorkerIds: ['local', 'local'] }, { allowedWorkerIds: new Array(1) },
    { mode: 'unsafe' }, { timeoutMs: 0 }, { maxOutputTokens: 16385 }, { cwd: '/tmp' }, { command: ['anything'] },
  ])('rejects invalid or over-scoped browser task fields before queue writes %#', async (patch) => {
    const f = await fixture(); const supervisor = await f.start(); const before = f.state();
    expect(() => supervisor.submit({ ...f.task(), ...patch } as ResourceConsoleTaskInput)).toThrow(ResourceSupervisorError);
    expect(f.state()).toEqual(before); expect(f.requests).toHaveLength(0);
  });

  it('fails explicitly at queue capacity without dropping identities', async () => {
    const f = await fixture(); const supervisor = await f.start({ maxQueued: 1 }); supervisor.setPaused(true); supervisor.submit(f.task());
    expect(() => supervisor.submit(f.task('other'))).toThrow(ResourceSupervisorError);
    expect(supervisor.snapshot().jobs).toHaveLength(1); expect(supervisor.submit(f.task()).id).toBe('task-a');
  });

  it('rejects queued bytes that fit but cannot reserve every pending metadata transition', async () => {
    const f = await fixture(); const limit = await nearCapacityFixture(f, false);
    const supervisor = await f.start(); const before = readFileSync(limit.statePath);
    expect(() => supervisor.submit(limit.input)).toThrow(expect.objectContaining({ code: 'CAPACITY' }));
    expect(readFileSync(limit.statePath)).toEqual(before);
    expect(supervisor.snapshot()).toMatchObject({ paused: true, error: null, queuedCount: 22 });
    expect(f.requests).toHaveLength(0); expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
    // Capacity rejection leaves controls and prior identities usable.
    expect(supervisor.cancel('filler-0').state).toBe('cancelled');
    expect(supervisor.submit(limit.input).state).toBe('queued');
    expect(supervisor.snapshot().error).toBeNull();
  });

  it('reserves the entire legal envelope at the byte limit and still dispatches the longest worker id', async () => {
    const workerId = 'w'.repeat(64); const f = await fixture({ workers: [worker(workerId)], hold: true });
    const limit = await nearCapacityFixture(f, true); const supervisor = await f.start({ maxParallel: 1 });
    expect(supervisor.submit(limit.input).state).toBe('queued');
    expect(readFileSync(limit.statePath).length).toBeLessThan(limit.target);
    supervisor.setPaused(false);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 5000 });
    expect(supervisor.snapshot()).toMatchObject({ error: null, activeCount: 1 });
    expect(supervisor.snapshot().jobs[0]).toMatchObject({ state: 'dispatching', workerId });
    expect(readFileSync(limit.statePath).length).toBeLessThanOrEqual(limit.target);
    supervisor.setPaused(true); f.held[0]!.end(result()); await settled(supervisor, 'filler-0');
    expect(supervisor.snapshot().error).toBeNull();
    expect(readFileSync(limit.statePath).length).toBeLessThanOrEqual(limit.target);
    await supervisor.close(); expect(f.requests).toHaveLength(1);
  });

  it('retains all 256 historical identities and explicitly rejects new work when history is full', async () => {
    const f = await fixture(); const first = await f.start(); first.setPaused(true); first.submit(f.task('task-0'));
    first.cancel('task-0'); await first.close(); const state = f.state(); const template = state.jobs[0];
    state.jobs = Array.from({ length: 256 }, (_, index) => ({ ...template, id: `task-${index}`,
      taskDigest: digest(canonical({ ...f.task(`task-${index}`), schemaVersion: 1, cwd: f.workspace })) }));
    save(join(f.root, 'resource-console-state.json'), state); const next = await f.start();
    expect(next.snapshot().jobs).toHaveLength(256);
    const before = readFileSync(join(f.root, 'resource-console-state.json'));
    expect(() => next.submit(f.task('new-task'))).toThrow(expect.objectContaining({ code: 'CAPACITY' }));
    expect(readFileSync(join(f.root, 'resource-console-state.json'))).toEqual(before);
    expect(next.submit(f.task('task-0'))).toMatchObject({ id: 'task-0', state: 'cancelled' }); expect(f.requests).toHaveLength(0);
  });

  it('refuses a dangling queue-file link instead of replacing it as an absent state', async () => {
    const f = await fixture(); mkdirSync(f.root, { mode: 0o700 });
    const statePath = join(f.root, 'resource-console-state.json'); symlinkSync(join(base, 'absent-fixture'), statePath);
    await expect(f.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(lstatSync(statePath).isSymbolicLink()).toBe(true); expect(f.requests).toHaveLength(0);
  });

  it('refuses changed enrollment/workspace and malformed private state on restart', async () => {
    const f = await fixture(); const supervisor = await f.start(); supervisor.setPaused(true); supervisor.submit(f.task()); await supervisor.close();
    const changed = structuredClone(f.pool); changed.workers[0]!.model = 'new-model';
    await expect(f.start({ pool: changed })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const state = f.state(); state.jobs[0].input.prompt = 'changed'; save(join(f.root, 'resource-console-state.json'), state);
    await expect(f.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' }); expect(f.requests).toHaveLength(0);
  });

  it('rejects an unsafe existing root without repairing its permissions', async () => {
    const f = await fixture(); mkdirSync(f.root, { mode: 0o755 });
    await expect(f.start()).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(lstatSync(f.root).mode & 0o777).toBe(0o755);
  });

  it('detects owner loss, aborts owned transport, and never overwrites a replacement lock', async () => {
    const f = await fixture({ hold: true }); const supervisor = await f.start(); supervisor.submit(f.task());
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const lock = join(f.root, '.resource-console.lock'); unlinkSync(lock); save(lock, { replacement: true });
    expect(supervisor.snapshot()).toMatchObject({ error: 'supervisor-ownership-lost' });
    await expect(supervisor.close()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(json(lock)).toEqual({ replacement: true }); expect(f.requests).toHaveLength(1);
  });

  it('detects an externally changed queue before writing or dispatching it', async () => {
    const f = await fixture(); const supervisor = await f.start(); supervisor.setPaused(true); supervisor.submit(f.task());
    const state = f.state(); state.paused = false; save(join(f.root, 'resource-console-state.json'), state);
    expect(() => supervisor.setPaused(false)).toThrow(ResourceSupervisorError);
    expect(supervisor.snapshot().error).toBe('supervisor-persistence-unavailable'); await sleep(60); expect(f.requests).toHaveLength(0);
  });

  it('refuses malformed observations and overlapping writable scope before initializing', async () => {
    const f = await fixture();
    await expect(f.start({ readObservations: () => [{ invalid: true }] as unknown as ResourceObservation[] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.start({ root: join(f.workspace, 'ledger') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(readdirSync(f.workspace)).toEqual([]); expect(existsSync(f.root)).toBe(false);
  });

  it('preserves native termination uncertainty and prevents post-restart native replay', async () => {
    const f = await fixture(); const script = join(base, 'native.cjs'); const started = join(base, 'native-started');
    writeFileSync(script, `const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(started)},'ready',{flag:'wx'});setInterval(()=>{},1000)});`, { mode: 0o600 });
    const pool: ResourcePool = { schemaVersion: 1, id: 'native', workers: [worker('native', 'codex')] };
    const bindings: ResourceBinding[] = [{ workerId: 'native', capacityKey: 'native', kind: 'native-cli', command: [process.execPath, script] }];
    const patch = { pool, bindings, readObservations: () => [] }; const supervisor = await f.start(patch);
    supervisor.submit(f.task('native-task', { allowedWorkerIds: ['native'] }));
    await vi.waitFor(() => expect(existsSync(started)).toBe(true)); supervisor.cancel('native-task');
    // Native ownership uses a documented 5-second termination grace. Observe
    // its completed settlement before close to cover the no-longer-active case.
    await vi.waitFor(() => expect(supervisor.snapshot().activeCount).toBe(0), { timeout: 10_000 });
    await expect(supervisor.close()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(supervisor.snapshot().jobs[0]?.state).toBe('unresolved'); expect(supervisor.snapshot().jobs[0]?.outcome).toBe('uncertain');
    const next = await f.start(patch); expect(next.snapshot().jobs[0]).toMatchObject({ state: 'unresolved', cancellable: false });
    expect(() => next.cancel('native-task')).toThrow(ResourceSupervisorError); expect(readFileSync(started, 'utf8')).toBe('ready');
    await expect(next.close()).resolves.toBeUndefined();
  });
});
