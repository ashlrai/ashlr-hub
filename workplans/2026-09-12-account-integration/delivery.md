# Account integration readiness

The Spark preparation and passive collector inspection commits apply cleanly to
primary. They remain isolated while the original native acceptance runs finish.

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

Native primary sessions73003 and3245 were still live at this checkpoint. Their
eventual terminal results must be recorded separately before primary integration.
These tests and the build do not prove real calibration, quota freshness, account
commissioning, accepted engineering work or production deployment.

## Operational path

Use the existing [pool migration procedure](../../docs/RESOURCE-POOLS.md) and
quota-scope access API; no new scheduler is needed. Resolve collector custody,
preserve the ledger through additive migration, merge the General exclusion using
a fresh policy revision, verify the unchanged75%ceiling, and only then consider
releasing the whole-account pause. Personal General must remain reserved. Fresh
exact-scope quota evidence and resolution of the existing global stop are still
required before commissioning eligible work. Nothing here changes live policy.
