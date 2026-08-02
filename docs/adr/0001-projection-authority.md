# ADR 0001: Handle-Relative Projection Authority

- Status: accepted design, dormant implementation
- Scope: proposal persistence and the operational proposal projection
- Activation: prohibited until every gate in this ADR is satisfied by a separate reviewed change

## Decision

Ashlr will replace pathname-based projection authority with a long-lived native
single-writer service. The service will acquire the trusted storage root once,
retain directory handles for its lifetime, and perform every descendant open,
create, rename, remove, read, and durability operation relative to those held
handles.

The first production implementation will use a small Rust service and a durable
append-only commit journal with immutable content-addressed proposal blobs. A
journal root is authoritative only while it exactly matches the externally
signed monotonic CAS root; materialized proposal JSON and projection manifests
are compatibility caches. SQLite is not part of the first authority boundary.
It may replace the journal later only behind a handle-relative custom VFS or an
equivalent proven immutable-root mechanism.

This branch remains dormant. No source module outside the transaction/replay
implementation may import its coordinator until the native service, migration,
rollback, cross-platform, and external monotonic-root gates are complete.

## Problem

The current code has strong path-level checks but no object-capability boundary.
It repeatedly validates `(dev, ino)`, ownership, modes, symlink/reparse state,
and stable reads, then performs later Node.js filesystem operations by pathname.
A concurrent replacement can therefore present an approved directory during a
check and a different directory during a later open or rename. Additional
before/after checks detect many races but cannot prove that every operation was
resolved beneath the same directory object.

Keeping a directory descriptor open does not fix this by itself. The child
operation must also be relative to that descriptor. A descriptor plus a later
absolute `open`, `rename`, or `lstat` remains path-authorized.

## Current Interface And Call-Site Map

| Boundary | Current behavior | Authority gap |
| --- | --- | --- |
| `proposal-mutation-lock.ts` | `ProposalStoreMutationAuthority` captures home/root paths and `(dev, ino)` while a path-backed local lock is held. | It is an identity observation, not an open root capability. |
| `store.ts::persistProposal` | Creates temp/rollback files, fsyncs, links or renames, rereads, and rolls back under the store lock. It is reached by proposal creation, status/field updates, and realized-merge recording. | Temp creation, publication, reread, cleanup, and rollback all resolve pathnames independently. |
| `operational-projection.ts` | Reads proposal files and a signed projection manifest; migration writes `proposal-projection/current.json`. | Proposal enumeration, member reads, key reads, and manifest publication are independent pathname traversals. This module currently has test-only consumers. |
| `operational-projection-transaction.ts` | Persists the active phase journal and binds reads to captured home/root identities. | Journal/key reads and temp publication return to path resolution after validation. |
| `operational-projection-replay-ledger.ts` | Persists an authenticated local phase history and reconciles one-phase gaps. It explicitly reports `rollbackProtected:false` and `historicalAuthority:false`. | It has the same pathname boundary and cannot supply an external monotonic root. |
| `operational-projection-transaction-coordinator.ts` | Coordinates journal and replay-ledger phases. | It is intentionally dormant and has no non-test call site. It does not atomically mutate proposal plus projection state. |
| `private-file-write.ts` / `stable-file-read.ts` | Pin opened file identity and perform bounded I/O with extensive before/after validation. | Parent directory operations remain pathname-relative; Windows has no Node.js handle-relative child API here. |
| `foundry/provenance.ts` | Reads the host-shared key after opening and checking directory/file identities. | The key and its parents are still located by pathname. The HMAC authenticates cooperative local state, not independent history. |

The production conversion must cover all `persistProposal` callers and all
proposal readers. Converting only the projection manifest would leave proposal
bytes outside the same authority and would not close the transaction.

## Options Considered

### 1. One-Shot Native Helper

A Rust helper can use `openat`/`renameat`/`fsync` on POSIX and `NtCreateFile`
with `OBJECT_ATTRIBUTES.RootDirectory`, `FILE_OPEN_REPARSE_POINT`, and
handle-relative rename on Windows.

This proves descendant resolution beneath the held root only for one helper
lifetime. A helper invoked independently for each phase reintroduces cross-call
root ABA. It is acceptable only if one invocation performs the complete commit
and recovery operation, and every authoritative read also goes through that
invocation. At that point it is effectively the service protocol with process
startup on every request and weaker continuity, so it is not selected.

### 2. SQLite Transactional Projection Store

SQLite is an excellent atomicity engine. One transaction can commit proposal,
projection, journal, and replay rows together, and its crash-test history is far
stronger than a new multi-file transaction implementation.

SQLite alone does not prove namespace authority. The standard API opens a
filename through a VFS, and rollback/WAL modes create sidecar files. Even
`SQLITE_OPEN_NOFOLLOW` addresses the final database symlink, not a hostile
parent replacement or all sidecar resolution. Default Node `DatabaseSync`
likewise accepts a path, not a trusted directory handle. A custom VFS could make
SQLite handle-relative, but that is a larger first slice than a bounded journal
and still requires the native service boundary.

SQLite remains the preferred later storage engine if measurements justify it
and the custom VFS passes the same root-continuity suite. It is rejected as a
standalone fix.

### 3. Native Single-Writer Service With Immutable Root Handle

This is selected. The daemon starts one native child from an immutable verified
release and retains a private anonymous inherited IPC channel. Launch admission
must bind the exact executable bytes and release identity used by the child,
pass only the intended channel and root capabilities, close all other inheritable
descriptors/handles, and construct an allowlisted environment that excludes
loader injection and language-runtime hook variables. No named pipe, Unix socket,
path-discovered endpoint, mutable `PATH`, or post-verification executable lookup
may enter the authority boundary. The child and supervisor mutually bind a fresh
session nonce, protocol version, executable digest, and release digest before any
storage request is accepted.

The child resolves the OS account home without trusting mutable `HOME`, acquires
the platform root/volume capability, opens the home and `.ashlr` hierarchy
component by component without following links/reparse points, and holds the
resulting handles until shutdown. Account lookup and initial root acquisition
remain part of launch admission rather than a guarantee supplied by the journal;
platform tests must prove that a mutable path cannot be substituted between
lookup and capability acquisition.

On POSIX, descendant operations use single-component `openat`, `mkdirat`,
`fstatat(AT_SYMLINK_NOFOLLOW)`, `renameat`, and `unlinkat` calls. Linux may add
`openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`,
but portable POSIX behavior must not depend on Linux-only `openat2`. Files and
the exact containing directory handles are fsynced; unsupported durability is
a hard failure.

On Windows, the service uses directory handles opened without
`FILE_SHARE_DELETE`, `NtCreateFile` relative to `RootDirectory`,
`FILE_OPEN_REPARSE_POINT`, explicit reparse-tag/DACL/owner checks, and
handle-relative rename information. File data and metadata are flushed with
documented write-through/flush APIs. Native Windows activation remains blocked
until abrupt-power-loss tests prove the exact selected filesystem semantics;
an unsupported directory-entry durability result is not downgraded.

## Authoritative Storage Model

The service owns one private `projection-authority-v1` directory beneath the
held `.ashlr` root:

```text
projection-authority-v1/
  journal.log
  blobs/
    <proposal-digest>.json
  snapshots/
    <journal-root>.json
```

- Proposal blobs are canonical, bounded, immutable, content-addressed files.
  Creation is exclusive and handle-relative. Existing bytes must match the
  requested digest exactly.
- `journal.log` is opened once by handle. Each bounded frame carries length,
  schema version, sequence, previous-root digest, transaction ID, proposal ID,
  before/after digests, canonical timestamp, checksum, and service attestation.
  Framing must distinguish a torn final frame from a malformed committed frame;
  corruption before the final candidate is a hard stop, never a truncation hint.
- A commit first makes every new blob durable, then appends and flushes one
  complete journal frame as a local candidate, then performs an externally
  signed compare-and-set from the exact previous root to that candidate root.
  The candidate becomes readable as committed, and success is returned, only
  after the signed CAS response verifies and exactly names both roots. A partial
  final frame is not committed. A complete local candidate with an unchanged
  external root is recovered only by retrying the same idempotent CAS or stopping;
  it is never exposed or discarded by local policy. An external root ahead of,
  or conflicting with, durable local history is degraded and requires explicit
  signed recovery evidence. Committed history before a malformed tail is never
  silently reinterpreted.
- The current proposal namespace and operational projection are derived views.
  They may be materialized handle-relatively for compatibility, but readers
  cannot use those files as authority.
- The request is one compare-and-commit operation. Callers provide expected
  journal root/generation and canonical next proposal bytes. The service
  computes digests, membership, and the next projection. It never accepts a
  caller assertion that verification, locking, durability, or recovery already
  occurred.

The service protocol has only `status`, bounded point/batch reads, and
`compare-and-commit`. Every bounded frame carries the session nonce, monotonically
increasing request ID, protocol version, operation, canonical request digest, and
an exact response binding; duplicate, skipped, unsolicited, truncated, or
out-of-order traffic closes the session and degrades authority. Unknown fields,
duplicate IDs, noncanonical JSON, oversized frames, stale expected roots,
unavailable keys, incomplete recovery, peer death, or any platform-assurance
failure return a typed degraded result and perform no commit. There is no path
fallback. There is no reconnect to a path-discovered endpoint.

## Guarantees

| Strategy | Actually proves | Does not prove |
| --- | --- | --- |
| Current path checks | Cooperative ownership/mode checks, file identity around bounded I/O, many detectable races. | Parent object continuity for later path operations; same-root resolution for proposal and projection; rollback resistance. |
| One-shot handle-relative helper | Same-root descendant resolution during one invocation; no symlink/reparse traversal for covered calls. | Continuity across invocations; multi-file atomicity unless the whole transaction is one invocation; external history. |
| SQLite with default VFS | Serializable atomic transactions and crash recovery for records inside one database under documented filesystem assumptions. | Trusted database/sidecar namespace, root continuity, HMAC integrity, external monotonic history. |
| Selected native service and journal | One writer; object continuity for the service lifetime; handle-relative namespace confinement; a single local commit point; bounded crash recovery; no live path fallback. | Trust before root acquisition; protection from a process with equivalent OS authority; independent verification; cross-restart rollback resistance; remote/CAS availability. |
| Selected service plus external signed monotonic CAS | All above, plus detection/reconciliation of local rollback or root replacement across restarts when the CAS transport is healthy and signatures verify. | Correctness of a compromised signer/service, hardware failure outside documented guarantees, or authorization beyond the signed policy. |

The service is a storage authority, not an independent judge. It does not make
proposal quality, verification, merge, or deployment decisions.

## Incremental Dormant Implementation

1. **Protocol and native primitive harness:** add a Rust workspace containing
   no daemon integration. Implement root acquisition, relative single-component
   file operations, strict flushes, bounded framing, launch/peer binding, and a
   fake in-memory transport. Package no binary in release artifacts yet.
2. **Native platform proof:** run Linux, macOS, and Windows tests against real
   filesystems. Inject parent swaps, child swaps, symlinks, junctions, mount
   escapes, hard links, stale handles, service death, partial writes, rename
   failure, flush failure, and restart after every commit point.
3. **Shadow import:** while legacy writers are quiescent under the existing
   global store lock, the service opens the legacy inbox handle-relatively,
   ingests a complete bounded snapshot, and writes a signed genesis frame.
   Reads compare service state with legacy state but never route authority to it.
4. **External-root binding:** bind genesis and every committed journal root to
   the signed monotonic CAS coordinator. Missing, unavailable, stale, unsigned,
   or conflicting CAS evidence stops startup and mutation.
5. **Writer conversion:** route every `persistProposal` caller through one
   compare-and-commit port. Remove direct path mutation from live code. Keep the
   old files as service-produced compatibility views only.
6. **Reader conversion:** route proposal and operational-projection reads
   through the service. Require a healthy exact journal root. Missing service or
   incomplete migration is degraded, never cold-start or healthy zero.
7. **Canary and activation:** activate only on an immutable release with native
   CI, signed artifact identity, abrupt-crash evidence, canary monitoring, and a
   tested disable path. Activation is a separate reviewed change.

The smallest first code slice is steps 1 and 2 for one immutable blob plus one
journal frame. It remains unreachable from `store.ts`, the daemon, CLI, web,
automerge, and release installation.

## Migration And Rollback

- Migration is idempotent and CAS-guarded. The genesis frame binds a complete
  legacy namespace digest, projection digest, provenance-key generation, and
  external expected root. Partial or changed legacy input aborts.
- Dual-write is prohibited because it creates two authorities. Shadow mode is
  legacy-write plus service import/compare; cutover is service-write plus
  compatibility projection.
- Legacy files remain untouched through the canary and rollback window.
- Rollback means disable mutation and return to a read-only prior release that
  understands the service export. It must never resume a legacy path writer
  after service cutover. If a compatible rollback release is unavailable, the
  fleet remains stopped and exports evidence for recovery.
- Rollback to an earlier journal root requires an externally signed rollback
  permit bound to the exact before/after roots. Local HMAC state is insufficient.

## Required Tests Before Activation

- **Primitive confinement:** every operation is relative to a held handle;
  absolute paths, separators, `.`/`..`, alternate streams, device paths, and
  unknown reparse tags are rejected.
- **ABA:** swap/rename every ancestor and child before and during open, create,
  publish, read, flush, and recovery. The operation either targets the original
  held object or fails; it never targets the replacement.
- **Crash matrix:** kill before/after blob write, blob flush, directory flush,
  journal append, journal flush, CAS request, CAS apply, signed response receipt,
  and caller response. Recovery yields exactly the externally anchored before or
  after root and never a healthy ambiguous state.
- **Protocol:** malformed/duplicate/oversized/out-of-order frames, stale CAS,
  stale generation, replay, conflict, unknown fields, wrong session/executable/
  release binding, inherited-handle leakage, loader-environment injection, peer
  replacement, peer death, and partial responses all fail closed without fallback.
- **Migration:** empty, complete, oversized, changing, malformed, aliased,
  hard-linked, and legacy-unmigrated namespaces; repeated genesis is exact
  replay and different genesis is conflict.
- **Durability:** real native Windows, macOS, and Linux abrupt-process tests;
  supported filesystem matrix; injected sync errors; removable/network/
  unsupported filesystems refuse activation.
- **Import boundary:** until the activation change, no live source imports the
  transaction/replay coordinator. The contract test added with this ADR
  enforces that dormant state.
- **End-to-end:** every proposal create/update/merge-evidence path and every
  authoritative reader crosses the service; killing or impersonating the
  service cannot cause local fallback.

## Activation Gates

Production projection authority remains false until all of these are true:

1. native artifacts are reproducible, signed, and bound to the immutable Hub release;
2. all three native platform suites and the crash matrix pass;
3. the external signed monotonic CAS transport is available and writable;
4. migration is complete and exact read parity is proven;
5. every writer and reader uses the service with no path fallback;
6. the service is supervised, resource-bounded, launch/peer authenticated, and
   exposes health without raw proposal contents;
7. canary, disable, export, and signed rollback-permit procedures are exercised; and
8. a separate reviewed activation change removes the dormant import guard.

## Research Basis

- POSIX specifies directory-relative rename through
  [`renameat`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)
  and descriptor durability through
  [`fsync`](https://pubs.opengroup.org/onlinepubs/009695399/functions/fsync.html).
- Linux `openat2` adds explicit beneath/no-symlink resolution controls, but is
  Linux-only: [`openat2(2)`](https://man7.org/linux/man-pages/man2/openat2.2.html).
- Microsoft documents relative opens through `OBJECT_ATTRIBUTES.RootDirectory`
  and reparse-point control in
  [`NtCreateFile`](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile),
  plus handle-relative rename targets in
  [`FILE_RENAME_INFORMATION`](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information).
- SQLite documents its atomic-commit assumptions and crash testing in
  [Atomic Commit](https://www.sqlite.org/atomiccommit.html), while its open API
  delegates filename behavior to the selected
  [VFS](https://www.sqlite.org/c3ref/open.html).
- Microsoft recommends replacement/database patterns instead of adopting the
  deprecated TxF platform:
  [Alternatives to TxF](https://learn.microsoft.com/en-us/windows/win32/fileio/deprecation-of-txf).
