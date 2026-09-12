# Account integration readiness

The Spark preparation, passive collector inspection and test cleanup fix are
integrated locally on primary throughcfbbd491. The original native acceptance
finished before integration:489tests/17files/zero skips3042.59s on73003. The
four separate stale-result controls passed on3245. The clean primary rebuild at
e732a824passed on73726 and retained all nine qualified evaluator asset hashes.
Combined primary acceptance passed360account/runtime tests and421UI tests, with
zero skips. Web types, docs, lane and independent review passed. Exact evidence
is in`integration-verification.json`; source integration is complete locally.

Fixed one independently identified native test cleanup defect: each actual
invocation now owns a cleanup ticket. Missing settlement, thrown dispatch and
failed activity proof retain evidence, and later successful cases cannot clear
the hold. Cleanup requires confirmed aggregate settlement, the production activity
inspector and independent process-group absence. Retained roots are reported.
No production evaluator semantics or numerical acceptance criteria changed.

## Verified locally

- Account evolution, quota policy, recovery and inspection:349tests/15files,
  zero skipped,54.34s,session90524exit0.
- Cleanup helper and non-dispatch controls:22passed,4filtered,2files,2.32s,
  session26155exit0. Eleven helper tests are included, not additional.
- Real poisoned-candidate and cancellation paths:2passed,13filtered,70.62s,
  session82818exit0. The two long baseline/post-settlement cases were not rerun.
- Full isolated build, scoped lint and docs:session5553exit0. The first full
  build42583 failed package inventory because npm followed a dependency symlink
  outside the package. Replaced that symlink with an independent local APFS copy;
  preserved the original link. No dependency install or validator relaxation.
- Regenerated evaluator matched all nine primary asset hashes and aggregate
  `25d5787412e177238745216d259a9167768ca6460bfed126cc453eb714d0f953`.
- Independent source reviews found no integration or cleanup-fix blocker.

Native primary sessions73003 and3245 are terminal, with exact results retained in
`../2026-09-12-installed-scoring/primary-native-acceptance.json` and
`stale-controls.json`. Neither terminal handle should be polled or restarted.
These tests and the build do not prove real calibration, quota freshness, account
commissioning, accepted engineering work or production deployment.

## Operational path

Fresh read-only inspection at2026-09-12T10:52:31.575Z confirmed the global stop
healthy/active and the collector record pending/v1/legacy-owner-evidence-missing.
No automatic recovery was attempted. There are no live native validation handles.

Use the existing [pool migration procedure](../../docs/RESOURCE-POOLS.md) and
quota-scope access API; no new scheduler is needed. Resolve collector custody,
preserve the ledger through additive migration, merge the General exclusion using
a fresh policy revision, verify the unchanged75%ceiling, and only then consider
releasing the whole-account pause. Personal General must remain reserved. Fresh
exact-scope quota evidence and resolution of the existing global stop are still
required before commissioning eligible work. Nothing here changes live policy.
