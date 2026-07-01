# Ashlr Hub Functionality Report

## Completed This Pass

- Wired M262 visibility into the dashboard snapshot so Mission Control consumers can see the resource grid, fleet activity, cost/savings, and Director state.
- Added M297 bounded retry for empty-diff transient external-agent aborts, while preserving partial-diff behavior and refusing to retry stall/timeouts.
- Preserved failed engine stdout so transient markers such as `aborted_streaming` remain visible to retry detection and logs.
- Converted the fleet pulse formatter to Telegram HTML with escaping for dynamic fields.
- Made the decisions ledger support `ASHLR_HOME` for hermetic tests and local state isolation.
- Tightened local quality gates by ignoring generated/runtime directories in ESLint and making invariant tests serial.
- Added a Fleet Dashboard Visibility panel that renders activity, savings, resource availability, and Director posture from `snapshot.visibility`.
- Aligned Node support to Node 22 across package metadata, release workflows, quickstart docs, and the CI contract test.
- Corrected Quickstart NIM authentication docs to use `NVIDIA_NIM_API_KEY`.
- Hardened the M52 macOS sandbox profile so broad TMPDIR write allowances cannot override a HOME write deny, then made the write-allow proof hermetic with fake HOME under TMPDIR.

## Verification

- `npm test -- test/m262.visibility.test.ts test/m297.retry-transient-abort.test.ts` passed.
- `npm run typecheck` passed.
- `npm run lint` passed with warnings only.
- `npm run test:invariants` passed after making the script serial: 41 files / 409 tests.
- `npm test -- test/m30.ci.test.ts test/m213.dashboard-sse.test.ts test/m262.visibility.test.ts test/m297.retry-transient-abort.test.ts` passed: 73 tests.
- `npx vitest run test/m52.confine.test.ts test/m52.write-allow.test.ts --no-file-parallelism` passed: 23 tests.
- Final `npm run typecheck` passed.
- Final `npm run lint` passed with 0 errors / 119 warnings.

## Follow-Up Candidates

- Consider removing the repo-wide lint warning debt next so `npm run lint` becomes a quieter signal.
- Run `npm run build` when generated `dist/` output is acceptable to update/check locally.
