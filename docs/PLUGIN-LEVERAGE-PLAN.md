# ashlr-plugin Leverage Maximization Plan

**Date:** 2026-06-29  
**Status:** Research complete, implementation ready  
**Scope:** How to extend ashlr-plugin's token savings from interactive-only to the full autonomous fleet + workbench

---

## Part A: How the Plugin Saves Tokens

### Core compression strategies

**1. snipCompact — head+tail truncation (ashlr__read)**

Returns head (80 lines) + tail (40 lines); replaces middle with a single elision marker showing estimated tokens saved (e.g., `[⋯ 312 lines elided · ~4,820 tokens saved ⋯]`). Token estimate uses `chars/4` heuristic. Threshold: files ≥2 KB.

Savings: 60–90% depending on file size.

**2. AST skeleton (ashlr__read, code files ≥6 KB)**

Extracts function/class signatures, type declarations, docstrings — never the bodies. Returns signatures-only "skeleton" of the file. Falls back to snipCompact on parse failure. Confidence badge attached: `high` (snipCompact), `medium` (AST), `low` (LLM summary).

Savings: 75–95%.

**3. LLM summarization (ashlr__read, files ≥16 KB)**

Calls Haiku as summarizer; attaches summary + confidence badge. Most aggressive compression.

Savings: 85–95%.

**4. Genome-aware grep (ashlr__grep)**

With `.ashlrcode/genome/` present: inverted-index lookup over pre-summarized knowledge sections + embedding similarity (cosine threshold 0.68). Returns best-K matches, not raw ripgrep output. Without genome: falls back to ripgrep + result truncation. Genome index cached at `~/.ashlr/genome-index-<repoSha>.cache`.

Savings: ~80%.

**5. Diff-format edits (ashlr__edit, ashlr__multi_edit)**

Returns only a summary + diff after edit, not the full file. Threshold: files ≥2 KB, combined edit ≥80 chars. AST-structural operations (rename, extract-function) available for TypeScript/JavaScript.

Savings: 80–95%.

**6. Hook intercept (PreToolUse/PostToolUse)**

Hooks intercept native Read/Grep/Edit/Write calls. In `redirect` mode (default v1.18+): blocks native call, returns explanation + ashlr equivalent. In `nudge` mode: soft suggestion via `additionalContext`. Throttled ≤1 nudge/60 sec. Guards: in-cwd files only, not plugin tree.

**7. Savings tracking**

`recordSaving(rawBytes, outputBytes, toolName)` in `servers/_stats.ts:L44–90`. Atomic JSON write (tempfile → fsync → rename) with lockfile + mutex. Keyed by `CLAUDE_SESSION_ID`. `ashlr__savings` renders session + lifetime totals with per-tool breakdown, 7-day sparkline, dollar estimate.

**Headline cross-repo average: −57% tokens on instrumented calls.**

---

## Part B: Where It's Leveraged vs. NOT (The Gaps)

### Where it WORKS today

| Context | Status | How |
|---------|--------|-----|
| Mason's interactive Claude Code sessions | ✅ Full | MCP registered in `~/.claude/settings.json`, hooks active |
| Orchestrator (ashlr-hub CLI, the hub process itself) | ✅ Partial | Hub process inherits Mason's MCP env; `mcp-native-engineer.ts` sees ashlr__ tools |
| ashlr__savings display | ✅ Working | `servers/savings-server.ts` reads `~/.ashlr/stats.json` |

### WHERE IT'S NOT — The Critical Gaps

**Gap 1 (biggest): Fleet sandboxed engine invocations — NO MCP**

Every autonomous fleet run spawns `claude -p "<goal>" --model <M> --output-format json --dangerously-skip-permissions --add-dir <cwd>`. No `--mcp-config` flag, no `MCP_CONFIG` env var, no `.mcp.json` written to the engine's working directory.

The engines discover MCP servers from the real `~/.claude/settings.json` (preserved HOME is passed via `buildContainedEnv()`), so IF ashlr-plugin is registered there at the user level it IS inherited. But there is no explicit wiring — it's purely accidental, not guaranteed, and not measured.

Key files:
- `src/core/run/engine-registry.ts:63–66` — claude argv spec (no `--mcp-config`)
- `src/core/run/sandboxed-engine.ts:259–298` — `buildContainedEnv()` + `withToolEnv()`
- `src/core/env-bridge.ts` — `buildToolEnv()` (no MCP vars)

**Gap 2: Fleet token compression is unmeasured**

Even when a fleet engine does use ashlr__ tools (via inherited `~/.claude/settings.json`), `recordSaving()` writes to `~/.ashlr/stats.json` under the session key `CLAUDE_SESSION_ID`. The fleet spawned process has a different session ID than Mason's interactive session. The savings are counted but siloed — they don't roll up to the lifetime counter Mason sees.

**Gap 3: Fleet's own tool usage is uncompressed**

The fleet orchestrator makes its own file reads to build engine prompts (inject context, read worktree state, build M154 context). These happen in the hub process, not via the MCP layer. They use native TS `fs.readFileSync` / direct reads — no snipCompact, no compression.

**Gap 4: Workbench engines (OpenHands/Goose/Aider) — NO MCP**

Workbench adapter invocations don't pass MCP config. These agents have their own tool ecosystems; ashlr__ compression is entirely absent.

**Gap 5: Fleet cost tracking is inference-only, not compression-aware**

`src/core/observability/forecast.ts:L60–90` computes `localSavingsUsd` = "what local tokens would cost if cloud-priced." This measures routing savings (local vs cloud), not compression savings (raw vs compact). The two are tracked in completely separate systems with no cross-link.

**Gap 6: M246 cache metrics are typed but not instrumented**

`GenAiSpan` has `cacheReadTokens`, `cacheWriteTokens`, `cacheHitRate` fields. They exist in `src/core/types.ts:2177–2193` but are not populated in any span emission path (`src/core/swarm/runner.ts:811`, `src/core/run/orchestrator.ts:726`).

---

## Part C: Wiring Plan — Prioritized, Concrete, Non-Destabilizing

### P0 — Guarantee fleet engines inherit ashlr-plugin (1–2 hours)

**What:** Explicitly write a minimal `.mcp.json` into the engine's ephemeral workspace before spawning, so the fleet's claude instances always have ashlr__ tools regardless of the user's global settings.

**Where:** `src/core/run/sandboxed-engine.ts` — in the setup block before `spawnEngine()` is called.

**How:** Before calling `spawnEngine()`, write `<worktree>/.mcp.json`:

```json
{
  "mcpServers": {
    "ashlr": {
      "command": "ashlr-mcp",
      "env": {
        "ASHLR_MCP_HOST": "ashlr-fleet-engine",
        "ASHLR_HOOK_MODE": "redirect",
        "ASHLR_SESSION_LOG": "0"
      }
    }
  }
}
```

Then pass `--mcp-config <worktree>/.mcp.json` in the claude argv (add to `autonomousArgv` in `engine-registry.ts:66`).

**Risk:** LOW. The `.mcp.json` is written to the ephemeral worktree, not the user's real home. The `--mcp-config` flag is standard claude CLI. Clean up the file after engine exit (already handled by worktree teardown).

**Guard:** Check `which ashlr-mcp` exists before writing; skip silently if not installed. This prevents breaking fleet runs in CI/CD where ashlr-plugin is not installed.

**Files to change:**
- `src/core/run/sandboxed-engine.ts` — add `writeMcpConfigIfAvailable(worktreePath)` call
- `src/core/run/engine-registry.ts:66` — add `--mcp-config` to claude's `autonomousArgv`
- `src/core/run/engines.ts` — ensure `--mcp-config` path interpolation is supported

---

### P1 — Fleet savings rollup into ashlr-plugin lifetime counter (2–4 hours)

**What:** Fleet engine runs record savings under their own session IDs. Aggregate those into a `fleet` bucket in `~/.ashlr/stats.json` so `ashlr__savings` shows Mason the full picture: interactive + fleet.

**Approach A (simpler):** Set `CLAUDE_SESSION_ID=ashlr-fleet-<runId>` in the engine's environment so savings land in the plugin's stats file under nameable keys. Then modify `_savings-render.ts` to display a `fleet` aggregate bucket separate from the interactive session bucket.

**Approach B (more accurate):** After each fleet run completes, have the hub process call `ashlr__savings --annotate-fleet --run-id <runId> --tokens-in <n> --tokens-out <n>` to write a fleet annotation directly. This avoids cross-session session-ID collisions.

Recommend Approach A first (minimal change, reversible).

**Files to change:**
- `src/core/run/sandboxed-engine.ts:259–298` — add `CLAUDE_SESSION_ID: 'ashlr-fleet-' + runId` to env
- `ashlr-plugin/servers/_savings-render.ts:74–100` — detect `ashlr-fleet-*` session keys, aggregate into fleet bucket

**Risk:** LOW for Approach A. Session IDs are only used as keys in the JSON file; adding fleet-prefixed keys doesn't break existing interactive session display.

---

### P2 — Compress fleet-internal context building (3–5 hours)

**What:** The orchestrator and swarm runner read worktree files to build engine prompts (M154 context injection). These reads use raw `fs` calls. Replace with snipCompact-equivalent logic so prompt-building doesn't balloon token counts before the engine even runs.

**Where:** 
- `src/core/run/orchestrator.ts` — context-building block (search for `readFileSync` or file-read utilities)
- `src/core/fleet/supervisor.ts` — wherever worktree state is read to build task context

**How:** Import and use the same `snipCompact(content, { head: 80, tail: 40 })` utility that ashlr-plugin uses. This utility should be extractable from `ashlr-plugin/servers/_snip.ts` into a shared package or inlined.

**Alternative:** Add an `ashlr__read` MCP call from the hub process itself during context-building. The hub already has MCP access (it runs in Mason's interactive session context).

**Risk:** MEDIUM. Context truncation could cause engines to miss relevant code sections. Mitigate by: (a) only applying to files ≥4 KB, (b) preserving a larger head (160 lines) for context injection vs the standard 80, (c) A/B testing on a subset of fleet runs first.

**Files to change:**
- `src/core/run/orchestrator.ts` — wrap file reads with snipCompact
- `src/core/fleet/supervisor.ts` — same
- Optionally: extract `snipCompact` into `src/core/utils/snip-compact.ts` (copy from plugin, keep in sync)

---

### P3 — Wire M246 cache metrics in span emission (1–2 hours)

**What:** Populate `cacheReadTokens`, `cacheWriteTokens`, `cacheHitRate` in GenAiSpan emission. These fields exist but are never set.

**Where:**
- `src/core/swarm/runner.ts:811–847` — span emit
- `src/core/run/orchestrator.ts:726–763` — span emit

**How:** The claude CLI's `--output-format json` response includes `usage` with `cache_read_input_tokens` and `cache_creation_input_tokens`. Parse these from the engine's JSON output and populate the span before emitting.

**Files to change:**
- `src/core/run/engines.ts` — parse `usage.cache_*` from claude JSON output
- `src/core/swarm/runner.ts:811` — set `span.cacheReadTokens`, `span.cacheWriteTokens`
- `src/core/run/orchestrator.ts:726` — same

**Risk:** LOW. Additive only — fields go from undefined to populated. No behavioral change.

---

### P4 — Unified savings dashboard in Pulse (4–8 hours)

**What:** Surface both compression savings (ashlr-plugin) and routing savings (fleet local-tier) in a single "Savings" tab in the Pulse dashboard.

**Data sources:**
- Compression: `~/.ashlr/stats.json` (ashlr-plugin, `lifetime.tokensSaved`)
- Routing: `src/core/observability/forecast.ts` `buildForecast()` → `localSavingsUsd`
- Cache: GenAiSpan `cacheReadTokens` after P3 above

**How:**
1. Add a `getSavingsSummary()` function in `src/core/observability/savings-summary.ts` that reads both sources and returns a unified `SavingsSummary` type.
2. Add a `/map` tab sub-panel or a `/savings` route to the Pulse dashboard (`src/cli/dashboard.ts:225`).
3. Display: interactive compression savings + fleet routing savings + cache hit savings as three separate bars with a combined total.

**Files to change:**
- New: `src/core/observability/savings-summary.ts`
- `src/cli/dashboard.ts` — add savings panel
- `docs/PULSE-BRIDGE.md` — document the new data source

**Risk:** LOW. Read-only data aggregation. No changes to save paths.

---

### P5 — Per-run token budget enforcement (future, 1–2 days)

**What:** Give each fleet run an explicit token budget. Abort or downgrade engine if budget exceeded.

**Where:**
- `src/core/fleet/quota.ts` currently tracks dispatch counts. Extend to track `tokensUsed` per repo per day.
- `src/core/governance/trust.ts` — tier-based budget: local tier gets higher budget, cloud tier lower.

**How:**
1. After each run, write `tokensIn + tokensOut` to quota ledger keyed by `(repoId, day)`.
2. Before dispatching, check `quotaLedger.tokensBudgetRemaining(repoId)`.
3. If over budget: skip or downgrade to haiku.

**Risk:** MEDIUM. Changes dispatch behavior. Requires careful calibration to avoid starving legitimate work. Gate behind `cfg.governance.tokenBudgetEnabled: false` default.

---

## Part D: Making Savings Measurable + Meaningful

### What to instrument now (cheap, high signal)

1. **Fleet session ID prefix** (P1 above): Lets you immediately see "fleet contributed X tokens saved this month" in `ashlr__savings`.

2. **Cache hit rate in spans** (P3 above): Reveals how much Anthropic prompt caching is helping fleet runs. This is free money — cache hits cost 10% of normal input tokens.

3. **Per-run token log**: After each fleet engine exits, log `{ runId, goal_hash, tokensIn, tokensOut, cacheHits, model, durationMs }` to `~/.ashlr/fleet-runs.jsonl`. This is ~200 bytes per run, negligible storage. Enables retroactive analysis.

### What the "187M lifetime" number means + how to grow it

The 187M figure is `lifetime.tokensSaved` in `~/.ashlr/stats.json` — the accumulated delta between raw file sizes and snipCompact output sizes across all interactive sessions. It's a compression-layer metric, not an inference-layer metric.

To grow it:
- P0 (fleet MCP wiring) directly adds fleet engine reads to this counter
- P1 (fleet session rollup) makes fleet contributions visible in the display
- P2 (context compression) adds pre-prompt compression to the counter

Expected impact of P0+P1+P2: If the fleet runs 50+ engine calls/day and each reads 5–10 files, fleet compression could add 2–5M tokens/day to the counter, potentially 10× the current interactive session rate.

### Dashboard metric targets (after all phases)

| Metric | Source | Target |
|--------|--------|--------|
| Interactive compression savings | `~/.ashlr/stats.json` session bucket | Existing display, unchanged |
| Fleet compression savings | `~/.ashlr/stats.json` fleet-* buckets | P1: add to `ashlr__savings` display |
| Fleet routing savings (local vs cloud) | `forecast.ts localSavingsUsd` | P4: Pulse dashboard panel |
| Cache hit savings | GenAiSpan `cacheReadTokens` | P3+P4: Pulse dashboard panel |
| Per-run token log | `~/.ashlr/fleet-runs.jsonl` | P1 side effect: retroactive analysis |
| Fleet token budget remaining | `quota.ts` extension | P5: dispatch governance |

---

## Risk Summary

| Change | Risk Level | Why Safe |
|--------|------------|----------|
| P0: Write `.mcp.json` to worktree | LOW | Ephemeral path, guarded by `which ashlr-mcp` |
| P0: Add `--mcp-config` to claude argv | LOW | Standard flag, no behavioral change if file missing |
| P1: Fleet session ID prefix | LOW | Additive key in JSON stats file |
| P1: Render fleet bucket in savings display | LOW | Read-only aggregation, existing display unchanged |
| P2: snipCompact in context building | MEDIUM | Gate behind file-size threshold; test on subset first |
| P3: Populate cache span fields | LOW | Additive only |
| P4: Savings dashboard panel | LOW | Read-only data aggregation |
| P5: Token budget enforcement | MEDIUM | Default-off; requires calibration |

**DO NOT touch:**
- `ashlr-plugin/servers/_stats.ts` — session-critical, atomic writes, any race condition breaks the counter
- `ashlr-plugin/hooks/pretooluse-edit.ts` — live MCP hook, changes affect every interactive session immediately
- `ashlr-plugin/servers/_router.ts` — MCP server entry point; restart required for any change

---

## Implementation Sequence

```
Week 1 (fast wins, zero risk):
  P0 → P3 → P1  (fleet MCP wiring, cache metrics, session rollup)

Week 2 (medium effort, measurable impact):
  P2 (context compression, gated)
  P4 (unified savings dashboard)

Week 3+ (governance layer):
  P5 (token budgets, default-off)
```

P0+P1 alone transforms the fleet from "MCP-invisible" to "MCP-measured" — that's the highest leverage change in this plan.
