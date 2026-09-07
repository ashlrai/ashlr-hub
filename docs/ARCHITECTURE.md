# Architecture

Hub is the local execution and observation kernel for [Ashlr Universe](NORTH-STAR.md).
It ships a TypeScript/ESM CLI and SDK plus a React web console, with Node 22.15+
as the package runtime floor. The backend primarily uses Node builtins and bundles
three declared runtime dependencies: MCP transport (`@modelcontextprotocol/sdk`),
Markdown analysis (`marked`) and archive handling (`tar`). The manifest and lockfile
are the canonical inventory, not this overview.

## Current runtime map

These are separate executable paths, not one automatically commissioned loop:

| Path | Current responsibility | Evidence and boundary | Operator guide |
|------|------------------------|-----------------------|----------------|
| `universe` → `src/core/universe/` | Generate local candidates, evaluate artifacts, retain diverse winners, run bounded campaigns and deliver an artifact to a new local branch | Fixed evaluator and persisted lineage; operator/local-model generation. No subscription-pool bridge or automatic remote release | [Universe](ASHLR-UNIVERSE.md) |
| `resources pool` → `src/core/resources/` | Admit explicit native/local workers against quota, rolling task and shared concurrency limits; supervise a foreground queue | Durable assignments, output and reported usage. Worker completion is not verified engineering acceptance | [Resource Pools](RESOURCE-POOLS.md) |
| `runtime` → `src/core/local-runtime/` | Install, verify, select and roll back trusted exact local packages | A selected unsigned candidate is not npm publication or resident-service qualification; forwarded commands remain explicitly scoped | [Pinned runtime](ASHLR-UNIVERSE.md#install-a-pinned-local-runtime) |
| Scoped consoles → `src/core/web/` + `src/web-ui/` | Observe one Universe store or inspect/control one explicit resource pool | Loopback authentication; Universe console is read-only, resource mutations require execution enablement and separate authority | [Universe console](ASHLR-UNIVERSE.md#observe-one-universe-store), [resource console](RESOURCE-POOLS.md#operate-the-resource-console) |
| General Hub / legacy fleet | Shared configuration, enrolled-repository status, proposal and goal workflows | General dashboard is distinct from the scoped consoles; resident dispatch remains dormant as described below | [General Hub setup](QUICKSTART.md#general-hub-and-legacy-fleet-setup) |

The [North Star](NORTH-STAR.md) is the integrated product objective: useful accepted
changes per measured token and hour. Do not join Universe measurements to resource
worker receipts as if an execution/evaluation bridge already exists. Automatic
effectiveness assessment requires evidence tied to the actual produced artifact,
not merely a successful process or a populated fleet map.

Ecosystem products retain their repositories and product boundaries. Shared
contracts connect capabilities; their presence in an architecture map is not proof
that a provider, desktop controller or cross-product runtime is commissioned.
See the [source ecosystem design](https://github.com/ashlrai/ashlr-hub/blob/master/docs/AGENT-NATIVE-ECOSYSTEM.md).

## Legacy fleet activation boundary

**Current production boundary:** compiled daemon and conductor trust roots are
empty. Non-dry `ashlr loop` and daemon starts refuse before effects; only their
dry-run/status surfaces are active. `ashlr goal "<objective>"` remains a live,
owner-invoked, proposal-only plan-and-advance path, not resident authority. The
source-flow diagrams below describe latent architecture, not an activation
recipe.

---

## The autonomous loop

The legacy fleet's high-level source flow, not the current Universe/resource
execution path or an activation recipe:

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

Once separately admitted, the `ashlr loop` source path
(`src/cli/loop.ts`) calls `runConductor` (`core/goals/conductor.ts`), which
advances active goals first and falls back to `runDaemon`
(`core/daemon/loop.ts`) when no goals are active. Both paths are proposal-only
and kill-switch-gated. The current production entrypoint refuses non-dry loop
execution earlier because its compiled conductor trust roots are empty.

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

The legacy `runEngineSandboxed` path treats each external engine as a black box.
The layers below apply to that path; Resource Pool workers instead use an
explicit `cwd` and native adapter controls, while Universe has its own candidate
and evaluator isolation profile. Do not infer one path's confinement from another.

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
| `server.ts` | Loopback HTTP server plus separate read and mutation capabilities: read header/cookie for content, independent raw token for enabled actions. |
| `control.ts` | Control endpoints: pause, resume, approve, reject. |

Static assets and a content-free `GET /api/health` liveness projection are the
only public surfaces. Every proprietary GET and SSE request is authenticated
before route dispatch, so newly added API reads inherit the boundary by
default. `POST /api/session` requires the per-process read token and creates a
15-minute HttpOnly, SameSite=Strict ticket scoped to `GET /api/*`. Since a
browser cookie is shared by every port on one host, the signed ticket contains
a digest binding to a browser-generated 256-bit client proof stored in
origin-scoped `sessionStorage`. Cookie-authenticated fetches must supply the
exact bounded proof header. EventSource cannot set headers, so `/api/events`
accepts exactly one `client` query value and rejects duplicate or unknown query
parameters. That query value is not bearer authority: it works only with the
matching HttpOnly ticket, contains no read or mutation token, and is protected
from referrer disclosure by `Referrer-Policy: no-referrer`.

The ticket is signed with the current read token, making restart/token rotation
an immediate revocation mechanism. Mutations do not accept tickets or client
proofs and retain their explicit enablement plus an independent raw-header
token. The React console at `/next/` discards the raw read token after its session
exchange; only the non-authority client proof is stored in `sessionStorage`.
Cookie plus proof survives reload until ticket expiry, when the user must supply
the read token again. An explicitly unlocked mutation token is held only in module
memory with a 20-minute idle expiry; **Lock** clears it immediately.

The separately labelled legacy dashboard at `/` retains its raw read token in tab
`sessionStorage` for session renewal and prompts independently for mutation
authority. Do not apply that legacy storage contract to `/next/`. Ticket expiry
does not revoke the process's raw read token; server restart does. Scoped
Universe and resource consoles use their own server instances and authority
surfaces, as documented in their operator guides.

The loopback server intentionally speaks HTTP, so its browser cookie cannot use
the `Secure` attribute. No forwarded-protocol header is trusted and no CORS
credential path is enabled; a future TLS/reverse-proxy mode must establish a
trusted transport boundary before changing that behavior.

---

## The `~/.ashlr/` home layout

The general Hub defaults to `~/.ashlr/` (resolved at runtime, never a hardcoded
personal path). It is not the only supported state root. Universe can select an
explicit `--root`; Resource Pools use an explicit ledger root and private pool,
binding and observation files; managed packages use a separate `--store`.
Keep these stores distinct from source worktrees and from each other. A
foreground resource console can write its owned queue and ledger through
authenticated control requests; it is not a read-only CLI-owned store.

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
├── scorecard-history/
│   └── <YYYY-MM>.jsonl # POSIX-only observational scorecard snapshots
└── manager/
    └── <ts>.json        # Manager judge scorecards
```

Scorecard history is deliberately non-authoritative. On POSIX, each append or
read runs in a bounded one-shot helper whose validated current working
directory begins at the private state root. It enters `scorecard-history` by
one relative component, pins that directory as its working directory, and then
uses only single-component relative names with `O_NOFOLLOW` for enumeration and
child-file I/O. Successful appends fsync the file and fsync newly-created
directory or partition entries. Node does not expose an equivalent
directory-handle-relative primitive on Windows, so Windows performs no
scorecard-history writes and reports the source as degraded with
`unsupported-platform`; there is no absolute-path fallback.

External paths the hub reads but never writes:
- `~/.claude/projects/**/*.jsonl` — Claude Code session usage metadata (token counts, model, timestamp; never message content)
- `~/.claude.json`, `~/.claude/settings.json`, `~/.mcp.json`, `~/.ashlrcode/settings.json` — MCP server discovery
- `<repo>/.ashlrcode/genome/` — per-project genomes (aggregated at recall time)

---

## How a command flows — two examples

### `ashlr loop` (latent source flow; production non-dry entrypoint dormant)

The sequence below documents the admitted source architecture. It does not run
in the current production build without a separately provisioned compiled trust
root; `ashlr loop --dry-run` remains available.

1. `bin/ashlr` → `dist/cli/index.js` → `cmdLoop` (`src/cli/loop.ts`)
2. `buildFleetStatus` renders the M49 control-plane snapshot.
3. `runConductor` (`core/goals/conductor.ts`) checks for active goals.
4. If goals exist: `advanceGoal` → `planMilestoneSpec` → `runEngineSandboxed` → PENDING proposal filed.
5. If no goals: `runDaemon` tick → backlog scan → `routeBackend` → `runEngineSandboxed` → PENDING proposal filed.
6. Kill-switch and daily budget are checked before any dispatch.
7. Summary printed; exit 0.

### `ashlr inbox approve <id>` (explicit operator action)

1. `cmdInboxApprove` (`src/cli/inbox.ts`) resolves the proposal and checks its state;
   partial review evidence cannot be applied.
2. The operator confirms the displayed proposal kind and exact target. Non-TTY
   invocation requires `--yes`, which records caller intent, not authenticated
   human identity.
3. The proposal becomes approved, then `applyProposal` checks its mutation locks,
   enrollment and kill switch before any effect.
4. A `patch` proposal is applied through an isolated worktree to a new local
   `ashlr/proposal/<id>` branch, leaving the user's current branch/index/tree
   untouched. Other proposal kinds have their own explicitly displayed and gated
   effects; approval is not inherently a local-only action for every kind.
5. The result records success or failure. Patch approval does not automatically
   push or merge the default branch; protected submission and auto-merge are
   separate entrypoints and authority paths.

---

## Design invariants

- **Local-first.** Network effects belong to explicitly selected command/provider paths. The scoped Universe evaluator denies network; configured local-model generation and native workers have different documented transports. There is no one flag that authorizes every subsystem.
- **Privacy.** Usage rollups read only token metadata from Claude transcripts — never message content. Phantom is read-only (names/status, never values).
- **Preserve evidence.** Append-only logs retain events and provenance; mutable queue, proposal and selection records use their owning subsystem's persistence contract. Do not confuse a current-state record with immutable history.
- **Fault tolerance.** Scans, probes, and gateway server starts degrade gracefully — one failure never crashes the whole operation.
- **Portability.** All home paths resolve from `os.homedir()`; no personal absolute paths in source.
- **Explicit dependency boundary.** The package's declared and bundled dependencies must match its verified inventory; reuse existing utilities before changing that contract.

---

## Milestone → module mapping (v1–v5)

This is a batched, series-level view. For an ID-by-ID lookup (including
milestone numbers that were spec'd for one thing and shipped as another),
see the [source milestone index](https://github.com/ashlrai/ashlr-hub/blob/master/docs/MILESTONE-INDEX.md).

| Milestones | Theme | Primary modules |
|-----------|-------|-----------------|
| M1–M7 | Foundation — index, MCP gateway, agent loop, observability, lifecycle, genome | `config`, `index-engine`, `mcp-gateway`, `run/orchestrator`, `observability/`, `lifecycle/`, `genome/` |
| M8–M20 | Agentic platform — doctor, scaffold, telemetry, init, self-heal, plugin system | `doctor`, `lifecycle/scaffold`, `observability/telemetry-sink`, `plugins/` |
| M21–M30 | Autonomous org — sandboxed swarms, Approval Inbox, enrollment, kill-switch | `swarm/`, `inbox/`, `sandbox/worktree` |
| H1–H8 | Harden and prove — adversarial test suite, safety invariants | `test/h*.test.ts` |
| M31–M33 | Agent-native — plugin system, Raycast, update channel | `plugins/`, `src/raycast/`, `cli/update.ts` |
| M34–M40 | Team Command Center — **spec'd, NOT built.** No `test/m34.*`–`test/m40.*` exist; `hub/v1`/`ASHLR_API_URL` absent from `src/`. See `docs/SPEC-V3-TEAM.md` status banner and `docs/MILESTONE-INDEX.md` §3. | `seams/identity.ts`, `seams/daemon-coordinator.ts` (gated stubs only) |
| M41–M44 | Local Weapon — adaptive prompts, sandboxed engineer tool surface, verify→repair, eval | `integrations/`, `run/verify.ts`, `cli/eval.ts` |
| M45–M49 | Foundry — sandboxed engines, router, tiered-trust gate, HMAC provenance, fleet supervisor | `run/sandboxed-engine`, `fleet/router`, `inbox/merge`, `foundry/provenance`, `daemon/loop` |
| M50–M55 | Open Fleet — engine registry, tri-tier trust, OS confinement, fleet intelligence, self-improving, conductor | `run/engine-registry`, `sandbox/confine`, `run/learned-router`, `goals/conductor`, `cli/loop`, `cli/goal` |
| M140+ | Verification-First — test-iterate loop, judge traces, best-of-N, SWE-bench harness | `run/best-of-n`, `fleet/judge-trace`, `fleet/judge-calibration`, `core/eval/` |

Each milestone has a binding contract file in `docs/contracts/CONTRACT-M<N>.md` pinning its exported signatures.
