# SPEC: Resource Control Plane (M250–M254)

**Status:** Design — not yet implemented  
**Branch target:** `feat/v5-open-fleet` (M250+ sequence, after M249 run-cache-shadow)  
**Driver:** Fleet self-routes OFF claude when weekly subscription usage is high, preserving headroom for human sessions. Never routes blindly when a cheaper/more-available backend exists.

---

## 1. Problem Statement

The fleet currently routes work using static tier logic (frontier / mid / local) plus a daily-USD budget cascade. It has no awareness of subscription-window exhaustion per backend. The real constraint Mason hits is **Claude's weekly message/token limit** — at 93% the human's interactive sessions start getting throttled, but the fleet keeps dispatching to Claude because nothing tells it to stop.

The fleet already has partial machinery:
- `quota.ts` — rolling-window dispatch-count ledger per backend
- `subscription-usage.ts` — Codex: real used% from session files; Claude: **no local signal, always null**
- `frontier-usage.ts` — aggregates both into `FrontierEngineUsage`
- `gateway.ts` (M247) — the unified routing chokepoint, flag-gated, with `subscriptionThrottle` step that calls `subscriptionAllows()`
- `recoverWithinBudget` — daily-USD cascade, not subscription-window aware

**What's missing:** a per-backend resource record that includes subscription-window headroom (estimated when not directly sensable), wired into the gateway's routing decision, with a configurable "protect N% for human sessions" policy.

---

## 2. Ground-Truth Sensability Per Backend

This section is the spec's honest foundation. Do NOT implement sensing that isn't here.

### 2.1 Claude (subscription plan — no API key)

| Signal | Sensable? | Source |
|--------|-----------|--------|
| Weekly message count (rolling 7d) | **YES — estimated** | `~/.claude/stats-cache.json` → `dailyActivity[].messageCount` — sum the last 7 days |
| Weekly token spend (rolling 7d) | **YES — real** | `usage-source.ts` reads `~/.claude/projects/<encoded>/*.jsonl`, extracts `usage` events with `input_tokens` / `output_tokens` |
| Hard weekly limit (absolute cap) | **NOT DIRECTLY EXPOSED** | Anthropic's subscription plan caps are not accessible via any public API. The code in `limits.ts` explicitly notes: "Subscription plan caps are not API-exposed." |
| Used % (the "93% weekly" in the status bar) | **NOT PROGRAMMATICALLY ACCESSIBLE** | Claude Code computes this internally. It is displayed in the TUI status bar but is not written to a local file, not exposed via `stats-cache.json`, and there is no `ccusage` tool installed on this machine. |
| 429 / rate-limit responses | **YES** | Claude CLI exits with a rate-limit error string; the fleet's retry/backoff path in `retry.ts` sees these. They are not currently surfaced as a structured signal to the router. |
| Subscription window reset time | **UNKNOWN** | Not exposed by any local file. |

**Conclusion for Claude:** The fleet cannot read Claude's true used-% or hard limit. The actionable approach is:
1. Configure a `weeklyMessageCap` in `cfg.foundry.limits.claude` (Mason sets this to, e.g., 1000/week based on his plan).
2. Derive used% by summing `stats-cache.json` `messageCount` over the rolling 7-day window — this is a COUNT of human + fleet messages combined, so it is a conservative over-estimate of fleet contribution. Acceptable for a demotion signal.
3. As a richer alternative: sum tokens from `collectUsageEvents()` over 7d, compare to a configured `weeklyTokenCap`. Token spend is already tracked per-model via `usage-source.ts` and `rollup.ts`.
4. Treat 429 responses from Claude as an immediate "exhausted" signal with exponential backoff before re-admission.

### 2.2 Codex (OpenAI subscription plan)

| Signal | Sensable? | Source |
|--------|-----------|--------|
| Primary window used% | **YES — real** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` → `token_count.rate_limits.primary.used_percent` |
| Secondary window used% | **YES — real** | Same file, `secondary.used_percent` |
| Window duration (minutes) | **YES — real** | `primary.window_minutes`, `secondary.window_minutes` |
| Reset timestamp | **YES — real** | `primary.resets_at` (Unix epoch seconds) |
| Plan type | **YES — real** | `plan_type` field in session files |
| Hard token cap (absolute) | **NOT EXPOSED** | Not in session files; not via OpenAI usage API |

**Conclusion for Codex:** Best-in-class — `readCodexRateLimits()` already extracts real used% and reset time from session files. This is the model to follow for other backends. Already wired into `subscriptionAllows()` and `subscriptionThrottle` in the gateway. **No new sensing work needed.**

### 2.3 NIM / Kimi (NVIDIA NIM API)

| Signal | Sensable? | Source |
|--------|-----------|--------|
| Per-request rate limit headers | **YES — on 429** | `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests` are standard headers returned by NVIDIA NIM on rate-limit responses |
| Daily/monthly quota | **NOT LOCALLY SENSABLE** | NIM does not expose quota state proactively; only 429 responses carry headroom info |
| Current load | **NOT SENSABLE** | NIM is a remote API; no local load signal |

**Conclusion for NIM:** Reactive sensing only. Parse rate-limit headers from 429 responses and store in the ResourceMonitor's `lastLimitSignal`. No proactive polling.

### 2.4 Local / Ollama

| Signal | Sensable? | Source |
|--------|-----------|--------|
| Server reachability | **YES** | HTTP GET `${baseUrl}/api/tags` (the Ollama health endpoint, ~10ms) |
| Active concurrent requests | **YES — approximate** | `GET /api/ps` returns running models. Non-empty = busy. |
| Absolute capacity | **CONFIGURABLE** | `OLLAMA_NUM_PARALLEL` env var; default 1 concurrent request. Can be configured in `cfg.foundry.local.maxConcurrent`. |
| Model availability | **YES** | `GET /api/tags` lists available models; cross-check against `cfg.foundry.local.model`. |
| Cost | **FREE** | Always $0.00/token. |

**Conclusion for Local:** Best availability signal of any backend. A quick `GET /api/ps` tells us if Ollama is idle or saturated. Ollama is always the fallback of last resort — the fleet should never skip it unless it is literally unreachable.

---

## 3. ResourceMonitor Design

### 3.1 Data Model

```typescript
// src/core/fabric/resource-monitor.ts

export type BackendAvailability =
  | 'available'    // within limits, no recent errors
  | 'near'         // >= warningThreshold% of configured cap
  | 'exhausted'    // >= 100% of cap OR recent 429 with no reset time
  | 'throttled'    // deliberately held back (e.g. protect headroom for human)
  | 'unreachable'  // health check failed (local only)
  | 'unknown';     // no signal available

export interface BackendResourceState {
  /** Backend engine id. */
  backend: EngineId;
  /** Availability classification. */
  availability: BackendAvailability;
  /** 0–100 estimated usage percentage. Null when unknowable. */
  usedPct: number | null;
  /** Configured hard cap (messages/tokens/requests depending on backend). */
  cap: number | null;
  /** Units for cap/used: 'messages' | 'tokens' | 'requests' | 'concurrent'. */
  capUnit: 'messages' | 'tokens' | 'requests' | 'concurrent' | null;
  /** Window label for the cap (e.g. '7d', '5h', '1d'). */
  capWindow: string | null;
  /** Unix epoch seconds when the window resets. Null when unknown. */
  resetsAt: number | null;
  /** Estimated cost per 1M output tokens (USD). 0 for local. */
  costPerMTokenOut: number;
  /** Median observed latency (ms). Null until samples exist. */
  p50LatencyMs: number | null;
  /** ISO timestamp of this snapshot. */
  snapshotAt: string;
  /** Reason string for current availability state. */
  reason: string;
  /**
   * Backoff state: set when a 429/error was received.
   * Gateway will not route to this backend until backoffUntilMs has passed.
   */
  backoffUntilMs: number | null;
}

export interface ResourceSnapshot {
  generatedAt: string;
  backends: BackendResourceState[];
}
```

### 3.2 Per-Backend Sensing Logic

```
getResourceState(backend, cfg): BackendResourceState

  'claude':
    1. Sum messageCount from ~/.claude/stats-cache.json over rolling 7d.
    2. Compare to cfg.foundry.limits.claude.weeklyMessageCap (if set).
    3. If no cap configured → usedPct=null, availability='unknown' but still
       check: if dispatchCount (quota.ts, 7d) is very high → 'near'.
    4. Check backoffState (set on 429): if backoffUntilMs > now → 'throttled'.
    5. Check cfg.foundry.claude.protectPct: if usedPct >= protectPct → 'throttled'
       (e.g. "protect 85% headroom for human sessions, fleet stops at 85%").
    costPerMTokenOut: 0 (subscription, no per-token billing).

  'codex':
    1. readCodexRateLimits() → primary.usedPercent, resetsAt.
    2. Already fully sensed. Map to BackendResourceState directly.
    3. Check backoff state.
    costPerMTokenOut: 0 (subscription).

  'nim':
    1. Check backoff state (set on last 429 with rate-limit headers).
    2. If backoffUntilMs > now → 'throttled', reason = 'rate-limit backoff'.
    3. Else → availability='available', usedPct=null (no proactive signal).
    costPerMTokenOut: read from cfg.foundry.nim.costPerMTokenOut or default.

  'local-coder' / 'ollama':
    1. GET ${ollamaBaseUrl}/api/ps with 2s timeout.
    2. Unreachable → 'unreachable'.
    3. ps.models.length >= cfg.foundry.local.maxConcurrent → 'near' (saturated).
    4. Else → 'available'.
    costPerMTokenOut: 0.

  'builtin':
    Always availability='available', costPerMTokenOut=0, usedPct=null.
```

### 3.3 Backoff Store

A lightweight in-memory map (not persisted — resets on process restart, which is intentional for short-lived sessions):

```typescript
// src/core/fabric/resource-monitor.ts
const backoffStore = new Map<EngineId, { until: number; reason: string }>();

export function recordBackoff(backend: EngineId, retryAfterMs: number, reason: string): void {
  backoffStore.set(backend, { until: Date.now() + retryAfterMs, reason });
}

export function clearBackoff(backend: EngineId): void {
  backoffStore.delete(backend);
}
```

Called by the fleet daemon's 429 handler. The ResourceMonitor reads `backoffStore` in `getResourceState()`.

### 3.4 Caching

`getResourceSnapshot(cfg)` caches its result for `TTL_MS` (default: 30s for Ollama health checks; 60s for stats-cache reads; always fresh for codex since `readCodexRateLimits()` is cheap). The snapshot is invalidated when `recordBackoff()` is called.

---

## 4. Resource-Aware Gateway Integration

### 4.1 Integration Point

The integration point is `src/core/fabric/gateway.ts`, specifically the `decide()` function, between **Step 2 (quota guard)** and **Step 3 (subscription throttle)**. A new **Step 2b** is inserted when the flag `cfg.foundry.fabric?.resourceAware === true`.

This is gated separately from `cfg.foundry.fabric?.gateway`. A user can run the M247 gateway without resource-aware routing, but resource-aware routing requires the gateway to be on.

### 4.2 Routing Policy

```
Step 2b — ResourceAware demote (NEW, flag-gated):

  snapshot = await getResourceSnapshot(cfg)  // cached, never throws
  state = snapshot.backends.find(b => b.backend === current.backend)

  if state.availability === 'exhausted' OR 'unreachable':
    → demote: find the next capable+available backend (see cascade below)
    → trace: { stage: 'resourceDemote', reason: `${current.backend} ${state.availability}: ${state.reason}` }

  if state.availability === 'throttled' (protect headroom):
    → demote or skip (same cascade)
    → trace: { stage: 'resourceThrottle', reason: ... }

  if state.availability === 'near' AND a cheaper alternative exists:
    → prefer the cheaper/more-available alternative
    → trace: { stage: 'resourcePrefer', reason: ... }

  else: no change.
```

**Cascade order for demotes** (capability-preserving, cost-optimizing):

```
1. Try other frontier backends in FRONTIER_PREFERENCE order
   (e.g. claude exhausted → try codex if available+not-exhausted)
2. Try mid-tier backends (nim, local-coder, kimi, hermes)
   — only when item.effort < FRONTIER_EFFORT_THRESHOLD (don't downgrade hard items)
3. For hard items (effort >= threshold) with all frontiers exhausted:
   → return { reason: 'resource-pause: all frontier backends exhausted, item requires frontier' }
   → caller queues the item for retry at next window reset
4. builtin as last resort for bulk items only
```

**Hard invariant:** A hard/escalation item (effort >= 4 or source='escalation') is NEVER silently demoted to local-coder/builtin. It is either paused (queued for retry) or routed to a non-exhausted frontier. This preserves merge authority semantics.

### 4.3 Gateway Trace Extension

`GatewayDecision` gains two new optional fields (backward-compatible):

```typescript
export interface GatewayDecision {
  // ... existing fields ...

  /**
   * M250: Resource state of the chosen backend at decision time.
   * Populated on the resource-aware flag-ON path; absent otherwise.
   */
  resourceState?: Pick<BackendResourceState, 'availability' | 'usedPct' | 'resetsAt' | 'reason'>;

  /**
   * M250: The originally-selected backend before any resource-driven demotion.
   * Populated only when a demotion occurred.
   */
  demotedFrom?: EngineId;
}
```

---

## 5. God-View Surface

### 5.1 `ashlr resources` CLI Command

New command: `src/cli/resources.ts`, registered in `src/cli/index.ts`.

```
ashlr resources [--json] [--watch]

  Show per-backend resource state: availability, used%, cap, resets-in, $/1M-out, latency.

  --json     Raw JSON (ResourceSnapshot)
  --watch    Refresh every 30s (Ctrl-C to stop)

  Output example:
    Resource Snapshot  —  14:23:07

    engine       avail       used%  cap        resets-in  $/1M-out  p50-ms
    ─────────────────────────────────────────────────────────────────────────
    claude       near        82%    1000/7d    6d 2h      $0        —
    codex        available   31%    5h win     3h 42m     $0        —
    nim          available   —      —          —          $0.42     1240ms
    local-coder  available   0/1    —          —          $0        340ms
    builtin      available   —      —          —          $0        —

    ⚠  claude at 82% of weekly cap — fleet will prefer codex/nim/local for new work.
    Run `ashlr resources --json` for machine-readable snapshot.
```

### 5.2 Dashboard Panel

In `src/core/web/control.ts` (Mission Control), add a `ResourcePanel` that calls `getResourceSnapshot(cfg)` on the `/api/status` polling interval (already exists). The panel reuses the `FrontierUsage` table with a `resourceState` column added. This is additive — the existing Frontier Usage panel becomes the Resource Control Plane panel.

### 5.3 Fleet Status Integration

`ashlr status` (existing) gains a one-line resource summary:

```
  Resources  claude:near(82%)  codex:ok(31%)  nim:ok  local:ok
```

This calls `getResourceSnapshot()` and formats each backend's availability.

---

## 6. LEAN MVP (Build This First)

The smallest slice that helps Mason today, buildable in a single session:

**M250 — ResourceMonitor core** (`src/core/fabric/resource-monitor.ts`):
- `BackendResourceState` type + `ResourceSnapshot` type
- `getResourceSnapshot(cfg)` with real sensing for:
  - Claude: sum `stats-cache.json` messages over 7d vs `cfg.foundry.limits.claude.weeklyMessageCap`
  - Codex: delegate to existing `readCodexRateLimits()` — zero new code
  - NIM: check backoff store only (no proactive sensing yet)
  - Local: `GET /api/ps` with 2s timeout
  - Builtin: always available
- `recordBackoff(backend, retryAfterMs, reason)` + `clearBackoff(backend)`
- 30s in-memory cache

**M251 — Config schema additions**:
- `cfg.foundry.limits.claude.weeklyMessageCap: number` — Mason sets this to his plan's weekly message limit
- `cfg.foundry.claude.protectPct: number` — default 85; fleet backs off when claude hits this %
- `cfg.foundry.fabric.resourceAware: boolean` — default false (flag-off)
- `cfg.foundry.local.maxConcurrent: number` — default 1

**M252 — Gateway Step 2b** (`src/core/fabric/gateway.ts`):
- Insert resource-aware demote between Step 2 and Step 3
- Only fires when `cfg.foundry.fabric?.resourceAware === true` AND `cfg.foundry.fabric?.gateway === true`
- Extend `GatewayDecision` with `resourceState` + `demotedFrom`
- Wire `recordBackoff()` call in the fleet daemon's 429/error handler (`src/core/daemon/`)

**M253 — `ashlr resources` CLI** (`src/cli/resources.ts`):
- Table view + `--json` flag
- Shows availability, used%, cap, resets-in for all configured backends
- Registered in `src/cli/index.ts`

**M254 — Fleet status integration + dashboard panel**:
- One-line resource summary in `ashlr status`
- `ResourcePanel` in Mission Control dashboard

### Activation for Mason Right Now

```jsonc
// .ashlr/config.json or ~/.ashlr/config.json
{
  "foundry": {
    "fabric": {
      "gateway": true,
      "resourceAware": true
    },
    "limits": {
      "claude": {
        "weeklyMessageCap": 2000,   // set to your plan's weekly limit
        "window": "7d"
      }
    },
    "claude": {
      "protectPct": 80              // fleet backs off at 80%, preserving 20% headroom
    }
  }
}
```

With this config: when Mason's `stats-cache.json` shows ≥ 80% of 2000 messages used in the last 7 days, the gateway demotes Claude to Codex or local-coder for all new fleet dispatches, while hard/escalation items are paused until the window resets.

---

## 7. Phased Roadmap

| Phase | Milestone | What | Effort |
|-------|-----------|------|--------|
| 1 | M250–M254 | LEAN MVP: stats-cache sensing, backoff store, gateway Step 2b, `ashlr resources` CLI | 1–2 sessions |
| 2 | M255 | Parse Claude 429 responses as structured `{ retryAfterMs, windowResetAt }` events; call `recordBackoff()` from retry handler | 0.5 session |
| 3 | M256 | NIM rate-limit header parsing on 429 → `recordBackoff()` with real retry-after | 0.5 session |
| 4 | M257 | Cross-machine ResourceSnapshot sharing via the existing `SharedStore` (M114 pattern) — multiple laptops sharing one Claude plan see each other's usage | 1 session |
| 5 | M258 | Token-based weekly cap for Claude (more accurate than message count): sum 7d tokens from `collectUsageEvents()` vs `cfg.foundry.limits.claude.weeklyTokenCap` | 0.5 session |
| 6 | M259 | ResourceSnapshot persisted to `~/.ashlr/fleet/resource-snapshot.json` (so cross-process / daemon restart doesn't lose backoff state entirely) | 0.5 session |
| 7 | M260 | Live Ollama load sensing: track in-flight dispatches via the quota ledger's sub-minute window; prefer local-coder when concurrency < max | 1 session |

---

## 8. Safety Invariants

These constraints are NEVER relaxed by resource routing:

1. **Gate bypass is impossible.** Resource routing only changes `WHICH` backend handles an item. It never changes WHETHER a proposal passes the judge, scope-cap, or sandbox. `gateway.ts` imports no `apply/merge/push/deploy` primitive — this constraint is inherited by the ResourceMonitor.

2. **Hard items are not silently downgraded.** An item with `effort >= FRONTIER_EFFORT_THRESHOLD` (4) or `source === 'escalation'` is either routed to a non-exhausted frontier backend, or **paused** (queued for retry at window reset). It is never silently routed to `local-coder` or `builtin`, which lack merge authority.

3. **`builtin` is always available as last resort for bulk items.** The cascade never returns "no backend" for effort < 4 items — builtin (0-diff, plans only) is always the floor.

4. **Flag-off by default.** `cfg.foundry.fabric.resourceAware` defaults to `false`. The existing fleet behavior is byte-identical when this flag is off.

5. **Never throws.** `getResourceSnapshot()` follows the same never-throw contract as all other fleet data sources. Sensing failures degrade to `availability: 'unknown'` — unknown is treated as permissive (same as `subscriptionAllows`).

6. **No network calls for sensing (except Ollama health check).** Claude and Codex sensing reads local files only. The Ollama health check is localhost-only. No external API calls in the ResourceMonitor (the existing `limits.ts` API-key path is a separate system).

---

## 9. Key Design Decisions & Tradeoffs

**Why stats-cache.json for Claude message count, not token count?**  
`stats-cache.json` is the most stable file Claude Code writes — it has been present since early Claude Code versions and has a versioned schema. Token counts from `usage-source.ts` are richer but require correlating JSONL files across 593+ project directories. For MVP: stats-cache gives a fast, cheap conservative estimate. Phase 4 (M258) adds token-based sensing as an upgrade.

**Why not poll the Anthropic usage API?**  
As documented in `limits.ts`: the Anthropic API does not expose subscription plan caps or used%. The API key usage endpoint returns token counts for API-key billing only; it returns nothing useful for Pro/Max subscription plans. This is verified in the existing code — `limits.ts` leaves `limit` undefined and includes an explicit note.

**Why is the "protect headroom" threshold configurable, not hardcoded?**  
Mason's plan limit and usage pattern are personal. A developer with Max plan may be comfortable at 95%; a Pro user might want to protect at 70%. The `protectPct` config knob makes this a user-tunable policy rather than a magic number.

**Why in-memory backoff store, not persisted?**  
Fleet sessions are typically short-lived (one `ashlr loop` tick). Persisting backoff state creates stale-lock problems: if the machine loses connectivity and Ollama becomes unreachable, a persisted 1-hour backoff would prevent the fleet from using it even after the issue resolves and the process restarts. In-memory resets cleanly on restart. M259 adds optional persistence for long-running daemon processes only.

---

## 10. File Map

| File | Action | Notes |
|------|--------|-------|
| `src/core/fabric/resource-monitor.ts` | **CREATE** (M250) | ResourceMonitor, BackendResourceState, backoff store, sensing logic |
| `src/core/fabric/gateway.ts` | **EXTEND** (M252) | Add Step 2b resource-aware demote; extend GatewayDecision |
| `src/core/types.ts` | **EXTEND** (M251) | Add `weeklyMessageCap`, `protectPct`, `resourceAware`, `maxConcurrent` to config types |
| `src/cli/resources.ts` | **CREATE** (M253) | `ashlr resources` command |
| `src/cli/index.ts` | **EXTEND** (M253) | Register `resources` command loader |
| `src/cli/status.ts` | **EXTEND** (M254) | Add one-line resource summary |
| `src/core/web/control.ts` | **EXTEND** (M254) | Add ResourcePanel to Mission Control |
| `src/core/daemon/loop.ts` | **EXTEND** (M252) | Call `recordBackoff()` on 429/rate-limit errors |

---

*Generated on 2026-06-29. Do not commit — Mason commits.*
