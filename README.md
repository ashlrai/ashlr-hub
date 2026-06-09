# ashlr-hub

**The local-first command center for the Ashlr dev-tool ecosystem.**

Index every project, run agents on local models, aggregate all your MCP servers, track spend, scaffold and ship, and give your whole stack shared private memory — all from one binary.

[![CI](https://github.com/masonwyatt23/ashlr-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/masonwyatt23/ashlr-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)

---

## Getting started in one command

Requires **macOS** and **Node.js 22+** with `~/.local/bin` on your `PATH`.

```sh
git clone https://github.com/masonwyatt23/ashlr-hub.git
cd ashlr-hub
npm ci && npm run build
./install.sh        # symlinks ashlr into ~/.local/bin (idempotent)
ashlr init          # one-command onboarding: config, models, editors, symlink, genome, doctor
```

`ashlr init` is the M20 capstone: it walks you through every setup step — config, local model detection, editor MCP wiring, symlink, genome dir, Phantom status — then runs `ashlr doctor` as a final gate and prints a `try: ashlr run / ashlr swarm / ashlr tui` next-steps summary. Re-runnable safely at any time; fully idempotent.

```
$ ashlr init
  config     ok   ~/.ashlr/config.json present
  models     detected   ollama: llama3:8b, mistral:7b
  editors    detected   claude, cursor (run --wire to register MCP gateway)
  symlink    ok   ashlr -> ~/.local/bin/ashlr
  genome     ok   ~/.ashlr/genome/ ready
  phantom    detected   logged in as mason · tier pro · team evero
  doctor     ok   all checks pass

you're set up — try: ashlr run / ashlr swarm / ashlr tui
```

**Optional flags:**

```sh
ashlr init --wire        # also wire the MCP gateway into every detected editor
ashlr init --wire --yes  # fully non-interactive (CI-safe)
ashlr init --json        # emit OnboardResult as JSON
```

`--wire` is the only mutating optional step. It uses the same backup-first, idempotent `wireEditor` path as `ashlr wire`. `ashlr init` **never** auto-downloads models, modifies secrets, or touches shell profiles.

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

## Self-healing

### `ashlr doctor --fix`

Run `ashlr doctor` at any time to see the health of your setup. Add `--fix` and the doctor applies every safe automated remediation it can, then tells you exactly what it fixed and what still needs your attention:

```sh
ashlr doctor          # health check: runtime, config, index, Phantom, MCP, providers
ashlr doctor --fix    # apply safe fixes, then report what was fixed vs. manual
ashlr doctor --fix --json   # emit FixAction[] for scripting
```

**What `--fix` can repair automatically (all safe, local, non-destructive):**

| Check | Automated fix |
|---|---|
| `config` | Create missing `~/.ashlr/config.json` from defaults (create-only; never overwrites) |
| `index` | Rebuild a stale or missing `~/.ashlr/index.json` (regenerates derived data only) |
| `local-bin` | Create the `ashlr` → `~/.local/bin` symlink when missing and the source resolves |
| `genome-memory` | Create `~/.ashlr/genome/` when absent (mkdir-only; never edits entries) |
| `mcp-plugin` | Register the ashlr MCP gateway in a detected editor config (backup-first + idempotent) |

Everything else — provider keys, PATH, Phantom login — stays in the **needs manual action** column with a one-line guidance hint. `doctor --fix` never auto-downloads models, never modifies secrets, and never touches shell profiles.

### Bounded runtime self-heal

The MCP gateway and model call sites are wrapped in a bounded self-heal loop (`src/core/run/self-heal.ts`). When something goes wrong at runtime, the hub classifies the failure and applies one recovery action before retrying — bounded by a hard `maxRestarts` ceiling:

| Failure | Recovery |
|---|---|
| Crashed MCP downstream | Restart, bounded retries → M3 skip-on-failure fallback |
| Local model OOM / error | Downgrade to a **smaller local** model (never cloud, never more cost) |
| Cloud rate-limit | Exponential backoff (only when `allowCloud` already set by the caller) |

Self-heal is always bounded (never loops), opt-out (`ASHLR_NO_HEAL=1`), and never escalates cost.

---

## What is this?

`ashlr-hub` is a command center for agentic engineers. It grew from a project navigator (M1) into a complete platform across 20 milestones:

| Capability | Commands |
|---|---|
| **Navigate** | `ashlr index` · `ashlr status` · `ashlr go` · `ashlr ls` · `ashlr open` · `ashlr tidy` |
| **Onboard + diagnose** | `ashlr init` · `ashlr doctor [--fix]` · `ashlr config` |
| **MCP gateway** | `ashlr mcp` · `ashlr mcp list` · `ashlr mcp doctor` · `ashlr mcp install` |
| **Orchestrate** | `ashlr run` · `ashlr runs` · `ashlr run show` |
| **Swarms** | `ashlr swarm` · `ashlr swarms` · `ashlr swarm show/verify/approve/rollback` |
| **Specs** | `ashlr spec new/list/show/refine` |
| **Models** | `ashlr models` · `ashlr models pull` · `ashlr models start` |
| **Observe** | `ashlr pulse` · `ashlr telemetry status/test` |
| **Lifecycle** | `ashlr new` · `ashlr ship` |
| **Memory** | `ashlr learn` · `ashlr recall` · `ashlr genome` |
| **Integrations** | `ashlr gh` · `ashlr vercel` · `ashlr wire` · `ashlr notify` |
| **Surfaces** | `ashlr tui` · `ashlr serve` · Raycast extension |
| **Maintain** | `ashlr update` |

It is **local-first by design**. Index, config, runs, rollups, and memory all live under `~/.ashlr/`. Agent runs default to local models and refuse to touch a cloud endpoint unless you explicitly opt in. Telemetry is metadata-only; secrets flow through Phantom, never through the hub.

---

## Commands

Every command is zero-runtime-dependency (Node builtins + MCP SDK). Add `--json` to most commands for machine-readable output.

### Navigate

| Command | What it does |
|---|---|
| `ashlr index [--refresh]` | Scan your project tree and persist `~/.ashlr/index.json`. |
| `ashlr status` | Index summary: counts by kind/category, dirty + stale repos, 7-day activity line. |
| `ashlr go [query] [--open\|--cd]` | Fuzzy-jump to a project. `--open` launches your editor; `--cd` prints the path. |
| `ashlr ls [category]` | List indexed items, optionally filtered. |
| `ashlr open <query>` | Resolve a name and open in your configured editor. |
| `ashlr tidy [--apply]` | Plan (dry-run) or apply moves of loose top-level files. |

Shell helper for instant `cd` — add to `.zshrc`:

```sh
j() { local p; p=$(ashlr go "$1" --cd) && cd "$p"; }
```

### Onboard + diagnose

| Command | What it does |
|---|---|
| `ashlr init [--wire] [--yes] [--json]` | Complete idempotent onboarding. See [Getting started](#getting-started-in-one-command). |
| `ashlr doctor [--fix] [--json]` | Health check across runtime, config, index, Phantom, MCP, providers. `--fix` applies safe automated remediations. |
| `ashlr config [get\|set <k> <v>\|path]` | Read or write `~/.ashlr/config.json`. |

### MCP

`ashlr` is the **single MCP entry point** for any agent. It discovers every MCP server already configured on your machine, starts each as a managed child process, and proxies all their tools through one stdio gateway — namespaced `<server>__<tool>` to prevent collisions.

| Command | What it does |
|---|---|
| `ashlr mcp` | Run the aggregation gateway on stdio. (Register this in your agent config.) |
| `ashlr mcp list` | Every discovered server, its source, and tool count (env values redacted). |
| `ashlr mcp doctor` | Health-probe each downstream (start → list tools → tear down). |
| `ashlr mcp install <claude\|ashlrcode>` | Idempotently register the gateway in a target agent config (backup-first). |

```sh
ashlr mcp install claude    # register in Claude Code, then restart it
ashlr mcp list              # see all servers + tool counts
```

### Orchestrate

Give `ashlr run` a goal; it decomposes it into a task-graph (DAG), fans out independent tasks in parallel on your local model, and synthesizes a final answer — all within hard budget and step guardrails. Cloud is off by default.

Runs stream progress live to stderr (task starts, model deltas, tool calls, retries, verify verdicts). Each task is retried on transient failure with bounded exponential back-off, then verified before the result is accepted.

| Command | What it does |
|---|---|
| `ashlr run "<goal>" [flags]` | Plan → parallel fan-out → synthesize. Resumable; persisted to `~/.ashlr/runs/`. |
| `ashlr run show <id>` | Print the full `RunState` for a past run. |
| `ashlr runs [--json]` | List all past runs, newest first. |

Key flags: `--budget N` · `--max-steps N` · `--parallel N` · `--engine builtin|ashlrcode|aw|claude` · `--stream / --no-stream` · `--allow-cloud` · `--no-memory` · `--no-capture` · `--resume <id>`.

```sh
ashlr run "Summarize the last 5 commits and flag risky changes"
ashlr run "Audit MCP registry for duplicate tool names" --budget 8000 --parallel 4
ashlr run "Refactor the config module" --engine claude    # delegate to Claude Code
```

### Spec-driven swarms

Author an end-state spec, then run a fleet of local agents against it — phases: SCAFFOLD → BUILD → INTEGRATE → VERIFY → REVIEW.

```sh
ashlr spec new "Add a plugin system" --project ~/my-project   # draft structured spec
ashlr spec list                                                # id · version · status · goal
ashlr spec refine <id> "Add hot-reload support"               # produce v2; v1 preserved

ashlr swarm <specId> --dry-run         # see the SwarmPlan (zero cost)
ashlr swarm <specId> --budget 64000    # run the fleet
ashlr swarm <specId> --background      # fire-and-forget, returns swarm id immediately
ashlr swarms                           # list all runs: id · status · cost
ashlr swarm show <id>                  # per-task status, usage, errors
```

**Verified, recoverable swarms** (M17): every task result is HMAC-SHA256 signed; downstream tasks verify signatures before consuming them; a risk heuristic catches destructive operations; the swarm pauses on any exception (`status: 'needs-approval'`) rather than proceeding silently; a confirm-gated rollback restores the exact pre-swarm git state.

```sh
ashlr swarm verify <id>              # verify all task signatures; exit 0 = all valid
ashlr swarm approve <id>             # resume a paused swarm (explicit human action only)
ashlr swarm rollback <id> [--yes]    # restore project to pre-swarm git state
```

### Cost-optimal routing

Every task is routed to the best available **local** model (Ollama / LM Studio) first. Cloud is structurally unreachable unless you pass `--allow-cloud` and the key is present — both required simultaneously.

On failure, the verify loop can escalate for one retry — still local unless `--allow-cloud`. There is no automatic cloud fallback, no silent billing.

```sh
ashlr models                  # list local models (Ollama + LM Studio) — read-only
ashlr models pull llama3      # explicit download — prints size warning + requires confirm
ashlr models start            # best-effort start of an installed-but-idle Ollama daemon
```

`ashlr pulse` shows a savings line: what local tokens would have cost in the cloud, and a projected monthly spend:

```
Local savings (est):  $0.42   |   Cloud would-have-been: $0.47   |   Projected 30d: $0.18
```

### Observe

```sh
ashlr pulse [--window 1d|7d|30d] [--project <name>]   # local usage dashboard (fully offline)
ashlr telemetry status    # endpoint configured, PAT available, active sink, governance
ashlr telemetry test      # emit a synthetic test span to verify the pipeline
```

`ashlr pulse` computes entirely offline from usage metadata in your Claude Code transcripts — never message content. Set `telemetry.budgetUsd` in config to get warn/over banners. M19 adds a full OTLP/HTTP-JSON pipeline (opt-in, fire-and-forget, metadata-only) and a period-based spend governance policy.

### Lifecycle

```sh
ashlr new my-server --template mcp-server   # scaffold ecosystem-wired project
ashlr ship                                  # pre-ship gate: supply-chain + test/lint/build (dry-run)
ashlr ship --deploy vercel --confirm        # gate + deploy (--confirm required for outward action)
```

Templates: `minimal` · `node-cli` · `mcp-server` · `next-app`. Deploy targets: `vercel` · `stack` · `gh` · `morphkit`.

### Memory

```sh
ashlr learn "<note>" [--project p] [--tags a,b]   # append to ~/.ashlr/genome/hub.jsonl
ashlr recall "<query>"                            # keyword/TF-IDF search, optional Ollama rerank
ashlr genome                                      # health: entry count, projects, store size
ashlr genome --teach "<note>"                     # manual high-value note (tagged 'teach')
ashlr genome consolidate                          # merge near-duplicates (backup-first)
ashlr genome playbook "<goal>"                    # synthesise a playbook from past runs
ashlr genome export ~/backup.json                 # portable export (JSON or Markdown)
```

The genome compounds automatically — every completed `ashlr run` and `ashlr swarm` appends a structured entry (metadata/summary only, capped at ~800 chars, never prompts or file contents). Before each run, a synthesised playbook is injected into the agent's planning context. Pass `--no-capture` or `--no-memory` to opt out per invocation.

### Integrations

| Command | What it does |
|---|---|
| `ashlr gh pr / issue / ci` | Read open PRs, issues, CI status for the current repo |
| `ashlr gh pr create` | The only mutation — confirm-gated, never automatic |
| `ashlr vercel ls / logs` | Recent deployments and latest logs for the linked project |
| `ashlr wire [claude\|cursor\|codex\|all]` | Wire the MCP gateway into editor configs (backup-first, idempotent) |
| `ashlr notify test` | Ping configured Slack/Discord webhook (no-op if none configured) |

All reads are non-mutating and degrade gracefully when a CLI or linked project is absent. `gh` owns GitHub auth, `vercel` owns Vercel auth, `phantom` owns secrets — the hub never handles raw tokens. Phantom identity appears in `ashlr status` and `ashlr doctor` as name/tier/team only; vault contents are never accessed.

### Surfaces

```sh
ashlr tui                # interactive alt-screen dashboard, auto-refreshes every ~2 s
ashlr tui --once         # render one frame to stdout and exit (headless/CI)
ashlr serve              # local web dashboard at http://127.0.0.1:7777
ashlr serve --open       # launch the browser automatically
ashlr serve --allow-dispatch   # enable opt-in POST /api/run (prints session token)
```

**TUI tabs**: Overview · Runs · Swarms · Pulse · MCP. Keys: `Tab`/`1–5` switch tabs, `j/k` scroll, `r` refresh, `q` quit. Terminal safety guaranteed — alt-screen/raw mode always restored on quit or exception.

**Web dashboard pages**: Overview · Runs · Swarms (SVG dependency-graph + live burndown) · Pulse (SVG charts) · Genome (instant search). All pages live-update via SSE. Binds `127.0.0.1` only; DNS-rebinding protection; read-only by default; no CDN; fully offline.

---

## Architecture

TypeScript ESM (NodeNext). Core logic in `src/core/`, CLI dispatch in `src/cli/`, Raycast extension in `src/raycast/` (own package). `core/` and `cli/` carry zero runtime dependencies beyond the MCP SDK.

| Area | Key modules |
|---|---|
| Index & navigation | `config` · `git` · `classify` · `index-engine` · `tidy` |
| Onboard & diagnose | `onboard` · `doctor` · `doctor-fix` · `providers` · `phantom` |
| MCP gateway | `mcp-registry` · `mcp-gateway` · `tools-registry` |
| Orchestration | `run/provider-client` · `run/budget` · `run/agent-loop` · `run/orchestrator` · `run/router` · `run/self-heal` |
| Resilience | `run/retry` · `run/verify` · `run/engines` · `run/streaming` |
| Specs & swarms | `spec/spec-store` · `swarm/planner` · `swarm/runner` · `swarm/store` · `swarm/sign` · `swarm/gate` · `swarm/rollback` |
| Observability | `observability/usage-source` · `observability/rollup` · `observability/budget-alert` · `observability/forecast` · `observability/otlp` · `observability/telemetry-sink` · `observability/governance` |
| Lifecycle | `lifecycle/templates` · `lifecycle/scaffold` · `lifecycle/ship` |
| Memory / genome | `genome/store` · `genome/recall` · `genome/capture` · `genome/consolidate` · `genome/playbook` · `genome/export` |
| Integrations | `integrations/github` · `integrations/vercel` · `integrations/editors` · `integrations/identity` · `integrations/notify` |
| Surfaces | `web/server` · `web/api` · `web/static` · `tui/app` · `tui/render` · `dashboard` |
| Ecosystem | `env-bridge` |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full module map and data flow.

---

## Telemetry and governance

Local-first by default: every run records compact JSONL to `~/.ashlr/telemetry/` — no network calls, no configuration required. When you configure an OTLP endpoint and PAT, the hub emits proper OTLP/HTTP-JSON traces with GenAI semantic-convention attributes (metadata only — never prompts, completions, or secrets). Spend governance (`budgetUsd` + `budgetWindow`) surfaces `ok / warn / over` banners in `ashlr pulse`, `ashlr doctor`, and before each run/swarm. Governance is advisory by default; `govAction: 'block'` requires `--over-budget` to proceed (never silently blocks).

```sh
ashlr telemetry status   # endpoint configured (bool), PAT available (bool), sink, governance
ashlr telemetry test     # emit a synthetic test span; reports ok/fail
```

---

## Local-first and private

- **Local models first.** Provider resolution probes LM Studio (`:1234`) and Ollama (`:11434`) first. `ashlr run` refuses to call a cloud endpoint without `--allow-cloud` + a present key.
- **Metadata-only telemetry.** `ashlr pulse` reads only token counts, model id, timestamp, and project path — never message content. All rollups stay under `~/.ashlr/`.
- **Phantom owns secrets.** Phantom surfaces secret names and vault status only — values are never read, captured, or printed by the hub. Subprocess spawns are wrapped via `phantom exec --` when enabled so secrets are injected by Phantom, not the hub.
- **Private memory.** Genome lives under `~/.ashlr/genome/`. Embeddings are computed locally via Ollama. Auto-capture stores metadata/summary only, hard-capped at ~800 chars per entry. Export is always available — no lock-in.
- **Self-heal never escalates cost.** Model downgrade is always to a smaller local model. Cloud backoff is only applied when cloud is already in use (`allowCloud` set by the caller).

---

## Requirements

- **macOS** · **Node.js 22+** · `~/.local/bin` on your `PATH`
- Optional: [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) for local agent runs; [`phantom`](https://github.com/nicholasgasior/phantom) for secrets management; [Raycast](https://raycast.com) for the extension.

---

## Development

```sh
npm run build      # tsc -> dist/
npm run dev        # tsx watch — no compile step, fast iteration
npm test           # vitest (2026 tests)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

CI runs typecheck, lint, build, and test on Node 22 for every push and PR.

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for workflow, conventions, and how to keep the build green (tests, lint, and typecheck must all pass).

---

## License

[MIT](./LICENSE) © Mason Wyatt ([@masonwyatt23](https://github.com/masonwyatt23) · [ashlr.ai](https://ashlr.ai))
