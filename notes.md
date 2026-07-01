# Notes: Ashlr Hub Productivity Push

## Current State
- Branch: `master`
- Entire: no checkpoint found for `master`
- Untracked files observed:
  - `.m262-wip/`
  - `src/core/comms/fleet-pulse.ts`
- `src/core/web/visibility.ts`
- `test/m262.visibility.test.ts`
- `test/m297.retry-transient-abort.test.ts`
- Planning/report files added this session:
  - `task_plan.md`
  - `notes.md`
  - `ashlr_hub_functionality_report.md`

## Research Log
- Initial scan started 2026-06-30.

## Synthesized Findings
- Ashlr Hub's highest-leverage workflow is Mission Control / `ashlr loop` / inbox: autonomous work should be visible, recoverable, and proposal-gated.
- M262 was partially implemented but not wired into `DashboardSnapshot`; visibility is now built as part of `buildSnapshot`.
- M297 tests described a useful retry behavior for `aborted_streaming` / transient network aborts; implementation was absent and is now added.
- Telegram pulse text must match the existing Telegram transport's `parse_mode: HTML`; the pulse builder now emits escaped Telegram HTML.
- Gate hygiene matters for productivity: ESLint previously walked local/generated directories, and invariant tests were not serial despite shared HOME fixtures.
- The Fleet Dashboard had the new visibility data in the backend but no panel; `app.js` now renders an optional Visibility panel using existing panel classes.
- Docs/config drift made Node support ambiguous; package metadata, release workflows, quickstart, and CI test now agree on Node 22.
- Quickstart used the wrong NIM key name; it now points users to `NVIDIA_NIM_API_KEY`.
- M52 macOS sandbox proof previously avoided fake HOME because TMPDIR write reallow came after HOME deny; the profile now allows broad temp writes before denying HOME, then re-allows worktree/vendor dirs.

## Verification Notes
- `npm test -- test/m262.visibility.test.ts test/m297.retry-transient-abort.test.ts`: passed, 50 tests.
- `npm run typecheck`: passed after M262/M297 changes.
- `npm run lint`: passed with pre-existing warnings, 0 errors.
- `npm run test:invariants`: passed serially, 41 files / 409 tests.
- `npm test -- test/m30.ci.test.ts test/m213.dashboard-sse.test.ts test/m262.visibility.test.ts test/m297.retry-transient-abort.test.ts`: passed, 73 tests.
- `npx vitest run test/m52.confine.test.ts test/m52.write-allow.test.ts --no-file-parallelism`: passed, 23 tests.
- Stale-string scan for Node 20 release/doc assertions and `NVIDIA_API_KEY` quickstart drift returned no matches in the checked files.
- Final `npm run typecheck`: passed.
- Final `npm run lint`: passed with 0 errors / 119 pre-existing warnings.
