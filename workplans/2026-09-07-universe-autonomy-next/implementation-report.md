# Implementation report

## Scope

Opt-in model-driven create/replace/delete of declared files, with read-only
context and explicit parent/previous-attempt presence. This extends the existing
local experiment runtime; it does not install services, add subscription
transports, publish npm, or change the real goal-loop parser.

## Integration

- Protocol/replay, confined filesystem execution, and independent acceptance are
  implemented in separate agent-owned lanes; root integrates runner and package.
- Legacy replacement-only configuration, prompt and receipt bytes are preserved.
- New receipts bind file-state context and complete artifact deltas, including
  undeclared changes and executable bits. A model claim alone is not evidence.
- A constant package-owned worker performs data-only operations under macOS
  confinement. Partial failure discards scratch; the batch is not transactional.
- Fixed evaluators, archive selection, budgets, comparison, graph and local Git
  delivery remain the same runtime paths.

## Verification so far

- Installed-package contract harness against source exports: 29/29 passed on
  Node 24.18.0. Includes missing exports, explicit absence, readonly scope overlap,
  SDK/CLI lifecycle and detection of mutated validators. No work/model executed.
- Native source acceptance/review: 19/19 passed. The exact-source parser challenge
  rejects the incomplete helper, accepts the corrected helper at 23/23 checks,
  and treats an identical follow-up as a tie. Private branch delivery and graph
  ancestry are verified. Sixteen deterministic fixture requests; zero real models.
- Protocol/replay plus legacy compatibility: 241/241 passed in eight files.
- Model/filesystem plus legacy/search tests: 122/122 passed, including 45 new
  operation cases and a regression for synchronous verification crossing the
  generation deadline. Usage is retained without claiming successful operations.
- Independent runner admission: 2/2 passed. A mocked successful broker with
  undeclared/mode changes cannot enter evaluation or archive selection.
- Web: 211/211 in 34 files. Invariants: 449 passed, five existing skips, 41 files.
- TypeScript and web TypeScript passed. Full lint: zero errors, 106 existing warnings; final changed
  source/tests lint clean. Git diff whitespace check passed.
- Full Universe/package regression: 1,009/1,009 tests in 44 files, 332.80 seconds.
  Its initial operation suite had 44 cases; the final deadline regression was
  added afterward and separately verified in the 45-case/122-test focused run.
  Clean package and independent exact-tarball acceptance remain pending at this
  source snapshot. Test counts above overlap and must not be added together.

## Independent review

Review identified one concrete deadline gap: synchronous post-worker verification
could finish after the budget before the timeout callback ran. The broker now
checks its monotonic deadline before assigning successful operation evidence.
The regression and final independent review passed. Readonly and whole-artifact
scope are checked again on the frozen snapshot before evaluation.

## Release state

Branch `codex/universe-autonomy-next`, based on merged PR360. Publication and exact
artifact identifiers will be recorded outside the source tree so the inspected
package can retain a clean, immutable source identity. This report does not claim
npm publication or resident activation. GitHub Actions were verified disabled.
Entire is enabled in manual-commit mode; branch resume had no saved checkpoint.
