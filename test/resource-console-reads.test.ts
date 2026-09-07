import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceConsoleReader, normalizeResourceConsoleRead, validateResourceConsolePath,
  validateResourceConsoleReadScope, unavailableManagedResourceWorkers, withholdResourceConsoleWorkers,
  type ResourceConsoleReader, type ResourceConsoleReadScope, type ResourceConsoleManagedRead } from '../src/core/web/resource-console-reads.js';
import { degradedResourceConsoleEvidence, MAX_RESOURCE_CONSOLE_RESPONSE_BYTES, projectResourceConsoleEvidence,
  validateResourceConsoleResponse } from '../src/core/web/resource-console-public.js';
import type { ReadProjectionWorkerHandle } from '../src/core/web/bounded-read-worker.js';
import { planResourceAssignment, type ResourceObservation } from '../src/core/resources/pool-policy.js';

const forbidden = vi.hoisted(() => ({ read: vi.fn(), status: vi.fn(), run: vi.fn(), config: vi.fn() }));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: forbidden.read, resourcePoolStatus: forbidden.status,
  runResourceTask: forbidden.run }));
vi.mock('../src/core/config.js', () => ({ loadConfig: forbidden.config }));
const scope: ResourceConsoleReadScope = { root: '/private/tmp/resource-reader-root', observationsFile: '/private/tmp/resource-observations.json',
  pool: { schemaVersion: 1, id: 'pool', workers: [{ id: 'local', provider: 'local', model: 'model', maxConcurrent: 1,
    maxTasksPerWindow: 5, taskWindowMs: 60_000, reservePercent: 0, priority: 1 }] },
  bindings: [{ workerId: 'local', capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1' }] };
type Request = { id: number; kind: string; payload?: unknown };
class FakeWorker extends EventEmitter {
  requests: Request[] = [];
  postMessage = vi.fn((request: Request) => { this.requests.push(request); });
  terminate = vi.fn(async () => 0);
  result(index: number, value: unknown): void { this.emit('message', { type: 'result', id: this.requests[index]!.id, ok: true, value }); }
}
const readers: ResourceConsoleReader[] = [];
function harness(timeoutMs = 1000, selectedScope = scope) {
  const workers: FakeWorker[] = [];
  const factory = vi.fn((_entry: URL, _options: unknown): ReadProjectionWorkerHandle => {
    const worker = new FakeWorker(); workers.push(worker); return worker as unknown as ReadProjectionWorkerHandle;
  });
  const input = structuredClone(selectedScope);
  const reader = createResourceConsoleReader(input, { timeoutMs, _workerFactory: factory });
  readers.push(reader); return { reader, workers, factory, input };
}
const evidence = () => degradedResourceConsoleEvidence(scope.pool, scope.bindings, new Date().toISOString());
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.close();
  for (const call of Object.values(forbidden)) expect(call).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
});

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
function managedScope(): ResourceConsoleReadScope {
  const worker = { ...scope.pool.workers[0]!, provider: 'codex' as const, allowUnknownQuota: true };
  return { ...scope, pool: { ...scope.pool, workers: [{ ...worker, id: 'codex-a' }, { ...worker, id: 'codex-b' },
    { ...scope.pool.workers[0]!, id: 'local' }] }, bindings: [
    { workerId: 'codex-a', capacityKey: 'shared', kind: 'native-cli', command: ['/fixture/native-a'] },
    { workerId: 'codex-b', capacityKey: 'shared', kind: 'native-cli', command: ['/fixture/native-b'] },
    scope.bindings[0]!,
  ], managedWorkerIds: ['codex-a', 'codex-b'] };
}
function reading(workerId = 'codex-a', patch: Partial<ResourceObservation> = {}): ResourceObservation {
  return { workerId, observedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(), health: 'ready', retryAfter: null,
    windows: [{ id: 'codex_primary', usedPercent: 25, resetsAt: new Date(NOW + 90_000).toISOString() }], ...patch };
}
function managed(patch: Partial<ResourceConsoleManagedRead> = {}): ResourceConsoleManagedRead {
  return { observations: [reading(), reading('codex-b')], unavailableWorkerIds: [], ...patch };
}
function eligibleEvidence(selectedScope = managedScope()) {
  const observations = [...managed().observations, { ...reading('local'), windows: [] }];
  return projectResourceConsoleEvidence(selectedScope.pool, selectedScope.bindings,
    { schemaVersion: 1, sourceState: 'missing', poolId: selectedScope.pool.id, observations, attempts: [],
      plan: planResourceAssignment({ pool: selectedScope.pool, observations, allowedWorkerIds: selectedScope.pool.workers.map((row) => row.id),
        activeCounts: {}, taskReservationCounts: {}, nowMs: NOW }) });
}

describe('managed resource read payload boundary', () => {
  it('pins a dense all-alias scope and detaches managed data before serialization', () => {
    const suppliedScope = managedScope(); const pinned = validateResourceConsoleReadScope(suppliedScope);
    const payload = managed(); const normalized = normalizeResourceConsoleRead('snapshot', payload, pinned)!;
    payload.observations[0]!.windows[0]!.usedPercent = 99;
    payload.unavailableWorkerIds.push('codex-a'); suppliedScope.managedWorkerIds![0] = 'local';
    expect(normalized.observations[0]!.windows[0]!.usedPercent).toBe(25);
    expect(normalized.unavailableWorkerIds).toEqual([]); expect(pinned.managedWorkerIds).toEqual(['codex-a', 'codex-b']);
    expect(Object.isFrozen(normalized)).toBe(true); expect(Object.isFrozen(pinned.managedWorkerIds)).toBe(true);
  });

  it.each([new Array(1), [], ['codex-a'], ['codex-a', 'codex-a'], ['local'], ['unknown'], ['codex-a', 'codex-b', 'local']]
    .map((managedWorkerIds) => ({ managedWorkerIds })))(
    'rejects sparse, partial-alias or invalid managed scopes %#', ({ managedWorkerIds }) => {
      expect(() => validateResourceConsoleReadScope({ ...managedScope(), managedWorkerIds })).toThrow();
    });

  it('refuses scope accessors without invoking them', () => {
    const value = managedScope(); const getter = vi.fn(() => ['codex-a', 'codex-b']);
    Object.defineProperty(value, 'managedWorkerIds', { get: getter });
    expect(() => validateResourceConsoleReadScope(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, [], { observations: [] }, { observations: [], unavailableWorkerIds: new Array(1) },
    { observations: [], unavailableWorkerIds: ['unknown'] }, { observations: [], unavailableWorkerIds: ['local'] },
    { observations: [], unavailableWorkerIds: ['codex-a', 'codex-a'] },
    { observations: [reading('local')], unavailableWorkerIds: [] },
    { observations: [], unavailableWorkerIds: [], root: '/private/other' }])('rejects an unpaired or malformed managed request %#', (payload) => {
      expect(() => normalizeResourceConsoleRead('snapshot', payload, managedScope())).toThrow('Invalid resource console read');
    });

  it('does not execute payload getters, toJSON, array accessors or proxy traps', () => {
    const getter = vi.fn(() => []); const toJSON = vi.fn(() => ({})); const trap = vi.fn(() => Object.prototype);
    const values: unknown[] = [Object.defineProperty(managed(), 'observations', { get: getter }),
      Object.assign(managed(), { toJSON }), new Proxy(managed(), { getPrototypeOf: trap })];
    const array = ['codex-a']; Object.defineProperty(array, 0, { get: getter });
    values.push({ observations: [], unavailableWorkerIds: array });
    const nested = managed(); Object.defineProperty(nested.observations[0]!, 'windows', { get: getter }); values.push(nested);
    const inherited = Object.create({ toJSON }); Object.assign(inherited, managed()); values.push(inherited);
    for (const payload of values) expect(() => normalizeResourceConsoleRead('snapshot', payload, managedScope())).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
  });

  it('rejects cycles, symbols, oversized strings and non-plain data without serializing caller input', () => {
    const cyclic: any = managed(); cyclic.observations = [cyclic];
    const symbol = Object.assign(managed(), { [Symbol('private')]: true });
    const huge = managed(); huge.observations[0]!.workerId = 'x'.repeat(128 * 1024 + 1);
    for (const payload of [cyclic, symbol, huge, new Date(), { observations: [], unavailableWorkerIds: new Set() }]) {
      expect(() => normalizeResourceConsoleRead('snapshot', payload, managedScope())).toThrow();
    }
  });

  it('accepts the maximum declared 32-worker, 8-window bounded shape', () => {
    const definition = managedScope();
    definition.pool.workers = Array.from({ length: 32 }, (_, index) => ({ ...definition.pool.workers[0]!, id: `worker-${index}` }));
    definition.bindings = definition.pool.workers.map((worker) => ({ workerId: worker.id, capacityKey: worker.id,
      kind: 'native-cli', command: ['/fixture/never-called'] }));
    definition.managedWorkerIds = definition.pool.workers.map((worker) => worker.id);
    const payload = { observations: definition.managedWorkerIds.map((workerId) => reading(workerId, { windows:
      Array.from({ length: 8 }, (_, index) => ({ id: `window-${index}-${'x'.repeat(53)}`, usedPercent: 25,
        resetsAt: new Date(NOW + 90_000).toISOString() })) })), unavailableWorkerIds: [...definition.managedWorkerIds] };
    const result = normalizeResourceConsoleRead('snapshot', payload, validateResourceConsoleReadScope(definition))!;
    expect(result.observations).toHaveLength(32); expect(result.observations[0]!.windows).toHaveLength(8);
  });
});

describe('managed freshness across asynchronous IPC', () => {
  it.each([
    { observations: [] },
    { observations: [reading(), reading('codex-b', { health: 'unavailable' })] },
    { observations: [reading(), reading('codex-b', { updatedAt: new Date(NOW + 1).toISOString() })] },
    { observations: [reading(), reading('codex-b', { expiresAt: new Date(NOW).toISOString() })] },
    { observations: [reading(), reading('codex-b', { windows: [] })] },
    { observations: [reading(), reading('codex-b', { windows: [{ id: 'quota', usedPercent: null, resetsAt: null }] })] },
  ])('keeps every missing, unavailable or unknown managed alias gated %#', (patch) => {
    expect(unavailableManagedResourceWorkers(managedScope(), managed(patch), NOW)).toContain('codex-b');
  });

  it('only removes candidates and preserves original evidence while withholding the entire shared capacity', () => {
    const original = eligibleEvidence(); const before = JSON.stringify(original);
    const result = withholdResourceConsoleWorkers(original, ['codex-b']);
    expect(result.plan?.candidates.map((row) => row.workerId)).toEqual(['local']);
    expect(result.plan?.selectedWorkerId).toBe('local');
    for (const id of ['codex-a', 'codex-b']) expect(result.plan?.exclusions.find((row) => row.workerId === id)).toEqual({
      workerId: id, reasons: ['worker-unavailable'], nextEligibleAt: null });
    expect(result.observations).toBe(original.observations); expect(result.counts).toBe(original.counts);
    expect(result.sampledAt).toBe(original.sampledAt); expect(JSON.stringify(original)).toBe(before);
    expect(validateResourceConsoleResponse(JSON.stringify(result), managedScope().pool, managedScope().bindings)).toEqual(result);
    expect(withholdResourceConsoleWorkers(result, ['codex-b'])).toEqual(result);
  });

  it.each([new Array(1), ['unknown'], ['codex-a', 'codex-a']].map((ids) => ({ ids })))('rejects invalid public veto ID arrays %#', ({ ids }) => {
    expect(() => withholdResourceConsoleWorkers(eligibleEvidence(), ids)).toThrow();
  });

  it('rechecks expiration after the worker reply even when that reply was eligible when sampled', async () => {
    vi.setSystemTime(NOW);
    const { reader, workers } = harness(60_000, managedScope());
    // Use a valid bounded transport timeout; advance wall time, not its timers.
    const pending = reader.snapshot(managed());
    vi.setSystemTime(NOW + 60_001);
    workers[0]!.result(0, JSON.stringify(eligibleEvidence()));
    const result = await pending;
    expect(result.sourceState).toBe('missing'); expect(result.counts.total).toBe(0);
    expect(result.plan?.candidates.map((row) => row.workerId)).toEqual(['local']);
    expect(result.plan?.exclusions.flatMap((row) => row.reasons)).toContain('worker-unavailable');
    expect(result.observations[0]!.observedAt).toBe(new Date(NOW).toISOString());
  });

  it('does not let mutation of the caller gate reopen an in-flight shared group', async () => {
    vi.setSystemTime(NOW);
    const { reader, workers } = harness(1000, managedScope()); const payload = managed({ unavailableWorkerIds: ['codex-b'] });
    const pending = reader.snapshot(payload); payload.unavailableWorkerIds.length = 0;
    workers[0]!.result(0, JSON.stringify(eligibleEvidence()));
    const result = await pending;
    expect(result.plan?.candidates.map((row) => row.workerId)).toEqual(['local']);
    expect(workers[0]!.requests[0]!.payload).toMatchObject({ unavailableWorkerIds: ['codex-b'] });
  });

  it('requires the paired managed payload without starting a worker and keeps ordinary snapshots unchanged', async () => {
    const { reader, factory } = harness(1000, managedScope());
    expect((await reader.snapshot()).sourceState).toBe('degraded'); expect(factory).not.toHaveBeenCalled();
  });
});

describe('fixed resource console read transport', () => {
  it.each(['', '/', 'relative', '/tmp/\nfile', '/tmp/\u007ffile', `/tmp/${'é'.repeat(2048)}`])('rejects invalid explicit scope before worker startup %#', (path) => {
    const factory = vi.fn();
    expect(() => createResourceConsoleReader({ ...scope, root: path }, { _workerFactory: factory })).toThrow();
    expect(() => createResourceConsoleReader({ ...scope, observationsFile: path }, { _workerFactory: factory })).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it('normalizes lexical paths without inspecting or creating any source', () => {
    expect(validateResourceConsolePath('/private/tmp/root/child/..')).toBe('/private/tmp/root');
  });

  it.each([['snapshot', { root: '/other' }], ['snapshot', null], ['run', undefined], ['snapshot', { observationsFile: '/other' }]])(
    'refuses browser-selected paths and non-read requests %#', (kind, payload) => {
      expect(() => normalizeResourceConsoleRead(kind, payload)).toThrow('Invalid resource console read');
    });

  it('starts lazily, pins detached scope, strips inherited Node arguments and coalesces polls', async () => {
    const { reader, factory, workers, input } = harness(); expect(factory).not.toHaveBeenCalled();
    input.root = '/other'; input.pool.workers[0]!.model = 'changed'; input.bindings[0]!.capacityKey = 'changed';
    const first = reader.snapshot(); const second = reader.snapshot();
    expect(factory.mock.calls[0]![0].protocol).toBe('data:');
    expect(decodeURIComponent(factory.mock.calls[0]![0].href)).toContain('resource-console-worker.ts');
    expect(factory.mock.calls[0]![1]).toMatchObject({ workerData: scope, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 } });
    expect(workers[0]!.requests).toEqual([{ type: 'read', id: 1, kind: 'snapshot' }]);
    const expected = evidence(); workers[0]!.result(0, JSON.stringify(expected));
    await expect(first).resolves.toEqual(expected); await expect(second).resolves.toEqual(expected);
  });

  it.each([{}, '{', '[]', '{"schemaVersion":1}', JSON.stringify({ ...scope, schemaVersion: 1 })])(
    'withholds malformed/raw/unpinned worker replies as degraded evidence %#', async (value) => {
      const { reader, workers } = harness(); const pending = reader.snapshot(); workers[0]!.result(0, value);
      await expect(pending).resolves.toMatchObject({ sourceState: 'degraded', counts: { total: null }, plan: null,
        reasons: ['resource-evidence-unavailable'] });
    });

  it('withholds responses exceeding the actual UTF-8 byte budget', async () => {
    const { reader, workers } = harness(); const pending = reader.snapshot();
    workers[0]!.result(0, JSON.stringify({ secret: 'é'.repeat(MAX_RESOURCE_CONSOLE_RESPONSE_BYTES / 2) }));
    const result = await pending; expect(result.sourceState).toBe('degraded'); expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('maps worker source failure to fixed degraded data and permits a later retry', async () => {
    const { reader, workers } = harness(); const pending = reader.snapshot();
    workers[0]!.emit('message', { type: 'result', id: 1, ok: false, error: 'private source details' });
    expect(JSON.stringify(await pending)).not.toContain('private');
    const retry = reader.snapshot(); workers[0]!.result(1, JSON.stringify(evidence())); await expect(retry).resolves.toHaveProperty('schemaVersion', 1);
  });

  it('bounds timed-out reads and withholds late results', async () => {
    const { reader, workers } = harness(50); const pending = reader.snapshot();
    await vi.advanceTimersByTimeAsync(50); await expect(pending).resolves.toHaveProperty('sourceState', 'degraded');
    expect(workers[0]!.terminate).toHaveBeenCalledOnce(); workers[0]!.result(0, JSON.stringify(evidence()));
  });

  it('idempotent close rejects active reads and prevents future worker creation', async () => {
    const { reader, workers, factory } = harness(); const pending = reader.snapshot();
    const rejection = expect(pending).rejects.toMatchObject({ code: 'READ_PROJECTION_CLOSED' });
    await reader.close(); await reader.close(); await rejection;
    await expect(reader.snapshot()).rejects.toMatchObject({ code: 'READ_PROJECTION_CLOSED' });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce(); expect(factory).toHaveBeenCalledOnce();
  });
});
