# Changelog

All notable changes to ashlr-hub are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions map to milestone series: **2.1.0** = v2.1 "Harden & Prove" (H1–H8),
**2.0.0** = v2 "Autonomous Engineering Organization" (M21–M30), **1.0.0** = v1
hub (M1–M20). Entries below detail each milestone; dates are merge dates into `main`.

---

## [Unreleased]

- **v3 gate opened — Team Command Center spec.** `docs/SPEC-V3-TEAM.md`: the
  hand-written end-state spec for the team / multi-machine backbone (one team
  memory, shared approval inbox with owner-apply routing, coordinated
  daemons, team visibility) riding api.ashlr.ai under `/hub/v1/*`.
  Milestones M34–M40, thirteen new team safety invariants, registered as a
  living ashlr goal. ROADMAP and contracts README updated to point at it.

## [3.0.1] — 2026-06-17 — presentation + polish

A patch release on top of 3.0.0 — no change to the engine, fleet, or safety
floor; refreshes the public face and hardens the release/test ergonomics.

- **docs:** README reworked as the ecosystem front door — npm badges, an "Ashlr
  ecosystem" table linking every sibling tool (phantom-secrets, ashlrcode,
  ashlr-stack, ashlr-plugin, binshield, ashlr-md, ashlr-workbench, ashlr-pulse)
  with how the hub leverages each, and an accurate v3/v4/v5 capability map (the
  prior copy still read "30 milestones").
- **cli:** `ashlr version` / `--version` / `-v` now print the package version
  (previously "Unknown command").
- **test/release:** deterministic publish gate — `prepublishOnly` runs the suite
  with `--no-file-parallelism` (new `test:serial` script); `h1`/`h8` assert the
  real `~/.ashlr` is byte-identical before/after (the actual isolation guarantee)
  rather than assuming it is empty; `m32` gets a realistic timeout. The full suite
  is now deterministically green on a developer machine with the daemon live.

## [3.0.0] — 2026-06-17 — v3-Weapon · v4-Foundry · v5-Open-Fleet (M41–M60)

A major leap: local models became an engineering weapon, then a fleet of
backends that builds and maintains the ecosystem autonomously — proposal-only,
trust-gated, contained. Same safety floor; zero new runtime deps.

### v3-Weapon (M41–M44)
- Adaptive, model-sized prompts; the sandboxed engineering tool surface
  (write/edit/bash confined to a worktree, diffs → inbox, never the live tree);
  the verify→repair loop; and `ashlr eval` proving the local uplift.

### v4-Foundry (M45–M49)
- `runEngineSandboxed`: run an external agent CLI inside a throwaway git
  worktree, sever git push, capture ONLY the scrubbed diff as a PENDING
  proposal, trust-tagged `{engineModel, engineTier}`.
- Backend router + rate/quota scheduler; the tiered-trust merge-to-`main` gate
  with HMAC-signed provenance (M47.1); the 24/7 fleet supervisor; the fleet
  control plane (`ashlr fleet status/pause/resume` + `#fleet` web view).

### v5-Open-Fleet (M50–M60)
- **M50** declarative engine registry (adding a backend is config-only) + a real
  OpenAI-compatible API client (Hermes, OpenCode, NVIDIA NIMs, Kimi K2.7 …);
  existing engines reproduce byte-identical argv.
- **M51** tri-tier trust (`local | mid | frontier`); authority never leaks
  upward (`frontier→main`, `mid→branch`, `local→proposal-only`).
- **M52** OS-level confinement (macOS `sandbox-exec` read-jail + egress gate)
  closing v4's read-residual.
- **M53** fleet intelligence — learned routing, budget-breach tier cascade,
  per-run cost-anomaly holds (all proposal-only).
- **M54** self-improving fleet — a never-weaken guard (refuses any diff that
  deletes/weakens a safety test) + a green-flag-off-AND-on self-eval harness.
- **M55** the conductor — `ashlr goal` + `ashlr loop` + Claude Code `/goal`
  `/loop`.
- **M56** `mid→branch` auto-apply (verified mid-tier opens a PR, never `main`),
  behind a separate default-off `midToBranch` flag.
- **M57** `cfg.foundry` example + `docs/FOUNDRY-CONFIG.md`.
- **M58/M60** two reference plugins (scanner + template) seeding the ecosystem.
- **M59** `ashlr fleet init` (config bootstrap) + typed `cfg.foundry.intelligence`.

### Safety
Everything can reach `main` — but only a frontier merge-authority model, fully
verified, with valid HMAC provenance. Auto-merge (main and mid→branch) is
DEFAULT OFF. Kill-switch (`~/.ashlr/KILL`) halts every backend.

---

## [2.2.0] — 2026-06-12 — v2.2 "Agent-Native Ecosystem" (M31–M33)

Makes ashlr's intelligence first-class INSIDE agent sessions — CLI-first, with
the MCP gateway as a second transport over the same capabilities. No safety
posture change: reads flow freely, writes stay append-only or proposal-only.

- **M31 — Agent-native surface.** The MCP gateway now serves 11 native
  `ashlr_*` tools (orient/ask/recall/learn/backlog/health/status/impact/
  pulse/inbox_list/inbox_propose) with structural safety classes
  (read / append / proposal), kill-switch gating on every write, secret
  scrubbing + 32KB caps on every result, and full `mcp:native-call` audit
  coverage. There is deliberately NO approve/apply tool — approval stays
  human-only via `ashlr inbox`. New `ashlr orient [--repo] [--json]`
  (composite session-start context), `ashlr docs --agent` (generated agent
  cheat sheet), `ashlr wire --claude-md` (CLAUDE.md snippet),
  `ashlr completions zsh|bash`, "did you mean" suggestions, and read-only
  `GET /api/orient|health|backlog|impact` web routes.
  `docs/contracts/CONTRACT-M31.md` · 6 new test files.

- **M32 — Living command center.** The web dashboard becomes a real control
  surface: `#inbox` view with approve/reject (gated identically to dispatch —
  routes 404 without `--allow-dispatch`, per-session token, applies only via
  `applyProposal`'s triple gate), `#daemon` view + live nav badge, and a
  dispatch panel with live cost preview. SSE gains `inbox`/`daemon` named
  events (metadata only — never diffs). New pre-flight cost estimator:
  `ashlr run|swarm "<goal>" --estimate` (p25/median/p75 tokens·cost·duration
  from history, confidence-tiered, budget-clamped; also a footer in swarm
  `--dry-run` and `GET /api/estimate`). Help reworked into topics:
  `ashlr help [<topic>] [--search <term>] [--all]`. Knowledge build shows a
  TTY progress line. Opt-in macOS desktop notification (+ webhook) when an
  unattended swarm files a PENDING proposal (`notify.desktop: true`;
  metadata only). `docs/contracts/CONTRACT-M32.md` · 5 new test files.

- **M33 — Ecosystem layer.** Plugins: third parties can contribute backlog
  scanners, project templates, model providers, and CLI commands from
  `~/.ashlr/plugins/<name>/` — DEFAULT-OFF (`plugins.enabled: []`),
  manifest-only discovery (no code executes until enabled), sha256 integrity
  pinning, capability declarations enforced, kill-switch gated, fully audited,
  with a least-privilege host API (frozen config projection, never secrets).
  `ashlr plugins list|info|enable|disable`, `ashlr x <name>`. Distribution:
  the package is now `@ashlr/hub` (public, npm provenance) with a tag-gated
  release pipeline (full CI verify → version/changelog gates → publish +
  GitHub release), a CI pack-smoke step keeping the exports map honest, and
  `ashlr update` channel awareness (git checkout vs npm install; npm installs
  only with `--yes`). Public API: curated `@ashlr/hub` / `./core` / `./types`
  / `./plugin` entry points (`applyProposal` deliberately unexported).
  `docs/contracts/CONTRACT-M33.md`, `docs/PLUGINS.md`, `docs/RELEASING.md`.

- **DX follow-ups.** `ashlr plugins init <name> [--capability k]` scaffolds a
  working plugin skeleton (every skeleton integration-proven to load and
  contribute); agent-contract conformance locks pin the OrientResult /
  RunEstimate shapes, the 11 native tool names + safety classes, and the
  AGENT_COMMANDS registry so shape drift fails a named test; public roadmap
  (`docs/ROADMAP.md`); CI made hermetic (doctor `which ashlr` shim,
  check-version argv precedence) — the suite is green on clean runners.

## [2.1.0] — 2026-06-11 — v2.1 "Harden & Prove" (H1–H8)

Takes v2 from *built + unit-tested* to **proven trustworthy**. Eight hardening
milestones, each a contracts-first agent workflow with a **test-validity**
adversarial lens (which repeatedly caught false-green stub tests and real bugs).
Every change is local-first and adds **no new outward capability** — v2.1 only
proves and hardens what v2 built. Disposable repos in isolated tmp HOMEs
throughout; the real portfolio was never touched. 40 commits · 3,374 tests.

- **H1 — End-to-end autonomous-chain harness (keystone).** A reusable
  disposable-repo / tmp-HOME testkit + an integration suite that drives the *real*
  chain (enroll → daemon tick → sandboxed swarm → pending proposal → approve →
  `applyProposal`) and proves the working tree stays byte-identical, the proposal
  is the only sink, and every gate holds. `test/helpers/h1-fixture.ts`.
- **H2 — Crash recovery & resumability.** Fault-injection: daemon-mid-tick and
  swarm-mid-run crashes recover with no double-spend, no orphaned sandboxes, no
  stuck proposals, clean resume, and a clean kill-switch race. Adds
  `sweepOrphanSandboxes`.
- **H3 — Concurrency & budget stress.** Proves the in-process caps hold under
  load; adds a monotonic `makeId` counter. **Honest finding:** under `parallel>1`
  the per-tick budget is a *bounded overshoot* (≤ (parallel-1)×per-item), not a
  hard cap — documented, not hidden.
- **H4 — Safety-invariant regression suite + `ashlr verify-safety`.** Turns all
  54 enumerated guards across 7 invariants into a permanent always-on suite
  (closing 12 previously-untested guards) plus a read-only self-check, so no
  future change can silently weaken a guarantee.
- **H5 — Sandbox lifecycle & leak hardening.** Wires the orphan sweep into daemon
  start (+ `ashlr sandbox gc`), adds a read-only daemon-state reconcile, env-gates
  the `allowAnyRepo` test hatch, and adds a sandbox disk cap. Found + fixed a
  live-worktree-removal bug.
- **H6 — Audit & observability completeness.** `enroll` / `unenroll` / `setKill`
  are now audited at the primitive; adds a read-only `ashlr audit` viewer; brings
  the two secret-scrub implementations to parity (+ a Stripe-token pattern).
- **H7 — Guided onboarding & preflight.** `ashlr preflight` (read-only readiness)
  + 5 new doctor probes, a guided `ashlr onboard` first-activation walkthrough,
  and one-command `ashlr onboard --rollback`. No new outward capability.
- **H8 — Reproducible demo + reliability docs + activation runbook.** `ashlr demo`
  runs the full chain on a disposable repo so you can watch it before trusting it
  (auto-cleans, never touches your portfolio, never applies); `docs/RELIABILITY.md`;
  the canonical README activation runbook; and a maintainability cleanup pass.

**Activation remains the operator's explicit gate** — enrollment ships empty and
nothing autonomous runs until you `ashlr enroll` a repo and approve proposals via
`ashlr inbox`. See `docs/RELIABILITY.md` and the README *Activation* section.

---

## [Unreleased] — M30: Cloud-Ready Seams v2 + Polish (CAPSTONE)

The Ashlr v2 capstone. Makes the team/multi-machine future a **drop-in** later
without a rewrite by defining clean **seam interfaces** for every v2 store — and
shipping **only the LOCAL side** now. Every seam has a working LOCAL impl (a thin
adapter over the existing module, zero behaviour change) and a GATED cloud stub
that THROWS a clear gated error if ever selected. **There is no config flag and
no code path that can activate a functional cloud backbone** — cloud/team is a
Mason gate (explicit opt-in, not implemented). Local-first, self-hostable,
nothing public. Generalises the M19 telemetry-sink seam pattern across the v2
stores without destabilising them.

### Added

- **`ashlr seams` / `ashlr seams status`** — read-only diagnostic that lists every
  v2 seam, its active implementation (`local`), and its cloud availability
  (`gated` for the seven v2 seams; `false` for the cited telemetry reference
  seam). `--json` emits the `SeamRegistry`; `--help` prints usage. Mutates
  nothing, makes no network connection, and instantiates no seam impl. Backed by
  `src/cli/seams.ts` (`cmdSeams`), mirroring `src/cli/health.ts`.

- **Seam layer** (`src/core/seams/`): one cohesive module per seam, each exposing
  the canonical four-part shape — INTERFACE, LOCAL impl (default, delegates 1:1 to
  the existing module), GATED cloud stub (every method throws before any I/O), and
  a `selectX(cfg)` selector (returns LOCAL by default; returns the throwing stub
  ONLY when a cloud endpoint is explicitly configured):
  - `RunSwarmStore` (`seams/run-swarm.ts`) — wraps `core/swarm/store.ts`
    (`listSwarms` / `loadSwarm` / `saveSwarm`).
  - `BacklogSource` (`seams/backlog.ts`) — wraps `core/portfolio/backlog.ts`
    (`loadBacklog` / `buildBacklog`).
  - `InboxStore` (`seams/inbox.ts`) — wraps `core/inbox/store.ts`
    (`listProposals` / `createProposal` / `loadProposal` / `setStatus` /
    `pendingCount`).
  - `DaemonCoordinator` (`seams/daemon-coordinator.ts`) — wraps
    `core/daemon/state.ts` (`loadDaemonState` / `saveDaemonState`); LOCAL is
    single-machine (lease is a no-op), cloud stub is a GATED multi-machine
    lease/lock.
  - `GenomeSync` (`seams/genome.ts`) — wraps `core/genome/store.ts`
    (`loadGenome` / `appendHubEntry` / `genomeHubHealth`).
  - `PortfolioSync` (`seams/portfolio.ts`) — wraps `core/quality/store.ts` +
    `core/dashboard.ts` (health snapshots + portfolio dashboard).
  - `IdentityProvider` (`seams/identity.ts`) — wraps
    `core/integrations/identity.ts` (`getIdentity`); LOCAL is the phantom probe,
    cloud stub is GATED team auth.
  - `TelemetrySink` (`core/observability/telemetry-sink.ts`, M19) — the CANONICAL
    reference seam. CITED via the registry, not duplicated. Its opt-in
    `OtlpHttpSink` is a real local-network sink, not a gated team backbone, so its
    `cloud` field is `false` (distinct from the seven `gated` v2 seams).

- **Seam types** (`src/core/seams/types.ts`, single-sourced): `SeamId`,
  `SeamImpl` (`'local' | 'gated'`), `SeamCloud` (`false | 'gated'` — NEVER `true`
  in M30), `SeamStatus`, `SeamRegistry`, and `SeamsConfig` (OPTIONAL per-seam
  `{ endpoint? }`). `CLOUD_GATED_MESSAGE` + `cloudGatedError(seam, method)` are the
  single canonical gated error, centralised so it is identical across seams and
  trivially assertable.

- **Seam registry** (`src/core/seams/registry.ts`, READ-ONLY): `buildSeamRegistry(cfg)`
  derives the full registry from the in-memory config + static descriptors —
  triggers NO I/O, instantiates NO seam impl, never touches disk/network, never
  throws. `seamsConfig(cfg)` reads the OPTIONAL `seams` block defensively via a cast
  over an optional property (so `AshlrConfig` is unmodified). `seamEndpoint(cfg, id)`
  returns the explicitly-configured endpoint for a gated seam, or `null` — a
  non-null result routes the selector to the GATED stub (which throws) and NEVER
  enables a functional backbone.

- **Barrel** (`src/core/seams/index.ts`) re-exporting the seam interfaces, selectors,
  registry, and types.

### Docs

- **`docs/SEAMS.md`** — documents the local-first + cloud-ready seam architecture,
  the canonical four-part seam pattern, each seam and the existing module it wraps,
  the Mason gate, the `ashlr seams` diagnostic, and the five hard safety invariants.

- **`README.md`** — adds the full v2 command surface (`ask`, `knowledge`,
  `reflect`, `health`, `goals`, `digest`, `daemon`, `inbox`, `backlog`, `enroll`,
  `seams`), a concise **"Ashlr v2 — Autonomous Engineering Organization"** section
  summarising M21–M30, and a clearly-marked **ACTIVATION RUNBOOK ("the human's
  gate")**: enroll real repos (`ashlr enroll add <repo>`) → run `ashlr daemon` →
  review and approve proposals via `ashlr inbox`. Emphasises that default
  enrollment is EMPTY and everything is proposal-only / sandboxed.

### Polish

- **CI** — `.github/workflows/ci.yml` extended to a Node `["20", "22"]` matrix,
  keeping typecheck / lint / build / test. Must stay green on both.

### Tests

- **`test/m30.seams.test.ts`** — hermetic invariant tests (in-memory config; never
  the real `~/.ashlr`, never the real portfolio, never a remote call): every cloud
  stub method throws `CLOUD_GATED_MESSAGE`; every selector returns the LOCAL impl on
  the default config; a configured endpoint routes to the throwing stub; the
  registry reports `allLocal` by default.

### Safety invariants (M30)

- **Interfaces + local only** — no functional cloud/team/remote implementation
  exists. Each cloud stub throws `cloudGatedError(...)` as the FIRST statement of
  every method, before any I/O; no `fetch`/http/socket/disk in any seam cloud stub.
- **No activation path** — selectors return LOCAL by default; a configured endpoint
  only routes to a throwing stub. There is no value of config that yields a
  functional cloud backbone, and no way for the autonomous loop/daemon to flip to
  cloud.
- **Non-regression** — zero edits to any wrapped store; local adapters delegate 1:1;
  the seam config is read via a cast over an OPTIONAL property so `AshlrConfig` is
  unmodified. All prior tests stay green.
- **Nothing public / self-hostable** — no outward action, no registration/telemetry/
  phone-home, no public flip. Docs state local-first + self-hostable + cloud-gated.
- **Bounded + no new deps** — `package.json` unchanged; only intra-repo imports; the
  registry maps a fixed 8-element descriptor list; read-only diagnostics.

---

## [Unreleased] — M25: Portfolio Intelligence (`ashlr knowledge` · `ashlr ask` · `ashlr impact`)

### Added

- **`ashlr knowledge build [--repo <path>]`** — build or incrementally refresh the local semantic knowledge index for all enrolled repos (or a single repo with `--repo`). Walks source files read-only, chunks them, embeds each chunk via local Ollama embeddings (keyword/TF-IDF fallback when no embedding model is available), and stores results to `~/.ashlr/knowledge/<repo-hash>/*.jsonl`. Incremental by mtime — only changed files are re-indexed.

- **`ashlr ask "<question>" [--repo <path>] [--allow-cloud]`** — local RAG Q&A across the indexed portfolio. Retrieves the top relevant chunks via embedding similarity or keyword scoring, synthesises a plain-language answer using the **local** model, and cites every source as `repo/file:line`. `--repo` scopes the search to a single enrolled repo. Cloud is structurally OFF by default — the local provider is used for both retrieval and synthesis; `--allow-cloud` is required to route synthesis to a cloud model AND only takes effect when a key is present.

- **`ashlr knowledge graph [--repo <path>]`** — build and print a lightweight cross-repo knowledge graph. Nodes are repos, modules, and key dependencies; edges are imports, depends-on, and shared-dep relationships. Cross-repo findings (same vulnerable/outdated dependency, duplicated patterns) are surfaced as `crossRepo` entries. Output is JSON-serialisable for downstream tooling.

- **`ashlr impact <file|symbol> [--repo <path>]`** — answer "what depends on this?" across the enrolled portfolio. Returns all references (repo, file, line) and a list of dependent repos/modules. Scoped to enrolled repos only; read-only analysis.

- **Knowledge index engine** (`src/core/knowledge/index.ts`):
  - `buildKnowledge(opts?)` — default `repos = listEnrolled()` (DEFAULT EMPTY → empty knowledge, no disk scan). Bounded: skips `node_modules/`, `.git/`, `dist/`, and binary files; enforces file-count and byte caps per repo; local embeddings via `getActiveClient()` from `core/genome/recall.ts`; keyword/TF-IDF fallback. Secret-scrubs chunks before storing (skips `.env`/key files; redacts secret-shaped tokens). Writes `~/.ashlr/knowledge/<repo-hash>/*.jsonl`.
  - `knowledgeDir()` — canonical store path (`~/.ashlr/knowledge/`).
  - `loadChunks(repo?)` — read stored chunks from disk; scoped to one repo when provided.

- **Ask engine** (`src/core/knowledge/ask.ts`):
  - `ask(question, { repo?, allowCloud })` — retrieve top chunks (embedding cosine or keyword TF-IDF), call local synthesis via `core/run/provider-client.ts` local provider, return `AskResult { question; answer; sources; method; local }`. `allowCloud` defaults to `false` at every call site; code-to-cloud on the default path is a guardrail violation.

- **Graph + impact engine** (`src/core/knowledge/graph.ts`):
  - `buildGraph(repos?)` — static import/dependency analysis; returns `KnowledgeGraph { nodes; edges; crossRepo }`. Cross-repo detection surfaces shared vulnerable/outdated deps and duplicated structural patterns.
  - `impact(target, repos?)` — file or symbol name → `ImpactResult { target; references; dependents }`. Read-only; enrollment-scoped.

- **CLI entry points**:
  - `src/cli/ask.ts` (`cmdAsk`) — backs `ashlr ask`; `--repo` and `--allow-cloud` flags; cloud OFF by default.
  - `src/cli/knowledge.ts` (`cmdKnowledge`) — backs `ashlr knowledge build | graph | impact`; delegates to core engines.

- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `KnowledgeChunk { repo; file; startLine; endLine; text; vector?; summary? }`
  - `AskHit { chunk: KnowledgeChunk; score: number }`
  - `AskResult { question; answer; sources: {repo; file; line}[]; method: 'embedding'|'keyword'; local: boolean }`
  - `ImpactResult { target; references: {repo; file; line}[]; dependents: string[] }`
  - `KnowledgeGraph { nodes: {id; kind; label}[]; edges: {from; to; kind}[]; crossRepo: {kind; detail; repos}[] }`

### Guardrails (M25)

- **LOCAL-ONLY BY DEFAULT (privacy)**: indexing, ask synthesis, and embeddings all run on the local provider (Ollama via `getActiveClient()`). Repo code and chunks are **never sent to a cloud model** unless `--allow-cloud` is explicitly passed AND a cloud key is present. Both conditions must be true simultaneously. Sending code to cloud on the default path is a contract violation.
- **READ-ONLY**: `buildKnowledge`, `ask`, `buildGraph`, and `impact` never modify any enrolled repo. All writes are confined to `knowledgeDir()` (`~/.ashlr/knowledge/`). No `git` mutations, no installs, no project-script execution.
- **ENROLLMENT-SCOPED**: default repos = `listEnrolled()`. Default enrollment is empty — empty knowledge, no whole-portfolio disk scan. Only explicitly enrolled repos are ever indexed or queried.
- **BOUNDED**: file-count and byte caps per repo; skips `node_modules/`, `.git/`, `dist/`, and binary files; embedding calls subject to the same time/concurrency caps as genome recall.
- **NO SECRETS**: `.env` and key files are excluded from indexing. Secret-shaped tokens (high-entropy strings matching common key patterns) are redacted from chunks before storing, embedding, or citing. No secret values appear in `~/.ashlr/knowledge/` or in `ask` answers.
- All 2443 existing tests preserved. Typecheck passes clean (`tsc --noEmit`). No new runtime dependencies. Reuses `core/genome/recall.ts` (embeddings + `getActiveClient`), `core/sandbox/policy.ts` (`listEnrolled`, `isEnrolled`), `core/run/provider-client.ts` (local provider), `core/git.ts`, and `cli/ui.ts`.

---

## [Unreleased] — M24: The Autonomous Daemon (`ashlr daemon`)

### Added

- **`ashlr daemon` — the autonomous operator that makes the org continuous** (`src/core/daemon/state.ts`, `src/core/daemon/loop.ts`, `src/cli/daemon.ts`):
  - Pulls the highest-value backlog items for enrolled repos and dispatches sandboxed swarms whose output becomes PENDING proposals in the Approval Inbox. **It is proposal-only by construction — it has no path to apply, push, open a PR, or deploy.**
  - **`ashlr daemon start`** — begin the operator loop; ticks on an interval until stopped, daily budget is exhausted, or the kill switch is set.
  - **`ashlr daemon start --once`** — run exactly one tick and exit (ideal for cron or manual one-shot use).
  - **`ashlr daemon start --dry-run`** — plan only: shows which backlog items would be worked this tick; no swarm is dispatched, no proposal is created. Safe to run at any time.
  - **`ashlr daemon start --budget <usd>`** — override the daily budget cap for this session.
  - **`ashlr daemon start --interval <ms>`** — override the tick interval.
  - **`ashlr daemon start --parallel <n>`** — override the per-tick concurrency cap.
  - **`ashlr daemon stop`** — sets `~/.ashlr/KILL` and clears running state; all in-flight ticks halt at the next kill-switch check.
  - **`ashlr daemon status`** — running state, PID, last tick time, today's spend vs cap, items processed, pending proposals count.

- **Daemon state** (`src/core/daemon/state.ts`) — atomic, never-throws, day-reset-aware:
  - `daemonStatePath()` — `~/.ashlr/daemon.json`.
  - `loadDaemonState()` — returns a fresh zeroed `DaemonState` on missing or corrupt file; never throws.
  - `saveDaemonState(s)` — atomic write (temp file + rename), `mkdir -p` on first save.
  - `resetDayIfNeeded(s)` — zeroes `todaySpentUsd` and `itemsProcessed` when `todayDate` has rolled over; preserves all other state.

- **Daemon loop** (`src/core/daemon/loop.ts`) — ordered safety checks before any work is dispatched:
  - `tick(cfg, { dryRun })` — one operator cycle: kill-switch check → budget-exhausted check → enrolled-repos check → load/refresh backlog → select top-K items under per-tick + daily budget cap → (dry-run: log plan only; else: dispatch `runSwarm` with `opts.sandbox=true` + `opts.propose=true` at bounded concurrency) → record spend + audit + daemon state. Returns a `DaemonTick` summary.
  - `runDaemon(cfg, { once, dryRun })` — REFUSES (throws) if `ASHLR_IN_DAEMON` or `ASHLR_IN_SWARM` is set (fork-bomb guard); sets `ASHLR_IN_DAEMON=1` on child processes; `once=true` runs one tick; otherwise loops, re-checking kill switch and budget every iteration. No unbounded loop — exits cleanly on exhaustion or stop.
  - `stopDaemon()` — sets `~/.ashlr/KILL` + clears running state.

- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `DaemonConfig { dailyBudgetUsd; perTickItems; parallel; intervalMs }` — caps only; grants no authority.
  - `DaemonTick { ts; itemsConsidered; proposalsCreated; spentUsd; reason }` — one tick summary record.
  - `DaemonState { running; pid; startedAt; lastTickAt; todayDate; todaySpentUsd; itemsProcessed; ticks }` — persisted daemon state.
  - `AshlrConfig.daemon?: Partial<DaemonConfig>` — optional per-installation caps override.
  - `DashboardSnapshot.daemon?: { running; todaySpentUsd; pendingProposals }` — optional; absent = not running.

- **Dashboard surface** (TUI + web) — `DashboardSnapshot.daemon` populated from `loadDaemonState()` + `pendingCount()`; read-only display of running state, today's spend, and pending proposal count.

### Guardrails (M24)

- **PROPOSAL-ONLY (grep-provable)**: the daemon code imports and calls ONLY `createProposal` (via `runSwarm opts.propose`) and `pendingCount` (read-only). It NEVER imports or calls `applyProposal`, `git push`, `gh pr create`, or any deploy/ship path. Every tick's output is a PENDING proposal in the Approval Inbox; applying it requires explicit human `ashlr inbox approve`.
- **ENROLLMENT-ONLY**: the daemon operates ONLY on `listEnrolled()` repos. Default enrollment is empty — if nothing is enrolled, the daemon idles and does nothing. It never scans or operates on the full 69-repo portfolio.
- **SANDBOXED**: all swarm work is dispatched with `opts.sandbox=true` (M21 git-worktree sandboxes). The user's working tree, current branch, index, and HEAD are never touched.
- **BOUNDED**: hard daily budget cap (default modest), per-tick item cap, and concurrency cap enforced on every tick. Budget resets per calendar day via `resetDayIfNeeded`. When exhausted the daemon idles or stops. No unbounded loop.
- **KILL SWITCH**: `~/.ashlr/KILL` is checked at the top of every tick. `ashlr daemon stop` sets it immediately. Cannot be bypassed.
- **RE-ENTRANCY GUARD**: `runDaemon` REFUSES to start if `ASHLR_IN_DAEMON=1` or `ASHLR_IN_SWARM=1` is set in the environment. Prevents daemon-inside-daemon and daemon-inside-swarm fork bombs. Respects the existing swarm recursion guard.
- All 2357 existing tests preserved. Typecheck passes clean (`tsc --noEmit`). No new runtime dependencies.

---

## [Unreleased] — M23: Approval Inbox (Single Outward Gate)

### Added
- **Approval Inbox — the single human control plane for all outward actions** (`src/core/inbox/store.ts`, `src/core/inbox/apply.ts`, `src/cli/inbox.ts`):
  - Every proposed outward action (patch, PR, deploy) is written as a `Proposal` to `~/.ashlr/inbox/<id>.json` before anything happens. Nothing outward occurs until you explicitly approve.
  - **`ashlr inbox`** — list all pending proposals with counts; shows id, kind, origin, title, and age.
  - **`ashlr inbox show <id>`** — full proposal detail including unified diff (for patch proposals) and summary.
  - **`ashlr inbox approve <id> [--yes]`** — the ONLY path that triggers outward action. Confirm-gated interactively (or bypass with `--yes`); marks the proposal `approved` then calls `applyProposal`. Nothing outward runs before this point.
  - **`ashlr inbox reject <id>`** — marks a proposal `rejected`; discards it. No outward action taken.
- **Proposal store** (`src/core/inbox/store.ts`) — atomic-write, never throws:
  - `createProposal(p)` — creates a fresh `Proposal` (status `'pending'`, timestamp, fresh id) and persists to `~/.ashlr/inbox/<id>.json`. **Does not apply anything.**
  - `listProposals(filter?)` — returns proposals newest-first; filter by status; read-only, never throws.
  - `loadProposal(id)` — returns a single proposal or `null`.
  - `setStatus(id, status, result?)` — persistence-only; sets `decidedAt` on approve/reject; **applies nothing**.
  - `pendingCount()` — count of pending proposals (used by dashboard snapshot and daily-digest).
- **Apply engine** (`src/core/inbox/apply.ts`) — the single outward funnel, heavily guarded:
  - `applyProposal(id, { confirmed })` — REFUSES (mutates nothing) unless proposal exists AND `status === 'approved'` AND `confirmed === true`. All three conditions are required simultaneously.
  - By kind: `'patch'` → applies the diff on a **NEW branch** (`BRANCH_PREFIX`) off HEAD in the target repo — **never touches the user's current branch, index, or working tree**; never force-pushes; never pushes at all (local only). `'pr'` → branch + commit then explicit M18 gated `createPr`. `'deploy'` → gated ship path. `'note'` → no-op record.
  - Enrollment-checked (`assertMayMutate`) and kill-switch-checked before any mutation. Every apply is audited. Status set to `'applied'` on success or `'failed'` on error.
  - Never throws — always returns `ApplyResult { ok, status, detail }`.
- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `ProposalKind = 'patch' | 'pr' | 'deploy' | 'note'`
  - `ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed'`
  - `Proposal { id; repo; origin: 'backlog'|'swarm'|'manual'; kind; title; summary; diff?; sandboxId?; status; createdAt; decidedAt?; result? }`
  - `ApplyResult { ok; status; detail }`
  - `DashboardSnapshot.inbox: { pending: number }` — pending count surfaced to dashboard and daily digest.
- **Surfaces**:
  - **TUI** — new Inbox tab (read-only view of pending proposals; approve via `ashlr inbox approve`). Pending count shown in Overview tab.
  - **Web dashboard** — Inbox section at `/inbox` (read-only list + detail); pending count in the snapshot header.
  - **Daily digest** — `inbox.pending` included in the dashboard snapshot for digest-ready consumption.

### Guardrails (M23)
- **PENDING NEVER AUTO-APPLIES.** `applyProposal` runs ONLY when `status === 'approved'` AND triggered by the explicit `inbox approve` command (confirm/`--yes`). Never on `createProposal`, never on list/show, never by any daemon or background process. This is structurally enforced — `applyProposal` checks all three conditions before touching anything.
- **Single outward funnel.** Every outward mutation in v2 (patch, PR, deploy) passes through `applyProposal`. There is no other path.
- **Patch on a new branch only.** `'patch'` kind applies to a new `ashlr/`-prefixed branch off HEAD via `git apply`. The user's working tree, current branch, and index are never touched. No `git reset --hard`, no checkout in the source repo, no push, no branch deletion of user branches.
- **PR via explicit gated path.** `'pr'` kind uses the M18 `createPr` which is itself confirm-gated and explicit — no auto-PR.
- **Enrollment + kill switch enforced on every apply.** `assertMayMutate` runs before any mutation; kill switch is checked first and cannot be bypassed.
- **No secrets in proposals.** `Proposal` fields and `~/.ashlr/inbox/` contain only metadata. No token values, env vars, prompt text, or secret names are ever written.
- No new runtime dependencies. All 2266 existing tests preserved. Typecheck passes clean (`tsc --noEmit`).

---

## [Unreleased] — M22: Work Discovery (`ashlr backlog`)

### Added
- **`ashlr backlog` — prioritized, scored work queue across enrolled repos** (`src/cli/backlog.ts`, `src/core/portfolio/backlog.ts`, `src/core/portfolio/scanners.ts`):
  - Aggregates open work items across all enrolled repos from six read-only sources: GitHub issues, TODO/FIXME/HACK/XXX code comments, CI/test state, outdated/vulnerable deps, docs health, and binshield security findings.
  - Each item is scored by `value / effort` heuristic (higher = do first) and persisted to `~/.ashlr/backlog.json`.
  - **`ashlr backlog`** — list the scored queue; flags: `--repo <path>` (single repo), `--source <issue|todo|test|dep|doc|security>` (filter by source), `--limit N` (top N), `--json` (machine-readable).
  - **`ashlr backlog refresh`** — re-scan all enrolled repos and rebuild the backlog.
- **Six read-only scanners** (`src/core/portfolio/scanners.ts`) — each returns `WorkItem[]`, bounded, never throws:
  - `scanIssues` — open GitHub issues via `gh` (M18 `listIssues`); skips repos without a GitHub remote.
  - `scanTodos` — TODO/FIXME/HACK/XXX comments in source via `rg`/`grep`; skips `node_modules/`, `.git/`, `dist/`; capped per-repo.
  - `scanTests` — CI state via `gh run list` (latest run); notes test-script presence heuristic; **never runs `npm test` or any project script**.
  - `scanDeps` — `npm outdated --json` (stale) + `npm audit --json` (vulnerability severity counts); bounded with timeouts; read-only metadata only.
  - `scanDocs` — heuristic checks: missing/thin README, missing LICENSE, missing CONTRIBUTING, low test-file presence.
  - `scanSecurity` — `binshield` findings if installed; skipped gracefully when absent.
- **Backlog engine** (`src/core/portfolio/backlog.ts`):
  - `buildBacklog(opts?)` — runs all scanners over `listEnrolled()` repos (default) or a provided subset; dedupes by id; sorts descending by score; persists to `~/.ashlr/backlog.json`.
  - `loadBacklog()` — reads the persisted backlog; returns `null` when absent.
  - `scoreItem(value, effort)` — pure `value/effort` heuristic, clamped, no side effects.
  - `backlogPath()` — `~/.ashlr/backlog.json`.
- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `WorkSource = 'issue' | 'todo' | 'test' | 'dep' | 'doc' | 'security'`
  - `WorkItem { id; repo; source; title; detail; value(1-5); effort(1-5); score; tags; ts }` — one scored work item.
  - `Backlog { generatedAt; repos; items }` — persisted backlog shape.

### Guardrails (M22)
- **READ-ONLY**: scanners never modify any repo — no writes, no git mutations, no installs, no fixes. All subprocess calls use `execFile` with explicit arg arrays (no shell injection).
- **ENROLLMENT-SCOPED**: only repos returned by `listEnrolled()` are scanned. Default enrollment is empty → empty backlog. The scanner never walks the disk outside enrolled paths.
- **Bounded**: all scanners skip `node_modules/`, `.git/`, `dist/`; per-repo caps on file count and output size; `npm outdated`/`npm audit` run with timeouts. No project scripts (`npm test`, `npm run build`, etc.) are ever executed.
- **Never throws**: every scanner catches all errors and returns `[]`; a failing scanner never aborts the rest of the backlog build.
- **No secrets**: `WorkItem` fields and `~/.ashlr/backlog.json` contain only metadata (title, detail, score, tags). No token values, env vars, or secret names are written.
- No new runtime dependencies. All 2202 existing tests preserved. Typecheck passes clean (`tsc --noEmit`).

---

## [Unreleased] — M21: Safety Foundation (Sandboxed Execution, Audit Trail, Enrollment + Kill Switch)

### Added
- **Git-worktree sandbox** (`src/core/sandbox/worktree.ts`) — the isolation primitive all future autonomous work runs inside:
  - `createSandbox(sourceRepo, opts?)` — asserts enrollment + kill-switch gate, then runs `git worktree add -b ashlr/sandbox/<id>` under `~/.ashlr/sandboxes/<id>/` off the current HEAD. The source repo's working tree, index, HEAD, and user branches are **never touched**.
  - `sandboxDiff(sb)` — returns `SandboxDiff { sandboxId, files, insertions, deletions, patch }` via `git diff` against `baseHead`. Read-only; never mutates.
  - `removeSandbox(sb)` — `git worktree remove --force` + `git branch -D` on the scratch branch. Idempotent; never touches the source tree. All sandbox paths are forced under `~/.ashlr/sandboxes/`.
  - `sandboxesDir()` / `listSandboxes()` — path helper + persisted metadata listing; never throws on bad entries.
- **Append-only audit trail** (`src/core/sandbox/audit.ts`):
  - `audit(entry)` — sets `ts`, appends one JSONL line to `~/.ashlr/audit/<YYYY-MM-DD>.jsonl`. Never truncates, rewrites, or deletes. Malformed lines are skipped on read; never throws.
  - `readAudit(limit?)` — returns entries newest-first; `limit` caps count.
  - `auditDir()` — `~/.ashlr/audit`. **No secrets ever written** — summary is metadata only.
- **Enrollment registry + kill switch** (`src/core/sandbox/policy.ts`) — the gate every autonomous mutation passes through:
  - `isEnrolled(repo)` / `enroll(repo)` / `unenroll(repo)` / `listEnrolled()` — registry persisted in `cfg.autonomy` / `~/.ashlr/enrollment.json`. **Default empty — nothing enrolled means nothing autonomous can mutate.**
  - `killSwitchOn()` / `setKill(on)` — kill switch backed by `~/.ashlr/KILL` file / cfg flag. When set, ALL sandbox-mutating ops refuse regardless of enrollment.
  - `assertMayMutate(repo, opts?)` — throws (and records `result:'refused'` in audit) if kill switch is on OR repo is not enrolled. The `allowAnyRepo` test hatch never overrides the kill switch.
- **CLI surface** (`src/cli/sandbox.ts`):
  - `ashlr sandbox list` — list active sandboxes.
  - `ashlr sandbox diff <id>` — show the diff accumulated inside a sandbox.
  - `ashlr sandbox cleanup <id>` — remove a sandbox (worktree + scratch branch).
  - `ashlr audit [N]` — tail the audit trail, newest-first, optional limit.
  - `ashlr enroll list` — show enrolled repos.
  - `ashlr enroll add <repo>` — enroll a repo for autonomous work.
  - `ashlr enroll remove <repo>` — unenroll a repo.
  - `ashlr enroll kill on|off` — set or clear the global kill switch.
- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `Sandbox { id; sourceRepo; worktreePath; branch; baseHead; createdAt }` — live sandbox descriptor.
  - `SandboxDiff { sandboxId; files; insertions; deletions; patch }` — diff of a sandbox vs its base HEAD.
  - `AuditEntry { ts; action; repo; sandboxId; summary; result:'ok'|'refused'|'error' }` — one audit record.
  - `Enrollment { repos }` — persisted enrollment registry shape.
  - `SwarmOptions.sandbox?:boolean` — seam for M24 daemon (OFF by default; swarm behavior today is unchanged).

### Guardrails (M21)
- **Isolation is absolute**: sandbox worktrees live ONLY under `~/.ashlr/sandboxes/`. Create and remove operations are structurally incapable of modifying the source repo's working tree, index, HEAD, or user branches. No `git reset --hard`, no checkout in source repo, no push, no user-branch deletion.
- **Enrollment default empty**: until you run `ashlr enroll add <repo>`, no real repo can be autonomously mutated — the gate throws before any worktree is created.
- **Kill switch**: `ashlr enroll kill on` sets `~/.ashlr/KILL`; every `assertMayMutate` call checks it first and refuses (audit `result:'refused'`). Cannot be bypassed by enrollment or the `allowAnyRepo` test hatch.
- **Audit is append-only**: no secret values, no prompt/completion content — metadata (action, repo, sandbox id, summary, result) only.
- **No new runtime deps**: node builtins + existing `core/git.ts` / `core/config.ts` / `cli/ui.ts` only.
- **Swarm seam is inert**: `SwarmOptions.sandbox` field plumbed; M12 swarm runner behaviour unchanged until M24 wires it.
- All 2110 existing tests preserved. Typecheck passes clean (`tsc --noEmit`).

---

## [Unreleased] — M20: One-Command Onboarding + Self-Healing (CAPSTONE)

### Added
- **`ashlr init` — complete, idempotent, NON-TTY-safe onboarding** (`src/core/onboard.ts`, updated `src/cli/doctor-init.ts`):
  - A single `ashlr init` (or `ashlr init --wire --yes`) takes a brand-new machine from zero to fully set-up. Re-runnable safely at any time — every step is idempotent.
  - Seven ordered steps: **config** (ensure `~/.ashlr/config.json` from defaults), **models** (detect Ollama / LM Studio and report — never auto-downloads), **editors** (detect Claude / Cursor / Codex; wire all when `--wire`), **symlink** (ensure `ashlr` → `~/.local/bin`), **genome** (seed empty genome dir), **phantom** (status report only), **doctor** (roll-up as final gate).
  - `--wire` — the only mutating optional step; wires every detected editor's MCP config (backup-first, idempotent, M18 pattern).
  - `--yes` (or non-TTY stdin) — accepts all defaults without interactive prompts; fully CI-safe.
  - `--json` — emits `OnboardResult { steps, ready, nextSteps }` for machine consumption.
  - Finishes with a crisp `you're set up — try: ashlr run / ashlr swarm / ashlr tui` next-steps summary.
  - **NEVER** auto-downloads models, modifies secrets, modifies shell profiles, or makes any network/outward call.
- **`ashlr doctor --fix` — self-healing doctor** (`src/core/doctor-fix.ts`, updated `src/cli/doctor-init.ts`):
  - Runs `runDoctor`, then applies one safe automated remediation per failing/warn check in the SAFE-FIXABLE set:
    - **`config`** — creates missing `~/.ashlr/config.json` from `defaultConfig()` + `saveConfig()`. Create-only; never overwrites an existing config.
    - **`index`** — rebuilds a stale/missing index via `buildIndex` + `writeIndex`. Non-destructive (regenerates derived data only).
    - **`local-bin`** — creates the `ashlr` → `~/.local/bin` symlink when missing and the source resolves. PATH is left as a `manual` action.
    - **`genome-memory`** — creates the genome directory when missing (mkdir-only; never seeds or edits entries).
    - **`mcp-plugin`** — registers the ashlr MCP gateway into a detected editor config via `wireEditor` (backup-first + idempotent, M18 pattern).
  - Every other failing check → `FixAction { applied:false, manual:true }` with a one-line guidance hint.
  - `--fix --json` emits `FixAction[]` for scripting; without `--json` prints a split **fixed** / **needs manual action** table.
  - Exits non-zero only when blocking failures remain after fixes.
  - **HARD GUARDRAILS**: NEVER deletes/overwrites user data, auto-downloads models, modifies secrets or shell profiles, or makes any outward/network call.
- **Bounded runtime self-heal** (`src/core/run/self-heal.ts`):
  - `withHeal<T>(fn, policy, onHeal)` — BOUNDED wrapper around any runtime operation (MCP downstream spawn, model call). Classifies failures and emits `HealEvent` via `onHeal` before a bounded retry:
    - `kind:'mcp-restart'` — restart a crashed MCP downstream; after `maxRestarts`, falls back to the existing M3 skip-on-failure behavior.
    - `kind:'model-downgrade'` — on local model OOM/error, downgrade to a SMALLER LOCAL model via `chooseRoute` (only when `policy.allowDowngrade`; NEVER escalates to cloud, NEVER increases cost).
    - `kind:'rate-backoff'` — exponential backoff on cloud rate-limit (ONLY when `allowCloud` is already set by the caller; never enables cloud on its own).
  - Reuses `withRetry` from `core/run/retry.ts` for the bounded loop and backoff — no reimplemented backoff logic.
  - Rethrows the last error on exhaustion or non-recoverable failure. Bounded by construction — `policy.maxRestarts` hard ceiling; no infinite loop.
  - `defaultHealPolicy()` — conservative default (`maxRestarts: 3, allowDowngrade: true`).
  - Opt-out: set `ASHLR_NO_HEAL=1` env var to bypass heal wrapping at any call site.
  - MCP gateway downstream spawn wrapped in `withHeal` (bounded restart → M3 skip-on-failure fallback).
  - Model call site wrapped in `withHeal` (local OOM → downgrade; cloud rate-limit → backoff — opt-out preserved).
- **New types in `src/core/types.ts`** (all existing types unchanged):
  - `FixAction { checkId; label; applied; detail; manual }` — result of one `fixDoctor` remediation attempt.
  - `OnboardStep { name; status:'ok'|'wired'|'detected'|'skipped'|'manual'; detail }` — one step of `onboard`.
  - `OnboardResult { steps; ready; nextSteps }` — full onboarding result; `--json` output shape of `ashlr init`.
  - `HealPolicy { maxRestarts; allowDowngrade }` — governs the self-heal loop; `allowDowngrade` enables local model downgrade only.
  - `HealEvent { kind:'mcp-restart'|'model-downgrade'|'rate-backoff'; detail; attempt }` — emitted by `withHeal` on each heal action.

### Changed
- `src/cli/doctor-init.ts` — `cmdInit` drives full onboarding via `onboard(cfg, {wire, yes})`; `cmdDoctor` accepts `--fix` → `fixDoctor` + split fixed/manual report. Existing flags and behavior preserved in all non-`--fix` paths.
- `src/core/mcp-gateway.ts` — downstream spawn/connect wrapped in `withHeal` (bounded restart, then M3 skip-on-failure). Opt-out via `ASHLR_NO_HEAL`.
- `src/core/run/router.ts` (model call site) — wrapped in `withHeal` for local OOM downgrade and cloud rate-limit backoff. M15 local-first + escalation gates unchanged.

### Guardrails (M20)
- **`ashlr init` is idempotent + NON-TTY-safe**: `--wire`/`--yes` gate the optional mutating steps; default is detect + report + safe ensures only.
- **`doctor --fix` is safe/local/non-destructive**: creates only (never overwrites), no auto-download, no secret access, no shell profile modification, no network calls. Editor-config writes are backup-first + idempotent (M18). Every fix is reversible-ish and logged.
- **Self-heal is BOUNDED**: hard `maxRestarts` ceiling; no infinite loop. Downgrade is always to a SMALLER LOCAL model; cloud backoff only when `allowCloud` already set by the caller.
- All 2026 existing tests preserved. No new runtime dependencies. M3/M11/M15/M18 semantics and tests unchanged.

---

## [Unreleased] — M19: Real Telemetry (OTLP) + Spend Governance

### Added
- **OTLP/HTTP-JSON trace emitter** (`src/core/observability/otlp.ts`):
  - `buildGenAiTrace(spans)` — builds a valid OTLP/HTTP-JSON payload (`resourceSpans → scopeSpans → spans`) with GenAI semantic-convention attributes only: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, a cost attribute, `ashlr.run.id`, `ashlr.provider`, `ashlr.tier`, span status, and `start/endTimeUnixNano`. **Metadata only — never prompts, completions, tool arguments, file contents, or secrets.**
  - `spansFromRun(run)` — produces one `GenAiSpan` per executed task from the `RunState` (usage, status, ids, provider, tier, duration). Pure, no I/O.
  - `spansFromSwarm(s)` — same, from a `SwarmRun`. Pure, no I/O.
- **TelemetrySink seam** (`src/core/observability/telemetry-sink.ts`) — the documented cloud-ready seam:
  - `TelemetrySink` interface: `emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult>`.
  - `LocalFileSink` (default) — appends spans and run summaries as JSONL to `~/.ashlr/telemetry/*.jsonl`; this is what `ashlr pulse` already aggregates locally. Active whenever no OTLP endpoint + PAT are configured.
  - `OtlpHttpSink` — active only when `cfg.telemetry.pulse` is set **and** a PAT is available. Calls `buildGenAiTrace` → POSTs to the endpoint with `Authorization: Bearer <PAT>` and `Content-Type: application/json`. Bounded timeout, fire-and-forget, never throws or blocks the run. PAT is placed only in the Authorization header — never logged, printed, stored in span attributes, or returned.
  - `getSink(cfg)` — returns `OtlpHttpSink` iff `cfg.telemetry.pulse && patAvailable(cfg)`, else `LocalFileSink`. **Default is 100% local.**
  - `patAvailable(cfg)` — returns a `boolean` only; prefers Phantom, falls back to `ASHLR_PULSE_TOKEN` env var; never returns, logs, or exposes the value.
  - `localTelemetryDir()` — returns `~/.ashlr/telemetry`.
- **Spend governance** (`src/core/observability/governance.ts`):
  - `evalGovernance(cfg)` — reuses `buildForecast` / `buildRollup` to compute actual spend vs `cfg.telemetry.budgetUsd` over `cfg.telemetry.budgetWindow`. Returns a `GovernanceStatus`: `ok` (< 80% of cap), `warn` (≥ 80%), or `over` (> cap). `capUsd: null` + `ok` when no cap is configured. Never throws.
  - `ashlr pulse` shows a governance summary line: `Governance: ok | ⚠ warn (82% of $50.00) | ✗ over ($52.10 of $50.00 / 30d)`.
  - `ashlr doctor` gains a "Spend governance" check (degrades to warn when no cap is set).
- **`ashlr telemetry` command** (`src/cli/telemetry.ts`):
  - `ashlr telemetry status` — prints whether an endpoint is configured (boolean), whether a PAT is available (boolean), the active sink (`local` or `otlp`), and a governance summary. **Never prints the endpoint URL value or PAT value.**
  - `ashlr telemetry test` — emits a best-effort synthetic metadata-only span via the configured sink and reports the `TelemetryEmitResult` (sink type, ok/fail, non-secret detail). Useful for verifying the pipeline without a real run.
- **New types in `src/core/types.ts`** (all existing types preserved):
  - `GenAiSpan { name; runId; model; provider; tier; tokensIn; tokensOut; estCostUsd; status; startTs; endTs }` — metadata only; no prompts, completions, tool args, file contents, or secrets.
  - `TelemetryEmitResult { sink: 'local' | 'otlp'; ok: boolean; detail: string }` — `detail` never holds a PAT or content.
  - `GovernanceStatus { level: 'ok' | 'warn' | 'over'; spentUsd: number; capUsd: number | null; window: string; message: string }`.
  - `cfg.telemetry.govAction?: 'warn' | 'block'` (default `'warn'`); existing `pulse?`, `budgetUsd?`, `budgetTokens?`, `budgetWindow?` fields unchanged.

### Changed
- **`src/core/run/orchestrator.ts`** — `runGoal` replaces the M9 bespoke `reportToPulse()` with `getSink(cfg).emit(spansFromRun(run))`. Called post-completion, fire-and-forget, never blocks or throws. Governance check (`evalGovernance`) runs before execution: `warn` prints a prominent advisory; `over` + `govAction === 'block'` requires `--over-budget` to proceed (never silently blocks; per-run hard budget remains the only hard ceiling).
- **`src/core/swarm/runner.ts`** — `runSwarm` replaces any prior pulse reporting with `getSink(cfg).emit(spansFromSwarm(s))`. Same post-completion, opt-in, best-effort semantics. Governance check runs before swarm start.
- **`ashlr pulse`** — extended with a governance summary line (`ok` / `warn` / `over`) derived from `evalGovernance`.
- **`ashlr doctor`** — extended with a "Spend governance" check.

### Guardrails (M19)
- **Opt-in + best-effort**: OTLP emission happens ONLY when `cfg.telemetry.pulse` is set AND a PAT is available. It is fire-and-forget, bounded timeout, NEVER blocks, slows, or throws during a run or swarm. Failures log to stderr only.
- **Local-first default**: when no endpoint + PAT are configured (the default), the `LocalFileSink` is active and all telemetry stays 100% local under `~/.ashlr/telemetry/`.
- **Metadata-only**: span attributes and JSONL records contain model, token counts, cost estimate, run/swarm id, provider, tier, status, and duration — never prompt/response text, tool arguments, file contents, or secret values.
- **PAT safety**: the PAT lives only in the `Authorization` header. It is never logged, printed, put in span attributes, returned by any function, or committed. `patAvailable()` returns a boolean; `ashlr telemetry status` shows boolean flags — never values.
- **Governance is advisory, not a silent blocker**: `warn` prints a visible message; `over` + `block` requires `--over-budget` (which the user must pass explicitly). The per-run hard `RunBudget` ceiling remains the only hard ceiling and is unchanged.
- **No new runtime dependencies**: OTLP POST uses Node.js `fetch` builtin (Node 22+). No third-party packages added.
- All 1899 existing tests preserved.

---

## [Unreleased] — M18: Deep Integrations

### Added
- **`ashlr gh` — GitHub read + guarded mutations** (`src/cli/gh.ts`, `src/core/integrations/github.ts`):
  - `ashlr gh pr` — list open PRs for the current repo (number, title, URL, state, author).
  - `ashlr gh issue` — list open issues (same fields).
  - `ashlr gh ci` — latest CI/checks status for HEAD (`passing` / `failing` / `pending` / `none`).
  - All reads go through the **`gh` CLI** (which owns auth) — no raw tokens are ever handled by the hub.
  - `ashlr gh pr create` — the only mutation; prints a confirm prompt before any `gh pr create` call; never runs automatically.
  - `githubStatus(cwd)` — read-only, never throws; degrades gracefully when cwd is not a git repo or `gh` is unavailable.
- **`ashlr vercel` — Vercel read-only surface** (`src/cli/vercel.ts`, `src/core/integrations/vercel.ts`):
  - `ashlr vercel ls` — recent deployments (URL, state, createdAt, target) via the **`vercel` CLI**.
  - `ashlr vercel logs` — tail logs for the latest deployment.
  - `vercelStatus(cwd)` — read-only, never throws; degrades gracefully when no project is linked.
  - Deploy actions remain in `ashlr ship --deploy vercel --confirm` (already gated); no new deploy paths added.
- **`ashlr wire` — editor auto-wire** (`src/cli/wire.ts`, `src/core/integrations/editors.ts`):
  - `ashlr wire [claude|codex|cursor|all]` — wire the ashlr MCP gateway (and note genome) into each target editor's MCP config. Defaults to all detected editors.
  - Reuses the M3 `mcp install` pattern: backup-first, deep-merge of `mcpServers`, idempotent, never clobbers, local-only. Accepts `configPath` for temp-safe test operation.
  - `detectEditors()` — returns the subset of `claude`/`codex`/`cursor` whose config directories are present.
  - `wireEditor(target, opts)` — returns `{ok, detail}`; the only file writes are to editor config dirs (or `opts.configPath` in tests).
- **Phantom identity in status + doctor** (`src/core/integrations/identity.ts`):
  - `getIdentity()` — reads `phantom cloud status` and `phantom team` (via the installed **`phantom` CLI**); surfaces `{loggedIn, user, tier, team}`. Returns names/status only — secret values are never read, printed, or logged. Never throws; degrades to `loggedIn: false` when phantom is absent or logged out.
  - `ashlr status` gains a "You: `<user>` · tier `<t>` · team `<team>`" identity line (suppressed when not logged in).
  - `ashlr doctor` gains an identity check that degrades gracefully (warn, not fail) when phantom is not available.
- **`ashlr notify` — opt-in completion notifications** (`src/cli/notify.ts`, `src/core/integrations/notify.ts`):
  - `ashlr notify test` — sends a test ping to configured webhooks (Slack and/or Discord). Strict no-op when no webhook is configured — no network call, no error.
  - `notify(text, cfg)` — posts a concise, secret-free run/swarm completion summary. Returns `false` with zero side-effects when `cfg.notify.slackWebhook` and `cfg.notify.discordWebhook` are both unset. Never posts without an explicitly configured webhook.
  - Config: `cfg.notify.slackWebhook` and/or `cfg.notify.discordWebhook` in `~/.ashlr/config.json`; both are optional; both unset = feature is completely dormant.
- **GitHub + Vercel one-liners in `ashlr status`**:
  - When cwd is a GitHub repo and `gh` is available: `GitHub: N open PRs · CI passing/failing`.
  - When a Vercel project is linked and `vercel` is available: `Vercel: <latest deploy state> <url>`.
  - Both lines are omitted when the respective CLI is absent or the repo/project is not linked.
- **New types in `src/core/types.ts`** (all existing types preserved):
  - `GithubStatus { isRepo: boolean; openPrs: number; openIssues: number; ci: 'passing'|'failing'|'pending'|'none'; repo: string|null }`
  - `VercelStatus { linked: boolean; latestState: string|null; url: string|null }`
  - `Identity { loggedIn: boolean; user: string|null; tier: string|null; team: string|null }`
  - `NotifyTarget { slackWebhook?: string; discordWebhook?: string }`
  - `AshlrConfig.notify?: NotifyTarget`
  - Supporting read-model types: `PrSummary`, `IssueSummary`, `CreatePrOpts`, `CreatePrResult`, `DeploySummary`.

### Changed
- `ashlr status` output extended with GitHub, Vercel, and identity lines (each omitted when the source is unavailable).
- `ashlr doctor` extended with an identity check for phantom cloud login (degrades to warn, not fail).
- Architecture table in `src/core/` updated: new `integrations/` subdirectory (`github.ts`, `vercel.ts`, `editors.ts`, `identity.ts`, `notify.ts`).

### Guardrails (M18)
- **Read-first, always.** All status/list/identity reads (`githubStatus`, `vercelStatus`, `getIdentity`) are safe, read-only, and never throw. They delegate to the installed CLIs (`gh`, `vercel`, `phantom`) — the hub never handles raw tokens.
- **Mutations are explicit, confirm-gated, never automatic.** `ashlr gh pr create` requires an explicit subcommand + confirm prompt. Notifications require a configured webhook. Deploy stays in `ashlr ship --confirm`. No other write or outward action is introduced.
- **Identity = names/status only.** `getIdentity` never reads, stores, or prints secret values. Phantom vault contents are never accessed; only `phantom cloud status` and `phantom team` output is parsed.
- **Editor-wire is backup-first + idempotent + local.** `wireEditor` never overwrites a config unconditionally; it deep-merges `mcpServers` and backs up the target file before any write. Tests use `configPath` for temp-file safety.
- **Notify is strictly opt-in.** `notify()` returns `false` immediately with zero network calls when no webhook is configured. No webhook = feature is completely dormant.
- **No new runtime dependencies.** All new modules use Node builtins and the existing `gh`/`vercel`/`phantom` CLIs already installed on the system.
- All 1745 existing tests preserved.

---

## [Unreleased] — M17: Verified Orchestration

### Added
- **Tamper-evident task signing** (`src/core/swarm/sign.ts`):
  - `signOutput(content, cfg)` — HMAC-SHA256 signs a task result (content hash + HMAC). Key source: Phantom best-effort, else a local key auto-generated once at `~/.ashlr/keys/swarm.key` (0600, `crypto.randomBytes`). Signature stored on `SwarmTaskRun.signature` (`OutputSignature { alg, hash, sig, signer, ts }`). Signature contains only hashes — no payload secrets, never logged.
  - `verifyOutput(content, sig, cfg)` — verifies a stored signature using `timingSafeEqual`; returns `boolean`; never throws.
  - `ensureLocalKey()` — returns the key path, creating the file at 0600 with 32 random bytes if absent. Key is never printed, logged, or committed.
- **Downstream signature verification** (`src/core/swarm/runner.ts`):
  - Before a task consumes a dependency's output, `runner.ts` calls `verifyOutput` on that dependency's stored signature. A mismatch (tampered or corrupted result) skips consumption and triggers an escalation gate rather than silently proceeding.
- **Exception-driven escalation gates** (`src/core/swarm/gate.ts`):
  - `riskScan(text)` — case-insensitive heuristic scan for destructive/outward operations: `rm -rf`, `git push --force`, `deploy`, SQL `DROP`, and secret-exfiltration patterns. Returns `{ risky: boolean; reason: string }`; never throws.
  - `shouldEscalate(ctx)` — pure function; priority order `tamper > verify-failed > over-budget > risk > low-confidence`. Returns the `EscalationReasonKind` that applies, or `null`. Only decides — the caller persists the `EscalationEvent`, sets `status: 'needs-approval'`, and **stops**. Never auto-approves.
  - Gate trip conditions: downstream verify failure, over-budget, low-confidence / failed `verifyTask` on a critical task, or a RISK heuristic match on a task goal or result.
- **Swarm pause + `ashlr swarm approve <id>`** (`src/cli/swarm.ts`):
  - When a gate trips, `runSwarm` persists the `EscalationEvent` (task id, kind, detail, timestamp) to the `SwarmRun`, sets `status: 'needs-approval'`, and halts. No work continues automatically.
  - `ashlr swarm approve <id>` — explicit human action; resumes a `needs-approval` swarm from where it stopped. Only valid when status is `needs-approval`; errors otherwise.
- **`ashlr swarm verify <id>`** (`src/cli/swarm.ts`):
  - Verifies all stored task signatures in a completed or paused swarm. Exit code 0 when every signature is valid; exit code 1 on any failure or if the swarm is not found. Safe to run at any time.
- **Rollback-aware snapshots** (`src/core/swarm/rollback.ts`):
  - `snapshotProject(project)` — read-only; records the project's git `HEAD` commit ref and a stash ref (`stashRef`) for any dirty working tree into `RollbackSnapshot`. Non-git dirs or `null` project → `isRepo: false`; never throws.
  - `rollbackTo(snap, { force })` — **caller must confirm before invoking** (CLI prompts or `--yes`). Refuses if `isRepo: false`, if the snapshot has no `head`, or if the tree is dirty without `--force`. Restores `HEAD` via `git reset --hard` and re-applies the stash if `stashRef` is set. **Never runs `git push --force`, never deletes branches, never force-resets without `force: true`.**
  - `RollbackSnapshot` stored on `SwarmRun.rollback` at swarm start (before any tasks run).
- **`ashlr swarm rollback <id> [--yes] [--force]`** (`src/cli/swarm.ts`):
  - Prints exactly what it will restore (project path, HEAD ref, stash ref) before doing anything.
  - Requires `--yes` (or interactive confirmation) to proceed — never automatic.
  - `--force` required to restore over a dirty working tree (without it, refuses and explains).
  - Refuses on a non-git project or detached/ambiguous HEAD state, with guidance.
  - This is the **only potentially-destructive operation** in M17; all other new paths are read-only or additive.
- **New types in `src/core/types.ts`** (all existing types preserved):
  - `OutputSignature { alg: 'hmac-sha256' | 'phantom'; hash: string; sig: string; signer: string; ts: string }` — hashes only, no secrets.
  - `EscalationReasonKind = 'verify-failed' | 'over-budget' | 'tamper' | 'risk' | 'low-confidence'`
  - `EscalationEvent { taskId: string | null; kind: EscalationReasonKind; detail: string; ts: string }`
  - `RollbackSnapshot { project: string | null; isRepo: boolean; head: string | null; dirty: boolean; stashRef: string | null; ts: string }`
  - `SwarmTaskRun.signature?: OutputSignature`
  - `SwarmRun.escalations?: EscalationEvent[]`, `SwarmRun.rollback?: RollbackSnapshot`
  - `SwarmRun.status` union extended with `'needs-approval'`.

### Changed
- `src/core/swarm/runner.ts`: `runSwarm` snapshots project state at start (before any tasks), signs each task output on completion, verifies dependency signatures before consumption, calls `shouldEscalate` / `riskScan` at each gate point, persists `EscalationEvent` and halts on a positive gate, calls `captureFromSwarm` on normal completion.
- `src/cli/swarm.ts`: three new subcommands (`verify`, `approve`, `rollback`) wired and documented; rollback confirm-gate enforced at the CLI layer.

### Guardrails (M17)
- **Rollback is the only destructive operation.** It requires `ashlr swarm rollback <id>` + an explicit `--yes` confirm (or interactive prompt). It never runs automatically. `--force` is required to reset over a dirty tree. No `git push --force`; no branch deletion; refuses on non-git dirs and detached HEAD.
- **Keys: 0600, never logged.** `~/.ashlr/keys/swarm.key` is created with `crypto.randomBytes`, `chmod 0600`, and is never printed, logged, or captured in any run artifact. Phantom secrets never expose values — signatures contain only derived hashes.
- **Escalation gates pause, never auto-approve.** A gate trip sets `status: 'needs-approval'` and stops; `ashlr swarm approve <id>` is the only path forward.
- **Recursion guard + hard budget intact.** `ASHLR_IN_SWARM` env guard and the global `RunBudget` ceiling are unchanged.
- **Zero new runtime dependencies.** All signing and hashing use `node:crypto` (Node builtin). No third-party packages added.
- All 1619 existing tests preserved.

---

## [Unreleased] — M16: Compounding Genome

### Added
- **Auto-capture from runs and swarms** (`src/core/genome/capture.ts`):
  - `captureFromRun(run, cfg)` and `captureFromSwarm(s, cfg)` — fire-and-forget hooks called on run/swarm completion. Append a structured `GenomeEntry` (goal, concise approach/outcome summary, tags for project/status/tool/engine, and result gist) to `~/.ashlr/genome/hub.jsonl` via `appendHubEntry`.
  - `summarizeForGenome({goal, result, tasks})` — pure, deterministic helper that produces a secret-free, hard-capped (~800 chars) summary suitable for storage. Captures metadata/summary only — never raw prompts, completions, tool arguments, file contents, or secrets.
  - Opt-out: set `cfg.genome.autoCapture: false` (default `true`) or pass `--no-capture` on `ashlr run` / `ashlr swarm`. Auto-capture is **dedupe-aware** and **never throws or blocks** — it fires in the background after completion.
- **`ashlr genome consolidate`** (`src/core/genome/consolidate.ts`):
  - `consolidateGenome(cfg)` — merges near-duplicate entries (same goal/project with high text overlap) into one canonical entry. Preserves full provenance: merged `count`, `firstSeen`/`lastSeen` timestamps, and a union of all tags. Returns a `ConsolidationResult { before, after, merged, backupPath }`.
  - **Writes a timestamped backup of `hub.jsonl` before any mutation.** Nothing is silently deleted; all content is preserved in the merged entry. Bounded: only touches the hub store.
- **`ashlr genome playbook "<goal>"`** (`src/core/genome/playbook.ts`):
  - `buildPlaybook(goal, cfg, opts?)` — recalls similar past entries and synthesises a concise "how we approached this before — what worked / what failed / cost" playbook using the **local provider only**. Falls back to a concatenated recall summary when synthesis is unavailable or over budget. Never throws.
  - `playbookText(p, maxChars)` — pure, hard-capped serialiser for injecting into agent prompts.
  - Used by `orchestrator.runGoal`: when `cfg.genome.playbookOnRun !== false` (and `--no-memory` is not set), the M7 raw-recall injection is upgraded to a synthesised playbook injected (bounded by char cap) into the planning context.
- **`ashlr genome export <file>`** (`src/core/genome/export.ts`):
  - `exportGenome(cfg, dest, format)` — dumps the full genome to a portable JSON or Markdown file. Read-only, never throws, no lock-in. Returns `{ok, count, path}`.
  - `format: 'json'` — newline-delimited array of `GenomeEntry` objects.
  - `format: 'md'` — human-readable Markdown with one section per entry.
- **New CLI subcommands in `ashlr genome`** (`src/cli/genome.ts`):
  - `ashlr genome --teach "<note>" [--project p] [--tags a,b]` — append a high-value manual note (tagged `teach`).
  - `ashlr genome consolidate` — dedupe and merge near-duplicate entries (backup-first).
  - `ashlr genome export <file> [--format json|md]` — portable export of the full genome.
  - `ashlr genome playbook "<goal>"` — synthesise and print a playbook for the given goal.
  - All existing `cmdRecall` / `cmdLearn` / `cmdGenome` (health) commands preserved unchanged.
- **New types in `src/core/types.ts`** (all existing types preserved):
  - `GenomeCapture { goal: string; project: string|null; summary: string; tags: string[]; outcome: 'done'|'aborted'|'failed'; source: 'run'|'swarm'|'teach' }`
  - `Playbook { goal: string; entries: RecallHit[]; synthesis: string }`
  - `ConsolidationResult { before: number; after: number; merged: number; backupPath: string }`
  - `cfg.genome.autoCapture?: boolean` (default `true`) and `cfg.genome.playbookOnRun?: boolean` (default `true`).

### Changed
- `src/core/run/orchestrator.ts`: `runGoal` calls `captureFromRun` on completion and injects `playbookText` into planning context (upgrading M7 raw-recall); honours `--no-capture` flag and `cfg.genome.autoCapture`.
- `src/core/swarm/runner.ts`: `runSwarm` calls `captureFromSwarm` on completion; honours `--no-capture`.
- `src/cli/run.ts` and `src/cli/swarm.ts`: `--no-capture` flag added; sets `cfg.genome.autoCapture = false` for that invocation only.

### Guardrails (M16)
- **Privacy**: auto-capture stores metadata/summary only. Raw prompts, completions, tool call arguments, and file contents are never written to the genome. `summarizeForGenome` is hard-capped at ~800 chars and is deterministic with no I/O.
- **No data loss**: `consolidateGenome` writes a timestamped backup before any mutation; merged entries retain all key content; the genome is append-only everywhere else; `exportGenome` is strictly read-only.
- **Local-only**: playbook synthesis uses the local provider only (best-effort); falls back to concatenated recall on failure or budget exhaustion; no cloud calls. Auto-capture fires in the background and never throws.
- **Non-blocking**: capture is fire-and-forget — it never delays a run result or swarm completion.
- All 1504 existing tests preserved.

---

## [Unreleased] — M15: Cost-Optimal Local-First Routing

### Added
- **Per-task model routing** (`src/core/run/router.ts`): `chooseRoute(taskGoal, cfg, opts)` picks the best available local model (Ollama / LM Studio) for every task according to `cfg.models.providerChain`. Optional `cfg.models.routing[]` rules match task goals by pattern and override the default model. Returns a `RouteDecision` with `{provider, model, tier, reason}` so the caller always knows exactly what was chosen and why.
  - **Local-first, hard-enforced**: cloud provider is selected only when `opts.allowCloud === true` AND `opts.lastReason !== 'none'` (an escalation reason is present) AND a cloud API key is actually available (`cloudKeyAvailable(provider)`). Any other combination stays local. No silent cloud spend is ever possible.
  - `cloudKeyAvailable(provider)`: reads the standard API-key env var for a provider; returns a boolean — never logs or leaks the value.
  - `wouldBeCloudCost(tokensIn, tokensOut)`: returns a clearly-labeled estimate of what the same token counts would have cost on the default cloud provider, for savings comparison only. Never used as a billing figure.
- **Auto-escalation on failure/latency** (integrated into `src/core/run/orchestrator.ts`):
  - When a task result is empty/errored, or `verifyTask` returns `!ok` (M11 verify loop), the orchestrator calls `chooseRoute` with `lastReason: 'task-failed'` / `'verify-failed'` for the retry pass.
  - When a task exceeds `cfg.models.escalate.latencyMs` (optional), the next attempt is routed with `lastReason: 'latency'`.
  - **Cloud escalation requires both `--allow-cloud` AND a present key.** Without both, the retry stays local or marks the task `needs-attention`. There is no automatic cloud fallback.
  - Escalation is a single routed retry — it ties into the existing M11 `withRetry` / `verifyTask` path; the global `RunBudget` ceiling is never lifted.
- **Cost attribution per provider** (orchestrator + `src/core/observability/rollup.ts`):
  - Each `RunTask` now records `provider` and `tier` from its `RouteDecision`.
  - Local tasks (tier `'local'`) contribute `$0.00` actual cost; cloud tasks carry real `estCostUsd`.
  - `buildRollup` aggregates actual spend by provider and separately computes a "would-have-been-cloud" estimate (via `wouldBeCloudCost`) for every local task — giving a concrete savings figure.
- **Cost forecasting** (`src/core/observability/forecast.ts`): `buildForecast(window, cfg)` returns a `CostForecast` with:
  - `spentUsd` — actual cost in the window (local = $0, cloud = real estimate).
  - `localSavingsUsd` — cloud-equivalent cost for tokens handled locally, clearly labeled as an estimate.
  - `projectedMonthlyUsd` — simple linear projection from the window rate.
  - All numbers are **estimates, labeled as such**; no precision is fabricated.
- **`ashlr pulse` savings + forecast line**: `ashlr pulse` now shows a savings/forecast line beneath its summary output:
  ```
  Local savings (est):  $X.XX   |   Cloud would-have-been: $Y.YY   |   Projected 30d: $Z.ZZ
  ```
  The line is printed only when at least one local task has run in the window; suppressed on `--json` (the `CostForecast` is merged into the JSON rollup instead).
- **`ashlr models` — local model management** (`src/cli/models.ts`, `src/core/run/model-manager.ts`):
  - `ashlr models` — list all local models from Ollama (`/api/tags`) and LM Studio (`/api/models`). Shows name, provider, approximate size label, and whether it is the currently active/default model per config.
  - `ashlr models pull <name>` — explicit Ollama pull. Prints a size warning and requires interactive confirmation (`y/yes`) before downloading. **Never invoked automatically** during a run, route, or any other command.
  - `ashlr models start` — best-effort attempt to start a locally installed Ollama daemon when it is installed but not responding. **Never invoked automatically**; bounded to the local Ollama process; never installs or downloads anything.
  - `ollamaInstalled()`: checks `PATH` for the `ollama` binary — no network call, no side effects.
- **New types** in `src/core/types.ts` (all existing types preserved):
  - `ModelTier = 'local' | 'cloud'`
  - `RouteDecision { provider: string; model: string; tier: ModelTier; reason: string }`
  - `RoutingRule { match: string; model: string }`
  - `EscalationReason = 'task-failed' | 'verify-failed' | 'latency' | 'none'`
  - `LocalModelInfo { provider: 'ollama' | 'lmstudio'; name: string; sizeLabel?: string; active: boolean }`
  - `CostForecast { window: string; spentUsd: number; localSavingsUsd: number; projectedMonthlyUsd: number }`
  - `cfg.models.routing?: RoutingRule[]` and `cfg.models.escalate?: { onFailure: boolean; latencyMs?: number }` config fields.

### Guardrails (M15)
- **Local-first, no silent cloud**: cloud is reachable only via `--allow-cloud` + a present API key + a non-`'none'` escalation reason. The default path is 100% local. Every run and swarm is still bounded by the hard `RunBudget` ceiling.
- **No auto-download**: `ollama pull` runs only on the explicit `ashlr models pull <name>` command (with a confirmation prompt). It is never called during a run, route, or escalation.
- **No auto-start**: `ashlr models start` is the only path that attempts to start a local Ollama process. It is never called automatically.
- **Estimates clearly labeled**: all savings and forecast numbers are estimates; no precision is fabricated; every cost label includes `(est)`.
- **No secrets logged**: `cloudKeyAvailable` returns a boolean only; key values never appear in logs, run state, or rollup output.
- **Zero new runtime dependencies**: `router.ts`, `model-manager.ts`, `forecast.ts`, and `cli/models.ts` use only Node builtins and existing hub modules (`provider-client`, `budget`, `rollup`, `ui`).
- All 1396 existing tests preserved.

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


---

## Milestone Roadmap — M1 through M20 (COMPLETE)

The full M1–M20 roadmap is now complete. Every milestone shipped, all 2026 tests green.

| Milestone | Theme | Status |
|---|---|---|
| M1 | Foundation — index, navigate, config, Raycast | COMPLETE |
| M2 | Identity and model awareness — `ashlr doctor`, `ashlr init`, provider probing | COMPLETE |
| M3 | MCP aggregation gateway — single stdio entry point, namespaced tools | COMPLETE |
| M4 | Agent orchestrator — `ashlr run`, parallel DAG, budget, local-first | COMPLETE |
| M5 | Observability — `ashlr pulse`, metadata-only usage rollup, budget alerts | COMPLETE |
| M6 | Project lifecycle — `ashlr new`, `ashlr ship`, templates, deploy gate | COMPLETE |
| M7 | Shared memory / genome — `ashlr learn`, `ashlr recall`, cross-project store | COMPLETE |
| M8 | _(internal polish / test infrastructure)_ | COMPLETE |
| M9 | Hardening, CI, and polish — self-update, 932-test milestone, P0 fixes | COMPLETE |
| M10 | Ecosystem cohesion — config→env bridge, unified config projection across all tools | COMPLETE |
| M11 | Watchable, robust runs — streaming, retry+verify loop, hardened engine delegation | COMPLETE |
| M12 | Spec-driven swarms — `ashlr spec`, `ashlr swarm`, phase fan-out, resumable | COMPLETE |
| M13 | Surfaces I — interactive TUI (`ashlr tui`), real-time Raycast extension | COMPLETE |
| M14 | Surfaces II — local web dashboard (`ashlr serve`), SSE live updates, security posture | COMPLETE |
| M15 | Cost-optimal local-first routing — per-task model routing, savings forecast, `ashlr models` | COMPLETE |
| M16 | Compounding genome — auto-capture, consolidation, playbook synthesis, export | COMPLETE |
| M17 | Verified orchestration — tamper-evident signing, escalation gates, safe rollback | COMPLETE |
| M18 | Deep integrations — GitHub, Vercel, editor auto-wire, Phantom identity, notifications | COMPLETE |
| M19 | Real telemetry (OTLP) + spend governance — GenAI semantic conventions, `TelemetrySink`, `ashlr telemetry` | COMPLETE |
| M20 | One-command onboarding + self-healing — `ashlr init` capstone, `doctor --fix`, bounded runtime heal | COMPLETE |

The command surface is complete. From M1 through M20, `ashlr` grew from a local project navigator into a full agentic engineering platform — local-first, private by construction, and now trivial to adopt and self-healing in production.
