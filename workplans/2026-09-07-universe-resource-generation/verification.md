# Verification record

Record exact source, independent review, tests, candidate/evaluation outcomes,
provider versus fixture execution, installed acceptance and publication here.

## Local source verification

- Selected Universe/resource backend regression: 2,467 tests in 79 files passed.
- Resource transport regression: 49 tests in one file also passed separately;
  final JSON inspection confirms these were already included in the broad run.
- Web regression: 468 tests in 44 files passed.
- Total selected regression: 2,935 distinct tests in 123 files, all passed,
  plus the 49-test transport rerun (2,984 executions across these reports).
- Full core/web typecheck passed; full lint had zero errors and 105 existing
  warnings. Real-I/O lane membership and Git whitespace checks passed.
- Documentation audit: 8 entrypoints, 64 local links, 28 source links,
  27 external links checked without external requests; zero errors.
- Parallel independent review found and resolved post-generation timeout/cancel
  evidence loss and campaign deadline precedence during resource handoff.
- Native integration tests use inert fixture workers; they do not prove live
  account activation. No provider calls were made during source verification.

## Installed acceptance and publication

Pending clean-source build and offline installation. Exact artifact hashes,
bounded actual local-model outcomes, browser acceptance, and publication state
will be recorded outside source in the release evidence directory so verification
does not invalidate the clean source identity embedded in the package.

Evidence directory:
`/Users/masonwyatt/.codex/artifacts/ashlr-universe-resource.1IdOzm`.

The prepared local calibration permits at most two Qwen generation calls against
57 fixed checks and confined validation of any locally delivered bytes. It does
not authorize downloads, subscription switching, resident service activation,
npm publication, or GitHub Actions.
