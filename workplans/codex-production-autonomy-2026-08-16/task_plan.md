# Task Plan: Ashlr Hub Production Autonomy Continuation

## Goal
Ship the reviewed quota-authority upgrade, then deliver the exception-first Operator Briefing and a bounded one-shot conductor activation path through protected production gates without colliding with Claude Code or silently expanding resident/provider authority.

## Phases
- [x] Phase 1: Re-establish exact repository, PR, runtime, release, and concurrent-work state
- [x] Phase 2: Merge PR #310 and verify the exact protected-master merge
- [ ] Phase 3: Build and review the Operator Briefing as an independent source slice
- [ ] Phase 4: Build and review the signed one-shot conductor permit as an independent source slice
- [ ] Phase 5: Merge exact green slices and execute release/production verification
- [ ] Phase 6: Prepare or execute resident runtime activation only with exact artifact, permit, rollback, and acceptance evidence

## Key Questions
1. Has protected master or Claude Code's owned work moved since PR #310 became green?
2. What exact public surface constitutes production for the TUI and conductor changes?
3. Which activation inputs and trust roots exist, and which must remain explicitly unprovisioned?

## Decisions Made
- Serialize merge/release authority; parallelize only read-only audits and independent source slices.
- Preserve the dirty Claude Code checkout and use isolated linked worktrees.
- Keep npm `latest`, resident daemon activation, trust-root provisioning, and provider spend as distinct evidence gates.
- Never move or reuse release tags; use the repository's protected successor-version recovery process if a release attempt fails.

## Errors Encountered
- The first PR-topology observation for PR #310 was cancelled because the PR description changed during its snapshot; the automatic replacement completed successfully at the same exact head.

## Status
**Phase 3 in progress** - PR #310 is merged and exact-master CI/CodeQL are terminal green. The Operator Briefing is frozen at exact commit `f9440cc8bcf6c87f95ed424c43b989a18029434a` in PR #311 with two independent hostile-review GOs; hosted checks are running. A separate dormant one-shot conductor implementation is in progress in an isolated worktree.
