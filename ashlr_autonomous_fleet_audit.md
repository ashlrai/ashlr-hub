# Ashlr Autonomous Fleet Audit

## Strategic Direction

Ashlr Hub already has the right spine for an autonomous engineering fleet: sandboxed
execution, proposal-first merge gates, visibility, cost controls, and a web control
plane. The next leap is durability and operator usefulness: make every autonomous
loop bounded, observable, restartable, and reviewable from Mission Control.

## Work Completed This Push

- Added `scripts/test-ci.mjs`, a hermetic CI/publish test runner with isolated
  `HOME`/`ASHLR_HOME` and a watchdog timeout.
- Wired `prepublishOnly`, GitHub CI, release verify, docs, and CI metadata tests
  to `npm run test:ci`.
- Decoupled OS service crash restart delay from daemon work interval via
  `restartSec`; launchd/systemd now restart crashes quickly by default.
- Improved inbox proposal detail UX by showing current `riskClass`, verification
  result, and TASTE score.
- Captured multi-agent audit findings into this report and `notes.md`.

## Top Gaps

1. **Daemon singleton durability:** separate `ashlr daemon start` processes can both
   run because the guard is in-process only. Add an O_EXCL PID/heartbeat lock.
2. **Spend persistence fail-closed:** `saveDaemonState()` swallows write failures,
   so stale spend can permit overspend. State writes should report failure and
   dispatch should pause until repaired.
3. **Queue lease renewal:** shared queue claims default to five minutes while
   productive frontier runs can last much longer. Renew leases during dispatch.
4. **Concurrent backend assignment enforcement:** resource slots plan a backend,
   but the task closure can reroute internally. The assigned backend must become
   the actual backend.
5. **Mission Control command surface:** telemetry is strong; control workflows
   need first-class start/stop/pause/resume, setup remediation, inbox lanes, and
   activation checklist.
6. **Shared package adoption:** Hub duplicates config, CLI helpers, cost math,
   MCP envelope logic, and efficiency primitives already present in local Ashlr
   packages.
7. **Dependency alerts:** Vite advisories currently flow through Vitest 2.x; the
   fix is a major Vitest upgrade and should be handled as a focused migration.

## Ranked Next Actions

1. Implement daemon singleton lock with stale-lock takeover and status visibility.
2. Make spend/state persistence fail closed after dispatch-cost commits.
3. Split tests into fast hermetic and slow integration lanes, then use `test:ci`
   as the bounded default for CI/publish.
4. Rebuild Inbox into a ranked review cockpit: ship now, needs review, risky,
   stale, failed verification.
5. Adopt shared packages behind thin adapters: `@ashlr/config`, `@ashlr/cost`,
   `@ashlr/cli-common`, `@ashlr/mcp-kit`.
6. Add `ashlr ecosystem doctor`: package versions, dirty branches, installed CLIs,
   Phantom/Pulse/Plugin/Stack/Webfetch/`ac` visibility.
7. Run a focused Vitest 4 / Vite 8 migration branch to clear Dependabot alerts.
