# SPEC-DATA-ACQUISITION — Total Data Visibility for the God-View Resource Control Plane

**Status:** Design spec — implementation starts at M262  
**Branch:** feat/v4-foundry → master  
**Relates to:** SPEC-RESOURCE-CONTROL-PLANE.md, SPEC-INFERENCE-FABRIC.md, SPEC-V4-FOUNDRY.md

---

## 1. Why Data Is the Lever

The god-view resource control plane (`src/core/fabric/resource-monitor.ts`,
`gateway.ts`) can only make elite routing decisions when it has real, timely
data. Today the ResourceMonitor has three blind spots:

1. **Claude (cli-agent path):** availability is inferred from
   `~/.claude/stats-cache.json` message counts — a loose proxy that
   over-counts human+fleet combined and has no reset timestamp.
2. **NIM / OpenAI-compat (api-model path):** `senseNimState()` always returns
   `availability:'open'` — it never reads any actual signal.
3. **Historical usage / cost:** the system has no structured record of what it
   spent, on what model, at what time, so cost-to-green routing and cap
   forecasting are impossible.

All three problems are solvable without new runtime dependencies.  Every API
already returns the data in response headers and local files.  This spec
defines how to capture all of it, persist it to a unified internal data layer,
and wire it into every decision point that needs it.

**The highest-leverage single change:** capturing the `anthropic-ratelimit-*`
and `x-ratelimit-*` response headers that the APIs already return on **every
completion call**.  These headers give per-minute remaining-requests and
remaining-tokens with exact reset timestamps — real headroom, not an estimate.
For the api-model path this costs zero extra network calls.  For the claude
cli-agent path a lightweight post-dispatch probe recovers the same data at
~$0.000003 per call, debounced to at most once per 60 seconds.

---

## 2. Per-Backend Data Sources

The table below is ground-truth for what is actually obtainable from each
backend.  "Not gettable" means confirmed: no public API, no header, no file.
The best proxy column states what the system SHOULD use instead.

### 2.1 Master Table

| Backend | Granularity | What | How | Auth | Gettable? |
|---|---|---|---|---|---|
| **Anthropic** | Per-request | RPM remaining | `anthropic-ratelimit-requests-remaining` response header | None (key already in request) | YES — api-model path only |
| **Anthropic** | Per-request | ITPM remaining | `anthropic-ratelimit-input-tokens-remaining` response header | None | YES — api-model path only |
| **Anthropic** | Per-request | OTPM remaining | `anthropic-ratelimit-output-tokens-remaining` response header | None | YES — api-model path only |
| **Anthropic** | Per-request | Reset timestamps | `anthropic-ratelimit-{requests,input-tokens,output-tokens}-reset` (RFC 3339) | None | YES — api-model path only |
| **Anthropic** | Per-request | Retry delay | `retry-after` header on 429 | None | YES — already consumed by `recordBackoff()` |
| **Anthropic** | Per-request | Combined headroom | `anthropic-ratelimit-tokens-remaining/limit/reset` (most-restrictive constraint) | None | YES — reflects strictest of ITPM/OTPM |
| **Anthropic** | Per-request | Priority Tier headers | `anthropic-priority-input-tokens-*` / `anthropic-priority-output-tokens-*` | None | YES — only if on Priority Tier |
| **Anthropic** | 1m / 1h / 1d | Historical token usage | `GET /v1/organizations/usage_report/messages` — params: `starting_at`, `ending_at`, `bucket_width`, `group_by[]`, `models[]` | `x-api-key: ANTHROPIC_ADMIN_KEY` (sk-ant-admin01-…) | YES — requires Admin API key (separate from subscription OAuth token) |
| **Anthropic** | 1d only | Historical cost (USD cents) | `GET /v1/organizations/cost_report` | `x-api-key: ANTHROPIC_ADMIN_KEY` | YES — daily only, excludes Priority Tier costs |
| **Anthropic** | Static | Configured rate limits (RPM/ITPM/OTPM per model group) | `GET /v1/organizations/rate_limits` | `x-api-key: ANTHROPIC_ADMIN_KEY` | YES — static caps only, NOT live remaining |
| **Anthropic** | Static | Workspace-level rate limit overrides | `GET /v1/organizations/workspaces/{id}/rate_limits` | `x-api-key: ANTHROPIC_ADMIN_KEY` | YES — static caps only |
| **Anthropic** | Monthly | Spend cap ($500/$1k/$200k) | Console UI only | — | **NOT gettable via API** — proxy: poll `cost_report` daily and alert at 80% of known tier cap |
| **Anthropic (cli-agent)** | Per-request | Headers | `claude --output-format stream-json` emits final `result` event with `usage.input_tokens` / `usage.output_tokens` only — raw HTTP headers are not surfaced | — | **NOT gettable** from CLI subprocess — proxy: post-dispatch probe POST (see §3.2) |
| **Anthropic (cli-agent)** | Rolling 7d | Message count | `~/.claude/stats-cache.json` `dailyActivity.messageCount` | None (local file) | YES — already in `sumClaudeMessages7d()` — NOT a billing metric, over-counts human+fleet |
| **Anthropic (subscription)** | Weekly | Hard message cap | Not exposed by any API for Pro/Max subscription plans | — | **NOT gettable** — proxy: user sets `cfg.foundry.limits.claude.weeklyMessageCap`; system forecasts from stats-cache trend |
| **OpenAI** | Per-request | RPM remaining | `x-ratelimit-remaining-requests` response header | None | YES — api-model path |
| **OpenAI** | Per-request | TPM remaining | `x-ratelimit-remaining-tokens` response header | None | YES — api-model path |
| **OpenAI** | Per-request | Reset times | `x-ratelimit-reset-requests` / `x-ratelimit-reset-tokens` (duration string e.g. `6m0s`) | None | YES — must parse to absolute timestamp client-side |
| **OpenAI** | Per-request | Per-project token limit | `x-ratelimit-limit-project-tokens` / `x-ratelimit-remaining-project-tokens` / `x-ratelimit-reset-project-tokens` | None | YES — present when project-level limits are set |
| **OpenAI** | Per-day enforcement | RPD / TPD (per-day) limits | Enforced by the API but NOT reflected in any response headers — a 429 from RPD exhaustion is header-identical to an RPM 429 | — | **NOT gettable** in headers — proxy: poll usage API daily |
| **OpenAI** | 1m / 1h / 1d | Historical token usage | `GET /v1/organization/usage/completions` — params: `start_time` (Unix sec), `bucket_width`, `group_by[]` | Org-level API key (`Authorization: Bearer OPENAI_ADMIN_KEY`) — project keys return 403 | YES — requires org-level key |
| **OpenAI** | Static | Configured tier RPM/TPM caps | Not returned by any programmatic endpoint — must be hardcoded or inferred from the `x-ratelimit-limit-*` values seen on the first successful response | — | **NOT gettable** via API — proxy: capture limit values from live response headers |
| **NVIDIA NIM (hosted)** | Per-request | Rate-limit headers | None — `integrate.api.nvidia.com` returns zero `x-ratelimit-*` headers under any conditions (confirmed by direct curl without auth) | — | **NOT gettable** |
| **NVIDIA NIM (hosted)** | Per-request | Credits exhausted | HTTP 402 status | Bearer NGC personal key | YES — only signal available |
| **NVIDIA NIM (hosted)** | Per-request | Throttled | HTTP 429 — `retry-after` header MAY appear | Bearer NGC personal key | Conditional — not documented, treat as optional |
| **NVIDIA NIM (hosted)** | Any | Usage / cost / quota | Not exposed by any public API — only visible at `ngc.nvidia.com` dashboard | — | **NOT gettable** — no proxy exists |
| **NVIDIA NIM (self-hosted)** | Per-request | Rate-limit headers | None — standard HTTP only, no built-in `x-ratelimit-*` infrastructure | — | **NOT gettable** — proxy: Ollama-style concurrency probe |
| **Codex (cli-agent)** | Per-session | Used percent (5h window) | `~/.codex/sessions/*.jsonl` — `token_count` events, `rate_limits.primary.used_percent` | None (local file) | YES — already in `readCodexRateLimits()` via `codex-source.ts` |
| **Codex (cli-agent)** | Per-session | Used percent (7d window) | `rate_limits.secondary.used_percent` from same session files | None | YES — same as above |
| **Codex (cli-agent)** | Per-session | Window size + reset time | `rate_limits.primary.window_minutes`, `rate_limits.primary.resets_at` | None | YES — reflects state AFTER the last turn; lag acceptable under fleet load |
| **Codex (cli-agent)** | Weekly | Hard subscription cap | Not exposed — same opacity as Claude subscription | — | **NOT gettable** — proxy: same pattern as Claude (user-configured cap + trend forecast) |
| **Ollama (local)** | Real-time | Loaded models + VRAM usage | `GET http://localhost:11434/api/ps` (2s timeout) | None | YES — already in `senseLocalState()` |
| **llama-server (local)** | Real-time | Availability probe | `GET <baseUrl>/v1/models` | None | YES — already in `engineInstalled()` probe |

### 2.2 Key Constraints

**Anthropic token bucket is NOT a fixed window.**  The `remaining` counts
replenish continuously throughout the minute.  The `reset` timestamp marks when
the bucket would be FULL again — not when the next request is allowed.  Never
treat a near-zero `remaining` at :30s as a hard block through :00; the bucket
will have partially refilled.  Use the reset timestamp as a worst-case
upper-bound only.

**Anthropic combined header reflects the most-restrictive constraint.**
`anthropic-ratelimit-tokens-remaining` shows the lower of ITPM and OTPM
currently in effect.  If workspace-level limits exist, this shows the workspace
ceiling, not the org ceiling.  Always read the per-type headers
(`input-tokens-remaining`, `output-tokens-remaining`) alongside the combined
header for fleet dispatch decisions.

**Anthropic cache tokens do NOT count toward ITPM (most models).**
`cache_read_input_tokens` are excluded from the ITPM bucket for all models
except Haiku 3.5.  The `anthropic-ratelimit-input-tokens-remaining` header
already accounts for this.  Do NOT subtract cached tokens again — it would
double-deflate the headroom estimate.

**Admin API key is a distinct credential.**  The usage/cost/rate-limits
endpoints on `api.anthropic.com` 401 with a standard API key
(`sk-ant-api03-…`) or the subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`).
They require an Admin API key (`sk-ant-admin01-…`).  This key is only available
to organizations (not individual accounts).  When absent, the system falls back
to local stats-cache.json heuristics.

**OpenAI reset values are duration strings.**  `x-ratelimit-reset-requests:
6m0s` means "6 minutes from now", not a timestamp.  Parse with the regex
`/^(?:(\d+)m)?(?:(\d+)s)?$/` and add to `Date.now()`.  Anthropic uses RFC 3339
— these two formats differ and must not be conflated in the store.

**NVIDIA NIM is opaque by design.**  The free-tier model uses cloud credits, not
token buckets.  There is no rate-limit header, no usage API, and no programmatic
credit balance endpoint.  The only actionable signals are HTTP 402 (credits
exhausted) and HTTP 429 (throttled).  Fleet strategy: treat NIM as
"open until 402", demote immediately on 402, surface a manual dashboard-check
warning.

---

## 3. Live Rate-Limit Header Capture — The Creative Win

### 3.1 Why This Is the Highest-Leverage Change

Every `POST /v1/chat/completions` response from Anthropic and OpenAI already
carries exact per-minute headroom in response headers.  These headers are
available for ZERO additional cost on the api-model path — every real dispatch
already returns them.  The only reason the ResourceMonitor does not use them
today is that nothing reads them off the response before the body is consumed.

Capturing them turns the ResourceMonitor from a heuristic guesser into a
real-time resource control plane.  Instead of "claude used 47 messages this
week, estimate 62% of cap", the system knows "claude api-model has 4,200
input tokens remaining in the current minute, resetting at 14:23:07Z".  This
precision enables the gateway to make correct dispatch vs. defer decisions under
load without ever querying an external endpoint.

### 3.2 Data Flow

```
Real dispatch (api-model path)
  │
  ▼
buildOpenAICompatibleClient() — provider-client.ts
  │
  │  POST /v1/chat/completions
  │◄─────────────────────────────────────────────────────────────
  │  Response headers (before body consumed):
  │    anthropic-ratelimit-requests-remaining: 4950
  │    anthropic-ratelimit-input-tokens-remaining: 82400
  │    anthropic-ratelimit-input-tokens-reset: 2026-06-29T14:23:07Z
  │    x-ratelimit-remaining-requests: 9800
  │    x-ratelimit-remaining-tokens: 1820000
  │    x-ratelimit-reset-tokens: 6m0s
  │
  ▼
extractAndStoreRateLimitHeaders()     ← new, in provider-client.ts
  │
  ▼
storeSnapshot()                       ← new, rate-limit-store.ts
  │  ~/.ashlr/fleet/rate-limits.json  (atomic write, no secrets)
  │
  ▼
getSnapshot(backend)                  ← read by resource-monitor.ts
  │
  ▼
senseClaudeState() / senseNimState()  ← prefer live snapshot when <90s fresh
  │
  ▼
GatewayDecision: backend, tier, model, reason
```

For the **claude cli-agent path** (subprocess), headers are not accessible
from the child process stdout.  A lightweight post-dispatch probe recovers them:

```
spawnEngineInner() settle(ok:true) for claude engine
  │
  └─► setImmediate(() => probeAnthropicRateLimitHeaders('claude', cfg).catch(() => {}))
        │
        │  60s debounce guard — skip if last probe was <60s ago
        │
        ▼
        resolveProviderKey('ANTHROPIC_API_KEY', cfg)
          │  phantom vault first, then process.env
          │  returns undefined when absent → probe is skipped silently
          │
          ▼
        https.request (Node built-in, zero new deps)
          POST api.anthropic.com/v1/messages
          model: claude-haiku-4-5, max_tokens: 1, messages: [{role:'user',content:'x'}]
          cost: ~$0.000003 per probe
          │
          ▼
        response headers → storeSnapshot('claude')
```

When `ANTHROPIC_API_KEY` is absent (subscription-only setup), the probe is
skipped and the existing `sumClaudeMessages7d()` heuristic remains active — no
regression.

### 3.3 New Files

**`src/core/fabric/rate-limit-store.ts`** — The single source of truth for
live rate-limit snapshots.

```typescript
export interface RateLimitSnapshot {
  backend: string;          // engine id (e.g. 'claude', 'nim', 'codex')
  model: string;            // concrete model string at time of capture
  capturedAt: number;       // Date.now() ms — used for freshness guard

  // Anthropic headers (api-model path, or probe path for cli-agent)
  requestsLimit: number | null;
  requestsRemaining: number | null;
  requestsResetAt: string | null;       // RFC 3339

  inputTokensLimit: number | null;
  inputTokensRemaining: number | null;
  inputTokensResetAt: string | null;    // RFC 3339

  outputTokensLimit: number | null;
  outputTokensRemaining: number | null;
  outputTokensResetAt: string | null;   // RFC 3339

  // Combined / most-restrictive (Anthropic only)
  tokensLimit: number | null;
  tokensRemaining: number | null;
  tokensResetAt: string | null;         // RFC 3339

  // OpenAI-compat headers (nim, kimi, openai-compat, llama-server)
  rlLimitRequests: number | null;
  rlRemainingRequests: number | null;
  rlResetRequests: string | null;       // duration string — parsed to absolute at read time

  rlLimitTokens: number | null;
  rlRemainingTokens: number | null;
  rlResetTokens: string | null;

  rlLimitProjectTokens: number | null;
  rlRemainingProjectTokens: number | null;
  rlResetProjectTokens: string | null;
}

export function storeSnapshot(snap: RateLimitSnapshot): void;  // atomic write
export function getSnapshot(backend: string): RateLimitSnapshot | null;  // in-memory first
```

Persisted at `~/.ashlr/fleet/rate-limits.json`.  Atomic write (tmp + rename,
POSIX-atomic).  In-memory mirror for sub-millisecond reads.  The file contains
**no credentials** — only parsed numeric values and RFC 3339 / duration
timestamps.

**`src/core/fabric/rate-limit-probe.ts`** — The post-dispatch probe for the
claude cli-agent path.

Key properties:
- Uses `node:https` only (zero new dependencies).
- Reads key via `resolveProviderKey('ANTHROPIC_API_KEY', cfg)` — phantom vault
  first.  Key value is passed only as an `Authorization` header on the wire;
  never written to disk, env, or logs.
- 60-second debounce per backend — at most one probe per minute.
- On any network error, times out in 5s and exits silently.
- Skips silently when key is absent (subscription-only setups are unaffected).

### 3.4 Changes to Existing Files

**`src/core/run/provider-client.ts`** — Add `extractAndStoreRateLimitHeaders()`
call inside `buildOpenAICompatibleClient`'s fetch wrapper, after response
headers are available and before the body is consumed.  This is a pure additive
change — no behavior change on any existing path.

**`src/core/run/engines.ts`** — In `spawnEngineInner`, after `settle(ok:true)`
for the claude engine, fire `setImmediate(() => probe(...).catch(() => {}))`.
The probe is fire-and-forget; it never delays or fails the dispatch result.

**`src/core/fabric/resource-monitor.ts`** — In `senseClaudeState()` and
`senseNimState()`, add a live-snapshot read at the top:

```typescript
const snap = getSnapshot(backend);
if (snap && Date.now() - snap.capturedAt < 90_000) {  // 90s freshness
  // Derive usedPct from inputTokensRemaining vs inputTokensLimit (Anthropic)
  // or rlRemainingTokens vs rlLimitTokens (OpenAI-compat)
  // Map to availability using existing thresholds (protectPct)
  return buildStateFromSnapshot(snap, rcfg);
}
// Fall through to existing heuristic (stats-cache.json / 'open' default)
```

**Staleness policy:** snapshots older than 90 seconds fall back to the existing
heuristic.  Under normal fleet load the store stays fresh — every dispatch
updates it.  Under idle conditions, the first real dispatch after the 90s
window fires the probe (claude) or updates the store directly (api-model) and
the snapshot is current within one round-trip.

### 3.5 Phantom Safety

- `storeSnapshot()` stores only numeric remaining/limit values and timestamps.
  No API keys, no org identifiers, no auth tokens.
- `rate-limits.json` can be read by any process on the machine without
  leaking credentials.
- The probe's key is in-process only — the value flows from
  `resolveProviderKey()` into a `node:https.request` Authorization header and
  nowhere else.  `CRED_ENV_DENY` is not relevant here (in-process, not a
  subprocess), but the same phantom discipline applies: never log, never
  serialize.
- The `raw` field on internal snapshots is dev-only and must never be written
  to the store file.

---

## 4. Unified Internal Data Layer

### 4.1 What Exists (Scattered)

The codebase already produces all the data needed for elite decisions — it is
just spread across independent subsystems with no common query surface:

| Store | File | Key Signal |
|---|---|---|
| Session transcripts | `~/.claude/projects/**/*.jsonl` | tokensIn/Out, model, cacheRead/Write, project |
| Activity rollup | computed in `rollup.ts` | byProject, byDay, byModel, cacheHitRate, estCostUsd |
| Forecast | `forecast.ts` | spentUsd, localSavingsUsd, projectedMonthlyUsd |
| Usage windows | `limits.ts` | 5h + 24h rolling windows per provider |
| Fleet quota ledger | `~/.ashlr/fleet/quota.json` | dispatch counts per backend per window |
| Subscription usage | in-memory + `shared-store.ts` | usedPercent, resetsAt (codex only) |
| Rate-limit store | `~/.ashlr/fleet/rate-limits.json` (new, §3) | live remaining/limit per backend |
| Decisions ledger | `~/.ashlr/decisions/YYYY-MM-DD.jsonl` | every routing decision, secret-scrubbed |
| Judge traces | `~/.ashlr/judge-traces/YYYY-MM-DD.jsonl` | verdict, scores, outcome link |
| Judge calibration | computed in `judge-calibration.ts` | cohenKappa, darkCurrent, degradation rate |
| Worked ledger | `~/.ashlr/fleet/worked.json` | per-item outcome (diff/empty/judged-*) |
| Quality metrics | computed in `quality-metrics.ts` | successRate, mergeRate, trivialRate, per-engine |
| Genome | `~/.ashlr/genome/hub.jsonl` + project `.ashlrcode/genome/` | knowledge entries, health |
| Swarm runs | `~/.ashlr/swarms/*.json` | tasks, successRate, tokens, cost |
| Reflection report | computed in `reflect.ts` | successRate, avgCostUsd, localShare, failureModes, WoW delta |
| Ecosystem index | `docs/ecosystem-index.json` | 21-repo inventory, profile coverage, capabilities + composition bets |
| Stats cache | `~/.claude/stats-cache.json` | claude message counts (7d) |
| Codex sessions | `~/.codex/sessions/*.jsonl` | usedPercent, windowMinutes, resetsAt |
| Savings stats | `~/.ashlr/stats.json` | fleet-wide token/cost savings |

### 4.2 The Unified Data Layer

**`src/core/data-layer/index.ts`** — A single zero-dependency, local-first
TypeScript module that exposes one composable query interface over all existing
stores.  It is a **read-only JOIN surface** — it adds no new persistence of its
own and never calls any external API.

```typescript
export interface DataLayerSnapshot {
  ts: string;                          // snapshot ISO timestamp
  cost: ActivityRollup;                // rollup.ts — tokens/cost/cacheHitRate
  forecast: CostForecast;              // forecast.ts — spent, localSavings, projectedMonthly
  limits: UsageWindowsResult;          // limits.ts — 5h/24h windows + provider status
  resources: ResourceSnapshot;         // resource-monitor.ts — per-backend availability
  quality: QualityMetrics;             // quality-metrics.ts — successRate, mergeRate, trend
  reflection: ReflectionReport;        // reflect.ts — outcomes, failure modes, WoW delta
  decisions: DecisionEntry[];          // decisions-ledger.ts — recent N (default 200)
  judgeTraces: JudgeTrace[];           // judge-trace.ts — recent N with outcomes (default 200)
  genome: GenomeHealth;                // genome/store.ts — hub-only health (fast path)
  velocityByRepo: ProjectActivity[];   // rollup.byProject — commits + tokens + cost
  rateLimits: RateLimitSnapshot[];     // rate-limit-store.ts — all backend snapshots
}

export async function queryDataLayer(
  cfg: AshlrConfig,
  opts?: {
    window?: '1d' | '7d' | '30d';
    project?: string;
    slices?: Array<keyof DataLayerSnapshot>;  // request only needed slices
    maxDecisions?: number;
    maxTraces?: number;
  }
): Promise<DataLayerSnapshot>
```

Design invariants:
- **Zero new persistence.** Every store already exists — this is a read-only
  JOIN.
- **Never-throw contract.** Each sub-query mirrors the never-throw pattern of
  its source module.
- **Phantom-safe.** No API key values are ever read or returned.  The
  `limits.ts` provider entries show `'api-key active'` status but the key
  value is never included in any `DataLayerSnapshot` field.
- **Lazy + cached.** All slices are computed in parallel (`Promise.all`) and
  memoized with per-slice TTLs (30s for resource state, 5min for rollups).
- **Fast genome path.** The genome slice calls `genomeHubHealth()` (hub-only,
  no portfolio filesystem walk) — identical to the fast path already used by
  `buildReflection()`.
- **Bounded JSONL scans.** Decisions and judge-traces default to a 7-day
  window; full 30-day is an explicit opt-in.  The `maxDecisions=200`,
  `maxTraces=200` defaults bound memory regardless of fleet age.

### 4.3 The Data Flywheel (Write Path)

**`src/core/data-layer/history.ts`** — After each sandboxed dispatch
completes, `appendDataPoint()` writes one record to
`~/.ashlr/data-layer/history.jsonl`:

```typescript
interface DataPoint {
  ts: string;            // ISO
  backend: EngineId;
  tier: EngineTier;
  model: string;
  itemSource: string;    // 'pr-review' | 'issue' | 'escalation' | ...
  effortBand: number;    // 1-5
  goalCategory: string;  // classifyGoal() output
  outcome: string;       // 'diff' | 'empty' | 'judged-review' | 'judged-merge' | ...
  tokensIn: number;
  tokensOut: number;
  cacheHitRate: number;  // 0–1
  wallMs: number;        // dispatch wall-clock time — the missing p50LatencyMs input
  retryCount: number;    // escalations/retries before final outcome
  totalCostUsd: number;  // full cost including retries
}
```

Bounded to MAX_EVENTS=2000 (same pattern as `worked-ledger.ts` and
`quota.ts`).  The flywheel closes when:

1. Every dispatch appends a `DataPoint` (write path, `sandboxed-engine.ts`).
2. `learned-router.ts` reads `history.jsonl` to build cost-to-green weighted
   engine scores (§5.3).
3. `judge-calibration.ts` reads judge-traces to detect `darkCurrent` drift.
4. `prompt-optimizer.ts` reads `reflection.topFailureModes` to target prompt
   rewrites.
5. `resource-monitor.ts` reads backoff history + outcome history to predict
   saturation before it hits (§5.4).

The `wallMs` field in `DataPoint` is the only new piece of data.  It fills the
`p50LatencyMs: null` gap in `BackendResourceState` — latency-weighted routing
becomes possible once 50+ data points exist per backend.

---

## 5. Creative Capabilities Unlocked

### 5.1 Subscription Cap Forecasting — "Hours Until Claude Hits Its Weekly Cap"

**Problem:** Claude Pro/Max hard weekly message cap is not API-accessible.
`sumClaudeMessages7d()` in `resource-monitor.ts` already reads
`~/.claude/stats-cache.json` and computes a `usedPct` estimate — but it has no
reset time and no forward projection.

**Implementation** — `src/core/data-layer/cap-forecast.ts`:

```typescript
export function forecastCapHit(
  cfg: AshlrConfig
): { hoursUntilCap: number | null; confidence: 'high' | 'low' | 'none' }
```

Algorithm:
1. Read `sumClaudeMessages7d()` → `used`.
2. Read `cfg.foundry.limits.claude.weeklyMessageCap` → `cap`. If absent,
   return `{ hoursUntilCap: null, confidence: 'none' }` — never fabricate a limit.
3. Compute `dailyRate = used / daysElapsed` from `rollup.byDay`.
4. `hoursUntilCap = ((cap - used) / dailyRate) * 24`.
5. Return confidence `'high'` when dailyRate is stable (< 30% CV over last 3
   days), `'low'` otherwise.

Surface as a new `capForecast` field on `BackendResourceState` for claude.  The
gateway uses it to pre-emptively throttle fleet dispatch when
`hoursUntilCap < 4` (configurable threshold).

**Degradation:** when `weeklyMessageCap` is not configured, the forecast
returns `null` and no behavioral change occurs — the existing stats-cache
heuristic remains the sole signal.

### 5.2 Predictive Cache Pre-Warming

**Problem:** `cacheHitRate` per model per day is already computed in `rollup.ts`
but is purely backward-looking.  When the fleet starts work on a repo with a
cold cache, every call pays the full cache-miss penalty.

**Implementation** — `src/core/data-layer/context.ts`:

Before dispatching any WorkItem, check whether the target repo's genome summary
is loaded.  If `cacheHitRate` for this model is below a threshold (default
0.30) for this repo over the last 24h, pre-warm by constructing a minimal
system prompt containing:

1. The repo's genome summary (title+tags only, not full text — stays within
   ~500 tokens).
2. The CLAUDE.md for the repo (if present).

The pre-warm is a fire-and-forget background call to the api-model endpoint
that sets `max_tokens: 1`.  Cost: one cache-write (typically < $0.001 for a
500-token context).  Benefit: all subsequent calls to the same repo in the
same session hit the cache at the full input-token price reduction.

Gate: only run when `cfg.foundry.predictiveCachePrewarm === true` (opt-in,
default off until validated by the flywheel data).

### 5.3 Cost-to-Green Routing

**Problem:** `learned-router.ts` scores engines on `verifiedSuccessRate` but
not on the total cost including retries, escalations, and empty runs.  An
engine that succeeds 80% of the time but requires 2 retries per success is
worse in real terms than one that succeeds 70% of the time on the first try.

**Implementation** — extend `buildEngineScores()` in `learned-router.ts`:

```typescript
// For each (itemSource, effortBand, goalCategory) bucket with >= 50 samples
// in history.jsonl, compute median totalCostUsd across all attempts.
// Weight engine score as:
//   score = verifiedSuccessRate * 0.6 + (1 / medianCostToGreen) * 0.4
// (normalized so both terms contribute meaningfully)
```

Data source: `queryHistory({ effortBand, goalCategory })` from
`data-layer/history.ts`.  50-sample minimum prevents overfitting on sparse
data; below the threshold, the existing `verifiedSuccessRate`-only score is
used unchanged.

### 5.4 Anomaly Detection — Automated Regression Sentinel

**Problem:** `regression-sentinel.ts` exists but its output is not surfaced in
any unified query — it is dead code from the gateway's perspective.

**Implementation** — `src/core/data-layer/anomaly.ts`:

```typescript
export interface AnomalyReport {
  severity: 'warn' | 'critical';
  dimension: 'cacheHitRate' | 'mergeRate' | 'emptyRate';
  current: number;
  baseline: number;
  delta: number;
  description: string;
}

export function detectAnomalies(
  snapshot: DataLayerSnapshot,
  baseline: DataLayerSnapshot,
): AnomalyReport[]
```

Triggers:
- `cacheHitRate` drops > 20 percentage points from 30d baseline → `warn`.
  Indicates a new context-breaking change (model update, new CLAUDE.md, etc.).
- `mergeRate` drops > 15 percentage points → `critical`.
  Indicates judge calibration drift (`darkCurrent` has shifted).
- Empty-run rate spikes > 30 percentage points → `warn`.
  Indicates scanner producing stale or noise items.

Surface as `snapshot.anomalies: AnomalyReport[]` on `DataLayerSnapshot`.  The
gateway logs anomalies on every `decide()` call when the gateway flag is on.

### 5.5 Agent Context Enrichment from Ecosystem Index

**Problem:** when an agent runs on repo X, it starts cold with no awareness of
which other repos it should reuse or avoid touching.

**Implementation** — `getFabricContext()` in `src/core/data-layer/context.ts`:

Before each dispatch, inject a ~3-paragraph `FabricContext` block into the
system prompt:

1. The repo's genome summary (title + tags — genome hub ONLY, no disk walk).
2. Top-2 ecosystem composition bets involving this repo from
   `docs/ecosystem-index.json`.
3. Last 3 routing decisions for this repo from the decisions ledger.

Total injection: ~500 tokens.  This eliminates the most common reinvention
mistakes (re-implementing something already in a sibling repo) and grounds the
agent in the fleet's recent decision history.

Gate: behind `cfg.foundry.fabricContextInjection` (default off, opt-in).

### 5.6 The Data Flywheel Closes Here

When all five capabilities are active, every run improves the next:

```
Dispatch → DataPoint appended to history.jsonl
  │
  ├─► learned-router: cost-to-green scores updated (§5.3)
  ├─► judge-calibration: darkCurrent drift detected (§5.4)
  ├─► prompt-optimizer: failure mode clusters drive prompt rewrites
  ├─► resource-monitor: backoff + latency data improves p50LatencyMs
  └─► cap-forecast: daily rate estimate tightens (§5.1)
```

Zero extra I/O beyond what already exists.  The flywheel is a better JOIN
between existing append-only stores.

---

## 6. MVP — What to Wire First and Phased Roadmap

### 6.1 MVP (M262–M265) — Real Headroom in Four Changes

The highest-leverage, lowest-risk sequence:

**M262 — `rate-limit-store.ts` + header capture in `provider-client.ts`**

Add `extractAndStoreRateLimitHeaders()` to `buildOpenAICompatibleClient`'s
fetch wrapper.  Add `storeSnapshot()` / `getSnapshot()` in new
`rate-limit-store.ts`.  Atomic persist to
`~/.ashlr/fleet/rate-limits.json`.  No behavior change — just starts
accumulating data.

Acceptance: after one NIM / Kimi / OpenAI-compat dispatch, `rate-limits.json`
contains a snapshot with non-null `rlRemainingTokens` and a valid reset string.

**M263 — ResourceMonitor reads live snapshots for NIM and OpenAI-compat**

In `senseNimState()`, replace the hardcoded `availability:'open'` with a
`getSnapshot('nim')` read (90s freshness guard).  Apply the same pattern to
any OpenAI-compat backend.  When snapshot is fresh, derive `availability` and
`usedPct` from `rlRemainingTokens / rlLimitTokens`.  When stale, fall through
to the existing default.

Acceptance: after a NIM dispatch, the dashboard shows real token headroom for
NIM rather than "open".

**M264 — Post-dispatch probe for the claude cli-agent path**

Add `rate-limit-probe.ts`.  Wire `setImmediate` probe call into
`spawnEngineInner` after settle for the claude engine.  ResourceMonitor
`senseClaudeState()` prefers the live snapshot when fresh.

Acceptance: after one claude dispatch (with `ANTHROPIC_API_KEY` set),
`rate-limits.json` contains a claude snapshot with `inputTokensRemaining` and
`inputTokensResetAt`.  ResourceMonitor returns real `usedPct` instead of the
stats-cache heuristic.

**M265 — `DataLayerSnapshot` type + `queryDataLayer()` stub**

Define `DataLayerSnapshot` and wire `queryDataLayer()` to call all existing
sub-systems in parallel.  No new computation — just the JOIN surface.  Expose
via `ashlr dashboard` and the Pulse export.

Acceptance: `queryDataLayer(cfg, { slices: ['cost', 'resources', 'quality'] })`
returns a well-typed snapshot in < 500ms.

### 6.2 Phase 2 (M266–M269) — Data Flywheel

**M266 — `history.ts` + `appendDataPoint()` wired into `sandboxed-engine.ts`**

Every `runEngineSandboxed` and `runApiModelSandboxed` completion appends a
`DataPoint` to `~/.ashlr/data-layer/history.jsonl`.  Bounded at 2000 events.
Adds `wallMs` to the output of `spawnEngineInner` (using `Date.now()` before and
after the subprocess wait).

**M267 — `cap-forecast.ts` — subscription cap forecasting**

`forecastCapHit()` + surface `hoursUntilCap` in `BackendResourceState` for
claude.  Gateway pre-throttles at `hoursUntilCap < 4`.

**M268 — Cost-to-green routing in `learned-router.ts`**

Extend `buildEngineScores()` to query `history.jsonl` for per-bucket median
total cost.  Gate behind 50-sample minimum.

**M269 — `anomaly.ts` wired into `DataLayerSnapshot`**

`detectAnomalies()` comparing last 24h snapshot vs 30d baseline.  Surface in
gateway logs and dashboard.

### 6.3 Phase 3 (M270–M273) — Enrichment and Forecasting

**M270 — Anthropic historical usage via Admin API**

`fetchAnthropicDailyUsage()` polled daily (background, non-blocking).  Writes
per-model per-day token totals to `history.jsonl` to supplement per-dispatch
records.  Only active when `ANTHROPIC_ADMIN_KEY` is present in phantom vault.

**M271 — OpenAI historical usage via org-level key**

`fetchOpenAIDailyUsage()` polled daily.  Same pattern as M270.

**M272 — Agent context enrichment (`getFabricContext()`)**

System prompt injection of genome summary + ecosystem bets + recent decisions.
Gate: `cfg.foundry.fabricContextInjection`.

**M273 — Predictive cache pre-warming**

Background pre-warm for repos with `cacheHitRate < 0.30` in the last 24h.
Gate: `cfg.foundry.predictiveCachePrewarm`.

### 6.4 Phase 4 (M274+) — Latency + Multi-Machine

**M274 — p50LatencyMs wired from `history.jsonl`**

`BackendResourceState.p50LatencyMs` is populated from the median `wallMs`
over the last 20 dispatches for each backend.  Enables latency-weighted routing.

**M275 — NIM credit depletion alert**

On HTTP 402 from NIM, record a `DataPoint` with `outcome: 'credits-exhausted'`
and surface a human-visible warning with the NGC dashboard URL.

**M276 — SharedStore cross-machine rate-limit sync**

When `cfg.fleet.sharedQueue.mode === 'filesystem'`, write the rate-limit store
to the shared path so all machines share the same headroom view.  Prevents
multiple machines from simultaneously approaching a quota ceiling.

---

## 7. Safety and Privacy

### 7.1 Phantom Vault — No Secret Leakage

All credential resolution goes through `resolveProviderKey(envKey, cfg)` in
`src/core/integrations/secrets.ts`.  The phantom vault is checked first when
`cfg.phantom.enabled` is true and `phantom` is installed; `process.env` is the
fallback.

Rules that apply to every new data-acquisition path:

1. **Never write a key to disk.** `rate-limits.json`, `history.jsonl`,
   `decisions/`, `judge-traces/` — none of these files ever contain a key
   value or any auth token.
2. **Never log a key.** The `raw` field on internal `RateLimitSnapshot`
   objects is dev-only (`{}` in production) and is never written to the store.
3. **Never pass a key to a subprocess.** The probe in `rate-limit-probe.ts`
   runs in-process using `node:https.request` — the key is used only as an
   Authorization header value on the wire.  `CRED_ENV_DENY` in the subprocess
   env builder (`buildContainedEnv`) already strips credential-shaped vars from
   all CLI-agent subprocess environments; the probe is in-process so this guard
   is not relevant, but the discipline applies equally.
4. **Treat the Admin API key as a production secret.** `ANTHROPIC_ADMIN_KEY`
   has org-wide read access to usage and cost data.  It is stored in the phantom
   vault only, never in `.env` files committed to source control.  It is
   distinct from `ANTHROPIC_API_KEY` and from `CLAUDE_CODE_OAUTH_TOKEN`.

### 7.2 No Data to Untrusted Endpoints

The data layer makes no outbound calls to any third-party analytics service,
telemetry endpoint, or logging aggregator.  All data flows:

- **Inbound:** official provider APIs (Anthropic, OpenAI) using keys already
  held by the user.
- **Local:** filesystem reads/writes under `~/.ashlr/` and `~/.claude/`.
- **No outbound telemetry.** The `DataLayerSnapshot` is never sent anywhere —
  it is a local query surface only.

### 7.3 Safety-Preserving Degradation

Every new data-acquisition path follows the existing never-throw pattern:

- Missing credential → skip probe silently, fall back to heuristic.
- Network error → ignore, return stale or unknown state.
- Malformed response → log at debug level, return null.
- Stale snapshot (> 90s) → treat as unknown (permissive), not exhausted.

The last point is important: a stale snapshot showing near-exhaustion
MUST NOT cause a backend to be permanently demoted.  Staleness implies the
token bucket has been refilling — the safe default is permissive, not blocking.

---

## 8. What Is Genuinely Not Obtainable and the Best Proxy

| Gap | Best Proxy | Notes |
|---|---|---|
| **Anthropic Pro/Max weekly message cap** | User-configured `cfg.foundry.limits.claude.weeklyMessageCap` + linear extrapolation from `sumClaudeMessages7d()` | Never fabricate a limit. If not configured, return `hoursUntilCap: null`. |
| **Anthropic monthly spend cap** | Poll `cost_report` daily, alert when cumulative cost > 80% of known tier cap ($500 Start / $1k Build / $200k Scale) | Tier cap must be manually configured or hardcoded per known tier names. |
| **OpenAI configured RPM/TPM tier caps** | Capture `x-ratelimit-limit-requests` and `x-ratelimit-limit-tokens` values from the first successful response; persist in the rate-limit store as the "configured limit" | These live values are authoritative — they reflect what the account is actually provisioned for, not a docs-table guess. |
| **OpenAI RPD/TPD per-day limit enforcement** | Poll `/v1/organization/usage/completions` with `bucket_width=1d`; alert when today's count approaches yesterday's max | A 429 from RPD exhaustion is header-identical to an RPM 429 — the only way to distinguish is pre-emptive daily usage tracking. |
| **NVIDIA NIM rate-limit headers** | HTTP 402 (credits exhausted) + HTTP 429 (throttled) status codes only | No proxy for per-minute headroom exists. Fleet strategy: treat NIM as "open until 402", demote on 402, surface a dashboard-check warning. |
| **NVIDIA NIM usage / credit balance** | None — NGC dashboard only | Do not build automated budget enforcement on NIM. |
| **claude cli-agent rate-limit headers** | Post-dispatch probe POST with `max_tokens=1` (~$0.000003, 60s debounce) OR wire claude as api-model engine | Probe requires `ANTHROPIC_API_KEY`. Without it, stats-cache.json message count remains the only signal. |
| **p50LatencyMs per backend** | Median `wallMs` from `history.jsonl` over last 20 dispatches | Not available until M266 (`appendDataPoint`) is shipped. Until then, `p50LatencyMs` remains null in `BackendResourceState`. |
| **Per-item actual wall-clock execution time** | `Date.now()` before/after `spawnEngineInner` await, stored as `wallMs` in `DataPoint` | Not stored today — M266 adds this. |
| **Cache pre-warming effectiveness** | Per-repo `cacheHitRate` trend from `rollup.byModel` — compare pre/post pre-warm sessions | No prospective cache-miss predictor exists yet; historical hit rate is the best available signal. |
| **Cross-repo runtime dependency graph** | `docs/ecosystem-index.json` (static, updated per-release) | Runtime topology changes (new imports, new API calls) are not detected automatically. |
| **Codex real-time rate limits within a run** | Last session file `rate_limits` fields — reflect state after last completed turn | Lag is acceptable under fleet load; under single-session mode the data may be minutes old. Use file mtime as the freshness guard, not `capturedAt`. |
