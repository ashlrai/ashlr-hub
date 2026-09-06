# Local model candidates: implementation and verification

## Delivered source

Worktree: `/Users/masonwyatt/.codex/worktrees/ashlr-hub/ashlr-universe-kernel`.
Branch: `codex/universe-model-candidates`, based on master
`c3741b6979925c11d35f288841af48e8ba95bab0`.

- Model candidate runtime, durable resource receipts, CLI/console and contracts:
  `3b96d849e4f49b164b3a6c4991b429e0bac4912e`.
- Separately authored chart-date correction and independent regressions:
  `2da861968d44c3329084e570a14efbf149fc2579`.

This is an additive local-model path in the established Hub runtime, not a new
framework. Command variants and legacy evidence still work. The operator selects
a numeric-loopback endpoint/model and existing text-file allowlist; the broker
generates strictly validated replacements. The independently pinned evaluator
determines pass/fail and the existing archive selects measured niche winners.
Source integration is separate from package publication or persistent operation.
The exact-head source integration is tracked in
[PR #354](https://github.com/ashlrai/ashlr-hub/pull/354); its current status is
authoritative rather than this pre-merge verification snapshot.

## Measured behavior

Three real requests to already-installed Ollama models consumed 6,352
transport-reported generation tokens and produced **zero passing candidates**.
Neither changing to the stronger installed model nor adding a critique changed
the fixed evaluator. All failed artifacts remain inspectable; none was promoted
or applied to product source. See `canary-result.md` for exact identities.

The separately authored chart correction passed the same unchanged canary:
5,236/5,236 checks (5,194 date cases, 40 other-export cases and two source
invariants). Its source SHA-256 is
`48c543afb1c19d4464c64159e3147f31cd425456de8997b5f3f5615088bc7324`.
This is a useful source fix, not a successful model-generated canary artifact;
the recorded 6,352 tokens do not measure the surrounding development effort.

## Local verification

- Universe suites: **114 passed / 8 files**, including **43** adapter tests and
  **10** native macOS integration tests with real pinned evaluators and disposable
  HTTP fixtures. Two generations, parent reuse, rejected edits, failed evaluation,
  unknown/zero/overrun usage, cancellation, timeouts, inconsistent totals and
  interrupted-run recovery are exercised.
- Web suite after the chart fix: **176 passed / 33 files**, including **51** chart
  tests and independent Gregorian arithmetic across 6,732 calendar boundaries.
- Existing invariants: **449 passed, 5 existing skips / 41 files**.
- Typecheck, source build and changed-file lint passed. Full lint passed with
  **0 errors, 106 existing warnings**; the real-I/O membership check passed.
- Portable package allowlist focus: **7 passed, 52 intentionally filtered**.
  Actual extracted npm tarball imported the Universe package export independently
  of the checkout, contained new JS/declarations, accepted model manifests and
  read legacy evidence without creating missing roots. That initial smoke package
  correctly reported dirty source and is not a publication artifact.
- Browser inspection confirmed the built console renders old evidence with
  unavailable tokens and the new distinctions between generation, evaluation,
  archive admission and recorded resource coverage.

All tests ran locally. GitHub Actions was verified disabled. No npm publication,
paid API request, credential/account change, model download, provider startup,
or legacy daemon activation was performed. The read-only loopback preview is a
temporary process, not a production desktop release.

## Important limits

- Execution retains the existing macOS-only confinement scope; this is not a VM
  for arbitrary hostile programs, and detached-descendant cleanup is not proven.
- Numeric-loopback routing does not attest a model or prevent its server from
  proxying another service. Model identity is the configured label.
- Only complete transport-reported counters are used. Failed candidates still
  consume resources. Unfinished/interrupted/failed generations withhold aggregate
  totals because an in-flight request can outlive its last durable trial receipt.
  Coverage explicitly describes recorded requests; dollar cost stays unavailable.
- Output budgets are requested from the provider. A fully reported overrun
  rejects admission but cannot undo spend or enforce an unreported limit.
- Codex/Claude subscription orchestration, account pooling, durable request-start
  metering, unattended portfolio scheduling, and public desktop release remain
  separate work. No autonomous business-value or production-completion claim is
  made from this experiment.

Entire resume found no previous branch checkpoint. Entire status was enabled in
manual-commit mode, but `entire explain --commit 3b96d849...` reported no associated
checkpoint or trailer; session capture is not claimed from configuration alone.
The primary checkout and its unrelated workplans were preserved.

At push time, GitHub reported the existing default-branch moderate Dependabot
alert #32. No dependency or workflow files were changed by this work; these
focused checks do not constitute a fresh repository-wide vulnerability audit.
