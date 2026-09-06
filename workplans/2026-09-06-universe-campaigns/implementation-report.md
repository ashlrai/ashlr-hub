# Universe campaign implementation evidence

Verification snapshot: 2026-09-06 22:51 UTC. This is a tested working-tree
implementation, not a production-release or accepted-product-value statement.

## Source and scope

- Repository: `/Users/masonwyatt/.codex/worktrees/ashlr-hub/ashlr-universe-kernel`.
- Branch: `codex/universe-campaigns`.
- Base HEAD: `18fb49abe91ef0e8ae59d8c8267cb3e96fb3a54e`.
- Campaign changes are uncommitted at this snapshot; an exact integration/release
  SHA is pending. Reverify that SHA before claiming released behavior.
- Reviewed: campaign ownership and record projection, feedback and evidence-size
  contracts, CLI, read-only console/API privacy, native fixture acceptance, and
  [local-model-campaign.mjs](local-model-campaign.mjs).

The implementation adds successive generations under one immutable campaign
budget, durable pre-dispatch request reservations, explicit pause/stop/resume,
original-deadline recovery, and bounded feedback from verified prior attempts.
It continues after a passing candidate. Only measured archive admissions and
strict improvements count as progress; completion of an invocation is not
acceptance of a project.

The CLI and console expose the same campaign history. The console remains
read-only, including during gaps between generations. Evaluator diagnostic
messages and locations are omitted from web responses; codes remain visible.
The [canonical guide](../../docs/ASHLR-UNIVERSE.md) documents operation, incomplete
token accounting, and the new writer evidence-size policy without changing
legacy record readability or existing store ceilings.

## Verified local campaign

Persisted records were independently reread through the current SDK; both the
campaign and Universe report healthy evidence.

| Observation | Result |
| --- | --- |
| Campaign | `campaign-calendar-94544f09` |
| Local model configuration | `qwen3-coder:30b`, loopback OpenAI-compatible endpoint |
| Execution interval | 2026-09-06 22:47:05.929–22:48:06.806 UTC; 60.877 seconds |
| Generations / started model requests | 3 / 3 |
| Reported generation tokens | 9,580; accounting complete |
| Fixed evaluator, each generation | 5,236 / 5,236 checks passed |
| Archive result | One initial admission; two byte-identical ties; zero strict improvements |
| Terminal reason | Campaign generation budget exhausted |

The evaluator covered 5,194 date cases, 40 other-export checks, and two source
invariants. All three artifacts share digest
`4c318f90dee6a7f0c84ce8fb8a7fd75c725c4a7c904c8b16317b119ca72140aa`.
Generations two and three retain the first elite as parent and record bounded
feedback provenance. Their unchanged bytes and zero score delta are not new
improvements.

This replay uses the existing utility benchmark and does not edit Hub source.
It demonstrates actual local-model generation, evaluation, feedback, durable
selection, and bounded stopping. It is not a new production fix or evidence that
the broader Universe product is complete. The script registers a new experiment
and contacts the configured local model if explicitly run; it was inspected and
syntax-checked, not rerun during this documentation review.

## Local verification

Counts are snapshots of separate checks and must not be added as unique tests.

| Check | Verified result |
| --- | --- |
| Universe regression suite, integration-owner run | 215 passed |
| Native campaign fixture integration, integration-owner run | 9 passed |
| Final combined native/replay integration | 4 files; 48 passed (9 campaign, 10 model, 14 core, 15 replay) |
| CLI tests for Universe and campaigns | 52 passed |
| Authenticated Universe API tests | 8 passed |
| Full web suite (`npm run test:web`) | 33 files, 186 tests passed |
| Invariants (`npm run test:invariants`) | 41 files; 449 passed, 5 existing skips |
| Durable feedback replay and evidence-size checks | 15 passed |
| Typecheck, production build, full lint | Passed; 0 lint errors, 106 existing warnings |
| Focused lint, script syntax, whitespace checks | Passed |

Native fixture acceptance covers feedback after rejection, continued search,
stagnation, request reservation limits, incomplete usage, observed token cutoff,
pause/resume without refunds, execution exclusion, deadline preservation, and
exact finished-run recovery without replay. No GitHub Actions were used.

The old core concurrency assertion was updated for the shared execution-owner
message, with guaranteed cancellation in teardown. An initially subsecond
deadline fixture was load-sensitive: setup could exhaust the deadline before
the test's HTTP request began. The final fixture performs real native pause and
then advances the observed wall clock past the persisted deadline to test
resume deterministically. These initial failures are not hidden as passes.
The corrected combined native/replay rerun passed all 48 tests in 99.72 seconds.

The rebuilt read-only console at `http://127.0.0.1:56322/next#/universe` was
authenticated and visually inspected. It shows the real campaign's three steps,
9,580-token total, one admission, zero improvements, and correct generation-two
details after selecting its campaign link. No UI control dispatched work.

## Handoff limits

Update this report with the exact committed integration SHA and its final local
verification before release. This snapshot does not establish a rebuilt live
preview, production deployment, a resident service, subscription-account
orchestration, multi-repository delivery, or customer acceptance. No legacy fleet
daemon was reactivated by this lane, and no additional model calls were made
during the independent documentation review.
