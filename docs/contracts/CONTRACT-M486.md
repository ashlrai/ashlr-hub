# M486 Runtime Release Launch Handoff V1 Contract

Status: dormant POSIX proof-child observation implemented; resident, install,
start, deployment, rollback, and activation authority are not active

## Purpose

M486 proves that one bounded child process can acknowledge four retained POSIX
descriptors while the parent revalidates the signed release and the corresponding
named filesystem identities. It narrows the verification-to-execution problem
without integrating with daemon lifecycle, service installation, admission,
readiness, CLI commands, or production trust roots.

The protocol identifier is `runtime-release-launch-handoff-v1`. The only child
is a finite proof child. The staged `bin/ashlr` command and its daemon/service
arguments are never executed.

## Protocol

The observation executes in this order:

1. Continue only on explicitly demonstrated `darwin` or `linux` hosts. Refuse
   Windows, FreeBSD, AIX, and every other platform before inspecting release
   inputs or touching claim storage.
2. Validate a caller-supplied 256-bit hexadecimal nonce and bounded
   acknowledgement timeout.
3. Open and retain descriptors for the package root, dependency root, staged
   launcher, and declared interpreter. Each descriptor must match a canonical,
   non-symlink named path; files must have one hard link.
4. Construct a new exact allowlisted `RuntimeReleaseLaunchObservationOptions`
   value, copying `argv` and buffer inputs, and run the existing signed
   runtime-release launch observation while retaining those descriptors.
   Caller excess properties and verification hooks never cross this boundary.
   Require each descriptor to still match its named identity.
5. Derive a nonce digest and deterministic transaction identity over the exact
   manifest, staged-tree, service-invocation, policy, envelope, and trust-root
   canonical digests.
6. Durably record one cooperative claim keyed by the nonce digest before child
   creation. Exact content is a replay; different content in that nonce slot is
   a conflict. Neither case starts another child.
7. Execute the declared interpreter as a new POSIX process-group leader with a
   fixed inline proof program. Register the child `error` listener immediately
   after `spawn`, before reading PID or pipe state. Pre-PID spawn failures,
   including `EACCES`, resolve through the bounded failure path without an
   unhandled event. Pass the four already-open descriptors as inherited file
   descriptors. Do not pass or execute the daemon/service argv.
8. Require exactly one bounded JSON acknowledgement containing the transaction
   ID, nonce digest, child PID, and all four child-observed descriptor
   identities. EOF is the frame boundary. The only accepted bytes are the
   exact canonical UTF-8 JSON object followed by one LF. CRLF, trailing spaces
   or tabs, a first newline followed by delayed data, extra bytes, and missing
   EOF all fail. A first newline never settles the proof.
9. While the child remains alive, compare every retained descriptor with its
   named identity, construct another fresh exact allowlisted observation input,
   rerun the complete signed launch observation, compare the six transaction
   bindings, and compare the descriptors again.
10. Signal the complete process group with TERM, escalate to KILL within a
    fixed monotonic deadline, and require both the direct child's `close` event
    and an `ESRCH` probe for the negative process-group ID before reporting
    success.

Malformed, noncanonical, multiple, oversized, mismatched, missing, timed-out,
or early-exit acknowledgements fail closed. Descriptor replacement, named-path
replacement, asynchronous spawn error, signed-input drift, claim-store failure,
exact replay, and nonce conflict also fail closed. A claim remains consumed
when child startup, post-acknowledgement, or cleanup checks fail; the protocol
does not silently retry a partially attempted proof. Unconfirmed cleanup
returns bounded PID, process-group, attempted-signal, direct-close, and
group-death remediation metadata. That metadata is returned to the caller and
is never written to the claim store.

## Receipt And Authority

Successful receipts permanently carry:

```json
{
  "assurance": "bounded-posix-proof-child-observation-only",
  "authority": {
    "activationPermitted": false,
    "deployPermitted": false,
    "installPermitted": false,
    "launchPermitted": false,
    "mergePermitted": false,
    "rollbackPermitted": false,
    "startPermitted": false
  },
  "coverage": {
    "atomicLaunchHandoff": "bounded-proof-child-observation-only",
    "descriptorLifetime": "retained-through-proof-child-acknowledgement",
    "launchConsumer": "proof-child-only-terminated",
    "mutationAfterReceipt": "not-prevented",
    "replayPrevention": "host-local-cooperative-one-use",
    "serviceMutation": "absent"
  },
  "proofChild": {
    "directChildCloseObserved": true,
    "processGroupDeathObserved": true,
    "terminated": true
  }
}
```

No result, including a successful receipt, is an activation capability. No
M486 type or record may be interpreted as permission to install, start,
restart, supervise, merge, deploy, roll back, or run the Ashlr daemon.

## Durable Claim

Claims use the existing immutable private-record store beneath the configured
Ashlr storage anchor. They persist fixed protocol metadata, false authority,
the nonce digest, transaction identity, six release-binding digests, and a
claim digest. Raw nonce bytes, manifests, policies, envelopes, paths, argv,
environment, prompts, output, diffs, and file contents are not persisted.

The store provides no-clobber publication, crash recovery, exact replay, and
conflict detection for cooperating processes under one OS account. It is not
an external monotonic consumption root. A same-user process can read, remove,
replace, or roll back local state and can interfere with pathname operations.
Consequently `sameUserTamperResistant` is permanently false.

## Descriptor And Child Boundary

Retained descriptors prevent a cooperative pathname replacement from silently
changing the objects the parent and proof child compare. Full post-ack signed
observation additionally detects nested staged-tree content drift that a root
directory descriptor alone cannot represent.

This is not portable `execveat` or `fexecve` launch authority. The OS still
resolves the interpreter pathname when creating the child, and a malicious
same-user process can race, emulate, or terminate the proof. The child is not a
resident daemon and its acknowledgement is not a service-manager or post-start
settlement receipt. Evidence says only that the bounded proof completed under
the stated cooperative threat model.

POSIX group containment covers the direct proof child and descendants that
remain in its process group. A hostile same-user descendant can attempt to
create a different session or process group; M486 is not a cgroup, namespace,
privilege, or independently supervised containment boundary. Such resistance
remains a production-activation prerequisite.

The ordinary `observeRuntimeReleaseLaunchHandoffV1` entry point accepts only
typed runtime options, uses the real host platform, and has no environment or
untyped hook lookup. Fault injection is available only through the explicitly
named `observeRuntimeReleaseLaunchHandoffForVerificationOnly` wrapper. That
wrapper returns the same permanently false authority and has no runtime
consumer.

Only Darwin and Linux are supported. Windows, FreeBSD, AIX, and all other
platforms return `platform-unsupported` because their directory durability,
descriptor inheritance, detached process-group, signal, and group-death probe
semantics are not established by this slice.

## Test Evidence

The M486 corpus contains 22 tests covering successful EOF-framed proof, exact
observer-input allowlisting under injected M442 hooks, descriptor replacement,
mismatched acknowledgement, pre-PID `EACCES`, delayed second frame, CRLF,
trailing space, trailing tab, extra bytes, timeout, crash, exact replay, nonce
conflict, trust-root divergence, post-ack mutation, real TERM resistance,
same-group descendant cleanup, unconfirmed cleanup remediation, Windows,
FreeBSD, and AIX refusal, plus import/wiring boundaries. Parameterized cases
contribute their individual executions to that count.

## Activation Gate

M486 must remain unwired and all authority false until a separately reviewed
successor provides all of the following:

- one canonical activation identity binding release tip, signed permit,
  manifest, staged tree, service definition, rollback target, and resident
  generation;
- an independently controlled monotonic consume operation that resists local
  same-user rollback;
- crash-safe phases spanning permit consumption, service mutation, resident
  claim, acknowledgement, post-start settlement, and terminal rollback;
- a bootstrap executable that performs the handoff on every resident start,
  including service-manager restarts;
- native macOS, Linux, and Windows launch semantics with hostile race and crash
  coverage; and
- rollback authority and post-start evidence tied to the same activation ID.

Green M486 tests or a successful proof receipt cannot remove any existing
production-readiness blocker.
