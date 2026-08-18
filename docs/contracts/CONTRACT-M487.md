# M487 Daemon State Quarantine Contract

## Purpose

When daemon state (`~/.ashlr/daemon-state.json`) is suspected corrupt or
crash-damaged, an operator needs a way to preserve it as evidence — for
later diagnosis — before the daemon is allowed to start fresh (M501 covers
the "start fresh" half). M487 is the preservation half: a two-phase,
explicitly-authorized, atomic quarantine of the suspect state file into
immutable evidence storage. It grants no repair, restart, or service
authority by itself.

## Hard rule

Quarantine is two-phase and both phases are required:

1. **Preview** (`previewDaemonStateQuarantine`,
   `src/core/daemon/state-recovery.ts:1346`) is read-only. It validates the
   caller-supplied expected SHA-256 of the current state file against the
   real file, refuses if a daemon service is active
   (`serviceRefusal(runtime)`), and — only if both checks pass — writes a
   **signed, immutable plan** (`DaemonStateQuarantinePlan`,
   `state-recovery.ts:90`) to disk via `writeExclusiveRecord`. The plan
   records its own digest and signature, an `expiresAt` exactly
   `PLAN_TTL_MS` (10 minutes, `state-recovery.ts:60`) after creation, and an
   explicit `authority` block whose fields (`operatorAuthorizationRequired:
   true`, `sourceMutationAllowed: false`, `serviceMutationAllowed: false`,
   `serviceStartAllowed: false`, `serviceRestartAllowed: false`,
   `serviceInstallAllowed: false`) are permanent — the preview step cannot
   set any of them to grant authority.
2. **Execute** (`executeDaemonStateQuarantine`, `state-recovery.ts:1425`)
   requires the exact `planId`, the exact `planDigest` from the plan (so a
   caller cannot execute a plan it hasn't actually seen), and an
   `operatorAuthorization` value. It re-validates the plan hasn't expired,
   re-checks the service isn't active, and only then publishes the
   quarantine record via an atomic hard-link (source file → content-addressed
   quarantine path keyed by `expectedSourceSha256` + `planId`,
   `daemonStateQuarantinePath`, `state-recovery.ts:458`), producing a signed
   `DaemonStateQuarantineReceipt` (`state-recovery.ts:119`).

A crash between the hard-link and the receipt being durably recorded must be
recoverable by a later call without either double-quarantining or losing the
evidence — `prepareDaemonStateAtomicQuarantineEvidence`
(`state-recovery.ts:1266`) is the shared atomic-evidence primitive both the
quarantine and resolution flows use for this.

Plans expire after 10 minutes specifically so a stale, previously-issued plan
cannot be replayed against a since-changed source file.

## Surface

- `previewDaemonStateQuarantine(expectedSourceSha256, runtime): PreviewDaemonStateQuarantineResult`
- `executeDaemonStateQuarantine({planId, planDigest, operatorAuthorization}, runtime): ExecuteDaemonStateQuarantineResult`
- `prepareDaemonStateAtomicQuarantineEvidence(...)` — shared hard-link +
  receipt-publication primitive
- `daemonStateRecoveryPlanPath`, `daemonStateRecoveryReceiptPath`,
  `daemonStateQuarantinePath` — content-addressed path helpers
  (`state-recovery.ts:434-458`)
- CLI wiring: `ashlr daemon recover-state --dry-run` (preview) /
  `--execute --plan-id <id> --plan-sha256 <digest> --authorize <token>`
  (execute), via `src/cli/daemon.ts` (M490)

## Verification

`test/m487.daemon-state-quarantine.test.ts` proves:

- The dry-run plan is immutable — its digest/signature cannot be forged and
  re-submitted to authorize a different quarantine target.
- Execution refuses when source content has drifted since the plan was
  previewed (SHA-256 mismatch), when a daemon service is active, and when
  the plan has expired.
- Cross-device quarantine (state file and quarantine store on different
  filesystems, where hard-linking is impossible) is explicitly unavailable,
  not silently degraded to a copy.
- Crash recovery works correctly for a crash landing after the hard-link is
  created but before the receipt is published — a retry converges on one
  quarantine record, never two.
- Windows: hard-link-based publication has the same durability requirements
  as every other private-store write in this repo (see CONTRACT-M463.md
  "Persistence Proof Required Before Activation" for the general Windows
  durability bar); this contract inherits that requirement rather than
  relaxing it.

## Non-goals

- Grants no service restart, reinstall, or repair authority — those remain
  withheld per the resident-service authority restriction (see CHANGELOG
  3.2.0, "Temporary resident-service authority restriction").
- Does not itself produce a fresh, usable daemon state — see M501
  (`CONTRACT-M501.md`) for the resolution flow that consumes this receipt.
- Not a general-purpose file quarantine tool; scoped to exactly
  `daemonStatePath()`.
