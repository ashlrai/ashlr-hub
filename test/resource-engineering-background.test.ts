/** Effectful-worker transport lifecycle only; no actual worker, ledger or provider. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineeringBackground } from '../src/core/resources/engineering-background-types.js';
import type { createEngineeringBackground as Create } from '../src/core/resources/engineering-background.js';

const fixture = vi.hoisted(() => ({ workers: [] as Array<{ emit(event: string, value?: unknown): boolean;
  messages: Array<{ type: string; id: number; kind: string; input: unknown }>;
  terminate: ReturnType<typeof vi.fn>; closeFlag: Int32Array }> }));
const reader = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock('../src/core/resources/engineering-successor-reader.js', () => ({ createEngineeringSuccessorReader: reader.create }));
vi.mock('node:worker_threads', async original => {
  const actual = await original<typeof import('node:worker_threads')>();
  const { EventEmitter } = await import('node:events');
  return { ...actual, Worker: class extends EventEmitter {
    messages: Array<{ type: string; id: number; kind: string; input: unknown }> = [];
    closeFlag: Int32Array;
    terminate = vi.fn(async () => { this.emit('exit', 0); return 0; });
    constructor(_url: unknown, options: { workerData: { closeBuffer: SharedArrayBuffer } }) {
      super(); this.closeFlag = new Int32Array(options.workerData.closeBuffer); fixture.workers.push(this);
    }
    postMessage(message: { type: string; id: number; kind: string; input: unknown }) {
      this.messages.push(message);
      if (message.kind === 'initialize') queueMicrotask(() => this.emit('message', { type: 'engineering-result', id: message.id, ok: true, value: null }));
    }
  } };
});
import { createEngineeringBackground } from '../src/core/resources/engineering-background.js';

function input() {
  return { preparation: { configFile: '/private/preparation.json', root: '/private/resources', workspace: '/private/repo',
    projectsFile: '/private/projects.json', poolFile: '/private/pool.json', bindingsFile: '/private/bindings.json',
    observationsFile: '/private/observations.json', config: { schemaVersion: 1, outputRoot: '/private/output', profiles: [] } },
  owner: { catalog: vi.fn(() => []), snapshot: vi.fn(), checkRegistration: vi.fn(), register: vi.fn() },
  supervisor: { projectFileBinding: vi.fn(), projectExecutionBinding: vi.fn() }, isClosing: () => false, onFault: vi.fn(),
  } as unknown as Parameters<typeof Create>[0];
}
function reply(worker: typeof fixture.workers[number], kind: string, value: unknown = null) {
  const message = worker.messages.findLast(message => message.kind === kind)!;
  expect(message).toBeDefined(); worker.emit('message', { type: 'engineering-result', id: message.id, ok: true, value });
}
afterEach(() => { fixture.workers.splice(0); vi.clearAllMocks(); reader.read.mockReset(); reader.create.mockReset(); });
function journal() {
  const config = { schemaVersion: 1, supervisionId: 'automatic', profileId: 'improve', allowedWorkerIds: ['local'],
    maxOutputTokens: 200, proposalTimeoutMs: 5000, maxSuccessors: 2, pollIntervalMs: 100 };
  return { directory: '/private/resources/engineering-successors/automatic', config,
    expectedEnrollment: { configDigest: 'a'.repeat(64), deadlineAt: '2099-01-01T00:00:00.000Z' } };
}
function sample() {
  return { snapshot: { schemaVersion: 1, supervisionId: 'automatic', profileId: 'improve', configDigest: 'a'.repeat(64),
    deadlineAt: '2099-01-01T00:00:00.000Z', state: 'observing', maxSuccessors: 2, entries: [] },
    sampledAt: '2026-09-11T00:00:00.000Z', recordsDigest: 'b'.repeat(64) };
}
async function configure(background: EngineeringBackground, supervision = { snapshot: vi.fn(), admit: vi.fn(), isExecutionStopped: () => false }, initialReport?: unknown) {
  reader.create.mockReturnValue(reader); reader.read.mockResolvedValue(sample()); reader.close.mockResolvedValue(undefined);
  const scope = journal();
  const configured = background.configureSuccessors({ root: '/private/resources', configFile: '/private/successors.json',
    config: scope.config } as Parameters<EngineeringBackground['configureSuccessors']>[0],
    supervision as unknown as Parameters<EngineeringBackground['configureSuccessors']>[1], () => ({ observations: [], unavailableWorkerIds: [] }));
  if (initialReport) fixture.workers[0]!.emit('message', { type: 'engineering-coordinator-observation', report: initialReport });
  reply(fixture.workers[0]!, 'configure-successors', scope); await configured;
}
function lifecycle(sequence = 1) {
  return { schemaVersion: 1, supervisionId: 'automatic', configDigest: 'a'.repeat(64),
    deadlineAt: '2099-01-01T00:00:00.000Z', sequence, reportedAt: '2026-09-10T23:59:59.000Z', state: 'idle', reason: null };
}

describe('engineering background ownership and drain protocol', () => {
  it('carries automatic preparation and pending reads without enabling a successor coordinator', async () => {
    const background = await createEngineeringBackground(input()); const worker = fixture.workers[0]!;
    const binding = { schemaVersion: 1 as const, supervisionId: 'automatic', configDigest: 'a'.repeat(64), deadlineAt: '2099-01-01T00:00:00.000Z' };
    const request = { id: 'first' }; const original = { ...binding };
    const prepared = background.prepareAutomatically(request, binding); binding.configDigest = 'b'.repeat(64); request.id = 'mutated';
    expect(worker.messages.at(-1)).toMatchObject({ kind: 'prepare-automatically', input: { input: { id: 'first' }, binding: original } });
    reply(worker, 'prepare-automatically', { disposition: 'created' }); await prepared;
    const read = background.pendingAutomaticAdmissions(original, [], 'first');
    expect(worker.messages.at(-1)).toMatchObject({ kind: 'pending-automatic-admissions', input: { binding: original, admitted: [], preferred: 'first' } });
    reply(worker, 'pending-automatic-admissions', []); expect(await read).toEqual([]);
    expect(worker.messages.some(message => message.kind === 'configure-successors' || message.kind === 'start')).toBe(false);
    const closing = background.close(); reply(worker, 'close'); await closing;
    await expect(background.pendingAutomaticAdmissions(original, [])).rejects.toThrow('unavailable');
  });
  it.each([
    ['faulted', 'coordinator-loop-failed'], ['waiting', 'proposal-workers-ineligible'], ['waiting', 'proposal-admission-unavailable'],
  ])('pins pre-configuration lifecycle and keeps %s/%s report time separate from fresh journal reads', async (state, reason) => {
    const options = input(); const background = await createEngineeringBackground(options); const worker = fixture.workers[0]!;
    await configure(background, undefined, lifecycle());
    const first = await background.snapshot(); expect(first.observation?.coordinator).toEqual(lifecycle());
    first.observation!.coordinator!.state = 'closed';
    const failed = { ...lifecycle(2), state, reason };
    worker.emit('message', { type: 'engineering-coordinator-observation', report: failed });
    reader.read.mockResolvedValueOnce({ ...sample(), sampledAt: '2026-09-11T00:01:00.000Z' });
    const second = await background.snapshot();
    expect(second.observation).toMatchObject({ workerState: 'connected', sampledAt: '2026-09-11T00:01:00.000Z', coordinator: failed });
    expect(options.onFault).not.toHaveBeenCalled(); expect(Atomics.load(worker.closeFlag, 0)).toBe(0);
    const check = background.check({}); reply(worker, 'check', { valid: true }); await expect(check).resolves.toEqual({ valid: true });
    const closing = background.close(); reply(worker, 'close'); await closing;
  });
  it('discards an initial report not bound to the verified initialization scope', async () => {
    const options = input(); const background = await createEngineeringBackground(options); const worker = fixture.workers[0]!;
    await configure(background, undefined, { ...lifecycle(), configDigest: 'f'.repeat(64) });
    expect((await background.snapshot()).observation?.coordinator).toBeNull();
    worker.emit('message', { type: 'engineering-coordinator-observation', report: lifecycle(2) });
    expect((await background.snapshot()).observation?.coordinator).toEqual(lifecycle(2));
    expect(options.onFault).not.toHaveBeenCalled();
    const closing = background.close(); reply(worker, 'close'); await closing;
  });
  it('ignores malformed, stale and misbound telemetry without renewing or closing execution', async () => {
    const options = input(); const background = await createEngineeringBackground(options); const worker = fixture.workers[0]!;
    await configure(background, undefined, lifecycle(4));
    const invalid = [null, { ...lifecycle(5), extra: '/private/secret' }, { ...lifecycle(5), state: 'paused' },
      { ...lifecycle(5), state: 'running', reason: 'signal-aborted' }, { ...lifecycle(5), reason: 'private-error' },
      { ...lifecycle(5), configDigest: 'f'.repeat(64) }, { ...lifecycle(5), supervisionId: 'other' },
      { ...lifecycle(5), deadlineAt: '2098-01-01T00:00:00.000Z' }, { ...lifecycle(5), reportedAt: 'yesterday' },
      { ...lifecycle(5), sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...lifecycle(5), sequence: 0 },
      { ...lifecycle(4), state: 'running' }, { ...lifecycle(3), state: 'closed' }];
    for (const report of invalid) {
      worker.emit('message', { type: 'engineering-coordinator-observation', report });
      expect((await background.snapshot()).observation?.coordinator).toEqual(lifecycle(4));
    }
    // Sequence, not wall time, orders the one live worker's reports.
    const next = { ...lifecycle(5), reportedAt: '2026-09-10T23:58:00.000Z', state: 'running' };
    worker.emit('message', { type: 'engineering-coordinator-observation', report: next });
    expect((await background.snapshot()).observation?.coordinator).toEqual(next);
    expect(options.onFault).not.toHaveBeenCalled(); expect(Atomics.load(worker.closeFlag, 0)).toBe(0);
    const closing = background.close(); reply(worker, 'close'); await closing;
  });
  it('sets close immediately but never terminates before acknowledged drain', async () => {
    const background = await createEngineeringBackground(input()); const worker = fixture.workers[0]!;
    const close = background.close(); expect(Atomics.load(worker.closeFlag, 0)).toBe(1);
    expect(worker.terminate).not.toHaveBeenCalled(); expect(background.close()).toBe(close);
    await expect(background.check({})).rejects.toThrow('unavailable');
    reply(worker, 'close'); await close; expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('fences registration before a pending recovery read drains, without claiming an uncertain mutation', async () => {
    const options = input(); const background = await createEngineeringBackground(options); const worker = fixture.workers[0]!;
    const binding = { schemaVersion: 1 as const, supervisionId: 'automatic', configDigest: 'a'.repeat(64), deadlineAt: '2099-01-01T00:00:00.000Z' };
    const read = background.pendingAutomaticAdmissions(binding, []); const readFailed = expect(read).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const closing = background.close();
    const response = new SharedArrayBuffer(16 + 4096); const header = new Int32Array(response, 0, 4); header[2] = 1;
    worker.emit('message', { type: 'engineering-host-call', id: 1, method: 'owner.register', inputJson: JSON.stringify([{ schemaVersion: 1, enrollments: [] }]), response });
    const refused = JSON.parse(new TextDecoder().decode(new Uint8Array(response, 16, Atomics.load(header, 1))));
    expect(refused).toEqual({ ok: false, code: 'CLOSED', uncertain: false });
    expect(options.owner.register).not.toHaveBeenCalled(); expect(options.onFault).not.toHaveBeenCalled(); expect(worker.terminate).not.toHaveBeenCalled();
    const message = worker.messages.find(value => value.kind === 'pending-automatic-admissions')!;
    worker.emit('message', { type: 'engineering-result', id: message.id, ok: false, code: 'UNAVAILABLE' }); await readFailed;
    reply(worker, 'close'); await closing; expect(worker.terminate).toHaveBeenCalledOnce(); expect(options.onFault).not.toHaveBeenCalled();
  });
  it('drains a live protocol-faulted worker and preserves uncertainty after cleanup', async () => {
    const options = input(); const background = await createEngineeringBackground(options); const worker = fixture.workers[0]!;
    worker.emit('message', { unexpected: true }); expect(options.onFault).toHaveBeenCalledTimes(1);
    const close = background.close(); const result = expect(close).rejects.toThrow('unavailable');
    expect(worker.messages.at(-1)?.kind).toBe('close'); expect(worker.terminate).not.toHaveBeenCalled();
    reply(worker, 'close'); await result; expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('rejects cleanup if a previously faulted worker exits before its drain reply', async () => {
    const options = input(); const background = await createEngineeringBackground(options); const worker = fixture.workers[0]!;
    worker.emit('message', { unexpected: true });
    const close = background.close(); const result = expect(close).rejects.toThrow('unavailable');
    worker.emit('exit', 1); await result;
    expect(options.onFault).toHaveBeenCalledTimes(1); expect(worker.terminate).not.toHaveBeenCalled();
  });
  it('rejects all pending calls on unexpected exit, without replacing the worker', async () => {
    const options = input(); const background = await createEngineeringBackground(options); const worker = fixture.workers[0]!;
    const call = background.prepare({ id: 'one' }); const result = expect(call).rejects.toThrow('unavailable');
    worker.emit('exit', 1); await result; await expect(background.close()).rejects.toThrow('unavailable');
    expect(fixture.workers).toHaveLength(1); expect(worker.terminate).not.toHaveBeenCalled();
  });
  it('bounds pending commands and allows the distinct close request through the full queue', async () => {
    const background: EngineeringBackground = await createEngineeringBackground(input()); const worker = fixture.workers[0]!;
    const reads = Array.from({ length: 8 }, () => background.check({}).catch(() => null));
    await expect(background.check({})).rejects.toThrow('unavailable');
    const closing = background.close();
    for (const message of worker.messages.filter(message => message.kind === 'check')) worker.emit('message', {
      type: 'engineering-result', id: message.id, ok: false, code: 'UNAVAILABLE',
    });
    reply(worker, 'close'); await closing; await Promise.all(reads);
    expect(worker.messages.filter(message => message.kind === 'check')).toHaveLength(8);
  });
  it('vetoes automatic admission while paused and forwards one exact CAS without retry', async () => {
    const background = await createEngineeringBackground(input()); const worker = fixture.workers[0]!;
    let paused = true;
    const admit = vi.fn((request: unknown) => request);
    const supervision = { snapshot: vi.fn(), admit, isExecutionStopped: () => paused };
    await configure(background, supervision);
    const request = { expectedRevision: 7, enrollments: [{ enrollmentId: 'next', expectedEnrollmentDigest: 'a'.repeat(64) }] };
    let id = 0;
    const invoke = () => {
      const response = new SharedArrayBuffer(16 + 4096); const header = new Int32Array(response, 0, 4);
      header[2] = ++id;
      worker.emit('message', { type: 'engineering-host-call', id, method: 'supervision.admit', inputJson: JSON.stringify([request]), response });
      return JSON.parse(new TextDecoder().decode(new Uint8Array(response, 16, Atomics.load(header, 1))));
    };
    expect(invoke().ok).toBe(false); expect(admit).not.toHaveBeenCalled();
    paused = false; expect(invoke()).toEqual({ ok: true, value: request });
    expect(admit).toHaveBeenCalledExactlyOnceWith(request);
    admit.mockImplementationOnce(() => { throw new Error('stale revision'); });
    expect(invoke().ok).toBe(false); expect(admit).toHaveBeenCalledTimes(2);
    expect(admit.mock.calls[1]).toEqual([request]);
    const closing = background.close(); reply(worker, 'close'); await closing;
  });
  it('prewarms once and uses a fresh independent read for each observation', async () => {
    const background = await createEngineeringBackground(input()); const worker = fixture.workers[0]!;
    await configure(background); expect(reader.read).toHaveBeenCalledTimes(1);
    const pending = background.prepare({ id: 'one' });
    const first = await background.snapshot(); expect(first.observation).toMatchObject({ kind: 'durable-journal', workerState: 'connected' });
    reader.read.mockResolvedValueOnce({ ...sample(), recordsDigest: 'c'.repeat(64) });
    expect((await background.snapshot()).observation?.recordsDigest).toBe('c'.repeat(64));
    expect(reader.read).toHaveBeenCalledTimes(3);
    expect(worker.messages.some(row => row.kind === 'snapshot')).toBe(false);
    reply(worker, 'prepare', {}); await pending;
    const closing = background.close(); reply(worker, 'close'); await closing; expect(reader.close).toHaveBeenCalledTimes(1);
  });
  it.each(['exit', 'fault', 'close'])('rejects a late journal response after worker %s', async event => {
    const background = await createEngineeringBackground(input()); const worker = fixture.workers[0]!;
    await configure(background);
    let finish!: (value: unknown) => void;
    reader.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const observation = background.snapshot(); const rejection = expect(observation).rejects.toThrow('unavailable');
    let closing: Promise<void> | undefined;
    if (event === 'exit') worker.emit('exit', 1);
    else if (event === 'fault') worker.emit('message', { unexpected: true });
    else closing = background.close();
    finish(sample()); await rejection;
    if (event === 'exit') await expect(background.close()).rejects.toThrow('unavailable');
    else { closing ??= background.close(); const outcome = event === 'fault' ? expect(closing).rejects.toThrow('unavailable') : closing;
      reply(worker, 'close'); await outcome; }
  });
  it('drains an initialization interrupted by the parent signal without starting successors', async () => {
    const signal = new AbortController(); const options = { ...input(), signal: signal.signal };
    const creation = createEngineeringBackground(options); const rejected = expect(creation).rejects.toThrow('unavailable');
    const worker = fixture.workers[0]!; signal.abort(); reply(worker, 'close'); await rejected;
    expect(worker.messages.map(row => row.kind)).toEqual(['initialize', 'close']);
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(options.onFault).not.toHaveBeenCalled();
  });
});
