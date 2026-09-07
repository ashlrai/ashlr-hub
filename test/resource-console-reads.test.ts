import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceConsoleReader, normalizeResourceConsoleRead, validateResourceConsolePath,
  type ResourceConsoleReader, type ResourceConsoleReadScope } from '../src/core/web/resource-console-reads.js';
import { degradedResourceConsoleEvidence, MAX_RESOURCE_CONSOLE_RESPONSE_BYTES } from '../src/core/web/resource-console-public.js';
import type { ReadProjectionWorkerHandle } from '../src/core/web/bounded-read-worker.js';

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
function harness(timeoutMs = 1000) {
  const workers: FakeWorker[] = [];
  const factory = vi.fn((_entry: URL, _options: unknown): ReadProjectionWorkerHandle => {
    const worker = new FakeWorker(); workers.push(worker); return worker as unknown as ReadProjectionWorkerHandle;
  });
  const input = structuredClone(scope);
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
