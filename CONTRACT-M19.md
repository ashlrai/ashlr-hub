# CONTRACT — M19: Real telemetry (OTLP) + spend governance

Build against THIS contract. Each agent edits ONLY its own file(s). No new runtime
deps (use `node:http`/`node:https` + builtin `fetch` only). Preserve all existing
behavior and the 1899 passing tests. Do NOT `git commit`.

All shapes below are defined in `src/core/types.ts` (the contract module). Import
them from there — never redefine.

```ts
// src/core/types.ts — ADDED by the contract agent (existing types unchanged):

export interface GenAiSpan {
  name: string;        // operation/task identifier — METADATA, not content
  runId: string;       // owning run/swarm id
  model: string;       // gen_ai.request.model
  provider: string;    // gen_ai.system
  tier: string;        // routing tier label
  tokensIn: number;    // gen_ai.usage.input_tokens
  tokensOut: number;   // gen_ai.usage.output_tokens
  estCostUsd: number;  // estimated USD cost for the span
  status: string;      // 'done' | 'failed' | 'aborted' | ...
  startTs: string;     // ISO
  endTs: string;       // ISO
}

export interface TelemetryEmitResult {
  sink: 'local' | 'otlp';
  ok: boolean;
  detail: string;      // NEVER the PAT, prompts, or content
}

export interface GovernanceStatus {
  level: 'ok' | 'warn' | 'over';  // ok <80% cap, warn >=80% cap, over >cap
  spentUsd: number;
  capUsd: number | null;          // null when no cap configured
  window: string;
  message: string;
}

// cfg.telemetry EXTENDED with one optional field (default 'warn'):
//   govAction?: 'warn' | 'block'
// cfg.telemetry already has: pulse?, budgetUsd?, budgetTokens?, budgetWindow?
```

## EXACT SIGNATURES

### `src/core/observability/otlp.ts`
```ts
import type { GenAiSpan, RunState, SwarmRun } from '../types.js';

export function buildGenAiTrace(spans: GenAiSpan[]): object;
export function spansFromRun(run: RunState): GenAiSpan[];
export function spansFromSwarm(s: SwarmRun): GenAiSpan[];
```
- `buildGenAiTrace` returns a valid OTLP/HTTP-JSON traces payload:
  `{ resourceSpans: [ { resource:{attributes:[...]}, scopeSpans:[ { scope:{name,version}, spans:[...] } ] } ] }`.
- Each span carries GenAI semantic-convention attributes ONLY (metadata):
  `gen_ai.system` (provider), `gen_ai.request.model` (model),
  `gen_ai.usage.input_tokens` (tokensIn), `gen_ai.usage.output_tokens` (tokensOut),
  a cost attribute (e.g. `gen_ai.usage.cost_usd` = estCostUsd), `ashlr.run.id` (runId),
  `ashlr.provider`, `ashlr.tier`, plus span `status`, and `startTimeUnixNano`/
  `endTimeUnixNano` derived from startTs/endTs.
- PRIVACY: span attributes are METADATA ONLY. NEVER include prompt/response text,
  tool args, file contents, goal text beyond an id-like `name`, or any secret.
- `spansFromRun`/`spansFromSwarm` derive one span per executed task from the
  task `usage` (tokensIn/tokensOut/estCostUsd), `status`, ids, and run/swarm
  `provider`/timestamps. Pure functions; no I/O.

### `src/core/observability/telemetry-sink.ts`
```ts
import type { AshlrConfig, GenAiSpan, TelemetryEmitResult } from '../types.js';

export interface TelemetrySink {
  emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult>;
}

export function getSink(cfg: AshlrConfig): TelemetrySink;       // OtlpHttpSink if cfg.telemetry.pulse && patAvailable(cfg), else LocalFileSink
export function patAvailable(cfg: AshlrConfig): boolean;        // boolean ONLY — phantom or ASHLR_PULSE_TOKEN env; NEVER returns the value
export function localTelemetryDir(): string;                    // ~/.ashlr/telemetry
```
- `LocalFileSink` (default): appends spans/summaries as JSONL under
  `localTelemetryDir()` (`~/.ashlr/telemetry/*.jsonl`) — what `ashlr pulse`
  already aggregates locally. Returns `{ sink:'local', ok, detail }`.
- `OtlpHttpSink`: `buildGenAiTrace(spans)` -> POST JSON to `cfg.telemetry.pulse`
  (the OTLP traces endpoint) with `Authorization: Bearer <PAT>` and
  `Content-Type: application/json`. Bounded timeout; fire-and-forget;
  best-effort. Returns `{ sink:'otlp', ok, detail }`. On failure: `ok:false`,
  detail logged to stderr only — NEVER throws, NEVER blocks the caller.
- `patAvailable` resolves the PAT from phantom (preferred) or `ASHLR_PULSE_TOKEN`
  env and returns a BOOLEAN ONLY. The PAT value is NEVER returned here, never
  logged, never printed, never placed in span attrs or `detail`. The PAT is read
  internally by `OtlpHttpSink` solely to populate the Authorization header.
- `getSink` chooses OtlpHttpSink ONLY when `cfg.telemetry.pulse` is set AND
  `patAvailable(cfg)` is true; otherwise LocalFileSink (default = 100% local).

### `src/core/observability/governance.ts`
```ts
import type { AshlrConfig, GovernanceStatus } from '../types.js';

export function evalGovernance(cfg: AshlrConfig): GovernanceStatus;
```
- Reuse `buildForecast`/`buildRollup` (M5/M15) to compute window spend vs
  `cfg.telemetry.budgetUsd` over `cfg.telemetry.budgetWindow`.
- `level`: `ok` (<80% of cap), `warn` (>=80%), `over` (>cap). When no cap is set,
  `capUsd:null` and `level:'ok'`. Pure-ish (reads local rollup only); never throws.

### `src/cli/telemetry.ts`
```ts
export async function cmdTelemetry(args: string[]): Promise<number>;  // 'status' | 'test'
```
- `status`: prints whether an OTLP endpoint AND a PAT are configured — as
  BOOLEANS (`patAvailable(cfg)`), never the PAT value or endpoint secret;
  shows the active sink ('local' | 'otlp') and governance summary.
- `test`: best-effort emit of a synthetic metadata-only span through `getSink(cfg)`
  and reports the `TelemetryEmitResult`. Returns a process exit code.

### orchestrator + swarm (`src/core/run/orchestrator.ts`, `src/core/swarm/runner.ts`)
- REPLACE the M9 bespoke `reportToPulse` with:
  `getSink(cfg).emit(spansFromRun(run))` / `getSink(cfg).emit(spansFromSwarm(s))`.
- OPT-IN + BEST-EFFORT: emit runs ONLY after the run/swarm completes; it is
  fire-and-forget with a bounded timeout, NEVER blocks/slows/throws the run/swarm;
  failures log to stderr only. Default (no `cfg.telemetry.pulse` / no PAT) =
  LocalFileSink, 100% local.
- SPEND GOVERNANCE: on run/swarm, call `evalGovernance(cfg)`; on `level:'over'`
  print a prominent advisory warning. When `cfg.telemetry.govAction === 'block'`,
  require `--over-budget` to proceed (governance still does NOT silently block —
  it warns and gates only behind an explicit flag). The per-run HARD budget
  remains the only hard ceiling.

## GLOBAL GUARDRAILS (apply to every file above)
- PRIVACY: span attributes / JSONL records are METADATA ONLY — model, token
  counts, cost, ids, provider, tier, status, duration. NEVER prompt/response
  text, tool args, file contents, or secrets.
- PAT/SECRET SAFETY: the PAT lives ONLY in the Authorization header. It is NEVER
  logged, printed, returned by `patAvailable`, placed in span attrs/`detail`, or
  committed. Source: phantom (preferred) or `ASHLR_PULSE_TOKEN` env.
- OTLP emit is OPT-IN (endpoint + PAT both present) and BEST-EFFORT (bounded
  timeout, fire-and-forget, never blocks/throws). Default is LocalFileSink.
- No new runtime deps; `node:http`/`node:https` + builtin `fetch` only. Do not
  break existing behavior or the 1899 tests. Do not `git commit`.
