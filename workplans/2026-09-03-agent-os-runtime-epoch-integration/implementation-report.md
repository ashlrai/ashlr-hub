# Agent OS runtime epoch integration report

Status: source implementation complete through M564; uncommitted, uncommissioned, and inactive.

Repository evidence reviewed on 2026-09-04: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub`, branch `codex/v333-iteration`, base `6d1bf2fe8a237343681049043ec50fa1b6bf307f`. The worktree contains extensive concurrent user/agent changes. This report covers the M553-M564 epoch runtime tranche and does not assess those unrelated changes as release-ready.

## Implemented runtime boundary

M553-M561 provide the immutable active-epoch core and the source, attempt, and Snapshot V2 ledgers. The first M555 source remains sequence one; M559 renewals extend it through a complete M561 lineage. M557 starts bind the current source and retain the historical source/key generation needed for terminal verification. M560 snapshots bind the exact attempt/start, source/policy, manifest/head, predecessor, producer, and key generation. Complete attempt reads join source and snapshot evidence through bounded authenticated batches instead of per-record full-ledger scans.

M562 coordinates one observation-only transaction in the durable order start, observation, snapshot, terminal. It acquires the process lease and observation lock first, uses one fixed authenticated closure, runs M563 recovery, and applies live cancellation/deadline/commit fences around publication. Existing terminal and orphan-snapshot recovery paths do not rerun observation.

M563 runs conservative source, snapshot, and attempt recovery in that order. Before and after every stage it rechecks the same authenticated epoch identity, both coordination capabilities, and the runtime stop state. It may discard an authenticated uncommitted one-link stage or unlink only the staging name for an exact already-linked two-link target. It does not publish an unlinked stage, choose a key, advance the pointer, or grant effect authority.

## M564 commissioned-trust composition

M564 is a concrete factory for M562 dependencies, not a key or anchor implementation. Construction requires:

- a fresh injected monotonic-anchor read whose canonical bytes exactly equal the active M553 head;
- an injected commissioned-trust generation with purpose-separated manifest, prepared-evidence, source, renewal, attempt, and snapshot services;
- canonical reauthentication of the M553 head, manifest, first source, and active pointer;
- a complete, current M555/M559/M561 source lineage; and
- a Snapshot V2 signer/verifier identity fixed by the active manifest.

Historical attempt and snapshot contexts come only from the authenticated complete source lineage. The public closure contains identity and lineage fields only; it returns no signer, verifier, key, or effect capability. All result authority remains observation-only with planning, execution, pointer, anchor, release, deployment, publication, credential, budget, and external mutation authority false.

### Exact runtime sessions and signer gating

Attempt/snapshot signing and signer-bearing attempt-key selection are available only during one exact M562 transaction. After it holds both locks, M562 mints a one-use token bound in a private registry to the exact trust-session object. M564 atomically consumes the token before comparing the binding and then performs full anchor, commissioning, time, core, source, and manifest admission. Caller-created, replayed, wrapped, or cross-composition tokens fail.

Every in-session closure read retains fresh anchor, commissioning-generation, current-source-time, and immutable-core checks. Attempt and snapshot signer callbacks repeat the required fences after the callback and reject argument mutation, provider drift, expiry, or reentrancy. The M561 renewal signer is the narrow exception because source renewal is an independent locked protocol; it remains surrounded by fresh anchor/trust/time/core and callback-integrity fences. Direct callers and reconstructed M557/M560 stores cannot use the retained attempt/snapshot signing material outside M562.

### Source identity and restart admission

M564 pins the renewal ledger as ordered expected filenames plus SHA-256 digests of the exact authenticated file bytes. Source additions, replacements, byte changes, unexpected entries, symlinks, or unstable reads fail closed. Link-count and ctime changes alone do not change the authenticated semantic history.

A restarted process can encounter a durable target and its two-link staging witness before composition exists. The dedicated recovery-admission reader accepts only a canonical authenticated stage/target pair that resolves through the source codec, contains equivalent records, consists of private regular files, and shares the same exact two-link inode. This path is read-only. Ordinary M561 complete reads remain strict, and only M563 may remove the stage while holding both capabilities.

## M562b local observation-isolation seam

`AgentOsObservationSandboxV1` provides authenticated bounded request/response frames and a pre/post backend-attestation gate. It binds input bytes and digest, epoch/tick/attempt/start identity, deadline, output cap, backend/policy identity, and response process identity. Its deny policy covers network, filesystem writes, child processes, workers, addons, WASI, inspector, and host IPC; filesystem reads and environment exposure are bounded. Attestation, request, and response keys are role-separated.

The contract does not install or launch a backend and is not connected to M562. Node 22 permissions are permanently `seatbelt-only`; a local permission probe denied child-process creation but still permitted network `fetch`. The host's existing `sandbox-exec` profile is not auto-qualified. `enforced` requires an injected verifier to authenticate fresh exact backend evidence before and after execution.

## Adversarial findings closed

Independent review drove fail-closed fixes for stale anchor and commissioning caches, active-pointer/core replacement, source expiry and rotation, signer/verifier mismatch, callback byte mutation, provider drift, cross-instance reentrancy, token laundering, public signer reuse, terminal replay after trust loss, multiplicative full-ledger callback scans, ctime drift after linked recovery, and the stage-before-composition restart order. Performance caching is confined to evidence already admitted inside the exact token-bound M562 session; it does not create public signing authority.

## Verification evidence

The following repository-local evidence was current after the final source changes on 2026-09-04:

- The authoritative exact M550-M564 tranche covered 17 test files and passed 346/346 tests.
- M564 focused suite: 13/13 passed. It covers the real M562 transaction, identity-only facade, absent commissioning, stale/rollback/malformed anchor, exact-session admission, reconstructed M557/M560 denial, expiry before and during runtime, signer mismatch, trust drift, cross-instance reentrancy, token laundering, callback mutation, core tamper, source rotation/key retirement, and stage-before-composition linked-source recovery.
- M561 plus shared immutable-record-store adjacent suites: 21/21 passed after the restart-admission addition.
- M562b focused suite: all 9 tests are included in the passing exact tranche.
- Repository TypeScript compilation passed. Full lint completed with zero errors and 108 pre-existing warnings. The final build completed through TypeScript, asset copy, Vite's 183-module build, dependency inventory, and build identity generation.
- Scoped Semgrep reported zero findings. Scoped Gitleaks reported zero findings across the 30 M550-M564 runtime/store/test files; the whole dirty-worktree scan still contains 81 pre-existing or unattributed findings and is not reported as clean.
- `npm audit --offline --audit-level=low` reported zero vulnerabilities from the local cache, and `git diff --check` passed. The online audit did not complete, so this is not current online registry evidence.
- The isolated M562 three-store crash-recovery regression passed in 17.084 seconds after one parallel combined run exceeded its existing 20-second cap. The timeout was not hidden by increasing that test's limit.
- A second `npm run test:ci` attempt used a 1,800,000 ms cap, completed the entire 116-file real-I/O project without an observed failure, continued through the unit project, and then reached the cap. A separate complete unit-project run passed 590 files with 1 skipped and 12,778 tests with 28 skipped. Both project lanes therefore received complete green coverage across the two runs, but neither capped combined invocation is claimed as a passing single-command `test:ci` gate.

This evidence validates source behavior, complete lane-level repository test coverage, and a local build only. It is not an immutable release artifact, deployment, commissioned provider result, daemon run, or user acceptance result. The formal single-command prepublish regression gate remains open because its serial harness budget expires before the combined summary.

## Remaining commissioning gates

1. Select and independently accept an external monotonic-anchor adapter. M564 accepts only an injected fresh read and cannot create or update an anchor.
2. Provision the purpose-separated cryptographic services, install authenticated trust roots, and define key rotation, retirement, revocation, backup, and recovery ceremonies. No key material is provisioned here.
3. Implement and commission an M562b-compatible local isolation backend, connect it to M562 through a separate reviewed change, and verify all required controls on the target host. Node permissions alone are insufficient.
4. Establish legacy/mixed-version writer exclusion, a stopped-runtime writer-upgrade protocol, and commissioned crash/contention acceptance.
5. Raise or split the serial CI budget so the formal `test:ci` command emits a final summary, then commit and independently review the exact source and produce any immutable artifact through the normal release process. Both test projects and the local build pass independently, but nothing was released.
6. Only after those gates may an explicitly authorized change add daemon/config wiring and enable a single observation lane with rollback and degraded-mode acceptance.

No external anchor, backend, key, trust root, daemon, configuration, provider, or observer lane was selected, installed, mutated, commissioned, or activated by this tranche.
