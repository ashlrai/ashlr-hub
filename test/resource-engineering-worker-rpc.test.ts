import { afterEach, describe, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createEngineeringWorkerRpcClient, createEngineeringWorkerRpcHost } from '../src/core/resources/engineering-worker-rpc.js';

const workers: Worker[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.terminate())); });
function closeFlag() { return new Int32Array(new SharedArrayBuffer(4)); }
function request(id = 1, method = 'owner.snapshot', inputJson = '[]') {
  const response = new SharedArrayBuffer(16 + 256); const header = new Int32Array(response, 0, 4); header[2] = id;
  return { type: 'engineering-host-call', id, method, inputJson, response };
}
function reply(message: ReturnType<typeof request>) {
  const header = new Int32Array(message.response, 0, 4);
  return JSON.parse(Buffer.from(message.response, 16, header[1]!).toString('utf8'));
}
async function workerFixture(onRequest: (message: ReturnType<typeof request>) => void, options: { timeoutMs?: number; body?: string; close?: Int32Array } = {}) {
  const close = options.close ?? closeFlag();
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
  const source = new URL('../src/core/resources/engineering-worker-rpc.ts', import.meta.url).href;
  const script = `import {register} from ${JSON.stringify(loader)};register();
    const {createEngineeringWorkerRpcClient}=await import(${JSON.stringify(source)});
    const {parentPort,workerData}=await import('node:worker_threads');
    const client=createEngineeringWorkerRpcClient({port:parentPort,closeFlag:workerData.close,timeoutMs:workerData.timeoutMs,maxBytes:256});
    parentPort.once('message',()=>{try{const value=(()=>{${options.body ?? "return client.call('owner.snapshot', ['one']);"}})();
      parentPort.postMessage({type:'done',ok:true,value});}catch(error){parentPort.postMessage({type:'done',ok:false,code:error.code,uncertain:error.uncertain});}});
    parentPort.postMessage({type:'ready'});`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`), {
    workerData: { close, timeoutMs: options.timeoutMs ?? 1000 }, execArgv: [],
  });
  workers.push(worker);
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.type === 'ready') ready();
      else if (message.type === 'done') resolve(message);
      else onRequest(message);
    });
  });
  await started;
  return { worker, close, done, start: () => worker.postMessage('start') };
}

describe('closed engineering host RPC protocol', () => {
  it('never permits blocking RPC on the parent thread', () => {
    expect(() => createEngineeringWorkerRpcClient({ port: { postMessage() {} }, closeFlag: closeFlag() })).toThrow('WORKER_ONLY');
  });
  it('captures only own synchronous handlers, with no accessor invocation or mutable map alias', () => {
    const getter = vi.fn(); const handlers = Object.defineProperty({}, 'owner.snapshot', { get: getter });
    expect(() => createEngineeringWorkerRpcHost({ handlers, closeFlag: closeFlag() })).toThrow('INVALID_OPTIONS');
    expect(getter).not.toHaveBeenCalled();
    expect(() => createEngineeringWorkerRpcHost({ handlers: { read: async () => 1 }, closeFlag: closeFlag() })).toThrow('INVALID_OPTIONS');
    const map = { read: () => 'original' }; const host = createEngineeringWorkerRpcHost({ handlers: map, closeFlag: closeFlag(), maxBytes: 256 });
    map.read = () => 'changed'; const message = request(1, 'read'); host.handle(message);
    expect(reply(message)).toEqual({ ok: true, value: 'original' });
  });
  it('binds monotonic IDs and executes no duplicate, cancelled or unknown method', () => {
    const handler = vi.fn(() => 1); const host = createEngineeringWorkerRpcHost({ handlers: { 'owner.snapshot': handler }, closeFlag: closeFlag(), maxBytes: 256 });
    const first = request(); expect(host.handle(first)).toBe(true); expect(host.handle(first)).toBe(true);
    const cancelled = request(2); new Int32Array(cancelled.response)[0] = 4; host.handle(cancelled);
    const unknown = request(3, 'owner.anything'); host.handle(unknown);
    expect(reply(unknown)).toEqual({ ok: false, code: 'INVALID_REQUEST', uncertain: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong-id', 'extra-field', 'getter', 'oversized', 'malformed', 'wrong-buffer'])(
    'refuses malformed requests without host effects: %s', kind => {
      const handler = vi.fn(); const host = createEngineeringWorkerRpcHost({ handlers: { 'owner.snapshot': handler }, closeFlag: closeFlag(), maxBytes: 256 });
      const message = request();
      if (kind === 'wrong-id') new Int32Array(message.response)[2] = 9;
      if (kind === 'extra-field') Object.assign(message, { extra: true });
      if (kind === 'getter') Object.defineProperty(message, 'inputJson', { get: () => { throw Error('must not run'); } });
      if (kind === 'oversized') message.inputJson = ' '.repeat(257);
      if (kind === 'malformed') message.inputJson = '{';
      if (kind === 'wrong-buffer') Object.assign(message, { response: new ArrayBuffer(272) });
      expect(() => host.handle(message)).not.toThrow(); expect(handler).not.toHaveBeenCalled();
    });
  it('rejects nested dispatch and never runs an asynchronous continuation as a successful RPC', () => {
    const nested = request(2);
    const handler = vi.fn(() => { host.handle(nested); return Promise.resolve('not synchronous'); });
    const host = createEngineeringWorkerRpcHost({ handlers: { 'owner.snapshot': handler }, closeFlag: closeFlag(), maxBytes: 256 });
    const first = request(); host.handle(first);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(reply(nested)).toMatchObject({ ok: false, code: 'INVALID_REQUEST', uncertain: false });
    expect(reply(first)).toMatchObject({ ok: false, code: 'HANDLER_FAILED', uncertain: true });
  });
  it('bounds failed/oversized handler responses and refuses dispatch after close', () => {
    const handler = vi.fn(() => 'x'.repeat(257)); const host = createEngineeringWorkerRpcHost({ handlers: { 'owner.snapshot': handler }, closeFlag: closeFlag(), maxBytes: 256 });
    const first = request(); host.handle(first); expect(reply(first)).toMatchObject({ code: 'HANDLER_FAILED', uncertain: true });
    host.close(); const second = request(2); host.handle(second);
    expect(reply(second)).toEqual({ ok: false, code: 'CLOSED', uncertain: false }); expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('actual worker-only synchronous RPC races', () => {
  it('does not send any request when closed before the call', async () => {
    const close = closeFlag(); Atomics.store(close, 0, 1); const called = vi.fn();
    const f = await workerFixture(called, { close });
    f.start(); expect(await f.done).toMatchObject({ ok: false, code: 'CLOSED', uncertain: false }); expect(called).not.toHaveBeenCalled();
  });
  it('round-trips fixed calls on fresh buffers while the parent timer keeps running', async () => {
    const close = closeFlag(); const host = createEngineeringWorkerRpcHost({ handlers: { 'owner.snapshot': value => value }, closeFlag: close, maxBytes: 256 });
    const buffers = new Set<SharedArrayBuffer>(); let ticks = 0;
    const f = await workerFixture(message => { buffers.add(message.response); setTimeout(() => host.handle(message), 50); }, {
      close, body: "return [client.call('owner.snapshot',['one']),client.call('owner.snapshot',['two'])];",
    });
    const timer = setInterval(() => ticks++, 5);
    try { f.start(); expect(await f.done).toMatchObject({ ok: true, value: [['one'], ['two']] }); }
    finally { clearInterval(timer); }
    expect(buffers.size).toBe(2); expect(ticks).toBeGreaterThan(2);
  });
  it('cancels a timed-out pending request atomically so late service cannot execute it', async () => {
    let pending!: ReturnType<typeof request>; const handler = vi.fn(); const close = closeFlag();
    const host = createEngineeringWorkerRpcHost({ handlers: { 'owner.snapshot': handler }, closeFlag: close, maxBytes: 256 });
    const f = await workerFixture(message => { pending = message; }, { close, timeoutMs: 50 });
    f.start(); expect(await f.done).toMatchObject({ ok: false, code: 'TIMEOUT_CANCELLED', uncertain: false });
    expect(new Int32Array(pending.response)[0]).toBe(4); host.handle(pending); expect(handler).not.toHaveBeenCalled();
  });
  it('reports running timeout as uncertain and never retries an already claimed mutation', async () => {
    const close = closeFlag(); let effects = 0;
    const host = createEngineeringWorkerRpcHost({ handlers: { 'owner.snapshot': () => {
      const until = performance.now() + 150; while (performance.now() < until) { /* Deliberate bounded parent work. */ }
      effects++; return 'committed';
    } }, closeFlag: close, maxBytes: 256 });
    const f = await workerFixture(message => host.handle(message), { close, timeoutMs: 50 });
    f.start(); expect(await f.done).toMatchObject({ ok: false, code: 'TIMEOUT_UNCERTAIN', uncertain: true }); expect(effects).toBe(1);
  });
  it('reports oversize output after a host effect as uncertain without replay', async () => {
    const close = closeFlag(); const handler = vi.fn(() => 'x'.repeat(300));
    const host = createEngineeringWorkerRpcHost({ handlers: { 'owner.snapshot': handler }, closeFlag: close, maxBytes: 256 });
    const f = await workerFixture(message => host.handle(message), { close });
    f.start(); expect(await f.done).toMatchObject({ ok: false, code: 'HANDLER_FAILED', uncertain: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('does not mistake a close concurrent with completed host effects for a no-effect refusal', async () => {
    const close = closeFlag(); let effects = 0;
    const host = createEngineeringWorkerRpcHost({ handlers: { 'owner.snapshot': () => {
      effects++; Atomics.store(close, 0, 1); return 'committed';
    } }, closeFlag: close, maxBytes: 256 });
    const f = await workerFixture(message => host.handle(message), { close });
    f.start(); expect(await f.done).toMatchObject({ ok: false, code: 'CLOSED', uncertain: true }); expect(effects).toBe(1);
  });
  it('observes the shared close flag during a pending wait without dispatching cleanup as a mutation', async () => {
    const close = closeFlag(); const handler = vi.fn(); const host = createEngineeringWorkerRpcHost({ handlers: { 'owner.snapshot': handler }, closeFlag: close, maxBytes: 256 });
    let pending!: ReturnType<typeof request>;
    const f = await workerFixture(message => { pending = message; host.close(); }, { close });
    f.start(); expect(await f.done).toMatchObject({ ok: false, code: 'CLOSED', uncertain: false });
    host.handle(pending); expect(handler).not.toHaveBeenCalled();
  });
  it.each(['id', 'length', 'json', 'state'])('refuses a malformed parent response: %s', async kind => {
    const f = await workerFixture(message => {
      const header = new Int32Array(message.response, 0, 4);
      const bytes = Buffer.from(kind === 'json' ? '{' : '{"ok":true,"value":1}');
      new Uint8Array(message.response, 16, bytes.length).set(bytes);
      Atomics.store(header, 1, kind === 'length' ? 9999 : bytes.length);
      if (kind === 'id') Atomics.store(header, 2, 99);
      Atomics.store(header, 0, kind === 'state' ? 9 : 2); Atomics.notify(header, 0);
    });
    f.start(); expect(await f.done).toMatchObject({ ok: false, code: 'INVALID_RESPONSE', uncertain: true });
  });
});
