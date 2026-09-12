# Automatic admission recovery — local verification

Date: September 12, 2026. Base: `f0d6898a4011bf0f8c861766c3902780a076ab97`.
Branch: `codex/automatic-admission-recovery`.

## Implemented behavior

Ordinary registrations explicitly marked for automatic admission retain their
original queue ID, configuration digest and deadline. The existing background
owner reconciles them after startup, preparation and on bounded timer passes.
Manual/successor registrations are not retrofitted. Paused queues may recover
admission but do not execute. Stale bindings, unavailable proof and capacity
remain visible holds. No deadline, account reserve or usage allocation is renewed.

The existing Automatic engineering panel reads authenticated recovery metadata,
shows sampled/historical state and bounded hold reasons, and preserves valid
supervision controls when the subordinate recovery read fails or times out.

## Verified

- Serialized real-I/O gate: **95 tests, eight suites, zero skips, 721.28 seconds**,
  exit 0. Suites: auto-admission-recovery-acceptance, console-engineering-routes,
  engineering-supervisor-admission-acceptance, console-engineering-preparation-
  acceptance/boundaries/reuse, engineering-preparation-registry, and engineering-
  setup-acceptance (all `resource-` prefixed under `test/`).
- The new actual HTTP/owner test passed in 61.310 seconds: durable registration
  survives injected admission failure; restart recovers without another prepare;
  paused recovery has zero ledger attempts, worker/evaluator calls and branches;
  explicit resume executes once; another restart causes no replay. Original
  configuration, deadline, registration/bundle bytes and account policy remain.
- Pure recovery/registration/manager/background/RPC gate: 75 tests, five files.
- Combined web gate: 136 tests, four files, including decoder, supervision
  client/panel and objective composer. No nonexistent test filter is counted.
- Full source/web typechecks, scoped lint, documentation and diff checks passed.

## Limits

The restart test uses a normally stopped owner to exercise the persisted gap; it
is not SIGKILL or arbitrary controller-crash recovery evidence. Browser geometry
has not been checked. No real provider accounts, autonomous service, remote
publication or production deployment were activated.

The pinned native-Git change is separately committed as `9338c627`. Combining
these changes alters trusted preparation dependencies and therefore the builtin
identity. Rebuild and verify the combined source; do not reuse old comparator
pins or call the separate native gate proof of a later build.
