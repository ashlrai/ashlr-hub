# Notes: Ashlr Autonomous Fleet Ambition Push

## Current State
- Hub repo: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub`
- Branch: `master`
- Remote: `https://github.com/ashlrai/ashlr-hub.git`
- Latest pushed commit before this follow-up: `12431bd fix: Harden autonomous fleet operations`
- Working tree at start of this push: clean and synced to `origin/master`
- Entire: not set up; no checkpoint found for `master`

## Local Ashlr Ecosystem Candidates
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-auth`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cli-common`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-config`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cost`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-mcp-kit`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-md`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-plugin`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-pulse`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-workbench`
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlrcode`
- `/Users/masonwyatt/Desktop/github/dev-tools/phantom-secrets`
- `/Users/masonwyatt/Desktop/github/dev-tools/prompt-trackr`
- `/Users/masonwyatt/Desktop/github/dev-tools/stack`
- `/Users/masonwyatt/Desktop/github/dev-tools/webfetch`

## Findings
- Reliability audit: biggest 24/7 risks are cross-process daemon singleton locking, fail-closed spend persistence, queue lease renewal for long frontier runs, hard enforcement of concurrent-dispatch backend assignments, fail-closed resource-control mode, and better fatal sidecar observability.
- Follow-up reliability patch: added a same-machine daemon singleton lock (`~/.ashlr/daemon.lock`) with token-checked release, heartbeat, dead-owner stale takeover, and `runDaemon` refusal before ticking when another process owns the lock.
- State persistence hardening: daemon saves now use unique temp files instead of one shared `daemon.json.tmp`, and `lastPulseExportAt` survives load/save cycles.
- Auto-merge effectiveness patch: Mission Control now surfaces successful `inbox:auto-merge` audit events, and auto-merge/inline merge judge signing now uses the shared GPT-5/Codex-aware frontier predicate instead of Claude-only checks.
- Quick reliability patch shipped: `restartSec` decouples OS service crash restart from daemon work interval. Default crash restart is 30s with a 5s minimum.
- Test/release audit: full serial Vitest can hang from leaked handles or long localhost/SSE probes. `test:ci` wrapper isolates HOME/ASHLR_HOME and kills the process group after a watchdog timeout.
- UX audit: Mission Control has strong telemetry but weak control surfaces. Inbox detail was reading `riskLevel` while proposals expose `riskClass`; patched to show risk, verification, and taste.
- Ecosystem audit: Hub overlaps with `@ashlr/config`, `@ashlr/cli-common`, `@ashlr/cost`, `@ashlr/mcp-kit`, `@ashlr/core-efficiency`, `ashlrcode`, `ashlr-plugin`, `phantom-secrets`, and `ashlr-pulse`. Next strategic lane is shared package adoption behind thin adapters.
- Security/dependency state: GitHub Dependabot alerts are Vite advisories through Vitest 2.x. `npm audit` recommends forced Vitest 4 upgrade; defer to focused migration.
- Shared queue hardening: long daemon dispatches now renew shared queue leases for the current machine, dry-runs release shared claims before returning, and atomic shared queue writes use unique temp files.
- Concurrent dispatch hardening: assigned resource-control backends now flow into actual execution instead of being rerouted inside the task closure; `throttled:`, `resource-pause:`, and `budget-pause:` decisions skip cleanly with audit coverage.
- CI isolation hardening: stale failures came from leaked `ASHLR_HOME`, fixed-date reflect seeds, learned-routing test contamination, and a stale secret-leak expectation around intentionally passed engine auth. The affected tests now isolate `ASHLR_HOME`, use relative dates, construct stable score fixtures, and allowlist engine auth passthrough only where intended.
- Operator control patch: Mission Control, Fleet, and Fleet Dashboard now include pause/resume controls backed by token-gated `/api/fleet/pause` and `/api/fleet/resume` endpoints. The endpoints stay hidden unless dispatch is enabled, preserve existing kill-switch semantics, and refresh fleet status after each action.
- Dependency security patch: upgraded from Vitest 2 to Vitest 3.2.6 and pinned Vite to 6.4.3 through `overrides`, clearing the Vite/esbuild advisory chain while avoiding the larger Vitest 4/Vite 8 migration.
- Plugin compatibility patch: Vitest 3's module runner can fail to import temporary external `.mjs` plugin entries from macOS `/var` paths, so the plugin registry now falls back to importing a base64 data URL for an existing entry file.
- Agent next lanes: spend persistence should fail closed on malformed or unwritable state; shared queue lease/reclaim health should be visible in Mission Control; daemon dispatches should expose backend assignment/reason traces; and the ecosystem needs a read-only `ashlr ecosystem doctor` inventory command.
- Spend persistence fail-closed patch: daemon state now has strict read/result-save APIs beside the forgiving dashboard APIs. `tick()` refuses before backlog/dispatch when `daemon.json` is malformed, when a spend guard is present, or when the normalized state cannot be saved before spend-capable work. Live ticks arm `daemon.spend-guard.json` before dispatch and only clear it after final spend accounting is strictly saved.
- Daemon loop hardening: `runDaemon()` now refuses start on strict state load/save failure, continuous/batch loop budget checks stop on strict load failure, and stop-state persistence audits failures instead of silently masking them.
- Queue health agent plan: add an additive `FleetStatus.queue.shared` object with active/expired/reclaimable leases, claims by machine, oldest expired age, next lease expiry, worked/cooldown/usage counts, and lock health; render in `/api/fleet`, `/api/control`, CLI fleet status, Mission Control, and Fleet Dashboard.
- Backend trace agent plan: gateway decisions already include reason/trace, but concurrent dispatch and daemon ticks collapse them to aggregates. Add `DaemonTick.dispatches` with item id/title/repo, assigned backend, reason, trace, and attempted/dispatched status; surface in Mission Control logs and Fleet Activity.
- Ecosystem doctor agent plan: add read-only `ashlr ecosystem doctor --json --root --deep` as an inventory command with synthetic sibling-repo tests, using existing `DoctorReport`/tool registry/dependency parser patterns without reusing write-capable doctor checks.

## Verification Log
- `ASHLR_TEST_CI_TIMEOUT_MS=120000 npm run test:ci -- test/m30.ci.test.ts test/m33.release-meta.test.ts test/m262.visibility.test.ts test/m297.retry-transient-abort.test.ts`: passed, 63 tests.
- `npm test -- test/m93.daemon-service.test.ts test/m30.ci.test.ts test/m33.release-meta.test.ts`: passed, 58 tests.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run lint`: passed with 0 errors / 119 warnings after fixing the new script.
- `npm test -- test/m24.state.test.ts test/m201.daemon-loop.test.ts`: passed, 77 tests.
- Follow-up singleton pass: `npm run typecheck`, `npm run build`, `npm run lint`, and `ASHLR_TEST_CI_TIMEOUT_MS=120000 npm run test:ci -- test/m24.state.test.ts test/m201.daemon-loop.test.ts` all passed.
- Follow-up auto-merge pass: `npm test -- test/m197.observability.test.ts` and `npm test -- test/m48.automerge-pass.test.ts test/m126.manager-merge-gate.test.ts` passed.
- Final combined pass: `npm run typecheck`, `npm run build`, `npm run lint`, and `ASHLR_TEST_CI_TIMEOUT_MS=180000 npm run test:ci -- test/m24.state.test.ts test/m201.daemon-loop.test.ts test/m197.observability.test.ts test/m48.automerge-pass.test.ts test/m126.manager-merge-gate.test.ts` passed, 134 tests.
- Shared queue/concurrency pass: `npm test -- test/m111.work-queue.test.ts test/m113.coordinator-wire.test.ts test/m255.concurrent-dispatch.test.ts test/m201.daemon-loop.test.ts test/m116.worker-pool.test.ts` passed, 122 tests.
- Targeted CI hardening pass: `npm run test:ci -- test/m119.quality-metrics.test.ts test/m120.manager.test.ts test/m240.learned-routing.test.ts test/m245.self-improve-integration.test.ts test/m26.cli.test.ts test/m45.foundry.test.ts test/m230.claude-auth-passthrough.test.ts` passed, 139 tests.
- Previous full verification: `npm run typecheck`, `npm run lint`, `npm run build`, and full `npm run test:ci` passed. Full CI result: 395 test files, 8,345 passed tests, 7 skipped.
- Mission Control control patch: `npm test -- test/m299.web-fleet-control.test.ts test/m49.fleet-status.test.ts test/m61.control.test.ts` passed, 33 tests.
- Plugin migration guard: `npm test -- test/m33.plugin-registry.test.ts test/m33.plugin-wiring.test.ts test/m33.plugin-wrappers.test.ts test/m33.plugin-manifest.test.ts` passed, 84 tests.
- Dependency verification: `npm audit` passed with 0 vulnerabilities; `npm ls vitest vite vite-node esbuild --all` resolved to `vitest@3.2.6`, `vite-node@3.2.4`, `vite@6.4.3`, and patched `esbuild`.
- Current full verification: `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:invariants`, and full `npm run test:ci` passed. Full CI result: 396 test files, 8,348 passed tests, 7 skipped.
- Spend fail-closed focused pass: `npm test -- test/m24.state.test.ts test/h3.budget-cap.test.ts` passed, 60 tests.
- Spend fail-closed daemon pass: `npm test -- test/m24.loop.test.ts test/m201.daemon-loop.test.ts test/h1.daemon-gates.test.ts test/h2.kill-race-abort.test.ts` passed, 111 tests.
- Spend fail-closed final gate: `npm run typecheck`, `npm run build`, `npm audit`, `git diff --check`, and `npm run lint` passed. Lint remains at the existing 118-warning baseline with 0 errors.
- Spend fail-closed invariants: `npm run test:invariants` passed, 41 files and 411 tests.
- Spend fail-closed full CI: `npm run test:ci` passed, 396 files and 8,357 passed tests with 7 skipped.
