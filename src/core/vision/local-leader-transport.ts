/** Private local Leader binding: a catalog tag must name the actual serving weights. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { probeLlamaRuntime } from '../local-runtime/llama/health.js';
import { resolveLlamaServerBaseUrl } from '../local-runtime/llama/config.js';
import { resolveOllamaModelBlob } from '../local-runtime/llama/ollama-blob.js';
import { buildOpenAICompatibleClient } from '../run/provider-client.js';
import { readKillSwitch } from '../sandbox/policy.js';
import type { LeaderCallOptions, LeaderComplete } from './leader-seat.js';

export interface LocalLeaderRuntime { baseUrl: string; servingModel: string; contextWindow: number }
export interface LocalLeaderBinding extends LocalLeaderRuntime {
  model: string; blobPath: string; manifestPath: string; epoch: string;
}

/** One settled local invocation; not decode speed, account usage or billing. */
export interface LocalLeaderCompletionMetrics {
  runId: string; finishedAt: string; model: string; contextWindow: number; bindingHint: string;
  elapsedMs: number | null; inferenceRequestStarted: boolean;
  tokensIn: number | null; tokensOut: number | null;
  outcome: 'completed' | 'failed' | 'unknown';
}

export function localLeaderBase(value: string): string | null {
  try {
    const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        !['localhost', '::1'].includes(host) && !/^127\.\d+\.\d+\.\d+$/.test(host) ||
        url.pathname.replace(/\/+$/, '') !== '/v1') return null;
    return url.origin + '/v1';
  } catch { return null; }
}

/** A fetch/body implementation must not extend the probe or call deadline. */
async function metadataWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Runtime metadata cancelled');
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Runtime metadata cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/** Only live props can identify the served model; an ownership-record fallback cannot. */
export async function readLocalLeaderRuntime(cfg: AshlrConfig, signal?: AbortSignal): Promise<LocalLeaderRuntime | null> {
  const baseUrl = localLeaderBase(resolveLlamaServerBaseUrl(cfg));
  if (!baseUrl || signal?.aborted) return null;
  let servingModel: string | null = null;
  const snapshot = await probeLlamaRuntime({ baseUrl, origin: new URL(baseUrl).origin, fetchImpl: async (url, init) => {
    const requestSignal = signal ? AbortSignal.any([signal, init.signal]) : init.signal;
    const response = await metadataWait(fetch(url, { method: 'GET', redirect: 'error', headers: { Accept: 'application/json' },
      signal: requestSignal }), requestSignal);
    return { ok: response.ok, status: response.status, json: async () => {
      if (!response.body) throw new Error('Runtime metadata unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const part = await metadataWait(reader.read(), requestSignal); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > 1024 * 1024) throw new Error('Runtime metadata too large');
          chunks.push(part.value);
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.endsWith('/props') && body && typeof body === 'object' && !Array.isArray(body)) {
          const props = body as Record<string, unknown>;
          const value = props['model_path'] ?? props['model_alias'];
          if (typeof value === 'string' && isAbsolute(value)) servingModel = value;
        }
        return body;
      } finally { try { void reader.cancel().catch(() => {}); } catch { /* Preserve metadata failure. */ } reader.releaseLock(); }
    } };
  } });
  if (signal?.aborted || snapshot.killSwitchEngaged || snapshot.state !== 'up' || snapshot.runtimeKind !== 'llama-server' ||
      snapshot.slots.source === 'unknown' || !Number.isSafeInteger(snapshot.contextPerSlot) || Number(snapshot.contextPerSlot) <= 0 ||
      servingModel === null) return null;
  return { baseUrl, servingModel, contextWindow: Number(snapshot.contextPerSlot) };
}

function epoch(paths: readonly string[]): string | null {
  try { return JSON.stringify(paths.map(path => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    return [path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  })); } catch { return null; }
}

export function bindLocalLeaderModel(runtime: LocalLeaderRuntime | null, model: string, contextWindow: number | null): LocalLeaderBinding | null {
  try {
    if (!runtime || !Number.isSafeInteger(runtime.contextWindow) || runtime.contextWindow < 1 ||
        contextWindow !== runtime.contextWindow || localLeaderBase(runtime.baseUrl) !== runtime.baseUrl) return null;
    const blob = resolveOllamaModelBlob(model);
    if (!blob.ok || realpathSync(runtime.servingModel) !== realpathSync(blob.blobPath)) return null;
    const boundEpoch = epoch([blob.blobPath, blob.manifestPath]);
    return boundEpoch === null ? null : { ...runtime, model, blobPath: blob.blobPath, manifestPath: blob.manifestPath, epoch: boundEpoch };
  } catch { return null; }
}

export function localLeaderBindingCurrent(binding: LocalLeaderBinding, cfg: AshlrConfig): boolean {
  return readKillSwitch().state === 'inactive' && localLeaderBase(resolveLlamaServerBaseUrl(cfg)) === binding.baseUrl &&
    epoch([binding.blobPath, binding.manifestPath]) === binding.epoch;
}

/** Same local API request path as workers; no credentials, listener or tool authority. */
export function llamaLeaderTransport(inputBinding: LocalLeaderBinding, cfg: AshlrConfig, opts: LeaderCallOptions = {},
  readRuntime: typeof readLocalLeaderRuntime = readLocalLeaderRuntime,
  record?: (metrics: Readonly<LocalLeaderCompletionMetrics>) => void): LeaderComplete {
  // Correlation follows the selected snapshot; later settings cannot relabel it.
  const binding = Object.freeze({ ...inputBinding });
  const selected = binding;
  const bindingHint = createHash('sha256').update(JSON.stringify(selected)).digest('hex');
  return async (system, user, signal) => {
    const runId = randomUUID();
    let inferenceRequestStarted = false;
    let tokensIn: number | null = null, tokensOut: number | null = null;
    let outcome: LocalLeaderCompletionMetrics['outcome'] = 'failed';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Local Leader deadline elapsed')), opts.timeoutMs ?? 15 * 60_000);
    const watch = setInterval(() => { if (!localLeaderBindingCurrent(binding, cfg)) controller.abort(new Error('Local Leader binding unavailable')); }, 100);
    watch.unref(); const started = performance.now();
    const onAbort = () => controller.abort(signal?.reason);
    try {
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      controller.signal.throwIfAborted();
      if (!localLeaderBindingCurrent(binding, cfg)) throw new Error('Local Leader binding unavailable');
      const current = await metadataWait(readRuntime(cfg, controller.signal), controller.signal);
      const fresh = bindLocalLeaderModel(current, binding.model, binding.contextWindow);
      if (!fresh || JSON.stringify(fresh) !== JSON.stringify(binding) || !localLeaderBindingCurrent(binding, cfg)) {
        throw new Error('Local Leader serving model or context changed');
      }
      const remaining = (opts.timeoutMs ?? 15 * 60_000) - (performance.now() - started);
      if (remaining <= 0 || controller.signal.aborted) throw new Error('Local Leader deadline elapsed');
      const client = buildOpenAICompatibleClient(binding.baseUrl, '', binding.servingModel, false, 0.2, controller.signal, {
        cfg, onRequestStart: () => { inferenceRequestStarted = true; }, strictStreaming: { expectedModel: binding.servingModel }, redirect: 'error', timeoutMs: Math.ceil(remaining),
        maxRequestBytes: 1024 * 1024, maxResponseBytes: 1024 * 1024, maxOutputTokens: opts.maxOutputTokens ?? 4096,
      });
      const result = await client.chatStream!([{ role: 'system', content: system }, { role: 'user', content: user }], undefined, () => {}, controller.signal);
      if (result.usageKnown === true && Number.isSafeInteger(result.usage.tokensIn) && result.usage.tokensIn >= 0 &&
          Number.isSafeInteger(result.usage.tokensOut) && result.usage.tokensOut >= 0) {
        tokensIn = result.usage.tokensIn; tokensOut = result.usage.tokensOut;
      }
      if (!localLeaderBindingCurrent(binding, cfg) || controller.signal.aborted) throw new Error('Local Leader binding unavailable');
      outcome = 'completed';
      return result.content;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      controller.abort(); clearTimeout(timer); clearInterval(watch);
      const elapsed = performance.now() - started;
      const metrics = Object.freeze({ runId, finishedAt: new Date().toISOString(), model: selected.model,
        contextWindow: selected.contextWindow, bindingHint,
        elapsedMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
        inferenceRequestStarted, tokensIn, tokensOut,
        outcome: outcome === 'completed' ? outcome : inferenceRequestStarted ? 'unknown' : 'failed' });
      try { void Promise.resolve(record?.(metrics)).catch(() => {}); } catch { /* Telemetry never changes the completion or its refusal. */ }
    }
  };
}
