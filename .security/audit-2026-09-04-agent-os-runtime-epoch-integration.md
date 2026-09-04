# Security audit: Agent OS runtime epoch integration

Date: 2026-09-04

Scope:

- M553-M561 immutable epoch core, source, attempt, and Snapshot V2 stores.
- M562 coordinated observation-only epoch transaction.
- M562b authenticated local observation-sandbox contract.
- M563 ordered crash recovery.
- M564 commissioned-trust composition.
- Shared immutable private-record recovery admission used by this tranche.

No external anchor, cryptographic key, trust root, sandbox backend, daemon lane, configuration activation, release, commit, push, or deployment was in scope.

## Result

No open P0 or P1 source finding remains in the reviewed tranche. The implementation is source-complete and locally verified, but it is not commissioned or active. Every exposed result remains observation-only and grants no planning, execution, pointer, anchor, release, deployment, publication, credential, budget, or external-mutation authority.

## Findings closed

- Bound M562 reentrancy to canonical runtime roots so aliases cannot bypass the guard.
- Made M562 trust-session tokens one-use, module-private, exact-object-bound, and available only after both coordination locks are held.
- Rejected public, replayed, wrapped, and cross-composition session tokens.
- Gated attempt/snapshot signers and signer-bearing attempt-key resolution to the exact active M562 session; reconstructed stores cannot publish with retained signing material.
- Retained fresh anchor, commissioning-generation, time, immutable-core, source, and manifest checks around in-session callbacks rather than trusting a stale cache.
- Rejected source semantic drift with ordered expected filenames and exact content digests while allowing authenticated hard-link cleanup to change link metadata.
- Added a read-only restart admission for only an exact authenticated two-link stage/target inode pair; cleanup remains exclusively under M563's held locks.
- Added directory metadata snapshots that detect same-name inode substitution during callbacks.
- Corrected recovery stop reasons so unavailable, revoked, or hostile states are not reported as successful completion.
- Cloned and pinned M562b signed response data before verification and final attestation, closing response-mutation time-of-check/time-of-use exposure.
- Removed multiplicative full-ledger callback scans from the hot trust-composition path.

## Threat coverage

| Area | Verified treatment | Residual commissioning boundary |
| --- | --- | --- |
| Active epoch identity | Exact M553 head, manifest, source genesis, active pointer, and complete M561 lineage are reauthenticated. | External monotonic-anchor implementation and acceptance are not provided. |
| Signing authority | Purpose-separated injected services are gated to one exact lock-held runtime session. | Keys, trust roots, rotation, revocation, backup, and recovery ceremonies are not provisioned. |
| Crash recovery | M563 recovers source, snapshot, then attempt stages conservatively and never promotes an unlinked stage. | Real-host crash/contention commissioning and mixed-version writer exclusion remain open. |
| Filesystem races | Private regular files, canonical paths, stable metadata, inode/link relationships, exact bytes, and post-callback snapshots fail closed. | Same-user hostile-process resistance is not claimed. |
| Observation isolation | M562b authenticates bounded request/response frames and fresh pre/post backend attestations for a complete deny policy. | No sandbox backend is selected, integrated, or active. Node permissions alone are only defense in depth. |
| Effects | Runtime results carry literal false effect authorities and expose no signing material in the public facade. | Any future effect executor requires a separate current, revocable authority protocol. |

## Verification evidence

- Exact M550-M564 tranche: 17 test files, 346/346 tests passed.
- Focused M564 trust-composition suite: 13/13 passed.
- M557b/M561/M564 recovery-admission matrix: 43/43 passed after the final inode-substitution hardening.
- Whole-tree TypeScript typecheck passed.
- Full lint passed with 0 errors and 108 pre-existing warnings.
- Production build passed; Vite transformed 183 modules.
- Scoped Semgrep TypeScript scan of the final epoch source set: 0 findings.
- Scoped Gitleaks scan: 0 findings across 30 M550-M564 runtime-store and test files. A separate whole dirty-worktree scan reported 81 pre-existing or unattributed patterns, so repository-wide secret cleanliness is not claimed.
- `npm audit --offline --audit-level=low`: 0 vulnerabilities. This uses cached advisory data; the earlier online audit did not complete.
- `git diff --check` passed.
- A second `npm run test:ci` run used a 1,800,000 ms cap. It completed the entire 116-file real-I/O project without an observed failure, continued through the unit project, and then reached the cap. A separate run of the complete unit project passed 590 files with 1 skipped and 12,778 tests with 28 skipped. Together these runs exercised both complete project lanes without an observed failure, but neither capped combined invocation is represented as a passing single-command `test:ci` gate.

## Commissioning gates still required

1. Commit and independently review the exact source through repository ownership controls.
2. Select and independently accept an external monotonic-anchor adapter.
3. Provision purpose-separated cryptographic services and establish trust-root, rotation, retirement, revocation, backup, and recovery procedures.
4. Implement, integrate, and commission an M562b-compatible local isolation backend on the target host.
5. Establish legacy and mixed-version writer exclusion plus a stopped-runtime writer-upgrade protocol.
6. Raise or split the serial CI budget so the formal `test:ci` command can emit its final summary, then run packaged-binary and real-home crash/contention acceptance. Complete lane-level source coverage is green; the single-command prepublish gate remains open.
7. Only after those gates should a separately authorized change wire and activate one daemon observation lane with rollback and degraded-mode acceptance.

No external system or active runtime state was changed by this tranche.
