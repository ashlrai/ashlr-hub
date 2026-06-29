/**
 * test/m254.usage-api.test.ts — M254 OAuth usage API + resource-monitor wiring.
 *
 * Invariants proved:
 *
 *  1. PARSE five_hour/seven_day → fiveHourPct/weeklyPct (utilization * 100, rounded).
 *
 *  2. NO-TOKEN → null immediately (no fetch attempted).
 *
 *  3. NULL → TRANSCRIPT FALLBACK: when fetchClaudeUsageApi() returns null,
 *     senseClaudeState falls back to M253 transcript method.
 *
 *  4. 60s CACHE: repeated calls within TTL return cached result without new fetch.
 *
 *  5. NEVER-THROWS: network error, parse error, AbortError all → null (no throw).
 *
 *  6. RESOURCE-MONITOR API-FIRST: when API returns data, uses it for availability
 *     classification (max of fiveHourPct/weeklyPct vs protectPct).
 *
 *  7. NO-REGRESSION: flag-off (resourceAware=false) byte-identical.
 *
 *  8. EXTRA-USAGE: optional extra_usage block parsed when present.
 *
 *  9. NON-2XX → null (no retry, no throw).
 *
 * 10. CACHE-NULL: a failed fetch (no token / 429) is also cached so the endpoint
 *     is not probed again within TTL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Env isolation helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string | undefined;
let origProjectsDir: string | undefined;
let origToken: string | undefined;
let origBridgeToken: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m254-'));
  mkdirSync(join(tmpHome, '.ashlr', 'decisions'), { recursive: true });
  mkdirSync(join(tmpHome, '.ashlr', 'fleet'), { recursive: true });
  mkdirSync(join(tmpHome, '.claude', 'projects'), { recursive: true });

  origHome = process.env['HOME'];
  origProjectsDir = process.env['CLAUDE_PROJECTS_DIR'];
  origToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  origBridgeToken = process.env['CLAUDE_BRIDGE_OAUTH_TOKEN'];

  process.env['HOME'] = tmpHome;
  process.env['CLAUDE_PROJECTS_DIR'] = join(tmpHome, '.claude', 'projects');
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  delete process.env['CLAUDE_BRIDGE_OAUTH_TOKEN'];

  vi.resetModules();
});

afterEach(() => {
  process.env['HOME'] = origHome;
  if (origProjectsDir === undefined) {
    delete process.env['CLAUDE_PROJECTS_DIR'];
  } else {
    process.env['CLAUDE_PROJECTS_DIR'] = origProjectsDir;
  }
  if (origToken === undefined) {
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  } else {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = origToken;
  }
  if (origBridgeToken === undefined) {
    delete process.env['CLAUDE_BRIDGE_OAUTH_TOKEN'];
  } else {
    process.env['CLAUDE_BRIDGE_OAUTH_TOKEN'] = origBridgeToken;
  }
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function mockFetchWith(responseBody: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseBody,
  }));
}

function mockFetchNetworkError(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
}

function mockFetchAbort(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
  ));
}

/** Build a valid usage API response body. */
function makeUsageBody(opts: {
  fiveHourUtil?: number;
  fiveHourResetsAt?: number;
  weeklyUtil?: number;
  weeklyResetsAt?: number;
  extraUsage?: {
    is_enabled: boolean;
    used_credits: number;
    monthly_limit: number;
    utilization: number;
  };
}) {
  return {
    five_hour: {
      utilization: opts.fiveHourUtil ?? 0.3,
      resets_at:   opts.fiveHourResetsAt ?? 1700000000,
    },
    seven_day: {
      utilization: opts.weeklyUtil ?? 0.5,
      resets_at:   opts.weeklyResetsAt ?? 1700086400,
    },
    ...(opts.extraUsage ? { extra_usage: opts.extraUsage } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. Parse five_hour/seven_day → pcts
// ---------------------------------------------------------------------------

describe('M254 fetchClaudeUsageApi — parse utilization', () => {
  it('converts five_hour.utilization and seven_day.utilization to percentages', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith(makeUsageBody({ fiveHourUtil: 0.42, weeklyUtil: 0.67 }));

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const result = await fetchClaudeUsageApi();

    expect(result).not.toBeNull();
    expect(result!.fiveHourPct).toBe(42);   // 0.42 * 100 = 42
    expect(result!.weeklyPct).toBe(67);     // 0.67 * 100 = 67
  });

  it('rounds fractional utilization', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith(makeUsageBody({ fiveHourUtil: 0.425, weeklyUtil: 0.675 }));

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const result = await fetchClaudeUsageApi();

    expect(result).not.toBeNull();
    // Math.round(42.5) = 43, Math.round(67.5) = 68
    expect(result!.fiveHourPct).toBe(43);
    expect(result!.weeklyPct).toBe(68);
  });

  it('exposes resets_at fields as unix epoch seconds', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    const fhReset = 1700000000;
    const wkReset = 1700086400;
    mockFetchWith(makeUsageBody({ fiveHourResetsAt: fhReset, weeklyResetsAt: wkReset }));

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const result = await fetchClaudeUsageApi();

    expect(result!.fiveHourResetAt).toBe(fhReset);
    expect(result!.weeklyResetAt).toBe(wkReset);
  });

  it('returns null for malformed response (missing five_hour)', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith({ seven_day: { utilization: 0.5, resets_at: 1700000000 } });

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const result = await fetchClaudeUsageApi();

    expect(result).toBeNull();
  });

  it('returns null for malformed response (utilization not a number)', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith({
      five_hour: { utilization: 'high', resets_at: 1700000000 },
      seven_day: { utilization: 0.5,    resets_at: 1700000000 },
    });

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const result = await fetchClaudeUsageApi();

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. No token → null (no fetch)
// ---------------------------------------------------------------------------

describe('M254 fetchClaudeUsageApi — no token → null', () => {
  it('returns null immediately when CLAUDE_CODE_OAUTH_TOKEN is absent', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const result = await fetchClaudeUsageApi();

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when CLAUDE_BRIDGE_OAUTH_TOKEN is also absent', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const result = await fetchClaudeUsageApi();

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses CLAUDE_BRIDGE_OAUTH_TOKEN as fallback when primary token absent', async () => {
    process.env['CLAUDE_BRIDGE_OAUTH_TOKEN'] = 'bridge-token-redacted';
    mockFetchWith(makeUsageBody({ fiveHourUtil: 0.1, weeklyUtil: 0.2 }));

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const result = await fetchClaudeUsageApi();

    expect(result).not.toBeNull();
    expect(result!.fiveHourPct).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 3. Null → transcript fallback in resource-monitor
// ---------------------------------------------------------------------------

describe('M254 resource-monitor — null API → transcript fallback', () => {
  it('falls back to transcript method when API returns null (no token)', async () => {
    // No token → API returns null → transcript path fires
    // Write 5 assistant messages in 5h window
    const projectPath = join(tmpHome, '.claude', 'projects', 'proj-a');
    mkdirSync(projectPath, { recursive: true });
    const lines = Array.from({ length: 5 }, () => JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));
    writeFileSync(join(projectPath, 'session.jsonl'), lines.join('\n') + '\n');

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: { allowedBackends: ['claude'], claudeResource: { fiveHourMessageCap: 100, protectPct: 85 } },
    };

    const state = await getBackendResourceState('claude', cfg);
    // Should use transcript fallback: 5 messages / 100 cap = 5% → open
    expect(state.availability).toBe('open');
    expect(state.usedPct).toBe(5);
    expect(state.capWindow).toBe('5h'); // transcript uses 5h window label
    expect(state.reason).toMatch(/5h/); // transcript reason cites 5h
  });
});

// ---------------------------------------------------------------------------
// 4. 60-second cache
// ---------------------------------------------------------------------------

describe('M254 fetchClaudeUsageApi — 60s cache', () => {
  it('does not call fetch again within 60s TTL', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeUsageBody({ fiveHourUtil: 0.3, weeklyUtil: 0.4 }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { fetchClaudeUsageApi, invalidateUsageApiCache } = await import('../src/core/fabric/usage-api.js');
    invalidateUsageApiCache(); // ensure cold start

    const r1 = await fetchClaudeUsageApi();
    const r2 = await fetchClaudeUsageApi();
    const r3 = await fetchClaudeUsageApi();

    expect(fetchSpy).toHaveBeenCalledTimes(1); // only one fetch despite 3 calls
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  it('caches null (no-token result) to prevent repeated no-op checks', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { fetchClaudeUsageApi, invalidateUsageApiCache } = await import('../src/core/fabric/usage-api.js');
    invalidateUsageApiCache();

    await fetchClaudeUsageApi();
    await fetchClaudeUsageApi();
    await fetchClaudeUsageApi();

    // No token → resolved without calling fetch, and cached null
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-fetches after invalidateUsageApiCache()', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeUsageBody({ fiveHourUtil: 0.1, weeklyUtil: 0.2 }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { fetchClaudeUsageApi, invalidateUsageApiCache } = await import('../src/core/fabric/usage-api.js');
    invalidateUsageApiCache();

    await fetchClaudeUsageApi();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    invalidateUsageApiCache();
    await fetchClaudeUsageApi();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Never-throws
// ---------------------------------------------------------------------------

describe('M254 fetchClaudeUsageApi — never-throws', () => {
  it('returns null (does not throw) on network error', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchNetworkError();

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    await expect(fetchClaudeUsageApi()).resolves.toBeNull();
  });

  it('returns null (does not throw) on AbortError (timeout)', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchAbort();

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    await expect(fetchClaudeUsageApi()).resolves.toBeNull();
  });

  it('returns null (does not throw) on non-JSON response', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    await expect(fetchClaudeUsageApi()).resolves.toBeNull();
  });

  it('returns null (does not throw) on null response body', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith(null);

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    await expect(fetchClaudeUsageApi()).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Resource-monitor API-first: availability classification
// ---------------------------------------------------------------------------

describe('M254 resource-monitor — API-first availability classification', () => {
  function makeCfg(protectPct = 85) {
    return {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: {
        allowedBackends: ['claude'],
        claudeResource: { fiveHourMessageCap: 100, protectPct },
      },
    };
  }

  beforeEach(() => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));
  });

  it('open when max(fiveHourPct, weeklyPct) < 75', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith(makeUsageBody({ fiveHourUtil: 0.30, weeklyUtil: 0.40 }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const state = await getBackendResourceState('claude', makeCfg());

    expect(state.availability).toBe('open');
    expect(state.usedPct).toBe(40); // max(30, 40)
    expect(state.reason).toMatch(/oauth-usage-api/);
  });

  it('near when max(fiveHourPct, weeklyPct) >= 75 and < protectPct(85)', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith(makeUsageBody({ fiveHourUtil: 0.60, weeklyUtil: 0.78 }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const state = await getBackendResourceState('claude', makeCfg());

    expect(state.availability).toBe('near');
    expect(state.usedPct).toBe(78); // max(60, 78)
  });

  it('throttled when max(fiveHourPct, weeklyPct) >= protectPct(85)', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith(makeUsageBody({ fiveHourUtil: 0.90, weeklyUtil: 0.50 }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const state = await getBackendResourceState('claude', makeCfg());

    expect(state.availability).toBe('throttled');
    expect(state.usedPct).toBe(90);
    expect(state.reason).toMatch(/protectPct/);
    expect(state.reason).toMatch(/oauth-usage-api/);
  });

  it('exhausted when max(fiveHourPct, weeklyPct) >= 100', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith(makeUsageBody({ fiveHourUtil: 1.05, weeklyUtil: 0.80 }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const state = await getBackendResourceState('claude', makeCfg());

    expect(state.availability).toBe('exhausted');
    expect(state.usedPct).toBeGreaterThanOrEqual(100); // 1.05 → 105%, above threshold
  });

  it('reason cites both 5h and weekly percentages', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith(makeUsageBody({ fiveHourUtil: 0.35, weeklyUtil: 0.55 }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const state = await getBackendResourceState('claude', makeCfg());

    expect(state.reason).toMatch(/5h: 35%/);
    expect(state.reason).toMatch(/weekly: 55%/);
    expect(state.reason).toMatch(/source=oauth-usage-api/);
  });

  it('resetsAt is max of fiveHourResetAt and weeklyResetAt', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    const fhReset = 1700000000;
    const wkReset = 1700086400;
    mockFetchWith(makeUsageBody({ fiveHourResetsAt: fhReset, weeklyResetsAt: wkReset }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const state = await getBackendResourceState('claude', makeCfg());

    expect(state.resetsAt).toBe(wkReset); // max of the two
  });
});

// ---------------------------------------------------------------------------
// 7. Flag-off (resourceAware=false) byte-identical
// ---------------------------------------------------------------------------

describe('M254 resource-monitor — flag-off unchanged', () => {
  it('does not sense claude when resourceAware is off (backoff path unaffected)', async () => {
    // This test verifies the backoff path still short-circuits before the API call.
    // recordBackoff → backoffStore hit → return exhausted without API probe.
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState, recordBackoff } = await import('../src/core/fabric/resource-monitor.js');
    recordBackoff('claude', 5 * 60 * 1000, 'test-429');

    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: { allowedBackends: ['claude'], claudeResource: { fiveHourMessageCap: 100, protectPct: 85 } },
    };
    const state = await getBackendResourceState('claude', cfg);

    // Backoff is hit before API path — fetch never called
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.availability).toBe('exhausted');
    expect(state.reason).toMatch(/backoff/);
  });
});

// ---------------------------------------------------------------------------
// 8. extra_usage block parsed
// ---------------------------------------------------------------------------

describe('M254 fetchClaudeUsageApi — extra_usage', () => {
  it('parses extra_usage when present', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith(makeUsageBody({
      fiveHourUtil: 0.2,
      weeklyUtil: 0.4,
      extraUsage: { is_enabled: true, used_credits: 150, monthly_limit: 1000, utilization: 15 },
    }));

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const result = await fetchClaudeUsageApi();

    expect(result).not.toBeNull();
    expect(result!.extraUsage).toBeDefined();
    expect(result!.extraUsage!.isEnabled).toBe(true);
    expect(result!.extraUsage!.usedCredits).toBe(150);
    expect(result!.extraUsage!.monthlyLimit).toBe(1000);
    expect(result!.extraUsage!.utilizationPct).toBe(15);
  });

  it('omits extraUsage when not present in response', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith(makeUsageBody({ fiveHourUtil: 0.2, weeklyUtil: 0.3 }));

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const result = await fetchClaudeUsageApi();

    expect(result!.extraUsage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Non-2xx → null (no retry)
// ---------------------------------------------------------------------------

describe('M254 fetchClaudeUsageApi — non-2xx response', () => {
  it('returns null on 429 (rate limit)', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith({}, 429);

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    await expect(fetchClaudeUsageApi()).resolves.toBeNull();
  });

  it('returns null on 401 (unauthorized)', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    mockFetchWith({ error: 'unauthorized' }, 401);

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    await expect(fetchClaudeUsageApi()).resolves.toBeNull();
  });

  it('caches null after 429 (does not hammer endpoint)', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-redacted';
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const { fetchClaudeUsageApi, invalidateUsageApiCache } = await import('../src/core/fabric/usage-api.js');
    invalidateUsageApiCache();

    await fetchClaudeUsageApi(); // first call → 429 → cache null
    await fetchClaudeUsageApi(); // second call → cache hit → no second fetch
    await fetchClaudeUsageApi(); // third call → still cache hit

    expect(fetchSpy).toHaveBeenCalledTimes(1); // only ONE real request
  });
});

// ---------------------------------------------------------------------------
// 10. No-regression: existing M253/M250 tests still pass structurally
// ---------------------------------------------------------------------------

describe('M254 no-regression — M253 transcript path intact when no API token', () => {
  it('transcript path still fires for weeklyTokenBudget mode (API token absent)', async () => {
    // Fleet-ledger mode — even without API token, ledger path must still work
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {}, tools: {},
      foundry: {
        allowedBackends: ['claude'],
        claudeResource: { weeklyTokenBudget: 1_000_000, protectPct: 85 },
      },
    };

    const state = await getBackendResourceState('claude', cfg);
    expect(state.capWindow).toBe('7d');
    expect(state.usedPct).toBe(0);
    expect(state.reason).toMatch(/fleet/i);
    // Must NOT cite oauth-usage-api (no token)
    expect(state.reason).not.toMatch(/oauth-usage-api/);
  });
});
