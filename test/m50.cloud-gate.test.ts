/**
 * M50 — cloud gate tests for getActiveClient.
 *
 * Proves the local-first gate is UNCHANGED after the M50 refactor:
 *   - cloud provider active + allowCloud=false → throws local-first error
 *   - cloud provider active + allowCloud=true but key absent → throws missing-key error
 *   - allowCloud=true + key present → returns a valid ProviderClient (fetch mocked)
 *   - null activeProvider → throws "no provider" error
 *
 * Does NOT test Ollama/LM Studio paths (covered by existing tests).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock providers.ts so no real HTTP probes happen
// ---------------------------------------------------------------------------

vi.mock('../src/core/providers.js', () => ({
  getProviderRegistry: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------

import { getActiveClient } from '../src/core/run/provider-client.js';
import { getProviderRegistry } from '../src/core/providers.js';

const mockGetRegistry = getProviderRegistry as ReturnType<typeof vi.fn>;

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

/** Stub registry returning a specific active provider (no real endpoints). */
function stubRegistry(activeProvider: string | null): void {
  mockGetRegistry.mockResolvedValue({
    providers: [],
    activeProvider,
    chain: activeProvider ? [activeProvider] : [],
  });
}

/** Build a minimal mock Response for fetch. */
function mockJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function openAIResponse(content = 'ok'): unknown {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NVIDIA_NIM_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.HERMES_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NVIDIA_NIM_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.HERMES_API_KEY;
});

// ---------------------------------------------------------------------------
// Gate 1: no provider active
// ---------------------------------------------------------------------------

describe('getActiveClient — no provider active', () => {
  it('throws when activeProvider is null', async () => {
    stubRegistry(null);
    const cfg = makeConfig([]);
    await expect(
      getActiveClient(cfg, { allowCloud: false }),
    ).rejects.toThrow(/no provider is reachable/i);
  });
});

// ---------------------------------------------------------------------------
// Gate 2: cloud provider + allowCloud=false → always throws
// ---------------------------------------------------------------------------

describe('getActiveClient — cloud provider, allowCloud=false', () => {
  it('throws for nvidia_nim when allowCloud=false', async () => {
    stubRegistry('nvidia_nim');
    process.env.NVIDIA_NIM_API_KEY = 'sk-nim-present';
    const cfg = makeConfig(['nvidia_nim']);
    await expect(
      getActiveClient(cfg, { allowCloud: false }),
    ).rejects.toThrow(/local-first.*nvidia_nim.*cloud/i);
  });

  it('throws for moonshot when allowCloud=false', async () => {
    stubRegistry('moonshot');
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-key';
    const cfg = makeConfig(['moonshot']);
    await expect(
      getActiveClient(cfg, { allowCloud: false }),
    ).rejects.toThrow(/local-first.*moonshot.*cloud/i);
  });

  it('throws for kimi alias when allowCloud=false', async () => {
    stubRegistry('kimi');
    process.env.MOONSHOT_API_KEY = 'sk-kimi-key';
    const cfg = makeConfig(['kimi']);
    await expect(
      getActiveClient(cfg, { allowCloud: false }),
    ).rejects.toThrow(/local-first.*kimi.*cloud/i);
  });

  it('throws for hermes_api when allowCloud=false', async () => {
    stubRegistry('hermes_api');
    process.env.HERMES_API_KEY = 'sk-hermes-key';
    const cfg = makeConfig(['hermes_api']);
    await expect(
      getActiveClient(cfg, { allowCloud: false }),
    ).rejects.toThrow(/local-first.*hermes_api.*cloud/i);
  });

  it('throws even without a key set when allowCloud=false', async () => {
    stubRegistry('nvidia_nim');
    // No key set
    const cfg = makeConfig(['nvidia_nim']);
    await expect(
      getActiveClient(cfg, { allowCloud: false }),
    ).rejects.toThrow(/local-first/i);
  });
});

// ---------------------------------------------------------------------------
// Gate 3: cloud provider + allowCloud=true but key absent → throws
// ---------------------------------------------------------------------------

describe('getActiveClient — cloud provider, allowCloud=true, key absent', () => {
  it('throws for nvidia_nim when NVIDIA_NIM_API_KEY is not set', async () => {
    stubRegistry('nvidia_nim');
    delete process.env.NVIDIA_NIM_API_KEY;
    const cfg = makeConfig(['nvidia_nim']);
    await expect(
      getActiveClient(cfg, { allowCloud: true }),
    ).rejects.toThrow(/NVIDIA_NIM_API_KEY/);
  });

  it('throws for moonshot when MOONSHOT_API_KEY is not set', async () => {
    stubRegistry('moonshot');
    delete process.env.MOONSHOT_API_KEY;
    const cfg = makeConfig(['moonshot']);
    await expect(
      getActiveClient(cfg, { allowCloud: true }),
    ).rejects.toThrow(/MOONSHOT_API_KEY/);
  });

  it('throws for hermes_api when HERMES_API_KEY is not set', async () => {
    stubRegistry('hermes_api');
    delete process.env.HERMES_API_KEY;
    const cfg = makeConfig(['hermes_api']);
    await expect(
      getActiveClient(cfg, { allowCloud: true }),
    ).rejects.toThrow(/HERMES_API_KEY/);
  });

  it('throws when key is set to empty string', async () => {
    stubRegistry('nvidia_nim');
    process.env.NVIDIA_NIM_API_KEY = '';
    const cfg = makeConfig(['nvidia_nim']);
    await expect(
      getActiveClient(cfg, { allowCloud: true }),
    ).rejects.toThrow(/NVIDIA_NIM_API_KEY/);
  });

  it('throws when key is whitespace only', async () => {
    stubRegistry('moonshot');
    process.env.MOONSHOT_API_KEY = '   ';
    const cfg = makeConfig(['moonshot']);
    await expect(
      getActiveClient(cfg, { allowCloud: true }),
    ).rejects.toThrow(/MOONSHOT_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// Gate passes: allowCloud=true + key present → returns valid client
// ---------------------------------------------------------------------------

describe('getActiveClient — cloud provider, allowCloud=true, key present', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns a ProviderClient for nvidia_nim when key and allowCloud are set', async () => {
    stubRegistry('nvidia_nim');
    process.env.NVIDIA_NIM_API_KEY = 'sk-nim-valid-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse())));

    const cfg = makeConfig(['nvidia_nim']);
    const client = await getActiveClient(cfg, { allowCloud: true });

    expect(typeof client.id).toBe('string');
    expect(typeof client.chat).toBe('function');
  });

  it('returns a ProviderClient for moonshot when key and allowCloud are set', async () => {
    stubRegistry('moonshot');
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-valid';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse())));

    const cfg = makeConfig(['moonshot']);
    const client = await getActiveClient(cfg, { allowCloud: true });

    expect(typeof client.id).toBe('string');
    expect(typeof client.chat).toBe('function');
  });

  it('returns a ProviderClient for hermes_api when key and allowCloud are set', async () => {
    stubRegistry('hermes_api');
    process.env.HERMES_API_KEY = 'sk-hermes-valid';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse())));

    const cfg = makeConfig(['hermes_api']);
    const client = await getActiveClient(cfg, { allowCloud: true });

    expect(typeof client.id).toBe('string');
    expect(typeof client.chat).toBe('function');
  });

  it('returned client.chat() calls the correct base URL for nvidia_nim', async () => {
    stubRegistry('nvidia_nim');
    process.env.NVIDIA_NIM_API_KEY = 'sk-nim-key';
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse()));
    vi.stubGlobal('fetch', fetchSpy);

    const cfg = makeConfig(['nvidia_nim']);
    const client = await getActiveClient(cfg, { allowCloud: true });
    await client.chat([{ role: 'user', content: 'hi' }]);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('integrate.api.nvidia.com');
    expect(url).toContain('chat/completions');
  });

  it('returned client.chat() sends Bearer auth for nvidia_nim', async () => {
    stubRegistry('nvidia_nim');
    process.env.NVIDIA_NIM_API_KEY = 'sk-nim-bearer-test';
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse()));
    vi.stubGlobal('fetch', fetchSpy);

    const cfg = makeConfig(['nvidia_nim']);
    const client = await getActiveClient(cfg, { allowCloud: true });
    await client.chat([{ role: 'user', content: 'hi' }]);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-nim-bearer-test');
  });

  it('kimi alias routes to moonshot base URL', async () => {
    stubRegistry('kimi');
    process.env.MOONSHOT_API_KEY = 'sk-kimi-bearer';
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(openAIResponse()));
    vi.stubGlobal('fetch', fetchSpy);

    const cfg = makeConfig(['kimi']);
    const client = await getActiveClient(cfg, { allowCloud: true });
    await client.chat([{ role: 'user', content: 'hello' }]);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.moonshot.ai');
    expect(url).toContain('chat/completions');
  });
});

// ---------------------------------------------------------------------------
// Gate invariant: error messages are informative
// ---------------------------------------------------------------------------

describe('getActiveClient — error message quality', () => {
  it('allowCloud=false error mentions the provider id', async () => {
    stubRegistry('nvidia_nim');
    const cfg = makeConfig(['nvidia_nim']);
    let caught: Error | null = null;
    try {
      await getActiveClient(cfg, { allowCloud: false });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('nvidia_nim');
    expect(caught!.message.toLowerCase()).toContain('local-first');
  });

  it('missing-key error mentions the env var name', async () => {
    stubRegistry('hermes_api');
    delete process.env.HERMES_API_KEY;
    const cfg = makeConfig(['hermes_api']);
    let caught: Error | null = null;
    try {
      await getActiveClient(cfg, { allowCloud: true });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('HERMES_API_KEY');
  });
});
