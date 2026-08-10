# Task Plan: Ashlr Autonomous Engineering Team OS

## Goal
Build and verify the highest-leverage coherent slice that makes Ashlr Hub a more autonomous, useful, intuitive engineering team for Ashlr.ai while preserving strict human and system authority boundaries.

## Phases
- [x] Phase 1: Preserve active work and create a clean current worktree
- [x] Phase 2: Map current Hub, Locus, Cortex, live fleet, and agent-work state
- [x] Phase 3: Synthesize the north star, architecture, and collision-free implementation slice
- [x] Phase 4: Implement the selected slice with focused tests
- [x] Phase 5: Run adversarial review and broad verification
- [x] Phase 6: Commit, rebase, push, and publish a durable program brief

## Key Questions
1. Where does the current autonomous loop lose intent, output, trust, or human comprehension?
2. Which capability is absent from `origin/master`, not already owned by another worktree, and valuable every day?
3. How should Hub orchestrate while Locus supplies governed capability and Cortex supplies company knowledge or reasoning?
4. What must remain proposal-only, observation-only, or explicitly human-approved?
5. What objective evidence is required before calling the slice production-ready?

## Decisions Made
- Use a clean worktree based on current `origin/master` because the primary checkout is 539 commits behind and contains five uncommitted agent-owned files.
- Keep initial delegated work read-only until overlap and authority boundaries are mapped.
- Treat source changes, installed daemon state, and production activation as separate evidence gates.
- Adopt an Ecosystem Mission Graph as the missing orchestration primitive: outcome-bearing nodes target exact enrolled repositories and may depend on verified realized completion of upstream nodes.
- V1 has local planning authority only. It may validate and preview an in-memory graph, while an explicit CLI reconciliation may materialize at most one dependency-ready local goal. It cannot persist a graph as a new system of record, dispatch, merge, deploy, publish, grant credentials, enroll repositories, or satisfy human gates.
- Preserve flat strategist-goal compatibility. Graph metadata is additive and bounded; legacy briefings and goal records continue to parse.
- Keep Locus as the identity/credential plane and Cortex as the company intent/accountability plane. Cross-product mission intake is a later fail-closed integration after the local graph contract is proven.
- Outcome contracts describe intent and measurement plans. They never attest that an outcome happened; completion still requires existing verified realized-merge evidence or a separately authorized external receipt.

## Errors Encountered
- Entire.io is not enabled in the primary checkout. An initial `entire resume` was also invoked from the dirty primary checkout after worktree creation and correctly refused because of uncommitted changes; retry from the clean worktree.

## Status
**Complete** - The implementation and independent authority, correctness, and product/accessibility reviews are complete. The branch was rebased without conflict onto current `origin/master` `90a0f6d6`; exact-revision focused tests, invariants, typecheck, build, lint, audit, syntax, and diff checks pass. The earlier repository-wide CI attempt reached its 15-minute hard cap with no failures in the completed modules, so it remains explicitly incomplete. The work is packaged for a draft PR without activating the installed runtime.
