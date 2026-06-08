/**
 * Tests for src/core/providers.ts (M2)
 *
 * All tests are hermetic: fetch is mocked via vi.stubGlobal — no real network.
 * Probes never throw; they return typed ProviderEndpoint with up:false on error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(providerChain: string[] = ['lmstudio', 'ollama']): AshlrConfig {
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

/** Build a minimal mock Response that fetch returns. */
function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Fake fetch that returns a successful LM Studio /v1/models response. */
function lmStudioResponse(models: string[]): Response {
  return mockResponse({
    data: models.map(id => ({ id })),
  });
}

/** Fake fetch that returns a successful Ollama /api/tags response. */
function ollamaResponse(models: string[]): Response {
  return mockResponse({
    models: models.map(name => ({ name })),
  });
}

// ---------------------------------------------------------------------------
// Import module under test (AFTER potential vi.mock setup)
// ---------------------------------------------------------------------------
import { probeEndpoint, getProviderRegistry, resolveActiveProvider } from '../src/core/providers.js';

// ---------------------------------------------------------------------------
// probeEndpoint — LM Studio style (data[].id)
// ---------------------------------------------------------------------------

// probeEndpoint('lmstudio', url) internally appends /v1/models if not already
// present, so we pass the base URL. The result.url will be the full probe URL.
describe('probeEndpoint — LM Studio up', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(lmStudioResponse(['gpt-4o', 'llama3'])));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns up:true when endpoint responds', async () => {
    const result = await probeEndpoint('lmstudio', 'http://localhost:1234');
    expect(result.up).toBe(true);
  });

  it('returns the correct id', async () => {
    const result = await probeEndpoint('lmstudio', 'http://localhost:1234');
    expect(result.id).toBe('lmstudio');
  });

  it('url in result contains the probe path', async () => {
    const result = await probeEndpoint('lmstudio', 'http://localhost:1234');
    expect(result.url).toContain('localhost:1234');
  });

  it('populates models array from data[].id', async () => {
    const result = await probeEndpoint('lmstudio', 'http://localhost:1234');
    expect(result.models).toContain('gpt-4o');
    expect(result.models).toContain('llama3');
  });

  it('does not set error when up', async () => {
    const result = await probeEndpoint('lmstudio', 'http://localhost:1234');
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// probeEndpoint — Ollama style (models[].name)
// ---------------------------------------------------------------------------

// probeEndpoint('ollama', url) internally appends /api/tags; pass the base URL.
describe('probeEndpoint — Ollama up', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ollamaResponse(['llama3:8b', 'mistral'])));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns up:true', async () => {
    const result = await probeEndpoint('ollama', 'http://localhost:11434');
    expect(result.up).toBe(true);
  });

  it('populates models from models[].name', async () => {
    const result = await probeEndpoint('ollama', 'http://localhost:11434');
    expect(result.models).toContain('llama3:8b');
    expect(result.models).toContain('mistral');
  });
});

// ---------------------------------------------------------------------------
// probeEndpoint — endpoint down (fetch rejects / network error)
// ---------------------------------------------------------------------------

describe('probeEndpoint — network down (fetch rejects)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns up:false without throwing', async () => {
    const result = await probeEndpoint('lmstudio', 'http://localhost:1234/v1/models');
    expect(result.up).toBe(false);
  });

  it('returns empty models array when down', async () => {
    const result = await probeEndpoint('lmstudio', 'http://localhost:1234/v1/models');
    expect(result.models).toEqual([]);
  });

  it('sets error field when down', async () => {
    const result = await probeEndpoint('lmstudio', 'http://localhost:1234/v1/models');
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('preserves id and url even when down', async () => {
    const url = 'http://localhost:1234/v1/models';
    const result = await probeEndpoint('lmstudio', url);
    expect(result.id).toBe('lmstudio');
    expect(result.url).toBe(url);
  });
});

// ---------------------------------------------------------------------------
// probeEndpoint — HTTP 4xx/5xx (non-ok response)
// ---------------------------------------------------------------------------

describe('probeEndpoint — HTTP error response', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({}, false, 503)));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns up:false for non-ok HTTP status', async () => {
    const result = await probeEndpoint('lmstudio', 'http://localhost:1234/v1/models');
    expect(result.up).toBe(false);
  });

  it('returns empty models for non-ok status', async () => {
    const result = await probeEndpoint('lmstudio', 'http://localhost:1234/v1/models');
    expect(result.models).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// probeEndpoint — timeout / AbortError
// ---------------------------------------------------------------------------

describe('probeEndpoint — timeout', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns up:false without throwing on abort/timeout', async () => {
    const result = await probeEndpoint('ollama', 'http://localhost:11434');
    expect(result.up).toBe(false);
    expect(result.models).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getProviderRegistry — chain ordering + activeProvider resolution
// ---------------------------------------------------------------------------

describe('getProviderRegistry — both providers up', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('1234')) return Promise.resolve(lmStudioResponse(['model-a']));
      if (String(url).includes('11434')) return Promise.resolve(ollamaResponse(['model-b']));
      return Promise.reject(new Error('unexpected URL'));
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns a registry with both providers', async () => {
    const cfg = makeConfig(['lmstudio', 'ollama']);
    const registry = await getProviderRegistry(cfg);
    expect(registry.providers.length).toBeGreaterThanOrEqual(2);
  });

  it('chain reflects cfg.models.providerChain', async () => {
    const cfg = makeConfig(['lmstudio', 'ollama']);
    const registry = await getProviderRegistry(cfg);
    expect(registry.chain).toEqual(['lmstudio', 'ollama']);
  });

  it('activeProvider is the first up provider in the chain', async () => {
    const cfg = makeConfig(['lmstudio', 'ollama']);
    const registry = await getProviderRegistry(cfg);
    expect(registry.activeProvider).toBe('lmstudio');
  });
});

describe('getProviderRegistry — lmstudio down, ollama up', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('1234')) return Promise.reject(new Error('ECONNREFUSED'));
      if (String(url).includes('11434')) return Promise.resolve(ollamaResponse(['llama3:latest']));
      return Promise.reject(new Error('unexpected URL'));
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('activeProvider falls over to ollama when lmstudio is down', async () => {
    const cfg = makeConfig(['lmstudio', 'ollama']);
    const registry = await getProviderRegistry(cfg);
    expect(registry.activeProvider).toBe('ollama');
  });

  it('lmstudio provider is marked up:false', async () => {
    const cfg = makeConfig(['lmstudio', 'ollama']);
    const registry = await getProviderRegistry(cfg);
    const lms = registry.providers.find(p => p.id === 'lmstudio');
    expect(lms?.up).toBe(false);
  });

  it('ollama provider is marked up:true', async () => {
    const cfg = makeConfig(['lmstudio', 'ollama']);
    const registry = await getProviderRegistry(cfg);
    const oll = registry.providers.find(p => p.id === 'ollama');
    expect(oll?.up).toBe(true);
  });
});

describe('getProviderRegistry — all providers down', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('activeProvider is null when all providers are down', async () => {
    const cfg = makeConfig(['lmstudio', 'ollama']);
    const registry = await getProviderRegistry(cfg);
    expect(registry.activeProvider).toBeNull();
  });

  it('does not throw when all providers are down', async () => {
    const cfg = makeConfig(['lmstudio', 'ollama']);
    await expect(getProviderRegistry(cfg)).resolves.toBeDefined();
  });
});

describe('getProviderRegistry — empty chain', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('should not be called')));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('handles an empty providerChain gracefully', async () => {
    const cfg = makeConfig([]);
    const registry = await getProviderRegistry(cfg);
    expect(registry.activeProvider).toBeNull();
    expect(registry.chain).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveActiveProvider — convenience wrapper
// ---------------------------------------------------------------------------

describe('resolveActiveProvider', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns the first up provider id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('1234')) return Promise.reject(new Error('down'));
      if (String(url).includes('11434')) return Promise.resolve(ollamaResponse(['llama3']));
      return Promise.reject(new Error('unexpected'));
    }));
    const cfg = makeConfig(['lmstudio', 'ollama']);
    const active = await resolveActiveProvider(cfg);
    expect(active).toBe('ollama');
  });

  it('returns null when no providers are up', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('all down')));
    const cfg = makeConfig(['lmstudio', 'ollama']);
    const active = await resolveActiveProvider(cfg);
    expect(active).toBeNull();
  });
});
