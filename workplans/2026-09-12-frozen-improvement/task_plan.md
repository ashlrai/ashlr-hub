# Frozen improvement and native evidence

Base: `3a1429407f2b734468ebb46936be4b53a4056c6a`, clean integration branch `auto/p00`.
Previous turn: progress (implemented, committed and verified recovery/capture).
Overall autonomous-firm goal remains active, not complete.

- [x] Explore successful capture driver, independent scoring contract and existing delivery adapters with three agents.
- [ ] Run one actual full-success capture and retain exact private evidence; serialize all native workloads.
- [x] Repair the prerequisite builtin-trial custody gap in isolated `codex/builtin-trial-custody`; preserve unresolved process evidence and prevent uncertain replay before enabling scoring.
- [x] Independently review, test and document the resulting behavior and unresolved gaps.

Use existing fixed evaluator, immutable capture, archive, campaign and delivery.
Never convert reported checks directly into acceptance. Keep primary evaluator
and generated assets frozen while native capture runs. Parent owns execution and
integration; other agents perform read-only exploration or isolated pure work.
No GitHub Actions, account-policy mutation, provider/model launch or service
activation is part of this measurement packet. Full-success native capture,
frozen reward and actual improved delivery are distinct requirements.

## Status

Three agents completed implementation, runner regressions and independent review.
The frozen source passed 185 combined regressions, source/web typechecking,
strict new-test checking, scoped lint, documentation and test-lane checks. Its
build passed. Final serialized native acceptance passed 19 tests in three files
(23.79s) after correcting test-only cleanup observations; the product
implementation is unchanged. Total focused coverage: 204 tests / ten files.
Local implementation `9d09e2a01cc066a9c7f355fd8c1f99c27cd56d4e` was
integrated as `c78bbea917ec54fadc424679135014670afe5b25`. The primary
rebuild passed; final integration gate 87754 passed all 204 tests in ten files,
zero skips, 25.74s. All native handles are terminal. No activation is claimed.
The final handoff commit and clean build contain no further runtime changes.
The parent-run retained capture stopped during preflight before any evaluator
dispatch: the real global KILL switch is active. It was not cleared or bypassed.
Evidence is retained at `/Users/masonwyatt/.codex/artifacts/ashlr-preparation-full-capture.BvfQ68`.
No full-success capture is claimed. The preflight attempt used the previous
clean `3a142940` build; the custody repair is a separate tested increment.

## Errors

- Capture driver returned `FULL_CAPTURE_NOT_CONFIRMED` at preflight (67 ms);
  a read-only check found KILL `healthy/active/present`. No automatic retry.
- A guessed nested test path did not exist; located actual root-level test files
  with `rg --files`. No source changes or test failures resulted.
- Strict new-test typechecking caught an inferred mock-only callback type; added
  an explicit `() => void` annotation. Strict checking then passed.
- Initial native custody gate: 18 passed / 1 failed. An assertion assumed
  confirmed scratch always disappears, but preexisting cleanup is best-effort
  and installed fixture seeds contain protected directories. Correct the test
  to observe the actual permission failure and prove continued admission; do not
  introduce unsafe recursive chmod or claim storage reclamation is solved.
- The second native gate remained 18 passed / 1 failed because the new test's
  observer tried to spy on a nonconfigurable Node ESM export before dispatch.
  Replace only observation with a transparent call-through module wrapper; keep
  the real removal operation, error and product implementation unchanged.
- The transparent observer measured ENOTEMPTY (native gate 18/1, 21.63s), rather
  than presumed EACCES/EPERM. Include that actual parent-removal error only with
  the existing mandatory owned-nonwritable-descendant proof. Do not infer cause
  from error wording alone or waive the second-generation assertion.
- One documentation patch used a nonexistent context line and made no change;
  reapplied against the actual section heading.
