# ashlr-hub

**Command center for the Ashlr ecosystem.** Indexes everything on Mason's Desktop — ~69 git repos across categorized folders — and exposes it through a fast CLI (`ashlr`) and a Raycast extension. Both read from the same `~/.ashlr/index.json`. M2 adds identity awareness (Phantom secrets), local-model discovery (LM Studio + Ollama), and a one-glance health check.

---

## Overview

`ashlr-hub` scans your Desktop's `github/<category>/<repo>` tree and document folders, classifies each entry, attaches git status, and writes a persistent index. From there you can fuzzy-jump into any project, tidy loose files, check repo health, run onboarding, or browse everything from Raycast.

---

## Install

### Prerequisites

- Node.js v22+
- `~/.local/bin` on your `PATH` (already configured)

### One-command install

```sh
./install.sh
```

That script:
1. Runs `npm run build` (compiles TypeScript to `dist/`)
2. Symlinks `bin/ashlr` → `~/.local/bin/ashlr`
3. Verifies `ashlr help` runs cleanly

The script is idempotent — safe to re-run after pulling updates.

### Manual install

```sh
npm run build
ln -sf "$(pwd)/bin/ashlr" ~/.local/bin/ashlr
chmod +x bin/ashlr
ashlr help
```

---

## CLI reference

All commands are zero-dependency (Node builtins only). The binary is `ashlr`.

### `ashlr init [--yes]`

Idempotent onboarding. Run once after install (or any time) to ensure your config is valid, detect local models, and optionally enable Phantom secrets.

- Creates `~/.ashlr/config.json` with sensible defaults if it does not exist.
- Detects LM Studio (`:1234`) and Ollama (`:11434`) and probes for available models.
- Checks whether `phantom` is installed; when present, enables the integration automatically (`phantom.enabled: true`). It does **not** prompt for phantom.
- Prompts for the editor only when run interactively; `--yes` / non-TTY auto-detects it.
- `--yes` (or non-TTY stdin) — accepts all defaults silently, never prompts. Safe to run in CI or scripts.
- Exits non-zero when the resulting health check has any failures.

```sh
ashlr init          # interactive onboarding
ashlr init --yes    # non-interactive; accept all defaults
ashlr init --json   # machine-readable InitResult JSON
```

Example output (`ashlr init --yes`, first run, Ollama up / LM Studio down):

```
  ashlr init

  Config not found. Creating ~/.ashlr/config.json
  ✓ phantom v0.6.0 not initialized
     run: phantom init to initialize a vault

  Probing local model providers…
  ○ lmstudio   down http://localhost:1234/v1/models (fetch failed)
  ✓ ollama up http://localhost:11434/api/tags — llama3, qwen2.5, deepseek-r1 +6 more
  active provider: ollama

  ✓ Created ~/.ashlr/config.json

  Health checks:
  ! Index file present                      ~/.ashlr/index.json not found — run ashlr index to build it
     fix: ashlr index
  ! Phantom secrets CLI                     phantom v0.6.0 installed but vault not initialized
     fix: phantom init
  ! Local provider: lmstudio                http://localhost:1234/v1/models is down — fetch failed
     fix: Start LM Studio and enable the local server

  ! init complete  7 pass  3 warn
```

---

### `ashlr doctor`

One-glance health check. Probes the runtime (Node, git, PATH, install), config, index, Phantom integration, the ashlr MCP plugin, and every provider endpoint; prints a structured report grouped into Failures / Warnings / Passing and exits non-zero (1) if any check fails.

```sh
ashlr doctor          # human-readable, color when TTY
ashlr doctor --json   # full DoctorReport as JSON
```

Checks use glyphs `✓` (pass) `!` (warn) `✗` (fail), each with an optional `fix:` hint. The summary line is space-separated (`8 pass  3 warn`) and omits zero counts.

Example output (Ollama up / LM Studio down, vault not yet initialized):

```
  ashlr doctor  — 6/8/2026, 7:17:50 PM

  Warnings
  ! Index file present                      ~/.ashlr/index.json not found — run ashlr index to build it
     fix: ashlr index
  ! Phantom secrets CLI                     phantom v0.6.0 installed but vault not initialized
     fix: phantom init
  ! ashlr MCP plugin registered             ashlr MCP server not found in ~/.claude/settings.json, ~/.mcp.json, or ~/.claude.json
     fix: Add the ashlr MCP server via: ashlr init  or install the ashlr Claude Code plugin
  ! Local provider: lmstudio                http://localhost:1234/v1/models is down — fetch failed
     fix: Start LM Studio and enable the local server

  Passing
  ✓ Node.js version                         v22.22.3 (>= 18 required)
  ✓ git installed                           git version 2.49.0
  ✓ ~/.local/bin on PATH                    /Users/you/.local/bin is on PATH
  ✓ ashlr installed                         /Users/you/.local/bin/ashlr
  ✓ Config file exists                      ~/.ashlr/config.json is valid JSON
  ✓ Index file freshness                    Index is 0.0 days old
  ✓ Local provider: ollama                  http://localhost:11434/api/tags is up (9 models)
  ✓ Active provider                         Active provider: ollama (local)

  8 pass  3 warn
```

> The `Active provider` check labels the resolved provider as `(local)` or, when only a cloud key (e.g. `ANTHROPIC_API_KEY`) is available, `(cloud fallback)`.

Exit code 0 when all checks pass or warn; non-zero when any check is `fail`.

---

### `ashlr index [--refresh]`

Build and persist the Desktop index to `~/.ashlr/index.json`.

- On first run (or when the index file is absent) it always rebuilds.
- `--refresh` forces a full rescan even if a cached index exists.

```sh
ashlr index           # build index if missing
ashlr index --refresh # force full rescan
```

---

### `ashlr go [query] [--open | --cd]`

Fuzzy-jump to a project. Without a query, presents an interactive picker over all indexed items. With a query, filters the list first.

- `--open` — opens the selected item in your configured editor (default: Cursor)
- `--cd` — prints the absolute path (pipe into `cd` via shell function)

```sh
ashlr go                        # interactive picker, all items
ashlr go artist-encyclopedia    # filter then pick
ashlr go precious-grove --open  # open in Cursor
ashlr go ashlrcode --cd         # print path for cd
```

Shell function tip — add to your `.zshrc`:

```sh
j() { local p; p=$(ashlr go "$1" --cd) && cd "$p"; }
```

---

### `ashlr status`

Summarize the current index: item counts by kind and category, dirty repos, and stale repos (not committed in `staleDays` days).

```sh
ashlr status
```

Example output:

```
Index: 71 items  (built 2 hours ago)
  repo        57
  doc-folder   6
  symlink      5
  other        3

Categories:
  dev-tools              12
  side-projects          18
  professional-tools      7
  artist-encyclopedias    4
  client-engagements      6
  forks                   5
  ashlrai                 5

Dirty repos:   3
Stale repos:   8  (> 30 days)
Activity (7d): 142 k tokens in / 38 k out  $0.84 est.
```

---

### `ashlr ls [category]`

List all indexed items. Optionally filter by category name.

```sh
ashlr ls                   # all items
ashlr ls dev-tools         # only dev-tools repos
ashlr ls side-projects
```

---

### `ashlr open <query>`

Resolve `query` to an indexed item (name match) and open it in your configured editor.

```sh
ashlr open ashlr-hub
ashlr open precious-grove
```

If the query matches multiple items, an interactive picker is shown.

---

### `ashlr tidy [--apply]`

Plan (or apply) moves of loose top-level Desktop files according to the tidy rules in `~/.ashlr/config.json`.

- By default, prints a dry-run plan — no files are moved.
- `--apply` executes the moves (mkdir -p destination, then rename).
- Keepers (see config) are never touched. Symlinks and git repos are never moved.

```sh
ashlr tidy           # dry-run: show what would move
ashlr tidy --apply   # execute the plan
```

---

### `ashlr config [get | set <key> <value> | path]`

Read or write `~/.ashlr/config.json`.

```sh
ashlr config path               # print path to config file
ashlr config get                # pretty-print full config
ashlr config get editor         # print one key
ashlr config set editor vscode  # update a key
ashlr config set staleDays 14
```

---

### `ashlr help`

Print usage summary.

```sh
ashlr help
```

---

## M4: `ashlr run` — local-first agent orchestrator

M4 adds a local-first agent orchestrator. Give it a goal; it decomposes the goal into a task-graph (DAG), runs independent tasks in parallel on your local model, and synthesizes a final answer — all within hard budget and step guardrails.

### Quick start

```sh
# Run a goal on the active local provider (Ollama / LM Studio)
ashlr run "Summarize the last 5 commits in ashlr-hub and identify any risky changes"

# Limit token budget and step count
ashlr run "Audit the MCP registry for duplicate tool names" --budget 8000 --max-steps 10

# Fan out up to 4 tasks in parallel
ashlr run "Compare llama3 vs qwen2.5 on three reasoning prompts" --parallel 4

# Output machine-readable JSON (suitable for piping / scripting)
ashlr run "List all Ollama models and their sizes" --json
```

### How it works

1. **Planning.** One chat call to the local model decomposes the goal into a `RunTask[]` DAG. Each task has a unique id, a sub-goal string, and a `deps[]` list referencing prerequisite task ids. On parse failure, the orchestrator falls back to a single task.

2. **Parallel fan-out.** The executor walks the DAG in waves: any task whose deps are all `done` becomes _ready_. Up to `--parallel N` ready tasks run concurrently (default: 3). Each task runs its own bounded chat/tool loop.

3. **Tool access.** When `--no-tools` is not set, each agent loop connects to the M3 MCP gateway (`ashlr mcp`) as an MCP client and exposes all discovered tools to the model. Disable with `--no-tools` for faster, tool-free runs.

4. **Synthesis.** Once all tasks complete (or the run is aborted), a final chat call synthesizes a unified answer from all task results.

5. **Persistence.** Run state is written to `~/.ashlr/runs/<id>.json` after every step. The run id is printed at the start so you can always resume or inspect it later.

### Engines

| Engine      | Description |
|-------------|-------------|
| `builtin`   | Default. Calls the active local provider directly (Ollama or LM Studio). |
| `ashlrcode` | Delegates to the `ashlrcode` CLI binary if installed; falls back to `builtin`. |
| `aw`        | Delegates to the `aw` (ashlr-workbench) binary if installed; falls back to `builtin`. |

```sh
ashlr run "..." --engine aw
```

### LOCAL-FIRST — cloud is off by default

`ashlr run` refuses to call any cloud endpoint unless you pass `--allow-cloud` and the relevant API key is present. Without `--allow-cloud`, if no local provider is reachable, the command exits with a clear error rather than silently billing a cloud API.

```sh
# Will error if only Anthropic/OpenAI keys are available and no local provider is up
ashlr run "..."

# Opt in to cloud (key must be present in env)
ashlr run "..." --allow-cloud
```

### Budget and step guardrails

Both limits are HARD ceilings — exceeding either one aborts the run immediately, preserving all partial results in state.

| Flag           | Default | Description |
|----------------|---------|-------------|
| `--budget N`   | 32000   | Maximum total tokens (in + out) across all tasks. |
| `--max-steps N`| 50      | Maximum total steps (model calls + tool calls) across all tasks. |
| `--parallel N` | 3       | Maximum tasks running concurrently. |

```sh
ashlr run "..." --budget 16000 --max-steps 20 --parallel 2
```

When the budget is hit mid-run, the orchestrator sets `status: 'aborted'`, writes the partial state, and exits non-zero. Use `--resume` to continue.

### Resumability

Every run is assigned a short id (e.g. `r_1a2b3c4d`) and persisted to `~/.ashlr/runs/<id>.json`. Completed task results are cached; `--resume` skips them and only re-runs pending or failed tasks.

```sh
# Resume a previously aborted or interrupted run
ashlr run "..." --resume r_1a2b3c4d

# List all past runs (newest first)
ashlr runs

# Inspect a specific run
ashlr run show r_1a2b3c4d

# Machine-readable list
ashlr runs --json
```

### Cost and usage reporting

After every run, `ashlr run` prints a usage summary. Local providers (Ollama, LM Studio) always show $0.00 cost. Cloud providers show an estimated cost when `--allow-cloud` is used.

```
Run r_1a2b3c4d  done  3 tasks  12 steps
  tokens in:   4 821
  tokens out:  1 203
  total:       6 024
  est. cost:   $0.00  (ollama — local)
  elapsed:     14.3 s
```

If `telemetry.pulse` is set in `~/.ashlr/config.json`, a run summary is POSTed to Pulse in the background after the run completes. This is best-effort: it never blocks the CLI and never throws.

### Full flag reference

```sh
ashlr run "<goal>"
  [--budget N]          # max total tokens (default 32000)
  [--max-steps N]       # max total steps (default 50)
  [--parallel N]        # max concurrent tasks (default 3)
  [--engine builtin|ashlrcode|aw]
  [--allow-cloud]       # permit cloud provider (off by default)
  [--no-tools]          # disable MCP tool access
  [--resume <id>]       # continue a prior run from cache
  [--json]              # emit JSON instead of human output

ashlr run show <id>     # print full RunState for a past run
ashlr runs [--json]     # list all past runs, newest first
```

---

## M5: `ashlr pulse` — local-first observability

M5 adds a local observability dashboard. All numbers are computed **entirely offline** from data already on your machine — no network call required.

### Privacy

`ashlr pulse` reads **only usage metadata** from Claude Code session transcripts (`~/.claude/projects/**/*.jsonl`): token counts, model id, timestamp, and the project path encoded in the directory name. It **never** reads, stores, or prints message content — no prompts, completions, tool arguments, or file contents. Aggregation results are written only under `~/.ashlr/`.

---

### `ashlr pulse`

Rich local dashboard: window summary, per-project table, top models, cost estimate, and budget status.

```sh
ashlr pulse                    # 7-day window (default)
ashlr pulse --window 1d        # last 24 hours
ashlr pulse --window 30d       # last 30 days
ashlr pulse --project ashlr-hub  # restrict to one project
ashlr pulse --json             # machine-readable ActivityRollup JSON
```

Example output:

```
ashlr pulse  —  7d window  (since 2026-06-01)

Totals
  tokens in:    142 312
  tokens out:    38 044
  est. cost:      $0.84
  sessions:          18
  commits:           34

By project
  Project                  Sessions  Commits  Tokens in   Cost
  ashlr-hub                      11       22     98 441  $0.58
  artist-encyclopedia-factory     5       10     32 104  $0.19
  ashlrcode                       2        2     11 767  $0.07

Top models
  claude-sonnet-4-6   120 k in / 33 k out  $0.71   14 calls
  claude-haiku-4-5     22 k in /  5 k out  $0.13    4 calls

Budget
  ✓ ok  —  $0.84 / $10.00 spent  (8%)  |  180 k / 500 k tokens  (36%)
```

The `--json` flag emits a full `ActivityRollup` object (see `src/core/types.ts`) suitable for scripting or the Raycast Pulse view.

---

### `ashlr status` — Activity line

`ashlr status` now includes a compact **Activity (7d)** line drawn from the same local rollup:

```
Activity (7d): 142 k tokens in / 38 k out  $0.84 est.
```

---

### Budget alerts

Set optional per-period caps in `~/.ashlr/config.json` under `telemetry`:

| Key              | Type              | Description                                  |
|------------------|-------------------|----------------------------------------------|
| `budgetUsd`      | number (USD)      | Max est. spend in the budget window          |
| `budgetTokens`   | number            | Max total tokens in the budget window        |
| `budgetWindow`   | `"1d"/"7d"/"30d"` | Rolling window for cap evaluation (def. 7d)  |

When >= 80% of any cap is reached, `ashlr pulse` prints a **warn** banner and `ashlr doctor` surfaces a warning check. When a cap is exceeded, the level escalates to **over**.

```
Budget
  ! warn  —  $8.43 / $10.00 spent  (84%)  — approaching USD cap for 7d window
```

```
Budget
  ✗ over  —  $11.20 / $10.00 spent  (112%)  — USD cap exceeded for 7d window
```

---

### Raycast Pulse view

The Raycast extension includes a **Pulse** command backed by `ashlr pulse --json`. It displays the same window summary and by-project table inside Raycast — no extra setup required beyond having `ashlr` on your PATH.

---

## Config reference — `~/.ashlr/config.json`

Created automatically on first run with sensible defaults. Edit directly or via `ashlr config set`.

```jsonc
{
  "version": 1,

  // Roots to scan (depth ~3)
  "roots": ["/Users/masonwyatt/Desktop"],

  // Default editor for deep links
  // "cursor" => cursor://file/<path>
  // "vscode"  => vscode://file/<path>
  "editor": "cursor",

  // Repos with no commit in this many days are flagged "stale" in `ashlr status`
  "staleDays": 30,

  // Maps category folder names to display labels
  "categories": {
    "dev-tools": "Dev Tools",
    "side-projects": "Side Projects",
    "professional-tools": "Professional Tools",
    "artist-encyclopedias": "Artist Encyclopedias",
    "client-engagements": "Client Engagements",
    "forks": "Forks",
    "ashlrai": "AshlrAI"
  },

  // Rules for `ashlr tidy` — evaluated in order; first match wins
  // matchType: "glob" | "regex" | "ext"
  "tidyRules": [
    { "match": "*.pdf",  "matchType": "ext",  "dest": "~/Desktop/Business/",  "description": "PDF documents" },
    { "match": "*.png",  "matchType": "ext",  "dest": "~/Desktop/Assets/",    "description": "Images" },
    { "match": "*.jpg",  "matchType": "ext",  "dest": "~/Desktop/Assets/",    "description": "Images" },
    { "match": "*.zip",  "matchType": "ext",  "dest": "~/Desktop/archive/",   "description": "Archives" }
  ],

  // Paths (names or absolute) that tidy will NEVER move
  "keepers": [
    "Rent Application.pdf",
    "ASHLRAI",
    "rde-other",
    "Keys & Recovery",
    "github",
    "Evero Notes",
    "OneDrive - James Madison University",
    "tts agents"
  ],

  // M2: Phantom secrets integration
  // Read-only — only secret names/status are ever surfaced, never values.
  // Set enabled: true via `ashlr init` or manually; `ashlr doctor` reports vault status.
  "phantom": {
    "enabled": true
  },

  // M2: AI model config — local-first provider chain
  // providerChain: ordered list; first reachable provider wins (lmstudio -> ollama -> anthropic).
  // Endpoints probed at runtime by `ashlr doctor` and `ashlr init`.
  "models": {
    "lmstudio": "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF",
    "ollama": "llama3",
    "providerChain": ["lmstudio", "ollama", "anthropic"]
  },

  // Telemetry / observability (optional)
  // pulse: POST run summaries here after each `ashlr run` (best-effort, non-blocking)
  // budgetUsd: warn/alert when est. cost in budgetWindow exceeds this amount (USD)
  // budgetTokens: warn/alert when total tokens in budgetWindow exceeds this count
  // budgetWindow: rolling window for budget checks — "1d" | "7d" | "30d" (default "7d")
  "telemetry": {
    "pulse": "",
    "budgetUsd": 10,
    "budgetTokens": 500000,
    "budgetWindow": "7d"
  },

  // Tool paths resolved at init time
  "tools": {
    "entire": "/usr/local/bin/entire",
    "aw": "/usr/local/bin/aw",
    "claude": "/usr/local/bin/claude",
    "pulse-agent": "/usr/local/bin/pulse-agent"
  }
}
```

Config is validated against `schema/config.schema.json` (JSON Schema draft-07).

---

## M2: Identity & model awareness

M2 turns `~/.ashlr/config.json` into the real unified source of truth and adds two new surface areas: **Phantom secrets** and the **local-model/provider registry**.

### Provider registry — local-first failover

`ashlr` probes local endpoints in `providerChain` order and resolves the first one that is up as the active provider. Probes never throw — every endpoint returns a typed result regardless of whether it is reachable.

| Provider  | Default endpoint                   | Model list source             |
|-----------|------------------------------------|-------------------------------|
| lmstudio  | `http://localhost:1234/v1/models`  | `data[].id` (OpenAI-compat)   |
| ollama    | `http://localhost:11434/api/tags`  | `models[].name`               |
| anthropic | cloud fallback (no probe)          | —                             |

`ashlr init` discovers available providers and writes discovered model names into config. `ashlr doctor` probes all endpoints and reports each one as `pass` / `warn` / `fail`. If neither local provider is reachable, the chain falls through to `anthropic`.

### Phantom secrets integration

`ashlr` integrates with the [`phantom`](https://github.com/nicholasgasior/phantom) secrets CLI for identity management. The integration is **strictly read-only** — secret values are never read, captured, or printed. Only names and vault status are surfaced.

- `ashlr init` detects `phantom` on PATH and enables the integration automatically (sets `phantom.enabled: true`); it does not prompt.
- `ashlr doctor` reports: installed, version, initialized, and the count/names of secrets in the vault.
- `phantom.enabled: true` in config activates doctor checks for the vault.
- Phantom CLI flags are verified at runtime via `phantom --help`; the integration degrades gracefully if a subcommand is unavailable.

---

## M3: MCP aggregation gateway

M3 makes `ashlr` the **single MCP entry point** for any agent. It discovers every
MCP server already configured on the machine, starts each one as a managed child
process, and exposes all their tools through a single stdio gateway — tools
namespaced as `<server>__<tool>` so there are no collisions. Point any agent at
`ashlr mcp` and it instantly has access to every tool in your stack.

---

### `ashlr mcp`

Run the aggregation gateway on stdio. Discovers all configured MCP servers,
starts them (8 s timeout per server), and proxies `tools/list` and `tools/call`
to the correct downstream. Servers that fail to start are skipped with a warning
to stderr — they never crash the gateway.

```sh
ashlr mcp
```

This is the command you register in your agent config (see `ashlr mcp install`).

---

### `ashlr mcp list`

Print the full MCP registry: every discovered server, where it was found, and
how many tools it exposes. Env values are always redacted to `<set>`.

```sh
ashlr mcp list
```

Example output:

```
MCP registry  (4 servers)

  ashlr              ~/.claude/settings.json      12 tools
  phantom-secrets    ~/.claude/settings.json       8 tools
  filesystem         ~/.mcp.json                   6 tools
  github             ~/.mcp.json                   9 tools
```

---

### `ashlr mcp doctor`

Health-probe every discovered server: attempts to start it, list its tools, and
tear it down cleanly. Reports `ok` / `fail` per server with tool count and any
error message.

```sh
ashlr mcp doctor
```

Example output:

```
MCP server health

  ✓ ashlr              12 tools
  ✓ phantom-secrets     8 tools
  ✓ filesystem          6 tools
  ✗ github              0 tools  — spawn error: ENOENT npx
```

---

### `ashlr mcp install <target> [--config <path>]`

Idempotently add the `ashlr mcp` gateway to a target agent's `mcpServers`
config. The file is backed up before any write. If the `ashlr` entry already
exists, it is left unchanged (no clobber).

Supported targets:

| Target      | Default config path           |
|-------------|-------------------------------|
| `claude`    | `~/.claude/settings.json`     |
| `ashlrcode` | `~/.ashlrcode/settings.json`  |

Pass `--config <path>` to write to an arbitrary file instead of the default.

```sh
# Register the gateway in Claude Code
ashlr mcp install claude

# Register in ashlrcode
ashlr mcp install ashlrcode

# Write to a custom / temp path (useful for CI / testing)
ashlr mcp install claude --config /tmp/test-settings.json
```

After install, restart your agent. It will connect to `ashlr mcp` on stdio and
inherit every tool from every downstream server.

---

### Discovery: where servers are found

`ashlr mcp list` (and the gateway) scan these paths in order, deduping by server
name (first occurrence wins):

- `~/.claude.json`
- `~/.claude/settings.json`
- `~/.mcp.json`
- `~/.ashlrcode/settings.json`
- ashlr-workbench agent settings

The ashlr-plugin server (`"ashlr"`) and Phantom (`"phantom-secrets"`) are
recognized specially and surfaced prominently in `doctor` output.

---

### Ecosystem tools registry

`ashlr status` and `ashlr doctor` now include a tools table showing which
ecosystem tools are installed and their versions:

```
Ecosystem tools  (6 / 10 installed)

  phantom          v0.6.0   /usr/local/bin/phantom
  ashlr-plugin     v1.2.0   ~/.local/bin/ashlr
  ashlrcode        v0.9.1   ~/.local/bin/ashlrcode
  stack            —        not installed
  pulse-agent      v0.4.0   /usr/local/bin/pulse-agent
  aw               —        not installed
  morphkit         —        not installed
  binshield        —        not installed
  ashlr-md         —        not installed
  ashlr-hub        v0.3.0   ~/.local/bin/ashlr
```

---

## Raycast extension

The Raycast extension reads `~/.ashlr/index.json` directly — it does not re-scan. Run `ashlr index` at least once first.

### Import steps

```sh
# 1. Install extension dependencies
cd src/raycast
npm ci

# 2. Start the dev server (Raycast hot-reload)
npm run dev
```

Then in Raycast:

1. Open Raycast preferences → Extensions → click **+** → **Import Extension**
2. Select the `src/raycast` folder
3. The extension will appear as **"Ashlr Hub"**

### Available Raycast commands

| Command | Description |
|---|---|
| Search Projects | List view over all indexed items; filter by name or category |

Actions available on each item:

- **Open in Editor** — opens in Cursor (or VSCode if configured)
- **Reveal in Finder** — opens the folder in Finder
- **Copy Path** — copies the absolute path to clipboard

The extension re-reads `~/.ashlr/index.json` on each activation. Refresh the index with `ashlr index --refresh` from the terminal when you add new repos.

---

## Project structure

```
ashlr-hub/
├── bin/ashlr            # CLI entrypoint (ESM wrapper)
├── src/
│   ├── core/
│   │   ├── types.ts         # Canonical types (never redefine elsewhere)
│   │   ├── config.ts        # ~/.ashlr/ management
│   │   ├── git.ts           # Git introspection (child_process, no deps)
│   │   ├── classify.ts      # Category, language, kind, description
│   │   ├── index-engine.ts  # Desktop scanner + index persistence
│   │   ├── tidy.ts          # Tidy planner + applier
│   │   ├── providers.ts     # M2: local-model endpoint probing + registry
│   │   ├── phantom.ts       # M2: Phantom secrets status (read-only)
│   │   ├── doctor.ts        # M2: one-glance health check aggregator
│   │   ├── mcp-registry.ts  # M3: discover MCP servers across known config paths
│   │   ├── mcp-gateway.ts   # M3: stdio aggregation gateway + per-server probe
│   │   ├── tools-registry.ts # M3: detect ecosystem tools + versions via PATH
│   │   ├── run/             # M4: local-first agent orchestrator
│   │   │   ├── provider-client.ts  # ProviderClient over Ollama / LM Studio
│   │   │   ├── budget.ts           # RunUsage accounting + budget enforcement
│   │   │   ├── agent-loop.ts       # Bounded chat/tool loop per RunTask
│   │   │   └── orchestrator.ts     # DAG planner, parallel executor, persistence
│   │   ├── observability/   # M5: local-first usage rollups
│   │   │   ├── usage-source.ts     # Parse ~/.claude/projects + ~/.ashlr/runs (metadata only)
│   │   │   ├── rollup.ts           # buildRollup: aggregate tokens/cost/commits by window
│   │   │   └── budget-alert.ts     # evalBudget: cap evaluation + warn/over level
│   │   └── lifecycle/       # M6: project scaffold + ship gate
│   │       ├── templates.ts        # TEMPLATES[], getTemplate(), listTemplates()
│   │       ├── scaffold.ts         # scaffoldProject(), defaultCategory(), targetDir()
│   │       └── ship.ts             # runShipGate(), deploy()
│   ├── cli/
│   │   ├── index.ts     # argv dispatch (index/go/status/ls/open/tidy/config/doctor/init/mcp/run/runs/pulse/new/ship/help)
│   │   ├── run.ts       # M4: `ashlr run` + `ashlr runs` subcommand handlers
│   │   ├── pulse.ts     # M5: `ashlr pulse` dashboard
│   │   ├── mcp.ts       # M3: `ashlr mcp` subcommand dispatcher
│   │   ├── new.ts       # M6: `ashlr new` scaffold command
│   │   ├── ship.ts      # M6: `ashlr ship` pre-ship gate + deploy
│   │   ├── open.ts      # Editor / Finder / Terminal launchers
│   │   └── picker.ts    # fzf (if present) or readline picker
│   └── raycast/         # Raycast extension (own package.json)
│       └── src/
│           ├── lib/
│           │   ├── index.ts   # loadIndex()
│           │   └── open.ts    # openInEditor(), openInFinder()
│           └── commands/
├── schema/
│   └── config.schema.json
├── test/
├── dist/                # compiled output (git-ignored)
├── CONTRACT.md          # binding interface spec
├── CONTRACT-M2.md       # M2 extension to the contract
├── CONTRACT-M3.md       # M3 extension to the contract (MCP gateway)
├── CONTRACT-M4.md       # M4 extension to the contract (agent orchestrator)
├── CONTRACT-M5.md       # M5 extension to the contract (local-first observability)
├── CONTRACT-M6.md       # M6 extension to the contract (project lifecycle)
├── install.sh           # build + symlink installer
└── package.json
```

---

## Development

```sh
npm run build      # tsc → dist/
npm run dev        # tsx (no compile step; for quick iteration)
npm test           # vitest
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

Zero runtime dependencies in `core/` and `cli/` — Node builtins only.

---

## Milestone scope

### M1 — shipped, GREEN

- [x] Desktop index (repos, doc folders, assets, symlinks)
- [x] CLI: `index`, `go`, `status`, `ls`, `open`, `tidy`, `config`, `help`
- [x] Raycast extension (read-only list + open actions)
- [x] 108 tests passing

### M2 — identity & model awareness

- [x] `ashlr init` — idempotent onboarding, NON-TTY safe (`--yes`)
- [x] `ashlr doctor` — one-glance health check with pass/warn/fail + fix hints
- [x] Provider registry — LM Studio + Ollama probing, local-first failover chain
- [x] Phantom secrets integration — read-only, names/status only, never values
- [x] `phantom` + `models` config fields unified in `~/.ashlr/config.json`

### M3 — MCP aggregation gateway + ecosystem tools registry

- [x] `ashlr mcp` — stdio MCP gateway multiplexing all discovered MCP servers, tools namespaced as `<server>__<tool>`
- [x] `ashlr mcp list` — registry of all discovered servers + per-server tool counts (env values redacted)
- [x] `ashlr mcp doctor` — health-probe each downstream server; reports starts + tool count
- [x] `ashlr mcp install <claude|ashlrcode>` — idempotently register the gateway in a target mcpServers config (backs up file first)
- [x] Ecosystem tools registry — detect + version-report the full Ashlr tool stack via PATH
- [x] `ashlr status` + `ashlr doctor` surface ecosystem tool presence and versions

### M4 — local-first agent orchestrator

- [x] `ashlr run "<goal>"` — decompose a goal into a task-graph (DAG), run independent tasks in parallel on local models, synthesize a final answer
- [x] `ashlr runs` — list past runs with id, status, goal, token usage, and estimated cost
- [x] `ashlr run show <id>` — inspect a completed or aborted run in full
- [x] ProviderClient — thin chat layer over Ollama (native `/api/chat`) and LM Studio (`/v1/chat/completions`); LOCAL-FIRST by default; `--allow-cloud` opt-in
- [x] Task-graph executor — respects `deps[]`, fans out independent tasks up to `--parallel N`; HARD budget/step ceiling with clean abort and partial result preservation
- [x] Resumability — run state persisted to `~/.ashlr/runs/<id>.json` after every step; `--resume <id>` skips completed tasks and continues from cache
- [x] MCP tool access — agent loop connects to the M3 gateway as an MCP client; `--no-tools` disables
- [x] Pulse cost reporting — best-effort POST of a run summary to Pulse if `telemetry.pulse` is configured (never blocks)

### M5 — local-first observability (`ashlr pulse`)

- [x] `ashlr pulse` — rich local dashboard: window summary, by-project table, top models, cost, budget status; `--json`; `--window 1d|7d|30d`; `--project <name>`
- [x] `ashlr status` — compact `Activity (7d)` line (tokens in/out + est. cost) from local rollup
- [x] Budget alerts — `telemetry.budgetUsd` / `budgetTokens` / `budgetWindow` in config; `ashlr pulse` + `ashlr doctor` warn at 80% and alert when exceeded
- [x] Privacy-first — only usage metadata read from `~/.claude/projects/` transcripts (token counts, model, timestamp, project path); message content never touched
- [x] Raycast "Pulse" view — backed by `ashlr pulse --json`; no extra setup
- [x] Fully offline — all numbers computed locally from transcripts, `~/.ashlr/runs/`, and git log; Pulse cloud config is optional and informational only

### M6 — project lifecycle (`ashlr new` + `ashlr ship`)

- [x] `ashlr new <name>` — scaffold an ecosystem-wired project at `~/Desktop/github/<category>/<name>`; includes CLAUDE.md preset, `.mcp.json` ashlr-gateway, genome stub, README, package.json, .gitignore, entry point; `git init` by default; registers in the index. Refuses to overwrite an existing directory.
- [x] Templates: `node-cli`, `mcp-server`, `next-app`, `minimal` — each a complete agentic-engineering starter.
- [x] `--stack <recipe>` — delegates to `stack` when installed; warns clearly when absent.
- [x] `--here` — scaffolds into cwd instead of the default Desktop location.
- [x] `ashlr ship [path]` — pre-ship gate: supply-chain check (binshield if installed, else built-in dep check) + `test`/`lint`/`build` for every npm script present; per-check pass/warn/fail/skip report.
- [x] `--deploy vercel|stack|gh|morphkit` — DRY-RUN by default; `--confirm` required to actually deploy.
- [x] `--strict` — exits non-zero when any gate check is `fail`.
- [x] Runtime tool detection via `which`; morphkit absent prints guidance (`morphkit not installed — see morphkit.dev`).

## M6: `ashlr new` + `ashlr ship` — project lifecycle

M6 wires every new project into the Ashlr ecosystem from birth and gives every existing project a pre-ship gate before code leaves your machine.

---

### `ashlr new <name>`

Scaffold a new ecosystem-wired project at `~/Desktop/github/<category>/<name>`.

```sh
ashlr new my-tool
ashlr new my-server --template mcp-server
ashlr new my-app    --template next-app    --category side-projects
ashlr new quick     --template minimal     --no-git
ashlr new proto     --template node-cli    --stack myrecipe
ashlr new here-pkg  --here                  # scaffold into cwd
```

Every scaffold includes a complete **agentic-engineering layout**:

| File | Purpose |
|---|---|
| `CLAUDE.md` | Pre-configured Claude Code context preset |
| `.mcp.json` | Wires the `ashlr` MCP gateway into the project |
| `.ashlrcode/genome/` | Genome stub for ashlrcode sessions |
| `README.md` | Project readme with name + description |
| `package.json` | Ready-to-edit manifest |
| `.gitignore` | Sensible defaults |
| Entry point | Template-specific starter (e.g. `src/index.ts`, `src/server.ts`) |

After scaffolding, the project is registered in `~/.ashlr/index.json` automatically.

#### Templates

| `--template` | Description |
|---|---|
| `minimal` | Bare-bones starter — just the agentic layout + entry point (**default**) |
| `node-cli` | Node.js CLI with arg parsing, bin field, and build script |
| `mcp-server` | MCP server stub wired to the ashlr gateway |
| `next-app` | Next.js app starter with TypeScript and Tailwind |

#### Options

| Flag | Default | Description |
|---|---|---|
| `--template <t>` | `minimal` | Template to use |
| `--category <c>` | `side-projects` | Desktop category folder |
| `--stack <recipe>` | — | Run a `stack` recipe after scaffolding (requires `stack` installed) |
| `--here` | — | Scaffold into the current working directory instead of the default location |
| `--no-git` | — | Skip `git init` |

#### Safety

- **Refuses to overwrite** an existing directory — exits non-zero with a clear error.
- Writes **only** under the target directory; never touches anything outside it.

---

### `ashlr ship [path]`

Run a pre-ship gate on a project, then optionally deploy it.

```sh
# Gate only — read-only, safe to run any time
ashlr ship
ashlr ship ./my-app

# Gate + strict (fail the command on any failing check)
ashlr ship --strict

# Gate + dry-run deploy preview (default — prints what WOULD run, does nothing)
ashlr ship --deploy vercel
ashlr ship --deploy stack
ashlr ship --deploy gh

# Gate + actual deploy (only with --confirm)
ashlr ship --deploy vercel --confirm
ashlr ship --deploy gh     --confirm --strict
```

#### Gate checks

The gate is **read-only** and runs these checks in order:

| Check | Source | Notes |
|---|---|---|
| Supply-chain / dependency sanity | `binshield` if installed; built-in dep check otherwise | Looks for known vulnerable or suspicious packages |
| `npm test` | `package.json` `scripts.test` | Skipped if script absent |
| `npm run lint` | `package.json` `scripts.lint` | Skipped if script absent |
| `npm run build` | `package.json` `scripts.build` | Skipped if script absent |

Each check has one of four statuses: `pass`, `warn`, `fail`, or `skip`. The gate's `passed` flag is `false` when any check is `fail`.

Example output:

```
ashlr ship  —  /Users/you/Desktop/github/side-projects/my-app

Gate
  ✓ supply-chain      no issues found (built-in dep check)
  ✓ test              56 tests passed
  ✓ lint              0 errors
  ✓ build             dist/ ready

  4 pass  0 warn  0 fail

Deploy  (DRY-RUN — pass --confirm to actually deploy)
  would run: vercel --prod
```

#### Deploy targets

| `--deploy` | Tool required | Behavior when absent |
|---|---|---|
| `vercel` | `vercel` CLI | Error — install with `npm i -g vercel` |
| `stack` | `stack` CLI | Error — install stack |
| `gh` | `gh` CLI | Error — install GitHub CLI |
| `morphkit` | `morphkit` CLI | Guidance: `morphkit not installed — see morphkit.dev` |

Tool presence is detected at runtime via `which`. Currently on this machine: `stack`, `vercel`, `gh` are present; `binshield` and `morphkit` are absent.

#### Options

| Flag | Default | Description |
|---|---|---|
| `--deploy <target>` | — | Deploy target (`vercel` / `stack` / `gh` / `morphkit`) |
| `--strict` | off | Exit non-zero if any gate check is `fail` |
| `--confirm` | off | Actually run the deploy (default is dry-run) |

#### Safety defaults

- **Deploy is DRY-RUN by default.** Without `--confirm`, `ashlr ship` prints exactly what would run and exits 0.
- The gate is **read-only** — it never writes files, pushes to git, creates repos, or makes network calls beyond probing local scripts.
- `--confirm` is required for any outward-facing action (deploy, publish, push).

### Future

- [ ] Semantic search over the index using local embeddings
- [ ] Automated tidy + refactor suggestions
