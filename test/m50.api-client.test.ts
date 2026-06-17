/**
 * M50 — OpenAI-compatible API client tests.
 *
 * Validates buildOpenAICompatibleClient against a mocked global fetch:
 *   - correct URL construction (<base>/chat/completions)
 *   - Authorization header present when key provided, absent when key empty
 *   - OpenAI-shaped request body (model, messages, stream:false)
 *   - standard response parsing into ChatResult shape
 *   - tool_calls parsing
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';
import type { ChatMessage } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(texts: string[] = ['hello']): ChatMessage[] {
  return texts.map((content, i) => ({
    role: i === 0 ? ('user' as const) : ('assistant' as const),
    content,
  }));
}

/** Build a minimal mock Response. */
function mockJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/** Standard OpenAI chat completion response. */
function openAIResponse(content: string, promptTokens = 10, completionTokens = 5): unknown {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

/** OpenAI response with tool_calls. */
function openAIToolCallResponse(toolName: string, toolArgs: unknown): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_abc123',
              type: 'function',
              function: {
                name: toolName,
                arguments: JSON.stringify(toolArgs),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  };
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe('buildOpenAICompatibleClient — URL construction', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('appends /chat/completions to the base URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('hi')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'sk-test',
      'test-model',
      false,
    );
    await client.chat(makeMessages());

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('strips trailing slash from base URL before appending', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('hi')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1/',
      'sk-test',
      'test-model',
      false,
    );
    await client.chat(makeMessages());

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('constructs correct URL for NIM-style base URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('ok')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = buildOpenAICompatibleClient(
      'https://integrate.api.nvidia.com/v1',
      'nim-key',
      'meta/llama-3.1-70b-instruct',
      true,
    );
    await client.chat(makeMessages());

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
  });
});

// ---------------------------------------------------------------------------
// Authorization header
// ---------------------------------------------------------------------------

describe('buildOpenAICompatibleClient — Authorization header', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends Authorization: Bearer <key> when apiKey is non-empty', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('hello')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'sk-my-secret-key',
      'gpt-4o',
      false,
    );
    await client.chat(makeMessages());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-my-secret-key');
  });

  it('does NOT send Authorization header when apiKey is empty string', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('hello')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = buildOpenAICompatibleClient(
      'http://localhost:1234/v1',
      '', // LM Studio — no auth
      'local-model',
      false,
    );
    await client.chat(makeMessages());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('always sends Content-Type: application/json', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('ok')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'sk-key',
      'model',
      false,
    );
    await client.chat(makeMessages());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});

// ---------------------------------------------------------------------------
// Request body shape
// ---------------------------------------------------------------------------

describe('buildOpenAICompatibleClient — request body', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends correct model in request body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('hi')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'key',
      'kimi-k2-0711-preview',
      false,
    );
    await client.chat(makeMessages());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('kimi-k2-0711-preview');
  });

  it('sends messages in OpenAI format', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('reply')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'key',
      'model',
      false,
    );
    await client.chat([{ role: 'user', content: 'What is 2+2?' }]);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const messages = body['messages'] as Array<Record<string, unknown>>;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'What is 2+2?' });
  });

  it('sends stream:false for non-streaming chat()', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('reply')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'key',
      'model',
      false,
    );
    await client.chat(makeMessages());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['stream']).toBe(false);
  });

  it('sends tools and tool_choice:auto when supportsTools=true and tools provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('done')));
    vi.stubGlobal('fetch', fetchSpy);

    const tools = [{ type: 'function', function: { name: 'myTool', parameters: {} } }];
    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'key',
      'model',
      true, // supportsTools
    );
    await client.chat(makeMessages(), tools);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['tools']).toEqual(tools);
    expect(body['tool_choice']).toBe('auto');
  });

  it('does NOT send tools when supportsTools=false', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('done')));
    vi.stubGlobal('fetch', fetchSpy);

    const tools = [{ type: 'function', function: { name: 'myTool', parameters: {} } }];
    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'key',
      'model',
      false, // supportsTools=false
    );
    await client.chat(makeMessages(), tools);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['tools']).toBeUndefined();
  });

  it('sends temperature when provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('hi')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'key',
      'model',
      false,
      0.7,
    );
    await client.chat(makeMessages());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['temperature']).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// Response parsing — ChatResult shape
// ---------------------------------------------------------------------------

describe('buildOpenAICompatibleClient — response parsing', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns content from choices[0].message.content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('hello world'))));

    const client = buildOpenAICompatibleClient('https://api.example.com/v1', 'key', 'model', false);
    const result = await client.chat(makeMessages());

    expect(result.content).toBe('hello world');
  });

  it('returns correct tokensIn from usage.prompt_tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('hi', 42, 7))));

    const client = buildOpenAICompatibleClient('https://api.example.com/v1', 'key', 'model', false);
    const result = await client.chat(makeMessages());

    expect(result.usage.tokensIn).toBe(42);
  });

  it('returns correct tokensOut from usage.completion_tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('hi', 42, 7))));

    const client = buildOpenAICompatibleClient('https://api.example.com/v1', 'key', 'model', false);
    const result = await client.chat(makeMessages());

    expect(result.usage.tokensOut).toBe(7);
  });

  it('falls back to estimated tokens when usage is absent', async () => {
    const noUsage = { choices: [{ message: { content: 'short reply', tool_calls: null } }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(noUsage)));

    const client = buildOpenAICompatibleClient('https://api.example.com/v1', 'key', 'model', false);
    const result = await client.chat(makeMessages(['a test message']));

    expect(result.usage.tokensIn).toBeGreaterThan(0);
    expect(result.usage.tokensOut).toBeGreaterThan(0);
  });

  it('returns empty string content when message.content is null/absent', async () => {
    const noContent = {
      choices: [{ message: { content: null, tool_calls: null } }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(noContent)));

    const client = buildOpenAICompatibleClient('https://api.example.com/v1', 'key', 'model', false);
    const result = await client.chat(makeMessages());

    expect(result.content).toBe('');
  });

  it('returns undefined toolCalls when response has no tool_calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse('plain text'))));

    const client = buildOpenAICompatibleClient('https://api.example.com/v1', 'key', 'model', true);
    const result = await client.chat(makeMessages());

    expect(result.toolCalls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool call parsing
// ---------------------------------------------------------------------------

describe('buildOpenAICompatibleClient — tool call parsing', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('parses tool_calls from response message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(openAIToolCallResponse('search', { query: 'test' })),
      ),
    );

    const client = buildOpenAICompatibleClient('https://api.example.com/v1', 'key', 'model', true);
    const result = await client.chat(makeMessages());

    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0].name).toBe('search');
    expect(result.toolCalls![0].id).toBe('call_abc123');
  });

  it('parses tool call arguments from JSON string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(openAIToolCallResponse('read_file', { path: '/tmp/foo.txt' })),
      ),
    );

    const client = buildOpenAICompatibleClient('https://api.example.com/v1', 'key', 'model', true);
    const result = await client.chat(makeMessages());

    expect(result.toolCalls![0].arguments).toEqual({ path: '/tmp/foo.txt' });
  });
});

// ---------------------------------------------------------------------------
// ProviderClient interface shape
// ---------------------------------------------------------------------------

describe('buildOpenAICompatibleClient — client shape', () => {
  it('client has id and chat function', () => {
    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'key',
      'my-model',
      false,
    );
    expect(typeof client.id).toBe('string');
    expect(client.id.length).toBeGreaterThan(0);
    expect(typeof client.chat).toBe('function');
  });

  it('client exposes the model name', () => {
    const client = buildOpenAICompatibleClient(
      'https://api.example.com/v1',
      'key',
      'kimi-k2-0711-preview',
      false,
    );
    expect(client.model).toBe('kimi-k2-0711-preview');
  });

  it('client exposes supportsTools', () => {
    const clientWithTools = buildOpenAICompatibleClient('https://x.com/v1', 'k', 'm', true);
    const clientNoTools = buildOpenAICompatibleClient('https://x.com/v1', 'k', 'm', false);
    expect(clientWithTools.supportsTools).toBe(true);
    expect(clientNoTools.supportsTools).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('buildOpenAICompatibleClient — error handling', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('throws on HTTP error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({}, false, 401)));

    const client = buildOpenAICompatibleClient('https://api.example.com/v1', 'bad-key', 'model', false);
    await expect(client.chat(makeMessages())).rejects.toThrow(/401/);
  });

  it('throws when fetch itself rejects (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const client = buildOpenAICompatibleClient('https://api.example.com/v1', 'key', 'model', false);
    await expect(client.chat(makeMessages())).rejects.toThrow(/ECONNREFUSED/);
  });
});
