# Runtime Activation Authority V1

Ashlr exposes a signed, read-only resident activation admission contract. The
preflight remains available on every platform. The explicit activation command
performs additional macOS-only validation, but resident mutation is deliberately
withheld in this release. Linux and Windows refuse before filesystem or service
observation.

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
The signed plan also binds operation, platform, exact HOME, configuration,
package version and tag, build, the prior plist and unloaded state, the release
root and `current` pointer. The validity window is checked both before and after all artifact
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

## Explicit activation

```bash
ashlr daemon activate \
  --request ~/.ashlr/control/activation/plans/<plan-id>.json \
  --authorize <plan-sha256> \
  --confirm <plan-sha256>
```

The command derives HOME from the operating-system account database, rejects a
mismatched `HOME` environment value, uses the actual host platform, requires
two exact copies of the admitted plan digest, revalidates the signed
candidate/rollback/configuration bindings, and parses already-read plist bytes
through `plutil` stdin against a closed execution schema. It then returns the
stable refusal `runtime-activation-consumer-unavailable`.

It does not stage a release, invoke `launchctl`, change a plist or service,
write an acknowledgement/replay/journal/dispatch record, or move `current`.
There is no effect, platform, clock, or home injection seam in the production
consumer. `daemon install`, setup, and the worker/dashboard/web service-repair
paths retain their existing mutation denials. The separate legacy `update`
workflow retains its own guards and is not an activation authority; `--check`
remains read-only.

Full resident production activation requires a future native launchd v2
transaction. At minimum, that consumer must add exact candidate staging and
provenance, signed prior version/revision/plist/package plus loaded-and-disabled
state observed from the native manager, an activation-specific signing root,
trusted monotonic time, external monotonic compare-and-swap replay consumption,
a lifecycle lock and signed exact-keyed fsynced journal, live launchd
PID/start/executable/runtime acknowledgement, separate release-bound dispatch
authorization, pointer CAS, crash recovery at every phase, and settled-state
revalidation. It must restore the exact signed prior resident without auto-start.
Until those properties have implementation and adversarial evidence, this
command is not resident-production-ready.

The machine-readable preflight exposes each of these absent properties under
`nativeAuthority`, where every field remains `false`. Signed manifest fields
such as `prior.serviceLoaded` and `prior.plistSha256` are declarations only;
neither the preflight nor `activate` observes launchd or proves the current
pointer, live PID, executable, acknowledgement, or rollback execution.

## Authority boundary

The operator-custodied signed plan is still required to bind protected
post-merge and release-signing evidence. This command does not publish npm,
create a tag, build a release, change daemon policy, approve proposals, deploy
provider effects, or make Linux/Windows residents available. A same-UID hostile
process and coherent rollback of all local trust roots remain outside this
host-local authority boundary.
