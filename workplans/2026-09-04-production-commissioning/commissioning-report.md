# Agent OS production commissioning report

Status: protected integration review active; production not yet commissioned.

This report will distinguish source completion, pushed review branch, merge, registry publication, immutable local installation, commissioned trust/isolation, daemon activation, and live acceptance.

## Verified state

- Protected `origin/master` is `d6c1a5ec3626f715018a8ffb929906ac0f52f5c9`, the exact prepared `3.3.2` bridge source.
- The recovered Agent OS development line is clean and pushed to `origin/codex/v333-iteration` at `a01fc08663baab3039c4f1c084538de732a4fd0e`.
- Draft PR #332 integrates the governed Agent OS line on the exact bridge base. Its current reviewed line is intentionally blocked from merge until the bridge release and final protected checks complete.
- The installed immutable CLI is still `3.1.0`; launchd is registered but stopped and points at repository source, so it is not production authority.
- No authenticated Agent OS observation stores, epoch composition, anchor, signing key, or enforced sandbox have been commissioned on this host.
- Docker Desktop is installed but unavailable because its data image exhausted host storage; no Docker data has been removed.
- npm publication remains blocked on interactive security-key verification. No `3.3.2` tag, GitHub release, or npm publication has been created.
- The NIWC/DON research was reduced to control-plane requirements in `docs/AGENT-OS-DOCTRINE.md`: contested-resource scheduling, decision/administration/enforcement separation, non-person identity, continuous evidence, and exact production acceptance gates. These are transferable engineering patterns, not an assertion of government endorsement or compliance.

## Release order

1. Verify the npm trusted-publisher binding and publish `3.3.2` from exact protected master.
2. Complete and merge the Agent OS integration through protected checks as the next semver-minor line.
3. Publish and install the immutable successor artifact.
4. Commission execution-bound isolation and authenticated observation trust.
5. Activate one bounded lane and verify effect, degraded behavior, shutdown, and rollback receipts.

## Current gates

- Exact-master integration is pushed as draft PR #332; GitHub's native operating-system, authority, dependency, and CodeQL matrix is running on the current head.
- The unused Raycast dependency that pulled the vulnerable `stream-json` chain has been removed. Stable Tauri's Linux `glib@0.18.5` line remains an upstream ecosystem constraint and is not being papered over with an unsafe override.
- Isolation V2 source contracts passed focused independent review after immutable-snapshot, policy-binding, native-image, process, cleanup, and replay-evidence repairs. They still do not commission an enforcement backend.
- A final security repair is closing cross-chunk durable-stream redaction and authenticated realized-merge scorecard windowing before the successor's exact-SHA full gate.
- The complete unsharded recovery-line `test:ci` run finished 15,746 passing, 45 skipped, and three host-contention failures. The production deadline semantics were separately retained; the combined crash suite was split into independently budgeted cases. Three repeated focused runs passed before the fix was pushed.
