# Task Plan: Ambitious Ashlr Hub Autonomy Expansion

## Goal
Identify and deliver one high-leverage, independently mergeable improvement that makes Ashlr Hub more autonomous, functional, reliable, and ambitious without interfering with concurrent Claude Code work.

## Phases
- [x] Phase 1: Establish isolated workspace and map concurrent work
- [x] Phase 2: Parallel architecture, product, and safety exploration
- [x] Phase 3: Select and implement a coherent slice
- [x] Phase 4: Test, hostile-review, and document handoff

## Key Questions
1. Which important autonomy capability is incomplete or missing today?
2. Which slice can be implemented independently of Claude Code's active changes?
3. What fail-closed authority and regression tests are required?

## Decisions Made
- Use a dedicated linked worktree and preserve all concurrent branches and dirty files.
- Prefer a complete, reviewable slice over scattered edits across unrelated systems.
- Base the new branch on exact protected `origin/master` `80d49d718d893d0cb02f85a62cd9d2691f4f39c3`.
- Treat the heavily modified `codex/locus-firm-fleet-docs` checkout as Claude-owned and read-only.
- Implement durable, idempotent, fail-closed provider quota reservations as the first slice. It closes an effect-boundary authority gap before any new live autonomy is enabled.
- Preserve the TUI operator briefing and signed one-shot conductor permit as separately scoped follow-ons; do not combine them with the quota authority change.

## Errors Encountered
- `entire resume codex/autonomy-expansion-v1` found no prior checkpoint; the branch is new, so work continues without recovered session state.
- `entire explain --commit 1b636a81` found no historical Entire checkpoint for the original quota-ledger commit; current behavior is being derived from source and tests instead.

## Status
**Source slice complete and merge-ready** - The implementation, migration path, focused/full daemon verification, build checks, CodeQL race repair, independent hostile reviews, and all exact-head hosted gates are green at `17835bb86703a459c8be56b80f8baa6721c3ab1b`. PR #310 is open, clean, and mergeable. Runtime activation remains a separate authority gate.
