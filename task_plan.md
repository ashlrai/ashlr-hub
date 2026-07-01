# Task Plan: Ashlr Autonomous Fleet Ambition Push

## Goal
Identify and execute the highest-leverage work that makes Ashlr Hub and its surrounding tool ecosystem more useful as a 24/7 autonomous self-improving engineering fleet.

## Phases
- [x] Phase 1: Confirm repo/GitHub/session state
- [x] Phase 2: Parallel multi-agent ecosystem audit
- [x] Phase 3: Synthesize an ambitious product/architecture roadmap
- [x] Phase 4: Execute high-leverage improvements now
- [ ] Phase 5: Verify, commit, push, and leave resumable next steps

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
- Defer major Vitest 2 -> 4 / Vite 8 dependency migration to a separate focused branch because it is a major test-runner upgrade.

## Errors Encountered
- Entire is not set up for this repo; `entire resume master` has no checkpoint.
- Full serial Vitest can hang after many tests with one worker alive; mitigated with `scripts/test-ci.mjs` watchdog for CI/publish gates.

## Status
**Currently in Phase 5** - Verifying the shipped gate/service/inbox improvements and preparing a pushed commit.
