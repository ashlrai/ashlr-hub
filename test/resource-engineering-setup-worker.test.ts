/** Protocol doubles only; real materialization is covered by autonomous-setup tests. */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ workers: [] as Array<{ emit(name: string, value?: unknown): boolean; terminate: ReturnType<typeof vi.fn> }>,
  handlers: {} as Record<string, (input: unknown) => unknown>, flag: undefined as Int32Array | undefined }));
vi.mock('node:worker_threads', async original => ({ ...await original<typeof import('node:worker_threads')>(),
  Worker: class extends EventEmitter {
    terminate = vi.fn();
    constructor() { super(); state.workers.push(this); }
  },
}));
vi.mock('../src/core/resources/engineering-worker-rpc.js', () => ({
  createEngineeringWorkerRpcHost: (options: { closeFlag: Int32Array; handlers: typeof state.handlers }) => {
    state.handlers = options.handlers; state.flag = options.closeFlag;
    return { handle: () => false, close: () => { Atomics.store(options.closeFlag, 0, 1); } };
  },
}));
import { prepareEngineeringMissionSetup, type EngineeringSetupRequest } from '../src/core/resources/engineering-setup.js';
import { createWorkerSetupExecutionContext, setupRequestDigest, takeWorkerSetupExecutionContext } from '../src/core/resources/engineering-setup-context.js';
const request = { input: { expectedPlanDigest: 'a'.repeat(64), output: '/fixture/output' } } as EngineeringSetupRequest;
const result = { schemaVersion: 1, status: 'prepared', scope: 'local-autonomous-setup-only', disposition: 'created',
  planDigest: 'a'.repeat(64), initialEnrollmentDigest: 'b'.repeat(64), output: '/fixture/output', executionStarted: false, providerContacted: false };
const lifetime = () => ({ deadlineAt: new Date(Date.now() + 60_000).toISOString() });
const success = () => ({ type: 'engineering-setup-result', ok: true, value: result });
beforeEach(() => { state.workers.length = 0; state.handlers = {}; state.flag = undefined; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('cooperative setup worker lifecycle', () => {
  it('monitors a received result until exit, then stops polling on failure without forcing cleanup', async () => {
    vi.useFakeTimers(); let stopped = false; let finished = false;
    const veto = vi.fn(() => stopped);
    const run = prepareEngineeringMissionSetup(request, { lifetime: { ...lifetime(), isExecutionStopped: veto } })
      .finally(() => { finished = true; });
    const rejection = expect(run).rejects.toThrow('Engineering setup');
    state.handlers['setup.authorize']!(setupRequestDigest(request));
    const worker = state.workers[0]!; worker.emit('message', success());
    expect(vi.getTimerCount()).toBe(1);
    const before = veto.mock.calls.length;
    vi.advanceTimersByTime(25); expect(veto).toHaveBeenCalledTimes(before + 1);
    stopped = true; vi.advanceTimersByTime(25);
    expect(vi.getTimerCount()).toBe(0); expect(Atomics.load(state.flag!, 0)).toBe(1);
    const failedCalls = veto.mock.calls.length;
    stopped = false; vi.advanceTimersByTime(1000); await Promise.resolve();
    expect(veto).toHaveBeenCalledTimes(failedCalls); expect(finished).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
    // Recovery of the sampled condition cannot clear the recorded failure.
    worker.emit('exit', 0); await rejection;
    expect(worker.terminate).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('requires the pinned one-use authorization and natural worker exit before returning', async () => {
    let finished = false;
    const run = prepareEngineeringMissionSetup(request, { lifetime: lifetime() }).then(value => { finished = true; return value; });
    expect(() => state.handlers['setup.authorize']!('wrong')).toThrow();
    expect(state.handlers['setup.authorize']!(setupRequestDigest(request))).toEqual({ hasCustody: false });
    expect(() => state.handlers['setup.authorize']!(setupRequestDigest(request))).toThrow();
    expect(state.handlers['setup.active']!(null)).toBe(true);
    state.workers[0]!.emit('message', success()); await Promise.resolve();
    expect(finished).toBe(false); expect(state.workers[0]!.terminate).not.toHaveBeenCalled();
    state.workers[0]!.emit('exit', 0); expect(await run).toEqual(result);
  });
  it.each(['abort', 'veto', 'deadline'] as const)('waits for cleanup on %s without forcing termination or accepting late success', async mode => {
    const controller = new AbortController(); let stopped = false, finished = false;
    const run = prepareEngineeringMissionSetup(request, { lifetime: { deadlineAt: new Date(Date.now() + (mode === 'deadline' ? 40 : 60_000)).toISOString(),
      signal: controller.signal, isExecutionStopped: () => stopped } }).finally(() => { finished = true; });
    const rejection = expect(run).rejects.toThrow('Engineering setup');
    state.handlers['setup.authorize']!(setupRequestDigest(request));
    if (mode === 'abort') controller.abort(); if (mode === 'veto') stopped = true;
    await vi.waitFor(() => expect(Atomics.load(state.flag!, 0)).toBe(1));
    expect(finished).toBe(false); expect(state.workers[0]!.terminate).not.toHaveBeenCalled();
    state.workers[0]!.emit('message', success()); state.workers[0]!.emit('exit', 0); await rejection;
    expect(state.workers).toHaveLength(1);
  });
  it.each(['error', 'missing', 'malformed', 'unapproved', 'wrong-output', 'wrong-plan', 'missing-enrollment', 'duplicate', 'cleanup'] as const)(
    'retains %s failure until exit without retrying effects', async mode => {
      const run = prepareEngineeringMissionSetup(request, { lifetime: lifetime() }); const rejection = expect(run).rejects.toThrow('Engineering');
      const worker = state.workers[0]!;
      if (mode !== 'unapproved') state.handlers['setup.authorize']!(setupRequestDigest(request));
      if (mode === 'error') worker.emit('error', Error('private detail'));
      else if (mode === 'cleanup') worker.emit('message', { type: 'engineering-setup-result', ok: false, reason: 'setup-cleanup-unconfirmed' });
      else if (mode !== 'missing') {
        const reply = success();
        if (mode === 'wrong-output') reply.value = { ...result, output: '/other' };
        if (mode === 'wrong-plan') reply.value = { ...result, planDigest: 'c'.repeat(64) };
        if (mode === 'missing-enrollment') reply.value = { ...result, initialEnrollmentDigest: '' };
        worker.emit('message', mode === 'malformed' ? { type: 'private-command' } : reply);
        if (mode === 'duplicate') worker.emit('message', reply);
      }
      expect(worker.terminate).not.toHaveBeenCalled(); worker.emit('exit', 0); await rejection;
      expect(state.workers).toHaveLength(1);
    });
  it('rechecks stop after a valid result but before natural exit', async () => {
    let stopped = false;
    const run = prepareEngineeringMissionSetup(request, { lifetime: { ...lifetime(), isExecutionStopped: () => stopped } });
    const rejection = expect(run).rejects.toThrow(); state.handlers['setup.authorize']!(setupRequestDigest(request));
    state.workers[0]!.emit('message', success()); stopped = true; state.workers[0]!.emit('exit', 0); await rejection;
  });
  it('refuses executable hosts, missing deadlines, and non-worker execution context before spawning', async () => {
    const getter = vi.fn();
    await expect(prepareEngineeringMissionSetup(request, { lifetime: {} })).rejects.toThrow();
    await expect(prepareEngineeringMissionSetup(request, { lifetime: lifetime(), get custody() { return getter(); } })).rejects.toThrow();
    expect(() => createWorkerSetupExecutionContext(request, { call: () => { throw Error(); }, isClosed: () => false })).toThrow('Unrecognized');
    expect(() => takeWorkerSetupExecutionContext({ kind: 'engineering-setup-worker' }, request.input)).toThrow('Unrecognized');
    expect(getter).not.toHaveBeenCalled(); expect(state.workers).toHaveLength(0);
  });
});
