# CONTRACT-M521: Dormant resident-start permit and exact-release ACK protocol

Status: protocol-only, dormant, and authority-free. There is no CLI, service,
setup, activation-transaction, launchd, install, start, pointer, rollback, or
provider-effect consumer.

## Purpose

M521 defines the next distinct authority boundary after M520's stopped-release
selector. It provides a domain-separated Ed25519 resident-start permit schema
and a canonical exact-release acknowledgement frame. These types make the
future native broker contract reviewable without pretending that JavaScript,
launchd output, a local file, or a PID can authenticate a resident process.

The protocol identifier is `runtime-activation-resident-start-v1`. Its permit
and acknowledgement domains are distinct from M502, M515, and M520.

## Resident-start permit

The permit is valid for at most 120 seconds and uses a trust-root set dedicated
to resident start. The compiled production set is a frozen empty array; config,
environment, request, and acknowledgement bytes cannot add a key.

The closed scope requests one exact macOS resident start while requiring a
healthy engaged KILL switch and blocked provider effects. It forbids enabling,
installing, pointer mutation, and dispatch. The signed bindings include:

- exact activation, M502 admission/plan/request/trust-root, and M520 stopped
  permit/receipt identities;
- dynamic signed candidate revision, Git tree, version, matching release tag,
  runtime tree, manifest, launch receipt, service descriptor, invocation, and
  configuration digests;
- the already-selected `releases/<revision>` current target and the exact prior
  unloaded/disabled launchd state;
- host UID, exact launchd label and target;
- a random 256-bit broker challenge and a bounded acknowledgement deadline.

No package version is hard-coded into M521. The version and matching tag are
bound from the signed admitted release so the protocol does not silently grant
authority to a different successor.

## Exact-release acknowledgement

The ACK is one canonical UTF-8 JSON object followed by exactly one LF and EOF.
It repeats the full permit binding, the domain-separated signed-permit payload
digest, permit/activation identity, and challenge.
It also carries native-broker observations for PID, non-reusable process-start
identity, audit token, executable vnode, code identity, and launchd job
generation. Its state is necessarily `pre-dispatch`, with the KILL switch
engaged, dispatch unauthorized, and provider effects blocked.

The protocol parser rejects accessors, exotic prototypes, missing/excess keys,
noncanonical JSON, duplicate-key encodings, BOM, CRLF, trailing or multiple
frames, malformed UTF-8, and oversized frames. Matching a frame proves only
that its bytes satisfy this closed evidence contract. It cannot prove that the
bytes came from the resident or a native broker.

Every authority bit remains false even when the signature and ACK bindings
verify. Canonical ACK evidence must never be accepted from an environment
variable, writable file, unauthenticated pipe/socket, PID-only observation, or
self-signed runtime claim.

## Frozen production refusal

`runtime-activation-resident-start-runtime.ts` exposes a frozen adapter and a
frozen empty trust-root array. Its only result is:

```text
native-hostile-process-cas-unavailable
```

The result explicitly records that no acknowledgement was accepted, no service
was started or enabled, no pointer changed, and no provider effects were
unblocked. The adapter has no registration, replacement, environment gate,
test hook, launchd call, process spawn, filesystem access, or service import.

## Next reviewed native boundary

A future implementation requires a separately installed, protected native
broker/XPC boundary outside same-UID JavaScript authority. Its versioned IPC
must provide, as one crash-recoverable transaction:

1. trusted monotonic time and external monotonic one-use permit/replay CAS;
2. fd-relative, no-follow access to protected release, pointer, plist, journal,
   and acknowledgement objects;
3. a genuine conditional old-device/inode/raw-target pointer compare-exchange,
   not a check followed by `rename` and not an unconditional swap;
4. exact native launchd prior-state and job-generation observation followed by
   bounded bootstrap/kickstart;
5. retained vnode, code-signature, executable, audit-token, PID, and
   non-reusable process-start identity through exec;
6. a broker-owned inherited ACK descriptor or authenticated socket with peer
   credentials, challenge, single-frame deadline, and EOF enforcement;
7. a signed, keyed, fsynced lifecycle journal with recovery at every phase;
8. exact stopped rollback restoration without auto-start; and
9. a separate release-bound dispatch permit after broker acceptance. The
   daemon must remain pre-dispatch under the healthy KILL switch until then.

macOS `renameatx_np(RENAME_SWAP)` alone is insufficient: it swaps names
atomically but does not condition the operation on the previously observed
destination inode. An unprivileged helper under the same UID cannot exclude a
hostile same-UID process from racing or replaying local state.
