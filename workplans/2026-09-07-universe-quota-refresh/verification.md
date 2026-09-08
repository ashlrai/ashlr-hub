# Verification

## Source verification

Development root: `/Users/masonwyatt/.codex/worktrees/ashlr-hub/ashlr-universe-kernel`.
Branch: `codex/universe-quota-refresh`, based on merged PR372
`22d8b6e2d5a38773a5fea9ed4de5b2272dd50c1d`.

- Focused generation/CLI: 191 tests across four files passed.
- One-pass/recurring/console: final 93 tests across three files passed.
- Shared lease/server: 69 tests across two files passed.
- New inert native integration: 13 tests passed.
- These focused counts overlap; do not sum them into a distinct-test total.
- Broad resource/campaign/portfolio run: 1,693 of 1,694 passed across 45 files;
  the one failure used the old clock fixture before its correction. A final
  isolated run passed all 31 one-pass tests. Latest per-file results therefore
  cover 1,697 distinct passing tests; no production change was needed for that
  fixture correction. A frozen-source broad rerun is the final packaging gate.
- Core and web TypeScript passed. Full lint: zero errors, 105 preexisting warnings.
- Real-IO classification: 180 files, 631 unit files, no unclassified markers;
  preexisting m11 stream-file-sink soft signal remains.
- Documentation: eight entrypoints, 69 local links, 28 source links, 27 external
  links, zero external requests and zero errors. `git diff --check` passed.
- Independent implementation and installed-harness reviews found no blockers.

## Corrections during verification

Preserved the existing operator-reconciliation diagnostic after two old server
assertions detected wording drift. Restructured cleanup error precedence to
remove a no-unsafe-finally lint error without suppressing it. Corrected a test
clock fixture that could produce a capture older than the actual attempt.

## Exact artifact acceptance

Pending build from a clean committed revision, followed by one-use installed CLI
acceptance. Evidence directory:
`/Users/masonwyatt/.codex/artifacts/ashlr-universe-quota.zs1g4B`.
The standalone harness uses an inert dual-mode native wrapper, stale observations,
one fixed evaluator, actual installed CLI run/rerun, and before/after inventories.
It never selects an installed Codex CLI or reads credentials.

## Remaining boundaries

No live model/account calls, observation-file rewriting, account changes,
credential/global-configuration reads, registry publication, or resident activation.
No capacity queue or shared long-lived campaign collector. Parallel collectors
sharing one root refuse rather than wait. New metadata captures have no separate
persisted Universe metrics yet. Source/offline acceptance is not 24/7 qualification.
GitHub Actions was verified disabled before publication. Entire is enabled in
manual-commit mode; branch resume had no prior checkpoint.
