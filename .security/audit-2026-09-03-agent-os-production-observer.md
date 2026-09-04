# Security Audit: Agent OS Production Observer and Ecosystem Contracts

**Date:** 2026-09-03 | **Auditor:** Codex | **Repository:** `@ashlr/hub` (TypeScript/Node)

## Executive summary

No unresolved critical or high-severity vulnerability is currently confirmed in the scoped Agent OS observer and external-contract tranche. Independent adversarial review found and remediated authority confusion, fabricated tick provenance, repeated-source receipt exhaustion, cancellation ownership and retry accounting, crash-resume, mid-attempt source revocation, cross-ledger snapshot loss, replay misbinding, deadline overrun, signer-role confusion, and mutable digest-bound artifact defects before activation. The principal residual is architectural: bounded local ledgers and same-user HMAC checkpoints do not establish indefinite service or rollback resistance.

**Risk rating:** Medium until bounded rollover and an external monotonic anchor exist
**Open findings:** 0 Critical, 0 High, 1 Medium, 1 Low/Informational

Scope is source and local test evidence only. No observer keys were provisioned; no daemon observer was enabled; no package was committed, published, installed, promoted, or deployed; and no model, provider, repository, publication, credential, or external effect was authorized.

## Findings

### Remediated: structural daemon authority could be caller-forged

**Prior severity:** High

The daemon tick boundary accepted a structurally valid activation-scope object from an in-process caller. That shape was compatibility data, not an unforgeable grant, so a future Agent OS bridge could have confused evidence with runtime authority.

The production path now requires an opaque process-resident capability carried in a `WeakMap` and minted only at the daemon authority boundary. Legacy structural input remains readable for compatibility but cannot authorize a production tick. Standing grants are rechecked on every tick and Agent OS observation keys are not activation keys.

### Remediated: one principal could occupy every observation role

**Prior severity:** High

The first policy normalized uniqueness by role plus principal. One principal could therefore register separate keys as source observer, evidence-index observer, and outcome observer while the resulting bundle reported independent verification.

Policy normalization now requires principal uniqueness across all roles. Verification additionally rejects outcome signer principal, key, or public key reuse against source and evidence signers and requires the outcome observers demanded by the contract to be distinct. Same-principal multi-role adversarial fixtures fail closed.

### Remediated: attempt ledger could exhaust on an unchanged source

**Prior severity:** High availability risk

Every eligible daemon tick originally wrote a start and terminal attempt receipt even when the current source bundle compiled to an existing snapshot. At the normal five-minute cadence, the 8,192-record ledger could stop observation after 4,096 unchanged ticks; at a five-second idle cadence, exhaustion could occur in hours.

The scheduler now classifies only a complete authenticated attempt ledger, suppresses already-successful exact source digests, binds starts to the source digest, limits failed-source retries with explicit backoff, and proves that one successful observation for each of the source registry's maximum 4,096 bundles fits the paired 8,192-receipt capacity. Capacity exhaustion is a visible degraded state rather than a silent pass.

### Remediated: cancellation completion preceded confirmed child exit

**Prior severity:** Medium

The first escalation path sent `SIGTERM`, later sent `SIGKILL`, and then cleared the active child and resolved completion without a `close` event. A delayed or failed kill could permit overlap and make shutdown status untruthful.

Termination no longer manufactures exit. The scheduler retains ownership and blocks overlap until `close` confirms process termination. A missing close remains explicitly stuck/degraded and the daemon's independent forced-shutdown bound remains the outer availability control.

### Remediated: source authorization could change mid-attempt

**Prior severity:** Medium

The child verified current source state initially, but the final observer gate rechecked only KILL and configuration policy. Supersession, expiry, or revocation between initial verification and snapshot append could therefore commit stale input.

Every observer gate now reloads the exact policy and complete signed source chain. The pre-append gate requires the expected digest to remain the healthy current source. Superseded, expired, revoked, or missing source state detected at a gate receives a bound terminal attempt receipt without a snapshot. The coordinated observation lock now holds official source publication stable through snapshot and terminal publication; mixed old binaries and same-user tampering remain outside that guarantee.

### Remediated: crash resume synthesized a conflicting deadline

**Prior severity:** Medium

An open attempt was rescheduled with a newly computed deadline even though the append-only start receipt bound the original deadline. The new begin conflicted and could leave the attempt orphaned.

Production starts now bind the exact source digest. Recovery carries the persisted attempt ID, tick digest, tick time, deadline, and source digest verbatim. Exactly one digest-bound open attempt is closed before current-source work; multiple opens and legacy null-source starts degrade rather than being guessed.

### Remediated: digest-bound external artifacts remained mutable

**Prior severity:** Low

The external efficiency, Stack observation, and Stack planned-effect compilers returned mutable nested objects. A caller could change an accepted in-memory projection while retaining its original digest, although every authority field remained false.

Accepted projections are now freshly cloned and recursively frozen. Caller-owned input is never frozen. Mutation tests cover nested source, topology, resources, Phantom, cost, rollback, and digest bindings.

### Remediated: fabricated durable-tick provenance could reach the child

**Prior severity:** High integrity risk

The exported scheduling surfaces accepted structurally valid successful ticks, and the child initially validated only the syntax of the supplied tick digest and attempt ID. The resident loop now marks only the exact tick object after daemon-state persistence, the default post-tick bridge rejects every other object, and the child derives the attempt ID and requires the exact full tick digest in strict persisted daemon history before loading writable observer stores. These are process/local-state guarantees and do not widen the declared same-user threat model.

### Remediated: source refresh with an unchanged projection falsely exhausted retries

**Prior severity:** High availability risk

Snapshot replay originally keyed only on the projected snapshot digest and returned the current chain head. A new signed source with unchanged projected state therefore received an envelope bound to the prior source/attempt and failed three times. Replay now requires source, snapshot, and attempt identity and returns that exact envelope; a new source receives a new source-bound envelope even when its projection is identical.

### Remediated: administrative cancellation consumed processing-failure budget

**Prior severity:** Medium availability risk

KILL, configuration revocation, shutdown, and source supersession terminals previously counted toward permanent source retry exhaustion. Retry accounting now counts only source validation, deadline, append, and ambiguous-commit failures. Safe administrative cancellation closes its exact attempt without charging the source failure budget.

### Remediated: snapshot publication could cross its declared deadline

**Prior severity:** Medium integrity risk

The observer checked its deadline before entering synchronous snapshot recovery and publication. The snapshot store now invokes a fail-closed commit guard before the immutable writer, after its lock acquisition, and at the real commit boundary after stage validation and immediately before the no-clobber link. The attempt ledger rejects successful terminal receipts completed at or after the bound deadline.

### Open: bounded ledgers and same-user history are not indefinite or rollback-resistant

**Severity:** Medium if represented as unattended production readiness

The source registry is intentionally bounded to 4,096 bundles and the attempt registry to 8,192 receipts. This is adequate for the proven one-success-per-source relationship, but it is not an indefinite retention design. The host-local snapshot and attempt authenticators also resist accidental corruption and unauthorized format changes, not a malicious same-user process able to read keys and replace both data and checkpoints.

Required future control: a separately specified rollover/checkpoint protocol with bounded reads, plus an external transparency, hardware-backed monotonic, or independently operated anchor. Until then, status must keep `sameUserTamperResistant`, `rollbackProtected`, and `historicalAuthority` false, and capacity exhaustion must degrade visibly.

### Remediated: attempt success did not reconcile later snapshot-ledger loss

**Prior severity:** Medium availability and recovery risk

The scheduler now suppresses an already successful source only when the complete authenticated attempt ledger joins the exact authenticated snapshot envelope across source, snapshot, envelope, sequence, and attempt identities. A wholly absent snapshot ledger admits a bounded fresh observation only after retry/backoff and remaining receipt capacity are checked. Corrupt, partial, conflicting, or orphan-checkpoint state remains degraded and untouched.

The existing retry/backoff ceiling bounds regeneration failure, and successful historical receipts do not consume that failure budget.

### Remediated: final source gate and snapshot publication used independent locks

**Prior severity:** Low

Official source publication and source-bound snapshot publication now use one observation transaction lock. The child holds that lock while it reauthenticates and consumes the exact current source through snapshot and terminal publication. A mixed old/new binary is therefore a commissioning blocker, and same-user tampering remains outside the claimed guarantee.

No authority field was widened; the result remains observation-only.

### Open: external producer receipts prove consistency, not independent truth

**Severity:** Low / Informational

Core Efficiency, Plugin, and Stack local producer candidates pass the M544 protocol, canonical-byte, digest, binding, privacy, and no-authority contracts. The historical Stack fixture correctly fails current freshness, and synthetic test-vector provenance keeps every candidate `releaseReady: false`. None is a published or installed producer. Their unkeyed digests establish exact byte consistency, not producer identity, correct measurement, provider state, deployment, or business effectiveness. Plugin's current chars-div-4 statistics lack measured counters and therefore remain estimated.

Required future control: external signing identities, independently observed outcome windows, released artifact provenance, and live acceptance tests. Do not promote `self-reported-unverified` or `local-unverified` inputs into policy or effect authority.

## PASS: controls verified

| Area | Status | Evidence |
| --- | --- | --- |
| Default state | PASS | Observer absent/disabled unless exact enabled config includes a valid non-empty public trust policy. |
| Authority separation | PASS | Observation, planning, execution, proposal, merge, release, deployment, publication, and external-mutation authority remain false. |
| Child boundary | PASS | Environment allowlist, no production preloads, deadline-triggered TERM/KILL escalation, referenced child retained until confirmed close, KILL/config/source rechecks, process-local overlap suppression. |
| Source integrity | PASS | Role-separated Ed25519 policy, complete-chain verification, sequence/predecessor lineage, policy generation and revocation checks. |
| Attempt integrity | PASS | HMAC-authenticated immutable records, exact source/tick/deadline binding, replay classification, and explicit degradation when the initiating tick ages out of bounded daemon history. An attempt receipt does not grant tick provenance. |
| External inputs | PASS | Exact canonical caller bytes, bounded sizes/counts/depth, version pins, digest and freshness checks, no discovery or effect seam. |
| Privacy | PASS | Aggregate-only contracts reject paths, sessions, prompts, provider/account identifiers, secret names/values, and free-form metadata. |
| Dependency audit | PASS | `npm audit`: zero known vulnerabilities across 434 dependencies. |
| Focused SAST | PASS | Final Semgrep: 214 rules, 12 scoped files, zero findings, zero parse errors. |
| Secret scan | PASS | Gitleaks: 81 repository matches triaged as existing fixtures/constants; zero matches in scoped Agent OS/external paths. |
| Native dependencies | PASS | Only existing Rollup macOS and `fsevents` development/build binaries; no new native dependency. |

## OWASP coverage

| Category | Tested | Scoped result |
| --- | --- | --- |
| A01 Broken Access Control | Yes | Remediated opaque capability and role/principal separation; no effect endpoint added. |
| A02 Cryptographic Failures | Yes | Ed25519 trust policy and domain-separated digests; same-user/local rollback limitation remains explicit. |
| A03 Injection | Yes | No shell/model/provider input path in external contracts; child invocation and preload propagation are constrained. |
| A04 Insecure Design | Yes | Observation and effect proposals remain separate; open bounded-ledger limitation documented. |
| A05 Security Misconfiguration | Yes | Default-off and invalid-policy fail closed; child environment is allowlisted. |
| A06 Vulnerable Components | Yes | Dependency audit clean; native surface unchanged. |
| A07 Identification/Auth Failures | Yes | Policy-wide principal uniqueness and signer separation are enforced. |
| A08 Software/Data Integrity | Yes | Canonical bytes, immutable authenticated stores, frozen projections, sequence/predecessor binding. |
| A09 Logging/Monitoring Failures | Yes | Durable attempts plus explicit process-local scheduler status; no private payload logging. |
| A10 SSRF | Yes | No network access in observer compiler or external contract adapters. |

## Prioritized recommendations

### Immediate

1. Complete the final combined regression, typecheck, lint, build, schema, and diff gates on the exact final tree.
2. Keep the observer disabled and provision no trust keys until source producers and conformance artifacts are independently reviewed and released.
3. Preserve Plugin's intrinsic test HOME isolation. The proven synthetic local-stats delta was repaired under an exact compare-and-swap guard; a mode-0600 incident backup remains with SHA-256 `692aefdb980d7cd68135d656436d6a979d81aabd4086ee692e016c22f32e157e`.

### Short term

1. Specify cross-ledger rollover and external anchoring before unattended runtime commissioning.
2. Add signed producer envelopes and released-artifact provenance to the ecosystem conformance manifest.
3. Join efficiency receipts to frozen quality and outcome windows before using savings as a portfolio metric.

### Medium term

1. Commission one read-only observer lane with dedicated keys, fault injection, disk-capacity alerts, and rollback drills.
2. Promote reversible workspace effects one capability at a time only after separate effect-boundary acceptance.

## Verification evidence

- M544 ecosystem conformance: 11/11 hermetic tests passed; the real three-producer run correctly returned non-ready because Stack freshness was historical and all provenance was synthetic.
- Direct Core Efficiency and Stack producer-to-Hub conformance: every required check passed with all authority fields false.
- Isolated Plugin producer: exact canonical fixture digest `7994d7319bfd771a9d4204ac4d59b87acd17b04e3b9785e308d22f27ff0aa809`, M544 acceptance, and 3,608 passed/17 skipped full tests under isolated HOME; unpublished.
- Focused M535/M538/M539 trust suites after principal-separation repair: 37/37 passed.
- Current Agent OS/source/external matrix M531 and M533-M543: 173/173 passed; the final M536/M543 lifecycle subset independently passed 42/42 after the last scheduler edit.
- Exact-final M201 daemon-loop regression: 255/255 passed.
- Core and web typecheck passed before the final status-only scheduler edit; core typecheck and scoped ESLint were rerun successfully afterward.
- Exact-final Agent OS/modified-adjacent matrix: 372 passed and one platform skip across 23 files; M201 daemon loop 255/255; web 107/107; core/web typechecks passed.
- Full repository attempt: 15,338 passed, 45 skipped, one test-only M30 CI-partition expectation failed; after updating the exact expected partition, M30 passed 7/7. The entire 687-file suite was not rerun after that test-only correction.
- Full lint: zero errors and 108 baseline warnings. Production build: passed with 183 web modules. Config JSON and `git diff --check`: passed.
