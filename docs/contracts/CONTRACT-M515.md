# CONTRACT-M515: Activation-Bound Launch Handoff Observation V1

Status: dormant proof-child observation implemented; resident, service,
install, launch, dispatch, effect, rollback, and activation authority absent.

## Purpose

M515 narrows the gap between the signed M502 runtime-activation admission and
native execution. It proves that one finite child of the exactly admitted
interpreter can acknowledge retained descriptors for the admitted candidate
package, dependency tree, launcher, and interpreter. The proof child is always
terminated. The admitted launcher, daemon argv, and launchd descriptor are
never executed.

The protocol identifier is `runtime-activation-launch-handoff-v1`.

## Inputs and platform boundary

The production observation accepts only an absolute private activation-request
path, its expected 256-bit M502 admission digest, and an optional bounded ACK
timeout. It derives the current macOS account home from the operating-system
account database and requires the `HOME` environment value to match exactly.
Non-macOS hosts refuse before admission observation or claim storage.

Fault-injected platform, home, clock, and proof-child source are available only
through the explicitly named verification entry point. That entry point grants
the same permanently false authority as production observation.

## Protocol

The observer performs these steps:

1. Refuse unless the effective platform is macOS and the account home is exact.
2. Run the complete M502 execution-plan observation and require the result's
   admission digest to equal the caller's expected digest.
3. Open and retain read-only, no-follow descriptors for the admitted candidate
   package root, dependency root, `bin/ashlr` launcher, and interpreter. Files
   must be canonical single-link regular files; roots must be canonical
   directories.
4. Repeat M502 observation, compare the stable admission, plan, canonical
   request, and operator trust-root digests, and compare every retained
   descriptor with its named identity. Preserve the second observation's raw
   candidate/rollback launch-receipt digests as point-in-time evidence; do not
   compare them because their completion timestamps are intentionally volatile.
5. Derive a domain-separated digest of M502's replay key and a deterministic
   transaction ID. Before child creation, durably publish one cooperative claim
   below `~/.ashlr/control/activation/handoff-claims-v1`.
6. Exact claim replay and conflicting claim content both refuse before another
   child starts. Degraded or incomplete claim storage fails closed.
7. Spawn only the admitted interpreter with a fixed inline proof program, an
   empty environment, no shell, the candidate package as cwd, a new process
   group, and the four retained descriptors at file descriptors 3 through 6.
   The admitted launcher and daemon/service arguments are never executed.
8. Require exactly one bounded canonical UTF-8 JSON acknowledgement followed
   by one LF and EOF. The ACK binds protocol, transaction ID, replay-key digest,
   child PID, and all four descriptor identities. CRLF, multiple frames,
   trailing bytes, missing EOF, malformed JSON, mismatch, timeout, early exit,
   oversized output, and spawn failure all fail closed.
9. While the child remains alive, revalidate every descriptor, repeat the full
   M502 observation, compare its stable admission identity, and revalidate
   every descriptor again. The admission digest already binds both stable
   candidate/rollback observation identities.
10. Signal the complete child process group with TERM, escalate to KILL on a
    monotonic bounded deadline, and require both direct-child close and an
    `ESRCH` probe for the negative process-group ID before success.

A claim remains consumed after any attempted child creation. Failed or
unconfirmed cleanup returns bounded remediation metadata; it never retries or
reports success.

## Persisted data

The cooperative claim contains only:

- the protocol and schema version;
- immutable false authority fields;
- the domain-separated replay-key digest and transaction ID;
- admission, plan, canonical-request, trust-root, and candidate/rollback
  launch-receipt digests; and
- its domain-separated claim digest.

It does not persist raw replay keys, paths, argv, environment, manifests,
policies, prompts, output, file contents, credentials, or provider data.

The immutable private-record store provides no-clobber publication, exact
replay, conflict detection, and crash recovery for cooperative processes. It is
not an external monotonic authority. A same-UID process can roll back local
state, so `sameUserTamperResistant` remains false.

## Receipt and authority

A successful receipt proves only a bounded proof-child observation. Its child
is already dead. Every receipt and failure keeps these permissions false:

- activation, install, launch, start, and service mutation;
- dispatch and provider/effect execution;
- rollback, deployment, merge, and publication.

M515 does not call launchd, install or alter a plist, run the daemon, move the
release pointer, contact a provider or model, consume an external CAS, or
acknowledge a resident runtime. It has no CLI, service, setup, daemon, or
activation-transaction consumer.

Retaining the interpreter descriptor does not provide `fexecve`/`execveat`
semantics: child creation still resolves the named interpreter path. The
post-ACK named-identity check catches cooperative replacement but cannot stop a
same-UID adversary from racing, restoring, emulating, or terminating the proof.
The new process group is cleanup containment, not a VM, namespace, or cgroup;
a hostile descendant can attempt to create a different session. These limits
are why the receipt remains observation-only.

## Successor gate

A future native resident-canary transaction must separately provide external
monotonic replay consumption, trusted time, signed prior native state, a
signed/fsynced lifecycle journal, isolated canary label and bounded lifetime,
release-bound proposal-only dispatch authority, mandatory confinement, live
launchd PID/executable/bootstrap acknowledgement, atomic pointer CAS, crash
recovery at every phase, and exact stopped rollback restoration. M515 evidence
cannot remove any of those blockers.
