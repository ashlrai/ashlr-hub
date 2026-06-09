# CONTRACT — M12: Contracts-First Swarm (`ashlr spec` + `ashlr swarm`)

This contract is binding. Implementation agents build AGAINST these exact
signatures and types. Each agent edits ONLY its own file(s). No agent commits;
the main loop commits/pushes. All new types live in `src/core/types.ts` (added
this milestone) — downstream modules MUST import them, never redefine.

## Types (already added to `src/core/types.ts`)

```ts
export interface SpecArtifact {
  id: string;
  goal: string;
  version: number;
  project: string | null;
  path: string;
  status: 'draft' | 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export type SwarmPhaseName = 'scaffold' | 'build' | 'integrate' | 'verify' | 'review';

export interface SwarmTaskSpec {
  id: string;
  phase: SwarmPhaseName;
  goal: string;
  deps: string[];
}

export interface SwarmTaskRun {
  id: string;
  phase: SwarmPhaseName;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
  usage?: RunUsage;
  error?: string;
}

export interface SwarmPlan {
  specId: string | null;
  goal: string;
  tasks: SwarmTaskSpec[];
}

export interface SwarmRun {
  id: string;
  goal: string;
  specId: string | null;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  budget: RunBudget;
  usage: RunUsage;
  parallel: number;
  status: 'planning' | 'running' | 'done' | 'aborted' | 'failed';
  plan: SwarmPlan;
  tasks: SwarmTaskRun[];
  result?: string;
}

export interface SwarmOptions {
  budget?: Partial<RunBudget>;
  parallel?: number;
  background?: boolean;
  resumeId?: string;
  dryRun?: boolean;
  allowCloud?: boolean;
  project?: string;
}
```

Reused existing types (DO NOT redefine): `AshlrConfig`, `RunBudget`,
`RunUsage`, `RunOptions`, `RunState`, `StreamSink` (from
`src/core/run/streaming.ts`: `export type StreamSink = (e: RunStreamEvent) => void`).

## Module signatures (EXACT)

### `src/core/spec/spec-store.ts`
```ts
import type { SpecArtifact, AshlrConfig } from '../types.js';

export function specsDir(project?: string): string;
export async function authorSpec(goal: string, cfg: AshlrConfig, opts?: { project?: string }): Promise<SpecArtifact>;
export function listSpecs(project?: string): SpecArtifact[];
export function loadSpec(id: string): { meta: SpecArtifact; body: string } | null;
export async function refineSpec(id: string, note: string, cfg: AshlrConfig): Promise<SpecArtifact>;
```
- `specsDir(project?)` → `<project>/.ashlr/specs` when project given, else a
  global default under `~/.ashlr/specs`. Created on demand.
- `authorSpec` uses the orchestrator's LOCAL-first provider to DRAFT a
  structured end-state spec (sections: Context, North Star, Operating
  Principles, Pillars, Roadmap/phases, Verification). Persists
  `<slug>-v1.md` + sidecar `<slug>-v1.json`. version=1, status='draft'.
- `listSpecs` → newest version per spec id, sorted by `updatedAt` desc.
- `loadSpec(id)` → highest version for that id, or null.
- `refineSpec` → reads current highest version, produces v+1 incorporating the
  note (model call), writes new `<slug>-v<N+1>.md` + sidecar. Never destructive.

### `src/core/swarm/planner.ts`
```ts
import type { SwarmPlan, AshlrConfig } from '../types.js';

export async function planSwarm(input: { goal: string; specBody?: string }, cfg: AshlrConfig): Promise<SwarmPlan>;
```
- Decomposes goal (+ optional spec body) into phases scaffold → build →
  integrate → verify → review using model + heuristics. Caps tasks per phase
  to <= 6. Build-phase tasks are independent (parallelizable); later phases
  depend on prior phases via `deps`. LOCAL-first.

### `src/core/swarm/runner.ts`
```ts
import type { SwarmRun, AshlrConfig, SwarmOptions } from '../types.js';
import type { StreamSink } from '../run/streaming.js';

export async function runSwarm(input: { goal: string; specId?: string }, cfg: AshlrConfig, opts: SwarmOptions, sink: StreamSink): Promise<SwarmRun>;
```
- Executes phases in order scaffold → build (parallel, capped by
  `opts.parallel`, default 3, max 8) → integrate → verify → review. Each task
  reuses `orchestrator.runGoal` (LOCAL-first; cloud only when
  `opts.allowCloud`). HARD total budget across the whole swarm (sum of all
  task usage); abort cleanly with partial state when exceeded.
- RECURSION GUARD: refuse to start if `process.env.ASHLR_IN_SWARM` is set;
  set `ASHLR_IN_SWARM=1` on every task subprocess. No swarm-within-swarm.
- NO OUTWARD/DESTRUCTIVE ACTION by default (no push/deploy/repo-create/
  `tidy --apply`/`ship --confirm`); code/build/test only.
- Resumable via `opts.resumeId`; persists the `SwarmRun` after every step via
  `store.saveSwarm`. Streams phase start/done, per-task start/done, burndown
  via `sink`.

### `src/core/swarm/store.ts`
```ts
import type { SwarmRun } from '../types.js';

export function swarmsDir(): string;            // ~/.ashlr/swarms
export function saveSwarm(s: SwarmRun): void;
export function loadSwarm(id: string): SwarmRun | null;
export function listSwarms(): SwarmRun[];
```

### `src/cli/spec.ts`
```ts
export async function cmdSpec(args: string[]): Promise<number>;
```
- Subcommands: `new "<goal>" [--project <path>]`, `list`, `show <id>`,
  `refine <id> "<note>"`. Returns process exit code.

### `src/cli/swarm.ts`
```ts
export async function cmdSwarm(args: string[]): Promise<number>;
export async function cmdSwarms(args: string[]): Promise<number>;
```
- `cmdSwarm`: `"<goal>" | <specId> [--budget N] [--parallel N] [--background]
  [--resume <id>] [--dry-run] [--allow-cloud] [--project <path>]`. Builds a
  `StreamSink` (reuse the M11 CLI sink pattern), parses `SwarmOptions`, calls
  `runSwarm`. `--background` launches a DETACHED worker (spawn detached,
  ignore stdio, unref) and returns the swarm id immediately. `--dry-run` plans
  only (no execution). REFUSE to start when `ASHLR_IN_SWARM` is set.
- `cmdSwarms`: list persisted swarms; `swarm show <id>` is routed via the
  swarm command dispatch.

## Guardrails (binding on all implementers)
- HARD total budget across the swarm; bounded concurrency (default 3, max 8);
  bounded tasks per phase (<= 6); no unbounded loops.
- LOCAL-first; cloud only with `--allow-cloud` and a key present.
- No recursion / fork bomb: `ASHLR_IN_SWARM` marker; refuse nested swarms.
- No outward/destructive action unless an explicit flag is passed.
- Preserve ALL existing behavior + the 1064 tests. No new runtime deps.
  phantom owns secrets; no secrets in env/argv/logs.
- Wire CLI dispatch + lazy loaders in `src/cli/index.ts` for `spec`, `swarm`,
  `swarms` following existing patterns.
