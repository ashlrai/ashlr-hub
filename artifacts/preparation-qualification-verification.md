# Installed preparation qualification verification

Date: September 12, 2026. Status: native qualification passed; not a live
autonomy or production-release claim.

Implementation checkout: `firm-qualification`, branch
`codex/preparation-during-call-qualification`, based on
`58b1b0466c14d7deea20d4177b13edd9e7c0b1a1`. Product candidate is checkpointed as
`c1749a1ff19d582619240d3c21c60cc25979b4f8`, with test alignment4607a638. These
are integrated into `auto/p00` as ef80e60d and fd8250e7. The rebuilt identity
matches and focused integration tests passed.
The [observed bundle identity](preparation-qualification-bundle.json) is not a
baseline capture or acceptance receipt; compare it after any integration rebuild.

## Implemented contract

The installed `preparation-measurement-v1` diagnostic now emits the versioned
`preparation-workflows-v2` report. It retains the original fifteen measurement
regions and nineteen checks, then runs fixed runtime-drift and source-drift
qualification pairs against the same selected candidate. Each pair requires a
healthy metadata result, one during-call mutation, semantic refusal, preserved
mutated fixture and confirmed process closure. Full success requires 23 checks.

Qualification counts are separate from the original benchmark vector. Historical
v1 reports remain readable without gaining qualification claims. Failed/partial
v2 evidence and mixed workload versions cannot become comparable passing data.

## Verification so far

- Rebuilt integration: **589 tests /17files /zero skips /40.95seconds**.
  Selected existing installed controls: **13 passed /2 intentionally excluded
  /59.80seconds**, including actual manager poisoning, cancellation after native
  candidate registration, prelaunch identity drift and deadline refusal. Excluded
  cases are two-run repeatability and full-success post-settlement drift; they are
  not claimed as reverified here. No all-suite green claim is made.
- Package dry run includes all nine installed runtime files plus their manifest:
  6553 total package files,12,707,131 compressed bytes; nothing published.
- The integration build reproduced aggregate
  `474989f5fbce91ae3442ab2519915ec6a9162b06ce9447e0347ec83d537c8f19`.
  All nine runtime files, original manifest, Node/Git/native tool pins, target
  source and fixed launch semantics match. Fixed-evaluator, verify-commands and
  native acceptance source bytes also match the tested qualification checkout.
  This reuses evidence for identical bytes, not a new capture or scoring result.
- Rebuilt source/web typechecks, documentation links and real-I/O lane checks
  passed. Documentation checked116 local/31 source links with zero external
  requests; lane registration found338 real-I/O and698 unit files.
- Final expanded source regression: **589 tests in17 files, zero skipped,
  40.11seconds**. The extra case proves full passing diagnostics cannot become
  scored seed evidence. The older live evaluator suite was also aligned to v2,
  independently reviewed and strict-type/lint checked; its full repeatability and
  post-settlement success scenarios have not been rerun in this increment.
- Coverage includes original campaign deadline precedence, diagnostic/capture/
  fixture budget boundaries, unchanged ordinary worker-trial limits, synthetic
  v1/v2 immutable-journal CLI compatibility and real failed-diagnostic custody.
  Journal fixtures are not baseline captures. Deliberate cleanup failures remain
  observable, and lost evaluator returns retain custody.
- Independent runtime/acceptance and parser/comparison reviews reported no
  concrete blocker. Tests still decide acceptance.
- Whole repository lint: zero errors,107 existing warnings; real-I/O registration
  passed. Documentation link check passed with116 local/31 source links and zero
  external requests. A further20-case seed suite passed in19.87seconds, explicitly
  proving that valid full diagnostic output cannot become scored seed evidence.

## Native acceptance

The first five-case gate, session `65147`, is terminal with exit1: four controls
passed (runtime current33,237ms/stale28,310ms; source current184,916ms/stale63,679ms).
The full case failed after908,569ms with `timedOut:true`, a899,969ms runner timeout
and a retained termination-authority diagnostic, despite confirmed group exit.
Total suite1219.98seconds. It remains a failed gate.

After that terminal result, the product gained an explicit1800000ms ceiling for
closed diagnostic capture. Campaign seed invocation retains its original deadline
clamp but refuses diagnostic output as scored evidence (`evaluator-invalid-result`);
this is not accepted seed measurement. Ordinary worker-trial and command evaluator
ceilings stay900000ms. Fixture setup and capture records honor the longer original
deadline; individual sessions/tools and campaign deadline precedence are unchanged.
Boundary tests and rebuild passed. Failure output now emits sanitized transport,
check-count and checkpoint information before assertions.

A fresh five-case gate started08:01:03UTC in session `41730` and finished with
exit0: **5 passed, zero skipped,1250.74seconds**. No active invocation was extended.
The full installed v2 workload passed all23 checks with15 benchmark regions,
4828 benchmark processes and both qualification pairs. The evaluator returned
code0, no stderr/error/timeout/cancellation/truncation and confirmed group exit;
the test independently verified every recorded group absent. Evaluation elapsed
928591ms (full test934383ms). Report SHA-256:
`2d88050128e908dff438f368d7214815ad870f4c6131bc97407b34eb11022230`.

Current/stale runtime controls passed in33108/28207ms; current/stale source
controls passed in189387/64486ms. Runtime qualification recorded222 processes,
4 blob processes and one mutation. Source qualification recorded1518 processes,
13 blob processes and one mutation. These extra counts do not enter the original
15-region benchmark. This hermetic acceptance is not a retained baseline capture.

## Remaining autonomy dependency

A successful qualification gate is not installed optimization scoring. Finish the
closed scoring route and reusable workload/finalization split before freezing the
measurement bundle for three genuine baseline captures. Calibration must pin that
frozen measurement identity; a separate scoring identity pins its own entry and
calibration data, avoiding a self-referential digest. Source/native identities,
target-only scope and all fifteen regional nonregression checks remain required.

No account policy, provider use, stop-switch override, resident service activation,
GitHub Actions, public deployment or package publication was performed here.
