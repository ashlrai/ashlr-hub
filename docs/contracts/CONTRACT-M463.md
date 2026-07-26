# M463 Claimed-Batch Admission Contract

Status: pure codec and private-store proving slice implemented; daemon wiring
and operational authority are not active

## Purpose

M463 defines the evidence boundary for a future claimed-batch admission
receipt. The receipt may record that one non-empty batch of work items was
observed after every claimed lease passed an exact-set fence and before
dispatch routing, policy assignment, attempt creation, spend reservation, or
execution.

The protocol identifier is `claimed-batch-admission-v1`. M463 is an
observation-only prerequisite for later assignment reconciliation. It does not
select work, renew or release leases, choose a route, authorize execution,
establish a learning label, or change fleet behavior.

Ashlr performs some feasibility evaluation before claiming work. Therefore the
receipt may claim only post-fence, pre-dispatch ordering. It must not claim that
persistence preceded every route or eligibility evaluation.

## Exact Admission Boundary

A future daemon integration must use this order:

1. Exclude dry-run and require a non-empty claimed batch.
2. Reject duplicate claimed IDs.
3. Have the admission API fence every claimed ID itself and require unique set
   equality plus an opaque exact-generation identity for every renewed claim.
   Callers cannot assert that fencing already happened or provide claim
   capabilities directly.
4. Derive private member identities from authenticated work provenance.
5. Persist an immutable observation and reread it from the private store.
6. Fence the complete batch again and require the same exact claim generations.
7. Persist and reread a separate immutable commit bound to the observation.
   Readers expose only exact observation/commit pairs. A stranded observation
   is degraded diagnostic evidence, never an admitted batch.
8. Treat the committed pair only as historical observation evidence. It cannot
   permit maintenance, spend, routing, assignment, attempt creation, or
   execution. A later operational gate must atomically decide admission in the
   queue and begin the same exact generations before any effect.

Partial renewal is failure for the entire batch. Empty renewal, mismatched or
duplicate membership, unavailable identity, unsafe storage, write failure,
conflict, degraded reread, or generation change at either fence must stop the
renewer, best-effort release every still-claimed member, and refuse the tick
before any downstream authority or spend is created.

An unrelated authenticated but uncommitted observation does not invalidate a
later exact observation/commit pair when both underlying stores are otherwise
healthy. It does keep the aggregate source incomplete and is withheld from
complete learning reads. This prevents one abandoned transaction from wedging
future admission without silently erasing missing denominator evidence.

Writer confirmation uses a canonical point read of its exact observation and
commit slots, not an unbounded ledger scan. Aggregate file or byte limits may
therefore withhold complete learning reads without wedging exact historical
collection. Detected orphaned or mismatched commits, unsafe storage, active
writers, and malformed records still refuse the operation.

Observation and commit snapshots are independently bounded. When either side
hits a file or byte limit, unmatched rows cannot be classified as genuine
uncommitted or orphaned evidence because the opposite row may be outside the
snapshot. The aggregate remains degraded and incomplete; semantic join
failures are emitted only when both snapshot coverages are complete.

The persist-and-reread gate is an integration requirement. It must not be
wired into the daemon until the immutable private store passes its
cross-platform durability, crash-recovery, replay, conflict, race, and reader
purity proof.

## Receipt Semantics

Every receipt permanently carries the following fixed claims:

```json
{
  "authority": "observation-only",
  "executionAuthority": false,
  "learningAuthority": false,
  "policyEligible": false,
  "causalIdentifiability": "not-identifiable",
  "commitSemantics": "historical-exact-generation-fence",
  "attestationAuthority": "host-shared-hmac",
  "verifierIsolated": false,
  "queueAtomicDecision": false,
  "leaseAuthorityAtCommit": false,
  "leaseAuthorityAtReturn": false,
  "orderingEvidence": "daemon-observed-post-fence-pre-dispatch",
  "batchDenominatorComplete": true,
  "batchAssignmentExpectationComplete": true,
  "campaignDenominatorComplete": false,
  "causalDenominatorComplete": false,
  "assignmentDenominatorComplete": false,
  "preExposureVerified": false
}
```

`batchDenominatorComplete: true` means exactly that every unique member of the
one successfully fenced batch appears once in that receipt. It excludes
unclaimed candidates, failed claims, work excluded before the fence, other
ticks, other hosts, and every broader scanner, queue, fleet, campaign,
assignment, exposure, and outcome population.

`batchAssignmentExpectationComplete: true` means the receipt contains one
expected assignment identity for every admitted member. It does not prove that
an assignment was made, persisted before execution, or matched the behavior
policy. Assignment completeness remains false until a later reconciler proves
exact set equality against independently read assignment receipts.

No M463 field may be reinterpreted as campaign closure, a causal denominator,
randomization evidence, exposure evidence, outcome completeness, or permission
to train, route, promote, merge, deploy, or execute.

The second exact-generation fence is the historical observation linearization
point. The local commit may become durable after a lease expires, and crash
recovery may publish it later. That remains truthful only because the record
claims no live lease, queue decision, execution capability, or authority at
commit or return.

## Private Identity And Contents

The persisted record is private metadata only. It may contain:

- fixed protocol, schema, authority, and evidence enums;
- a canonical timestamp, policy version, and learning epoch;
- host-keyed occurrence, batch, campaign, policy, population, receipt, and
  attestation digests;
- a bounded member count; and
- sorted host-keyed admission and expected-assignment unit IDs paired with a
  bounded work-source enum.

Ordinary work identity must bind the physical canonical repository, work item
ID, source, and authenticated objective hash under a domain-separated host-key
HMAC. Trusted generated repairs must carry a durable authenticated handoff and
use its authoritative generation and retry lineage; legacy timestamp-derived
repair generations are refused. Missing keys, invalid repair provenance,
unreadable or unenrolled repositories, and unresolved physical identity refuse
the whole batch.

Caller campaign and admission-policy context digests are re-HMACed under
separate host-key domains before persistence. The caller bytes themselves never
become stored identifiers.

The population digest must be derived from sorted admission identities, fixed
context, and a host-keyed digest of the coordinator-owned exact claim
generations. A retry of the same claim generation replays one population and
batch slot; a released, expired, or reclaimed generation rotates both. Raw
claim tokens and queue identifiers are never persisted. The identity must not
depend on caller-supplied assignment IDs, mutable scores, attempt IDs,
timestamps from the work item, backend choice, or random backlog snapshot IDs.

The receipt must never persist raw repository paths, work item IDs, titles,
details, objective text or hashes, generation IDs, prompts, rationale,
commands, output, diffs, environment values, model names, URLs, filenames, or
file contents. Host-keyed digests remain linkable private metadata and are not
anonymization.

## Persistence Proof Required Before Activation

The private store implementation must prove:

- exact private ownership and permissions for directories, stages, records,
  keys, and locks;
- bounded canonical encoding and stable, read-only enumeration;
- exclusive staging, file fsync, no-clobber publication, directory-entry
  durability, and persist-then-reread behavior;
- exact replay versus authenticated conflict semantics for both observations
  and commits;
- withholding of uncommitted observations and orphaned or mismatched commits;
- recovery across every crash point before and after stage publication without
  allowing a different batch to occupy the stranded transaction slot;
- rejection of aliases, symlinks, reparse points, parent replacement,
  hard-link surprises, active writers, malformed records, duplicate keys,
  digest or MAC failures, and changed directory identity;
- missing and degraded source states that never appear as complete; and
- reader purity: reads create, repair, remove, or mutate nothing.

Unsupported directory-entry durability must fail closed. In particular, native
Windows admission cannot activate until its durability and exact private DACL
requirements are proven on Windows.

## Authority And Threat Boundary

The receipt is authenticated with a host-shared symmetric provenance key. It
provides cooperative-process integrity only. It is not an independent
verifier, does not resist a malicious daemon or same-user process that can read
the key or race pathnames, and provides no rollback-resistant historical
authority.

Independent verification requires a separate signing principal, public-key
verification, descriptor-relative storage operations, a source-native
monotonic watermark, and an exclusive close barrier. None of those properties
is claimed by M463.

M463 readers and receipts must have no routing, backend-selection, dispatch,
proposal, verification, merge, automerge, ship, deployment, readiness,
command-rail, CLI, web, dashboard, or learned-policy consumer. A later
assignment reconciler may read M463 only to report private evidence quality;
it may not authorize work.

An authority-bearing successor requires one queue transaction that revalidates
the full exact-generation set and durably decides `COMMITTED` or `ABORTED`.
Local observation and commit records may project that queue decision, but
cannot substitute for it.

## Activation Gate

The codec, store, contract, and CI registration do not activate M463.
Authority-bearing daemon wiring of this protocol is permanently prohibited.
Even observation-only collection remains prohibited until:

- the immutable private store passes the full crash and native-platform matrix;
- the claimed-batch test proves exact-set fencing and all-or-nothing refusal;
- dry-run is proven to write nothing;
- successful persistence is reread before every downstream dispatch path;
- failures release only still-claimed generations and never release executing
  work; and
- an import-boundary test proves that authority-bearing consumers cannot read
  the receipt.

Operational admission additionally requires the queue-atomic decision protocol
described above, exact generation handles from selection through terminal
settlement, and a separate reviewed activation change. A green storage or
unit-test slice alone does not establish production readiness.
