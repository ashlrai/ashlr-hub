# CONTRACT — M11: watchable, robust agent foundation

Status: CONTRACT ONLY. No implementations land in this milestone's contract step.
Each downstream agent edits ONLY its own file(s). No git commit (main loop commits/pushes).

All shared shapes live in `src/core/types.ts` (already added this step):
`RunStreamEvent`, `RetryPolicy`, `VerifyVerdict`, `EngineId`, `EngineCommand`.
Pre-existing M4 shapes referenced below: `RunTask`, `RunBudget`, `RunUsage`,
`ProviderClient`, `ChatMessage`, `ChatResult`, `AshlrConfig`.

GUARDRAILS (binding on every implementer):
- LOCAL-FIRST + BUDGET: every path stays under the hard token/step budget; retries
  are bounded; no unbounded loops. `verifyTask` does an optional model check ONLY
  when budget allows; heuristic-first.
- NO REAL DELEGATED AGENT RUNS in build/integrate/verify. Unit-test the engine ARG
  BUILDERS (assert exact argv) + the fallback. Exercise streaming/retry/verify with
  the BUILTIN local path against Ollama only, bounded (--max-steps<=2, tiny budget).
- phantom-exec must NEVER log secret values. `withToolEnv` stays allowlist (no secrets).
- Preserve M4 budget/usage/resume + M7 memory-injection + M10 env-bridge behavior and
  their tests. NO new runtime deps.

---

## 1. `src/core/run/engines.ts` (NEW FILE — engines agent)

Hardened per-engine adapters. Each engine maps a goal to its REAL CLI argv.

```ts
import type { AshlrConfig, EngineId, EngineCommand } from '../types.js';

/**
 * Build the EXACT external command for an engine, or null when the local builtin
 * loop must be used.
 *
 * Returns null when `engine === 'builtin'` (caller runs the local agent loop).
 * Returns a fully-resolved EngineCommand for 'ashlrcode' | 'aw' | 'claude'.
 *
 * The arg builders are the source of truth and MUST be unit-tested for exact argv.
 * Confirmed real CLIs (probed via --help where installed):
 *   - claude (INSTALLED): non-interactive print mode.
 *       bin 'claude', args ['-p', goal, '--model', <model>, '--output-format', 'json']
 *       (--model/--output-format only valid with -p/--print; json carries usage/cost).
 *   - aw (ashlr-workbench, INSTALLED): autonomous builder subcommand.
 *       bin 'aw', args ['auto', goal, '--cwd', <cwd>] (+ ['--model', <alias>] when model given).
 *   - ashlrcode (ABSENT here): real CLI is 'ac' (alias 'ashlrcode'). Build correct argv
 *       for when present; since absent the SPAWN path falls back to builtin (M9/M10),
 *       but this builder MUST still produce the correct argv.
 *
 * `opts.model` is the hub-selected model; `opts.cwd` the target dir (default process.cwd()).
 * This function is PURE: it does not spawn, probe PATH, or touch the network.
 */
export function buildEngineCommand(
  engine: EngineId,
  goal: string,
  cfg: AshlrConfig,
  opts?: { cwd?: string; model?: string },
): EngineCommand | null;

/**
 * Whether the engine's real binary is on PATH.
 * 'builtin' => always true. 'claude'|'aw' => their bin. 'ashlrcode' => 'ac' (or 'ashlrcode').
 * Best-effort, never throws; uses a cheap `which`/spawnSync probe.
 */
export function engineInstalled(engine: EngineId): boolean;

/**
 * Spawn a resolved EngineCommand and capture its result.
 *
 * - Applies withToolEnv(cfg) (M10 env-bridge; allowlist, NON-SECRET only) to the
 *   child env, including the hub-selected model (ASHLR_MODEL / AC_MODEL).
 * - Wraps via phantomWrap(cmd, cfg) when cfg.phantom?.enabled AND phantom installed,
 *   so phantom injects secrets safely (we never do). Best-effort: spawns normally
 *   when phantom is absent/disabled.
 * - Captures stdout as `output`. Parses tokens/cost from the tool's stdout/json when
 *   reported (e.g. claude --output-format json); else `usage` is omitted (caller estimates).
 * - Never throws; failures are reported via { ok:false, error }.
 * - MUST NOT be invoked against a real agent during build/integrate/verify.
 */
export function spawnEngine(
  cmd: EngineCommand,
  cfg: AshlrConfig,
): { ok: boolean; output: string; usage?: { tokensIn: number; tokensOut: number }; error?: string };

/**
 * Wrap an EngineCommand so it runs under `phantom exec -- <bin> <args...>`,
 * letting phantom inject secrets into the child. PURE arg transform:
 *   { bin:'phantom', args:['exec','--', cmd.bin, ...cmd.args], cwd: cmd.cwd }.
 * Caller decides whether to apply it (only when cfg.phantom?.enabled && installed).
 * NEVER logs secret values.
 */
export function phantomWrap(cmd: EngineCommand, cfg: AshlrConfig): EngineCommand;
```

---

## 2. `src/core/run/streaming.ts` (NEW FILE — streaming agent)

```ts
import type { RunStreamEvent } from '../types.js';

/** A sink that receives live run events. Never throws to the caller. */
export type StreamSink = (e: RunStreamEvent) => void;

/** A no-op sink (used when streaming is disabled or in tests). */
export function nullSink(): StreamSink;

/**
 * A sink that renders a live, readable stream for the CLI.
 * - opts.json === true  → human stream lines go to STDERR (stdout stays clean JSON).
 * - opts.json === false → readable lines go to STDOUT/STDERR for a TTY.
 * model-delta events render incrementally; lifecycle/retry/verify events render as lines.
 * NEVER prints secret values.
 */
export function makeCliSink(opts: { json: boolean }): StreamSink;
```

---

## 3. `src/core/run/retry.ts` (NEW FILE — retry agent)

```ts
import type { RetryPolicy } from '../types.js';

/**
 * Run `fn` with bounded exponential backoff.
 * - `fn` receives the 1-based attempt number.
 * - Retries ONLY while isRetryable(err) is true AND attempts < policy.maxAttempts.
 * - Backoff delay = policy.baseDelayMs * 2^(attempt-1) (bounded by maxAttempts; no jitter required).
 * - Rethrows the last error when attempts are exhausted or the error is non-retryable.
 * - Bounded by construction: NEVER loops more than policy.maxAttempts times.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  isRetryable: (e: unknown) => boolean,
): Promise<T>;
```

---

## 4. `src/core/run/verify.ts` (NEW FILE — verify agent)

```ts
import type { RunTask, ProviderClient, RunBudget, RunUsage, VerifyVerdict } from '../types.js';

/**
 * Judge whether `task.result` plausibly satisfies `task.goal`.
 *
 * Heuristic FIRST (method:'heuristic'): non-empty result, no error marker, looks
 * on-topic (cheap keyword/overlap vs the goal). If the heuristic is confident, return it.
 *
 * Optional cheap MODEL check (method:'model') ONLY when the heuristic is inconclusive
 * AND the budget allows (respects budget.maxTokens/maxSteps; mutates `usage` to account
 * for the check). NEVER exceeds the global budget; on budget-exhaustion, fall back to
 * the heuristic verdict. Never throws.
 */
export async function verifyTask(
  task: RunTask,
  client: ProviderClient,
  budget: RunBudget,
  usage: RunUsage,
): Promise<VerifyVerdict>;
```

---

## 5. `src/core/run/provider-client.ts` (EDIT — provider agent)

ADD a streaming method to the `ProviderClient` interface in `src/core/types.ts`
and implement it in both the Ollama and LM Studio clients.

`types.ts` — extend `ProviderClient`:
```ts
export interface ProviderClient {
  id: string;
  supportsTools: boolean;
  chat(messages: ChatMessage[], tools?: unknown[]): Promise<ChatResult>;
  /**
   * Streaming chat: invoke onDelta(textChunk) for each incremental content token,
   * resolving to the SAME ChatResult shape as chat() (final content + toolCalls + usage).
   * Falls back to chat() (single onDelta of the full content) when the provider/model
   * does not support streaming or streaming errors.
   *
   * OPTIONAL at the type level (`chatStream?`) so the contract typechecks before
   * the provider agent implements it. The provider agent makes it CONCRETE on both
   * the Ollama and LM Studio clients; callers `?.`-guard (fall back to chat()) until then.
   */
  chatStream?(
    messages: ChatMessage[],
    tools: unknown[] | undefined,
    onDelta: (t: string) => void,
  ): Promise<ChatResult>;
}
```

`provider-client.ts` — both `buildOllamaClient` and `buildLmStudioClient` implement:
```ts
async chatStream(
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  onDelta: (t: string) => void,
): Promise<ChatResult>;
```
- Ollama: POST /api/chat with `stream:true`; parse NDJSON lines, onDelta each
  `message.content` chunk; accumulate usage from the final `done` line.
- LM Studio: POST /v1/chat/completions with `stream:true`; parse SSE `data:` lines,
  onDelta each `choices[0].delta.content`; usage from the final chunk when present
  (else estimate, preserving existing estimateTokens fallback).
- On any streaming failure, delegate to `chat()` and emit its full content via one onDelta.
- Preserve existing tool-call parsing and the LOCAL-FIRST cloud guards.

---

## 6. `src/cli/run.ts` (EDIT — cli agent)

- Construct a `StreamSink`: `makeCliSink({ json })` when streaming is on, else `nullSink()`.
- Add flags `--stream` / `--no-stream`. DEFAULT: stream ON when stderr is a TTY
  (`process.stderr.isTTY`), OFF otherwise. Keep existing `--json` semantics:
  with `--json`, stdout stays clean machine JSON and the stream renders to STDERR.
- Pass the sink through `RunOptions` into the orchestrator (orchestrator agent threads
  it to the agent loop / engine delegation; out of scope for THIS file beyond wiring).
- Update the usage string to include `[--stream|--no-stream]`.
- Preserve all existing flags/behavior: `--budget --max-steps --parallel --engine`
  `--allow-cloud --no-tools --resume --json --no-memory --model`.

---

## Engine ARG-BUILDER reference (assert these EXACT argvs in unit tests)

| engine     | bin        | args (goal=`G`, model=`M`, cwd=`D`)                                  |
|------------|------------|----------------------------------------------------------------------|
| builtin    | —          | `buildEngineCommand` returns `null`                                  |
| claude     | `claude`   | `['-p', G, '--model', M, '--output-format', 'json']`                 |
| aw         | `aw`       | `['auto', G, '--cwd', D]` (+ `['--model', M]` when model provided)   |
| ashlrcode  | `ac`       | `['--goal', G]` style per ac's interface (ABSENT here → fallback)    |
| phantomWrap| `phantom`  | `['exec', '--', <orig.bin>, ...<orig.args>]`                         |

Notes:
- Omit `--model` when no model is selected (don't pass empty).
- claude json `--output-format json` is what lets `spawnEngine` capture tokens/cost;
  when usage is absent, the caller estimates (M4 estimateTokens).
- `ac` argv is built for when-present; absence routes to builtin per M9/M10.
