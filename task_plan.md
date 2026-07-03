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
**Current batch in final verification** - The repo execution-profile/resource-routing batch is committed and pushed; the active follow-up adds ranked fleet next actions, richer resource visibility, and a stricter judge `wouldMerge` trust contract.

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
- [ ] Commit, push to `origin/master`, and verify live daemon/fleet status.

## Current Continuation
- [x] Rechecked git/daemon/fleet state after the previous push.
- [x] Deployed fresh explorer agents on daemon refill, fleet/backlog persistence, and cross-repo discovery.
- [x] Found live fleet status showing zero backlog because persisted `backlog.json` was a stale temp-test snapshot while real self-heal work lived in `~/.ashlr/self-heal-queue.json`.
- [x] Added a shared read-only queued-autonomy reader and wired it into `fleet status`, daemon cached backlog counts, and the queued autonomy scanner.
- [x] Prevented daemon verification commands from writing into production `HOME`/`~/.ashlr` by giving each verify subprocess an isolated temp HOME.
- [x] Prevented explicit subset/temp `buildBacklog({ repos })` scans from clobbering the global fleet backlog snapshot unless the caller opts into `persist:true`.
- [x] Fixed daemon singleton lock recovery so a dead-owner lock with a fresh heartbeat does not block service restart.
- [x] Verified live patched `bin/ashlr fleet status --json` now reports 13 backlog items across 9 repos and `autonomyDirection.mode:"backlog-build"` instead of an empty queue.
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
