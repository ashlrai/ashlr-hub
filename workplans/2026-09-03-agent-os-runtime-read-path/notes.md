# Notes: Agent OS Authenticated Runtime Read Path

## Reconciled implementation state

- The Agent OS foundation includes Execution Identity, Capability Spectrum, Living End-State portfolio, strategic investment compilation, kernel shadow, the exact-bound read model, an authenticated snapshot store, a narrow runtime projection, an inert standing-permit evaluator, and the read-only cockpit.
- The cockpit is mounted in source at `/agent-os` and queries `GET /api/agent-os`; this does not prove that a built or installed desktop artifact contains the change.
- No production component currently constructs the complete `AgentOsReadModelInputV1`. The internal append API exists, but no daemon loop, background child, API writer, provider, model, or external source invokes it.
- Entire is enabled in manual-commit mode but had no checkpoint for this branch at task start.

## Data and trust flow

1. The internal append boundary receives exact kernel, capability, portfolio, and hypothesis inputs plus a source digest and explicit read-model verifier.
2. `buildAgentOsReadModelV1` re-verifies the inputs, requires external source-bundle, evidence-index, and independent outcome-observer authentication, and derives only closed deterministic cockpit labels. Invalid, stale, cross-basis, oversized, unauthenticated, or outcome-forged input is rejected before storage.
3. `agent-os-snapshot-store.ts` writes canonical authenticated envelopes through the hardened immutable private-record store. It uses the existing foundry provenance key and does not mint another credential.
4. The store enforces a sequence/predecessor/time chain and an authenticated current-tip checkpoint. Reads withhold all envelopes and the current payload when storage, authentication, lineage, or checkpoint completeness degrades.
5. `agent-os-runtime-read.ts` removes the private envelope and publishes only source state, completeness, bounded reason, optional verified snapshot, authentication state, and literal false authority claims.
6. `server.ts` authenticates the read before `api.ts` dispatches `GET /api/agent-os`. Healthy, missing, and degraded reads use HTTP 200 so transport status is not confused with evidence status.
7. The web view mounts the cockpit only when the response is healthy, complete, authenticated, observation-only, `sameUserTamperResistant:false`, and every effect-authority bit is false. Otherwise it renders an explicit missing or degraded state without sample values.

## Security findings and resulting controls

- **Observation authenticity is not effect authority.** The host-shared provenance HMAC authenticates local records, but it grants no execution, proposal, merge, release, deployment, publication, external-mutation, or budget authority.
- **Same-user compromise remains outside the trust boundary.** A process that can read the provenance key can forge records. The store and public response therefore publish `sameUserTamperResistant:false`.
- **Historical rollback is not proven.** The chain and tip detect duplicates, gaps, predecessor forks, clock regression, malformed records, and currently visible tip mismatches. A same-user attacker can still replace the entire ledger and tip with an older coherent copy. `rollbackProtected:false` and `historicalAuthority:false` are mandatory until an independent monotonic anchor exists.
- **The read path does not create credentials or storage.** Default runtime reads use the provenance key's read-only loader. Missing key/store state is unavailable or degraded, not silently initialized.
- **Private persistence metadata stays private.** Public responses omit raw envelopes, authenticators, producer/key identities, all digests, sequence numbers, filesystem paths, and arbitrary source internals. Public JSON scrubbing remains defense in depth rather than the primary boundary.
- **API auth is centralized.** `server.ts` default-denies unauthenticated `/api/*` reads before `handleApi`; the new route does not add a second token system. There is no POST/PUT/PATCH/DELETE Agent OS route.
- **The cockpit does not infer.** Missing, invalid, incomplete, unexpectedly authoritative, or same-user-tamper-resistant responses hide all capability, value-bet, and next-action values.
- **Standing-permit marker strings are untrusted.** Every receipt requires an injected verifier and the head, sequence floor, suffix base, and predecessor require a separately verified current anchor. Missing verification fails closed, only workspace-edit/model-dispatch can become policy-eligible, and the evaluator cannot activate anything.
- **Caller-authored prose is not public evidence.** The read model no longer accepts display metadata or copies claims/metrics/account/path fragments. Public text comes from a closed deterministic taxonomy.
- **Signed-tip crash residue is recoverable.** Under the transaction lock, only the exact fixed temporary tip is inspected. Valid signed residue matching the authenticated head can finalize; malformed, widened, symlink, stale, or conflicting residue is exact-inode checked before only that fixed name is removed.
- **Windows storage is fail-closed.** The current private snapshot implementation reports the platform unsupported rather than weakening filesystem assumptions.

## Standing-permit boundary

The shadow contract binds principal, workload, repository, mission, spec, tool, environment, budget, time window, acceptance, rollback, and revocation-policy digests. Its canaries cover scope, expiry, replay, supplied-chain fork/counter regression, budget, mission/spec drift, evidence/posture health, reversibility/blast radius, signer, and complete contract binding.

Even when every canary passes:

- `policyEligible` on the permit remains false;
- `grant.requested` and `grant.granted` remain false;
- execution remains unrequested, unauthorized, and unperformed;
- every authority bit and effect flag remains false; and
- no activation permit, effect journal, credential, filesystem, provider, Git host, release system, deployment system, or communications channel is consulted.

A later bridge must use the existing `daemon/activation-permit.ts` and `util/effect-journal.ts` systems, not reinterpret the shadow verdict as authority.

## Verification state

Focused tests have been added for:

- permit contract exactness and fail-closed canaries;
- canonical append, HMAC authenticity, replay, clock regression, widened/tampered input, visible high-water inconsistency, sequence gaps, predecessor breaks, torn-checkpoint recovery, and sensitive/non-exact model rejection;
- public-response minimization, missing/degraded/authority-mismatch withholding, server-level read authentication, HTTP 200 evidence states, and absence of a mutation route; and
- UI loading, transport error, missing/degraded/authentication/authority states, backend type parity, navigation, and query behavior.

Final reconciled evidence: M526-M534 ran 99 passed and 1 platform-specific skip across 9 files; all 107 web tests passed across 29 files; core/web typecheck, focused Semgrep, production build, npm audit, and tracked/current-tranche whitespace checks passed. Focused ESLint had 0 errors and one pre-existing unrelated warning. The monolithic backend suite was not run.

## No-live-activation record

No production source was created, no snapshot was deliberately written to the user's live store, no daemon producer was scheduled, no service was restarted, no provider or model was called, no standing grant was minted, no effect was prepared or committed, and no merge, release, deployment, publication, external communication, destructive operation, or installed-runtime promotion was performed by this workstream.
