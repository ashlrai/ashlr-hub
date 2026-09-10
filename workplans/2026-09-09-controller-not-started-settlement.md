# Settle a proven uncalled controller dispatch

Base: `6a1ee62e2b61530893f18343338efd4624d83eac`.
Isolated branch: `codex/universe-not-started-settlement`.

## Contract

If the owning invocation observes cancellation or expiry after a durable intent
but before calling the campaign runner or delivery path, record a held settlement
with reason `dispatch-not-started`. Preserve the existing `attempted` field:
it means durable campaign-call intent, not evidence that a call actually ran.

Require exact intent, unchanged campaign identity and records, retained controller
ownership and, for campaign dispatch, the transferred Universe lease. Recheck
these conditions if the settlement must wait for its short transaction. Use the
existing bounded cleanup allowance; no new execution or renewed budget.

This receipt may clear the known unresolved intent and permit drain acknowledgement.
It never completes the campaign, restores a pending slot, or authorizes replay.
Unknown crashes, thrown worker calls, changed evidence or lost ownership remain
unresolved. Restart cannot infer no-start merely from absent worker evidence.
Use existing settlement schema and preserve older ledger compatibility.

## Workstreams and verification

- Runtime agent: no-start settlement and focused state/ownership regressions.
- Native agent: real CLI post-intent cancellation, unchanged campaigns, restart.
- Independent reviewer: proof boundaries, transaction waits and compatibility.
- Primary: operator docs, real-I/O lane, integrated checks, publication receipts.

Reproduce the prior in-flight result, verify held no-start result, ensure no
worker/delivery call and no campaign mutation, preserve deadlines, and test unknown
attempts remain unresolved. Run relevant controller/CLI/recovery suites locally,
typecheck, lint, documentation and build. No GitHub Actions, providers, personal
account allocation changes, resident services or public npm activation.
