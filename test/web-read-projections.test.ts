import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import {
  createReadProjectionWorker,
  type ReadProjectionKind,
  type ReadProjectionReader,
  type ReadProjectionRequest,
  type ReadProjectionWorkerHandle,
  type ReadProjectionWorkerOptions,
} from '../src/core/web/read-projections.js';

// If a transport failure ever falls back to inline computation, these spies
// make that observable without touching a real fleet, provider, or daemon.
const inline = vi.hoisted(() => ({ snapshot: vi.fn(), control: vi.fn(), fleet: vi.fn() }));
vi.mock('../src/core/dashboard.js', () => ({ buildSnapshot: inline.snapshot }));
vi.mock('../src/core/web/control.js', () => ({ buildControlSnapshot: inline.control }));
vi.mock('../src/core/fleet/status.js', () => ({ buildFleetStatus: inline.fleet }));

const cfg = {
  version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {},
} as AshlrConfig;
const readers: ReadProjectionReader[] = [];

class FakeWorker extends EventEmitter {
  readonly requests: ReadProjectionRequest[] = [];
  readonly postMessage = vi.fn((request: ReadProjectionRequest) => { this.requests.push(request); });
  readonly terminate = vi.fn((): Promise<number> => Promise.resolve(0));

  result(index: number, value: unknown): void {
    this.emit('message', { type: 'result', id: this.requests[index]!.id, ok: true, value });
  }
}

function harness(options: Omit<ReadProjectionWorkerOptions, '_workerFactory'> = {}) {
  const workers: FakeWorker[] = [];
  const factory = vi.fn((_url: URL, _options: unknown): ReadProjectionWorkerHandle => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as ReadProjectionWorkerHandle;
  });
  const reader = createReadProjectionWorker(cfg, { timeoutMs: 1_000, ...options, _workerFactory: factory });
  readers.push(reader);
  return { reader, workers, factory };
}

function deferredTermination() {
  let resolve!: (value: number) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// The transport chains terminate().then(pump); drain only promise reactions,
// leaving fake timeout deadlines under each test's explicit control.
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.close();
  for (const compute of Object.values(inline)) expect(compute).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('bounded read-projection transport', () => {
  it('starts lazily, coalesces identical reads, and serializes distinct projections', async () => {
    const { reader, workers, factory } = harness();
    expect(factory).not.toHaveBeenCalled();
    const snapshot = reader.read('snapshot');
    const duplicate = reader.read('snapshot');
    const control = reader.read('control');
    expect(duplicate).toBe(snapshot);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]![1]).toMatchObject({
      workerData: { cfg }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
    });
    const worker = workers[0]!;
    expect(worker.requests.map((request) => request.kind)).toEqual(['snapshot']);
    worker.result(0, { sampledAt: 'snapshot observation' });
    await expect(snapshot).resolves.toEqual({ sampledAt: 'snapshot observation' });
    await expect(duplicate).resolves.toEqual({ sampledAt: 'snapshot observation' });
    expect(worker.requests.map((request) => request.kind)).toEqual(['snapshot', 'control']);
    worker.result(1, { sampledAt: 'control observation' });
    await expect(control).resolves.toEqual({ sampledAt: 'control observation' });
    expect(worker.requests[0]!.id).not.toBe(worker.requests[1]!.id);
  });

  it('uses only the fixed local source loader and worker, without inherited Node arguments', async () => {
    const { reader, workers, factory } = harness();
    const previousArgs = process.execArgv;
    process.execArgv = ['--conditions=ashlr-parent-test-only'];
    try {
      const pending = reader.read('snapshot');
      const transport = new URL('../src/core/web/read-projections.ts', import.meta.url);
      const loader = pathToFileURL(createRequire(transport).resolve('tsx/esm/api')).href;
      const source = new URL('./read-projection-worker.ts', transport).href;
      const fixedBootstrap = `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`;
      const [workerUrl, options] = factory.mock.calls[0]!;
      expect(workerUrl.href).toBe(`data:text/javascript,${encodeURIComponent(fixedBootstrap)}`);
      expect(options).toEqual({
        workerData: { cfg }, execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
      });
      workers[0]!.result(0, { sourceMode: true });
      await expect(pending).resolves.toEqual({ sourceMode: true });
    } finally {
      process.execArgv = previousArgs;
    }
  });

  it('counts active and queued jobs against capacity, after checking for coalesced work', async () => {
    const { reader, workers } = harness({ maxPending: 2 });
    const first = reader.read('snapshot');
    const second = reader.read('control');
    expect(reader.read('control')).toBe(second);
    expect(reader.read('snapshot')).toBe(first);
    await expect(reader.read('fleet')).rejects.toMatchObject({ code: 'READ_PROJECTION_BUSY' });
    expect(workers[0]!.requests).toHaveLength(1);
    workers[0]!.result(0, { first: true });
    await first;
    const third = reader.read('fleet');
    expect(workers[0]!.requests).toHaveLength(2);
    workers[0]!.result(1, { second: true });
    await second;
    expect(workers[0]!.requests.map((request) => request.kind)).toEqual(['snapshot', 'control', 'fleet']);
    workers[0]!.result(2, { third: true });
    await expect(third).resolves.toEqual({ third: true });
  });

  it('normalizes pulse keys without mixing projects/windows or caching completed reads', async () => {
    const { reader, workers } = harness();
    const first = reader.read('pulse', { window: '1d', project: 'one' });
    expect(reader.read('pulse', { project: 'one', window: '1d' })).toBe(first);
    const anotherWindow = reader.read('pulse', { window: '7d', project: 'one' });
    const anotherProject = reader.read('pulse', { window: '1d', project: 'two' });
    const worker = workers[0]!;
    worker.result(0, { reading: 1 });
    await first;
    worker.result(1, { reading: 2 });
    await anotherWindow;
    worker.result(2, { reading: 3 });
    await anotherProject;
    expect(worker.requests.map((request) => request.payload)).toEqual([
      { window: '1d', project: 'one' }, { window: '7d', project: 'one' }, { window: '1d', project: 'two' },
    ]);
    const fresh = reader.read('pulse', { window: '1d', project: 'one' });
    expect(worker.requests).toHaveLength(4);
    worker.result(3, { reading: 4 });
    await expect(fresh).resolves.toEqual({ reading: 4 });
  });

  it('rejects unknown operations and extra or malformed payloads before creating a worker', async () => {
    const { reader, factory } = harness();
    await expect(reader.read('execute' as ReadProjectionKind)).rejects.toMatchObject({ code: 'READ_PROJECTION_INVALID_REQUEST' });
    await expect(reader.read('snapshot', { root: '/not-a-selector' } as never)).rejects.toMatchObject({ code: 'READ_PROJECTION_INVALID_REQUEST' });
    for (const payload of [undefined, null, [], { window: ['1d'] }, { window: { toString: () => '1d' } },
      { window: 'forever' }, { window: '1d', root: '/not-a-selector' }, { window: '1d', project: '\n' },
      { window: '1d', project: 'x'.repeat(513) }]) {
      await expect(reader.read('pulse', payload as never)).rejects.toMatchObject({ code: 'READ_PROJECTION_INVALID_REQUEST' });
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    { maxPending: 0 }, { maxPending: 33 }, { maxPending: 1.5 }, { timeoutMs: 0 },
    { timeoutMs: 60_001 }, { timeoutMs: Number.NaN }, { timeoutMs: Number.POSITIVE_INFINITY },
  ])('rejects invalid bounds %j', (options) => {
    expect(() => createReadProjectionWorker(cfg, options)).toThrow('Invalid read projection limits');
  });

  it('treats a projection error as a failed read, then continues queued work on the same worker', async () => {
    const { reader, workers, factory } = harness();
    const first = reader.read('snapshot');
    const rejected = expect(first).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' });
    const second = reader.read('control');
    const worker = workers[0]!;
    worker.emit('message', { type: 'result', id: worker.requests[0]!.id, ok: false, error: 'private worker details' });
    await rejected;
    expect(worker.requests.map((request) => request.kind)).toEqual(['snapshot', 'control']);
    expect(factory).toHaveBeenCalledOnce();
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.result(1, { observed: true });
    await expect(second).resolves.toEqual({ observed: true });
  });

  it('recovers from worker factory failure without computing a read inline', async () => {
    const { reader, factory, workers } = harness();
    factory.mockImplementationOnce(() => { throw new Error('test-owned unavailable worker'); });
    await expect(reader.read('snapshot')).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' });
    expect(workers).toHaveLength(0);
    const next = reader.read('snapshot');
    expect(factory).toHaveBeenCalledTimes(2);
    workers[0]!.result(0, { recovered: true });
    await expect(next).resolves.toEqual({ recovered: true });
  });

  it('terminates a worker whose dispatch throws and recovers for a subsequent caller', async () => {
    const { reader, factory, workers } = harness();
    const warmed = reader.read('snapshot');
    workers[0]!.result(0, { warmed: true });
    await warmed;
    workers[0]!.postMessage.mockImplementationOnce(() => { throw new Error('test dispatch failure'); });
    await expect(reader.read('control')).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' });
    await flushMicrotasks();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    const recovered = reader.read('control');
    expect(factory).toHaveBeenCalledTimes(2);
    workers[1]!.result(0, { recovered: true });
    await expect(recovered).resolves.toEqual({ recovered: true });
  });

  it.each(['error', 'exit'])('rejects all pending work on worker %s and waits for termination before replacement', async (event) => {
    const { reader, workers, factory } = harness();
    const first = reader.read('snapshot');
    const queued = reader.read('control');
    const failures = Promise.all([
      expect(first).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' }),
      expect(queued).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' }),
    ]);
    const old = workers[0]!;
    const termination = deferredTermination();
    old.terminate.mockReturnValueOnce(termination.promise);
    old.emit(event, event === 'error' ? new Error('test worker error') : 1);
    await failures;
    const recovered = reader.read('fleet');
    await flushMicrotasks();
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    termination.resolve(0);
    await flushMicrotasks();
    expect(factory).toHaveBeenCalledTimes(2);
    const replacement = workers[1]!;
    expect(replacement.requests.map((request) => request.kind)).toEqual(['fleet']);
    old.result(0, { obsolete: true });
    old.emit('error', new Error('late obsolete error'));
    old.emit('exit', 0);
    expect(replacement.terminate).not.toHaveBeenCalled();
    replacement.result(0, { recovered: true });
    await expect(recovered).resolves.toEqual({ recovered: true });
  });

  it.each([null, { type: 'other', id: 1, ok: true, value: {} }, { type: 'result', id: 999, ok: true, value: {} },
    { type: 'result', id: 1, ok: 'true', value: {} }, { type: 'result', id: 1, ok: true },
    { type: 'result', id: 1, ok: true, value: undefined }])('rejects malformed worker response %j', async (message) => {
    const { reader, workers } = harness();
    const active = reader.read('snapshot');
    const queued = reader.read('control');
    const failures = Promise.all([
      expect(active).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' }),
      expect(queued).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' }),
    ]);
    workers[0]!.emit('message', message);
    await failures;
    await flushMicrotasks();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it('times out active and queued work together and allows a fresh request to recover', async () => {
    const { reader, workers } = harness();
    const active = reader.read('snapshot');
    const queued = reader.read('control');
    const failures = Promise.all([
      expect(active).rejects.toMatchObject({ code: 'READ_PROJECTION_TIMEOUT' }),
      expect(queued).rejects.toMatchObject({ code: 'READ_PROJECTION_TIMEOUT' }),
    ]);
    await vi.advanceTimersByTimeAsync(999);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failures;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    const recovered = reader.read('snapshot');
    workers[1]!.result(0, { recovered: true });
    await expect(recovered).resolves.toEqual({ recovered: true });
  });

  it('includes queue wait in a projection deadline rather than restarting its budget on dispatch', async () => {
    const { reader, workers } = harness();
    const first = reader.read('snapshot');
    await vi.advanceTimersByTimeAsync(400);
    const second = reader.read('control');
    const timedOut = expect(second).rejects.toMatchObject({ code: 'READ_PROJECTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(500);
    workers[0]!.result(0, { first: true });
    await first;
    expect(workers[0]!.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it('invalidates pending observations and permits fresh reads only after the old worker stops', async () => {
    const { reader, workers, factory } = harness();
    const active = reader.read('snapshot');
    const queued = reader.read('control');
    const failures = Promise.all([expect(active).rejects.toThrow(/invalidated/), expect(queued).rejects.toThrow(/invalidated/)]);
    const termination = deferredTermination();
    workers[0]!.terminate.mockReturnValueOnce(termination.promise);
    const invalidated = reader.invalidate();
    await failures;
    const fresh = reader.read('snapshot');
    await flushMicrotasks();
    expect(factory).toHaveBeenCalledOnce();
    termination.resolve(0);
    await invalidated;
    workers[1]!.result(0, { fresh: true });
    await expect(fresh).resolves.toEqual({ fresh: true });
  });

  it('closes idempotently, rejects all pending reads, and never restarts after close', async () => {
    const { reader, workers, factory } = harness();
    const active = reader.read('snapshot');
    const queued = reader.read('control');
    const failures = Promise.all([
      expect(active).rejects.toMatchObject({ code: 'READ_PROJECTION_CLOSED' }),
      expect(queued).rejects.toMatchObject({ code: 'READ_PROJECTION_CLOSED' }),
    ]);
    await reader.close();
    await failures;
    await reader.close();
    workers[0]!.result(0, { obsolete: true });
    await expect(reader.read('snapshot')).rejects.toMatchObject({ code: 'READ_PROJECTION_CLOSED' });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  it('fails closed if worker termination rejects instead of starting an overlapping worker', async () => {
    const { reader, workers, factory } = harness();
    const active = reader.read('snapshot');
    const failure = expect(active).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' });
    const termination = deferredTermination();
    workers[0]!.terminate.mockReturnValueOnce(termination.promise);
    workers[0]!.emit('error', new Error('test worker failure'));
    await failure;
    const waiting = reader.read('control');
    const stopped = expect(waiting).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' });
    termination.reject(new Error('test failed termination'));
    await stopped;
    await expect(reader.read('snapshot')).rejects.toMatchObject({ code: 'READ_PROJECTION_CLOSED' });
    expect(factory).toHaveBeenCalledOnce();
  });
});
