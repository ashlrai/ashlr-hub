/** Local role identity comes from live runtime props plus the exact selected weights. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { localLeaderCompletionEvent } from '../src/core/vision/leader-seat.js';
import { agentActionsDir, recordAgentActionResult } from '../src/core/fleet/agent-action-ledger.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AshlrConfig } from '../src/core/types.js';
const probe = vi.hoisted(() => vi.fn());
vi.mock('../src/core/local-runtime/llama/health.js', () => ({ probeLlamaRuntime: probe }));
import {
  bindLocalLeaderModel, llamaLeaderTransport, localLeaderBase, localLeaderBindingCurrent,
  readLocalLeaderRuntime, type LocalLeaderRuntime, type LocalLeaderBinding, type LocalLeaderCompletionMetrics,
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
  vi.stubEnv('HOME', home); vi.stubEnv('ASHLR_HOME', join(home, '.ashlr')); vi.stubEnv('OLLAMA_MODELS', join(home, '.ollama', 'models'));
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

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


describe('settled local Leader telemetry', () => {
  function reported(input: number | null = 12, output: number | null = 3): Response {
    const text = { model: blob, choices: [{index:0,delta:{content:'PRIVATE_RESPONSE_CANARY'},finish_reason:'stop'}] };
    const usage = input === null || output === null ? '' : `data: ${JSON.stringify({model:blob,choices:[],usage:{prompt_tokens:input,completion_tokens:output}})}\n\n`;
    return new Response(`data: ${JSON.stringify(text)}\n\n${usage}data: [DONE]\n\n`, {headers:{'content-type':'text/event-stream'}});
  }
  it('round trips an actual strict completion through private ledger and a cold read without private context', async () => {
    const pinned = binding(), events: LocalLeaderCompletionMetrics[] = [];
    let clock = 100; vi.spyOn(performance,'now').mockImplementation(() => clock);
    const fetch = vi.fn(async () => { clock += 35; return reported(); }); vi.stubGlobal('fetch',fetch);
    await llamaLeaderTransport(pinned,cfg,{timeoutMs:1000},async () => {clock+=15;return runtime;}, metrics => {events.push(metrics);})('PRIVATE_PROMPT_CANARY','PRIVATE_TASK_CANARY');
    expect(events).toHaveLength(1);
    const metric = events[0]!;
    expect(metric).toMatchObject({model:'test-qwen:27b',contextWindow:65536,elapsedMs:50,tokensIn:12,tokensOut:3,inferenceRequestStarted:true,outcome:'completed'});
    expect(metric.bindingHint).toBe(createHash('sha256').update(JSON.stringify(pinned)).digest('hex'));
    expect(fetch).toHaveBeenCalledOnce();
    const finished = metric.finishedAt;
    vi.setSystemTime(new Date(Date.parse(finished)+60000));
    const event = localLeaderCompletionEvent(metric,'selected-local-account');
    expect(event.ts).toBe(finished);
    expect(recordAgentActionResult(event,{sync:true})).toEqual({attempted:1,recorded:1});
    const file = join(agentActionsDir(),finished.slice(0,10)+'.jsonl'), bytes = readFileSync(file,'utf8');
    vi.resetModules();
    const {readAgentActionsDetailed} = await import('../src/core/fleet/agent-action-ledger.js');
    const read = readAgentActionsDetailed({inspectionOnly:true,requireComplete:true});
    expect(read.complete).toBe(true); expect(read.events).toHaveLength(1);
    expect(read.events[0]).toMatchObject({ts:finished,runId:metric.runId,backend:'llama-server',model:'test-qwen:27b',durationMs:50,
      counts:{tokensIn:12,tokensOut:3,inferenceRequests:1,contextWindowTokens:65536}});
    expect(read.events[0]?.tags).toEqual(expect.arrayContaining(['trace:local-leader-completion-v1','role:leader',`runtime-binding:${metric.bindingHint}`,
      `seat-hint:${createHash('sha256').update('selected-local-account').digest('hex')}`]));
    for(const secret of ['PRIVATE_PROMPT_CANARY','PRIVATE_TASK_CANARY','PRIVATE_RESPONSE_CANARY',blob,manifest,runtime.baseUrl,'selected-local-account']) expect(bytes).not.toContain(secret);
    expect(readFileSync(file,'utf8')).toBe(bytes);
  });
  it('pins the selected binding for both execution and trace despite later caller mutation', async () => {
    const selected = binding(), original = {...selected}, record = vi.fn();
    const complete = llamaLeaderTransport(selected,cfg,{timeoutMs:1000},vi.fn().mockResolvedValue(runtime),record);
    selected.baseUrl='http://127.0.0.1:9090/v1';selected.model='another-model';selected.contextWindow=131072;
    const fetch=vi.fn().mockResolvedValue(reported());vi.stubGlobal('fetch',fetch);
    expect(await complete('s','u')).toContain('PRIVATE_RESPONSE_CANARY');
    expect(fetch.mock.calls[0]?.[0]).toBe(original.baseUrl+'/chat/completions');
    expect(record.mock.calls[0]?.[0]).toMatchObject({model:original.model,contextWindow:original.contextWindow,
      bindingHint:createHash('sha256').update(JSON.stringify(original)).digest('hex')});
  });
  it('refuses an already aborted caller before metadata or inference and settles once', async () => {
    vi.useFakeTimers();const caller=new AbortController(),read=vi.fn(),fetch=vi.fn(),record=vi.fn();
    vi.stubGlobal('fetch',fetch);caller.abort(new Error('caller cancelled before dispatch'));
    await expect(llamaLeaderTransport(binding(),cfg,{timeoutMs:1000},read,record)('s','u',caller.signal))
      .rejects.toThrow('caller cancelled before dispatch');
    expect(read).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0]).toMatchObject({inferenceRequestStarted:false,tokensIn:null,tokensOut:null,outcome:'failed'});
    expect(getEventListeners(caller.signal,'abort')).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
  });
  it('settles caller cancellation during stalled metadata without inference or retained listeners', async () => {
    vi.useFakeTimers();const caller=new AbortController(),record=vi.fn(),fetch=vi.fn();let metadataSignal:AbortSignal|undefined,entered!:()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;});
    const read=vi.fn((_cfg:AshlrConfig,signal?:AbortSignal)=>{metadataSignal=signal;entered();return new Promise<null>(()=>{});});
    vi.stubGlobal('fetch',fetch);
    const failed=expect(llamaLeaderTransport(binding(),cfg,{timeoutMs:1000},read,record)('s','u',caller.signal)).rejects.toThrow('Runtime metadata cancelled');
    await reading;expect(getEventListeners(caller.signal,'abort')).toHaveLength(1);caller.abort(new Error('caller cancelled metadata'));
    await failed;expect(metadataSignal?.aborted).toBe(true);expect(fetch).not.toHaveBeenCalled();expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0]).toMatchObject({inferenceRequestStarted:false,tokensIn:null,tokensOut:null,outcome:'failed'});
    expect(getEventListeners(caller.signal,'abort')).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
  });
  it('forwards cancellation after POST to the active client and settles unknown usage once without replay', async () => {
    vi.useFakeTimers();const caller=new AbortController(),record=vi.fn();let requestSignal:AbortSignal|undefined,entered!:()=>void;
    const contacted=new Promise<void>(resolve=>{entered=resolve;});
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{requestSignal=init?.signal ?? undefined;entered();
      return new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/event-stream'}});});
    vi.stubGlobal('fetch',fetch);
    const failed=expect(llamaLeaderTransport(binding(),cfg,{timeoutMs:1000},vi.fn().mockResolvedValue(runtime),record)('s','u',caller.signal))
      .rejects.toThrow('caller cancelled response');
    await contacted;await vi.advanceTimersByTimeAsync(0);caller.abort(new Error('caller cancelled response'));await failed;
    expect(requestSignal?.aborted).toBe(true);expect(fetch).toHaveBeenCalledOnce();expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0]).toMatchObject({inferenceRequestStarted:true,tokensIn:null,tokensOut:null,outcome:'unknown'});
    expect(getEventListeners(caller.signal,'abort')).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
  });
  it('removes a completed caller listener and keeps later invocations independently cancellable', async () => {
    vi.useFakeTimers();const first=new AbortController(),second=new AbortController(),record=vi.fn();let entered!:()=>void;
    const contacted=new Promise<void>(resolve=>{entered=resolve;});
    const fetch=vi.fn().mockResolvedValueOnce(reported()).mockImplementationOnce(async()=>{
      entered();return new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/event-stream'}});
    });vi.stubGlobal('fetch',fetch);
    const complete=llamaLeaderTransport(binding(),cfg,{timeoutMs:1000},vi.fn().mockResolvedValue(runtime),record);
    expect(await complete('s','u',first.signal)).toContain('PRIVATE_RESPONSE_CANARY');
    expect(getEventListeners(first.signal,'abort')).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
    const failed=expect(complete('s','u',second.signal)).rejects.toThrow('second caller cancelled');
    await contacted;await vi.advanceTimersByTimeAsync(0);first.abort(new Error('completed caller'));expect(record).toHaveBeenCalledOnce();
    expect(getEventListeners(second.signal,'abort')).toHaveLength(1);second.abort(new Error('second caller cancelled'));await failed;
    expect(fetch).toHaveBeenCalledTimes(2);expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0]?.[0]).toMatchObject({tokensIn:12,tokensOut:3,outcome:'completed'});
    expect(record.mock.calls[1]?.[0]).toMatchObject({tokensIn:null,tokensOut:null,outcome:'unknown'});
    expect(getEventListeners(second.signal,'abort')).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
  });
  it('settles a pre-contact deadline once with no inferred usage, even if the observer throws', async () => {
    vi.useFakeTimers();const record=vi.fn(()=>{throw new Error('telemetry');}),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    const failed=expect(llamaLeaderTransport(binding(),cfg,{timeoutMs:100},()=>new Promise(()=>{}),record)('s','u')).rejects.toThrow('Runtime metadata cancelled');
    await vi.advanceTimersByTimeAsync(100);await failed;
    expect(record).toHaveBeenCalledOnce();expect(record.mock.calls[0]?.[0]).toMatchObject({inferenceRequestStarted:false,tokensIn:null,tokensOut:null,outcome:'failed'});
    expect(fetch).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it('settles Stop after contact once with unknown usage, preserves refusal and never retries', async () => {
    vi.useFakeTimers();const record=vi.fn(),fetch=vi.fn().mockResolvedValue(new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/event-stream'}}));vi.stubGlobal('fetch',fetch);
    const failed=expect(llamaLeaderTransport(binding(),cfg,{timeoutMs:1000},vi.fn().mockResolvedValue(runtime),record)('s','u')).rejects.toThrow(/binding unavailable/);
    await vi.advanceTimersByTimeAsync(1);mkdirSync(join(home,'.ashlr'),{recursive:true});writeFileSync(join(home,'.ashlr','KILL'),'Stop');
    await vi.advanceTimersByTimeAsync(100);await failed;
    expect(record).toHaveBeenCalledOnce();expect(record.mock.calls[0]?.[0]).toMatchObject({inferenceRequestStarted:true,tokensIn:null,tokensOut:null,outcome:'unknown'});
    expect(fetch).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps missing usage unknown, measured zero distinct and each request counted once', async () => {
    const metrics: LocalLeaderCompletionMetrics[] = [];
    const fetch = vi.fn().mockResolvedValueOnce(reported(null,null)).mockResolvedValueOnce(reported(0,0)); vi.stubGlobal('fetch',fetch);
    const complete = llamaLeaderTransport(binding(),cfg,{timeoutMs:1000},vi.fn().mockResolvedValue(runtime),m => {metrics.push(m);});
    await complete('s','u'); await complete('s','u');
    expect(metrics.map(m => [m.tokensIn,m.tokensOut,m.inferenceRequestStarted])).toEqual([[null,null,true],[0,0,true]]);
    expect(metrics[0]?.runId).not.toBe(metrics[1]?.runId); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('counts neither metadata refresh nor refused binding as an inference attempt', async () => {
    const record = vi.fn(), fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
    await expect(llamaLeaderTransport(binding(),cfg,{timeoutMs:1000},vi.fn().mockResolvedValue({...runtime,contextWindow:131072}),record)('s','u')).rejects.toThrow(/changed/);
    expect(fetch).not.toHaveBeenCalled(); expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0]).toMatchObject({inferenceRequestStarted:false,tokensIn:null,tokensOut:null,outcome:'failed'});
  });
  it('retains one attempted inference but unknown counts for a failed strict response without replay', async () => {
    const record = vi.fn(), fetch = vi.fn().mockResolvedValue(new Response('data: broken\n\n',{headers:{'content-type':'text/event-stream'}}));vi.stubGlobal('fetch',fetch);
    await expect(llamaLeaderTransport(binding(),cfg,{timeoutMs:1000},vi.fn().mockResolvedValue(runtime),record)('s','u')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce(); expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0]).toMatchObject({inferenceRequestStarted:true,tokensIn:null,tokensOut:null,outcome:'unknown'});
  });
  it('retains returned usage but refuses success when final binding changes', async () => {
    const pinned = binding(), record = vi.fn();
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async () => {
      const result = reported(); const responseText = await result.text();
      return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(responseText));writeFileSync(blob,'changed weights');c.close();}}),{headers:{'content-type':'text/event-stream'}});
    }));
    await expect(llamaLeaderTransport(pinned,cfg,{timeoutMs:1000},vi.fn().mockResolvedValue(runtime),record)('s','u')).rejects.toThrow(/binding/);
    expect(record).toHaveBeenCalledOnce();expect(record.mock.calls[0]?.[0]).toMatchObject({tokensIn:12,tokensOut:3,outcome:'unknown'});
  });
  it('does not replace unknown elapsed time with zero or let sync/async observers change completion', async () => {
    let clock = 100;vi.spyOn(performance,'now').mockImplementation(()=>clock);
    const record = vi.fn(()=>{throw new Error('observer');});
    vi.stubGlobal('fetch',vi.fn(async()=>{clock=50;return reported();}));
    expect(await llamaLeaderTransport(binding(),cfg,{timeoutMs:1000},vi.fn().mockResolvedValue(runtime),record)('s','u')).toContain('PRIVATE_RESPONSE_CANARY');
    expect(record.mock.calls[0]?.[0]).toMatchObject({elapsedMs:null,outcome:'completed'});
    expect(await llamaLeaderTransport(binding(),cfg,{timeoutMs:1000},vi.fn().mockResolvedValue(runtime),async()=>{throw new Error('async observer');})('s','u')).toContain('PRIVATE_RESPONSE_CANARY');
    await Promise.resolve();
  });
});
