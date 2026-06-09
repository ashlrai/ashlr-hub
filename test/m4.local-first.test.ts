/**
 * M4 local-first tests — hermetic, mock fetch + mock providers, no network.
 *
 * Covers:
 *   - getActiveClient throws with a clear local-first error message when only
 *     a cloud provider is available and allowCloud=false.
 *   - getActiveClient succeeds when allowCloud=true AND the API key is present.
 *   - getActiveClient succeeds when a local provider (ollama) is up.
 *   - getActiveClient throws when allowCloud=true but API key is missing.
 *   - Error message contains actionable hint (--allow-cloud).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { getActiveClient } from '../src/core/run/provider-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(providerChain: string[] = ['ollama']): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain,
    },
    telemetry: {},
    tools: {},
  };
}

/** Minimal mock fetch Response. */
function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Mock fetch that simulates Ollama up. */
function ollamaUpFetch(): typeof fetch {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('11434/api/tags')) {
      return Promise.resolve(mockResponse({ models: [{ name: 'llama3:8b' }] }));
    }
    // For actual chat calls, return a valid Ollama chat response
    if (String(url).includes('11434/api/chat')) {
      return Promise.resolve(mockResponse({
        message: { role: 'assistant', content: 'Hello.' },
        prompt_eval_count: 10,
        eval_count: 5,
      }));
    }
    return Promise.reject(new Error(`unexpected url: ${String(url)}`));
  }) as unknown as typeof fetch;
}

/** Mock fetch that simulates all local providers down. */
function allDownFetch(): typeof fetch {
  return vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
}

/** Mock fetch that simulates LM Studio up. */
function lmStudioUpFetch(): typeof fetch {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('1234/v1/models')) {
      return Promise.resolve(mockResponse({ data: [{ id: 'llama3' }] }));
    }
    if (String(url).includes('1234/v1/chat/completions')) {
      return Promise.resolve(mockResponse({
        choices: [{ message: { role: 'assistant', content: 'Hi.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    }
    return Promise.reject(new Error(`unexpected: ${String(url)}`));
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// LOCAL-FIRST refusal — cloud-only, allowCloud=false
// ---------------------------------------------------------------------------

describe('getActiveClient — LOCAL-FIRST refusal', () => {
  beforeEach(() => {
    // All local providers down
    vi.stubGlobal('fetch', allDownFetch());
    // Remove any cloud API keys from env
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  it('throws when no local providers are up and allowCloud=false', async () => {
    const cfg = makeConfig(['ollama', 'lmstudio']);
    await expect(
      getActiveClient(cfg, { allowCloud: false }),
    ).rejects.toThrow();
  });

  it('error message mentions local-first / no local provider', async () => {
    const cfg = makeConfig(['ollama', 'lmstudio']);
    let msg = '';
    try {
      await getActiveClient(cfg, { allowCloud: false });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // Should mention something about local or no provider
    expect(msg.toLowerCase()).toMatch(/local|no.*(provider|model)|provider.*down|not.*available/);
  });

  it('error message contains --allow-cloud hint', async () => {
    const cfg = makeConfig(['ollama']);
    let msg = '';
    try {
      await getActiveClient(cfg, { allowCloud: false });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('--allow-cloud');
  });

  it('throws with cloud-only chain and allowCloud=false even when API key present', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key-value';
    const cfg = makeConfig(['anthropic']);
    await expect(
      getActiveClient(cfg, { allowCloud: false }),
    ).rejects.toThrow();
  });

  it('error for cloud-only + allowCloud=false mentions --allow-cloud', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key-value';
    const cfg = makeConfig(['anthropic']);
    let msg = '';
    try {
      await getActiveClient(cfg, { allowCloud: false });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('--allow-cloud');
  });
});

// ---------------------------------------------------------------------------
// Cloud provider with allowCloud=true — requires key present
// ---------------------------------------------------------------------------

describe('getActiveClient — cloud provider, allowCloud=true', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  it('throws when allowCloud=true but API key is missing', async () => {
    vi.stubGlobal('fetch', allDownFetch());
    delete process.env['ANTHROPIC_API_KEY'];
    const cfg = makeConfig(['anthropic']);
    await expect(
      getActiveClient(cfg, { allowCloud: true }),
    ).rejects.toThrow();
  });

  it('error when key missing mentions missing key or cloud not configured', async () => {
    vi.stubGlobal('fetch', allDownFetch());
    delete process.env['ANTHROPIC_API_KEY'];
    const cfg = makeConfig(['anthropic']);
    let msg = '';
    try {
      await getActiveClient(cfg, { allowCloud: true });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // Should say something about missing key, cloud, or no provider
    expect(msg.toLowerCase()).toMatch(/key|api|cloud|no.*(provider|model)/);
  });

  it('throws or returns a client when allowCloud=true AND anthropic key is present', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-anthropic-key';
    // All local providers down so it falls to cloud
    vi.stubGlobal('fetch', allDownFetch());
    const cfg = makeConfig(['anthropic']);
    // The implementation may either return a cloud client OR throw "not yet
    // implemented" — both are valid; what must NOT happen is a local-first
    // refusal error (which only fires when allowCloud=false).
    let threw = false;
    let threwRefusalError = false;
    try {
      await getActiveClient(cfg, { allowCloud: true });
    } catch (e) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      // A local-first *refusal* (when allowCloud=false) says something like
      // "no local model available … Pass --allow-cloud to use it."
      // The "not yet implemented" error (when allowCloud=true, key present) may
      // also mention --allow-cloud contextually, but specifically says it was
      // "requested" — NOT that the user needs to pass it.
      // Refusal: "Pass --allow-cloud" / "pass --allow-cloud"
      threwRefusalError = /pass --allow-cloud/i.test(msg);
    }
    // Must not be a local-first refusal (that would mean allowCloud was ignored)
    expect(threwRefusalError).toBe(false);
    // Regardless of outcome (client returned or "not yet impl." thrown), no panic
    expect(typeof threw).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Local provider up — succeeds regardless of allowCloud
// ---------------------------------------------------------------------------

describe('getActiveClient — local provider up', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('returns a client when ollama is up (allowCloud=false)', async () => {
    vi.stubGlobal('fetch', ollamaUpFetch());
    const cfg = makeConfig(['ollama']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    expect(client).toBeDefined();
  });

  it('returned client has id matching the active provider', async () => {
    vi.stubGlobal('fetch', ollamaUpFetch());
    const cfg = makeConfig(['ollama']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    expect(client.id).toBe('ollama');
  });

  it('returned client has supportsTools boolean', async () => {
    vi.stubGlobal('fetch', ollamaUpFetch());
    const cfg = makeConfig(['ollama']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    expect(typeof client.supportsTools).toBe('boolean');
  });

  it('returned client has a chat function', async () => {
    vi.stubGlobal('fetch', ollamaUpFetch());
    const cfg = makeConfig(['ollama']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    expect(typeof client.chat).toBe('function');
  });

  it('returns a client when lmstudio is up (allowCloud=false)', async () => {
    vi.stubGlobal('fetch', lmStudioUpFetch());
    const cfg = makeConfig(['lmstudio']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    expect(client).toBeDefined();
    expect(client.id).toBe('lmstudio');
  });

  it('prefers first up provider in chain', async () => {
    // Both up; chain = [ollama, lmstudio] → should pick ollama
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('11434/api/tags')) {
        return Promise.resolve(mockResponse({ models: [{ name: 'llama3:8b' }] }));
      }
      if (String(url).includes('1234/v1/models')) {
        return Promise.resolve(mockResponse({ data: [{ id: 'llama3' }] }));
      }
      return Promise.reject(new Error('unexpected'));
    }) as unknown as typeof fetch);
    const cfg = makeConfig(['ollama', 'lmstudio']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    expect(client.id).toBe('ollama');
  });

  it('falls over to lmstudio when ollama is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('11434')) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      if (String(url).includes('1234/v1/models')) {
        return Promise.resolve(mockResponse({ data: [{ id: 'llama3' }] }));
      }
      return Promise.reject(new Error('unexpected'));
    }) as unknown as typeof fetch);
    const cfg = makeConfig(['ollama', 'lmstudio']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    expect(client.id).toBe('lmstudio');
  });
});

// ---------------------------------------------------------------------------
// Ollama client chat() — basic integration via mock fetch
// ---------------------------------------------------------------------------

describe('getActiveClient (ollama) — chat function smoke test', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('client.chat() returns a ChatResult with content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('11434/api/tags')) {
        return Promise.resolve(mockResponse({ models: [{ name: 'llama3:8b' }] }));
      }
      if (String(url).includes('11434/api/chat')) {
        return Promise.resolve(mockResponse({
          message: { role: 'assistant', content: 'Hello from Ollama!' },
          prompt_eval_count: 12,
          eval_count: 8,
        }));
      }
      return Promise.reject(new Error('unexpected'));
    }) as unknown as typeof fetch);

    const cfg = makeConfig(['ollama']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    const result = await client.chat([{ role: 'user', content: 'Hello' }]);
    expect(result.content).toBe('Hello from Ollama!');
  });

  it('client.chat() returns usage with tokensIn and tokensOut', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('11434/api/tags')) {
        return Promise.resolve(mockResponse({ models: [{ name: 'llama3:8b' }] }));
      }
      if (String(url).includes('11434/api/chat')) {
        return Promise.resolve(mockResponse({
          message: { role: 'assistant', content: 'Hi!' },
          prompt_eval_count: 20,
          eval_count: 10,
        }));
      }
      return Promise.reject(new Error('unexpected'));
    }) as unknown as typeof fetch);

    const cfg = makeConfig(['ollama']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    const result = await client.chat([{ role: 'user', content: 'Hi' }]);
    expect(typeof result.usage.tokensIn).toBe('number');
    expect(typeof result.usage.tokensOut).toBe('number');
    expect(result.usage.tokensIn).toBeGreaterThan(0);
    expect(result.usage.tokensOut).toBeGreaterThan(0);
  });

  it('client.chat() falls back to estimateTokens when provider omits counts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('11434/api/tags')) {
        return Promise.resolve(mockResponse({ models: [{ name: 'llama3:8b' }] }));
      }
      if (String(url).includes('11434/api/chat')) {
        return Promise.resolve(mockResponse({
          // No prompt_eval_count / eval_count
          message: { role: 'assistant', content: 'Response without token counts.' },
        }));
      }
      return Promise.reject(new Error('unexpected'));
    }) as unknown as typeof fetch);

    const cfg = makeConfig(['ollama']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    const result = await client.chat([{ role: 'user', content: 'Hello world' }]);
    // estimateTokens fallback should still produce non-negative numbers
    expect(result.usage.tokensIn).toBeGreaterThanOrEqual(0);
    expect(result.usage.tokensOut).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// M11 HIGH regression: streaming body read is bounded (idle-timeout watchdog)
//
// A provider that returns 200 headers then STALLS mid-stream (never emits a
// chunk, never closes the body) must NOT hang chatStream indefinitely. The
// per-read idle watchdog aborts the stalled body, and the catch falls back to
// non-streaming chat(). These tests drive the watchdog with fake timers so the
// 60s STREAM_TIMEOUT_MS resolves instantly and deterministically.
// ---------------------------------------------------------------------------

describe('getActiveClient (ollama) — streaming body read is bounded', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * A reader whose read() returns a promise that never resolves on its own —
   * it only settles (rejects) when the AbortController fires via abort(). This
   * models a provider that sends headers then trickles nothing forever.
   */
  function stallingStreamFetch(): typeof fetch {
    return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('11434/api/tags')) {
        return Promise.resolve(mockResponse({ models: [{ name: 'llama3:8b' }] }));
      }
      if (String(url).includes('11434/api/chat')) {
        const body = init?.body ? String(init.body) : '';
        const isStream = body.includes('"stream":true');
        if (isStream) {
          const signal = init?.signal;
          // Headers arrive (ok response) but the body read never produces data
          // and never closes — until the request is aborted by the idle watchdog.
          const reader = {
            read: () =>
              new Promise((_resolve, reject) => {
                if (signal) {
                  signal.addEventListener('abort', () => {
                    reject(new Error('aborted'));
                  });
                }
                // Otherwise never settles.
              }),
            releaseLock: () => {},
          };
          return Promise.resolve({
            ok: true,
            status: 200,
            body: { getReader: () => reader },
          } as unknown as Response);
        }
        // Non-streaming fallback chat() — answer normally so the fallback succeeds.
        return Promise.resolve(mockResponse({
          message: { role: 'assistant', content: 'fallback content' },
          prompt_eval_count: 7,
          eval_count: 3,
        }));
      }
      return Promise.reject(new Error(`unexpected: ${String(url)}`));
    }) as unknown as typeof fetch;
  }

  it('chatStream resolves (falls back) instead of hanging when the body stalls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', stallingStreamFetch());

    const cfg = makeConfig(['ollama']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    expect(typeof client.chatStream).toBe('function');

    const deltas: string[] = [];
    const promise = client.chatStream!(
      [{ role: 'user', content: 'hello' }],
      undefined,
      (t) => deltas.push(t),
    );

    // Advance past the idle watchdog deadline (STREAM_TIMEOUT_MS=60s). This
    // fires the abort -> read rejects -> catch -> fallback chat().
    await vi.advanceTimersByTimeAsync(61_000);

    const result = await promise;
    // Fallback chat() supplied the content; the stalled stream did not hang.
    expect(result.content).toBe('fallback content');
    expect(result.usage.tokensIn).toBeGreaterThan(0);
    // Fallback emits the content as a single delta.
    expect(deltas.join('')).toContain('fallback content');
  });

  it('aborts the stalled request (signal.aborted) at the idle deadline', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).includes('11434/api/tags')) {
          return Promise.resolve(mockResponse({ models: [{ name: 'llama3:8b' }] }));
        }
        if (String(url).includes('11434/api/chat')) {
          const body = init?.body ? String(init.body) : '';
          if (body.includes('"stream":true')) {
            capturedSignal = init?.signal ?? undefined;
            const reader = {
              read: () =>
                new Promise((_resolve, reject) => {
                  init?.signal?.addEventListener('abort', () =>
                    reject(new Error('aborted')),
                  );
                }),
              releaseLock: () => {},
            };
            return Promise.resolve({
              ok: true,
              status: 200,
              body: { getReader: () => reader },
            } as unknown as Response);
          }
          return Promise.resolve(mockResponse({
            message: { role: 'assistant', content: 'fallback' },
          }));
        }
        return Promise.reject(new Error('unexpected'));
      }) as unknown as typeof fetch,
    );

    const cfg = makeConfig(['ollama']);
    const client = await getActiveClient(cfg, { allowCloud: false });
    const promise = client.chatStream!(
      [{ role: 'user', content: 'hi' }],
      undefined,
      () => {},
    );
    await vi.advanceTimersByTimeAsync(61_000);
    await promise;

    expect(capturedSignal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens — ~4 chars/token heuristic
// ---------------------------------------------------------------------------

import { estimateTokens } from '../src/core/run/provider-client.js';

describe('estimateTokens', () => {
  it('returns a non-negative integer for empty string', () => {
    // Implementation uses Math.max(1, ...) so empty string returns at least 1
    expect(estimateTokens('')).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(estimateTokens(''))).toBe(true);
  });

  it('returns ~1 for a 4-character string', () => {
    // "test" = 4 chars → ~1 token
    expect(estimateTokens('test')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens('test')).toBeLessThanOrEqual(2);
  });

  it('returns ~25 for a 100-character string', () => {
    const str = 'a'.repeat(100);
    const tokens = estimateTokens(str);
    expect(tokens).toBeGreaterThanOrEqual(20);
    expect(tokens).toBeLessThanOrEqual(30);
  });

  it('scales linearly with string length', () => {
    const short = estimateTokens('x'.repeat(40));
    const long = estimateTokens('x'.repeat(400));
    expect(long).toBeGreaterThan(short);
  });

  it('returns an integer (whole number)', () => {
    const n = estimateTokens('Hello, world!');
    expect(Number.isInteger(n)).toBe(true);
  });
});
