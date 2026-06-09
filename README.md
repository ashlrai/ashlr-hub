# ashlr-hub

**The local-first command center for the Ashlr dev-tool ecosystem.**

Your front door to every repo, model, MCP server, and agent on your machine — one fast `ashlr` CLI and a Raycast extension, both reading from a single local index.

[![CI](https://github.com/masonwyatt23/ashlr-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/masonwyatt23/ashlr-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)

---

## What is this?

`ashlr-hub` is the command center for agentic engineers. It indexes your projects, surfaces health at a glance, aggregates every MCP server into one gateway, orchestrates local-first agent runs, tracks usage, scaffolds and ships new projects, and gives the whole ecosystem a shared, private memory — all from one binary.

It is **local-first by design**. The index, config, runs, observability rollups, and memory all live under `~/.ashlr/`. Agent runs default to local models (Ollama / LM Studio) and refuse to touch a cloud endpoint unless you explicitly opt in. Telemetry is metadata-only; secrets are read through Phantom and never captured.

Think of it as the front door to your entire dev-tool stack: type `ashlr go`, jump anywhere; type `ashlr doctor`, see everything; point any agent at `ashlr mcp`, get every tool.

---

## Quickstart

Requires **macOS** and **Node.js 22+** with `~/.local/bin` on your `PATH`.

```sh
git clone https://github.com/masonwyatt23/ashlr-hub.git
cd ashlr-hub
npm ci
npm run build
./install.sh        # symlinks `ashlr` into ~/.local/bin (idempotent)
```

Then bootstrap and verify:

```sh
ashlr init          # idempotent onboarding: config, model discovery, Phantom
ashlr doctor        # one-glance health check across the whole stack
ashlr index         # build the project index at ~/.ashlr/index.json
```

`./install.sh` builds the TypeScript to `dist/`, symlinks `bin/ashlr` -> `~/.local/bin/ashlr`, and verifies `ashlr help` runs cleanly. It is safe to re-run after every `git pull`.

<details>
<summary>Manual install (no script)</summary>

```sh
npm run build
chmod +x bin/ashlr
ln -sf "$(pwd)/bin/ashlr" ~/.local/bin/ashlr
ashlr help
```
</details>

---

## Commands

Every command is zero-runtime-dependency (Node builtins plus the MCP SDK). Add `--json` to most commands for machine-readable output.

### Navigate

| Command | What it does |
|---|---|
| `ashlr index [--refresh]` | Scan your project tree and persist `~/.ashlr/index.json`. `--refresh` forces a full rescan. |
| `ashlr status` | Summary of the index: counts by kind/category, dirty + stale repos, and a 7-day activity line. |
| `ashlr go [query] [--open\|--cd]` | Fuzzy-jump to a project. `--open` launches your editor; `--cd` prints the path. |
| `ashlr ls [category]` | List all indexed items, optionally filtered by category. |
| `ashlr open <query>` | Resolve a name and open it in your configured editor. |
| `ashlr tidy [--apply]` | Plan (dry-run) or apply moves of loose top-level files per your tidy rules. |

```sh
ashlr go artist-encyclopedia --open     # filter, pick, open in Cursor
ashlr tidy                              # dry-run: show what would move
ashlr status                            # counts, dirty/stale repos, activity
```

Shell helper for instant `cd` — add to your `.zshrc`:

```sh
j() { local p; p=$(ashlr go "$1" --cd) && cd "$p"; }
```

### Config

| Command | What it does |
|---|---|
| `ashlr init [--yes]` | Idempotent onboarding: writes config defaults, detects local models, enables Phantom if present. Non-TTY safe. |
| `ashlr doctor` | Health check across runtime, config, index, Phantom, MCP plugin, and every provider endpoint. Exits non-zero on failure. |
| `ashlr config [get\|set <k> <v>\|path]` | Read or write `~/.ashlr/config.json`. |

```sh
ashlr init --yes                # accept all defaults, no prompts (CI-safe)
ashlr doctor --json             # full DoctorReport as JSON
ashlr config set editor vscode  # change the editor used for deep links
```

### MCP

`ashlr` is the **single MCP entry point** for any agent. It discovers every MCP server already configured on your machine, starts each as a managed child process, and proxies all their tools through one stdio gateway — namespaced `<server>__<tool>` so there are no collisions.

| Command | What it does |
|---|---|
| `ashlr mcp` | Run the aggregation gateway on stdio. (This is what you register in your agent.) |
| `ashlr mcp list` | Print the registry: every discovered server, where it was found, and its tool count. |
| `ashlr mcp doctor` | Health-probe each downstream server (start -> list tools -> tear down). |
| `ashlr mcp install <claude\|ashlrcode> [--config <path>]` | Idempotently register the gateway in a target agent's config (backs up the file first). |

```sh
ashlr mcp install claude        # register the gateway in Claude Code, then restart it
ashlr mcp list                  # see all servers + tool counts (env values redacted)
```

### Orchestrate

Give `ashlr run` a goal; it decomposes it into a task-graph (DAG), runs independent tasks in parallel on your local model, and synthesizes a final answer — all within hard budget and step guardrails. **Cloud is off by default** — `ashlr run` refuses to call a cloud endpoint unless you pass `--allow-cloud` and the key is present.

**Watchable, robust runs (M11).** `ashlr run` now streams progress live as it happens: task starts, model token deltas, tool calls, retries, and verification verdicts all appear in real time on stderr. Each task is retried on transient failures with bounded exponential back-off, then verified against a cheap heuristic (and optionally a model check) before the result is accepted — all under the global budget ceiling. Engine delegation to `claude`, `aw`, or `ashlrcode` uses each tool's actual CLI (confirmed at build time); when `phantom` is enabled, subprocess spawns are wrapped via `phantom exec --` so secrets are injected by Phantom rather than the hub.

| Command | What it does |
|---|---|
| `ashlr run "<goal>" [flags]` | Plan -> parallel fan-out -> synthesize. Resumable and persisted to `~/.ashlr/runs/`. |
| `ashlr run show <id>` | Print the full `RunState` for a past run. |
| `ashlr runs [--json]` | List all past runs, newest first. |

Key flags: `--budget N` (default 32000 tokens) · `--max-steps N` (default 50) · `--parallel N` (default 3) · `--engine builtin\|ashlrcode\|aw\|claude` · `--stream` / `--no-stream` (default stream on when stderr is a TTY) · `--allow-cloud` · `--no-tools` · `--no-memory` · `--resume <id>`.

```sh
ashlr run "Summarize the last 5 commits in ashlr-hub and flag risky changes"
ashlr run "Audit the MCP registry for duplicate tool names" --budget 8000 --parallel 4
ashlr run "Refactor the config module" --engine claude   # delegate to Claude Code
ashlr run "Generate test stubs" --no-stream --json       # clean JSON stdout, no live stream
ashlr runs                      # list past runs with cost + status
```

Budget and step limits are **hard ceilings** — exceeding either aborts immediately, preserves all partial results, and lets you `--resume`. Retries are bounded; the verification step never re-runs a task that would push usage over the budget.

### Cost-optimal routing

`ashlr` is local-first not just by philosophy but by mechanical guarantee: every task is routed to the best available **local** model (Ollama / LM Studio) first. Cloud endpoints are structurally unreachable unless you explicitly opt in.

#### How routing works

For each task in a run or swarm, `chooseRoute` inspects `cfg.models.providerChain`, probes which local providers are live, and selects the best match. Optional `cfg.models.routing[]` rules let you pin specific task patterns to a particular model (e.g., route "summarize" tasks to a lighter model). The result is a `RouteDecision` — `{provider, model, tier, reason}` — logged with every task so you always know exactly what ran where.

#### Cloud: only on explicit failure + explicit flag

If a local task fails (empty/error result), the M11 verify loop marks it `!ok`, or it exceeds an optional latency threshold, the orchestrator can escalate to a cloud provider for **one retry** — but only when:

1. `--allow-cloud` is passed to `ashlr run` or `ashlr swarm`, **and**
2. The cloud provider API key is actually present in the environment.

Both conditions must be true simultaneously. If either is absent, the retry stays local (or marks the task `needs-attention`). There is **no automatic cloud fallback**, no silent billing, and no "best effort" that secretly calls OpenAI when Ollama is slow.

```sh
# default — 100% local; escalation stays local if a task fails
ashlr run "Audit the MCP registry"

# opt-in cloud escalation for failed tasks only (key must be present)
ashlr run "Audit the MCP registry" --allow-cloud
```

#### No auto-download, no auto-start

`ashlr` never downloads a model or starts a daemon on your behalf during normal operation. Those actions are opt-in subcommands:

```sh
ashlr models               # list local models (Ollama + LM Studio) — read-only
ashlr models pull llama3   # explicit download — prints size warning + requires confirm
ashlr models start         # best-effort start of an installed-but-idle Ollama daemon
```

`ashlr models pull` is the only path that runs `ollama pull`. It is never called during a run, route, or escalation, even if no local model is available.

#### Savings + forecast in `ashlr pulse`

Local tasks cost **$0.00**. `ashlr pulse` now shows a savings line that tells you what those tokens would have cost on a cloud provider, and a projected monthly spend based on recent usage:

```
Local savings (est):  $0.42   |   Cloud would-have-been: $0.47   |   Projected 30d: $0.18
```

All numbers are clearly marked as estimates. The same data is available machine-readable via `ashlr pulse --json` (the `CostForecast` fields are merged into the rollup output).

#### Config

```jsonc
// ~/.ashlr/config.json (relevant fields)
{
  "models": {
    "providerChain": ["ollama", "lmstudio"],   // local-first order
    "routing": [                                // optional per-task overrides
      { "match": "summarize", "model": "llama3:8b" },
      { "match": "verify",    "model": "mistral:7b" }
    ],
    "escalate": {
      "onFailure": true,      // escalate to cloud on failure (--allow-cloud still required)
      "latencyMs": 30000      // also escalate if a task takes longer than 30s
    }
  }
}
```

---

### Observe

| Command | What it does |
|---|---|
| `ashlr pulse [--window 1d\|7d\|30d] [--project <name>]` | Local usage dashboard: window summary, by-project table, top models, cost, budget status. |

```sh
ashlr pulse                     # 7-day window (default)
ashlr pulse --window 30d --json # machine-readable ActivityRollup
```

`ashlr pulse` is computed **entirely offline** from usage *metadata* in your Claude Code transcripts (token counts, model id, timestamp, project path) — never message content. Set `telemetry.budgetUsd` / `budgetTokens` in config to get warn/over banners at 80%+ of any cap.

### Lifecycle

| Command | What it does |
|---|---|
| `ashlr new <name> [--template t] [--category c] [--here]` | Scaffold an ecosystem-wired project (CLAUDE.md, `.mcp.json` gateway, genome stub, entry point) and register it in the index. |
| `ashlr ship [path] [--deploy t] [--strict] [--confirm]` | Pre-ship gate (supply-chain + test/lint/build), then optional deploy. |

Templates: `minimal` (default) · `node-cli` · `mcp-server` · `next-app`. Deploy targets: `vercel` · `stack` · `gh` · `morphkit`.

```sh
ashlr new my-server --template mcp-server
ashlr ship --deploy vercel              # DRY-RUN by default — prints what would run
ashlr ship --deploy vercel --confirm    # actually deploy
```

`ashlr ship` is **read-only and dry-run by default**. The gate never writes, pushes, or deploys; any outward action requires `--confirm`.

### Memory

A cross-project, local-first shared memory. Every project genome, every taught note, and every `ashlr run` share one searchable store — all on your machine, never sent anywhere.

| Command | What it does |
|---|---|
| `ashlr learn "<note>" [--project p] [--tags a,b]` | Append a memory entry to `~/.ashlr/genome/hub.jsonl` (append-only). |
| `ashlr recall "<query>"` | Search the aggregated genome; ranked by keyword/TF-IDF, optionally reranked via local Ollama embeddings. |
| `ashlr genome` | Genome health: total entries, projects covered, store size, last-learned, embeddings availability. |

```sh
ashlr learn "Use bge-m3 for local embedding rerank" --tags ollama,embeddings
ashlr recall "embedding model setup"
```

`ashlr run` is **memory-aware by default** — it injects the top-k `recall(goal)` hits into each sub-agent's prompt (cap via `genome.maxRecall`, disable per-run with `--no-memory`).

#### Compounding memory (M16)

The genome grows richer with every run — automatically. Each completed `ashlr run` or `ashlr swarm` appends a concise structured entry to the genome (goal, approach/outcome summary, project, tags). Over time the genome accumulates institutional knowledge about what has been tried, what worked, and what failed — without any manual effort.

**Auto-capture**

After every run or swarm completes, a structured `GenomeEntry` summarising the work is appended to `~/.ashlr/genome/hub.jsonl` in the background. Capture is:

- **Metadata/summary only** — never raw prompts, completions, tool arguments, or file contents. Hard-capped at ~800 chars per entry.
- **Dedupe-aware** — near-duplicate entries for the same goal are detected and skipped.
- **Non-blocking** — fires after the result is returned; never slows a run.
- **Opt-out per invocation**: pass `--no-capture` to `ashlr run` or `ashlr swarm`, or set `genome.autoCapture: false` in `~/.ashlr/config.json` to disable globally.

```sh
ashlr run "Audit the MCP registry"               # auto-captures on completion (default)
ashlr run "Audit the MCP registry" --no-capture  # skip capture for this run
```

**Teach a note manually**

```sh
ashlr genome --teach "Always pre-warm Ollama before a long swarm — cold-start adds ~30s"
ashlr genome --teach "bge-m3 rerank improves recall precision ~20%" --tags ollama,embeddings
```

High-value notes are tagged `teach` and are immediately searchable via `ashlr recall`.

**Consolidate duplicates**

As the genome grows, near-duplicate entries accumulate. Consolidation merges them into one canonical entry while preserving all provenance:

```sh
ashlr genome consolidate
# Writes a timestamped backup of hub.jsonl first (no data loss)
# Merged entry retains: count, firstSeen, lastSeen, union of all tags, full content
# Reports: before=142  after=98  merged=44
```

A timestamped backup of `hub.jsonl` is always written before any mutation. Nothing is silently deleted.

**Playbook: synthesised prior art**

Before planning a run, `ashlr` recalls similar past entries and synthesises a concise "how we approached this before — what worked / what failed / cost" playbook, injected (bounded by char cap) into the agent's planning context. This upgrades M7's raw-recall injection into a structured synthesis.

```sh
# Inspect the playbook for a goal before running
ashlr genome playbook "Add a plugin system to ashlr-hub"
# Prints: relevant past attempts, outcomes, lessons, cost summary

# Playbook injection is on by default during ashlr run / ashlr swarm
# Disable with --no-memory or set genome.playbookOnRun: false in config
```

Synthesis uses the **local provider only**. If synthesis fails or the budget is exhausted, it falls back to a concatenated recall summary — never errors, never calls a cloud endpoint.

**Export your genome**

The genome is yours. Export it to a portable format at any time — no lock-in:

```sh
ashlr genome export ~/genome-backup.json             # JSON array of GenomeEntry objects
ashlr genome export ~/genome-backup.md --format md   # human-readable Markdown
```

Export is strictly read-only and never modifies the genome store.

**Privacy**

| Guarantee | Detail |
|---|---|
| Metadata/summary only | Capture never reads prompts, completions, tool args, or file contents |
| Hard-capped entries | Each auto-captured entry is capped at ~800 chars |
| Local-only | All genome data stays under `~/.ashlr/genome/`; no cloud sync |
| No data loss | Consolidation is backup-first; `export` is read-only; store is append-only |
| Opt-out anywhere | `--no-capture` per run; `autoCapture: false` globally; `--no-memory` skips injection |

**Config**

```jsonc
// ~/.ashlr/config.json (relevant fields)
{
  "genome": {
    "maxRecall": 5,           // top-k recall hits injected into prompts
    "injectOnRun": true,      // inject genome context into agent runs (M7)
    "autoCapture": true,      // auto-capture run/swarm summaries on completion (M16)
    "playbookOnRun": true     // synthesise playbook for planning context (M16)
  }
}
```

---

### Spec-driven swarms

Author an ambitious end-state spec, then unleash a fleet of local agents against it — all within hard budget and safety guardrails.

**Step 1 — author a spec.**

```sh
# Draft a structured spec (Context / North Star / Pillars / Roadmap / Verification)
ashlr spec new "Add a plugin system to ashlr-hub" --project ~/Desktop/github/dev-tools/ashlr-hub
# → .ashlr/specs/add-a-plugin-system-v1.md  +  .ashlr/specs/add-a-plugin-system-v1.json

ashlr spec list                                   # id · version · status · goal
ashlr spec show add-a-plugin-system-v1            # full markdown body
ashlr spec refine add-a-plugin-system-v1 "Add hot-reload support to the plugin lifecycle"
# → produces v2; v1 is preserved
```

**Step 2 — run an agent fleet against the spec.**

```sh
# Dry-run first: see the SwarmPlan (phases + tasks) with zero cost
ashlr swarm add-a-plugin-system-v1 --dry-run

# Real swarm: SCAFFOLD → BUILD(parallel) → INTEGRATE → VERIFY → REVIEW
ashlr swarm add-a-plugin-system-v1 --budget 64000 --parallel 3

# Tighter budget, single worker lane, on a temp scratch dir
ashlr swarm "Add config validation" --budget 16000 --parallel 1 --project /tmp/scratch

# Fire-and-forget: returns the swarm id immediately; work runs in the background
ashlr swarm add-a-plugin-system-v1 --budget 64000 --background
# → swarm id: swarm_abc123  (progress written to ~/.ashlr/swarms/swarm_abc123.json)

# Resume after an interruption or budget hit
ashlr swarm add-a-plugin-system-v1 --resume swarm_abc123 --budget 32000

ashlr swarms                                      # list all runs: id · status · cost
ashlr swarm show swarm_abc123                     # per-task status, usage, errors
```

**Safety model — non-negotiable defaults.**

| Guardrail | Behaviour |
|---|---|
| Hard total budget | Single `RunBudget` ceiling across all tasks and phases; aborts cleanly when hit. |
| Bounded concurrency | `--parallel` default 3, max 8; planner caps ≤6 tasks per phase. |
| Local-first | Runs on builtin/Ollama by default; `--allow-cloud` required for cloud endpoints. |
| No recursion | Sets `ASHLR_IN_SWARM=1` on subprocess env; refuses to start if already set. |
| No outward action | Tasks cannot push, deploy, or create repos without an explicit opt-in flag. |
| Resumable | `SwarmRun` persisted to `~/.ashlr/swarms/<id>.json` after every step. |

---

### Surfaces

#### Interactive TUI (`ashlr tui` / `ashlr dash`)

A live, auto-refreshing terminal dashboard — zero new runtime dependencies, built on Node.js builtins and the ANSI helpers in `src/cli/ui.ts`.

```sh
ashlr tui           # interactive alt-screen dashboard, auto-refreshes every ~2 s
ashlr dash          # alias — same thing
ashlr tui --once    # render one frame to stdout and exit (headless / scripting / tests)
```

**Tabs**

| Key | Tab | What it shows |
|---|---|---|
| `1` | Overview | Repo health (dirty/stale counts), ecosystem tool availability, 7-day activity line |
| `2` | Runs | Recent agent runs — status, goal, token usage |
| `3` | Swarms | Live phase/task burndown for active and recent swarms (done/total per phase) |
| `4` | Pulse | 7-day cost, tokens, and per-project activity from the local observability rollup |
| `5` | MCP | Discovered MCP server health (name, tool count, ok/fail) |

**Key bindings**

| Key | Action |
|---|---|
| `Tab` / `Shift-Tab` | Cycle through tabs |
| `1` – `5` | Jump directly to a tab |
| `j` / `k` | Move selection up/down |
| `r` | Force-refresh data |
| `Enter` | Show detail for selected item |
| `q` / `Ctrl-C` | Quit |

**Non-TTY / headless**: when stdout is not a TTY (pipe, redirect, CI), the TUI automatically prints one frame and exits without entering raw mode or alt-screen — same behavior as `--once`.

**Terminal safety**: alt-screen, cursor visibility, and raw mode are always restored on quit, signal (`SIGINT`/`SIGTERM`), or thrown exception. The terminal is never left corrupted.

#### Web dashboard (`ashlr serve`)

A polished, fully local web dashboard — no CDN, no external fonts or scripts, no network calls. Everything is bundled in the repo and served by a Node `http` server bound to `127.0.0.1`.

```sh
ashlr serve                     # start on http://127.0.0.1:7777 (default port)
ashlr serve --port 8080 --open  # custom port; open the browser automatically
ashlr serve --allow-dispatch    # enable the opt-in POST /api/run endpoint (prints token)
```

**Pages**

| Page | What it shows |
|---|---|
| Overview | Aggregated ecosystem snapshot (git health, tools, 7-day activity) |
| Runs | Recent agent runs — status, goal, token/cost usage |
| Swarms | SVG dependency-graph of the swarm DAG (nodes colored by phase/status, edges for deps) + live burndown chart |
| Pulse | SVG bar charts of cost/token usage by project, day, and model |
| Genome | Full genome list + instant search box (`/api/genome?q=`) |

All pages live-update via a Server-Sent Events stream (`/api/events`) — no manual refresh needed.

**JSON API** (read-only by default)

| Endpoint | Handler |
|---|---|
| `GET /api/snapshot` | `buildSnapshot(cfg)` aggregate |
| `GET /api/runs` / `/api/run/:id` | `listRuns` / `loadRun` |
| `GET /api/swarms` / `/api/swarm/:id` | `listSwarms` / `loadSwarm` |
| `GET /api/pulse[?window=1d\|7d\|30d]` | `buildRollup` (default 7d) |
| `GET /api/genome[?q=<query>]` | `recall(q, cfg)` or `loadGenome(cfg)` |
| `GET /api/events` | SSE stream (bounded poll, cleared on disconnect) |
| `POST /api/run` | **Opt-in only** — requires `--allow-dispatch` + session token header |

**Security posture**

| Guardrail | Behaviour |
|---|---|
| Local-only bind | `127.0.0.1` only — never `0.0.0.0`; not reachable from the network |
| DNS-rebinding protection | Host-header allowlist (`localhost`/`127.0.0.1`/`::1` ± port) checked first — all other hosts → 403 |
| Read-only by default | No mutating endpoints unless `--allow-dispatch` is explicitly passed |
| Token-guarded dispatch | Per-session token (printed at start, required in header, constant-time compared) — defeats CSRF/drive-by POSTs |
| Path-traversal-safe | Static serving resolves under the assets dir; `..`, absolute paths, null bytes, and symlink escapes → 404 |
| No SSRF | The server makes no outward network calls |
| No CDN / fully offline | All assets bundled in the repo; works without any internet access |
| Ephemeral | `Ctrl-C` stops the server cleanly; SSE timers cleared; no leaks |
| Zero new deps | `http` / `crypto` / `fs` / `path` / `url` builtins only |

#### Raycast extension

The Raycast extension at `src/raycast/` adds two new commands and makes the existing views live:

| Command | What it does |
|---|---|
| **Dispatch Run** | Form UI (goal, budget, parallel, engine) that invokes `ashlr run --json` and streams output. Bounded and local-first — matches CLI guardrails. |
| **Swarms** | Lists active and recent swarms with live done/total task counts and per-phase progress. Actions: show detail or open the target project. |
| **Pulse** _(upgraded)_ | Auto-revalidates on a short interval via `usePromise` — no manual refresh needed. |
| **Attention** _(upgraded)_ | Same live-revalidation treatment as Pulse. |

All commands are registered in `src/raycast/package.json`. Raycast dispatch is the only outward action from the Surfaces layer; it uses the same bounded, local-first `ashlr run` path as the CLI.

---

### Maintain

| Command | What it does |
|---|---|
| `ashlr update` | Update the installed `ashlr` CLI from its git remote and rebuild. |

---

## Ecosystem cohesion

`ashlr-hub` projects its unified `~/.ashlr/config.json` into the environment of
every tool it spawns — so one config drives the entire suite without modifying any
of the independently-shipped tools.

When the hub starts a child process (an `ashlrcode` / `aw` agent run, an MCP
downstream server, or a deploy tool like `vercel` or `stack`), it merges a set of
non-secret env vars derived from your config into that child's environment before
exec. Common endpoint vars (`OLLAMA_HOST`, `OLLAMA_BASE_URL`, `LM_STUDIO_URL`,
`OPENAI_BASE_URL`), provider identity (`ASHLR_LLM_PROVIDER`, `ASHLR_PROVIDER_CHAIN`),
model name (`ASHLR_MODEL`, `AC_MODEL`), paths (`ASHLR_CONFIG`, `ASHLR_GENOME_DIR`,
`ASHLR_ROOTS`), and a local-first flag (`ASHLR_LOCAL_FIRST=1`) are all set
automatically.

**No secret values are ever injected.** API keys are Phantom's responsibility and
reach child processes only via normal environment inheritance. The bridge maps
endpoints, model names, paths, and flags — nothing else.

The implementation lives in `src/core/env-bridge.ts` (`buildToolEnv` /
`withToolEnv`) and is applied at every spawn site in the hub.

---

## Architecture

`ashlr-hub` is a TypeScript ESM (NodeNext) project. Core logic lives in `src/core/`, the CLI dispatch in `src/cli/`, and the Raycast extension in `src/raycast/` (its own package). `core/` and `cli/` carry **zero runtime dependencies** beyond the MCP SDK.

| Area | Modules |
|---|---|
| Index & navigation | `config` · `git` · `classify` · `index-engine` · `tidy` |
| Identity & models | `providers` · `phantom` · `doctor` |
| MCP gateway | `mcp-registry` · `mcp-gateway` · `tools-registry` |
| Orchestration | `run/provider-client` · `run/budget` · `run/agent-loop` · `run/orchestrator` |
| Observability | `observability/usage-source` · `observability/rollup` · `observability/budget-alert` |
| Lifecycle | `lifecycle/templates` · `lifecycle/scaffold` · `lifecycle/ship` |
| Memory / genome | `genome/store` · `genome/recall` · `genome/capture` · `genome/consolidate` · `genome/playbook` · `genome/export` |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full module map and data flow.

---

## Local-first & private

`ashlr-hub` is built so your machine is the source of truth and nothing leaves it without your say-so:

- **Local models first.** Provider resolution probes LM Studio (`:1234`) and Ollama (`:11434`) and uses the first one up. `ashlr run` will not call a cloud API unless you pass `--allow-cloud` and the key is present — otherwise it errors rather than silently billing you.
- **Metadata-only telemetry.** `ashlr pulse` reads only usage metadata (token counts, model id, timestamp, project path) from transcripts. Prompts, completions, tool arguments, and file contents are never read, stored, or printed. All rollups stay under `~/.ashlr/`.
- **Phantom secrets, read-only.** The [`phantom`](https://github.com/nicholasgasior/phantom) integration surfaces only secret *names* and vault status — values are never read, captured, or printed.
- **Private memory.** The genome lives under `~/.ashlr/genome/` and each repo's `.ashlrcode/genome/`. Embeddings (when used) are computed locally via Ollama; no cloud call is ever made. Auto-capture (M16) records metadata/summary only — never prompts, completions, or file contents. The full genome is always exportable (`ashlr genome export`) in a portable format; no lock-in.

---

## Requirements

- **macOS**
- **Node.js 22+**
- `~/.local/bin` on your `PATH`
- Optional: [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) for local agent runs; [`phantom`](https://github.com/nicholasgasior/phantom) for secrets; [Raycast](https://raycast.com) for the extension.

---

## Development

```sh
npm run build      # tsc -> dist/
npm run dev        # tsx — no compile step, fast iteration
npm test           # vitest
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

CI runs typecheck, lint, build, and test on Node 22 for every push and PR.

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow, coding conventions, and how to keep the build green (tests, lint, and typecheck must pass).

---

## License

[MIT](./LICENSE) © Mason Wyatt ([@masonwyatt23](https://github.com/masonwyatt23) · [ashlr.ai](https://ashlr.ai))
