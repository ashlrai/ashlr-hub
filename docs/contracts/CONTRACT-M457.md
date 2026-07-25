# CONTRACT-M457: External Skill Artifact Firewall

Status: observation-only, fail-closed

## Objective

M457 classifies the inert contents of one canonical M446 external-skill capture
bundle and projects bounded metadata from exact skill entry files. It accepts
two reads of the bundle and two reads of its marker, requires byte-identical
canonical snapshots, recomputes their internal bindings, and returns only
fixed enums, counts, and digests.

M457 does not read quarantine storage, resolve paths, follow symlinks, execute
content, authenticate custody, establish source provenance, or authorize any
runtime action. Matching double reads prove repeatable caller-supplied bytes,
not independent reads, separate-principal custody, or present store state.

The protocol identifier is `external-skill-artifact-firewall-v1`. Its
classification policy is bound by a domain-separated `policyDigest`, and its
metadata projection policy is `skill-frontmatter-metadata-v1`.

## Input Boundary

`evaluateExternalSkillArtifactFirewall()` accepts one closed-schema record:

```ts
{
  firstBundleBytes: Uint8Array,
  secondBundleBytes: Uint8Array,
  firstMarkerBytes: Uint8Array,
  secondMarkerBytes: Uint8Array,
}
```

The record must have exactly those four enumerable data properties and an
ordinary or null prototype. Accessors, symbol keys, missing fields, and extra
fields are rejected. Each byte input must be a non-empty `Uint8Array` backed
by an `ArrayBuffer`; shared buffers, detached or invalid views, and oversized
inputs are rejected. M457 copies all four inputs before comparison or parsing.

The fixed bounds are:

- 24 MiB per bundle read and 16 KiB per marker read;
- 2,048 bundle entries;
- 256 KiB per non-directory artifact and 16 MiB total artifact bytes;
- 4,096 UTF-8 bytes per path, 255 UTF-8 bytes per path segment, and depth 12;
- canonical JSON depth 8 and 32,768 visited JSON nodes; and
- at least one bundle entry.

Callers cannot relax these limits.

## Canonical M446 Envelope

M457 requires the first and second bundle bytes to be exactly equal and the
first and second marker bytes to be exactly equal. Both payloads must decode as
fatal UTF-8, re-encode to the same bytes, parse as bounded JSON, use an exact
closed schema, and equal M446's canonical compact JSON serialization. Alternate
key order, whitespace, duplicate representation, appended bytes, or any other
semantically equivalent but byte-distinct encoding is rejected.

The bundle must contain:

- schema version 1 and object format `sha1` or `sha256`;
- non-zero, full-width commit, commit-tree, pack-tree, and entry Git OIDs for
  that object format;
- lowercase SHA-256 `packSubdirHash` and `portablePackDigest`;
- entries in strictly increasing raw UTF-8 path-byte order; and
- for every entry, exactly `path`, `kind`, `mode`, `gitOid`, `byteLength`,
  `contentDigest`, and `contentBase64`.

Paths must be relative, NFC, portable across the supported path policy, free of
empty and dot segments, `.git`, controls, Windows device names and reserved
characters, trailing dots or spaces, backslashes, and traversal. Exact and
case-folded path collisions are rejected. Every non-root parent must appear as
an earlier directory entry.

The only accepted kind/mode pairs are:

| Kind | Mode | Content |
| --- | --- | --- |
| `directory` | `040000` | zero bytes, null digest, null Base64 |
| `file` | `100644` or `100755` | canonical Base64 plus matching length and SHA-256 |
| `symlink` | `120000` | canonical Base64 plus matching length and SHA-256 |

M457 never resolves or follows a symlink. Symlink target bytes remain
quarantined content.

The marker must be canonical schema version 1 and contain exact lowercase
SHA-256 values for `captureDigest`, `bundleDigest`, `portablePackDigest`, and
`sourceIdentity`; safe non-negative file, symlink, and byte counts; and these
four literal false values:

```text
custodyAuthenticated: false
executionEligible: false
policyEligible: false
promotionEligible: false
```

M457 recomputes and requires:

- `bundleDigest = SHA-256(canonicalBundleBytes)`;
- `captureDigest = SHA-256("ashlr-external-skill-git-capture-v1\0" ||
  bundleDigest)`;
- `sourceIdentity = SHA-256("ashlr-external-skill-source-v1" and the bundle's
  object format, commit OID, commit-tree OID, pack-tree OID, and subdirectory
  hash, joined with NUL separators)`;
- exact portable-pack digest equality between bundle and marker; and
- exact file count, symlink count, and aggregate non-directory byte count.

An accepted envelope sets `canonicalCaptureConsistencyVerified: true` and
`repeatableSnapshotVerified: true`. It derives `captureReceiptDigest` as
`SHA-256("ashlr:external-skill-capture-receipt:v1\0" || canonicalMarkerBytes)`.
This verifies internal canonical consistency only. M457 does not verify that
the two inputs came from distinct reads, reopen M446 storage, authenticate the
unsigned marker, or bind a signed M451 audit receipt.

## Classification Taxonomy

Every entry is assigned exactly one of these classes:

| Class | Meaning |
| --- | --- |
| `directory` | Any directory entry |
| `skill-entry` | Exact `skills/<slug>/SKILL.md` file |
| `skill-support` | Other content below an exact `skills/<slug>/` root |
| `reference` | Content below `references/` or `skills/<slug>/references/` |
| `eval-contract` | Exact `evals/cases/<slug>.json` file |
| `eval-fixture` | Content below `evals/fixtures/` |
| `license` | Exact root `LICENSE` file |
| `documentation` | Root `README.md`, `CONTRIBUTING.md`, `evals/README.md`, or content below `docs/` |
| `instruction-surface` | Recognized agent instruction, command, persona, prompt, or rule path |
| `executable-surface` | Executable mode, executable extension, workflow/hook/script path, or skill script subtree |
| `plugin-manifest` | Root `plugin.json` or content below a recognized plugin manifest root |
| `repository-metadata` | Recognized root Git, GitHub, package, or lock metadata |
| `symlink` | Any symlink entry, without target resolution |
| `unknown` | Every path not covered by the closed taxonomy |

Classification uses this precedence:

1. symlink kind;
2. directory kind;
3. executable mode or executable path;
4. instruction path;
5. the exact path classes below, in order; and
6. unknown.

Executable classification includes mode `100755`; extensions `.bat`, `.bash`,
`.cmd`, `.exe`, `.ps1`, `.sh`, and `.zsh`; roots `bin/`, `hooks/`, `scripts/`,
`.githooks/`, and `.github/workflows/`; and
`skills/<slug>/scripts/`.

Instruction classification includes exact root `AGENTS.md` and `CLAUDE.md` plus
content under `agents/`, `commands/`, `personas/`, `prompts/`, `rules/`,
`.claude/`, `.codex/`, `.opencode/`, and `.gemini/commands/`.

The remaining exact-path order is `skill-entry`, `plugin-manifest`,
`eval-contract`, `eval-fixture`, `reference`, `skill-support`, `license`,
`documentation`, then `repository-metadata`. Earlier kind and surface rules
always win. For example, an executable `skills/<slug>/SKILL.md` is an
`executable-surface`, and a symlink at that path is a `symlink`.

Any `unknown` artifact makes classification incomplete and withholds the
result. The classifier never guesses a safe class for an unrecognized path.

## Metadata-Only Projection

Only artifacts classified as `skill-entry` are eligible for projection. The
entry must therefore be an exact regular file at
`skills/<slug>/SKILL.md` with mode `100644`; higher-precedence executable,
directory, and symlink entries never reach the projector.

M457 passes the already-verified in-memory bytes to the existing external-skill
frontmatter metadata projector. The projected metadata name must be a canonical
lowercase hyphenated slug and exactly match the path slug. Invalid frontmatter,
invalid metadata, or a name/path mismatch increments `invalidArtifacts`,
sets `projectionDigest` to null, and withholds the result as
`projection-invalid`.

For each valid eligible entry, M457 hashes only the projected name, projected
content hash, projected description hash, and artifact byte length under an
entry-specific domain. The final projection digest binds the policy digest,
eligible-entry count, and ordered projection-entry digests. Non-skill content
does not enter the projection digest.

M457 never returns projected names, descriptions, text, paths, or file
contents. Projection is metadata reduction, not semantic review, prompt
injection detection, correctness verification, usefulness scoring, or license
approval.

## Output And Privacy

A valid result contains:

- `classified|withheld` state and the fixed reason enum
  `inventory-classified|unknown-artifacts|projection-invalid|invalid-input`;
- `collecting|withheld` gate;
- policy, capture, capture-receipt, portable-pack, inventory, and projection
  digests where valid;
- artifact, unknown, eligible, and invalid counts;
- all fourteen class records in fixed taxonomy order, each with a count and
  aggregate byte count; and
- canonical-consistency and classification-completeness booleans.

The inventory digest domain-separates and binds the policy digest, capture
digest, private source identity, portable-pack digest, artifact count, and each
ordered artifact's path, kind, mode, Git OID, byte length, content digest, and
class. These private values influence the digest but are not returned.

Malformed input returns a metadata-empty `invalid-input` result: all evidence
digests are null, all counts are zero, class counts are empty, and consistency,
repeatability, and classification completeness are false.

The public result returns no raw content, Base64, path, artifact name, projected
text, source identity, symlink target, Git OID, prompt, fixture, command,
environment value, stdout, or stderr. Hashes remain linkable metadata and must
not be treated as anonymization.

## Fixed-False Authority

Every result is `authority: observation-only` and fixes all of these fields to
false:

```text
executionAuthority
exposureAuthority
routingAuthority
learningAuthority
policyAuthority
promotionAuthority
proposalAuthority
verificationAuthority
mergeAuthority
releaseAuthority
deploymentAuthority
transitionAuthority
revocationAuthority
rawContentReturned
pathsReturned
referenceExpansion
distinctReadReceiptsVerified
captureReceiptBindingVerified
custodyAuthenticated
auditReceiptBindingVerified
sourceCompletenessVerified
sourceProvenanceVerified
licensePolicyVerified
runtimeConsumerVerified
artifactNamesReturned
projectedTextReturned
sourceIdentityReturned
```

`state: classified`, `gate: collecting`, complete classification, and valid
projection metadata grant no execution, exposure, routing, learning, policy,
promotion, proposal, verification, merge, release, deployment, transition, or
revocation authority.

## Runtime Firewall And Non-Goals

M457 is an inert protocol with no filesystem, Git, network, subprocess,
environment, model, sandbox, CLI, daemon, router, dispatcher, proposal,
verification, merge, release, or deployment consumer. It does not import the
M446 runtime. Package export containment and static import guards are regression
controls, not a security boundary against code running as the same principal.

M457 does not provide:

- acquisition, capture, checkout, materialization, extraction, or execution;
- independent source completeness, publisher identity, signed commit/tag, or
  authenticated provenance;
- independent rereads, store freshness, append-only custody, same-principal
  immutability, or global replay protection;
- semantic content safety, prompt-injection analysis, dependency review,
  vulnerability review, license policy, or behavioral evidence;
- sandbox exposure, outcome attestation, routing calibration, activation,
  canarying, rollback, promotion, or revocation; or
- any conversion of M444-M456 evidence into runtime authority.

## Future Signed Integration

A later protocol may consume M457 only after it independently:

1. reopens and rehashes the exact M446 bundle and marker from authenticated,
   immutable or separately controlled custody;
2. binds a signed M451 successor receipt to the exact M446 capture receipt,
   M457 policy digest, inventory digest, and projection digest;
3. proves trusted time, verifier identity, online revocation, one-use replay
   protection, and append-only transparency;
4. verifies source completeness, license policy, semantic safety, and the exact
   candidate lineage; and
5. issues a fresh, scoped authorization for a sealed no-network sandbox before
   any content can be materialized or exposed.

That integration requires a versioned M444 report and M451 receipt successor;
it must not reinterpret unsigned v1 capture bytes or an M457 `classified`
result as signed eligibility. Production activation remains a separate,
explicitly authorized protocol with independent canary, rollback, and
revocation evidence.
