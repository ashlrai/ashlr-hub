# Runtime Activation Authority V1

> **Not to be confused with `ashlr activation` (`src/cli/activation.ts`,
> M470).** This document covers `ashlr daemon activation-preflight` /
> `ashlr daemon activate` — verifying a *release build* is safe to install.
> It remains preflight-only; nothing below changed on 2026-08-16. The
> similarly-named `ashlr activation` command is a different system entirely:
> operator-granted standing authority (resident/install/automerge/deploy/
> repair/etc.) that gates what the daemon is *allowed* to do once it's
> running. See
> [`docs/RUNTIME-FLEET-ACTIVATION.md`](RUNTIME-FLEET-ACTIVATION.md) for that
> system and `docs/MILESTONE-INDEX.md` §2 for why M470 now names both an
> unrelated shipped feature and that command.

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

The trust-root file contains two exact, disjoint public-key sets: dedicated
activation-authority Ed25519 keys under the
`ashlr:runtime-activation-authority-key:v1` domain, and release-evidence keys
through the existing Runtime Release Evidence Trust Root V2 schema. A key ID
cannot occur in both sets. The root also fixes the minimum policy epoch and the
closed activation-mode set. Private keys and credentials never belong in this
directory, the repository, logs, or preflight output.

## Signed activation manifest

The canonical Ed25519-signed manifest binds both candidate and rollback to:

- exact revision, Git-tree, release-tag, build-binding, and packaging
  declarations;
- unsigned release-manifest digest and signed evidence envelope identities;
- package tarball SHA-256;
- dependency inventory and immutable runtime-tree identities;
- interpreter and service-descriptor SHA-256;
- exact service invocation and canonical policy identity;
- operator evidence trust-root identity and evidence signing key;
- policy epoch, activation mode, issuance, expiry, and unique plan ID; and
- a distinct independently packaged rollback release.

The preflight verifies the activation signature only with the distinct
activation-authority key set. It composes M440 manifest verification, M441 release-evidence signature verification,
M442 closed-byte launch revalidation, and M488 candidate/rollback pair
verification. Tarballs and service descriptors are independently hashed from
immutable, single-link files. Artifact paths must be absolute and canonical,
and every bundle path component must be canonical,
current-user-owned, non-writable, and free of symlink substitution; native ACL
checks apply on Windows. Candidate and rollback must have distinct bundle paths,
revisions, trees, manifests, tarballs, and runtime-tree identities.
The signed plan also binds operation, platform, exact HOME, configuration,
package version and tag declarations, build declaration, the prior plist and
unloaded-state declarations, the release root and `current` pointer. The
machine-readable result keeps these under `signedDeclarations`, separate from
the bytes actually re-read under `observedEvidence`. In particular, this
preflight does not prove Git object provenance, tag publication, build
provenance, independent packaging, or tarball-to-runtime-tree equivalence. The
validity window is checked before and after artifact observations, and the
operator trust root is re-read and compared before admission completes.

## CLI

```bash
ashlr daemon activation-preflight \
  --request ~/.ashlr/control/activation/plans/<plan-id>.json \
  --json
```

The command is read-only. `preflightPassed:true` means the signed declarations
and directly observed byte identities passed this limited admission contract;
it does not mean activation is permitted or production-ready. Every result
keeps install, launch, start, deploy, rollback, and activation false. The
domain-separated `admissionDigest` binds the canonical request, canonical
operator trust root, signed plan, and time-independent candidate and rollback
observation identities.

## Explicit activation

```bash
ashlr daemon activate \
  --request ~/.ashlr/control/activation/plans/<plan-id>.json \
  --authorize <admission-sha256> \
  --confirm <admission-sha256>
```

The command derives HOME from the operating-system account database, rejects a
mismatched `HOME` environment value, uses the actual host platform, requires
two exact copies of the admitted admission digest, repeats complete request,
trust-root, candidate, and rollback observation, and returns only the final
verified request. It revalidates the signed candidate, rollback, and
configuration bindings, and parses both already-captured plist byte strings
through `plutil` stdin against a closed execution schema with fixed
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Raw launch-receipt digests are returned as
diagnostic evidence but excluded from the stable admission digest because their
completion timestamps change between observations. The command then returns
the stable refusal `runtime-activation-consumer-unavailable`.

It does not stage a release, invoke `launchctl`, change a plist or service,
write an acknowledgement/replay/journal/dispatch record, or move `current`.
There is no effect, platform, clock, or home injection seam in the production
consumer. `daemon install`, setup, and the worker/dashboard/web service-repair
paths retain their existing mutation denials. The separate legacy `update`
workflow retains its own guards and is not an activation authority; `--check`
remains read-only.

## Dormant activation-bound handoff observation

The packaged runtime also contains the dormant
[`CONTRACT-M515`](./contracts/CONTRACT-M515.md) proof-child observer. Given an
exact M502 admission digest, it retains the admitted candidate package,
dependency, launcher, and interpreter descriptors through one canonical
EOF-framed acknowledgement, repeats M502 observation after the ACK, and proves
the finite proof process group is dead before success. It persists only a
metadata-only cooperative replay claim.

M515 has no CLI, daemon, service, setup, or activation-transaction consumer. It
does not execute `bin/ashlr`, the daemon argv, or the launchd descriptor; it
does not call launchd or contact a provider/model. Every lifecycle, dispatch,
effect, rollback, and activation permission remains false. Its host-local claim
is not an external monotonic replay authority and its receipt is not resident
runtime acknowledgement.

Full resident production activation requires a future native launchd v2
transaction. At minimum, that consumer must add exact candidate staging and
Git/tag/build/tarball-to-runtime provenance, signed prior
version/revision/plist/package plus loaded-and-disabled state observed from the
native manager, trusted monotonic time, external monotonic compare-and-swap replay consumption,
a lifecycle lock and signed exact-keyed fsynced journal, live launchd
PID/start/executable/runtime acknowledgement, separate release-bound dispatch
authorization, pointer CAS, crash recovery at every phase, and settled-state
revalidation. It must restore the exact signed prior resident without auto-start.
Until those properties have implementation and adversarial evidence, this
command is not resident-production-ready.

The machine-readable preflight exposes these absent properties under
`nativeAuthority`. Only the separately scoped activation signing root can be
true after trust-root validation; every mutation/runtime authority field remains
false. Signed manifest fields
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
