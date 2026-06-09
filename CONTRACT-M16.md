# CONTRACT-M16 — Compounding Genome (the moat)

The genome learns from every run/swarm automatically and feeds it back. Build
against these EXACT signatures. Each agent edits ONLY its file(s). Reuse the
existing M7 modules (`core/genome/store.ts`, `core/genome/recall.ts`). No new
runtime deps. No git commit. Preserve all existing behavior + 1504 tests.

## Types (already added to `src/core/types.ts` — do NOT redefine)

```ts
interface GenomeCapture {
  goal: string;
  project: string | null;
  summary: string;
  tags: string[];
  outcome: 'done' | 'aborted' | 'failed';
  source: 'run' | 'swarm' | 'teach';
}

interface Playbook {
  goal: string;
  entries: RecallHit[];   // from M7
  synthesis: string;
}

interface ConsolidationResult {
  before: number;
  after: number;
  merged: number;
  backupPath: string;
}
```

`cfg.genome` is extended with two OPTIONAL fields (existing `maxRecall` /
`injectOnRun` unchanged):

```ts
genome?: {
  maxRecall: number;
  injectOnRun: boolean;
  autoCapture?: boolean;    // default true
  playbookOnRun?: boolean;  // default true
};
```

Defaults are applied by READERS (treat `undefined` as `true`): never persist a
silent override. Auto-capture and playbook injection are ON unless explicitly
disabled in config or via `--no-capture` (capture) on the run/swarm CLI.

## Reused M7 surface (do NOT change its signatures)

- `loadGenome(cfg)`, `recall(query, cfg, opts?)`, `appendHubEntry(input: LearnInput, cfg)`,
  `genomeHealth(cfg)`, `hubStorePath(cfg)` — `~/.ashlr/genome/hub.jsonl`,
  `GenomeEntry { id, project, source, title, text, tags, ts }`.

## EXACT signatures to implement

### `src/core/genome/capture.ts` (NEW)

```ts
export function captureFromRun(run: RunState, cfg: AshlrConfig): void;
export function captureFromSwarm(s: SwarmRun, cfg: AshlrConfig): void;
export function summarizeForGenome(input: { goal: string; result?: string; tasks?: unknown[] }): string;
```

- `captureFromRun` / `captureFromSwarm`: FIRE-AND-FORGET. MUST NOT throw, MUST
  NOT block or slow the caller (wrap all work in try/catch; swallow errors;
  return immediately — do any async append without awaiting in the hot path).
  No-op when `cfg.genome?.autoCapture === false`. Build a `GenomeCapture`
  (source `'run'` / `'swarm'`), derive `summary` via `summarizeForGenome`, set
  `tags` to include the project (when known), the status/outcome, and the
  engine (run) — all lowercased, deduped. DEDUPE-AWARE: skip the append when a
  near-identical entry (same goal + project, high text overlap) already exists
  in the genome. Append via `appendHubEntry` (title derived from goal, tags
  carried, `text` = the summary). Outcome maps run/swarm `status`:
  `'done'→'done'`, `'aborted'→'aborted'`, anything else → `'failed'`.
- `summarizeForGenome`: returns a SUMMARY/METADATA-ONLY string. NEVER include
  secrets, raw prompts/completions, tool args, or file contents. Cap total
  length (hard cap, e.g. <= 800 chars). Summarize the goal, a concise
  approach/outcome gist, and a bounded count/sketch of tasks (task goals/status
  only — never their raw result bodies or tool output). Deterministic; no model
  call; no I/O; never throws.

### `src/core/genome/consolidate.ts` (NEW)

```ts
export async function consolidateGenome(cfg: AshlrConfig): Promise<ConsolidationResult>;
```

- Write a TIMESTAMPED backup of `hub.jsonl` FIRST (e.g.
  `hub.jsonl.bak-<ISO-safe-ts>`) before any mutation; return its absolute path
  as `backupPath`. NO DATA LOSS: merge near-duplicate hub entries (same
  goal/project, high text overlap) into ONE canonical entry that PRESERVES
  provenance — keep a merged `count`, first/last-seen timestamps, and the union
  of tags; the canonical entry RETAINS the key content of every merged member
  (never silently drop information). Bounded (cap comparisons / work). Only
  rewrites the HUB store; project genome sources are read-only. Returns
  `{ before, after, merged, backupPath }`. If nothing to merge, still writes a
  backup (or treats it as a no-op consistently) and returns `merged: 0` with
  `before === after`.

### `src/core/genome/playbook.ts` (NEW)

```ts
export async function buildPlaybook(goal: string, cfg: AshlrConfig, opts?: { limit?: number }): Promise<Playbook>;
export function playbookText(p: Playbook, maxChars: number): string;
```

- `buildPlaybook`: `recall(goal, cfg)` for similar past entries (respect
  `opts.limit`, else `cfg.genome?.maxRecall`). SYNTHESIZE a concise
  "how we've approached this before — what worked / what failed / cost"
  string using the LOCAL provider (best-effort, bounded). On any failure /
  over-budget / no provider, FALL BACK to a concatenated-recall synthesis built
  from the recalled entries. LOCAL-ONLY — never a cloud call. Never throws;
  returns `{ goal, entries, synthesis }` (empty `entries` + brief synthesis when
  nothing recalled).
- `playbookText`: render the playbook to an injection-ready string capped at
  `maxChars` (hard truncate with an elision marker). Pure; never throws.

### `src/core/genome/export.ts` (NEW)

```ts
export function exportGenome(cfg: AshlrConfig, dest: string, format: 'json' | 'md'): { ok: boolean; count: number; path: string };
```

- READ-ONLY on the genome. Loads the full aggregated genome (`loadGenome`) and
  writes it to `dest` as portable JSON (array of `GenomeEntry`) or Markdown (one
  section per entry: title, project/tags/ts, body). NO lock-in. Returns
  `{ ok, count, path }` (`ok:false` with `count:0` on write failure; never
  throws).

### `src/cli/genome.ts` (EXTEND — keep existing `cmdRecall` / `cmdLearn` / `cmdGenome`)

Add subcommands routed by `cmdGenome` (preserve existing `genome` health
output as the default/no-subcommand behavior):

- `genome --teach "<note>"` — explicit high-value teach: append via
  `appendHubEntry` with tag `'teach'` (source semantics `'teach'`), project from
  cwd/flag when available.
- `genome consolidate` — calls `consolidateGenome(cfg)`, prints
  `{ before, after, merged, backupPath }`.
- `genome export <file>` — infers `format` from the file extension
  (`.md`→`'md'`, else `'json'`) or a `--format` flag; calls `exportGenome`,
  prints `{ ok, count, path }`.
- `genome playbook "<goal>"` — calls `buildPlaybook(goal, cfg)` and prints
  `playbookText(p, <cap>)`.

`--json` is honored on each (machine-readable output), mirroring existing CLI
conventions in this file.

### Run / swarm wiring (orchestrator + runner + their CLIs)

- `core/run/orchestrator.ts` (`runGoal`): on COMPLETION (any terminal status),
  call `captureFromRun(run, cfg)` (fire-and-forget, after final state is
  persisted). When `cfg.genome?.playbookOnRun !== false` and not disabled,
  `buildPlaybook(goal, cfg)` and inject `playbookText(...)` (bounded char cap)
  into the planning context — UPGRADING M7's raw recall injection into the
  synthesized playbook. Honor `RunOptions.noMemory` (skip injection) and a
  capture opt-out.
- `core/swarm/runner.ts` (`runSwarm`): on COMPLETION, call
  `captureFromSwarm(s, cfg)` (fire-and-forget).
- CLI `--no-capture` on `ashlr run` / `ashlr swarm` passes through to disable
  auto-capture for that invocation (overrides `cfg.genome.autoCapture`).

## Guardrails (binding)

- PRIVACY: capture METADATA/SUMMARY only — never secrets, full prompts/
  completions, tool args, or file contents. Cap entry size (`summarizeForGenome`
  hard cap). Reuse M5 privacy discipline.
- NO DATA LOSS: `consolidate` writes a timestamped backup FIRST and merges
  (never silently drops content); append-only semantics preserved elsewhere;
  `export` is read-only.
- LOCAL-ONLY: no cloud calls anywhere in M16; playbook synthesis uses the local
  provider best-effort, falling back to concatenated recall on failure/over-
  budget; bounded. Auto-capture NEVER blocks or slows a run (fire-and-forget,
  never throws).
- REUSE existing modules; NO new runtime deps; NO git commit. Preserve all
  existing behavior + 1504 tests.

## Rules

Build against this contract. Each agent edits ONLY its file(s).
