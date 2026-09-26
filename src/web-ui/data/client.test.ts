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
import { ApiError, apiPost, DispatchDisabledError, readFailureReason } from './client.js';

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
  vi.unstubAllGlobals();
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
