# Architecture

`ashlr-hub` is a local-first command center for the Ashlr dev-tool ecosystem. It
indexes your machine (git repos, doc folders, assets) and exposes it through one
front door: the `ashlr` CLI and a Raycast extension, both reading the same
`~/.ashlr/index.json`. Everything runs locally; cloud calls are opt-in and off by
default.

Stack: TypeScript (strict), ESM / NodeNext, Node >= 22. Zero runtime
dependencies in `core/` and `cli/` except `@modelcontextprotocol/sdk` (MCP
layer). Source compiles via `tsc` to `dist/`; `bin/ashlr` is a shim that imports
`dist/cli/index.js`.

---

## High-level shape

```
bin/ashlr  ──imports──▶  dist/cli/index.js  ──delegates──▶  src/core/*
                                │
                                ├─ parses argv, dispatches to one command
                                └─ commands read/write  ~/.ashlr/  (the home)

src/raycast/  ── separate package; reads ~/.ashlr/index.json read-only
```

The CLI is the only writer of the `~/.ashlr/` home. Raycast and downstream
agents are consumers.

---

## `src/core/` — subsystems

The canonical type contract lives in **`core/types.ts`** — every shared shape
(`AshlrConfig`, `IndexedItem`, `AshlrIndex`, `DoctorReport`, `RunState`,
`ActivityRollup`, `ProjectTemplate`, genome types). Import these; never redefine.

### Foundation (M1)

| Module              | Responsibility |
|---------------------|----------------|
| `config.ts`         | `~/.ashlr/config.json` read/write + path constants (`CONFIG_DIR`, `CONFIG_PATH`, `INDEX_PATH`). All `~` paths resolve from `os.homedir()`. Validates against `schema/config.schema.json`. |
| `git.ts`            | Git introspection via `child_process` (branch, dirty, ahead/behind, last commit) — no deps. |
| `classify.ts`       | Classify each scanned entry: category, language, `ItemKind`, description. |
| `index-engine.ts`   | Walk `cfg.roots` (`github/<category>/<repo>` + Desktop top level, depth ≤ 3), build a fully-populated `AshlrIndex`, persist/load `~/.ashlr/index.json`. Fault-tolerant: one bad dir never crashes the walk. |
| `tidy.ts`           | Plan (dry-run) and apply moves of loose Desktop files per `cfg.tidyRules`; never touches keepers, symlinks, or git repos. |

### Identity & models (M2)

| Module         | Responsibility |
|----------------|----------------|
| `providers.ts` | Probe local model endpoints (LM Studio `:1234`, Ollama `:11434`) in `providerChain` order; resolve the active provider. Probes never throw. |
| `phantom.ts`   | Read-only Phantom secrets CLI status (installed/version/initialized/secret names). Never reads or prints secret values. |
| `doctor.ts`    | Aggregate a one-glance `DoctorReport` (runtime, config, index, phantom, MCP plugin, providers, ecosystem tools, genome) with pass/warn/fail + fix hints. |

### MCP gateway (M3)

| Module               | Responsibility |
|----------------------|----------------|
| `mcp-registry.ts`    | Discover MCP servers across known config paths (`~/.claude.json`, `~/.claude/settings.json`, `~/.mcp.json`, `~/.ashlrcode/settings.json`, …); dedupe by name. Env values redacted. |
| `mcp-gateway.ts`     | stdio aggregation gateway — start every discovered server as a managed child, proxy `tools/list` / `tools/call`, namespace tools as `<server>__<tool>`. Per-server health probe. Uses `@modelcontextprotocol/sdk`. |
| `tools-registry.ts`  | Detect ecosystem tools (`phantom`, `ashlrcode`, `aw`, `stack`, …) and their versions via `PATH`. |

### Agent orchestrator (M4) — `core/run/`

| Module               | Responsibility |
|----------------------|----------------|
| `provider-client.ts` | Thin `ProviderClient` chat layer over Ollama (`/api/chat`) and LM Studio (`/v1/chat/completions`). Local-first; cloud only with `--allow-cloud`. |
| `budget.ts`          | `RunUsage` accounting + HARD budget/step enforcement. |
| `agent-loop.ts`      | Bounded chat/tool loop per `RunTask`; connects to the M3 gateway as an MCP client for tool access. |
| `orchestrator.ts`    | Decompose a goal into a `RunTask[]` DAG, fan out independent tasks in waves up to `--parallel N`, synthesize a final answer. Persists `RunState` to `~/.ashlr/runs/<id>.json` after every step (atomic write-then-rename); supports `--resume`. |

### Observability (M5) — `core/observability/`

| Module             | Responsibility |
|--------------------|----------------|
| `usage-source.ts`  | Collect `UsageEvent`s from `~/.claude/projects/**/*.jsonl` (metadata only — token counts, model, timestamp, project path; never message content) and `~/.ashlr/runs/*.json`. |
| `rollup.ts`        | `buildRollup`: aggregate tokens / cost / sessions / commits by window into an `ActivityRollup`. |
| `budget-alert.ts`  | `evalBudget`: evaluate `telemetry.budget*` caps → ok / warn / over level. |

### Project lifecycle (M6) — `core/lifecycle/`

| Module          | Responsibility |
|-----------------|----------------|
| `templates.ts`  | `TEMPLATES[]`, `getTemplate()`, `listTemplates()` — `minimal` / `node-cli` / `mcp-server` / `next-app`. |
| `scaffold.ts`   | `scaffoldProject()`, `defaultCategory()`, `targetDir()` — write the agentic-engineering layout (CLAUDE.md, `.mcp.json`, genome stub, README, package.json, entry point); refuses to overwrite an existing dir. |
| `ship.ts`       | `runShipGate()` (supply-chain + test/lint/build) and `deploy()` (dry-run unless `--confirm`). |

### Shared memory / genome (M7) — `core/genome/`

| Module        | Responsibility |
|---------------|----------------|
| `store.ts`    | `loadGenome()`, `appendHubEntry()`, `hubStorePath()`, `genomeHealth()` — aggregate the hub store (`~/.ashlr/genome/hub.jsonl`) with every project's `<repo>/.ashlrcode/genome/`. Append-only; never modifies existing entries. |
| `recall.ts`   | `recall()`, `keywordScore()` — rank genome entries by keyword/TF-IDF, optionally reranked via local Ollama `/api/embeddings`. Fully offline-capable; no cloud call ever. |

---

## `src/cli/` — commands

`cli/index.ts` is the argv dispatcher. It parses the subcommand and delegates to
`core/` (and to the command-handler modules below for the larger features).

| File            | Commands handled |
|-----------------|------------------|
| `index.ts`      | Dispatch + M1 commands: `index`, `go`, `status`, `ls`, `open`, `tidy`, `config`, `help` |
| `doctor-init.ts`| `doctor`, `init` (M2) |
| `mcp.ts`        | `mcp` (`list` / `doctor` / `install`) (M3) |
| `run.ts`        | `run`, `run show <id>`, `runs` (M4) |
| `pulse.ts`      | `pulse` (M5) |
| `new.ts`        | `new` (M6) |
| `ship.ts`       | `ship` (M6) |
| `genome.ts`     | `recall`, `learn`, `genome` (M7) |
| `update.ts`     | `update` — safe self-update (M9) |
| `open.ts`       | Editor / Finder / Terminal launchers (deep links) |
| `picker.ts`     | Interactive picker — `fzf` if present, else readline |

Command handlers stay thin: parse flags, call into `core/`, format output
(human text or `--json`). Exit codes are meaningful (e.g. `doctor` / `ship
--strict` / `run` over budget exit non-zero).

---

## The `~/.ashlr/` home layout

All persistent state lives under `~/.ashlr/` (resolved from `os.homedir()` at
runtime; never hardcoded). The CLI is the sole writer.

```
~/.ashlr/
├── config.json            # AshlrConfig — roots, editor, staleDays, categories,
│                          #   tidyRules, keepers, phantom, models, telemetry, genome, tools
│                          #   (validated against schema/config.schema.json)
├── index.json             # AshlrIndex — the scanned Desktop index (Raycast + CLI read this)
├── runs/
│   └── <id>.json          # M4 RunState, one file per run (atomic write-then-rename)
└── genome/
    └── hub.jsonl          # M7 append-only hub memory store (one GenomeEntry per line)
```

Related external paths the hub *reads* (never writes):

- `~/.claude/projects/**/*.jsonl` — Claude Code session usage metadata (M5, read-only)
- `~/.claude.json`, `~/.claude/settings.json`, `~/.mcp.json`, `~/.ashlrcode/settings.json` — MCP server discovery (M3)
- `<repo>/.ashlrcode/genome/` — per-project genomes, aggregated at recall time (M7; `learn --project` only ever adds a new note file, never edits existing ones)

---

## How a command flows

Example: `ashlr status`

1. `bin/ashlr` (shim) imports `dist/cli/index.js`.
2. `cli/index.ts` parses argv → `status`.
3. `config.ts` loads `~/.ashlr/config.json` (or defaults + warning).
4. `index-engine.ts` loads `~/.ashlr/index.json` (built earlier by `ashlr index`).
5. `git.ts` data already on items surfaces dirty/stale repo counts; `observability/rollup.ts` computes the `Activity (7d)` line from local usage; `genome/store.ts` `genomeHealth()` supplies the Memory line.
6. The command formats an aligned human table (or emits JSON with `--json`) and sets the exit code.

Example: `ashlr run "<goal>"` — `cli/run.ts` → `run/orchestrator.ts` plans a DAG
→ `run/agent-loop.ts` runs each task (tools via the M3 gateway as an MCP client)
→ `run/budget.ts` enforces ceilings → state persisted to `~/.ashlr/runs/<id>.json`
each step → synthesis → usage summary.

---

## Milestone → module mapping

| Milestone | Theme | Primary modules | Commands |
|-----------|-------|-----------------|----------|
| **M1** | Desktop index + core CLI | `config`, `git`, `classify`, `index-engine`, `tidy`, `open`, `picker` | `index`, `go`, `status`, `ls`, `open`, `tidy`, `config`, `help` |
| **M2** | Identity & model awareness | `providers`, `phantom`, `doctor` | `doctor`, `init` |
| **M3** | MCP aggregation gateway | `mcp-registry`, `mcp-gateway`, `tools-registry` | `mcp` (`list`/`doctor`/`install`) |
| **M4** | Local-first agent orchestrator | `run/provider-client`, `run/budget`, `run/agent-loop`, `run/orchestrator` | `run`, `run show`, `runs` |
| **M5** | Local-first observability | `observability/usage-source`, `observability/rollup`, `observability/budget-alert` | `pulse` (+ `status` Activity line) |
| **M6** | Project lifecycle | `lifecycle/templates`, `lifecycle/scaffold`, `lifecycle/ship` | `new`, `ship` |
| **M7** | Shared memory / genome | `genome/store`, `genome/recall` | `learn`, `recall`, `genome` (+ genome-aware `run`) |
| **M9** | Index-engine refinement + safe self-update | `index-engine` (incremental/robust walk), `cli/update` | `update` (`--check`/`--json`) |

Each milestone has a binding contract file (`CONTRACT.md`, `CONTRACT-M2.md` …
`CONTRACT-M7.md`) pinning its exported signatures. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the contracts-first workflow.

---

## Design invariants

- **Local-first.** No network call without explicit opt-in (`run --allow-cloud`). Observability and genome are fully offline.
- **Privacy.** Usage rollups read only token *metadata* from Claude transcripts — never message content. Phantom is read-only (names/status, never values).
- **Append-only memory.** The hub store and project genomes are only ever appended to; existing entries are never modified or deleted.
- **Fault tolerance.** Scans, probes, and gateway server starts degrade gracefully — one failure never crashes the whole operation.
- **Portability.** All home paths resolve from `os.homedir()`; no personal absolute paths in source.
