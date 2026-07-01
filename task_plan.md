# Task Plan: Ashlr Autonomous Fleet Ambition Push

## Goal
Identify and execute the highest-leverage work that makes Ashlr Hub and its surrounding tool ecosystem more useful as a 24/7 autonomous self-improving engineering fleet.

## Phases
- [x] Phase 1: Confirm repo/GitHub/session state
- [x] Phase 2: Parallel multi-agent ecosystem audit
- [x] Phase 3: Synthesize an ambitious product/architecture roadmap
- [x] Phase 4: Execute high-leverage improvements now
- [x] Phase 5: Verify, commit, push, and leave resumable next steps
- [x] Follow-up: Implement same-machine daemon singleton lock
- [x] Follow-up: Fix Mission Control auto-merge visibility and GPT-5/Codex judge attestation signing
- [x] Follow-up: Final verification and push singleton hardening
- [x] Follow-up: Add shared queue lease renewal and dry-run claim release
- [x] Follow-up: Verify and push next functionality hardening batch

## Key Questions
1. What prevents Ashlr Hub from acting as a reliable always-on engineering fleet today?
2. Which surrounding Ashlr repos are key infrastructure versus abandoned experiments?
3. What should be built into Mission Control so the system feels operationally useful every day?
4. What risks would make 24/7 autonomy dangerous, expensive, noisy, or untrustworthy?
5. What can be improved immediately in this repo without destabilizing the pushed baseline?

## Decisions Made
- Use multiple agents because the user explicitly asked for broad parallel exploration and maximum ambition.
- Keep current hub `master` clean and synced as baseline; new work should be incremental and verified before pushing.
- Audit the ecosystem from local repos first, then use GitHub/official docs only where current external state matters.
- Bound the CI/publish test gate with a hermetic wrapper instead of letting leaked handles freeze autonomous delivery indefinitely.
- Land small operational patches now: service restart delay and inbox review fields.
- Land daemon singleton hardening now: exclusive lock, heartbeat, stale dead-owner takeover, token-checked release, and state temp-file collision reduction.
- Defer major Vitest 2 -> 4 / Vite 8 dependency migration to a separate focused branch because it is a major test-runner upgrade.

## Errors Encountered
- Entire is not set up for this repo; `entire resume master` has no checkpoint.
- Full serial Vitest can hang after many tests with one worker alive; mitigated with `scripts/test-ci.mjs` watchdog for CI/publish gates.

## Agent Findings From Follow-Up Audit
- Shared queue leases are not renewed during long runs; dry-run shared claims should release immediately.
- Concurrent dispatch plans currently do not force the assigned backend all the way through execution.
- `resource-pause:` decisions need daemon-level skip handling beside `throttled:` and `budget-pause:`.
- Codex/GPT-5 judge attestation should use one shared frontier-judge predicate in auto-merge and inline merge paths.
- Mission Control's auto-merge feed should include `inbox:auto-merge` audit events, not only `merge.*` actions.
- Current pass agents: shared queue renewal, concurrent dispatch assignment, Mission Control pause/resume, and Vite/Vitest dependency migration are running in parallel.
- Current pass landed shared queue lease renewal, dry-run claim release, concurrent-dispatch backend assignment enforcement, `resource-pause:` skip handling, and CI isolation hardening for leaked `ASHLR_HOME`/date/auth assumptions.

## Status
**Current batch complete** - Verified locally and ready to push. Highest-leverage next lanes are spend/state fail-closed writes, Mission Control pause/resume controls, and a focused Vitest/Vite dependency migration.
