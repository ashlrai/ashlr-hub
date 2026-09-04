# Contract M567 — Default-off Local Container Broker V1

## Status and scope

M567 is a **source-complete, default-off local adapter**, not a commissioned or
production service. When an embedding caller explicitly constructs it with
`enabled: true`, it can consume one authenticated dispatch permit and one M566
capacity reservation to run the fixed observation producer in a local Docker
container. This repository does not wire the broker into the daemon, CLI,
configuration, installers, or startup paths. It does not provision Docker, an
image, a seccomp profile, signing keys, permits, or capacity evidence.

The source tests use a fake Docker Engine protocol server on a temporary Unix
socket. They never contact a live Docker daemon and therefore do not establish
that any host, image, engine, or seccomp control is commissioned or effective.

## Admission and authority

- Disabled construction performs no filesystem, socket, or Docker operation.
- The broker captures the permit, request-frame, response-frame, isolation,
  capacity-store, journal, and Docker-client capabilities once at construction.
  Accessor-backed and proxy dependency shapes do not become runtime authority.
- Permit, request, execution identity, capacity evidence, request deadline,
  broker, engine, image, native producer, seccomp, create configuration, output
  limit, and the exact one-slot reservation must all bind before container I/O.
- The signed request/permit window is rechecked immediately before create and
  immediately before start; setup latency cannot turn stale authority into work.
- One request nonce deterministically names one capacity allocation and one
  container. The durable M566 finalized-allocation tombstone is the consume-once
  replay fence; idempotent acquisition cannot redisclose its owner capability.
- The secret lease owner capability remains in memory only. It is never written
  to the lifecycle journal, sent to Docker, or returned in public results.
- A successful permit authorizes only its exact, one-time local observation
  dispatch. Broker results and attestations convey no reusable execution,
  provider-contact, credential, external-mutation, commissioning, activation,
  or production authority.

## Docker Engine boundary

`AgentOsDockerEngineClientV1` uses Node's HTTP client directly over one absolute,
caller-pinned, direct-child Unix socket. The socket and anchor owner, type, link
count, write modes, device, and inode are checked; symlink/hardlink aliases,
replacement, Windows, and an API version other than the fixed v1.54 fail closed.
There is no Docker CLI, shell, PATH lookup, TCP endpoint, registry, pull, build,
exec, copy, volume, or generic request surface.

The only representable create request uses the digest-pinned image and fixed
native producer entrypoint. It has an empty environment and labels, no network,
mounts, binds, ports, devices, added capabilities, restart, logging, init, or
health command; it uses private namespaces, drops all capabilities, enables a
read-only root, `no-new-privileges`, the exact inline seccomp profile, and the
signed CPU/memory/swap/PID limits. A post-create inspection must match the full
effective policy before start. Stdin is the one canonical request frame;
multiplexed stdout/stderr and JSON response framing are bounded and authenticated.
Docker's empty wire values for private PID/UTS namespaces and its RFC3339Nano
and zero-value lifecycle timestamps are translated without weakening the signed
private-namespace policy.
Non-wait Engine control requests are capped at five seconds; the capacity window
must cover the signed deadline plus the full kill, wait, frame-drain, inspect,
remove, absence-confirmation, cleanup-grace, and settlement budget.

The Engine identity digest binds the pinned socket inode/device and the version
response. This is local mismatch evidence, not an independently authenticated
Docker peer identity. Same-user socket substitution and the truth of a daemon's
own API response are not claimed resistant or independently verified.

## Lifecycle, cleanup, and recovery

The broker holds a dedicated lifecycle lock across admission and one run. Before
create, it durably appends `lease-held`; after every observed boundary it appends
an immutable, digest-linked record. A successful path is:

```text
lease-held -> created -> prepared -> started -> stopped -> removed
           -> finalized -> settled
```

Container absence is confirmed before the capacity lease is released. Output is
returned only after the signed response, producer digest, wait/final inspection,
V2 finalize attestation, removal, lease release, and journal settlement all
agree. Deadline or output overflow causes bounded kill/wait and cleanup. Any
ambiguous create transport failure remains journaled and is never retried.
A negative name lookup is not proof that an already-sent create cannot become
visible later; the lease-held record remains active until cleanup-only recovery
observes and removes the container.

`recover()` is cleanup-only. It first rechecks the pinned engine identity, then
resolves a deterministic name if create may have occurred, kills a still-running
known container, removes it, confirms absence, and terminates the journal. It
never creates, starts, attaches, writes a request, or reruns producer work.
Because owner capabilities are intentionally not durable, a lease stranded by a
process crash is released only by M566's deterministic expiry/reclaim path.
Policy drift, engine drift, ambiguous inspection, failed removal, journal
corruption, lock ambiguity, and durability failure remain unavailable or
unreconciled for explicit inspection.

## Private journal and acceptance boundary

The bounded journal is rooted below a caller-pinned private anchor and reuses the
immutable private-record, exact-mode, stable-read, atomic rename/fsync, and local
lock primitives. Symlinks, hardlinks, unsafe modes, unexpected entries,
replacement, malformed transitions, digest-chain corruption, and ambiguous
durability fail closed. Public inspection is values-free and explicitly reports
no same-user tamper resistance.

M567 tests cover pure permit verification, fake Unix-socket Engine translation,
fragmented/bounded attach frames, unsafe socket aliases, private journal
durability and corruption, default-off behavior, verifier pinning, exact
admission, replay denial, removal-before-release, capacity-window refusal,
oversized output cleanup, delayed ambiguous-create visibility, running-container
cleanup, removal-confirmed settlement, and engine-drift refusal. Commissioning still
requires a separately authorized image/seccomp/key installation, a pinned host
configuration, live Docker acceptance tests, daemon integration, operational
rollback, and an explicit activation decision.
