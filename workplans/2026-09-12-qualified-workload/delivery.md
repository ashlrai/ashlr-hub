# Qualification integration handoff

Qualification is integrated locally as ef80e60d and fd8250e7. The broad autonomy
goal remains active. See [verification](../../artifacts/preparation-qualification-verification.md)
and [bundle identity](../../artifacts/preparation-qualification-bundle.json).

- Native41730 is terminal0:5 cases passed, zero skips,1250.74seconds. Full23
  checks, both same-call qualifications and current/stale controls passed with
  confirmed cleanup. Earlier65147 remains a documented timeout failure.
- Primary rebuild exactly matches all nine runtime files, manifest, Node/native
  pins, target, launch semantics and three host/test sources. Rebuilt regression
  gate5675 passed589 tests/17files/zero skips/40.95seconds.
- Selected legacy installed gate63790 is terminal0:13 passed,2 intentionally
  excluded,59.80seconds. Two-run repeatability and full-success post-settlement
  drift were not rerun; do not claim all-suite verification.
- Build, source/web types, documentation/lane checks and package dry run passed.
  Full lint passed with107 existing warnings, zero errors.
  No provider/account/stop-switch changes, activation or publication occurred.

## Next dependency: scoring

`/Users/masonwyatt/.codex/worktrees/ashlr-hub/firm-scoring`, branch
`codex/preparation-scoring-runtime`, checkpoint21343f3b contains the separately
reviewed source-only shared-workload extraction. Its69 focused tests and build
passed, and actual installed import starts no workload. It is not integrated or
natively accepted. Read its `workplans/2026-09-12-installed-scoring/task_plan.md`.

Build the fixed score entry around an immutable nested diagnostic bundle and its
original manifest. Complete closed registry/scoring, whole-inventory checks and
explicit scored-trial worker/evaluation budgets before freezing measurement bytes
for three real matching baselines. Keep original campaign deadlines and separate
diagnostic/scoring authority. Then verify equal baseline, useful improvement and
integrated delivery. Live fleet activation and production remain unproven.
