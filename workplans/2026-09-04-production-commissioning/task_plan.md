# Task Plan: Agent OS production commissioning

## Goal

Ship the current Ashlr Hub Agent OS work through an exact, reviewable source release and commission the strongest safe local autonomous runtime that the available host, trust material, providers, and repository controls can actually support.

## Phases

- [x] Phase 1: Inventory dirty-work ownership, branch/upstream drift, release history, CI, installed artifact, daemon state, providers, credentials, and rollback paths.
- [x] Phase 2: Freeze the production architecture and exact commissioning scope from discovered evidence.
- [ ] Phase 3: Close source, isolation, trust, CI-budget, packaging, and operational blockers. (in progress)
- [ ] Phase 4: Run focused, repository, security, artifact, and real-host acceptance gates.
- [x] Phase 5: Create logically scoped commits and push an exact reviewable branch. (draft PR #332; subsequent hardening commits remain review-only)
- [ ] Phase 6: Merge/release/publish only through verified repository and registry authority.
- [ ] Phase 7: Install the immutable artifact, commission trust and isolation, activate one bounded daemon lane, and verify rollback/degraded behavior.
- [ ] Phase 8: Publish exact production evidence and unresolved external blockers.

## Key Questions

1. Which dirty changes comprise the intended Agent OS release, and which belong to other concurrent work?
2. What is the current protected GitHub release path and npm publication state?
3. Which local isolation backend can satisfy M562b on this host without inventing an enforcement claim?
4. What commissioned key, anchor, provider, and service authority already exists, and what must be provisioned?
5. Can the formal serial test gate finish within a corrected budget without weakening coverage?

## Decisions Made

- Production claims require separate proof for source, pushed branch, merged commit, published artifact, installed artifact, commissioned trust/isolation, daemon state, and live acceptance.
- Preserve all existing dirty work until ownership is mapped; do not stage the whole worktree blindly.
- Use an execution-bound observation-isolation V2 contract and a local-container broker once Docker is healthy. Cloudflare Sandbox remains an evaluated alternative, not an assumed dependency.
- Publish the exact protected-master `3.3.2` bridge before merging the semver-minor Agent OS line; the bridge release's first-parent integrity contract would otherwise fail closed.
- Keep proposal-once and resident-standing runtime authority independent, and leave resident-standing false where the protected-master contract has no such authority.
- No effectful daemon lane activates before fail-closed trust, isolation, rollback, and exact-artifact checks pass.

## Errors Encountered

- `npm whoami` returned `E401 Unauthorized`; direct registry publication is unavailable from this shell unless fresh authority is established or trusted publishing is used.
- Docker Desktop 4.69 is installed and signed, but its engine returns HTTP 503. Logs identify disk exhaustion; the sparse `Docker.raw` consumes about 291 GiB physically. Cleanup is paused until existing Docker-data preservation requirements are known.
- The existing `sandbox-exec` profile is permissive and failed a deny-default Node probe, so it cannot support an enforced-isolation claim.
- The protected `master` bridge is source-complete at `d6c1a5ec`, but npm trusted-publisher verification is paused at the npm security-key touch gate.

## Status

**Phase 3 in progress** — the recovery branch is clean and pushed at `a01fc086`; exact-master draft PR #332 contains the dependency and isolation hardening plus the evidence-backed control doctrine. Cross-chunk stream redaction, authenticated scorecard time binding, final exact-SHA gates, bridge publication, and runtime commissioning remain open. Production remains intentionally inactive.
