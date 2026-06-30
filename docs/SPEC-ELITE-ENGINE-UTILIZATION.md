# SPEC: Elite Engine Utilization

**Status:** Design — not yet built  
**Branch:** feat/v4-foundry  
**Author:** Mason Wyatt (research pass, 2026-06-29)  
**Milestones:** M264–M271 (proposed)

---

## Executive Summary

Two linked goals:

**A — Frontier Ambition:** The trio (Claude Opus 4.8, Codex gpt-5.5, Kimi K2.6) should be building genuinely frontier-pushing work. Today Kimi K2.6 is registered `tier: 'mid'`, which excludes it from frontier routing. The strategist and invent engine already inject NORTH-STAR but have a subtle gap: they generate work items at `value=4, effort=3` as a flat default — ambition is bounded by the invent engine's hardcoded scoring, not by milestone scope. Frontier engines can be assigned incremental work when the router sends `effort < 4` items to them.

**B — Local Agentic Harness:** The `local-coder` engine already runs a genuine ReAct-style agentic loop (plan → tool call → observe → react, up to 20 steps / 50k tokens) via `agent-loop.ts`. It is **not** a one-shot prompt. The gap is upstream: local models are context-blind (no genome injection at task time, no ecosystem-index, no NORTH-STAR grounding) and execution-constrained (`allowExec: false`, no shell, no test runner). The "incredible harness" is mostly a context + execution upgrade, not a loop rewrite.

---

## Part A: Frontier Ambition

### A.1 Current State — Ground Truth

#### Engine Registry (`src/core/run/engine-registry.ts`)

| Engine | Tier | Model | Merge Authority |
|--------|------|-------|-----------------|
| `claude` | `frontier` | `claude-opus-4-8` | YES |
| `codex` | `frontier` | `gpt-5.5` | YES |
| `nim` | `mid` (builtin) | `meta/llama-3.1-70b-instruct` | NO |
| `kimi` | `mid` | `kimi-k2-0711-preview` | NO |
| `local-coder` | `mid` | `qwen2.5:72b-instruct-q4_K_M` | NO |

**Kimi K2.6 specifics (L186–198):** Registered `tier: 'mid'`, `capabilities: ['agent', 'edit', 'architecture']`, API at `https://api.moonshot.ai/v1` via `MOONSHOT_API_KEY`. The `architecture` capability signals it is intended for high-level work — but the `mid` tier prevents it from being in the frontier rotation.

**Existing promotion mechanism (L161–167, L333–351):** `applyNimConfig()` lets `cfg.foundry.nim = { tier: 'frontier', model: 'moonshotai/kimi-k2.6' }` promote the `nim` slot to frontier. This promotes NIM, not `kimi`. Kimi has no equivalent override path.

#### Goal Decomposition (`src/core/goals/planner.ts`)

`decomposeGoal()` (L183–244) is FRONTIER-FIRST: if `claude` or `codex` is installed and allowed, it calls `decomposeWithFrontier()` to generate milestones as a JSON array. This is good — the best models do the decomposition. The problem is the **ambition floor**: the prompt does not specify that milestones should be *hard*, *bold*, or *architecturally significant* — just that they should be decomposed.

#### Milestone Advancement (`src/core/goals/advance.ts`)

M229 frontier rotation (L128, L316–363): advances using `['claude', 'codex', 'nim']` as the frontier trio. Kimi is excluded from this list entirely. Rotation is round-robin with 429/5xx backoff. This means even if you add Kimi to `allowedBackends`, it will not appear in the frontier rotation — it falls to mid-tier via `routeBackend()`.

#### Work Item Routing (`src/core/fleet/router.ts`)

`isFrontierItem(item)` (L193–198): routes to frontier when `item.effort >= 4` OR `item.score >= 8` OR `item.source === 'escalation'`. Under `quality` routing policy, `isSubstantiveItem()` also routes `['issue', 'goal', 'security', 'feature', 'invent']` sources to frontier.

**The gap:** Default routing policy is `'balanced'`, not `'quality'`. Under balanced, only `effort >= 4` or `score >= 8` items hit frontier. The invent engine generates items with `value=4, effort=3, score≈2.7` — these do NOT reach the frontier threshold and get routed to mid-tier.

#### Invent Engine (`src/core/generative/invent.ts`)

`inventWorkItems()` (L267–389) injects NORTH-STAR via `northStarDocSummary()` in the system prompt with explicit "GRAND VISION GROUNDING" framing. This is the right shape. The ambition gap is in the **output normalization**: all invented items are assigned `value=4, effort=3` as defaults (L340–360 approximately). Bold architectural items (e.g., "build the inference fabric embedding layer") and incremental items (e.g., "add a CLI flag") both come out with the same score. The router cannot distinguish them.

#### NORTH-STAR Injection

`northStarDocSummary()` is injected into the strategist system prompt and the invent engine. The strategist receives the "ELON-MODE" directive (maximize bold moves, 10x bets > 10% tweaks). This is directionally correct. The ambition signal does not flow through to per-item `effort`/`score` fields, so it cannot drive routing.

### A.2 The Gaps

1. **Kimi K2.6 is not in the frontier trio** — `advance.ts:L128` hardcodes `['claude', 'codex', 'nim']`. Kimi never gets frontier-grade assignments even though `kimi-k2-0711-preview` (and K2.6) is a 1T-parameter MoE model competitive with frontier offerings.

2. **No Kimi tier-promotion path** — unlike `nim`, `kimi` has no `applyKimiConfig()` or override in `resolveEngineRegistry()`. You cannot promote it to frontier via config today.

3. **Invented items are flat-scored** — `value=4, effort=3` for everything. The invent engine generates both incremental and ambitious items; the router cannot differentiate. Bold architectural items fall to mid-tier under the balanced routing policy.

4. **Balanced routing policy as default** — most deployments use `'balanced'`, so the `isSubstantiveItem()` path never fires. The only way an `invent`-sourced item hits frontier is if someone manually sets `effort >= 4` or switches to `quality` policy.

5. **Milestone ambition prompt is underspecified** — `decomposeWithFrontier()` does not tell the frontier model to generate *ambitious, architecturally significant* milestones. It just asks for decomposition.

### A.3 Design: Elevating Kimi to Frontier-Class Work Assignment

#### Decision: Elevate Kimi K2.6 for Work Assignment, Not Merge Authority

Kimi K2.6 (`kimi-k2-0711-preview`, the Moonshot AI 1T MoE) has `'architecture'` in its capabilities — this is the correct signal. It should participate in the frontier work rotation (goal decomposition, milestone advancement, ambitious task assignments). It should NOT have merge-to-main authority until it has a trust track record (same standard applied to NIM). This preserves the safety invariant: frontier work assignment ≠ merge authority. Merge authority remains gated by the tiered-trust merge gate (M47) independently of routing tier.

#### A.3.1 Add Kimi Tier-Promotion Path

**File:** `src/core/run/engine-registry.ts`

Add `applyKimiConfig()` parallel to `applyNimConfig()` (L333–351):

```typescript
// New function alongside applyNimConfig()
function applyKimiConfig(
  spec: EngineSpec,
  cfg: AshlrConfig,
): EngineSpec {
  const override = cfg.foundry?.kimi;
  if (!override) return spec;
  return {
    ...spec,
    tier: override.tier ?? spec.tier,
    api: override.model
      ? { ...spec.api!, defaultModel: override.model }
      : spec.api,
    ...(override.apiKeyEnv ? { api: { ...spec.api!, envKey: override.apiKeyEnv } } : {}),
  };
}
```

Wire into `resolveEngineRegistry()` (L363–379):

```typescript
// After applying nim config, apply kimi config
if (merged.kimi) {
  merged.kimi = applyKimiConfig(merged.kimi, cfg);
}
```

Config shape addition to `AshlrConfig` / `FoundryConfig`:

```typescript
kimi?: {
  tier?: EngineTier;           // 'frontier' to promote
  model?: string;              // e.g. 'moonshotai/kimi-k2-0711-preview'
  apiKeyEnv?: string;          // default: 'MOONSHOT_API_KEY'
};
```

**Safety invariant preserved:** `engineTierOf('kimi', cfg)` now returns `'frontier'` when promoted. The tiered-trust merge gate (`src/core/run/merge-gate.ts`) independently checks proposal provenance and trust score — it does not use engine tier directly. Kimi proposals will still require the same human approval or scored auto-merge threshold as any non-established engine.

#### A.3.2 Add Kimi to Frontier Rotation

**File:** `src/core/goals/advance.ts`

Change `FRONTIER_TRIO` constant (L128) from:

```typescript
const FRONTIER_TRIO: EngineId[] = ['claude', 'codex', 'nim'];
```

To a function that reads the resolved registry:

```typescript
function resolveFrontierTrio(cfg: AshlrConfig): EngineId[] {
  // Base candidates — ordered by trust/capability preference
  const candidates: EngineId[] = ['claude', 'codex', 'kimi', 'nim'];
  return candidates.filter(e => engineTierOf(e, cfg) === 'frontier');
}
```

This makes the frontier trio dynamic: when Kimi is promoted via `cfg.foundry.kimi.tier = 'frontier'`, it automatically joins the rotation. When it is not promoted (default), it stays mid-tier. No hardcoded special-casing.

Update `resolveFrontierEngines()` (L147–158) to call `resolveFrontierTrio(cfg)` instead of the static array.

#### A.3.3 Ambitious Milestone Generation

**File:** `src/core/goals/planner.ts`

In `decomposeWithFrontier()` (L114–152), add explicit ambition direction to the prompt:

```typescript
const ambitionDirective = `
AMBITION STANDARD: Each milestone must represent a non-trivial engineering challenge — 
architecturally significant, genuinely novel, or measurably expanding fleet capability.
Incremental changes (config tweaks, doc updates, lint fixes) are NOT valid milestones.
Each milestone should require a skilled engineer 4–16 hours of focused work.
Prefer milestones that compose multiple system capabilities (e.g., "add genome-aware 
context injection to local-coder" vs. "update README").
`.trim();
```

Inject this before the milestone-count guidance in the existing prompt string.

Also add an `effort` and `scope` field to the JSON schema requested from the frontier model:

```typescript
// Request schema addition
`Return JSON array of objects with shape:
{ title: string, detail: string, effort: 1|2|3|4|5, scope: 'trivial'|'incremental'|'substantive'|'architectural' }
`
```

Filter out `scope: 'trivial'` milestones at parse time. Map `scope` to effort floor: `'architectural' → effort=5`, `'substantive' → effort=4`.

#### A.3.4 Invent Engine: Score Ambitious Items Correctly

**File:** `src/core/generative/invent.ts`

Change the output normalization (L340–360 approximately) from flat defaults to model-reported scores:

```typescript
// Current (flat):
value: 4,
effort: 3,
score: value / effort,

// New: ask the model to self-score, clamp to valid ranges
value: clamp(item.value ?? 4, 1, 10),
effort: clamp(item.effort ?? 3, 1, 5),
score: (clampedValue / clampedEffort),
```

Update the invent engine system prompt to request self-scored output:

```typescript
`For each item, provide:
- value (1–10): impact on the grand vision; 8+ means frontier-class (architecturally novel, compounds capabilities)
- effort (1–5): engineering effort; 4–5 means multi-day frontier-engineer work
Bold architectural items should have value≥7, effort≥4. Incremental items value≤5, effort≤2.`
```

With this change, ambitious invented items naturally clear the `isFrontierItem()` threshold (`effort >= 4` or `score >= 8`), and the balanced routing policy will send them to frontier engines without needing to switch the whole fleet to `quality` mode.

#### A.3.5 Summary of Changes by File

| File | Symbol | Change |
|------|--------|--------|
| `src/core/run/engine-registry.ts` | `applyKimiConfig()` | New function, wired into `resolveEngineRegistry()` |
| `src/core/run/engine-registry.ts` | `FoundryConfig` | Add `kimi?: { tier?, model?, apiKeyEnv? }` field |
| `src/core/goals/advance.ts` | `FRONTIER_TRIO` / `resolveFrontierTrio()` | Dynamic function replacing static array |
| `src/core/goals/advance.ts` | `resolveFrontierEngines()` | Call `resolveFrontierTrio(cfg)` |
| `src/core/goals/planner.ts` | `decomposeWithFrontier()` | Add ambition directive + effort/scope fields to JSON schema |
| `src/core/generative/invent.ts` | output normalization | Model-reported value/effort instead of flat defaults; system prompt addition |
| `docs/FOUNDRY-CONFIG.md` | `foundry.kimi` | Document the new config block |

#### A.3.6 Safety: What Does NOT Change

- Merge authority is gated by `src/core/run/merge-gate.ts` independently. Promoting Kimi to `tier: 'frontier'` for routing does not grant it merge authority.
- The tiered-trust merge gate (M47) uses proposal trust scores derived from outcome history, not engine tier. A new frontier-promoted engine starts with low trust and requires human approval until it accumulates a track record.
- `assertMayMutate()` enrollment and kill-switch checks are unaffected.
- All runs remain sandboxed + proposal-only (`propose: true, requireSandbox: true`).

---

## Part B: Local Agentic Harness

### B.1 Current State — Ground Truth

#### What local-coder IS (not a one-shot prompt)

`local-coder` (`src/core/run/engine-registry.ts:L238–252`) runs `qwen2.5:72b-instruct-q4_K_M` via Ollama at `http://localhost:11434/v1` using the OpenAI-compatible protocol. It has `capabilities: ['agent', 'edit', 'tools']`.

The execution path (`src/core/run/sandboxed-engine.ts:L710–860`, `runApiModelSandboxed()`):
1. Creates a throwaway git worktree (OS-level sandbox)
2. Builds `buildOpenAICompatibleClient()` pointing at `localhost:11434/v1`
3. Constructs engineer tools (read/write/grep/test scoped to worktree)
4. Calls `runTask()` — the ReAct loop in `src/core/run/agent-loop.ts`

The loop (`agent-loop.ts:L59–392`) is a genuine multi-turn ReAct cycle:
- `while(true)`: call model → parse tool_calls → execute tools → push `role:'tool'` messages → loop
- Budget: 50,000 tokens, 20 steps (TASK_STEP_CAP hard wall)
- Tool calling: native structured `message.tool_calls[]` + M118 content-embedded fallback for models that emit JSON in content instead of structured tool calls
- Streaming: `chatStream()` with token-by-token delta emission, fallback to `chat()`

**It is a real agentic loop.** Not a one-shot prompt.

#### What is MISSING

**1. No genome/context injection at task time.**
The orchestrator injects genome recall into planning prompts (`src/core/run/orchestrator.ts:L11–13`), but the local-coder system prompt is built by `buildEngineerSystemPrompt()` (or equivalent in sandboxed-engine.ts) without genome recall, NORTH-STAR distillation, or ecosystem summary. The local model starts each task context-blind.

**2. No ecosystem-index or codebase map.**
Local models receive the task goal but no structured map of the codebase. They must discover file structure via tool calls (read/grep), spending tokens on orientation that a genome-injected system prompt would provide for free.

**3. `allowExec: false` — no shell execution.**
`sandboxed-engine.ts:L808` sets `allowExec: false` for local-coder. The tool set is read/write/grep/navigate but no `bash` execution. Local models cannot run tests, cannot verify their own edits compile, cannot use `tsc --noEmit` to check types.

**4. No verification loop.**
Local models write diffs but have no mechanism to self-verify. The fleet sends the proposal to the manager judge (a frontier model) for scoring — but the local model itself cannot run tests, check lint, or confirm the build passes before proposing.

**5. Step cap is a hard wall, not adaptive.**
20 steps regardless of task complexity. A thorough architectural task (orient → plan → multi-file edit → verify) may legitimately need 30–40 steps. The cap terminates the run with a partial result.

**6. No self-improvement capture at the loop level.**
Genome capture fires after task completion (`captureFromRun()`) but captures only goal + outcome metadata. The tool-call trace — what worked, what failed, which grep patterns were useful — is discarded. Local models cannot learn from their own successful navigation patterns.

#### ashlrcode (`ac`) Assessment

ashlrcode (`/Users/masonwyatt/Desktop/github/dev-tools/ashlrcode`) is a standalone agentic CLI:
- Full ReAct loop (`src/agent/loop.ts`) with 45+ tools (file I/O, bash, web, MCP, memory, sub-agents)
- Reasoning cache (`src/agent/reasoning-cache.ts`): prepends prior thinking blocks from similar goals into the system prompt — a form of context injection
- Local model support: Ollama at `localhost:11434/v1` (provider router `src/providers/router.ts:L68–73`)
- **No genome integration:** ashlrcode has no `.ashlrcode/genome/` awareness, no ecosystem index, no NORTH-STAR injection
- **No fleet integration:** ashlrcode runs standalone; it is not wired into the hub's tiered-trust pipeline, merge gate, or inbox

ashlrcode provides a **superior tool surface** (45+ tools including bash execution) vs. the hub's sandboxed local-coder (read/write/grep only). The gap is fleet integration: ashlrcode runs independently and its outputs are not captured as signed, tiered proposals flowing through the merge gate.

#### ashlr-workbench Assessment

ashlr-workbench (`/Users/masonwyatt/Desktop/github/dev-tools/ashlr-workbench`) is a CLI wrapper (`aw`) that orchestrates four agents (OpenHands, Goose, Aider, ashlrcode) against a shared LM Studio instance with 10 ashlr-plugin MCP servers. It is:
- A **start/stop orchestrator**, not an agentic coordinator
- No goal decomposition, no routing by task shape, no merge gate
- Useful as a local multi-agent workbench for interactive sessions
- Not directly wirable into the hub's autonomous fleet loop

**Bottom line for Part B:** The hub already has a real ReAct loop for local models. ashlrcode has a richer tool surface. The "incredible harness" is achieved by: (1) injecting elite context into local-coder at task time, (2) unlocking measured shell execution in the sandbox, (3) adding a local verification loop, (4) making step budget adaptive, and (5) capturing tool-trace patterns for genome self-improvement. ashlrcode can be integrated as a higher-capability local backend (replacing raw local-coder for complex tasks) after the context injection layer is shared.

### B.2 Design: The Incredible Local Harness

The design is layered: each layer is independently shippable and compounds the previous.

#### Layer 1 — Elite Context Injection (M264)

**Problem:** Local models start context-blind.  
**Solution:** Build `buildLocalCoderSystemPrompt(goal, cfg, repo)` that assembles a rich context bundle before the first model call.

**File:** `src/core/run/local-context.ts` (new)

```typescript
export interface LocalCoderContext {
  northStar: string;          // ~300 tokens: grand vision distillation
  ecosystemSummary: string;   // ~300 tokens: 13-repo platform map
  genomeHits: string;         // ~400 tokens: top-5 genome recall hits for this goal
  repoTree: string;           // ~200 tokens: 2-level directory tree of the repo
  activeFiles: string[];      // Recently modified files (git log --since=7d)
  engineerRules: string;      // House style: test coverage, no console.log, etc.
}

export async function buildLocalCoderContext(
  goal: string,
  cfg: AshlrConfig,
  repo: string,
): Promise<LocalCoderContext> {
  const [northStar, ecosystemSummary, genomeHits, repoTree, activeFiles] =
    await Promise.all([
      northStarDocSummary(600),           // cap lower for local models' context window
      ecosystemSummary(600),
      recallForLocal(goal, cfg, 5),       // keyword recall, no embedding (offline-safe)
      shallowRepoTree(repo, 2),           // `find . -maxdepth 2 -type f -name '*.ts'`
      recentlyModifiedFiles(repo, 7),     // git log --since=7d --name-only
    ]);
  return { northStar, ecosystemSummary, genomeHits, repoTree, activeFiles, engineerRules: ENGINEER_RULES };
}
```

**System prompt injection** in `runApiModelSandboxed()` (`src/core/run/sandboxed-engine.ts`):

```typescript
const ctx = await buildLocalCoderContext(goal, cfg, worktree.path);
const systemPrompt = buildLocalCoderSystemPrompt(ctx, goal);
// Pass systemPrompt as the first system message to runTask()
```

System prompt structure:

```
=== GRAND VISION (orient all work here) ===
{northStar}

=== PLATFORM MAP (13 repos, composition bets) ===
{ecosystemSummary}

=== RELEVANT PRIOR WORK (genome recall) ===
{genomeHits}

=== CODEBASE ORIENTATION ===
Repo: {repo}
Active files (last 7d): {activeFiles}
Structure:
{repoTree}

=== ENGINEERING STANDARDS ===
{engineerRules}

=== YOUR TASK ===
{goal}
```

**Expected impact:** Local models immediately know what the fleet is building, what has been tried, and where the relevant code lives. Orientation tool calls drop from ~5–8 (read/grep just to understand structure) to ~0–2. This is token-free context that pays for itself on the first grep the model skips.

#### Layer 2 — Measured Shell Execution (M265)

**Problem:** `allowExec: false` means local models cannot verify their edits compile or pass tests.  
**Solution:** Enable a restricted shell in the local-coder sandbox — compile-check and test commands only, scoped to the worktree.

**File:** `src/core/run/sandboxed-engine.ts`

Change the local-coder tool construction (L803–L806):

```typescript
// Current:
const allowExec = false;

// New: allow restricted exec for local-coder when cfg.foundry.localExec !== false
const allowExec = engine === 'local-coder'
  ? (cfg.foundry?.localExec ?? true)
  : false;
```

**Restricted exec guard** in the bash tool handler:

```typescript
const LOCAL_CODER_ALLOWED_COMMANDS = new Set([
  'tsc', 'bun', 'node', 'npx', 'pnpm', 'npm',
  'git diff', 'git status',
]);

function isAllowedLocalCommand(cmd: string): boolean {
  const first = cmd.trim().split(/\s+/)[0];
  return LOCAL_CODER_ALLOWED_COMMANDS.has(first);
}
```

Disallow: `rm`, `curl`, `wget`, `ssh`, `git push`, `git commit`, `npm publish`. The worktree is already throwaway (deleted on completion) — exec blast radius is contained to the sandbox.

**Expected impact:** Local models can run `bun test`, `tsc --noEmit`, `bun run lint` to self-verify before concluding. The manager judge sees a diff that has already been compile-checked, reducing trivial-error rejections.

#### Layer 3 — Adaptive Step Budget (M266)

**Problem:** 20-step hard cap cuts off thorough architectural tasks mid-execution.  
**Solution:** Derive step budget from task properties, not a single constant.

**File:** `src/core/run/agent-loop.ts`

```typescript
export function deriveStepBudget(
  item: WorkItem | null,
  engine: EngineId,
  cfg: AshlrConfig,
): number {
  const base = cfg.foundry?.maxSteps ?? TASK_STEP_CAP;  // default 20
  if (!item) return base;

  // Scale by effort (1–5 → 1.0–2.5x)
  const effortScale = 1.0 + (item.effort - 1) * 0.375;

  // Local models need more steps (slower tool calls, less parallelism)
  const engineScale = engine === 'local-coder' ? 1.5 : 1.0;

  const derived = Math.round(base * effortScale * engineScale);
  return Math.min(derived, cfg.foundry?.maxStepsCap ?? 60);
}
```

Pass `stepBudget` into `runTask()` options instead of relying on the compile-time `TASK_STEP_CAP` constant.

**Expected impact:** A `local-coder` task with `effort=4` gets `20 × 1.875 × 1.5 = 56` steps. A trivial task (`effort=1`) gets `20 × 1.0 × 1.5 = 30` steps — still enough headroom without runaway cost.

#### Layer 4 — Tool-Trace Genome Capture (M267)

**Problem:** Genome captures goal + outcome only. Successful navigation patterns (which grep queries found the right files, which tool sequence worked) are discarded.  
**Solution:** Capture a condensed tool-trace summary alongside the outcome.

**File:** `src/core/genome/capture.ts`

Add `toolTrace` to `GenomeEntry`:

```typescript
interface GenomeEntry {
  // ... existing fields ...
  toolTrace?: {
    successfulGreps: string[];       // patterns that returned useful results
    filesRead: string[];             // files that were load-bearing for the solution
    stepCount: number;
    verifiedCompile: boolean;        // did tsc/bun pass before proposal?
    engineId: string;
  };
}
```

In `captureFromRun()`, extract from the run's tool-call events:

```typescript
const toolTrace = extractToolTrace(run.steps);  // parse emitted step events
await captureFromRun(run, cfg, { toolTrace });
```

**Genome recall enhancement** in `src/core/genome/recall.ts`: when recalling for a goal, surface `toolTrace.filesRead` and `toolTrace.successfulGreps` as pre-seeded context hints. Inject these into the local-coder system prompt under `=== PRIOR NAVIGATION HINTS ===`:

```
Prior runs on similar goals navigated these files:
  src/core/run/sandboxed-engine.ts
  src/core/run/agent-loop.ts
Useful grep patterns:
  "allowExec"
  "runTask.*budget"
```

This is the self-improvement loop: each successful local run teaches the next local run where to look.

#### Layer 5 — ashlrcode Integration as `local-agent` Backend (M268)

**Problem:** ashlrcode has 45+ tools (including bash, web, MCP) vs. local-coder's 4 (read/write/grep/test). For complex tasks, ashlrcode is a materially better executor.  
**Solution:** Add `local-agent` as a new engine backed by `ashlrcode`'s `ac` CLI, but with genome/context injection layered on top.

**File:** `src/core/run/engine-registry.ts`

```typescript
'local-agent': {
  id: 'local-agent',
  kind: 'cli-agent',
  tier: 'mid',
  bin: 'ac',
  argv: [
    '--model', 'ollama:{model}',
    '--system-file', '{contextFile}',  // pre-built context bundle written to temp file
    '--goal', '{goal}',
    '--worktree', '{cwd}',
    '--propose',
  ],
  capabilities: ['agent', 'edit', 'tools', 'execute'],
  defaultModel: 'qwen2.5:72b-instruct-q4_K_M',
},
```

The `{contextFile}` is written by `buildLocalCoderContext()` (Layer 1) before invoking `ac` — so ashlrcode's loop gets the same genome/NORTH-STAR injection, but executes with its full 45-tool surface. This is the "incredible harness": elite context + elite tool surface.

**Routing:** `local-agent` sits above `local-coder` in mid-tier preference when `ac` is installed:

```typescript
// fleet/router.ts MID_PREFERENCE
const MID_PREFERENCE: EngineId[] = ['local-agent', 'local-coder', 'nim', 'kimi', 'hermes'];
```

Tasks route to `local-agent` when ashlrcode is installed, fall back to `local-coder` otherwise. Both get the same context injection.

#### Layer 6 — Local Verification Loop (M269)

**Problem:** Local models propose diffs but don't know if they're correct until the manager judge scores them.  
**Solution:** A lightweight self-verification pass before the proposal is filed.

**File:** `src/core/run/sandboxed-engine.ts`

After `runTask()` completes and before `captureDiff()`:

```typescript
if (cfg.foundry?.localVerify !== false && result.diff) {
  const verifyResult = await runLocalVerification(worktree.path, cfg);
  result.verifyPassed = verifyResult.passed;
  result.verifyOutput = verifyResult.output;
  
  if (!verifyResult.passed && cfg.foundry?.requireLocalVerify) {
    // Re-run with verification failure as context (one retry)
    const retryGoal = `${goal}\n\nNOTE: Your previous attempt produced a diff that failed verification:\n${verifyResult.output}\nPlease fix these issues.`;
    return runApiModelSandboxed(engine, retryGoal, cfg, { ...opts, _verifyRetry: true });
  }
}
```

`runLocalVerification()` runs `tsc --noEmit && bun test --passWithNoTests` in the worktree, capped at 30 seconds. Result attached to the proposal as `verifyStatus: 'passed' | 'failed' | 'skipped'`.

**Manager judge sees the verification result** — proposals with `verifyStatus: 'passed'` get a trust bonus in scoring. This is the trust-building path: local models that self-verify and pass start accumulating a track record.

### B.3 Summary: Current Reality vs. Incredible Harness

| Capability | Today | After M264–M269 |
|------------|-------|-----------------|
| Agent loop type | ReAct, 20 steps, tool-calling | ReAct, adaptive steps (up to 60), tool-calling |
| Context at task start | Goal text only | NORTH-STAR + ecosystem map + genome recall + repo tree + prior navigation hints |
| Tool surface | read/write/grep/test (4 tools) | Same + optional `local-agent` (ashlrcode, 45+ tools) |
| Shell execution | None | Restricted: tsc/bun/git-diff only (configurable) |
| Self-verification | None | Local tsc+test pass before proposal filed |
| Self-improvement | Goal+outcome only | Tool-trace capture → genome → next-run navigation hints |
| Manager judge input | Diff only | Diff + verify status + tool trace summary |

### B.4 MVP First Slice

Ship in this order (each slice is independently useful):

**M264 — Elite Context Injection** (highest ROI, lowest risk)
- New file: `src/core/run/local-context.ts`
- Modify: `src/core/run/sandboxed-engine.ts` to call `buildLocalCoderContext()` and pass system prompt to `runTask()`
- No behavior changes to the loop, no exec changes, no trust changes
- Expected outcome: local models skip 5–8 orientation tool calls per task, produce more accurate diffs on first attempt

**M265 — Restricted Shell Execution** (enables self-verification)
- Modify: `src/core/run/sandboxed-engine.ts` allowExec guard
- New: `isAllowedLocalCommand()` whitelist
- Risk: contained to throwaway worktree; `cfg.foundry.localExec = false` opt-out

**M266 — Adaptive Step Budget** (unblocks architectural tasks)
- Modify: `src/core/run/agent-loop.ts`, `deriveStepBudget()`
- One-liner effective change, low risk

**M267 — Tool-Trace Genome Capture** (closes the self-improvement loop)
- Modify: `src/core/genome/capture.ts` GenomeEntry shape
- Modify: `src/core/genome/recall.ts` to surface navigation hints
- Modify: `src/core/run/local-context.ts` to inject prior hints

**M268 — ashlrcode as `local-agent` backend** (full tool surface)
- Modify: `src/core/run/engine-registry.ts` add `local-agent`
- Modify: `src/core/fleet/router.ts` MID_PREFERENCE order
- Requires: ashlrcode `ac` CLI accepts `--system-file` and `--propose` flags (verify against ashlrcode)

**M269 — Local Verification Loop** (trust-building)
- Modify: `src/core/run/sandboxed-engine.ts` post-runTask verify pass
- Modify proposal schema to carry `verifyStatus`
- Modify manager judge prompt to weight verify-passed proposals higher

---

## Part A: M-Milestones (Frontier Ambition)

| Milestone | Title | Files | Effort |
|-----------|-------|-------|--------|
| M264-A | Kimi frontier-promotion config path | `engine-registry.ts`, `FoundryConfig` type | 3h |
| M265-A | Dynamic frontier trio (replace static array) | `advance.ts` | 2h |
| M266-A | Ambitious milestone decomposition prompt | `planner.ts` | 2h |
| M267-A | Invent engine model-reported scoring | `invent.ts` | 3h |

## Part B: M-Milestones (Local Harness)

| Milestone | Title | Files | Effort |
|-----------|-------|-------|--------|
| M264 | Elite context injection for local-coder | `local-context.ts` (new), `sandboxed-engine.ts` | 5h |
| M265 | Restricted shell execution in local sandbox | `sandboxed-engine.ts` | 2h |
| M266 | Adaptive step budget by task effort | `agent-loop.ts` | 2h |
| M267 | Tool-trace genome capture + recall injection | `capture.ts`, `recall.ts`, `local-context.ts` | 4h |
| M268 | ashlrcode as `local-agent` fleet backend | `engine-registry.ts`, `router.ts` | 4h |
| M269 | Local verification loop + trust signal | `sandboxed-engine.ts`, proposal schema, judge prompt | 4h |

---

## Appendix: Key File References

| File | What it controls |
|------|-----------------|
| `src/core/run/engine-registry.ts:L186–198` | Kimi builtin spec (mid tier) |
| `src/core/run/engine-registry.ts:L333–351` | `applyNimConfig()` — pattern for Kimi promotion |
| `src/core/goals/advance.ts:L128` | Hardcoded frontier trio `['claude', 'codex', 'nim']` |
| `src/core/goals/advance.ts:L147–158` | `resolveFrontierEngines()` |
| `src/core/goals/advance.ts:L316–363` | `dispatchFrontierWithRotation()` round-robin |
| `src/core/fleet/router.ts:L193–198` | `isFrontierItem()` threshold (effort≥4 or score≥8) |
| `src/core/fleet/router.ts:L97` | `MID_PREFERENCE` order |
| `src/core/generative/invent.ts:L143–167` | `buildSystemPrompt()` NORTH-STAR injection |
| `src/core/generative/invent.ts:L340–360` | Flat `value=4, effort=3` normalization (the gap) |
| `src/core/run/sandboxed-engine.ts:L808` | `allowExec: false` for local-coder |
| `src/core/run/agent-loop.ts:L59–392` | ReAct loop — already real, not one-shot |
| `src/core/genome/recall.ts` | Keyword + embedding recall |
| `src/core/genome/capture.ts` | Fire-and-forget outcome capture |
| `src/core/ecosystem/map.ts:L152–201` | `northStarDocSummary()` + `ecosystemSummary()` |
| `src/core/vision/north-star.ts:L79–171` | `computeNorthStar()` leverage metric |
