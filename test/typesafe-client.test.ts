/**
 * classify/typesafe-client — transport-level contract.
 *
 * Every test here stubs `fetch`. The suite MUST pass with no network and no
 * TYPESAFE_API_KEY, because that is exactly the environment CI and an offline
 * laptop present, and the module's whole purpose is to behave correctly there.
 *
 * The invariant under test throughout: `askTypeSafe` NEVER throws. Whatever the
 * transport does — refuses, hangs, 429s, returns HTML, returns a gigabyte — the
 * caller gets a typed `{ ok: false, reason }` and can fall back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import {
  askTypeSafe,
  choiceAnswer,
  noulAnswer,
  scoreAnswer,
  typeSafeAvailable,
  TYPESAFE_API_KEY_ENV,
  TYPESAFE_DISABLE_ENV,
  type TypeSafeRequest,
} from '../src/core/classify/typesafe-client.js';

// phantom disabled => resolveProviderKey reads process.env directly and never
// spawns a subprocess, which keeps this suite out of the real-io lane.
const cfg = { phantom: { enabled: false } } as unknown as AshlrConfig;

const ENDPOINT = 'https://classifier.invalid/v1/systemone';
const FAKE_KEY = 'test-key-not-a-real-credential';

const REQUEST: TypeSafeRequest = {
  state: 'Error: 429 too many requests',
  questions: {
    error_kind: {
      type: 'choice',
      instructions: 'classify',
      criteria: { 'rate-limit': 'throttled', execution: 'anything else' },
    },
    retryable: { type: 'noul', instructions: 'would a retry work?' },
  },
};

function okBody(): string {
  return JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      error_kind: {
        type: 'choice',
        choice: 'rate-limit',
        confidence: 1.0,
        probabilities: { 'rate-limit': 1.0, execution: 0.0 },
      },
      retryable: { type: 'noul', noul: 0.86 },
    },
    usage: { input_tokens: 478, output_tokens: 91 },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const savedKey = process.env[TYPESAFE_API_KEY_ENV];
const savedDisable = process.env[TYPESAFE_DISABLE_ENV];

beforeEach(() => {
  process.env[TYPESAFE_API_KEY_ENV] = FAKE_KEY;
  delete process.env[TYPESAFE_DISABLE_ENV];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env[TYPESAFE_API_KEY_ENV];
  else process.env[TYPESAFE_API_KEY_ENV] = savedKey;
  if (savedDisable === undefined) delete process.env[TYPESAFE_DISABLE_ENV];
  else process.env[TYPESAFE_DISABLE_ENV] = savedDisable;
});

// ---------------------------------------------------------------------------
// Availability — no key, no call, no I/O
// ---------------------------------------------------------------------------

describe('askTypeSafe — availability short-circuits', () => {
  it('returns no-key without touching the transport when unkeyed', async () => {
    delete process.env[TYPESAFE_API_KEY_ENV];
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only key as no key', async () => {
    process.env[TYPESAFE_API_KEY_ENV] = '   ';
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns disabled when the kill env is set, even with a key present', async () => {
    process.env[TYPESAFE_DISABLE_ENV] = '1';
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns disabled for an empty question set rather than paying for nothing', async () => {
    const res = await askTypeSafe({ state: 'x', questions: {} }, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('typeSafeAvailable tracks key presence and the kill env', () => {
    expect(typeSafeAvailable(cfg)).toBe(true);
    process.env[TYPESAFE_DISABLE_ENV] = 'true';
    expect(typeSafeAvailable(cfg)).toBe(false);
    delete process.env[TYPESAFE_DISABLE_ENV];
    delete process.env[TYPESAFE_API_KEY_ENV];
    expect(typeSafeAvailable(cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

describe('askTypeSafe — request wire format', () => {
  it('sends one call with every question, and criteria FLAT on the question', async () => {
    fetchMock.mockResolvedValue(new Response(okBody(), { status: 200 }));
    await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('jev-latest');
    expect(body.state).toBe(REQUEST.state);
    expect(Object.keys(body.questions).sort()).toEqual(['error_kind', 'retryable']);

    // The documented trap: criteria is flat on the question, NOT nested under
    // a `choice` key. Regression-guard it explicitly.
    expect(body.questions.error_kind.criteria).toBeTypeOf('object');
    expect(body.questions.error_kind.choice).toBeUndefined();
  });

  it('honours an explicit model', async () => {
    fetchMock.mockResolvedValue(new Response(okBody(), { status: 200 }));
    await askTypeSafe({ ...REQUEST, model: 'jev-preview' }, cfg, { endpoint: ENDPOINT });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).model).toBe('jev-preview');
  });

  it('truncates an enormous state head+tail instead of sending it whole', async () => {
    fetchMock.mockResolvedValue(new Response(okBody(), { status: 200 }));
    const huge = `START${'x'.repeat(500_000)}END`;
    await askTypeSafe({ ...REQUEST, state: huge }, cfg, { endpoint: ENDPOINT });
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).state as string;
    expect(sent.length).toBeLessThan(10_000);
    expect(sent.startsWith('START')).toBe(true);
    expect(sent.endsWith('END')).toBe(true);
    expect(sent).toContain('elided');
  });

  it('sends the credential only as a bearer header and never in the result', async () => {
    fetchMock.mockResolvedValue(new Response(okBody(), { status: 200 }));
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(String(init.body)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(res)).not.toContain(FAKE_KEY);
  });
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

describe('askTypeSafe — response parsing', () => {
  it('parses a choice + noul answer set with usage', async () => {
    fetchMock.mockResolvedValue(new Response(okBody(), { status: 200 }));
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model).toBe('jev-1.13.0');
    expect(res.usage).toEqual({ inputTokens: 478, outputTokens: 91 });

    const kind = choiceAnswer(res, 'error_kind', ['rate-limit', 'execution'] as const);
    expect(kind?.choice).toBe('rate-limit');
    expect(kind?.confidence).toBe(1);
    expect(kind?.probabilities['rate-limit']).toBe(1);
    expect(noulAnswer(res, 'retryable')?.noul).toBe(0.86);
  });

  it('parses a score answer and defaults an absent confidence to 0, not 1', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ model: 'jev-1.13.0', answers: { risk: { type: 'score', score: 4 } } }),
        { status: 200 },
      ),
    );
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    const score = scoreAnswer(res, 'risk');
    expect(score?.score).toBe(4);
    // An unstated confidence must never read as certainty.
    expect(score?.confidence).toBe(0);
  });

  it('drops a malformed answer rather than guessing at it', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            good: { type: 'noul', noul: 0.3 },
            bad_confidence: { type: 'choice', choice: 'x', confidence: 7 },
            bad_noul: { type: 'noul', noul: 'yes' },
            unknown_type: { type: 'vibes', value: 1 },
          },
        }),
        { status: 200 },
      ),
    );
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(res.answers)).toEqual(['good']);
  });

  it('rejects a choice label outside the allowed set', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: { error_kind: { type: 'choice', choice: 'invented-label', confidence: 1 } },
        }),
        { status: 200 },
      ),
    );
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(choiceAnswer(res, 'error_kind', ['rate-limit', 'execution'] as const)).toBeUndefined();
  });

  it('returns malformed-response for a non-JSON body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 200 }));
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed-response');
  });

  it('returns malformed-response when nothing in answers is well formed', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ model: 'x', answers: { a: { type: 'vibes' } } }), { status: 200 }),
    );
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed-response');
  });
});

// ---------------------------------------------------------------------------
// Failure modes — the point of the module
// ---------------------------------------------------------------------------

describe('askTypeSafe — failure modes never escape as exceptions', () => {
  it('reports a 429 as rate-limited with retryAfterMs and does NOT retry', async () => {
    fetchMock.mockResolvedValue(
      new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('rate-limited');
      expect(res.status).toBe(429);
      expect(res.retryAfterMs).toBe(30_000);
    }
    // Rule 3: one call, never a stampede against a provider that just said no.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses an HTTP-date Retry-After and bounds it to an hour', async () => {
    const future = new Date(Date.now() + 10 * 3_600_000).toUTCString();
    fetchMock.mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': future } }));
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    if (!res.ok) expect(res.retryAfterMs).toBe(3_600_000);
  });

  it('treats a 503 carrying Retry-After as throttling', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503, headers: { 'retry-after': '5' } }));
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    if (!res.ok) {
      expect(res.reason).toBe('rate-limited');
      expect(res.retryAfterMs).toBe(5_000);
    }
  });

  it('reports any other non-2xx as http-error with a bounded detail', async () => {
    fetchMock.mockResolvedValue(new Response('y'.repeat(5_000), { status: 500 }));
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('http-error');
      expect(res.status).toBe(500);
      expect(res.detail.length).toBeLessThan(300);
    }
  });

  it('reports a transport failure as network instead of throwing', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.typesafe.ai'));
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('network');
  });

  it('survives a transport that throws a non-Error', async () => {
    fetchMock.mockImplementation(() => {
      throw 'kaboom';
    });
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('network');
  });

  it('refuses an oversized body declared by content-length', async () => {
    fetchMock.mockResolvedValue(
      new Response(okBody(), { status: 200, headers: { 'content-length': '99999999' } }),
    );
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('oversized-response');
  });

  it('aborts on its own deadline and reports timeout', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT, timeoutMs: 20 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('timeout');
      expect(res.detail).toContain('20ms');
    }
  });

  it('honours a caller signal already aborted before dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT, signal: controller.signal });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('timeout');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a caller signal aborted mid-flight', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      setTimeout(() => controller.abort(), 5);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT, signal: controller.signal });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('timeout');
  });

  it('every unavailable result carries a duration and a secret-free detail', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 418 }));
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(typeof res.durationMs).toBe('number');
      expect(res.detail).not.toContain(FAKE_KEY);
    }
  });
});

// ---------------------------------------------------------------------------
// Accessors on an unavailable result
// ---------------------------------------------------------------------------

describe('answer accessors', () => {
  it('return undefined for an unavailable result rather than throwing', async () => {
    delete process.env[TYPESAFE_API_KEY_ENV];
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(choiceAnswer(res, 'error_kind', ['rate-limit'] as const)).toBeUndefined();
    expect(scoreAnswer(res, 'risk')).toBeUndefined();
    expect(noulAnswer(res, 'retryable')).toBeUndefined();
  });

  it('return undefined when the answer is present but of the wrong type', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ model: 'x', answers: { a: { type: 'noul', noul: 0.5 } } }), {
        status: 200,
      }),
    );
    const res = await askTypeSafe(REQUEST, cfg, { endpoint: ENDPOINT });
    expect(choiceAnswer(res, 'a', ['x'] as const)).toBeUndefined();
    expect(scoreAnswer(res, 'a')).toBeUndefined();
    expect(noulAnswer(res, 'a')?.noul).toBe(0.5);
  });
});
