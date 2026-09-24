// Generous ceiling for the real-io lane. Replaces the piecemeal per-file
// `vi.setConfig({ testTimeout: N })` / `{ timeout: N }` raises (5k-45k) that
// used to be scattered across these files — one lane-wide default instead of
// N ad hoc guesses. Files that genuinely need more than this (m482's real npm
// pack/install contract, h5's 500-cycle leak-containment sweep) keep their own
// larger per-file/per-test override on top of this floor.
export const REAL_IO_LANE_TIMEOUT_MS = 60_000;

/**
 * Real-IO lane membership — test files whose runtime is dominated by REAL
 * git/npm/filesystem/subprocess/network work rather than pure in-memory logic.
 * These are exactly the suites that flake with `Test timed out in 5000ms`
 * under parallel load (many agents / tool runs sharing this machine at once)
 * while passing every time in isolation: the work is real, so its wall-clock
 * cost is at the mercy of whatever else is contending for git's index lock,
 * disk I/O, or CPU at the moment it runs.
 *
 * Membership here was derived systematically, not guessed:
 *   1. A full-suite `--reporter=json` run on an idle machine (this session,
 *      2026-08-18) measured every file's actual per-test duration. The
 *      comment on each line below is that measured single-test maximum.
 *   2. That was cross-checked against this session's list of confirmed
 *      environmental repeat offenders (isolation re-runs proved they pass;
 *      they only fail under parallel load) — the first group below.
 *   3. A grep for real-io code markers (spawn/execFile/execSync, real git/npm
 *      invocation, real HTTP server binds, multi-MB fixture writes) filled in
 *      the rest, grouped by the feature family they belong to.
 *   4. The entire hermetic H-suite (test/h*.test.ts) is folded in as a block:
 *      every file in it spins up a real temp git repo by design, and the
 *      suite was already forced fully serial via `npm run test:invariants`
 *      (--no-file-parallelism) before this change — this keeps that existing
 *      convention and the lane's membership in sync instead of two competing
 *      sources of truth.
 *
 * Both `vitest.config.ts` (to build the `real-io` project) and
 * `scripts/check-realio-lane-membership.mjs` (the guard below) import this
 * same array — one source of truth, not two lists that can drift apart.
 *
 * scripts/check-realio-lane-membership.mjs is a best-effort guard (run via
 * `npm run lint:realio-lane`, wired into `npm run lint`) that flags a test
 * file using known real-io markers (spawns git/npm, writes multi-MB fixtures)
 * but missing from this list — so the next heavy suite lands in the right
 * lane by default instead of silently rejoining the flaky pile.
 */
export const REAL_IO_TEST_FILES = [
  'test/builtin-activity-pgid-reuse.test.ts', // private activity journals with synthetic identity reuse probes
  'test/builtin-activity-settlement-witness.test.ts', // private journals and one real owned subprocess
  'test/resource-quota-cleanup-diagnostics.test.ts', // private real collector leases with inert failure witnesses
  'test/resource-quota-native-lifecycle.test.ts', // real inert native protocol, shared quota lease and group settlement
  'test/collector-cleanup-reproduction.test.ts', // inert inherited descendants and actual native helper cleanup
  'test/legacy-collector-reconciliation-driver.test.ts', // operator quarantine in private fixtures with real lock custody
  'test/resource-engineering-mission-store.test.ts', // private immutable mission records and configuration replay
  'test/resource-engineering-mission-invocations.test.ts', // private immutable invocation observations and timing
  'test/resource-engineering-mission-diagnostics.test.ts', // real journal and lease cleanup with execution doubles
  'test/resource-engineering-mission-feedback-loop.test.ts', // private mission/receipt journals and inert loopback transport
  'test/resource-engineering-mission-acceptance.test.ts', // two actual mission scopes, local transport, delivery and restart
  'test/resource-engineering-setup-evidence.test.ts', // private Git setup receipts and fresh metadata reconstruction
  'test/universe-seed-batch.test.ts', // real SHA1/SHA256 seed materialization and bounded blob batches
  'test/resource-quota-scopes.test.ts', // scoped quota collection, native fixtures and console IPC
  'test/mcp-firm-resources.test.ts', // signed history via real CLI MCP processes
  'test/local-runtime-anthropic-proxy.test.ts', // two real loopback HTTP servers: a llama-server stub and the proxy in front of it
  'test/local-eval.test.ts', // spawns real `node` checkers against real temp fixtures to grade the graders
  'test/verse-seats.test.ts', // real loopback HTTP server standing in for Ollama
  'test/verse-local-dispatch.test.ts', // real loopback HTTP server standing in for Ollama's discovery endpoints
  'test/verse-accounts.test.ts', // real collector lease acquisition and private evidence files in a tmp root
  'test/verse-api.test.ts', // real web server bind + SSE tails against an in-memory fake engine
  'test/verse-api-context.test.ts', // real web server bind + real memory/preference files in a tmp HOME (V3.9 routes)
  'test/verse-context-fit.test.ts', // real `git init`/`git ls-files` in temp repos to measure context fit
  'test/verse-session-handoff.test.ts', // real temp git repos for the handoff note's `git diff --stat`
  'test/verse-control-api.test.ts', // real web server bind + real enrollment/audit/kill-switch state in a tmp HOME
  'test/verse-daemon-pause.test.ts', // real web server bind + real git repos, pause/kill sentinels and audit in a tmp HOME
  'test/universe-control-execution.test.ts', // private signed effect and interrupted settlement records
  'test/universe-firm-resource-control-handler.test.ts', // enrolled graph dispatch to real inert transports
  'test/universe-firm-cli-integration.test.ts', // real CLI processes with test-owned provenance
  'test/universe-firm-engineering-control.test.ts', // real confined candidates, resource ledger and local delivery
  'test/universe-firm-engineering-cli.test.ts', // private enrollment files and CLI dispatch boundary
  'test/universe-firm-graph-query.test.ts', // verified history and immutable read-only inspection
  'test/universe-firm-resource-execution.test.ts', // enrolled receipt to real inert resource transport
  'test/universe-value-allocation-store.test.ts', // private signed storage and concurrent final-slot admission
  'test/resource-worker-kill.test.ts', // real loopback cancellation and native owned cleanup
  'test/universe-firm-demo.test.ts', // complete signed fixture graph and CLI queries
  'test/universe-control-graph.test.ts', // private signed graph records, ownership and restart
  'test/universe-control-recovery-guards.test.ts', // signed intent linkage and no-retry private graph evidence
  'test/universe-harness-archive.test.ts', // private immutable candidate snapshots and admission
  'test/universe-firm-memory.test.ts', // private immutable daily journals and consolidation CAS
  'test/universe-showcase-cli.test.ts', // private demo source/export custody and CLI subprocesses
  'test/universe-campaign-delivery.test.ts', // actual campaign evaluation and local Git branch delivery
  'test/universe-campaign-initial-repair-delivery.test.ts', // measured failed seed, local repair branch and custody/recovery checks
  'test/universe-calibrated-campaign.test.ts', // synthetic score transport with real seed records, local branch delivery and replay
  'test/universe-campaign-passed-seed-acceptance.test.ts', // real command worker/evaluator from passing seed to one-generation local branch
  'test/m11.stream-file-sink.test.ts', // thousands of real sink writes and reads across secret boundaries
  'test/m442.runtime-release-launch-revalidation.test.ts', // large dependency fixtures, permissions and recursive cleanup
  'test/m444.external-skill-audit.test.ts', // large real audit trees and recursive cleanup
  'test/m466.host-merge-revocation-protocol.test.ts', // 4097-file store bounds and competing subprocess CAS
  'test/resource-native-profile.test.ts', // exclusive profile preparation and inert native execve
  'test/resource-claude-account-status.test.ts', // native auth status with inert private process fixtures
  'test/resource-claude-account-usage.test.ts', // private scratch and bounded native usage mocks
  'test/resource-grok-account-probe.test.ts', // native metadata protocol with inert ACP fixtures
  'test/resource-connection-monitor.test.ts', // private metadata monitoring fixtures
  'test/resource-metadata-coordination.test.ts', // shared collector scheduling over private inert scopes
  'test/resource-connection-server.test.ts', // loopback account monitoring and durable allocation controls
  'test/resource-allocation-policy.test.ts', // atomic private allocation state and final admission
  'test/resource-allocation-refresh.test.ts', // allocation changes across owned quota refresh and admission
  'test/resource-native-profile-review.test.ts', // independent native environment and process identity fixtures
  'test/resource-profile-integration.test.ts', // actual CLI preparation and generated inert native launchers
  'test/resource-profile-repin.test.ts', // private profiles, inert native execve through repinned launchers
  'test/universe-resource-runtime-check.test.ts', // explicit private runtime and sterile Git workspace reads
  'test/resource-launcher-compatibility.test.ts', // bounded inert CLI help/version subprocesses
  'test/resource-commissioning-integration.test.ts', // built public CLI with private inert multi-account fixtures
  'test/resource-pool-supervisor.test.ts', // durable queues, verified locks, native and loopback tasks
  'test/resource-console-worker.test.ts', // fixed-scope worker threads and private evidence files
  'test/resource-console-server.test.ts', // real scoped HTTP listener and authentication fences
  'test/resource-console-quota-scopes.test.ts', // final HTTP quota projection and shared account ceilings
  'test/resource-console-history-server.test.ts', // private history HTTP reads, deletes and restart persistence
  'test/resource-console-history.test.ts', // durable supervisor transcripts with real inert transports
  'test/resource-console-history-acceptance.test.ts', // independent restart, deletion and receipt reconciliation
  'test/resource-console-followup.test.ts', // context headroom and corrupted durable-state refusal
  'test/resource-console-followup-server.test.ts', // authenticated follow-up HTTP and shared quota accounting
  'test/resource-console-followup-acceptance.test.ts', // independent context deletion, replay and real local transport
  'test/resource-console-projects-server.test.ts', // catalog HTTP boundaries and actual CLI bootstrap
  'test/resource-console-projects-acceptance.test.ts', // independent project cwd, shared accounting and migration
  'test/resource-console-project-state.test.ts', // pinned-directory drift at reservation and worker dispatch
  'test/resource-console-files.test.ts', // registered-project filesystem reads
  'test/resource-console-files-server.test.ts', // authenticated project-file HTTP routes
  'test/resource-console-files-acceptance.test.ts', // independent real file-to-task snapshot acceptance
  'test/resource-console-engineering-acceptance.test.ts', // actual HTTP, shared quota, Git evaluation and delivery
  'test/resource-console-engineering-core.test.ts', // signed graph attribution and durable console launch/cancel ownership
  'test/resource-console-engineering-graph-completion.test.ts', // read-only completion over real private ownership records
  'test/resource-console-engineering-registration.test.ts', // immutable same-owner dynamic enrollment with real private supervisor state
  'test/resource-console-engineering-preparation-boundaries.test.ts', // real pinned recipe files and immutable objective registration boundaries
  'test/resource-console-engineering-preparation-reuse.test.ts', // real committed bundle replay and call-local validation counts
  'test/resource-engineering-successor-preparation.test.ts', // real upstream delivery and pinned downstream preparation
  'test/resource-engineering-successor-acceptance.test.ts', // actual proposal-to-successor delivery and accounting
  'test/resource-console-engineering-preparation-acceptance.test.ts', // actual objective HTTP preparation, restart and evaluated delivery
  'test/resource-engineering-outcomes.test.ts', // exact receipt joins against real private resource history and ledger
  'test/resource-engineering-outcomes-review.test.ts', // independent overflow, changed-sample and incomplete-proof regressions
  'test/resource-engineering-supervisor-admission.test.ts', // durable bounded queue admission and restart over private state
  'test/resource-engineering-supervision-state.test.ts', // read-only private supervision state and owner restart identity
  'test/resource-engineering-supervisor-admission-acceptance.test.ts', // actual prepare-to-queue evaluation, delivery and restart
  'test/resource-engineering-auto-admission-recovery-acceptance.test.ts', // ordinary registration gap recovery, paused restart and delivery
  'test/universe-preparation-measurement-capture-acceptance.test.ts', // actual installed failed diagnostic, immutable custody and CLI report replay
  'test/universe-builtin-trial-custody-acceptance.test.ts', // actual installed failed diagnostics, private trial custody, and injected return-loss hold
  'test/resource-console-engineering-inspect.test.ts', // read-only commissioning through real CLI, Git and history fixtures
  'test/resource-console-state-inspection.test.ts', // strict persisted-state decoding and pinned-directory previews
  'test/universe-backlog-marker-evaluator.test.ts', // real bounded Node evaluator processes over fixed source cases
  'test/universe-hub-marker-campaign.test.ts', // full pinned Hub seed, confined evaluator and exact local Git delivery
  'test/universe-campaign-seed-store.test.ts', // private campaign records and Git fixtures
  'test/universe-campaign-seed-evaluation.test.ts', // confined evaluator subprocess lifecycle
  'test/universe-seed-measurement-acceptance.test.ts', // loopback generation and verified local delivery
  'test/universe-campaign-seed-context.test.ts', // raw campaign/run history and immutable context reconstruction
  'test/universe-seed-context-model.test.ts', // candidate filesystem and actual model-boundary receipts
  'test/resource-console-engineering-routes.test.ts', // actual HTTP auth and lifecycle with inert engineering owner
  'test/resource-console-acceptance.test.ts', // end-to-end console sessions, supervision and queue recovery
  'test/resource-worker-process.test.ts', // real bounded stdin and process ownership
  'test/resource-worker.test.ts', // native worker fixtures and numeric-loopback model transport
  'test/resource-pool-runtime.test.ts', // durable admission, concurrent tasks, and replay
  'test/resource-admission-preflight.test.ts', // read-only admission parity against private persisted ledgers
  'test/resource-performance-runtime.test.ts', // monotonic measurements in the private task ledger
  'test/resource-review-benchmark.test.ts', // fixed calibration through real ledger and loopback transport
  'test/resource-pool-cli.test.ts', // explicit private manifests and CLI output files
  'test/resource-codex-account-probe.test.ts', // native metadata protocol and owned subprocess cleanup
  'test/resource-probe-cli.test.ts', // private commissioning reports and signal ownership
  'test/resource-quota-console.test.ts', // actual foreground collector, HTTP and subprocess lifecycle
  'test/resource-quota-refresh-lease.test.ts', // actual collector lease and durable pending marker
  'test/resource-quota-recovery.test.ts', // exact private marker recovery and real lease identity
  'test/resource-quota-idle-recovery.test.ts', // durable activity records and same-boot recovery
  'test/resource-quota-registered-recovery.test.ts', // durable command phases and passive group-absence recovery
  'test/resource-collector-diagnostics.test.ts', // acquisition-time evidence and private loopback console
  'test/resource-native-idle-lifecycle.test.ts', // owned child exit and strict process-group receipt
  'test/resource-quota-shared-evidence.test.ts', // private snapshots and verified process/lease identity
  'test/resource-shared-admission.test.ts', // current evidence inside atomic durable reservation
  'test/resource-worker-access.test.ts', // durable worker pauses and alias-aware atomic admission
  'test/resource-quota-publication.test.ts', // foreground publication lifecycle and failure fencing
  'test/universe-shared-quota.test.ts', // live collector handoff through private Universe runtime
  'test/resource-quota-once.test.ts', // private one-pass collector lifecycle and storage
  'test/resource-quota-contention.test.ts', // private collector contention, verified ownership and cancellation
  'test/resource-capacity-wait.test.ts', // read-only admission polls over private resource ledgers
  'test/resource-local-model-refresh.test.ts', // test-owned loopback inventory, refusal and cancellation
  'test/universe-core.test.ts', // real Git snapshots and confined experiment subprocesses
  'test/universe-delivery.test.ts', // real Git object/ref delivery and private receipts
  'test/universe-delivery-git-entries.test.ts', // bounded real Git blob loading and read-only inventory verification
  'test/universe-delivery-git-precommit.test.ts', // prepared real Git transaction guards and create-only ref outcomes
  'test/universe-delivery-kill.test.ts', // global stop under real prepared Git ref locks
  'test/universe-integration-delivery.test.ts', // private delivery evidence and fault-injected local Git publication
  'test/universe-integration-handoff.test.ts', // immutable downstream registration and source-lineage verification
  'test/universe-portfolio-controller.test.ts', // durable controller records and injected dispatch/restart faults
  'test/universe-portfolio-controller-graph-dispatch.test.ts', // immutable parent linkage and controller enrollment compatibility
  'test/universe-portfolio-controller-integration.test.ts', // native checkpointed DAG execution and replay
  'test/universe-dispatch-recovery-integration.test.ts', // native dispatch-attributed controller recovery without worker replay
  'test/universe-controller-reconciliation.test.ts', // private controller recovery ledger with injected attribution faults
  'test/universe-controller-diagnostics.test.ts', // private diagnostic history and failure publication invariants
  'test/universe-controller-handoff-diagnostics.test.ts', // real evaluated delivery and receipt-only acknowledgement recovery
  'test/universe-engineering-handoff-recovery.test.ts', // graph-linked delivery acknowledgement without repeating effects
  'test/universe-engineering-pending-continuation.test.ts', // real recovered delivery and bounded pending campaign continuation
  'test/universe-controller-pending-continuation.test.ts', // owned controller history and continuation refusal cases
  'test/universe-control-continuation-authority.test.ts', // signed graph intent and live continuation capability lifetime
  'test/resource-engineering-supervisor.test.ts', // private persisted supervision and owned execution lifecycle
  'test/resource-engineering-supervisor-boundaries.test.ts', // independent supervisor ownership and restart boundary checks
  'test/resource-engineering-supervisor-acceptance.test.ts', // actual unattended console queue and local evaluated delivery
  'test/resource-engineering-preparation.test.ts', // private linked campaign preparation and replay
  'test/resource-engineering-preparation-builtin.test.ts', // closed scoring recipes, pinned Git scope and mocked installed identity
  'test/resource-engineering-preparation-metadata.test.ts', // verified metadata reads and real source drift
  'test/resource-engineering-preparation-boundaries.test.ts', // independent private preparation boundary checks
  'test/resource-engineering-preparation-acceptance.test.ts', // actual prepared campaign to evaluated local delivery
  'test/resource-engineering-setup-acceptance.test.ts', // actual setup CLI and emitted autonomous A-to-B startup
  'test/resource-engineering-autonomous-setup.test.ts', // private Git fixtures and offline registration publication
  'test/resource-engineering-preparation-registry.test.ts', // immutable configuration and legacy registration identity
  'test/resource-engineering-worker-rpc.test.ts', // actual worker-thread authority calls and timeout/close races
  'test/resource-engineering-successor-store.test.ts', // private immutable journal records and drift/staging refusal
  'test/resource-engineering-successor-reader.test.ts', // fixed actual read worker, private journal and concurrent busy worker
  'test/resource-engineering-lifecycle.test.ts', // actual effect worker caught coordinator fault and independent journal observation
  'test/universe-preparation-verification.test.ts', // pinned evaluator prototype, real Git fixtures and OS confinement
  'test/preparation-verification-workflow.test.ts', // real candidate-linked manager restoration and successor delivery fixtures
  'test/preparation-batch-candidate-acceptance.test.ts', // pinned patch versus baseline in confined children with during-call drift
  'test/preparation-batch-node-boundary.test.ts', // actual Node combined stdout/stderr buffer boundaries
  'test/preparation-verification-runtime-drift.test.ts', // real candidate reads with trusted during-call runtime mutation
  'test/preparation-verification-successor-drift.test.ts', // real delivered source with trusted during-call branch mutation
  'test/preparation-verification-workflow-bridge.test.ts', // real fixed workflow bundle construction and graph checks
  'test/universe-builtin-preparation-evaluator.test.ts', // installed builtin through real Universe registration and isolated measurement
  'test/universe-preparation-measurement-files.test.ts', // actual bounded descriptor reads through the public diagnostic CLI route
  'test/universe-preparation-measurement-candidate-comparison.test.ts', // real private journals and calibration-to-comparison CLI; synthetic measurement contents
  'test/preparation-qualified-workload-acceptance.test.ts', // installed v2 workload and fixed packaged same-call stale-guard controls
  'test/preparation-score-packaging.test.ts', // private package fixtures, real esbuild/import and pinned native identity reads; no candidate dispatch
  'test/preparation-typecheck-authoring.test.ts', // private compiler graph snapshots and real closed full-program baseline verification
  'test/preparation-typecheck-full-project-acceptance.test.ts', // real full-project packaged compiler subprocess and process-group settlement
  'test/preparation-verification-child.test.ts', // actual OS-confined persistent candidate processes and deadline settlement
  'test/resource-pool-evolution.test.ts', // private ledger evolution and journal publication
  'test/resource-spark-enrollment-files.test.ts', // private proposal publication and filesystem tamper refusal
  'test/resource-quota-inspection.test.ts', // passive private collector marker inspection without acquisition
  'test/resource-console-inspection.test.ts', // authenticated loopback inspection with real private evidence preservation
  'test/resource-pool-evolution-boundaries.test.ts', // independent real account-capacity and conversation evolution fixtures
  'test/resource-console-pool-evolution.test.ts', // pinned console origins across private ledger epochs
  'test/resource-pool-evolution-engineering.test.ts', // evolved account ledger through campaign preparation and evaluated delivery
  'test/resource-quota-scope-access.test.ts', // durable private scope policy and locked admission
  'test/resource-quota-scope-access-boundaries.test.ts', // independent scope policy HTTP and native fixture acceptance
  'test/universe-graph-controller-reconciliation.test.ts', // immutable settlement guards and terminal graph preservation
  'test/universe-campaign-dispatch.test.ts', // exact dispatch recovery with actual private measured-seed records
  'test/universe-controller-contention-integration.test.ts', // native execution-lock contention, bounded waiting and cancellation
  'test/universe-admission-preflight-integration.test.ts', // invalid resource configuration withheld before real campaign dispatch
  'test/universe-controller-crash-integration.test.ts', // separate-process SIGKILL, stale leases and exact-dispatch recovery
  'test/universe-controller-owner-control-integration.test.ts', // separate campaign control CLI, worker drain and persisted DAG restart
  'test/universe-controller-signal-integration.test.ts', // real controller SIGINT/SIGTERM and owned worker cleanup
  'test/universe-controller-controls.test.ts', // immutable drain/resume ordering and short transaction locking
  'test/universe-controller-drain.test.ts', // persisted admission control, live transaction contention and drain acknowledgement
  'test/universe-controller-drain-integration.test.ts', // separate CLI drain/resume, active delivery and preserved queue across restart
  'test/universe-controller-admission-integration.test.ts', // separate-process admission contention and fresh evidence before intent
  'test/universe-controller-not-started-integration.test.ts', // post-intent cancellation, verified no-call settlement and restart without replay
  'test/universe-campaign-owned.test.ts', // exact private execution leases and campaign admission authority
  'test/universe-integration-evaluate.test.ts', // real private candidate artifacts with injected evaluation and ledger faults
  'test/universe-delivery-review.test.ts', // independent Git provenance and historical receipt review
  'test/universe-graph-reader.test.ts', // targeted real Git/private-ledger graph observation
  'test/local-pack-universe-smoke.test.ts', // installed SDK/CLI contract with real Git fixtures
  'test/universe-model-integration.test.ts', // real pinned evaluator plus bounded local HTTP model fixtures
  'test/universe-resource-integration.test.ts', // native resource handoff through frozen evaluator and campaign feedback
  'test/universe-resource-generation.test.ts', // private Git workspace and resource transport admission, replay and cancellation
  'test/universe-file-operations.test.ts', // confined create/replace/delete and local transport fixtures
  'test/universe-file-operations-replay.test.ts', // private artifact presence and operation ledger replay
  'test/universe-file-operations-integration.test.ts', // native multi-file parser challenge and Git delivery
  'test/universe-file-operations-review.test.ts', // independent operation conflicts and cancellation review
  'test/universe-file-operations-runner.test.ts', // frozen snapshot admission with private Git fixtures
  'test/universe-campaign-integration.test.ts', // native multi-generation ownership, feedback and durable resource limits
  'test/universe-portfolio-integration.test.ts', // native cross-Universe dependency ordering and concurrent campaign settlement
  'test/universe-portfolio-resource-integration.test.ts', // shared resource ledger and confined cross-Universe dependency execution
  'test/universe-resource-quota-integration.test.ts', // inert native metadata capture before confined Universe generation
  'test/universe-capacity-wait-integration.test.ts', // parallel inert campaigns sharing collector and worker capacity
  'test/universe-local-refresh-integration.test.ts', // inert inventory and local-chat campaign lifecycle
  'test/universe-campaign-readiness.test.ts', // immutable private campaign and evaluator readback
  'test/universe-supervision-integration.test.ts', // confined multi-campaign supervision and owned cleanup
  'test/universe-campaign-supervisor-restart.test.ts', // real campaign ledgers, admission and leases across foreground reinvocations
  'test/universe-feedback-replay.test.ts', // durable feedback integrity and a complete 64-trial record footprint
  'test/universe-evaluator-diagnostics.test.ts', // immutable fixture stores and evaluator phase feedback replay
  'test/universe-generation-diagnostics.test.ts', // immutable failure evidence and next-generation feedback
  'test/universe-search-feedback-integration.test.ts', // native metric-directed search after repeated unchanged trials
  'test/universe-search-feedback-replay.test.ts', // independent versioned search-context replay and legacy recovery
  'test/universe-comparison-reader.test.ts', // targeted private-ledger and Git delivery observation
  'test/universe-comparison-integration.test.ts', // native paired campaigns with loopback model fixtures
  'test/universe-demo.test.ts', // two real Universe generations and artifact lineage
  'test/universe-confinement.test.ts', // real macOS filesystem boundary checks with test-owned sentinels
  // --- confirmed-flaky repeat offenders (this session's evidence: isolation re-runs pass;
  // only fail under parallel load with the 5s default) ---
  'test/m201.daemon-loop.test.ts', // real daemon subprocess loop — 16.5s slowest test in the quiet baseline
  'test/m86.automerge-gate.test.ts', // real git automerge gate — 7.6s slowest test in the quiet baseline
  'test/m126.manager-merge-gate.test.ts', // real git manager merge gate — 7.2s slowest test in the quiet baseline
  'test/m153.verification-gate.test.ts', // real verify-command subprocess gate — 4.2s slowest test in the quiet baseline
  'test/m362.repair-handoff-journal.test.ts', // real fs journal + repair handoff — 5.5s slowest test in the quiet baseline
  'test/m367.resolution-observer.test.ts', // real fs resolution observer polling — 1.8s slowest test in the quiet baseline
  'test/m395.effect-terminal-retention.test.ts', // real fs retention manifest crash-recovery (95.9s single test) — 95.9s slowest test in the quiet baseline
  'test/m432.operational-projection.test.ts', // real fs operational projection — 9.1s slowest test in the quiet baseline
  'test/m476.release-current-tip-store.test.ts', // real fs release tip store — 2.3s slowest test in the quiet baseline
  'test/m501.daemon-state-resolution.test.ts', // real daemon state resolution over real fs — 17.7s slowest test in the quiet baseline
  'test/m518.goal-timestamp-repair.test.ts', // real fs goal timestamp repair — 3.7s slowest test in the quiet baseline
  'test/npm-cli-launch.test.ts', // spawns the real npm CLI — 3.5s slowest test in the quiet baseline
  'test/m310.queued-autonomy-work.test.ts', // real queued autonomy work over real fs — 9.6s slowest test in the quiet baseline
  'test/m245.self-improve-integration.test.ts', // real self-improve integration loop — 4.7s slowest test in the quiet baseline
  'test/h2.swarm-resume.test.ts', // real swarm resume fixture (hermetic H-suite) — 4.1s slowest test in the quiet baseline
  'test/m233.partial-diff-on-timeout.test.ts', // real diff/timeout subprocess interaction — 3.3s slowest test in the quiet baseline
  'test/m482.release-artifact-contract.test.ts', // real npm pack/install release artifact contract (68.1s single test — keeps its own 180s override below) — 68.1s slowest test in the quiet baseline
  'test/m342.dispatch-production-ledger.test.ts', // real fs dispatch ledger, 105s+ verified in isolation — 29.7s slowest test in the quiet baseline
  'test/m355.skill-records.test.ts', // writes real 4MiB skill-record fs partitions — 55.6s slowest test in the quiet baseline

  // --- external-skill / judge / foundry family: real git capture, audit receipts, custody
  // attestation, and routing over a real fs (some already carried a piecemeal 45s raise) ---
  'test/m172.judge-in-loop.test.ts', // real fs/git skill or judge subprocess work — 3.8s slowest test in the quiet baseline
  'test/m176.judge-resolver.test.ts', // real fs/git skill or judge subprocess work — 4.5s slowest test in the quiet baseline
  'test/m183.taste-critic.test.ts', // real fs/git skill or judge subprocess work — 3.4s slowest test in the quiet baseline
  'test/m45.foundry.test.ts', // real fs/git skill or judge subprocess work — 3.9s slowest test in the quiet baseline
  'test/m446.external-skill-git-capture.test.ts', // real fs/git skill or judge subprocess work — 23.4s slowest test in the quiet baseline
  'test/m447.external-skill-custody-attestation.test.ts', // real fs/git skill or judge subprocess work — 4.4s slowest test in the quiet baseline
  'test/m451.external-skill-audit-receipt.test.ts', // real fs/git skill or judge subprocess work — 14.0s slowest test in the quiet baseline
  'test/m454.agent-skills-routing-challenge.test.ts', // real fs/git skill or judge subprocess work — 9.4s slowest test in the quiet baseline
  'test/m455.external-skill-maturity.test.ts', // real fs/git skill or judge subprocess work — 13.2s slowest test in the quiet baseline
  'test/m456.skill-retrieval-calibration.test.ts', // real fs/git skill or judge subprocess work — 16.3s slowest test in the quiet baseline
  'test/m457.external-skill-artifact-firewall.test.ts', // real fs/git skill or judge subprocess work — 12.3s slowest test in the quiet baseline

  // --- automerge / merge-decision / post-merge / worktree family: real git worktrees, real
  // merges and applies against a real repo checkout ---
  'test/m21.worktree.test.ts', // real git worktree/merge/apply subprocess work — 3.3s slowest test in the quiet baseline
  'test/m23.apply.test.ts', // real git worktree/merge/apply subprocess work — 3.3s slowest test in the quiet baseline
  'test/m23.gate.test.ts', // real git worktree/merge/apply subprocess work — 3.1s slowest test in the quiet baseline
  'test/m42.engineer-tools.test.ts', // real git worktree/merge/apply subprocess work — 7.1s slowest test in the quiet baseline
  'test/m47.merge.test.ts', // real git worktree/merge/apply subprocess work — 6.1s slowest test in the quiet baseline
  'test/m48.automerge-pass.test.ts', // real git worktree/merge/apply subprocess work — 5.2s slowest test in the quiet baseline
  'test/m56.branch-apply.test.ts', // real git worktree/merge/apply subprocess work — 3.2s slowest test in the quiet baseline
  'test/m85.fleet-continuity.test.ts', // real git worktree/merge/apply subprocess work — 5.3s slowest test in the quiet baseline
  'test/m315.remote-handoff-truth.test.ts', // real git worktree/merge/apply subprocess work — 8.7s slowest test in the quiet baseline
  'test/m375.post-merge-window.test.ts', // real git worktree/merge/apply subprocess work — 11.3s slowest test in the quiet baseline
  'test/m394.effect-journal-integration.test.ts', // real git worktree/merge/apply subprocess work — 30.1s slowest test in the quiet baseline
  'test/m397.automerge-canary-store.test.ts', // real git worktree/merge/apply subprocess work — 14.5s slowest test in the quiet baseline
  'test/m398.merge-decision-truth.test.ts', // real git worktree/merge/apply subprocess work — 7.9s slowest test in the quiet baseline
  'test/m402.automerge-canary-shadow-hook.test.ts', // real git worktree/merge/apply subprocess work — 11.9s slowest test in the quiet baseline
  'test/m419.remote-handoff-intent.test.ts', // real git worktree/merge/apply subprocess work — 5.1s slowest test in the quiet baseline
  'test/m468.detached-post-merge-runner.test.ts', // real git worktree/merge/apply subprocess work — 3.9s slowest test in the quiet baseline

  // --- mutation-fence / sandbox-lifecycle family: real fs locks, real sandbox dirs, real
  // recovery over a crash-simulated real fs (measured single-test duration close to/over 5s) ---
  'test/m405.apply-mutation-fence.test.ts', // real fs lock/sandbox lifecycle work — 4.3s slowest test in the quiet baseline
  'test/m407.verification-mutation-fence.test.ts', // real fs lock/sandbox lifecycle work — 4.3s slowest test in the quiet baseline
  'test/m408.sandbox-creation-mutation-fence.test.ts', // real fs lock/sandbox lifecycle work — 9.3s slowest test in the quiet baseline
  'test/m409.engine-execution-mutation-fence.test.ts', // real fs lock/sandbox lifecycle work — 5.9s slowest test in the quiet baseline
  'test/m411.local-merge-reconciliation.test.ts', // real fs lock/sandbox lifecycle work — 6.2s slowest test in the quiet baseline
  'test/m412.sandbox-pre-effect-recovery.test.ts', // real fs lock/sandbox lifecycle work — 3.3s slowest test in the quiet baseline
  'test/m417.sandbox-cleanup-quiescence.test.ts', // real fs lock/sandbox lifecycle work — 4.8s slowest test in the quiet baseline
  'test/m426.sandbox-reservation-identity.test.ts', // real fs lock/sandbox lifecycle work — 3.6s slowest test in the quiet baseline
  'test/m463.claimed-batch-admission.test.ts', // real fs lock/sandbox lifecycle work — 7.4s slowest test in the quiet baseline
  'test/m490.daemon-state-recovery-cli.test.ts', // real fs lock/sandbox lifecycle work — 3.6s slowest test in the quiet baseline

  // --- misc real subprocess/fs/network work (worker pool, dashboard CLI spawn, fleet, retry) ---
  'test/activation-readiness-package.test.ts', // real subprocess/fs work (marker-detected or measured) — 4.7s slowest test in the quiet baseline
  'test/h1.chain.test.ts', // real subprocess/fs work (marker-detected or measured) — 4.0s slowest test in the quiet baseline
  'test/m116.worker-pool.test.ts', // real subprocess/fs work (marker-detected or measured) — 4.8s slowest test in the quiet baseline
  'test/m2.config-set.test.ts', // real subprocess/fs work (marker-detected or measured) — 3.4s slowest test in the quiet baseline
  'test/m211.dashboard-cli.test.ts', // real subprocess/fs work (marker-detected or measured) — 4.1s slowest test in the quiet baseline
  'test/m220.anticlog-verdict-feedback.test.ts', // real subprocess/fs work (marker-detected or measured) — 4.0s slowest test in the quiet baseline
  'test/m240.learned-routing.test.ts', // real subprocess/fs work (marker-detected or measured) — 4.7s slowest test in the quiet baseline
  'test/m247.gateway-equivalence.test.ts', // real subprocess/fs work (marker-detected or measured) — 5.1s slowest test in the quiet baseline
  'test/m297.retry-transient-abort.test.ts', // real subprocess/fs work (marker-detected or measured) — 3.9s slowest test in the quiet baseline
  'test/m301.autonomy-policy.test.ts', // real subprocess/fs work (marker-detected or measured) — 4.5s slowest test in the quiet baseline
  'test/m332.outcome-watcher.test.ts', // real subprocess/fs work (marker-detected or measured) — 3.1s slowest test in the quiet baseline
  'test/m360.generated-repair-lifecycle.test.ts', // real subprocess/fs work (marker-detected or measured) — 3.1s slowest test in the quiet baseline
  'test/m374.proposal-source-quality.test.ts', // real subprocess/fs work (marker-detected or measured) — 3.7s slowest test in the quiet baseline
  'test/m383.cutoff-observation-checkpoints.test.ts', // real subprocess/fs work (marker-detected or measured) — 17.1s slowest test in the quiet baseline
  'test/m46.fleet.test.ts', // real subprocess/fs work (marker-detected or measured) — 3.2s slowest test in the quiet baseline
  'test/h5.leak-containment.test.ts', // real subprocess/fs work (marker-detected or measured) — 30.6s slowest test in the quiet baseline
  'test/m518.goal-timestamp-repair-faults.test.ts', // real subprocess/fs work (marker-detected or measured) — 3.5s slowest test in the quiet baseline
  'test/m522.production-promotion-admission.test.ts', // spawns a real Node child to validate immutable promotion admission

  // --- special cases: fast on a quiet machine but genuinely real I/O, so still contention-prone ---
  'test/local-runtime-acceptance.test.ts', // pinned archives, real installed Node smoke and durable selection failure recovery
  'test/universe-console-acceptance.test.ts', // real loopback scope/session isolation and immutable private Universe observations
  'test/local-runtime-store.test.ts', // private runtime installation/rollback, manifests, fsync and subprocess smoke
  'test/m19.telemetry-sink.test.ts', // binds a real local HTTP server (OtlpHttpSink describe block) — 0.0s slowest test in the quiet baseline
  'test/m571.local-production-gate.test.ts', // validates the macOS sandbox with real loopback HTTP, Unix sockets, subprocesses, and filesystem writes
  'test/m2.doctor.test.ts', // runs real environment/tool probes against git, npm, and fs — 0.9s slowest test in the quiet baseline
  'test/m440.dependency-audit-ci.test.ts', // spawns bounded real shell fixtures to prove audit fallback fail-closed behavior
  'test/m93.daemon-service-crash-recovery.test.ts', // real daemon process crash/recovery (24.5s file total) — 1.7s slowest test in the quiet baseline

  // --- Agent OS durable stores and runtime: real private filesystem layouts, fsync/link
  // publication, process locks, crash-stage recovery, and large authenticated histories.
  // The integrated M526-M564 run proved these suites serially. A full four-worker unit
  // run then reproduced contention-only deadline failures in M557/M560/M562, while the
  // same assertions remain green in their bounded lane. Keep the complete related
  // filesystem family together so future changes do not reintroduce cross-suite load.
  'test/m526.execution-identity-v1.test.ts', // real private locator store and permission checks
  'test/m533.agent-os-snapshot-store.test.ts', // immutable snapshot records and crash recovery
  'test/m536.agent-os-observer-attempt-store.test.ts', // durable attempt receipts and retries
  'test/m537.daemon-tick-authority-capability.test.ts', // real daemon authority state fixtures
  'test/m538.agent-os-source-bundle-store.test.ts', // authenticated source registry on disk
  'test/m543.agent-os-observer-scheduler.test.ts', // real child lifecycle and durable tick fixtures
  'test/m548.locus-workspace-identity-ledger.test.ts', // bounded private identity ledger
  'test/m552.locus-privacy-provenance-admission.test.ts', // atomic capability-to-ledger admission
  'test/m553.agent-os-epoch-store.test.ts', // immutable epoch artifacts and active pointer
  'test/m556.agent-os-epoch-coordination.test.ts', // process lease and observation lock
  'test/m557.agent-os-epoch-attempt-store.test.ts', // 1000-receipt authenticated history
  'test/m557b.immutable-private-record-layout.test.ts', // exact-private layout recovery
  'test/m560.agent-os-epoch-snapshot-store.test.ts', // snapshot history and reciprocal joins
  'test/m561.agent-os-epoch-source-store.test.ts', // source renewal lineage and recovery
  'test/m562.agent-os-epoch-runtime.test.ts', // end-to-end durable transaction and crash stages
  'test/m563.agent-os-epoch-stage-recovery.test.ts', // ordered recovery over three ledgers
  'test/m564.agent-os-epoch-trust-composition.test.ts', // composed trust reads over real stores
  'test/m566.execution-capacity-lease.test.ts', // exact-private capacity ledger, atomic rename/fsync, and lock contention
  'test/m567.docker-engine-unix-client.test.ts', // fake Docker Engine protocol over a real temporary Unix socket
  'test/m567.agent-os-local-container-broker-journal.test.ts', // exact-private append-only lifecycle journal
  'test/m567.agent-os-local-container-broker.test.ts', // real journal/capacity I/O with injected fake Engine capability

  // --- 3.10 (Tracks A/B/C). Each entry was either flagged by
  // `node scripts/check-realio-lane-membership.mjs` or named by its building unit
  // as real-io even though the guard cannot see it (the git/child-process work
  // lives in a test/helpers/ file the marker grep does not follow). Files a unit
  // named that turned out to be pure in-memory (perf-server-sse: a fake
  // ServerResponse; local-fleet-lanecap-310b: a pure derivation) stay in the
  // fast lane on purpose — this lane is serialized, so membership is a cost. ---
  // Track A — performance, accounts, local runtime, health/history.
  'test/perf-server-github.test.ts', // real `git init`/commits in a temp repo for the GitHub read cache
  'test/perf-server-rollup.test.ts', // real temp git repos; asserts a new commit invalidates exactly one repo's rollup
  'test/perf-server-private-storage.test.ts', // real /bin/chmod ACL grants and revocations on private dirs
  'test/perf-server-static.test.ts', // real loopback HTTP server for immutable/compressed static assets
  'test/perf-server-control.test.ts', // real read-projection worker thread; asserts a busy worker is never awaited (timing-sensitive under load)
  'test/perf-server-claude-usage.test.ts', // real transcript appends/truncations and the async prime path on disk
  'test/llama-process-async.test.ts', // spawns a real (harmless node timer) process standing in for llama-server
  'test/local-eval-trace.test.ts', // real loopback HTTP server standing in for the local model endpoint
  'test/local-eval-heldout.test.ts', // spawns real `node` held-out checkers, like local-eval.test.ts
  'test/verse-accounts-limit-reached.test.ts', // private 0600/0700 ledger evidence files round-tripped in a tmp root (sibling of verse-accounts)
  'test/verse-fleet-history.test.ts', // one real worker thread + an event-loop budget assertion over on-disk fixtures
  'test/routing-budget-api.test.ts', // real web server bind for /api/verse/budget* under a relocated HOME
  'test/routing-capacity-history.test.ts', // 3.10.1: real loopback http server + real authenticated web server bind for /api/verse/budget/history under a relocated HOME; real mkfifo + a tsx child with a deadline for the FIFO guard; multi-MiB compaction fixtures
  'test/setup/home-isolation-guard.test.ts', // spawns a nested real `vitest run` to prove the guard fails a leaking fixture
  // Track A/C — Verse server surfaces.
  'test/verse-activity-310.test.ts', // real web server bind for /api/verse/activity + a 300-chat warm-read latency bound
  'test/verse-apps-310.test.ts', // real web server bind for /api/verse/apps
  'test/verse-project-memory.test.ts', // spawns real `node` to prove a NUL-bearing argv cannot throw at spawn time
  'test/verse-workspaces.test.ts', // real `git` in temp repos for multi-folder workspace roots
  // (test/local-only-dispatch-paths.test.ts was listed here at INT8 as a marker
  // false positive; it moved to scripts/realio-lane-known-fast-spawns.mjs, its
  // better home — the `spawn(` it matches is inside a source-text scan.)
  // Track B — autonomy core.
  'test/host-merge-310b.test.ts', // real git through FakeGithub (test/helpers/fleet-github-310b.ts) — guard cannot see it
  'test/standing-merge-pass-310b.test.ts', // real git rebase/squash through FakeGithub — guard cannot see it
  'test/execution-leases-310b.test.ts', // cross-process lease cases via real tsx children (test/helpers/throughput-310b.ts)
  'test/throughput-310b.test.ts', // real tsx children + h1 temp repos; only the model is faked
  'test/mirrors-310b.test.ts', // real mirror clones/fetches in h1 temp repos via the throughput helper
  'test/safe-git-310b.test.ts', // real `git init` mirrors to prove hooks/fsmonitor are forced off
  'test/confine-autonomous-darwin-310b.test.ts', // real sandbox-exec children + a real net server as an egress target
  'test/engines-judges-310b.test.ts', // execs the grok-cli launcher (fake pinned binary in a seat fixture) exactly as the fleet would, to inspect env scrubbing
  'test/fleet-live-api-310b.test.ts', // real web server bind for /api/verse/fleet/live
  'test/overnight-api-310b.test.ts', // real web server bind for /api/verse/overnight
  'test/w1.post-merge-halt.test.ts', // real git in h1 fixture repos for the post-merge halt
  // Added at the 3.10 protected-infra pass (R3e): two the guard flagged, one it cannot see.
  'test/int4-confine-engines-310b.test.ts', // real git worktrees + real sandbox-exec children (1.2s slowest test, 5s file)
  'test/post-merge-watch-suite-310b.test.ts', // real git mirror + worktree and the real verify commands the watch runs
  'test/verify-confinement-310b.test.ts', // real sandbox-exec around verify commands via runVerifyCommandAsync — guard cannot see it
  'test/completeness-gate-stash-hardening-310b.test.ts', // real git stash push/pop in temp repos with planted fsmonitor/filter programs (R3a)
  // Added at the 3.10 fix pass (L2): none carries a marker the guard sees — the
  // spawn/git lives behind a src/ or test/helpers/ call — so each is named here
  // by what it really does, measured 2026-09-24 on this machine.
  'test/verify-commands-confine-310b.test.ts', // real sandbox-exec + node children through runVerifyCommandAsync/runVerifyCommand (R3a)
  'test/engines-stream-family-310b.test.ts', // real spawnEngine children (fake grok binary) raced against 200ms stall-grace timers — timing-sensitive under parallel load
  'test/standing-wiring-loop-310b.test.ts', // real h1-fixture git repos driven through the daemon loop (3.4s slowest test, 10.8s file)
  'test/tick-hooks-loop-310b.test.ts', // real h1-fixture git repos driven through the daemon loop (4.0s slowest test, 14.4s file)
  // Added at the 3.10 fix pass (P5): the guard flagged it. Its darwin block runs
  // a real `/usr/bin/log stream` probe and real sandbox-exec children, and waits
  // on the log stream's readiness + barrier line — only ~50ms per test idle
  // (2026-09-24), but a wait on another process's output is exactly what slips
  // past 5s under parallel load, so it belongs in the serialized lane.
  'test/sandbox-kernel-evidence-310.test.ts', // real log stream + sandbox-exec (d0 kernel evidence)

  // --- hermetic H-suite: every file spins up a real temp git repo + real fs by design.
  // Already forced fully serial via `npm run test:invariants` (--no-file-parallelism); folding
  // the whole family in here keeps that existing convention and this lane's membership in sync. ---
  'test/h1.apply-guardrails.test.ts', // hermetic real temp git repo + real fs fixture — 2.6s slowest test in the quiet baseline
  'test/h1.audit.test.ts', // hermetic real temp git repo + real fs fixture — 2.1s slowest test in the quiet baseline
  'test/h1.daemon-gates.test.ts', // hermetic real temp git repo + real fs fixture — 2.8s slowest test in the quiet baseline
  'test/h1.fixture.test.ts', // hermetic real temp git repo + real fs fixture — 1.4s slowest test in the quiet baseline
  'test/h1.safety.test.ts', // hermetic real temp git repo + real fs fixture — 1.6s slowest test in the quiet baseline
  'test/h2.daemon-no-double-spend.test.ts', // hermetic real temp git repo + real fs fixture — 3.9s slowest test in the quiet baseline
  'test/h2.kill-race-abort.test.ts', // hermetic real temp git repo + real fs fixture — 3.3s slowest test in the quiet baseline
  'test/h2.orphan-sandbox.test.ts', // hermetic real temp git repo + real fs fixture — 4.0s slowest test in the quiet baseline
  'test/h2.proposal-survives.test.ts', // hermetic real temp git repo + real fs fixture — 3.1s slowest test in the quiet baseline
  'test/h3.atomic-writes.test.ts', // hermetic real temp git repo + real fs fixture — 21.0s slowest test in the quiet baseline
  'test/h3.budget-cap.test.ts', // hermetic real temp git repo + real fs fixture — 2.3s slowest test in the quiet baseline
  'test/h3.concurrency-cap.test.ts', // hermetic real temp git repo + real fs fixture — 9.4s slowest test in the quiet baseline
  'test/h3.daily-reset.test.ts', // hermetic real temp git repo + real fs fixture — 4.0s slowest test in the quiet baseline
  'test/h3.id-collision.test.ts', // hermetic real temp git repo + real fs fixture — 0.8s slowest test in the quiet baseline
  'test/h4.local-first-secret.test.ts', // hermetic real temp git repo + real fs fixture — 1.3s slowest test in the quiet baseline
  'test/h4.proposal-only.test.ts', // hermetic real temp git repo + real fs fixture — 1.6s slowest test in the quiet baseline
  'test/h4.sandbox-containment.test.ts', // hermetic real temp git repo + real fs fixture — 2.3s slowest test in the quiet baseline
  'test/h4.sandbox-enrollment-kill.test.ts', // hermetic real temp git repo + real fs fixture — 1.6s slowest test in the quiet baseline
  'test/h4.verify-safety.test.ts', // hermetic real temp git repo + real fs fixture — 0.8s slowest test in the quiet baseline
  'test/h5.allowanyrepo-envgate.test.ts', // hermetic real temp git repo + real fs fixture — 4.6s slowest test in the quiet baseline
  'test/h5.disk-cap.test.ts', // hermetic real temp git repo + real fs fixture — 5.9s slowest test in the quiet baseline
  'test/h5.orphan-sweep-wire.test.ts', // hermetic real temp git repo + real fs fixture — 5.3s slowest test in the quiet baseline
  'test/h5.reconcile-state.test.ts', // hermetic real temp git repo + real fs fixture — 0.1s slowest test in the quiet baseline
  'test/h6.audit-completeness.test.ts', // hermetic real temp git repo + real fs fixture — 1.2s slowest test in the quiet baseline
  'test/h6.audit-policy.test.ts', // hermetic real temp git repo + real fs fixture — 2.3s slowest test in the quiet baseline
  'test/h6.audit-viewer.test.ts', // hermetic real temp git repo + real fs fixture — 0.0s slowest test in the quiet baseline
  'test/h6.no-secret-in-audit.test.ts', // hermetic real temp git repo + real fs fixture — 3.9s slowest test in the quiet baseline
  'test/h6.scrub-parity.test.ts', // hermetic real temp git repo + real fs fixture — 0.0s slowest test in the quiet baseline
  'test/h7.doctor-probes.test.ts', // hermetic real temp git repo + real fs fixture — 5.4s slowest test in the quiet baseline
  'test/h7.no-new-outward.test.ts', // hermetic real temp git repo + real fs fixture — 3.3s slowest test in the quiet baseline
  'test/h7.onboard.test.ts', // hermetic real temp git repo + real fs fixture — 2.8s slowest test in the quiet baseline
  'test/h7.preflight.test.ts', // hermetic real temp git repo + real fs fixture — 1.2s slowest test in the quiet baseline
  'test/h7.rollback.test.ts', // hermetic real temp git repo + real fs fixture — 7.8s slowest test in the quiet baseline
  'test/h8.cleanup-comment-only.test.ts', // hermetic real temp git repo + real fs fixture — 0.0s slowest test in the quiet baseline
  'test/h8.demo-safety.test.ts', // hermetic real temp git repo + real fs fixture — 1.9s slowest test in the quiet baseline
  'test/h8.demo.test.ts', // hermetic real temp git repo + real fs fixture — 4.2s slowest test in the quiet baseline
  'test/h8.docs.test.ts', // hermetic real temp git repo + real fs fixture — 0.0s slowest test in the quiet baseline
  'test/h8.no-new-outward.test.ts', // hermetic real temp git repo + real fs fixture — 0.0s slowest test in the quiet baseline
  'test/verse-session-engine.test.ts', // real detached subprocesses (fake vendor CLIs) with process-group cancel/timeout kill paths
];
