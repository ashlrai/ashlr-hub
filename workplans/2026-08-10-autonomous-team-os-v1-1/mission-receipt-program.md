# Mission Receipt and Governed Autonomy Program

Status: architecture confirmed; implementation wave in progress.

## V1.1 build slices

1. `mission-observation-receipt-v1`: authenticated, immutable, bounded engineering-state snapshots. A receipt records evidence; it grants no planning, execution, proposal, merge, release, deploy, external-mutation, learning, policy, or human-decision authority.
2. Shadow reconciliation suggestion: a deterministic suggestion that identifies at most one dependency-ready node and persists no goal. Existing `planning` goals are daemon work inputs, so active materialization remains explicit and separately gated.
3. Cortex planning candidate: strict pure validation of intent-only, organization/workstream-scoped candidate bytes. No live transport, arbitrary payload, repository mapping, goal creation, or Cortex write.
4. Locus evidence envelope: strict pure validation of identity/tool-context evidence. Local/unverified evidence is display-only and never realizes a mission node.

## Evidence separation

- Engineering realization requires the exact mission graph and node binding plus verified, authenticated realized-merge evidence.
- Business outcomes remain `not-observed` in V1.1 even when engineering work is complete.
- Human decisions require a future independently authenticated decision receipt; booleans and local labels are never sufficient.
- Cortex approval, Locus identity evidence, Hub proposal approval, merge, release, deployment, publication, and provider mutation remain independent gates.

## Privacy and safety floor

Mission evidence excludes raw repository paths, objectives, rationale, goal/milestone/proposal IDs, diffs, commands, URLs, raw provider responses, transcript, forensics, credential names or values, session seals, and home paths. Sensitive local identifiers use domain-separated HMAC references. Reads are bounded and return explicit missing, healthy, or degraded source quality.

## Deferred activation gates

- No daemon goal materialization until shadow results are reviewed, a shared CLI/daemon reconcile lease exists, and activation is explicit.
- No live Cortex relay until it has permission-filtered issuance, durable revision/CAS, revocation, retention/deletion, and credential-recovery-safe authentication.
- No realization-bearing Locus evidence until a separately verifiable signed attestation binds graph, node, tool, selector/args digests, identity context, time, and nonce.
- No runtime install, start, dispatch, merge, release, deployment, publication, or external mutation is authorized by this program.
