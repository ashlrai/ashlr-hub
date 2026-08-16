# M501 Daemon State Resolution Contract

## Purpose

M487 quarantines suspect daemon state as evidence. M501 is the other half:
producing a new, usable daemon state after that quarantine, without silently
discarding same-day spend accounting (which could let the daemon exceed its
configured daily budget after "recovering") and without silently reactivating
service authority the fleet doesn't currently hold.

## Hard rule

Resolution is two-phase, mirroring M487:

1. **Preview** (`previewDaemonStateResolution`,
   `src/core/daemon/state-recovery.ts:2736`) requires the exact
   `quarantinePlanId` and `quarantineReceiptDigest` from an M487 quarantine —
   it reads the quarantine chain (`readQuarantineChain`) rather than
   accepting a bare state blob from the caller. It then re-verifies the
   *live* `daemonStatePath()` file is still the exact same authenticated
   inode/generation/digest that was quarantined
   (`source.stat.dev/ino`, `sameRelocatedGeneration`, SHA-256, size all
   compared against the plan) and refuses with `source-drift` if anything
   changed underneath it. It requires no daemon supervisor is observed
   active (`observeAbsentSupervisor`) both before and after acquiring the
   recovery lock, refusing with `service-state-unknown` if that observation
   changes mid-preview.
2. Accounting is **derived, not reset to zero.** `deriveDaemonAccounting`
   (`state-recovery.ts:1988`) attempts to parse the quarantined bytes; if
   `todayDate` matches the current UTC day and `todaySpentUsd` is a valid
   non-negative number, that spend carries forward into the fresh state. If
   the quarantined bytes are unparseable, the budget day doesn't match, or
   the value is malformed, the derived state treats the day as **exhausted**
   (fail-closed) rather than silently zeroing spend — a crash must never look
   like a free daily budget reset.
3. **Execute** (`executeDaemonStateResolution`, `state-recovery.ts:2882`)
   requires the plan id, plan digest, and an explicit `operatorAuthorization`
   value, re-validates the plan hasn't expired (same `PLAN_TTL_MS`, 10
   minutes) and that service/source state hasn't drifted since preview, then
   publishes the fresh state and a signed `DaemonStateResolutionReceipt`
   (`state-recovery.ts:221`), and retires the quarantine marker
   (`daemonStateResolutionRetiredMarkerPath`) so the same quarantine cannot
   be resolved twice.

Resolution must refuse — not degrade — on any live service activity or
execution retry in flight; it does not attempt to reconcile with a running
daemon.

## Surface

- `previewDaemonStateResolution({quarantinePlanId, quarantineReceiptDigest}, runtime): PreviewDaemonStateResolutionResult`
- `executeDaemonStateResolution({planId, planDigest, operatorAuthorization}, runtime): ExecuteDaemonStateResolutionResult`
- `daemonStateResolutionPlanPath`, `daemonStateResolutionIntentPath`,
  `daemonStateResolutionReceiptPath`, `daemonStateResolutionRetiredMarkerPath`
  (`state-recovery.ts:442-454`)
- CLI wiring: `ashlr daemon resolve-state --dry-run` /
  `--execute --plan-id <id> --plan-sha256 <digest> --authorize <token>`
  (`src/cli/daemon.ts`, M490)

## Verification

`test/m501.daemon-state-resolution.test.ts` proves:

- Same-day spend in the quarantined bytes is carried forward exactly;
  cross-day or malformed quarantined bytes fail closed to an exhausted
  budget day rather than a reset-to-zero one.
- Resolution refuses when the live state file has drifted from what was
  quarantined (source-drift), when a service is active, when the plan has
  expired, and when execution retries are detected in flight.
- Concurrent marker races (two resolution attempts against the same
  quarantine) converge on exactly one retirement, never two.
- Symlinked `HOME`/`~/.ashlr` anchors are handled without escaping the
  intended private-store root.

## Non-goals

- Does not restart, install, or repair the daemon service — see the
  resident-service authority restriction (CHANGELOG 3.2.0).
- Does not reconcile with a currently-running daemon; a live supervisor
  causes refusal, not merge.
- Not a general daemon-state editor — the only permitted transformation is
  "derive fresh state from an exactly-linked M487 quarantine record."
