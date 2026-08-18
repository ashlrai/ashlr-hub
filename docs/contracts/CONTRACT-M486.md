# M486 Daemon Spend Durability Contract

## Purpose

The daemon's accounting state (`~/.ashlr/daemon-state.json`) and its spend
guard record what the fleet has already spent today. Before M486 a process
crash or power loss between "wrote bytes" and "bytes actually on disk" could
silently lose or corrupt that record — the daemon would wake up believing it
had spent less than it had, or believing a spend guard had never armed.
M486 closes that gap for the daemon's own accounting persistence. It is a
crash-safety guarantee, not a new authority surface.

## Hard rule

Every durable write to daemon state or the spend guard crosses a strict
barrier before it may be reported successful:

1. Write the new content to a private (`0600`), process-and-run-unique
   temporary file in `~/.ashlr/`.
2. `fsync` the temp file's file descriptor.
3. Atomically rename the temp file onto the target path (POSIX-atomic).
4. `fsync` the containing directory so the rename survives a crash, not just
   the file contents.

`src/core/daemon/state.ts:604` (`writeDurableReplacement`) and
`src/core/daemon/state.ts:632` (`writeDurableExclusive`) implement this order.
`saveDaemonStateResult` (`src/core/daemon/state.ts:665`) and
`armDaemonSpendGuard` (`src/core/daemon/state.ts:786`) are the two callers
that must go through it.

If the post-rename directory-fsync barrier fails, the write must never be
reported as durably successful, even though the visible file on disk may
already contain the new bytes — a caller that treated that as success could
book spend twice after a crash recovery re-reads stale-but-visible state. If
only the pre-rename step fails, the exact legacy bytes remain recoverable
(the rename never happened), and that must also be distinguishable from a
successful write. `SaveDaemonStateResult` (`state.ts:141`) makes both
outcomes explicit to the caller rather than collapsing them into a boolean.

## Surface

- `writeDurableReplacement(path, value)` — private, not exported. Rename-based
  durability for a path that may already exist (`daemonStatePath()`).
- `writeDurableExclusive(path, value)` — private, not exported. Exclusive
  create + fsync for a path that must not already exist.
- `saveDaemonStateResult(state): SaveDaemonStateResult` — public entry point;
  never throws; returns which barrier stage failed, if any.
- `armDaemonSpendGuard(input): ArmDaemonSpendGuardResult` —
  `src/core/daemon/state.ts:786`; same barrier for the spend-guard file.
- `fsyncDirectory` (`src/core/util/durability.ts`) — the shared
  platform-aware directory-fsync primitive both writers call.

## Verification

`test/m486.daemon-spend-durability.test.ts` proves:

- A successful write survives simulated crashes injected after each of the
  four barrier steps in turn — the file on disk is either the old durable
  bytes or the new durable bytes, never a torn write.
- A failure at the post-rename directory-fsync step is reported as
  indeterminate, not success, even though the renamed file is visible.
- A failure before rename leaves the prior durable bytes fully intact and
  readable.

## Non-goals

- M486 does not change what is spent, how spend is computed, or any budget
  policy. It only makes the *recording* of spend crash-safe.
- No cross-machine or cross-process durability claim — this is single-host,
  single-user filesystem durability only, same threat model as every other
  Ashlr private-store write (see `CONTRACT-M460.md`'s Threat Boundary
  section, which applies here unchanged).
- Does not grant recovery authority; see M487/M501 for the quarantine and
  resolution flows that consume a *corrupt* state, which this contract does
  not itself produce or repair.
