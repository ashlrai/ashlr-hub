/** The local Leader opt-in never replays incomplete SSE as another inference. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';

const model = '/private/runtime/weights';
const messages = [{ role: 'user' as const, content: 'Plan the next useful task.' }];
const encoder = new TextEncoder();
function chunk(content: string | null, finish: string | null = null, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }], ...extra })}\n\n`;
}
const done = 'data: [DONE]\n\n';
function response(text: string, split = false): Response {
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function client(overrides: Record<string, unknown> = {}, base = 'http://127.0.0.1:8080/v1', key = '') {
  return buildOpenAICompatibleClient(base, key, model, false, 0.2, undefined, {
    strictStreaming: { expectedModel: model }, redirect: 'error', timeoutMs: 100,
    maxRequestBytes: 4096, maxResponseBytes: 4096, maxOutputTokens: 40, ...overrides,
  });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('strict local Leader stream', () => {
  it('accepts split UTF-8/CRLF frames only after stop and DONE, preserving reported usage', async () => {
    const fetch = vi.fn().mockResolvedValue(response((chunk('Hello 🧠') + chunk(null, 'stop') +
      `data: ${JSON.stringify({ model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n` + done).replace(/\n/g, '\r\n'), true));
    vi.stubGlobal('fetch', fetch);
    const delta = vi.fn();
    const result = await client().chatStream!(messages, undefined, delta);
    expect(result).toEqual({ content: 'Hello 🧠', usage: { tokensIn: 12, tokensOut: 3 }, usageKnown: true });
    expect(delta.mock.calls).toEqual([['Hello 🧠']]);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(init.redirect).toBe('error');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(String(init.body))).toMatchObject({ model, stream: true, max_tokens: 40, stream_options: { include_usage: true } });
  });
  it('keeps absent usage unknown rather than estimating provider token counts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(chunk('ok', 'stop') + done)));
    expect(await client().chatStream!(messages, undefined, () => {})).toMatchObject({ usageKnown: false });
  });
  it.each([
    ['missing DONE', chunk('partial', 'stop')],
    ['missing stop', chunk('partial') + done],
    ['length termination', chunk('partial', 'length') + done],
    ['tool termination', chunk('partial', 'tool_calls') + done],
    ['wrong model', chunk('partial', 'stop', { model: 'other' }) + done],
    ['array delta', chunk('partial') + `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: [], finish_reason: 'stop' }] })}\n\n` + done],
    ['multiple choices', `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: 'a' } }, { index: 1, delta: { content: 'b' }, finish_reason: 'stop' }] })}\n\n` + done],
    ['tool delta', `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { tool_calls: [{ id: 'call' }] }, finish_reason: 'stop' }] })}\n\n` + done],
    ['refusal delta', chunk('partial') + `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { refusal: 'refused' }, finish_reason: 'stop' }] })}\n\n` + done],
    ['empty result', chunk('', 'stop') + done],
    ['data after DONE', chunk('ok', 'stop') + done + chunk('more')],
    ['invalid JSON', 'data: nope\n\n'],
    ['dangling frame', chunk('ok', 'stop') + 'data: [DONE]'],
    ['fractional usage', chunk('ok', 'stop', { usage: { completion_tokens: 0.5 } }) + done],
    ['excess usage', chunk('ok', 'stop', { usage: { completion_tokens: 41 } }) + done],
  ])('refuses %s without emitting or replaying partial output', async (_label, text) => {
    const fetch = vi.fn().mockResolvedValue(response(text)); vi.stubGlobal('fetch', fetch);
    const delta = vi.fn();
    await expect(client().chatStream!(messages, undefined, delta)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce(); expect(delta).not.toHaveBeenCalled();
  });
  it.each([
    ['response bytes', { maxResponseBytes: 16 }, response(chunk('large', 'stop') + done)],
    ['missing stream type', {}, new Response('{}')],
    ['HTTP error', {}, new Response('', { status: 503 })],
    ['invalid UTF-8', {}, new Response(Uint8Array.of(0xff), { headers: { 'content-type': 'text/event-stream' } })],
  ])('holds %s within the original request', async (_name, overrides, reply) => {
    const fetch = vi.fn().mockResolvedValue(reply); vi.stubGlobal('fetch', fetch);
    await expect(client(overrides).chatStream!(messages, undefined, () => {})).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    ['remote', {}, 'https://example.com/v1', ''],
    ['embedded credentials', {}, 'http://user:pass@localhost:8080/v1', ''],
    ['API credential', {}, 'http://localhost:8080/v1', 'test-key'],
    ['redirect follow', { redirect: 'follow' }, 'http://localhost:8080/v1', ''],
    ['unbounded response', { maxResponseBytes: undefined }, 'http://localhost:8080/v1', ''],
    ['noninteger deadline', { timeoutMs: 0.5 }, 'http://localhost:8080/v1', ''],
    ['request/model mismatch', { strictStreaming: { expectedModel: 'another-model' } }, 'http://localhost:8080/v1', ''],
  ])('refuses %s before contact', async (_name, overrides, base, key) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(client(overrides, base, key).chatStream!(messages, undefined, () => {})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses tools and oversized request bodies before contact', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(client().chatStream!(messages, [{ name: 'execute' }], () => {})).rejects.toThrow();
    await expect(client({ maxRequestBytes: 8 }).chatStream!(messages, undefined, () => {})).rejects.toThrow(/byte limit/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('honors cancellation already active before dispatch', async () => {
    const controller = new AbortController(); controller.abort(new Error('Stop'));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(client().chatStream!(messages, undefined, () => {}, controller.signal)).rejects.toThrow('Stop');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds headers, body reads and hanging cancel cleanup by the original total deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(chunk('partial'))); }, cancel });
    const fetch = vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const result = client().chatStream!(messages, undefined, () => {});
    const settled = expect(result).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(100); await settled;
    expect(cancel).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a fetch that never resolves and never retries it', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetch);
    const result = expect(client().chatStream!(messages, undefined, () => {})).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(100); await result; expect(fetch).toHaveBeenCalledOnce();
  });
  it('aborts an in-progress body immediately on Stop without emitting or replay', async () => {
    const controller = new AbortController(), delta = vi.fn();
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const result = expect(client().chatStream!(messages, undefined, delta, controller.signal)).rejects.toThrow('Stop');
    await Promise.resolve(); controller.abort(new Error('Stop')); await result;
    expect(delta).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });
});
