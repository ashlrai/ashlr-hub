# Resource console implementation receipt

Source workspace: `/Users/masonwyatt/.codex/worktrees/ashlr-hub/ashlr-universe-kernel`.
Branch: `codex/resource-pool-console`, based on
`8422403e6ee75d53529ac330225869a0e9404c70`. This receipt is committed with the feature;
the immutable artifact handoff records its final source SHA and package digest.
The primary Desktop checkout was preserved.

## Delivered behavior

One fixed resource pool has a visual operations desk with capacity-group topology,
quota-window inspection, routing refusals, active owned assignments, durable task
history, usage coverage and a task composer/inspector. Separate read and control
capabilities gate observation versus submission/pause/cancel. Execution requires
an explicit startup workspace; all control inputs remain outside that workspace.

A foreground supervisor persists queue and pause state, retries capacity admission,
does not replay ambiguous dispatched work, isolates identity conflicts, and awaits
owned cancellation on shutdown. Transient quota-file failures recover automatically
without abandoning admitted tasks. Task output is bounded and session-local.
The canonical operating procedure is `docs/RESOURCE-POOLS.md`.

## Verification

- Full web suite: 265 tests across 37 files, including the final owned-instance strip.
- Independent controller + HTTP acceptance: 51 tests before two additional
  metadata-envelope regressions; the final supervisor has 44 tests.
- Focused read model and worker: 76 tests; CLI/server: 65 tests.
- Full typecheck passed. Full lint passed with 106 preexisting warnings and no
  errors; real-IO membership passed (169 real-IO files, 620 unit files).
- Actual browser flows and desktop/dark/mobile visual checks are recorded in notes.
- Final broad regression, artifact contract, clean build, offline install and
  installed CLI/HTTP acceptance outcomes belong to the immutable handoff receipt.

## Not represented as complete

This is not an authenticated multi-account production commissioning, an automatic
quota collector, a resident fleet, or verified accepted engineering yield. Local
fixtures prove implementation paths, not model quality or account entitlement.
No provider credentials, account selection, billing, GitHub Actions, global command,
registry publication, or legacy daemon authority was changed. The console is a
usable scoped component; Universe evaluation integration remains future work.
