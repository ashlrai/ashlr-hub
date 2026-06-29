/**
 * usage-api.ts — M254 Claude Code OAuth Usage API client.
 *
 * Fetches authoritative utilization from the internal Claude Code endpoint:
 *   GET https://api.anthropic.com/api/oauth/usage
 *   x-api-key: <CLAUDE_CODE_OAUTH_TOKEN>
 *
 * SAFETY INVARIANTS:
 *  - Never throws. Network/parse errors return null (triggers transcript fallback).
 *  - 60-second module-level cache (endpoint rate-limits HARD — confirmed 429 on burst).
 *  - No token when absent → null immediately (no probe attempt).
 *  - 3-second AbortController timeout on the fetch.
 *  - NEVER logs or surfaces the token value.
 *  - No retries on any error (429, auth failure, network).
 *
 * Response shape (internal undocumented endpoint, confirmed from binary analysis):
 *   {
 *     five_hour:   { utilization: 0..1, resets_at: <unix-sec> }
 *     seven_day:   { utilization: 0..1, resets_at: <unix-sec> }
 *     extra_usage?: { is_enabled: bool, used_credits: number, monthly_limit: number, utilization: int% }
 *   }
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClaudeApiExtraUsage {
  isEnabled: boolean;
  usedCredits: number;
  monthlyLimit: number;
  /** Integer percentage (0–100+). */
  utilizationPct: number;
}

export interface ClaudeApiUsageResult {
  /** 5-hour rolling window utilization as a percentage (0–100+). */
  fiveHourPct: number;
  /** 7-day rolling window utilization as a percentage (0–100+). */
  weeklyPct: number;
  /** Unix epoch seconds when the 5h window resets. */
  fiveHourResetAt: number;
  /** Unix epoch seconds when the 7d window resets. */
  weeklyResetAt: number;
  /** Extra/overage usage block, if present in response. */
  extraUsage?: ClaudeApiExtraUsage;
}

// ---------------------------------------------------------------------------
// Cache (60 seconds — hard minimum per spec)
// ---------------------------------------------------------------------------

interface ApiUsageCache {
  result: ClaudeApiUsageResult | null;
  expiresAt: number;
}

let _apiCache: ApiUsageCache | null = null;
const API_CACHE_TTL_MS = 60_000; // 60 seconds — never call more than once/60s

/** Invalidate the API cache (used in tests). */
export function invalidateUsageApiCache(): void {
  _apiCache = null;
}

// ---------------------------------------------------------------------------
// Token resolver — never logs the value
// ---------------------------------------------------------------------------

function resolveOAuthToken(): string | null {
  const t = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? process.env['CLAUDE_BRIDGE_OAUTH_TOKEN'];
  return typeof t === 'string' && t.length > 0 ? t : null;
}

// ---------------------------------------------------------------------------
// Core fetcher
// ---------------------------------------------------------------------------

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 3000;

/**
 * Fetch authoritative Claude Code usage from the internal OAuth usage endpoint.
 *
 * Returns null when:
 *  - No OAuth token in env (CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_BRIDGE_OAUTH_TOKEN)
 *  - Network error or timeout
 *  - Non-2xx response (including 429 rate-limit — do NOT retry)
 *  - Parse error or unexpected response shape
 *
 * 60-second cache prevents hammering the endpoint.
 * Never throws.
 */
export async function fetchClaudeUsageApi(): Promise<ClaudeApiUsageResult | null> {
  const now = Date.now();

  // Return cached result (including cached null — don't retry within TTL)
  if (_apiCache && _apiCache.expiresAt > now) {
    return _apiCache.result;
  }

  const token = resolveOAuthToken();
  if (!token) {
    // No token available — cache null so we don't re-probe every call
    _apiCache = { result: null, expiresAt: now + API_CACHE_TTL_MS };
    return null;
  }

  let result: ClaudeApiUsageResult | null = null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(USAGE_ENDPOINT, {
        method: 'GET',
        headers: {
          'x-api-key': token,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!resp.ok) {
      // 429, 401, 403, etc — do NOT retry, cache null
      _apiCache = { result: null, expiresAt: now + API_CACHE_TTL_MS };
      return null;
    }

    const body = await resp.json() as unknown;
    result = parseUsageResponse(body);
  } catch {
    // Network error, abort, parse error — all → null, no retry
    result = null;
  }

  _apiCache = { result, expiresAt: now + API_CACHE_TTL_MS };
  return result;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

function parseUsageResponse(body: unknown): ClaudeApiUsageResult | null {
  try {
    if (typeof body !== 'object' || body === null) return null;
    const b = body as Record<string, unknown>;

    const fiveHour = b['five_hour'];
    const sevenDay  = b['seven_day'];

    if (typeof fiveHour !== 'object' || fiveHour === null) return null;
    if (typeof sevenDay  !== 'object' || sevenDay  === null) return null;

    const fh = fiveHour as Record<string, unknown>;
    const sd = sevenDay  as Record<string, unknown>;

    const fhUtil    = fh['utilization'];
    const fhReset   = fh['resets_at'];
    const sdUtil    = sd['utilization'];
    const sdReset   = sd['resets_at'];

    if (typeof fhUtil  !== 'number') return null;
    if (typeof fhReset !== 'number') return null;
    if (typeof sdUtil  !== 'number') return null;
    if (typeof sdReset !== 'number') return null;

    const result: ClaudeApiUsageResult = {
      fiveHourPct:    Math.round(fhUtil * 100),
      weeklyPct:      Math.round(sdUtil * 100),
      fiveHourResetAt: fhReset,
      weeklyResetAt:   sdReset,
    };

    // Optional extra_usage block
    const extra = b['extra_usage'];
    if (typeof extra === 'object' && extra !== null) {
      const ex = extra as Record<string, unknown>;
      if (
        typeof ex['is_enabled']    === 'boolean' &&
        typeof ex['used_credits']  === 'number'  &&
        typeof ex['monthly_limit'] === 'number'  &&
        typeof ex['utilization']   === 'number'
      ) {
        result.extraUsage = {
          isEnabled:      ex['is_enabled']    as boolean,
          usedCredits:    ex['used_credits']  as number,
          monthlyLimit:   ex['monthly_limit'] as number,
          utilizationPct: ex['utilization']   as number,
        };
      }
    }

    return result;
  } catch {
    return null;
  }
}
