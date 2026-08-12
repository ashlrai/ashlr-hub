import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyOllamaModelIdentity } from '../src/core/run/ollama-identity.js';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';
import { runTask } from '../src/core/run/agent-loop.js';
import { newUsage } from '../src/core/run/budget.js';

const expectedDigest = `sha256:${'a'.repeat(64)}`;
const model = 'nemotron-shadow:exact';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('M504 bounded Ollama artifact identity', () => {
  it('preserves exact inventory identity metadata and performs only a loopback tags read', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [{
        name: model,
        model,
        digest: 'a'.repeat(64),
        size: 24_000_000_000,
        details: {
          parent_model: '',
          format: 'gguf',
          family: 'nemotron',
          families: ['nemotron'],
          parameter_size: '30B',
          quantization_level: 'Q4_K_M',
        },
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyOllamaModelIdentity({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model,
      expectedDigest,
    });

    expect(result).toEqual({
      ok: true,
      identity: {
        name: model,
        digest: expectedDigest,
        size: 24_000_000_000,
        details: {
          parent_model: '',
          format: 'gguf',
          family: 'nemotron',
          families: ['nemotron'],
          parameter_size: '30B',
          quantization_level: 'Q4_K_M',
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:11434/api/tags');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it.each([
    'https://127.0.0.1:11434/v1',
    'http://localhost:11434/v1',
    'http://192.168.1.10:11434/v1',
    'http://127.999.0.1:11434/v1',
    'http://ollama.internal:11434/v1',
    'http://user:password@localhost:11434/v1',
  ])('refuses non-exact loopback authority before fetch: %s', async (baseUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyOllamaModelIdentity({ baseUrl, model, expectedDigest })).resolves.toEqual({
      ok: false,
      reason: 'non-loopback-endpoint',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the full observed identity on digest mismatch without invoking the model', async () => {
    const observedDigest = `sha256:${'b'.repeat(64)}`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [{
        name: model,
        digest: observedDigest,
        size: 123,
        details: { format: 'gguf', family: 'nemotron', parameter_size: '30B' },
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyOllamaModelIdentity({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model,
      expectedDigest,
    })).resolves.toEqual({
      ok: false,
      reason: 'digest-mismatch',
      identity: {
        name: model,
        digest: observedDigest,
        size: 123,
        details: { format: 'gguf', family: 'nemotron', parameter_size: '30B' },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires a canonical full sha256 pin before any endpoint access', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(verifyOllamaModelIdentity({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model,
      expectedDigest: 'a'.repeat(64),
    })).resolves.toEqual({ ok: false, reason: 'invalid-config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects secret-shaped artifact metadata instead of persisting it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      models: [{
        name: 'github_pat_1234567890abcdefghijklmnop',
        model,
        digest: expectedDigest,
        size: 123,
        details: { family: 'nemotron' },
      }],
    }), { status: 200 })));
    await expect(verifyOllamaModelIdentity({
      baseUrl: 'http://127.0.0.1:11434/v1', model, expectedDigest,
    })).resolves.toEqual({ ok: false, reason: 'invalid-response' });
  });

  it('binds the preferred chatStream path to redirect, output-token, contact, and delta behavior', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onRequestStart = vi.fn();
    const onDelta = vi.fn();
    const client = buildOpenAICompatibleClient(
      'http://127.0.0.1:11434/v1',
      '',
      model,
      false,
      undefined,
      undefined,
      {
        redirect: 'error', timeoutMs: 100, maxRequestBytes: 1024,
        maxResponseBytes: 1024, maxOutputTokens: 128, onRequestStart,
      },
    );

    await expect(client.chatStream!(
      [{ role: 'user', content: 'hello' }], undefined, onDelta,
    )).resolves.toMatchObject({
      content: 'ok',
    });
    expect(onRequestStart).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledOnce();
    expect(onDelta).toHaveBeenCalledWith('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toMatchObject({ model, max_tokens: 128, stream: false });
  });

  it('makes actual runTask inherit sealed shadow transport through chatStream', async () => {
    const onRequestStart = vi.fn();
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      expect(JSON.parse(String(init.body))).toMatchObject({ max_tokens: 64, stream: false });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'bounded final' } }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = buildOpenAICompatibleClient(
      'http://127.0.0.1:11434/v1', '', model, false, undefined, undefined,
      {
        redirect: 'error', timeoutMs: 100, maxRequestBytes: 4096,
        maxResponseBytes: 1024, maxOutputTokens: 64, onRequestStart,
      },
    );
    const deltas: string[] = [];
    const task = await runTask(
      { id: 'shadow-run-task', goal: 'bounded task', deps: [], status: 'pending' },
      client,
      {
        budget: { maxTokens: 1_000, maxSteps: 2, allowCloud: false },
        usage: newUsage(),
        onStep: () => {},
        sink: (event) => {
          if (event.kind === 'model-delta') deltas.push(event.text);
        },
      },
    );

    expect(task).toMatchObject({ status: 'done', result: 'bounded final' });
    expect(deltas).toEqual(['bounded final']);
    expect(onRequestStart).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a remote redirect in chatStream without a second request', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      throw new TypeError('redirect mode is set to error');
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = buildOpenAICompatibleClient(
      'http://127.0.0.1:11434/v1', '', model, false, undefined, undefined,
      {
        redirect: 'error', timeoutMs: 100, maxRequestBytes: 1024,
        maxResponseBytes: 1024, maxOutputTokens: 128,
      },
    );

    await expect(client.chatStream!(
      [{ role: 'user', content: 'hello' }], undefined, () => {},
    )).rejects.toThrow('redirect mode is set to error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized shadow inference response before parsing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': '2048' },
    })));
    const client = buildOpenAICompatibleClient(
      'http://127.0.0.1:11434/v1', '', model, false, undefined, undefined,
      {
        redirect: 'error', timeoutMs: 100, maxRequestBytes: 1024,
        maxResponseBytes: 1024, maxOutputTokens: 128,
      },
    );
    await expect(client.chatStream!(
      [{ role: 'user', content: 'hello' }], undefined, () => {},
    )).rejects.toThrow(
      'OpenAI-compat response exceeds byte limit',
    );
  });

  it('rejects an oversized shadow inference request before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = buildOpenAICompatibleClient(
      'http://127.0.0.1:11434/v1', '', model, false, undefined, undefined,
      {
        redirect: 'error', timeoutMs: 100, maxRequestBytes: 32,
        maxResponseBytes: 1024, maxOutputTokens: 128,
      },
    );
    await expect(client.chatStream!(
      [{ role: 'user', content: 'x'.repeat(100) }], undefined, () => {},
    )).rejects.toThrow(
      'OpenAI-compat request exceeds byte limit',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies the transport timeout in chatStream after truthfully recording contact', async () => {
    const onRequestStart = vi.fn();
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = buildOpenAICompatibleClient(
      'http://127.0.0.1:11434/v1', '', model, false, undefined, undefined,
      {
        redirect: 'error', timeoutMs: 5, maxRequestBytes: 1024,
        maxResponseBytes: 1024, maxOutputTokens: 128, onRequestStart,
      },
    );

    await expect(client.chatStream!(
      [{ role: 'user', content: 'hello' }], undefined, () => {},
    )).rejects.toThrow('aborted by timeout');
    expect(onRequestStart).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds non-2xx bodies before reading and never exposes their secret text', async () => {
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(secret, {
      status: 500,
      headers: { 'content-length': String(2 * 1024 * 1024) },
    })));
    const client = buildOpenAICompatibleClient(
      'http://127.0.0.1:11434/v1', '', model, false, undefined, undefined,
      {
        redirect: 'error', timeoutMs: 100, maxRequestBytes: 1024,
        maxResponseBytes: 1024, maxOutputTokens: 128,
      },
    );
    const error = await client.chat([{ role: 'user', content: 'hello' }]).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain('[response body exceeded byte limit]');
    expect(String((error as Error).message)).not.toContain(secret);
  });
});
