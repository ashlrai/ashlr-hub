# CONTRACT-M568: Version-general stopped-selection broker permit

Status: protocol-complete, dormant, and authority-free. There is no production
consumer, native helper, CLI, launchd, service, pointer, plist, rollback, or
provider-effect call site.

## Purpose

M568 defines the version-general successor to M520's release-specific stopped
selector without reinterpreting or weakening any M520 v1 byte, signature,
journal, receipt, recovery, or storage contract. M520 v1 remains exclusively
bound to `3.2.7` / `v3.2.7`.

The M568 protocol identifier is
`runtime-activation-stopped-consumer-v2`. Its permit signature domain is
`ashlr:runtime-activation-stopped-consumer:permit:v2`, distinct from M502,
M515, M520, and M521.

## Closed permit

The permit is one canonical UTF-8 JSON object followed by exactly one LF and
EOF. It is valid for at most 120 seconds and is signed by a dedicated Ed25519
root. The production root set is a frozen empty array. Configuration,
environment, request bytes, and runtime input cannot add a root.

The closed scope requests selection of one exact, already-admitted macOS
release while preserving an unloaded service and its exact disabled bit. It
requires healthy engaged KILL, blocked provider effects, a native broker, a
genuine conditional pointer compare-and-exchange, and exact stopped rollback.
It forbids install, enable, start, resident acknowledgement, dispatch, and
provider effects.

The signed bindings include:

- exact activation, M502 admission/plan/request/trust-root, configuration,
  host UID, launchd label, and launchd target identities;
- dynamic candidate revision, Git tree, semantic version, matching `v<version>`
  release tag, runtime tree, manifest, launch receipt, service descriptor,
  service invocation, and relative `releases/<revision>` current target;
- dynamic rollback revision, Git tree, semantic version, matching release tag,
  runtime tree, manifest, launch receipt, service descriptor, and service
  invocation identities;
- exact absolute HOME, releases root, current-pointer, and plist paths; and
- exact prior current target, prior plist digest, `loaded=false`, and the prior
  disabled bit.

Neither candidate nor rollback version is selected by CLI, configuration, or
environment. The permit must match an independently admitted M502 plan
byte-for-byte before a future broker may consume it.

## Evidence is not authority

The pure verifier can authenticate canonical permit bytes and compare the
complete binding to an independently supplied expected binding. A successful
verification returns a domain-separated permit digest while every authority
bit remains false. It cannot consume the permit, reserve replay state, mutate a
pointer or plist, observe launchd, or authorize rollback.

The frozen production runtime always returns
`native-version-general-stopped-selection-unavailable`. It accepts no
arguments and exposes no registration, replacement, environment gate, test
hook, filesystem access, process spawn, service import, or native transport.

## M520 compatibility

M568 adds no import to M520 and changes none of these M520 v1 invariants:

- protocol, action, and permit/signature domains remain v1 and `3.2.7`-bound;
- its permit, claim, receipt, and journal formats remain byte-identical;
- its existing recovery runs independently of current permit expiry or roots;
- its cooperative pointer operation remains explicitly insufficient against a
  hostile same-UID process; and
- it never starts, enables, or acknowledges a service.

A later effectful consumer must use distinct v2 permit, claim, receipt, journal,
and replay namespaces. It must detect simultaneous v1/v2 recovery journals and
fail to reconciliation rather than choosing one.

## Native boundary still required

The future protected broker must satisfy CONTRACT-M521's native launchd v2
requirements: trusted monotonic time and external one-use replay CAS;
fd-relative no-follow custody; genuine old-device/inode/raw-target conditional
pointer exchange; a broker-keyed fsynced lifecycle journal; recovery at every
phase; and exact stopped rollback. M568 intentionally implements none of those
effects.

An npm JavaScript process or ordinary unprivileged same-UID sidecar is not this
boundary. Resident start and authenticated ACK remain M521 work, and a separate
release-bound dispatch permit remains mandatory after any future resident ACK.
