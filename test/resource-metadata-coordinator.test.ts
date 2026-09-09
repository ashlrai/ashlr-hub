/** In-memory scheduling only; no provider, filesystem or credential contact. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeMetadataCoordinator, type NativeMetadataCoordinator } from '../src/core/resources/metadata-coordinator.js';

const coordinators: NativeMetadataCoordinator[] = [];
afterEach(() => { for (const coordinator of coordinators.splice(0)) coordinator.dispose(); vi.restoreAllMocks(); });
function create(options: Parameters<typeof createNativeMetadataCoordinator>[0] = {}) {
  const coordinator = createNativeMetadataCoordinator(options); coordinators.push(coordinator); return coordinator;
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
async function flush(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe('shared native metadata coordinator', () => {
  it('passes each concurrent operation its own durable lifecycle without invoking it', async () => {
    const hooks = [0, 1].map(() => ({ prepare: vi.fn() }));
    const settled: number[] = []; let id = 0;
    const coordinator = create({ beginNativeActivity: () => {
      const index = id++;
      return { processGroupLifecycle: hooks[index], settle: () => { settled.push(index); } };
    } });
    const first = deferred<number>(); const second = deferred<number>();
    const operations = [first, second].map((gate, index) => coordinator.run(async (hook) => {
      expect(hook).toBe(hooks[index]); return gate.promise;
    }, () => true));
    await flush(); expect(id).toBe(2); expect(settled).toEqual([]);
    second.resolve(2); first.resolve(1);
    expect(await Promise.all(operations)).toEqual([1, 2]);
    expect(settled.sort()).toEqual([0, 1]);
    for (const hook of hooks) expect(hook.prepare).not.toHaveBeenCalled();
  });

  it('durably reserves before invoking and settles before admitting the next operation', async () => {
    const events: string[] = []; let nextId = 0;
    const coordinator = create({ maxConcurrent: 1, beginNativeActivity: () => {
      const id = ++nextId; events.push(`reserve-${id}`); return { settle: () => { events.push(`settle-${id}`); } };
    } });
    const run = (id: number) => coordinator.run(async () => { events.push(`invoke-${id}`); return id; }, () => true);
    expect(await Promise.all([run(1), run(2)])).toEqual([1, 2]);
    expect(events).toEqual(['reserve-1', 'invoke-1', 'settle-1', 'reserve-2', 'invoke-2', 'settle-2']);
  });

  it('requires a settlement predicate before reserving or invoking tracked work', async () => {
    const beginNativeActivity = vi.fn(() => ({ settle: vi.fn() }));
    const coordinator = create({ beginNativeActivity }); const operation = vi.fn(async () => 1);
    await expect(coordinator.run(operation)).rejects.toThrow('settlement predicate required');
    expect(beginNativeActivity).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled();
  });

  it.each(['reserve', 'settle', 'predicate', 'unconfirmed'] as const)('aborts tracked work after %s failure without launching a queued operation', async (failure) => {
    const settle = vi.fn(() => { if (failure === 'settle') throw new Error('Fixture settlement write failed'); });
    const beginNativeActivity = vi.fn(() => {
      if (failure === 'reserve') throw new Error('Fixture reservation write failed');
      return { settle };
    });
    const coordinator = create({ maxConcurrent: 1, beginNativeActivity });
    const operation = vi.fn(async () => 1); const queued = vi.fn(async () => 2);
    const first = coordinator.run(operation, () => {
      if (failure === 'predicate') throw new Error('Fixture predicate failure');
      return failure !== 'unconfirmed';
    });
    const second = coordinator.run(queued, () => true);
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(coordinator.signal.aborted).toBe(true); expect(queued).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledTimes(failure === 'reserve' ? 0 : 1);
    expect(settle).toHaveBeenCalledTimes(failure === 'settle' ? 1 : 0);
  });

  it('settles a clean active peer after abort but retains the rejected operation reservation', async () => {
    const settled: number[] = []; let nextId = 0;
    const coordinator = create({ beginNativeActivity: () => {
      const id = ++nextId; return { settle: () => { settled.push(id); } };
    } });
    const first = deferred<number>(); const peer = deferred<number>();
    const outcomes = Promise.allSettled([coordinator.run(() => first.promise, () => true),
      coordinator.run(() => peer.promise, () => true)]);
    await flush(); first.reject(new Error('Fixture missing cleanup')); await flush();
    expect(coordinator.signal.aborted).toBe(true); expect(settled).toEqual([]);
    peer.resolve(2); const results = await outcomes;
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(settled).toEqual([2]);
  });

  it('defaults to at most two active operations and serves queued work FIFO', async () => {
    const coordinator = create(); const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = []; let active = 0; let peak = 0;
    const results = gates.map((gate, index) => coordinator.run(async () => {
      started.push(index); active++; peak = Math.max(peak, active);
      try { return await gate.promise; } finally { active--; }
    }));
    await flush(); expect(started).toEqual([0, 1]); expect(peak).toBe(2);
    gates[1]!.resolve(1); await flush(); expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve(0); await flush(); expect(started).toEqual([0, 1, 2, 3]);
    gates[3]!.resolve(3); await flush(); expect(started).toEqual([0, 1, 2, 3, 4]);
    gates[2]!.resolve(2); gates[4]!.resolve(4);
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]); expect(peak).toBe(2);
  });

  it('allows a single shared permit', async () => {
    const coordinator = create({ maxConcurrent: 1 }); const gate = deferred<number>(); const second = vi.fn(async () => 2);
    const firstResult = coordinator.run(() => gate.promise); const secondResult = coordinator.run(second);
    await flush(); expect(second).not.toHaveBeenCalled(); gate.resolve(1);
    expect(await Promise.all([firstResult, secondResult])).toEqual([1, 2]);
  });

  it.each([0, -1, 3, 1.5, NaN, Infinity])('rejects invalid concurrency %s', (maxConcurrent) => {
    expect(() => create({ maxConcurrent })).toThrow('Invalid native metadata coordinator configuration');
  });

  it('never invokes an operation when the upstream signal was already aborted', async () => {
    const upstream = new AbortController(); upstream.abort('private reason');
    const coordinator = create({ signal: upstream.signal }); const operation = vi.fn(async () => 1);
    await expect(coordinator.run(operation)).rejects.toThrow('Native metadata collection cancelled');
    expect(operation).not.toHaveBeenCalled(); expect(coordinator.signal.aborted).toBe(true);
  });

  it('never invokes an operation aborted after permit grant but before callback invocation', async () => {
    const coordinator = create(); const operation = vi.fn(async () => 1);
    const result = coordinator.run(operation); coordinator.abort();
    await expect(result).rejects.toThrow('Native metadata collection cancelled'); expect(operation).not.toHaveBeenCalled();
  });

  it('rejects queued work but awaits active settlement rather than claiming cleanup on abort', async () => {
    const upstream = new AbortController(); const coordinator = create({ signal: upstream.signal, maxConcurrent: 1 });
    const gate = deferred<number>(); const queuedOperation = vi.fn(async () => 2); const settled = vi.fn();
    const active = coordinator.run(() => gate.promise); void active.then(settled);
    const queued = coordinator.run(queuedOperation);
    const queuedCheck = expect(queued).rejects.toThrow('Native metadata collection cancelled');
    await flush(); upstream.abort(); await queuedCheck; await flush();
    expect(coordinator.signal.aborted).toBe(true); expect(settled).not.toHaveBeenCalled();
    expect(queuedOperation).not.toHaveBeenCalled(); gate.resolve(1); expect(await active).toBe(1);
    await expect(coordinator.run(queuedOperation)).rejects.toThrow('Native metadata collection cancelled');
    expect(queuedOperation).not.toHaveBeenCalled();
  });

  it('aborts before releasing a synchronously throwing callback permit', async () => {
    const coordinator = create({ maxConcurrent: 1 }); const error = new Error('operation failed');
    const queuedOperation = vi.fn(async () => 2);
    const first = coordinator.run(() => { throw error; }); const next = coordinator.run(queuedOperation);
    const queuedCheck = expect(next).rejects.toThrow('Native metadata collection cancelled');
    await expect(first).rejects.toBe(error); await queuedCheck;
    expect(coordinator.signal.aborted).toBe(true); expect(queuedOperation).not.toHaveBeenCalled();
    await expect(coordinator.run(queuedOperation)).rejects.toThrow('Native metadata collection cancelled');
    expect(queuedOperation).not.toHaveBeenCalled();
  });

  it('rejects queued work after callback rejection without an orphaned rejection', async () => {
    const coordinator = create({ maxConcurrent: 1 }); const gate = deferred<number>(); const error = new Error('callback failed');
    const first = coordinator.run(() => gate.promise); const check = expect(first).rejects.toBe(error);
    const queuedOperation = vi.fn(async () => 2); const next = coordinator.run(queuedOperation);
    const queuedCheck = expect(next).rejects.toThrow('Native metadata collection cancelled');
    await flush(); gate.reject(error); await check; await queuedCheck;
    expect(coordinator.signal.aborted).toBe(true); expect(queuedOperation).not.toHaveBeenCalled();
  });

  it('cancels an in-flight peer without settling its result before cleanup', async () => {
    const coordinator = create(); const failedGate = deferred<number>(); const cleanupGate = deferred<number>();
    const error = new Error('unexpected transport rejection'); const cancelled = vi.fn(); const peerSettled = vi.fn();
    const first = coordinator.run(() => failedGate.promise); const firstCheck = expect(first).rejects.toBe(error);
    const peer = coordinator.run(async () => {
      coordinator.signal.addEventListener('abort', cancelled, { once: true });
      return cleanupGate.promise;
    });
    void peer.then(peerSettled);
    const queuedOperation = vi.fn(async () => 3); const queued = coordinator.run(queuedOperation);
    const queuedCheck = expect(queued).rejects.toThrow('Native metadata collection cancelled');
    await flush(); failedGate.reject(error); await firstCheck; await queuedCheck; await flush();
    expect(cancelled).toHaveBeenCalledTimes(1); expect(peerSettled).not.toHaveBeenCalled();
    expect(queuedOperation).not.toHaveBeenCalled();
    await expect(coordinator.run(queuedOperation)).rejects.toThrow('Native metadata collection cancelled');
    cleanupGate.resolve(2); expect(await peer).toBe(2); await flush();
    expect(peerSettled).toHaveBeenCalledTimes(1); expect(queuedOperation).not.toHaveBeenCalled();
  });

  it('leaves successfully returned result classification to the caller', async () => {
    const coordinator = create({ maxConcurrent: 1 }); const result = { status: 'failed' };
    const first = coordinator.run(async () => result); const next = coordinator.run(async () => 2);
    expect(await first).toBe(result); expect(await next).toBe(2); expect(coordinator.signal.aborted).toBe(false);
  });

  it('disposes idempotently and removes the upstream listener', async () => {
    const upstream = new AbortController(); const remove = vi.spyOn(upstream.signal, 'removeEventListener');
    const coordinator = create({ signal: upstream.signal }); const operation = vi.fn(async () => 1);
    coordinator.dispose(); coordinator.dispose(); coordinator.abort();
    expect(remove).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(coordinator.signal.aborted).toBe(true);
    await expect(coordinator.run(operation)).rejects.toThrow('Native metadata collection cancelled');
    expect(operation).not.toHaveBeenCalled();
  });

  it('disposal rejects pending work while an active rejection still propagates normally', async () => {
    const coordinator = create({ maxConcurrent: 1 }); const gate = deferred<number>(); const error = new Error('cleanup failed');
    const active = coordinator.run(() => gate.promise); const activeCheck = expect(active).rejects.toBe(error);
    const queued = coordinator.run(async () => 2); const queuedCheck = expect(queued).rejects.toThrow('Native metadata collection cancelled');
    await flush(); coordinator.dispose(); await queuedCheck; gate.reject(error); await activeCheck;
  });
});
