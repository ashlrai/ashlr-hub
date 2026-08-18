# Runtime Activation Authority V1 and dormant stopped consumer

> **Not to be confused with `ashlr activation` (`src/cli/activation.ts`,
> M470).** This document covers `ashlr daemon activation-preflight` /
> `ashlr daemon activate` — verifying a *release build* is safe to install.
> It remains preflight-only. The similarly-named `ashlr activation` command
> is a different system entirely: operator-granted standing authority
> (resident/install/automerge/deploy/repair/etc.) that gates what the daemon
> is *allowed* to do once it's running. See
> [`docs/RUNTIME-FLEET-ACTIVATION.md`](RUNTIME-FLEET-ACTIVATION.md) for that
> system and `docs/MILESTONE-INDEX.md` §2 for why M470 now names both an
> unrelated shipped feature and that command.

Ashlr exposes a signed, read-only resident activation admission contract and a
separate dormant macOS stopped-release consumer. The preflight remains
available on every platform. Linux and Windows refuse before filesystem or
service observation. The stopped consumer is source-complete but its compiled
production trust-root array is intentionally empty, so production execution
fails closed unless a separately reviewed source change provisions an operator
public key.

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
completion timestamps change between observations. The command then passes a
plan only to the stopped consumer.

The consumer accepts only an independently observed immutable candidate whose
signed package version and tag are exactly `3.2.7` and `v3.2.7`. It requires a
distinct canonical Ed25519 permit at
`~/.ashlr/control/activation/consumer-permits/<plan-id>.json`. The permit lasts
at most 120 seconds and binds the exact admission and plan digests, request and
trust-root identities, candidate and rollback revisions, prior `current` raw
target, prior plist digest, `loaded=false`, and the exact prior disabled bit.
Runtime flags, environment variables, or plan bytes cannot add a trust root.

Before any transaction record or release mutation, the consumer requires:

- exact-private operator control custody and an already-existing read-only
  provenance key for journal authentication;
- a healthy, explicitly engaged KILL switch that blocks provider effects;
- complete guard sources with no non-maintenance block;
- strict daemon state `running=false,pid=null`, quiescent activity, and zero
  daemon roots or PPID descendants from a bounded process observation;
- `ASHLR_HOME`, when present, exactly equal to the operating-system account's
  canonical `<home>/.ashlr` root, so activity, KILL, guard, and daemon-state
  observations cannot be redirected to another tree;
- the outward-mutation fence followed by the daemon service-lifecycle fence;
- launchd observation proving the service is unloaded and the disabled bit
  exactly matches the permit; and
- the exact signed prior plist and cooperative current-pointer identity.

The transaction durably claims the permit before effects and maintains an
HMAC-authenticated, canonical, fsynced phase journal. It replaces only the
already-stopped plist, verifies the disabled bit is unchanged, then performs a
host-local cooperative pointer CAS from the exact old symlink inode and raw
target to `releases/<candidate-revision>`. It revalidates maintenance, service,
pointer, and plist state before and after the immutable receipt. A failure
before settlement restores the exact prior pointer and plist while keeping the
service unloaded and its disabled bit unchanged. Uncertain recovery retains the
journal and reports reconciliation instead of claiming success.

On a later invocation, authenticated recovery runs before current plan
observation, permit lookup, permit expiry, or compiled-root availability. It
still requires both fences, healthy maintenance, exact unloaded/disabled state,
the HMAC-authenticated journal, and the matching immutable claim. An
unreceipted journal restores the prior pointer and plist; an exact immutable
receipt settles the candidate and removes the journal. Missing or degraded
claim/receipt evidence retains the journal and fails closed. Recovery therefore
does not mint new mutation authority and continues to work after the short-lived
permit expires or its permit directory is removed.

Every Buffer returned by the provenance-key loader is owned by the consumer and
zeroed in its own `finally` path. A recovery result carries only authenticated
journal-bound activation, candidate, admission, and plan identity; diagnostic
request, trust-root, and launch-receipt identities remain unavailable. If a
raced journal cannot be authenticated, every identity remains unavailable and
the journal is retained. Once an exact immutable receipt and exact candidate
state are observed, settlement is a committed `activated-stopped` success even
if a later response step fails; it is never reported as a contradictory blocked
activation.

This slice does **not** start, bootstrap, boot out, kickstart, enable, disable,
or acknowledge a service. It never auto-starts either candidate or rollback.
Starting a resident and accepting its runtime acknowledgement require a
separate release-bound operator permit and are outside this contract.

The pointer operation is deliberately named a **host-local cooperative pointer
CAS**. The lifecycle fences, exact inode/target comparison, atomic rename, and
post-rename verification coordinate Ashlr participants, but they are not a
kernel compare-exchange and do not exclude a hostile process running as the
same UID. A reviewed native helper with old-inode comparison remains a separate
prerequisite for stronger production authority. The local HMAC journal and
immutable records likewise do not substitute for trusted monotonic time or an
external monotonic replay/CAS service.

There is no effect, platform, clock, or home injection seam in the production
entrypoint or consumer graph. The shipped runtime adapter and its empty root
array are frozen; it exposes no registration, replacement, environment gate,
or test-only mutation API. Tests substitute that module only through Vitest's
test graph, outside `src` and outside the published package exports. The CLI
imports the consumer lazily only after rejecting an account-HOME mismatch.
`daemon install`, setup, and the worker/dashboard/web service-repair paths
retain their existing mutation denials. The legacy `update` workflow retains
its own guards and is not an activation authority; `--check` remains read-only.

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

Full resident production activation still requires a future native launchd v2
transaction. At minimum, that consumer must add exact candidate staging and
Git/tag/build/tarball-to-runtime provenance, signed prior
version/revision/plist/package plus loaded-and-disabled state observed from the
native manager, trusted monotonic time, external monotonic compare-and-swap replay consumption,
a lifecycle lock and signed exact-keyed fsynced journal, live launchd
PID/start/executable/runtime acknowledgement, separate release-bound dispatch
authorization, native pointer CAS, crash recovery at every resident-launch phase, and settled-state
revalidation. It must restore the exact signed prior resident without auto-start.
Until those properties have implementation and adversarial evidence, this
stopped selection must not be described as resident activation or production
activation completion.

## Dormant resident-start permit and exact-release ACK protocol

[`CONTRACT-M521`](./contracts/CONTRACT-M521.md) defines the separately scoped,
dynamic release-bound resident-start permit and canonical pre-dispatch ACK
frame. The ACK repeats the exact admitted release/configuration identity and
binds native-broker PID, process-start, audit-token, executable-vnode,
code-identity, launchd-generation, and challenge observations. It is evidence,
not authority: it cannot authenticate its own transport or source.

M521 has no CLI or effect consumer. Its compiled resident-start trust roots are
a frozen empty array, and its frozen production adapter always refuses with
`native-hostile-process-cas-unavailable`. It does not inspect HOME, call
launchd, spawn a process, start/install/enable a service, change `current`,
accept an ACK, unblock dispatch, or contact a provider. A protected native
broker with trusted monotonic replay/time, genuine old-inode conditional CAS,
authenticated peer-bound ACK transport, lifecycle recovery, exact stopped
rollback, and separate dispatch authorization remains the next reviewed
boundary.

The machine-readable preflight exposes these absent properties under
`nativeAuthority`. Only the separately scoped activation signing root can be
true after trust-root validation; every mutation/runtime authority field remains
false. Signed manifest fields such as `prior.serviceLoaded` and
`prior.plistSha256` are declarations in preflight. The dormant consumer
separately observes only unloaded/disabled manager state and the cooperative
pointer/plist transaction; it does not prove a live PID, executable, resident
acknowledgement, or running rollback.

## Authority boundary

The operator-custodied signed plan is still required to bind protected
post-merge and release-signing evidence. This command does not publish npm,
create a tag, build a release, change daemon policy, approve proposals, deploy
provider effects, or make Linux/Windows residents available. A same-UID hostile
process and coherent rollback of all local trust roots remain outside this
host-local authority boundary.
