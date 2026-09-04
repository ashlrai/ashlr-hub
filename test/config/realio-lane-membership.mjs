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
  'test/m19.telemetry-sink.test.ts', // binds a real local HTTP server (OtlpHttpSink describe block) — 0.0s slowest test in the quiet baseline
  'test/m2.doctor.test.ts', // runs real environment/tool probes against git, npm, and fs — 0.9s slowest test in the quiet baseline
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
];
