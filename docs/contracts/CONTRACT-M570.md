# CONTRACT-M570: Release successor policy evidence

Status: schema-and-verifier complete, dormant, and authority-free. No production
version policy exists in this milestone. Release and promotion workflows remain
unchanged.

## Purpose

M570 defines the closed, version-general evidence document that a later,
separately reviewed release tranche may use to bind one exact successor to one
accepted rollback. It avoids replacing the frozen 3.3.2 lane with a loose
semver or workflow-dispatch parameter while leaving that lane byte-for-byte
untouched.

The policy is protected-source evidence only. Validation does not publish,
promote, tag, install, activate, dispatch, contact npm or GitHub, inspect
credentials, or change provider effects. Those actions retain their existing,
separate human and workflow gates.

## Closed policy

The schema lives at `.github/release-policies/schema-v1.json`. A policy is one
canonical UTF-8 JSON object followed by exactly one LF and EOF, bounded to
64 KiB. `scripts/verify-release-policy.mjs` requires:

- the exact `@ashlr/hub` package, version-derived lightweight tag and tarball;
- a candidate-only dist-tag and exact protected `master` first parent;
- an older rollback with exact version, tag, revision, tree, and sha512 SRI;
- npm `latest` and prior-candidate identities equal to that rollback;
- ordered, disjoint quarantined and failed-version histories with exact tag,
  integrity, run, and absence declarations;
- the unchanged trusted-publisher repository, `release.yml` filename, release
  environment, observation-only promotion workflow, and promotion environment;
- pinned Node 24+ and npm 11+ toolchains;
- runtime-manifest v3 for the candidate, only v2/v3 for rollback, and the M568
  version-general stopped-consumer protocol; and
- an explicit evidence-only authority object with publish, promotion, install,
  activation, dispatch, and provider-effect authority all false.

The verifier rejects unknown/missing/accessor/symbol properties, sparse or
decorated arrays, duplicate versions, cross-field identity drift, noncanonical
JSON, duplicate keys, BOM, CRLF, trailing bytes, malformed UTF-8, and oversized
input. A successful receipt contains only the policy/version/tag, canonical
SHA-256, and the frozen all-false authority object.

## Frozen 3.3.2 boundary

This milestone intentionally adds none of the following:

- `.github/release-policies/v3.4.0.json` or any other production policy;
- registry SRI, release-run, provenance, acceptance, or promotion placeholders;
- package or lockfile version changes;
- release or promotion workflow changes;
- npm, GitHub, installation, service, launchd, trust-root, or provider calls; or
- imports from M520, M521, or M568 into an effectful transaction or CLI.

The synthetic fixture uses unrelated 9.x identities. The frozen 3.3.2 release
completed its own trusted-publisher, candidate, provenance, isolated acceptance,
and promotion gates at protected source
`2971c9f767c934e12fd056bf8c6dca5164ffe7d2`, with successful release run
`33932333902` and observation-only admission run `33933861238`; npm `latest` and
`candidate` then both resolved to 3.3.2. That completed immutable release does
not populate an M570 production policy or grant this milestone any effect
authority. Only a later exact-state change may add a production successor policy.

## Later workflow consumption

A future tranche may derive a policy filename solely from a validated release
tag and require tag, package, lockfile, policy, changelog, protected source,
rollback, registry, and workflow identity to agree. It must retain the current
two-parent release admission, candidate-only OIDC boundary, script-free
artifact handoff, provenance verification, and observation-only promotion
split. The final release first parent and accepted rollback are distinct
bindings; the rollback need only be the separately accepted exact ancestor.

M568 already makes candidate and rollback versions dynamic inside a signed
authority-free permit. M570 does not turn that protocol into a consumer. A
protected native broker, monotonic replay/time, genuine conditional pointer
CAS, authenticated resident acknowledgement, crash recovery, exact stopped
rollback, provisioned signing roots, and separate dispatch permission remain
mandatory before any production activation claim.
