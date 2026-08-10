# Runtime Activation Authority V1

Ashlr runtime activation remains unavailable. This contract adds a read-only,
fail-closed preflight that can establish whether one candidate release and one
rollback release have enough operator-custodied evidence for a future
transactional consumer. It does not install, launch, start, deploy, restart,
roll back, quarantine, resolve, or mutate daemon state.

## Operator trust root

The preflight reads only these fixed operator-owned paths:

```text
~/.ashlr/control/activation/trust-root.json
~/.ashlr/control/activation/plans/<signed-plan-id>.json
```

Every directory below the operator home must be a real, current-user-owned
`0700` directory. Both files must be real, single-link, current-user-owned
`0600` files. Windows uses the native owner and ACL adapter. Symlinks,
hard links, permissive modes, owner drift, ACL uncertainty, noncanonical JSON,
and read-time identity changes fail closed.

The trust-root file contains public Ed25519 keys only through the existing
Runtime Release Evidence Trust Root V2 schema. It also fixes the minimum policy
epoch and the closed activation-mode set. Private keys and credentials never
belong in this directory, the repository, logs, or preflight output.

## Signed activation manifest

The canonical Ed25519-signed manifest binds both candidate and rollback to:

- exact Git revision and tree declarations;
- unsigned release-manifest digest and signed evidence envelope identities;
- package tarball SHA-256;
- dependency inventory and immutable runtime-tree identities;
- interpreter and service-descriptor SHA-256;
- exact service invocation and canonical policy identity;
- operator evidence trust-root identity and evidence signing key;
- policy epoch, activation mode, issuance, expiry, and unique plan ID; and
- a distinct independently packaged rollback release.

The preflight composes M440 manifest verification, M441 signature verification,
M442 closed-byte launch revalidation, and M488 candidate/rollback pair
verification. Tarballs and service descriptors are independently hashed from
immutable, single-link files. Artifact paths must be absolute and canonical,
and every bundle path component must be canonical,
current-user-owned, non-writable, and free of symlink substitution; native ACL
checks apply on Windows. Candidate and rollback must have distinct bundle paths,
revisions, trees, manifests, tarballs, and runtime-tree identities.
The signed plan validity window is checked both before and after all artifact
observations so a plan expiring mid-preflight cannot become ready.

## CLI

```bash
ashlr daemon activation-preflight \
  --request ~/.ashlr/control/activation/plans/<plan-id>.json \
  --json
```

The command is read-only. `evidenceReady:true` means the signed inputs passed
the observation contract; it does not mean activation is permitted. Every
result keeps install, launch, start, deploy, rollback, and activation false.

## Durable plan evidence

`writeRuntimeActivationPlanEvidence()` exposes the shared immutable private
record-store protocol for a caller-supplied isolated anchor. It publishes one
deterministic, metadata-only plan record with no-clobber, fsync, replay, and
conflict semantics. The CLI does not call the writer and no production path is
defaulted. This record is observation evidence, not replay consumption or
service authority.

## Remaining blockers

Activation stays unavailable until a separate reviewed release implements and
adversarially proves all of the following as one transaction:

1. Descriptor-bound installation and launch from still-open immutable handles.
2. Durable single-consumption replay authority for the signed plan.
3. Independent verification of the signed Git revision and tree declarations.
4. Protected post-merge and release-signing evidence bound to the exact bytes.
5. Atomic candidate canary, health observation, and rollback execution.
6. A separately authorized daemon-state quarantine and resolution sequence.
7. An external monotonic anchor preventing coherent rollback of local roots and epochs.

The resident-service authority guard remains unconditional. No configuration
value can turn this preflight into a mutation consumer.
