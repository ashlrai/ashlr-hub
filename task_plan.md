# Task Plan: Ashlr Autonomous Fleet Ambition Push

## Goal
Identify and execute the highest-leverage work that makes Ashlr Hub and its surrounding tool ecosystem more useful as a 24/7 autonomous self-improving engineering fleet.

## Phases
- [x] Phase 1: Confirm repo/GitHub/session state
- [x] Phase 2: Parallel multi-agent ecosystem audit
- [x] Phase 3: Synthesize an ambitious product/architecture roadmap
- [x] Phase 4: Execute high-leverage improvements now
- [x] Phase 5: Verify, commit, push, and leave resumable next steps
- [x] Follow-up: Implement same-machine daemon singleton lock
- [x] Follow-up: Fix Mission Control auto-merge visibility and GPT-5/Codex judge attestation signing
- [x] Follow-up: Final verification and push singleton hardening
- [x] Follow-up: Add shared queue lease renewal and dry-run claim release
- [x] Follow-up: Verify and push next functionality hardening batch
- [x] Follow-up: Add Mission Control pause/resume controls
- [x] Follow-up: Implement spend persistence fail-closed path
- [x] Follow-up: Explore queue health metrics for Mission Control
- [x] Follow-up: Explore backend assignment traces for Mission Control
- [x] Follow-up: Explore ecosystem doctor implementation scope
- [x] Follow-up: Verify, commit, and push spend persistence batch
- [x] Follow-up: Implement shared queue health in Fleet/Mission Control
- [x] Follow-up: Explore state repair UX for fail-closed ledger blocks
- [x] Follow-up: Explore persisted backend assignment traces implementation
- [x] Follow-up: Explore ecosystem doctor command implementation
- [x] Follow-up: Evaluate dependency security migration path
- [x] Follow-up: Verify, commit, and push next usefulness batch
- [x] Follow-up: Add autonomy evidence packs and policy verdicts
- [x] Follow-up: Expose autonomy evidence and harden judge ordering
- [x] Follow-up: Add causal proposal IDs, guard health, outcome records, and ecosystem doctor
- [x] Follow-up: Make outcome feedback item-accurate
- [x] Follow-up: Add cheap auto-merge readiness preflight
- [x] Follow-up: Add verify-before-judge and reusable verification metadata
- [x] Follow-up: Add resource-aware autonomous direction loop
- [x] Follow-up: Surface autonomous direction in always-on status surfaces
- [x] Follow-up: Resolve or explain GitHub Dependabot alert mismatch
- [x] Follow-up: Add next autonomous control-plane execution improvement
- [x] Follow-up: Clear nested Raycast audit vulnerabilities
- [x] Follow-up: Repair nested Raycast local lint
- [x] Follow-up: Harden executable autonomy control observability and local-only routing
- [x] Follow-up: Persist daemon backend assignment traces
- [x] Follow-up: Add daemon simulation awareness and bounded ready-evidence autonomy input
- [x] Follow-up: Surface auto-merge maintenance resource estimates and caps
- [x] Follow-up: Repair daemon launchd liveness, status read-only behavior, sandbox/engine cwd normalization, active guard health, and manager auto-merge bounds
- [x] Follow-up: Surface auto-merge preflight blockers, top queue work, and stale live-owner spend guards in fleet status
- [x] Follow-up: Make Foundry autonomy control executable by default when configured
- [x] Follow-up: Pre-scan executable direction and hide stale unenrolled backlog from status
- [x] Follow-up: Surface effective autonomy control mode in CLI/API/Mission Control
- [x] Follow-up: Reload full daemon config live and surface backend resource availability
- [x] Follow-up: Add auto-merge gate explanations, effective config visibility, and protected remote PR handoff
- [x] Follow-up: Bind verification to merge base, fail-close optional safety checks, finish live daemon reload, and harden unknown resource handling
- [x] Follow-up: Add Mission Control service recovery, resource-aware judge throttling, and queued autonomy work survival
- [x] Follow-up: Enroll all local dev-tools repos and surface repo coverage in fleet status
- [x] Follow-up: Prioritize the core fleet spine inside the ecosystem map
- [x] Follow-up: Make the autonomous loop obey core fleet focus under scarce resources
- [x] Follow-up: Add explicit resource overrides for vendor lockouts the local sensors cannot infer
- [x] Follow-up: Drain permanently failed verification proposals out of verify-only deadlock
- [x] Follow-up: Harden daemon liveness heartbeat, service cadence, and auto-provider lockout sensing
- [x] Follow-up: Bound daemon verification child process trees with a watchdog runner
- [x] Follow-up: Research NVIDIA LocateAnything and add safe visual-grounding foundation
- [x] Follow-up: Add deterministic judge-free evidence trust basis for auto-merge
- [x] Follow-up: Make proposal production high-yield enough to feed judge-free auto-merge
- [x] Follow-up: Sandbox-wrap ashlrcode executor, pass routed models, and block self-heal infra false positives
- [x] Follow-up: Add cap-aware route-preserving dispatch
- [x] Follow-up: Add durable dispatch-production ledger and judge-free default maintenance
- [x] Follow-up: Feed dispatch-production yield into routing/status surfaces and final backend guards
- [x] Follow-up: Repair live dead-owner spend guard and filter noisy self-heal backlog
- [ ] Follow-up: Set valid Raycast author account for publish validation

## Key Questions
1. What prevents Ashlr Hub from acting as a reliable always-on engineering fleet today?
2. Which surrounding Ashlr repos are key infrastructure versus abandoned experiments?
3. What should be built into Mission Control so the system feels operationally useful every day?
4. What risks would make 24/7 autonomy dangerous, expensive, noisy, or untrustworthy?
5. What can be improved immediately in this repo without destabilizing the pushed baseline?
6. How can Ashlr continuously choose the highest-value safe work without Mason as the bottleneck?
7. How can Ashlr spend scarce judge/frontier/model resources only after cheap facts say a candidate is mergeable?

## Decisions Made
- Use multiple agents because the user explicitly asked for broad parallel exploration and maximum ambition.
- Keep current hub `master` clean and synced as baseline; new work should be incremental and verified before pushing.
- Audit the ecosystem from local repos first, then use GitHub/official docs only where current external state matters.
- Bound the CI/publish test gate with a hermetic wrapper instead of letting leaked handles freeze autonomous delivery indefinitely.
- Land small operational patches now: service restart delay and inbox review fields.
- Land daemon singleton hardening now: exclusive lock, heartbeat, stale dead-owner takeover, token-checked release, and state temp-file collision reduction.
- Clear Vite/esbuild advisories with a conservative Vitest 3 + Vite 6 override migration instead of jumping straight to Vitest 4 / Vite 8.
- Next local critical path is shared queue health in Mission Control because a multi-machine autonomous fleet needs visible lease, reclaim, and owner distribution signals.
- Current autonomy critical path is making auto-merge evidence explicit and durable so higher-quality agents can merge by default without forcing Mason to reconstruct safety from logs.
- Evidence visibility should ride on `FleetStatus` so API, CLI, Mission Control, and Fleet Dashboard all share one read-only autonomy signal.
- Next autonomy control path is to turn causal proposal IDs and outcome records into active policy: item-accurate learning, cheap readiness checks before judge calls, bounded verification before review, and resource-aware mission choice.
- Current next path is to make autonomous direction visible where operators and agents already look, then close the GitHub security-alert mismatch so the default branch health signal is trustworthy.
- GitHub Dependabot alert mismatch resolved: alerts #1 and #2 were stale Vite `<=6.4.2` findings; `package-lock.json` resolves Vite to `6.4.3`, local audit is clean, and both alerts were dismissed as inaccurate.
- Fleet status now surfaces a lightweight `autonomyDirection` summary, so `/api/fleet`, CLI status, and web control JSON expose the current autonomous operating mode without running a full ecosystem doctor.
- Idle daemon ticks now run the gated auto-merge maintenance pass before returning `no-backlog`, closing a 24/7 drain dead-zone where pending verified proposals could wait for unrelated fresh backlog.
- Nested Raycast audit now passes after scoped overrides for patched `esbuild` and `minimatch`; `ray lint` still has separate packaging/config blockers (`author` 404 and ignored `src/**`).
- `foundry.autonomyControlLoop` is the first opt-in executable direction mode: daemon ticks consume the resource strategy report, pause/verify-only modes suppress new proposal generation, and local-only clamps dispatch to local/builtin paths.
- Nested Raycast local lint now has its own flat ESLint config and `npm run lint` no longer inherits the root `src/raycast/**` ignore. Raycast publish validation still requires replacing `author: "masonwyatt"` with a real Raycast username.
- Daemon autonomy control now uses cheap daemon-tick resource-strategy dependencies, including a lightweight fleet snapshot, lightweight ecosystem report, and empty outcome records, so opt-in direction checks avoid expensive full status/doctor/outcome joins.
- Daemon autonomy control now reads bounded ready-evidence outcome records only when auto-merge is enabled, making `auto-merge-ready` reachable from recent pending main-merge evidence without paying for the full outcome-record join on every tick.
- Local-only autonomy mode now preserves the first-class `local-coder` backend instead of collapsing it to `builtin`, keeping the free local coding workhorse available when frontier resources are constrained.
- Daemon ticks, Mission Control logs, and Fleet Activity now show applied direction reason and auto-merge maintenance attempted/judged/merged counts; Mission Control distinguishes the active applied mode from the current recommended direction.
- Daemon ticks now persist bounded per-item dispatch assignment traces with item, repo, backend, tier, model, assignment reason, dispatched/skipped state, and spend. Mission Control logs and Fleet Activity expose the same metadata without adding a new endpoint or heavyweight panel.
- Daemon dry-run/simulation ticks now carry a canonical `dryRun` marker through persisted tick records, Mission Control logs, and Fleet Activity payloads, so no-op rehearsals are visible instead of inferred from `reason` alone.
- Auto-merge maintenance now surfaces configured judge/verification caps, cap-hit counts, verification-before-judge runs, archive/TTL drains, and display-only judge spend estimates in daemon ticks, Mission Control logs, and Fleet Activity maintenance chips.
- Do not debit display-only judge estimates into `todaySpentUsd` until `judgeProposal` exposes measured tokens/cost; fake budget precision is worse than an explicit estimate.
- `fleet status` must never run full backlog refresh, goal expansion, or generative strategy work; it now reads only the last persisted backlog snapshot while the daemon/backlog CLI own refresh.
- Plugin and scanner output must never be trusted for `WorkItem.repo`; backlog normalization now coerces every item back to the enrolled repo root scanned, and plugin wrappers force the same contract.
- Manager `wouldMerge` is advisory but must mirror configured auto-merge risk/file/line bounds so Gate 7 does not block proposals that the real merge gate is configured to allow.
- The installed `ai.ashlr.daemon` launch agent was stale and ran `ashlr loop --watch`; reinstalling from the repo generator now runs `node bin/ashlr daemon start --budget 5 --interval 1800000 --parallel 1`.
- Foundry autonomy control should be executable by default when a `foundry` block exists. Advisory-only behavior is still available with `foundry.autonomyControlLoop=false`, but a self-improving fleet must obey its own resource-direction loop without requiring a hidden opt-in.
- Executable resource direction must run before expensive backlog/scanner/planner refresh. When the fleet is in pause/verify-only, it should spend the tick on safety/verification/merge drain, not on generating or refreshing more candidate work.
- `fleet status` should never treat stale persisted backlog from missing or unenrolled repos as live work. Read-only status can use cached snapshots, but must filter visibility to enrolled existing repos.
- Effective autonomy authority must be explicit in operator surfaces. `disabled`, `advisory`, and `executable` mean materially different risk/control postures and should not be inferred from a hidden boolean.
- Running daemons must reload full config, not just `daemon`, so Foundry policy, auto-merge settings, backend caps, and routing controls can change without service restarts.
- Backend status should show resource availability for every allowed backend, including `not-sensed` for allowed engines without a resource sensor.
- Auto-merge must be explainable from cheap read-only evidence before spending judge/verify resources. `explainAutoMergeGate()` now shares the pure gate logic for authority, provenance, risk, scope, verification evidence, self-target policy, and manager-gate evidence.
- Effective operator config should be visible without dumping secrets or mutating config files. `ashlr config effective`, `/api/config/effective`, and the exported core API expose curated autonomy/daemon/foundry/backend settings with source labels.
- Remote auto-merge must never bypass host branch protection. The GitHub path now opens a PR and attempts ordinary host auto-merge (`gh pr merge --auto --squash`) without privileged bypass, records the remote handoff as applied to prevent duplicate PR spam, and reports `merged=false` unless Ashlr can prove the host actually merged it.
- Verification and merge must be bound to the same base commit. `verifyProposal()` now records `baseBranch`/`baseHead`, persisted verify results carry that binding, and auto-merge refuses or reverifies when the default branch moved or legacy cached verification lacks a base.
- Optional safety layers must fail closed when explicitly enabled. Red-team, blast-radius, and spec-contract checks now skip/refuse proposals on thrown or malformed results and expose the blocker in both skipped/results.
- Live daemon config reload must include loop behavior, not only tick inputs. The non-once loop now rereads mode, budget, interval, and idle backoff around every iteration so batch/continuous behavior and sleep intervals can change without a restart.
- Unknown resource availability is not capacity. Concurrent dispatch gives `unknown` zero slots, and resource-aware gateway demotes unknown current backends to sensed open/near alternatives instead of treating missing signals as healthy.
- Mission Control should show OS service health separately from daemon process state. `/api/daemon/service` gives fresh read-only service health, while `/api/control` uses cached service status so frequent dashboard polling does not synchronously probe launchd/systemd/schtasks every refresh.
- Token-gated service repair should reinstall/reload the configured OS service definition instead of starting daemon work inside the web process. It uses the same `--allow-dispatch` plus session-token gate as fleet pause/resume.
- Resource-aware judge selection should preserve constrained Claude headroom. Cached `throttled`, `exhausted`, or `unreachable` Claude availability now falls to Codex/local for judging when available.
- Self-heal and invent work must survive backlog refresh. `scanQueuedAutonomyWork()` rehydrates queued self-heal items and durable `source:'invent'` backlog items into normal daemon selection.
- Fleet status needs repo coverage, not just item counts. The local ecosystem now has 21 enrolled dev-tools repos; `fleet status` should show how many enrolled repos have live backlog, how many are silent, and which repos dominate the queue.
- The next autonomy bottleneck is fairness and health-aware routing: a 21-repo fleet with 10 active backlog repos but 19 hub items still behaves too much like a hub-centered daemon unless shared queue filling and repo-health inventory guide selection.
- The ecosystem should not allocate equal attention to all 21 repos. The core fleet spine is `ashlr-hub`, `phantom-secrets`, `ashlr-plugin`, `binshield`, `ashlr-md`, `ashlr-stack`, `ashlr-pulse`, `ashlrcode`, and `ashlr-workbench`; `ashlr-mux` is tracked as a core-adjacent cofounder-owned candidate until it is available locally or through GitHub.
- Strategic focus must affect behavior, not only docs. Core-fleet repos now receive a gentle backlog score boost, daemon round-robin starts with higher-strategic-tier repos when tick capacity is scarce, and fleet/Mission Control status surfaces backlog pressure by strategic tier.
- Claude scarcity should not freeze the loop when Codex/NIM/local are available. Resource-aware paths already demote exhausted Claude; the simple conductor now also reroutes away from `throttled` Claude to open fallbacks such as Codex.
- Some provider lockouts are not fully inferable from local transcript telemetry. The ResourceMonitor now accepts expiring `foundry.resourceOverrides` so an operator-known lockout can become a real dispatch signal until its reset time instead of living only in chat context.
- Known failed verification is a permanent no-merge condition, but it should not freeze the fleet forever. Auto-merge maintenance now drains those proposals to `rejected` after the existing stuck threshold, and direction reports ignore terminal failures.

## Errors Encountered
- Entire is not set up for this repo; `entire resume master` has no checkpoint.
- Full serial Vitest can hang after many tests with one worker alive; mitigated with `scripts/test-ci.mjs` watchdog for CI/publish gates.
- Full CI initially exposed two stale auto-merge test expectations: default tier frontier proposals no longer get a pass-level judge, and evidence-mode explainer fixtures now need a diff-bound verification hash. Updated tests and reran affected suites plus full CI.

## Agent Findings From Follow-Up Audit
- Shared queue leases are not renewed during long runs; dry-run shared claims should release immediately.
- Concurrent dispatch plans currently do not force the assigned backend all the way through execution.
- `resource-pause:` decisions need daemon-level skip handling beside `throttled:` and `budget-pause:`.
- Codex/GPT-5 judge attestation should use one shared frontier-judge predicate in auto-merge and inline merge paths.
- Mission Control's auto-merge feed should include `inbox:auto-merge` audit events, not only `merge.*` actions.
- Current pass landed shared queue lease renewal, dry-run claim release, concurrent-dispatch backend assignment enforcement, `resource-pause:` skip handling, and CI isolation hardening for leaked `ASHLR_HOME`/date/auth assumptions.
- Current usefulness batch landed Mission Control/Fleet/Fleet Dashboard pause-resume controls, token-gated pause/resume APIs, a conservative Vitest 3/Vite 6 security migration, and a plugin-registry import fallback for Vitest 3's module runner.
- Current pass agents identified next lanes: spend persistence fail-closed dispatch guards, queue lease/reclaim metrics, backend assignment traces, and an `ashlr ecosystem doctor` inventory command.
- Current pass landed strict daemon state reads, result-returning daemon state saves, a durable spend-commit guard, and daemon/run-loop fail-closed behavior for malformed/unwritable spend state.
- Current pass agents refined next lanes: additive `FleetStatus.queue.shared` health, persisted daemon backend assignment traces, and a read-only `ashlr ecosystem doctor --json --root --deep`.
- Current queue-health pass adds read-only shared queue lease/cooldown/lock health to `FleetStatus`, CLI status/watch, Mission Control, Fleet, and Fleet Dashboard snapshots.
- Repair UX audit found that `daemon status`, doctor, and web surfaces still mask malformed daemon/spend-guard state through forgiving loaders; next pass should expose a shared additive guard-health block before attempting auto-repair.
- Backend trace audit found gateway decisions already have traces but daemon ticks persist only aggregate backend counts; next pass should persist bounded `backendAssignments` beside existing tick counts.
- Ecosystem doctor audit recommends a read-only `ashlr ecosystem doctor [--json] [--root] [--deep]` command with tool inventory and sibling repo health.
- Current autonomy pass adds `~/.ashlr/evidence/<proposalId>.json` evidence packs, a pure `AutonomyPolicyVerdict` ladder, and a pre-mutation Gate 8 in `autoMergeProposal` that fails closed if the evidence pack cannot be persisted or the policy denies the requested action.
- Current visibility pass adds evidence pack read/list helpers, surfaces autonomy evidence in `FleetStatus`, CLI status/watch, `/api/fleet`, `/api/control`, `/api/snapshot`, Mission Control, Fleet, Fleet Dashboard, and read-only `/api/autonomy/evidence` endpoints.
- Current trust fix makes the newest judged decision authoritative in the verification gate, so a newer non-ship verdict overrides any older signed `ship`.
- Current autonomy learning foundation pass added `workItemId`, `workSource`, and `runId` on proposals across daemon/swarm/best-of-N/sandboxed runs; guard-health diagnosis in daemon/fleet status; read-only outcome records; and read-only ecosystem doctor.
- Current autonomy control pass makes outcome feedback item-accurate, skips permanent auto-merge blockers before judge calls, verifies before spending judge calls in verification mode, and adds a read-only resource-aware direction report.
- Current dispatch-trace pass persists bounded daemon dispatch assignment metadata and surfaces it in existing control logs and Fleet Activity tick streams.
- Current pass adds canonical daemon dry-run awareness and a cheap ready-evidence reader so autonomy direction can see pending main-merge evidence when auto-merge is enabled.
- Current pass adds maintenance resource/cap visibility for auto-merge judge and verify-before-judge work while preserving existing merge and budget behavior.
- Current liveness pass found the daemon was installed but stopped, status could misreport a cleanly exited launchd job as running, `fleet status` could trigger backlog/goal-planner side effects, plugin scanners and engine adapter callers could smuggle file paths into execution cwd, active spend guards were reported as stale blocks, and manager `wouldMerge` used stale hard-coded caps.
- Current liveness pass repairs those issues, enrolls `ashlr-hub`, reinstalls the daemon service from the generated plist, and verifies launchd is running the real `daemon start` command.
- Current observability pass adds read-only `autoMergeReadiness` to `FleetStatus`, renders auto-merge preflight blockers in CLI status, adds top persisted backlog work under `queue.next`, and marks a live daemon spend guard as blocked when the owning daemon lock heartbeat is stale.
- Current executable-control pass makes `foundry.autonomyControlLoop` default on whenever Foundry is configured, keeps explicit `false` as advisory-only, updates Mission Control control JSON to report the effective default, and verifies daemon ticks suppress new work in `verify-only` mode by default.
- Agent audits identified next high-leverage lanes: expose executable/advisory/disabled control mode explicitly, add effective config visibility, show resource availability in backend status, explain hidden stale backlog counts, make direction report basis visible, enforce exact judge/verify cost accounting, bind verification to the same base tree as merge, and replace readiness approximation with a shared dry-run gate explainer.
- Current pre-scan direction pass moves daemon resource planning ahead of `buildBacklog()`, uses cached enrolled backlog counts for the lightweight direction snapshot, filters `FleetStatus.queue` to enrolled existing repos, and updates the self-target auto-merge gate test so `allowSelfMerge=true` is explicit.
- Current control-mode pass adds a single effective `autonomyControlMode` resolver and surfaces it in `FleetStatus`, `/api/fleet`, `ControlDaemon`, `/api/control`, CLI fleet status, and Mission Control hero/detail UI while preserving the legacy `autonomyControlLoop` boolean.
- Current live-config/resource pass makes `runDaemon` reload the complete config before every tick in once/continuous/batch modes, adds regression coverage for live Foundry policy reloads, and extends backend status/API/CLI with resource availability including `not-sensed` for allowed unsensed backends.

## Status
**Current batch complete** - Implemented the Ashlr Hub Autonomous Fleet Plan foundation: proposal factory, repo verification contracts, causal learning telemetry, evidence-bound judge-free auto-merge, Fleet OS readiness, and production velocity controls on branch `codex/autonomous-fleet-foundation`.

## Current Continuation - Fleet Usefulness And Hard Questions
- [x] Rechecked git status, recent commits, Entire state, task plan, notes, and live fleet summary.
- [x] Deployed parallel scouts for FleetStatus/readiness, proposal production, causal learning, and product strategy questions.
- [x] Implement the highest-leverage usefulness slice from live state.
- [x] Add focused regression coverage.
- [x] Run verification, commit, push, and verify fleet state.

## Current Continuation - Autonomous Fleet Foundation
- [x] Rechecked git status, recent commits, Entire state, task plan, notes, and autonomy plan.
- [x] Deploy parallel agents across verification, telemetry, auto-merge safety, Fleet OS, and velocity lanes.
- [x] Implement proposal-production critical-path fixes locally.
- [x] Integrate agent patches for verification contracts, learning graph, evidence preflight, Fleet OS readiness, and velocity controls.
- [x] Add focused regression coverage for proposal-disabled cooldown, verify manifests, evidence mode safety, telemetry causality, and status/UI readiness.
- [x] Run focused and broad verification gates.
- [x] Commit, push, and leave daemon/fleet state verified.

## Current Continuation - Visual Grounding Foundation
- [x] Rechecked git status, recent commits, Entire state, daemon status, task plan, notes, and relevant code.
- [x] Deployed parallel agents for LocateAnything model/release/license, Ashlr integration architecture, product strategy, and competitive/open-source landscape.
- [x] Verified primary NVIDIA sources: LocateAnything project page, NVlabs/Eagle, and Hugging Face model/license.
- [x] Decided to treat LocateAnything as an optional research backend because released weights are non-commercial/research-use, while building a provider-neutral Ashlr visual grounding layer.
- [x] Added `foundry.visualGrounding` config shape with explicit endpoint, license, and remote-upload gates.
- [x] Added `src/core/visual/grounding.ts` with normalized box parsing, local image metadata, OpenAI-compatible local worker support, and fail-closed provider guards.
- [x] Added focused parser/config/provider tests and a visual grounding roadmap doc.
- [x] Run focused/full verification.
- [x] Commit, push, and verify live daemon health.

## Current Continuation - Execution Profiles And Routing Truth
- [x] Rechecked git, Entire, task plan, notes, daemon status, and fleet status.
- [x] Deployed parallel explorer agents for repo execution profiles, local-coder resource sensing, swarm gate parity, Best-of-N routing, and sibling repo verify inventory.
- [x] Paused the live daemon/fleet for the maintenance window before edits.
- [x] Added a shared read-only repo execution profile layer for Node/Bun/pnpm/yarn, Cargo/Rust, Make/Just, Bats, nested package roots, and package-manager precedence.
- [x] Routed `detectVerifyCommands()` through the profile layer and taught verification runners to execute nested project commands from their project cwd.
- [x] Surfaced repo execution-profile coverage in fleet status so operators can see verify-command coverage and detected toolchains.
- [x] Made `local-coder` a sensed Ollama-backed resource state instead of `not-sensed`, and added it to resource-aware demotion before builtin.
- [x] Made Best-of-N honor daemon-assigned backend/model and judge/taste the persisted proposal diff instead of sandbox stdout when available.
- [x] Focused verification passed: typecheck plus 276 tests across verify/profile/status/self-heal/resource/Best-of-N/daemon suites.
- [x] Hardened profile discovery against symlinked directories, preserved hoisted workspace `node_modules/.bin`, and shared daemon/verification tool PATHs for Cargo, Bun, Homebrew, local user bins, and system bins.
- [x] Kept builtin as an always-open fallback, keyed resource snapshot caching by config/resource inputs, and added regression coverage for local-coder sensing after builtin-only snapshots.
- [x] Fixed the production-panel UTC fixture so "today" tests use the current ISO day instead of crossing UTC midnight with `now - 30m`.
- [x] Agent audits queued the next high-leverage lanes: swarm/engineer proposal gate parity, daemon `ashlrcode` sandbox-only capture, single-source auto-merge readiness, repo-specific verify profiles for the core fleet, and richer resource/status visibility.
- [x] Full gates passed: `npm run typecheck`, focused profile/resource/status/service suites, `npm run lint`, `npm run build`, `npm audit --audit-level=moderate`, `node --check src/core/web/public/app.js`, `npm run test:invariants`, full `npm run test:ci` (412 files, 8548 passed, 7 skipped), and `git diff --check`.
- [x] Commit, push to `origin/master`, resume/restart launchd daemon, and verify live autonomous status.

## Current Continuation - Next Actions And Judge Trust
- [x] Deployed a broader explorer wave for auto-merge trust, daemon reliability, cross-repo coordination, command-center UI, and market/open-source leverage.
- [x] Added `FleetStatus.nextActions`, a ranked read-only action list derived from daemon state, guard health, host PR handoffs, auto-merge readiness, backend resource state, backlog, and repo verify coverage.
- [x] Rendered next actions in `ashlr fleet status` and the Fleet web view, and surfaced compact backend resource reasons in CLI/Fleet/Mission Control backend rows.
- [x] Tightened judge trust so cached `ship` decisions require `detail:'would-merge'` plus a valid HMAC attestation, and `evaluateVerificationGate()` requires explicit merge intent; `ship` with `wouldMerge=false` is now non-mergeable feedback, not merge authority.
- [x] Stopped manager/inline judge paths from signing `ship` attestations when `wouldMerge=false`.
- [x] Gated executable next actions behind fleet/daemon/guard readiness so stopped or blocked fleets prioritize control-plane repair before drain/verify/build work.
- [x] Focused verification passed: typecheck, web JS syntax check, `m49`, `m172`, `m153`, `m157` (97 tests), plus adjacent `m48`, `m47`, and `m201` suites (109 tests).
- [x] Full gates passed: `npm run typecheck`, `node --check src/core/web/public/app.js`, focused trust/status/daemon suites (12 files, 338 tests), `npm run lint`, `npm run build`, `npm audit --audit-level=moderate`, `npm run test:invariants` (41 files, 411 tests), full `npm run test:ci` (412 files, 8552 passed, 7 skipped), and `git diff --check`.
- [x] Committed and pushed to `origin/master`; live daemon/fleet checks passed after launchd reinstall/reload and `fleet resume`.

## Current Continuation - Merged Verified Goal Completion
- [x] Rechecked clean repo state, recent commits, Entire state, task plan, and notes.
- [x] Deploy/read parallel agents for goal completion semantics, regression targets, and lane-lock design.
- [x] Map current goal progress/proposal status behavior locally.
- [x] Implement the smallest safe merged+verified completion signal or repair path.
- [x] Add focused regression coverage for applied-but-unverified versus applied-and-verified goal milestones.
- [x] Run verification, commit, push, restart/resume daemon, and smoke live goal-focus state.

## Current Continuation - Read-Only Lane Locks
- [x] Rechecked clean repo state, recent commits, Entire state, and live daemon/fleet status.
- [x] Deploy/read parallel agents for lane-lock status shape, derivation semantics, and tests.
- [x] Map current FleetStatus assembly, goal/proposal stores, and CLI/web formatter patterns.
- [x] Implement derived read-only `FleetStatus.laneLocks` with bounded privacy-safe samples.
- [x] Add focused status, pure-helper, and formatter regression coverage.
- [x] Run verification, commit, push, restart/resume daemon, and smoke live lane-lock status.

## Current Continuation - Stale Goal Lane Recovery Action
- [x] Rechecked clean state and live lane-lock signal after rollout.
- [x] Mapped existing `nextActions` builder and `ashlr goals` recovery commands.
- [x] Added a high-priority read-only/control-plane next action for stale in-progress goal lanes.
- [x] Added focused `m49` coverage for inspect, pause, and resume command suggestions.
- [x] Run verification, commit, push, restart/resume daemon, and smoke live next action.

## Current Continuation - Remote Handoff Reconciliation
- [x] Rechecked git status, recent commits, Entire state, task plan, and notes after the previous push.
- [x] Deployed parallel agents for remote PR reconciliation, proposal unblockers, service progress health, active kill cancellation, repo contracts, and shared cooldown parity.
- [x] Implemented read-only GitHub PR reconciliation for proposals waiting on remote host merge outcomes.
- [x] Required strong PR identity before terminal reconciliation: exact PR URL or matching head/base refs; ambiguous terminal responses stay awaiting/unknown.
- [x] Hooked reconciliation into daemon maintenance while skipping dry-run, kill/no-enrollment/budget gates, and resource-control `pause`.
- [x] Surfaced remote handoff reconciliation counts in daemon ticks, control logs, Fleet Activity API, and Mission Control tick stream without mixing them into autonomous merge counts.
- [x] Fixed shared cooldown parity so `judged-*` anti-clog outcomes survive shared-store parsing, suppress cross-machine work, and are counted in shared queue health.
- [x] Routed daemon anti-clog sweep through the active work-queue coordinator so shared fleets cool down rejected/noise work globally.
- [x] Focused verification passed: typecheck; `m18`, `m201`, `m315`, `m61`, `m90`; and shared cooldown suites `m111`, `m220`.
- [x] Broad gates passed: typecheck, node web syntax check, lint, build, audit, diff check, invariants, and full `npm run test:ci`.
- [x] Commit, push to `origin/master`, and verify live daemon/fleet status.

## Current Continuation
- [x] Rechecked git/daemon/fleet state after the previous push.
- [x] Deployed fresh explorer agents on daemon refill, fleet/backlog persistence, and cross-repo discovery.
- [x] Found live fleet status showing zero backlog because persisted `backlog.json` was a stale temp-test snapshot while real self-heal work lived in `~/.ashlr/self-heal-queue.json`.

## Current Continuation - Fleet OS Readiness Lane
- [x] Rechecked branch/worktree, Entire state, current planning files, and recent commits.
- [x] Mapped `FleetStatus`, CLI `fleet status`, Mission Control/Fleet app.js renderers, and focused tests.
- [x] Add additive read-only Autonomous Ship Readiness status to `FleetStatus`.
- [x] Render readiness in CLI Fleet status and Mission Control/Fleet web surfaces.
- [x] Add focused readiness regression coverage and run targeted gates.
- [ ] Resolve unrelated current typecheck failure in `src/core/run/sandboxed-engine.ts` if this branch owner wants a full TypeScript gate.
- [x] Added a shared read-only queued-autonomy reader and wired it into `fleet status`, daemon cached backlog counts, and the queued autonomy scanner.
- [x] Prevented daemon verification commands from writing into production `HOME`/`~/.ashlr` by giving each verify subprocess an isolated temp HOME.
- [x] Prevented explicit subset/temp `buildBacklog({ repos })` scans from clobbering the global fleet backlog snapshot unless the caller opts into `persist:true`.
- [x] Fixed daemon singleton lock recovery so a dead-owner lock with a fresh heartbeat does not block service restart.
- [x] Verified live patched `bin/ashlr fleet status --json` now reports 13 backlog items across 9 repos and `autonomyDirection.mode:"backlog-build"` instead of an empty queue.

## Current Continuation - Overnight Learning Loop
- [x] Rechecked worktree, recent plan/notes, and the partially applied action-count routing patch.
- [x] Collected parallel scout findings for dispatch-production action counts and FleetStatus/eval attempt-shape diagnostics.
- [x] Added metadata-only dispatch `actionCounts` rollups and compact `attemptShape` counters.
- [x] Kept policy-disabled samples neutral by outcome and by `actionCounts.proposalDisabled`.
- [x] Added gate-dominant routing guard so low proposal yield caused by capture/completeness gates does not trigger same-tier backend churn.
- [x] Rendered dispatch attempt shape in CLI Fleet status, Mission Control/Fleet web dispatch cards, and attention eval reports.
- [x] Focused verification passed: typecheck, diff check, and 145 tests across dispatch-production, learned routing, fleet status, eval attention, and dashboard suites.
- [x] Broad verification passed: adjacent learning/router suites, build, lint, audit, invariants, and full `npm run test:ci` (438 files, 8992 passed, 7 skipped).
- [ ] Commit, push, reload daemon, and continue to the next autonomous lane.

## Current Continuation - Overnight Proposal Quality Gate
- [x] Rechecked git, Entire, planning files, recent commits, and live fleet status after the automerge safety push.
- [x] Deployed parallel scouts for trivial proposal gating, outcome plumbing, and Phantom readiness integration.
- [x] Hardened the trivial diff classifier against semantic directives, whitespace-sensitive files, string-whitespace changes, leading-star code, and fixture docs.
- [x] Integrated a typed `trivial-proposal` outcome into autonomous sandbox/API proposal capture before proposal creation.
- [x] Mapped trivial outcomes to gate-blocked dispatch production so the fleet learns no-proposal quality signals and cools down repeated tiny churn.
- [x] Added focused classifier, sandbox, api-model, and daemon regression tests.
- [x] Run broad verification.
- [x] Commit, push, restart/resume daemon, and verify live fleet state.
- [x] Verified focused/backlog/scanner suites, typecheck, lint, build, audit, and diff checks.
- [ ] Commit, push, restart launchd daemon, and verify live service after restart.

## Current Continuation - Goal Scope And Verify-Only Drain
- [x] Rechecked git, Entire, daemon service, daemon status, fleet status, and live process state.
- [x] Deployed explorer agents for goal/backlog scope, verify-only blockers, self-heal queue quality, daemon heartbeat liveness, and auto-merge usefulness.
- [x] Stopped the daemon for the maintenance window so live verification would not run against a half-edited worktree.
- [x] Fixed `scanGoals()` so only goals whose `Goal.project` resolves to the scanned repo can emit backlog work; projectless planning-only goals and wrong-repo goals are skipped before milestone expansion.
- [x] Expanded goal-scanner regression coverage in M160/M222/M223 for projectless/wrong-repo goals.
- [x] Prevented `regression:detected` from creating goals against ephemeral Ashlr execution worktrees under `~/.ashlr/sandboxes/*/worktree` or `~/.ashlr/tmp/vwt-*`.
- [x] Added reject-only auto-merge maintenance for stale pending proposals produced from ephemeral temp-worktree regression goals.
- [x] Generalized auto-merge preflight drain so all permanent readiness blockers, not only known failed verification, increment `stuckPassCount` and reject at the existing `autoArchiveAfterRejects` threshold.
- [x] Surfaced `invalidRejected` in daemon auto-merge tick summaries and Mission Control logs.
- [x] Verified focused suites: M160/M222/M223, M258/M305/M307, M201/M61/M307, and diff checks.
- [x] Run full type/lint/build/audit gates.
- [x] Commit, push to `origin/master`, clear the maintenance kill switch, restart launchd daemon, and verify live autonomous status.

## Current Continuation - Stale Self-Heal Cleanup
- [x] Rechecked git, Entire, daemon status, fleet status, and live queue state after the previous push.
- [x] Deployed explorer agents for stale self-heal cleanup, self-heal detection/workspace quality, daemon heartbeat liveness, remote PR truth, and live queue truth.
- [x] Stopped the live daemon and set the maintenance kill switch before editing.
- [x] Made `detectBreakage()` distinguish proven green from unknown/no-command/detect-error states.
- [x] Pruned stale self-heal items from both `self-heal-queue.json` and persisted backlog echoes only after a scanned repo is verified green.
- [x] Added regression coverage for green pruning, unknown preservation, no-command preservation, and disabled self-heal no-mutation behavior.
- [x] Verified focused self-heal and queued-autonomy suites plus typecheck.
- [x] Run full lint/build/audit/diff gates and broader related tests.
- [x] Commit and push the initial verified-green cleanup to `origin/master`.
- [x] Live restart exposed a sharper stale-kind case: build repairs can be stale while tests remain red.
- [x] Extended self-heal to keep one canonical current repair per repo and prune missing/unenrolled self-heal pollution.
- [x] Run follow-up full gates.
- [x] Commit, push, resume/restart daemon, and verify live queue truth.

## Current Continuation - Judge-Free Autonomy Push
- [x] Rechecked git status, recent commits, Entire state, task plan, notes, and package/test surface.
- [x] Deployed parallel explorers for auto-merge trust gates, daemon throughput, operator surfaces, config/schema/docs, deterministic risk signals, and unfinished follow-up lanes.
- [x] Synthesize explorer findings into one high-leverage implementation slice.
- [x] Implemented `foundry.autoMerge.trustBasis:"evidence"` with deterministic gates for base-bound verification, provenance, EDV confirmation, risk/scope caps, partial-proposal refusal, and build/CI/manifest safety.
- [x] Routed evidence mode through daemon maintenance without resolving or calling the judge, while preserving verification mode's judge-backed path.
- [x] Shared auto-merge readiness preflight with FleetStatus so status and merge maintenance no longer drift on evidence/verification blockers.
- [x] Updated docs/effective-config/status/evidence-pack typing for tier, verification, and evidence trust modes.
- [x] Run focused verification, typecheck, lint, build, audit, invariants, full test:ci, node syntax, and diff checks.
- [x] Leave updated notes and commit-ready status; live daemon was not restarted because no live config/service mutation was required.

## Current Continuation - Proposal Production Yield Push
- [x] Rechecked git status, recent commits, Entire state, task plan, notes, daemon status, and fleet status.
- [x] Confirmed live bottleneck remains proposal production: daemon running, guard clear, 33 backlog items, 0 pending proposals, and 53 no-proposal dispatches in the recent window.
- [x] Deployed parallel agents across dispatch defaults, proposal capture, live telemetry, backlog quality, verification contracts, and operator surfaces.
- [x] Implemented structured `RunProposalOutcome` and daemon `dispatch.production` telemetry so empty diffs, gate blocks, engine failures, sandbox failures, disabled proposal filing, and capture failures are distinguishable.
- [x] Threaded production outcomes through Best-of-N, daemon tick summaries, FleetStatus recent no-proposal examples, and the Best-of-N candidate ledger.
- [x] Marked the legacy `ashlrcodeExecutor` branch as an explicit no-proposal/capture-bypass outcome instead of letting it look like successful proposal creation.
- [x] Made judged-proposal anti-clog sweeps idempotent by proposal ID so the same rejected proposal cannot keep producing duplicate `judged-decline` events.
- [x] Added focused regression coverage for API-model gate-block outcomes, Best-of-N no-proposal summaries, daemon dispatch production traces, FleetStatus production examples, and judged sweep idempotency.
- [x] Verification passed: `npm run typecheck -- --pretty false`; focused `test:ci` over 5 affected suites (121 passed, 1 skipped); full `npm run test:ci` (426 files, 8751 passed, 7 skipped); `npm run build`; `npm run lint` (existing 117-warning baseline, 0 errors); `npm audit --audit-level=moderate`; and `git diff --check`.
- [x] Updated notes/task plan and left commit-ready status.

## Current Continuation - Async Verification Liveness
- [x] Rechecked git status, recent commits, Entire state, task plan, and notes.
- [x] Deployed parallel agents to audit async verification migration, auto-merge verification callers, and failure-kind/tooling classification.
- [x] Stopped the live daemon for the maintenance window before edits.
- [x] Added an async verification command runner that preserves process-tree timeout and isolated HOME behavior without blocking timers.
- [x] Migrated production verification paths that can run inside daemon/autonomy work to the async runner: structured verification, auto-merge proposal verification, self-target parity, self-heal detection, TITRR/completeness gates, regression sentinel, and MCP-native lint-on-edit.
- [x] Added regression tests proving async verification lets timers run, kills process trees, ships the wrapper in the package, and keeps self-target parity from treating promises as truthy.
- [x] Repaired full-CI drift exposed by the migration: dynamic doctor HOME paths, stale mocks, stable reflection fixtures, multi-backend merge mocks, and production-panel mock reset.
- [x] Run final full gates, commit, push, restart daemon, and verify live service/queue truth.

## Current Continuation - Gate Parity And Remote Handoff Truth
- [x] Rechecked git, Entire, task plan, notes, daemon status, fleet status, and live queue/resource state.
- [x] Deployed explorer agents for API/local-coder proposal gate parity, remote PR handoff truth, live loop proposal effectiveness, and cross-repo fleet usefulness.
- [x] Stopped the live daemon and engaged the fleet kill switch for the maintenance window before edits.
- [x] Added API-model/local-coder proposal gate parity: in-process sandbox runs now run `runCompletenessGate()` before filing proposals.
- [x] Treat API-model budget/step-cap results as partial for completeness-gate purposes, so partial diffs are blocked by default.
- [x] Persist API-model run steps, task traces, usage, and proposed decision telemetry instead of discarding step/usage data.
- [x] Added `awaiting-host-merge` proposal status and `handoff` decision action so remote GitHub PR handoffs do not count as landed merges.
- [x] Persist structured `remoteHandoff` metadata on handoff proposals and surface host PR counts in fleet status/Mission Control.
- [x] Added hermetic regression coverage for API-model gate blocking/step capture and remote PR handoff truth.
- [x] Focused gates passed: typecheck, diff check, 190 affected tests, and 149 merge/automerge/fleet/resource tests.
- [x] Run full lint/build/audit/full-CI gates.
- [x] Commit, push to `origin/master`, resume/restart launchd daemon, and verify live autonomous status.

## Current Continuation - Autonomy Effectiveness And Worker Queue Truth
- [x] Rechecked git, recent commits, Entire state, notes/task plan, live daemon status, and live fleet status.
- [x] Deployed parallel agents for auto-merge truth, daemon autonomy reliability, cross-repo backlog, and Mission Control visibility; deployed one worker agent on the safest cross-repo self-heal item.
- [x] Confirmed current truth: Ashlr Hub is online, auto-merge is enabled, and guards are clear, but it is not effectively auto-merging because there are `0` pending/preflight-ready proposals and `0` recent merges.
- [x] Added read-only `FleetStatus.autonomyEffectiveness` with explicit phases such as `proposal-starved`, `merge-ready`, `verification-needed`, `host-handoff`, and `control-blocked`.
- [x] Surfaced autonomy effectiveness in `ashlr fleet status`, `/api/fleet`/control consumers, Fleet, and Mission Control, and promoted ranked next actions into Mission Control.
- [x] Fixed `ashlr worker setup --queue` so shared workers persist `sharedQueue.mode:'filesystem'` instead of silently configuring a path that the coordinator treats as local-only.
- [x] Focused verification passed: typecheck, web JS syntax check, `m49`, `m112`, `m111`, and `git diff --check`.
- [x] Broad gates passed: lint, build, audit, invariants, and full `npm run test:ci`.
- [x] Commit, push to `origin/master`, and verify live daemon/fleet status with the new effectiveness field.

## Current Continuation - Recursive Self-Improvement Proposal Production
- [x] Rechecked git, recent commits, Entire state, task plan, notes, daemon status, and fleet status.
- [x] Confirmed live bottleneck remains `autonomyEffectiveness.phase:"proposal-starved"`: healthy daemon, 30 backlog items, 0 pending proposals, 0 recent merges.
- [x] Deployed agents for proposal-production starvation, recursive self-improvement loops, daemon workhorse dispatch, service budget liveness, and judge parser reliability.
- [x] Added daemon proposal-production telemetry so ticks report selected, claimed, dispatched, skipped, errors, proposals created, and dispatched-without-proposal counts.
- [x] Integrated agent findings into safe patches: Best-of-N uses CLI/API runner by engine kind, daemon honors workhorse dispatch, budget exhaustion sleeps resident until the next UTC budget day, Codex/GPT judge parsing handles JSONL/reasoning output, and learned routing uses canonical work identity.
- [x] Focused verification passed: typecheck, diff-check, JS syntax, and 169 tests across manager, Best-of-N, daemon loop, learned routing, workhorse dispatch, auto-merge, and Mission Control.
- [x] Fixed the final audit finding: judge parsing no longer treats bare telemetry score fields as verdict JSON, and now preserves valid nested JSONL verdicts even when later telemetry contains `value`.
- [x] Final full CI passed after audit fix: `npm run test:ci` covered 412 files, 8583 passed tests, and 7 skipped.
- [x] Final package gates passed: build, lint (117 existing warnings, 0 errors), audit (0 vulnerabilities), and diff check.
- [ ] Commit, push, reinstall/restart daemon, and verify live status.

## Current Continuation - Visual Evidence Into Auto-Merge Verification
- [x] Rechecked git, Entire, task plan, notes, daemon status, and fleet status.
- [x] Deployed explorer agents for visual grounding evidence wiring and operator visibility.
- [x] Added explicit `foundry.visualGrounding.query` gating so browser verification never calls a visual model unless an operator configured a screenshot query.
- [x] Added sanitized `VisualGroundingEvidence` and `ProposalBrowserVerifyEvidence` contracts.
- [x] Made browser verification attach visual evidence metadata only: provider, status, boxes, bytes, hash, and scrubbed detail; no raw provider text, sourceText, base64, or screenshot paths.
- [x] Wired `verifyProposal()` to run opt-in browser verification against the patched isolated verify worktree, fail closed on non-skipped render/console failures, and persist compact browser/visual evidence into proposal verification and autonomy evidence packs.
- [x] Updated browser/orchestrator/merge/autonomy tests for sanitized evidence and worktree browser verification.
- [x] Run final full gates.
- [x] Commit, push to `origin/master`, and verify live daemon/fleet status.
- [x] Next slice: expose daemon proposal-production diagnosis in Fleet/Mission Control so `proposal-starved` explains selected, dispatched, no-proposal, and error causes.

## Current Continuation - Proposal Production Diagnosis
- [x] Rechecked git status, recent commits, Entire state, task plan, notes, and relevant fleet/control/dashboard code.
- [x] Deployed explorer agents for fleet/status diagnosis, Mission Control/Fleet UI wiring, and test/API coverage.
- [x] Added read-only `FleetStatus.proposalProduction` aggregation from recent daemon ticks: selected, claimed, dispatched, skipped, errors, proposals created, no-proposal dispatches, top reasons, and bounded recent examples.
- [x] Folded proposal-production diagnosis into `autonomyEffectiveness.phase:"proposal-starved"` summaries and ranked `inspect-proposal-production` next actions.
- [x] Surfaced proposal production in `ashlr fleet status`, Fleet view, Mission Control hero/cards, Fleet Dashboard production panel, and Fleet Activity tick tests.
- [x] Added backend, CLI, control, dashboard snapshot, Fleet Activity, and static web wiring regression coverage.
- [x] Focused verification passed: typecheck, web JS syntax check, and 103 tests across M49, M61, M90, M210, and M213.
- [x] Run final full gates.
- [x] Commit, push to `origin/master`, and verify live daemon/fleet status.

## Current Continuation - Sandboxed Executor And Self-Heal Trust
- [x] Rechecked git status, recent commits, Entire state, task plan, and notes.
- [x] Deployed six parallel scout agents across ashlrcode executor routing, proposal capture, verify/self-heal taxonomy, workhorse dispatch, cross-repo usefulness, and production-outcome learning.
- [x] Removed the daemon's direct `runViaAshlrcode` dispatch path from live routing and rewrote `ashlrcodeExecutor` to use normal sandboxed `runGoal(... engine:'ashlrcode', sandboxEngine:true, requireSandbox:true ...)`.
- [x] Added an allowlist guard so `ashlrcodeExecutor` only rewrites to `ashlrcode` when `foundry.allowedBackends` explicitly includes it.
- [x] Added autonomous `ac` argv coverage: `--autonomous --dangerously-skip-permissions --surgical` now comes from the engine registry and is used by sandboxed engine execution.
- [x] Threaded the routed daemon model into the normal sandboxed `runGoal` path so dispatch traces and executed model no longer diverge.
- [x] Added `VerifyFailureCategory` and made self-heal treat only `code` verify failures as repairable; tool, timeout, infra, and invalid-command failures stay untrusted and do not create queue work.
- [x] Focused verification passed: typecheck; affected executor/model/self-heal suites (9 files, 250 passed, 1 skipped); build; lint (existing 117-warning baseline, 0 errors); audit; and diff-check.
- [x] Full `npm run test:ci` passed: 426 files, 8,759 passed tests, 7 skipped.

## Current Continuation - Cap-Aware Route-Preserving Dispatch
- [x] Rechecked current branch state, persistent plan/notes context, recent commits, and Entire resume state.
- [x] Harvested and closed the prior six scout agents; their strongest next finding was cap-aware local/workhorse dispatch.
- [x] Deployed a fresh read-only scout wave for proposal capture, dispatch-production ledger, config/docs comments, and route-model regression coverage.
- [x] Add backend-state-aware concurrent slot budgeting so `capUnit:'concurrent'` and `usedPct` clamp local-coder/workhorse capacity instead of the generic open/near slot count.
- [x] Make `workhorseDispatch` preserve protected gateway decisions such as frontier, throttle, budget-pause, and resource-pause routes while still spreading local-mid bulk work.
- [x] Add focused tests for local-coder cap clamping, saturated local-coder zero assignment, and route-preserving workhorse dispatch.
- [x] Updated operator/config docs and resource-control wording for cap-aware, route-preserving dispatch.
- [x] Verification passed: focused dispatch/daemon tests, adjacent routing/resource suites, typecheck, build, diff check, lint, audit, and full CI.

## Current Continuation - Dispatch Production Ledger
- [x] Rechecked current branch state, recent commits, Entire state, task plan, and notes.
- [x] Deployed parallel scouts across ledger integration, tests, proposal capture, MCP diff redaction, status consumers, live fleet lanes, and judge-free merge paths.
- [x] Added append-only metadata-only dispatch production JSONL ledger under `$ASHLR_HOME/dispatch-production/YYYY-MM-DD.jsonl`.
- [x] Wrote daemon dispatch production events after dispatch outcomes settle, reusing run proposal outcomes, Best-of-N no-winner truth, and pending-proposal delta fallback without double-counting side proposals.
- [x] Added focused ledger and daemon regression tests for append/read, scrubbing, malformed lines, unavailable persistence, empty diffs, filed proposals, side-proposal fallback, and thrown dispatch failures.
- [x] Made default tier/evidence auto-merge maintenance judge-free at the pass layer; explicit `trustBasis:"verification"` and `managerGate:true` remain judge-backed.
- [x] Bound evidence-mode cached verification to the current proposal diff via `ProposalVerifyResult.diffHash`, with stale/missing hashes forcing reverify or fail-closed evidence explanations.
- [x] Repaired stale judge-path tests to make manager-gated suites explicit and updated read-only gate explainer fixtures for diff-bound evidence.
- [x] Verification passed: focused affected suites, `npm run typecheck -- --pretty false`, `git diff --check`, and full `npm run test:ci` (427 files, 8779 passed, 7 skipped).

## Current Continuation - Dispatch Yield And Route Truth
- [x] Rechecked worktree/session state, task plan, notes, and the relevant dispatch/status/routing diffs.
- [x] Deployed and harvested parallel auditors for dispatch yield ledger hardening, Fleet/Mission Control surfaces, routing safety, and final verification gates.
- [x] Hardened dispatch-production reads for `$ASHLR_HOME` fallback, sanitized legacy rows, date-window pruning, loose legacy JSONL compatibility, and longer window file selection.
- [x] Fed source-isolated dispatch-production yield into learned routing as a conservative same-tier reroute signal with a sample floor and no escalation.
- [x] Cleared stale routed models and rechecked quota, subscription, and resource guards after learned/budget/resource reroutes in daemon and gateway paths.
- [x] Surfaced durable dispatch yield in `FleetStatus`, CLI status, Mission Control/Fleet Dashboard production panels, and dashboard/control snapshots.
- [x] Tightened evidence-mode readiness so cached verification must be bound to the current proposal diff hash before being counted preflight-ready.
- [x] Updated operator docs/examples for yield knobs, trust-basis semantics, JSON-only yield dimensions, and current model examples.
- [x] Verification passed: focused dispatch/routing/status/dashboard suites, broader merge/resource/judge suites, typecheck, JS syntax, lint, build, audit, and diff checks.

## Current Continuation - Live Guard Recovery And Self-Heal Trust
- [x] Rechecked post-push repo, Entire, live daemon, fleet status, task plan, and notes.
- [x] Deployed parallel auditors for live guard recovery, proposal capture unification, backlog quality, operator surfaces, and merge effectiveness.
- [x] Repaired the live control block by confirming stale spend guard PID `3403` was dead, archiving the guard, reinstalling/restarting launchd, and verifying guard health clear.
- [x] Paused the daemon for the maintenance patch to avoid racing live autonomous dispatch.
- [x] Added a shared next action for poor durable dispatch yield so CLI, Fleet, and Mission Control direct agents toward low-yield backends.
- [x] Added a pure self-heal trust filter and used it for both fresh self-heal classification and queued self-heal rehydration.
- [x] Rejected queued self-heal noise such as npm script banners, rustup setup errors, Cargo download chatter, missing local tool binaries, TAP plan lines, and termination noise while preserving concrete code diagnostics.
- [x] Added a distinct `daemon-spend-guard-dead-owner` guard-health diagnosis for future stale guard incidents.
- [x] Verification passed: focused status/self-heal/queued-autonomy/guard-health suite, adjacent daemon/control/dashboard/ledger/workhorse suites, typecheck, build, lint, audit, and diff checks.

## Current Continuation - Global Workspace Agent Telemetry
- [x] Rechecked branch state, Entire session context, recent progress notes, and the pre-existing dirty worktree before editing.
- [x] Deployed parallel research/code/UI/test/verification agents and folded their findings into the implementation plan.
- [x] Researched Anthropic's July 6, 2026 global workspace/J-lens work plus adjacent agent-observability, blackboard, executable-harness, and trajectory-learning research.
- [x] Added an append-only, metadata-only `agent-actions` JSONL ledger with secret scrubbing, bounded fields, HOME fallback, malformed-line skipping, finite numeric handling, and poisoned legacy-row normalization.
- [x] Wired daemon ticks and dispatch-production outcomes into durable agent-action events so the fleet records what it attended to, skipped, blocked on, dispatched, and produced.
- [x] Added `FleetStatus.workspace`, `/api/fleet-state.workspace`, Fleet Activity `recentActions`, CLI global-workspace output, Mission Control metrics/cards, Fleet view cards, Fleet Dashboard production summaries, and an agent action feed.
- [x] Hardened browser and CLI surfaces for empty workspace data, partial stale status objects, and Windows-style repo paths.
- [x] Added focused regression tests for append/read/window limits, fallback paths, secret scrubbing, poisoned legacy dimensions, non-finite numbers, summaries, FleetStatus, dashboard snapshots, and agent-readable API output.
- [x] Production verification passed: JS syntax, typecheck, focused affected suites, adjacent daemon/control suites, build, lint, audit, diff check, and full `npm run test:ci` (428 files, 8,811 passed, 7 skipped).
- [x] Commit only this pass's files, push to `origin/master`, and restart/verify the live daemon.

## Current Continuation - Score Stability And Routing Contract Hygiene
- [x] Rechecked branch state, recent commits, Entire state, dirty worktree, task plan, and notes.
- [x] Deployed parallel agents for health-score leakage, invent ambition contract safety, learned-router sample-floor coverage, live telemetry, and final verification planning.
- [x] Preserved richer invent impact/confidence/effort ambition signals while mapping emitted `WorkItem.value`, `effort`, and `score` back to the stable backlog contract.
- [x] Added malformed numeric fallback, clamped ambition metadata, high-impact/low-effort, and contract-safe frontier ambition regression tests.
- [x] Hardened health score math and report output so non-finite dimension scores and worst-offender fields cannot leak `NaN` or `Infinity`, while typed errors remain visible.
- [x] Tightened learned-routing sample-floor stabilization and added exact-floor route/model selection coverage for both engine and producer scores.
- [x] Run focused health, invent, learned-routing, and model-granular routing verification.
- [x] Run final typecheck, adjacent suites, lint, build, audit, diff checks, and full CI.
- [x] Commit, push to `origin/master`, rebuild/restart daemon, and verify live fleet status.

## Current Continuation - In-Progress Global Workspace Telemetry
- [x] Rechecked clean `master`, recent commits, Entire resume state, task plan, and notes.
- [x] Deployed parallel explorer agents across daemon tick lifecycle, verification lifecycle, sandboxed action counts, tests, operations, and next product bottlenecks.
- [x] Re-read Anthropic's July 6, 2026 global-workspace writeup and translated it into Ashlr's software-level shared telemetry channel: record intent/start/finish metadata early enough for other systems to use it.
- [x] Added `started` as a first-class `AgentActionOutcome` so in-flight events do not collapse into `unknown`.
- [x] Added metadata-only `daemon:tick-start` events at tick entry with dry-run/live mode and dispatch capacity counts while keeping durable daemon tick history terminal-only.
- [x] Added auto-merge verifier lifecycle events around evidence-backed preflight verification: `auto-merge:verify-before-merge-start/finish` and `auto-merge:verify-before-judge-start/finish`.
- [x] Added focused ledger, daemon-loop, and auto-merge regression coverage for started outcomes, terminal tick preservation, verifier pass/fail telemetry, and no raw diff/stdout/stderr leakage.
- [x] Focused verification passed: `npm run test:ci -- test/m343.agent-action-ledger.test.ts test/m201.daemon-loop.test.ts test/m48.automerge-pass.test.ts test/m49.fleet-status.test.ts` (114 tests).
- [x] Run final typecheck, build, lint, audit, diff checks, and full CI.
- [x] Commit, push to `origin/master`, restart/reverify the live daemon, and record next telemetry lanes.

## Current Continuation - Critical Autonomy Throughput Audit
- [x] Rechecked clean `master`, recent commits, Entire resume state, daemon health, fleet status, task plan, and notes.
- [x] Deployed parallel agents for proposal-disabled/TITRR capture semantics, dispatch-yield learning truth, cooldown-aware status, sandboxed action counts, and route trace persistence.
- [x] Identified live critical bottleneck: daemon/service healthy and guard clear, but proposal production is starved (1/12 recent dispatches produced proposals; 7/12 were `proposal-disabled`).
- [x] Prevented `proposal-disabled` control-flow rows from poisoning backend/source yield learning while preserving them in operator-visible dispatch-production status.
- [x] Added focused routing tests proving disabled proposal-filing samples do not reroute, while real empty/gate/engine failures remain learnable.
- [x] Harvested agent findings and selected the smallest second lane: make FleetStatus cooldown/pending-aware so next actions only point at daemon-eligible backlog.
- [x] Added raw/eligible/cooling/pending queue fields, eligible-only `queue.next`, wait-for-eligibility next action, CLI/Fleet/Mission Control visibility, and focused status regressions.
- [x] Run final gates, commit, push, and production-check.

## Current Continuation - Context Architecture From Grok Chat
- [x] Rechecked branch/session state, recent commits, Entire resume, existing notes, and current in-flight diff before touching source.
- [x] Kept the live fleet paused while editing after prior daemon/agent cleanup raced in-flight patches in the shared checkout.
- [x] Deployed/read parallel agents across genome memory, scoped delegation, observability, cross-repo Phantom ownership, attention-eval strategy, status/UI audit, and next-lane architecture.
- [x] Added metadata-only `FleetStatus.contextEfficiency` from workspace attention, proposal-production yield, queue breadth, and hub genome health.
- [x] Surfaced context efficiency in CLI fleet status, Fleet, Mission Control, and Fleet Dashboard production panels.
- [x] Made reflected genome memories outrank raw run/swarm captures when keyword relevance is otherwise equal.
- [x] Fixed Phantom returned-output scrubbing so injected values remain available to the scrubber after the ephemeral env is cleared.
- [x] Added focused regression coverage for context-efficiency FleetStatus/formatter output, recall tiering, and Phantom literal-value scrubbing.
- [x] Run focused typecheck, JS syntax, and affected suites.
- [x] Run final lint/build/audit/diff/full-CI gates.
- [x] Commit, push, resume/reinstall the live fleet, and verify production status.
- [ ] Next lane: implement shared `DelegationScope` for context budgets, allowed files, memory mode, and result contracts.
- [ ] Next lane: add `ashlr eval attention` with middle-drop and workflow-resolution gates.
- [ ] Next lane: emit prompt utilization, retrieval hit-rate, and compression metadata into the causal trajectory graph.
- [ ] Next lane: formalize cross-repo ownership where Phantom owns secrets, Pulse owns durable telemetry, executor repos own model behavior, and Hub coordinates policy/scheduling.

## Current Continuation - Overnight Autonomous Execution Loop
- [x] User requested a 12-hour overnight loop and many-agent execution.
- [x] Created an hourly heartbeat automation for 12 runs to continue this thread.
- [x] Rechecked clean `master`, recent commits, Entire state, package scripts, persistent plan/notes, and next-lane backlog.
- [x] Deployed parallel agents for `DelegationScope`, attention evals, trajectory metadata, cross-repo ownership, and live fleet status.
- [x] Implemented a bounded first slice: shared `DelegationScope` contract/helpers, sandboxed scope propagation, causal `contextSummary`, and context-efficiency next action.
- [x] Ran focused verification for delegation scope, learning graph, fleet status, learned routing, typecheck, and diff checks.
- [x] Second heartbeat: wired daemon/swarm/best-of-N/runGoal producers to create and propagate `DelegationScope` by default.
- [x] Added regression coverage for daemon default scope on builtin, single-run, and best-of-N paths; best-of-N candidate child scopes; swarm task scopes; and TITRR attempt/capture pass-through.
- [x] Focused verification passed: producer-scope suite, typecheck, and lint. Full suite passed except `h8.cleanup-comment-only`, which intentionally fails while `src/core/swarm/runner.ts` has an uncommitted code diff because that invariant diffs swept files against `HEAD`.
- [x] Post-commit full suite passed against clean `HEAD`, then commit/push/relaunch verified the delegation-scope producer wiring in production.
- [x] Audited unexpected untracked BinShield work from the live loop, deployed parallel agents, and found the proposed adapter targeted a non-existent `binshield dependency-bump` command.
- [x] Corrected the adapter to the real `binshield scan npm <package> <version> --json` surface, made valid-but-unknown/error JSON fail closed, and preserved JSON stdout from non-zero risk exits.
- [x] Wired scanner-time BinShield gating into opt-in npm dependency-bump backlog items: target-version scans must succeed, high/critical targets are suppressed, and passed items carry bounded BinShield evidence tags/detail.
- [x] Formalized ecosystem ownership boundaries in the machine-readable ecosystem index and Markdown map with invariant tests for complete/disjoint local ownership plus external candidate handoff.
- [x] Focused verification passed for BinShield adapter/dep scanners/ownership docs, typecheck, and diff checks.
- [x] Run final lint/build/audit/full-suite gates for the BinShield + ownership-boundaries slice.
- [x] Commit `d6c804c`, push to `origin/master`, relaunch/verify daemon, repair stale guard from replaced daemon pid, and continue the overnight loop.
- [x] Implement `ashlr eval attention` v1 as a metadata-only fleet attention report over the agent-action ledger.
- [x] Add a dedicated attention report store under `$ASHLR_HOME/eval/attention/reports` with atomic temp-write/rename persistence.
- [x] Add adversarial attention fixtures and tests proving raw prompt/diff/stdout/stderr/summary/reason/detail fields and full paths do not persist.
- [x] Focused verification passed for attention eval, root eval helpers, agent-action ledger, and typecheck; live CLI smoke passed.
- [x] Final verification passed: diff check, lint, audit, build, invariants, and full clean-state test suite.
- [x] Commit `5447577`, push to `origin/master`, relaunch launchd daemon, verify guard health clear, and smoke `bin/ashlr eval attention`.
- [x] Next heartbeat: use attention-eval output to drive context-summary instrumentation gaps and Phantom capability snapshot work.

## Current Continuation - Values-Free Phantom Capability Plane
- [x] Rechecked current worktree, recent commits, Entire state, persistent plan/notes, and in-progress Phantom/readiness changes.
- [x] Deployed parallel agents for Phantom safety review, FleetStatus/dashboard mapping, and Phantom/Ashlr product backlog synthesis.
- [x] Added a values-free Phantom capability snapshot to `PhantomStatus` with known fleet secret counts, Pulse PAT/token credential booleans, metadata mode, injection availability, MCP availability, and mutation-approval posture.
- [x] Hardened Phantom parsing so JSON and plain-text paths use a strict env-name allowlist, value-shaped token families are filtered, and unknown/error structured status fails closed as not initialized.
- [x] Added readiness/preflight Phantom snapshot output with counts/booleans only, home-relative MCP source display, and values-hidden operator findings.
- [x] Added cached FleetStatus Phantom capability with short CLI timeouts, config-aware injection flags, MCP configured boolean, and a compact CLI `Phantom:` line that says values hidden.
- [x] Added focused tests for parser safety, readiness name/value/path privacy, FleetStatus formatter/dashboard pass-through, cached status behavior, and doctor fixtures.
- [x] Verification passed: typecheck, focused Phantom/readiness/FleetStatus/dashboard/control suites, lint, build, audit, diff check, invariants, built CLI smoke, and privacy greps.
- [x] Full `npm run test:ci` passed 434/435 files with 8,908 passing tests and 7 skipped; the sole failure was an order-sensitive `test/m78.titrr.test.ts` mock assertion that passed immediately in direct rerun and in a mixed Phantom/Fleet/TITRR subset.
- [x] Commit `a576d9c`, push to `origin/master`, reinstall/restart the daemon, and verify live fleet status.

## Current Continuation - Hub Secret-Safety Invariant Plane
- [x] Rechecked clean `master`, recent commits, Entire state, task plan, notes, and local privacy/scrub tests after the Phantom capability deployment.
- [x] Deployed parallel agents to audit secret-safety utilities, persistence surfaces, Phantom/MCP backlog, and product-grade safety questions.
- [x] Identified the highest-leverage safety gap for the recursive learning loop: scattered scrub logic plus unsanitized decision `reason`, direct genome hub appends, and partial dispatch-production field sanitization.
- [x] Extended the shared `util/scrub.ts` canary coverage for PEM/private-key blocks, `github_pat_`, GitLab/HuggingFace/npm/Google token prefixes, URL authority passwords, connection strings, access/refresh/session tokens, long base64, and existing provider families.
- [x] Moved audit and decisions ledgers onto the shared scrubber; decisions now sanitize `reason`, verdict/model/engine, and causal IDs before append.
- [x] Rebuilt dispatch-production sanitization as an explicit sanitized record instead of `...event` passthrough so corrupted legacy fields cannot leak into durable production-yield data.
- [x] Hardened genome hub write/read paths so direct `appendHubEntry()` and legacy hub JSONL loads scrub title/text/project/tags before persistence/API/export use.
- [x] Added `test/m349.secret-safety-invariants.test.ts`, a cross-store fake-secret canary that drives synthetic provider-shaped values through audit, decisions, dispatch-production, agent-actions, judge traces, genome hub, and raw on-disk `.ashlr` bytes.
- [x] Focused verification passed: new canary, dispatch ledger, learning graph, judge trace, audit, genome capture/store, typecheck, and diff check.
- [x] Wider verification passed: adjacent quality/dashboard/phantom/attention suites, lint, build, audit, and full `test:invariants`.
- [x] Commit `24e58c9`, push to `origin/master`, and continue review before deployment.
- [x] Applied late review follow-up: preserve 40-char Git SHA-1s in scrubbed audit text, sanitize project genome entries as well as hub entries, and strengthen the canary so each store must write and redact.
- [x] Follow-up verification passed: focused safety/genome/dispatch/audit suites, typecheck, diff check, lint, build, audit, and full `test:invariants`.
- [x] Commit `65c7269`, push the review follow-up, resume/reinstall the live daemon, and verify guard health clear on pid `46963`.
- [ ] Next lane: sanitize public inbox/proposal and dashboard/control read surfaces without erasing legitimate source diffs needed for review.
- [ ] Next lane: split raw MCP specs from sanitized public MCP views and unify Phantom name-only parsing across Hub integration paths.

## Current Continuation - Overnight Safety/Yield Loop
- [x] Rechecked clean `master`, recent commits, Entire state, live daemon status, FleetStatus summary, task plan, and notes after secret-safety deployment.
- [x] Deployed parallel scouts for proposal/inbox secrecy, public API sanitization, MCP safe views, production-yield recovery, and Phantom/Grok product strategy.
- [x] Land and push `0af1b81`, a public web JSON/SSE safe-view boundary that scrubs secret-shaped strings and home paths without erasing review structure.
- [x] Fix the live proposal-production starvation bug where `proposal-disabled` dispatches fell through to `empty` worked-ledger cooldown.
- [x] Tighten long-base64 scrubbing so ordinary absolute temp paths are preserved while compact blobs still redact.
- [x] Run focused web/control/dashboard/inbox/safety, daemon/fleet/scrub, typecheck, lint, build, audit, and diff verification for the two slices.
- [x] Commit `98b89f0`, push the cooldown/scrub fix, archive stale dead-owner spend guard, reinstall launchd daemon, and verify guard health clear on pid `36972`.
- [x] Filter live attention/workspace summaries to enrolled existing repos by default so stale fixture telemetry cannot shape FleetStatus, web workspace views, or attention evals.
- [x] Preserve raw metadata audit access with `readAgentActions()` and explicit `ashlr eval attention --all-repos`, while saved attention reports now record `source.repoScope`.
- [x] Added focused regressions for workspace scoping, FleetStatus context-efficiency fixtures, and CLI default/all-repos attention behavior.
- [x] Verification passed: focused workspace/eval/status suite, typecheck, lint, build, audit, and diff check.
- [x] Commit `2c002b6`, push to `origin/master`, and smoke live attention/fleet status with scoped repo telemetry.
- [x] Sanitize inbox/proposal persistence on write/read without erasing legitimate source diff review context.
- [x] Preserve provenance when only non-diff text redacts, and drop `diffHash`/`provenanceSig` when diff redaction changes signed bytes.
- [x] Verification passed: focused inbox/API suite, secret-safety/API scrub canaries, typecheck, lint, build, audit, and diff check.
- [x] File non-empty partial/TITRR/API-model diffs as safe review-only proposals with failed verification metadata instead of discarding them.
- [x] Verify partial proposals stay fail-closed through `isPartial:true`, `verifyResult.passed:false`, and existing auto-merge/verification gates.
- [x] Update daemon/status/backlog pending matching to prefer repo-scoped `workItemId` so stale proposal prose cannot block unrelated work.
- [x] Keep legacy no-`workItemId` pending coverage through same-repo exact item-id / normalized-title fallback.
- [x] Repair adjacent public-read and scrub regressions uncovered by broad CI: enrolled-existing workspace fixtures, orient path-scrub expectations, MCP audit `keys=`, and long-diff truncation markers.
- [x] Harden the order-sensitive TITRR worktree mock fixture so full CI no longer depends on incidental module cache order.
- [x] Verify pending matching and public/scrub fixes with focused, adjacent, typecheck, lint, build, audit, broad affected suites, and full `npm run test:ci` (437 files, 8,933 passed, 7 skipped).
- [x] Connect review-only partial/failed-verify proposals to a metadata-only repair/verify work queue.
- [x] Queue proposal-repair work through the self-heal queue with stable ids, scrubbed bounded failure context, and no raw diff/stdout/stderr/prompt/file content.
- [x] Refresh daemon backlog after proposal-repair maintenance so repair work can be selected in the same tick.
- [x] Verify proposal repair with focused/adjacent gates and full `npm run test:ci` (437 files, 8,937 passed, 7 skipped).
- [x] Make merge-grade verification explicit in status by separating inferred command coverage from repo-owned contracts.
- [x] Add root `ashlr.verify.json` with required merge-profile typecheck, lint, and full CI commands.
- [x] Treat `ashlr.verify.json` changes as build/CI/manifest changes that cannot self-certify through in-process verification.
- [x] Surface explicit merge contract coverage and pending-proposal verifier-contract gaps in FleetStatus and CLI output.
- [ ] Later lane: evaluate the untracked triviality classifier as observe-only fleet telemetry after moving/hardening it.
- [x] Add Fleet Dashboard first-panel readiness strip using existing autonomous ship readiness data.
- [x] Verify dashboard readiness strip with JS syntax, dashboard/SSE/control/status suites, typecheck, build, lint, audit, and diff checks.
- [x] Normalize run-ledger causal metadata without ingesting raw run/proposal text.
- [x] Verify run-ledger causal metadata with focused/adjacent/typecheck/build/lint/audit/invariant/full-CI gates.
- [x] Strengthen automerge test-weakening detection for equal-count assertion rewrites, skipped tests, and weakened verification scripts.
- [x] Verify automerge safety hardening with focused/broad/full-CI gates.
- [x] Adopt and deploy the trivial-proposal quality gate so tiny docs/comment/whitespace-only diffs do not create autonomous proposals.
- [x] Add read-only Phantom command metadata parsed only from `phantom --help`'s `Commands:` block.
- [x] Surface Phantom command availability in readiness, FleetStatus, CLI status, and dashboard snapshots without raw help text or secret names/values.
- [x] Verify command metadata with focused Phantom/readiness/FleetStatus/dashboard tests plus typecheck, lint, build, audit, invariants, and full CI.
- [ ] Next lane: add a values-free Phantom agent report rollup only after the `agent` command is feature-detected as an actual command, never from prose.
- [x] Filter proposal-disabled dispatch-production samples out of weak-yield next-action diagnostics while preserving raw ledger and status counts.
- [x] Verify dispatch-yield diagnostics with focused FleetStatus/dispatch-ledger/intel tests, typecheck, build, audit, and diff check.
- [x] Run lint/invariants/full regression gates for the diagnostic patch.
- [x] Commit and push `8b1d5ff`; smoke live FleetStatus showing raw `proposalDisabled` still visible while `inspect-dispatch-yield` targets actionable local-coder no-diff output.
- [ ] Restart/resume the live daemon after the active spend guard clears.

## Current Continuation - Proposal Capture Centralization
- [x] Rechecked clean `master`, recent commits, plan state, and scout recommendations after the dispatch-yield diagnostic deployment.
- [x] Migrate API-model success capture through the shared sandboxed proposal-capture helper without losing run usage/tasks/provenance.
- [x] Migrate failed/partial sandbox capture through the shared helper while preserving current fail-closed partial proposal semantics.
- [x] Add focused regression coverage for API-model success, partial failure capture, trivial/empty outcomes, and causal/provenance fields.
- [x] Add default-on merge-contract backlog scanner work for repos with inferred verify commands but no explicit merge-grade `ashlr.verify.json`.
- [x] Verify capture/scanner lanes with focused, adjacent, static, invariant, and full-CI gates.
- [x] Commit and push `79dae3b`, reload launchd daemon, resume fleet, and smoke FleetStatus with guard clear.

## Current Continuation - Overnight Data Loop And Phantom Rollup
- [x] Rechecked current dirty state after compaction, recent commits, plan/notes, and verification sessions.
- [x] Deployed parallel agents for diff audit and next-lane strategy while keeping local verification on the critical path.
- [x] Added metadata-only sandbox action-count telemetry across sandbox creation, model/tool steps, retries, capture attempts, gate/repair attempts, diff size, and proposal outcome counters.
- [x] Persisted action counts through run summaries, daemon dispatch-production traces, causal sanitization, and terminal agent-action ledger records without raw prompts, diffs, stdout, stderr, env, or file contents.
- [x] Added default-off, values-free Phantom `agent report --json` rollup gated by actual top-level `agent` command detection.
- [x] Split skipped/not-attempted dispatch rows from actionable no-proposal diagnostics so FleetStatus can distinguish selection skips from backend/capture yield failures.
- [x] Repaired sibling `ashlrcode` TypeScript/test compatibility and pushed commit `3065031` to `origin/main`.
- [x] Verify current hub batch with typecheck, focused Vitest, Phantom reruns, lint, build, audit, invariants, CI-wrapper affected suites, and full `test:ci`.
- [x] Commit and push the current hub telemetry/Phantom/status batch as `e7548c7`.
- [x] Reload the launchd daemon, resume the fleet, and verify production status.
- [ ] Next lane: use action-count telemetry for sample-gated, same-tier proposal-yield diagnostics/routing without escalating risk.

## Current Continuation - Overnight Autonomous Maintenance Loop
- [x] Rechecked clean `master`, recent commits, Entire state, task plan, notes, and focused daemon-loop context after compaction.
- [x] Deployed sidecar scouts for Phantom-specific leverage, metadata-only learning telemetry, and Fleet OS product critique.
- [x] Fixed daemon selection ordering so prunable self-heal work is refreshed after producer maintenance before live item claims.
- [x] Preserved ordinary non-empty backlog maintenance cadence and proposal-repair same-tick refill behavior.
- [x] Added regression coverage proving stale self-heal work is not dispatched when maintenance refreshes it away.
- [x] Focused verification passed: `npm run typecheck -- --pretty false`, `npm run test:ci -- test/m201.daemon-loop.test.ts test/m165.self-heal.test.ts test/m310.queued-autonomy-work.test.ts`, and `git diff --check`.
- [x] Broader verification passed: adjacent daemon/status/auto-merge/control suites, lint, build, audit, invariants, and full `npm run test:ci` (438 files, 8,993 passed, 7 skipped).
- [x] Added auto-merge drain coverage for the case where self-heal maintenance empties a previously non-empty backlog.
- [x] Post-drain focused verification passed: typecheck, build, lint, audit, diff check, and `m201/m165/m310/m48/m49` focused CI.
- [x] Commit, push, reload daemon, and smoke live fleet state.
- [ ] Integrate sidecar scout recommendations into the next implementation lane.

## Current Continuation - Phantom Signing Trust Boundary
- [x] Followed the Phantom scout recommendation to inspect Hub-only signing before touching Phantom's dirty `docs/accuracy-fixes` worktree.
- [x] Removed the metadata-derived Phantom signing path that hashed secret names/version text and emitted `alg:"phantom"`.
- [x] Kept local HMAC signing unchanged and made legacy/future `alg:"phantom"` signatures fail closed until a real Phantom-held signer exists.
- [x] Updated type/module comments so operator trust labels match the actual signing boundary.
- [x] Added focused regression tests for Phantom-enabled config still emitting local signatures and Phantom-labelled signatures failing closed.
- [x] Verification passed: typecheck, focused signing/runner/secret-safety tests, lint, build, audit, invariants, and diff check.
- [x] Commit, push, reload daemon, and continue with the next high-leverage lane.

## Current Continuation - Fleet OS Mission Brief
- [x] Rechecked clean `master`, recent commits, Entire state, and active overnight goal before editing.
- [x] Deployed parallel scout agents for proposal capture, automerge evidence, Phantom actionability, dashboard coverage, and Fleet OS mission-brief shape.
- [x] Added `FleetStatus.missionBrief` as a read-only single-command operating brief derived from ship readiness, autonomy effectiveness, and ranked next actions.
- [x] Surfaced the brief in `ashlr fleet status`, Fleet view, Mission Control, and the Fleet Dashboard readiness rail without adding new persistence or raw data.
- [x] Added focused status/control/dashboard/formatter/API coverage for blocked and ready mission states.
- [x] Verification passed: typecheck, JS syntax check, focused `m49/m61/m210/m213/m299` CI, lint, build, audit, invariants, and diff check.
- [x] Commit `41d9241`, push to `origin/master`, reload launchd daemon, resume fleet, and smoke live FleetStatus mission brief.

## Current Continuation - Evidence Command Reuse Gate
- [x] Implement evidence-mode verification reuse guard so cached `passed:true` results with no command evidence (`ran: []`) are treated as needing reverify.
- [x] Apply the same command-evidence rule to both daemon auto-merge pass preflight and direct `autoMergeProposal()` reuse paths.
- [x] Add focused regression coverage proving evidence mode reverifies current base/diff cached no-command evidence before merge attempt and skips judge spend.
- [x] Integrate API-model TITRR capture-state metadata propagation so filed proposals no longer retain stale `proposal-disabled` run summaries.
- [x] Add Phantom agent-report actionability from existing count-only rollups plus JSON schema support for `phantom.agentReportRollup`.
- [x] Focused verification passed: typecheck plus combined `m78/m307/m48/m153/m86/m348/m2/m49` suites.
- [x] Broader smoke passed: lint, build, audit, invariants, schema parse/diff check, and full `npm run test:ci` (438 files, 8,999 passed, 7 skipped).
- [x] Commit and push `6d26a6d`, reload/kickstart launchd daemon, and smoke production FleetStatus.

## Current Continuation - Sample-Gated Yield And Service Recovery
- [x] Deployed parallel scouts for sample-gated yield diagnostics, FleetStatus data-quality badges, and daemon service recovery.
- [x] Add structured `dispatchYieldDiagnostics` with sample gating, policy-disabled separation, same-tier-only recommendations, and config-aware low-yield threshold.
- [x] Surface dispatch-yield diagnosis in CLI status and keep weak-yield next actions tied to actionable samples only.
- [x] Add daemon service `ensureRunning()` and wire daemon install, fleet resume, web service repair, and web fleet resume through best-effort OS-service activation.
- [x] Add first-class autonomous ship readiness source-quality badges and summaries so stale/missing/degraded sources do not look like healthy zeros.
- [x] Focused verification passed: typecheck, `node --check` for the dashboard bundle, and status/service/control/dashboard focused suites.
- [x] Broad gates passed: lint, build, audit, invariants, diff check, and full `npm run test:ci` (438 files, 9,005 passed, 7 skipped).
- [x] Commit and push `b88fbff`, clear stale dead-owner spend guard, reload launchd daemon, and smoke production state with PID `26160`.

## Current Continuation - Backend/Source Yield Granularity
- [x] Rechecked clean pushed state after service recovery deployment and production smoke.
- [x] Deployed fresh scouts for backend/source telemetry parity, conservative routing consumption, stale `ashlrcode` self-heal work, and Fleet OS UI actionability.
- [x] Add `dispatchProduction.byBackendSource` buckets so proposal-yield diagnostics can match learned-router backend+work-source granularity without changing routing behavior.
- [x] Prefer backend/source buckets in `dispatchYieldDiagnostics` while preserving policy-disabled filtering, sample gates, and same-tier-only advisory language.
- [x] Promote existing Mission Brief action detail into Mission Control and Fleet Dashboard rail so the first screen shows the concrete next move.
- [x] Focused verification passed: typecheck, dashboard JS syntax check, diff check, and `m342/m49/m210/m213` CI (96 tests).
- [x] Broad lightweight gates passed: lint, build, audit, invariants, and diff check.
- [x] Commit and push `ce89b22`, smoke production status, and continue.

## Current Continuation - Targeted Self-Heal Maintenance
- [x] Confirm live `ashlrcode` TypeScript blocker is stale, then reproduce Ashlr's actual self-heal detector showing the current failure is an Ink raw-mode test error.
- [x] Add targeted `runSelfHealCycleForRepos()` so non-empty backlog self-heal maintenance can revalidate only repos represented by queued self-heal work instead of sweeping every enrolled repo.
- [x] Wire daemon pre-selection self-heal refresh through the targeted helper while preserving full self-heal sweep for empty/periodic maintenance.
- [x] Add focused self-heal and daemon-loop regression coverage.
- [x] Live-revalidate `ashlrcode` queue to replace the stale TypeScript self-heal with the current Ink raw-mode test failure, then refresh backlog.
- [x] Focused verification passed: typecheck, diff check, and `m165/m201/m310/m49` CI (160 tests).
- [x] Broad lightweight gates passed: typecheck, lint, build, audit, invariants, and diff check.
- [x] Commit and push `c01e058`.
- [x] Apply scout-found corrective hardening so only tagged self-heal work triggers targeted pre-selection maintenance, targeted invalid cleanup stays repo-scoped, and target paths canonicalize to enrolled repo paths.
- [x] Corrective verification passed: typecheck, diff check, focused `m165/m201` CI (118 tests), lint, build, audit, and invariants.
- [x] Push corrective hardening, reload launchd daemon, clear stale dead-owner spend guard, and smoke production status.

## Current Continuation - Fleet OS Command Rail
- [x] Rechecked clean production state after `f587104`: daemon PID `78743`, launchd running, guard clear, one verification-failed pending proposal, and 21 backlog items.
- [x] Deployed sidecar scouts for command-rail implementation, live merge-blocker diagnosis, and next attempt-record learning slice.
- [x] Add metadata-safe command rail to `FleetStatus.nextActions`.
- [x] Render command rail in CLI and Fleet OS web surfaces without adding unsafe web mutations.
- [x] Add focused status/UI regression coverage.
- [x] Add cleared-kind self-heal pruning so stale build rows clear after build commands pass even when later verification is untrusted.
- [x] Verify focused gates, broad lightweight gates, and live command-rail/backlog state.
- [x] Commit and push `c4185d6`, reload launchd daemon, and smoke production status.

## Current Continuation - Attempt Record Coverage
- [x] Rechecked clean production state after command rail: daemon PID `4199`, guard clear, live command rail present.
- [x] Deploy sidecar scout for exact reader APIs and privacy pitfalls.
- [x] Add read-only non-persisted AttemptRecord builder rooted in dispatch-production rows.
- [x] Surface bounded attempt coverage in FleetStatus and CLI.
- [x] Add privacy/join regression coverage, including derived trajectory, worked-ledger time, aggregate ref, and raw execution canaries.
- [x] Verify focused gates and broad lightweight gates.
- [x] Commit and push `a0cc3d2`, reload launchd daemon, and smoke attempt coverage live in FleetStatus.

## Current Continuation - Capture-Gate Repair Queue
- [x] Rechecked clean pushed state, daemon/fleet smoke, and existing proposal-repair maintenance path.
- [x] Deploy sidecar agents for repair queue privacy, daemon integration tests, and live-yield product risk.
- [x] Add metadata-only repair work from recent self capture-gate dispatch-production failures.
- [x] Wire repair result counts through existing daemon maintenance without new merge authority.
- [x] Add focused queue/daemon/privacy tests.
- [x] Verify focused and broad lightweight gates.
- [x] Commit and push `abb7a18`, reload launchd daemon, run live repair scan/backlog refresh, and smoke fleet health.

## Current Continuation - Goal Focus Mode
- [x] Rechecked clean pushed state and current live goal/backlog pressure before editing.
- [x] Deployed sidecar agents for scanner flow, test targets, live state, and createGoal boundary analysis.
- [x] Add a reusable goal-focus detector for repo-bound active goals with pending/in-progress milestones.
- [x] Suppress planning-goal expansion and generative invent enqueue while active goal work is already in flight.
- [x] Surface read-only goal-focus state in FleetStatus and CLI next actions.
- [x] Add focused scanner/invent/status regression coverage.
- [x] Verify focused and broad lightweight gates.
- [x] Commit `34d4233`, push to `origin/master`, reload daemon, refresh backlog, clear stale dead-owner spend guard, and smoke live goal-focus state.

## Current Continuation - Stale Lane Recovery And Fleet OS Truth
- [x] Rechecked repo state, recent commits, Entire state, task plan, notes, and live FleetStatus.
- [x] Deployed scouts for proposal capture, automerge evidence, Fleet OS data quality, and Phantom safe-delegation strategy.
- [x] Used the new command rail manually to inspect and reset the stale Phantom team-vault lane from `in-progress` to `pending`.
- [x] Confirmed live `laneLocks.staleInProgress` dropped from 1 to 0 and the recovery next action disappeared.
- [x] Added `recoverStaleGoalLanes()` as a bounded, idempotent, goal-store-only primitive for stale proposal-less `in-progress` milestones.
- [x] Added `ashlr goals recover-stale [--dry-run] [--max N] [--json]` and pointed FleetStatus next actions at that single recovery command.
- [x] Fixed `laneLocks.lockedVisibleItems` false-zero by reading canonical scanner goal IDs from `WorkItem.tags`.
- [x] Scoped the H8 cleanup meta-test to CONTRACT-reference diff lines so real code changes in swept files are not misclassified as comment-sweep violations.
- [x] Focused verification passed: `m28.store`, `m28.cli`, `m49.fleet-status`, and `h8.cleanup-comment-only` (106 tests), plus typecheck and diff check.
- [x] Broad gates passed: lint, build, audit, and invariants.
- [x] Commit and push `529e155`, reload launchd daemon, and smoke live FleetStatus locked-lane counts.
- [x] Next lane: implement remote protected-base freshness.

## Current Continuation - Evidence Remote Base Freshness
- [x] Rechecked clean pushed state after stale-lane recovery.
- [x] Deployed a Best-of-N file-once scout while implementing the smaller evidence-mode mutation guard locally.
- [x] Added read-only `git ls-remote --heads origin <base>` protected-remote head resolution before evidence-mode PR handoff.
- [x] Fail closed when the protected remote branch moved after verification, even if local `main` and `origin/main` refs are stale.
- [x] Added regression coverage that advances the bare remote from another clone without fetching and proves no PR is opened.
- [x] Focused verification passed: `m315.remote-handoff-truth`, `m153.verification-gate`, `m307.verify-before-judge`, and `m48.automerge-pass` (89 tests), plus typecheck and diff check.
- [x] Broad gates passed: lint, build, audit, and invariants.
- [x] Commit and push `5d9d367`, reload launchd daemon, and smoke live FleetStatus.
- [x] Next lane: Best-of-N file-once proposal capture.

## Current Continuation - Best-of-N File-Once Proposal Capture
- [x] Rechecked clean pushed state after remote-base freshness and resumed local notes.
- [x] Used sidecar scouts to confirm the safe capture shape: hold per-candidate sandboxes, draft-capture diffs, score drafts, then file only the selected winner through `captureSandboxedProposal()`.
- [x] Added `draftOnly` capture support so proposal-shaped drafts reuse the existing scrub, triviality, completeness, diff hash, and provenance pipeline without writing inbox rows or decision-ledger `proposed` entries.
- [x] Changed Best-of-N candidate generation to run candidates with `propose:false` in retained sandboxes, judge draft proposals, final-capture the ranked winner synchronously, and clean up all candidate sandboxes in `finally`.
- [x] Removed loser proposal rejection from Best-of-N; losers now remain metadata-only rows in the Best-of-N ledger with `proposalId:null`.
- [x] Updated model-stats and Best-of-N regression coverage for winner-only filing and race-only loser visibility.
- [x] Focused verification passed: Best-of-N/model-stats suite (26 tests), broader adjacent proposal-production suite (177 tests), and typecheck.
- [x] Broad gates passed: diff check, lint, build, audit, invariants, and full CI (439 files, 9,046 passed tests, 7 skipped).
- [x] Commit and push `ea3701f`, reload launchd daemon, and smoke live FleetStatus.

## Current Continuation - Ephemeral Best-of-N Judge Traces
- [x] Rechecked clean pushed state after Best-of-N file-once rollout and confirmed live daemon/fleet health.
- [x] Deployed sidecar scouts for durable judge/taste side effects and downstream learning/model-stat joins.
- [x] Added an explicit `JudgeProposalOptions.recordTrace` switch so selection-only judging can opt out of durable judge traces.
- [x] Routed Best-of-N candidate scoring through `recordTrace:false`, keeping real manager/automerge proposal judging durable by default.
- [x] Added regression coverage that ephemeral judging leaves no judge-trace row and Best-of-N candidate scoring passes the trace-suppression option.
- [x] Focused verification passed: `m141`, `m333`, `m142`, and `m335` (62 tests), plus typecheck and diff check.
- [x] Adjacent verification passed: manager, judge-trace, Best-of-N, taste critic, model ROI/stats, automerge, and verification-gate suite (217 tests).
- [x] Broad gates passed: lint, build, audit, invariants, diff check, and full CI (439 files, 9,047 passed tests, 7 skipped).
- [x] Commit and push `9bbd42f`, reload launchd daemon, and smoke live FleetStatus.

## Current Continuation - Resource-Feasible Dispatch Yield Status
- [x] Rechecked clean pushed state, Entire state, task plan, notes, and recent fleet status.
- [x] Deployed scouts for dispatch-yield routing/status, learning ledger causality, Fleet OS readiness UI, and Phantom safe-delegation rollups.
- [x] Keep runtime routing unchanged while making FleetStatus dispatch-yield actions resource-feasible.
- [x] Add regression coverage for open installed same-tier alternatives and blocked alternatives.
- [x] Run broad verification.
- [x] Commit `c8ea6ab`, push, reload daemon, and smoke live FleetStatus.

## Current Continuation - Decision Ledger Learning Backfill
- [x] Rechecked clean pushed state after resource-feasible yield rollout.
- [x] Deployed sidecar scouts for Lease Board UI and Phantom fleet rollup readiness.
- [x] Normalize legacy decision rows on read through the causal learning scrubber.
- [x] Add regression coverage for trajectory/label/epoch backfill, secret scrubbing, raw-field dropping, and measurement preservation.
- [x] Run broad verification.
- [x] Commit `b31bde5`, push, reload daemon, and smoke live FleetStatus.

## Current Continuation - Fleet OS Lease Board
- [x] Rechecked clean pushed state after decision-ledger rollout.
- [x] Deployed sidecar scouts for stale pending production-velocity and evidence-pack base/diff binding.
- [x] Add an inline Fleet Dashboard Lease Board from existing shared queue per-machine health.
- [x] Add static UI and snapshot contract coverage for per-machine lease fields.
- [x] Run focused, broad, and invariant verification.
- [x] Commit `884efa8`, push, reload daemon, and smoke status.

## Current Continuation - Evidence Pack Base/Diff Binding
- [x] Rechecked clean pushed state after Lease Board rollout.
- [x] Deployed sidecar scouts for stale pending TTL, evidence binding, and proposal-production yield.
- [x] Persist verification base, diff, freshness, and source metadata into autonomy evidence packs.
- [x] Fail closed for evidence-mode main policy when persisted evidence lacks command, base, diff, timestamp, source, or matching diff-hash metadata.
- [x] Refuse stale protected remote base before persisting an allowed evidence pack.
- [x] Add policy and remote-handoff regression coverage.
- [x] Finish focused, broad, invariant, and full-CI verification.
- [x] Commit `8a85909`, push, reload daemon, and smoke status.

## Current Continuation - TITRR Terminal Capture Yield
- [x] Rechecked clean pushed state after evidence binding rollout.
- [x] Deployed sidecar scouts for TITRR budget control flow and downstream proposal-disabled semantics.
- [x] Add final capture for budget-exhausted TITRR terminal runs from the existing shared sandbox.
- [x] Reuse captured proposal metadata so stale producer `proposal-disabled` summaries cannot survive terminal capture.
- [x] Strengthen TITRR regression coverage for budget-exhausted stale producer metadata becoming captured `empty-diff` metadata.
- [x] Run focused, broad, and invariant verification.
- [x] Finish full CI.
- [x] Commit `8c01966`, push, reload daemon, and smoke status.

## Current Continuation - Production Velocity Stale Pending Unblock
- [x] Rechecked clean pushed state after TITRR terminal-capture rollout.
- [x] Deployed sidecar scouts for stale-pending mechanics, proposal-yield promotion, and explicit merge-contract rollout.
- [x] Centralize production-velocity stale pending filtering for backlog coverage only.
- [x] Keep proposal counts truthful while allowing TTL-stale pending proposals to stop suppressing matching queue work.
- [x] Wire the shared filter through backlog dedup, FleetStatus eligibility, and daemon selection.
- [x] Add focused regression coverage for helper, backlog, status, daemon selection, resource-strategy, and queue-drain behavior.
- [x] Run focused, broad, and invariant verification.
- [x] Finish full CI.
- [x] Commit `0238939`, push, reload daemon, and smoke status.

## Current Continuation - Dispatch Yield Readiness Promotion
- [x] Rechecked clean pushed state after stale-pending rollout and resumed local notes.
- [x] Deployed sidecar scouts for dispatch-yield promotion, explicit merge-contract rollout, and proposal-disabled operator diagnostics.
- [x] Promote actionable dispatch-yield diagnostics above the generic proposal-production-needed readiness blocker.
- [x] Sort `inspect-dispatch-yield` ahead of generic `build-backlog` when both are medium-priority next actions.
- [x] Add FleetStatus regression coverage for next-action ordering, Autonomous Ship Readiness blocker, and Mission Brief directive.
- [x] Finish broad verification.
- [x] Commit, push, reload daemon, and smoke status.
- [ ] Next lane: make explicit merge-contract rollout repo-aware and visible enough to close missing contracts across enrolled repos.

## Current Continuation - Repo-Aware Merge Contract Backlog
- [x] Rechecked clean pushed state after dispatch-yield rollout and reviewed recent backlog/scanner commits.
- [x] Deployed sidecar review for repo-aware backlog dedupe risks.
- [x] Make first-pass backlog id/title dedupe repo-aware with full resolved repo paths.
- [x] Preserve same-repo duplicate collapse while allowing identical rollout titles across different repos.
- [x] Add focused backlog regressions for multi-repo merge-contract rollout items.
- [x] Finish broad verification.
- [x] Commit, push, refresh backlog, reload daemon, and smoke live contract coverage.

## Current Continuation - Operator Diagnostic Reason Hygiene
- [x] Rechecked live backlog/service state after repo-aware merge-contract rollout.
- [x] Deployed sidecar audits for CLI/status paths, web/dashboard paths, and next learning telemetry lane.
- [x] Preserve raw dispatch-production reasons while adding diagnostic-only reason summaries for operator surfaces.
- [x] Suppress all `proposal filing disabled` control-flow variants, including API-model wording, from proposal/dispatch diagnostics.
- [x] Update CLI, Mission Control, Fleet, and Fleet Dashboard production surfaces to treat empty diagnostic reason arrays as authoritative.
- [x] Add focused regressions for raw-vs-diagnostic dispatch reasons, all-suppressed proposal windows, and dashboard source contracts.
- [x] Finish focused, broad, invariant, and full-CI verification.
- [x] Commit, push, reload daemon, smoke live diagnostic output, and continue into diagnostic/learnable attempt classification.

## Current Continuation - Diagnostic Attempt Learning Classification
- [x] Rechecked dirty worktree, recent commits, Entire state, task plan, notes, and current diagnostic classification diff.
- [x] Integrated scout audits for attention eval, attempt records, workspace summaries, and Fleet OS operator surfaces.
- [x] Add shared metadata-only attempt learning classification with policy-suppressed, diagnostic no-proposal, failed, blocked, and proposal-created kinds.
- [x] Thread diagnostic learning fields through attention eval, agent workspace summaries, attempt coverage, CLI status, API payloads, Mission Control, Fleet, and Fleet Dashboard.
- [x] Preserve raw no-proposal counters while making operator surfaces prefer diagnostic no-proposal and split policy suppression explicitly.
- [x] Add focused regressions for policy-disabled control flow, empty-diff diagnostics, failed/sandbox-failed non-diagnostics, privacy canaries, and status/API/web contracts.
- [x] Finish focused, broad, invariant, and full-CI verification.
- [x] Commit, push, reload daemon, smoke live fleet status, and continue into the next highest-leverage overnight lane.

## Current Continuation - Explicit Merge Contract Wave 1
- [x] Rechecked Hub, BinShield, and Pulse git states and repo instructions.
- [x] Add explicit merge-grade `ashlr.verify.json` to clean core-fleet repos `binshield` and `ashlr-pulse`.
- [x] Keep the slice manifest-only: no package scripts, lockfiles, CI, or app code changes.
- [x] Verify BinShield `pnpm run typecheck`, `pnpm run lint`, and `pnpm run test`.
- [x] Verify Pulse server `bun run typecheck` and `bun run test`.
- [x] Verify Pulse agent `cargo check` and deterministic `cargo test -- --test-threads=1`.
- [x] Run Hub repo-profile/backlog/status/merge regression coverage.
- [x] Commit and push both sibling repo manifests, refresh Hub backlog, and smoke live contract coverage.

## Current Continuation - Versioned Attempt Learning Labels
- [x] Rechecked dirty Hub state, recent commits, Entire state, persistent plan/notes, and current attempt-label diff.
- [x] Deployed sidecar scouts for label semantic risk, next high-leverage learning lane, and explicit contract rollout candidates.
- [x] Persist authoritative versioned `learningLabel` metadata on new dispatch-production writes while preserving legacy rows without invented durable labels.
- [x] Sanitize label payloads on read/write and drop raw prompt, diff, stdout, stderr, env, file contents, and hostile extra fields.
- [x] Thread durable labels through dispatch-production summaries, agent-action workspace summaries, attempt coverage, attention eval, daemon dispatch traces, and agent-action terminal records.
- [x] Preserve raw outcome/no-proposal counters while using labels for learning shape, policy suppression, diagnostic no-proposal, and diagnostic reason aggregation.
- [x] Add focused regressions for hostile labels, legacy fallback, contradictory raw signals, workspace/eval/coverage counts, and secret-safety invariants.
- [x] Finish final full CI.
- [x] Commit, push, reload daemon, and smoke live label readiness.
- [x] Next lane selected: epoch-gated learned routing from authoritative current-policy labels.

## Current Continuation - Epoch-Gated Learned Routing
- [x] Rechecked clean pushed state, Entire state, live FleetStatus, and learned-router tests.
- [x] Deployed sidecar scouts for learned-router mapping and safety constraints.
- [x] Require dispatch-yield route mutation to use valid authoritative attempt labels, current router policy version, matching learning epoch, and no routeSnapshot policy disagreement.
- [x] Exclude policy-suppressed labels and stop using freeform dispatch reasons in route-changing learned-yield decisions.
- [x] Add focused regressions for legacy rows, old policy rows, invalid classifier labels, stale epochs, policy-suppressed labels, and policy-version disagreement.
- [x] Run focused and adjacent router/daemon/gateway/resource/status verification.
- [x] Run broad verification.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Comparative Learned Routing Gate
- [x] Rechecked clean state after epoch-gated routing rollout and safety-scout findings.
- [x] Deploy sidecar scouts for resource-state follow-up and comparative test coverage.
- [x] Require same-tier learned reroute candidates to have their own current-label eligible samples, meet the proposal-yield threshold, and beat the base backend by a margin.
- [x] Preserve same-tier/allowed/installed/non-builtin constraints and metadata-only route reasons.
- [x] Add focused regressions for no blind unknown alternate and positive comparative candidate yield.
- [x] Run focused and adjacent router/daemon/gateway/resource/status verification.
- [x] Run broad verification.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Resource-Aware Learned Target Gate
- [x] Rechecked dirty Hub state, recent commits, Entire state, task plan, notes, and current resource-aware routing diff.
- [x] Deployed sidecar scouts for learned-router safety, gateway integration coverage, and next high-leverage fleet lanes.
- [x] Pass resource snapshots into learned routing as explicit input so same-tier learned reroutes only target `open` or `near` backends when resource-aware gateway mode is active.
- [x] Preserve direct `recommendRoute()` callers by keeping missing resource state permissive unless a caller explicitly provides a snapshot.
- [x] Keep final gateway resource demotion fresh after learned/budget routing so `recordBackoff()` cache invalidations during routing are observed before dispatch.
- [x] Add pure learned-router and gateway integration regressions for open/near, unavailable, missing-snapshot, and mid-decision backoff cases.
- [x] Run focused and adjacent router/daemon/gateway/resource/status verification.
- [x] Run broad verification.
- [x] Commit, push, reload daemon, and smoke live status.
- [x] Next lane: implement diagnostic no-diff reslice queue so empty-diff attempts generate better-shaped follow-up work instead of only telemetry.

## Current Continuation - Diagnostic No-Diff Reslice Queue
- [x] Rechecked clean pushed state after resource-aware routing rollout and live proposal-starved fleet status.
- [x] Attempted to deploy another explorer wave; agent pool was saturated, so continued locally using prior scout findings and code audit.
- [x] Extend proposal repair maintenance to queue metadata-only diagnostic reslice work for recent `empty-diff` dispatch-production events.
- [x] Add a narrow self-heal trust path for generated diagnostic reslice items without requiring fake compiler/test failures.
- [x] Surface no-diff reslice maintenance counters on daemon ticks.
- [x] Harden the diagnostic trust path so hand-written lookalikes are not rehydrated as actionable self-heal work.
- [x] Run focused regression coverage.
- [x] Run broad verification.
- [x] Commit, push, reload daemon, and smoke live status.
