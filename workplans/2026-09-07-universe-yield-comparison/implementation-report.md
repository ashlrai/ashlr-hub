# Implementation report

## Implemented scope

- Read-only paired campaign comparison through the public SDK and strict CLI.
- Exact comparator/configuration/workload checks, campaign-scoped archive progress,
  reported model-token coverage, recorded run duration and separate wall span.
- Explicit bundled-feedback labeling; no causal model ranking, savings estimate,
  accepted-change credit, scheduling change or new execution framework.
- Targeted bounded sampling and independently verified local delivery attribution.
- Native private paired fixtures, independent projection review, reader/CLI tests,
  installed-package smoke and canonical paired-experiment instructions.

## Local verification

- TypeScript and web typecheck passed during implementation.
- Initial installed smoke found a test-only mismatch: overview `sampledAt` changes
  between read-only observations. Fixed the assertion to compare stable evidence,
  retaining the explicit Git-ref and no-execution checks. Rerun passed: 24 tests.
- Web suite passed: 211 tests across 34 files. CLI help/agent registry/JSON suites
  passed: 29 tests across 4 files.
- Full lint passed during implementation: 0 errors and 106 pre-existing warnings.
- Independent review caught mixed feedback treatment, inconsistent projected
  counters and stale positive delivery counts after source drift. These now
  suppress comparative conclusions or verification claims as appropriate;
  historical recorded observations/subtotals remain visible.
- Focused lanes passed before the integrated run: 45 pure core tests, 63 reader/CLI
  tests and 23 native/review tests (5 native, 18 independent projected-evidence
  cases). All are included in the integrated run.
- Invariant suite passed: 449 tests across 41 files, with 5 existing skips.
- Final typecheck and full lint passed after source freeze (0 lint errors;
  106 pre-existing warnings). Real-I/O membership check passed.
- No real model inference or provider requests have been made. Native tests use
  test-owned deterministic loopback responses and private disposable repositories.
- Integrated Universe and installed-smoke suite passed: 882 tests across 38 files
  in 325.25 seconds. JSON evidence is in the task-specific release scratch.
- Exact final source/package identity and independent artifact acceptance will be
  recorded in the post-commit handoff outside the source tree.

## Publication and runtime limits

GitHub Actions was read as disabled during this increment. Source publication is
separate from npm publication, release-policy qualification and resident fleet
activation. No release-policy file, credential, provider account, model service,
daemon or scheduler is changed. Port 56322 had no listener when this turn began;
this source increment does not claim a live refreshed browser console.

The package's existing local-production policy and GitHub-hosted provenance
requirements are not rewritten by a package smoke. This work does not claim that
the complete Universe operating-system vision is finished or released.

The existing medium-severity desktop `glib` Dependabot alert 32 remains open in
`desktop/src-tauri/Cargo.lock`; this TypeScript increment does not modify it.
Entire is enabled in manual-commit mode; branch resume found no saved checkpoint.

## Release-path follow-up

The existing full local gate and canonical v3 receipt validator already provide
local qualification. Reuse them with verified successor-policy bindings; do not
build another gate engine. Its reproducible package mode differs from this
Git-identity development artifact. Local qualification does not require npm login,
but public publication/finalization still expects hosted provenance and needs a
separate local-only path. Current npm authentication was not tested this turn.
