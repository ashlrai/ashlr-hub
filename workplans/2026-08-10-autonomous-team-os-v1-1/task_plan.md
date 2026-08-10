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
- The first hosted V1.1 matrix exposed an incomplete-module-mock integration
  regression: daemon tests replaced the best-of-N runner without exporting its
  new count resolver. The resolver and hard limits now live in a dependency-free
  policy module, while the runner re-exports them for compatibility.
- One local release-contract run exceeded its per-test timeout while competing
  with parallel checks; the exact failed tamper case passed alone in 10.8s.

## Status
**Currently in Phase 6** - The hosted daemon integration defect has been repaired
and the formerly failing daemon suites pass locally (381/381). Mission, source
quality, and Windows lock regressions pass 75/75; policy/CLI hardening adds 32/32
passing checks. Typecheck, scoped lint, build, version/changelog validation,
package-content validation, and diff checks pass. One full release-contract run
had a load-related timeout; its exact failed case passes in isolation. The full
repository suite remains incomplete, so protected hosted native checks remain
merge authority. npm publication remains separately blocked on registry
authentication and must not be inferred from source merge readiness.
