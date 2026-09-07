import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUniverseConsoleReader, normalizeUniverseConsoleRead, validateUniverseConsoleRoot,
  type UniverseConsoleReader } from '../src/core/web/universe-console-reads.js';
import type { ReadProjectionWorkerHandle } from '../src/core/web/bounded-read-worker.js';
import { MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES } from '../src/core/web/universe-console-public.js';

// The parent transport must never fall back to computing a raw local overview.
const forbidden = vi.hoisted(() => ({ overview: vi.fn(), graph: vi.fn(), config: vi.fn(), gc: vi.fn() }));
vi.mock('../src/core/universe/overview.js', () => ({ readUniverseOverview: forbidden.overview }));
vi.mock('../src/core/universe/graph-reader.js', () => ({ readUniverseGraph: forbidden.graph }));
vi.mock('../src/core/config.js', () => ({ loadConfig: forbidden.config }));
vi.mock('../src/core/run/streaming.js', () => ({ gcRunStreams: forbidden.gc }));

type Request = { id: number; kind: string; payload?: unknown };
class FakeWorker extends EventEmitter {
  requests: Request[] = [];
  postMessage = vi.fn((request: Request) => { this.requests.push(request); });
  terminate = vi.fn(async () => 0);
  result(index: number, value: unknown): void {
    this.emit('message', { type: 'result', id: this.requests[index]!.id, ok: true, value });
  }
}
const readers: UniverseConsoleReader[] = [];
const root = '/private/tmp/console-read-unit-scope';
const json = '{"schemaVersion":1,"sourceState":"missing"}';
function harness(timeoutMs = 1_000) {
  const workers: FakeWorker[] = [];
  const factory = vi.fn((_entry: URL, _options: unknown): ReadProjectionWorkerHandle => {
    const worker = new FakeWorker(); workers.push(worker); return worker as unknown as ReadProjectionWorkerHandle;
  });
  const reader = createUniverseConsoleReader(root, { timeoutMs, _workerFactory: factory });
  readers.push(reader); return { reader, factory, workers };
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.close();
  for (const call of Object.values(forbidden)) expect(call).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
});

describe('scoped console bounded reader', () => {
  it.each(['relative', '', '/', '/tmp/\nprivate', '/tmp/\u007fprivate', `/tmp/${'x'.repeat(4096)}`])(
    'rejects invalid roots before worker creation %#', (value) => {
      const factory = vi.fn();
      expect(() => createUniverseConsoleReader(value, { _workerFactory: factory })).toThrow('explicit absolute');
      expect(factory).not.toHaveBeenCalled();
    });

  it('normalizes an explicit path without inspecting or creating it', () => {
    expect(validateUniverseConsoleRoot(`${root}/child/..`)).toBe(root);
  });

  it.each([
    ['overview', { root }], ['graph', { universeId: 'one', root }], ['graph', { universeId: ['one'] }],
    ['graph', { universeId: '../one' }], ['graph', {}], ['execute', undefined],
  ])('rejects browser scope and unsupported operation %#', (kind, payload) => {
    expect(() => normalizeUniverseConsoleRead(kind, payload)).toThrow('Invalid Universe console read');
  });

  it('pins one root and fixed source worker, strips inherited Node args, and starts lazily', async () => {
    const { reader, factory, workers } = harness();
    expect(factory).not.toHaveBeenCalled();
    const one = reader.overview(); const duplicate = reader.overview(); const graph = reader.graph('universe-one');
    const transport = new URL('../src/core/web/universe-console-reads.ts', import.meta.url);
    const loader = pathToFileURL(createRequire(transport).resolve('tsx/esm/api')).href;
    const worker = new URL('./universe-console-worker.ts', transport).href;
    const bootstrap = `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(worker)});`;
    expect(factory.mock.calls[0]![0].href).toBe(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
    expect(factory.mock.calls[0]![1]).toEqual({ workerData: { root }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 } });
    expect(workers[0]!.requests).toHaveLength(1);
    workers[0]!.result(0, json); await expect(one).resolves.toBe(json); await expect(duplicate).resolves.toBe(json);
    expect(workers[0]!.requests[1]).toMatchObject({ kind: 'graph', payload: { universeId: 'universe-one' } });
    workers[0]!.result(1, json); await expect(graph).resolves.toBe(json);
  });

  it.each([{}, { schemaVersion: 1, universes: [] }, '{', '[]', '{"schemaVersion":2}']) (
    'rejects raw objects and malformed serialized replies %#', async (value) => {
      const { reader, workers } = harness(); const pending = reader.overview();
      workers[0]!.result(0, value);
      await expect(pending).rejects.toThrow('Invalid Universe console response');
    });

  it('withholds oversized serialized output instead of returning a partial object', async () => {
    const { reader, workers } = harness(); const pending = reader.overview();
    workers[0]!.result(0, JSON.stringify({ schemaVersion: 1, value: 'é'.repeat(MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES / 2) }));
    await expect(pending).rejects.toThrow('Invalid Universe console response');
  });

  it('maps worker failures to a fixed unavailable error and can read again', async () => {
    const { reader, workers } = harness(); const pending = reader.overview();
    workers[0]!.emit('message', { type: 'result', id: workers[0]!.requests[0]!.id, ok: false, error: 'private source path' });
    await expect(pending).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' });
    const next = reader.overview(); workers[0]!.result(1, json); await expect(next).resolves.toBe(json);
  });

  it('terminates timed-out work, withholds late results, and remains closed after shutdown', async () => {
    const { reader, workers } = harness(50); const pending = reader.overview();
    const failure = expect(pending).rejects.toMatchObject({ code: 'READ_PROJECTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50); await failure;
    workers[0]!.result(0, json); expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    await reader.close(); await reader.close();
    await expect(reader.overview()).rejects.toMatchObject({ code: 'READ_PROJECTION_CLOSED' });
  });

  it('settles active and queued reads during idempotent close', async () => {
    const { reader, workers } = harness();
    const first = reader.overview(); const second = reader.graph('one');
    const failures = Promise.all([expect(first).rejects.toMatchObject({ code: 'READ_PROJECTION_CLOSED' }),
      expect(second).rejects.toMatchObject({ code: 'READ_PROJECTION_CLOSED' })]);
    await reader.close(); await reader.close(); await failures;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
});
