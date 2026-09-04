# Task Plan: Agent OS runtime epoch integration

## Goal

Integrate epoch-aware source, snapshot, and attempt records into a durable authenticated runtime boundary without choosing an external anchor, provisioning keys, activating the daemon, or converting observation evidence into effect authority.

## Phases

- [x] Phase 1: Inspect branch, dirty-worktree ownership, Entire state, prior plans, and current epoch contracts.
- [x] Phase 2: Map integration seams, persistence invariants, and collision-free implementation slices in parallel.
- [x] Phase 3: Freeze the producer, durable ledger, and closure-verifier contracts.
- [x] Phase 4: Implement source/attempt/snapshot epoch persistence and runtime orchestration.
- [x] Phase 5: Add crash, replay, tamper, stale-context, concurrency, and authority regressions.
- [x] Phase 6: Run independent adversarial review and security verification for M553-M564.
- [x] Phase 7: Run focused, adjacent, typecheck, lint, build, and repository regression coverage. The exact M550-M564 tranche, complete 116-file real-I/O project, complete unit project, typecheck, lint, build, scoped security scans, offline dependency audit, and whitespace gate are complete. The formal combined `npm run test:ci` command still requires a larger or split runtime budget before it can be called a passing prepublish gate.
- [x] Phase 8: Publish the exact source implementation and remaining commissioning boundary in the architecture and implementation handoff.
- [x] Phase 9: Integrate guarded cross-ledger stage recovery and a production authenticated trust composition.
- [x] Phase 10: Define and verify an honest local observation-sandbox commissioning boundary.

## Key Questions

1. Can M555 records be persisted using the existing exact-private stores without weakening their canonical or authenticity guarantees?
2. Which component owns authenticated active-epoch closure, and how is time-of-check/time-of-use drift prevented?
3. How can the observer consume epoch records while remaining default-off and incapable of granting execution authority?
4. Which runtime contracts can be completed before selecting a hardware-backed or remote transparency anchor?

## Decisions Made

- Keep the external anchor behind an injected interface; this tranche will not select or commission an implementation.
- Preserve all existing dirty work and allocate new milestone files or surgically extend only the required untracked Agent OS modules.
- Treat persisted local records as evidence caches, never as the authoritative epoch commit point.
- Do not wire daemon activation, provision keys, publish packages, commit, push, or mutate external systems.
- Reuse the M550 raw source genesis as the single epoch-one sentinel; M555 retains its exported name only as a compatibility alias.
- Separate M553 immutable-core verification from bounded runtime-owned ledger-root validation. Preparation stays strictly empty; active reads admit only the exact versioned ledger layout.
- The runtime composition root, not a public record caller, owns verifier selection and closure construction. Caller-provided Boolean authentication is never sufficient.
- Add a Snapshot V2 contract before any successful epoch terminal can be accepted.
- Add a separately versioned sequenced source contract for renewals inside an epoch; M555 Source V2 remains the first-source contract.
- Persist attempt start before observation, Snapshot V2 before successful terminal, and terminal last. Recovery may use only exact authenticated persisted artifacts.
- Treat Node 22 permissions as defense in depth only. An M562 sandbox result may be `enforced` only after a separately trusted verifier authenticates a fresh backend/policy attestation proving every required isolation control before and after the run.
- Compose recovery in source, snapshot, then attempt order. Recheck the fixed authenticated epoch identity and both coordination capabilities before and after each stage; never promote an unlinked stage into a record.
- Build the M564 closure only from exact M553 artifacts, a fresh exact anchor-head read, a complete current M561 source lineage, commissioned purpose-separated cryptographic services, and the manifest-fixed Snapshot V2 identity. The public facade exposes identities, not signing material.
- Gate attempt/snapshot signing and signer-bearing attempt-key resolution behind a one-use token minted by M562 after both locks are held, bound to the exact trust-session object, and atomically consumed. Source renewal is a separate narrowly fenced M561 capability.
- Fingerprint source history by ordered canonical record filename and exact content. A dedicated read-only admission may recognize only an authenticated two-link stage/target pair so a restarted process can construct M564 before M563 cleanup; ordinary M561 reads remain strict and the factory performs no cleanup.

## Errors Encountered

- The first parallel inspection script referenced an undefined loop variable while formatting tool results. The script failed before repository actions; it was corrected and rerun successfully.
- The first literal M550/M555 genesis regression vector copied an incorrect expanded hash from an abbreviated architecture note. The equality assertion against the actual M550 export passed; the literal was replaced with the repository-computed canonical value and rerun.
- An initial M559 future-skew test used a timestamp only 30.001 seconds beyond issuance, which was correctly inside the 60-second allowance. The fixture was moved beyond the actual limit.
- An M559 typecheck briefly observed a concurrent agent's unused import while M558 was still being authored; the completed M559 tree subsequently passed typecheck.
- The first M553 three-ledger layout patch had one extra closing parenthesis in the new source-directory identity guard. The transform gate caught it immediately; the syntax was corrected before tests continued.
- A progress-only `wc` command used unmatched zsh globs for not-yet-created M560 files and exited before reading anything. It was replaced with `rg --files` filtering; no repository state changed.
- The first patch insertion for the M555 unsorted-principal regression used a test title copied from M559 and found no matching context. The exact M555 title was located with `rg`; the patch then applied and the focused suite passed.
- An integrated M550-M560 run overlapped the then-in-progress M560 start-receipt provider contract migration and observed 11 transient `start-receipt-unavailable` failures while the other 255 tests passed. That migration completed, and the later authoritative M550-M564 run passed 346/346.
- `npm audit --json` produced no response for more than 60 seconds, so the hung read-only network check was interrupted. The offline audit later reported zero vulnerabilities; current online registry evidence remains unavailable.
- The first scoped M562b Semgrep invocation combined the remote `auto` ruleset with metrics disabled, which Semgrep refuses before scanning. It was rerun with the explicit TypeScript ruleset and passed with no findings.
- Independent M564 review found and closed stale-session cache, callback-amplification, public-signer, token-laundering, source-currentness, and restart-order recovery gaps. The final session keeps fresh anchor/trust/time/core fences, binds the performance exception to an exact one-use M562 token, and denies reconstructed out-of-session M557/M560 writes.
- The first repository-wide `npm run test:ci` attempt reached the harness's 900,000 ms cap. A second 1,800,000 ms attempt completed the entire 116-file real-I/O project without an observed failure and progressed through the unit project before its cap. A separate complete unit run passed 590 files with 1 skipped and 12,778 tests with 28 skipped. Coverage is complete across the two lanes, while the capped combined command remains incomplete rather than passed.

## Status

**Source implementation, documentation, and lane-level repository verification are complete through M564.** The exact 17-file M550-M564 tranche passed 346/346 tests; the complete real-I/O and unit projects ran green across two invocations; and typecheck, lint, build, scoped Semgrep, scoped Gitleaks, offline dependency audit, and whitespace checks completed. The formal serial `npm run test:ci` command still reaches its runtime cap before a combined summary and is not claimed as passed. This is not a commissioned runtime: external anchor acceptance, key/trust-root provisioning, an enforced sandbox backend, legacy/mixed-writer exclusion, stopped-runtime upgrade evidence, daemon/config activation, commit/review, and a final single-command prepublish gate remain outstanding.
