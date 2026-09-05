# Contract M566 — Execution Capacity Lease V1

## Scope

M566 is an internal, explicitly enabled reservation ledger for authenticated
execution-identity capacity observations. It reserves abstract slots before a
future execution authority exists. It does not start work, resolve credentials,
select providers, alter routes, or contact any external system. Its private
storage and locking dependencies may perform bounded local OS security
inspection: on supported POSIX systems process-start inspection uses fixed
`/bin/ps` argv (never `PATH` lookup), and macOS exact-mode assurance may use
fixed `/bin/ls` argv. Windows is unsupported for this store.

## Safety contract

- Default state is disabled and performs no filesystem mutation.
- Every mutation returns `executionAuthority: false`,
  `providerContactAuthority: false`, `routingMutation: false`, and explicitly
  reports `sameUserTamperResistant: false`.
- Capacity evidence is accepted only through a trusted verifier pinned when the
  store is constructed. The verifier identity digest is part of the canonical
  domain-separated envelope, and the verifier method is captured once so a
  request cannot replace it. Identity, evidence digest, epoch, freshness,
  future skew, expiry, and trusted-slot claims are revalidated.
- A batch is one atomic all-or-nothing ledger transition. The sum of active
  reservations for an identity never exceeds its authenticated `trustedSlots`.
- The first successful acquisition returns a random owner capability. Only its
  domain-separated commitment is written. Idempotent replays never redisclose
  the capability.
- Renew and release require the exact capability plus current lease epoch.
  Finalized allocation tombstones are retained, preventing stale capability or
  allocation-ID ABA reuse. An exhausted safe-integer epoch refuses further
  transitions instead of overflowing the fence.
- Expiry only changes `reserved` to `expired` and releases abstract slots. It
  has no execution or cleanup authority.
- The ledger is bounded and fail-closed. A full identity or allocation history
  refuses new reservations rather than deleting replay protection.

## Private durability contract

The store is rooted beneath a caller-pinned trusted anchor. Its directory is
0700 and state/lock files are 0600 on POSIX. Named paths, owners, link counts,
inode identities, sizes, and stable reads are verified. Symlinks, hardlinks,
unsafe modes, malformed content, digest corruption, replacement races, lock
ambiguity, and durability failures fail closed. Publication uses an exclusive
temporary file, file fsync, identity-checked rename, directory fsync, and a
post-publication byte/inode check.

A failure after rename is reported as `committedWithoutReceipt: true`; no owner
capability is returned. The reservation remains harmless and self-expires.

## Public inspection

Inspection is values-free: it exposes opaque identity/evidence/allocation
digests, counts, epochs, slot totals, state, and expiry only. Raw allocation
identifiers and owner capabilities never appear. The inspection remains
observation-only and makes no same-user tamper-resistance claim.

## Acceptance

`test/m566.execution-capacity-lease.test.ts` covers default-off behavior,
authenticated evidence rejection, atomic batching, slot conservation,
idempotency, identity conflict, evidence drift, epoch/capability fences,
verifier pinning, hostile batch shapes, rejected-request isolation,
deterministic expiry, ABA tombstones, private modes, link/path/corruption
rejection, fixed-path process inspection, lock contention, replacement races,
and ambiguous durability.
