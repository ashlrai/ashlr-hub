# Calibration settlement receipt compatibility

## Goal
Use exact durable capture readback after invocation-private evaluator keys are discarded.

## Phases
- [x] Inspect live qualification, existing driver and capture receipt validation.
- [x] Isolate edits from qualification source 18e26e7d (session 24963).
- [x] Replace obsolete activity-journal reinspection with exact receipt and intent readback.
- [x] Run targeted regression: 165 tests across three suites passed.
- [x] Complete static checks and retain delivery evidence.

## Constraints
No provider calls, account changes, stop changes, service activation or publication. Existing delegated agents remain quota-exhausted. No independent review claimed. Full native qualification is separate and remains pending.

## Errors
Root task_plan.md and notes.md already existed. An Add File patch replaced them; both were restored byte-for-byte from this worktree's HEAD and git diff confirms no changes. New planning documents live in this unique directory. Entire resume found no checkpoint on the new branch.

## Status
Targeted tests, strict test typecheck, ESLint, Node syntax, documentation, real-I/O lane and diff checks passed. This fix does not itself activate autonomy.
