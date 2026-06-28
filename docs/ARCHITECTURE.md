# Architecture

ashlr-hub is a single Node binary (`@ashlr/hub`) that runs an autonomous agent fleet against enrolled git repositories. It is TypeScript/ESM, Node 22+, with zero runtime dependencies in `core/` and `cli/` except `@modelcontextprotocol/sdk` (MCP gateway only).

---

## The autonomous loop

The high-level control flow, end to end:

```
┌─────────────────────────────────────────────────────────────────┐
│  ashlr loop / ashlr daemon start                                │
│                                                                 │
│  1. End-State Spec  ──────────────────  ashlr vision            │
│     (northStar + endState prose)         core/vision/spec.ts    │
│            │                                                    │
│  2. Elon Strategist  ─────────────────  ashlr vision review     │
│     (decomposes spec → strategic goals)  core/vision/strategist │
│            │                                                    │
│  3. Goals + Milestone Planner  ───────  ashlr goals plan        │
│     (ordered milestones per goal,        core/goals/planner.ts  │
│      each with a spec + acceptance       core/goals/store.ts    │
│      criteria)                                                  │
│            │                                                    │
│  4. Fleet Supervisor (24/7)  ─────────  core/daemon/loop.ts     │
│     (holds leases across enrolled        ashlr daemon start     │
│      repos; feeds the router)                                   │
│            │                                                    │
│  5. Backend Router  ──────────────────  core/fleet/router.ts    │
│     (routes each backlog item to a       core/run/learned-      │
│      backend by class/difficulty/tier;    router.ts             │
│      learned routing from outcomes)                             │
│            │                                                    │
│  6. Sandboxed Engine  ────────────────  core/run/sandboxed-     │
│     (throwaway worktree, push severed,   engine.ts              │
│      diff-only capture, HMAC-signed      core/sandbox/          │
│      provenance)                         core/swarm/runner.ts   │
│            │                                                    │
│  7. PENDING Proposal  ────────────────  core/inbox/store.ts     │
│     (scrubbed diff + {engineModel,       ~/.ashlr/inbox/        │
│      engineTier} + provenanceSig)                               │
│            │                                                    │
│  8. Manager Judge  ───────────────────  core/fleet/manager.ts   │
│     (frontier model scores proposal:     ashlr manager          │
│      value/correctness/scope/alignment)                         │
│            │                                                    │
│  9. Tiered-Trust Merge Gate  ─────────  core/inbox/merge.ts     │
│     local → proposal only               core/swarm/gate.ts      │
│     mid   → branch/PR (opt-in)                                  │
│     frontier → main (opt-in, CI green                           │
│                + mergeAuthority + HMAC)                         │
│            │                                                    │
│  10. Approval Inbox  ─────────────────  ashlr inbox             │
│      (human gate — nothing auto-applies  core/inbox/apply.ts    │
│       by default)                                               │
│            │                                                    │
│  11. Comms Channel  ──────────────────  core/comms/             │
│      (Telegram / iMessage —             core/integrations/      │
│       approve-by-text, on top of gate)   telegram.ts            │
│            │                                                    │
│  12. Scorecard Feedback  ─────────────  core/fleet/feedback.ts  │
│      (outcomes → learned router;         core/fleet/judge-      │
│       judge CoT traces persisted)         calibration.ts        │
└─────────────────────────────────────────────────────────────────┘
```

The `ashlr loop` command (`src/cli/loop.ts`) is the polished front door. It calls `runConductor` (`core/goals/conductor.ts`), which advances active goals first and falls back to `runDaemon` (`core/daemon/loop.ts`) when no goals are active. Both paths are proposal-only and kill-switch-gated.

---

## Engine tiers and the trust gate

Every backend is assigned a tier at registration time. The tier is provenance-bound (HMAC-signed, verified at merge time) and cannot be claimed post-hoc.

| Tier | Who | What it may reach |
|------|-----|-------------------|
| `local` | Ollama, LM Studio, any local model | Proposals only — always |
| `mid` | Strong open models: Kimi K2, Hermes, NIM-hosted 70B | Branch/PR via `autoMerge.midToBranch` (opt-in) |
| `frontier` | Claude Opus, Codex GPT | `main` via `mergeAuthority` (opt-in, CI green + HMAC verified) |

Key files:
- `src/core/run/engine-registry.ts` — the declarative engine registry (M50). Adding a backend is one entry here, no code change elsewhere.
- `src/core/run/sandboxed-engine.ts` — `runEngineSandboxed`: the keystone that contains any external CLI, severs push, captures diff-only, signs provenance.
- `src/core/foundry/provenance.ts` — HMAC key generation, signing, and verification (M47.1).
- `src/core/inbox/merge.ts` — `evaluateMergeAuthority`: the trust gate. Refuses non-frontier / unlisted / CI-not-green proposals.
- `src/core/fleet/router.ts` — `routeBackend`: capability-tiered routing.
- `src/core/run/learned-router.ts` — `recommendRoute`: learned routing from verified-outcome priors (M53).

---

## Sandboxed execution — security model

Every external agent CLI is treated as a black box. The containment layers:

**Layer 1 — git worktree isolation** (`src/core/sandbox/worktree.ts`):
- A throwaway `git worktree` is created for each run. The agent's `cwd` is the worktree, not the live tree.
- Push credentials are severed via `buildContainedEnv` in `sandboxed-engine.ts`: env-stripped of `*_TOKEN|SECRET|KEY|PASSWORD|CREDENTIALS`, `GIT_TERMINAL_PROMPT=0`, `SSH_AUTH_SOCK` deleted, `GIT_ASKPASS` empty, a hard-fail `pre-push` hook injected via `GIT_CONFIG_COUNT/KEY/VALUE` env vars (no shared-config mutation).
- The agent's own subscription auth (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_*`) is preserved so the agent can function.
- Only the scrubbed diff is captured (`src/core/run/diff.ts`). The agent's commits die with the sandbox.

**Layer 2 — OS-level confinement** (`src/core/sandbox/confine.ts`, M52):
- macOS: `sandbox-exec` with a generated SBPL profile. Read-jailed to worktree + vendor homes. Network egress denied.
- Linux: `bwrap` (preferred) or `firejail` (secondary).
- Graceful fallback to env-only isolation when the platform has no supported jail binary (unless `onUnsupported: 'fail'` is configured, which makes it a terminal error).
- All confinement decisions are written to the append-only audit log (`src/core/sandbox/audit.ts`).

**Layer 3 — diff scrubbing** (`src/core/util/scrub.ts`):
- The captured diff is scrubbed of secrets before it reaches the inbox.

---

## Key subsystems

### `src/core/run/` — Agent orchestrator

| File | Responsibility |
|------|---------------|
| `orchestrator.ts` | Decompose a goal into a `RunTask[]` DAG, fan out independent tasks in waves, synthesize a final answer. Persists `RunState` to `~/.ashlr/runs/<id>.json` atomically after every step. Supports `--resume`. |
| `sandboxed-engine.ts` | The fleet's containment keystone (M45). `runEngineSandboxed` wraps any external CLI. |
| `engine-registry.ts` | Declarative engine registry (M50). Drives `buildEngineCommand`, `engineInstalled`, `engineTierOf` — no orphaned hardcoded engine logic. |
| `router.ts` | Static capability-tiered routing. `learned-router.ts` adds outcome-prior learned routing. |
| `best-of-n.ts` | M142: generate N candidate diffs, score with Manager judge as critic, prefer test-passing candidates. |
| `provider-client.ts` | Thin chat layer over Ollama, LM Studio, and OpenAI-compatible APIs (NIMs, Kimi, etc). Local-first; cloud only with `--allow-cloud`. |
| `agent-loop.ts` | Bounded chat/tool loop per `RunTask`. Connects to the M3 MCP gateway for tool access. |
| `verify.ts` / `verify-commands.ts` | Post-execution verification: run the repo's actual test suite in the sandbox and iterate to green. |

### `src/core/swarm/` — Multi-agent swarm runner

| File | Responsibility |
|------|---------------|
| `runner.ts` | Fan out a goal into parallel tasks, each in its own sandbox. Task outputs are tamper-evident signed (M17). Downstream tasks verify signatures before consuming upstream output. Escalation gates PAUSE (needs-approval) — never auto-proceed. |
| `sign.ts` | Task output signing and verification. |
| `gate.ts` | Swarm-level merge gate: risk classification, scope-cap enforcement, CI check. |
| `rollback.ts` | Confirm-gated rollback to pre-swarm git state. Never automatic, never force-push. |

### `src/core/fleet/` — Fleet intelligence + oversight

| File | Responsibility |
|------|---------------|
| `manager.ts` | The Manager judge. Runs a frontier model over proposals; produces verdicts (ship/review/noise/harmful) and a quality scorecard. Shadow mode by default. |
| `router.ts` | `routeBackend`: capability-tiered routing per backlog item. |
| `judge-calibration.ts` | Judge calibration: Cohen's kappa, dark-current subtraction (M141/V6). |
| `feedback.ts` | Accept/reject outcome → learned router feedback loop. |
| `judge-trace.ts` | Persist judge CoT traces + sub-scores with eventual real-world outcomes (M141). |
| `prompt-optimizer.ts` | Optimize judge/strategist prompts against accept/reject outcomes. |
| `shared-store.ts` | Shared fleet state (quota, per-backend throughput, decision ledger). |
| `automerge-pass.ts` | The opt-in auto-merge pass (M47 gate). Separate module — the daemon never imports this directly. |

### `src/core/goals/` — Goal and milestone conductor

| File | Responsibility |
|------|---------------|
| `store.ts` | Goal + milestone CRUD, status lifecycle. |
| `planner.ts` | `decomposeGoal`: frontier-model decomposition of an objective into ordered milestones, each with a spec. |
| `advance.ts` | `advanceGoal`: execute the next pending milestone through the sandboxed, proposal-only swarm path. |
| `conductor.ts` | `runConductor`: the `ashlr loop` backend. Advances active goals first, falls back to `runDaemon`. |

### `src/core/vision/` — Elon Strategist

| File | Responsibility |
|------|---------------|
| `spec.ts` | `EndStateSpec` CRUD: northStar + endState prose. |
| `strategist.ts` | `runStrategist`: frontier model reads the spec + fleet state → strategic briefing → goal evolution. |
| `playbook.ts` | Strategic playbook builder. |

### `src/core/inbox/` — Proposal lifecycle

| File | Responsibility |
|------|---------------|
| `store.ts` | `PENDING → approved → claimed → applied` lifecycle. Append-only. |
| `apply.ts` | `applyProposal`: the only path to a real branch. Confirm-gated. |
| `merge.ts` | `evaluateMergeAuthority`: the tiered-trust merge gate. Verifies HMAC provenance, CI status, `mergeAuthority` config. |

### `src/core/daemon/` — Continuous autonomous operator

| File | Responsibility |
|------|---------------|
| `loop.ts` | `runDaemon`: the 24/7 operator. Per-tick: loads enrolled repos, builds backlog, routes items, dispatches sandboxed work, runs the opt-in auto-merge pass. Kill-switch and daily-budget gated. |
| `service.ts` | OS service management (launchd/systemd install/uninstall). |
| `state.ts` | Daemon lease + state persistence. |

### `src/core/sandbox/` — OS-level confinement

| File | Responsibility |
|------|---------------|
| `worktree.ts` | Git worktree lifecycle: create, track, remove. |
| `confine.ts` | `buildSandboxLauncher`: platform dispatch to `sandbox-exec` / `bwrap` / `firejail`. `buildMacosSbplProfile`: generates the SBPL read-jail + egress-deny profile. |
| `confine-linux.ts` | Linux `bwrap`/`firejail` launcher builder. |
| `audit.ts` | Append-only confinement audit log. |
| `policy.ts` | Confinement profile resolution from `cfg.foundry.confinement`. |

### `src/core/genome/` — Shared memory

| File | Responsibility |
|------|---------------|
| `store.ts` | `loadGenome`, `appendHubEntry`: aggregate the hub store (`~/.ashlr/genome/hub.jsonl`) with every project's `<repo>/.ashlrcode/genome/`. Append-only; never modifies existing entries. |
| `recall.ts` | `recall`: keyword/TF-IDF ranked retrieval, with optional Ollama embedding rerank. Fully offline. |
| `consolidate.ts` | Periodic consolidation: cluster related entries, synthesize playbooks. |
| `playbook.ts` | Build structured playbooks from genome entries. |

### `src/core/portfolio/` — Backlog and value filtering

| File | Responsibility |
|------|---------------|
| `scanners.ts` | Portfolio scanners: GitHub issues, TODOs, health checks, dependency stale, failing tests, convention violations, and more. Each scanner returns `WorkItem[]`. |
| `backlog.ts` | `loadBacklog`, `scoreItems`: aggregate, score (value × effort), and persist the work queue. |
| `value-filter.ts` | Filter and rank items by value density, dedup, cooldown. |
| `edv-verify.ts` | EDV (expected diffed value) verification: separate verifier before memory write (V6). |

### `src/core/comms/` — Bidirectional channel

| File | Responsibility |
|------|---------------|
| `dispatch.ts` | `runCommsCycle`: send pending outbound, poll inbound replies, resolve approve/reject decisions. |
| `handlers.ts` | Register handlers for inbound messages (approve, reject, pause, etc). |
| `requests.ts` | Build and send oversight requests via the configured transport. |
| `merge-requests.ts` | Post ship proposals for approve-by-text. |

Transports: `src/core/integrations/telegram.ts` and `src/core/integrations/imessage.ts`.

### `src/core/observability/` — Spend and telemetry

| File | Responsibility |
|------|---------------|
| `usage-source.ts` | Collect `UsageEvent`s from Claude session metadata and runs (never message content). |
| `rollup.ts` | Aggregate tokens/cost/sessions/commits by window. |
| `budget-alert.ts` | Evaluate `telemetry.budget*` caps → ok/warn/over. |
| `telemetry-sink.ts` | OTLP export (GenAI semantic conventions). |

### `src/core/web/` — Mission Control web dashboard

| File | Responsibility |
|------|---------------|
| `api.ts` | REST API: `/api/fleet`, `/api/inbox`, `/api/runs`, `/api/swarms`, `/api/genome`, `/api/pulse`, `/api/goals`. |
| `server.ts` | HTTP server bound to `127.0.0.1:7777` — localhost only, never externally reachable. |
| `control.ts` | Control endpoints: pause, resume, approve, reject. |

---

## The `~/.ashlr/` home layout

All persistent state lives under `~/.ashlr/` (resolved from `os.homedir()` at runtime; never hardcoded). The CLI is the sole writer.

```
~/.ashlr/
├── config.json          # AshlrConfig (validated against schema/config.schema.json)
├── index.json           # AshlrIndex — scanned desktop index
├── KILL                 # Kill-switch — present = fleet halted
├── runs/
│   └── <id>.json        # RunState, one file per run (atomic write-then-rename, resumable)
├── swarms/
│   └── <id>.json        # SwarmState, one file per swarm
├── inbox/
│   └── <id>.json        # InboxProposal — proposal lifecycle records
├── goals/
│   └── <id>.json        # Goal + milestone state
├── genome/
│   └── hub.jsonl        # Append-only hub memory store
├── foundry/
│   └── provenance.key   # HMAC signing key (0600, per-machine, never transmitted)
├── audit/
│   └── confinement.jsonl  # Append-only sandbox confinement audit
└── manager/
    └── <ts>.json        # Manager judge scorecards
```

External paths the hub reads but never writes:
- `~/.claude/projects/**/*.jsonl` — Claude Code session usage metadata (token counts, model, timestamp; never message content)
- `~/.claude.json`, `~/.claude/settings.json`, `~/.mcp.json`, `~/.ashlrcode/settings.json` — MCP server discovery
- `<repo>/.ashlrcode/genome/` — per-project genomes (aggregated at recall time)

---

## How a command flows — two examples

### `ashlr loop` (autonomous)

1. `bin/ashlr` → `dist/cli/index.js` → `cmdLoop` (`src/cli/loop.ts`)
2. `buildFleetStatus` renders the M49 control-plane snapshot.
3. `runConductor` (`core/goals/conductor.ts`) checks for active goals.
4. If goals exist: `advanceGoal` → `planMilestoneSpec` → `runEngineSandboxed` → PENDING proposal filed.
5. If no goals: `runDaemon` tick → backlog scan → `routeBackend` → `runEngineSandboxed` → PENDING proposal filed.
6. Kill-switch and daily budget are checked before any dispatch.
7. Summary printed; exit 0.

### `ashlr inbox approve <id>` (human gate)

1. `cmdInboxApprove` (`src/cli/inbox.ts`) reads the proposal.
2. Prompts for confirmation (TTY required; `--yes` skips prompt but still checks TTY).
3. `setStatus(proposal, 'approved')`.
4. `applyProposal` (`core/inbox/apply.ts`) applies the diff to the live tree.
5. If `mergeAuthority` is configured and the proposal carries matching frontier provenance with a valid HMAC + green CI: optionally merges to `main`.
6. Exit 0.

---

## Design invariants

- **Local-first.** No network call without explicit opt-in (`--allow-cloud`). Genome recall, observability, and the backlog are fully offline.
- **Privacy.** Usage rollups read only token metadata from Claude transcripts — never message content. Phantom is read-only (names/status, never values).
- **Append-only memory.** The hub store, project genomes, inbox records, and audit log are only ever appended to. Existing entries are never modified or deleted.
- **Fault tolerance.** Scans, probes, and gateway server starts degrade gracefully — one failure never crashes the whole operation.
- **Portability.** All home paths resolve from `os.homedir()`; no personal absolute paths in source.
- **No new runtime deps.** The fleet drives CLIs and APIs the user already has.

---

## Milestone → module mapping (v1–v5)

| Milestones | Theme | Primary modules |
|-----------|-------|-----------------|
| M1–M7 | Foundation — index, MCP gateway, agent loop, observability, lifecycle, genome | `config`, `index-engine`, `mcp-gateway`, `run/orchestrator`, `observability/`, `lifecycle/`, `genome/` |
| M8–M20 | Agentic platform — doctor, scaffold, telemetry, init, self-heal, plugin system | `doctor`, `lifecycle/scaffold`, `observability/telemetry-sink`, `plugins/` |
| M21–M30 | Autonomous org — sandboxed swarms, Approval Inbox, enrollment, kill-switch | `swarm/`, `inbox/`, `sandbox/worktree` |
| H1–H8 | Harden and prove — adversarial test suite, safety invariants | `test/h*.test.ts` |
| M31–M33 | Agent-native — plugin system, Raycast, update channel | `plugins/`, `src/raycast/`, `cli/update.ts` |
| M34–M44 | Team + Local Weapon — multi-machine inbox, adaptive prompts, verify→repair, eval | `integrations/`, `run/verify.ts`, `cli/eval.ts` |
| M45–M49 | Foundry — sandboxed engines, router, tiered-trust gate, HMAC provenance, fleet supervisor | `run/sandboxed-engine`, `fleet/router`, `inbox/merge`, `foundry/provenance`, `daemon/loop` |
| M50–M55 | Open Fleet — engine registry, tri-tier trust, OS confinement, fleet intelligence, self-improving, conductor | `run/engine-registry`, `sandbox/confine`, `run/learned-router`, `goals/conductor`, `cli/loop`, `cli/goal` |
| M140+ | Verification-First — test-iterate loop, judge traces, best-of-N, SWE-bench harness | `run/best-of-n`, `fleet/judge-trace`, `fleet/judge-calibration`, `core/eval/` |

Each milestone has a binding contract file in `docs/contracts/CONTRACT-M<N>.md` pinning its exported signatures.
