# Agent OS Observation Sandbox V1

Status: contract and commissioning preflight only. No backend is commissioned,
no daemon lane is enabled, and M562 continues to accept only a trusted in-process
observer callback.

## Honest boundary

`AgentOsObservationSandboxV1` is the protocol between the M562 observation
coordinator and a future local isolation backend. It does not turn a callback,
a child process, or a Node flag into a sandbox. A run is `enforced` only when a
fresh attestation is authenticated by a separately configured verifier and
binds the expected backend identity and policy.

The attested policy must prove all of the following at once:

- a separate process and an isolation boundary intended for untrusted code;
- denied network access, runtime/input-only filesystem reads, and denied filesystem writes;
- a minimal sanitized environment and denied ambient host IPC;
- denied child processes, worker threads, native addons, WASI, and inspector;
- backend-enforced deadline termination and bounded output collection; and
- a response-bound process identity.

The controller authenticates exact canonical request and response frames with
role-separated attestation, controller-request, and backend-response keys,
binds each request to the epoch, durable tick, attempt, start receipt, input,
deadline, output cap, backend, and policy, and rereads the exact backend
attestation after execution. Callback mutation, attestation drift, stale
evidence, oversized output, late completion, malformed Base64, digest mismatch,
and authentication failure all withhold the output.

This is still an observation-only capability. An authenticated sandbox result
grants no planning, execution, effect, credential, commissioning, activation,
or external-mutation authority.

## Why Node 22 is a seatbelt, not the boundary

Node 22.22.3 is installed on the inspected host. Node 22's stable Permission
Model can restrict `node:fs`, child processes, worker threads, native addons,
WASI, and the inspector when Node starts with `--permission` and the related
allow flags are omitted. The V1 helper returns a minimal defense-in-depth flag
set, but a `node-permission-seatbelt` attestation is hard-coded to remain
`seatbelt-only`.

This follows Node's own threat model: the Permission Model is a seat belt for
trusted code and does not provide guarantees against malicious code. The Node
22 documentation also says filesystem restrictions apply through `node:fs`
and do not guarantee that another API cannot access the filesystem. A local
probe confirmed child-process creation was denied by the listed flags while
`fetch()` still reached the network; Node 22 does not provide the newer network
permission described by later Node releases.

Primary references:

- [Node.js 22.18 Permission Model](https://nodejs.org/download/release/v22.18.0/docs/api/permissions.html)
- [Node.js 22.17 command-line permission flags](https://nodejs.org/download/release/v22.17.0/docs/api/cli.html)

## Why the existing macOS launcher is not auto-commissioned

The inspected host has `/usr/bin/sandbox-exec`, and a trivial SBPL profile ran
successfully. Hub's existing `src/core/sandbox/confine.ts` uses it effectively
for a different threat model: interactive engineering agents working in a Git
worktree. That profile begins with `(allow default)`, re-allows vendor homes,
and intentionally retains broad process functionality. Its launcher builder
does not produce a fresh authenticated proof that the child actually started
under the expected profile, remained there, was killed at its deadline, and
had bounded output.

Reusing that launcher would therefore overstate the M562 guarantee. A future
macOS adapter can qualify only after it uses a dedicated deny-first observation
profile and independently demonstrates each required control through an
authenticated commissioning and runtime attestation. A local container or VM
backend can implement the same protocol without changing M562 records.

## Commissioning sequence

1. Choose a local backend and pin its executable/image and policy digests.
2. Implement a dedicated producer process that accepts only authenticated V1
   request frames and emits only authenticated V1 response frames.
3. Red-team filesystem writes, egress, subprocesses, workers, addons, WASI,
   inspector, deadline termination, output flooding, and process substitution.
4. Install a distinct attestation trust root and frame keys through an explicit
   ceremony. Do not accept a key ID supplied by the backend as its own trust.
5. Run crash, timeout, cancellation, and attestation-rotation acceptance with
   M562 still disabled.
6. Add the sandbox dependency to the composition root, then enable one
   observation lane through the separately governed daemon activation path.

Until those steps complete, the exact residual is: authenticated framing and a
fail-closed commissioning gate exist, but no local isolation backend is proven
or active and the M562 callback must remain trusted and side-effect-free.
