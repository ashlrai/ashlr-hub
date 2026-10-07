/**
 * client.test.ts — how apiPost classifies a refused write.
 *
 * The one distinction that matters: a CODELESS 404 is the --allow-dispatch
 * gate (DispatchDisabledError, "this server is read-only"), while a 404 that
 * carries a `code` is a real route refusing a real request ("session not
 * found") and must stay an ApiError with that code — otherwise a deleted chat
 * is reported as a read-only server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, apiPost, apiDelete, DispatchDisabledError, readFailureReason, MetadataReadTimeoutError, METADATA_JSON_READ_TIMEOUT_MS } from './client.js';
import { markCheckComplete } from './auth-store.js';

function respond(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' } },
  )));
}

async function refusal(): Promise<unknown> {
  try {
    await apiPost('/api/verse/sessions/vs_1/context-mode', { mode: 'expansive' }, 't'.repeat(64));
  } catch (err) {
    return err;
  }
  throw new Error('expected apiPost to throw');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  markCheckComplete(false);
  document.head.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

it('expires a remote phone read on an Access HTML response without forwarding Hub headers', async () => {
  window.history.replaceState(null, '', '/verse/m/');
  document.head.innerHTML = '<meta name="ashlr-remote-gateway" content="v1">';
  markCheckComplete(true);
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response('<html>Access login</html>', { headers: { 'Content-Type': 'text/html' } }));
  vi.stubGlobal('fetch', fetch);
  await expect(apiGet('/api/verse/bootstrap')).rejects.toMatchObject({ status: 401 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', cache: 'no-store' });
  const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
  expect(headers.has('x-ashlr-token')).toBe(false);
  expect(headers.has('x-ashlr-read-client')).toBe(false);
});

describe('apiPost — refusals', () => {
  it('maps the dispatch gate’s bare 404 to DispatchDisabledError', async () => {
    respond(404, { error: 'not found' });
    const err = await refusal();
    expect(err).toBeInstanceOf(DispatchDisabledError);
    expect((err as ApiError).status).toBe(404);
  });

  it('treats an unknown-route 404 (also codeless) the same way — the two are indistinguishable by design', async () => {
    respond(404, { error: 'not found: POST /api/verse/sessions/vs_1/nope' });
    expect(await refusal()).toBeInstanceOf(DispatchDisabledError);
  });

  it('treats a non-JSON 404 as the dispatch gate too', async () => {
    respond(404, 'Not Found');
    expect(await refusal()).toBeInstanceOf(DispatchDisabledError);
  });

  it('keeps a 404 that carries a code as an ApiError with that code and sentence', async () => {
    respond(404, { code: 'VERSE_SESSION_NOT_FOUND', error: 'session not found: vs_1' });
    const err = await refusal();
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(DispatchDisabledError);
    expect(err).toMatchObject({ status: 404, code: 'VERSE_SESSION_NOT_FOUND', detail: 'session not found: vs_1' });
    expect((err as ApiError).message).toBe('POST /api/verse/sessions/vs_1/context-mode failed (HTTP 404): session not found: vs_1.');
  });

  it('carries the code on other refusals, and null when there is none', async () => {
    respond(409, { code: 'VERSE_SESSION_BUSY', error: 'a turn is running' });
    expect(await refusal()).toMatchObject({ status: 409, code: 'VERSE_SESSION_BUSY', detail: 'a turn is running' });
    respond(500, { error: 'boom' });
    expect(await refusal()).toMatchObject({ status: 500, code: null, detail: 'boom' });
  });

  it('still reads the plain-language `note` when a refusal has no `error`', async () => {
    respond(409, { ok: false, note: 'no repositories are enrolled, so the loop would do nothing' });
    expect(await refusal()).toMatchObject({ status: 409, detail: 'no repositories are enrolled, so the loop would do nothing' });
  });

  it('reports a rejected token as a 401 ApiError, never the dispatch error', async () => {
    respond(401, { error: 'unauthorized' });
    const err = await refusal();
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(DispatchDisabledError);
    expect((err as ApiError).status).toBe(401);
  });
});

describe('readFailureReason — what a surface prints after its own "X unavailable."', () => {
  it("prefers the route's own sentence over the GET wrapper", () => {
    const err = new ApiError('GET /api/verse/budget failed (HTTP 503).', 503, '/api/verse/budget', 'Seat capacity could not be read.');
    expect(readFailureReason(err)).toBe('Seat capacity could not be read.');
  });

  it('names the status when the route sent no sentence', () => {
    expect(readFailureReason(new ApiError('GET /x failed (HTTP 502).', 502, '/x'))).toBe('The server answered HTTP 502.');
  });

  it("never shows a browser's own exception text", () => {
    // fetch() rejects with a TypeError when nothing answered.
    expect(readFailureReason(new TypeError('Failed to fetch'))).toBe('The server did not answer.');
    expect(readFailureReason(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe('The request failed.');
    expect(readFailureReason('boom')).toBe('The request failed.');
  });
});


describe('authenticated JSON read lifetime', () => {
  it('aborts a stalled transport and clears its owned timer and caller listener', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removed = vi.spyOn(caller.signal, 'removeEventListener');
    let passed!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      passed = init.signal!;
      passed.addEventListener('abort', () => reject(passed.reason), { once: true });
    })));
    const result = apiGet('/api/verse/fleet/control', caller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(METADATA_JSON_READ_TIMEOUT_MS);
    const error = await result;
    expect(passed.aborted).toBe(true);
    expect(error).toBeInstanceOf(MetadataReadTimeoutError);
    expect(error).toBe(passed.reason);
    expect((error as MetadataReadTimeoutError).name).toBe('AbortError');
    expect(readFailureReason(error)).toBe('The read timed out. Try again.');
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 503])('keeps the deadline through the local HTTP%s JSON body', async (status) => {
    vi.useFakeTimers();
    let passed!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
      passed = init.signal!;
      const response = Response.json({}, { status });
      response.json = () => new Promise((_resolve, reject) => {
        passed.addEventListener('abort', () => reject(passed.reason), { once: true });
      });
      return response;
    }));
    const result = apiGet('/api/verse/fleet/control').catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(passed.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(METADATA_JSON_READ_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(MetadataReadTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a slow valid two-worker read and cleans up before expiry', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    let passed!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => {
      passed = init.signal!;
      return new Promise<Response>(resolve => { finish = resolve; });
    }));
    const reading = apiGet('/api/resources');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(passed.aborted).toBe(false);
    finish(Response.json({ sourceState: 'healthy' }));
    await expect(reading).resolves.toEqual({ sourceState: 'healthy' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(METADATA_JSON_READ_TIMEOUT_MS);
    expect(passed.aborted).toBe(false);
  });

  it.each(['before', 'during'])('preserves the exact caller cancellation reason %s dispatch', async (when) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = new Error('caller cancellation');
    const fetch = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    if (when === 'before') caller.abort(reason);
    const reading = apiGet('/api/verse/fleet/control', caller.signal).catch(error => error);
    if (when === 'during') caller.abort(reason);
    expect(await reading).toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['POST', 'DELETE'])('does not impose the metadata lifetime on %s', async (method) => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    let passed: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => {
      passed = init.signal;
      return new Promise<Response>(resolve => { finish = resolve; });
    }));
    const pending = method === 'POST' ? apiPost('/api/action', {}, 'token') : apiDelete('/api/action', 'token');
    expect(passed).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(METADATA_JSON_READ_TIMEOUT_MS + 1);
    finish(Response.json({ ok: true }));
    await expect(pending).resolves.toEqual({ ok: true });
  });
});


describe('local mutation method compatibility', () => {
  it.each(['POST', 'DELETE'] as const)('preserves %s headers, caller signal and response parsing', async method => {
    const caller = new AbortController();
    const fetch = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const body = { message: 'fixture' };
    await expect(method === 'POST' ? apiPost('/api/action', body, 'token', caller.signal)
      : apiDelete('/api/action', 'token', caller.signal)).resolves.toEqual({ ok: true });
    const init = fetch.mock.calls[0]![1];
    expect(init).toMatchObject({ method, credentials: 'same-origin', signal: caller.signal });
    expect(new Headers(init.headers).get('x-ashlr-token')).toBe('token');
    expect(new Headers(init.headers).get('Content-Type')).toBe(method === 'POST' ? 'application/json' : null);
    if (method === 'POST') expect(init.body).toBe(JSON.stringify(body));
    else expect(Object.hasOwn(init, 'body')).toBe(false);
  });

  it('retains POST default JSON and DELETE empty-text success', async () => {
    const fetch = vi.fn(async (_path: string, init: RequestInit) => init.method === 'DELETE'
      ? new Response('') : Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    await expect(apiPost('/api/action', undefined, 'token')).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls[0]![1].body).toBe('{}');
    await expect(apiDelete('/api/action', 'token')).resolves.toBeUndefined();
  });

  it.each(['POST', 'DELETE'] as const)('does not read a %s 204 body', async method => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, 'json'); const text = vi.spyOn(response, 'text');
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(method === 'POST' ? apiPost('/api/action', null, 'token')
      : apiDelete('/api/action', 'token')).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
  });

  it.each(['POST', 'DELETE'] as const)('preserves %s refusal status, codes and sentence precedence', async method => {
    const run = () => method === 'POST' ? apiPost('/api/action', {}, 'token') : apiDelete('/api/action', 'token');
    respond(401, { error: 'untrusted body' });
    await expect(run()).rejects.toMatchObject({ status: 401, message: 'Mutation token was rejected.' });
    respond(404, { error: 'bare route' });
    await expect(run()).rejects.toBeInstanceOf(DispatchDisabledError);
    respond(404, { error: 'route refusal', note: 'secondary', message: 'tertiary', code: 'ROUTE_REFUSED' });
    await expect(run()).rejects.toMatchObject({ status: 404, code: 'ROUTE_REFUSED', detail: 'route refusal',
      message: `${method} /api/action failed (HTTP 404): route refusal.` });
    respond(409, { note: 'route note', message: 'tertiary' });
    await expect(run()).rejects.toMatchObject({ detail: 'route note' });
    respond(409, { message: 'route message' });
    await expect(run()).rejects.toMatchObject({ detail: 'route message' });
    respond(500, 'Not JSON');
    await expect(run()).rejects.toMatchObject({ status: 500, code: null, detail: null,
      message: `${method} /api/action failed (HTTP 500).` });
  });
});
