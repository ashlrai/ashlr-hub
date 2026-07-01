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
- Added a same-machine daemon singleton lock with heartbeat, dead-owner stale
  takeover, token-checked release, and `runDaemon` refusal before ticking when a
  second process already owns the fleet.
- Hardened daemon state I/O by using unique temp files for atomic saves and
  preserving `lastPulseExportAt` across load/save cycles.
- Fixed auto-merge operator visibility by including successful
  `inbox:auto-merge` audit events in Mission Control's recent merge feed.
- Fixed GPT-5/Codex frontier judge signing by reusing the shared
  `isFrontierJudge` predicate in both daemon auto-merge and inline merge paths.
- Hardened shared queue dispatch by renewing same-machine leases during long
  runs, releasing shared claims during dry-runs, and giving shared queue writes
  unique temp files.
- Hardened concurrent dispatch so resource-control backend assignments are the
  backends that actually run, with explicit skip handling for throttled,
  resource-pause, and budget-pause decisions.
- Hardened CI isolation around `ASHLR_HOME`, drifting fixed-date tests,
  learned-routing fixtures, and intentional Claude engine auth passthrough.
- Added token-gated fleet pause/resume APIs and wired Mission Control, Fleet, and
  Fleet Dashboard controls to the existing kill switch.
- Cleared the Vite/esbuild dependency advisory chain with a conservative
  Vitest 3.2.6 migration plus a Vite 6.4.3 override.
- Added a plugin-registry import fallback for Vitest 3's module runner so
  external temporary `.mjs` plugin entries continue to load in tests.
- Hardened spend persistence fail-closed behavior with strict daemon state reads,
  result-returning state saves, a durable spend-commit guard, and daemon loop
  refusal when the spend ledger is malformed, unwritable, or has unresolved
  accounting.
- Captured multi-agent audit findings into this report and `notes.md`.

## Top Gaps

1. **Queue lease renewal follow-through:** lease renewal is now implemented.
   Next improvement is surfacing renewal health and reclaim metrics in Mission
   Control.
2. **Concurrent backend assignment enforcement:** implemented for daemon
   execution. Next improvement is making backend assignment decisions visible in
   operator-facing timelines.
3. **Mission Control command surface:** pause/resume is now live; remaining
   control workflows need first-class start/stop, setup remediation, inbox lanes,
   and activation checklist.
4. **Shared package adoption:** Hub duplicates config, CLI helpers, cost math,
   MCP envelope logic, and efficiency primitives already present in local Ashlr
   packages.
5. **Dependency migration follow-through:** current `npm audit` is clean after a
   conservative Vitest 3/Vite 6 migration. Future Vitest 4 cleanup should first
   remove the remaining Vitest 3 deprecation warnings.
6. **State repair UX:** fail-closed spend guards are now protective, but operators
   need a clear doctor/remediation path to inspect and intentionally clear or
   repair blocked ledger state.

## Ranked Next Actions

1. Surface shared queue lease renewal/reclaim metrics in Mission Control.
2. Add first-class backend assignment/reason traces to Mission Control timelines.
3. Add state repair/doctor UX for malformed daemon ledgers and unresolved spend
   guards.
4. Split tests into fast hermetic and slow integration lanes, then use `test:ci`
   as the bounded default for CI/publish.
5. Rebuild Inbox into a ranked review cockpit: ship now, needs review, risky,
   stale, failed verification.
6. Adopt shared packages behind thin adapters: `@ashlr/config`, `@ashlr/cost`,
   `@ashlr/cli-common`, `@ashlr/mcp-kit`.
7. Add `ashlr ecosystem doctor`: package versions, dirty branches, installed CLIs,
   Phantom/Pulse/Plugin/Stack/Webfetch/`ac` visibility.
8. Remove Vitest 3 deprecation warnings, then consider a focused Vitest 4 /
   Vite 8 migration branch when the ecosystem is ready.
