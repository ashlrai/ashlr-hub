# CONTRACT-M447: External Skill Custody Statement Verification

## Objective

M447 verifies a bounded Ed25519 statement under one explicitly supplied policy
over an exact successful M446 capture tuple. It introduces no policy-approval
root, signing key, network client, filesystem reader or writer, sandbox runner,
trial-admission path, or production consumer.

A successful result proves only that the selected public key in the supplied
policy verified the canonical statement. It does not authenticate the policy,
the signer as an approved custodian, the M446 capture's origin, current object
availability, retention enforcement, storage implementation, semantic safety,
trial readiness, or execution isolation.

## Verifier-Only Boundary

`verifyExternalSkillCustodyAttestation()` accepts one closed, structured-cloned
record containing:

- an exact completed M446 `captured|replayed` result;
- a signed custody statement; and
- a supplied policy containing 1-16 sorted Ed25519 public keys.

The completed M446 result carries `captureReceiptDigest`, the
domain-separated digest of the exact canonical bytes M446 published as its
commit-last receipt. M447 accepts no separate receipt-reference input and does
not infer legacy references. The signed statement must bind exactly the digest
on the completed M446 result. A cross-stage mismatch is
`capture-receipt-mismatch`; an old caller-supplied reference is an unknown input
field and fails as `invalid-input`.

M447 still does not read the receipt from stable storage. A caller that
fabricates an entire internally consistent M446 result and signed statement can
still produce a self-consistent story. The bridge removes caller-selected
reference substitution; it does not authenticate custody, so the result keeps
custody unauthenticated.

The module has no private-key type, key-generation function, signing function,
ambient trust-store lookup, environment-variable input, path input, URL, fetch,
child process, or storage API. Its canonical-payload and public-key-id helpers
exist only for interoperable verification and cannot produce a signature.

M447 is not exported from Ashlr's runtime package API. Its types are available
from `@ashlr/hub/types`. A TypeScript-AST import guard permits only type-only
edges from M446 and the public type barrel and rejects runtime imports, exports,
`require`, and literal dynamic imports elsewhere in `src`.

## Supplied Policy

Every supplied policy is closed-schema and binds:

- schema and protocol version;
- a bounded policy version;
- 1-16 unique keys sorted by derived key identity;
- exact canonical DER SPKI public-key bytes;
- fixed `ed25519` algorithm and `custody-statement-signer` key purpose;
- opaque custody-authority and retention-policy digests; and
- canonical inclusive signing windows.

Every policy key is parsed and validated, including unselected keys. Re-exported
DER must byte-match the input, rejecting accepted-prefix encodings with trailing
bytes. `keyId` is independently recomputed as a domain-separated SHA-256 digest
of those exact bytes. RSA, EC, malformed, relabeled, duplicate, or unsorted keys
fail closed.

The complete ordered policy is hashed and the statement binds that digest. This
provides deterministic policy-generation identity, not organizational approval.
Ashlr does not know who approved the policy, whether its opaque authority digest
maps to a real provider, or whether the policy was current when presented.

The selected key must be valid at `issuedAt`. The retention period may extend
beyond the signing-key window because it is a signed claim about external
storage, not continued key authorization. M447 has no historical policy archive,
revocation feed, certificate chain, or rotation authority.

## Signed Statement

The canonical signed payload binds:

- the M446 capture, canonical capture-receipt, bundle, portable-pack, and
  source digests;
- file, symlink, and byte counts;
- opaque object-version, custody-authority, and retention-policy digests;
- fixed `external-retention-lock` and `canonical-bundle-rehashed` claims;
- canonical issue and custody-expiration times;
- exact supplied-policy digest, key identity, role, and algorithm; and
- fixed `workflowAuthority:none` and false execution, policy, and promotion
  eligibility.

M447 checks that `captureDigest` is the M446 domain-separated digest of the
claimed `bundleDigest` and that every public M446 metadata field matches. This
is consistency checking against caller inputs; it is not a local stable reread
of the M446 receipt or captured objects.

The issue time may be at most 60 seconds in the future. The retention claim must
be active, positive, and no longer than 366 days. Signatures and public keys use
strict unpadded canonical base64url. Unknown fields, accessors, uncloneable or
cyclic graphs, sparse/subclassed/named-property arrays, non-canonical timestamps,
policy drift, expired statements, and signature mismatch fail closed.

## Result And Authority

A successful result is named `statement-signature-verified` and reports:

```text
mode: external-custody-statement-verification
authority: observation-only
captureReceiptDigest: <exact M446-derived identity>
statement.signatureVerified: true
statement.keyMatchedSuppliedPolicy: true
statement.trustPolicyApprovalVerified: false
custody.authenticated: false
custody.bundleIntegrity: signer-claimed-rehash
custody.retentionClaim: unexpired-signer-claim
custody.liveAvailabilityVerified: false
custody.replayProtectionVerified: false
custody.transparencyVerified: false
executionEligible: false
policyEligible: false
promotionEligible: false
```

All four M446 blockers remain, including
`capture-custody-authentication-required`. A withheld result returns no
caller-controlled digest or timestamp and also retains all four blockers.

## Privacy

Inputs and outputs contain fixed enums, timestamps, counts, public keys, and
digests only. They cannot contain repository paths, filenames, symlink targets,
blob bytes, pack text, prompts, fixtures, commands, diffs, stdout/stderr,
environment values, credentials, or model prose. Public keys and digests are
linkable metadata and must not enter learning ledgers by default.

## Deliberate Omissions

M447 does not provide or claim:

- approved trust-policy distribution, hardware-backed key custody, provider
  identity, certificate chains, revocation, or historical policy validation;
- live remote reads, write-once enforcement, deletion audit, availability
  monitoring, replay prevention, or append-only receipt transparency;
- a trusted-storage reread or independent proof for the M446 receipt bytes;
- materialization, disposable no-network sandboxing, exact mount verification,
  exposure receipts, deterministic outcome evidence, or trial execution;
- structural or behavioral safety, license review, usefulness, promotion, or
  runtime routing, proposal, learning, verification, or merge authority; or
- protection after compromise of the signer, supplied policy, verifier binary,
  root, kernel, clock, or cryptographic implementation.

Before a real paired trial, Ashlr still needs verifier-owned trust distribution,
trusted canonical capture-receipt admission, append-only transparency and
replay controls, live custody revalidation, a disposable no-network sandbox,
exact exposure verification, and separately signed deterministic outcomes.

## Verification

Focused tests cover exact statement verification without custody elevation,
M446-derived capture-receipt identity, legacy-reference rejection, replay and
cross-stage mismatch behavior, bundle-domain binding, every policy key, canonical DER,
non-Ed25519 keys, policy generations, signing windows, future/expired/overlong
claims, metadata mismatch, signature corruption, canonical base64url, closed
schemas, sparse and named-property arrays, stateful input cloning, output
privacy, deterministic vectors, and the runtime import firewall. Tests generate
ephemeral Ed25519 keys; production code contains no signer.
