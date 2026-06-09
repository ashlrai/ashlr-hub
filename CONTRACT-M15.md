# CONTRACT — M15: cost-optimal, local-first model routing

Build against these EXACT signatures. Each agent edits ONLY its own file(s).
All types below are defined in `src/core/types.ts` (the contract) — import from
there; do NOT redefine. Preserve all existing behavior + 1396 tests. No new
runtime deps. No git commit. Cost numbers are ESTIMATES, clearly labeled.

## Guardrails (non-negotiable)

- LOCAL-FIRST, NO SILENT CLOUD: `chooseRoute` returns a CLOUD route ONLY when
  ALL of: `opts.allowCloud === true` AND `cloudKeyAvailable(provider) === true`
  AND `opts.lastReason !== 'none'` (a real escalation reason). Otherwise the
  decision is always a LOCAL route (tier `'local'`).
- NO AUTO-DOWNLOAD / NO AUTO-START during routing or runs. `pullModel` runs an
  `ollama pull` ONLY from the explicit `ashlr models pull <name>` path (with a
  confirm in the CLI). `startOllama` only starts a LOCAL installed Ollama,
  bounded + best-effort, and only from `ashlr models start`.
- Every run/swarm remains bounded by the existing hard budget (`RunBudget`).
- No secrets in logs/env. Cloud key presence is detected via env only; never
  print the value.

## Contract types (in `src/core/types.ts`)

```ts
export type ModelTier = 'local' | 'cloud';

export interface RouteDecision {
  provider: string;
  model: string;
  tier: ModelTier;
  reason: string;
}

export interface RoutingRule {
  match: string;
  model: string;
}

export type EscalationReason = 'task-failed' | 'verify-failed' | 'latency' | 'none';

export interface LocalModelInfo {
  provider: 'ollama' | 'lmstudio';
  name: string;
  sizeLabel?: string;
  active: boolean;
}

export interface CostForecast {
  window: string;
  spentUsd: number;
  localSavingsUsd: number;
  projectedMonthlyUsd: number;
}
```

`AshlrConfig.models` is extended (existing fields unchanged):

```ts
models: {
  lmstudio: string;
  ollama: string;
  providerChain: string[];
  routing?: RoutingRule[];
  escalate?: { onFailure: boolean; latencyMs?: number };
};
```

## `src/core/run/router.ts` (NEW — router agent)

```ts
export async function chooseRoute(
  taskGoal: string,
  cfg: AshlrConfig,
  opts: { allowCloud: boolean; attempt: number; lastReason: EscalationReason },
): Promise<RouteDecision>;

export function cloudKeyAvailable(provider: string): boolean;

export function wouldBeCloudCost(tokensIn: number, tokensOut: number): number;
```

- `chooseRoute`: local-first. Apply `cfg.models.routing` rules (first match on
  `taskGoal` wins) to pick a preferred model, else select the best available
  LOCAL model per `cfg.models.providerChain` (reuse `provider-client.ts`
  `getActiveClient` / `pickModel`). Returns a CLOUD `RouteDecision` ONLY when
  `opts.allowCloud && opts.lastReason !== 'none' && cloudKeyAvailable(<cloud
  provider>)`; otherwise a LOCAL decision. `reason` explains the choice
  (rule match, local-first default, or escalation cause).
- `cloudKeyAvailable`: true iff the env API key for `provider` is present
  (e.g. ANTHROPIC_API_KEY / OPENAI_API_KEY). Detection only; never logs value.
- `wouldBeCloudCost`: estimate USD for the same token counts on a representative
  cloud model. Reuse `core/run/budget.ts` `estCostUsd`. Clearly an estimate.

## `src/core/run/model-manager.ts` (NEW — model-manager agent)

```ts
export async function listLocalModels(cfg: AshlrConfig): Promise<LocalModelInfo[]>;

export function ollamaInstalled(): boolean;

export async function pullModel(name: string): Promise<{ ok: boolean; detail: string }>;

export async function startOllama(): Promise<{ ok: boolean; detail: string }>;
```

- `listLocalModels`: probe Ollama (:11434 `/api/tags`) and LM Studio (:1234),
  reusing `provider-client.ts`. Mark `active` per `cfg.models.ollama` /
  `cfg.models.lmstudio`. Never throws — unreachable providers yield no entries.
- `ollamaInstalled`: detect the `ollama` binary on PATH (sync, no spawn of work).
- `pullModel`: EXPLICIT only. Runs `ollama pull <name>`; returns `{ok,detail}`.
  Never invoked from routing/runs.
- `startOllama`: best-effort start of a LOCAL installed Ollama only; bounded;
  `{ok,detail}`. No-op `{ok:false,...}` when not installed.

## `src/core/observability/forecast.ts` (NEW — forecast agent)

```ts
export function buildForecast(window: '7d' | '30d', cfg: AshlrConfig): CostForecast;
```

- Reuse `core/observability/rollup.ts` `buildRollup` + cost helpers. `spentUsd`
  from the window's actual usage (local=$0). `localSavingsUsd` from
  `wouldBeCloudCost` over the window's local tokens. `projectedMonthlyUsd`
  extrapolates the window rate to ~30 days. Estimates, clearly labeled.

## `src/cli/models.ts` (NEW — cli agent)

```ts
export async function cmdModels(args: string[]): Promise<number>;
```

- `ashlr models` (no args): list local models via `listLocalModels`, marking
  active/default. Reuse `cli/ui.ts`.
- `ashlr models pull <name>`: EXPLICIT management. Confirm (large download),
  then `pullModel`. Honor `--yes` to skip the prompt.
- `ashlr models start`: `startOllama` (best-effort, local installed only).
- Returns a process exit code. Register in `src/cli/index.ts`.

## `src/core/run/orchestrator.ts` (EDIT — orchestrator agent)

- Per task, call `chooseRoute(task.goal, cfg, {allowCloud, attempt, lastReason})`
  to select provider+model BEFORE the attempt; thread the resulting model into
  the existing M11 attempt path.
- On task failure / verify-fail (M11 `VerifyVerdict.ok === false`) OR latency
  over `cfg.models.escalate?.latencyMs`, set `lastReason` accordingly and
  perform the M11 retry as a ROUTED retry (escalation = a routed retry). Cloud
  escalation gated exactly by `chooseRoute`'s rule (allowCloud + key + reason).
  Otherwise stay local / mark needs-attention. All bounded by `RunBudget`.
- Attribute cost per provider (local=$0) into existing `RunUsage`.

## Surfacing (pulse / summaries — observability + cli agents)

- `ashlr pulse` + run summaries show a savings + forecast line from
  `buildForecast` (e.g. "this run $0.00 local; cloud would've been ~$X;
  projected monthly ~$Y"). Estimates clearly labeled.
