# Ashlr Hub Production Autonomy Handoff

This document will record exact merged SHAs, release artifacts, production verification, runtime state, rollback evidence, and any authority gates intentionally left closed.

## Quota Authority Merge
- PR: https://github.com/ashlrai/ashlr-hub/pull/310
- Merge SHA: `99adb0dc2b7445f11a4eb7bbfe3ca70cc511b0c3`
- Parents: `80d49d718d893d0cb02f85a62cd9d2691f4f39c3`, `17835bb86703a459c8be56b80f8baa6721c3ab1b`
- Merge tree equals reviewed PR-head tree.
- Exact-master CI: run `31970330630`, all 9 native jobs terminal success.
- Exact-master CodeQL: run `31970330178`, Actions, JavaScript/TypeScript, and Rust terminal success.
- Dependency audit was path-filtered from the master push; the identical PR-head tree's dependency audit passed.
- Release boundary: source is production-master, but npm/GitHub release is intentionally held. Immutable `v3.2.6` points to the prior `80d49d7` tree, npm `candidate=3.2.6`, and `latest=3.0.1`; the merged quota change requires a fresh successor release lane.

## Operator Briefing Source Lane
- PR: https://github.com/ashlrai/ashlr-hub/pull/311
- Exact head: `f9440cc8bcf6c87f95ed424c43b989a18029434a`
- Base: `99adb0dc2b7445f11a4eb7bbfe3ca70cc511b0c3`
- Scope: `src/tui/app.ts`, `src/tui/render.ts`, `test/m13.render.test.ts`, `test/m13.tui-once.test.ts`
- Local gates: focused tests, full dashboard isolated rerun, typecheck, scoped lint, build, and diff-check passed.
- Two independent hostile reviews found no remaining P0-P3 issues.
- Hosted PR verification: running.
