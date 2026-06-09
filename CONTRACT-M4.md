# CONTRACT-M4 — `ashlr run` local-first agent orchestrator

This is THE contract for Milestone 4. Each build agent writes ONLY its file(s),
imports types from `src/core/types.ts`, and implements the EXACT signatures
below. Zero new runtime deps (reuse `@modelcontextprotocol/sdk` + Node builtins).
All `.js` import extensions (NodeNext ESM). No commits.

## Shared types (already added to `src/core/types.ts`)

```ts
RunBudget   { maxTokens:number; maxSteps:number; allowCloud:boolean }
RunUsage    { tokensIn:number; tokensOut:number; steps:number; estCostUsd:number }
RunTaskStatus = 'pending'|'running'|'done'|'failed'|'skipped'
RunTask     { id:string; goal:string; deps:string[]; status:RunTaskStatus; result?:string; usage?:RunUsage; error?:string }
RunStep     { ts:string; taskId:string; kind:'plan'|'model'|'tool'|'synthesize'; summary:string; usage?:RunUsage }
RunState    { id:string; goal:string; engine:string; provider:string; createdAt:string; updatedAt:string;
              budget:RunBudget; usage:RunUsage; tasks:RunTask[]; steps:RunStep[];
              status:'running'|'done'|'aborted'|'failed'; result?:string }
RunOptions  { budget?:Partial<RunBudget>; parallel?:number; engine?:string; tools?:boolean;
              allowCloud?:boolean; resumeId?:string; json?:boolean }
ChatMessage { role:'system'|'user'|'assistant'|'tool'; content:string; toolCallId?:string; name?:string }
ChatResult  { content:string; toolCalls?:{id:string;name:string;arguments:unknown}[]; usage:{tokensIn:number;tokensOut:number} }
ProviderClient (interface) { id:string; supportsTools:boolean; chat(messages:ChatMessage[], tools?:unknown[]):Promise<ChatResult> }
```

---

## `src/core/run/provider-client.ts`

```ts
import type { AshlrConfig, ProviderClient } from '../types.js';

/**
 * Build a chat client over the ACTIVE LOCAL provider for `cfg`.
 *
 * - Resolves the active provider via core/providers.ts
 *   (getProviderRegistry / resolveActiveProvider).
 * - LOCAL-FIRST: if the only available/active provider is a CLOUD provider
 *   (e.g. anthropic/openai/gemini/...) and opts.allowCloud is false, THROW a
 *   clear Error explaining the run is local-first and how to opt in
 *   (--allow-cloud). When allowCloud is true, a cloud client requires the
 *   relevant API key to be present (else also throw).
 * - Ollama: chat via POST <ollamaUrl>/api/chat (native). Detect tool support
 *   for capable models; degrade to plain chat when tools are unsupported.
 * - LM Studio: chat via POST <lmstudioUrl>/v1/chat/completions (OpenAI shape).
 * - supportsTools reflects detected capability of the resolved provider/model.
 * - chat() returns approximate token usage (use estimateTokens when the
 *   provider omits usage counts).
 */
export async function getActiveClient(
  cfg: AshlrConfig,
  opts: { allowCloud: boolean },
): Promise<ProviderClient>;

/** Approximate token count for a string (~4 chars/token heuristic). */
export function estimateTokens(text: string): number;
```

---

## `src/core/run/budget.ts`

```ts
import type { RunUsage, RunBudget } from '../types.js';

/** Fresh zeroed usage: { tokensIn:0, tokensOut:0, steps:0, estCostUsd:0 }. */
export function newUsage(): RunUsage;

/** Return a NEW RunUsage = a + b (b partial; missing fields treated as 0). Pure. */
export function addUsage(a: RunUsage, b: Partial<RunUsage>): RunUsage;

/** True when usage has reached/exceeded budget: (tokensIn+tokensOut) >= maxTokens OR steps >= maxSteps.
 *  Uses >= (conservative): once the ceiling is hit we stop BEFORE attempting another step. */
export function overBudget(usage: RunUsage, budget: RunBudget): boolean;

/** Estimated USD cost. LOCAL providers (ollama/lmstudio) return 0. */
export function estCostUsd(provider: string, tokensIn: number, tokensOut: number): number;
```

---

## `src/core/run/agent-loop.ts`

```ts
import type { RunTask, RunStep, RunBudget, RunUsage, ProviderClient } from '../types.js';

/**
 * Execute a single RunTask to completion using `client`.
 *
 * - Runs a bounded chat loop. When ctx.tools is present AND client.supportsTools,
 *   the loop may issue tool calls and feed results back (role:'tool' messages);
 *   otherwise plain chat.
 * - Accumulates per-step usage into ctx.usage (mutated in place via addUsage),
 *   and emits one RunStep per step through ctx.onStep (kind 'model' | 'tool').
 * - HARD STOP: before/after each step, if overBudget(ctx.usage, ctx.budget),
 *   stop the loop. Set task.status='failed' with a budget error if no result
 *   was produced, else 'done' with the partial result.
 * - On success sets task.status='done', task.result=<text>, task.usage=<delta>.
 *   On model/tool error sets task.status='failed', task.error=<message>.
 * - Returns the SAME task object (mutated) for convenience.
 */
export async function runTask(
  task: RunTask,
  client: ProviderClient,
  ctx: {
    tools?: unknown[];
    budget: RunBudget;
    usage: RunUsage;
    onStep: (s: RunStep) => void;
  },
): Promise<RunTask>;
```

---

## `src/core/run/orchestrator.ts`

```ts
import type { AshlrConfig, RunTask, RunState, RunOptions, ProviderClient } from '../types.js';

/**
 * PLANNING call: decompose `goal` into a RunTask[] DAG via one chat call to
 * `client`. Each task gets a unique id, a sub-goal, and deps[] referencing
 * other task ids (deps form a valid DAG — no cycles). status starts 'pending'.
 * On parse failure, fall back to a single task whose goal is the original goal.
 */
export async function planGoal(goal: string, client: ProviderClient): Promise<RunTask[]>;

/**
 * Top-level driver. Builds/loads RunState, plans (unless resuming), then
 * executes the DAG: independent ready tasks run in parallel up to
 * (opts.parallel ?? default). Enforces the HARD budget — abort cleanly when
 * overBudget (status='aborted', partial results preserved). Persists RunState
 * via saveRun after EACH step. When --resume, completed tasks load from cache
 * and are NOT re-run. Synthesizes a final answer into state.result and sets
 * status='done' on success. Best-effort POST of a run summary to Pulse if
 * cfg.telemetry.pulse is set (never blocks / never throws).
 *
 * Defaults: budget { maxTokens, maxSteps } and parallel have sane built-in
 * defaults; engine defaults to 'builtin'. 'ashlrcode' / 'aw' engines delegate
 * only when that binary is installed (else fall back to 'builtin' with a note).
 */
export async function runGoal(goal: string, cfg: AshlrConfig, opts: RunOptions): Promise<RunState>;

/** Load a persisted run by id from ~/.ashlr/runs/<id>.json, or null if absent/invalid. */
export function loadRun(id: string): RunState | null;

/** List all persisted runs (newest first by createdAt) from ~/.ashlr/runs/. */
export function listRuns(): RunState[];

/** Persist RunState atomically to ~/.ashlr/runs/<id>.json (mkdir -p the dir). */
export function saveRun(s: RunState): void;
```

Persistence rules: writes ONLY under `~/.ashlr/runs/`. Never touch repos or
Desktop. No git operations.

---

## `src/cli/run.ts`

```ts
/**
 * `ashlr run "<goal>" [--budget N] [--max-steps N] [--parallel N]
 *   [--engine builtin|ashlrcode|aw] [--allow-cloud] [--no-tools]
 *   [--resume <id>] [--json]`
 *
 * Also handles the subcommand `ashlr run show <id>` (print one run).
 *
 * Parses args into RunOptions, calls runGoal (or loads via loadRun for `show`),
 * prints a human cost/usage summary (or JSON when --json), and returns a process
 * exit code: 0 ok, non-zero on abort/failure/usage error.
 */
export async function cmdRun(args: string[]): Promise<number>;

/**
 * `ashlr runs` — list past runs (id, status, goal, tokens, cost). Honors --json.
 * Returns a process exit code (0 ok).
 */
export async function cmdRuns(args: string[]): Promise<number>;
```

CLI wiring: `src/cli/index.ts` dispatches `run` -> `cmdRun`, `runs` -> `cmdRuns`
(the index owner adds the dispatch; run.ts only exports the two functions).

---

## Safety guardrails (binding on all M4 files)

- LOCAL-FIRST: never call a cloud endpoint unless `allowCloud` AND the key is
  present; default refuses with a clear message (enforced in `getActiveClient`).
- Budget is a HARD ceiling — exceeding `maxTokens` or `maxSteps` aborts the run;
  partial results are preserved in RunState.
- Resumability writes ONLY under `~/.ashlr/runs/`; never repos/Desktop; no commits.
- Tests/smoke: prefer a MOCKED ProviderClient for determinism; live calls use
  tiny `--max-steps`/`--budget` + short timeouts; `--no-tools` (or a mock gateway)
  to avoid spawning the full downstream gateway.
- Zero new runtime deps. Reuse `@modelcontextprotocol/sdk` and Node builtins.
