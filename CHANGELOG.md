# Changelog

All notable changes to ashlr-hub are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions map to internal milestones (M1–M10); no semver yet — the project uses
milestone tags. Dates are the merge dates into `main`.

---

## [Unreleased] — M10: Ecosystem Cohesion

### Added
- **Config → env bridge** (`src/core/env-bridge.ts`): `buildToolEnv` / `withToolEnv`
  project `~/.ashlr/config.json` into every spawned child's environment so all
  independently-shipped ecosystem tools (ashlrcode, aw, MCP downstreams, stack,
  vercel, gh, morphkit) honor one unified config without modification. Maps
  endpoints (`OLLAMA_HOST`, `OLLAMA_BASE_URL`, `LM_STUDIO_URL`, `OPENAI_BASE_URL`),
  provider identity (`ASHLR_LLM_PROVIDER`, `ASHLR_PROVIDER_CHAIN`, `ASHLR_MODEL`,
  `AC_MODEL`), paths (`ASHLR_CONFIG`, `ASHLR_GENOME_DIR`, `ASHLR_ROOTS`), and a
  local-first flag (`ASHLR_LOCAL_FIRST=1`). No secret values are ever injected —
  Phantom owns credentials; they flow to children only via normal `process.env`
  inheritance.
- `ToolEnv` type alias exported from `src/core/types.ts` (optional alias for
  `Record<string,string>` — the non-secret env map projected into spawned children).

### Fixed
- **Orchestrator resume-before-delegation reorder** (`src/core/run/orchestrator.ts`):
  the engine-delegation block previously ran before the `--resume` short-circuit,
  causing `ashlr run --engine x --resume <id>` to re-run an already-completed run
  instead of resuming it. The resume path now short-circuits first; env-bridge is
  applied to the delegation spawn after the reorder.
- **Genome recall TTY alignment** (`src/cli/genome.ts`): the recall table
  header/separator was misaligned in a TTY. Fixed column padding. Hits with
  `score <= 0` are now dropped from the display.
- **Doctor version awareness** (`src/core/tools-registry.ts`, `src/core/doctor.ts`):
  `ashlr doctor` now surfaces the installed version of each detected ecosystem tool
  (phantom, ashlrcode, aw, stack, morphkit, etc.) via lightweight `--version` probes,
  giving at-a-glance version awareness without requiring any new runtime dependencies.

### Changed
- `src/core/run/orchestrator.ts`, `src/core/mcp-gateway.ts`,
  `src/core/lifecycle/ship.ts` spawn sites updated to call `withToolEnv(cfg)` so
  every child inherits the unified config projection.
- MCP gateway downstream spawns merge `spec.env` AFTER `withToolEnv` base so
  per-server env overrides win over bridge defaults.

---

## [M9] — Hardening, CI, and Polish

_Commit: `71cb197` · `dfef853` · `b302e3e`_

### Added
- `ashlr update` command: self-update from the git remote + rebuild.
- CI workflow: typecheck, lint, build, and vitest on Node 22 for every push and PR.
- 932-test suite milestone reached.

### Fixed
- P0 bug fixes identified by internal audit: budget hard-ceiling enforcement,
  run-persistence atomicity, provider probe timeouts.

### Changed
- Shared CLI helpers extracted into `src/cli/ui.ts` and `src/cli/args.ts` (DRY
  refactor across 12 CLI files).
- Release polish: `CONTRIBUTING.md`, `ARCHITECTURE.md`, `install.sh` updated for
  public-repo presentation.

---

## [M7] — Shared Memory / Genome

_Commit: `26df2e0`_

### Added
- `ashlr learn "<note>"` — append a memory entry to `~/.ashlr/genome/hub.jsonl`
  (append-only; never overwrites).
- `ashlr recall "<query>"` — keyword/TF-IDF search across the aggregated genome
  (all indexed repos' `.ashlrcode/genome/` dirs + hub store). Optional
  embedding-rerank via local Ollama (`bge-m3` or similar); never calls a cloud API.
- `ashlr genome` — health status: entry count, projects covered, store size,
  staleness, embeddings availability.
- `src/core/genome/store.ts` — `loadGenome`, `appendHubEntry`, `genomeHealth`.
- `src/core/genome/recall.ts` — `recall`, `keywordScore`.
- `ashlr run` memory injection: top-k recall hits injected into sub-agent prompts
  (bounded by `cfg.genome.maxRecall`; disable per-run with `--no-memory`).
- `AshlrConfig.genome?: { maxRecall, injectOnRun }` config field.
- Types: `GenomeEntry`, `RecallHit`, `GenomeHealth`, `LearnInput`.

---

## [M6] — Project Lifecycle (`ashlr new` + `ashlr ship`)

_Commit: `febb800`_

### Added
- `ashlr new <name>` — scaffold an ecosystem-wired project (CLAUDE.md,
  `.mcp.json` gateway, genome stub, entry point) and register it in the index.
  Templates: `minimal`, `node-cli`, `mcp-server`, `next-app`.
- `ashlr ship [path]` — pre-ship gate (supply-chain + test/lint/build), then
  optional deploy. Read-only and dry-run by default; `--confirm` required for any
  outward action. Deploy targets: `vercel`, `stack`, `gh`, `morphkit`.
- `src/core/lifecycle/templates.ts` — `TEMPLATES`, `getTemplate`, `listTemplates`.
- `src/core/lifecycle/scaffold.ts` — `scaffoldProject`, `defaultCategory`,
  `targetDir`. Refuses to overwrite an existing directory.
- `src/core/lifecycle/ship.ts` — `runShipGate` (read-only), `deploy` (dry-run
  by default; real deploy requires `--confirm`).
- Types: `ProjectTemplate`, `ScaffoldSpec`, `ScaffoldResult`, `ShipCheck`,
  `ShipGate`, `ShipResult`.

---

## [M5] — Observability (`ashlr pulse`)

_Commit: `72a8714`_

### Added
- `ashlr pulse` — local usage dashboard: window summary (tokens/cost), by-project
  table, top models, budget status. Honors `--window 1d|7d|30d`, `--project`,
  `--json`. All numbers computed offline.
- `src/core/observability/usage-source.ts` — `collectUsageEvents`: streams
  metadata-only from `~/.claude/projects/**/*.jsonl` and `~/.ashlr/runs/*.json`.
  Never reads message content.
- `src/core/observability/rollup.ts` — `buildRollup`, `windowToMs`: aggregates
  by project, day, and model; joins with git commit counts.
- `src/core/observability/budget-alert.ts` — `evalBudget`: warn at >=80% of any
  cap; over when exceeded.
- `AshlrConfig.telemetry` extended with `budgetUsd`, `budgetTokens`, `budgetWindow`.
- Types: `UsageEvent`, `ProjectActivity`, `DailyUsage`, `ModelUsage`,
  `BudgetAlert`, `ActivityRollup`.

---

## [M4] — Agent Orchestrator (`ashlr run`)

_Commit: `56b1626`_

### Added
- `ashlr run "<goal>"` — plan → parallel DAG fan-out → synthesize. Resumable
  (`--resume <id>`); persisted to `~/.ashlr/runs/`. Hard budget and step ceilings
  (`--budget N`, `--max-steps N`). Local-first: refuses cloud unless `--allow-cloud`.
- `ashlr runs` — list past runs (id, status, tokens, cost).
- `ashlr run show <id>` — print full `RunState` for a past run.
- `src/core/run/provider-client.ts` — `getActiveClient`, `estimateTokens`.
  Supports Ollama (native `/api/chat`) and LM Studio (OpenAI-compatible). Enforces
  local-first: errors rather than silently billing when cloud is the only option.
- `src/core/run/budget.ts` — `newUsage`, `addUsage`, `overBudget`, `estCostUsd`.
- `src/core/run/agent-loop.ts` — `runTask`: bounded chat loop with tool-call
  support (degrades gracefully when unsupported). Hard-stops on budget.
- `src/core/run/orchestrator.ts` — `planGoal`, `runGoal`, `loadRun`, `listRuns`,
  `saveRun`. Parallel task fan-out (up to `--parallel N`). Engine delegation to
  `ashlrcode` / `aw` when installed.
- Types: `RunBudget`, `RunUsage`, `RunTask`, `RunStep`, `RunState`, `RunOptions`,
  `ChatMessage`, `ChatResult`, `ProviderClient`.

---

## [M3] — MCP Aggregation Gateway

_Commit: `aa59450`_

### Added
- `ashlr mcp` — run the single stdio MCP aggregation gateway. Discovers all
  configured MCP servers, starts each as a managed child, and proxies their tools
  namespaced as `<server>__<tool>`.
- `ashlr mcp list` — registry + per-server tool counts (env values redacted).
- `ashlr mcp doctor` — per-server health (starts? tool count?).
- `ashlr mcp install <claude|ashlrcode>` — idempotently register the gateway in a
  target agent config (backs up the file first; never clobbers).
- `src/core/mcp-registry.ts` — `discoverMcpServers`, `knownConfigPaths`: reads
  `~/.claude.json`, `~/.claude/settings.json`, `~/.mcp.json`,
  `~/.ashlrcode/settings.json`; deduped, env values redacted in display.
- `src/core/mcp-gateway.ts` — `startGateway`, `probeServer`. Per-downstream
  startup timeout 8s; failed downstreams skipped, gateway never crashes.
- `src/core/tools-registry.ts` — `getToolsRegistry`: detects installed ecosystem
  tools (phantom, ashlrcode, aw, stack, morphkit, …) via PATH.
- Runtime dependency: `@modelcontextprotocol/sdk` (gateway only; rest stays
  zero-dep).
- Types: `McpServerSpec`, `McpRegistry`, `AggregatedTool`, `McpServerHealth`,
  `ToolInfo`, `ToolsRegistry`.

---

## [M2] — Identity and Model Awareness

_Commit: `3a52826`_

### Added
- `ashlr doctor` — one-glance health check across runtime, config, index, Phantom,
  MCP plugin, and every provider endpoint. Exits non-zero on any `fail`.
- `ashlr init [--yes]` — idempotent onboarding: writes config defaults, detects
  local models, enables Phantom if present. Non-TTY safe (`--yes` accepts all
  defaults without prompting).
- `src/core/providers.ts` — `probeEndpoint`, `getProviderRegistry`,
  `resolveActiveProvider`: probes LM Studio (`:1234`) and Ollama (`:11434`);
  builds a registry; resolves the active provider via the configured chain.
  Probes never throw.
- `src/core/phantom.ts` — `phantomInstalled`, `getPhantomStatus`: read-only
  introspection of the `phantom` CLI. Returns names and status only — never secret
  values.
- `src/core/doctor.ts` — `runDoctor`: aggregates config, phantom, and provider
  health into a single `DoctorReport`. Never throws.
- `AshlrConfig` extended with `models.providerChain`, `phantom.enabled`.
- Types: `ProviderEndpoint`, `ProviderRegistry`, `PhantomStatus`, `DoctorCheck`,
  `DoctorReport`.

---

## [M1] — Foundation

_Commit: `814f3c3`_

### Added
- `ashlr index [--refresh]` — scan project tree, persist `~/.ashlr/index.json`.
- `ashlr status` — index summary: counts by kind/category, dirty/stale repos,
  7-day activity line.
- `ashlr go [query]` — fuzzy-jump to a project (`--open` / `--cd`).
- `ashlr ls [category]` — list indexed items.
- `ashlr open <query>` — resolve and open in configured editor.
- `ashlr tidy [--apply]` — plan or apply moves of loose top-level files.
- `ashlr config get|set|path` — read/write `~/.ashlr/config.json`.
- `ashlr help` — usage.
- `src/core/config.ts` — `loadConfig`, `saveConfig`, `defaultConfig`,
  `CONFIG_DIR`, `CONFIG_PATH`, `INDEX_PATH`.
- `src/core/git.ts` — `isRepo`, `getGitStatus`, `getRemoteOrg`. Tolerates
  worktrees, missing upstream, zero-commit repos.
- `src/core/classify.ts` — `categoryOf`, `describe`, `primaryLanguage`, `kindOf`.
- `src/core/index-engine.ts` — `buildIndex`, `loadIndex`, `writeIndex`. Detects
  symlinks; no double-counting.
- `src/core/tidy.ts` — `planTidy`, `applyTidy`.
- `src/cli/open.ts` — `openInEditor`, `openInFinder`, `openInTerminal`.
- `src/cli/picker.ts` — `pick`: uses `fzf` if present on PATH, else built-in
  readline numbered picker.
- `src/raycast/` — Raycast extension (own `package.json`): list view over
  `IndexedItem`, open in editor, reveal in Finder, copy path.
- `AshlrConfig`, `IndexedItem`, `AshlrIndex`, `GitStatus`, `TidyRule`,
  `TidyMove`, `TidyPlan` types established as THE canonical contract in
  `src/core/types.ts`.
- Zero runtime dependencies in `core/` and `cli/` (Node builtins only).
- `install.sh`: idempotent symlink of `bin/ashlr` into `~/.local/bin`.
