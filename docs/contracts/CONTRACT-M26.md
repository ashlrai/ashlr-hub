# CONTRACT-M26 — Self-Improvement / Meta-Learning (`ashlr reflect`)

Status: CONTRACT + SCAFFOLD. This file defines exact module boundaries,
signatures, the CLI surface, and the five HARD safety invariants every M26 agent
MUST build against. The type definitions and compiling stubs already exist
(`src/core/learn/*`, `src/cli/reflect.ts`, types in `src/core/types.ts`). The
Build/Integrate phase fills the `TODO(build)` bodies and wires the dispatcher.

Ashlr v2 pillar D. `ashlr reflect` is a reflection loop that scores the org's
OWN past runs/swarms, distills playbooks, proposes routing/policy/prompt tuning,
and reports "the org got X% more effective / Y% cheaper this week". It COMPOUNDS
over time: each run persists a snapshot under `~/.ashlr/learn/` that the next run
diffs against.

---

## Module boundaries (`src/core/learn/`)

### `store.ts` — snapshot persistence (the ONLY writer under `~/.ashlr/learn/`)

```ts
export function reportsDir(): string;                       // ~/.ashlr/learn/reports
export function saveReport(report: ReflectionReport): string | null;
export function listReports(): ReflectionReport[];          // most-recent first, bounded (MAX_REPORTS=200)
export function loadPreviousReport(before?: string): ReflectionReport | null;
```

- `reportsDir()` = `join(learnDir(), 'reports')` where `learnDir()` (added to
  `src/core/config.ts`) = `join(CONFIG_DIR, 'learn')`.
- `saveReport` writes one pretty-printed `ReflectionReport` per run to
  `reportsDir()/<epoch-ms>.json` via atomic tmp-write + rename (mirrors
  `core/swarm/store.ts` / `core/inbox/store.ts`). Returns the path or null.
- `loadPreviousReport(before)` returns the newest snapshot strictly before
  `before` (so a just-saved current report isn't compared to itself) — the prior
  used for week-over-week deltas.
- Never throws; the ONLY filesystem destination is under `~/.ashlr/learn/`.

### `reflect.ts` — deterministic metrics engine (NO LLM, NO NETWORK)

```ts
export const DEFAULT_MAX_RUNS = 100;
export function classifyGoal(goal: string): 'feature'|'bugfix'|'refactor'|'test'|'docs'|'chore'|'other';
export function normalizeErrorKey(error: string): string;
export function clusterFailures(swarms: SwarmRun[]): FailureMode[];
export function summarizeGoalCategories(swarms: SwarmRun[]): GoalCategoryStat[];
export function computeDelta(
  current: Pick<ReflectionReport, 'successRate'|'avgCostUsd'|'localShare'>,
  previous: ReflectionReport | null,
): ReflectionDelta;
export function buildReflection(cfg: AshlrConfig, opts?: ReflectionOptions): ReflectionReport;
```

`buildReflection` composes — READ-ONLY — `listSwarms()` (capped to the most
recent `maxRuns` and/or `sinceMs`), `collectUsageEvents(sinceMs)` +
`isLocalProviderModel(model)` (local-vs-cloud share), and `genomeHealth(cfg)`.
It computes: success rate (`done` vs `failed`/`aborted`), avg cost & tokens per
swarm, local share, top clustered failure modes (`clusterFailures`), slowest /
most-expensive goal categories (`summarizeGoalCategories`), and week-over-week
deltas (`computeDelta` vs `loadPreviousReport`). **NO LLM in this function.** It
makes ZERO network connections and never throws (zeroed report on failure).

### `playbooks.ts` — distill SUCCESSFUL patterns -> genome

```ts
export interface DistilledPlaybook { category; title; text; tags; supportCount }
export interface PlaybookResult { playbooks: DistilledPlaybook[]; persisted: GenomeEntry[]; local: boolean }
export function distillPlaybooks(swarms: SwarmRun[]): DistilledPlaybook[];   // pure
export function distillAndPersist(
  cfg: AshlrConfig,
  opts?: { maxRuns?: number; narrative?: boolean; allowCloud?: boolean },
): Promise<PlaybookResult>;
```

Mines recurring patterns from `done` swarms; persists each via
`appendHubEntry({ text, title, tags, hubOnly: true })` so playbooks auto-inject
into future agents. `hubOnly: true` guarantees NO file is written into a user
repo working tree. Optional narrative polish routes through
`getActiveClient(cfg, { allowCloud })` EXACTLY as M25 `ask.ts` — local-only
unless `allowCloud` AND a key exist; deterministic fallback otherwise. Never
throws. MUST NOT call `saveConfig()` / write `CONFIG_PATH` / router policy.

### `tuning.ts` — PROPOSAL-ONLY suggestions (the inbox is the SOLE sink)

```ts
export function deriveTuning(report: ReflectionReport): TuningProposal[];     // pure, deterministic
export function emitTuningProposals(suggestions: TuningProposal[]): Proposal[];
```

`deriveTuning` reads the report (e.g. high `localShare` + zero cloud escalations
-> "raise local-first threshold"; a category succeeding first-try -> "lower
retry cap on phase X"; a recurring failure cluster -> "add a playbook for
failure Y"). `emitTuningProposals` is the ONLY outward sink: each suggestion ->
`createProposal({ repo: null, origin: 'manual', kind: 'note', title, summary })`
(status `pending`). `kind: 'note'` is a no-op record — applying it mutates
NOTHING. There is NO path here that writes `CONFIG_PATH` / `saveConfig()` /
router policy / prompts. Never throws.

---

## CLI surface (`src/cli/reflect.ts`)

```ts
export async function cmdReflect(args: string[]): Promise<number>;  // 0 ok, 1 error, 2 bad usage
```

| Invocation | Behavior |
| --- | --- |
| `ashlr reflect` | Build + persist the report; print human-readable summary. |
| `ashlr reflect --since <7d\|30d>` | Restrict analysis to the last N days. |
| `ashlr reflect --json` | Emit the `ReflectionReport` as JSON. |
| `ashlr reflect playbooks` | Distill recurring SUCCESSFUL patterns + persist to genome. |
| `ashlr reflect propose` | Emit derived tuning as PENDING inbox proposals. |
| `--allow-cloud` | Allow a cloud model for OPTIONAL narrative/playbook text only. OFF by default; mirrors M25. Prints the same cloud warning shape as `ask.ts`. |

Lazy-imports the M26 core (graceful "module not yet built" degradation), mirrors
`cli/ask.ts` arg-parsing / `--allow-cloud` warning / `--json` conventions.

### REQUIRED integration step (owned by Build/Integrate, NOT this scaffold)

`src/cli/index.ts` MUST add, matching the existing `lazyCmd`/`cmdHelp` pattern:

```ts
const loadReflectCmd = lazyCmd(
  () => import('./reflect.js'),
  (m) => m.cmdReflect as Cmd,
  'reflect command requires src/cli/reflect.ts (M26 module not yet built).',
);
// dispatch switch:
case 'reflect': {
  const cmdReflect = await loadReflectCmd();
  process.exitCode = await cmdReflect(rest);
  break;
}
// cmdHelp() cmds[] entries:
['reflect [--since 7d|30d]',  'Score past swarms/usage; report effectiveness + cost deltas (read-only).'],
['reflect playbooks',         'Distill recurring SUCCESSFUL patterns into the genome (auto-inject).'],
['reflect propose',           'Emit routing/policy/prompt tuning as PENDING inbox proposals.'],
```

---

## Shared types (added to `src/core/types.ts`)

```ts
export interface ReflectionReport {
  generatedAt: string;              // ISO time of generation
  since: string;                    // ISO lower bound of the window
  window: string | null;            // '7d'/'30d' when from --since, else null
  swarmsAnalyzed: number;
  swarmsDone: number;
  swarmsFailed: number;             // failed + aborted
  successRate: number;              // 0..1
  avgCostUsd: number;
  avgTokens: number;                // mean (tokensIn+tokensOut) per swarm
  totalCostUsd: number;
  localShare: number;               // 0..1 of token usage on LOCAL providers
  topFailures: FailureMode[];
  goalCategories: GoalCategoryStat[];
  delta: ReflectionDelta;           // week-over-week vs prior snapshot
  genome: GenomeHealth;
  narrative?: string;               // OPTIONAL LLM text; ABSENT on default path
  narrativeLocal?: boolean;         // true when narrative came from a LOCAL model
}

export interface FailureMode { key; label; count: number; phases: string[]; exampleSwarmIds: string[] }
export interface GoalCategoryStat { category; swarms; avgCostUsd; avgTokens; successRate }
export interface ReflectionDelta { previousAt: string|null; effectivenessPct: number|null; costPct: number|null; localSharePct: number|null; headline: string }
export interface TuningProposal { key; area: 'routing'|'policy'|'prompt'|'playbook'; title; rationale; confidence: number }
export interface ReflectionOptions { sinceMs?: number; maxRuns?: number; window?: string|null }
```

Reused unchanged: `SwarmRun`, `SwarmTaskRun`, `RunUsage`, `UsageEvent`,
`GenomeEntry`, `LearnInput`, `GenomeHealth`, `Proposal`, `ProposalStatus`,
`ProposalKind`.

---

## The 5 HARD safety invariants (verbatim) + enforcement + proof

**1. READ-ONLY over history.** reflect only READS swarm history, genome, and
usage/telemetry. It writes ONLY under `~/.ashlr/learn/` (reports, snapshots) and
— only on an explicit propose action — to the Approval Inbox via
`createProposal()`. It NEVER mutates a user repo, never touches working trees.
- *Enforced:* `reflect.ts` calls only `listSwarms()` / `genomeHealth()` /
  `collectUsageEvents()` (all read-only, all bounded, all never-throw). The sole
  fs writer is `store.ts`, scoped to `reportsDir()` under `learnDir()`.
  `playbooks.ts` writes only via `appendHubEntry({ hubOnly: true })` (genome hub
  append; no repo file). No `writeFileSync`/`mkdirSync` targets any path outside
  `~/.ashlr/`.
- *Verifier proves:* grep `src/core/learn` + `src/cli/reflect.ts` for
  `writeFileSync`/`appendFileSync`/`renameSync`/`mkdirSync` — every hit resolves
  under `learnDir()`/`reportsDir()`; assert no path joins a `cfg.roots` /
  project / working-tree path. Assert `appendHubEntry` is always called with
  `hubOnly: true`. A tmpdir test runs every command and asserts the fixture repo
  + working tree are byte-identical afterward.

**2. PROPOSAL-ONLY tuning.** reflect NEVER auto-mutates config.json, router
policy, prompts, or any setting. Derived routing/policy/prompt tuning
suggestions are emitted as Approval Inbox PROPOSALS (status pending) requiring
explicit human approval, OR printed in the report. There must be NO code path
where `ashlr reflect` writes to CONFIG_PATH / saveConfig() / router config.
Grep-prove this.
- *Enforced:* the ONLY outward sink in `tuning.ts` is `createProposal(...)` with
  `kind: 'note'` (no-op) and `status: 'pending'` (createProposal hard-codes
  pending). No M26 file imports `saveConfig` or the router config writer.
- *Verifier proves:* `grep -rn 'saveConfig\|CONFIG_PATH\|router.*policy' src/core/learn src/cli/reflect.ts`
  returns ZERO hits. `grep -rn 'createProposal' src/core/learn` shows it only in
  `tuning.ts`. A test asserts `~/.ashlr/config.json` is byte-identical before/
  after `ashlr reflect propose`, and that created proposals are
  `status==='pending'` and `kind==='note'`.

**3. LOCAL-FIRST.** The METRICS core is deterministic and computed WITHOUT any
LLM. Any optional LLM-assisted narrative or playbook-text generation must route
through `getActiveClient(cfg, { allowCloud })` — local Ollama/LM Studio only
unless the user passes `--allow-cloud` AND a key is present (mirror M25 ask.ts
exactly). Default path makes ZERO non-localhost network connections.
- *Enforced:* `reflect.ts` contains no `fetch`/`getActiveClient`. Narrative/
  playbook synthesis lives only in `playbooks.ts`, forwarding `allowCloud`
  verbatim to `getActiveClient` (which throws for cloud without key); on throw
  it falls back to the deterministic body.
- *Verifier proves:* `grep -n 'fetch\|getActiveClient' src/core/learn/reflect.ts`
  returns ZERO hits. A test mocks `getActiveClient` and asserts the default
  `ashlr reflect` path never invokes it; a network-spy test asserts no
  non-localhost connection on the default path.

**4. BOUNDED.** Reflection operates only on the user's OWN local history
(swarms/genome/usage) — NOT a portfolio disk scan. Cap how many runs/entries are
read (e.g. most recent N, or a `--since` window). No unbounded loops.
- *Enforced:* `listSwarms()` is capped at 200; `buildReflection`/
  `distillAndPersist` further slice to `maxRuns` (default `DEFAULT_MAX_RUNS=100`)
  and/or `sinceMs`. `listReports()` caps at `MAX_REPORTS=200`. Failure clusters
  and goal categories are capped (`MAX_FAILURE_MODES`, `MAX_TUNING`,
  `MAX_PLAYBOOKS`). No directory/portfolio walk.
- *Verifier proves:* a tmpdir test seeds > maxRuns swarms and asserts only
  `maxRuns` are analyzed; grep confirms no `discoverGenomeRepos`-style root scan
  and no recursion without a depth/count cap in `src/core/learn`.

**5. NO OUTWARD ACTION.** No push/PR/deploy/merge. Proposals are the only sink
and they sit pending.
- *Enforced:* no M26 file imports `applyProposal`, `setStatus`, `createPr`,
  `git push`, `ship`, or any deploy path. Emitted proposals are `kind: 'note'`
  (apply-is-a-no-op) and stay `pending` (createProposal never auto-advances).
- *Verifier proves:* `grep -rn 'applyProposal\|setStatus\|createPr\|push\|deploy\|merge' src/core/learn src/cli/reflect.ts`
  returns ZERO hits. A test asserts post-`propose` every new proposal is still
  `pending` and nothing outward occurred.

---

## Tests (`test/m26.*.test.ts`)

Use `tmpdir` + a relocated `HOME` and mocked stores — NEVER the real `~/.ashlr`
or real portfolio. Cover: deterministic metrics math; week-over-week deltas
across two snapshots; failure clustering; goal classification; the five
invariants above (config byte-identical, repo byte-identical, no cloud on
default path, bounded reads, proposals pending/`note`). No runtime deps added.
