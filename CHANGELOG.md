# Changelog

All notable changes to ashlr-hub are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions map to internal milestones (M1–M10); no semver yet — the project uses
milestone tags. Dates are the merge dates into `main`.

---

## [Unreleased] — M14: Surfaces II (Local Web Dashboard)

### Added
- **`ashlr serve [--port N] [--open] [--allow-dispatch]` — local web dashboard** (`src/core/web/server.ts`, `src/core/web/api.ts`, `src/core/web/static.ts`, `src/cli/serve.ts`):
  - Starts a localhost HTTP server (Node `http` builtin) serving a JSON API and a single-page dashboard (static assets bundled in the repo — **no CDN, fully offline**). Default port 7777; `--open` launches the browser automatically.
  - **Five dashboard views** (vanilla JS + inline SVG/Canvas, dark theme, brand aesthetic, live via EventSource):
    - **Overview** — aggregated snapshot of the local ecosystem (git health, tools, 7-day activity).
    - **Runs** — paginated list of recent agent runs with status, goal, and token/cost usage.
    - **Swarms** — swarm detail with an **SVG dependency-graph** (nodes per task colored by phase/status, edges for declared dependencies) and a live burndown chart updating in real time via SSE.
    - **Pulse** — SVG bar charts of cost/token usage by project, day, and model.
    - **Genome browser** — full genome list with a search box that hits `/api/genome?q=` for instant recall.
  - **Live updates via SSE** — `GET /api/events` uses Server-Sent Events to push run/swarm state changes (bounded poll interval) so the page live-streams burndown without a reload. Cleared on disconnect and on server close (no timer leaks).
- **JSON read-only API** (all endpoints metadata-only; no secrets served):
  - `GET /api/snapshot` — `buildSnapshot(cfg)` aggregate (M13 dashboard snapshot).
  - `GET /api/runs` / `GET /api/run/:id` — `listRuns` / `loadRun` (404 on unknown id).
  - `GET /api/swarms` / `GET /api/swarm/:id` — `listSwarms` / `loadSwarm` (404 on unknown id).
  - `GET /api/pulse[?window=1d|7d|30d]` — `buildRollup` (default 7d).
  - `GET /api/genome[?q=<query>]` — `recall(q, cfg)` when `q` supplied, else `loadGenome(cfg)`.
  - `GET /api/events` — SSE stream (see above).
- **Opt-in dispatch endpoint** (`POST /api/run`) — registered **only** when `--allow-dispatch` is passed. Protected by a per-session token (printed at server start, required in a header, compared constant-time) to defeat CSRF/drive-by POSTs. Body clamped to local-first budget caps; `allowCloud` never set. **Default server has zero mutating endpoints.**
- **New types** in `src/core/types.ts`: `WebServerOptions`, `WebServerHandle`.

### Security (non-negotiable, documented in CONTRACT-M14.md)
- **Binds `127.0.0.1` only** — never `0.0.0.0`; not externally reachable.
- **Host-header allowlist** (`localhost` / `127.0.0.1` / `::1` ± port) enforced as the first pipeline step — all other `Host` values → 403. Defeats DNS-rebinding attacks.
- **Read-only by default** — no mutating endpoints exist unless `--allow-dispatch` is explicitly passed.
- **Token-guarded dispatch** — constant-time comparison; token printed once at startup; never in logs or snapshot responses.
- **Path-traversal-safe static serving** — decode + join under assets dir, resolve, reject `..` / absolute / null-byte / symlink-escape → 404.
- **No outward/SSRF calls** from the server process.
- **No CDN / no external fonts or scripts** — all assets bundled in the repo and served locally; fully functional offline.
- **Ephemeral + clean close** — `Ctrl-C` stops the server; SSE poll timers cleared; no leaks.
- **Zero new runtime dependencies** (`http` / `crypto` / `fs` / `path` / `url` builtins only).

### Guardrails (M14)
- All 1314 existing tests preserved.
- Reuses `core/dashboard.ts buildSnapshot`, `core/run/orchestrator.ts listRuns/loadRun/runGoal`, `core/swarm/store.ts listSwarms/loadSwarm`, `core/observability/rollup.ts buildRollup`, `core/genome/store.ts loadGenome/genomeHealth`, `core/genome/recall.ts recall`, and `cli/ui.ts`.
- Zero new runtime dependencies in `core/` and `cli/`.

---

## [Unreleased] — M13: Surfaces I (Interactive TUI + Real-Time Raycast)

### Added
- **`ashlr tui` / `ashlr dash` — interactive live terminal dashboard** (`src/tui/app.ts`, `src/tui/render.ts`, `src/cli/tui.ts`):
  - Runs in an alt-screen buffer with raw-mode key handling and automatic resize awareness. Auto-refreshes every ~2 s by re-reading local data sources (bounded, never blocks the event loop).
  - **Five tabs** (switch with `Tab` / `Shift-Tab` or `1`–`5`):
    - **Overview** — repo health (dirty/stale counts), ecosystem tool availability, 7-day activity summary.
    - **Runs** — recent agent runs with live status, goal summary, and token usage.
    - **Swarms** — live phase/task burndown for active and recent swarms (done/total per phase).
    - **Pulse** — 7-day cost, tokens, and per-project activity from the local observability rollup.
    - **MCP** — discovered MCP server health (name, tool count, ok/fail).
  - **Key bindings**: `Tab` / `Shift-Tab` or `1`–`5` to switch tabs; `j` / `k` to move selection; `r` to force-refresh; `Enter` to show detail; `q` / `Ctrl-C` to quit.
  - **`--once` flag**: render one frame to stdout and exit — safe for headless use, scripting, and test assertions.
  - **Non-TTY graceful degradation**: when stdout is not a TTY (pipe, redirect, CI), automatically prints one frame without entering raw mode or alt-screen.
  - **Terminal safety guarantee**: alt-screen, cursor visibility, and raw mode are **always restored** on quit, signal (`SIGINT`, `SIGTERM`), or thrown exception — the terminal is never left corrupted.
  - **Zero new runtime dependencies**: built entirely on Node.js builtins and `src/cli/ui.ts` ANSI helpers.
- **`src/core/dashboard.ts`** — `buildSnapshot(cfg)`: aggregates index/git (dirty/stale), tools-registry, observability rollup, runs (orchestrator), swarm store, MCP registry, and genome health into a single `DashboardSnapshot`. Bounded and fault-tolerant — never throws; any failed data source degrades to zeroed/empty fields.
- **New types** in `src/core/types.ts`: `DashboardSnapshot`, `TuiTab`.
- **Raycast extension upgrades** (`src/raycast/`):
  - **Dispatch Run** command: form UI (goal, budget, parallel, engine flags) that invokes `ashlr run --json` and shows live output. Bounded and local-first, matching CLI guardrails.
  - **Swarms** command: lists active and recent swarms with live done/total task counts and per-phase progress; action to show full detail or open the target project.
  - **Auto-revalidation**: existing Pulse and Attention views now use `usePromise`/`useExec` with a short poll interval so they refresh without manual reloads.
  - All new commands registered in `src/raycast/package.json`.

### Guardrails (M13)
- TUI is **reads-only** — no destructive or outward actions from any tab.
- Raycast dispatch is the only outward action; it is bounded (budget ceiling), local-first by default (`--allow-cloud` required for cloud endpoints), and uses the same `ashlr run` path as the CLI.
- ZERO new runtime dependencies added to CLI/TUI (Node builtins + `src/cli/ui.ts` only); Raycast retains its existing `@raycast/api`.
- All 1184 existing tests preserved.

---

## [Unreleased] — M12: Spec-Driven Swarms

### Added
- **`ashlr spec` — end-state specs as first-class artifacts** (`src/core/spec/spec-store.ts`, `src/cli/spec.ts`):
  - `ashlr spec new "<goal>" [--project <path>]`: drafts a structured end-state spec with the local model (sections: Context, North Star, Operating Principles, Pillars, Roadmap/phases, Verification). Stored versioned at `<project>/.ashlr/specs/<slug>-v<N>.md` plus a sidecar `.json` (id, goal, version, createdAt, status). Never overwrites an existing version.
  - `ashlr spec list [--project <path>]`: table of all specs (id, version, status, goal).
  - `ashlr spec show <id>`: print the full markdown body + metadata.
  - `ashlr spec refine <id> "<note>"`: produce v+1 incorporating the note. Versioned and append-only — prior versions are always recoverable.
- **`ashlr swarm` — contracts-first agent-fleet orchestration** (`src/core/swarm/planner.ts`, `src/core/swarm/runner.ts`, `src/core/swarm/store.ts`, `src/cli/swarm.ts`):
  - `ashlr swarm "<goal>" | <specId> [--budget N] [--parallel N] [--background] [--resume <id>] [--dry-run] [--allow-cloud]`: decomposes a goal or spec into a `SwarmPlan` (phases: SCAFFOLD → BUILD → INTEGRATE → VERIFY → REVIEW) and executes a fleet of agents through it. Each task is an `orchestrator.runGoal` invocation, local-first by default. BUILD phase fans out in parallel (cap `--parallel`, default 3, max 8). Planner caps tasks per phase at 6.
  - `ashlr swarms [--json]`: list all past swarm runs (id, status, phase, cost).
  - `ashlr swarm show <id>`: full `SwarmRun` detail including per-task status, usage, and errors.
- **New types in `src/core/types.ts`**: `SpecArtifact`, `SwarmPhaseName`, `SwarmTaskSpec`, `SwarmTaskRun`, `SwarmPlan`, `SwarmRun`, `SwarmOptions`.
- **`--dry-run`**: planner runs, all tasks printed, no agents invoked — zero cost, safe to run anywhere.
- **`--background`**: launch a detached worker process that runs the swarm and writes progress to the swarm record; foreground returns the swarm id immediately. Total budget still bounds all background work.

### Guardrails
- **Hard total budget**: a single `RunBudget` ceiling spans the entire swarm (all tasks, all phases). Any task that would push usage over the limit is skipped; the swarm aborts cleanly with full partial state preserved.
- **Bounded concurrency**: `--parallel` (default 3, max 8); planner enforces ≤6 tasks per phase.
- **Local-first**: tasks run on local models (builtin/Ollama) by default. `--allow-cloud` required for cloud endpoints — no silent billing.
- **No recursion / no fork bomb**: swarm tasks set `ASHLR_IN_SWARM=1` in subprocess env. `ashlr swarm` refuses to start if that marker is already set, preventing nested swarms.
- **No outward/destructive actions by default**: tasks operate within the target project dir; push, deploy, repo creation, and destructive `tidy --apply` / `ship --confirm` are blocked unless explicitly opted in.
- **Resumable**: `SwarmRun` persisted to `~/.ashlr/swarms/<id>.json` after every step; `--resume <id>` restarts from the last completed checkpoint.
- **Streaming progress** (M11 `StreamSink`): phase start/done, per-task start/done, live burndown counts streamed to stderr in real time.

---

## [Unreleased] — M11: Watchable, Robust Runs

### Added
- **Hardened engine delegation** (`src/core/run/engines.ts`): replaced the guessed
  `['--goal', goal]` spawn with per-engine adapter functions that emit the real,
  confirmed CLI argv for each tool. `buildEngineCommand` returns `null` for
  `builtin` (local loop) or an `EngineCommand` with the exact invocation:
  - `claude` (Claude Code): `claude -p "<goal>" --model <M> --output-format json`
    (JSON carry usage + cost automatically).
  - `aw` (ashlr-workbench): `aw auto "<goal>" --cwd <dir>` plus `--model <M>` when
    a model is set.
  - `ashlrcode` (absent on this host): `ac --goal "<goal>"`; absence is detected via
    `engineInstalled` and routes to the builtin loop with a clear message.
  `spawnEngine` applies `withToolEnv(cfg)` to every spawn and wraps via
  `phantom exec --` when `cfg.phantom?.enabled` and `phantom` is on PATH.
  `phantomWrap` is exported for unit testing the exact argv without real delegation.
- **Streaming output** (`src/core/run/streaming.ts`): `RunStreamEvent` (with kinds
  `task-start`, `model-delta`, `tool-call`, `task-done`, `retry`, `verify`, `log`)
  flows from the agent loop to the CLI in real time. `makeCliSink` renders a live,
  human-readable stream to **stderr** (keeping stdout clean for `--json`);
  `nullSink` is a no-op for programmatic consumers. `StreamSink` type exported.
- **`--stream` / `--no-stream` flags** (`src/cli/run.ts`): streaming defaults on
  when stderr is a TTY; `--no-stream` suppresses live output. `--json` keeps stdout
  clean JSON while the event stream goes to stderr. All existing flags preserved.
- **Retry + verification loop** (`src/core/run/retry.ts`, `src/core/run/verify.ts`):
  `withRetry` wraps any async fn with bounded exponential back-off
  (`baseDelayMs × 2^(attempt-1)`, capped at `maxAttempts`; caller supplies
  `isRetryable`). `verifyTask` checks a completed task result with a cheap
  heuristic first; if the budget allows, it optionally asks the model for a
  verdict — but never exceeds the global budget ceiling. `VerifyVerdict` signals
  `ok`, `reason`, and `method` (`'heuristic'` or `'model'`).
- **Phantom-exec proxy** (`src/core/run/engines.ts` `phantomWrap`): when
  `cfg.phantom?.enabled` is true and `phantom` is installed, all engine spawns are
  wrapped as `phantom exec -- <bin> [...args]` so secrets are injected by Phantom
  rather than by the hub. Best-effort: absent or disabled Phantom falls back to
  direct spawn. Secret values are never logged or injected into the env allowlist.
- New types in `src/core/types.ts`: `RunStreamEvent`, `RetryPolicy`,
  `VerifyVerdict`, `EngineId`, `EngineCommand`.
- `ProviderClient` extended with optional `chatStream?(messages, tools, onDelta)`
  for Ollama (NDJSON `/api/chat stream:true`) and LM Studio (SSE
  `/v1/chat/completions stream:true`); both fall back to `chat()` when streaming
  is unavailable. Callers guard with `?.`.

### Changed
- `src/core/run/orchestrator.ts` updated to consume `StreamSink` and forward
  events from the agent loop to the CLI sink; engine delegation paths updated to
  use `buildEngineCommand` / `spawnEngine` from `engines.ts`.
- `src/cli/run.ts` wires `makeCliSink` (TTY) or `nullSink` (non-TTY / `--no-stream`)
  and passes it through to the orchestrator.

### Fixed
- Engine delegation previously passed a guessed argv to spawned sub-agents; the
  adapter layer now asserts exact argv in unit tests (no real delegated runs during
  build or CI).

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
