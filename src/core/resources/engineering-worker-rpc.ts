import { isMainThread } from 'node:worker_threads';
import { types } from 'node:util';

const MAX_BYTES = 2 * 1024 * 1024;
const HEADER_BYTES = 16;
const PENDING = 0, RUNNING = 1, SUCCESS = 2, FAILED = 3, CANCELLED = 4;
const METHOD = /^[a-zA-Z][a-zA-Z0-9.]{0,95}$/;
export class EngineeringWorkerRpcError extends Error {
  constructor(readonly code: string, readonly uncertain = false) { super(`Engineering host RPC ${code}`); this.name = 'EngineeringWorkerRpcError'; }
}
export interface EngineeringWorkerRpcClientOptions {
  port: { postMessage(value: unknown): void };
  closeFlag: Int32Array;
  timeoutMs?: number;
  maxBytes?: number;
}
export interface EngineeringWorkerRpcHostOptions {
  handlers: Readonly<Record<string, (input: unknown) => unknown>>;
  closeFlag: Int32Array;
  maxBytes?: number;
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new EngineeringWorkerRpcError('INVALID_OPTIONS');
  return result;
}
function flag(value: Int32Array): Int32Array {
  if (!(value instanceof Int32Array) || !(value.buffer instanceof SharedArrayBuffer) || value.length !== 1 || value.byteOffset !== 0 ||
      value.buffer.byteLength !== 4) throw new EngineeringWorkerRpcError('INVALID_OPTIONS');
  return value;
}
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !types.isProxy(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
/** Refuse executable aliases and lossy JSON values before crossing the boundary. */
function json(value: unknown, maxBytes: number): string {
  const ancestors = new Set<object>(); let count = 0;
  function visit(item: unknown, depth: number): void {
    if (++count > 100_000 || depth > 64) throw new EngineeringWorkerRpcError('INVALID_DATA');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || !item || types.isProxy(item) || !Array.isArray(item) && !plain(item) || ancestors.has(item)) {
      throw new EngineeringWorkerRpcError('INVALID_DATA');
    }
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string') || Array.isArray(item) &&
        (item.length > 100_000 || Object.keys(descriptors).length !== item.length + 1 ||
          Array.from({ length: item.length }, (_, index) => index).some(index => !Object.hasOwn(descriptors, index)))) throw new EngineeringWorkerRpcError('INVALID_DATA');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new EngineeringWorkerRpcError('INVALID_DATA');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > maxBytes) throw new EngineeringWorkerRpcError('OVERSIZED');
  return result;
}

/** Only the worker blocks. A fresh buffer prevents late replies aliasing another call. */
export function createEngineeringWorkerRpcClient(options: EngineeringWorkerRpcClientOptions) {
  if (isMainThread) throw new EngineeringWorkerRpcError('WORKER_ONLY');
  const closeFlag = flag(options.closeFlag);
  const maxBytes = limit(options.maxBytes, MAX_BYTES, MAX_BYTES);
  if (maxBytes < 128) throw new EngineeringWorkerRpcError('INVALID_OPTIONS');
  const timeoutMs = limit(options.timeoutMs, 30_000, 60_000);
  const post = options.port.postMessage.bind(options.port);
  let sequence = 0;
  const isClosed = () => Atomics.load(closeFlag, 0) !== 0;
  return { isClosed, call<T = unknown>(method: string, input: unknown = null): T {
    if (typeof method !== 'string' || !METHOD.test(method)) throw new EngineeringWorkerRpcError('INVALID_METHOD');
    if (isClosed()) throw new EngineeringWorkerRpcError('CLOSED');
    const deadline = performance.now() + timeoutMs;
    const inputJson = json(input, maxBytes);
    if (isClosed()) throw new EngineeringWorkerRpcError('CLOSED');
    if (performance.now() >= deadline) throw new EngineeringWorkerRpcError('TIMEOUT_CANCELLED');
    if (sequence >= 0x7fffffff) throw new EngineeringWorkerRpcError('ID_EXHAUSTED');
    const id = ++sequence;
    const response = new SharedArrayBuffer(HEADER_BYTES + maxBytes);
    const header = new Int32Array(response, 0, 4); Atomics.store(header, 2, id);
    try { post({ type: 'engineering-host-call', id, method, inputJson, response }); }
    catch {
      const previous = Atomics.compareExchange(header, 0, PENDING, CANCELLED);
      throw new EngineeringWorkerRpcError('TRANSPORT_FAILED', previous !== PENDING && previous !== CANCELLED);
    }
    while (true) {
      const state = Atomics.load(header, 0);
      if (isClosed() || performance.now() >= deadline) {
        const previous = Atomics.compareExchange(header, 0, PENDING, CANCELLED);
        throw new EngineeringWorkerRpcError(isClosed() ? 'CLOSED' : previous === PENDING || previous === CANCELLED ? 'TIMEOUT_CANCELLED' : 'TIMEOUT_UNCERTAIN',
          previous !== PENDING && previous !== CANCELLED);
      }
      if (state === SUCCESS || state === FAILED) {
        const size = Atomics.load(header, 1);
        if (Atomics.load(header, 2) !== id || size < 1 || size > maxBytes) throw new EngineeringWorkerRpcError('INVALID_RESPONSE', true);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(new Uint8Array(response, HEADER_BYTES, size))); }
        catch { throw new EngineeringWorkerRpcError('INVALID_RESPONSE', true); }
        if (!plain(value) || Object.keys(value).some(key => !(state === SUCCESS ? ['ok', 'value'] : ['ok', 'code', 'uncertain']).includes(key)) || value.ok !== (state === SUCCESS)) {
          throw new EngineeringWorkerRpcError('INVALID_RESPONSE', true);
        }
        if (state === FAILED) {
          if (!['CLOSED', 'INVALID_REQUEST', 'HANDLER_FAILED'].includes(String(value.code)) || typeof value.uncertain !== 'boolean') {
            throw new EngineeringWorkerRpcError('INVALID_RESPONSE', true);
          }
          throw new EngineeringWorkerRpcError(String(value.code), value.uncertain);
        }
        return value.value as T;
      }
      if (state !== PENDING && state !== RUNNING) throw new EngineeringWorkerRpcError('INVALID_RESPONSE', true);
      Atomics.wait(header, 0, state, Math.min(25, Math.max(1, deadline - performance.now())));
    }
  } };
}

/** Closed synchronous dispatch only. Host handlers must never call/await the worker. */
export function createEngineeringWorkerRpcHost(options: EngineeringWorkerRpcHostOptions) {
  const closeFlag = flag(options.closeFlag);
  const maxBytes = limit(options.maxBytes, MAX_BYTES, MAX_BYTES);
  if (maxBytes < 128) throw new EngineeringWorkerRpcError('INVALID_OPTIONS');
  if (!plain(options.handlers)) throw new EngineeringWorkerRpcError('INVALID_OPTIONS');
  const handlers = new Map<string, (input: unknown) => unknown>();
  for (const key of Reflect.ownKeys(options.handlers)) {
    const descriptor = Object.getOwnPropertyDescriptor(options.handlers, key)!;
    if (typeof key !== 'string' || !METHOD.test(key) || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' || types.isAsyncFunction(descriptor.value)) throw new EngineeringWorkerRpcError('INVALID_OPTIONS');
    handlers.set(key, descriptor.value as (input: unknown) => unknown);
  }
  let sequence = 0; let running = false;
  return {
    close() { Atomics.store(closeFlag, 0, 1); },
    handle(message: unknown): boolean {
      if (!plain(message)) return false;
      const descriptors = Object.getOwnPropertyDescriptors(message);
      if (descriptors.type?.value !== 'engineering-host-call') return false;
      if (Reflect.ownKeys(message).length !== 5 || !['type', 'id', 'method', 'inputJson', 'response'].every(key =>
        descriptors[key] && Object.hasOwn(descriptors[key], 'value'))) return true;
      const { id, method, inputJson, response } = message;
      if (!Number.isSafeInteger(id) || (id as number) < 1 || (id as number) > 0x7fffffff || !(response instanceof SharedArrayBuffer) ||
          response.byteLength < HEADER_BYTES + 128 || response.byteLength > HEADER_BYTES + maxBytes) return true;
      const header = new Int32Array(response, 0, 4);
      if (Atomics.load(header, 2) !== id || (id as number) <= sequence) return true;
      sequence = id as number;
      if (Atomics.compareExchange(header, 0, PENDING, RUNNING) !== PENDING) return true;
      let invoked = false;
      const reply = (value: unknown, state: number) => {
        const bytes = Buffer.from(json(value, response.byteLength - HEADER_BYTES));
        new Uint8Array(response, HEADER_BYTES, bytes.length).set(bytes);
        Atomics.store(header, 1, bytes.length); Atomics.store(header, 0, state); Atomics.notify(header, 0);
      };
      try {
        if (Atomics.load(closeFlag, 0) !== 0) { reply({ ok: false, code: 'CLOSED', uncertain: false }, FAILED); return true; }
        if (running || typeof method !== 'string' || !handlers.has(method) || typeof inputJson !== 'string' || Buffer.byteLength(inputJson) > maxBytes) {
          reply({ ok: false, code: 'INVALID_REQUEST', uncertain: false }, FAILED); return true;
        }
        const input: unknown = JSON.parse(inputJson); json(input, maxBytes);
        running = true; invoked = true;
        const value = handlers.get(method)!(input);
        if (types.isPromise(value)) { void value.catch(() => {}); throw new Error('Asynchronous RPC handler'); }
        reply({ ok: true, ...(value === undefined ? {} : { value }) }, SUCCESS);
      } catch {
        reply({ ok: false, code: invoked ? 'HANDLER_FAILED' : 'INVALID_REQUEST', uncertain: invoked }, FAILED);
      } finally { if (invoked) running = false; }
      return true;
    },
  };
}
