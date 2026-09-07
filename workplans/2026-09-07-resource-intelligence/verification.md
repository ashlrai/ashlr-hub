# Resource intelligence verification

Source branch: `codex/resource-intelligence`, based on merged PR #365 at
`2c81bdc8f2b830850a34b1c6dc2e505cd9d55562`. Final immutable source/artifact identity
is recorded in the external release handoff after local gates.

## Implemented

- Optional versioned monotonic execution measurements and named token scopes.
- Per-worker, per-outcome descriptive statistics and public consistency checks.
- Read-only code-review calibration CLI with pinned local model identity,
  deterministic checks, cancellation, no replay and private report output.
- Measured-performance console with unknown coverage and outcome inspection.
- Accurate browser-observation receipts and tool descriptions.
- Native multi-account commissioning and current Grok integration boundaries.

## Verification layers

Focused tests use private filesystem/loopback fixtures, not subscriptions.
Independent agents reviewed accounting, evaluator expectations, mutable scope,
cancellation, maximum 4 MiB transport footprint and UI semantics. Full typecheck,
web tests and lint were run locally. A separate installed-artifact harness checks
archive identity, HTTP authority, task lifecycle and the actual benchmark CLI.
Exact final counts and results are retained in the handoff; no Actions are used.

Source gates: 836 selected backend/adjacent tests (23 files), 269 web tests
(38 files), 60 release-artifact contract tests (one file); full backend/web
typecheck, scoped lint and lane membership passed. Full lint had no errors and
105 existing warnings. Browser acceptance used the real local calibration ledger:
authentication, completed/failed outcome filtering, worker inspection, expired
readiness, light/dark rendering and 390 px mobile layout. A cramped worker column
was corrected; page width remained 390 px with scrolling contained to the table.
Temporary viewport/theme changes were restored and the test tab was closed.

Three real local calibration runs made 18 bounded requests. Each produced six
completed task receipts, but only two cases fully passed per run. These are real
local-model measurements, not verified accepted repository changes. See notes.
Final independent review caught and fixed overflowing JSON numbers being
canonicalized as null. Four new regressions pass; original real-model reports
predate that numeric-contract fix, with prompts and expected answers unchanged.

## Remaining commissioning

No Codex/Claude account authentication, quota polling, native task execution,
Grok transport, general desktop executor, resident fleet or autonomous accepted
change loop is activated by this increment. No npm publication or global runtime
replacement is implied by a local package. Preserve ledgers for rollback; old
versions may reject new measurement fields. Existing unrelated dependency alerts
and services are not changed.
