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

| Command | What it does |
|---|---|
| `ashlr run "<goal>" [flags]` | Plan -> parallel fan-out -> synthesize. Resumable and persisted to `~/.ashlr/runs/`. |
| `ashlr run show <id>` | Print the full `RunState` for a past run. |
| `ashlr runs [--json]` | List all past runs, newest first. |

Key flags: `--budget N` (default 32000 tokens) · `--max-steps N` (default 50) · `--parallel N` (default 3) · `--engine builtin\|ashlrcode\|aw` · `--allow-cloud` · `--no-tools` · `--no-memory` · `--resume <id>`.

```sh
ashlr run "Summarize the last 5 commits in ashlr-hub and flag risky changes"
ashlr run "Audit the MCP registry for duplicate tool names" --budget 8000 --parallel 4
ashlr runs                      # list past runs with cost + status
```

Budget and step limits are **hard ceilings** — exceeding either aborts immediately, preserves all partial results, and lets you `--resume`.

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
| Memory / genome | `genome/store` · `genome/recall` |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full module map and data flow.

---

## Local-first & private

`ashlr-hub` is built so your machine is the source of truth and nothing leaves it without your say-so:

- **Local models first.** Provider resolution probes LM Studio (`:1234`) and Ollama (`:11434`) and uses the first one up. `ashlr run` will not call a cloud API unless you pass `--allow-cloud` and the key is present — otherwise it errors rather than silently billing you.
- **Metadata-only telemetry.** `ashlr pulse` reads only usage metadata (token counts, model id, timestamp, project path) from transcripts. Prompts, completions, tool arguments, and file contents are never read, stored, or printed. All rollups stay under `~/.ashlr/`.
- **Phantom secrets, read-only.** The [`phantom`](https://github.com/nicholasgasior/phantom) integration surfaces only secret *names* and vault status — values are never read, captured, or printed.
- **Private memory.** The genome lives under `~/.ashlr/genome/` and each repo's `.ashlrcode/genome/`. Embeddings (when used) are computed locally via Ollama; no cloud call is ever made.

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
