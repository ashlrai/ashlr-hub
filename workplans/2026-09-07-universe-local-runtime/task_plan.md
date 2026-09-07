# Universe local runtime continuation

## Goal

Deliver the next executable capability toward a usable agent-native engineering
runtime, reusing verified package and foreground execution paths.

## Phases

- [x] Check source ownership, recent release and Entire context.
- [x] Explore installation, artifact verification and independent acceptance.
- [x] Select a concrete implementation contract based on reusable patterns.
- [x] Implement parallel lanes and verify end-to-end behavior.
- [ ] Verify exact source/package and complete the source release handoff.

## Current state

Branch `codex/universe-local-runtime` starts from merged PR361,
`08c5d750290c3ed43c32a5256778830b50dca758`. The primary Desktop checkout
and its existing untracked plans remain untouched.

Three agents are exploring installation/launch patterns, release identity and
independent acceptance. Root investigates reusable artifact-handling code.
The strategic choice offered is pinned offline local installation plus explicit
foreground console versus subscription execution; the first is the working
default until the user redirects.

## Boundaries

- No GitHub Actions, provider/model requests or credential/account changes.
- No resident service activation, startup items, global command replacement or
  changes to the existing kill switch merely to test an installer.
- Distinguish exact candidate identity and local execution from production release
  qualification, registry publication and resident activation.
- Preserve source and existing installations; stage and verify before finalizing.
- No framework rewrite or new generic fleet/approval layer.

## Errors / observations

- Entire resume found no checkpoint for the prior or new branch.
- Repository-local AGENTS.md search returned no matches (exit 1); branch setup
  completed successfully before that expected search result.
- First archive/manifest regression invocation used Vitest directly and omitted
  npm_execpath, required by an existing toolchain test: 124 passed, 1 skipped,
  1 invocation-environment failure. Re-running through the pinned npm test script;
  no product code change is warranted by that environment mismatch.
- Double-failure acceptance initially missed a cached filesystem binding. The
  corrected injection removes the actual pending marker then fails finalization
  and restoration; 26/26 independent acceptance now passes with degraded evidence
  preserved. No failing check was waived.

## Status

Implementing pinned offline candidate installation, status, rollback and a
foreground Universe-only launcher. All operations require an explicit runtime
store; operational Universe commands also require an explicit Universe root.
Console isolation is deferred because existing serve/config/GC/API paths touch
default state. This increment does not change those paths.

Root owns bounded archive admission and extraction plus package integration.
Explore owns transactional store, Resource owns CLI, Acceptance owns independent
regressions and installed native acceptance. The tar header parser is reused
from pinned, bundled node-tar 7.5.22; no custom tar-header parser, npm execution,
network access or lifecycle scripts occur in the installer.
