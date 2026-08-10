# Task Plan: Ashlr Autonomous Team OS V1.1+

## Goal
Extend Ecosystem Mission OS from planning-only graph compilation into a durable, auditable, bounded autonomy loop, while designing truthful governed seams to Ashlr Cortex and Ashlr Locus and preserving all human and production authority boundaries.

## Phases
- [x] Phase 1: Refresh exact Hub/PR/runtime state and map active cross-repository work
- [x] Phase 2: Parallel research on mission receipts, bounded reconciliation, Cortex/Locus seams, and adversarial risks
- [x] Phase 3: Confirm the highest-leverage collision-free implementation slice and acceptance evidence
- [x] Phase 4: Implement durable mission receipts and the selected safe automation/visibility integration
- [x] Phase 5: Run focused, invariant, cross-platform, security, and adversarial verification
- [ ] Phase 6: Rebase, publish protected PRs, observe hosted gates, and record the next executable roadmap (in progress)

## Key Questions
1. What immutable evidence must a mission receipt bind so replayed or stale work can never unlock authority?
2. Which reconciliation step can become automatic without adding dispatch, merge, deployment, publication, credential, or company-truth authority?
3. What existing Cortex and Locus contracts can be consumed without duplicating their identity and accountability ownership?
4. Which active agents or branches already own nearby files and how can this lane avoid collisions?
5. What exact local and hosted evidence is required before advancing beyond shadow mode?

## Decisions Made
- Continue from draft PR #238 and its planning-only authority contract.
- Begin delegated lanes read-only until active ownership and overlap are mapped.
- Treat mission receipt persistence, daemon reconciliation, Cortex intake, Locus evidence, merge, and deployment as separate authority gates.
- Preserve the existing dirty primary Hub checkout and use clean worktrees for implementation.
- Keep PR #238 as the planning kernel; prepare V1.1 as a stacked branch unless Mason directs otherwise.
- Exclude current Locus fleet-gate output from authority evidence; a future adapter must fail closed on a missing, unsealed, expired, frozen, malformed, or unhealthy pin.
- Created stacked branch `codex/mission-receipts-v1` from PR #238's exact head so the planning kernel remains independently reviewable.
- V1.1 automatic reconciliation is shadow-only because a persisted `planning` goal is consumed by the existing scanner and can reach dispatch on a later tick.
- Implement Cortex and Locus integration first as strict pure contracts; live connectors and external mutations remain disabled.
- Contain best-of-N immediately at eight candidates and two internal workers; the separate atomic budget-reservation and capability-eligible scheduler remain the next P0 execution slice.
- Treat protected-master merge, npm publication, GitHub Release creation, public documentation, and the installed daemon as separate production gates with separate evidence.

## Errors Encountered
- The first M497 fixture was rejected as an unreadable briefing because graph metadata omitted required `humanGate` and `outcome` fields; the fixture was corrected to the exact persisted schema.
- The same fixture used macOS's lexical `/var` path while enrollment canonicalized to `/private/var`; it now binds the real path, matching production enrollment semantics.

## Status
**Currently in Phase 6** - Local verification is complete: the combined Mission OS and best-of-N matrix passed 284/284 tests; the invariant suite previously passed 445 with 5 skips; typecheck, build, npm pack dry-run, dependency audit, and diff checks pass; lint has 0 errors and 101 inherited warnings. The full local repository run reached its 15-minute hard cap with no completed failures and is explicitly incomplete. Consolidating the stacked branches and relying on the protected hosted native matrix for merge authority.
