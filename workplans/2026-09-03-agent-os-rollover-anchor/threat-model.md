# M546 Threat Model

Status: source-only design companion to `specification.md`.

## 1. Assets

M546 protects the integrity and availability of:

- the identity of the active Agent OS observation epoch;
- monotonic linkage between closed and active epochs;
- source, snapshot, and attempt tips included in each transition;
- the exact coherent source/snapshot/attempt binding at rollover;
- the distinction between prepared local state and externally committed state;
- the identity and limited role of an external evidence signer;
- the distinction among origin, claim, release, and live-acceptance assurance; and
- the invariant that observation evidence grants no authority.

M546 does not protect raw prompts, responses, secrets, customer data, or arbitrary metadata because those values are forbidden from its protocols.

## 2. Trust boundaries

### 2.1 Trusted only after explicit commissioning

- The exact M546 verifier binary identified by `writerProtocolDigest`.
- The provisioned source and evidence trust-policy bytes.
- The external anchor's linearizable compare-and-swap property.
- The operating-system process identity and private-storage controls against other users.
- The canonicalization, Ed25519, SHA-256, HMAC, and constant-time comparison implementations.

### 2.2 Not trusted by default

- Caller-provided policy, public key, clock verdict, anchor verdict, assurance label, or prior state.
- Local active pointer, directory name, file timestamp, process memory, environment variable, or status prose.
- A digest without a signature and policy.
- A signature as proof that its signed claim is true.
- A package name, semantic version, Git commit, branch, tag, CI badge, test output, or release URL as immutable release provenance.
- A producer as its own independent outcome observer.
- The same-user local HMAC as rollback-resistant history.
- A legacy Agent OS writer after M546 commissioning.
- An adapter merely because it implements the TypeScript interface.

## 3. Adversaries and failure actors

1. **Malformed caller** supplies unknown fields, non-canonical bytes, invalid timestamps, oversized values, or cross-protocol objects.
2. **Stale cooperating writer** runs an older protocol or races from an old anchor head.
3. **Concurrent current writer** attempts the same or a different rollover simultaneously.
4. **Crash/fault actor** terminates the process at any filesystem or network boundary.
5. **Ambiguous network** loses an anchor CAS response after the server may have committed it.
6. **Dishonest producer** signs an internally consistent but false efficiency, topology, outcome, or effectiveness claim.
7. **Role-colluding principal** attempts to use one identity as producer, release attestor, and outcome observer.
8. **Replay actor** reuses a valid source, snapshot, attempt, attestation, or anchor head in another epoch, artifact, policy generation, or time window.
9. **Local same-user process** can read host keys and replace local files or local checkpoints.
10. **Compromised external anchor identity** can violate monotonicity or return fabricated state.
11. **Operator error** starts mixed versions, selects the wrong fleet identity, restores only part of a backup, or treats a green source test as live acceptance.

## 4. Security properties

### 4.1 Safety properties

- At most one epoch `N + 1` can be externally committed from one exact epoch `N` head.
- No local state can make an epoch active when the external head does not name it.
- A stale writer cannot overwrite a newer anchor head.
- Epoch-local sequence reset cannot permit cross-epoch replay because the first source and snapshot bind the preceding epoch tips and attempt IDs bind the epoch.
- Rollover never begins with an open attempt or incomplete ledger.
- Ambiguous CAS is resolved by exact read-back, never optimistic retry.
- No corrupt or conflicting state is deleted in order to manufacture a healthy read.
- Detached signatures cannot mutate or replace the canonical artifact they bind.
- No assurance axis implies another assurance axis.
- Every protocol output retains the exact all-false authority block.

### 4.2 Availability properties

- All tick-time reads are bounded to the current epoch and a constant amount of transition metadata.
- Capacity exhaustion is visible and terminal until safe rollover becomes possible.
- Exact prepared state and exact committed-but-not-activated state are recoverable.
- Anchor unavailability cannot corrupt local history, though it may halt writes.
- A crash cannot create two active epochs.

### 4.3 Privacy properties

Epoch and attestation records contain only bounded identifiers, digests, counts, timestamps, fixed enums, and explicit policy metadata. They exclude:

- prompts, model responses, tool arguments, diffs, source content, and arbitrary prose;
- absolute paths, repository names unless explicitly public package identity is required, sessions, accounts, and customer identifiers;
- secret names, values, tokens, OAuth scopes, provider response bodies, and environment variables; and
- raw signatures or public keys from status/read-model projections.

Public keys and stable digests are linkable metadata and must not enter learning or telemetry by default.

## 5. Threat analysis and controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| Local ledger reaches hard capacity | High-water rollover threshold, reserved closure capacity, externally committed bounded epochs | Anchor unavailability can still halt observation. |
| Same-user rollback of local pointer or epoch files | External monotonic head is authoritative; local state may recover only forward to it | A compromised anchor or verifier identity remains fatal. |
| Prepared epoch mistaken for committed | External CAS is the sole commit point | Availability depends on exact anchor read-back. |
| CAS response lost | Read-after-ambiguity and idempotent operation ID | Extended anchor outage leaves state `indeterminate` and blocks writes. |
| Two writers roll simultaneously | Global local lock plus external linearizable CAS | A malicious same-user process can ignore the local lock, but should still lose CAS. |
| Old writer mutates legacy roots | New namespace, anchored writer protocol digest, legacy activity monitor, stopped-runtime commissioning | Same-user malicious execution can still cause denial of service. |
| Old source bundle replayed after reset | First source predecessor binds previous epoch source tip | Depends on source signer correctly supporting rollover successor semantics. |
| Old snapshot/tick replayed after reset | Snapshot predecessor and epoch-bound attempt ID | Snapshot format/store must enforce the epoch base exactly. |
| Snapshot/attempt/source disagree at rollover | Exact coherent binding and complete-ledger eligibility check | Same-user key compromise can fabricate local records; external head only preserves what was committed. |
| Anchor adapter lies about monotonicity | Separate adapter acceptance, read-after-write, fault tests, independently operated or hardware-backed service | M546 source cannot prove provider internals. |
| Producer signs false savings | Origin assurance remains separate from claim assurance | Independent observer can also be wrong or collude. |
| Producer self-signs release/outcome role | Policy-wide principal/key/public-key uniqueness | Organizational collusion is outside cryptographic enforcement. |
| Mutable tag presented as release evidence | Immutable artifact and build-provenance digest required | Provenance signer may still make a false statement. |
| Signature replay across artifacts | Artifact protocol/digest, policy generation, role, time, and statement domain binding | Exact replay remains idempotent within the same accepted tuple. |
| Signature interpreted as execution approval | Literal all-false authority fields and no effect imports | A downstream consumer ignoring the contract is outside M546; import/consumer audits are required. |
| Sensitive data hidden in free-form metadata | No arbitrary metadata/prose fields; exact allowlists and bounds | Approved public product identifiers remain linkable. |

## 6. Crash-state threat matrix

| Crash point | Attacker opportunity | Required invariant after restart |
| --- | --- | --- |
| Before any next-epoch durable write | Manufacture partial epoch | Old external/local head remains active; incomplete temp cannot be read as an epoch. |
| During manifest or first-source publication | Substitute or alias prepared bytes | Exact-private inode/path/digest reread fails closed. |
| After local preparation, before CAS | Claim preparation equals activation | Anchor still names old head; prepared epoch is inactive. |
| During CAS | Cause blind double advance | Outcome becomes `indeterminate`; only exact anchor reread decides. |
| After CAS, before response | Force retry from stale expected head | Exact intended head is a replay; a different head is conflict. |
| After CAS, before active-pointer update | Make old local pointer appear authoritative | Anchor-ahead recovery advances local pointer only after exact prepared-state verification. |
| During active-pointer replacement | Install partial or attacker-selected head | Temporary is accepted only if it matches the external head and epoch bytes exactly. |
| After activation, before first snapshot | Present empty epoch as completed observation | State remains `awaiting-first-snapshot`; no `already-observed` result. |
| After snapshot, before terminal receipt | Lose success linkage | Existing attempt recovery must join the exact snapshot and persist/replay one terminal. |

## 7. Mixed-version threats

Mixed-version safety is a commissioning property, not a semver assumption.

- A V1 process does not understand epoch roots, anchored writer digests, or the M546 global lock.
- Therefore M546 must never treat an active V1 process as cooperative merely because it uses the same user or package name.
- Commissioning must stop all V1 writers, close attempts, pin the installed binary digest, establish the new namespace, and commit that digest in the first anchor head.
- A running binary whose digest differs from the head cannot write, repair, recover, or roll over.
- Mutations in legacy roots after commissioning are an alarm and write blocker, not inputs to reconciliation.
- A software upgrade is itself an anchored epoch transition. Replacing files on disk is not enough.

The protocol does not claim to prevent a malicious same-user process from executing an older binary. The external CAS prevents that process from advancing M546 history without current anchor state, while monitoring and process isolation address denial of service.

## 8. Assurance-confusion threats

M546 treats assurance as four independent questions:

1. **Origin identity**: did a key accepted for the producer role sign the exact artifact?
2. **Claim evidence**: did a different accepted observer sign a bounded outcome statement about the exact artifact?
3. **Release provenance**: did a different accepted attestor bind the exact immutable released artifact and build provenance?
4. **Live acceptance**: did a separately configured observer verify the artifact in the intended live environment now?

Forbidden inferences include:

- digest verified -> producer authenticated;
- producer authenticated -> claim true;
- tests passed -> released artifact exists;
- release provenance verified -> deployed or live;
- outcome signature verified -> measurement unbiased;
- measured field present -> directly measured;
- large savings -> quality preserved;
- anchor advanced -> history retained;
- any evidence accepted -> planning, learning, promotion, execution, or effect authorized.

## 9. Explicitly out of scope

M546 does not defend against:

- compromise of the external anchor, commissioned trust-policy authority, operating-system kernel, or cryptographic implementation;
- malicious cooperation among organizationally distinct principals;
- deletion of historical epoch bytes after a head has been anchored;
- trusted time failure unless the commissioned anchor separately supplies and proves it;
- correctness of efficiency accounting, topology discovery, outcome methodology, or business-value attribution;
- provider availability, package publication, deployment, customer acceptance, or effect execution; or
- denial of service by a same-user process able to exhaust CPU, disk, locks, or file descriptors.

These omissions must remain visible in status and release documentation.

## 10. Required red-team cases

Before implementation commissioning, independently test:

1. A stale process races an honest rollover from the previous head.
2. Two honest processes prepare different successor sources for the same epoch.
3. CAS commits but every response is lost until restart.
4. Anchor returns an older, newer-skipping, malformed, or byte-different head.
5. Local pointer, manifest, source tip, snapshot tip, and attempt digest are substituted one at a time.
6. Epoch-one source, snapshot, and tick records are replayed into a later epoch.
7. A legacy process writes during commissioning and after activation.
8. A prepared epoch is aliased, symlinked, widened, truncated, or given extra links.
9. Producer, release, and outcome attestations reuse a principal, key ID, or public key.
10. A valid signature is replayed across artifact protocol, digest, version, commit, policy generation, role, or time window.
11. Estimated savings are relabeled measured before and after a valid producer signature.
12. Every successful evidence and rollover result is fed to effect, policy, learning, and promotion consumers; static and dynamic guards must reject it as authority.

## 11. Residual risk statement

Even with a correct implementation and commissioned external anchor, M546 would establish bounded monotonic observation history and limited signer identity under a policy. It would not establish that signed claims are true, released artifacts are deployed, historical bytes are retained, outcomes are causal, or actions are authorized. Those remain separate evidence and authority systems.
