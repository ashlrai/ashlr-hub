# ASHLR Agentic Inference Fabric — Definitive Architecture Specification

**Version:** F0-Draft — Foundry (v4) base  
**Branch:** `feat/v4-foundry` → target `feat/v5-open-fleet`  
**Author:** Lead Architect synthesis from three proposals + verified codebase findings

---

## 1. Vision: The Coding-Agent Work Cache Nobody Owns

Generic LLM gateways (LiteLLM, Portkey, Helicone) cache chat completions. They have no idea what the response *did* — whether the diff compiled, whether the tests passed, whether a judge ruled it safe to merge. Their caches are blind to source state. Their routers learn from human preference surveys, not from compilers.

Ashlr-hub already has something structurally unique and unreplicable: a **verified-outcome loop**. Every engine output becomes a PENDING proposal that flows through sandbox confinement, secret scrubbing, signed provenance, judge attestation, scope-cap, and tests-green before it is marked `verified` or `merged` in the decisions ledger. That verdict is ground truth — not a preference vote, a compiler verdict.

The Agentic Inference Fabric layers four compounding capabilities on top of that existing verified loop:

1. **A git-source-aware dual-layer run cache** that reuses *verified correct* prior diffs when the repo state is provably identical — skipping the entire subprocess spawn while still flowing through the same PENDING proposal gates. No other system can offer this safety guarantee because no other system has a compiler/judge on the other side.

2. **A unified routing gateway** that consolidates scattered dispatch overrides into one traceable decision object, enabling a closed-loop optimizer to improve routing from *total cost to green* (including rework), not single-call cost.

3. **An embedding-aware skill retrieval layer** on top of the existing M243 genome, replacing pure-recency tag-filtering with the generative-agents `recency × importance × relevance` triple to surface the right procedure for the current task.

4. **A self-tuning optimizer** that learns cache thresholds and routing weights from verified outcomes, writing only an advisory config overlay — never auto-applying, never bypassing a gate.

The moat is architectural: a chat gateway caches answers. The Fabric caches *verified engineering decisions* made against known source states, optimizes routing toward *verified shipping*, and retrieves *verified procedures*. The data flywheel only improves as the fleet ships more code.

---

## 2. Verified Current State

What already exists to build on, with absolute file references.

### The single engine chokepoint

`/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/run/sandboxed-engine.ts` — `runEngineSandboxed` at line 294. Every real-diff engine invocation (daemon fleet, CLI `ashlr run`, bestOfN, ashlrcode executor) funnels through this function. The cache check belongs immediately before `buildEngineCommand`/`spawnEngine` at approximately line 353. The provenance/scrub/inbox triad executes at lines 415–459 after the spawn succeeds — a cache hit must re-enter at this exact point, not bypass it.

### The routing chokepoints

- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fleet/router.ts` — `routeBackend` at line 240: the fleet-path routing entry point, called *twice* per item from `loop.ts` (lines 678 and 705).
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/run/router.ts` — `routeTask` at line 359: model-granular selection, called by `routeBackend` three times.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/daemon/loop.ts` lines 705–770: the per-item dispatch sequence that imperatively overrides `routeBackend` via quota guard, subscription throttle, M53 `recommendRoute`, and `recoverWithinBudget`.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/run/orchestrator.ts` line 1001: the CLI engine-selection block; line 1170: delegates to `runEngineSandboxed`.

### The learning systems

- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/run/learned-router.ts` — two systems coexist: M53 `recommendRoute` (line 240, fleet-tier nudge from `orchestrator.listRuns()` history); M240 `buildEngineScores`/`sortEnginesByScore` (line 583/701, ship-rate-ordered candidate resequencing from `decisions-ledger`). **Latent bug at line 122**: `tierOf` hard-codes any non-builtin engine as `frontier`, so M53's mid-nudge via `backendForTier` can never resolve a mid backend — it silently falls through to builtin.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fleet/decisions-ledger.ts` — `recordDecision` at line 69: append-only dated JSONL under `~/.ashlr/decisions/`. `DecisionEntry` (types.ts line 3639) has no `costUsd`, `tokensIn`, `tokensOut`, or `durationMs` fields — the closed loop runs on quality only, never cost or speed.

### The telemetry gap

- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/observability/rollup.ts` — `buildRollup`: `UsageEvent` carries `cacheRead`/`cacheWrite` from `usage-source.ts`, but `buildRollup` sums only `tokensIn`/`tokensOut`. Cache tokens are collected but dropped before aggregation.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/run/sandboxed-engine.ts` — `estCostUsd` is already computed at lines 402/646 but is not threaded into `recordDecision`. Wall-clock latency is an explicit stub (confirmed in `orchestrator.ts`).

### The genome and memory systems

- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/genome/store.ts` — `loadGenome`, `appendHubEntry`. Re-walks disk depth-4 + re-parses `hub.jsonl` on every call. No L1 cache. Hub entries capped at `HUB_MAX_ENTRIES=2000`/`LOAD_MAX_TOTAL=5000`.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/genome/recall.ts` — keyword TF rank + opt-in local-Ollama embedding rerank. Pure-recency sort; no task-class lookup.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fleet/skill-library.ts` — M243 `learnFromApplied`, `distillWorkflow`, `curateSkills`. Append-only, tag-keyed, no read API by task class.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fleet/self-improve.ts` — M235 `learnFromRejection`, `curateAntiPlaybooks`. Mirror of M243 for rejection lessons.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-plugin/servers/_genome-cache.ts` — 64-entry in-process LRU keyed by `genomeRoot+pattern`, manifest-mtime invalidated. The L1 analog, but plugin-side only.
- **Fragmentation gap**: M243/M235 write to `hub.jsonl` (hub-side), but the plugin's `ashlr__grep` RAG reads `knowledge/*.md` via `retrieveSectionsV2` (plugin-side). Learned skills are invisible to the interactive path.

### Core-efficiency reusable primitives

- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency/src/genome/embeddings.ts` — `generateEmbedding` (Ollama fetch, graceful null), `cosineSimilarity`, `quantizeUnified`/`dequantizeUnified`.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency/src/genome/embedding-ultrafast.ts` — `UltraFastEmbedder.embed`: zero-dep, pure-CPU FNV-1a signed feature-hash, 256-dim, sub-ms. The offline fallback.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency/src/genome/quantized-ann.ts` — `QuantizedANNSearcher`: LSH-over-quantized-buckets ANN, exhaustive fallback under `MIN_CANDIDATES`.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency/src/genome/jsonl.ts` — `appendJsonl`/`readJsonl`: the established append-only persistence layer.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency/src/genome/embedding-cache-coherence.ts` — `EmbeddingCacheMetadata`/`FreshnessResult`: freshness + hash-staleness model to copy for cache-entry invalidation.

### Pulse (the analytics plane — far ahead of hub telemetry)

- `activity_event` table (migration 0001 + 0012 + 0025): `duration_ms`, `tokens_cache_read`, `tokens_cache_5m_write`, `tokens_cache_1h_write`, `cost_usd_cents`, `fleet_event`, `fleet_outcome`.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-pulse/server/src/lib/cost-insights.ts` — LLM cost optimizer consuming `cacheHitRate`, emitting `kind:'cache_strategy'` and `kind:'model_swap'` recommendations. The feedback channel is built; the apply step back to hub is missing.

---

## 3. Architecture

Six components, all under `src/core/fabric/` in hub, each with a concrete file:symbol integration point, zero new runtime dependencies, default-off, byte-identical when off.

```
daemon/loop.ts:runTick          orchestrator.ts:runGoal (CLI)
        |                                   |
        +------- [C1] InferenceGateway.decide(item, cfg) --------+
                         |                (one decision object,   |
                         |                replaces loop.ts:705-770)|
                         v                                        |
           routeBackend (fleet/router.ts:240)                     |
           routeTask (run/router.ts:359)                          |
           quota guard / subscription throttle                    |
           [C2] cost-aware sortEnginesByScore                     |
           recommendRoute / recoverWithinBudget                   |
                         |                                        |
                         v                                        |
        sandboxed-engine.ts:runEngineSandboxed (~line 294)        |
                         |                                        |
      [C3] RunCache.lookup(key) ← git-pinned exact key            |
           hit? → git apply --check → re-scrub → re-sign          |
                 → selectInboxStore.create(PENDING)  [NO spawn]  |
           miss? → spawnEngine → scrubSecrets → signProvenance    |
                 → selectInboxStore.create(PENDING)               |
                 → RunCache.write(key, entry)  [write-through]    |
                         |                                        |
      [C4] recordDecision(+costUsd, +tokensIn, +durationMs)       |
                         |                                        |
      [C5] MemoryFabric: loadGenome L1 cache + skill-index        |
                         |                                        |
      [C6] Optimizer: rollup.ts + buildIntelligence + bandit      |
                         |                                        |
           Pulse OTLP → cost-insights recommendations             |
```

### C1: InferenceGateway (`src/core/fabric/gateway.ts`, NEW)

**Purpose.** Consolidate the scattered per-item routing overrides in `loop.ts:705–770` into one pure function that returns one traceable decision object. Does not rewrite `routeBackend` or `routeTask` — calls them in sequence, records each step.

**Integration point.** `daemon/loop.ts` replaces the double `routeBackend` call (lines 678 and 705) and the imperative override block (lines 705–770) with a single `await gateway.decide(item, liveCfg, ctx)`. The CLI path at `orchestrator.ts:1001` calls `gateway.decide({goal, repo}, cfg)` so both paths share one gateway and one cache-key computation.

**Latent bug fix (prerequisite).** `learned-router.ts:tierOf` at line 122 hard-codes any non-builtin engine as `frontier`. The gateway fixes this by resolving tier via `engineTierOf(engine, cfg)` from the engine registry (already exposed in `sandboxed-engine.ts:173`), so M53's mid-nudge can actually find and return a mid backend. This is a one-symbol fix, not a rewrite, but it unblocks M53's cost-saving nudge.

**Type contract:**

```typescript
// src/core/fabric/gateway.ts
export interface GatewayDecision {
  backend: EngineId;
  tier: EngineTier;
  model?: string;
  cacheKeyInput: CacheKeyInput;   // computed once here, passed into C3
  source: 'fleet' | 'cli';
  trace: Array<{ stage: string; backend: EngineId; tier: EngineTier; reason: string }>;
  reason: string;
}

export async function decide(
  input: WorkItem | { goal: string; repo: string },
  cfg: AshlrConfig,
  ctx: { spentUsd?: number; forecast?: CostForecast; estimate?: RunEstimate },
): Promise<GatewayDecision>
```

**Invariants.** When `cfg.foundry.fabric?.gateway !== true`, `decide` is a thin pass-through returning exactly what `routeBackend` + `recommendRoute` already return — byte-identical behavior. Output always within `cfg.foundry.allowedBackends`. Never throws; catch-all returns `{ backend: 'builtin', tier: 'local' }`. `stableHash(item.id)` FNV-1a determinism preserved (no clock/random in the decision).

---

### C2: Cost-Aware Router Enhancement (extends `src/core/run/learned-router.ts`)

**Purpose.** Close the open loop: M240 currently optimizes on ship-rate only because `DecisionEntry` carries no cost or latency. Once C4 (telemetry) provides those fields, extend `buildEngineScores`/`sortEnginesByScore` to route on total-cost-to-green, not single-call cost.

**Integration point.** `buildEngineScores` at line 583. Extend `EngineScore` with optional `costPerShipUsd` and `medianLatencyMs`, both recency-decayed with the same `2^(-age/halfLife)` weight already at line 622. Extend `sortEnginesByScore` at line 701:

```typescript
// New utility function inside learned-router.ts
function computeUtility(score: EngineScore, λCost: number, λLat: number): number {
  // λCost and λLat default 0 → byte-identical to today's pure ship-rate sort
  // Optimize on cost-to-green, not single-call cost, to avoid routing everything
  // to the weakest model and incurring expensive rework (confirmed external pitfall)
  const normCost = score.costPerShipUsd != null
    ? Math.min(score.costPerShipUsd / COST_NORM_USD, 1.0)
    : 0;
  const normLat = score.medianLatencyMs != null
    ? Math.min(score.medianLatencyMs / LAT_NORM_MS, 1.0)
    : 0;
  return score.score - λCost * normCost - λLat * normLat;
}
```

**Constraints.** This only reorders the candidate list — it never changes the candidate set, tier, capability, or `allowedBackends`. The hard floor (`isFrontierItem` classifications never routed to local regardless of cost) is preserved because reordering cannot promote a lower-tier candidate past a capability gate. `LEARNED_ROUTING_MIN_SAMPLES=5` cold-start neutral-0.5 discipline unchanged. Gated on `cfg.foundry.learnedRouting !== false` — off means empty map, no-op, byte-identical.

---

### C3: RunCache (`src/core/fabric/cache/`, NEW)

**Purpose.** Skip engine subprocess spawns when the exact same goal was run against the exact same repo source state. This is the single highest-leverage intervention: avoided spawns save seconds-to-minutes of wall-clock time and the full LLM cost of generation, with zero similarity risk.

**The load-bearing correctness decision.** Agent diffs are correct only for the exact source state they were generated against (confirmed as the #1 hazard in findings and external research). The cache key MUST include repo source state. Any source change must produce a guaranteed miss. Similarity reuse of diffs is disabled by default and, even when opted in, is advisory-only into the planner prompt — never auto-return of a cached diff.

#### 3a. Cache Key Construction (`src/core/fabric/cache/key.ts`)

```typescript
// src/core/fabric/cache/key.ts
import { createHash } from 'node:crypto';

export interface CacheKeyInput {
  engine: EngineId;
  engineModel: string;          // resolveConcreteModel output — params matter
  goalCanonical: string;        // normalized: collapse whitespace, strip volatile ids/timestamps
  repoTreeSha: string;          // `git rev-parse HEAD:` — tree SHA, folds ALL tracked file content
  dirtyHash: string;            // sha256(`git diff`) — dirty worktree never collides with clean
  configEpoch: string;          // sha256 of gate-relevant cfg slice (allowedBackends, scopeCap, judge, testCmd)
  schemaVersion: 1;             // bump to wholesale-invalidate all entries
}

export function buildCacheKey(input: CacheKeyInput): string {
  return createHash('sha256')
    .update(JSON.stringify(input, Object.keys(input).sort()))
    .digest('hex');
}
```

`repoTreeSha` (not just HEAD commit SHA) folds all tracked file contents into the key: a `git commit`, `git checkout`, merge, or edit changes the tree SHA → guaranteed miss → no stale diff. `dirtyHash` ensures an uncommitted working-tree change (submodule update, env file) also misses. The combined key is the git-aware invalidation the external research identifies as mandatory for code output caching.

**Hook point.** `sandboxed-engine.ts:runEngineSandboxed`, immediately before `buildEngineCommand`/`spawnEngine` at approximately line 353. Both shell calls (`git rev-parse HEAD:` and `git diff`) are already the project's pattern — the codebase shells to git extensively. These are fast (`< 5ms` on any repo) and fire once per run attempt.

#### 3b. Cache Store (`src/core/fabric/cache/store.ts`)

Persistence: append-only JSONL at `~/.ashlr/fabric/cache/<repoTreeSha-prefix>.jsonl`, plus an in-process `Map<string, CacheEntry>` index built on first read per repo prefix. Mirrors `genome/store.ts` conventions exactly.

```typescript
// src/core/fabric/cache/store.ts
export interface CacheEntry {
  key: string;                  // sha256 from buildCacheKey
  patch: string;                // scrubbed diff (scrubSecrets already applied at write time)
  provenanceSig: string;        // stored for audit; NEVER replayed — always re-signed on serve
  engineModel: string;
  tier: EngineTier;
  diffHash: string;
  repoTreeSha: string;          // for git-aware sweep
  goalEmbedding?: number[];     // OPTIONAL, only when semantic opt-in on; never used to serve a diff
  verdictAtWrite: 'verified' | 'unknown';
  shipOutcomes: { ship: number; reject: number };  // quality-feedback eviction
  createdAt: string;
  lastHit: string;
  hits: number;
  schemaVersion: 1;
  embeddingModelId?: string;    // pinned; mismatch → entry ignored (never compare across models)
}

// Exact lookup only. Returns null on any error (parse fail, lock, missing dir).
// Never throws. Flag off → always null.
export function lookup(cfg: AshlrConfig, key: string): CacheEntry | null

// Write-through. Fire-and-forget, never-throw.
// Called ONLY after signProvenance succeeded and selectInboxStore.create() returned.
export function write(cfg: AshlrConfig, entry: CacheEntry): void

// Quality-feedback eviction: when a proposal whose diff matches diffHash is judged
// rejected/harmful in the decisions ledger, down-rank then evict that entry.
export function recordOutcome(cfg: AshlrConfig, diffHash: string, verdict: 'ship' | 'reject'): void

// LRU + size cap + git-aware TTL sweep. Called from the optimizer tick.
// Ships its own eviction from day one — no eviction primitive exists in the codebase today.
export function sweep(cfg: AshlrConfig): { removed: number }
```

Eviction policy: per-repo file scoping (no cross-repo leakage), `CACHE_MAX_ENTRIES=2000` (mirrors `HUB_MAX_ENTRIES`), `CACHE_TTL_DAYS=7` (Portkey/Helicone norm), LRU on `hits + recency`. Quality-feedback eviction: entries with `shipOutcomes.reject > shipOutcomes.ship` are evicted at the next sweep — wrong-but-cached answers are never re-served.

#### 3c. Public Seam (`src/core/fabric/cache/index.ts`)

```typescript
// src/core/fabric/cache/index.ts
export { buildCacheKey, type CacheKeyInput } from './key.ts';
export { lookup, write, recordOutcome, sweep, type CacheEntry } from './store.ts';
```

#### 3d. The cache-hit execution path (correctness is the point)

A cache hit at `sandboxed-engine.ts:~353` does **not** skip the safety pipeline. It re-enters the proposal path:

```typescript
// Inside runEngineSandboxed, before buildEngineCommand (~line 353)
const keyInput = buildCacheKeyInput(engine, engineModel, tier, goalWithContext, opts.cwd, cfg);
const cacheKey = buildCacheKey(keyInput);

if (cfg.foundry?.fabric?.cache === true) {
  const hit = lookup(cfg, cacheKey);
  if (hit) {
    // Step 1: apply-check in the already-created sandbox worktree (never skip this)
    const applyCheck = spawnSync('git', ['apply', '--check'], {
      input: hit.patch, cwd: sandboxCwd, encoding: 'utf8',
    });
    if (applyCheck.status !== 0) {
      // Residual drift: treat as miss, fall through to spawn
    } else {
      // Step 2: re-scrub (cheap, idempotent — defensive)
      const scrubbed = scrubSecrets(hit.patch);
      const diffHash = hashDiff(scrubbed);
      // Step 3: re-sign FRESH (NEVER replay the cached sig — provenance must bind THIS run)
      const provenanceSig = signProvenance(engineModel, tier, diffHash);
      // Step 4: same inbox path as a live run
      const proposal = selectInboxStore(cfg).create({
        /* ...same shape as live path... */
        source: 'fabric-cache',
        originProvenanceSig: hit.provenanceSig,  // dual provenance: origin + serve event
      });
      return { state: mk({ status: 'done', result: hit.patch, usage: ZERO_USAGE }), proposalId: proposal.id };
    }
  }
}
// ...miss path continues to spawnEngine...
// After successful live run, write-through:
write(cfg, { key: cacheKey, patch: scrubbed, provenanceSig, engineModel, tier, diffHash, ... });
```

A cache hit still produces a **PENDING proposal** that flows through judge + scope-cap + tests-green + merge-authority gates exactly as a fresh run would — because it *is* a normal pending proposal. The cache saves generation, never validation.

---

### C4: Telemetry Truth (extends existing files)

**Purpose.** Make the loop measurable before optimizing. This is Phase 0 — no behavior change, purely additive.

**`decisions-ledger.ts`** — add optional fields to `DecisionEntry` (types.ts line 3639). Optional = backward-compatible; old JSONL files with absent fields still parse (the M242 "absent on older snapshots" pattern):

```typescript
// Addition to DecisionEntry in types.ts (~line 3639)
costUsd?: number;
tokensIn?: number;
tokensOut?: number;
cacheReadTokens?: number;
durationMs?: number;       // wall-clock of the spawnEngine call
cacheHit?: boolean;        // true when the run was served from RunCache
```

**`sandboxed-engine.ts`** — thread existing `estCostUsd` result and `RunState.usage` into `recordDecision`. Wrap `spawnEngine` (line 389) with `Date.now()` deltas to un-stub the latency tracking (the existing stub is confirmed in the findings).

**`rollup.ts:buildRollup`** — sum `cacheRead`/`cacheWrite` from `UsageEvent` (already present, currently dropped). Add `cacheHitRate = cacheRead / (tokensIn + cacheRead)`. Add tiered cache pricing to `estCostUsd` in `budget.ts`: `read 0.1×`, `5m write 1.25×`, `1h write 2.0×` — mirroring pulse `pricing.ts` so `$-saved-by-cache` becomes measurable hub-side.

---

### C5: MemoryFabric Read Layer (extends genome)

**Purpose.** Add the missing read-side to M243: active retrieval by task class, not just tag-filtered recency. No new store — map tiers onto what exists.

| Tier | Backing | New code |
|---|---|---|
| **L1 hot** | In-process `Map` in front of `store.ts:loadGenome` | `memory-index.ts` — mtime-invalidated, bounded `LOAD_MAX_TOTAL=5000` cap preserved |
| **L2 warm** | `hub.jsonl` (append-only, already exists) | Write-through already works; add embedding vectors inline per entry |
| **L3 cold** | Git history of `hub.jsonl` and `knowledge/*.md` | Free provenance + audit; no new code |

**New file: `src/core/fabric/memory-index.ts`**

Responsibilities:
1. L1 cache in front of `loadGenome` — the disk walk + JSONL parse currently runs on every `recall()`, `isDuplicate()`, and `genomeHealth()` call. Cache the result, invalidate on manifest mtime change. Same pattern as `_genome-cache.ts:retrieveCached` (64-entry LRU), applied to the hub-side load.
2. Embedding-indexed skill retrieval: embed the current goal via `generateEmbedding` from core-efficiency (Ollama → `UltraFastEmbedder` fallback), cosine over skill entry description vectors (Voyager discipline: index the description, not the body), score by `recency × importance × relevance` (generative-agents triple) replacing pure-recency sort.
3. Anti-poisoning: only `verdictAtWrite === 'verified'` entries reach the retrieval pool. Retrieved memory is advisory grounding injected into the PLANNER prompt only (the existing `buildMemoryBlock` seam at `orchestrator.ts:~1661`) — never an execution directive.

**Corpus bridge (the M243/M235 → plugin gap).** A one-directional consolidation pass (mirrors `automerge-pass`/`SessionEnd`, single writer for Letta concurrency-safety without locks) projects `hub.jsonl` entries tagged `m243:skill` and `m235:anti-playbook` into `knowledge/*.md` files so learned skills reach the `ashlr__grep` interactive path. Single consolidator = append-only worker writes preserved, no rewrite races.

**Confirmation gate.** The findings flag uncertainty about whether `orchestrator.ts` actually calls `curateSkills` at inject time vs. only at `buildPlaybook`. This must be confirmed in `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/run/orchestrator.ts` around line 1619–1668 before wiring the skill-index retrieval into that seam. If curateSkills is not called there, the injection is currently a dead path and the indexer must wire into `buildMemoryBlock` directly.

---

### C6: Optimizer + Metrics (`src/core/fabric/optimizer.ts`, NEW)

**Purpose.** A bounded, file-only pass (no spawns, no network, sub-1s dashboard tick budget) that tunes the router's `λCost`/`λLat` weights and the cache sweep TTL from verified outcome history.

**Optimizer design.** Epsilon-greedy / Thompson contextual bandit: Beta posteriors per `(taskClass, tier)` pair, updated from `decisions-ledger` entries that now carry `costUsd` + `durationMs` + `cacheHit`. `α = ship count + 1`, `β = reject count + 1`. At each optimizer tick (called from the dashboard snapshot interval, bounded `<200ms`):

1. Read the last 90 days of decisions ledger (same `buildEngineScores` window).
2. Compute per-`(taskClass, tier)` `mean(costToGreen)` = `sum(costUsd) / sum(ship)`.
3. Update `λCost`/`λLat` weights via gradient step toward lower expected cost-to-green.
4. Compute counterfactual savings: for each routing decision, record what the *next-cheaper allowed tier* would have cost vs. what was actually spent. This is measured delta savings, not the current hypothetical `localSavingsUsd`.
5. Write output to `~/.ashlr/fabric/optimizer-proposal.json` — an advisory `cfg.foundry.fabric` overlay only. **Never writes live config. Never takes an outward action.** The overlay is a proposal; a human or a gated `/loop` step promotes it.

**Metrics surfaces:**

- `rollup.ts:buildRollup` — after the C4 cache-token fix: add `cacheHitRate`, `cacheReadTokens`, `cacheWriteTokens`, `cacheWriteUsd`, `cacheReadUsd` to `ModelUsage`/`DailyUsage`.
- `dashboard.ts:buildIntelligence` (M242 panel) — add: `cacheHitRate`, `runsSavedByCache`, `usdSavedByCache`, `usdSavedByRouting` (counterfactual), `tokensByTier: { frontier, mid, local }` (widening `control.ts:buildUsage` from binary `local/cloud` to the three-tier model the router actually uses).
- `web/public/app.js` — render the new fields in the existing M242 intelligence panel (around line 3467) and usage panel (around line 2631). One new row each: "Cache hit rate: X%" and "Estimated savings: $Y (cache) / $Z (routing)".
- **Pulse feedback loop.** `cost-insights.ts` already emits `kind:'cache_strategy'` and `kind:'model_swap'` recommendations consuming `cacheHitRate`. The missing apply step: pipe those recommendations back through the `RemoteTrigger`/control-plane path as *advisory* inputs to the optimizer (not auto-applied). This closes the hub→pulse→hub loop. Ship read-only first (recommendations rendered, human-promoted); auto-apply requires explicit opt-in.

---

## 4. Correctness and Safety Model

### Git-aware invalidation (the load-bearing claim)

The cache key includes `repoTreeSha` (`git rev-parse HEAD:`, the tree SHA) plus `dirtyHash` (`sha256(git diff)`). The tree SHA folds in the content of every tracked file: any commit, checkout, merge, or edit changes it. An uncommitted edit changes `dirtyHash`. Therefore:

- Identical goal + identical source state → guaranteed hit → cache serves the prior verified diff.
- Identical goal + any source change → guaranteed miss → engine spawns fresh.
- Different goal + same source → different `goalCanonical` → miss.

No TTL is needed for *correctness* (TTL is a disk-bound only). This is the structural answer to the #1 hazard identified in all three proposals.

### Re-validation on every cache hit

A hit does not skip the safety pipeline. It must pass:

1. `git apply --check` in a freshly-created sandbox worktree (same `createSandbox` that runs for a live spawn at line ~330). If the apply check fails → treat as miss, spawn the engine. This catches any residual drift the tree SHA didn't (submodule pointer changes, `.env` state).
2. `scrubSecrets(patch)` re-run — cheap, idempotent, defensive.
3. `signProvenance(engineModel, tier, diffHash)` re-signed fresh for THIS run. The cached `provenanceSig` is stored as `originProvenanceSig` for audit chain integrity — dual provenance (origin run + cache-serve event). **Never replay a cached signature** — doing so would attest a run that didn't happen.
4. `selectInboxStore(cfg).create(...)` — the proposal is PENDING, flows through judge + scope-cap + tests-green + merge-authority gates exactly as a fresh run would.

The cache saves *generation*. It never saves *validation*.

### Proposal-only invariant preserved end-to-end

The Fabric module (`src/core/fabric/`) imports zero apply/merge/push/create-pr/deploy primitives — the same contract `learned-router.ts` enforces with an explicit header comment. Every Fabric output is either a `GatewayDecision` object (a routing decision), a `PENDING` proposal (a cached diff entering the normal gates), or an advisory optimizer overlay (`optimizer-proposal.json`). None of these are outward actions.

### Anti-poisoning for the memory layer

Writes to `hub.jsonl` via `skill-library.ts` (M243) and `self-improve.ts` (M235) are already gated on `ship + tests-green` — only verified correct work writes to shared memory. The Fabric adds:

- Provenance signature on each skill entry (reusing `signProvenance`) so retrieval can down-weight low-trust sources.
- `verdictAtWrite: 'verified' | 'unknown'` field on skill entries; retrieval excludes `'unknown'`.
- Quality-feedback eviction: `recordOutcome` called from the merge/judge path demotes and evicts skill entries whose proposals were later rejected. Wrong-but-cached procedures are removed, not re-served.
- Retrieved memory is advisory grounding in the PLANNER prompt only — never an execution directive. The existing `buildMemoryBlock` posture is correct; the Fabric only adds a better retrieval ranking.

### Semantic similarity — explicit scope restriction

The external research is unambiguous: a semantically "similar" task against different file contents returns a cached diff that is silently *wrong code*, not just slow. The Fabric's policy:

- **Diffs/proposals**: L1 exact-hash only, by default. Semantic (L2) for diffs is `OFF` unless `cfg.foundry.fabric.semanticDiffCache === true`. Even when opted in, the cosine threshold is `>=0.97` (not 0.3 retrieval threshold, not 0.95 — higher, because the stakes are code correctness) AND the same source SHA must match AND `git apply --check` must pass.
- **Routing/classification**: semantic exemplar matching is safe (advisory, no mutation) and can use a standard threshold.
- **Memory/skill retrieval**: semantic is the right tool (advisory grounding, not a diff) and uses the existing `>0.3` retrieval threshold from `embeddings.ts:semanticSearch`.

The semantic and exact layers are kept architecturally separate: exact-hash is the correctness layer; semantic is the convenience layer. They are never blended for proposal outputs.

### Flag-off byte-identical invariant

Every Fabric component follows the M53/M240 contract:

| Flag | Default | Off behavior |
|---|---|---|
| `cfg.foundry.fabric?.gateway` | `false` | `decide()` returns `routeBackend()` result unchanged |
| `cfg.foundry.fabric?.cache` | `false` | `lookup()` returns `null`; `write()` no-ops |
| `cfg.foundry.fabric?.semanticDiffCache` | `false` | L2 for diffs disabled |
| `cfg.foundry.learnedRouting` | `true` | off → empty map → sort no-op (M240 existing) |
| `cfg.foundry.intelligence` | absent | M53 recommendRoute not called (existing) |
| `ASHLR_FABRIC_DISABLE=1` | — | Hard-disables all Fabric at the process level |

### Never-throw + safe-fallback everywhere

`lookup` returns `null` on any error (parse fail, lock contention, missing dir). `write` is fire-and-forget. `decide` returns `{ backend: 'builtin', tier: 'local' }` on any error. `optimizer.ts` runs only during the dashboard snapshot tick and catches all exceptions. The existing `routeBackend`/`routeTask`/`recommendRoute`/`buildEngineScores` never-throw contracts are unchanged.

---

## 5. MVP Slice and Phased Roadmap

### Phase F0 — Telemetry Truth (ship first, no behavior change)

**What ships.** Four additive changes that make the loop measurable before optimizing anything:

1. `rollup.ts:buildRollup` — sum `cacheRead`/`cacheWrite` from `UsageEvent` into `ModelUsage`/`DailyUsage`; compute `cacheHitRate`.
2. `budget.ts:estCostUsd` — add tiered cache pricing (5m 1.25×, 1h 2.0×, read 0.1×) mirroring pulse `pricing.ts`.
3. `types.ts:DecisionEntry` — add optional `costUsd?`, `tokensIn?`, `tokensOut?`, `durationMs?`, `cacheHit?` fields.
4. `sandboxed-engine.ts` — thread `estCostUsd` + `usage` into `recordDecision`; wrap `spawnEngine` with `Date.now()` delta to un-stub latency.
5. `dashboard.ts:buildIntelligence` + `web/public/app.js` — surface `cacheHitRate`, `tokensByTier` (widening from binary local/cloud).

**Why first.** Zero behavior change. Purely additive. Backward-compatible (optional fields, absent on older JSONL snapshots). This alone turns on the cost/latency signal that every subsequent phase optimizes against. Without it, the optimizer has no input.

**Measurable outcome.** `cacheHitRate` (currently always 0, will remain 0 until C3 ships but the counter is live), `tokensByTier` breakdown, real `estCostUsd` per decision in the ledger.

### Phase F1 — Gateway (behavior-preserving refactor)

**What ships.** `src/core/fabric/gateway.ts`. Consolidates `loop.ts:705–770` into `decide()`. Fixes the `tierOf` latent bug at `learned-router.ts:122`. Collapses the double `routeBackend` call. Adds decision trace for debuggability.

**Gate.** Golden-trace equivalence test: record 50 real decision inputs, assert that gateway output matches pre-refactor output for every one of them. This test must pass before merge. Flag-off (`cfg.foundry.fabric?.gateway !== true`) preserves current behavior exactly.

**Measurable outcome.** Decision traces visible in dashboard. `tierOf` fix allows M53's mid-nudge to actually fire — measurable in the ledger as `backend !== 'builtin'` decisions where they were previously falling through.

### Phase F2 — RunCache Exact-Only (the 80/20 win)

**What ships.** `src/core/fabric/cache/` (key.ts, store.ts, index.ts). Cache-check hook in `sandboxed-engine.ts` before line 353. Write-through after the existing sign/inbox path at lines 415–459. Per-repo JSONL persistence + LRU/TTL/quality-feedback eviction.

**Shadow mode first.** Ship the cache with a shadow-mode flag (`cfg.foundry.fabric.cacheShadow === true`): compute the key, log `would-hit`/`would-miss`, always spawn, never short-circuit. Run for 72 hours of daemon ticks to measure the real hit rate and verify zero false-positive keys (two identical keys should only occur when source state is genuinely identical). Only after zero false-positives in shadow mode, enable actual short-circuiting (`cfg.foundry.fabric.cache === true`).

**Measurable outcome.** `runsSavedByCache` counter in the dashboard. `usdSavedByCache` from `estCostUsd` applied to skipped spawns. Spawn count reduction measurable in `decisions-ledger` `cacheHit === true` entries. Wall-clock latency improvement measurable via the `durationMs === 0` (cache hits record zero spawn latency).

### Phase F3 — Cost-Aware Router

**What ships.** Extend `buildEngineScores` and `sortEnginesByScore` in `learned-router.ts` with `costPerShipUsd`/`medianLatencyMs` fields and the utility function. `λCost = 0`, `λLat = 0` defaults → byte-identical to today.

**Gate.** Requires `>=5` samples per `(engine, taskClass)` pair (existing `LEARNED_ROUTING_MIN_SAMPLES` discipline). Optimizer sets `λCost > 0` only after sufficient history.

**Measurable outcome.** `usdSavedByRouting` counterfactual (actual spend vs. next-cheaper-tier counterfactual) in dashboard. Should show measurable shift toward mid-tier backends on bulk tasks without quality regression (ship-rate stays flat or improves).

### Phase F4 — MemoryFabric Read Layer

**What ships.** `src/core/fabric/memory-index.ts`. L1 cache in front of `loadGenome`. Embedding-indexed skill retrieval with `recency × importance × relevance` scoring. Corpus bridge consolidation pass projecting `hub.jsonl` skills into `knowledge/*.md`.

**Prerequisite.** Confirm the `orchestrator.ts:~1661` inject path (`buildPlaybook` vs. `buildMemoryBlock` vs. direct `curateSkills` call) before wiring. If skills are not reaching prompts today, fix the inject path first.

**Measurable outcome.** Skill retrieval precision: measure whether the top-3 retrieved skills by embedding relevance overlap with task-class (manual audit on a sample of 20 tasks). `loadGenome` call frequency visible in metrics — should drop from re-parse-every-call to hit-count >> miss-count.

### Phase F5 — Optimizer + Pulse Feedback Loop

**What ships.** `src/core/fabric/optimizer.ts` (bandit, counterfactual baseline, advisory overlay). Pulse → hub recommendation pipe (read-only first; auto-apply behind explicit opt-in).

**Measurable outcome.** `optimizer-proposal.json` generated after each snapshot tick. Month-over-month trend in `usdSavedByRouting` + `usdSavedByCache`. Quality held: ship-rate flat or up while cost trends down.

### Phase F6 — Productization

Open-core line: F0–F2 (telemetry, gateway, exact cache) ship in OSS hub. F3–F5 (cost-aware learned routing, optimizer, cross-machine L2 memory sync, pulse insights apply) ship behind a Pro flag in the client-delivery runtime. See section 8.

---

## 6. Module and API Sketches

### `src/core/fabric/gateway.ts`

```typescript
// Zero deps. Never throws. Flag-off → pass-through.
import { routeBackend } from '../fleet/router.ts';
import { routeTask } from '../run/router.ts';
import { withinLimit } from '../quota.ts';
import { subscriptionAllows } from '../fleet/subscription.ts';
import { recommendRoute, recoverWithinBudget } from '../run/learned-router.ts';
import { buildCacheKey, buildCacheKeyInput } from './cache/key.ts';
import type { AshlrConfig, WorkItem, EngineId, EngineTier } from '../types.ts';

export interface GatewayDecision {
  backend: EngineId;
  tier: EngineTier;
  model?: string;
  cacheKeyInput: CacheKeyInput;
  source: 'fleet' | 'cli';
  trace: Array<{ stage: string; backend: EngineId; tier: EngineTier; reason: string }>;
  reason: string;
}

export async function decide(
  input: WorkItem | { goal: string; repo: string },
  cfg: AshlrConfig,
  ctx: GatewayCtx = {},
): Promise<GatewayDecision> {
  // Flag off → thin pass-through
  if (cfg.foundry?.fabric?.gateway !== true) {
    const d = 'id' in input
      ? routeBackend(input, cfg)
      : { backend: cfg.foundry?.defaultBackend ?? 'builtin' as EngineId, tier: 'local' as EngineTier };
    return { ...d, cacheKeyInput: buildCacheKeyInput(d, input, cfg), source: 'fleet' as const, trace: [], reason: 'pass-through' };
  }
  try {
    const trace: GatewayDecision['trace'] = [];
    let decision = isWorkItem(input) ? routeBackend(input, cfg) : baseDecision(input, cfg);
    trace.push({ stage: 'routeBackend', ...decision, reason: 'base routing' });

    if (decision.backend !== 'builtin' && !withinLimit(decision.backend)) {
      decision = { ...decision, backend: 'builtin', tier: 'local' };
      trace.push({ stage: 'quotaGuard', ...decision, reason: 'quota exceeded' });
    }

    if (cfg.foundry?.intelligence && isWorkItem(input)) {
      const nudge = await recommendRoute(input, cfg, ctx);
      if (nudge.backend !== decision.backend) {
        decision = nudge;
        trace.push({ stage: 'm53Nudge', ...decision, reason: nudge.reason ?? 'recommendRoute' });
      }
      const recovered = recoverWithinBudget(decision, cfg, ctx.spentUsd, ctx.forecast);
      if (recovered.backend !== decision.backend) {
        decision = recovered;
        trace.push({ stage: 'recoverBudget', ...decision, reason: 'budget recovery' });
      }
    }

    return {
      ...decision,
      cacheKeyInput: buildCacheKeyInput(decision, input, cfg),
      source: isWorkItem(input) ? 'fleet' : 'cli',
      trace,
      reason: trace.at(-1)?.reason ?? 'routeBackend',
    };
  } catch {
    // Never-throw: fail open to builtin
    return { backend: 'builtin', tier: 'local', cacheKeyInput: nullKeyInput(), source: 'fleet', trace: [], reason: 'error-fallback' };
  }
}
```

### `src/core/fabric/cache/key.ts`

```typescript
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

export interface CacheKeyInput {
  engine: EngineId;
  engineModel: string;
  goalCanonical: string;
  repoTreeSha: string;
  dirtyHash: string;
  configEpoch: string;
  schemaVersion: 1;
}

export function buildCacheKeyInput(
  decision: { backend: EngineId; tier: EngineTier; model?: string },
  input: WorkItem | { goal: string; repo: string },
  cfg: AshlrConfig,
): CacheKeyInput {
  const repo = 'repo' in input ? input.repo : (input as WorkItem).repo ?? process.cwd();
  const goal = 'goal' in input ? input.goal : buildItemGoal(input as WorkItem);
  let repoTreeSha = 'unknown';
  let dirtyHash = 'clean';
  try {
    repoTreeSha = execSync('git rev-parse HEAD:', { cwd: repo, encoding: 'utf8' }).trim();
    const diff = execSync('git diff', { cwd: repo, encoding: 'utf8' });
    dirtyHash = diff.length > 0
      ? createHash('sha256').update(diff).digest('hex')
      : 'clean';
  } catch { /* non-git dir → repoTreeSha stays 'unknown' → misses always */ }
  return {
    engine: decision.backend,
    engineModel: decision.model ?? decision.backend,
    goalCanonical: canonicalizeGoal(goal),
    repoTreeSha,
    dirtyHash,
    configEpoch: hashConfigSlice(cfg),
    schemaVersion: 1,
  };
}

export function buildCacheKey(input: CacheKeyInput): string {
  return createHash('sha256')
    .update(JSON.stringify(input, Object.keys(input).sort()))
    .digest('hex');
}

function canonicalizeGoal(goal: string): string {
  // Collapse whitespace, strip volatile ids (UUIDs, timestamps, PR numbers)
  return goal
    .replace(/\s+/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, 'UUID')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, 'TS')
    .trim();
}

function hashConfigSlice(cfg: AshlrConfig): string {
  const slice = {
    allowedBackends: cfg.foundry?.allowedBackends,
    scopeCap: cfg.foundry?.scopeCap,
    judgeModel: cfg.foundry?.judgeModel,
    testCmd: cfg.foundry?.testCmd,
  };
  return createHash('sha256').update(JSON.stringify(slice)).digest('hex').slice(0, 16);
}
```

### `src/core/fabric/optimizer.ts`

```typescript
// Zero deps. Bounded <200ms. Advisory output only. Never throws.
import { readFileSync, writeFileSync } from 'node:fs';
import { readDecisions } from '../fleet/decisions-ledger.ts';

export interface OptimizerState {
  lambdaCost: number;      // weight on costPerShipUsd in utility (default 0)
  lambdaLat: number;       // weight on medianLatencyMs in utility (default 0)
  posteriors: Record<string, { alpha: number; beta: number }>;  // Beta per (taskClass:tier)
  lastRunTs: number;
  counterfactualSavingsUsd: number;  // rolling measured delta vs next-cheaper tier
}

export function runOptimizerTick(cfg: AshlrConfig): {
  state: OptimizerState;
  proposalDelta: Partial<FabricCfg>;
} {
  // Read decisions ledger (same 90d window as buildEngineScores)
  // Update Beta posteriors from cacheHit + verdict outcomes
  // Compute counterfactual: for each routedTo=frontier decision, what would mid have cost?
  //   = sum(tokensIn * MID_PRICE - tokensIn * FRONTIER_PRICE) for ship verdicts
  // Output: advisory cfg overlay to ~/.ashlr/fabric/optimizer-proposal.json
  // NEVER write live config. NEVER take outward actions.
  // Return the proposal for the dashboard to render.
}
```

---

## 7. Metrics and Success Criteria

### Primary: $ saved

**Target (3 months post-F2):** `usdSavedByCache + usdSavedByRouting` > 20% of total fleet spend for active repos (repos with >5 runs/week). Benchmark: baseline is today's spend with no cache and no cost-aware routing.

**Measurement:** `decisions-ledger` entries with `cacheHit === true` × `estCostUsd` of the would-have-been run. Counterfactual routing savings from optimizer's next-cheaper-tier delta. Both surfaced in `dashboard.ts:buildIntelligence`.

### Secondary: Hit rate

**Target (3 months post-F2):** `cacheHitRate >= 15%` on daemon fleet ticks. Rationale: the daemon re-spawns identical goals across ticks on unchanged repos (confirmed pattern in findings). 15% is conservative; the real rate depends on how frequently goals repeat before a commit. Shadow-mode data from F2 will calibrate the actual baseline before committing to a target.

**Measurement:** `cacheRead / (tokensIn + cacheRead)` from `buildRollup`. Also `runsSavedByCache` counter in dashboard (integer count of skipped spawns).

### Guard rail: quality preserved

**Target:** Ship-rate (M240 `buildEngineScores`) flat or up across all `(engine, taskClass)` pairs after F2 and F3 ship. No degradation in `engineScorecards.shipRate` in the M242 dashboard panel.

**Measurement:** weekly comparison of `engineScorecards` snapshot before and after each phase. Alert if any taskClass ship-rate drops > 5 percentage points.

### Guard rail: zero false-apply incidents

**Target:** Zero instances of a cached diff producing a `rejected` or `harmful` verdict that was not caught by `git apply --check` or the judge gate. (Verified-gate catching a bad cached diff is acceptable; the cached diff silently merging wrong code is the failure mode to prevent.)

**Measurement:** audit `decisions-ledger` for proposals with `source: 'fabric-cache'` and `verdict: 'rejected'` or `verdict: 'harmful'`. Any such entry triggers automatic shadow-mode reversion of the cache for the affected repo until root cause is identified.

### Dashboard surfaces (what gets built)

| Metric | Source | Where rendered |
|---|---|---|
| `cacheHitRate` | `rollup.ts:buildRollup` | M242 intelligence panel |
| `runsSavedByCache` | `decisions-ledger` `cacheHit` count | M242 intelligence panel |
| `usdSavedByCache` | `estCostUsd` × saved runs | M242 intelligence panel |
| `usdSavedByRouting` | optimizer counterfactual delta | M242 intelligence panel |
| `tokensByTier.frontier/mid/local` | `control.ts:buildUsage` widened | Usage panel |
| `decisionTrace` | `GatewayDecision.trace` | Per-item expandable in fleet view |

---

## 8. Productization and Moat

### Open-core line

**OSS hub core (F0–F2):** Telemetry truth, InferenceGateway, RunCache exact-only. These are the correctness and observability foundations. Shipping them open-source establishes the git-aware cache as the standard approach for coding-agent systems. No other open project has a verified-outcome-gated response cache with git source-state keying.

**Pro tier (F3–F5, and the client-delivery runtime):** Cost-aware learned routing (F3), embedding skill retrieval (F4), bandit optimizer + pulse feedback loop (F5), cross-machine L2 memory sync (F4 extension), and the full Pulse analytics dashboard. These require the fleet's learning history to have value — they compound over time and are non-transferable to a new installation without data. This is the natural moat: the Pro tier gets better the more the fleet ships.

### The Ashlr.ai angle

The Fabric's self-optimizing loop — routing from verified outcomes, caching verified diffs, retrieving verified procedures — creates a client-delivery runtime story: "your engineering fleet learns your codebase, your patterns, and your cost profile, and compounds that learning into lower cost and higher quality over time." This is the pitch that no generic gateway can match because no generic gateway has a compiler verdict on the other side.

Concrete client-delivery differentiators:
- Per-client `hub.jsonl` is a proprietary skill asset: skills distilled from their fleet's shipped work, indexed by their codebase patterns.
- Per-client cache hit rates improve as the fleet re-approaches identical goals on stable repos (CI re-runs, iterative feature work, scheduled maintenance tasks).
- Per-client routing weights reflect their tech stack's actual compile+test success rates, not Chatbot Arena preferences.

### Fleet-uses-its-own-tools (the Tier-1 composition bet)

The ecosystem map (confirmed in memory files) already documents this bet. The Fabric makes it concrete: the fleet's routing decisions are informed by the fleet's own verified outcomes. The skill library written by the fleet is retrieved by the fleet. The optimizer tuning the fleet's routing is fed by the fleet's own cost data. The system is self-referential in a way that compounds positively as it ships more code.

---

## 9. Risks and Mitigations

### Risk 1: Stale cache corruption (severity: critical)

**Scenario.** A cached diff is served for a non-identical source state, producing wrong code that passes `git apply --check` but corrupts behavior.

**Mitigated by (three layers):**
1. `repoTreeSha` + `dirtyHash` in the key — any tracked or untracked change is a guaranteed miss.
2. `git apply --check` re-validation in the sandbox worktree — catches residual drift (submodule pointers, generated files).
3. Judge + scope-cap + tests-green still run on the PENDING proposal — wrong code must still pass all existing gates before it can merge. Cache saves generation, never validation.

**Residual risk:** shadow-mode data from F2 must show zero false-positive keys before enabling actual short-circuiting.

### Risk 2: Breaking the hot dispatch path during C1 gateway refactor

**Scenario.** The gateway refactor changes `loop.ts:705–770` behavior, causing routing regressions in the live fleet.

**Mitigated by:** golden-trace equivalence test (50 recorded real inputs, assert byte-identical decisions before/after); flag-gated default-off; fail-open-to-builtin on any error; the existing `routeBackend`/`recommendRoute` functions are *called*, not rewritten.

### Risk 3: `tierOf` latent bug fix changes M53 behavior unexpectedly

**Scenario.** Fixing `learned-router.ts:122` to correctly resolve mid-tier backends causes M53's nudge to fire where it previously fell through, unexpectedly routing items to mid engines.

**Mitigated by:** the fix is part of the gateway's `decide()` function which is flag-gated (`cfg.foundry.fabric?.gateway !== true` keeps old behavior). The fix ships after the golden-trace test validates equivalence. M53 only ever nudges *down* (frontier→mid), never escalates — the direction of the change is toward cost savings, not toward frontier escalation.

### Risk 4: Cost-collapse — optimizer routes everything to the weakest model

**Scenario.** `λCost > 0` routing drives all traffic to local/builtin engines. Quality collapses. Expensive rework costs more than the routing savings.

**Mitigated by:** utility function denominator is total-cost-to-green (includes rework), not single-call cost. `isFrontierItem` capability floor is preserved — frontier-required task classes cannot be routed to local regardless of cost. Optimizer writes advisory overlay only; human-promotion required before any weight changes apply to live routing. Quality guard rail: automatic reversion if ship-rate drops >5pp.

### Risk 5: Memory poisoning via skill-library (AgentPoison)

**Scenario.** A small number of malicious or incorrect skill entries (`<0.1%`) are retrieved and executed, hijacking `>80%` of triggered runs (confirmed AgentPoison result).

**Mitigated by (existing + new):** M243 already gates writes on `ship + tests-green` — only verified-correct work enters the skill library. New additions: `verdictAtWrite` field (retrieval excludes `'unknown'`); `signProvenance` on each skill entry; quality-feedback eviction for rejected skills; retrieved memory is advisory grounding in planner prompt only, never an execution directive. The system cannot be poisoned through the normal skill-write path without first passing judge + scope-cap + tests-green.

### Risk 6: Unbounded cache growth

**Scenario.** The JSONL cache files grow without bound, bloating disk and slowing the dashboard tick.

**Mitigated by:** `CACHE_MAX_ENTRIES=2000` hard cap per repo (mirrors `HUB_MAX_ENTRIES`), `CACHE_TTL_DAYS=7`, quality-feedback eviction of rejected entries, `sweep()` called from the optimizer tick. These policies ship in F2 from day one — eviction is not deferred.

### Risk 7: Embedding model version drift invalidating stored vectors

**Scenario.** Ollama `nomic-embed-text` is upgraded, making stored 256-dim vectors incomparable to newly computed vectors, causing semantic retrieval to silently degrade.

**Mitigated by:** `embeddingModelId` field on every cache entry. Lookup ignores entries with mismatched `embeddingModelId`. The `embedding-cache-coherence.ts` pattern from core-efficiency is the exact model to copy. Semantic entries are advisory only — a miss degrades to exact-hash lookup or keyword fallback, never returns a wrong result.

### Risk 8: Optimizer auto-applying pulse recommendations without human review

**Scenario.** Pulse `cost-insights.ts` emits a `model_swap` recommendation; the optimizer applies it directly to live routing config; the recommended model is unavailable or inappropriate for the fleet's task mix.

**Mitigated by:** pulse recommendations are advisory input to the optimizer, not direct config writes. The optimizer writes only to `optimizer-proposal.json` (an advisory overlay). Live config changes require explicit human promotion or a gated `/loop` step. Auto-apply requires `cfg.foundry.fabric.autoApplyOptimizer === true` explicit opt-in.

### Risk 9: Cross-repo cache leakage in a multi-repo fleet

**Scenario.** A cache hit for repo A is served to repo B because their goals are similar.

**Mitigated by:** per-repo scoping via `repoTreeSha` as a JSONL filename prefix — a cache lookup for repo B physically cannot find repo A's entries. The cache file path itself is namespaced. This is structurally impossible, not just threshold-dependent.

---

## 10. Concrete Next Milestones

### M50 — Telemetry Truth (Phase F0)

**Scope:**
- [ ] `rollup.ts:buildRollup` — sum `cacheRead`/`cacheWrite` from `UsageEvent` into `ModelUsage`/`DailyUsage`; compute `cacheHitRate = cacheRead/(tokensIn+cacheRead)`.
- [ ] `budget.ts:estCostUsd` — add tiered cache pricing (5m 1.25×, 1h 2.0×, read 0.1×) mirroring `ashlr-pulse/server/src/lib/pricing.ts`.
- [ ] `src/core/types.ts:DecisionEntry` — add optional `costUsd?`, `tokensIn?`, `tokensOut?`, `durationMs?`, `cacheHit?` fields.
- [ ] `sandboxed-engine.ts` — thread `estCostUsd` + `usage` into `recordDecision` at the existing emit site; wrap `spawnEngine` (~line 389) with `Date.now()` delta.
- [ ] `dashboard.ts:buildIntelligence` — add `cacheHitRate` and `tokensByTier: { frontier, mid, local }` to `IntelligenceSummary`.
- [ ] `web/public/app.js` — render new fields in M242 panel and usage panel.
- [ ] `control.ts:buildUsage` — widen `ControlUsageByProvider.tier` from binary `'local'|'cloud'` to `'local'|'mid'|'frontier'`.

**Test:** existing M242 snapshot tests pass with optional fields absent (backward-compat); new test asserts `cacheHitRate` appears in `IntelligenceSummary`; `estCostUsd` unit test covers cache-tier pricing.

**Files touched:** `src/core/observability/rollup.ts`, `src/core/run/budget.ts`, `src/core/types.ts`, `src/core/run/sandboxed-engine.ts`, `src/core/fleet/decisions-ledger.ts`, `src/core/dashboard.ts`, `src/core/web/control.ts`, `src/core/web/public/app.js`.

---

### M51 — InferenceGateway (Phase F1)

**Scope:**
- [ ] `src/core/fabric/gateway.ts` — `decide()` function wrapping the existing routing sequence.
- [ ] `src/core/run/learned-router.ts:tierOf` line 122 — fix to resolve tier via engine registry, unblocking M53 mid-nudge.
- [ ] `daemon/loop.ts` — replace double `routeBackend` call (lines 678, 705) and override block (705–770) with single `gateway.decide(item, liveCfg, ctx)` call.
- [ ] `orchestrator.ts:1001` — call `gateway.decide({goal, repo}, cfg)` for the CLI path.

**Gate:** golden-trace equivalence test — 50 recorded real `WorkItem` inputs, assert `gateway.decide` output byte-matches pre-refactor `routeBackend`/`recommendRoute` output on each. This test must be written and passing before merge. Ship behind `cfg.foundry.fabric.gateway: false` default.

**Files touched:** `src/core/fabric/gateway.ts` (NEW), `src/core/run/learned-router.ts`, `src/core/daemon/loop.ts`, `src/core/run/orchestrator.ts`.

---

### M52 — RunCache Shadow Mode (Phase F2, part 1)

**Scope:**
- [ ] `src/core/fabric/cache/key.ts` — `buildCacheKeyInput`, `buildCacheKey`, `canonicalizeGoal`, `hashConfigSlice`.
- [ ] `src/core/fabric/cache/store.ts` — `lookup`, `write`, `recordOutcome`, `sweep`. JSONL persistence under `~/.ashlr/fabric/cache/`. LRU/TTL/quality-feedback eviction.
- [ ] `src/core/fabric/cache/index.ts` — barrel export.
- [ ] `sandboxed-engine.ts` — shadow-mode hook: compute key, log `would-hit`/`would-miss` to `decisions-ledger`, always spawn (no short-circuit yet). Controlled by `cfg.foundry.fabric.cacheShadow === true`.
- [ ] Write-through after sign/inbox path (lines 415–459): call `write()` fire-and-forget.

**Gate:** 72h shadow-mode run on at least one active repo. Zero false-positive key collisions (two entries with the same key must represent genuinely identical source state — verify by inspecting the entries manually). `cacheHitRate` shadow counter appears in dashboard. Only after zero false-positives advance to M53.

**Files touched:** `src/core/fabric/cache/` (NEW dir + 3 files), `src/core/run/sandboxed-engine.ts`.

---

### M53 — RunCache Live (Phase F2, part 2)

**Scope:**
- [ ] `sandboxed-engine.ts` — enable actual short-circuit on cache hit: `git apply --check`, re-scrub, re-sign fresh, `selectInboxStore.create(PENDING)`. Controlled by `cfg.foundry.fabric.cache === true`.
- [ ] `decisions-ledger` — `recordOutcome` fan-out: when a proposal is judged, call `cache.recordOutcome(diffHash, verdict)` to update quality-feedback on the originating cache entry.
- [ ] `dashboard.ts:buildIntelligence` — add `runsSavedByCache`, `usdSavedByCache` to `IntelligenceSummary`.

**Gate:** first live cache hit must be manually audited — inspect the proposal, the diff, the apply-check result, the re-signed provenance, and confirm the `PENDING` proposal goes through the normal judge gate before this milestone is marked complete.

**Files touched:** `src/core/run/sandboxed-engine.ts`, `src/core/fleet/decisions-ledger.ts`, `src/core/dashboard.ts`.

---

### M54 — Cost-Aware Router (Phase F3)

**Scope:**
- [ ] `learned-router.ts:EngineScore` — add `costPerShipUsd?`, `medianLatencyMs?`.
- [ ] `learned-router.ts:buildEngineScores` — populate from C4 ledger fields.
- [ ] `learned-router.ts:sortEnginesByScore` — extend to `computeUtility(score, λCost, λLat)` with `λCost=0`, `λLat=0` defaults.
- [ ] `src/core/fabric/optimizer.ts` — initial bandit: read ledger, compute counterfactual savings baseline, write advisory `optimizer-proposal.json`.

**Gate:** `LEARNED_ROUTING_MIN_SAMPLES=5` enforced per `(engine, taskClass)` before any non-zero `λ` is emitted by the optimizer. Quality guard rail: automated test asserts ship-rate flat or up after optimizer runs against a recorded ledger fixture.

**Files touched:** `src/core/run/learned-router.ts`, `src/core/fabric/optimizer.ts` (NEW).

---

### M55 — MemoryFabric Read Layer (Phase F4)

**Scope:**
- [ ] Confirm `orchestrator.ts:~1661` inject path: does `buildMemoryBlock` call `curateSkills`? Trace and document. Fix if it's a dead path.
- [ ] `src/core/fabric/memory-index.ts` — L1 cache in front of `loadGenome`; embedding-indexed skill retrieval with `recency × importance × relevance` scoring.
- [ ] `skill-library.ts` — add `goalEmbedding` field to skill entries; compute on `learnFromApplied` fire-and-forget via `generateEmbedding` (core-efficiency).
- [ ] Corpus bridge consolidation pass: one-directional `hub.jsonl` m243/m235 entries → `knowledge/*.md` projection. Single-writer process, append-only.

**Gate:** retrieval precision test — manually select 20 tasks from `decisions-ledger`, retrieve top-3 skills for each by embedding similarity, audit whether they're relevant. Target: >=70% relevant at top-3.

**Files touched:** `src/core/run/orchestrator.ts`, `src/core/fabric/memory-index.ts` (NEW), `src/core/fleet/skill-library.ts`, new consolidation script.

---

### M56 — Pulse Feedback Loop (Phase F5)

**Scope:**
- [ ] Pipe `cost-insights.ts` recommendations from pulse back to hub as advisory optimizer inputs (read-only first: render in dashboard, no auto-apply).
- [ ] Add `cfg.foundry.fabric.autoApplyOptimizer` opt-in gate for auto-promote.
- [ ] `RemoteTrigger`/control-plane path for applying optimizer overlays to live fleet config.

**Gate:** recommendation-only mode must run for 2 weeks before auto-apply is considered. Recommendations during that window are manually reviewed and spot-checked for correctness.

**Files touched:** `src/core/fabric/optimizer.ts`, `src/core/dashboard.ts`, hub↔pulse control-plane bridge.

---

## Absolute File References

**Files to modify:**
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/observability/rollup.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/run/budget.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/types.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/run/sandboxed-engine.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fleet/decisions-ledger.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/dashboard.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/web/control.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/web/public/app.js`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/run/learned-router.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/daemon/loop.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/run/orchestrator.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fleet/skill-library.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/genome/recall.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/genome/store.ts`

**Files to create:**
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fabric/gateway.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fabric/cache/key.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fabric/cache/store.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fabric/cache/index.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fabric/memory-index.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/src/core/fabric/optimizer.ts`

**Core-efficiency primitives to reuse (no modification needed):**
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency/src/genome/embeddings.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency/src/genome/embedding-ultrafast.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency/src/genome/quantized-ann.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency/src/genome/jsonl.ts`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency/src/genome/embedding-cache-coherence.ts`