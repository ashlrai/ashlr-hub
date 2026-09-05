# CONTRACT-M569: Dormant native macOS broker foundation

Status: dormant source-foundation candidate, authority-free, and not an
activation consumer or production broker.

M569 adds native Rust building blocks for the future protected launchd broker.
The desktop binary does not import the library module, no Tauri command or CLI
exposes it, and no production effect consumer is registered. The exported
authority descriptor freezes effect-consumer, permit/trust-root,
protected-XPC, peer-identity, conditional-CAS, trusted-time, external-replay,
cross-generation exclusion, resident-acknowledgement, launch/start, and
dispatch authority to `false`.

## Implemented foundation

- Authenticated, strict-canonical request and receipt frames use separate
  request-verification, journal-authentication, and receipt-authentication keys.
  A request binds the three distinct pointer, plist, and journal parents, exact
  object observations, candidate target and plist digest, stopped launchd
  declaration, nonce, transaction, and an explicitly untrusted permit digest.
  Receipt decoding also validates canonical positive object identities, exact
  pointer-target grammar, plist digest/mode/size, stopped label, and owner/UID
  coherence; a valid MAC alone is not a semantically valid receipt.
- macOS custody walks absolute canonical paths from `/` with fd-relative
  `openat`, `O_DIRECTORY`, `O_NOFOLLOW`, and `O_CLOEXEC`. It requires owned,
  non-group/other-writable roots and binds each opened directory device/inode
  into authenticated recovery state.
- Pointer observation uses `fstatat(..., AT_SYMLINK_NOFOLLOW)`, bounded
  `readlinkat`, and a second `fstatat`. Plist and journal reads pin an
  `O_NOFOLLOW` descriptor and compare identity, owner, mode, link count, size,
  mtime, and ctime before and after the bounded read.
- The native stopped observer uses the fixed `/bin/launchctl` executable with a
  clean locale-only environment, bounded output, and a bounded deadline. It
  observes absent service, one exact disabled-bit entry, then absent service
  again. The internal transaction harness revalidates that observation
  immediately before selection mutation, before receipt, and before
  settlement. Intent/staging writes may precede the selection revalidation.
- The internal test-only transaction harness uses transaction-unique
  `RENAME_EXCL` claim names, verifies the displaced old pointer/plist identity
  and content, and installs staged objects only into absent names. Separate
  roots are serialized cooperatively by non-blocking leases on every affected
  root plus an authenticated journal-root active marker. A pre-existing final
  M520 v1 journal is rejected before an M569 mutation begins.
- Before creating a fresh active marker, execution refuses any existing
  transaction-ID-scoped pointer/plist staging or backup, journal final/pending,
  or receipt final/pending artifact. Terminal replay therefore uses recovery;
  within those same supplied custody roots it cannot silently reuse a completed
  or rolled-back transaction ID. Global one-use replay across different roots
  remains absent and requires the external monotonic replay authority already
  frozen to `false`.
- Every journal phase and receipt is written to a private exclusive pending
  file, fsynced, exclusively renamed, and followed by a directory fsync.
  Records authenticate their predecessor. Recovery rejects gaps, invalid phase
  transitions, rebound roots, ambiguous pending/final records, changed
  identities, or unauthenticated state. Terminal commit and rollback recovery
  are idempotent. Cleanup rechecks the recorded inode and observation before
  unlinking by name. That is cooperative identity-checked cleanup, not a
  conditional unlink; exact deletion under a hostile same-UID race still
  requires protected directory ownership.
- A committed transaction deliberately retains its old pointer and plist under
  transaction-unique backup names. This dormant foundation has no protected,
  conditionally safe garbage-collection authority, so bounded retention and
  authenticated cleanup policy remain production requirements.
- Non-macOS stopped observation fails closed with
  `native-macos-broker-unavailable` and has no filesystem effect path.

## Explicitly absent authority

M569 does not verify or consume M568 permits, own trust roots, provide trusted
time or external monotonic replay compare-exchange, install a privileged
helper, expose XPC, authenticate audit tokens or code identity, launch, load,
bootstrap, kickstart, enable, disable, start, dispatch, contact providers, or
authorize activation. Supplying a valid authenticated request is not a permit
and grants no authority.

M520 does not honor the M569 lifecycle lease or active marker, so checking for
its final journal cannot prove cross-generation mutual exclusion. M569 also
does not claim to detect an M520 temporary journal. Both consumers must share a
reviewed atomic arbitration primitive before either may claim simultaneous
cross-generation exclusion.

An opened custody descriptor remains identity-bound if its pathname is later
renamed, and recovery rejects a newly opened root identity that differs from
its journal. The authenticated request does not prove a root identity before
the broker opens it, however: a hostile same-UID process that controls an
ancestor can rebind the requested root name before custody acquisition. It can
also rename or replace the pathname after open; settlement verifies the pinned
old directory, not that the requested pathname still resolves to it. Protected
parent-entry custody is required. A pathname-to-descriptor recheck can detect
some interference but still has a final same-UID race, so this property remains
explicitly unverified.

The internal claim-and-verify sequence is deliberately not described as the
genuine conditional old-inode CAS required by M521. `RENAME_EXCL` prevents an
unconditional overwrite and turns interference into refusal, but a same-UID
hostile process can still race an ordinary desktop process. The engine remains
unexported and exists to exercise custody, durability, and recovery invariants
until a separately installed, code-signed protected broker owns the directories
and a reviewed conditional exchange design.

## Next reviewed boundary

Production activation still requires the protected XPC/service boundary,
broker-owned non-exportable keys, client audit-token and code-signature policy,
genuine conditional pointer exchange, external one-use monotonic replay,
M568 permit composition, exact launchd job-generation handling, and separate
resident-start acknowledgement and dispatch authorization. Those properties
must be implemented and adversarially verified before any M569 primitive can be
wired to a CLI, desktop action, daemon service, or production activation path.

The required macOS CI job creates a disposable Tauri sidecar placeholder, then
runs formatting, check, strict clippy, and the native library tests under its
workflow-pinned Rust 1.97.1 toolchain, matching the desktop release workflow.
It validates source behavior on a hosted Mac, but does not establish code
signing, protected custody, XPC peer identity, or production activation
authority.
