# ashlr-hub

**An autonomous engineering fleet that builds, maintains, and improves your repos — proposal-only, sandboxed, and gated by model-trust tier.**

[![npm](https://img.shields.io/npm/v/@ashlr/hub.svg?logo=npm&label=%40ashlr%2Fhub&color=cb3837)](https://www.npmjs.com/package/@ashlr/hub)
[![npm downloads](https://img.shields.io/npm/dm/@ashlr/hub.svg?color=cb3837)](https://www.npmjs.com/package/@ashlr/hub)
[![CI](https://github.com/ashlrai/ashlr-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/ashlrai/ashlr-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)

---

## What is this?

ashlr-hub is a single Node binary that runs an autonomous agent fleet against your enrolled repositories.

The fleet scans your backlog, dispatches sandboxed agent swarms across multiple backends (local Ollama/LM Studio, Claude Code, Codex, any OpenAI-compatible API), and deposits proposed diffs into an **Approval Inbox**. Nothing touches a branch until you explicitly approve it. The kill-switch is a single file.

It is also a local unifying harness: one CLI and web dashboard that indexes your enrolled projects, aggregates all your MCP servers into a single gateway, tracks real spend, and provides `ashlr run` / `ashlr swarm` for ad-hoc work.

---

## What makes it different

Most AI coding tools are request-response: you ask, the model answers. ashlr-hub runs a **continuous autonomous loop**:

```
End-State Spec (your vision)
  → Elon Strategist (decomposes spec into strategic goals)
    → Goals + milestone planner (concrete ordered work)
      → Fleet supervisor (24/7 dispatch to enrolled repos)
        → Backend router (routes each item to the right engine by tier)
          → Sandboxed swarm (throwaway worktree, push severed, diff-only capture)
            → Manager judge (frontier model scores every proposal)
              → Tiered-trust merge gate (local→proposal-only; mid→branch; frontier→main)
                → Approval Inbox (human gate — nothing auto-applies by default)
                  → Comms channel (Telegram/iMessage for approve-by-text)
                    → Scorecard feedback (outcomes feed learned routing)
```

**What this unlocks:**

- The fleet works your backlog while you sleep.
- You review proposals with `ashlr inbox`, not a chat window.
- High-confidence work (verified, frontier-authored) can optionally reach `main` without a manual approve — but only after CI passes and HMAC-signed provenance checks out. This is off by default.
- Adding a new backend (a NIM, a local Qwen, a different API) is one config entry, no code change.

**Key properties:**

- **Preflight-first activation.** `ashlr preflight` verifies daemon readiness, backend connectivity, and key configuration before you enroll any repos. Run it once before your first enroll.
- **Proposal-only floor.** The daemon can never apply, push, or deploy anything. The only path to a real branch is `ashlr inbox approve`.
- **Tiered-trust merge gate.** Local-model proposals stay proposals. Frontier models (Claude Opus, Codex GPT) can earn a gated path to `main` — only after CI is green and provenance is HMAC-verified. Default off.
- **Sandboxed by construction.** Every external agent CLI runs in a throwaway git worktree with push credentials severed. Only the scrubbed diff escapes.
- **OS-level confinement.** Optionally wraps each run with `sandbox-exec` (macOS) or `bwrap`/`firejail` (Linux) — read-jailed to the worktree, network egress blocked.
- **Kill-switch.** `touch ~/.ashlr/KILL` — all mutating operations refuse immediately, across every backend and repo.
- **Zero runtime dependencies.** The entire `core/` and `cli/` tree runs on Node builtins + `@modelcontextprotocol/sdk`. Backends are CLIs or APIs you already have.
- **Self-improving.** The fleet can target its own source, but a self-authored diff is ineligible to merge unless the full invariant suite passes flag-off and flag-on, and any diff that weakens a safety test is refused by construction.

---

## Quickstart

### Requirements

- Node.js 22+
- Git
- At least one backend: Ollama running locally, `claude` CLI, `codex` CLI, or an `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`

### Install

```sh
npm install -g @ashlr/hub
ashlr --version
```

Or from source:

```sh
git clone https://github.com/ashlrai/ashlr-hub
cd ashlr-hub
./install.sh   # builds dist/, symlinks bin/ashlr → ~/.local/bin/ashlr
```

`install.sh` requires Node 22+ and is idempotent — safe to re-run after pulling updates.

### 1. Run the setup wizard

```sh
ashlr setup
```

Detects local model servers, editors, Phantom Secrets, installs the daemon as an OS service (launchd/systemd), and auto-discovers repos to enroll. Idempotent.

### 1a. Preflight check (optional but recommended)

```sh
ashlr preflight
```

Verifies daemon readiness, backend connectivity, and key configuration before you enroll any repos. Safe to skip — setup covers the same ground — but useful as a standalone health check after config changes.

### 2. Enroll a repo

The fleet only works repos you have explicitly enrolled. Nothing is scanned until you add one.

```sh
ashlr enroll add ~/path/to/my-project
ashlr enroll list   # confirm enrollment
```

### 3. Dry run — see what would happen, spend nothing

```sh
ashlr daemon start --once --dry-run
```

Prints what the fleet would work on. Creates no proposals, spends $0.

### 4. Run one real tick

```sh
ashlr daemon start --once
```

The fleet scans the backlog, dispatches sandboxed work, and deposits proposals into the inbox.

### 5. Review proposals

```sh
ashlr inbox                # list pending proposals
ashlr inbox show <id>      # inspect diff + metadata
ashlr inbox approve <id>   # apply to branch — confirm-gated, never silent
ashlr inbox reject <id>    # discard a pending proposal; applies nothing
```

Applied changes always land on a dedicated branch — never your working tree directly — so undoing one is ordinary git. Swarm-applied work has a first-class undo: `ashlr swarm rollback <id>` restores the repo to its pre-swarm git state (confirm-gated, never force-push).

That is the full loop. Nothing touched your branch until step 5. The Approval Inbox is the **human gate** — every applied change passes through it.

### Open Mission Control (optional)

```sh
ashlr serve           # web dashboard at http://127.0.0.1:7777 (localhost only)
ashlr serve --open    # also opens the browser
```

The dashboard shows fleet status, all runs and swarms, the inbox, rolling spend analytics, and shared memory.

---

## The autonomous loop

Once repos are enrolled, the higher-level entry point is the goal conductor:

```sh
ashlr loop               # one tick — advances active goals, then backlog fallback
ashlr loop --watch       # continuous (Ctrl-C to stop)
ashlr loop --dry-run     # show what would advance, no proposals
```

Set a strategic objective and the fleet plans + executes milestones:

```sh
ashlr goal "harden the inbox apply path"
ashlr goals list                         # track progress
ashlr goals advance                      # execute the next milestone
```

The strategist and vision commands let you define the high-level direction:

```sh
ashlr vision show       # current end-state spec
ashlr vision review     # run the Elon strategist → strategic briefing
ashlr vision approve    # adopt the briefing → evolve spec + create goals
```

The fleet doesn't only fix rot — it can invent. The generative engine proposes bold, net-new features for a repo:

```sh
ashlr invent <repo>            # print invented feature ideas (frontier model)
ashlr invent <repo> --emit     # file the best ideas into the scored backlog
```

---

## Kill switch

```sh
touch ~/.ashlr/KILL        # halt all autonomous activity immediately
rm ~/.ashlr/KILL            # resume

ashlr fleet pause           # same via CLI
ashlr fleet resume
ashlr enroll kill on/off    # same via enroll subcommand
```

The kill-switch is checked before every mutating operation in every backend and repo.

---

## Backends and model tiers

| Tier | Examples | What it can reach |
|------|----------|-------------------|
| `local` | Ollama, LM Studio | Proposals only (always) |
| `mid` | Kimi K2, Hermes, NIM-hosted 70B | Branch/PR (opt-in, `autoMerge.midToBranch`) |
| `frontier` | Claude Opus, Codex GPT | `main` in default `trustBasis:"tier"` mode — only with CI green + signed provenance + `mergeAuthority` config (default off) |

Adding a backend is one entry in `cfg.foundry.engines` — no code change. The backend router uses learned routing (verified-outcome priors, dispatch-production yield, and cost estimates) to dispatch each backlog item to the appropriate tier.

---

## Sandboxed execution

Every external agent (Claude Code CLI, Codex, any engine) runs inside a throwaway git worktree:

- `cwd` is the worktree, not your live tree.
- Git push credentials are severed: env-stripped of `*_TOKEN|SECRET|KEY|PASSWORD|CREDENTIALS`, `GIT_TERMINAL_PROMPT=0`, `SSH_AUTH_SOCK` deleted, `GIT_ASKPASS` emptied, a hard-fail `pre-push` hook injected via `GIT_CONFIG_*` (no shared-config mutation).
- The agent's own subscription auth (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) is preserved so it can function.
- Only the scrubbed diff is captured. The agent's own commits die with the sandbox.

On macOS, `cfg.foundry.confinement` wraps the spawn in `sandbox-exec` (read-jailed to worktree + vendor homes, network egress denied). Linux uses `bwrap` or `firejail`. Unsupported platforms fall back to env-only isolation by default; `onUnsupported: 'fail'` makes that a terminal error instead.

Every run and proposal carries HMAC-signed `{engineModel, engineTier}` provenance (M47.1). The merge gate re-verifies the HMAC before any merge-to-main; a forged or tampered record is refused.

---

## Manager judge

```sh
ashlr manager                    # score pending proposals — shadow mode (never merges)
ashlr manager --window 30d       # wider quality window
ashlr manager --apply-rejects    # also reject noise/harmful proposals
```

The Manager runs a frontier model over pending proposals and produces a quality scorecard (value / correctness / scope / alignment, plus win/concern/recommendation narrative). Since v3.1 the default judge is **Claude Fable 5** (Mythos-class) with an automatic per-call Opus 4.8 fallback — a judge pass never dies on model availability — and every judge call records its cost/tokens/latency to the decisions ledger. Shadow mode by default — it records verdicts to `~/.ashlr/manager/<ts>.json` but never merges or rejects anything unless you pass `--apply-rejects`.

---

## Best-of-N (M142)

```sh
ashlr best-of-n --repo <path> --title "fix the timeout logic" -n 5
```

Generates N candidate diffs for a backlog item, scores each with the Manager judge as a rubric-supervised critic, prefers candidates that pass the repo's own test suite, and files the winner as the proposal (losers are archived with provenance — one pending proposal per item). Since v3.1 candidates can race DIFFERENT models — e.g. Claude Sonnet 5 vs Codex vs a local coder — via `cfg.foundry.bestOfNCandidates`, with every candidate's spend counted against the budget and per-model win rates on the dashboard **Models** tab. Gate fan-out to high-value items with `bestOfNMinItemScore`. Configured via `cfg.foundry.bestOfN`.

---

## Comms channel

```sh
ashlr comms status
ashlr comms send-test           # verify the channel is wired
ashlr comms cycle               # send pending + poll replies
ashlr comms digest              # build oversight snapshot + send summary
ashlr comms ask-merges          # post pending ship proposals for approve-by-text
```

Supports **Telegram** (recommended) and macOS iMessage. Configure in `cfg.comms`. The comms layer sits on top of all automated gates — replying to approve in Telegram resolves the human gate; it does not bypass verification or provenance.

---

## Fleet observability

```sh
ashlr fleet status         # per-backend throughput, queue, proposals, quota, kill state
ashlr fleet watch          # glanceable monitoring + recent autonomous actions
ashlr pulse                # rolling activity + spend analytics (1d/7d/30d)
ashlr audit                # append-only confinement + action audit log
```

`fleet status` shows both tick-level **Proposal production** and durable
**Dispatch yield**. Dispatch yield is read from
`~/.ashlr/dispatch-production/YYYY-MM-DD.jsonl` and reports
`proposalRate = proposalsCreated / dispatch attempts`, plus no-proposal reasons
grouped by backend/source in the human view and by backend, source, repo, and
backend+model in JSON/API output. Learned routing uses this ledger too, but
excludes non-learnable control-flow outcomes such as `proposal-disabled` so
intentional capture staging does not count as backend quality failure.

Queue status reports raw backlog plus daemon-eligible work: items cooling in the
worked ledger or already covered by pending proposals are counted separately, so
next actions point at work the daemon can select now instead of phantom backlog.

---

## Command reference

| Command | What it does |
|---------|-------------|
| `ashlr setup` | Guided first-activation wizard (idempotent) |
| `ashlr onboard <repo>` | Enroll one repo with walkthrough + dry run |
| `ashlr enroll add/remove/list` | Manage enrolled repos |
| `ashlr enroll kill on/off` | Engage/clear the kill-switch |
| `ashlr daemon start/stop/status` | Autonomous operator (proposal-only) |
| `ashlr loop [--watch] [--dry-run]` | Goal-aware conductor — one tick or continuous |
| `ashlr goal "<objective>"` | Set a strategic goal; plan + dispatch milestones |
| `ashlr goals list/show/plan/advance` | Manage goals + milestones |
| `ashlr vision show/review/approve` | End-state spec + strategic briefing |
| `ashlr inbox [show/approve/reject]` | Review and act on proposals |
| `ashlr swarm "<goal>"` | Multi-agent sandboxed swarm (ad-hoc) |
| `ashlr run "<goal>"` | Single agent run (ad-hoc) |
| `ashlr fleet status/watch/pause/resume` | Fleet control plane |
| `ashlr manager` | Proposal quality scorecard (frontier judge, shadow mode) |
| `ashlr best-of-n` | Best-of-N candidate generation + critic selection |
| `ashlr comms status/cycle/digest` | Bidirectional Telegram/iMessage channel |
| `ashlr backlog` | View the scored work queue |
| `ashlr invent [repo] [--emit]` | Generative engine — invent net-new features; `--emit` files them to the backlog |
| `ashlr digest [--notify]` | Org-level portfolio digest (health, goals, costs) → `~/.ashlr/digests/`, read-only |
| `ashlr spec new/list/show/refine` | Manage spec artifacts |
| `ashlr genome recall/learn` | Shared memory + knowledge recall |
| `ashlr serve [--open]` | Web dashboard (Mission Control) at 127.0.0.1:7777 |
| `ashlr pulse` | Rolling activity + spend analytics |
| `ashlr eval` | Local agent eval harness (adaptive-prompts A/B) |
| `ashlr verify-safety` | Run the safety invariant suite |
| `ashlr doctor` | One-glance health check |
| `ashlr models` | List + manage model backends |
| `ashlr mcp list/doctor/install` | MCP server aggregation gateway |
| `ashlr preflight` | Pre-activation health check — verifies daemon, backends, and keys before first enroll |
| `ashlr sandbox` | Sandbox management |
| `ashlr sandbox gc` | Garbage-collect stale worktrees (safe, read-jailed, no live state touched) |
| `ashlr demo` | Run a disposable demo repo through one full fleet tick — auto-cleaning sandbox, $0 spend, no side-effects |
| `ashlr swarm rollback <id>` | Restore a repo to its pre-swarm git state (confirm-gated, never force-push) |
| `ashlr audit` | Append-only audit log |
| `ashlr update` | Safe self-update |
| `ashlr tui` | Interactive TUI dashboard |
| `ashlr help` | Full command reference |

---

## Safety model

Every safety property below is proven by a named adversarial test. These invariants are never weakened — the fleet itself is blocked from doing so (M54).

1. **Proposal-only floor.** The daemon's source imports no merge/apply primitive. Auto-merge is a separate gated subsystem, default off. Proven by source-scan grep-guard + `test/h1.daemon-gates.test.ts`.
2. **Enrollment gate.** Only explicitly enrolled repos receive autonomous work. Proven by `test/h6.*`.
3. **Kill-switch halts everything.** `~/.ashlr/KILL` stops every backend and repo, including in-flight sandboxed runs. Proven by `test/m48.*` kill-all test.
4. **Sandboxed-with-diff-capture only.** External engines run only through `runEngineSandboxed`. No raw-external path in the autonomous loop. Sandbox-creation failure is terminal, never a silent fallback. Proven by `test/m45.*`.
5. **Git push is blocked.** The pre-push hook + credential strip make every push from the worktree fail. Proven by `test/m45.*` pre-push test.
6. **Only the diff is consumed.** The loop ingests only the captured, scrubbed diff. The agent's own commits die with the sandbox. Proven by `test/m45.*` diff-only test.
7. **Immutable signed provenance.** Every run and proposal carries write-once `{engineModel, engineTier}`, HMAC-signed at produce time. The merge gate re-verifies the HMAC before any merge-to-main. Proven by `test/m47.*` and `test/m47-1.*`.
8. **Merge-to-main requires explicit authority + verification.** Default `trustBasis: "tier"` requires CI/verify green plus a matching frontier `cfg.foundry.mergeAuthority` entry. Opt-in `trustBasis: "verification"` can authorize any producer only with a signed frontier judge ship, and opt-in `trustBasis: "evidence"` skips the judge only when base-bound deterministic evidence clears. Proven by `test/m47.*`, `test/m153.*`, and `test/m307.*`.
9. **Self-improvement cannot self-disarm.** A self-target diff must pass the invariant suite flag-off and flag-on. Any diff weakening a safety test is refused. Proven by `test/m54.*`.
10. **Zero new runtime dependencies.** Backends are CLIs or APIs the user already has. Proven by dependency-manifest grep-guard.

Full invariant set: [`docs/SPEC-V4-FOUNDRY.md`](docs/SPEC-V4-FOUNDRY.md) §9 and [`docs/SPEC-V5-OPEN-FLEET.md`](docs/SPEC-V5-OPEN-FLEET.md) §9.

---

## The `~/.ashlr/` home layout

```
~/.ashlr/
├── config.json          # AshlrConfig — roots, models, foundry, daemon, comms, …
├── index.json           # Scanned desktop index
├── KILL                 # Kill-switch — present = fleet halted
├── runs/                # RunState per agent run (atomic, resumable)
├── swarms/              # SwarmState per multi-agent swarm
├── inbox/               # Pending/approved/rejected proposals (append-only lifecycle)
├── dispatch-production/ # Append-only dispatch yield events (metadata only)
├── goals/               # Goal + milestone state
├── fleet/
│   └── worked.json      # Per-item cooldown outcomes (diff/empty)
├── genome/
│   └── hub.jsonl        # Append-only hub memory store
├── foundry/
│   └── provenance.key   # HMAC signing key (0600, per-machine, never transmitted)
├── audit/               # Append-only confinement + action audit log
└── manager/             # Manager judge scorecards
```

Per-repo memory lives in `<repo>/.ashlrcode/genome/`. The CLI is the sole writer of `~/.ashlr/`.

---

## Configuration

The config is validated against [`schema/config.schema.json`](schema/config.schema.json). Key sections:

```jsonc
{
  "roots": ["~/Desktop/github"],
  "daemon": {
    "enrolledRepos": ["/absolute/path/to/repo"],
    "intervalMs": 600000,
    "dailyBudgetUsd": 10,
    "parallel": 3
  },
  "foundry": {
    // absent = proposal-only behavior, byte-identical to pre-foundry
    "intelligence": {},            // learned routing (M53; optional knobs in docs)
    "autoMerge": {
      "enabled": false,            // DEFAULT OFF — fleet never auto-merges to main
      "trustBasis": "tier",        // tier | verification | evidence
      "midToBranch": false         // mid-tier proposals to branch (opt-in)
    },
    "mergeAuthority": [
      { "engine": "claude", "model": "claude-sonnet-5" },
      { "engine": "codex", "model": "gpt-5.5" }
    ],
    "confinement": {               // OS-level jail per-engine or fleet-wide
      "*": { "mode": "os", "onUnsupported": "fallback" }
    },
    "bestOfN": 3                   // N candidates for best-of-N critic selection
  },
  "comms": {
    "channel": "telegram",
    "telegram": { "botToken": "...", "chatId": "..." }
  }
}
```

See [`docs/FOUNDRY-CONFIG.md`](docs/FOUNDRY-CONFIG.md) for the full foundry reference and [`docs/examples/foundry.config.json`](docs/examples/foundry.config.json) for an annotated example.

---

## Version history

| Series | Theme | Status |
|--------|-------|--------|
| **v1** (M1–M20) | Local command center — Desktop index, MCP gateway, agent orchestrator, genome | Shipped |
| **v2** (M21–M30) | Autonomous org — sandboxed swarms, Approval Inbox, enrollment, kill-switch | Shipped |
| **v2.1** (H1–H8) | Harden and prove — adversarial test suite, safety invariants proven by tests | Shipped |
| **v2.2** (M31–M33) | Agent-native — plugin system, Raycast, update channel | Shipped |
| **v3** (M34–M44) | Team + Local Weapon — multi-machine inbox, adaptive prompts, verify→repair, eval | Shipped |
| **v4** (M45–M49) | Foundry — multi-backend engines, backend router, tiered-trust merge gate, HMAC provenance, fleet supervisor | Shipped |
| **v5** (M50–M55) | Open Fleet — declarative engine registry, tri-tier trust, OS confinement, fleet intelligence, self-improving fleet, goal/loop conductor | Shipped |
| **v5.1** (M320–M324) | Claude 5 Model Intelligence — Sonnet 5 workhorse routing, Fable 5 judge with Opus fallback, per-model ROI telemetry, cost-aware learned routing | Shipped |
| **v6** (M331–M340) | Verification-First — verify-to-green repair loop, real-world outcome watcher, multi-model best-of-N, gateway shadow activation program, Models dashboard tab, SWE-bench regression gate | Shipped |

Current npm release: **3.0.1** (3.1.0 tagged in-repo; publish follows the fleet's first autonomous merge).

---

## The Ashlr ecosystem

ashlr-hub is the orchestrator at the center of a 13-repo platform. The other repos are **composable capabilities** — the fleet can compose them to fix its own weaknesses and to build products: token-efficiency (`ashlr-plugin`, `@ashlr/core-efficiency`), executors (`ashlrcode`, `ashlr-workbench`), security and trust (`phantom-secrets`, `binshield`), infra and data (`stack`, `webfetch`), and observability and content (`ashlr-pulse`, `ashlr-md`, `morphkit`, `prompt-trackr`).

See [`docs/ECOSYSTEM-MAP.md`](docs/ECOSYSTEM-MAP.md) for the full capability map and the composition bets — how the hub uses its own ecosystem as building blocks.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Module map, the autonomous loop, engine tiers, safety gates, the `~/.ashlr/` layout |
| [`docs/ECOSYSTEM-MAP.md`](docs/ECOSYSTEM-MAP.md) | The 13-repo platform and composition bets |
| [`docs/QUICKSTART.md`](docs/QUICKSTART.md) | Step-by-step first activation |
| [`docs/FOUNDRY-CONFIG.md`](docs/FOUNDRY-CONFIG.md) | Full `cfg.foundry` reference — engines, tiers, confinement, auto-merge |
| [`docs/RELIABILITY.md`](docs/RELIABILITY.md) | Fault-tolerance and degradation guarantees |
| [`docs/SPEC-V4-FOUNDRY.md`](docs/SPEC-V4-FOUNDRY.md) · [`docs/SPEC-V5-OPEN-FLEET.md`](docs/SPEC-V5-OPEN-FLEET.md) · [`docs/SPEC-V6-VERIFICATION.md`](docs/SPEC-V6-VERIFICATION.md) | The design specs behind each version series (incl. the full safety-invariant set) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, test conventions, and the safety invariants contributors must never weaken.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map, the autonomous loop, engine tiers, safety gates, and the self-improvement layer.

## License

MIT — see [LICENSE](LICENSE).
