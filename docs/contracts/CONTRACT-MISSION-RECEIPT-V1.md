# Mission Observation Receipt V1 Contract

Status: source contract. This document does not attest runtime installation,
daemon activation, automatic reconciliation, merge authority, release, or
deployment.

## Purpose

Mission Observation Receipt V1 records one bounded, authenticated snapshot of
what the local Hub observed after an explicit planning reconciliation. It binds
the exact briefing digest, Ecosystem Mission Graph digest, source snapshots,
node lifecycle, HMAC-obscured goal and proposal references, verification
evidence, and realized merge revisions.

The receipt is evidence, never authority. It cannot create a goal, dispatch an
agent, create or approve a proposal, merge, release, deploy, publish, access a
credential, mutate an external system, establish company truth, change policy,
or earn a learning label.

## Authority invariants

Every valid record fixes these values:

- `authority: "observation-only"`;
- planning, execution, proposal, merge, release, deployment, external-mutation,
  and learning authority are all `false`;
- `policyEligible`, `verifierIsolated`, `humanDecisionEvidenceComplete`, and
  `outcomeEvidenceComplete` are `false`;
- `businessOutcomeStatus` is `"not-observed"`; and
- `attestationAuthority` is `"host-shared-hmac"`.

The HMAC proves that a process with the existing local provenance key recorded
the bytes. It is not independent verification and does not prove that the host
or current operating system is uncompromised.

## Input and source quality

The receipt writer accepts evidence-normalized input. All four sources—the
briefing, enrollment, goals, and linked proposals—must report a complete bounded
read with a lowercase SHA-256 source digest. The briefing source digest must
equal `missionObservationBriefingDigest()` for the supplied briefing.
Missing-but-complete empty operational sources are valid. A degraded or
incomplete source returns `source-degraded` and writes nothing.

The shared `missionObservationBriefingDigest()` canonicalizes a plain JSON-like
briefing with NFC string normalization, code-unit key ordering, finite numbers,
data properties only, cycle/depth/node/byte bounds, and domain-separated
SHA-256. The briefing itself is never persisted in the receipt.

V1 accepts no human-approval boolean and no external outcome assertion. Those
require later, separately authenticated protocols. A graph's engineering status
may be complete while its business outcome remains unobserved.

## Bounded evidence

A receipt contains 1–24 unique mission nodes. Each node has no more than eight
unique blockers and 64 milestones; the complete receipt has no more than 512
milestones and 256 KiB of canonical serialized data.

Local goal, milestone, and proposal identifiers are converted to
domain-separated HMAC references. Receipts do not persist objectives,
rationales, repository paths, diffs, verification commands/output, PR URLs,
provider payloads, credentials, or raw business evidence.

A work milestone is engineering-realized only when all of these are bound:

1. proposal status is `applied`;
2. passing verification has a SHA-256 evidence digest;
3. realized merge source is `local-default-branch` or `github-host`;
4. the exact lowercase 40-hex merge revision is present; and
5. a SHA-256 realized-merge evidence digest is present.

A work node is complete only when it has at least one non-skipped milestone and
every non-skipped milestone is engineering-realized. Human gates cannot be
complete in V1; they are blocked or awaiting an authenticated human receipt.

## Identity, replay, and authentication

The canonical identities are domain separated:

- `snapshotDigest` hashes every semantic observation field except `recordedAt`
  and authentication fields;
- `receiptId` hashes the graph digest and snapshot digest;
- `receiptDigest` hashes the complete unsigned record, including `recordedAt`;
- `attestation` is HMAC-SHA-256 over the receipt digest and unsigned body.

An identical semantic retry therefore selects the same immutable slot even when
it observes a later wall clock. The earliest valid persisted record is returned
as `replayed`. A different semantic snapshot receives a different receipt ID.

## Persistence

Receipts live under `~/.ashlr/mission-receipts/` through the shared
`ImmutablePrivateRecordStore`. The writer uses the existing provenance key and
never creates one. Readers use the read-only key loader and do not create keys,
directories, locks, or cleanup writes.

The store supplies exact-private directories and files, identity pinning,
no-clobber hard-link publication, cooperative writer locking, authenticated
crash recovery, post-write point verification, bounded aggregate reads, and
explicit missing/healthy/degraded source state. Aggregate consumers must use
`requireComplete: true`. A point read authenticates only one slot and makes no
claim about ledger completeness.

## Lifecycle use

The first integration point is `ashlr vision shadow [--json]`. It reads bounded
briefing, enrollment, goal, and proposal snapshots, records one immutable
observation receipt, and emits at most one all-false `would-create` or `hold`
suggestion. It never calls goal adoption, proposal creation, agent dispatch,
merge, release, deployment, publication, external mutation, policy, or budget
APIs. A receipt failure returns nonzero and emits no trusted suggestion.

The ordinary `ashlr vision reconcile` command remains an explicit planning
mutation and does not yet write this receipt. Post-effect capture, a shared
CLI/daemon reconcile lease, and an independently activated automatic mode are
separate future integrations.

Receipts must not be read by mission readiness projection. A future shadow
reconciler may require a healthy complete receipt source as an additional audit
gate, but it must still recompute readiness from current authoritative sources
and exact current graph/briefing digests.
