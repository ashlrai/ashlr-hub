# Notes: Ashlr Autonomous Fleet Ambition Push

## Current State
- Hub repo: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub`
- Branch: `master`
- Remote: `https://github.com/ashlrai/ashlr-hub.git`
- Latest pushed commit: `2f91815 feat: Add fleet visibility panel`
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
- Quick reliability patch shipped: `restartSec` decouples OS service crash restart from daemon work interval. Default crash restart is 30s with a 5s minimum.
- Test/release audit: full serial Vitest can hang from leaked handles or long localhost/SSE probes. `test:ci` wrapper isolates HOME/ASHLR_HOME and kills the process group after a watchdog timeout.
- UX audit: Mission Control has strong telemetry but weak control surfaces. Inbox detail was reading `riskLevel` while proposals expose `riskClass`; patched to show risk, verification, and taste.
- Ecosystem audit: Hub overlaps with `@ashlr/config`, `@ashlr/cli-common`, `@ashlr/cost`, `@ashlr/mcp-kit`, `@ashlr/core-efficiency`, `ashlrcode`, `ashlr-plugin`, `phantom-secrets`, and `ashlr-pulse`. Next strategic lane is shared package adoption behind thin adapters.
- Security/dependency state: GitHub Dependabot alerts are Vite advisories through Vitest 2.x. `npm audit` recommends forced Vitest 4 upgrade; defer to focused migration.

## Verification Log
- `ASHLR_TEST_CI_TIMEOUT_MS=120000 npm run test:ci -- test/m30.ci.test.ts test/m33.release-meta.test.ts test/m262.visibility.test.ts test/m297.retry-transient-abort.test.ts`: passed, 63 tests.
- `npm test -- test/m93.daemon-service.test.ts test/m30.ci.test.ts test/m33.release-meta.test.ts`: passed, 58 tests.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run lint`: passed with 0 errors / 119 warnings after fixing the new script.
