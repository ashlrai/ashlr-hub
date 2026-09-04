# Security audit: Locus workspace identity boundary

Date: 2026-09-03

Scope:

- Locus V1 Rust producer, read-only report path, CLI transport, and canonical fixtures in the isolated `codex/locus-workspace-identity-v1` worktree.
- Hub M547 strict consumer and M548 bounded lineage ledger.
- No release artifact, installed binary, live Locus home, trust-root commissioning, scheduler integration, provider call, or external effect was in scope.

## Result

No open critical, high, or medium source finding remains in the reviewed boundary. Residual limitations are explicit and fail closed:

| Severity | Residual limitation | Current treatment |
| --- | --- | --- |
| Low | Audience and workspace digests are caller-supplied. Syntax and exact expected values are enforced, but a digest is not proof that a privacy-safe keyed minting process produced it. | Locus help and Hub documentation label the values caller-asserted; future commissioning must mint them through a trusted capability. |
| Low | Locus source commit is descriptive and the content digest is unkeyed. | Every receipt and Hub projection reports local-unverified origin, false truth/release provenance, false trust, and zero authority. |
| Low | The Hub lineage ledger uses a host-shared HMAC and bounded local storage. | It claims neither verifier isolation, same-user tamper resistance, nor rollback protection; capacity degrades with `rollover-unimplemented`. |
| Info | The exact fixtures are source-worktree samples, not immutable released artifacts or live workspace acceptance. | Producer, CLI, consumer, and ledger remain uncommitted and uncommissioned. |

## Closed findings

- Hub requires exact caller-owned audience, workspace, sequence, and predecessor bindings before accepting canonical producer bytes.
- Before local sealing, the Hub ledger reconstructs the canonical Locus payload and independently verifies its domain-separated source digest; changing an audience or source digest and recomputing only the Hub envelope digest fails closed without creating a store.
- Rust and TypeScript validators share the audited Locus 0.5.x version language and reject overlong or incompatible versions.
- Both sides reject unreachable ready/pin/anchor/workspace/approval combinations, including ready without an MCP registration.
- Raw CLI JSON writes exact canonical bytes without a trailing newline; Hub consumes the exact CLI-path fixture with null optional adapter metadata as well as the synthetic non-null vector.
- The CLI observation path opens existing state and uses read-only doctor, runtime, approval, credential-migration, and credential-resolution inspection; it does not initialize a home, key, session, approval probe, or freeze state.
- The Hub ledger enforces per-audience/workspace genesis, exact sequence, source predecessor, local record predecessor, replay/fork/gap rejection, freshness at the actual publication boundary, private storage, authenticated records, bounded reads, and confirmed transaction-lock release.
- Read-time freshness enforces both expiry and future skew. Successor producer and acceptance timestamps must be monotonic; visible clock rollback is reported as `clock-regression` while the broader same-user rollback-resistance claim remains false.
- All producer, consumer, ledger, and nested effect flags remain false; reported Locus posture never becomes planning, execution, policy, promotion, merge, release, deployment, publication, credential, budget, learning, or external-mutation authority.

## Verification evidence

- Independent adversarial review found and drove closure of binding confusion, CLI newline incompatibility, production-fixture coverage, impossible posture acceptance, and producer/consumer version divergence.
- Final independent re-review found no remaining P0, P1, or P2 in M547/M548 or Rust parity; the exact Hub boundary passed 29/29 tests.
- Exact final Locus validation passed 485 core tests and 62 CLI tests, formatting, and Clippy across both packages with warnings denied.
- Semgrep OWASP/TypeScript scan: 0 findings across fourteen changed Hub observation, store, consumer, and ledger modules.
- Gitleaks: 0 findings across thirteen explicit Hub source/test files and nine explicit Locus source/fixture files, including untracked files.
- Hub `npm audit --audit-level=low`: 0 vulnerabilities. Locus adds no Cargo dependency; `cargo-audit` is not installed, so no Rust advisory-database claim is made.
- No new native binary was introduced.

## Commissioning gates still required

1. Commit and independently review each repository through its own ownership process.
2. Build immutable release artifacts and prove source-to-artifact provenance.
3. Replace naked digest inputs with a scoped, privacy-safe binding-mint capability.
4. Add authenticated transport/origin if Locus posture is ever used beyond local unverified display evidence.
5. Implement bounded ledger rollover plus an external monotonic/transparency anchor before claiming same-user rollback resistance.
6. Run stopped-runtime, packaged-binary, real-home read-only, and live degraded-mode acceptance before enabling any scheduled ingestion.
