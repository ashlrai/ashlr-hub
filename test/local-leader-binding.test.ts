/** Local role identity comes from live runtime props plus the exact selected weights. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AshlrConfig } from '../src/core/types.js';
const probe = vi.hoisted(() => vi.fn());
vi.mock('../src/core/local-runtime/llama/health.js', () => ({ probeLlamaRuntime: probe }));
import {
  bindLocalLeaderModel, llamaLeaderTransport, localLeaderBase, localLeaderBindingCurrent,
  readLocalLeaderRuntime, type LocalLeaderRuntime, type LocalLeaderBinding,
} from '../src/core/vision/local-leader-transport.js';

let home: string, blob: string, manifest: string, cfg: AshlrConfig;
let runtime: LocalLeaderRuntime;
function binding(): LocalLeaderBinding {
  const result = bindLocalLeaderModel(runtime, 'test-qwen:27b', 65536);
  expect(result).not.toBeNull(); return result!;
}
function success(model = blob): Response {
  const frame = { model, choices: [{ index: 0, delta: { content: '{"summary":"Useful next task"}' }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phantom-local-leader-binding-'));
  vi.stubEnv('HOME', home); vi.stubEnv('OLLAMA_MODELS', join(home, '.ollama', 'models'));
  vi.stubEnv('LLAMA_SERVER_BASE_URL', '');
  const root = join(home, '.ollama', 'models');
  blob = join(root, 'blobs', 'sha256-' + 'a'.repeat(64));
  manifest = join(root, 'manifests', 'registry.ollama.ai', 'library', 'test-qwen', '27b');
  mkdirSync(join(root, 'blobs'), { recursive: true }); mkdirSync(join(root, 'manifests', 'registry.ollama.ai', 'library', 'test-qwen'), { recursive: true });
  writeFileSync(blob, 'inert-test-weights');
  writeFileSync(manifest, JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:' + 'a'.repeat(64), size: 18 }] }));
  cfg = { models: { llamaServer: { baseUrl: 'http://127.0.0.1:8080/v1' } } } as unknown as AshlrConfig;
  runtime = { baseUrl: 'http://127.0.0.1:8080/v1', servingModel: blob, contextWindow: 65536 };
  probe.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('local Leader binding', () => {
  it('binds selected manifest weights, live serving path, context and configured base', () => {
    const pinned = binding();
    expect(pinned).toMatchObject({ ...runtime, model: 'test-qwen:27b', blobPath: blob, manifestPath: manifest });
    expect(localLeaderBindingCurrent(pinned, cfg)).toBe(true);
  });
  it.each(['http://example.com/v1', 'http://user:pass@localhost/v1', 'http://localhost/v1?x=1', 'http://localhost/v1#x', 'http://localhost/other', 'file:///v1'])('refuses nonlocal/unbound endpoint %s', base => {
    expect(localLeaderBase(base)).toBeNull();
    expect(bindLocalLeaderModel({ ...runtime, baseUrl: base }, 'test-qwen:27b', 65536)).toBeNull();
  });
  it('does not infer weights identity from a tag, missing manifest or a different context', () => {
    expect(bindLocalLeaderModel(null, 'test-qwen:27b', 65536)).toBeNull();
    expect(bindLocalLeaderModel({ ...runtime, servingModel: 'test-qwen:27b' }, 'test-qwen:27b', 65536)).toBeNull();
    expect(bindLocalLeaderModel(runtime, 'absent:27b', 65536)).toBeNull();
    expect(bindLocalLeaderModel(runtime, 'test-qwen:27b', 131072)).toBeNull();
    expect(bindLocalLeaderModel(runtime, 'test-qwen:27b', null)).toBeNull();
    expect(bindLocalLeaderModel({ ...runtime, contextWindow: 0 }, 'test-qwen:27b', 0)).toBeNull();
    expect(bindLocalLeaderModel({ ...runtime, contextWindow: 0.5 }, 'test-qwen:27b', 0.5)).toBeNull();
  });
  it('detects changed files/configuration and Stop after binding', () => {
    const pinned = binding();
    expect(localLeaderBindingCurrent(pinned, { models: { llamaServer: { baseUrl: 'http://127.0.0.1:8082/v1' } } } as unknown as AshlrConfig)).toBe(false);
    writeFileSync(blob, 'changed-test-weights'); expect(localLeaderBindingCurrent(pinned, cfg)).toBe(false);
    const current = binding();
    writeFileSync(manifest, '{}'); expect(localLeaderBindingCurrent(current, cfg)).toBe(false);
    mkdirSync(join(home, '.ashlr'), { recursive: true }); writeFileSync(join(home, '.ashlr', 'KILL'), 'kill switch active\n');
    expect(localLeaderBindingCurrent(pinned, cfg)).toBe(false);
  });
  it('does not admit a symlink as selected manifest or blob metadata', () => {
    // Windows may prohibit unprivileged symlink creation. The same lstat refusal
    // is exercised on platforms where creating this inert fixture is supported.
    const alias = join(home, 'manifest-alias');
    writeFileSync(alias, readFileSync(manifest));
    rmSync(manifest);
    try { symlinkSync(alias, manifest); } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    expect(bindLocalLeaderModel(runtime, 'test-qwen:27b', 65536)).toBeNull();
  });
  it('refreshes actual serving identity before one text-only request, without credentials or Ollama fallback', async () => {
    const fetch = vi.fn().mockResolvedValue(success()); vi.stubGlobal('fetch', fetch);
    const read = vi.fn().mockResolvedValue(runtime);
    expect(await llamaLeaderTransport(binding(), cfg, { timeoutMs: 1000, maxOutputTokens: 120 }, read)('system', 'task')).toContain('Useful next task');
    expect(read).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(runtime.baseUrl + '/chat/completions'); expect(init.redirect).toBe('error');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: blob, max_tokens: 120, stream: true });
  });
  it.each(['unknown', 'model', 'context', 'endpoint'])('holds %s refresh before inference', async kind => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const fresh = kind === 'unknown' ? null : { ...runtime,
      ...(kind === 'model' ? { servingModel: manifest } : {}),
      ...(kind === 'context' ? { contextWindow: 131072 } : {}),
      ...(kind === 'endpoint' ? { baseUrl: 'http://127.0.0.1:9090/v1' } : {}),
    };
    await expect(llamaLeaderTransport(binding(), cfg, { timeoutMs: 1000 }, vi.fn().mockResolvedValue(fresh))('s', 'u')).rejects.toThrow(/changed/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds a stalled whole runtime probe before dispatch without inference', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const read = vi.fn(() => new Promise<LocalLeaderRuntime | null>(() => {}));
    const result = expect(llamaLeaderTransport(binding(), cfg, { timeoutMs: 100 }, read)('s', 'u')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100); await result;
    expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('honors Stop while the whole pre-dispatch runtime probe is outstanding', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const read = vi.fn(() => new Promise<LocalLeaderRuntime | null>(() => {}));
    const result = expect(llamaLeaderTransport(binding(), cfg, { timeoutMs: 1000 }, read)('s', 'u')).rejects.toThrow();
    mkdirSync(join(home, '.ashlr'), { recursive: true }); writeFileSync(join(home, '.ashlr', 'KILL'), 'kill switch active\n');
    await vi.advanceTimersByTimeAsync(100); await result;
    expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects changed serving-model response without replay', async () => {
    const fetch = vi.fn().mockResolvedValue(success('different-model')); vi.stubGlobal('fetch', fetch);
    await expect(llamaLeaderTransport(binding(), cfg, { timeoutMs: 1000 }, vi.fn().mockResolvedValue(runtime))('s', 'u')).rejects.toThrow(/identity/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('aborts an outstanding request when the selected blob changes', async () => {
    vi.useFakeTimers(); const pinned = binding();
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const result = expect(llamaLeaderTransport(pinned, cfg, { timeoutMs: 1000 }, vi.fn().mockResolvedValue(runtime))('s', 'u')).rejects.toThrow(/binding unavailable/);
    await vi.advanceTimersByTimeAsync(1); writeFileSync(blob, 'changed');
    await vi.advanceTimersByTimeAsync(100); await result;
    expect(fetch).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('live local runtime metadata projection', () => {
  function healthy(overrides: Record<string, unknown> = {}) {
    return { state: 'up', runtimeKind: 'llama-server', killSwitchEngaged: false,
      slots: { source: 'props' }, contextPerSlot: 65536, model: blob, ...overrides };
  }
  function mockProbe(snapshot = healthy()) {
    probe.mockImplementation(async options => {
      try { await (await options.fetchImpl('http://127.0.0.1:8080/props', { signal: new AbortController().signal })).json(); }
      catch { return healthy({ state: 'unknown' }); }
      return snapshot;
    });
  }
  it('uses bounded redirect-refusing GET props, never ownership-record model fallback', async () => {
    mockProbe(); const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model_alias: blob }))); vi.stubGlobal('fetch', fetch);
    expect(await readLocalLeaderRuntime(cfg)).toEqual(runtime);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    fetch.mockResolvedValue(new Response(JSON.stringify({}))); expect(await readLocalLeaderRuntime(cfg)).toBeNull();
  });
  it.each([
    { state: 'loading' }, { runtimeKind: 'ollama' }, { killSwitchEngaged: true },
    { slots: { source: 'unknown' } }, { contextPerSlot: null }, { contextPerSlot: 0 }, { contextPerSlot: 1.5 },
  ])('holds unknown or incompatible runtime reading %j', async partial => {
    mockProbe(healthy(partial)); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ model_alias: blob }))));
    expect(await readLocalLeaderRuntime(cfg)).toBeNull();
  });
  it('holds metadata overflow, invalid JSON and nonabsolute alias without inference', async () => {
    mockProbe(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const text of ['x'.repeat(1024 * 1024 + 1), '{invalid}', JSON.stringify({ model_alias: 'catalog-tag' })]) {
      fetch.mockResolvedValue(new Response(text)); expect(await readLocalLeaderRuntime(cfg)).toBeNull();
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('bounds metadata body reads and hanging cleanup by caller cancellation', async () => {
    mockProbe(); const controller = new AbortController(), cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {}, cancel }))));
    const result = readLocalLeaderRuntime(cfg, controller.signal);
    await Promise.resolve(); await Promise.resolve(); controller.abort();
    expect(await result).toBeNull();
  });
  it('avoids even metadata contact for an unbound remote URL or prior Stop', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await readLocalLeaderRuntime({ models: { llamaServer: { baseUrl: 'https://example.com/v1' } } } as unknown as AshlrConfig)).toBeNull();
    const controller = new AbortController(); controller.abort(); expect(await readLocalLeaderRuntime(cfg, controller.signal)).toBeNull();
    expect(probe).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
