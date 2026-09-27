/**
 * Local models as first-class seats: warm one on demand and measure how fast
 * it really generates.
 *
 * WARM = load the weights before the first turn needs them, and keep them
 * resident (Ollama `keep_alive`), so the operator's first message does not pay
 * a 10–40 s cold load. The same call measures generation speed:
 *   - Ollama lane: `/api/generate` reports `eval_count` / `eval_duration`
 *     (pure generation, no prompt processing) and `load_duration` (the cold
 *     start it just paid) — exact figures.
 *   - llama-server lane: the Anthropic-compatible proxy the seat dispatches
 *     to (`/v1/messages`), measured end to end — a floor, labelled as such.
 *
 * LOOPBACK ONLY. A warm-up sends a fixed one-line prompt and nothing from any
 * chat, but it still must never reach a non-local host: an endpoint that is
 * not 127.0.0.1 / localhost / ::1 is refused before any request is made (the
 * same rule `verseSeatPermitted` applies to a local seat's turns).
 *
 * The last reading per model is kept in memory for the badges.
 */
import type { LocalWarmResult } from './types.js';

export const LOCAL_WARM_TIMEOUT_MS = 90_000;
/** How long a warmed model stays resident in Ollama. */
export const LOCAL_KEEP_ALIVE = '30m';
const WARM_PROMPT = 'Reply with the single word: ready';

export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

export interface Throughput {
  tokPerSec: number;
  source: 'warm' | 'turn';
  at: string;
}

const lastByModel = new Map<string, Throughput>();

export function recordThroughput(model: string, reading: Throughput): void {
  if (!Number.isFinite(reading.tokPerSec) || reading.tokPerSec <= 0) return;
  lastByModel.set(model, reading);
}

export function lastThroughput(model: string): Throughput | null {
  return lastByModel.get(model) ?? null;
}

export function resetThroughputForTest(): void {
  lastByModel.clear();
}

export interface WarmTarget {
  seatId: string;
  model: string;
  /** Where the model is discovered (Ollama). */
  ollamaBaseUrl: string;
  /** Set when the seat dispatches through the llama-server proxy instead. */
  anthropicBaseUrl?: string | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function warmLocalModel(
  target: WarmTarget,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<LocalWarmResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const lane = target.anthropicBaseUrl && target.anthropicBaseUrl !== target.ollamaBaseUrl ? 'llama-server' : 'ollama';
  const base = (lane === 'llama-server' ? target.anthropicBaseUrl! : target.ollamaBaseUrl).replace(/\/+$/, '');
  const fail = (error: string, ms = 0): LocalWarmResult => ({ seatId: target.seatId, ok: false, ms, loadMs: null, tokPerSec: null, error });
  if (!isLoopbackUrl(base)) return fail('This local seat does not point at this Mac, so it is not warmed.');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? LOCAL_WARM_TIMEOUT_MS);
  const started = now();
  try {
    if (lane === 'ollama') {
      const res = await fetchImpl(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: target.model,
          prompt: WARM_PROMPT,
          stream: false,
          keep_alive: LOCAL_KEEP_ALIVE,
          options: { num_predict: 24, temperature: 0 },
        }),
        signal: abort.signal,
      });
      const ms = now() - started;
      if (!res.ok) return fail(`The runtime answered ${res.status}.`, ms);
      const body = (await res.json()) as Record<string, unknown>;
      const evalCount = Number(body['eval_count']);
      const evalNs = Number(body['eval_duration']);
      const loadNs = Number(body['load_duration']);
      const tokPerSec = evalCount > 0 && evalNs > 0 ? round1(evalCount / (evalNs / 1e9)) : null;
      if (tokPerSec !== null) recordThroughput(target.model, { tokPerSec, source: 'warm', at: new Date(now()).toISOString() });
      return {
        seatId: target.seatId,
        ok: true,
        ms,
        loadMs: loadNs > 0 ? Math.round(loadNs / 1e6) : null,
        tokPerSec,
        error: null,
      };
    }
    const res = await fetchImpl(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: target.model, max_tokens: 24, messages: [{ role: 'user', content: WARM_PROMPT }] }),
      signal: abort.signal,
    });
    const ms = now() - started;
    if (!res.ok) return fail(`The runtime answered ${res.status}.`, ms);
    const body = (await res.json()) as { usage?: { output_tokens?: unknown } };
    const out = Number(body.usage?.output_tokens);
    const tokPerSec = out > 0 && ms > 0 ? round1(out / (ms / 1000)) : null;
    if (tokPerSec !== null) recordThroughput(target.model, { tokPerSec, source: 'turn', at: new Date(now()).toISOString() });
    return { seatId: target.seatId, ok: true, ms, loadMs: null, tokPerSec, error: null };
  } catch {
    const ms = now() - started;
    return fail(abort.signal.aborted ? 'The model took too long to load.' : 'The local runtime is not reachable.', ms);
  } finally {
    clearTimeout(timer);
  }
}
