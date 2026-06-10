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

## Portfolio intelligence

Ask anything about any enrolled project. The knowledge index, RAG engine, and architecture graph all run **entirely on your machine** — your source code never leaves unless you explicitly pass `--allow-cloud`.

### Quick start

```sh
# Enroll a repo first (one-time; default enrollment is empty)
ashlr enroll add ~/path/to/my-project

# Build the knowledge index (reads files; never modifies them)
ashlr knowledge build

# Ask a question — answer is synthesised locally and every line is cited
ashlr ask "Where is the authentication middleware and what does it validate?"

# Scope a question to one repo
ashlr ask "How does error handling work?" --repo ~/path/to/my-project

# See what depends on a file or symbol across all enrolled repos
ashlr impact src/core/auth/middleware.ts

# Print the cross-repo architecture graph (repos, modules, shared deps)
ashlr knowledge graph
```

### How it works

```
enrolled repos (read-only walk)
        │
        ▼
  chunk + embed (Ollama local / keyword fallback)
        │
        ▼
  ~/.ashlr/knowledge/<repo-hash>/*.jsonl   (chunks + optional vectors)
        │
        ▼
  ashlr ask "<question>"
        │
        ▼
  retrieve top chunks (cosine / TF-IDF)  →  local synthesis  →  cited answer
```

1. `ashlr knowledge build` walks every enrolled repo, splits source files into line-range chunks, and embeds each chunk with the local Ollama model. When no embedding model is available it falls back to keyword/TF-IDF scoring. Only changed files (by mtime) are re-indexed on subsequent runs.
2. `ashlr ask` retrieves the highest-scoring chunks, feeds them to the local model, and returns a plain-language answer with source citations (`repo/file:line`).
3. `ashlr knowledge graph` performs static import/dependency analysis and builds a lightweight graph, surfacing cross-repo findings such as the same outdated or vulnerable dependency appearing in multiple projects.
4. `ashlr impact` traces references to a file or symbol across all enrolled repos — useful before a refactor or before deleting a shared utility.

### Privacy guarantee — LOCAL-FIRST

**Your source code never leaves your machine by default.** The index, embeddings, retrieval, and synthesis steps all use the local provider (Ollama). Cloud models are structurally unreachable on the default path — `--allow-cloud` must be explicitly passed AND a cloud API key must be present. Passing the flag without a key is a no-op; omitting it with a key is also a no-op. Both are required simultaneously.

| Default path | With `--allow-cloud` + key |
|---|---|
| Embeddings: Ollama (local) | Embeddings: Ollama (local, unchanged) |
| Synthesis: local model | Synthesis: cloud model |
| Code sent to cloud: **never** | Code sent to cloud: synthesis context only |

### Read-only and enrollment-scoped

- **Read-only**: `knowledge build`, `ask`, `impact`, and `knowledge graph` never modify any enrolled repo. All writes go to `~/.ashlr/knowledge/` only.
- **Enrollment-scoped**: only repos you have explicitly enrolled (`ashlr enroll add`) are indexed or queried. Default enrollment is empty — empty knowledge, no whole-portfolio disk scan.
- **Bounded**: `node_modules/`, `.git/`, `dist/`, and binary files are always skipped. File-count and byte caps are enforced per repo.
- **No secrets in the index**: `.env` and key files are excluded. Secret-shaped tokens (high-entropy strings matching common key patterns) are redacted from chunks before storing, embedding, or citing. No secret values appear in `~/.ashlr/knowledge/` or in `ashlr ask` answers.

### Commands

| Command | What it does |
|---|---|
| `ashlr knowledge build [--repo <path>]` | Index all enrolled repos (or one). Incremental by mtime. |
| `ashlr ask "<question>" [--repo] [--allow-cloud]` | Local RAG Q&A with cited sources. Cloud OFF by default. |
| `ashlr knowledge graph [--repo <path>]` | Cross-repo architecture + dependency map. |
| `ashlr impact <file\|symbol> [--repo <path>]` | What references or depends on this, across enrolled repos. |

---

## The autonomous daemon

`ashlr daemon` is the continuous operator for your enrolled repos. Each tick it pulls the highest-value items from the backlog, dispatches sandboxed swarms to work them, and deposits the results as PENDING proposals in the Approval Inbox. Nothing it produces is ever applied automatically — **it can only propose**.

### How it works

```
enrolled repos  →  backlog (scored work items)
                        │
                        ▼
                 daemon tick (sandboxed swarm per item)
                        │
                        ▼
            ~/.ashlr/inbox/<id>.json   (status: pending)
                        │
                        ▼
            ashlr inbox approve <id>   ← YOU decide
```

1. On each tick the daemon checks the kill switch and daily budget, then loads the backlog for every enrolled repo.
2. It selects the top-K items that fit within the per-tick and daily budget caps.
3. For each item it calls `runSwarm` with `opts.sandbox=true` (isolated git worktree, never your working tree) and `opts.propose=true` (output is a PENDING proposal, never auto-applied).
4. Tick summary — items considered, proposals created, spend — is recorded to daemon state and the audit trail.

### Commands

```sh
ashlr daemon start              # begin the operator loop
ashlr daemon start --once       # one tick then exit
ashlr daemon start --dry-run    # show what would be worked — no swarms dispatched, no proposals created
ashlr daemon start --budget 2   # override daily budget cap (USD) for this session
ashlr daemon stop               # set kill switch + clear running state
ashlr daemon status             # running?, last tick, today spend vs cap, pending proposals
```

### The daemon ONLY proposes — you approve

Every piece of work the daemon produces lands as a PENDING proposal in the Approval Inbox. Nothing is applied to your repo, pushed to a remote, or opened as a PR until you run `ashlr inbox approve <id>`. This is structurally enforced — the daemon code has no import or call path to `applyProposal`, `git push`, `gh pr create`, or any deploy path.

```sh
ashlr inbox          # review what the daemon produced
ashlr inbox show <id>    # read the diff
ashlr inbox approve <id> # apply it — only then does anything outward happen
ashlr inbox reject <id>  # discard
```

### Enrollment, budget, and kill switch

| Safety layer | What it does |
|---|---|
| **Enrollment** | The daemon operates ONLY on repos you have explicitly enrolled (`ashlr enroll add <repo>`). Default is empty — if nothing is enrolled, the daemon does nothing. |
| **Daily budget cap** | A hard USD ceiling resets each calendar day. When exhausted the daemon idles until tomorrow. Configurable via `daemon.dailyBudgetUsd` in `~/.ashlr/config.json` or `--budget` flag. |
| **Per-tick cap** | Limits items worked in a single tick (configurable via `daemon.perTickItems`). |
| **Concurrency cap** | Limits parallel swarms per tick (configurable via `daemon.parallel`). |
| **Kill switch** | `ashlr daemon stop` (or `ashlr enroll kill on`) sets `~/.ashlr/KILL`. The daemon checks this at the top of every tick and halts immediately. Cannot be bypassed. |
| **Re-entrancy guard** | The daemon refuses to start if `ASHLR_IN_DAEMON` or `ASHLR_IN_SWARM` is set — no daemon-inside-daemon or daemon-inside-swarm fork bombs. |
| **Sandboxed execution** | All swarm work runs in isolated `git worktree` sandboxes under `~/.ashlr/sandboxes/`. Your working tree, current branch, index, and HEAD are never touched. |

### Activating on your real repos is your call

The daemon is safe to run in `--dry-run` mode at any time — it produces no swarms and no proposals. Running it for real on enrolled repos is an explicit gate you control:

1. Enroll a repo: `ashlr enroll add <path-to-repo>`
2. Set a modest daily budget in `~/.ashlr/config.json`: `{ "daemon": { "dailyBudgetUsd": 2 } }`
3. Do a dry run first: `ashlr daemon start --once --dry-run`
4. When you are ready: `ashlr daemon start --once`
5. Review proposals: `ashlr inbox`

The daemon will never touch a repo you have not enrolled, never exceed the budget you set, and never apply anything without your explicit approval.

---

## Autonomy safety (v2)

All autonomous code work in ashlr-hub v2 is designed around a safety-first principle: **proposal-only by default, with explicit enrollment and a hard kill switch**.

### How it works

| Primitive | What it does |
|---|---|
| **Git-worktree sandbox** | Every autonomous edit runs in an isolated `git worktree` under `~/.ashlr/sandboxes/<id>/` on a scratch branch. Your working tree, checked-out branch, index, and HEAD are never touched. |
| **Enrollment registry** | Only repos you explicitly enroll can be autonomously mutated. Default is empty — nothing enrolled means nothing can be changed. |
| **Kill switch** | A global hard stop. When set, all sandbox-mutating operations refuse immediately regardless of enrollment. |
| **Audit trail** | Every autonomous action (action, repo, sandbox id, summary, result) is appended to `~/.ashlr/audit/<YYYY-MM-DD>.jsonl`. Append-only; no secrets; never deleted. |
| **Proposal-only posture** | Until M24 wires the daemon, all sandbox output is a diff for your review — nothing is applied to your repo automatically. |

### Commands

```sh
# Enrollment
ashlr enroll list                 # show enrolled repos (default: empty)
ashlr enroll add <path-to-repo>   # enroll a repo for autonomous work
ashlr enroll remove <path-to-repo>

# Kill switch
ashlr enroll kill on    # set ~/.ashlr/KILL — all mutating ops refuse immediately
ashlr enroll kill off   # clear the kill switch

# Sandbox inspection
ashlr sandbox list             # list active sandboxes
ashlr sandbox diff <id>        # show what changed inside a sandbox
ashlr sandbox cleanup <id>     # discard sandbox (worktree + scratch branch removed)

# Audit trail
ashlr audit          # tail audit log, newest first
ashlr audit 50       # last 50 entries
```

### Guarantees

- Sandbox worktrees live **only** under `~/.ashlr/sandboxes/`. The implementation uses `git worktree add` (new scratch branch off HEAD) and `git worktree remove` + `git branch -D` on cleanup — no `git reset --hard`, no checkout in the source repo, no push, no deletion of user branches.
- Enrollment defaults to empty. A repo that is not enrolled cannot be touched by any autonomous operation; `assertMayMutate` throws before any worktree is created.
- The kill switch (`~/.ashlr/KILL`) is checked first on every mutating call and cannot be bypassed by enrollment state.
- Audit entries contain only metadata. No prompt text, no completion content, no secret values are ever written to the audit log.

---

## Approval Inbox

The Approval Inbox is the single human control plane through which **every proposed outward action must pass**. The autonomous org (swarms, backlog agents, daemon) creates *proposals*; nothing outward — no PR, no patch applied to a real branch, no deploy — happens until you explicitly approve.

### How proposals flow

```
autonomous work (swarm / backlog / manual)
        │
        ▼
  createProposal()  →  ~/.ashlr/inbox/<id>.json  (status: pending)
        │
        ▼
  ashlr inbox        — you review the queue
  ashlr inbox show   — you read the diff
        │
        ▼
  ashlr inbox approve <id>   ← THE ONLY OUTWARD TRIGGER
        │  (confirm prompt, or --yes)
        ▼
  applyProposal()   →  outward action runs
```

### Commands

```sh
ashlr inbox                      # list pending proposals (id · kind · origin · title · age)
ashlr inbox show <id>            # full detail + unified diff
ashlr inbox approve <id>         # confirm-gated → apply; add --yes to skip prompt
ashlr inbox reject <id>          # mark rejected; no action taken
```

### Guarantees

- **No auto-apply, ever.** `applyProposal` runs only when three conditions are simultaneously true: proposal exists, `status === 'approved'`, and `confirmed === true` (set only by `inbox approve`). It is structurally impossible for a proposal to self-apply on creation, list, show, or from a background daemon.
- **Single outward funnel.** Every outward mutation in v2 — patch, PR, deploy — goes through `applyProposal`. There is no side door.
- **Patches land on a new branch, never your working tree.** A `'patch'` proposal applies the diff to a fresh `ashlr/`-prefixed branch off HEAD. Your current branch, index, and working tree are untouched. No force-push, no push at all — local branch only.
- **PR proposals use the same gated M18 `createPr` path** — confirm-gated, explicit, never automatic.
- **Enrollment + kill switch apply.** `assertMayMutate` is called before any mutation — kill switch or un-enrolled repo refuses immediately and audits the refusal.
- **No secrets in proposals.** `~/.ashlr/inbox/` contains only metadata (title, summary, diff, kind). No token values, env vars, or prompt text are written.
- **Read surfaces are read-only.** The TUI Inbox tab and web `/inbox` route show proposals but trigger no action. Approve only via `ashlr inbox approve` or Raycast.

---

## Work discovery

`ashlr backlog` gives you a prioritized, scored queue of open work across all your enrolled repos — aggregated from six read-only sources and persisted locally.

### Quick start

```sh
# Enroll a repo (one-time; enrollment is required before any scan runs)
ashlr enroll add ~/path/to/my-project

# Build or refresh the backlog
ashlr backlog refresh

# View the scored queue
ashlr backlog                         # top items across all enrolled repos
ashlr backlog --repo ~/my-project     # filter to one repo
ashlr backlog --source todo           # filter by source
ashlr backlog --limit 20              # top 20 only
ashlr backlog --json                  # machine-readable output
```

### Sources

| Source | What it scans |
|---|---|
| `issue` | Open GitHub issues via `gh` |
| `todo` | TODO / FIXME / HACK / XXX comments in source files |
| `test` | CI run state (latest `gh run`); presence of a test script |
| `dep` | Outdated deps (`npm outdated`) + known vulnerabilities (`npm audit`) |
| `doc` | Missing/thin README, missing LICENSE or CONTRIBUTING, low test presence |
| `security` | `binshield` findings (skipped gracefully when not installed) |

### Scoring

Each work item carries a `value` (1–5) and `effort` (1–5). Items are ranked by `score = value / effort` — high value, low effort floats to the top. The backlog is persisted to `~/.ashlr/backlog.json` and rebuilt on `ashlr backlog refresh`.

### Guardrails

- **Read-only**: scanners never modify any repo — no writes, no git mutations, no installs, no fixes.
- **Enrollment-scoped**: only repos you have explicitly enrolled (`ashlr enroll add`) are ever scanned. Default enrollment is empty → empty backlog.
- **Bounded**: `node_modules/`, `.git/`, and `dist/` are always skipped; per-repo caps on file count and output; subprocesses run with timeouts. No project scripts (`npm test`, `npm run build`, etc.) are ever executed.
- **No secrets**: backlog items contain only metadata. No token values, env vars, or secret names are written.

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
| **Work discovery** | `ashlr backlog` · `ashlr backlog refresh` |
| **Approval Inbox** | `ashlr inbox` · `ashlr inbox show` · `ashlr inbox approve` · `ashlr inbox reject` |
| **Portfolio intelligence** | `ashlr knowledge build` · `ashlr ask` · `ashlr impact` · `ashlr knowledge graph` |
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
| Work discovery | `portfolio/scanners` · `portfolio/backlog` |
| Portfolio intelligence | `knowledge/index` · `knowledge/ask` · `knowledge/graph` |
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
