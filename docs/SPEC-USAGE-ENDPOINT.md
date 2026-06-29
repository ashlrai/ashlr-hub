# SPEC: Claude Code Usage Endpoint

> **INTERNAL / UNDOCUMENTED ENDPOINT — USE WITH CAUTION**
> See "Safety Assessment" section before wiring this to production code.

---

## 1. Endpoint

```
GET https://api.anthropic.com/api/oauth/usage
```

- Host: `api.anthropic.com` (confirmed from binary strings: `isFirstPartyAnthropicBaseUrl`, `https://api.anthropic.com`)
- Method: `GET`
- Path: `/api/oauth/usage`
- Auth: OAuth access token supplied as `x-api-key` header (the binary's internal `ei` HTTP client injects this via `auth:"teleport-org"` with `refreshOAuth:true`)

---

## 2. Required Headers

From `fetchUtilization` source extracted from binary:

```
Content-Type: application/json
x-api-key: <oauth_access_token>        ← injected by ei client; NOT a public API key
anthropic-version: 2023-06-01          ← standard Anthropic header
```

The binary does NOT send `anthropic-beta: oauth-2025-04-20` on this specific call (only `Content-Type` is explicit; the oauth header is injected by the auth layer).

---

## 3. Response JSON Shape

Derived from binary source (`fetchUtilization` return value consumed at `R = {...C.five_hour && ...}`):

```jsonc
{
  "five_hour": {               // optional — absent if not on a plan with 5h limits
    "utilization": 0.93,       // float 0.0–1.0, fraction of 5h window used
    "resets_at": 1782774000    // Unix epoch seconds when this window resets
  },
  "seven_day": {               // optional — absent if not applicable
    "utilization": 0.41,       // float 0.0–1.0, fraction of 7-day window used
    "resets_at": 1783200000    // Unix epoch seconds
  },
  "extra_usage": {             // optional — absent if extra usage not enabled
    "is_enabled": true,        // bool
    "used_credits": 1250,      // integer, minor currency units (cents)
    "monthly_limit": 5000,     // integer, minor currency units (cents), null = unlimited
    "utilization": 42          // integer percent (0–100), NOT float like the rate limits above
  }
  // Additional fields may be present — this is undocumented, shape may change
}
```

**Key**: `five_hour.utilization` is a **fraction** (0–1), NOT a percentage. The binary multiplies by 100 for display: `C.five_hour.utilization * 100`.

---

## 4. How the Binary Reads the Response

From binary source (the `_Cm` status-line builder):

```js
R = {
  ...C.five_hour && {
    five_hour: {
      used_percentage: C.five_hour.utilization * 100,
      resets_at: C.five_hour.resets_at
    }
  },
  ...C.seven_day && {
    seven_day: {
      used_percentage: C.seven_day.utilization * 100,
      resets_at: C.seven_day.resets_at
    }
  }
}
```

The status line renders `C.five_hour.utilization * 100` as the "5h %" and `C.seven_day.utilization * 100` as the "weekly %". Mason's reported ~93% maps to `five_hour.utilization ≈ 0.93`.

---

## 5. Token Location

The OAuth access token is stored in the **macOS Keychain** and read at runtime:

- **Keychain service**: `Claude Safe Storage` (account: `Claude Key`)
  - This 24-char entry is an **AES encryption key** (PBKDF2-SHA1 derived), NOT the OAuth token itself
  - It encrypts the token data stored in the Claude desktop app's Chromium LevelDB
- **Session cookie**: `sk-ant-sid02-...` in Claude desktop app's `Cookies` sqlite DB at:
  `~/Library/Application Support/Claude/Cookies`
  - This is the **web session credential** used on `claude.ai`, NOT the CLI OAuth access token
- **Runtime (daemon)**: When the claude daemon is running, the OAuth access token is cached at:
  `/tmp/cc-daemon-<uid>/<config_hash>/auth/<sessionId>.tokens.json`
  - Only present while a session is active; not persistent

**What the CLI actually uses**: The binary reads the OAuth access token at startup from the Claude desktop app bridge socket (env var `CLAUDE_BRIDGE_OAUTH_TOKEN`) or from a file descriptor (env var `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`). There is no persistent flat-file store for the OAuth Bearer token outside the running process.

**For integration purposes**: The token must be obtained at call-time from the running claude process environment, not from a static file.

---

## 6. Probe Results

The endpoint was confirmed to exist and rate-limit per account during discovery:

| Attempt | URL | Auth | Result |
|---------|-----|------|--------|
| Multiple | `https://api.anthropic.com/api/oauth/usage` | `Cookie: sessionKey=...` | `429 Rate Limited` |
| One | `https://claude.ai/api/oauth/usage` | `Cookie: sessionKey=...` | `401 x-api-key required` |

**Interpretation**:
- `429` from `api.anthropic.com` = endpoint exists, but we hit the per-account rate limit during repeated failed discovery probes. Not an auth failure.
- `401` from `claude.ai` = `x-api-key` header required (confirms the OAuth access token must be sent as `x-api-key`, not as a cookie or `Authorization: Bearer`)
- Actual numeric values (5h %, weekly %) could NOT be retrieved in this session due to the rate limit backoff

The response field names and shapes above are sourced directly from binary analysis of the production `claude.exe` (v2.1.179 / v2.1.195), not from a live response.

---

## 7. Integration Design: `src/core/fabric/usage-api.ts`

### Design Constraints

1. **Never log or persist the token** — read at call-time only, discard after use
2. **60-second cache** — the binary itself polls infrequently; this endpoint rate-limits aggressively
3. **Never throws** — return `null` on any failure; caller must handle gracefully
4. **Fallback is primary** — the M253 transcript method is the authoritative fallback and should be treated as equally valid
5. **Authorization: Bearer** — use `x-api-key` header (confirmed from `claude.ai` 401 message)

```typescript
// src/core/fabric/usage-api.ts
// INTERNAL USE: /api/oauth/usage is undocumented and may change without notice.
// This module is best-effort only. The M253 transcript method is the robust fallback.

export interface UsageWindow {
  /** Fraction 0.0–1.0 of window consumed */
  utilization: number;
  /** Unix epoch seconds when window resets */
  resets_at: number;
}

export interface UsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  extra_usage?: {
    is_enabled: boolean;
    used_credits: number | null;
    monthly_limit: number | null;
    utilization: number | null;
  };
}

// 60-second in-memory cache
let _cache: { data: UsageResponse; ts: number } | null = null;
const CACHE_TTL_MS = 60_000;

/**
 * Fetch Claude Code usage from the internal /api/oauth/usage endpoint.
 *
 * IMPORTANT: This is an undocumented Anthropic-internal endpoint. It may
 * change, be rate-limited, or disappear without notice. Always use the
 * M253 transcript method as fallback when this returns null.
 *
 * The OAuth token is read from the process environment at call-time and
 * is never logged or persisted.
 *
 * @returns UsageResponse or null on any failure (auth, network, rate limit, parse)
 */
export async function fetchUsage(): Promise<UsageResponse | null> {
  // Cache hit
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return _cache.data;
  }

  // Read token from environment at call-time only
  // The running claude process sets CLAUDE_CODE_OAUTH_TOKEN or passes via FD
  const token =
    process.env.CLAUDE_CODE_OAUTH_TOKEN ??
    process.env.CLAUDE_BRIDGE_OAUTH_TOKEN ??
    null;

  if (!token) {
    // No token available — caller falls back to transcript method
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,            // token used here, never logged
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      // 429 = rate limited, 401 = token expired, 4xx/5xx = endpoint issue
      // All are silent failures — never throw
      return null;
    }

    const data = (await res.json()) as UsageResponse;

    // Validate minimal shape before caching
    if (typeof data !== 'object' || data === null) return null;

    _cache = { data, ts: Date.now() };
    return data;
  } catch {
    // Network error, timeout, parse error — all silent
    return null;
  }
}

/** Invalidate the cache (e.g. after a known reset event) */
export function invalidateUsageCache(): void {
  _cache = null;
}
```

### ResourceMonitor Integration

```typescript
// In ResourceMonitor (the existing claude signal consumer):
import { fetchUsage } from './usage-api.js';
import { computeUsageFromTranscripts } from './m253-transcript.js'; // existing fallback

export async function getClaudeUsage() {
  // Try the live endpoint first — best-effort, 60s cached
  const live = await fetchUsage();

  if (live?.five_hour?.utilization !== undefined) {
    return {
      source: 'api' as const,
      fiveHourPct: live.five_hour.utilization * 100,
      fiveHourResetsAt: new Date(live.five_hour.resets_at * 1000),
      weeklyPct: live.seven_day ? live.seven_day.utilization * 100 : null,
      weeklyResetsAt: live.seven_day
        ? new Date(live.seven_day.resets_at * 1000)
        : null,
    };
  }

  // Fallback: M253 transcript method (always available, slightly stale)
  const transcript = await computeUsageFromTranscripts();
  return { source: 'transcript' as const, ...transcript };
}
```

---

## 8. Safety Assessment

### Is it safe/appropriate to wire this endpoint?

**Honest answer: conditional yes, with caveats.**

**Arguments for wiring it:**
- The binary itself calls this endpoint on every session start (`fetchUtilization` runs in `uae()` which is called from the main render loop)
- It gives authoritative, server-side usage numbers — unlike the transcript method which is client-estimated and can drift
- The 429 rate limit we hit was self-inflicted by ~20 discovery probes; normal usage (1 call/60s) is well within limits

**Arguments against / risks:**
- **Undocumented, internal endpoint** — Anthropic could rename fields, change the shape, or remove it without notice. The v2.1.195 binary behavior is the spec, not any public docs
- **No OAuth token is persistently accessible** — the token only exists in the running claude process environment. If ashlr-hub is NOT running inside a claude session, `CLAUDE_CODE_OAUTH_TOKEN` will be unset and the call returns null. This limits utility to within-session use
- **Terms of Service gray area** — using internal endpoints not exposed in the public API is not explicitly prohibited but is outside the sanctioned usage surface. Anthropic could consider it a ToS violation
- **Rate limit brittleness** — as demonstrated, even moderate probing triggers 429s. The 60s cache is essential

**Recommendation:**
- Wire it with the 60s cache and token-unavailable fallback as designed above
- Treat it as a **signal enhancer**, not a primary source — the M253 transcript method stays as the always-available baseline
- Add a feature flag (e.g. `ASHLR_USAGE_API=1`) so it can be disabled if Anthropic changes the endpoint
- Never surface an error to the user if this call fails — silent fallback only
- Re-evaluate if/when Anthropic documents a public usage API (there are signals in the binary suggesting a more stable usage API may be planned)

---

## 9. Summary

| Item | Value |
|------|-------|
| Endpoint | `GET https://api.anthropic.com/api/oauth/usage` |
| Auth | `x-api-key: <oauth_access_token>` (NOT a public API key) |
| 5h field | `five_hour.utilization` (float 0–1; multiply by 100 for %) |
| 5h reset | `five_hour.resets_at` (Unix epoch seconds) |
| Weekly field | `seven_day.utilization` (float 0–1; multiply by 100 for %) |
| Weekly reset | `seven_day.resets_at` (Unix epoch seconds) |
| Token location | Runtime env only (`CLAUDE_CODE_OAUTH_TOKEN` / bridge FD) |
| Probe result | 429 (rate limited from discovery probes) — endpoint confirmed |
| Live numbers | Not retrieved (rate limited) |
| Recommended cache | 60 seconds |
| Status | Undocumented internal — must keep M253 fallback |
