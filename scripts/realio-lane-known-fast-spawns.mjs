/**
 * Files that spawn a real child process (so `scripts/check-realio-lane-membership.mjs`'s
 * marker grep matches them) but were measured, in this session's full-suite
 * `--reporter=json` baseline run on an idle machine (2026-08-18), at well
 * under 3 seconds for their single slowest test — most under 1 second. The
 * spawn is real but cheap (e.g. a single fast `git rev-parse` or similar),
 * not the kind of work that meaningfully contends under parallel load, so
 * these stay in the fast `unit` lane rather than the serialized `real-io`
 * lane. The comment on each line is that measured single-test maximum.
 *
 * This list exists so the guard can stay a STRICT gate (anything with a real
 * spawn marker must be either in REAL_IO_TEST_FILES or explicitly justified
 * here) without today's tree failing `npm run lint` on ~46 pre-existing,
 * legitimately-fast files. A new file lands here only with a reason — if a
 * file here starts running slow (e.g. a rewrite adds real work), the
 * duration-based judgment in this comment goes stale and the file should
 * move to REAL_IO_TEST_FILES instead.
 */
export const KNOWN_FAST_SPAWN_FILES = [
  'test/m466.host-merge-revocation-protocol.test.ts', // 2.9s
  'test/m396.automerge-canary-classifier.test.ts', // 2.8s
  'test/m444.external-skill-audit.test.ts', // 2.7s
  'test/m49.fleet-status.test.ts', // 2.5s
  'test/m225.sandbox-cwd.test.ts', // 2.5s
  'test/m391.execution-lifecycle-authority.test.ts', // 2.3s
  'test/m283.mcp-exclude.test.ts', // 2.2s
  'test/m106.correctness-fixes.test.ts', // 2.1s
  'test/m9.index-engine.test.ts', // 1.9s
  'test/git.test.ts', // 1.6s
  'test/m422.policy-transaction-recovery.test.ts', // 1.6s
  'test/m331.verify-to-green.test.ts', // 1.5s
  'test/m389.persistence-generation-cas.test.ts', // 1.4s
  'test/m89.pulse-export.test.ts', // 1.1s
  'test/tidy.test.ts', // 1.0s
  'test/m17.rollback.test.ts', // 0.8s
  'test/m387.origin-authority.test.ts', // 0.7s
  'test/m454.agent-skills-generator.test.ts', // 0.7s
  'test/build-identity.test.ts', // 0.6s
  'test/m52.confine.test.ts', // 0.5s
  'test/m425.policy-startup-recovery.test.ts', // 0.5s
  'test/m367.daemon-observer-scheduler.test.ts', // 0.5s
  'test/m392.queue-lease-epochs.test.ts', // 0.4s
  'test/m314.repo-execution-profile.test.ts', // 0.4s
  'test/m385.cutoff-checkpoint-windows.test.ts', // 0.4s
  'test/m27.conventions.test.ts', // 0.4s
  'test/m24.state.test.ts', // 0.4s
  'test/m414.local-store-lock-unknown-owner.test.ts', // 0.3s
  'test/m31.gateway-native.test.ts', // 0.3s
  'test/m410.policy-opposing-race.test.ts', // 0.3s
  'test/m382.enrollment-cutoff-snapshot.test.ts', // 0.3s
  'test/m2.doctor-exit-code.test.ts', // 0.3s
  'test/m415.policy-durability-races.test.ts', // 0.3s
  'test/post-merge-credit-import-cycle.test.ts', // 0.2s
  'test/m147.telegram-comms.test.ts', // 0.2s
  'test/cli-tidy-json.test.ts', // 0.2s
  'test/m249.run-cache-shadow.test.ts', // 0.2s
  'test/classify.test.ts', // 0.1s
  'test/m52.write-allow.test.ts', // 0.1s
  'test/m14.static.test.ts', // 0.1s
  'test/m484.pr-topology-admission.test.ts', // 0.1s
  'test/m468.release-desktop-workflow-policy.test.ts', // 0.1s
  'test/setup/home.test.ts', // <0.1s
  'test/m468.resident-service-readiness.test.ts', // <0.1s
  'test/m54.self-guard.test.ts', // <0.1s
  'test/m93.daemon-service-launchd-integration.test.ts', // 0s (native_launchd env-gated on this machine)
];
