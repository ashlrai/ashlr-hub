# Ashlr Verse — real account telemetry (verified on this machine, 2026-09-19)

The V2 Usage section was specced to render Claude and Grok as "unknown". That was wrong: the
load-balancer layer already probes every provider, and the data is rich, free, and fast. This
document records what was verified by hand, so the UI can show the truth instead of a shrug.

Everything below costs **$0 and 0 model tokens**. None of it spends paid quota.

## Claude — `claude ... --output-format json -p /usage` (376ms, $0, 0 tokens)

The `result` string is human prose and must be parsed. Verified shape:

```
Current session: 47% used · resets Sep 20 at 2:30am (America/New_York)
Current week (all models): 58% used · resets Sep 25 at 7pm (America/New_York)
Current week (Fable): 100% used · resets Sep 25 at 7pm (America/New_York)

Last 24h · 3958 requests · 33 sessions
  99% of your usage came from subagent-heavy sessions
  68% of your usage was at >150k context
  67% of your usage came from sessions active for 8+ hours
  Top subagents: general-purpose 47%, workflow-subagent 17%, …
  Top plugins: feature-dev 1%
  Top MCP servers: Claude Browser 5%, claude-in-chrome 2%, …
```

So Claude yields **three independent windows** — rolling session, weekly all-models, and weekly
per-model — each with a used percent and a reset time, plus a 24h/7d attribution breakdown with
request and session counts. The per-model weekly window is the one that actually bites (Fable at
100% while all-models sits at 58%), so the UI must show all three, not a single number.

Parse defensively: the label set can change, percentages may be absent, and reset times are local
strings. Anything unparsed degrades to unknown for that window only, never for the account.

## Codex — rate-limit rows in the account's session JSONL ($0, instant)

Last `rate_limit` row of the newest `rollout-*.jsonl` under that account's `CODEX_HOME`:

```json
{ "limit_id": "codex", "primary": { "used_percent": 100.0, "window_minutes": 10080,
  "resets_at": 1790394416 }, "secondary": null,
  "credits": { "has_credits": true, "unlimited": false, "balance": "2048.4196250000" },
  "plan_type": "pro" }
```

Note **credits are separate from the window**: the weekly window can read 100% used while a credit
balance remains spendable. Showing only the percentage would tell Mason he is blocked when he is not.
Render window and credits as two distinct facts.

Caveat found: `~/.ashlr/native-profiles/codex-{a,b}/native-state/sessions/` is **empty** — the pinned
per-account profiles have no session history yet, so session-file parsing yields nothing for them
today. Per-account Codex numbers must come from the live App Server probe
(`codex app-server` → account/read + quota, as `src/core/resources/codex-account-probe.ts` does),
with session-file parsing as the fallback for the default profile.

## Grok — probe exists; **the account is currently signed out**

`grok models` through the pinned `grok-a` launcher returns "You are not authenticated" (it does read
the pinned `GROK_HOME` — it reports default model `grok-4.6` where the unpinned home reports
`grok-4.5`). So the correct UI state for Grok today is **"signed out — reconnect"**, with the exact
command to fix it, not "unknown" and not a zero meter. Once authenticated,
`src/core/resources/grok-account-probe.ts` returns windows matching
`/^grok_(?:credits|unified|build)(?:_weekly|_monthly)?$/`.

## Local models — Ollama HTTP, all free

- `GET /api/tags` — installed models.
- `GET /api/show` — per model: `details.parameter_size` (e.g. "79.7B"), `details.quantization_level`
  ("Q4_K_M"), `details.family`, `model_info["<arch>.context_length"]` (e.g. 262144 native) and
  `capabilities` (e.g. `["completion","tools"]`). Tool capability matters: a model without `tools`
  cannot drive an agentic session, and the seat picker should say so rather than failing at turn time.
- `GET /api/ps` — what is resident right now: name, size, `size_vram`, processor split, context, and
  expiry. Currently `{"models":[]}` (nothing loaded).
- Machine budget: 128 GB unified memory. A model's resident size against that budget is the honest
  "can I run this now" signal, and it is the local analogue of a subscription meter.

## What the UI must therefore show per account

| Account | Availability signal | Headline | Secondary |
|---|---|---|---|
| Claude | three windows, all real | the *binding* window (highest used %) | the other two + reset times + attribution |
| Codex ×2 | window % + credits + plan | window % with reset | credit balance, plan tier |
| Grok | auth state | "signed out — reconnect" | how to reconnect |
| Local | resident / loadable | loaded now vs installed | params, quant, native ctx, tools support, memory fit |

Rules: never show a number the provider did not give; distinguish *no signal* from *zero*; show the
binding constraint first, because "which account can I actually use right now" is the only question
this view exists to answer.

---

# Implementation plan (V2.1) — verified against source

## Root cause of "everything reads unknown"

`src/core/verse/seats.ts` reads `<accountsRoot>/observations.json`. That file is an **operator-seeded
baseline that nothing in this repo ever writes** — Mason's is `[]`, untouched since the pool was
created. The live data lives one directory down under a different name:
`~/.ashlr/account-connections/ledger/.resource-quota-shared-evidence.json`. Wrong directory and wrong
file, so seats always saw an empty map. Fixing the path is necessary but not sufficient: that evidence
file covers **Codex quota workers only**, carries a **5-second TTL**, and is rejected unless a
collector is currently running. Mason's is stale (`state: "closed"`, published 2026-09-13).

## The seam — `ashlr verse` owns the collectors

`ResourceConnectionMonitor` keeps its results **in memory only** and is served solely by the separate
resource-console process. So the only way to get Claude windows and Grok billing into Verse is for the
Verse server to run the collectors itself.

Implement option **(c)**: on startup, `ashlr verse` acquires
`acquireResourceQuotaRefreshLease(<accountsRoot>/ledger, …)` and instantiates
`createResourceConnectionMonitor` (all four accounts) plus `createResourceQuotaRefresher` (Codex
workers), wiring `onChange` to `publishSharedQuotaEvidence` so the evidence file stays fresh.

Constraints that are not optional:
- **The lock is exclusive per root and shared by both collectors** (`quota-refresh-lease.ts`). If
  `ashlr resource-console` holds it, acquisition fails with `collector-owned`. Handle that by falling
  back to **read-only** `readSharedQuotaEvidence` and surfacing a plain banner saying another collector
  owns the data, rather than crashing or silently showing nothing.
- **Release the lease on shutdown**, and note that `ResourceConnectionMonitor.close()` *throws* if any
  sample ended `uncertain` — catch it, log it, and still exit cleanly.
- `createNativeMetadataCoordinator` caps concurrency at **2**; do not raise it.
- Cost per 30s cycle is ~9–10 short-lived process spawns and **zero tokens or paid quota**. Make the
  poll interval configurable and default it to the existing 30s; pause polling entirely when no client
  has requested usage for several minutes, so a backgrounded app is not spawning processes forever.
- `~/.ashlr/account-connections/console-startup.json` holds **live bearer tokens**. It must never be
  read into, logged in, or serialized onto any API payload.

## Per-provider truth to render

- **Claude**: `probeClaudeAccountUsage` yields windows `five_hour`, `seven_day`, and per-model
  `seven_day_{sonnet,opus,fable}`. `resetsAt` is **structurally always null**; the human reset string
  lives in `nativeReport.resetDescription` and must be rendered verbatim, never turned into a
  countdown. `health` is always `unknown` for Claude by construction — do not render that as a fault.
  The probe is **version-pinned to Claude Code `2.1.257`** and fails closed on any other version;
  when it reports `usage-version-unsupported`, say exactly that and name the pin, because the fix is
  a one-line constant bump and a silent "unknown" would hide it.
- **Codex** (×2 accounts): window percent plus `credits.balance` and `plan_type`. Credits are
  independent of the window — a 100%-used weekly window with a spendable balance is not "blocked".
  A provider `rateLimitReachedType` is written as the **sentinel 100**, not a measurement; label it
  "limit reached", not "100% used".
- **Grok**: currently `signed-out`. Render the reconnect command. Grok is also absent from
  `frontier-usage.ts` entirely, so `/api/usage` will never carry it — it must come from the probe.
- **Local**: use `/api/ps` properly. `size_vram` vs `size` gives the GPU/CPU split, and `expires_at`
  gives the keep-alive countdown; both are already fetched in `fabric/resource-monitor.ts` and thrown
  away. Use `/api/show` `capabilities` to know whether a model supports `tools` — a model without it
  cannot drive an agentic session, and the seat picker should say so up front instead of failing at
  turn time. That also replaces the hardcoded `VERSE_LOCAL_TAG_RE` name heuristic in `seats.ts`.
  Show resident size against the machine's 128 GB as the local analogue of a quota meter.

## Token-output visualization — the data is already there

`buildRollup(window, cfg).byDay` returns `DailyUsage[]` = `{day, tokensIn, tokensOut, estCostUsd,
sessions, cacheRead?, cacheWrite?, cacheHitRate?}` and accepts `'1d' | '7d' | '30d'`. **Every current
consumer computes it and discards it** — `control.ts` keeps only totals, `frontier-usage.ts` only
`byModel`. So a 30-day series of tokens and estimated spend is one synchronous call away. Expose it
and chart it.

Honesty rules for those charts: cost is **estimated** from a static price table, not billed; Codex
`cacheRead`/`cacheWrite` are hardcoded 0 so its cache economics are not comparable to Claude's; and
`localSavingsUsd` is a flat `$3/1M tokens` heuristic with the constant inlined in `control.ts`. Label
each as an estimate where shown.
