# CONTRACT-M520: Dormant stopped-release consumer

Status: source-complete, dormant, not resident-production-ready.

M520 composes the exact M502 admission with a separate, short-lived Ed25519
operator permit to select the already-staged immutable Ashlr 3.2.7 release
while the daemon remains stopped. The compiled production permit trust-root
array is empty. Provisioning requires a separately reviewed source change.

## Authorized transaction

The permit binds the exact plan, admission, request, trust root, candidate,
rollback, prior pointer, prior plist, unloaded state, and disabled bit. While
holding the outward-mutation fence and then the daemon service-lifecycle fence,
the consumer requires a healthy engaged KILL switch, complete guards, and zero
daemon roots or PPID descendants. `ASHLR_HOME`, when present, must be exactly
the operating-system account's canonical `<home>/.ashlr`; it cannot redirect
KILL, guard, state, or activity evidence. It durably records a one-shot claim,
replaces the stopped plist, performs a host-local cooperative pointer CAS,
revalidates the stopped state, and records an immutable receipt.

Every local phase is bound by a canonical, HMAC-authenticated, fsynced journal.
An uncommitted failure restores the exact prior plist and pointer without
starting the prior service. Uncertain recovery retains the journal and reports
reconciliation.

Authenticated restart recovery precedes current permit, expiry, and trust-root
validation. It requires the matching immutable claim plus the same stopped,
quiescent, lock-held conditions. It restores an unreceipted journal or settles
an exact immutable receipt, so removing current roots cannot strand an already
authorized transaction or grant a new one.

The shipped runtime adapter and empty root array are frozen and expose no hook,
registration, replacement, or environment-gated test API. Tests provide their
dependencies only by replacing the adapter in Vitest's test-only module graph;
the production entrypoint has no HOME, clock, root, effect, or fence injection.
Recovery results carry the exact journal-bound activation, candidate, admission,
and plan identity, so a concurrent supplied plan cannot relabel recovery.
Request, trust-root, and launch-receipt diagnostics are unavailable for journal
recovery rather than inherited from a concurrent plan. An unauthenticated raced
journal retains reconciliation evidence with all identity unavailable. The
consumer owns and wipes the original provenance-key Buffer on every path. An
exact receipt plus exact candidate state is a committed `activated-stopped`
success, including when settlement is discovered after a response-path fault.

## Explicit exclusions

M520 never starts, bootstraps, boots out, kickstarts, enables, disables, or
accepts an acknowledgement from a service. The exact disabled bit and
`loaded=false` are invariants. A resident start and ACK require a separate
release-bound permit.

The pointer operation coordinates cooperative Ashlr processes. It is not a
kernel compare-exchange and does not exclude a hostile process under the same
UID. A reviewed native old-inode CAS helper, trusted monotonic time, external
monotonic replay authority, and resident launch/ACK transaction remain separate
prerequisites for stronger production activation. M520 must not be presented as
completed resident activation or deployment.
