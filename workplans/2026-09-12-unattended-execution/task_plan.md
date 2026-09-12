# Unattended execution

## Goal

Move the existing prepared-objective pipeline closer to real unattended engineering
delivery, using the current quota-aware runtime and preserving the user's personal
General reservation, account history, deadlines and resource limits.

## Phases

- [x] Verify the prior integration and current worktree; classify prior turn as progress.
- [x] Map automatic admission, execution, succession and recovery with three agents.
- [x] Select one concrete missing execution behavior, if present, and implement it.
- [ ] Verify behavior and independent review; retain exact commissioning blockers.

## Constraints

- No live provider work, account policy mutation, stop bypass or ledger replacement.
- No GitHub Actions or remote publication in this local implementation pass.
- Original dirty checkout stays untouched; primary is clean at f4ac1af5.
- Prior native handles are terminal and must not be polled or restarted.
- Reuse the existing automatic queue and campaign machinery; avoid duplicate schedulers.

## Session context

Entire resume found no checkpoint on auto/p00. Prior turn completed local source
integration, native acceptance, account/UI regression and the full primary build.
That was progress, not proof of fleet activation.

## Selected implementation

Automatic prepared-objective admission already exists. The concrete missing
behavior is pre-intent resource eligibility for new successor proposals. A known
quota denial currently leaves a durable intent without an execution receipt and
permanently holds that successor. Before creating a NEW intent, reuse the read-only
pool planner with fresh admission evidence and require an allowed eligible worker.
If none exists, defer to the existing tick with no intent or successor-slot charge.
Do not alter post-intent uncertain-work recovery or atomic final admission.

Builder owns engineering-successor-coordinator.ts and the shared pool-runtime
admission helper; an independent agent owns the coordinator regression suite and
new fresh-admission tests; a third agent reviews quota, race and ownership
semantics. Parent owns documentation, integration and final verification.

Acceptance: repeated unavailable ticks consume no proposal slots or calls; fresh
eligible evidence later produces one proposal and admission within the unchanged
deadline; unrelated eligible workers cannot satisfy the check; changed stop,
pause, expiry or evidence read failure withholds; existing no-replay tests stay.

## Discovery corrections

- An inferred preparation-manager filename does not exist; used the actual
  preparation registry and console owner discovered with rg.
- Broad multi-file output was truncated; subsequent decisions use focused reads.

## Status

Implementation and independent review completed. Preflight and final transaction
share fresh-only admission planning; ordinary status behavior is unchanged.
Coordinator and new preflight tests passed 72/72; final precise-zero helper rerun
passed 24/24. Adjacent admission/account tests passed 253/253, and builtin structural,
registry and lifecycle checks passed 67/67. Types, scoped lint, docs and lane checks
passed. Real loopback acceptance is running at handle 80608; do not infer its result.
Clean build and changed evaluator identity capture follow the implementation commit.
