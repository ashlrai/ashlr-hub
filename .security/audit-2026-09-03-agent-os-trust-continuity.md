# Security audit: Agent OS trust and continuity

Date: 2026-09-03

Scope:

- Hub M549 privacy-safe Locus binding capability.
- Hub M548/M552 atomic verified admission and bounded Locus continuity ledger.
- Hub M550 source-only epoch rollover and external-anchor outcome classifier.
- Hub M551 source-only fresh-namespace commissioning preflight classifier.
- Associated M547-M552 tests and integration documentation.

No persistent epoch writer, external anchor adapter, trust-root or key provisioning, daemon/config wiring, observer activation, release, or live commissioning was in scope.

## Result

No open critical, high, or medium source finding remains in the reviewed tranche. Independent integrated adversarial review found no P0 or P1 issue. All public evidence results remain structurally observation-only and grant no execution, policy, learning, merge, release, deployment, credential, budget, pointer, CAS, write, or external-effect authority.

## Threat coverage

| Area | Verified treatment | Residual boundary |
| --- | --- | --- |
| Input and canonicalization | Strict size, UTF-8, exact-key, prototype/accessor, numeric, canonical-byte, digest, and schema checks fail closed. | Live transport and producer authenticity remain uncommissioned. |
| Privacy | Audience and workspace labels are transformed with purpose-separated keyed digests; raw labels and paths are not emitted or persisted. | A host-shared HMAC does not resist compromise by the same OS user. |
| Authentication and provenance | M552 verifies M549 before M547, binds capability provenance into M548, and re-verifies at publication time. | Policy-generation truth and key lifecycle are caller-managed and not externally anchored. |
| Replay and lineage | Capability replay, source replay, forks, gaps, direct/verified role confusion, cross-chain substitution, expiry, and clock regression fail closed. | M548 is bounded to 4,096 records and has no commissioned rollover path. |
| Rollover and rollback | M550 binds exact prior manifest/head/source/snapshot/attempt state and requires post-CAS reread classification. | No durable writer, fsync protocol, authenticated external CAS, lock, or same-user rollback resistance exists yet. |
| Commissioning | M551 requires exact conservative observations and reports only `locally-quiescent-unverified`. | Caller facts are unauthenticated; stopped runtime and anchor commissioning are not proven. |
| Effects | Import scans and authority assertions prevent evidence from becoming an effect permit. | Any future runtime consumer must continue requiring a separate current authority artifact. |

## OWASP-oriented review

| Category | Disposition |
| --- | --- |
| Broken access control | Evidence and authorization remain separate; every reviewed success carries literal false effect permissions. |
| Cryptographic failures | Domain-separated HMAC/SHA-256 and timing-safe comparisons are used; key creation, storage, rotation, and external trust remain out of scope. |
| Injection | Canonical JSON parsers reject noncanonical, malformed, accessor-bearing, cyclic, unknown, and oversized input. No shell, SQL, template, or network sink was added. |
| Insecure design | Fail-closed state machines, exact lineage, replay prevention, mixed-version rejection, and post-CAS reread are covered by adversarial tests. |
| Security misconfiguration | No default-enabled runtime, config flag, key, adapter, or trust root was added. |
| Vulnerable components | No dependency was added or changed by this tranche. Cached npm advisory data reports zero vulnerabilities; online refresh did not complete. |
| Authentication failures | Capabilities are bounded by purpose, policy generation, audience, workspace, lineage, and time, but do not claim user or producer identity authentication. |
| Integrity failures | Exact canonical bytes, keyed admission records, prior-record links, manifest/head digests, and CAS reread classification protect the source-level boundary. |
| Logging/monitoring failures | No sensitive value is returned or intentionally logged. Live monitoring and alerting remain unimplemented. |
| SSRF | No network client or external adapter implementation was added. |

## Verification evidence

- Final M547-M552 focused matrix: 6 files, 116/116 tests passed.
- Broader continuity matrix before scanner-only malformed-fixture cleanup: 10 files, 196/196 tests passed; the three adjusted fixture files then passed 64/64.
- Whole-tree TypeScript typecheck passed.
- Production build passed with 183 web modules.
- Full lint passed with 0 errors and 108 pre-existing warnings; final scoped lint passed with zero warnings.
- Semgrep final scan: 210 rules across 10 exact source/test files, 100% parsed, 0 findings. Three initial test-only duplicate-key-fixture matches were eliminated and the scan rerun.
- Exact-tranche Gitleaks scan: 0 findings. A separate repository-wide scan reports 81 existing patterns, primarily intentional secret-redaction test fixtures and generated output, outside this tranche.
- `npm audit --offline --audit-level=low`: 0 vulnerabilities across 434 dependencies. Two online refresh attempts stalled for more than 60 seconds and were terminated, so this is a cached-advisory result rather than a fresh registry assertion.
- Existing native modules are Rollup's platform binary and `fsevents`; no native binary was introduced by this tranche.
- The central security findings tracker path was absent, so no external tracker was mutated.

## Commissioning gates still required

1. Commit and independently review the exact source through repository ownership controls.
2. Implement a durable epoch writer with fsync ordering, locks, authenticated full-state verification, bounded storage, and deterministic recovery after every crash point.
3. Commission an authenticated monotonic anchor and test conflict, timeout, ambiguity, rollback, and same-user attack cases against the real adapter.
4. Add a stopped-runtime writer-protocol upgrade and fresh-namespace procedure that excludes legacy binaries and writers.
5. Provision and rotate keys through a reviewed lifecycle; anchor policy generations and avoid one host-shared key as the final isolation boundary.
6. Implement M548 rollover before capacity and run packaged-binary, real-home, contention, stale-writer, and live degraded-mode acceptance.
7. Keep live runtime consumers behind separately authenticated, current, revocable authority artifacts; observation success must never authorize effects.

No commit, push, release, publication, key provisioning, external mutation, observer activation, or commissioning occurred.
