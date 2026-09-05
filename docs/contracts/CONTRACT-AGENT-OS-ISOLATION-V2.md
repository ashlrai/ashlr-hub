# Agent OS Observation Isolation V2 Contract

**Status:** source contract only; not commissioned, wired, installed, activated, or proven on a live Docker engine.

This contract defines the narrow evidence boundary for a future local Docker
broker that runs an Agent OS observation producer. It does not implement that
broker. The two source modules are deliberately pure:

- `agent-os-local-container-policy.ts` builds and validates a canonical,
  deny-by-construction create policy.
- `agent-os-observation-isolation-v2.ts` creates and verifies signed prepare and
  finalize attestations around one container run.

## Canonical Docker policy

The policy requires an immutable `repository@sha256:<digest>` image. It embeds
a sorted caller-approved digest allowlist and selects one native producer at the
single fixed `/opt/ashlr/bin/agent-os-observation-producer --stdio` entrypoint.
Arbitrary commands and interpreters are not representable. It hard-codes all of
the following:

- an empty environment rather than inherited host variables;
- no mounts, published ports, or devices;
- no network and private PID, IPC, UTS, and cgroup namespaces;
- no privileged mode or added Linux capabilities, with `ALL` capabilities dropped;
- a read-only root filesystem and `no-new-privileges`;
- a caller-pinned seccomp-profile digest;
- no restart and no container logging;
- mandatory CPU, memory, swap, wall-clock, and output limits, with an exact
  one-process PID ceiling and a small signed cleanup-start grace.

The policy digest is domain-separated canonical JSON. A future broker adapter
must translate every field to the Docker Engine create request and fail closed
when the engine cannot represent or confirm one. The current contract does not
claim that such a translation or enforcement exists.

## Attestation sequence

```text
caller-pinned request + policy
        |
        v
signed PREPARE attestation
  request nonce + request digest
  container ID
  broker / engine / image / producer / seccomp / create-config digests
  exact limits + short expiry
        |
        v
future broker starts and observes the container
        |
        v
signed FINALIZE attestation
  exact PREPARE digest and all original bindings
  request / response / final-inspect / exit / removal evidence digests
  output byte count, truncation, and limit-exceeded facts
  exit code, OOM/timeout facts, deadline-kill evidence and timing
  bounded cleanup start/removal timing
  confirmed removal and post-removal absence
```

The verifier first takes one recursively owned immutable snapshot of every data
argument. Proxy-backed inputs, accessors, cycles, and non-plain data graphs are
rejected before signature validation. Prepare and finalize signatures use
distinct domain-separated payloads. Each
attestation has its own domain-separated digest, a canonical 64-byte Ed25519
signature, a bounded validity window, and exact-key validation. Verification
rejects substituted nonces, container IDs, implementation digests, limits,
post-run evidence, signatures, prepare links, expired records, impossible
deadline/kill/cleanup chronology, extra properties, accessors, and mutating
verifier callbacks. Image, seccomp, native producer, resource limits, and the
create-config digest must all agree with one admitted canonical policy snapshot.
The cleanup-start delay is capped by the policy's `cleanupStartGraceMs`, while
removal itself remains independently capped by the protocol cleanup-duration
limit.

## Replay consumption is a later stateful gate

This pure verifier is mismatch-resistant, not replay-proof. A request nonce is
cryptographically bound and caller-pinned, so an attestation for request A
cannot satisfy request B. The verifier does not durably consume that nonce.
Every inspection reports `replayConsumptionRequired: true` and
`replayConsumptionVerified: false`. A later broker/runtime slice must place a
durable atomic consume-once ledger in front of admission and recovery-test it
before any production activation claim.

## Authority boundary

An admitted policy means only that the data structure is safe and canonical.
A verified attestation means only that the configured verifier authenticated an
exact caller-pinned statement. Every result explicitly leaves execution,
effects, credentials, commissioning, activation, container provisioning, and
isolation enforcement unauthorized. Broker truth and Docker enforcement remain
unverified until a later slice supplies, commissions, wires, and live-tests an
independent broker and engine evidence path.

This contract therefore cannot be used by itself to label Agent OS isolation,
the observer, the daemon, or a release as production-active.
