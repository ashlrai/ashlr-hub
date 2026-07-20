# Task Plan: Ashlr Autonomous Fleet Ambition Push

## Current Stack Integration Cycle
- [x] Add bounded parent-evidence quarantine diagnostics without changing repair-generation authority.
- [x] Merge protected PR #30 with exact-head authority and preserve its merge tree.
- [x] Diagnose post-merge Ubuntu failures as expired test fixtures, with macOS and all Windows lanes green.
- [x] Port only the five time-stability fixture repairs from the already-green source-revision branch.
- [x] Verify 261 focused tests, typecheck, scoped lint, build, dependency audit, and diff checks locally.
- [x] Land protected fixture hotfix PR #56 and require a green five-job post-merge master run.
- [x] Merge master into PR #31, retarget it, require fresh exact-head and post-merge CI, and merge it normally.
- [x] Retarget and merge PR #32 with fresh exact-head and post-merge CI.
- [x] Retarget and merge PR #33 with the verified M402/M49 resolution and fresh exact-head/post-merge CI.
- [x] Finish timeout-only PR #34 with 12/12 exact-head checks, verified merge-tree authority, and green six-job post-merge run `29553196281`.
- [x] Retarget and merge source-complete policy PR #36 with exact-head and post-merge authority.
- [x] Retarget and merge safe-minimum policy PR #38 with exact-head and post-merge authority.
- [x] Retarget and merge signed evidence-pack PR #39 with exact-head and post-merge authority.
- [x] Retarget and merge signed-evidence activation PR #40 with exact-head and post-merge authority.
- [x] Retarget and merge evidence-health PR #41 with 12/12 exact-head and six-job post-merge authority.
- [x] Retarget and merge causal-identity PR #42 with exact-head and six-job post-merge authority.
- [x] Retarget and merge operational-projection PR #43 with rerun-backed exact-head and six-job post-merge authority.
- [x] Retarget and merge projection-transaction PR #44 with exact-head and six-job post-merge authority.
- [x] Retarget and merge projection-replay-ledger PR #45 with rerun-backed exact-head and six-job post-merge authority.
- [x] Retarget and merge bounded-agent-events PR #46 with rerun-backed exact-head and six-job post-merge authority.
- [ ] Retarget and merge independent-review-policy PR #47, then continue #48-#53, #35, and #37.
- [ ] Keep production auto-merge and canary enforcement disabled until the integrated immutable release passes activation preflight.

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
- [x] Follow-up: Fast-track healthy generated repair recovery into queue selection and Fleet OS visibility
- [x] Follow-up: Add selection-phase global workspace telemetry for recursive repair learning
- [x] Follow-up: Add prompt-trackr explicit merge-grade verification contract
- [ ] Follow-up: Set valid Raycast author account for publish validation
- [x] Follow-up: Repair signed-evidence v3 protected CI fixture and verifier-runtime failures

## Key Questions
1. What prevents Ashlr Hub from acting as a reliable always-on engineering fleet today?
2. Which surrounding Ashlr repos are key infrastructure versus abandoned experiments?
3. What should be built into Mission Control so the system feels operationally useful every day?
4. What risks would make 24/7 autonomy dangerous, expensive, noisy, or untrustworthy?
5. What can be improved immediately in this repo without destabilizing the pushed baseline?
6. How can Ashlr continuously choose the highest-value safe work without Mason as the bottleneck?
7. How can Ashlr spend scarce judge/frontier/model resources only after cheap facts say a candidate is mergeable?

## Current Overnight Cycle - Protected Remote Authority
- [x] Rehydrate branch protection, production daemon, auto-merge pause, open proposals, GitHub issues, and isolated worktrees.
- [x] Upgrade Vitest to 4.1.10, restore isolation compatibility, pass the 10,647-test cross-platform matrix, and merge protected PR #26.
- [x] Require exact configured and force-fresh live protection for every remote-to-main trust basis.
- [x] Bind staging pushes, PR auto-merge, persisted handoffs, and host reconciliation to one deterministic expected head OID.
- [x] Make ambiguous PR retries and crash-left local refs reconstructable without overwriting or deleting replacement refs.
- [x] Project bounded live protection, freshness, configuration quality, and branch/main authority lanes into Fleet Status.
- [x] Add adversarial coverage for invalid config, stale/unavailable protection, mixed lanes, remote replacement, retry adoption, and reconciliation mismatch.
- [x] Rebase on merged Vitest 4 master; run definitive full verification and final adversarial review.
- [ ] Commit, push, open protected PR, observe all required checks, and keep production auto-merge disabled pending post-merge canary evidence.

## Current Overnight Cycle - Fleetwide Merge Contracts
- [x] Rehydrate the deployed Hub, daemon, guard, queue, and verifier-coverage state.
- [x] Audit the five remaining repositories without explicit merge contracts in parallel.
- [x] Enforce `quick|merge|deep` command profiles and repo-declared timeouts in the sandbox verifier.
- [x] Add repo-owned merge contracts to sales pipeline, ashlr-md, ashlr-plugin, ashlrcode, and morphkit.
- [x] Run focused repository gates plus Hub profile/status regression coverage.
- [x] Commit and push only cycle-owned files, deploy Hub changes, and record live coverage truth.

## Current Overnight Cycle - Required Diff Recovery
- [x] Rehydrate the deployed 24/24 contract baseline, daemon, queue, yield telemetry, and Entire state.
- [x] Audit empty-diff production, diagnostic reslicing, routing, red verifier baselines, and causal-data gaps in parallel.
- [x] Treat an explicitly required but known-empty diff as a bounded TITRR retry condition.
- [x] Preserve budget, sandbox, capture, provenance, and merge authority while recording truthful terminal outcomes.
- [x] Run focused/full verification, adversarial review, commit, push, reload, and production smoke.

## Current Overnight Cycle - Windows Fleet Durability
- [x] Rehydrate current release state and isolate the Windows persistence failure mode.
- [x] Centralize platform-aware directory durability without weakening file fsync or POSIX checks.
- [x] Migrate every active durability point, including synced agent-action and signed post-merge writes.
- [x] Split Windows CI into three isolated serial shards and harden the watchdog against surviving descendants.
- [x] Require exact GitHub check context plus App identity without auto-rejecting proposals for operator config drift.
- [x] Add signed observation-only post-merge outcomes and join judge-free merges into causal trajectories.
- [x] Persist host merge SHAs, require local ancestry before attribution, and make observation durability precede learning side effects.
- [x] Wire regression-sentinel outcomes into the learning graph as explicitly heuristic until parent-green proof exists.
- [x] Run focused/full verification and three independent adversarial reviews; close every reported P1.
- [x] Commit, push, watch all Ubuntu/Windows CI jobs, reload production, and record the live result.

## Current Overnight Cycle - Fair Post-Merge Observation
- [x] Rehydrate the deterministic-attribution release and audit remaining positive-outcome authority gaps.
- [x] Make post-merge scans observation-only and remove legacy heuristic routing authority.
- [x] Add strict bounded proposal enumeration and fail closed on incomplete production provenance.
- [x] Add durable CAS-protected cursors for outcome candidates and enrolled-repository regression rotation.
- [x] Add signed stable-window witness batches with global cohort replay detection and explicit non-authority.
- [x] Surface post-merge source quality and denominator incompleteness without changing operational readiness.
- [x] Close adversarial test gaps, run focused and exhaustive verification, commit, push, and reload production.

## Current Overnight Cycle - Production Stability Proofs
- [x] Rehydrate the released observation baseline and audit the missing production proof path.
- [x] Persist authoritative GitHub merge timestamps without fabricating or erasing host time.
- [x] Expose current-checkout green verification as explicitly observation-only, bound to one unchanged clean HEAD and one canonical required-command manifest.
- [x] Extract a bounded, HEAD-stable complete-window inspector for reverts and overlapping fixes.
- [x] Wire observation-only stability witness production from strict historical merge evidence.
- [x] Define the first fail-closed Windows DACL assurance slice for provenance and new private stores.
- [x] Run exhaustive verification, complete adversarial review, update durable notes, commit, push, and reload production.

## Current Overnight Cycle - Stable-Window Witness Production
- [x] Rehydrate the released stability-observation baseline, CI proof, production health, git state, Entire state, and durable notes.
- [x] Audit detached-worktree verification, strict applied-merge population capture, signed cohort persistence, and Windows private-storage assurance in parallel.
- [x] Wire a bounded observation-only stability producer from strict complete-window merge evidence without granting routing or merge authority.
- [ ] Bind every attempted population member to an explicit stable, adverse, or inconclusive classification with replay-safe identity and metadata-only persistence.
- [x] Preserve fail-closed source quality, cursor fairness, command-manifest integrity, and policy non-authority across restarts and concurrent scans for the observation-only v1 slice.
- [x] Add adversarial population, timing, replay, privacy, partial-write, and compatibility coverage for the observation-only v1 slice.
- [x] Run focused and exhaustive verification plus independent review; update notes, commit, push, observe CI, reload production, and preserve fail-closed canary truth when no receipt-qualified merge exists.

## Current Overnight Cycle - Windows Reconciliation Key Assurance
- [x] Rehydrate the released stable-witness baseline, production truth, CI state, git state, Entire state, and durable notes.
- [x] Audit denominator-v2, detached-worktree proof, and Windows private-storage blockers in parallel.
- [x] Add a fixed-program JSON-stdin Windows ACL adapter with exact SID/ACE readback and bounded fail-closed execution.
- [x] Store the reconciliation key under a dedicated protected directory and assure an exclusive empty file before writing secret bytes.
- [x] Add injected and native Windows adversarial tests, and pin the assurance suite into the portability matrix.
- [x] Run focused and exhaustive verification plus independent review; update notes, commit, push, observe CI, reload production, and canary fail-closed behavior.

## Current Overnight Cycle - Denominator-Complete Population Accounting
- [x] Rehydrate the released Windows-key baseline, CI proof, production health, git state, Entire state, and durable notes.
- [x] Audit strict applied-merge population capture, replay-safe v2 classification persistence, and detached-worktree proof sequencing in parallel.
- [x] Implement the smallest bounded metadata-only v2 candidate population/classification slice with adverse precedence and explicit inconclusive members.
- [x] Keep `policyEligible:false`; refuse incomplete, degraded, stale, conflicting, or over-limit sources rather than certifying a partial denominator.
- [x] Add adversarial cutoff snapshots, historical replay identity, source bounds, privacy, and v1 compatibility coverage.
- [ ] Add authenticated strict snapshot readers, then signed witness/root persistence with crash recovery and status projection before setting `denominatorComplete:true`.
- [x] Run focused and exhaustive verification plus independent review; update notes, commit, push, observe CI, reload production, and verify observation-only truth.

## Current Overnight Cycle - Authenticated Cutoff Snapshot Primitives
- [x] Rehydrate the released candidate-accounting baseline, CI proof, production health, git state, Entire state, and durable notes.
- [x] Audit enrollment, proposal, adverse-observation, and stability snapshot boundaries in parallel.
- [x] Define one bounded metadata-only authenticated observation envelope using existing POSIX provenance authority.
- [x] Implement a bracketed enrollment/default-branch producer with source, repository, and Git-metadata identity binding.
- [x] Keep exact cutoff authority false and candidate accounting unwired with `policyEligible:false` and `denominatorComplete:false`.
- [x] Add adversarial tamper, race, replay, bounds, privacy, and compatibility coverage.
- [x] Run focused/exhaustive verification and independent review; update notes, commit, push, observe CI, reload production, and canary unchanged authority.

## Current Overnight Cycle - Proposal Store Global Writer Integrity
- [x] Rehydrate the authenticated-observation release, CI proof, production health, git state, Entire state, and durable notes.
- [x] Audit proposal writer inventory, historical ordering, filename identity, outward-action races, and filesystem threats in parallel.
- [x] Add a store-wide cross-process persistence fence outside the replaceable inbox directory while retaining proposal-scoped authority locks.
- [x] Bind committed filenames, requested IDs, embedded IDs, and persistence destinations; move compatibility loads onto bounded no-follow reads.
- [x] Harden durable installation with collision refusal, high-entropy IDs, private random exclusive temps, complete writes, identity checks, and file/directory sync.
- [x] Run focused/exhaustive verification and independent review; update notes, commit, push, observe CI, reload production, and canary unchanged authority.

## Current Overnight Cycle - Durable Cutoff Observation Checkpoints
- [x] Rehydrate the authenticated-observation and proposal-integrity releases, production truth, CI state, git state, Entire state, and durable notes.
- [x] Audit signed-ledger durability, provenance boundaries, and status integration in parallel.
- [x] Add an append-ordered HMAC chain plus root-last authenticated release boundary for complete enrollment observations.
- [x] Recover missing roots, fsynced orphan rows, torn tails, and partial genesis writes without releasing unauthenticated data.
- [x] Keep checkpoint evidence observation-only and statically unwired from population, routing, readiness, merge, daemon, and policy authority.
- [x] Cover maximum valid captures, replay, tamper, wrong keys, unstable providers, permissions, and crash recovery with focused tests.
- [ ] Add authenticated rotation/retention and an external monotonic anchor before treating the bounded ledger as rollback-resistant historical authority.
- [x] Project checkpoint freshness into a separate observation-only FleetStatus surface after role-based forensic exclusion is implemented.
- [x] Commit, push, observe CI, reload production, and record unchanged cutoff/population/merge authority.

## Current Overnight Cycle - Cutoff Observation Fleet Visibility
- [x] Rehydrate the released checkpoint baseline, CI proof, production health, git state, Entire state, and durable notes.
- [x] Deploy disjoint audits for production capture cadence, observation-only Fleet OS projection, and authenticated rotation/anchoring.
- [x] Add a separate cutoff-checkpoint status with signed-source freshness and literal non-authority fields.
- [x] Make forensic evidence exclusion role-based and prevent missing/degraded sources from rendering as healthy zero rows.
- [x] Prove checkpoint state cannot change readiness, mission, effectiveness, direction, actions, routing, or merge authority.
- [x] Keep production capture scheduling separate until its detached child-process budget and restart-safe cadence are independently proven.
- [x] Run focused/exhaustive verification and independent review; update notes, commit, push, reload, and canary truthful visibility.

## Current Overnight Cycle - Detached Cutoff Observation Capture
- [x] Rehydrate the released visibility baseline, production health, git state, Entire state, and durable notes.
- [x] Deploy disjoint audits for daemon integration, detached-process safety, restart-safe cadence, and deterministic verification seams.
- [x] Add a Unix-only detached capture child with no inherited stdio, a 30-second parent deadline, single-flight execution, and bounded shutdown cancellation.
- [x] Persist private metadata-only cadence state with a 24-hour success interval and one-hour failure retry floor.
- [x] Schedule capture only after durable resident daemon ticks; exclude dry-run, once, persistence-failed, killed, and unsupported execution.
- [x] Surface capture health without granting cutoff, denominator, historical, rollback, routing, readiness, or merge authority.
- [x] Add cadence, restart, overlap, timeout, cancellation, malformed-state, privacy, platform, failure, replay, and authority-isolation coverage.
- [x] Run focused/exhaustive verification and independent review; update notes, commit, push, reload, and canary the first production checkpoint.

## Current Overnight Cycle - Actionable Dispatch Yield Recovery
- [x] Rehydrate the released capture baseline, production health, git state, Entire state, and durable notes.
- [x] Audit partial-capture causes, issue-route yield, queued repair coverage, and repair scheduling fairness in parallel.
- [x] Select one metadata-grounded intervention that improves mergeable proposal yield without weakening completeness or verification gates.
- [x] Implement bounded causal telemetry and/or recovery behavior with authority isolation and privacy preserved.
- [x] Add no-proposal, partial-capture, retry, fairness, and learning regressions.
- [x] Run focused/exhaustive verification and independent review; update notes, commit, push, reload, and canary improved production truth.

## Current Overnight Cycle - Repair Corpus Completeness
- [x] Rehydrate the dispatch-yield recovery release and inspect the first production repair attempts.
- [x] Audit rejected artifact materialization, physical queue source quality, and post-release proposal yield in parallel.
- [x] Make real machine-persisted capture mismatches eligible under exact lineage, timing, and non-human predicates.
- [x] Bound derived goal display titles and refuse invalid outgoing backlog snapshots without dropping authoritative goal data.
- [x] Run exhaustive verification and independent review; commit, push, reload production, and prove all eligible mismatch repairs materialize with a complete queue source.
- [x] Next lane: design and implement evidence-only objective-saturation quarantine after three unique empty attempts across two same-tier editing backends.

## Decisions Made
- Use multiple agents because the user explicitly asked for broad parallel exploration and maximum ambition.
- Keep current hub `master` clean and synced as baseline; new work should be incremental and verified before pushing.
- Empty-diff recovery stays in the same sandbox/backend/model and shares one cumulative token/step budget; missing usage consumes a conservative fallback step.
- Adaptive prompts must reach sandboxed API-model executors so production local coders receive the existing diff-quality role contract.
- Generated no-diff reslices need parent-context/tier preservation before broader frontier routing; stale reslices must not be coerced into cosmetic edits.
- Morphkit and Ashlr MD are not merge-green despite valid contracts: both have frozen-lock CI failures, and their dirty local worktrees remain untouched pending dedicated repair lanes.
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
- Windows portability 3/3 exposed a timing-only failure in the new 30-candidate paging fixture; production behavior passed, but the test retained Vitest's 5-second default. Raised only that integration test to the existing 30-second git-fixture budget.
- Entire is not set up for this repo; `entire resume master` has no checkpoint.
- Full serial Vitest can hang after many tests with one worker alive; mitigated with `scripts/test-ci.mjs` watchdog for CI/publish gates.
- Full CI initially exposed two stale auto-merge test expectations: default tier frontier proposals no longer get a pass-level judge, and evidence-mode explainer fixtures now need a diff-bound verification hash. Updated tests and reran affected suites plus full CI.
- Bounded diagnostic drain status test initially used a fixed `2026-07-03` tick outside the recent-window cutoff on July 9; switched it to the current test timestamp and reran focused M201/M49 tests.
- Source smoke initially used top-level await in `tsx -e`, which emits CommonJS; reran with an async IIFE.
- Direct `buildFleetStatus()` smoke initially omitted its required config; reran with `loadConfig()` and confirmed the corrected live 24-hour trajectory denominator is 129.
- Full CI exposed seven legacy M245 integration fixtures that bypassed the new authoritative proposal/evidence gate plus one credential-free NIM expectation in M344. Updated the fixtures to persist matching applied proposals/evidence and provide a scoped fake NIM credential; affected suites pass 75/75.

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

## Current Continuation - Verification Contract Coverage Visibility
- [x] Rechecked git, Entire, recent commits, task plan, notes, and existing FleetStatus coverage.
- [x] Deployed sidecar scouts for explicit contract rollout, Phantom integration, and next Hub autonomy gaps.
- [x] Make missing merge-contract status/action samples include project kind and reason.
- [x] Promote explicit merge-contract rollout from low-priority hygiene to medium-priority ship-readiness work.
- [x] Run focused verification.
- [x] Commit, push, reload/smoke production daemon, and choose the next overnight lane.
- [x] Add one validated clean-repo explicit contract in `ashlr WM` and record push blocker.

## Current Continuation - Causal Label Gap Diagnostics
- [x] Closed sidecar scouts and selected the next Hub autonomy/learning lane.
- [x] Inspect attempt coverage schema/tests and design metadata-only gap groups.
- [x] Implement grouped causal label diagnostics in attempt coverage and Fleet OS action text.
- [x] Add focused regression coverage.
- [x] Verify implementation with focused, adjacent, invariant, and full CI gates.
- [x] Commit, push, and reload/smoke production daemon.
- [x] Refine causal diagnostics with policy-suppressed-aware actionable causes.
- [x] Push actionable-cause refinement and confirm live FleetStatus surfaces current-writer unlabeled gaps.
- [x] Surface degraded/unknown Fleet Dashboard data-quality sources in the Data pill.
- [x] Name affected readiness sources in the Fleet Dashboard Data pill and tooltip.
- [x] Add proposal-derived causal metadata to auto-merge judge decisions and verification lifecycle actions.
- [x] Fail closed on Phantom placeholder tokens in in-process provider key resolution.

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

## Current Continuation - Explicit Merge Contract Wave 2
- [x] Rechecked live FleetStatus and selected clean sibling repos without in-progress dirty work.
- [x] Added root `ashlr.verify.json` manifests to `ashlr-auth`, `ashlr-cli-common`, `ashlr-config`, `ashlr-cost`, and `ashlr-mcp-kit`.
- [x] Verified each package with `bun run typecheck`, `bun run test`, and `bun run build`.
- [x] Corrected manifest command kinds to the current Hub schema (`typecheck|test|lint`) after parser validation rejected `kind:"build"`.
- [x] Committed the manifest wave locally in each sibling repo.
- [x] Refreshed Hub backlog/profile cache and confirmed explicit merge contracts increased from 3/24 to 8/24.
- [x] Record and commit the rollout notes in Hub.

## Current Continuation - Explicit Merge Contract Wave 3
- [x] Audited remaining repos and skipped dirty app repos to avoid trampling in-progress work.
- [x] Found and fixed stale Homebrew detection: current `brew audit` refuses path arguments and name audit depends on trusted taps, so inferred Homebrew verification now uses deterministic `ruby -c` syntax checks only.
- [x] Added explicit merge contracts to clean repos `homebrew-ashlr`, `homebrew-phantom`, and `openclaw-setup`.
- [x] Verified Homebrew formulas with `ruby -c` and `openclaw-setup` with `python -m pytest -q`.
- [x] Pushed `homebrew-phantom`; kept `homebrew-ashlr` local because no remote is configured and kept `openclaw-setup` local because it had pre-existing unpushed work.
- [x] Refreshed Hub backlog/profile cache and confirmed explicit merge contracts increased from 8/24 to 11/24.
- [x] Commit and push the Hub detector/rollout notes.

## Current Continuation - Generated Queue Work Visibility
- [x] Rechecked dirty Hub state after merge-contract wave 3 and resumed from the generated-work observability WIP.
- [x] Cleared completed sidecar agents and redeployed fresh scouts for proposal-yield readiness, merge-contract rollout, Phantom opportunities, and Fleet OS visibility.
- [x] Add read-only FleetStatus `queue.generatedWork` counts for self-heal, proposal-repair, diagnostic no-diff reslice, and invent work.
- [x] Render generated queue counts in `ashlr fleet status` so operators can see whether repair work is actually queued.
- [x] Add focused FleetStatus/CLI formatter regression coverage.
- [x] Run focused and broad verification.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Generated Work Web Visibility
- [x] Rechecked clean pushed state after generated queue status rollout.
- [x] Used Fleet OS sidecar findings to confirm the shared `FleetStatus` contract already feeds API/SSE/snapshot surfaces.
- [x] Render generated repair/no-diff work in Fleet summary, Mission Control hero metrics, and Fleet Dashboard readiness rail.
- [x] Add static web-surface and dashboard snapshot regression coverage.
- [x] Run focused web/status verification.
- [x] Run final gates.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Frontier Route No-Diff Reslices
- [x] Rechecked clean pushed state after generated-work web visibility.
- [x] Used proposal-yield scout findings to identify generated no-diff repair reslices being routed as local-mid self-work.
- [x] Add narrow router classification for generated `proposal-repair` + `dispatch-no-diff-reslice` work so frontier routes handle the reslice when available.
- [x] Preserve normal workhorse routing for ordinary low-score self work and fallback behavior when no frontier backend is installed.
- [x] Add route regression coverage and run adjacent concurrent/workhorse/resource dispatch suites.
- [x] Run final gates.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Daemon Active Tick Freshness
- [x] Investigate stale daemon tick after launchd kickstart.
- [x] Confirmed launchd process was alive and heartbeating while engines were running, but `lastTickAt` only records completed ticks.
- [x] Extend FleetStatus daemon state with `startedAt`, `lockHeartbeatAt`, and first-tick `tickInProgress`.
- [x] Make Autonomous Ship Readiness use the live daemon heartbeat as freshness evidence while preserving the last completed tick detail.
- [x] Render daemon start, active tick, and heartbeat in CLI fleet status.
- [x] Add focused FleetStatus and formatter regression coverage.
- [x] Run final gates.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Capture-Missing Learning Signal
- [x] Rechecked clean pushed state and deployed/read three scout agents for proposal-disabled, Phantom, and context-efficiency lanes.
- [x] Trace daemon-required TITRR failure path where internal `propose:false` attempts can end before final proposal capture.
- [x] Reclassify only required terminal capture-missing dispatches from `proposal-disabled` to `proposal-capture-error`.
- [x] Extend attempt-shape classification with reason metadata so `capture-missing` is diagnostic while normal `proposal-disabled` remains policy-suppressed.
- [x] Thread reason-aware classification through dispatch-production, agent-action workspace, attention eval, attempt records, and learned-router filtering.
- [x] Add daemon, dispatch-ledger, and FleetStatus regression coverage.
- [x] Run focused learning/daemon/status verification plus typecheck, lint, build, audit, and diff checks.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Context-Efficiency Executable Action
- [x] Deploy scouts for context-efficiency and Phantom delegation follow-up lanes.
- [x] Fix context-efficiency next action to use `ashlr eval attention --json`.
- [x] Add `ashlr reflect playbooks --persist` as a control-plane next action with metadata-only safety note.
- [x] Add guarded one-shot daemon drain command when proposal-yield-low or generated diagnostic reslices are present.
- [x] Add mission directive for the context reflection/reslice action.
- [x] Emit metadata-only reflection telemetry for executable playbook persist runs while preserving default report learn-only behavior.
- [x] Add FleetStatus and reflect CLI regression coverage.
- [x] Run focused tests, typecheck, lint, build, audit, and diff checks.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Causal Attempt Coverage
- [x] Deploy/read scout for causal attempt coverage, route/run metadata, and Fleet OS surfacing.
- [x] Add read-only causal coverage booleans for trajectory, route snapshot, run summary, router policy, learning epoch, and authoritative labels.
- [x] Add weak causal coverage summary with sample-gated thresholds and hashed sample refs only.
- [x] Surface weak causal coverage as a read-only next action and Mission Brief directive.
- [x] Render causal coverage in CLI, Fleet, Mission Control, and Fleet Dashboard production panels.
- [x] Add focused attempt-record, FleetStatus, CLI, and web surface regression coverage.
- [x] Run focused tests, typecheck, and browser JS syntax check.
- [x] Run final lint, build, audit, diff, commit, push, reload daemon, and smoke live status.

## Current Continuation - Phantom Delegation Safety Counts
- [x] Deploy scout for Phantom delegation safety count-only surfacing.
- [x] Extend Phantom agent report rollup with optional count-only delegation safety, status, and primary-action maps.
- [x] Parse aggregate and per-record Phantom delegation fields without persisting raw repos, prompts, commands, stdout/stderr, env, secret names, or file contents.
- [x] Sanitize delegation counts through FleetStatus allowlists and include unsafe/review signals in the Phantom audit next action.
- [x] Render delegation safety counts in CLI, Fleet, Mission Control, and Fleet Dashboard status surfaces.
- [x] Add focused Phantom parser, FleetStatus/CLI, and web surface regression coverage.
- [x] Run focused tests, typecheck, node syntax check, lint, build, audit, and diff checks.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Diagnostic Reslice Drain Action
- [x] Deploy scouts for dispatch yield, causal context-summary coverage, and evidence-pack quality.
- [x] Select dispatch-yield reslice drain as the live critical path because fleet status reports `dispatch-yield-actionable` and queued no-diff reslices.
- [x] Add a high-priority `drain-diagnostic-reslices` next action when dispatch yield is actionable, the recommended repair is tighten/reslice, and queued no-diff diagnostic reslices exist.
- [x] Make Mission Brief use `Drain diagnostic reslices` when that action is primary.
- [x] Add focused FleetStatus/CLI regression coverage.
- [x] Run focused M49 status tests, typecheck, and diff checks.
- [x] Run final lint, build, audit, commit, push, reload daemon, and smoke live status.

## Current Continuation - Delete-Only Evidence Packs
- [x] Spawn context-summary telemetry worker in parallel.
- [x] Inspect autonomy evidence-pack summarizer and policy persistence tests.
- [x] Make diff evidence collect files from `diff --git`, old/new headers, and rename headers while skipping `/dev/null`.
- [x] Add delete-only regression proving removed files are represented and deleted content/raw diff text is not persisted.
- [x] Run focused M301 autonomy policy tests, typecheck, and diff checks.
- [x] Run final lint, build, audit, commit, push, and continue to next lane.

## Current Continuation - Context Summary Telemetry
- [x] Review worker patch for metadata-only local context summaries.
- [x] Add local context bundle summary helper with prompt, retrieval, and compression counts/ratios only.
- [x] Thread `RunContextSummary` through api-model sandbox proposal capture, run state, decision metadata, and agent-action telemetry.
- [x] Add focused local-context and api-model dispatch regression coverage.
- [x] Re-run focused local-context/api-model, learning graph, attention, agent-loop, typecheck, and diff checks.
- [x] Run final lint, build, audit, commit, push, reload daemon, and smoke live status.

## Current Continuation - Native Grep Regex Reliability
- [x] Inspect daemon stderr and identify repeated `parentheses not balanced` failures from agent grep patterns such as `it\\.skip\\(`.
- [x] Reproduce default `git grep` basic-regex failure and confirm `git grep -E` accepts the JS-style escaped paren pattern.
- [x] Switch the native engineer grep tool to extended regex mode for git-backed searches.
- [x] Add regression coverage for `it\\.skip\\(` in the git-backed grep path.
- [x] Run focused native engineer/cwd tests, typecheck, and diff checks.
- [x] Run final lint, build, audit, commit, push, reload daemon, and smoke live status.

## Current Continuation - Executable Diagnostic Reslice Drain
- [x] Close scout agents and pick the live reslice-drain stall as the next daemon control-path blocker.
- [x] Export the existing trusted diagnostic no-diff reslice predicate instead of adding a looser selector.
- [x] Add `ashlr daemon start --once --drain diagnostic-reslices` as a targeted, proposal-only scheduler mode.
- [x] Filter targeted ticks to trusted diagnostic reslice items before normal round-robin selection while preserving coordinator claims, cooldowns, pending-proposal dedupe, budgets, dry-run, and sandboxed dispatch.
- [x] Persist drain request/selection metadata in tick and agent-action telemetry, including bounded selected ids and stalled counts.
- [x] Point Fleet OS drain commands at the targeted mode and surface `diagnosticResliceDrainStalled` / `reslice-drain-stalled`.
- [x] Integrate read-time legacy route/run fallback worker patch for dispatch-production attempt coverage without materializing legacy labels.
- [x] Run focused daemon/status/ledger/attempt/CLI-service tests, typecheck, lint, build, audit, and diff checks.
- [x] Commit, push, reload daemon, and smoke live targeted drain/status.

## Current Continuation - Bounded Diagnostic Drain Status
- [x] Rechecked clean pushed state after executable targeted drain rollout.
- [x] Kept the live targeted one-shot daemon running as a production probe while working on non-overlapping code.
- [x] Closed completed scouts and redeployed sidecar agents for drain caps/status, live queue telemetry, and Phantom/MCP argv secret exposure.
- [x] Add a drain-only selection cap with default safe limit and optional explicit `--limit`.
- [x] Persist drain limit/capped metadata in daemon tick and agent-action telemetry.
- [x] Surface latest targeted diagnostic drain result in FleetStatus and CLI status even when generated work is empty.
- [x] Add focused daemon/status/CLI regression coverage.
- [x] Run full verification suite for bounded diagnostic drain status.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - MCP Argv Safety
- [x] Rechecked clean pushed baseline and current MCP hardening diff.
- [x] Deployed sidecar scouts for MCP safety gaps, the next fleet autonomy lane, and Phantom/Ashlr opportunity synthesis.
- [x] Add a shared core MCP argv redaction and fail-closed launch-safety helper.
- [x] Refuse secret-like MCP argv before spawning downstream MCP child processes and redact refusal text.
- [x] Force daemon-launched Claude MCP config into strict mode so global MCP servers are not inherited.
- [x] Run focused MCP/Fleet MCP verification, typecheck, lint/build/audit gates, commit, push, reload daemon, and smoke live status.

## Current Continuation - Done-Diff Proposal Capture
- [x] Rechecked clean pushed MCP baseline and live fleet smoke after deployment.
- [x] Use scout finding to target daemon-required proposal capture parity.
- [x] Reclassify required `proposal-disabled` runs with produced diff metadata and zero capture attempts as `proposal-capture-error`.
- [x] Preserve failed-before-capture behavior and add a distinct done-with-diff diagnostic reason.
- [x] Add daemon loop regression for done run with diff but no filed proposal, including delegation contract, diff metadata, worked ledger, and learning label.
- [x] Run focused/adjacent verification and broad local gates.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Automatic Diagnostic Reslice Drain
- [x] Rechecked clean pushed done-diff baseline, live daemon guard state, Entire state, recent commits, and drain-related tests/code.
- [x] Deploy parallel scouts for daemon selection flow, trusted reslice invariants, and FleetStatus telemetry.
- [x] Implement conservative implicit diagnostic-reslice drain selection for live executable backlog-build ticks.
- [x] Add focused daemon-loop regressions for auto-drain priority, local-only preservation, pending/cooldown fallback, malformed lookalikes, status, router trust, and web telemetry.
- [x] Run focused and broad local verification gates.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Verify-Only Action Ranking
- [x] Rechecked clean pushed auto-drain baseline and live fleet status.
- [x] Deploy scouts for Mission Brief action ranking and known verification failure drain semantics.
- [x] Promote failed-verification repair ahead of diagnostic reslice drain when the merge gate is blocked.
- [x] Add focused FleetStatus regression for verify-only plus queued diagnostic reslices.
- [x] Persist terminal stuck-pass count before rejecting permanent auto-merge blockers.
- [x] Run production gates for the verify-only action ranking slice.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Native Build Verification Kind
- [x] Rechecked clean pushed permanent-blocker baseline, recent commits, and verification-contract files.
- [x] Deploy focused scout for verification kind schema and ordering.
- [x] Add first-class `build` verification command kind across contracts, results, sandbox test ordering, and self-heal classification.
- [x] Add focused regression coverage for manifest build commands, detected build scripts, runtime ordering, and native build failures.
- [x] Run verification gates for the native build verification kind slice.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Clean Repo Build Contract Migration
- [x] Rechecked sibling repo contract/status state after Hub build-kind rollout.
- [x] Deploy read-only validator for clean sibling contract migration.
- [x] Update clean sibling `ashlr.verify.json` build commands from `kind:"typecheck"` to `kind:"build"`.
- [x] Validate contracts and commit each clean repo; no remotes were configured to push.

## Current Continuation - Phantom Audit Readiness Blocker
- [x] Resume from clean pushed Phantom provider-key baseline and inspect the in-progress Phantom readiness diff.
- [x] Promote aggregate Phantom audit risk from values-free next action to Autonomous Ship Readiness top blocker once daemon and auto-merge preconditions are healthy.
- [x] Keep blocker/action/Mission Brief details metadata-only: bounded counts, no raw paths, secret names, commands, findings, stdout/stderr, env, or file contents.
- [x] Add focused Phantom/FleetStatus regression coverage for blocked readiness and Mission Brief directive.
- [x] Run focused `m348`/`m49`, typecheck, and diff checks.
- [x] Run final lint, build, audit, commit, push, and smoke live status.

## Current Continuation - Diagnostic Auto-Drain Command Rail
- [x] Use scout/live status to identify stale manual targeted drain command while launchd daemon is already active and auto-draining.
- [x] Gate diagnostic drain next action on eligible reslice items from `queue.next`, not total visible generated reslices.
- [x] Change active-daemon action/directive copy to `Monitor diagnostic auto-drain` with read-only commands only.
- [x] Convert context-efficiency secondary reslice command to read-only daemon inspection and keep Mission Brief at `Run context reflection`.
- [x] Add M49 regressions for active-daemon monitoring and visible-but-cooling reslices.
- [x] Run final lint, build, audit, commit, push, reload daemon, and smoke live status.

## Current Continuation - 10:4 Explicit Verification Contract
- [x] Deploy read-only verifier scout to reconcile nested `relay` detection and failing npm commands.
- [x] Identify colon-in-path PATH splitting as the cause of failed `npm run` verifier commands.
- [x] Add root `ashlr.verify.json` in `/Users/masonwyatt/Desktop/10:4` using `replace-detected` plus direct node TypeScript/Vitest entrypoints.
- [x] Validate Hub profile detection and commit locally; push remains blocked because the repo has no configured remote.

## Current Continuation - No-Diff Reslice Yield
- [x] Inspect the live `dispatch-yield-actionable` blocker and no-diff diagnostic reslice work item creation.
- [x] Add sanitized original-title metadata to no-diff reslice work items.
- [x] Strengthen reslice instructions to require a concrete file/subsystem target and a fresh file diff or explicit capture-gate failure.
- [x] Preserve the metadata-only/privacy boundary: no raw prompts, stdout, stderr, env, file contents, or prior diff output.
- [x] Run focused queue/daemon/status tests, typecheck, and diff checks.
- [x] Run final lint, build, audit, commit, push, reload daemon, and smoke live status.

## Current Continuation - Gate-Blocked Diff Repair
- [x] Receive scout diagnosis that live `local-coder/self` blocker includes `gate-blocked` rows with diff metadata but generic reason text.
- [x] Queue capture repair work for self `gate-blocked` dispatches when diff metadata proves changed files.
- [x] Add sanitized original-title metadata to capture-gate repair work items.
- [x] Add focused M310 regression for generic gate-blocked reason plus diff evidence.
- [x] Run focused and final gates, commit, push, reload daemon, and smoke live status.

## Current Continuation - Queued Repair Coverage Visibility
- [x] Rechecked live queue after gate-blocked repair rollout and confirmed 7 generated proposal-repair items: 2 capture repairs plus 5 no-diff reslices.
- [x] Deploy read-only scouts for FleetStatus/web visibility and action/blocker wording.
- [x] Add `queue.generatedWork.captureRepairs` and make the generated-work total resilient to the `dispatch-capture-repair` tag.
- [x] Thread queued repair coverage into dispatch-yield action/readiness details as aggregate counts only.
- [x] Render capture/no-diff generated repair counts in CLI and Mission Control/Fleet Dashboard metrics with readable plural labels.
- [x] Add focused FleetStatus, dashboard snapshot, SSE/static, and queued-autonomy regression coverage.
- [x] Run focused and final gates, commit, push, reload daemon, and smoke live status.

## Current Continuation - Capture Repair Action Rail
- [x] Use live status and scouts to confirm queued capture repairs are normal daemon-selected work, not a targeted drain mode.
- [x] Add a high-priority `process-capture-repairs` action only when capture repairs are visible in `queue.next` and dispatch yield is actionable.
- [x] Keep active-daemon commands read-only (`fleet status` and `daemon status`) so launchd remains the single dispatcher.
- [x] Preserve cooling/pending gates: generated capture-repair counts do not create an action unless the repair is daemon-eligible.
- [x] Update Mission Brief directive/action ranking to prefer concrete capture-repair monitoring over passive dispatch-yield inspection.
- [x] Add focused M49 coverage for eligible and cooling capture-repair cases.
- [x] Run focused and final gates, commit, push, reload daemon, and smoke live status.

## Current Continuation - Dispatch Learning Label Read Backfill
- [x] Use live causal coverage and scout findings to locate current authoritative-label debt in legacy dispatch-production rows.
- [x] Materialize deterministic `learningLabel` metadata on read for legacy dispatch-production rows using the same classifier already used on writes.
- [x] Preserve append-only behavior: legacy JSONL files are not rewritten and raw prompts/diffs/stdout/stderr/env/file contents remain absent.
- [x] Update ledger and attempt-record regressions for read-time labels plus no durable rewrite.
- [x] Run focused privacy/learning/fleet/dashboard gates and final lint/build/audit gates.
- [x] Commit, push, reload daemon, and smoke live causal coverage.

## Current Continuation - Dispatch Evidence Outcome Pass-Through
- [x] Use scout finding to identify `runState.evidenceOutcome` as an existing metadata source that was not reaching dispatch-production telemetry.
- [x] Thread sanitized `evidenceOutcome` through `DaemonDispatchProduction`, dispatch-production events, and derived daemon agent actions.
- [x] Keep evidence metadata pass-through only: no synthetic evidence outcome, no judge, no raw evidence detail.
- [x] Add daemon-loop regression for trace, state, dispatch-production ledger, and agent-action propagation.
- [x] Run focused daemon/learning/privacy gates plus final lint/build/audit gates.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Policy-Suppressed Label Weak Gate
- [x] Rechecked the in-progress patch, persistent plan/notes, and live FleetStatus after dispatch evidence telemetry.
- [x] Treat `currentAuthoritativeLabel` weak gating as a learnable-attempt metric while preserving the raw all-attempt coverage count.
- [x] Keep policy-suppressed attempts visible in causal diagnostics without turning them into a false actionable causal-coverage blocker.
- [x] Update FleetStatus next-action detail formatting to use the weak reason denominator when it differs from total attempts.
- [x] Add regression coverage for policy-suppressed attempts lacking current labels.
- [x] Run focused, typecheck, lint, build, audit, JS syntax, and diff gates.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Protected Capture Repair Routing
- [x] Use live FleetStatus and scout recommendations to select generated capture repairs as the next dispatch-yield lane.
- [x] Add a strict `isTrustedCaptureRepairItem()` predicate with deterministic id, generated tags/detail text, and diff/actionable-failure evidence.
- [x] Route trusted capture repairs as protected frontier candidates with a `frontier:` reason so workhorse dispatch preserves the hint.
- [x] Keep malformed/sanitized repair-shaped samples fail-closed instead of throwing or promoting.
- [x] Add router, resource-aware gateway, workhorse dispatch, and queued-autonomy regressions.
- [x] Run focused, adjacent, typecheck, lint, build, audit, JS syntax, and diff gates.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Generated Repair Yield Telemetry
- [x] Resume from the protected capture-repair routing baseline and recheck git, Entire, daemon, and fleet state.
- [x] Use repair-telemetry scout findings to choose a metadata-only generated repair yield surface.
- [x] Add fixed-enum generated repair classification for capture repairs, no-diff reslices, and proposal repairs.
- [x] Count generated repair attempts and conversion rates in dispatch-production yield and attempt coverage.
- [x] Render repair-yield aggregates in `ashlr fleet status` without exposing raw titles, prompts, diffs, stdout/stderr, env, argv, or file contents.
- [x] Add focused dispatch-ledger, attempt-coverage, and FleetStatus regressions for counts, conversion rates, and privacy boundaries.
- [x] Run focused, adjacent, typecheck, lint, build, audit, JS syntax, and diff gates.
- [x] Commit, push, reload daemon, clear stale dead-owner spend guard, and smoke live status.

## Current Continuation - Active Repair Recovery Status
- [x] Deploy scouts for repair-yield-driven recovery status and Phantom verifier readiness.
- [x] Thread generated repair attempts into dispatch-yield diagnostics and action/readiness detail.
- [x] Add a conservative generated-repair recovery gate requiring active generated work, at least three samples, and conversion at or above 50% plus the configured low-yield floor.
- [x] Replace the generic dispatch-yield blocker with `generated-repair-recovery-active` when repair conversion is healthy, while preserving the underlying diagnostic candidate and generic inspect action when no repair monitor action is active.
- [x] Add live-shaped FleetStatus regression coverage for 4/5 generated repair conversion with local-coder/self still sample-gated.
- [x] Run focused, adjacent, typecheck, lint, build, audit, JS syntax, and diff gates.
- [x] Commit, push, reload daemon, and smoke live status.

## Current Continuation - Dispatch Manifest Status
- [x] Resume from the concurrent dispatch manifest baseline and recheck git, plan, notes, and active sibling agents.
- [x] Surface recent append-only dispatch manifests in FleetStatus as bounded forensic metadata.
- [x] Render manifest event, assignment, unassigned, latest, and backend-count summaries in `ashlr fleet status`.
- [x] Add M49 regression coverage proving status aggregation and CLI output.
- [x] Run focused manifest/status tests, typecheck, lint, build, audit, JS syntax, and diff gates.
- [x] Commit, push, refresh live fleet status, and continue sibling verifier/research lanes.

## Current Continuation - Trajectory Learning Spine
- [x] Rechecked current branch state, Entire state, active agents, and in-flight trajectory-records diff.
- [x] Added a read-only `TrajectoryRecord` join across dispatch-production, proposals/outcome records, evidence, decisions, and agent actions.
- [x] Kept the trajectory surface metadata-only with central scrubbing for reasons, route snapshots, run summaries, evidence summaries, and timeline events.
- [x] Added `summarizeTrajectoryLearning()` with terminal outcomes, coverage, route-spine metrics, gap counts, and hashed recent refs.
- [x] Surfaced trajectory learning in `FleetStatus` and `ashlr fleet status`.
- [x] Added focused trajectory, privacy, attempt-coverage, and FleetStatus regression coverage.
- [x] Run final lint/build/audit/diff gates, commit, push, and smoke live status.

## Next Lane - Verified Skill Cards v1
- [x] Add `SkillCard` and `SkillUseEvent` schemas plus route-snapshot skill fields.
- [x] Persist append-only skill card/use events under `~/.ashlr/skills/` with secret scrubbing and malformed-row skips.
- [x] Distill structured skill cards from verified applied proposals while preserving the legacy genome note.
- [ ] Add shadow-mode skill retrieval after gateway routing; do not change backend choice until same-tier active-mode safety tests pass.
- [ ] Inject selected skill summaries into run context under a tight cap with verification checks and red flags, never raw diffs.
- [ ] Correlate selected skill ids with trajectory learning so Ashlr can prove which skills improve verification/merge outcomes.

## Current Overnight Cycle - Skill Learning Foundation and Data Truth
- [x] Rehydrate clean pushed baseline, Entire state, live FleetStatus, persistent notes, and prior agent findings.
- [x] Deploy disjoint worker lanes for the metadata-only skill ledger and Fleet Dashboard data-quality rendering.
- [x] Deploy read-only scouts for the live evidence-coverage gap and the two-commit skill retrieval/injection rollout.
- [x] Review and integrate the skill-card ledger foundation.
- [x] Prove degraded/unknown readiness rendering with executable regression coverage and surface trajectory learning in Fleet OS.
- [x] Resolve the live trajectory evidence gap: preserve true zero evidence while removing historical records from the 24-hour denominator.
- [x] Prevent overlapping SSE snapshot builds from stalling Fleet Dashboard and verify both learning surfaces in the browser.
- [x] Make NIM resource availability fail closed when the executor cannot resolve its configured credential.
- [x] Run focused privacy/dashboard/learning tests and final repository gates.
- [x] Update durable notes, commit, push, reload the daemon if runtime code changed, and smoke live status.

## Current Overnight Cycle - Shadow Skill Retrieval
- [x] Rehydrate the clean production baseline, Entire state, live skill store, and prior rollout notes.
- [x] Deploy parallel lanes for deterministic retrieval, routing integration mapping, trajectory correlation, and adversarial review.
- [x] Audit retrieval readiness adversarially and stop production wiring when the card ledger fails the canonical trust-boundary bar.
- [x] Require authoritative proposal provenance before distilling either a legacy workflow or structured skill card.
- [x] Harden skill ledger ownership, permissions, symlink handling, and bounded reads.
- [x] Add latest-revision-wins canonical eligibility with revocation/deprecation suppression and conflict quarantine.
- [x] Remove caller-controlled legacy `m243:skill` privilege from MCP learning and tag-only recall boosts.
- [x] Keep shadow retrieval observe-only and unwired while signing, lifecycle, and privilege boundaries settle in production.
- [x] Run focused and repository verification gates, update notes, commit, push, reload, and smoke production.

## Current Overnight Cycle - Shadow Route Equivalence
- [x] Rehydrate the signed trust-boundary baseline, Entire state, empty live skill store, and rollout constraints.
- [x] Deploy disjoint daemon-integration, trajectory-correlation, equivalence-matrix, and adversarial-review lanes.
- [x] Re-audit the proposed producer path and keep daemon routing/correlation unwired when strong attempt identity is unavailable.
- [x] Bind candidate summaries and use-event schemas to the exact signed card content hash and selection policy/time.
- [x] Add deterministic strong-identity event construction that rejects work-only/path-like identities and persists no card/query text.
- [x] Make use-event reads replay-idempotent, quarantine conflicting event ids, and recover after crash-truncated ledger tails.
- [ ] Select signed verified cards only after the final executable route and read the corpus once per tick.
- [x] Preallocate and propagate a durable attempt identity through serial, concurrent, failure, retry, builtin, and Best-of-N execution.
- [ ] Persist replay-idempotent metadata-only selection events after strong trajectory identity exists.
- [ ] Correlate skill-use observations into aggregate-only trajectory learning without claiming causality.
- [ ] Prove zero changes to backend, tier, model, goal/prompt, budget, delegation, retries, Best-of-N, or merge authority.
- [x] Keep active skill injection impossible and preserve current production routing as an exact no-producer behavioral no-op.
- [x] Run focused/full gates, update durable notes, commit, push, reload, and smoke production telemetry.

## Current Overnight Cycle - Durable Attempt Identity
- [x] Rehydrate the clean pushed baseline, Entire state, runtime health, and persistent rollout constraints.
- [x] Deploy disjoint audits for run propagation, Best-of-N candidate semantics, terminal-path coverage, and the identity primitive.
- [x] Add a privacy-safe preallocated attempt identity with deterministic Best-of-N child identities.
- [x] Propagate caller-supplied identity through run, swarm, sandbox, retry, and daemon dispatch paths without changing execution inputs.
- [x] Preserve the identity on success, no-proposal, and failure telemetry so no-attempt learning rows can be joined reliably.
- [x] Add focused serial, builtin, Best-of-N, retry, and error-path regression coverage.
- [x] Run repository gates, update durable notes, commit, push, reload, and smoke production telemetry.

## Current Overnight Cycle - Attempt Start and Builtin Outcome Truth
- [x] Rehydrate the clean pushed baseline, Entire state, live daemon, and rollout constraints.
- [x] Deploy disjoint audits for crash-visible start events, builtin terminal semantics, shadow activation readiness, and a pure classifier.
- [x] Record one metadata-only attempt-start event immediately before each real executor invocation.
- [x] Keep preflight/throttle/budget/resource skips free of false start events while preserving their attempt identity.
- [x] Add typed builtin swarm production outcomes for proposal, empty, blocked, failed, and unknown terminal states.
- [x] Prove serial, concurrent, workhorse, failure, and builtin parity without changing execution arguments or merge authority.
- [x] Run repository gates, independent review, durable notes, commit, push, reload, and production smoke.

## Current Overnight Cycle - Observe-Only Skill Selection
- [x] Rehydrate the clean pushed lifecycle baseline, live telemetry, Entire state, and shadow rollout constraints.
- [x] Deploy parallel final-route, trajectory-join, adversarial, and test-equivalence lanes.
- [x] Read the signed card corpus once per live tick and select only attested verified-proposal revisions.
- [x] Record metadata-only selections only after an executor demonstrably ran, using the final executable route.
- [x] Use candidate-local identities/routes for Best-of-N and suppress outer, skipped, and missing-runner observations.
- [x] Join skill-use rows into aggregate trajectory observation coverage without assigning causal outcomes.
- [x] Prove zero changes to route, model, prompt, options, budget, retries, fanout, winner, proposal, and merge authority.
- [x] Run focused/full gates and independent adversarial review.
- [x] Update notes, commit, push, reload, and production smoke.

## Current Overnight Cycle - Skill Corpus Cold Start
- [x] Rehydrate the clean deployed baseline, live FleetStatus, Entire state, and persistent rollout constraints.
- [x] Audit why the live verified-skill corpus is empty and map authoritative backfill options.
- [x] Add an honest corpus-readiness/data-quality surface without exposing card or query text.
- [x] Implement the safest high-leverage cold-start slice supported by authoritative evidence: bounded, fail-closed corpus diagnostics rather than unsafe historical backfill.
- [x] Prove no active prompt injection, route changes, causal overclaim, or merge-authority changes.
- [x] Run focused/full gates, independent review, notes, commit, push, reload, and production smoke.

## Current Overnight Cycle - Generated Repair Dispatch Reliability
- [x] Rehydrate the clean deployed baseline, Entire state, live queue, and proposal-yield telemetry.
- [x] Deploy disjoint audits for no-diff repair conversion, capture recovery, queue hygiene, and verifier coverage.
- [x] Trace repeated repair attempts to the concrete headless Codex startup failure.
- [x] Recover once from unsupported desktop reasoning preferences using a model-compatible CLI value without overriding valid operator configuration.
- [x] Keep trusted generated repairs off the planning-only builtin backend, including exceptional fallbacks and slot overflow.
- [x] Add retry, provenance, diagnostic-reslice, fallback, capacity, duplicate-id, and parallel-test-isolation coverage.
- [x] Run focused/full repository gates and independent adversarial review.
- [x] Update durable notes, commit, push, reload, and production smoke.

## Current Overnight Cycle - Terminal Generated Repair Lifecycle
- [x] Rehydrate the clean deployed repair-routing baseline, live queue growth, Entire state, and durable rollout evidence.
- [x] Deploy disjoint audits for lifecycle authority, queue retirement, adversarial suppression risks, and TITRR partial capture.
- [x] Add a versioned fail-closed generated-repair lifecycle using exact repo/item/generation identity and metadata-only terminal evidence.
- [x] Retire only from an exact durable proposal, exhaust only after two distinct typed empty-diff attempts, and keep infrastructure/capture failures retryable.
- [x] Prune terminal repairs from the durable queue and backlog before selection and expose count-only maintenance outcomes without raw task data.
- [x] Block local repair dispatch while lifecycle state is unavailable, fence shared mode, and reconcile crash-persisted proposals before retrying work.
- [x] Prove ordinary work, spoofed records, duplicate events, recurrence, queue persistence, lock contention, write failure, and daemon refresh behavior remain safe.
- [x] Run focused/full repository gates and independent adversarial review on the final source.
- [x] Update durable notes, commit, push, reload, and production smoke.

## Current Overnight Cycle - Failed TITRR Partial Capture
- [x] Rehydrate the clean deployed lifecycle baseline, live daemon, Entire state, and recorded next-lane boundary.
- [x] Deploy disjoint audits for CLI TITRR cleanup ordering, API-model parity, regression coverage, and capture authority.
- [x] Capture one scrubbed partial proposal from a failed producer sandbox before cleanup only when material diff exists.
- [x] Preserve failed producer status, exact run/trajectory/generation provenance, and partial completeness-gate truth.
- [x] Keep empty failures proposal-free, prevent duplicate filing across retries, and guarantee sandbox cleanup on every capture outcome.
- [x] Prove partial captures remain non-terminal repair evidence and do not weaken merge or lifecycle authority.
- [x] Run focused/full gates and independent adversarial review on the final source.
- [x] Update durable notes, commit, push, reload, and production smoke.

## Current Overnight Cycle - Metadata-Only Agent Diagnostics
- [x] Rehydrate the deployed partial-capture baseline, live diagnostics store, Entire state, and privacy boundary.
- [x] Deploy disjoint privacy, filesystem, retry-evidence, and adversarial-review lanes.
- [x] Replace future raw external-agent logs with a fixed-schema metadata-only diagnostic record.
- [x] Hash execution identity and preserve one bounded row for every actual retry attempt.
- [x] Fail closed on unsafe ownership, symlinks, malformed tails, unsupported Windows storage, and retention overflow.
- [x] Preserve legacy bytes while hardening their directory and file permissions in place.
- [x] Serialize concurrent processes with bounded lock acquisition and prove no loss under a 16-writer burst.
- [x] Run full repository gates and final independent review.
- [x] Update durable notes, commit, push, reload, harden the live store, and smoke production.

## Current Overnight Cycle - Verified Sandbox Cleanup
- [x] Rehydrate the deployed diagnostics baseline, live service, Entire state, and recorded next-lane boundary.
- [x] Map cleanup ownership, failure windows, parent-child repair handoff, and reusable recovery ledgers in parallel.
- [x] Define a typed cleanup postcondition that distinguishes complete, residual, refused, and unavailable outcomes.
- [x] Persist bounded metadata-only recovery evidence for incomplete cleanup without weakening containment.
- [x] Propagate cleanup truth through CLI/API/TITRR/Best-of-N terminal paths without changing proposal or merge authority.
- [x] Add adversarial coverage for worktree, scratch-branch, metadata-home, crash, retry, symlink, and concurrent cleanup cases.
- [x] Run focused/full gates and final independent review.
- [x] Update durable notes, commit, push, reload, and smoke production.

## Current Overnight Cycle - Durable Repair Handoff Journal
- [x] Rehydrate the clean deployed cleanup baseline, live service, Entire state, and recorded handoff risks.
- [x] Map parent outcome authority, repair derivation, queue mutation, lifecycle projection, and crash windows in parallel.
- [x] Define a bounded metadata-only generation-aware handoff journal with replay and conflict semantics.
- [x] Persist parent observations before acknowledgement and reconstruct missing queue projections without capped-ledger loss.
- [x] Serialize queue projection and add stale-lock recovery without enabling generated repairs in shared mode.
- [x] Preserve exact parent-to-child lineage through child attempts and proposals without granting terminal or merge authority.
- [x] Add crash, replay, conflict, truncation, concurrency, recurrence, stale-lock, and privacy coverage.
- [x] Run focused/full gates and final independent adversarial review.
- [x] Update durable notes, commit, push, reload, and smoke production.

## Current Overnight Cycle - Parent-Resolved Diagnostic Reslices
- [x] Rehydrate the deployed required-diff baseline, live queue, service health, Entire state, and repository blockers.
- [x] Deploy parallel parent-authority, tier-preservation, trajectory-metrics, live-queue, test-design, and adversarial-review lanes.
- [x] Resolve diagnostic retries only from fresh scanner-owned parent work and quarantine missing or provenance-mismatched parents.
- [x] Bind parent source, backend, and tier to the durable repair handoff journal and accept compatible enriched legacy replay.
- [x] Preserve exact parent tier through router, gateway, concurrent, workhorse, serial, Best-of-N, and executor paths.
- [x] Use available same-tier capacity without spilling repairs across tiers; pause when verified same-tier capacity is unavailable.
- [x] Retire pre-authority queue-only diagnostic rows instead of leaving permanently inert work in lifecycle storage.
- [x] Correct route-spine trajectory coverage to use dispatch-rooted denominators and add count-only parent-resolution telemetry.
- [x] Run focused/full gates, independent adversarial review, durable notes, commit, push, reload, and production smoke.
- Error encountered: full-history agent forks cannot override `agent_type`; relaunched scoped explorers without history forks.
- Error encountered: one `rg` expression used an unsupported backreference escape; reran the search with literal patterns.

## Current Overnight Cycle - Objective-Bound Repair Authority
- [x] Rehydrate the deployed parent-retry baseline, live queue, handoff history, lifecycle state, and Entire status.
- [x] Deploy parallel authority, operations, privacy, and adversarial-review lanes.
- [x] Bind every new diagnostic generation to a scrubbed, NFC-normalized, host-keyed objective fingerprint.
- [x] Require exact journal, source, route, generation, and objective identity before dispatch or lifecycle authority.
- [x] Quarantine changed or retroactively enriched replay and preserve immutable event fingerprints through compaction.
- [x] Retire hashless legacy diagnostic generations from queue and backlog without granting fallback authority.
- [x] Keep supplied maintenance events observational and leave resolution verification off the daemon critical path.
- [x] Validate hashes before persistence and require a durable 32-byte local key before minting objective identity.
- [x] Preserve parsed authority beyond the journal row warning threshold while retaining the bounded byte cap.
- [x] Run focused/full gates and three final independent SHIP reviews.
- [x] Update durable notes, commit, push, reload, and production smoke.

## Current Overnight Cycle - Source-Specific Scanner Evidence
- [x] Rehydrate the deployed objective-authority baseline, live queue, daemon health, Entire state, and persistent notes.
- [x] Deploy parallel audits for scanner failure semantics, daemon post-state scheduling, live evidence, and adversarial authority boundaries.
- [x] Add a backward-compatible metadata-only `present|absent|unavailable` scanner observation contract.
- [x] Keep every legacy empty scan unavailable; only exhaustive source adapters may assert absence.
- [x] Add one strict local queued-autonomy adapter that distinguishes healthy empty state from malformed, unreadable, or unsafe storage.
- [x] Preserve observations through bounded persistence and concurrent backlog refresh without changing dispatch, lifecycle, or merge authority.
- [x] Run focused/full gates and independent adversarial review.
- [x] Update durable notes, commit, push, reload, and production smoke.

## Current Overnight Cycle - Revision-Bound Source Lineage
- [x] Rehydrate the deployed scanner-evidence baseline, live diagnostic source mix, runtime health, and persistent notes.
- [x] Rank positive resolution witnesses and define repository/source revision contracts.
- [x] Bind merge-verification-contract observations to a revisioned metadata-only source base.
- [x] Add a separate advisory positive resolution-witness contract and ledger for the first deterministic objective kind.
- [x] Keep legacy/hashless source lineage advisory and grant no no-change, lifecycle, proposal, or merge authority.
- [x] Add malformed, replay, privacy, compatibility, and current-generation coverage.
- [x] Run focused/full gates and independent adversarial review.
- [x] Update durable notes, commit, push, reload, and production smoke.

## Current Overnight Cycle - Bounded Advisory Resolution Observer
- [x] Rehydrate the deployed lineage baseline, live daemon, fleet evidence, Entire state, and persistent notes.
- [x] Map post-state scheduling, prior/current observation correlation, status telemetry, and failure containment in parallel.
- [x] Define a single-flight, cancellation-aware, aggregate-deadline observer contract with explicit repository caps.
- [x] Record only authenticated advisory merge-contract transitions after durable scanner-state persistence.
- [x] Expose bounded witness quality and observer freshness without granting lifecycle, proposal, learning, or merge authority.
- [x] Add timeout, overlap, stale-base, replay, malformed-store, restart, privacy, and compatibility coverage.
- [x] Run focused/full gates and independent adversarial review.
- [x] Update durable notes, commit, push, reload, and production smoke.
- Error encountered: three parallel observer scouts hit the temporary subagent usage cap; continued the critical-path design locally and deferred fresh independent review until capacity resets.

## Current Overnight Cycle - Fleet Telemetry Truth And Test Isolation
- [x] Rehydrate the deployed observer baseline, live causal coverage, dispatch-yield evidence, Entire state, and persistent notes.
- [x] Deploy disjoint audits for causal identity, generated-repair yield, reflection scheduling, regression evidence, and test-state isolation.
- [x] Prove the repaired concurrent undefined-outcome path persists exact run and trajectory identity through production and agent-action ledgers.
- [x] Isolate worked-ledger test fixtures from the live `ASHLR_HOME` and verify no additional production-state contamination.
- [x] Preserve historical causal gaps as visible, non-fabricated evidence while confirming current-writer regressions remain actionable.
- [x] Run focused and repository-wide verification, then update durable notes, commit, push, reload, and smoke production.

## Current Overnight Cycle - Autonomous Metadata Context Rollup
- [x] Rehydrate the clean isolation baseline, live context/yield telemetry, daemon health, Entire state, and persistent notes.
- [x] Deploy disjoint implementation, daemon-integration, and privacy/authority audits.
- [x] Add a bounded metadata-only context rollup with persisted restart-safe cadence and minimum evidence thresholds.
- [x] Schedule it only after durable live daemon ticks without invoking models or mutating genome, prompts, routing, proposals, or merge authority.
- [x] Expose explicit effective configuration and preserve proposal-yield risks independently from reflection status.
- [x] Add threshold, cadence, restart, truncation, privacy, dry-run, failure, and end-to-end status coverage.
- [x] Run focused/full gates and independent adversarial review, then update notes, commit, push, reload, and production-canary the rollup.

## Current Overnight Cycle - Alternative Backend Retry Discipline
- [x] Rehydrate the deployed context-rollup baseline, live dispatch-yield evidence, daemon health, Entire state, and persistent notes.
- [x] Deploy disjoint lifecycle-authority, backend-routing, and regression-test audits.
- [x] Derive retry policy only from authoritative generated-repair lifecycle evidence.
- [x] Keep the first repair attempt on normal same-tier routing and require a different installed, capacity-eligible same-tier backend after one authoritative empty attempt.
- [x] Refuse repeat dispatch to the same backend with explicit `repair-alternative-unavailable` evidence when no qualified alternative exists.
- [x] Cover router, gateway, concurrent planner, daemon telemetry, lifecycle-unavailable, and flag-equivalence paths.
- [x] Run focused/full gates and independent adversarial review, then update notes, commit, push, reload, and production-canary the policy.

## Current Overnight Cycle - Backend Transition Learning Telemetry
- [x] Rehydrate the deployed retry-discipline baseline, live lifecycle state, queue, daemon health, and persistent notes.
- [x] Deploy disjoint audits for FleetStatus yield, authoritative lineage joins, and telemetry regression coverage.
- [x] Persist exact repair handoff/generation lineage on ordinary daemon dispatch events without raw content.
- [x] Bind retry ordinal and prior executed backend only from authoritative lifecycle state.
- [x] Preserve lineage through sanitization, replay reads, and agent-action projection without granting control or merge authority.
- [x] Add malformed, legacy, first-attempt, retry-success, retry-failure, executor-fallback, and privacy coverage.
- [x] Run focused/full gates and independent review, then update notes, commit, push, reload, and production-canary lineage capture.

## Current Overnight Cycle - Bounded Dispatch Production Reads
- [x] Rehydrate the deployed transition-telemetry baseline, live daemon state, Entire state, and persistent notes.
- [x] Deploy disjoint audits for bounded file I/O, source-quality propagation, compatibility, and adversarial fixtures.
- [x] Add explicit dispatch-production read health that never treats skipped, oversized, unreadable, or malformed partitions as healthy zero.
- [x] Bound bytes, files, rows, and returned events without weakening newest-first window semantics or metadata sanitization.
- [x] Propagate source quality through dispatch-yield FleetStatus while keeping existing event-reader callers compatible.
- [x] Add oversized, malformed, unreadable, mixed-quality, truncation, privacy, and legacy-window coverage.
- [x] Run focused/full gates and independent review, then update notes, commit, push, reload, and production-canary bounded reads.

## Current Overnight Cycle - Fail-Closed Decision Authority Reads
- [x] Rehydrate the deployed bounded-telemetry baseline, decision consumers, current git state, Entire state, and persistent notes.
- [x] Deploy disjoint audits for ledger storage, merge authority, source-quality propagation, and adversarial fixtures.
- [x] Add a bounded detailed decisions read contract that distinguishes missing, healthy, degraded, and incomplete evidence.
- [x] Require complete healthy decision evidence anywhere a cached verdict can grant judge-skip or merge authority.
- [x] Preserve observational `readDecisions()` compatibility without allowing malformed, unreadable, linked, replaced, or over-cap sources to authorize merges.
- [x] Add malformed-newer, unreadable, oversized, linked, replacement-race, ordering, and compatibility coverage.
- [x] Run focused/full gates and independent adversarial review, then update notes, commit, push, reload, and production-canary the authority boundary.

## Current Overnight Cycle - Bounded Judge-Trace Learning Evidence
- [x] Rehydrate the deployed decision-authority baseline, judge-trace consumers, current git state, Entire state, and persistent notes.
- [x] Deploy disjoint audits for trace storage integrity, outcome-link semantics, learning consumers, and adversarial fixtures.
- [x] Add bounded, race-safe judge-trace reads with explicit missing, healthy, degraded, and incomplete source quality.
- [x] Preserve observational compatibility while preventing degraded traces from becoming calibration, outcome, or routing labels.
- [x] Harden trace and outcome-patch writers against links, torn tails, short writes, unsafe modes, oversized rows, and partition drift.
- [x] Expose judge-trace quality in FleetStatus and CLI without presenting partial aggregates as healthy.
- [x] Add malformed, unreadable, oversized, linked, replacement, equal-time, outcome-patch, long-history, and privacy coverage.
- [x] Run focused/full gates and independent adversarial review, then update notes, commit, push, reload, and production-canary trace evidence.

## Current Overnight Cycle - Bounded Agent-Action Global Workspace
- [x] Rehydrate the deployed judge-evidence baseline, agent-action consumers, current git state, Entire state, and persistent notes.
- [x] Deploy disjoint audits for storage integrity, learning/control consumers, workspace aggregation, and compatibility fixtures.
- [x] Add bounded, race-safe detailed reads with explicit source quality while preserving `readAgentActions()`.
- [x] Harden async and synced writers against unsafe paths, links, torn tails, short writes, oversized rows, and partition drift.
- [x] Require complete evidence for routing, attempt/trajectory learning, context rollups, and daemon control derivations.
- [x] Surface agent-action source quality in FleetStatus, CLI, API, and workspace summaries without healthy-looking partial zeros.
- [x] Add malformed, unreadable, oversized, linked, replacement, exact-cap, stale-window, ordering, privacy, and writer coverage.
- [x] Complete independent adversarial review and update durable notes.
- [x] Commit, push, reload, and production-canary the workspace.

## Current Overnight Cycle - Bounded Dispatch-Intent And Candidate Evidence
- [x] Rehydrate the deployed agent-workspace baseline, production health, current git state, Entire state, and persistent notes.
- [x] Deploy disjoint audits for dispatch-manifest storage/consumers, Best-of-N storage/consumers, and compatibility/adversarial fixtures.
- [x] Add bounded, race-safe detailed source contracts while preserving observational reader compatibility.
- [x] Harden writers against unsafe paths, links, torn tails, short writes, oversized rows, partition drift, and concurrent mutation.
- [x] Require complete healthy evidence anywhere manifests or candidate outcomes affect learning, control, or production truth.
- [x] Surface source quality without presenting missing or partial candidate/dispatch evidence as healthy zero.
- [x] Add malformed, unreadable, oversized, linked, replacement, exact-cap, ordering, privacy, and legacy coverage.
- [x] Run focused/full gates and independent adversarial review, update notes, commit, push, reload, and production-canary both sources.

## Current Overnight Cycle - Autonomous Learning Evidence Matrix
- [x] Rehydrate the deployed candidate-evidence baseline, production health, current git state, Entire state, and persistent notes.
- [x] Audit readiness source construction, command rail, API mutation security, and UI contracts in parallel.
- [x] Promote bounded decision, judge, action, dispatch, manifest, and candidate evidence into one readiness matrix.
- [x] Attach explicit eligibility and read-only recovery commands without granting new merge, lifecycle, or learning authority.
- [x] Render the matrix in CLI and Mission Control without healthy-looking missing or partial values.
- [x] Add healthy, missing, degraded, stale, compatibility, and command-safety coverage.
- [x] Run focused/full gates and independent review, update notes, commit, push, reload, and production-canary the matrix.

## Current Overnight Cycle - Dispatchable Diagnostic Repair Drain
- [x] Rehydrate the deployed evidence-matrix baseline, production blocker, current git state, Entire state, and persistent notes.
- [x] Deploy disjoint audits for parent-context fidelity, generated-repair lifecycle/routing, and bounded production conversion evidence.
- [x] Make automatic diagnostic drain activate only for repairs with a currently dispatchable, policy-authorized backend.
- [x] Align generated-repair cooldown reads with generation-scoped outcome writes and preserve ordinary backlog progress.
- [x] Add starvation, unavailable-alternative, concurrent-capacity, lineage, and cooldown regression coverage.
- [x] Run focused/full gates and independent adversarial review, update notes, commit, push, reload, and production-canary repair progress.

## Current Overnight Cycle - Repair Parent Source Precision
- [x] Rehydrate the deployed diagnostic-drain baseline, production health, current git state, Entire state, and persistent notes.
- [x] Deploy disjoint audits for comment false positives, issue actionability, stale goals, and unchanged repair generations.
- [x] Remove comment/string-only skipped-test markers before they become executable self-improvement work.
- [x] Decide and implement the next evidence-bound source or generation precision improvement.
- [x] Add adversarial fixtures and run focused/full verification plus independent review.
- [x] Update durable notes, commit, push, reload, and production-canary backlog precision.

## Current Overnight Cycle - Bounded Engineering Issue Discovery
- [x] Rehydrate the deployed repair-precision baseline, production health, current git state, Entire state, and persistent notes.
- [x] Deploy disjoint audits for GitHub integration compatibility, label policy, production issue shapes, and objective-scoped repair identity.
- [x] Add strict bounded labeled issue discovery without changing the legacy CLI output contract.
- [x] Filter only explicit non-engineering labels while preserving positive engineering overrides, unknowns, and source uncertainty.
- [x] Add adversarial parsing/policy fixtures and run focused/full verification plus independent review.
- [x] Update durable notes, commit, push, reload, and production-canary issue precision.

## Current Overnight Cycle - Objective-Scoped Repair Generations
- [x] Rehydrate the deployed issue-precision baseline, live handoff/lifecycle evidence, daemon health, current git state, and persistent notes.
- [x] Deploy disjoint audits for handoff schema compatibility, lifecycle authority, downstream lineage, migration, and adversarial fixtures.
- [x] Derive new repair control generations from canonical parent objective identity rather than per-attempt identity.
- [x] Preserve v1 read compatibility and attempt-level telemetry while preventing unchanged-objective cooldown, empty-attempt, pending-proposal, retired, or exhausted resets.
- [x] Prove changed objectives receive fresh generations and missing/tampered objective authority fails closed.
- [x] Run focused/full verification plus independent review, update notes, commit, push, reload, and production-canary the reader-first rollout.

## Current Overnight Cycle - Repair Handoff Activation Observability
- [x] Rehydrate the reader-first production baseline and effective writer configuration.
- [x] Deploy independent activation, canary-evidence, and natural-eligibility audits.
- [x] Attempt a reversible single-daemon activation and classify the no-ordinary-parent result as inconclusive rather than successful.
- [x] Restore the writer-off baseline without deleting or rewriting either authority journal.
- [x] Add one bounded rollout status spanning journal health, schema counts, aliases, ordinary eligibility, projection evidence, and operator action.
- [x] Render rollout truth in CLI and Mission Control with legacy payload compatibility.
- [x] Complete independent review, commit, push, reload, production-canary the new status, and update durable notes.
- [x] Catch and fix the production dashboard's unbounded Codex transcript scan during the visual canary.
- [x] Bound transcript discovery, file count, aggregate bytes, head/tail parsing, and concurrent snapshot computation.
- [x] Upgrade existing dashboard LaunchAgents to an interactive service policy and verify desktop/mobile rendering.

## Current Overnight Cycle - Plugin Hook-Timing Retention
- [x] Rehydrate Hub and Plugin state, preserve unrelated dirty work, and audit writer/read/release surfaces in parallel.
- [x] Add one cross-process transaction covering timing-ledger size check, migration/rotation, and append.
- [x] Enforce bounded record/batch size plus explicit `0700/0600` permissions across active, retained, lock, metadata, and temp artifacts.
- [x] Stream retained plus active generations through the canonical reader and eliminate direct whole-file timing reads.
- [x] Surface explicit retained-window completeness without changing the legacy `readHookTimings()` return shape.
- [x] Add boundary, migration, stale-lock, multi-process, flush-barrier, permissions, privacy, and compatibility coverage.
- [x] Run focused/full Plugin gates and independent adversarial review without including unrelated user work.
- [x] Commit, push, deploy the plugin cache safely, and update durable Hub notes with production evidence.

## Current Overnight Cycle - Repair Treatment Learning And Canary Truth
- [x] Rehydrate the deployed Hub baseline, live repair-handoff state, daemon health, git state, and durable notes.
- [x] Deploy independent audits for V2 activation mechanics, ordinary-parent eligibility, and the highest-leverage learning gap.
- [x] Make reader-only rollout status fail closed when no qualifying ordinary parent is available for a canary.
- [x] Add deterministic metadata-only repair-treatment attribution without changing retry, budget, routing-tier, or merge authority.
- [x] Surface sample-gated treatment outcomes through existing bounded fleet telemetry.
- [x] Add state-machine, attribution, privacy, compatibility, and conversion regression coverage.
- [x] Run focused/full verification and independent adversarial review.
- [x] Commit, push, reload production, validate live status, and update durable notes.

## Current Overnight Cycle - Authenticated Merge And Causal Learning Truth
- [x] Rehydrate the deployed repair-learning baseline, production health, git state, Entire state, and durable notes.
- [x] Deploy independent audits for treatment outcomes, ordinary-work starvation, causal joins, and judge-free merge evidence.
- [x] Require fresh isolated verification for every mutating evidence-mode merge instead of trusting stored proposal metadata.
- [x] Replace raw repair dispatch claims with terminal authority-bound treatment outcomes.
- [x] Prevent duplicate-diff retries from stealing another producer's proposal outcome.
- [x] Preserve one ordinary-work slot during automatic repair drain when capacity and policy allow it.
- [x] Add adversarial regression coverage and run focused/full verification plus independent review.
- [x] Update durable notes, commit, push, reload production, and canary the hardened authority paths.

## Current Overnight Cycle - Temporal Fairness And Shared Claim Utilization
- [x] Rehydrate the deployed causal-authority baseline, CI, production health, git state, Entire state, and durable notes.
- [x] Audit single-slot fairness, shared-queue partial claims, live branch protection, and post-merge trajectory continuity in parallel.
- [x] Alternate eligible ordinary work after an automatic repair on one-slot daemons without weakening explicit drains.
- [x] Refill shared-queue capacity after partial contention without duplicate claims or lane-policy drift.
- [x] Add adversarial fairness, restart, contention, telemetry, evidence migration, origin binding, required-check producer identity, and compatibility coverage plus independent review.
- [x] Run focused/full verification, update durable notes, commit, push, reload production, and canary the new scheduler.

## Current Overnight Cycle - Deterministic Regression Attribution
- [x] Rehydrate the deployed post-merge watcher baseline, current git state, production evidence, Entire state, and durable notes.
- [x] Deploy independent audits for parent-green proof, stable cohort authority, multi-repo monitoring fairness, and adversarial attribution gaps.
- [x] Treat missing commands and infrastructure or tool failures as inconclusive without resetting known-green or RED-streak authority.
- [x] Require same-run direct-parent GREEN and culprit RED under an identical nonempty required-command manifest for deterministic attribution.
- [x] Bind deterministic evidence to the exact applied remote merge commit and canonical repository, and positively verify checkout restoration.
- [x] Preserve monotonic heuristic-to-deterministic evidence upgrades and expose metadata-only proof context in trajectories.
- [x] Add parent, manifest, infrastructure, restore, identity, privacy, precedence, and downgrade coverage.
- [x] Pass focused and exhaustive verification plus independent adversarial review; update durable release notes.
- [x] Commit, push, observe the complete GitHub matrix, reload production, and canary the deterministic attribution path.

## Current Overnight Cycle - Evidence-Only Objective Saturation Quarantine
- [x] Rehydrate the deployed repair-corpus baseline, live lifecycle evidence, git state, and durable notes.
- [x] Audit terminal lifecycle semantics, handoff authority, alias migration, queue retention, and daemon telemetry in parallel.
- [x] Quarantine only after one objective has three unique authoritative empty attempts across at least two non-builtin backends on one durable tier.
- [x] Bind legacy tier hydration to each source generation before alias merge and fail closed on incomplete or contradictory evidence.
- [x] Retain quarantined work for inspection while blocking dispatch and requeue; keep legacy two-empty repairs exhausted.
- [x] Add V1/V2, cross-tier, replay, malformed persistence, queue, and daemon regressions and pass focused verification.
- [x] Pass exhaustive verification and independent final review.
- [x] Commit, push, observe CI, reload production, and canary the lifecycle path.

## Current Overnight Cycle - V2 Handoff Canary And Dispatchable Queue Truth
- [x] Rehydrate the deployed quarantine baseline, live rollout status, lifecycle migration, git state, and durable notes.
- [x] Complete parallel audits of V2 activation, lifecycle-blocked queue selection, dispatch yield, and adversarial migration risks.
- [x] Run a reversible V2 writer canary only while source health and ordinary-parent eligibility remain positive; the bounded natural canary was inconclusive and rolled back cleanly.
- [x] Make Fleet queue eligibility exclude and separately report generated repairs whose lifecycle authority is unavailable or terminal.
- [x] Prune quarantined executable queue projections while retaining their durable lifecycle evidence.
- [x] Add focused status, dispatch, compatibility, retention-boundary, read-only, and fail-closed regression coverage plus independent review.
- [x] Pass exhaustive verification on the frozen tree; commit, push, CI, and production reload remain release steps.
- [x] Observe the complete CI matrix and reload Mission Control with the corrected queue truth.
- [x] Reload the daemon after the post-activation lease cleared without interruption and retain reader-only authority after the inconclusive canary.

## Current Overnight Cycle - V2 Activation Authority And Effective Writer Truth
- [x] Rehydrate the completed bounded canary, production scheduler, rollout journals, and config state.
- [x] Audit canary eligibility, activation provenance, runtime writer compatibility, and dispatch-yield follow-up in parallel.
- [x] Bind rollout promotion to a durable activation identity and post-activation writer/projection evidence so historical V2 rows cannot certify a new activation.
- [x] Distinguish configured and effective writer state, including shared-filesystem queue incompatibility, with a fail-closed operator action.
- [x] Add migration, replay, rollback, incompatible-mode, status, and projection regressions plus independent review.
- [x] Pass focused and exhaustive local verification; commit, push, CI, deployment, and a provenance-complete canary remain release steps.
- [x] Observe the complete CI matrix and deploy at a clean daemon lease boundary.
- [ ] Complete the armed provenance-bound canary, retaining or rolling back only from activation-scoped writer and projection evidence.

## Current Overnight Cycle - Generated Repair Ordinary-Lane Fairness
- [x] Rehydrate the armed activation, live maintenance receipt, scheduler selection path, git state, and durable notes.
- [x] Audit canary opportunity bounds, repair-backlog yield, and atomic shared-claim behavior in parallel.
- [x] Reserve one normal multi-slot claim lane for genuinely ordinary portfolio work when trusted generated repairs are also eligible.
- [x] Preserve total capacity through a full-candidate fallback lane without changing explicit drains, automatic diagnostic drains, or single-slot policy.
- [x] Add an adversarial high-score repair-backlog regression and pass focused scheduler and queue verification.
- [x] Pass typecheck, lint, build, dependency audit, diff checks, exhaustive verification, and independent review.
- [x] Commit, push, observe CI, deploy at a clean lease boundary, and inspect the first production canary opportunity.

## Current Overnight Cycle - Activation Projection Truth
- [x] Rehydrate the exact-source canary, current V2 journal, maintenance receipts, fleet status, git state, and durable notes.
- [x] Audit rollout evidence, generalized repair retry enforcement, and the live proposal-production bottleneck in parallel.
- [x] Prove the current activation has an exact later maintenance receipt for its authority count and both authority digests.
- [x] Remove retained dispatch-blocked lifecycle inventory from otherwise exact authority-journal projection certification.
- [x] Preserve fail-closed source, digest, activation, count, corruption, compaction, and inbox gates and add regression coverage.
- [x] Pass focused status/scheduler/queue/journal tests, typecheck, lint, build, audit, diff checks, exhaustive verification, and independent review.
- [x] Commit, push, observe CI, deploy at a clean boundary, and verify live `retain-writer` truth.

## Current Overnight Cycle - Trusted Repair Retry Authority
- [x] Rehydrate the retained-writer production baseline, live proposal-yield bottleneck, git state, and durable notes.
- [x] Audit lifecycle authority, routing bypasses, and normal-lane route feasibility on disjoint parallel lanes.
- [x] Generalize durable retry policy metadata from diagnostics to every trusted proposal and capture repair class.
- [x] Require one alternate backend on the original durable tier after the first authoritative empty attempt.
- [x] Reject distinct same-backend and cross-tier second-attempt evidence at the lifecycle writer while preserving exact replay.
- [x] Bind normal routing and the final daemon executor guard to the same durable tier and alternate-backend authority.
- [x] Reject invalid split-alias exhaustion and parent-tier-mismatched first evidence before it can become learning authority.
- [x] Add proposal, capture, diagnostic, alias, generation, rollback, router, and executor-drift regressions and pass focused verification.
- [x] Pass exhaustive verification and independent final review.
- [x] Commit, push, observe CI, reload production, and canary the trusted-retry release.

## Current Overnight Cycle - Repair Route Feasibility Observability
- [x] Rehydrate the deployed trusted-retry baseline, production health, git state, Entire state, and durable notes.
- [x] Audit lifecycle snapshots, pre-claim daemon flow, FleetStatus aggregation, and Mission Control compatibility.
- [x] Derive retry policy from the existing point-in-time read-only lifecycle snapshot without rereading mutable authority.
- [x] Add bounded observation-only route feasibility counts and reasons for eligible trusted repair candidates.
- [x] Preserve queue eligibility, `queue.next`, daemon claim authority, and no-directory/no-chmod status invariants.
- [x] Add focused lifecycle, route, and FleetStatus coverage.
- [x] Pass static, adjacent, exhaustive, and independent verification.
- [x] Commit, push, observe CI, reload production, and canary live feasibility truth.

## Current Overnight Cycle - Pre-Claim Repair Route Authority
- [x] Rehydrate the exact deployed route-observability source, live 15/14/1 partition, git state, and durable notes.
- [x] Audit every scheduler lane converging on the atomic shared claim and preserve the final execution guard.
- [x] Read one point-in-time repair queue snapshot and memoize route feasibility for each trusted repair candidate.
- [x] Exclude provably unroutable repairs before normal, automatic-drain, explicit-drain, fairness, and refill claims.
- [x] Preserve lane-scoped causal telemetry with one coherent raw selection denominator.
- [x] Add normal refill, explicit-drain attribution, lifecycle-unavailable, automatic-drain, local-only, and late-divergence coverage.
- [x] Pass exhaustive verification and independent final review.
- [ ] Commit, push, observe CI, deploy exact green source, and inspect production route truth without exceeding the daily cap.

## Current Overnight Cycle - Route Inventory Truth And Context Hygiene
- [x] Preserve the genuine in-flight Phantom dispatch lease while continuing on disjoint control-plane work.
- [x] Audit route-blocked treatment, proposal conversion, causal telemetry, and generated-worktree context pollution in parallel.
- [x] Make FleetStatus eligibility and `queue.next` match the daemon's pre-claim route authority.
- [x] Keep route-blocked repairs visible with a distinct count, route-gated effectiveness, readiness blocker, and read-only restore-routes action.
- [x] Fail closed per trusted repair when route inspection is unavailable while preserving ordinary work.
- [x] Exclude agent/generated worktree roots from repo maps, invalidate legacy scan-policy caches, and refuse symlink traversal.
- [x] Pass focused scheduler, status, lifecycle, and repo-map verification.
- [x] Pass exhaustive verification and independent adversarial review.
- [ ] Commit, push, observe CI, and deploy exact green source after the active lease clears naturally.

## Current Overnight Cycle - Frontier Repair Quality And Causal Release Evidence
- [x] Preserve live work while macOS Desktop access is unavailable by using a clean temporary mirror of `origin/master`.
- [x] Promote fresh trusted ordinary proposal repairs to frontier routing while preserving durable same-tier retry authority and malformed-item fallback.
- [x] Mirror frontier classification in read-only route feasibility so daemon claims and FleetStatus remain consistent.
- [x] Add stable action-only preclaim trajectories for route-infeasible repairs without creating dispatch, spend, cooldown, proposal-yield, lifecycle, or production-attempt authority.
- [x] Bound recurring preclaim trajectories by stable item/reason/policy identity and expose capped decision-row censorship counts.
- [x] Embed exact build revision and clean/dirty provenance in Node and SEA artifacts without runtime Git execution.
- [x] Expose sorted, capped, length-bounded route-block row evidence with explicit omission counts and no raw goals, details, repository paths, or backend metadata.
- [x] Pass focused integration tests, exhaustive verification, dependency audit, clean-build identity proof, independent adversarial review, and cross-platform CI.
- [ ] Restore canonical Desktop workspace access, reconcile its identical pre-existing patch with `origin/master`, deploy exact green source, and prove live revision/route invariants.

## Current Overnight Cycle - Learning Denominator And Build Identity Parity
- [x] Audit workspace proposal-rate math, attention attempt selection, trajectory retention, and build identity surfaces in parallel.
- [x] Use all diagnostic attempts as the proposal/no-proposal rate denominator while leaving failed attempts as the explicit remainder.
- [x] Exclude selection, start, skip, and `dispatched:0` actions from attempt numerators and denominators.
- [x] Deduplicate sandbox and daemon terminal telemetry by normalized causal identity, preferring the canonical daemon dispatch row.
- [x] Prioritize dispatch-rooted trajectories in the bounded learning window and isolate action-only route diagnostics from production, skill, terminal, coverage, and recent denominators.
- [x] Make build identity canonical across FleetStatus, CLI JSON/text, fleet/control/snapshot/pause/resume APIs, Node artifacts, and Bun SEA.
- [x] Remove source-mode environment identity fallback and prove a compiled binary ignores hostile external identity injection.
- [x] Pass focused integration, typecheck, build, dependency audit, exhaustive verification, independent adversarial re-review, and cross-platform CI.
- [ ] Restore canonical Desktop workspace access, reconcile local state, deploy exact green source, and verify live build/learning parity.

## Current Overnight Cycle - Mid-Tier Route Recovery
- [x] Rehydrate the clean release mirror, production fleet state, service boundary, and durable notes.
- [x] Audit the same-tier alternative deficit, recent material-diff yield, and causal backend-learning requirements in parallel.
- [x] Prove Grok supports bounded headless single-turn execution through cached CLI authentication under the launchd environment.
- [x] Canary an argv-only mid-tier Grok override, discover the macOS confinement gap before a fleet child launched, and remove the authorization.
- [x] Add first-class Grok mid-tier routing, minimal confinement, exact argv, and headless adapter coverage.
- [x] Make the existing six-unit repair treatment alter real dispatch context while preserving deterministic assignment and terminal attribution.
- [x] Pass focused, adjacent, exhaustive, static, build, dependency, and independent verification.
- [x] Correct the live evidence policy mismatch by setting `allowSelfMerge:false`.
- [x] Reload Mission Control and the daemon only at a clear guard/zero-child boundary; preserve HTTP health.
- [x] Let the post-reload child finish naturally, then reload the reverted backend allowlist without interrupting work.
- [x] Commit, push, and observe exhaustive Ubuntu/package plus all Windows portability CI.
- [ ] Deploy exact green source, then re-enable Grok with per-engine OS confinement and network egress.
- [ ] Observe the first Grok repair attempt and compare durable proposal conversion against the prior local-coder cohort.
- [ ] Restore canonical Desktop access and deploy the exact green release build.

## Current Overnight Cycle - Transactional Service Release And Treatment Truth
- [x] Rehydrate the clean release mirror, live launchd paths, CI baseline, fleet health, and persistent notes without touching the inaccessible canonical worktree.
- [x] Audit immutable deployment, launchd transactionality, treatment experiment truth, and daemon child-liveness semantics in parallel.
- [x] Make daemon and Mission Control plist installation atomic, serialized with removal, rollback-capable, owner-only, trusted-root bounded, and fail-closed on filesystem traps or false-zero launchctl errors.
- [x] Retain five non-empty rollback snapshots while retiring older bytes through verified file descriptors rather than pathname deletion.
- [x] Expose per-treatment attributed/terminal progress, minimum sample gate, integrity blockers, source-incomplete withholding, and explicitly labeled proposal conversion.
- [x] Add adversarial install/remove, symlink, ownership, mode, rollback, retention, source-health, privacy, and experiment-imbalance regressions.
- [x] Pass focused, adjacent, static, build, dependency, and exhaustive verification on the frozen release tree.
- [x] Commit, push, observe the complete CI matrix, and stage an immutable exact-SHA release outside Desktop.
- [x] Activate the immutable daemon and Mission Control release only after the live child exits naturally; verify no Desktop paths, exact build identity, HTTP health, and clear guard state.
- [ ] Add a metadata-only daemon activity ledger so lock heartbeat and actual child progress are no longer conflated.

## Current Overnight Cycle - Truthful Daemon Activity
- [x] Rehydrate the immutable production release, durable notes, git state, and daemon/status surfaces.
- [x] Audit writer ownership, privacy boundaries, freshness, process reuse, and UI false-zero risks in parallel.
- [x] Add an append-only, metadata-only daily activity journal with exact schema, owner-only storage, bounded retention, and no merge or learning authority.
- [x] Publish starting, tick, post-tick child, idle, stopping, and heartbeat observations from one daemon instance identity.
- [x] Require healthy, fresh, process-matched evidence before FleetStatus asserts active ticks or post-tick children.
- [x] Render missing, degraded, stale, future, and owner-mismatched evidence honestly across CLI, Fleet, Mission Control, and Fleet Dashboard.
- [x] Prove readiness, next-action, mission-brief, and learning authority remain independent of the observational journal.
- [x] Pass focused, adjacent, exhaustive, static, dependency, and two independent adversarial review gates.
- [x] Commit, push, observe CI, and leave production on the proven immutable release until a separate exact-source activation boundary.

## Current Overnight Cycle - Activity Journal Activation And Control-Plane Parity
- [x] Rehydrate exact release proof, production identity, daemon state, git state, Entire state, and durable notes.
- [x] Independently audit immutable activation, rollback criteria, raw daemon API disagreement, and remaining child-liveness gaps.
- [x] Stage and verify an immutable exact-feature release without modifying the live services.
- [x] Prove a real zero-child activation boundary using process-backed evidence, then transactionally activate Mission Control and daemon.
- [x] Canary fresh journal rows, FleetStatus truth, exact build identity, HTTP health, guard health, and rollback readiness.
- [x] Implement one bounded control-plane parity improvement only if activation evidence exposes a concrete safe gap.
- [x] Pass targeted and adversarial verification, update durable notes, and commit/push any resulting code or documentation.

## Current Overnight Cycle - Daemon-Owned Execution Cancellation
- [x] Rehydrate the clean mirror, exact production split, live activity evidence, git/Entire state, and durable notes without interrupting the active tick.
- Operational note: the first parallel explorer launch combined an explicit explorer role with full-history forking, which the agent runtime rejects. No work started and no files changed; agents were relaunched without history forking.
- [x] Map daemon stop authority, tick cancellation propagation, owned process-tree supervision, and unbounded execution edges in parallel.
- [x] Define one explicit daemon-owned execution contract that never signals unrelated or pre-existing processes.
- [x] Implement bounded cancellation through the daemon tick and the smallest complete set of child execution paths.
- [x] Keep activity and daemon state truthful through stopping, escalation, and child settlement.
- [x] Add adversarial Unix/Windows, repeated-stop, late-completion, no-proposal, provider-fallback, and no-signal regressions; use invocation-local process-group authority rather than persisted PID signaling.
- [x] Pass focused, adjacent, exhaustive, static, build, dependency, and independent review gates.
- [ ] Commit, push, observe CI, stage exact source, and activate only at a natural process-backed boundary.

## Current Overnight Cycle - Run And Swarm Persistence Integrity
- [x] Rehydrate the exact production split, durable notes, clean release mirror, CI baseline, and active daemon boundary without interrupting work.
- [x] Harden run and swarm structural validation, embedded-id binding, atomic replacement, randomized temporary cleanup, and cancellation compatibility.
- [x] Make state private at rest and migrate historical regular records to owner-only directory/file modes during successful reads.
- [x] Close case-insensitive direct-load/list disagreement and concurrent case-variant collisions with atomic persistent ownership claims.
- [x] Reject linked state roots, linked store directories, junctions, reparse paths, record symlinks, and non-regular persistence entries.
- [x] Pass focused cancellation/integrity/concurrency tests, exact exhaustive verification, full static/build/dependency gates, and repeated adversarial review.
- [x] Commit, push, pass exhaustive Ubuntu/package plus all Windows CI, and stage a clean no-hardlinks immutable exact-SHA release.
- [x] Promote Mission Control only and prove three exact-identity, guard-clear, owner-matched HTTP canaries without changing the daemon or `current`.
- [ ] Activate the exact daemon and atomically advance `current` only at a stable natural boundary with no tick, descendants, or spend guard.

## Current Overnight Cycle - Cancellation Learning Truth
- [x] Rehydrate the clean release candidate, production process boundary, durable notes, and persistence state.
- [x] Audit cancellation emission, learned-router denominators, trajectory projection, and persistence scalability in parallel.
- [x] Emit first-class metadata-only `cancelled` dispatch and agent-action outcomes without changing downgrade-safe public run/swarm status.
- [x] Classify current and recognizable historical owner/selection/lock-loss cancellations as non-diagnostic control flow.
- [x] Exclude cancellation from learned routing, proposal-yield diagnostics, generated-repair conversion, treatment attribution, and causal-label weakness.
- [x] Preserve hard-budget aborts, authoritative engine error exits, and provider failures as real failures.
- [x] Expose cancellation counts in dispatch summaries, trajectories, attempt coverage, CLI, Mission Control, and Fleet Dashboard.
- [x] Pass focused tests, typecheck, lint, build, dependency audit, and the definitive 492-file suite.
- [x] Resolve independent adversarial review, including Best-of-N precedence, diagnostic bucket ordering, and cooperating-daemon mutation fencing.
- [x] Commit/push, observe CI, and stage exact source.
- [ ] Activate only at a natural stable boundary with no daemon tick, descendants, or spend guard.

## Current Overnight Cycle - Bounded Race-Safe Persistence Reads
- [x] Replace full-history `listRuns()`/dashboard/SSE scans with bounded recent-record readers that count only valid records.
- [x] Read records through opened, `fstat`-verified handles with owner, link, size, byte, identity, and state-root bounds.
- [x] Reuse the reader for swarm history so malformed early directory entries cannot hide valid recent records.
- [x] Share one short-lived bounded run/swarm projection across all SSE clients while preserving REST array compatibility.
- [x] Pass focused integrity/cancellation/API tests, exact exhaustive verification, static/build/dependency gates, and a real-store latency benchmark.
- [x] Commit, push, observe exhaustive cross-platform CI, and stage exact source without interrupting the active production tick.

## Next P1 - Persistence Write Linearizability
- [ ] Add per-ID revision/CAS fencing so concurrent same-ID saves cannot roll completed state backward.
- [ ] Replace permanent case-fold claims with recoverable ownership plus bounded retention.
- [ ] Move historical owner-only mode repair into an explicit bounded migration so observational reads remain non-mutating without preserving permissive legacy state indefinitely.

## Current Overnight Cycle - Persistence Generation CAS
- [x] Rehydrate clean source, exact release proof, live production ownership, and the persistence P1 handoff.
- [x] Audit run, swarm, case-claim, and legacy-mode boundaries in parallel without interrupting production.
- [x] Add shared exact-generation snapshots and crash-recoverable per-ID mutation locks for run and swarm records.
- [x] Make stale writers fail closed without weakening downgrade-safe cancellation or swarm's never-throw storage API.
- [x] Add stale terminal rollback, cancellation, legacy-writer, lock-contention, and cross-process regressions.
- [x] Pass focused, exhaustive, static, dependency, and independent adversarial verification.
- [x] Commit, push, observe cross-platform CI, and stage exact source without activating the busy production daemon.

## Current Overnight Cycle - Recoverable Persistence Ownership
- [x] Rehydrate the clean exact-source mirror, immutable release proof, production boundary, and persistence P1 handoff.
- [x] Audit recoverable case ownership, bounded private-mode migration, and pre-first-commit lifecycle leases in parallel.
- [x] Select and implement the smallest complete high-leverage persistence slice without weakening generation-CAS.
- [x] Add cross-process, crash-recovery, retention, portability, and downgrade-safety regressions appropriate to the slice.
- [x] Pass focused, exhaustive, static, dependency, and independent adversarial verification.
- [x] Commit, push, observe cross-platform CI, and stage exact source without interrupting production.
- Verification note: Vitest 3.2 rejects the attempted `--repeat` convenience flag. The isolated concurrency test and its complete 48-test file both passed after the committed-record fast path removed claim-maintenance overhead.

## Current Overnight Cycle - Pre-Execution Lifecycle Authority
- [x] Rehydrate exact remote source in an isolated persistent worktree without touching unrelated canonical routing edits.
- [x] Audit run, Best-of-N, swarm, background handoff, local-lock, and crash-recovery boundaries with parallel agents.
- [x] Add case-folded run/swarm authority with explicit `claimed` and durable `executing` phases.
- [x] Recover pre-execution crashes, retain post-effect uncertainty as `ambiguous`, and clear only generation-proven or conclusively no-work outcomes.
- [x] Add a cooperating stale-lock reclaimer election, exact lock ownership probes, and live legacy-lock compatibility.
- [x] Make background launch a claimed-authority handoff with a persisted worker takeover hint, authenticated IPC acknowledgment, and no timeout for the acknowledged worker.
- [x] Add independent-process race, dead-owner, background handoff, setup refusal, post-effect checkpoint failure, run/swarm overlap, and Best-of-N regressions.
- [x] Pass the definitive exhaustive suite and final independent adversarial re-review.
- [x] Commit, push, observe cross-platform CI, and stage exact source without interrupting production.

## Next P1 - Effect And Migration Authority
- [ ] Add queue owner token/epoch fencing so an expired shared queue lease cannot authorize duplicate swarms.
- [ ] Add prepared/committed idempotency evidence around tool effects for finer-grained crash recovery than whole-attempt ambiguity.
- [ ] Add an explicit bounded owner-only persistence migration, including protected Windows temporary creation before bytes are written.
- [ ] Add a bounded operator/doctor resolution path for durable ambiguous execution markers with forensic evidence and audit.

## Current Overnight Cycle - Shared Queue Execution Epochs
- [x] Rehydrate exact merged source in an isolated worktree without touching unrelated canonical routing edits.
- [x] Audit shared-store, coordinator, daemon, lifecycle, effect, portability, downgrade, and security boundaries with parallel agents.
- [x] Add downgrade-preserving exact claim capabilities, queue incarnation/epoch metadata, and claimed-to-executing authority.
- [x] Make corrupt reads and stale-lock release fail closed, and expose non-reclaimable executing ambiguity honestly.
- [x] Bind daemon launch, renewal loss, completion, and release to the exact claim generation with per-item cancellation.
- [x] Add same-machine ABA, strict-expiry, takeover, ambiguity, corrupt-state, lock, daemon-launch, and Windows regressions.
- [x] Pass focused, exhaustive, static, dependency, and independent adversarial verification.
- [x] Commit, push, observe cross-platform CI, and stage exact source without interrupting production.

## Current Overnight Cycle - Effect Journal Authority
- [x] Rehydrate exact merged master, immutable release proof, production ownership, CI state, Entire state, and the effect-authority P1 handoff.
- [x] Audit provider, tool, verifier, sandbox, PR, lifecycle, durability, downgrade, and operator-recovery boundaries in parallel.
- [x] Define one explicit prepared/committed effect contract with generation-bound identity, bounded metadata, and fail-closed uncertainty.
- [x] Implement the smallest complete effect-journal slice that materially narrows replay ambiguity without claiming universal exactly-once behavior.
- [x] Add bounded authenticated reconciliation that can attest or abandon ambiguous effects but cannot blindly authorize replay.
- [x] Add crash-window, stale-writer, duplicate-key, tamper, corruption, signing-key, privacy, cross-generation, CLI, and safety-class regressions.
- [ ] Add authenticated immutable terminal-pack retention with crash-safe POSIX cleanup and a proven Windows durability boundary.
- [ ] Add exact no-replay execution-lease reconciliation after effect disposition without clearing or replaying the run.
- [x] Pass focused, adjacent, exhaustive, static, build, dependency, and independent adversarial verification.
- [x] Commit, push, observe protected cross-platform CI, stage exact source, and update durable notes without interrupting production.

## Current Overnight Cycle - Authenticated Terminal Retention
- [x] Rehydrate exact merged master, immutable release proof, production ownership, Entire state, and the two explicit effect-authority blockers.
- [x] Audit immutable terminal packing, crash recovery, overlap semantics, downgrade behavior, Windows durability, and execution-lease reconciliation in parallel.
- [x] Define an authenticated append-only pack and commit-marker contract that never authorizes replay from deletion, age, probabilistic membership, or unauthenticated summaries.
- [x] Implement bounded loose-plus-packed reads and crash-safe POSIX compaction while keeping unsupported Windows source deletion fail closed.
- [x] Add capacity, crash-window, overlap, tamper, rollback-visible, unknown-format, downgrade, POSIX, and Windows regressions.
- [x] Pass focused, adjacent, exhaustive, static, build, dependency, and independent adversarial verification.
- [x] Commit, push, observe protected cross-platform CI, stage exact source, and update durable notes without interrupting production.

## Current Overnight Cycle - Shadow Auto-Merge Canary Authority
- [x] Rehydrate exact protected-remote master, production identity, issue #27, canonical dirty-worktree state, CI proof, Entire state, and durable notes.
- [x] Audit cross-proposal admission, authenticated controller persistence, exact GitHub cancellation truth, docs-only change classification, and positive-learning embargo boundaries in parallel.
- [x] Add a bounded HMAC-chained shadow controller with pure read-only status, cross-process CAS, monotonic counters/high-water time, and `enforceSupported:false` hard-coded.
- [x] Inspect staged Git object metadata for the docs-only class; reject binaries, executable modes, symlinks, gitlinks, mode-only changes, renames, malformed paths, and mixed changes.
- [x] Extend GitHub PR reads with exact base OID and tri-state host auto-merge evidence so explicit `null` is the only cancellation proof.
- [x] Remove pre-outcome `merged` learning credit from manager-gate success while preserving truthful nonterminal authority evidence.
- [x] Integrate read-only Fleet/CLI visibility and shadow activation/halt controls without granting merge, routing, readiness, or learning authority.
- [x] Add explicit realized-merge witnesses so generic applied actions, branches, and contaminated legacy rows cannot create ship or learning credit.
- [x] Connect the immutable staged candidate to a bounded shadow observer whose result cannot affect merge behavior.
- [x] Run focused, cross-process, exhaustive, static, build, dependency, and independent adversarial verification on the expanded truth boundary.
- [x] Commit, push, open protected PR #29, and leave production auto-merge disabled; exact-SHA CI observation is recorded in durable notes.

### Canary V1 Invariants
- Configuration alone cannot create an epoch; only explicit activation may create shadow state.
- V1 cannot enter enforce mode. Host cancellation, learning embargo, rollback proof, and an external monotonic anchor remain activation blockers.
- Read-only status never creates keys, locks, directories, files, repairs, audit rows, or timestamp changes.
- Missing state is inactive; malformed, unsigned, conflicting, future-dated, rollback-suspect, or over-cap state is critical/degraded.
- Local HMAC protects visible integrity but cannot prove freshness after coherent state-and-key rollback.
- Production remains on immutable `f178db34fa6e47eb44df9f3db855943db602ef76` with auto-merge disabled until the complete enforce controller is proven.

## Current Overnight Cycle - Cross-Process Outward Mutation Authority
- [x] Rehydrate protected remote source in an isolated worktree while preserving the canonical routing and test edits.
- [x] Audit every autonomous outward-effect path, deferred task, shutdown boundary, policy transition, sandbox lifecycle, remote handoff, and local merge path with parallel adversarial agents.
- [x] Add one process-wide unforgeable outward-mutation fence and hold it through autonomous execution, capture, verification, staging, push/PR, local merge, fanout, cleanup, and awaited side effects.
- [x] Make KILL and unenrollment durable-before-wait, crash-recoverable, and unable to report quiescence while a cooperating outward effect remains active.
- [x] Add signed exact-remote pre-push intent, bounded retry/reconciliation, local merge receipts, later-base ancestry reconciliation, and realized-merge fanout replay.
- [x] Add durable policy transactions, sandbox reservations, fixed-point daemon drain, token-bound local locks, and authenticated abandoned-guard recovery.
- [x] Make live PID ownership conservative under clock drift, suspend, DST ambiguity, PID reuse, and unknown liveness; reclaim only after the OS proves `ESRCH`.
- [x] Add M403-M424 plus sandbox reservation coverage and native Windows CI partitions.
- [x] Re-prove the expanded physical-identity tree with a final exhaustive suite after closing all legacy fixture and mock-contract fallout.
- [x] Re-run typecheck, build, lint, dependency audit, and diff checks on the exact commit candidate.
- [x] Commit, push, and open protected PR #30.
- [x] Observe the final exact-SHA cross-platform CI matrix.
- [x] Keep production on immutable `f178db34fa6e47eb44df9f3db855943db602ef76`; auto-merge enforcement and deployment remain NO-GO.

## Current Overnight Cycle - Release Native Authority
- [x] Rehydrate the exact green mutation-fence SHA, protected PR state, production NO-GO boundary, persistent roadmap, and canonical user edits.
- [x] Confirm the recorded objective-saturation lane already shipped with three unique attempts across two same-tier editing backends and fail-closed lifecycle proof.
- [x] Make the canonical Ubuntu, three-part Windows, and macOS CI matrix reusable by tag-triggered releases.
- [x] Constrain the reusable verification workflow to read-only repository contents and pass no publish secrets into it.
- [x] Add drift-resistant workflow contract tests and run focused tests, typecheck, lint, build, YAML syntax validation, and dependency audit.
- [x] Run exhaustive verification and independent review on the exact commit candidate.
- [ ] Commit, push, and observe GitHub's exact workflow parse without publishing or deploying.

## Current Overnight Cycle Errors
- Parallel explorer deployment was attempted twice but the collaboration service reported `agent thread limit reached`; the critical path continued locally without duplicating unowned edits.
- The first quiet lint run rejected a counted-space regex in `m33.release-meta`; replacing it with an explicit `{2}` quantifier restored a zero-error lint gate.
- Exact SHA `c304772` passed nine of ten duplicate checks; the push Windows 2/3 runner completed the synchronous sandbox-preservation assertions and cleanup in 7.030 seconds but Vitest applied the default five-second ceiling. Its exact PR twin passed in 3.321 seconds. Only that Git-heavy test now uses the established 15-second integration ceiling.
- Exact SHA `1c4f8d4` exposed the same hosted-runner variance in the PR Windows 1/3 job: the synchronous 201-file goal-source bound fixture completed both assertions in 8.911 seconds, while the exact-tree push twin passed the entire file in 390 milliseconds. Only that fixture-heavy test now uses a 15-second ceiling; production read bounds are unchanged.
- Exact SHA `ead4579` exposed three more duplicate-run asymmetries under severe hosted Windows slowdown. The PR Windows 1/3 runner timed out two filesystem-heavy M113 coordinator ticks at 8.421 and 9.774 seconds while the exact push twin passed all 17 tests in 2.131 seconds; only those tests now use 15-second ceilings. The push Windows 3/3 runner took 192.316 seconds for M315 and observed one fail-closed `unknown` terminal reconciliation while its exact PR twin passed; the test permits one daemon-equivalent retry only when the dedicated key diagnostic is exactly `adapter-failed`, and proves the proposal remains `awaiting-host-merge` with its exact PR URL between attempts. Push Windows 2/3 took 84.564 seconds for the five serial M424 tests and crossed two existing 30-second integration ceilings while the exact PR twin passed them in 13.820 and 9.767 seconds; only those two bounded lifecycle tests now use 60-second ceilings. Production ACL, swarm, and merge-authority deadlines are unchanged.
- The first definitive local suite attempt on the corrected candidate emitted no per-file output under Vitest 4 and reached `test-ci`'s default 300-second idle watchdog before its final summary. The harness correctly classified this as a silent run rather than a test failure or leaked handle. The same exact candidate then passed all 534 files with 11,221 tests green and 9 intentional skips in 623.84 seconds using a one-off 12-minute idle bound inside the unchanged 15-minute hard-runtime cap.
- Exact SHA `63364ca` passed nine of ten initial checks. Push Windows 2/3 exhausted both 60-second M424 ceilings while its exact PR twin passed at 10.136 and 11.110 seconds; four audits traced the cost to repeated synchronous Windows DACL probes across thirteen real swarm checkpoints, not an authority deadlock. M424 now mocks only that separately covered adapter, preserves every lifecycle primitive, and restores 30-second ceilings. The rerun passed all 210 main-roster assertions, then its separate M426/H7 step passed the authority body but exhausted the existing 5.5-second `EBUSY` cleanup envelope for a dead temporary `git.exe`. Cleanup now defers only transient Windows executable locks, retries every retained path, and fails strictly at the bounded final pass.
- Vitest 4 rejects the attempted `--repeat` convenience flag. The unsupported command changed no files; focused M424, M425, M379, M426, and H7 coverage plus the exhaustive suite remain the verification authority.
- The final combined M424/M426 candidate passes all 534 files with 11,221 tests green and 9 intentional skips in 608.09 seconds under the unchanged 900-second hard cap.

### Final Verification Recovery
- The first serial exhaustive pass after physical identity hardening found 95 failures across 18 files; focused repairs reduced the fast discovery pass to 73 failures across 14 files.
- Four disjoint workers repaired the compatibility fixtures and mocks for the stricter canonical enrollment/proposal/goal-source contracts; the timing-sensitive deadline assertion now uses an injected clock without relaxing production budgets.
- Final adversarial review found and closed source/common-directory and post-create sandbox path races, healthy-empty alias enrollment projections, missing remote and local realized-merge fanout authority, and two native CI coverage gaps.
- Native CI exposed six masked portability defects: a two-backslash preload replacement that did not normalize Windows paths, synchronous tool probes that could wait on a SIGTERM handler, Windows `UNKNOWN` results for physically resolvable 8.3 ancestors, rounded numeric Windows file identities, worktree failure provenance recomputed after rollback changed the observed path state, and a private POSIX-only dispatch-manifest directory `fsync`.
- The fixes normalize each Windows separator before Node parses `NODE_OPTIONS`, use bounded `SIGKILL` probe termination, resolve `UNKNOWN` ancestors physically before guarded absence fallback, transport exact BigInt file identities and pin the published reservation metadata, freeze reservation truth before rollback, and reuse the validated cross-platform directory-durability helper.
- Eight changed physical-identity files now run fourteen named Windows cases in a dedicated hermetic step. This preserves native junction and canonical-path evidence without importing unrelated legacy POSIX assumptions from their full files into the stable portability partitions.
- The first full-file roster experiment failed deterministically and was replaced rather than waived: Windows 1/3 exposed unrelated legacy assumptions, while Windows 2/3 independently exposed the 8.3 and rollback-provenance defects. Both exact Ubuntu exhaustives, both macOS jobs, and both Windows 3/3 jobs on that intermediate production source remained green.
- The pre-native-recovery exhaustive baseline passes 534 files with 11,218 tests green and 9 intentional skips in 600.54 seconds, plus typecheck, build, zero-error lint with the unchanged 104-warning baseline, zero-vulnerability audit, and diff checks. Final exact-SHA Ubuntu CI remains the exhaustive authority after the native corrections.
- Authority reads remain fail closed for lexical or missing physical enrollments. Tests that represent healthy state must create and use physical canonical paths; malformed and legacy-state tests must remain explicitly degraded.
- Windows-only runner variance also crossed the old local bounds for one 256-commit fixture and one synchronization-heavy lifecycle test in only one of two duplicate exact-SHA jobs. Their behavioral assertions are unchanged; the per-test ceilings are now 45 and 30 seconds while production deadlines remain untouched.
- Final adversarial review then closed adjacent authority races: metadata publication now compares exact BigInt directory and opened-file identities through rename; rollback revalidates and monitors the reservation around every Git mutation, including the exact worktree while removal is allowed to make it absent; and the parent independently brackets exact HEAD, branch, and retained common-directory association reads with the child-attested worktree plus source/common/reservation identity pins before returning success.
- Rollback separately proves an initially absent worktree remains absent, and all worktree discovery/validation Git processes strip inherited `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_COMMON_DIR`. Native adversarial fixtures now force both an absent path appearing during removal and hostile repository-selection overrides.

### Authority Limits
- Manual human-confirmed apply and desktop actions do not yet share universal durable pre-effect intent and reconciliation.
- Older host auto-merge requests are not automatically revoked; this production installation has never enabled auto-merge.
- Cooperative locks cannot stop an uncooperative same-user process, and external engines remain outside a filesystem jail beyond the cooperative sandbox protocol.
- Host-local evidence cannot prove freshness after coherent state/key rollback; an external monotonic anchor remains required for enforcement.

## Dispatch Attempt Proof Cycle (2026-07-14)
- [x] Rehydrate exact green release-native authority SHA `080f8b9`, protected PR #31, production NO-GO state, canonical user edits, and Entire status.
- [x] Define an observational, metadata-only, owner-writable-local dispatch-attempt proof contract without claiming cryptographic trust, rollback protection, or cross-ledger atomicity.
- [x] Implement bounded writer-canonical partition reads, exact target matching, derived route/model/backend identity, and strict generated-repair lineage checks.
- [x] Remove proof-reader writer-lock contention, bound target/date/byte/row work, and make matching linear in partition rows plus targets.
- [x] Bind ordinal two to exactly one distinct ordinal-one attempt on the same tier and declared previous backend; propagate degraded predecessor authority.
- [x] Add adversarial M342 coverage for malformed/torn/empty/oversized storage, replay/conflict, runtime-invalid targets, allocation bounds, contradictory no-diff evidence, impossible metadata, producer normalization, and sequence ambiguity.
- [x] Pass focused and adjacent tests, daemon-producer compatibility, typecheck, lint, build, dependency audit, diff checks, and four independent final SHIP reviews.
- [x] Repair two M141 fixtures exposed by the first exhaustive pass that constructed future `01:00Z` rows during the UTC-midnight hour.
- [x] Pass the exhaustive hermetic suite on the exact candidate: 534 files, 11,238 tests green, and 9 intentional skips in 600.68 seconds.
- [ ] Commit, push, open a stacked protected PR against `codex/release-native-authority`, and observe the exact-SHA ten-check matrix without merging or deploying.

## Lifecycle Attempt Authority Cycle (2026-07-14)
- [x] Rehydrate the exact dispatch-attempt proof SHA in an isolated worktree while preserving canonical user edits and production NO-GO state.
- [x] Bind diagnostic empty-diff and proposal-created lifecycle transitions to canonical immutable dispatch receipts.
- [x] Make daemon dispatch production persistence precede lifecycle adoption and withhold settlement/cooldown authority on incomplete writes.
- [x] Add receipt-complete generation resolution that avoids global partition scans and remains valid across long outages and mature ledgers.
- [x] Reconcile crash-persisted empty and proposal attempts directly from exact generation receipts without trusting caller-only evidence.
- [x] Preserve generation authority across unchanged parent recurrence and current writer activation rollover.
- [x] Make terminal treatment publication immutable, idempotent, proof-revalidated, and recoverable after acknowledgement-save failure.
- [x] Keep proofless legacy terminal rows observable and unpublished without mutating them during reads.
- [x] Restore acknowledgement compatibility by requiring an exact already-durable treatment receipt and terminal attempt proof.
- [x] Add native Windows receipt-path coverage plus adversarial lifecycle, recovery, replay, corruption, and portability tests.
- [x] Pass the focused authority matrix: 7 files, 570 tests; typecheck, build, zero-error scoped lint, dependency audit, and diff checks.
- [ ] Pass the final exhaustive hermetic suite and independent final review on the exact candidate.
- [ ] Commit, push, open a protected stacked PR against `codex/dispatch-attempt-proof`, and observe the exact-SHA matrix without merging or deploying.

## Authority Re-Review And Repair-Amplification Cycle (2026-07-15)
- [x] Rehydrate the isolated authority worktree, canonical user edits, green stacked PRs, immutable production release, and Entire state.
- [x] Run fresh adversarial reviews after the initial focused-green result instead of treating test counts as release authority.
- [x] Fix terminal caller forgery, oversized-partition publication, rollback-marker adoption, generation-bound retention, and lifecycle memory amplification.
- [x] Fix stale FleetStatus action authority and the disabled-auto-merge false-idle contradiction.
- [x] Close post-retention protocol rollback, missing-protocol quality, alias-family reservation expansion, and pre-dispatch degraded-source blockers.
- [x] Preserve proposal authority through lifecycle alias merges and finish retained-proof fallback on exact v5/v4 writer output.
- [x] Establish treatment receipt/retention-marker DACLs in the real writer and include exact-DACL cases in the native selector.
- [x] Finish full crash-state fixture validation and reduce lifecycle serialization memory headroom.
- [x] Close ordinary/diagnostic outbox separation, schema-v1 acknowledgement migration, pre-spend attempt-quality refusal, stale diagnostic duplicate authority, and split alias-family degradation.
- [x] Re-run corrected focused integration plus typecheck, changed-file lint, build, dependency audit, and diff checks.
- [ ] Run the exact native Windows selectors, exhaustive hermetic suite, and final independent review on this corrected tree.
- [ ] Update exact counts, commit/push a protected stacked PR, and keep production, auto-merge, self-merge, release, tag, and deploy unchanged/NO-GO.

## Next P2 - Enrollment Read Truth
- [x] Add a read-only typed enrollment-registry snapshot that distinguishes missing-empty from malformed/degraded authority without invoking mutation recovery.
- [x] Propagate degraded enrollment into FleetStatus queue source quality, autonomous ship readiness, readiness preflight, and doctor; never render it as healthy-zero.
- [x] Preserve the legacy `listEnrolled(): string[]` compatibility contract while adding explicit policy, M49, readiness, and doctor regressions.
- [x] Reject symlinked or identity-changing `.ashlr` authority directories and make the writeability sentinel exclusive, no-follow, inode-bound, and replacement-safe.
- [x] Prove prepared enrollment transactions remain byte-identical under read-only snapshots and repair a stale daemon fixture without weakening production tier or settlement checks.
- [x] Pass the exact exhaustive suite: 534 files, 11,387 tests green, 11 intentional skips, 0 failures in 656.17 seconds under the unchanged 900-second hard cap.
- [ ] Run the exact selectors on a native Windows host; the macOS replay passed 733 selector executions with 565 platform skips/filters but is not Windows authority.

## Next P0 - Root-Bound Repair Admission
- [ ] Add explicit metadata-only repair root identity and depth to work items and proposals; never infer lineage from titles.
- [ ] Enforce one active repair per root and an initial maximum repair depth of one, with legacy unknown-root repairs withheld fail closed.
- [ ] Unify capture/no-diff admission by root objective and make terminal pruning projection-complete and failure-visible.
- [ ] Add root-level amplification and escape-funnel metrics: roots, descendants, depth, cap denials, proposal, verification, merge, and stable-window outcomes.
- Live evidence: 68/80 queue rows are generated repairs, reconstructed chains reach depth 15, seven roots have multiple queued descendants, and one root has 20 rows.

## Ruthless Operational Readiness Audit (2026-07-15)
- [x] Recheck live daemon, guards, queue, verifier coverage, resource posture, attempts, trajectories, merges, and learning sources instead of relying on prior green tests.
- [x] Confirm the fleet is safe and observable but not fully autonomous: 0 dispatch attempts, 0 trajectories, 0 merges, and 0 realized outcomes in the current 24-hour window.
- [x] Quantify historical proposal yield: 372 dispatch outcomes produced 15 proposals (4.0%); 171 were empty diffs, 100 gate-blocked, 29 capture errors, and 175 repair attempts.
- [x] Confirm all 24 enrolled repositories have valid explicit merge contracts, while 19 are silent and 53/74 visible backlog rows are concentrated in Phantom.
- [x] Keep production merge authority disabled while the candidate still has open P1 findings and lacks native Windows/exhaustive evidence.
- [ ] Close the final readiness, handoff, dispatch, lifecycle, repair-root, and proposal-source completeness findings with focused adversarial tests.
- [ ] Re-run exact static, focused integration, exhaustive, local selector, and native Windows gates on one frozen tree.
- [ ] Run a proposal-production canary with root-depth one, production-velocity routing, and explicit throughput SLOs before any auto-merge activation.
- [ ] Activate docs/additive-test auto-merge only after protected remote preflight and complete causal/post-merge evidence; source changes remain gated.

### Operating Decision
- Optimize useful closed-loop throughput, not tick count, memory volume, goal count, or raw agent concurrency.
- The next canary must produce at least 20 unique root attempts, at least 5 merge-grade proposals, greater than 30% proposal yield, 100% causal spine coverage, and no repair descendant deeper than one.
- Recursive learning requires route -> attempt -> proposal/no-proposal -> verification -> protected merge/rejection -> stable/adverse post-merge classification. Event collection without realized outcomes is observational telemetry, not self-improvement.

### Audit Checkpoint Result
- [x] Restore complete proposal authority for the current 671-file inbox under the bounded 4,096-file/64-MiB reader contract.
- [x] Make readiness writeability checks genuinely read-only and close degraded enrollment action authority.
- [x] Close the reviewed lifecycle proposal-fence, duplicate-row, commit-marker, terminal-reader, and retained-receipt races.
- [x] Close the reviewed handoff replay, durability, combined-source, torn-tail, capacity, compaction, and burst-test defects.
- [x] Add canonical root/depth metadata, fail-closed legacy handling, root-local contention, atomic root admission, and reservation binding.
- [x] Pass the seven-file integrated authority matrix: 578 tests green with 6 intentional platform skips, plus typecheck, quiet lint, build, zero-vulnerability audit, and diff checks.
- [ ] Close remaining P1s: retired treatment identities suppress raw rows; compaction allocation is aggregate-bounded; native Windows covers the protocol-anchor DACL; failed-attempt receipts remain exact beyond 24 hours.
- [ ] Run exhaustive hermetic and native Windows verification on one frozen tree before staging, commit, push, or PR.

## Adversarial Authority Closure - Second Pass (2026-07-15)
- [x] Make raw treatment rows non-terminal and require canonical immutable treatment receipts for terminal authority.
- [x] Bound treatment compaction allocations and add exact receipt recovery beyond capped raw analytics history.
- [x] Add root-scoped execution reservations so a crash-left marker fences every descendant of the same repair root.
- [x] Reconstruct exact diagnostic and ordinary success outcomes after receipt-before-lifecycle crashes; keep receiptless failures reserved and fail closed.
- [x] Bind ordinal-two alternate attempts to the failed ordinal-one backend and strip resident-safe persistence classification after any later critical persistence failure.
- [x] Pass the first corrected integrated matrix: 593 tests with six intentional platform skips, plus typecheck, quiet lint, build, zero-vulnerability audit, and diff checks.
- [x] Independently reject the implementer-green ledger after finding four additional P1s: retirement resurrection after raw partition deletion, duplicate raw events across failure-intent crashes, undiscoverable valid receipt sets above 256, and per-file Windows DACL probes hidden behind a batch preflight.
- [ ] Preserve root/depth on generic success receipts and close the current four M201 integration failures; latest evidence is 211/215 green.
- [ ] Close all four fresh ledger P1s with exact crash, deletion, maximum-cardinality, and native-DACL selector coverage.
- [ ] Run fresh independent reviews of the corrected daemon/lifecycle and ledger/storage trees; focused green tests alone are insufficient.
- [ ] Freeze one exact tree, rerun the full focused matrix and static gates, then run the 534-file exhaustive suite with the 900-second hard cap and a 720-second silent-run allowance.
- [ ] Replay every Windows selector locally and require protected native Windows authority before staging, commit, push, or PR.

### Corrected Tree Checkpoint
- [x] Close treatment retirement resurrection after raw partition deletion, duplicate failure events across intent crashes, 2,048-receipt discovery, and hidden per-file Windows DACL probes.
- [x] Separate modern exact treatment authority from bounded raw analytics; preserve raw fallback only for legacy schema v1.
- [x] Recover failure-intent appends from exact offset, digest, physical file identity, size, and timestamps without scanning an oversized partition or assuming absence.
- [x] Keep persistent treatment publication failure visible across no-backlog and all-skipped ticks until exact recovery, with critical persistence failures dominating resident-safe classification.
- [x] Make ordinal-two diagnostic success publishable from its lifecycle capsule, bind alternate failures across legitimate generation aliases, and keep ordinary proposal lifecycle authority valid after raw partition cap, rotation, or deletion.
- [x] Pass the corrected eight-file authority matrix: 624 tests green, six intentional platform skips, zero failures in 103.14 seconds.
- [x] Pass typecheck, quiet full lint, production build, zero-vulnerability dependency audit, and `git diff --check` on the corrected tree.
- [x] Migrate bounded schema-v1 retirement into exact modern tombstones before protocol mutation; preserve authority after raw deletion and fail closed with prior bytes unchanged on incomplete legacy history.
- [x] Require exact aggregate membership for every compact treatment marker; committed readers reject orphan, extra, missing, conflicting, unsafe, replaced, or mutated markers.
- [x] Separate objective control families, compatible active evidence aliases, and strict parent-row proof aliases; restore split-family degradation and writer-rollback queue suppression.
- [x] Add the missing native Windows selectors for append crash, oversized offset recovery, mutation/refusal, and maximum-cardinality batch assurance.
- [x] Pass the final corrected eight-file authority matrix: 639 tests green, six intentional platform skips, zero failures in 137.90 seconds.
- [x] Pass final typecheck, quiet full lint, production build, zero-vulnerability dependency audit, and `git diff --check`.
- [x] Receive SHIP from the final alias/control review and the one-question compact-membership review on this exact tree.
- [x] Run the exhaustive 534-file hermetic suite with the 900-second hard cap and 720-second silent-run allowance: 11,470 passed, 17 skipped, six failed across two files in 821.95 seconds.
- [x] Close the exhaustive regressions: pin the M402 canary fixtures to an injected active clock and preserve canonical root/depth metadata in the M170 repair fixture without weakening production checks.
- [x] Rerun the corrected files, expanded authority matrix, static gates, and full exhaustive on one unchanged tree: 534 files, 11,476 passed, 17 skipped, zero failures in 756.28 seconds.
- [x] Replay every exact Windows workflow selector locally: 751 passed, 739 platform/filter skips, zero failures across all three portability partitions and both native authority steps.
- [ ] Require protected native Windows authority before staging, commit, push, or PR.

### Ruthless Product Verdict
- Ashlr Hub is a high-assurance autonomous control plane, not yet a high-output autonomous product factory.
- Current autonomy grade is approximately 3/10; safety and observability are approximately B+.
- The audited 24-hour window produced zero dispatch attempts, trajectories, evidence packs, merges, or realized outcomes despite healthy daemon and guard processes.
- The current optimization target is `stable realized improvements/week`; an initial credible target is three to five, with proposal yield above 30% in the bounded 20-root canary.
- Agent count, event volume, queue size, and memory count are not success metrics. Do not expand generation until repair depth is one, active goals are capped at four, source authority is healthy, and the escape funnel closes through protected merge plus stable/adverse post-merge classification.

## Next P0 - Realized Learning Eligibility
- [ ] Add an observation-only `LearningEligibilityV1` projection joining dispatch, proposal/no-proposal, verification, protected merge/rejection, and stable/adverse/inconclusive outcome by authenticated identity.
- [ ] Persist the complete evaluated candidate-set digest, eligibility/refusal vector, policy version/epoch, and selection-propensity availability without raw prompts, diffs, output, environment, or repository contents.
- [ ] Keep `policyEligible:false` and `recursiveLearningEligible:false` until denominator completeness, stable/adverse precedence, and multi-epoch sample gates are independently proven.
- [ ] Stop learned-router positive credit at merge realization; consume realized post-merge outcomes only after the eligibility contract becomes authoritative.

## Next P0 - Judge-Free Enforcement Closure
- [ ] Expand test-weakening protection to every merge, canary, provenance, mutation-fence, and rollback-control suite; prove assertion removal is detected for each protected file.
- [ ] Require producer-v2 provenance bound to proposal, repository, source revision, route, and diff identity; sign the evidence pack itself and reject legacy-only evidence for judge-free authority.
- [ ] Require a safe minimum branch-protection policy, including strict checks, admin enforcement, no bypass actors, no force pushes/deletions, and explicit signature policy.
- [ ] Constrain the first enforceable canary to the deterministic docs-only classifier and implement serialized admission, confirmed host enable/cancel, deterministic rollback, and external rollback-resistant freshness.

## PR #33 Native Windows Authority Repair (2026-07-15)
- [x] Publish lifecycle attempt authority as `d3f534b` on protected stacked PR #33 without merging, releasing, deploying, or enabling auto-merge.
- [x] Diagnose the exact-SHA Windows failure as one shared root cause: the outward lock recursively created inherited-ACL `.ashlr` state before enrollment could exact-inspect it.
- [x] Secure fresh `.ashlr` and `.ashlr/authority` directories before local lock creation; inspect pre-existing directories without rewriting them and refuse unsafe roots or fence children.
- [x] Bind partial and full registry recovery mutations to the originally verified `.ashlr` filesystem object.
- [x] Add native proofs for exact fresh-root/fence DACLs, unchanged permissive-root refusal, and permissive nested-fence refusal; keep selector alternatives unique and manifest-bound.
- [x] Repair Windows fixture isolation in M2/M113 and the missing-HOME assumptions exposed in M271/M273/M274 without weakening production authority.
- [x] Pass focused authority verification: 119 passed with four platform skips; the eight exhaustive regressions were repaired and all 23 affected drain/judge tests pass.
- [x] Pass typecheck, full lint with the existing warning baseline only, build, zero-vulnerability audit, and diff checks.
- [x] Pass the corrected exhaustive suite: 534 files, 11,476 passed, 20 intentional skips, zero failures in 747.99 seconds.
- [x] Receive independent SHIP on the final security boundary with no P0/P1 findings under the declared current-user/SYSTEM/Administrators trust model.
- [x] Push correction `594a5c4`; both protected macOS jobs passed, while duplicate Windows portability 3/3 jobs crossed the five-minute no-output watchdog before their first file result.
- [x] Add real per-test dot progress to Windows portability 3/3 without synthetic heartbeats or a larger timeout; bind it in M30 and replay the exact selector locally (170 passed, one platform skip).
- [x] Close the genuine Windows 1/3 and 2/3 fixture failures with coherent home authority, production-secured roots, and exact environment restoration; do not relax production gates or timeouts.
- [x] Amortize repeated Windows first-use ACL proof only for the same exact root and authority filesystem objects, with replacement/different-root/unsafe-root regressions.
- [x] Remove quadratic byte counting from the M360 100,000-record cap fixture; the exact case now completes in 1.91 seconds and full M360 passes in 20.54 seconds.
- [x] Replay all three local Windows partitions and native alias authority: 285+213+170+31 assertions passed with two intentional platform skips.
- [x] Pass the final frozen exhaustive suite: 534 files, 11,479 passed, 20 intentional skips, zero failures in 750.66 seconds.
- [x] Push the reporter correction as `c0cbe59`; protected macOS passed, while Windows portability 1/3 exposed three remaining permissive legacy fixtures.
- [x] Repair M403/M415/M422 through production-secured roots and exact private artifact assurance; combined focused verification is 29/29 and the exact local Windows 1/3 contract is 285 passed with one intentional skip.
- [x] Move first-use ACL setup outside timed M23/M411 test bodies and secure the M426 real root before its junction alias without changing production gates or test timeouts.
- [x] Preserve the required Windows 3/3 check while splitting its active-progress workload into a bounded overflow job; local contracts pass 66/66 and 104 with one platform skip.
- [x] Close `e45a583` native 1/3 and overflow fixture findings without production or timeout changes; six-file integration is 61/61 and corrected local contracts are 285+104 with two platform skips.
- [x] Close the final native 2/3 authority/path separation findings and amortize M315 real private-storage proof without weakening handoff semantics; corrected 2/3 is 213/213 and 3/3 is 66/66 locally.
- [x] Remove the final M315 runner-speed race by splitting its real authority proof into bounded hooks without increasing hook, test, idle, or hard-runtime budgets.
- [x] Close the `fa2e010` duplicate-run fixture costs in M2/M23/M220/M411/M415/M418/M422, and make M426 spell the retained Git registration through an alias without placing mutation authority behind that alias.
- [x] Replay the corrected local Windows contracts on one tree: 1/3 passes 285 with one skip, 2/3 passes 213, 3/3 passes 66, and overflow passes 104 with one skip; typecheck, build, zero-vulnerability audit, and diff checks pass.
- [x] Classify the `fcc12d0` native-only failures: M201/M342/M423 repeated PowerShell DACL work, M22 split Windows home authority, and M426 synthetic retained-registration behavior; no production authorization regression was found.
- [x] Preserve explicit real native proofs while moving redundant semantic cases onto Windows-only private-storage adapters; make M22 coordinate all home variables and make M426 use Git-native locked alias retention.
- [x] Pass the five-file correction matrix with 424 assertions green and four platform skips, plus typecheck, full lint at the existing warning baseline, build, zero-vulnerability audit, diff checks, and independent SHIP review.
- [x] Classify `4957f59`: every Ubuntu, macOS, overflow, and 3/3 duplicate passed; the remaining native selector failures were confined to M22/M342/M360/M362 fixture authority and M23/M426 Windows Git/runtime behavior.
- [x] Preserve real native-DACL proofs while scoping semantic adapters, keep M22's local authority adapter live, move M23 bootstrap into fixture setup, and make M426's rollback race production-monitor-owned.
- [x] Pass the corrected eight-file integration (643 passed, six skipped), exact native path/lifecycle selector (52 passed), 2/3 (213), 3/3 (66), native alias (31), and all static/security gates.
- [x] Push `7d4e637` and classify its remaining duplicate failures: one fail-closed M315 authority acquisition plus M342 batch timeout and incomplete M360/M362 semantic adapter coverage.
- [x] Keep single-path assurance at five seconds, give bounded batch assurance the 15-second ceiling, remove M315's redundant DACL proof, and preserve dedicated native authority in M379/H4 plus explicit lifecycle proofs.
- [x] Pass M315/M342/M360/M362/M379 (387 passed, seven skipped), exact 3/3 (66 passed), typecheck, changed-file lint, and diff checks.
- [x] Classify both 2/3 duplicates: Windows Git legitimately removed the locked alias registration, and one unrelated M426 path case exhausted its 15-second body on redundant DACL startup.
- [x] Fault-inject only worktree remove/prune after a real alias registration, prove residual inventory and attempted cleanup, and keep M426 path semantics behind the real mutation fence with dedicated ACL proofs elsewhere.
- [x] Pass full M426 (19/19), M23+M426 integration (49/49), typecheck, changed-file lint, and diff checks.
- [x] Pass full lint at the existing warning baseline, build, zero-vulnerability audit, and independent final SHIP review with no P0/P1 findings.
- [x] Classify `a5ce1a7`: Ubuntu exhaustive, macOS shared-queue authority, Windows overflow, and Windows 3/3 passed in both duplicate runs; native 1/3 retained 24 lifecycle failures and native 2/3 retained one cleanup-injection failure.
- [x] Isolate M342/M360/M362 into independent hermetic Vitest processes while preserving the exact manifest, selector set, five-minute idle watchdog, and one aggregate 15-minute hard cap.
- [x] Replace the still-bypassed Windows cleanup shim with deterministic remove/prune fault injection at the production `execFileSync` boundary; preserve real Git creation, alias spelling, locks, inventory, branch deletion, and postcondition reads.
- [x] Isolate the remaining M342 failures to its three deliberate real-DACL cases, grant only that native test adapter the existing 15-second bounded ceiling, and keep production's five-second default unchanged.
- [x] Remove unrelated Windows ACL startup from M413 cancellation/finalization semantics while retaining the real mutation fence, kill-switch, cancellation, and cleanup authority.
- [x] Pass the checked-in native lifecycle command (52 selected assertions), full M342 (137 passed, four skipped), full M426 (19/19), exact 2/3 (213/213), M413 (1/1), M30 (7/7), typecheck, full lint at the unchanged baseline, build, zero-vulnerability audit, diff checks, and independent SHIP review.
- [x] Classify `c4fe878`: M413 is green in both 2/3 duplicates, while setup-time module caching bypasses the M426 child-process mock and M342's same three exact native assertions remain unresolved despite the test-only 15-second ceiling.
- [x] Replace M426 injection with a fault-only `gitRun` pre-execution hook that cannot mutate argv, suppress a permitted command, or fabricate Git output; reset in both `finally` and `afterEach`.
- [x] Add authenticated native diagnostics for M342 intent DACL, broadened directory reasons, and the 512-file retention batch preflight without weakening any expected authority outcome.
- [x] Classify `21e1a57`: both 2/3 jobs exposed a Git-format separator defect in the alias backlink; native M342 exposed an imprecise unsafe-source projection, a timing-dependent durable-intent fixture, and Administrator-owned manually seeded receipts. One PR-native run also exceeded two five-second M201 junction cases.
- [x] Write alias backlinks in Git `/` syntax with exact porcelain assertions, inject the attempt crash after the durable intent fsync, preserve `source-unsafe` in the batch resolver, normalize only the manually seeded receipt owners, and grant the two real junction cases bounded 15-second bodies.
- [x] Pass combined M201/M342/M426 verification at 373 passed with four platform skips, full M426 at 19/19, M30 at 7/7, typecheck, quiet full lint, and diff checks; receive independent agreement on all three native root causes.
- [x] Classify `cedb906`: M426 passes both its main and native-alias executions, closing the Git backlink defect. M342 still launches one redundant post-crash PowerShell inspection, its broadened-directory proof retains a five-second body, and its JSON path array is treated as one PowerShell object. Single-duplicate M405/M408/H7 timeout clusters are unrelated runner-load variance.
- [x] Bind the intent crash hook to the exact path only after production exact inspection and directory fsync, prove existence and bytes without a redundant adapter process, iterate owner paths as scalar static file ACL calls, and grant the multi-adapter directory proof a bounded 60-second native body.
- [x] Classify `b698317`: both native 1/3 runs now pass every M342 case except the durable-intent setup, which fails before reaching the assured hook on its first attempt. Both directory/owner corrections pass, and macOS, 3/3, and overflow pass in both duplicate runs.
- [x] Bound durable-intent setup recovery to three attempts and accept only the attempt that reaches the post-exact-inspection/fsync hook with the canonical path, live file, and expected bytes; deterministic authority failures still exhaust the bound and fail.
- [x] Classify `6407e57`: both native 1/3 runs exhausted all three M342 setup attempts before the assured hook in 202-215 seconds, while both native 2/3 runs completed H7 rollback behavior after its existing deadlines. Treat both as repeated native fixture cost, not runner noise.
- [x] Make M342's crash attempt ordinal two of the already-admitted generation, route only its exact intent and dot-delimited stage path through the real native adapter, assert the exact two native call tuples, remove retries, and restore full native mode before later DACL proofs.
- [x] Give H7 one explicit real outward-fence authority proof and use the Windows semantic adapter only for its repeated rollback-behavior cases; preserve every assertion and the existing 5/15-second deadlines.
- [x] Pass M342/H7/M30 at 156 assertions with four platform skips, full quiet lint, typecheck, build, zero-vulnerability audit, diff checks, and independent SHIP with no P0/P1 findings.
- [x] Classify `2cd75e1`: H7 passes both native 2/3 duplicates and M342's exact intent stage/final proof passes both native 1/3 jobs; only the later retention recovery trigger still fails after repeated unrelated ACL assurances. Both Ubuntu, macOS, and 3/3 duplicates pass; one PR-only M407 overflow timeout is duplicate-asymmetric.
- [x] Route only the retention marker's atomic stage rewrite and final canonical path through the real native adapter, assert the exact two calls, restore full native mode, and retain the final real readback inspection.
- [x] Repass M342/H7/M30 at 156 assertions with four platform skips plus typecheck, focused lint, and diff checks after the retention correction.
- [x] Classify protected `789ee10`: both native 1/3 duplicates complete retention recovery but record six canonical pre-rewrite inspections before the exact stage/final pair; all 2/3, 3/3, and overflow duplicates pass, while one PR-only macOS M426 marker read races the production destination monitor.
- [x] Make M342's selective native contract transaction-aware so only the successful stage creation and first post-stage canonical inspection delegate to the real adapter; publish M426's out-of-band randomized-path marker before making the monitored path appear.
- [x] Pass the corrected M342/M426/H7 integration at 168 assertions with four platform skips, repeat the M426 race case 20/20, and pass typecheck, full quiet lint, build, zero-vulnerability audit, and diff checks.
- [x] Push `480dcab` and classify its protected duplicates: M342 passes all 17 native cases in both 1/3 jobs, and both 2/3, 3/3, overflow, and macOS jobs pass; completing M342 exposes the same six latent M360 fixture failures in both native 1/3 jobs.
- [x] Remove M360's hook-name-dependent adapter selection, keep only handoff/proposal prerequisites semantic, and explicitly re-enter native mode for dispatch receipt creation plus the exact lifecycle root, treatment directory, retention file, lifecycle publication, marker, receipt, replay, and read-recovery assertions.
- [x] Pass full M360 locally at 111 assertions with two platform skips plus typecheck, focused lint, and diff checks.
- [x] Classify protected `5254ff4`: every Ubuntu, macOS, Windows 2/3, Windows 3/3, and overflow duplicate passes, while both native 1/3 jobs reproduce the same five diagnostic fixture failures plus the dedicated native dispatch prerequisite failure.
- [x] Bind Windows semantic mode directly to diagnostic fixture construction and natively secure every controlled semantic-created `.ashlr` prerequisite descendant before the dedicated lifecycle transaction.
- [x] Pass the corrected full M360 locally at 111 assertions with two platform skips plus typecheck, full quiet lint, production build, zero-vulnerability audit, diff checks, and two independent SHIP reviews with no P0/P1/P2 findings.
- [x] Publish `daa4815` and classify duplicate protected authority: every Ubuntu, macOS, Windows 3/3, and overflow copy passes; both native Windows 1/3 copies reproduce the same six M360 failures, and one Windows 2/3 copy exposes an independent finite-timeout outlier.
- [x] Split independent blockers into stacked PR #34 (Windows reservation-sweep budget) and PR #35 (verifier PATH authority), with focused/static verification complete.
- [x] Establish production exact-DACL authority in the repair-handoff store, inode-bind compaction durability, and replace M360's partial module mock with a sentinel-guarded canonical authenticated runner/observer.
- [x] Pass integrated M360/M362/M379 at 203 assertions with four platform skips plus full quiet lint, typecheck, production build, zero-vulnerability audit, diff checks, and independent security reviews with all P2 requests addressed.
- [x] Publish the M360 correction as `be0e89a` and classify both protected duplicates: every job except Windows portability 1/3 passes, while M360 returns before proposal persistence at the shared local-store lock.
- [x] Correct the local-store lock's exact Windows directory/candidate/canonical authority, bind proposal locks to an exact `~/.ashlr` root, and prove lifecycle transition persistence plus contention/release/replacement safety locally.
- [x] Publish the first lock-authority correction as immutable `4211282` and classify its protected failures without waivers: generic exact-DACL enforcement broke monitoring cursors, proposal persistence regressed on Ubuntu, and fixture contracts exposed changed assurance/config behavior.
- [x] Make exact private-storage assurance an explicit proposal-only option, preserve generic structural lock hardening, repair the Linux fixtures, and prove post-acquisition ownership/release remain exact and fail closed.
- [x] Publish corrected immutable `5a96c8d` and classify its narrowed matrix: native M416/Windows 3/3 pass; remaining failures are one zero-wait reclaim bug plus bounded authority-fixture costs and Linux anchor assumptions.
- [x] Grant one race-safe installation attempt after proven-dead zero-wait reclaim, make authority fixtures cross-platform and cost-bounded, preserve all assertions/deadlines, and pass focused/static plus PR #35 combined verification.
- [ ] Publish the next immutable SHA and require every duplicate protected job, including native 1/3 authority, to pass before merge consideration.

## Next P0 - Source-Complete GitHub Policy Authority
- [x] Paginate effective branch rules to exhaustion and refuse truncated, over-limit, or permission-incomplete observations.
- [x] Bind classic protection to the exact branch's GraphQL rule, including force-push and pull-request bypass allowance completeness, while retaining REST App-bound status-check identities.
- [x] Preserve ruleset source boundaries and reject unknown pagination, malformed source-local allowances, and incomplete typed-check bindings before flattening can appear authoritative.
- [x] Re-read the exact branch head, classic rule, and every effective ruleset detail after observation, and fail closed on hybrid snapshots or identity drift.
- [x] Require exact source-local configured-check bindings with `app_id:-1` any-app semantics while rejecting zero, malformed, duplicate, and conflicting identities.
- [x] Publish schema-v2 source-complete policy evidence as stacked PR #36 (`d76eb66`), with 133 focused tests, full static gates, and live read-only attestation; no merge authority was enabled.
- [ ] Add signed evidence-pack v3 after live policy closure, binding evaluator version, policy hash, exact configured checks, and the complete sealed pack digest.

### Remaining Defense In Depth
- [ ] Add a deterministic parent-replacement recovery test that proves markers and artifacts remain intact after authority-root substitution.
- [ ] Evaluate atomic Windows directory creation with `Directory.CreateDirectory(path, DirectorySecurity)` to remove the transient inherited-ACL interval even inside the trusted-principal boundary.
- [ ] Strengthen recovery ABA detection without treating legitimate child-entry ctime changes as parent replacement.

## PR #33 Final Native Fixture Closure (2026-07-16)
- [x] Publish zero-wait recovery correction `c26a5e9`; both protected duplicates passed macOS, Ubuntu, Windows 2/3, Windows 3/3, and overflow.
- [x] Classify the sole duplicate hermetic failure as M403 creating enrollment state through a semantic adapter before a native child exact-inspected it.
- [x] Establish the M403 enrollment registry through the native production path, then restore the semantic adapter only for repeated parent-side contention mechanics; all 14 focused cases pass unchanged.
- [x] Prove the M403 correction in both protected Windows 1/3 hermetic runs; the child now returns the expected authoritative `unenrolled` result.
- [x] Classify the remaining duplicate native-step failure as one M310 identity fixture exceeding its unchanged five-second body during repeated exact proposal-lock assurances.
- [x] Scope the authenticated semantic private-storage adapter to M310's physical alias/canonicalization behavior and restore native mode in `finally`; no production code, assertion, timeout, or exact-DACL proof changes.
- [x] Isolate the six remaining native M360 failures to its hand-written proposal JSON bypassing production persistence; do not relax locks, DACLs, lifecycle admission, assertions, or deadlines.
- [x] File M360 authority fixtures through `createProposal()`, reload exact causal bindings through `loadProposal()`, and let production-generated proposal IDs flow into dispatch and lifecycle evidence.
- [x] Pass full M360 at 111 assertions with two platform skips, H2 proposal persistence at 10/10, typecheck, scoped lint, and diff checks.
- [x] Publish `cb273a6` and prove production proposal persistence/reload is no longer the native blocker; classify the next refusal as lexical lifecycle repo identity versus writer-canonical dispatch identity.
- [x] Canonicalize lifecycle diagnostic proof targets through the writer's exact identity function, retain strict receipt comparison, and add ordered admission-stage plus immutable-witness regression proof.
- [x] Repass full M360 at 111 assertions with two platform skips plus typecheck, focused lint, production build, and diff checks on the corrected tree.
- [x] Use protected `8e65fdd` to prove canonical receipt targeting reaches terminal proof construction on Windows and isolate the remaining refusal to lifecycle-ledger persistence.
- [x] Correct the retained-live-receipt regression assumption and extend bounded test-only tracing across proposal binding, record construction, save outcome, and exact caught persistence error.
- [x] Use protected `98f9e15` to identify Windows directory-fd `fsync` `EPERM` as the final persistence refusal after valid lifecycle record construction.
- [x] Replace the lifecycle's duplicate raw directory fsync with the shared identity-validating Windows-aware durability primitive, preserving exact DACL inspection and all rollback/file-fsync guarantees.
- [x] Use protected `f4adc11` to prove Windows persistence succeeds and reduce native M360 from six failures to two post-success fixture expectations.
- [x] Reconstruct a genuine pre-protocol v2 tombstone fixture and require the successful transaction's post-commit lifecycle-file DACL inspection without changing production authority.
- [x] Trace the final native DACL mismatch to four exact stable-read/exact-DACL pairs and replace broad mode predicates with exact ordered transaction assertions.
- [x] Require all four installed-ledger inspections in the successful native recovery-read sequence exposed by `41797c2`.
- [x] Raise only the complete native DACL integration test's measured timeout from 60 to 120 seconds after `3318f0d` reached the ceiling with no assertion failure.
- [x] Set the same isolated native test to a 240-second bounded budget after `b7e5cad` measured the full real-PowerShell transaction at roughly 131 seconds.
- [x] Use protected `5750932` to prove M360 green and isolate the next native blocker to duplicate raw directory-fd fsync calls in repair-handoff append and compaction.
- [x] Route both repair-handoff directory durability sites through the shared Windows-aware identity-validating primitive without relaxing file or directory authority.
- [ ] Require every protected job on the final immutable PR #33 SHA before merge consideration.

## Next P0 - Safe-Minimum Protected-Remote Policy V1
- [x] Select a pure versioned policy evaluator as the next authority slice after PR #36 source-complete observation.
- [x] Require strict App-bound checks, admin enforcement, zero bypass actors, force-push/deletion prohibition, and explicit signature policy across source-local classic/ruleset evidence.
- [x] Re-evaluate at every force-fresh remote checkpoint and project unsafe or unknown policy as unavailable.
- [x] Publish as stacked PR #38 on #36 after exhaustive policy, drift, status, static, and protected verification.
- [x] Observe all 12 protected PR/push jobs green on immutable PR #38 head `48d8ea0`.

## Signed Evidence Pack V3 Cycle (2026-07-16)
- [x] Add bounded canonical JSON, domain-separated payload digest, dedicated derived signing key, HMAC signature, signing-key identity, and self-excluding sealed-pack digest.
- [x] Add strict closed v3 schema validation for proposal, verification, gate, remote-policy, visual, policy, causal, and outcome metadata while keeping v1/v2 readable as observational evidence.
- [x] Add race-safe private persistence with no-follow exclusive temporaries, short-write handling, inode/owner/mode/link checks, directory identity bracketing, canonical UTF-8 transport, duplicate-key rejection, and Windows private-storage assurance.
- [x] Bind live remote evidence to the canonical safe-minimum evaluator digest instead of an ad hoc snapshot hash.
- [x] Require verified signed v3 T4 evidence-mode merge authority before positive skill distillation; reject proposal-only, mismatched branch-lane, policyless-outcome, and legacy downgrade claims.
- [x] Pass the focused authority matrix, typecheck, scoped lint, production build, dependency audit, and diff checks; close protocol/policy review findings.
- [x] Close exact Windows signing-key DACL, durable parent/key installation, BigInt file identity, safe-home, ambiguous post-rename evidence, dedicated ready-reader, skill identity, and ready-window findings; rerun 395 focused assertions plus static gates.
- [x] Commit, push, and open protected PR #39 stacked on `codex/safe-minimum-policy-v1` without merging or deploying.
- [x] Implement and locally verify the separate activation PR that persists, rereads, verifies, and binds v3 before any staging push or PR mutation.

## Protected Stack Status (2026-07-16)
- [x] Keep PR #33 immutable at `e4ffbd4`; every required protected job is green.
- [x] Refresh and prove PR #34 `1c243b7`, PR #35 `52463d2`, and PR #36 `cc57322` with preserved patch identities and complete protected-green matrices.
- [x] Publish PR #37 generalized safety-test guard at `b12108a` after 75 focused tests and independent SHIP review, then publish assertion-preserving Windows fixture budgets as `d679c87`.
- [x] Prove PR #37 head `d679c87` across both protected matrices after the exact failed-job rerun; all 12 protected jobs are green.
- [x] Publish PR #38 safe-minimum policy at `48d8ea0` and observe all duplicate protected jobs green.

## Signed Evidence V3 Activation Cycle (2026-07-16)
- [x] Seal the final Gate 8 verdict as v3, publish and reread it under proposal authority, verify its exact seal, and bind live proposal/diff/verification/action state.
- [x] Put the exact `sealedPackDigest` into domain-separated local and remote mutation intents while retaining legacy receipt compatibility.
- [x] Require active v3 for URL-less recovery authority and support coherent main/tier/verification/evidence plus branch-review tuples.
- [x] Revalidate evidence at staging, push, PR, and local-merge boundaries; remove unsigned summary text from the PR body.
- [x] Make protected staging push atomic with the verified remote base and make local default-branch advancement an exact compare-and-swap.
- [x] Pass 265 focused assertions with one intentional skip, typecheck, scoped lint, build, zero-vulnerability audit, and diff checks on the rebased PR #39 head.
- [x] Commit, push, and open protected activation PR #40 on PR #39 without merging or deploying.
- [ ] Observe the complete PR #39 and PR #40 protected matrices before any merge or deployment.

## Signed Evidence Fleet Health Cycle (2026-07-16)
- [x] Audit Fleet OS evidence authority and identify false healthy-zero reporting for degraded signed-pack storage.
- [x] Preserve signed-pack source completeness, invalid/unreadable counts, and sealed-v3 versus legacy protocol counts in fleet status.
- [x] Add signed evidence as required merge-authority evidence and emit a high-priority read-only diagnosis action when pending proposals are fail-closed.
- [x] Add read-only `autonomy-packs` evidence-doctor coverage without storage/key creation or malformed-file mutation.
- [x] Complete CLI, standalone Fleet, and Mission Control degraded/cold-start rendering; pass 194 focused tests, CI manifest, and static gates.
- [x] Publish stacked protected PR #41 on #40 after local review and verification; require duplicate protected CI before merge consideration.

## Ranked Autonomy Follow-Ups (2026-07-16 Audit)
- [ ] P0: replace whole-history proposal authority with a transactional bounded operational projection before the 4,096-file cliff stops production.
- [ ] P0: add a single-flight evidence-mode post-merge observation hold and deterministic adverse quarantine before granting positive learning credit.
- [ ] P0: promote the shadow canary into a default-off, one-admission docs-only protected-remote controller with cancellation and containment authority.
- [ ] Keep host auto-merge disabled until the controller, observation latch, rollback rehearsal, and protected matrix are complete.

## Causal Proposal Identity Cycle (2026-07-16)
- [x] Rebind created run summaries to the generated durable proposal ID and canonical top-level run ID.
- [x] Strip proposal identity from false or omitted `proposalCreated` summaries.
- [x] Neutralize proposal-created identity on diff-hash dedup returns without mutating the durable duplicate owner.
- [x] Pass 188 focused assertions with two platform skips, typecheck, scoped lint, build, audit, and diff checks.
- [x] Complete independent re-review with SHIP and no remaining P0/P1/P2 findings.
- [x] Publish protected stacked PR #42 on fully protected-green #41; require duplicate protected CI before merge consideration.
- [x] Repair Ubuntu CI contract/timing assertions without changing production causal semantics or observer deadlines; rerun 24 focused assertions and static gates.

## Operational Proposal Projection Foundation (2026-07-16)
- [x] Define proposal-local operational membership without mutable side-ledger authority.
- [x] Add a bounded, private, domain-keyed sealed manifest and fail-closed read path.
- [x] Require exact complete namespace reconciliation for offline migration and reject active overflow before publication.
- [x] Prove 4,097 terminal records no longer consume active authority capacity while 4,097 active records fail closed.
- [x] Remove unsafe runtime point-read activation and pass independent blocker re-review with SHIP.
- [x] Publish protected stacked PR #43 on #42 with the dormant activation boundary explicit.
- [ ] Add crash-recoverable proposal-plus-projection writer transactions and an external anti-rollback anchor.
- [ ] Cut hot consumers over only after transaction recovery, source-completeness, and concurrent mutation tests pass.

## Operational Projection Transaction Journal (2026-07-16)
- [x] Persist an authenticated active two-artifact intent under exact writer-lock ownership.
- [x] Enforce monotonic phases, clocks, signing-key generation, and unambiguous two-digest movement.
- [x] Classify every before/after crash boundary from observed digests, including missing-artifact creation.
- [x] Fail closed for tamper, malformed state, unsafe storage, key replacement, phase skips, lock mismatch, and active overlap.
- [x] Add an independent host-local replay ledger that rejects an older valid active record while its atomic state remains intact.
- [ ] Add OS-backed or remote monotonic authority before claiming protection against coherent rollback of complete local state.
- [ ] Integrate all six proposal persistence paths only after replay protection and recovery installation are proven.
- [x] Publish draft stacked PR #44 on #43 with valid-record replay called out as a merge blocker.

## Operational Projection Local Replay Ledger (2026-07-16)
- [x] Add a separately keyed, atomically published bounded phase ledger and authenticated logical root under the global proposal-store mutation lock.
- [x] Bind every floor advance to the exact authenticated active transaction record and reject fabricated, stale, skipped-phase, cross-lineage, and clock-regressing inputs.
- [x] Detect older active-record replay, chain truncation, root tamper, malformed/canonical transport drift, and trailing bytes while the state remains intact.
- [x] Remove the append/root crash wedge and mixed-snapshot reader race by publishing one complete state generation atomically.
- [x] Rename direct transaction mutations as journal-only and add a coordinator that repairs one-phase crash gaps before any further advance.
- [x] Reconcile a committed predecessor before successor preparation and repair the exact committed-to-new-prepared identity boundary after restart.
- [x] Exact-assure private state storage on Windows and preserve exact POSIX directory/file modes.
- [x] Recover an owned empty Windows authority directory left by interruption before DACL hardening.
- [x] Sign literal `rollbackProtected:false` and `historicalAuthority:false`, and prove coherent whole-state rollback remains accepted without external authority.
- [ ] Add authenticated checkpoint/retention before the 4,096-row bound is reached.
- [x] Publish protected draft PR #45 on #44 after independent blocker review and require duplicate protected CI before merge consideration.

## Structured Agent Reasoning And Independent Review (2026-07-16)
- [x] Audit current action, run-summary, trajectory, observer, manager, red-team, and Best-of-N telemetry contracts.
- [x] Select a metadata-only `intent|observation|prediction|action|evidence|challenge` event union instead of persisting or parsing free-form chain-of-thought.
- [x] Add bounded all-or-nothing semantic events to decisions, agent actions, outcomes, and trajectory projections with finite registries, parent binding, deterministic identities, and exact sequence validation.
- [x] Emit only complete-JSON Manager action/challenge metadata; prohibit synthetic fallback predictions, score-as-observation claims, reasoning-derived telemetry, and calibration authority.
- [x] Preserve exact occurrence/event identities through outcome/trajectory projection, expose degraded decision and agent-action source quality, and withhold semantic projection from degraded sources.
- [x] Prove 100,000 seeded raw-content canaries persist zero semantic rows and near-authorized semantic evidence cannot replace cryptographic merge authority.
- [ ] Add independent post-effect observations and preregistered prediction mapping before enabling calibration metrics.
- [x] Enforce producer/reviewer model-family separation for verification-mode authority and fail pending when no independent frontier reviewer exists.
- [x] Close Best-of-N's draft-first deterministic verification gap without adding judge or model calls.
- [ ] Replace Best-of-N's null correctness critic only behind an explicit token budget and measurable selection lift; it is not independent review authority.
- [x] Publish protected draft PR #46 after final independent blocker review returned `SHIP`; require both duplicate protected matrices before promotion.

## Independent Reviewer Family Authority (2026-07-16)
- [x] Audit verification-mode judge routing and prove frontier status currently permits same-family producer/reviewer correlation.
- [x] Add a finite provider-family classifier and pure independence verdict over signed producer model plus reviewer model.
- [x] Require different known families for verification-mode merge authority and manager-gate reviewer authority; fail pending on unknown or same-family routes.
- [x] Route and cache frontier judges per producer family so mixed queues can use independent reviewers without per-proposal resolver churn.
- [x] Expose the exact independence blocker through existing readiness/status authority explanations.
- [x] Pass focused resolver, attestation, verification-gate, manager-gate, automerge, status, static, build, audit, and adversarial review gates.
- [x] Publish protected draft PR #47 stacked on PR #46 without activating merge or deployment authority.

## Post-Merge Positive-Credit Firewall (2026-07-16)
- [x] Audit every immediate merge fanout and separate immutable operational merge facts from positive recursive-learning credit.
- [x] Reserve one exact post-merge release label while making it structurally non-authoritative without a distinct proof verifier.
- [x] Stop realized merge receipts from immediately linking positive judge outcomes, worked-ledger productivity events, or reusable skills.
- [x] Keep routing, model ROI, feedback, calibration, and skill consumers dormant even when raw ledgers contain the reserved label.
- [x] Preserve factual realized-merge quality, trajectory, fanout, notification, and event-bus reporting independently from adaptive credit.
- [x] Keep historical realized-merge records readable as factual lifecycle evidence without allowing them to train positive policy.
- [x] Complete fixture migration and a 786-assertion changed-surface matrix.
- [x] Complete final adversarial bypass review with no remaining P0/P1/P2.
- [x] Pass the 864-assertion changed-surface matrix, typecheck, lint, build, zero-vulnerability audit, and diff checks.
- [x] Align the native shared-queue authority test with the v1 diff-origin ambiguity contract while preserving explicit diff-cooldown enforcement.
- [ ] Require the complete protected CI matrix on the immutable PR head.
- [x] Publish the firewall as draft PR #48 stacked on PR #47 without claiming a stability release protocol.
- [x] Align the full CI contract with dormant positive ROI, strategy, and skill consumers plus independent reviewer-family authority after Ubuntu exposed 16 stale assertions across seven suites.
- [ ] Re-run the complete duplicate protected matrix on the corrected immutable head.
- [ ] Build the separate protected-base release authority with reservation, detached verification, denominator-complete observation, monotonic quarantine, and crash-safe idempotent fanout.

## Observation-Only Learning Eligibility Projection (2026-07-16)
- [x] Audit the signed merge, protected-base, verification, stability, adverse, denominator, rollback, and consumer contracts behind positive learning release.
- [x] Refuse premature release authority while denominator completeness, sealed execution proof, historical branch-policy binding, and an external monotonic anchor remain unavailable.
- [x] Add bounded `LearningEligibilityV1` projection over dispatch-rooted trajectories with host-keyed subject/proposal digests, fixed stage states, refusal vectors, policy/epoch identity, propensity availability, and a complete evaluated-set digest.
- [x] Keep every projected member `policyEligible:false` and `recursiveLearningEligible:false`; raw release labels and caller-supplied metadata remain non-authoritative.
- [x] Reject partial candidate sets, duplicate subjects, malformed/oversized populations, invalid identities, missing keys, and degraded source inputs without persisting raw prompts, rationale, diffs, output, environment, paths, or contents.
- [x] Pass 63 focused trajectory/population/firewall/eligibility assertions, typecheck, scoped lint, production build, zero-vulnerability audit, and diff checks.
- [x] Publish the isolated stacked PR #49 on PR #48 and require the complete protected matrix.
- [ ] Remove free-form chain-of-thought and prompt context from durable judge traces; project only validated closed semantic events and bounded numeric metadata.

## Metadata-Only Judge Trace (2026-07-16)
- [x] Replace new durable judge-trace rows with a closed v2 metadata schema that omits reasoning and prompt context.
- [x] Preserve legacy outcome history through redacted read models without returning historical raw text.
- [x] Reject unknown v2 keys and raw-text smuggling as degraded source input.
- [x] Remove legacy reasoning/context reuse from prompt-optimizer reflection while retaining verdict, outcome intent, and bounded scores.
- [x] Pass 703 direct-consumer assertions across 24 suites, typecheck, scoped lint with zero errors, production build, zero-vulnerability audit, and diff checks.
- [x] Rebase on the final PR #49 head and rerun the complete local evidence matrix.
- [x] Publish protected stacked draft PR #50 on PR #49.
- [ ] Replace remaining durable free-form decision rationale with closed reason codes in a separate compatibility-scoped slice.

## Closed Judge Decision Metadata (2026-07-16)
- [x] Map every durable Manager rationale path through decisions, Gate 7 audit/status, proposal rejection, and recursive anti-playbooks.
- [x] Version new judged decision rows as metadata-only v2 with finite verdict and reason-code registries.
- [x] Omit model rationale and arbitrary detail at the generic ledger boundary; degrade v2 rows that smuggle raw rationale fields.
- [x] Preserve legacy judged history through a redacted v1 read model without returning historical reason or detail text.
- [x] Replace rejected-proposal and Gate 7 persistence with fixed code-derived text while preserving immediate ephemeral Manager rationale.
- [x] Stop proposal titles and judge reasoning from entering anti-playbook genome entries; retain finite negative observations only.
- [x] Pass 1,759 direct-consumer assertions across 65 suites, typecheck, scoped lint, production build, zero-vulnerability audit, and diff checks.
- [x] Publish protected stacked draft PR #51 on PR #50 and require the complete duplicate protected matrix.

## Run-Bound Agent Semantic Events (2026-07-16)
- [x] Rehydrate the exact PR #51 stack and reject scout findings already closed on the current source revision.
- [x] Extend semantic parent binding from proposal-only carriers to exact opaque proposal, run, or trajectory identities.
- [x] Emit finite terminal sandbox work-state events for execution intent, action completion/blocking, and optional proposal-created observation.
- [x] Preserve proposal-less run semantics through the agent-action ledger and trajectory projection without adding raw prompts, reasoning, diffs, output, environment, paths, or file contents.
- [x] Reject mismatched or unbound semantic subjects and retain the parent action with an explicit rejected state where applicable.
- [x] Project bounded replay-idempotent run signals for peer coordination, collapse contradictory facts to unknown, and withhold the projection when source evidence is degraded.
- [x] Pass 477 assertions across 15 semantic/ledger/trajectory/workspace/status/dashboard/sandbox consumer suites, typecheck, scoped lint, production build, zero-vulnerability audit, and diff checks.
- [x] Publish protected stacked draft PR #52 on PR #51 and require the complete duplicate protected matrix.

## Deterministic Best-of-N Draft Verification (2026-07-16)
- [x] Extract proposal-object verification so in-memory drafts and persisted proposals share one quick verification implementation.
- [x] Verify every captured Best-of-N draft before winner selection without persisting loser proposals.
- [x] Make explicit deterministic failures ineligible and prefer verified-green candidates over unverified candidates.
- [x] Prove highest-scored failure exclusion, all-fail no-winner behavior, verifier-unavailable ordering, and winner-only filing.
- [x] Pass focused and adjacent consumer suites, typecheck, scoped lint, production build, zero-vulnerability audit, and diff checks.
- [x] Publish protected stacked draft PR #53 on PR #52 without activating merge or deployment authority.
- [ ] Require the complete protected CI matrix on the immutable stacked PR head before promotion.

## Repository-Scoped Cooldown Identity (2026-07-20)
- [x] Audit dispatcher, generated-repair snapshot, and Fleet Status cooldown key construction.
- [x] Bind every canonical cooldown key to normalized repository, item id, and generation identity.
- [x] Refuse ambiguous legacy raw-key compatibility aliases rather than recreating cross-repository suppression.
- [x] Prove direct helper isolation and Fleet Status isolation for two repositories with the same item id.
- [x] Pass lifecycle/status focused tests, typecheck, scoped lint, and diff checks.

## Repository-Qualified Judged Feedback (2026-07-20)
- [x] Carry the exact matched WorkItem through rejected-proposal sweep callbacks.
- [x] Require canonical proposal/backlog repository identity for causal and legacy matching.
- [x] Write daemon judged outcomes through canonical scoped cooldown keys only.
- [x] Prove shared-queue rejected feedback cannot cool an equal-id item in another repo.
- [x] Pass the focused feedback suite, typecheck, scoped lint, and diff checks.
- [ ] Migrate shared-queue claims, policy maps, reservations, and post-claim attribution from raw item ids to a canonical execution key; fail closed on collisions until complete.

## Windows Receipt Test Budget (2026-07-20)
- [x] Diagnose the protected Windows native lifecycle shard failure from the completed job log.
- [x] Bound only the DACL-heavy failure-receipt materialization case with an explicit 30-second test timeout.
- [x] Pass the focused receipt materialization regression without changing global CI timing.

## Shared-Queue Cross-Repository Collision Fence (2026-07-20)
- [x] Audit the lossy WorkItem-to-raw-id boundary in shared queue claims.
- [x] Refuse whole claim batches containing one raw id from multiple canonical repositories.
- [x] Preserve local coordinator behavior and shared-store schema compatibility.
- [x] Prove direct and cross-lane collisions leave the queue unmodified.
- [x] Pass the focused shared-queue suite, typecheck, scoped lint, and diff checks.

## Local Multi-Lane Repository Identity (2026-07-20)
- [x] Audit local lane de-duplication against the repository-scoped cooldown and pending-proposal identities.
- [x] Preserve equal scanner ids from different canonical repositories during local lane selection.
- [x] Prove two-repository lane selection and pass focused coordinator tests, typecheck, scoped lint, and diff checks.

## Daemon Cooldown-Policy Repository Identity (2026-07-20)
- [x] Audit raw-id policy lookup through selection, cooldown settlement, and generated-repair decision telemetry.
- [x] Key all daemon claim cooldown-policy lookups by repository-scoped work identity.
- [x] Prove a cooled same-id item cannot block a second enrolled repository's item; pass focused daemon/coordinator tests, typecheck, scoped lint, and diff checks.

## Canonical Shared Execution-Key Foundation (2026-07-20)
- [x] Define one nullable canonical WorkItem execution identity that includes repository, item, and repair generation.
- [x] Adopt it in shared collision fencing and prove alias normalization plus repository separation.
- [x] Pass focused coordinator coverage, typecheck, scoped lint, and diff checks.

## Shared Queue Execution-Key Migration (2026-07-20)
- [x] Move shared store claim keys from raw scanner ids to canonical WorkItem execution identities through the coordinator.
- [x] Require WorkItem capabilities for shared lease, fence, execution, release, settlement, and atomic outcome mutation.
- [x] Bind daemon lease controllers, attempt identities, cooldown policies, and post-dispatch claim mutation to the selected WorkItem identity.
- [x] Remove the temporary cross-repository collision fence and prove equal scanner ids dispatch and settle independently in one shared queue.
- [x] Pass focused coordinator/two-machine/full-tick coverage, typecheck, scoped lint, and diff checks.

## Dispatch Bookkeeping Repository Identity (2026-07-20)
- [x] Audit proposal-delta association and post-dispatch per-item state for raw scanner-id joins.
- [x] Require repository and generation matching before a pending proposal can be attributed to a dispatch outcome.
- [x] Key production, handoff, lifecycle, and local settlement state by repository-qualified work identity.
- [x] Preserve raw local ledger ids for compatibility while persisting a scoped cooldown key.
- [x] Prove local raw-id compatibility and cross-repository cooldown isolation; pass focused coordinator/daemon tests, typecheck, lint, and diff checks.

## Route And Preflight Repository Identity (2026-07-20)
- [x] Audit automatic-drain route, preflight, blocked-selection, and fairness maps for raw scanner-id collisions.
- [x] Key route and preflight state by repository-qualified work identity.
- [x] Preserve ordinary-turn fairness when a same-id repair is claimed in another repository.
- [x] Pass the focused automatic-drain route/fairness suite and record the isolated-worktree typecheck limitation for protected CI.

## Concurrent Route Repository Identity (2026-07-20)
- [x] Audit concurrent gateway hint, task lookup, fallback attempt, and manifest annotation maps for raw scanner-id joins.
- [x] Key concurrent routing and task lookup by repository-qualified work identity.
- [x] Carry the same key through planner hint consumption and persisted dispatch-manifest annotations.
- [x] Pass focused concurrent manifest/fallback/routing coverage and diff checks.

## Generated-Repair Reservation Repository Identity (2026-07-20)
- [x] Audit in-memory generated-repair reservation, settlement, and receipt lookups for raw scanner-id collisions.
- [x] Key all reservation lifecycle bookkeeping by repository-qualified work identity.
- [x] Preserve raw event identifiers while binding reservation lookup to the selected WorkItem.
- [x] Pass focused generated-repair lifecycle/reservation coverage and diff checks.

## Concurrent Route Same-ID Regression (2026-07-20)
- [x] Add a direct two-repository, same-scanner-id gateway-hint regression for the pure concurrent route planner.
- [x] Prove repository-qualified route hints remain isolated without requiring a full daemon loop.
- [x] Run the focused regression and retain the protected-CI failure as a separate investigation.

## Repository-Scoped CI Fixture Alignment (2026-07-20)
- [x] Update shared-queue contention fixtures to use the canonical execution key.
- [x] Update cooldown fixtures to persist a public raw id and an authoritative scoped key.
- [x] Run complete daemon-loop and fleet-continuity suites plus diff checks.

## Legacy Dispatch-Treatment Receipt Compatibility (2026-07-20)
- [x] Diagnose the live analytics degradation without mutating immutable ledger evidence.
- [x] Accept only sanitizer-validated v1 learning-label bytes and bounded legacy single-line framing.
- [x] Prove malformed receipt bytes remain rejected and live dispatch-production evidence becomes healthy.
- [x] Audit the independent repair-handoff conflict set before enabling its writer.
- [x] Add bounded parent-evidence quarantine diagnostics without changing repair-generation authority.
- [x] Recover the protected-CI v1 receipt assertion with sanitizer-gated semantic comparison while preserving digest-bound retired/compacted reads.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Cross-Repo Admitted Repair (2026-07-20)
- [x] Reproduce the admitted binshield config typecheck defect in an isolated worktree.
- [x] Restore package-local Vitest type resolution and regenerate the lockfile.
- [x] Verify from a frozen-lockfile install and publish binshield PR #22.

## Binshield Action Runtime Packaging (2026-07-20)
- [x] Diagnose the protected workflow's ESM/CommonJS runtime boundary failure after self-contained bundling.
- [x] Publish an explicit `.cjs` action entrypoint and remove the obsolete `.js` runtime artifact.
- [x] Prove the checked-in bundle executes through Node under the action package's ESM boundary without checkout dependencies.
- [x] Require the immutable head's Binary Scan and validation workflows to pass before promotion.

## Stale Proposal Throughput Gate (2026-07-20)
- [x] Audit the durable proposal failure distribution without retaining raw prompts or diffs.
- [x] Preserve known verification failures while allowing unrelated backlog only after every pending proposal is stale under the explicit production-velocity TTL.
- [x] Prove stale failed proposals select `backlog-build`, while fresh pending failures remain `verify-only`.
- [x] Publish the protected draft update and require the complete CI matrix.

## Verification Yield Telemetry (2026-07-20)
- [x] Make scorecard verification rates denominator-complete with explicit attempt and pass counters.
- [x] Separate capture-gate failures from non-capture preflight failures using existing metadata-only verification records.
- [x] Lock the additive JSON scorecard contract and pass the focused quality-metrics suite.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Ecosystem Health Runtime Scope (2026-07-20)
- [x] Audit false fleet-direction ecosystem failures from scratch worktrees and sibling metadata discovery.
- [x] Scope fleet direction health to the explicit enrolled runtime repository set while preserving generic doctor discovery.
- [x] Resolve linked-worktree default roots beside the primary checkout and retain selected-repository failure visibility.
- [x] Verify focused doctor/resource-strategy coverage and the live read-only direction report.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Parent Capture Repeat Bound (2026-07-20)
- [x] Audit ordinary-parent versus generated-repair capture failure suppression authority.
- [x] Add a healthy-source, parent-reconciled two-attempt bound keyed by repository, item, source, and objective.
- [x] Apply the bound only to ordinary selection; preserve repair child routing and fail open on degraded evidence.
- [x] Add focused terminalization, changed-objective, and degraded-source coverage.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Capture-Repair Autonomous Drain (2026-07-20)
- [x] Audit capture repair generation, route feasibility, and live selection priority.
- [x] Add a bounded capture-repair drain lane ahead of diagnostic reslices, preserving lifecycle/route guards and ordinary-work fairness.
- [x] Add automatic priority and two-slot fairness regressions.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Nested Merge Verification Coverage (2026-07-20)
- [x] Audit merge-grade contract reporting against nested Python/Homebrew project detection.
- [x] Derive per-project merge coverage from safe command cwd and fail merge verification closed when a present contract is incomplete.
- [x] Surface coverage gaps in fleet status and contract-generation scanning with root/kind-only metadata.
- [x] Apply the same coverage refusal to protected auto-merge verification before command execution.
- [x] Require every nested project root while evaluating augment contracts against their effective merge command set.
- [x] Reject contract working-directory symlink escapes using physical repository containment while preserving lexical command metadata.
- [x] Preserve co-located ecosystem facets and require detector-bound merge coverage where a shared cwd is ambiguous.
- [x] Mark depth-limited project discovery unavailable and refuse merge coverage when deeper directories remain unscanned.
- [x] Exclude agent sandboxes and fixture/example/test trees from production project discovery.
- [x] Remove duplicate feature-branch CI matrices while retaining PR merge-ref and default-branch verification.
- [x] Restore the closed scanner-reason vocabulary and no-unused-local TypeScript invariants after discovery expansion.
- [ ] Add explicit nested verifier commands in isolated worktrees for each live incomplete enrolled repository.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Required Evidence Visibility (2026-07-20)
- [x] Audit whether compact Fleet OS data quality hides required evidence failures behind an aggregate state.
- [x] Surface required withheld and cold-start evidence counts without changing readiness or merge authority.
- [x] Prove optional evidence does not inflate required evidence counts in dashboard formatter coverage.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Selection Assignment Provenance (2026-07-20)
- [x] Audit causal-field persistence across run, dispatch, proposal, decision, evidence, and agent-action records.
- [x] Add an authenticated, metadata-only randomized-canary commitment to canonical dispatch events.
- [x] Bind the commitment to exact selected route, run/trajectory, objective, router policy, and learning epoch.
- [x] Remove the caller-injected propensity-ID escape hatch from learning eligibility.
- [x] Keep all selection data observation-only; no routing, merge, verification, or recursive-learning authority changes.
- [x] Surface categorical selection-propensity source quality in Fleet Status, CLI, and Mission Control.
- [x] Audit strict activation configuration and the durable shared-queue execution authority boundary.
- [x] Define the receipt-first canary design: opaque execution authority, immutable signed start receipt, then engine invocation.
- [x] Add a strict default-off canary configuration resolver and effective-config visibility that remains producer-disabled.
- [x] Preserve an opaque, digest-bound shared-queue execution-authority projection across the pre-effect coordinator seam.
- [x] Define and test the immutable signed selection-start receipt envelope and verifier before adding persistence.
- [x] Expose the existing pinned dispatch-production private-root primitives for the future receipt store.
- [x] Add durable no-clobber selection-start receipt installation, authenticated reads, replay/conflict handling, and tamper refusal.
- [x] Withhold raw selection observations from propensity status until an exact signed receipt join qualifies them.
- [x] Withhold raw selection observations from trajectory and learning-eligibility projections pending receipt qualification.
- [x] Extract the dispatch-production storage authority into a dependency leaf and qualify Fleet Status observations through exact signed receipt joins.
- [x] Carry only process-bound receipt-qualified selection projections into trajectory reconstruction and learning eligibility.
- [x] Normalize final concurrent backend/tier/model/disposition at the executor boundary without enabling a canary producer.
- [x] Resolve concurrent fallback tiers with the active routing configuration at the executor boundary.
- [x] Add a pure, unused binary canary pair eligibility contract with no randomization, reservation, or persistence.
- [x] Preserve per-assignment planner capacity snapshots as ephemeral sidecar metadata without changing assignments.
- [x] Define a typed ordinary-gateway predicate that refuses trace-free or overridden decisions without parsing reasons.
- [x] Bind an ordinary gateway decision to an unchanged final route as an ephemeral canonical candidate.
- [x] Audit the concurrent-planner seam and reject a precomputed canary helper that could diverge from the final route.
- [ ] Carry exact gateway route disposition and model tuple into the per-item concurrent commit point before enabling a binary canary producer.
- [ ] Add a real pre-execution randomized-canary producer only with an explicit assignment protocol and lease-bound capture point.

## Best-of-N Proposal Capture Repair (2026-07-20)
- [x] Audit Best-of-N no-winner classification against the direct-run required-capture gate.
- [x] Promote changed-but-unfiled candidate outcomes to `proposal-capture-error` using bounded diff metadata.
- [x] Preserve bounded candidate capture-attempt metadata so duplicate-diff suppression remains non-cooling.
- [x] Preserve policy-disabled behavior for candidates with no capture evidence.
- [x] Add order-independent capture-repair diagnostic coverage and run focused tests, typecheck, and lint.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Merge Contract Rollout Planner (2026-07-20)
- [x] Replace manual verify-contract editing guidance with a read-only rollout planner.
- [x] Bound detector-derived project roots and candidates, reject parent-relative cwd suggestions, and retain explicit blockers.
- [x] Add profile/Fleet Status coverage and prove the live Hub projection contains no absolute paths.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Windows Doctor Timing Recovery (2026-07-20)
- [x] Isolate the Windows portability timeout to the existing doctor report structure probe.
- [x] Preserve the timeout guard while widening only its hosted-Windows allowance from 15s to 30s.
- [x] Verify the full doctor suite, typecheck, and lint locally.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Windows Repair-Handoff Timing Recovery (2026-07-20)
- [x] Diagnose the subsequent hosted Windows timeout as the durable writer-activation rollover test's default Vitest allowance.
- [x] Preserve all journal assertions while giving only that test a bounded 30-second cold-runner allowance.
- [x] Verify the complete M362 journal suite and CI-policy guard locally.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.

## Windows Lifecycle Publication Timing Recovery (2026-07-20)
- [x] Diagnose the next Windows native-lifecycle timeout as the immutable converted-witness publication test's default Vitest allowance.
- [x] Preserve the full publication, acknowledgement, tamper-detection, and fail-closed assertion path while giving only that test a bounded 30-second allowance.
- [x] Verify the complete M360 lifecycle suite and CI-policy guard locally.
- [ ] Require the protected CI matrix on the immutable draft head before promotion.
