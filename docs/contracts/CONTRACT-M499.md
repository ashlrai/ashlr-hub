# M499 Cortex Engineering Relay Shadow Contract

M499 is an authenticated observation lane, not an execution lane. It validates
Cortex `EngineeringAssignmentV1` envelopes and records bounded evidence without
spawning an agent, creating a proposal, mutating a repository, merging, or
deploying.

## Trust roots

- Cortex assignments use the exact `ashlr-engineering-assignment/v1` canonical
  digest and Ed25519 signature protocol. Issuer, audience, key ID, tenant,
  repository, source commit, mission bounds, and proposal-only authority are
  signed. `assignmentId` must equal `runId`.
- Hub reads `~/.ashlr/cortex-relay-trust.json` without creating or repairing it.
  The private, exact-shape policy supplies issuer, audience, organization,
  workstreams, public keys, and one absolute Locus executable path. Network
  input cannot override these values.
- Git is invoked only through a root-owned, ACL-safe `/usr/bin/git` pin with a
  scrubbed configuration environment and pre/post custody checks.
- Locus authority ignores `LOCUS_BIN` and inherited `PATH`. The configured
  executable and every parent must be root-owned and non-writable before the
  executor capability enters a whitelist-only subprocess environment.

## Non-consumability

Local `origin/*` tracking refs do not prove current GitHub state atomically.
Therefore a fully matching shadow observation returns `reason:
"observation-only"`, `accepted:false`, `consumable:false`, and
`authorityGranted:false`. No delegation scope is returned. A later activation
must add an authoritative remote consuming fence and actual write enforcement;
it may not reinterpret M499 receipts as execution or proposal authority.

## Receipts and replay

The integrated consumer has no effect callback. After signature and trusted
policy validation, it writes one immutable `claim-only` receipt before Git or
Locus observation and before any future effect could be introduced. Missing
signer, duplicate, conflict, or publication failure stops the pipeline before
those observations. Callers cannot redirect the production receipt root. The
receipt uses the Hub provenance key through a
domain-separated HMAC. Publication uses staged hard links plus file and
directory `fsync`; exact duplicates replay, conflicting uses of one assignment
identity fail closed, and corrupted records are unavailable. Receipts contain
bounded metadata only, never raw
objectives, paths, diffs, stdout, stderr, environment values, credentials, or
Locus seals.

Production activation is deliberately absent from this milestone.
