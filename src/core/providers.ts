/**
 * Provider registry — probes local-model endpoints (LM Studio, Ollama) and
 * resolves the active provider from the configured chain.
 *
 * Rules:
 *  - NEVER throws; all probes return typed results with up:false on failure.
 *  - Uses global fetch (Node 22+) with a 2-second AbortController timeout.
 *  - Cloud providers (e.g. 'anthropic') are treated as up when the relevant
 *    env var is present (ANTHROPIC_API_KEY), else skipped.
 */

import type { AshlrConfig, ProviderEndpoint, ProviderRegistry } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a base URL has the expected path suffix.
 * e.g. ensurePath('http://localhost:1234', '/v1/models') -> 'http://localhost:1234/v1/models'
 * If the URL already ends with the path, it is returned unchanged.
 */
function ensurePath(base: string, suffix: string): string {
  const stripped = base.replace(/\/+$/, '');
  if (stripped.endsWith(suffix)) return stripped;
  return stripped + suffix;
}

/**
 * Parse model names from an LM Studio /v1/models response (OpenAI shape).
 * Returns empty array on any shape mismatch.
 */
function parseLmStudioModels(body: unknown): string[] {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>)['data'])
  ) {
    return [];
  }
  const data = (body as { data: unknown[] }).data;
  return data
    .filter((m): m is { id: string } => typeof (m as Record<string, unknown>)['id'] === 'string')
    .map((m) => m.id);
}

/**
 * Parse model names from an Ollama /api/tags response.
 * Returns empty array on any shape mismatch.
 */
function parseOllamaModels(body: unknown): string[] {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>)['models'])
  ) {
    return [];
  }
  const models = (body as { models: unknown[] }).models;
  return models
    .filter(
      (m): m is { name: string } => typeof (m as Record<string, unknown>)['name'] === 'string',
    )
    .map((m) => m.name);
}

/**
 * Determine which response shape to use for a given probe URL.
 * - URL ends with /v1/models  → LM Studio (OpenAI) shape
 * - URL ends with /api/tags   → Ollama shape
 * - Fallback: try LM Studio shape first, then Ollama
 */
function parseModels(url: string, body: unknown): string[] {
  if (url.endsWith('/v1/models')) return parseLmStudioModels(body);
  if (url.endsWith('/api/tags')) return parseOllamaModels(body);
  // Unknown path — try both shapes, take whichever yields results
  const lm = parseLmStudioModels(body);
  return lm.length > 0 ? lm : parseOllamaModels(body);
}

// ---------------------------------------------------------------------------
// Cloud provider env-var map
// Extend as new cloud providers are added to providerChain.
// ---------------------------------------------------------------------------

const CLOUD_PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  cohere: 'COHERE_API_KEY',
  groq: 'GROQ_API_KEY',
  nvidia_nim: 'NVIDIA_NIM_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  hermes_api: 'HERMES_API_KEY',
};

/**
 * Returns true if a cloud provider's API key is present in process.env.
 * Unknown cloud providers default to false (not considered up).
 */
function cloudProviderUp(id: string): boolean {
  const envVar = CLOUD_PROVIDER_ENV[id.toLowerCase()];
  if (!envVar) return false;
  const val = process.env[envVar];
  return typeof val === 'string' && val.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Probe a single provider endpoint with a 2-second timeout.
 *
 * - For LM Studio: GET <url>/v1/models (appended if not already present)
 * - For Ollama:    GET <url>/api/tags   (appended if not already present)
 * - For other ids: url is used as-is (caller must supply full probe URL)
 *
 * Never throws — returns up:false with an error string on any failure.
 */
export async function probeEndpoint(id: string, url: string): Promise<ProviderEndpoint> {
  // Determine the canonical probe URL
  let probeUrl: string;
  if (id === 'lmstudio') {
    probeUrl = ensurePath(url, '/v1/models');
  } else if (id === 'ollama') {
    probeUrl = ensurePath(url, '/api/tags');
  } else {
    probeUrl = url;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(probeUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    // NOTE: do NOT clearTimeout here — the abort signal must stay armed across
    // the response-body read below so a server that streams/hangs the body is
    // still bounded by the 2s timeout. Cleared in the finally block.

    if (!response.ok) {
      return {
        id,
        url: probeUrl,
        up: false,
        models: [],
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch {
      return {
        id,
        url: probeUrl,
        up: false,
        models: [],
        error: 'Response body is not valid JSON',
      };
    }

    const models = parseModels(probeUrl, body);
    return { id, url: probeUrl, up: true, models };
  } catch (err: unknown) {
    let message: string;
    if (err instanceof Error) {
      message = err.name === 'AbortError' ? 'Probe timed out after 2s' : err.message;
    } else {
      message = String(err);
    }

    return { id, url: probeUrl, up: false, models: [], error: message };
  } finally {
    // Disarm the timeout only after the body read has completed or failed,
    // so the abort signal bounds both the fetch() and the response.json().
    clearTimeout(timer);
  }
}

/**
 * Build the full ProviderRegistry from the current config.
 *
 * - Probes cfg.models.lmstudio and cfg.models.ollama in parallel.
 * - Walks cfg.models.providerChain in order to find the first up provider.
 * - Cloud providers (e.g. 'anthropic') count as up if their env key exists.
 * - Local providers not in the config (unknown ids) are skipped gracefully.
 */
export async function getProviderRegistry(cfg: AshlrConfig): Promise<ProviderRegistry> {
  const chain = cfg.models.providerChain;

  // Probe the two known local endpoints in parallel
  const [lmResult, ollamaResult] = await Promise.all([
    probeEndpoint('lmstudio', cfg.models.lmstudio),
    probeEndpoint('ollama', cfg.models.ollama),
  ]);

  // Build a lookup map for the probed local endpoints
  const localEndpoints: Record<string, ProviderEndpoint> = {
    lmstudio: lmResult,
    ollama: ollamaResult,
  };

  // Assemble the providers list in chain order where possible,
  // appending any probed endpoints not present in the chain.
  const seenIds = new Set<string>();
  const providers: ProviderEndpoint[] = [];

  for (const providerId of chain) {
    if (seenIds.has(providerId)) continue;
    seenIds.add(providerId);

    if (localEndpoints[providerId] !== undefined) {
      providers.push(localEndpoints[providerId]);
    }
    // Cloud providers are not added as ProviderEndpoint entries
    // (they have no local URL to probe) — they participate only in
    // activeProvider resolution below.
  }

  // Add any probed local endpoints that were not in the chain
  for (const [id, endpoint] of Object.entries(localEndpoints)) {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      providers.push(endpoint);
    }
  }

  // Resolve activeProvider: first entry in chain that is considered "up"
  let activeProvider: string | null = null;
  for (const providerId of chain) {
    const local = localEndpoints[providerId];
    if (local !== undefined) {
      if (local.up) {
        activeProvider = providerId;
        break;
      }
    } else {
      // Treat as a cloud provider — up if env key is present
      if (cloudProviderUp(providerId)) {
        activeProvider = providerId;
        break;
      }
    }
  }

  // Failover fallback: if the configured chain yielded no active provider but a
  // probed local endpoint is actually up (e.g. a custom chain that omits an up
  // local id), select the first up local endpoint. Keeps default behavior
  // identical (the default chain already lists both local ids) while making
  // failover correct for non-default chains.
  if (activeProvider === null) {
    for (const endpoint of providers) {
      if (endpoint.up) {
        activeProvider = endpoint.id;
        break;
      }
    }
  }

  return { providers, activeProvider, chain };
}

/**
 * Convenience wrapper — returns the id of the active provider, or null.
 */
export async function resolveActiveProvider(cfg: AshlrConfig): Promise<string | null> {
  const registry = await getProviderRegistry(cfg);
  return registry.activeProvider;
}
