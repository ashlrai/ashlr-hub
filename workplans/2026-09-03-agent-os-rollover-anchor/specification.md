# M546 Specification: Bounded Epoch Rollover, Monotonic Anchor, and Detached Evidence Attestation

Status: source-only design; no runtime implementation or activation.

## 1. Purpose

M546 defines the protocol required to operate the Agent OS observer beyond the fixed capacities of the V1 source, snapshot, and attempt stores while preserving bounded reads, exact lineage, crash recovery, and explicit assurance boundaries. It also defines a detached signature envelope for external evidence without changing existing V1 receipt or manifest bytes.

M546 does not provide an anchor service, hardware integration, signing key, trust-root installer, network client, daemon activation, migration command, or producer release. A source implementation is not commissioned until a separately reviewed adapter, policy, and operating procedure satisfy this contract.

## 2. Non-negotiable authority boundary

Every epoch manifest, anchor result, rollover result, evidence attestation, composed evidence result, and status projection carries this literal authority block:

```json
{
  "authority": "observation-only",
  "planningAuthority": false,
  "executionAuthority": false,
  "effectAuthority": false,
  "proposalAuthority": false,
  "learningAuthority": false,
  "promotionAuthority": false,
  "mergeAuthority": false,
  "releaseAuthority": false,
  "deployAuthority": false,
  "publicationAuthority": false,
  "budgetAuthority": false,
  "credentialAuthority": false,
  "externalMutationAuthority": false
}
```

No successful signature, anchor CAS, rollover, released artifact, or independent observation may change any field in this block. M546 records evidence; it never authorizes an effect.

## 3. Terms

- **Epoch**: one bounded generation of source, snapshot, and attempt records.
- **Epoch manifest**: immutable canonical metadata that binds an epoch to the preceding epoch and its initial record bases.
- **Epoch head**: the small canonical value stored at the external monotonic anchor.
- **Active pointer**: a local, replaceable cache of the externally committed epoch head. It is not authoritative.
- **Commit point**: successful external compare-and-swap from epoch `N` to `N + 1`.
- **Coherent observation binding**: an exact authenticated join across one source bundle, one snapshot envelope, and one successful terminal attempt.
- **Detached attestation**: a signature over the digest and provenance tuple of an existing canonical artifact; it does not alter the artifact's bytes.
- **Anchor adapter**: a separately commissioned implementation able to read and atomically compare-and-swap one monotonic head.

## 4. Protocol identifiers and domains

Implementations must use distinct protocol and hash/signature domains:

```text
ashlr-agent-os-observation-epoch-manifest-v1
ashlr-agent-os-observation-epoch-head-v1
ashlr-agent-os-detached-evidence-attestation-v1
ashlr-agent-os-evidence-trust-policy-v1

ashlr:agent-os:epoch-manifest:v1\0
ashlr:agent-os:epoch-head:v1\0
ashlr:agent-os:detached-evidence:v1\0
ashlr:agent-os:evidence-policy:v1\0
```

Canonicalization follows the existing closed-schema, minified UTF-8, deterministic-key-order rules. Unknown fields, accessors, cycles, sparse arrays, duplicate keys, non-canonical timestamps, unsafe integers, malformed encodings, and values outside declared bounds fail closed.

## 5. Epoch identity and layout

M546 uses a new namespace so a legacy writer cannot mutate the active epoch accidentally:

```text
~/.ashlr/agent-os-observation-history-v1/
  active-head.json
  epochs/
    <12-digit-epoch>/
      manifest.json
      source/
      snapshots/
      attempts/
```

The new runtime ignores legacy V1 roots for authoritative M546 reads. Legacy roots may be imported only by a one-time, stopped-runtime migration that emits an explicit epoch-zero migration receipt. They are never silently merged.

An epoch number is a positive safe integer. Epochs advance exactly by one. Directory names are canonical 12-digit decimal values and must match the authenticated manifest. Epoch storage, files, and locks retain the repository's exact-private ownership, no-symlink, no-alias, bounded-directory, fsync, and immutable-record requirements.

### 5.1 Epoch manifest

The exact shape is equivalent to:

```ts
interface AgentOsObservationEpochManifestV1 {
  schemaVersion: 1;
  protocol: 'ashlr-agent-os-observation-epoch-manifest-v1';
  recordType: 'agent-os-observation-epoch';
  epoch: number;
  protocolGeneration: 1;
  previousEpochHeadDigest: string;
  previousEpochManifestDigest: string;
  previousSourceTip: { sequence: number; bundleDigest: string } | null;
  previousSnapshotTip: { sequence: number; envelopeDigest: string } | null;
  previousAttemptSetDigest: string;
  previousCoherentBindingDigest: string | null;
  firstSourceBundle: {
    epochSequence: 1;
    bundleDigest: string;
    previousBundleDigest: string;
    trustPolicyDigest: string;
    policyGeneration: number;
  };
  snapshotBase: { nextSequence: 1; previousEnvelopeDigest: string };
  attemptNamespaceDigest: string;
  createdAt: string;
  manifestDigest: string;
  localAuthenticator: string;
  // exact all-false authority block
}
```

Epoch one uses protocol constants for the preceding manifest, source, snapshot, attempt, and coherent-binding digests. Later epochs bind the exact tips of the closed preceding epoch.

The first source bundle for a new epoch is required before the external CAS. It must be independently valid under the current source trust policy, use epoch-local sequence one, and bind `previousBundleDigest` to the prior epoch's source tip rather than to the genesis digest. This prevents an old epoch-one source bundle from being replayed after a sequence reset.

The first snapshot in a new epoch similarly uses epoch-local sequence one and binds `previousEnvelopeDigest` to the preceding epoch's snapshot tip. Attempt IDs are derived from `epoch + durableTickDigest`, preventing cross-epoch tick collisions.

The local authenticator provides cooperating-process integrity and crash recovery only. It does not provide same-user rollback resistance or independent historical authority.

### 5.2 External epoch head

```ts
interface AgentOsObservationEpochHeadV1 {
  schemaVersion: 1;
  protocol: 'ashlr-agent-os-observation-epoch-head-v1';
  epoch: number;
  protocolGeneration: 1;
  previousHeadDigest: string;
  epochManifestDigest: string;
  firstSourceBundleDigest: string;
  closedSourceTipDigest: string;
  closedSnapshotTipDigest: string;
  closedAttemptSetDigest: string;
  coherentBindingDigest: string;
  writerProtocolDigest: string;
  advancedAt: string;
  headDigest: string;
  // exact all-false authority block
}
```

The anchor stores exact canonical head bytes, not a caller-supplied Boolean verdict. `headDigest` covers every preceding field under the M546 head domain.

## 6. Anchor adapter contract

The core protocol may depend only on this semantic boundary:

```ts
interface AgentOsMonotonicAnchorV1 {
  read():
    | { state: 'present'; canonicalHeadBytes: Uint8Array }
    | { state: 'missing' }
    | { state: 'unavailable' | 'degraded' };

  compareAndSwap(input: {
    expectedHeadDigest: string | null;
    nextCanonicalHeadBytes: Uint8Array;
    operationId: string;
  }):
    | { state: 'advanced'; canonicalHeadBytes: Uint8Array }
    | { state: 'replayed'; canonicalHeadBytes: Uint8Array }
    | { state: 'conflict'; canonicalHeadBytes: Uint8Array | null }
    | { state: 'unavailable' | 'indeterminate' };
}
```

Required adapter properties:

1. Compare-and-swap is linearizable for one configured fleet identity.
2. A head can advance only from the exact expected digest to epoch `N + 1`.
3. Exact operation replay is idempotent.
4. A stale writer cannot replace or delete a newer head.
5. Read-after-write returns the exact committed bytes.
6. Errors never return `advanced` without exact committed bytes.
7. Credentials are not passed in arguments, logs, manifests, snapshots, or receipts.
8. The adapter exposes no general-purpose storage or execution capability to the observer.

A local file, local SQLite database, shared host HMAC, Git reference controlled by the same runtime identity, or caller-provided head does not satisfy the external monotonic property. Such adapters must report `anchorAssurance: local-unverified` and keep `rollbackProtected: false`.

## 7. Rollover state machine

### 7.1 States

| State | Meaning | Writes permitted |
| --- | --- | --- |
| `uncommissioned` | No accepted anchor policy/adapter/head exists. | None. |
| `legacy-detected` | A legacy writer, lock, or live legacy daemon may exist. | None. |
| `healthy` | Local active pointer, epoch manifest, three bounded ledgers, and external head agree. | Normal observation writes within capacity. |
| `rollover-required` | A configured high-water threshold is reached, but current epoch is still coherent. | Terminal closure and rollover only. |
| `rollover-preparing` | The next epoch is durable locally; external CAS has not committed it. | Only exact recovery or CAS replay. |
| `anchor-advanced` | External CAS committed the next head; local pointer may lag. | Only exact pointer recovery. |
| `awaiting-first-snapshot` | New epoch is active with its signed first source but no coherent snapshot yet. | One bounded observation attempt. |
| `anchor-conflict` | Anchor head differs from expected or intended bytes. | None. |
| `anchor-unavailable` | Required anchor cannot be read or CAS outcome cannot be determined. | No source, snapshot, attempt, or rollover write. |
| `capacity-exhausted` | Capacity is exhausted and rollover is not safely possible. | None. |
| `degraded` | Any integrity, lineage, policy, storage, clock, or mixed-version invariant fails. | Conservative exact recovery only. |

No state is inferred from the presence of a directory alone. A healthy state requires complete authenticated reads and exact external-head agreement.

### 7.2 Eligibility

Rollover is eligible only when all conditions hold under one process-resident M546 coordination lease and one global observation transaction lock:

1. The external anchor returns the exact locally expected head.
2. The active pointer and active epoch manifest match that head.
3. Source, snapshot, and attempt ledgers are complete and within bounds.
4. There are zero open observer attempts.
5. The current source is unexpired and valid under the current provisioned policy.
6. The current source, latest successful terminal, and referenced snapshot form one exact coherent binding.
7. The rollover threshold is reached or an explicit observation-only maintenance request exists.
8. A valid, fresh, signed epoch-successor source bundle is present.
9. The successor source principal and policy are authorized for the new epoch and do not weaken required role separation.
10. KILL, cancellation, or deadline is not active.

Thresholds are below hard capacity and reserve enough records to close any current attempt and produce rollover evidence. Crossing a threshold does not authorize rollover if any other condition fails.

### 7.3 Transaction order

1. Acquire the process-resident M546 coordination lease.
2. Acquire the global observation transaction lock.
3. Re-read the anchor, active pointer, manifest, policy, and all three ledgers.
4. Recompute the coherent binding and closed-ledger digests from authenticated canonical records.
5. Validate the successor source bundle and construct exact next-manifest and next-head bytes.
6. Create the next epoch directory, immutable manifest, first source record, empty bounded snapshot/attempt stores, and recovery marker; fsync every file and namespace barrier.
7. Re-read every prepared object by exact path and digest.
8. Perform external anchor CAS from the current head digest to the next canonical head bytes.
9. Re-read the anchor. `advanced` or `replayed` is accepted only if exact bytes match the intended next head.
10. Atomically write and fsync the local active pointer to the externally committed head.
11. Remove only the exact authenticated recovery marker, release locks, and report `awaiting-first-snapshot`.

Step 8 is the commit point. No local pointer, status string, directory rename, or process memory can commit an epoch.

### 7.4 Crash and ambiguity transitions

| Last durable event before crash | Recovery action |
| --- | --- |
| Before next manifest is fully durable | Ignore incomplete private temporary state; old epoch remains active. |
| Next epoch durable, before CAS invocation | Anchor still names old head; exact prepared epoch may be reused for the same operation or quarantined. It is not active. |
| CAS returns conflict | Read the returned/current anchor. Adopt only if it byte-matches the intended next head; otherwise enter `anchor-conflict`. |
| CAS request times out or returns `indeterminate` | Do not retry blindly. Read anchor; exact intended head means recover as committed, exact old head permits idempotent CAS replay, anything else degrades. |
| Anchor committed, before local pointer write | Re-read anchor and exact prepared epoch; atomically advance the lagging local pointer. |
| Local pointer temporary exists | Install it only when its canonical head exactly matches the current external head and prepared epoch; otherwise remove only the exact temporary or degrade. |
| Local pointer is behind by one known epoch | Recover forward only when the anchor and complete prepared epoch agree. Never roll the anchor backward. |
| Local pointer is ahead, anchor is behind, or either skips an epoch | Enter `degraded`; perform no writes. |
| New epoch active, first snapshot absent | Run one ordinary bounded observer attempt against the committed first source. Failure follows normal bounded backoff/exhaustion. |
| Crash after first snapshot but before terminal receipt | Existing exact attempt recovery and snapshot replay must close the attempt; replay must return the exact matching envelope. |

Recovery never deletes a complete old epoch. Orphan cleanup is a distinct bounded maintenance operation that identifies exact uncommitted epoch directories from the current external head and authenticated recovery metadata.

## 8. Bounded reads and retention

Normal scheduling reads only:

- the external head;
- the local active pointer and active epoch manifest;
- the active epoch's bounded source, snapshot, and attempt stores; and
- at most one immediately preceding epoch manifest when recovering a transition.

Historical epochs remain immutable evidence but are not scanned on every tick. Retention, archival, compaction, or deletion requires a separate policy and an anchor-bound retention receipt. M546 does not authorize deletion. External anchoring proves only the monotonic head property delivered by the commissioned adapter; it does not prove historical bytes remain available.

## 9. Mixed-version exclusion

M546 cannot safely share an active namespace with V1 writers that do not recognize epochs or the global observation lock. Commissioning therefore requires:

1. Observer disabled and daemon stopped.
2. No live observer child, active attempt, legacy store lock, or retained termination state.
3. Exact installed binary/protocol digest recorded as `writerProtocolDigest` in the initial external head.
4. A new M546 namespace; legacy roots become read-only migration evidence and are ignored for current state.
5. One process-resident singleton lease whose protocol digest matches the anchored writer protocol.
6. Every source, snapshot, attempt, recovery, and rollover writer verifies that digest before and immediately before commit.
7. Any observed legacy-root mutation after commissioning changes status to `legacy-detected` and blocks M546 writes.
8. Upgrade to another writer protocol requires a new anchored epoch transition; an unanchored binary replacement cannot write.

This excludes cooperating mixed-version writers. It does not claim protection from a malicious same-user process; that remains in the threat model.

## 10. Detached external evidence attestation

Existing efficiency receipt, Stack observation, and Stack effect-plan V1 bytes remain unchanged. M546 authenticates them with a separate envelope so old canonical fixtures and consumers remain valid.

### 10.1 Trust policy

The evidence policy is default-empty and deployment-provisioned. Each Ed25519 key binds a unique key ID, principal digest, one role, validity window, and optional revocation time. Roles are:

- `producer-origin-signer`
- `release-provenance-attestor`
- `outcome-observer`

One principal, key, or public key may not occupy multiple roles in one composed result. Policies are exact, sorted, bounded, generation-numbered, and digest-bound. Caller input cannot extend the installed policy.

### 10.2 Detached envelope

```ts
interface AgentOsDetachedEvidenceAttestationV1 {
  schemaVersion: 1;
  protocol: 'ashlr-agent-os-detached-evidence-attestation-v1';
  artifactProtocol: string;
  artifactDigest: string;
  sourceProduct: string;
  sourceVersion: string;
  sourceCommit: string;
  attestationRole:
    | 'producer-origin-signer'
    | 'release-provenance-attestor'
    | 'outcome-observer';
  statementDigest: string;
  policyGeneration: number;
  trustPolicyDigest: string;
  keyId: string;
  principalDigest: string;
  signatureAlgorithm: 'ed25519';
  issuedAt: string;
  expiresAt: string;
  signature: string;
  // exact all-false authority block
}
```

`statementDigest` is role-specific:

- Producer origin binds the exact canonical artifact digest and claimed product/version/commit.
- Release provenance binds the artifact digest, immutable package or release artifact digest, build-provenance digest, source commit, and release channel. A mutable branch or tag is insufficient.
- Outcome observation binds the artifact digest, a bounded outcome-window digest, measurement method, sample completeness, quality result, observation time, and privacy class. It cannot contain raw prompts, responses, paths, credentials, account identifiers, or free-form prose.

Signature verification proves that the selected policy key signed the exact statement during its accepted validity window. It does not prove the policy was organizationally approved, the signer was honest, the claimed artifact was published, the measurement was correct, or the outcome was valuable.

### 10.3 Orthogonal assurance result

Composition reports independent axes:

```ts
interface AgentOsExternalEvidenceAssuranceV1 {
  originAssurance:
    | 'unverified'
    | 'producer-signature-verified';
  claimAssurance:
    | 'self-reported-unverified'
    | 'independent-outcome-signature-verified';
  releaseAssurance:
    | 'unverified'
    | 'immutable-release-provenance-signature-verified';
  liveAcceptanceAssurance:
    | 'not-observed'
    | 'independently-observed';
  canonicalBytesVerified: boolean;
  freshnessVerified: boolean;
  roleSeparationVerified: boolean;
  // exact all-false authority block
}
```

Rules:

1. A content digest alone leaves all three assurance axes unverified.
2. A producer signature can upgrade only `originAssurance`.
3. A release attestation can upgrade only `releaseAssurance` and only with immutable artifact and build-provenance digests.
4. An outcome attestation can upgrade only `claimAssurance`; its principal must differ from producer and release principals.
5. `liveAcceptanceAssurance: independently-observed` requires a fresh live acceptance record from a separately configured observer and cannot be inferred from tests, CI, signatures, provenance, or outcomes alone.
6. Estimated and counterfactual measurements remain estimated and counterfactual after every signature.
7. Missing, expired, revoked, duplicated-role, malformed, non-canonical, policy-mismatched, or cross-artifact attestations are withheld.
8. No assurance result is planning-, policy-, learning-, promotion-, or execution-eligible by itself.

## 11. Public result states

All M546 APIs return closed discriminated unions. Allowed top-level states are:

- `accepted`: exact protocol verification succeeded within its limited assurance meaning.
- `withheld`: caller bytes or policy evidence failed validation; caller-controlled identity fields are not returned.
- `uncommissioned`: no accepted adapter or trust root exists.
- `unavailable`: a required external dependency could not be checked.
- `conflict`: authenticated current state differs from the expected state.
- `indeterminate`: commit outcome cannot yet be classified.
- `degraded`: completeness or integrity cannot be proved.

No exception text, local path, credential name, environment value, source bytes, signature bytes, or provider response body appears in public results.

## 12. Acceptance tests required before implementation is called complete

1. Exact deterministic vectors for manifest, head, policy, role statements, and signatures.
2. Full crash matrix around every fsync, CAS, anchor reread, and active-pointer transition.
3. Two-process CAS contention with exactly one committed next epoch.
4. CAS timeout resolved by read-after-ambiguity without double advancement.
5. Old source/snapshot/tick replay rejected after epoch-local sequence reset.
6. Open attempts, incomplete stores, stale source, source-policy drift, KILL, and deadline each block rollover.
7. Local pointer behind recovers forward; ahead, skipped, or conflicting pointers degrade.
8. Legacy writer/lock/root mutation detection blocks writes.
9. Missing/unavailable anchor never silently falls back to local state.
10. Hard capacity without safe rollover becomes visibly `capacity-exhausted`.
11. V1 external artifact bytes remain byte-identical and independently consumable.
12. Every role/key/principal substitution and cross-artifact replay fails.
13. Producer signatures do not upgrade claim or release assurance.
14. Release signatures do not upgrade claim truth or live acceptance.
15. Outcome signatures do not grant authority or relabel estimated measurements.
16. Every accepted, withheld, unavailable, conflict, and degraded output carries the exact all-false authority block.
17. Static import checks prove the observer cannot import adapter credentials, signer implementations, or effect modules.
18. Default production configuration has no adapter, no keys, no writer, and reports `uncommissioned` without creating files.

## 13. Commissioning gates outside this source specification

Before live use, a later release must provide and independently accept:

- one concrete monotonic adapter and its availability/recovery properties;
- credential custody and revocation procedures;
- externally approved source and evidence trust policies;
- stopped-runtime migration and rollback rehearsal;
- producer support for signed epoch-successor source bundles;
- producer, release, and outcome signing identities with enforced separation;
- telemetry for capacity, anchor latency/conflict, recovery, and legacy activity;
- fault injection on the exact packaged binary; and
- explicit operator activation.

Passing M546 source tests would prove only that the source implementation follows this contract. It would not prove commissioning, adapter behavior, external identity, historical retention, receipt truth, business effectiveness, or permission to perform any effect.
