/**
 * limits.ts — M63: real usage-window ingestion for Mission Control.
 *
 * `resolveUsageWindows(cfg)` replaces the "not wired" stub with:
 *
 *  (a) REAL rolling-window token/cost summaries from local transcripts
 *      (5 h — Claude Code's effective session window, and 24 h).
 *
 *  (b) Per-provider subscription/key status:
 *      - API-key providers (ANTHROPIC_API_KEY, OPENAI_API_KEY): attempt the
 *        real billing/usage endpoint with a short timeout; degrade gracefully.
 *      - Subscription plans (no key): honest note — caps are NOT API-exposed.
 *
 * Never throws. Never fabricates a limit number.
 */

import type { AshlrConfig } from '../types.js';
import { collectUsageEvents } from './usage-source.js';
import { modelToProviderKey } from './rollup.js';
import { estCostUsd } from '../run/budget.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UsageWindow {
  provider: string;
  window: '5h' | '24h';
  tokens: number;
  costUsd: number;
}

export interface ProviderLimitEntry {
  provider: string;
  kind: 'subscription' | 'api-key';
  detail: string;
  /** Only present when knowable from the API (never fabricated). */
  limit?: number;
  /** Only present when knowable from the API (never fabricated). */
  used?: number;
  /** Only present when the API returns a reset timestamp. */
  resetAt?: string;
}

export interface UsageWindowsResult {
  connected: boolean;
  windows: UsageWindow[];
  providers: ProviderLimitEntry[];
  note: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_5H  = 5  * 60 * 60 * 1_000;
const MS_24H = 24 * 60 * 60 * 1_000;

/** Timeout for provider API calls (ms). Degrade on any overrun. */
const PROVIDER_API_TIMEOUT_MS = 4_000;

// ---------------------------------------------------------------------------
// Rolling-window aggregation (REAL — from local transcripts)
// ---------------------------------------------------------------------------

function buildWindows(): UsageWindow[] {
  const now = Date.now();

  // Collect the broader 24 h window; the 5 h subset is a filter over it.
  const events24h = collectUsageEvents(now - MS_24H);

  // Accumulate per-provider × per-window
  const acc = new Map<string, { t5: number; c5: number; t24: number; c24: number }>();

  for (const ev of events24h) {
    const provKey = modelToProviderKey(ev.model);
    if (!acc.has(provKey)) {
      acc.set(provKey, { t5: 0, c5: 0, t24: 0, c24: 0 });
    }
    const bucket = acc.get(provKey)!;
    const tokens = ev.tokensIn + ev.tokensOut;
    const cost   = estCostUsd(provKey, ev.tokensIn, ev.tokensOut);

    bucket.t24 += tokens;
    bucket.c24 += cost;

    // Is this event within the 5 h sub-window?
    try {
      if (new Date(ev.ts).getTime() >= now - MS_5H) {
        bucket.t5 += tokens;
        bucket.c5 += cost;
      }
    } catch {
      // Malformed ts — already included in 24 h total above, skip 5 h
    }
  }

  const windows: UsageWindow[] = [];
  for (const [provider, b] of acc.entries()) {
    windows.push({ provider, window: '5h',  tokens: b.t5,  costUsd: Math.round(b.c5  * 1e6) / 1e6 });
    windows.push({ provider, window: '24h', tokens: b.t24, costUsd: Math.round(b.c24 * 1e6) / 1e6 });
  }

  // Sort: provider asc, then window ('5h' before '24h')
  windows.sort((a, b) => {
    const pc = a.provider.localeCompare(b.provider);
    if (pc !== 0) return pc;
    return a.window === '5h' ? -1 : 1;
  });

  return windows;
}

// ---------------------------------------------------------------------------
// Provider-key API calls (best-effort, degrade on any error/timeout)
// ---------------------------------------------------------------------------

/**
 * Wrap a fetch call with an AbortController timeout.
 * Returns the Response, or throws on timeout/network error.
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attempt to read Anthropic usage via the usage API.
 * Endpoint: GET https://api.anthropic.com/v1/usage
 * (As of 2025 Anthropic exposes token usage via the usage events API; we
 * surface what the endpoint returns and never fabricate limits.)
 *
 * Degrades to detail:'usage API unavailable' on any error or timeout.
 */
async function fetchAnthropicUsage(apiKey: string): Promise<ProviderLimitEntry> {
  const base: ProviderLimitEntry = {
    provider: 'anthropic',
    kind: 'api-key',
    detail: 'usage API unavailable',
  };

  try {
    // Anthropic usage events endpoint (beta, token-level usage data)
    const res = await fetchWithTimeout(
      'https://api.anthropic.com/v1/usage',
      {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'usage-1',
        },
      },
      PROVIDER_API_TIMEOUT_MS,
    );

    if (!res.ok) {
      const msg = res.status === 401 ? 'invalid API key'
                : res.status === 403 ? 'API key lacks usage permissions'
                : res.status === 404 ? 'usage endpoint not available on this plan'
                : `HTTP ${res.status}`;
      return { ...base, detail: msg };
    }

    const data = await res.json() as Record<string, unknown>;

    // The response shape varies; surface what's present without fabricating.
    // If Anthropic returns total_tokens or similar we surface it.
    const inputTokens  = typeof data['input_tokens']  === 'number' ? data['input_tokens']  : null;
    const outputTokens = typeof data['output_tokens'] === 'number' ? data['output_tokens'] : null;

    if (inputTokens !== null || outputTokens !== null) {
      const total = (inputTokens ?? 0) + (outputTokens ?? 0);
      return {
        provider: 'anthropic',
        kind: 'api-key',
        detail: `API key active — billing usage accessible`,
        used: total,
        // Anthropic does NOT expose plan caps via the usage API — never fabricate `limit`
      };
    }

    return { ...base, detail: 'API key active — usage endpoint returned no token counts' };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return { ...base, detail: isAbort ? 'usage API timed out' : 'usage API unavailable' };
  }
}

/**
 * Attempt to read OpenAI usage via the usage dashboard API.
 * Endpoint: GET https://api.openai.com/v1/usage (date-scoped)
 * Degrades to detail:'usage API unavailable' on any error or timeout.
 */
async function fetchOpenAIUsage(apiKey: string): Promise<ProviderLimitEntry> {
  const base: ProviderLimitEntry = {
    provider: 'openai',
    kind: 'api-key',
    detail: 'usage API unavailable',
  };

  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const res = await fetchWithTimeout(
      `https://api.openai.com/v1/usage?date=${today}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
      PROVIDER_API_TIMEOUT_MS,
    );

    if (!res.ok) {
      const msg = res.status === 401 ? 'invalid API key'
                : res.status === 403 ? 'API key lacks usage permissions'
                : res.status === 429 ? 'usage API rate-limited'
                : `HTTP ${res.status}`;
      return { ...base, detail: msg };
    }

    const data = await res.json() as Record<string, unknown>;

    // OpenAI usage endpoint returns { data: Array<{ n_context_tokens_total, n_generated_tokens_total }> }
    const items = Array.isArray(data['data']) ? data['data'] as Record<string, unknown>[] : [];
    let contextTotal = 0;
    let generatedTotal = 0;
    for (const item of items) {
      if (typeof item['n_context_tokens_total']   === 'number') contextTotal   += item['n_context_tokens_total'];
      if (typeof item['n_generated_tokens_total'] === 'number') generatedTotal += item['n_generated_tokens_total'];
    }

    const total = contextTotal + generatedTotal;
    if (total > 0) {
      return {
        provider: 'openai',
        kind: 'api-key',
        detail: `API key active — today's usage accessible`,
        used: total,
        // OpenAI does NOT expose plan hard caps via the usage API — never fabricate `limit`
      };
    }

    // soft-quota from headers if present (OpenAI sometimes includes these)
    const remainingRequests = res.headers.get('x-ratelimit-remaining-requests');
    const limitRequests     = res.headers.get('x-ratelimit-limit-requests');
    if (remainingRequests !== null && limitRequests !== null) {
      const lim  = parseInt(limitRequests, 10);
      const used = lim - parseInt(remainingRequests, 10);
      if (!isNaN(lim) && !isNaN(used)) {
        return {
          provider: 'openai',
          kind: 'api-key',
          detail: `API key active — request-level rate limit visible`,
          used,
          limit: lim,
        };
      }
    }

    return { ...base, detail: 'API key active — usage endpoint returned no token counts' };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return { ...base, detail: isAbort ? 'usage API timed out' : 'usage API unavailable' };
  }
}

// ---------------------------------------------------------------------------
// Provider list builder
// ---------------------------------------------------------------------------

async function buildProviders(): Promise<ProviderLimitEntry[]> {
  const anthropicKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const openaiKey    = process.env['OPENAI_API_KEY']    ?? '';

  const entries: Promise<ProviderLimitEntry>[] = [];

  if (anthropicKey) {
    entries.push(fetchAnthropicUsage(anthropicKey));
  } else {
    entries.push(Promise.resolve({
      provider: 'anthropic',
      kind: 'subscription' as const,
      detail:
        'Claude Pro/Max subscription plan — rate limits are not exposed via a public API. ' +
        'Rolling-window usage above reflects your real local session activity.',
    }));
  }

  if (openaiKey) {
    entries.push(fetchOpenAIUsage(openaiKey));
  } else {
    // Only surface OpenAI if there's actual usage in local transcripts
    // (avoids polluting the panel for users who don't use OpenAI at all).
    // We resolve eagerly here and filter in the caller if needed.
    entries.push(Promise.resolve({
      provider: 'openai',
      kind: 'subscription' as const,
      detail:
        'No OPENAI_API_KEY set — subscription plan limits are not API-accessible. ' +
        'Set OPENAI_API_KEY to enable usage API polling.',
    }));
  }

  return Promise.all(entries);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve usage windows and provider limit/subscription information.
 *
 * - `windows`: REAL rolling-window token+cost sums from local transcripts.
 *   Sourced from collectUsageEvents() — METADATA only, no content.
 * - `providers`: API-key providers get a best-effort live call (degrades
 *   gracefully). Subscription plans get an honest note; `limit` is never
 *   fabricated.
 * - `note`: one-line honest summary.
 *
 * Never throws.
 */
export async function resolveUsageWindows(_cfg: AshlrConfig): Promise<UsageWindowsResult> {
  try {
    const [windows, providers] = await Promise.all([
      Promise.resolve(buildWindows()),
      buildProviders(),
    ]);

    const hasApiKey = providers.some((p) => p.kind === 'api-key');
    const connected = hasApiKey;

    const note = hasApiKey
      ? 'Rolling-window usage from local transcripts (real). API-key providers polled best-effort; subscription plan caps are not API-exposed.'
      : 'Rolling-window usage from local transcripts (real). Subscription plan rate limits are not exposed via any public API — no limit numbers are fabricated.';

    return { connected, windows, providers, note };
  } catch {
    return {
      connected: false,
      windows: [],
      providers: [],
      note: 'Usage data unavailable.',
    };
  }
}
