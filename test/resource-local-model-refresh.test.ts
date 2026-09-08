/** Explicit mocked inventory and test-owned loopback HTTP only; no Ollama or inference. */
import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as inventory from '../src/core/run/ollama-identity.js';
import { refreshResourceLocalModelsOnce, validateResourceLocalModelConfig, RESOURCE_LOCAL_MODEL_REFRESH_TTL_MS,
  type ResourceLocalModelConfig } from '../src/core/resources/local-model-refresh.js';
import { MAX_RESOURCE_OBSERVATION_AGE_MS, type ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';

const MODEL_DIGEST = `sha256:${'a'.repeat(64)}`;
const servers: Server[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];
function fixture(count = 2) {
  const pool: ResourcePool = { schemaVersion: 1, id: 'local-models', workers: Array.from({ length: count }, (_, index) => ({
    id: `local-${index}`, provider: 'local', model: `fixture-${index}:exact`, maxConcurrent: 1,
    maxTasksPerWindow: 2, taskWindowMs: 60_000, priority: 1, reservePercent: 10 })) };
  const bindings: ResourceBinding[] = pool.workers.map((worker) => ({ workerId: worker.id,
    capacityKey: worker.id, kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }));
  const config: ResourceLocalModelConfig = { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
    workers: pool.workers.map((worker) => ({ workerId: worker.id, modelDigest: MODEL_DIGEST })) };
  return { pool, bindings, config, timeoutMs: 10_000 };
}
function success(options: inventory.VerifyOllamaModelIdentityOptions): inventory.OllamaIdentityVerification {
  return { ok: true, identity: { name: options.model, digest: options.expectedDigest as `sha256:${string}`,
    size: 1, details: { format: 'gguf' } } };
}
beforeEach(() => { vi.spyOn(inventory, 'verifyOllamaModelIdentity').mockImplementation(async (options) => success(options)); });
afterEach(async () => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  for (const server of servers.splice(0)) {
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
  }
  vi.restoreAllMocks();
});

describe('explicit local model enrollment', () => {
  it.each([1, 32])('validates and deeply detaches a %s-worker exact config without inventory contact', (count) => {
    const f = fixture(count); const config = validateResourceLocalModelConfig(f.config, f.pool, f.bindings);
    expect(config).toEqual(f.config); expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.workers)).toBe(true); expect(Object.isFrozen(config.workers[0])).toBe(true);
    f.config.workers[0]!.modelDigest = `sha256:${'b'.repeat(64)}`;
    expect(config.workers[0]!.modelDigest).toBe(MODEL_DIGEST); expect(inventory.verifyOllamaModelIdentity).not.toHaveBeenCalled();
  });

  it.each(['version', 'extra', 'digest', 'empty', 'duplicate', 'unknown', 'worker-extra', 'bare-hash', 'uppercase', 'sparse', 'array-extra'])(
    'rejects malformed %s enrollment before contact', async (kind) => {
      const f = fixture(); const config: any = f.config;
      if (kind === 'version') config.schemaVersion = 2;
      if (kind === 'extra') config.endpoint = '/PRIVATE/config';
      if (kind === 'digest') config.poolDigest = '0'.repeat(64);
      if (kind === 'empty') config.workers = [];
      if (kind === 'duplicate') config.workers[1] = config.workers[0];
      if (kind === 'unknown') config.workers[0].workerId = 'unknown';
      if (kind === 'worker-extra') config.workers[0].model = 'not-authority';
      if (kind === 'bare-hash') config.workers[0].modelDigest = 'a'.repeat(64);
      if (kind === 'uppercase') config.workers[0].modelDigest = `sha256:${'A'.repeat(64)}`;
      if (kind === 'sparse') config.workers = Array(1);
      if (kind === 'array-extra') config.workers.extra = true;
      await expect(refreshResourceLocalModelsOnce({ ...f, config })).rejects.toThrow('Invalid resource local model configuration');
      expect(inventory.verifyOllamaModelIdentity).not.toHaveBeenCalled();
    });

  it.each(['root', 'worker', 'array'])('rejects %s accessors without evaluating them', (kind) => {
    const f = fixture(); const getter = vi.fn();
    if (kind === 'root') Object.defineProperty(f.config, 'workers', { get: getter });
    if (kind === 'worker') Object.defineProperty(f.config.workers[0], 'modelDigest', { get: getter });
    if (kind === 'array') Object.defineProperty(f.config.workers, 0, { get: getter });
    expect(() => validateResourceLocalModelConfig(f.config, f.pool, f.bindings)).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(inventory.verifyOllamaModelIdentity).not.toHaveBeenCalled();
  });

  it.each(['https://127.0.0.1:1/v1', 'http://localhost:1/v1', 'http://192.0.2.1/v1',
    'http://user:pass@127.0.0.1:1/v1', 'http://127.0.0.1:1/v1?secret=value', 'http://127.0.0.1:1/api/tags'])(
    'rejects a noncanonical or non-loopback endpoint %s without contact', async (endpoint) => {
      const f = fixture(); (f.bindings[0] as { endpoint: string }).endpoint = endpoint;
      f.config.poolDigest = digest(canonical({ pool: f.pool, bindings: f.bindings }));
      await expect(refreshResourceLocalModelsOnce(f)).rejects.toThrow(); expect(inventory.verifyOllamaModelIdentity).not.toHaveBeenCalled();
    });

  it.each(['model', 'policy', 'endpoint'])('pins the actual %s rather than only worker IDs', async (kind) => {
    const f = fixture();
    if (kind === 'model') f.pool.workers[0]!.model = 'other-model';
    if (kind === 'policy') f.pool.workers[0]!.maxTasksPerWindow = 3;
    if (kind === 'endpoint') (f.bindings[0] as { endpoint: string }).endpoint = 'http://127.0.0.1:2/v1';
    await expect(refreshResourceLocalModelsOnce(f)).rejects.toThrow('Invalid resource local model configuration');
    expect(inventory.verifyOllamaModelIdentity).not.toHaveBeenCalled();
  });

  it('rejects an enrolled native worker even with valid native policy and bindings', async () => {
    const f = fixture(1); f.pool.workers[0]!.provider = 'codex';
    f.bindings[0] = { workerId: 'local-0', capacityKey: 'local-0', kind: 'native-cli', command: ['/inert/never-run'] };
    f.config.poolDigest = digest(canonical({ pool: f.pool, bindings: f.bindings }));
    await expect(refreshResourceLocalModelsOnce(f)).rejects.toThrow('Invalid resource local model configuration');
    expect(inventory.verifyOllamaModelIdentity).not.toHaveBeenCalled();
  });
});

describe('single bounded local inventory pass', () => {
  it('reads only explicitly managed workers and does not invent observations for the rest of the pool', async () => {
    const f = fixture(3); f.config.workers = [f.config.workers[1]!];
    const result = await refreshResourceLocalModelsOnce(f);
    expect(result.observations.map((row) => row.workerId)).toEqual(['local-1']);
    expect(result.unavailableWorkerIds).toEqual([]); expect(inventory.verifyOllamaModelIdentity).toHaveBeenCalledOnce();
    expect(vi.mocked(inventory.verifyOllamaModelIdentity).mock.calls[0]![0].model).toBe('fixture-1:exact');
  });

  it('samples successful completion, reports no identity or usage details, and contacts each explicit worker once', async () => {
    const f = fixture(); let sampled = Date.parse('2026-09-08T03:00:00.000Z'); vi.spyOn(Date, 'now').mockImplementation(() => sampled);
    vi.mocked(inventory.verifyOllamaModelIdentity).mockImplementation(async (options) => { sampled += 100; return success(options); });
    const result = await refreshResourceLocalModelsOnce(f);
    expect(result.unavailableWorkerIds).toEqual([]); expect(result.observations).toHaveLength(2);
    expect(result.observations.map((row) => Date.parse(row.observedAt))).toEqual([sampled - 100, sampled]);
    for (const row of result.observations) {
      expect(row).toMatchObject({ health: 'ready', windows: [], retryAfter: null });
      expect(Date.parse(row.expiresAt) - Date.parse(row.observedAt)).toBe(RESOURCE_LOCAL_MODEL_REFRESH_TTL_MS);
      expect(Date.parse(row.expiresAt) - Date.parse(row.observedAt)).toBeLessThanOrEqual(MAX_RESOURCE_OBSERVATION_AGE_MS);
    }
    expect(inventory.verifyOllamaModelIdentity).toHaveBeenCalledTimes(2);
    expect(vi.mocked(inventory.verifyOllamaModelIdentity).mock.calls.map(([options]) => options.model)).toEqual(['fixture-0:exact', 'fixture-1:exact']);
    expect(Object.isFrozen(result.observations[0]!.windows)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/endpoint|modelDigest|identity|PRIVATE|tokens|gguf/);
  });

  it('awaits the first read before the next and detaches caller-owned inputs before waiting', async () => {
    const f = fixture(); let finish!: () => void;
    vi.mocked(inventory.verifyOllamaModelIdentity).mockImplementationOnce((options) => new Promise((done) => {
      finish = () => done(success(options));
    }));
    const pending = refreshResourceLocalModelsOnce(f); expect(inventory.verifyOllamaModelIdentity).toHaveBeenCalledOnce();
    f.pool.workers[1]!.model = 'changed'; (f.bindings[1] as { endpoint: string }).endpoint = 'http://127.0.0.1:2/v1';
    f.config.workers[1]!.modelDigest = `sha256:${'b'.repeat(64)}`; f.timeoutMs = 0;
    finish(); const result = await pending;
    expect(result.unavailableWorkerIds).toEqual([]);
    expect(vi.mocked(inventory.verifyOllamaModelIdentity).mock.calls[1]![0]).toMatchObject({
      model: 'fixture-1:exact', baseUrl: 'http://127.0.0.1:1/v1', expectedDigest: MODEL_DIGEST,
    });
  });

  it.each(['invalid-config', 'non-loopback-endpoint', 'cancelled', 'unreachable', 'http-error', 'response-too-large',
    'invalid-response', 'model-not-found', 'digest-mismatch'] as const)('withholds a %s worker without retry or exposing its raw evidence', async (reason) => {
      vi.mocked(inventory.verifyOllamaModelIdentity).mockResolvedValueOnce({ ok: false, reason });
      const result = await refreshResourceLocalModelsOnce(fixture());
      expect(result.unavailableWorkerIds).toEqual(['local-0']); expect(result.observations.map((row) => row.workerId)).toEqual(['local-1']);
      expect(inventory.verifyOllamaModelIdentity).toHaveBeenCalledTimes(2); expect(JSON.stringify(result)).not.toContain(reason);
    });

  it('withholds thrown or inconsistent identity results without retaining exception text', async () => {
    vi.mocked(inventory.verifyOllamaModelIdentity).mockRejectedValueOnce(new Error('/PRIVATE/model-state'))
      .mockResolvedValueOnce({ ok: true, identity: { name: 'other', digest: `sha256:${'b'.repeat(64)}`, size: 1, details: {} } });
    expect(await refreshResourceLocalModelsOnce(fixture())).toEqual({ observations: [], unavailableWorkerIds: ['local-0', 'local-1'] });
    expect(inventory.verifyOllamaModelIdentity).toHaveBeenCalledTimes(2);
  });

  it.each([0, 900_001, 1.5, NaN, Infinity, null, '1000'])('rejects invalid total timeout %j before contact', async (timeoutMs) => {
    await expect(refreshResourceLocalModelsOnce({ ...fixture(), timeoutMs: timeoutMs as any })).rejects.toThrow('Invalid resource local model refresh');
    expect(inventory.verifyOllamaModelIdentity).not.toHaveBeenCalled();
  });

  it('validates even a pre-aborted request and leaves valid cancelled requests inert', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    expect(await refreshResourceLocalModelsOnce({ ...f, signal: controller.signal })).toEqual({ observations: [], unavailableWorkerIds: ['local-0', 'local-1'] });
    f.config.poolDigest = '0'.repeat(64);
    await expect(refreshResourceLocalModelsOnce({ ...f, signal: controller.signal })).rejects.toThrow('Invalid resource local model configuration');
    expect(inventory.verifyOllamaModelIdentity).not.toHaveBeenCalled();
  });

  it.each([{}, null])('rejects an invalid signal %j before contact', async (signal) => {
    await expect(refreshResourceLocalModelsOnce({ ...fixture(), signal: signal as any })).rejects.toThrow('Invalid resource local model refresh');
    expect(inventory.verifyOllamaModelIdentity).not.toHaveBeenCalled();
  });

  it('uses decreasing monotonic budgets capped at five seconds, without restarting after expiry', async () => {
    let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const budgets: number[] = [];
    vi.mocked(inventory.verifyOllamaModelIdentity).mockImplementation(async (options) => {
      budgets.push(options.timeoutMs!); elapsed += 4500; return success(options);
    });
    const result = await refreshResourceLocalModelsOnce({ ...fixture(3), timeoutMs: 7000 });
    expect(budgets).toEqual([5000, 2500]); expect(result.observations.map((row) => row.workerId)).toEqual(['local-0']);
    expect(result.unavailableWorkerIds).toEqual(['local-1', 'local-2']);
  });

  it('withholds early captures that expire before later workers finish, without renewing their timestamps', async () => {
    let sampled = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => sampled);
    vi.mocked(inventory.verifyOllamaModelIdentity).mockImplementation(async (options) => {
      if (options.model === 'fixture-1:exact') sampled += 61_000; return success(options);
    });
    const result = await refreshResourceLocalModelsOnce(fixture());
    expect(result.observations).toHaveLength(2); expect(result.unavailableWorkerIds).toEqual(['local-0']);
    expect(Date.parse(result.observations[0]!.expiresAt)).toBeLessThan(sampled);
  });

  it.each(['caller', 'deadline'])('awaits active verifier cleanup after %s cancellation and never starts the next worker', async (kind) => {
    const controller = new AbortController(); let finish!: () => void; let seenSignal!: AbortSignal;
    let notified!: () => void; const aborted = new Promise<void>((done) => { notified = done; });
    vi.mocked(inventory.verifyOllamaModelIdentity).mockImplementationOnce((options) => new Promise((done) => {
      seenSignal = options.signal!; seenSignal.addEventListener('abort', notified, { once: true });
      finish = () => done(success(options));
    }));
    const add = vi.spyOn(controller.signal, 'addEventListener'); const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let settled = false;
    const pending = refreshResourceLocalModelsOnce({ ...fixture(), timeoutMs: kind === 'deadline' ? 50 : 5000,
      signal: controller.signal }).then((result) => { settled = true; return result; });
    if (kind === 'caller') controller.abort(new Error('PRIVATE_ABORT_REASON'));
    await aborted; expect(settled).toBe(false); expect(seenSignal.aborted).toBe(true);
    finish(); expect(await pending).toEqual({ observations: [], unavailableWorkerIds: ['local-0', 'local-1'] });
    expect(inventory.verifyOllamaModelIdentity).toHaveBeenCalledOnce(); expect(add).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
  });
});

describe('test-owned loopback HTTP inventory', () => {
  it.each(['success', 'redirect', 'cancel'])('uses only the enrolled GET /api/tags route for %s', async (mode) => {
    vi.mocked(inventory.verifyOllamaModelIdentity).mockRestore();
    const requests: string[] = []; let contact!: () => void;
    const contacted = new Promise<void>((done) => { contact = done; });
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`); contact();
      if (mode === 'cancel') return;
      if (mode === 'redirect') { response.writeHead(302, { location: '/must-not-follow' }); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{ name: 'fixture-0:exact', digest: MODEL_DIGEST,
        size: 123, details: { format: 'gguf' } }] }));
    });
    servers.push(server); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected private test TCP port');
    const f = fixture(1); (f.bindings[0] as { endpoint: string }).endpoint = `http://127.0.0.1:${address.port}/v1`;
    f.config.poolDigest = digest(canonical({ pool: f.pool, bindings: f.bindings }));
    const controller = new AbortController();
    const pending = refreshResourceLocalModelsOnce({ ...f, timeoutMs: 3000, signal: controller.signal });
    await contacted;
    if (mode === 'cancel') timers.push(setTimeout(() => controller.abort(), 10));
    const result = await pending;
    expect(requests).toEqual(['GET /api/tags']);
    expect(result.unavailableWorkerIds).toEqual(mode === 'success' ? [] : ['local-0']);
    expect(result.observations).toHaveLength(mode === 'success' ? 1 : 0);
    expect(JSON.stringify(result)).not.toMatch(/127\.0\.0\.1|must-not-follow|modelDigest|identity/);
  });
});
