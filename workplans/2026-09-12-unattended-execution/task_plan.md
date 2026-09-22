# Unattended execution

## Goal

Move the existing prepared-objective pipeline closer to real unattended engineering
delivery, using the current quota-aware runtime and preserving the user's personal
General reservation, account history, deadlines and resource limits.

## Phases

- [x] Verify the prior integration and current worktree; classify prior turn as progress.
- [x] Map automatic admission, execution, succession and recovery with three agents.
- [x] Select one concrete missing execution behavior, if present, and implement it.
- [x] Verify behavior and independent review; retain exact commissioning blockers.

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
passed. Real loopback acceptance handle 80608 completed successfully: 3/3 tests in
315.70 seconds. It proved automatic quota recovery followed by two local deliveries,
accounting and seed continuity, restart identity, and lost-output/source-drift holds.
The clean build at 29f3e055 passed (96245); all nine asset hashes were verified.
The new evaluator identity is 9a051509b3eccea7e562a3b5d525bdc5e1beae1bdfe5bc2f83edad8c8306fe46.
Bridge and fixture bytes changed; prior 25d57874 native qualification does not
qualify this new identity. Full current native qualification and genuine scoring
calibration remain separate next gates, not claims of this increment.

Final read-only runtime sample at 2026-09-12T11:08:34Z: healthy active global stop;
collector pending v1 with legacy-owner-evidence-missing, recovery not attempted.
No live account work, policy changes, activation, push or publication occurred.
See verification.json and delivery.md for bounded completed scope and next work.
