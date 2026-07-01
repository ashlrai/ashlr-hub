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
- Local-only autonomy mode now preserves the first-class `local-coder` backend instead of collapsing it to `builtin`, keeping the free local coding workhorse available when frontier resources are constrained.
- Daemon ticks, Mission Control logs, and Fleet Activity now show applied direction reason and auto-merge maintenance attempted/judged/merged counts; Mission Control distinguishes the active applied mode from the current recommended direction.

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

## Status
**Current batch verified locally** - Autonomy control observability, cheap daemon strategy planning, local-coder local-only routing, and Mission Control active/recommended direction visibility are implemented and verified; preparing commit/push.
