# Universe console responsiveness follow-up

Universe source landed through PR #352 at `2934bb55a5748d661ca3c8648b3cab5a213b92fb`.
During the final live check, a direct Universe read took 111 ms but HTTP reads
intermittently exceeded five seconds. An independent profile measured the global
dashboard aggregator at 9.1 seconds, including 349 synchronous child-process
calls and substantial synchronous ledger parsing/redaction. Global SSE and the
notification center invoke these unrelated aggregates on every console route.

## Plan

- [x] Diagnose the live event-loop starvation; stop the task-owned preview.
- [x] Move expensive web read projections to one bounded, serial background
  worker per server with shared requests, deadlines, explicit failures, and
  shutdown/mutation invalidation. Keep authentication on the HTTP thread and
  preserve existing response shapes and local CLI behavior.
- [x] Remove the obsolete eight-second notification poll; its queries already
  receive SSE invalidation.
- [x] Independently verify worker lifecycle, unchanged HTTP authority boundaries,
  legacy routes, frontend tests, and actual built-server latency under background
  load. No workflow dispatch, provider activation, or resident daemon changes.
- [x] Build, review, and recheck the live preview.
- [ ] Integrate by normal PR (the GitHub PR and merge commit are authoritative).

The worker isolates computation, not security authority. Existing local read
builders and their metadata probes are unchanged; this is not an untrusted-code
sandbox. The change must not fabricate empty-success snapshots on timeouts.

## Verification on 2026-09-06

- Nine focused HTTP/authentication/cache/build-identity suites: 141 passed.
- Eight existing API/control/Universe suites: 161 passed.
- New transport and HTTP integration suites: 39 passed. Includes 28 independent
  fake-worker tests for bounded serialization, coalescing, invalid input and
  protocol messages, queue deadlines, failure recovery, close, and invalidation.
  HTTP regressions also preserve post-snapshot daemon observation ordering,
  invalidate after non-success authorized mutation attempts, and close the reader
  if the server cannot bind its port.
- Complete console suite: 121 passed across 32 files, including real SSE/cache
  notification refresh and duplicate-event coalescing.
- Full TypeScript checks, production build, changed-file ESLint, lane membership,
  and whitespace checks passed.
- Existing invariant suite rerun: 449 passed, 5 skipped across 41 files. Full
  repository ESLint passed with zero errors and 106 existing warnings.
- Built server with actual default local data: twelve Universe HTTP reads all
  returned healthy HTTP 200 in 93–123 ms while three cold global summaries took
  about 11.5 seconds and also returned HTTP 200. With the authenticated browser's
  SSE and notifications active, four further reads took 114–207 ms. These are
  local observations, not cross-platform performance guarantees.
- Browser login, rendered experiment archive, active notifications, and Refresh
  verified. No dispatch enabled and no persistent service installed.
- Extracted npm tarball executed the real packaged worker and returned its
  bounded run history successfully. This is a local smoke artifact, not an npm
  release.
- Source-development `tsx` worker read passed. Bun 1.3.14 compiled the full
  sidecar and its fixed sibling worker shim; `--version` and actual compiled
  worker proposal/fleet reads passed. The worker retained the same trusted
  build identity as its parent. Two packaging regressions passed (41 combined
  transport/API/packaging tests). This does not certify signed native release
  distribution. Temporary binary fixtures were moved recoverably to Trash.

Reviewed source: `codex/universe-console-responsiveness`, based on the full merge
SHA above, in the isolated `ashlr-universe-kernel` worktree. The implementation
diff was uncommitted while the local tests and temporary artifacts were built;
none of those smoke artifacts is a release artifact. Reviewed paths are the web
read transport, API/server integration, notification hook, Bun build helper,
their tests, and the canonical Universe documentation. No dependency or workflow
changes are part of this follow-up.

The prior synchronous aggregation is still expensive. This change isolates that
cost from the interactive HTTP loop; it does not claim to make all summaries
subsecond or move every legacy endpoint into a worker.
