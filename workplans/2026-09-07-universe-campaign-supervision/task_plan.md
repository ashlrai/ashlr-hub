# Universe bounded campaign supervision

## Goal

Add useful unattended campaign operation on one computer by extending the existing
runtime, with measured outcomes and explicit operational state.

## Phases

- [x] Explore existing execution and control patterns with independent agents.
- [x] Select and implement a bounded supervision contract and CLI.
- [ ] Verify races, cancellation, budgets and actual installed CLI behavior locally.
- [ ] Publish exact verified source and record activation state separately.

## Constraints and decisions

Preserve the original Desktop checkout. No GitHub Actions or account changes.
Reuse established Universe execution and model runtime; no new framework.
No automatic retry of uncertain execution or override of owner controls.
Prefer a foreground supervisor before installing persistent system services.
No declaration that the entire Universe vision is complete from fixture evidence.

## Status

Selected explicit-queue foreground supervision with at most four simultaneous
campaign runners, once per never-started campaign. Waiting on a Universe owner is
read-only and retains initial pins. Resource-withheld is not proof of temporary
contention: automatic resume is deferred until a pre-reservation resource check
can prevent quota denials from burning generation/request reservations.
Two admission prerequisites are included: exact raw-record expectation and durable
explicit owner pause even when a campaign is already operationally paused.
Agents own supervisor core/tests, admission/control fixes, and independent real
integration fixtures. Main owns CLI, exports, docs, packaging and publication.

## Errors

- Early CLI tests/typecheck ran before the parallel supervisor module existed:
  six CLI dispatch/routing failures and unresolved imports. Rerun after the core
  lane publishes its implementation; do not treat missing in-flight files as a
  runtime defect or weaken tests.
- Independent review caught a mislabeled observer-failure test that actually
  exercised caller cancellation. Replaced it and added a real completion-observer
  exception with another worker active and a third queued; cleanup is awaited.
- Initial scoped lint rejected a control-character regular expression. Reused
  the existing character-code validation pattern; scoped and full lint pass.
