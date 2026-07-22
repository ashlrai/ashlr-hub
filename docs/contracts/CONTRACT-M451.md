# M451 - Authenticated External-Skill Audit Receipts

## Status

Observation-only contract. No runtime consumer, signer, trust root, routing
authority, model exposure, learning authority, or promotion authority ships in
this milestone.

## Problem

M444 produces deterministic quarantine evidence, and M446/M449 bind an exact
Git-object capture. A later exposure verifier must not accept a caller-built
M444-shaped object: a caller could fabricate section, count, or routing fields.
M451 therefore authenticates exact canonical M444 report bytes under a
repository-owned verifier trust policy.

## Internal Verification Boundary

```ts
verifyTrustedExternalSkillAuditReceipt({
  reportBytes,
  receiptBytes,
  selectedSkillName,
})
```

The input cannot contain a public key, trust policy, clock override, prior
verdict, report object, path, source bytes, or signature-verification result.
Extra fields fail closed.

The function is verifier-only and is not exported from the package runtime.
An AST import firewall permits only curated type exports from `src/api/types.ts`;
adding a CLI, daemon, API, or other runtime consumer requires a later contract.

M444 owns `canonicalExternalSkillAuditReportBytes()`. It validates the bounded
report schema and emits sorted-key, minified UTF-8. M451 rejects any byte-level
change, including whitespace and key reordering. The receipt binds the report,
pack, portable pack, selected skill and content hash, M444 policy digest, trust
policy generation, verifier role, key identity, and validity window.

## Trust Model

`external-skill-audit-trust-roots.ts` is the only trust-policy source. Requests
cannot extend it. Production intentionally ships generation zero with an empty
root set, so otherwise valid receipts return `trust-root-unprovisioned`.
Provisioning a real independent Ed25519 verifier is a separate reviewed security
and deployment decision.

The verifier contains no signer, private-key type, key generation, environment
lookup, filesystem lookup, network lookup, or mutable trust-policy API. Audit
verifier key IDs and signature payloads use domains separate from M447 custody
statements, preventing cross-role key relabeling.

## Authority

Authenticated results still return:

```json
{
  "authority": "observation-only",
  "executionEligible": false,
  "policyEligible": false,
  "promotionEligible": false,
  "replayProtectionVerified": false,
  "transparencyVerified": false,
  "onlineRevocationVerified": false,
  "trustedClockVerified": false,
  "independentVerifierPrincipalVerified": false,
  "captureReceiptBindingVerified": false
}
```

Exact replay is idempotent, not one-use. Online revocation, transparency,
independent-principal custody, a production signer, exact M449 custody reread,
sealed context projection, hostile-content isolation, model exposure, and
outcome attestation remain mandatory later boundaries.

## Privacy

Verification results contain bounded identities and counts only. They never
return report bytes, receipt bytes, signatures, prompts, descriptions, fixture
contents, paths, stdout/stderr, argv, environment, credentials, or model output.

## Acceptance

- Empty production roots always withhold.
- A test-only code-owned root authenticates exact canonical M444 bytes.
- Report, receipt, selected-skill, policy, generation, role, key, and time
  substitutions fail closed.
- Custody-role key IDs cannot authenticate audit receipts.
- Raw external content and signature bytes do not enter verification results.
- No CLI activation, daemon, CI, merge, or deployment behavior changes.

The only package-resolution change is intentional: `marked` is pinned from the
compatible range `^17.0.0` to exact `17.0.0`, because parser semantics are part
of the authenticated M444 policy identity.
