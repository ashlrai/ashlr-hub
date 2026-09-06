# Autonomous Universe campaigns

## Goal

Turn the verified single-generation Universe runtime into a useful, durable
multi-generation workflow that learns from recorded outcomes, respects an
explicit resource envelope, and reports actual progress. Optimize for verified
engineering yield, not agent count, token consumption, or self-declared success.

## Phases

- [x] Inspect source ownership, memory, recent integration and Entire context.
- [x] Explore existing persistence, scheduling, feedback, transport and UI patterns.
- [x] Select a complete campaign contract and independent acceptance criteria.
- [x] Implement separately owned runtime, feedback, CLI/console and test lanes.
- [x] Verify recovery, limits, cancellation and meaningful real behavior locally.
- [ ] Submit exact-head source integration and report deployment limits.

## Decisions and exclusions

- Start from merged master `18fb49abe91ef0e8ae59d8c8267cb3e96fb3a54e` in the
  clean existing Universe worktree, branch `codex/universe-campaigns`.
- Preserve the primary checkout and its unrelated workplans.
- Keep the established non-eve stack and existing private-record/run primitives.
- No GitHub Actions; no implicit cloud-account changes, paid-provider fallback,
  release publication or legacy daemon reactivation.
- A failed candidate remains a failure even when generation or execution completed.

## Questions

- Which existing primitives can own and recover a campaign without a competing daemon?
- How should recorded evaluator outcomes become bounded next-generation feedback?
- How do campaign progress and resource limits stay correct after interruption?

## Status

User selected continued improvement within limits, not stop-on-first-pass.
Implemented an immutable campaign definition, ordered durable pre-dispatch
reservations, shared Universe execution ownership, explicit resume under the
original deadline, evaluator feedback with separately hashed previous attempts,
and read-only campaign console. Independent review fixed crash-intent projection,
feedback policy recovery and a pause acknowledgment race. Native integration
and final source integration verification are in progress. A bounded local
qwen3-coder:30b campaign completed three generations: one passing archive
admission, two identical ties, 9,580 reported tokens. See implementation-report.md.

## Setup notes

Entire resume found no checkpoint for the new branch. The inherited preview is
a temporary read-only process, not an unattended execution service.
