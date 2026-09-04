# Agent OS Authenticated Runtime Read Path

Status: source implementation and scoped integration verification complete; not deployed or activated

## Delivered architecture

```text
verified source inputs (no production registry yet)
  -> buildAgentOsReadModelV1
  -> internal appendAgentOsSnapshotV1
  -> private immutable records + authenticated local tip
  -> complete-chain read
  -> AgentOsRuntimeReadResultV1 public projection
  -> server-authenticated GET /api/agent-os
  -> typed query and /agent-os cockpit
```

The path is deliberately one-way and observation-only. There is no web writer, daemon producer, model/provider dispatch, activation-permit bridge, effect-journal call, or control-snapshot coupling.

## Implemented contracts

### Private authenticated snapshot store

`src/core/vision/agent-os-snapshot-store.ts`:

- re-runs the exact Agent OS read-model builder with an explicit external verifier before accepting an append;
- binds the verified snapshot to its source, kernel, capability, and portfolio evidence;
- derives a domain-separated HMAC signer/verifier from the existing foundry provenance key;
- stores canonical private records through `ImmutablePrivateRecordStore` with an outer transaction lock;
- publishes an authenticated local current-tip checkpoint;
- handles exact replay idempotently and rejects clock regression or unavailable/incoherent chains;
- detects visible duplicate sequence, gap, predecessor break, non-monotonic time, invalid/missing/behind/mismatched tip, unsafe storage, mutation, and capacity failures; and
- withholds every private envelope and the current payload unless the aggregate read is complete.

The store explicitly reports:

- `authority:'observation-only'`;
- `sameUserTamperResistant:false`;
- `rollbackProtected:false`;
- `historicalAuthority:false`; and
- every execution or external-effect authority as false.

The local tip is a crash-consistency and current-visible-chain control. It is not an external transparency log or proof against same-user replacement of the whole store.

### Public runtime read

`src/core/vision/agent-os-runtime-read.ts` and `src/core/web/api.ts`:

- read the default store with read-only dependencies;
- return `healthy`, `missing`, or `degraded` evidence state with HTTP 200;
- expose a snapshot only for a complete, available, authenticated, observation-only chain whose authority claims are all false;
- fail closed on inconsistent or unexpectedly authoritative store results;
- emit only bounded reason/source metadata and the verified cockpit payload; and
- omit all private envelopes, HMACs, key/producer identifiers, digests, paths, sequences, and arbitrary source internals.

`server.ts` supplies the established authenticated dashboard read boundary. Unsupported methods fall through to the existing 404 behavior; no Agent OS mutation endpoint exists.

### Read-only cockpit

The web layer imports the backend response type rather than copying it. The query at `/api/agent-os`, existing `snapshot` SSE invalidation, `/agent-os` route, and shared navigation are wired in source.

The cockpit renders only when source state is healthy, the read is complete, authentication is `authenticated`, a snapshot exists, authority is observation-only, same-user tamper resistance is explicitly false, and all operational authority bits are false. Every other condition renders a missing/degraded/transport state and invents no values.

### Inert standing-permit evaluator

`src/core/autonomy/standing-permit-shadow.ts` models exact permit bindings and deterministic canaries for a future narrow authority bridge. It is pure and performs no I/O. “Criteria satisfied” is advisory evidence only: grants, executions, authority bits, and effects remain false in every result.

Authentication strings are treated only as untrusted claims. Every receipt requires an injected verifier, and the current head/floor/suffix anchor must be independently verified. Only workspace editing and model dispatch may satisfy shadow policy eligibility; commit, push, merge, release, deploy, send, and destructive capabilities are categorically ineligible. Production use still requires an explicit bridge into the existing activation/effect machinery.

## Failure behavior

| Condition | Public result | Cockpit |
| --- | --- | --- |
| Store absent | `missing`, incomplete, authentication unavailable, null snapshot | Missing state |
| Key/verifier unavailable | `degraded`, incomplete, authentication unavailable, null snapshot | Hidden |
| Invalid record or tip | `degraded`, incomplete, authentication invalid, null snapshot | Hidden |
| Authenticated gap/fork/tip mismatch | `degraded`, incomplete, bounded reason, null snapshot | Hidden |
| Unexpected authority claim | `degraded`, incomplete, literal public authority bits false, null snapshot | Hidden |
| Complete authenticated observation-only chain | `healthy`, complete, authenticated, verified snapshot | Rendered |

## Work intentionally remaining

1. Build durable production registries and independent verifier adapters for every required source bundle, evidence index, and outcome observation.
2. Implement and schedule a bounded post-durable-tick producer only after those registries exist.
3. Add external monotonic/transparency anchoring before claiming historical rollback protection.
4. Define the reviewed bridge from policy eligibility to the existing activation permit and effect journal, with per-effect reauthorization.
5. Add measured effectiveness windows, outcome receipts, counterfactual evaluation, and portfolio reallocation.
6. Separately verify source, build, installed artifact, daemon/service state, credential/trust-root state, and effect authority before any live-autonomy claim.

## Acceptance state

Scoped source acceptance passed on the reconciled tree: M526-M534 produced 99 passes and one platform-specific skip across 9 files; the full web suite produced 107 passes across 29 files; full core/web typecheck, focused Semgrep, npm audit, production build, and tracked/current-tranche whitespace checks passed. Focused ESLint reported no errors and one pre-existing unrelated warning. The monolithic backend suite was not run.

No live source, producer, daemon schedule, authority bridge, effect, deployment, or installed-runtime activation is part of this deliverable.
