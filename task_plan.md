# Task Plan: Ashlr Hub Productivity Push

## Goal
Make Ashlr Hub more functional by quickly identifying the highest-leverage broken or incomplete areas, implementing focused fixes, and verifying the repo is healthier than when we started.

## Phases
- [x] Phase 1: Establish current state and session context
- [x] Phase 2: Parallel exploration of architecture, tests, and existing untracked work
- [x] Phase 3: Choose a high-leverage implementation slice
- [x] Phase 4: Execute fixes with focused ownership
- [x] Phase 5: Verify end-to-end and summarize next work
- [x] Phase 6: Continue with frontend visibility, docs/config drift, and M52 sandbox proof hardening

## Key Questions
1. What is Ashlr Hub's intended primary workflow and where is it currently least functional?
2. Are the current untracked files intentional in-progress work, generated scratch files, or abandoned changes?
3. Which failing tests, TODOs, or integration gaps give the best functionality return for one focused coding pass?

## Decisions Made
- Use parallel agents for independent exploration because the user explicitly asked to deploy many agents and maximize Codex throughput.
- Preserve untracked files until inspected; do not revert or overwrite unknown local work.
- Prioritize M262 visibility and M297 transient retry because multiple explorers independently identified them as the highest-leverage functionality gaps.
- Add low-risk gate hygiene from verification exploration: ignore generated/local artifacts in ESLint and run invariant tests serially.
- Wire the new visibility snapshot into the existing Fleet Dashboard panel system instead of introducing new styling primitives.
- Align Node support metadata to Node 22 because README, install script, CI, and release expectations now agree on that floor.
- Fix M52 by reordering macOS SBPL write allows so broad TMPDIR writes cannot override the later HOME write deny.

## Errors Encountered
- `entire resume master`: no checkpoint found for this branch, so there is no prior Entire session to restore.
- Initial M262 test runs leaked to the real decisions ledger; resolved with a visibility test injection seam and `ASHLR_HOME` support in the ledger.
- Initial M297 retry runs did not reach the stub binary because the sandbox test hatch was not forwarded; resolved by forwarding `allowAnyRepo` only when `ASHLR_TEST_ALLOW_ANY_REPO=1`.
- The first docs/config patch missed package-lock context; resolved with narrower hunks.
- The M52 proof had been non-hermetic because fake HOME under TMPDIR exposed an SBPL ordering hole; resolved by moving broad temp write allows before the HOME write deny and re-allowing only intended HOME exceptions afterward.

## Status
**Complete** - M262/M297 functionality landed, Mission Control now has a visibility panel, Node/NIM drift is aligned, M52 sandbox proof is hermetic, and verification passed.
