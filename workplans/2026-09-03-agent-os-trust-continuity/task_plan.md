# Agent OS trust and continuity tranche

Status: complete. Source-only and uncommissioned.

## Objective

Turn the verified local Locus observation boundary into a commissionable design without granting runtime or effect authority: privacy-safe keyed bindings, a bounded epoch/head protocol, external CAS classification, and a stopped-runtime commissioning preflight.

## Workstreams

- [x] M549: existing-key-only audience/workspace binding capability with exact purpose, policy generation, expiry, and zero authority.
- [x] M550: canonical epoch manifest/head and pure external-anchor transition classifier from the approved M546 specification.
- [x] M551: pure fresh-namespace commissioning preflight that reports caller-supplied local quiescence observations without authenticating them or creating trust state.
- [x] M552: atomic capability-to-consumer-to-ledger admission with publication-time re-verification and verified/direct lineage isolation.
- [x] Independent red-team closure across replay, role confusion, clock rollback, mixed versions, CAS ambiguity, privacy, and effect-boundary imports.
- [x] Focused and adjacent tests, typecheck, lint, build, SAST, secret scan, dependency audit, and exact worktree evidence.

## Hard boundaries

- No daemon/config/runtime integration.
- No external adapter selection or network call.
- No key generation, provisioning, trust-root installation, or credential lookup.
- No migration, deletion, commit, push, release, publication, or activation.
- Every success remains observation-only with all effect, policy, learning, promotion, release, and external-mutation authority false.
- A local HMAC or test adapter never establishes same-user rollback resistance.
- M551 is the stricter fresh-namespace preflight; stopped-runtime legacy import remains a separate future protocol.

## Exit criteria

1. Canonical formats have deterministic vectors and reject unknown/noncanonical/oversized input.
2. Binding outputs expose only keyed opaque digests and exact verification expectations.
3. Anchor results are derived from exact canonical bytes, never caller booleans.
4. Ambiguous CAS resolves only by exact reread; conflicts never mutate local active state.
5. Mixed-version and non-quiescent commissioning inputs fail closed.
6. Default dependencies report uncommissioned without creating files.
7. Static and dynamic tests prove no evidence result can authorize an effect.
