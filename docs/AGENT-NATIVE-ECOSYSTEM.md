# Ashlr agent-native engineering ecosystem

Status: canonical target architecture with the host-local epoch observation runtime and its source, attempt, and snapshot persistence implemented in source. This document grants no operational authority and does not claim commissioning, installation, deployment, provider activation, or user acceptance.

## Product outcome

Ashlr should make engineering intent executable by a fleet without making the engineer coordinate every agent. The system continuously senses the available project and resource state, selects a small portfolio of falsifiable value bets, allocates compatible model and tool capacity, executes within narrow authority, verifies the result, and updates its end-state model from outcome evidence.

The goal is not maximum token consumption or agent activity. It is maximum durable product, user, information, and reusable-IP value per constrained time and compute window.

[Agent OS Doctrine](./AGENT-OS-DOCTRINE.md) defines the safety and autonomy invariants. This document defines how the independently useful Ashlr products compose.

## One kernel, independent products

Hub is the only cross-product mission and resource kernel. It does not absorb the other products or import their broad internal APIs.

| Product | Independent value | Ecosystem role | Hub boundary |
| --- | --- | --- | --- |
| Ashlr Hub | Fleet cockpit, mission control, scheduling, and evidence | Chooses value bets and coordinates bounded work | Signed observations and narrow effect manifests |
| Ashlr Plugin | Compact tools and agent-facing workflows for Codex and Claude Code | Measures and improves context efficiency | Aggregate efficiency receipt; never raw sessions or prompts |
| `@ashlr/core-efficiency` | Reusable compression, budgeting, token, cache, genome, and local-context primitives | Computes portable context policies and accounting | Stable compiled receipt/types package |
| Ashlr Cortex | Durable organizational memory and intelligence | Supplies governed knowledge and evidence references | Versioned retrieval/evidence receipt |
| Locus and MMCP | Workspace and tool context | Supplies resource-specific tools and current workspace observations | Audience-bound MCP capabilities and redacted observations |
| Ashlr Stack | Provider and service lifecycle control plane | Reports topology and prepares provider changes | Observation manifest and separate planned-effect manifest |
| Phantom | Local vault and credential-capability broker | Delivers the minimum secret capability at the enforcement point | Metadata or opaque capability reference; never a secret value |
| wrkpad | Deliberate physical control surface | Human attention, approval, kill, and fleet navigation | Signed local input event with visible current binding |

Each product owns its internal implementation, release lifecycle, and standalone interface. Ecosystem compatibility is negotiated through small versioned protocols, not shared databases, root-barrel imports, copied source, or ambient credentials.

The verified Desktop layout currently has one canonical source checkout for Hub, Cortex, Plugin, Core Efficiency, Stack, Phantom, Locus, and wrkpad. MMCP is not currently present at its configured Desktop path. Product release repositories and registered worktrees are separate Git identities, not duplicate source roots. New agent worktrees belong under `~/.ashlr/worktrees/<product>/<workstream>` with an owner, base commit, branch, expiry, process state, and recovery policy; they should not accumulate as top-level Desktop folders.

## The distributed decision loop

The official *Sea Strike 2043* film uses a useful control-loop pattern: preserve uncertainty, run courses of action against a deadline, acquire more evidence, reconfigure modular capabilities, sustain distributed observations, and request authorization immediately before synchronized effects. Agent OS applies that pattern to engineering without importing the military domain.

```text
living intent + current constraints
              |
              v
 authenticated common operating picture
              |
              v
  competing value hypotheses and COAs
              |
              v
 deadline-aware capacity allocation
              |
              v
 isolated build / test / research missions
              |
              v
 independent artifact and outcome evidence
              |
              +------> learn and reallocate
              |
              v
 current narrow permit at the effect boundary
```

The authorization edge is deliberately late. Recommendation, source completion, tests, a signed receipt, and a planned effect remain distinct from permission to merge, deploy, communicate, spend, provision, reveal a credential, or mutate an external system.

## Kernel planes

1. **Intent** stores the living end state, mission graph, invariants, current bottleneck, acceptance contracts, and stop conditions.
2. **Identity** binds the human principal, workload, model/account, repository, worktree, tool, environment, policy generation, and revocation epoch.
3. **Resource** represents verified model windows, local compute, context budget, worktrees, tools, and interactive reserves. Unknown or stale capacity is zero.
4. **Planning** maintains no more than a small active portfolio, generates competing courses of action, and records explicit assumptions and counterfactuals.
5. **Execution** dispatches isolated work packages with the smallest time-, budget-, repository-, and effect-bounded capability.
6. **Evidence** authenticates inputs, artifacts, verification predicates, observation windows, and outcomes while preserving missing, degraded, estimated, and independently measured states.
7. **Command** exposes topology, exceptions, headroom, active bets, evidence quality, kill/revoke controls, and the next consequential decision.

No plane may manufacture authority for another.

## Protocol fabric

Every cross-product protocol follows the same envelope rules:

- an exact schema and protocol major version;
- bounded canonical bytes, with unknown fields rejected;
- source product, version, commit, generation, and freshness window;
- a domain-separated content digest;
- an explicit privacy class and a strict data allowlist;
- an explicit source state such as missing, degraded, local-unverified, authenticated, or independently observed;
- literal authority and effect fields that cannot be inferred from prose;
- replay identity, predecessor or sequence where history matters; and
- a separate authenticity mechanism when a deployment provisions trust roots.

A digest proves deterministic integrity. A signature can prove origin under its trust policy. Neither proves the real-world truth of a claim.

### Agent OS source bundle V1

The first implemented authenticated protocol binds the complete Agent OS read-model input to:

- a default-empty, role-separated Ed25519 trust policy;
- distinct source, evidence-index, and outcome-observer principals;
- full outcome-verification inputs rather than an outcome label;
- monotonic sequence and predecessor lineage;
- issue and expiry times; and
- permanently false planning, execution, merge, release, deployment, publication, budget, learning, and external-mutation authority.

Hub stores only externally signed bundles. Reads never create a trust root, signing key, or healthy source state.

### Efficiency receipt V1

Plugin and Core Efficiency target the same V1 canonical aggregate receipt containing only bounded interval counters, accounting method, pricing version, measurement class, and producer version/commit. It distinguishes directly measured savings from estimated or counterfactual savings. Hub's consumer is implemented. Compiled Core Efficiency and isolated Plugin producer candidates pass the three-product conformance runner from uncommitted worktrees; neither is yet a published package or installed producer.

The receipt excludes prompt text, tool arguments, response content, absolute paths, repositories, account labels, session identifiers, customer data, and arbitrary metadata. The current local Plugin ledger's 266,578,850-token saving is therefore treated as an estimated product signal until independent measurement and downstream quality evidence exist.

### Stack observation manifest V1

Stack emits a deterministic observation manifest from its own boundary. It may include a sanitized topology, resource-kind counts, bounded health classes, freshness, and Phantom availability metadata. It excludes resource identifiers, quotas with account detail, provider response bodies, OAuth scopes, local paths, secret names, and secret values. The compiled producer candidate and Hub consumer pass exact-byte conformance in an isolated, uncommitted Stack worktree; no provider discovery or live Phantom access was performed.

Hub consumes caller-supplied manifest bytes. It never imports Stack's broad root barrel, runs provider probes, reads Stack's local config, or asks Phantom to reveal a secret while building an observation.

### Locus workspace identity observation V1

Locus now has an isolated compiled producer that projects its existing `AgentReport` into a five-minute, metadata-only workspace identity observation. It carries opaque audience/workspace digests, bounded lineage, identity/pin/policy/approval posture, MCP registration booleans, and Phantom availability without tenant names, aliases, paths, commands, sessions, provider accounts, credential references, secret names, or secret values.

Hub's pure consumer accepts only exact canonical bytes from the audited Locus 0.5.x contract, requires the exact caller-owned audience, workspace, sequence, and predecessor bindings, verifies the domain-separated digest and freshness, and emits a fresh immutable observation whose origin, truth, release provenance, trust, eligibility, and every authority/effect flag remain false. The shared corpus covers both a synthetic non-null adapter vector and the exact newline-free production CLI projection with null optional adapter metadata.

A separate host-HMAC lineage ledger now enforces exact per-audience/workspace genesis, sequence, source predecessor, and local record predecessor continuity with bounded private storage. Replay, forks, gaps, cross-chain routing, stale/future input, corruption, unsafe storage, missing keys, and capacity all fail closed; capacity reports `rollover-unimplemented`. M549 derives audience-scoped workspace bindings from private caller labels under an existing key, and the M552 atomic admission wrapper is the only path that establishes that privacy provenance: it re-verifies the capability at publication, constrains the complete observation interval to its window, and durably binds capability identity, purpose, policy generation, and window in the M548 record. The preserved direct append is explicitly `direct-unverified` and cannot mix with a verified lineage. This still does not authenticate Locus identity, prove filesystem/workspace truth or release provenance, resist rollback by the same OS user, or anchor policy-generation rotation. The producer, consumer, mint, wrapper, and ledger are committed on the development line but remain unmerged, unreleased, and uncommissioned; no Locus home, binding, pin, approval, Phantom credential, or MCP configuration was changed.

### Planned effect manifest V1

A provider plan is a separate object from Stack observation. It binds the exact target, action class, preconditions, expected diff, idempotency key, rollback limits, cost ceiling, required secret capability class, acceptance check, and expiry. Creating or validating the manifest grants no execution authority.

The future effect path is:

```text
Hub proposal
  -> Stack deterministic plan
  -> policy decision
  -> current identity/capability/kill/budget recheck
  -> Phantom delivers opaque short-lived capability at enforcement
  -> Stack performs one idempotent effect
  -> independent result and outcome receipts
```

Plaintext secrets must never be placed in process arguments, logs, telemetry, mission state, or Agent OS snapshots. Secret transport should use an OS-protected descriptor, standard input, or authenticated local IPC when the producer contracts support it.

## Resource scheduler

Subscription plans are perishable inventory. The scheduler should know the compatible model/account, remaining trusted window, reset time, task shape, expected information gain, interactive reserve, and measured reliability. It should allocate cheap or local models to broad exploration, classification, mutation testing, replay, and verification only where observed quality is sufficient; frontier capacity should handle the work with the highest marginal reasoning value.

Allocation is a lease, not a belief that capacity exists. Reservations require atomic ownership, expiry, cancellation, crash recovery, and reconciliation with observed provider state. Capacity that cannot be independently observed is labeled unknown and contributes zero to an executable plan.

The portfolio objective is:

```text
expected durable value + information gain + reusable IP + dependency unlock
-------------------------------------------------------------------------
 token cost + elapsed time + failure risk + coordination cost
```

This is a scheduling model, not a validated financial metric. Every estimate keeps its source and calibration history.

## Autonomous effectiveness

The fleet can close routine work without a human only when the acceptance contract was frozen before execution and a distinct observation supplies the result. The producer cannot rewrite the metric, observation window, baseline, or guardrail after seeing the outcome.

Each bet resolves to one of:

- `effective`: the predeclared threshold was met with complete evidence;
- `refuted`: the evidence falsified the hypothesis;
- `inconclusive`: evidence quality or the observation window was insufficient;
- `guardrail-breached`: a frozen safety or product constraint failed; or
- `superseded`: the mission changed with explicit ancestry.

The learning model retains failed hypotheses, contradictory evidence, predicted probability, elapsed time, token use, intervention rate, and downstream outcome. It rewards calibrated prediction and retained value, not code volume or agreement among agents.

## Autonomy rollout

Promotion is per effect class and capability, never one global autonomous switch.

| Stage | Capability | Required proof before promotion |
| --- | --- | --- |
| 0 | Authenticated observation | Privacy, exact schema, freshness, provenance, replay, corruption, and missing-source tests |
| 1 | Shadow portfolio and allocation | Deterministic replay, counterfactual quality, calibration, no invented inputs |
| 2 | Isolated research/build/test | Sandbox escape tests, bounded resources, cancellation, artifact provenance |
| 3 | Workspace-local reversible edits | Nominal identity, repository/worktree scope, checkpoints, rollback, low escape rate |
| 4 | Commit and proposal creation | Complete acceptance evidence, attribution, no implicit push/merge authority |
| 5 | Selected integration effects | Immediately rechecked permit, idempotency, protected-branch and effect-journal evidence |
| 6 | Selected provider operations | Canary, cost/blast-radius bounds, secret capability isolation, revocation, recovery |
| 7 | Adaptive value portfolio | Longitudinal outcomes, anti-Goodhart audits, human override integrity, reliable degradation |

## Current source boundary

The current repository tranche implements source-level identity, capability, portfolio, kernel, read-model, snapshot, signed source-bundle, durable source registry, observer-attempt, bounded observer-transaction, cross-ledger observation coherence, daemon authority sealing, external efficiency/Stack/Locus consumers, a privacy-safe Locus binding mint and atomic admission wrapper, a bounded Locus lineage ledger, a default-off legacy observer boundary, and the source-complete M553-M564 epoch persistence, recovery, runtime, and trust-composition stack described below. The Agent OS read path and mounted cockpit route remain observation-only and degrade when no authenticated snapshot exists. The M562/M564 epoch runtime and M562b isolation protocol do not yet have a production composition root or daemon call site. Released producer provenance, live-current Stack/Locus evidence, key commissioning, authenticated external anchoring, an enforced observation-isolation backend, and local epoch-runtime activation remain outstanding.

This does not establish that the observer is installed, scheduled, provisioned with public keys, supplied by external producers, or operating against live products. It creates the fail-closed substrate needed to do those things without turning data into authority.

In the earlier observation path, successful source-digest deduplication requires an exact authenticated terminal-to-snapshot binding. A wholly absent legacy snapshot ledger is regenerated through its bounded attempt policy; corrupt, gapped, conflicting, or orphan-checkpoint state remains visibly degraded and is never rewritten automatically. Official source publication and snapshot publication share one transaction lock, so the exact current signed source remains stable through commit. This is a host-local coordination guarantee, not rollback protection against the same user or mixed old/new binaries.

The M550 rollover core now turns the M546 specification into strict canonical epoch manifest/head codecs, exact previous-epoch lineage, derived attempt namespaces, deterministic operation identities, and a pure external-anchor compare-and-swap outcome classifier. An ambiguous CAS is never accepted from the adapter response alone: exact canonical reread determines committed, unchanged, or conflicted state. Field-specific codecs preserve the existing raw signed-artifact digests while reserving `sha256:<64>` for control-plane identities; a post-genesis epoch cannot silently reuse a genesis source or snapshot sentinel.

M553-M556 establish the durable rollover substrate. The local epoch store prepares immutable exact-private epoch artifacts and empty `sources/`, `attempts/`, and `snapshots/` roots through no-clobber staging publication, file and directory fsync barriers, pinned directory-identity checks, and exact rereads. It can install or recover only a non-authoritative local active pointer after a fresh injected anchor read agrees byte-for-byte while both the process-resident protocol lease and cross-process observation transaction lock are held. Pointer replay closes the durability barrier again. Windows remains fail-closed because equivalent parent-directory fsync evidence is not established.

The rollover recovery layer is a pure deterministic classifier: it distinguishes preparation, safe CAS readiness, mandatory reread, same-operation replay, pointer-forward recovery, conflict, unavailable anchor, and degraded local state without performing I/O. Epoch-aware signed Source Bundle V2 and locally authenticated Attempt Receipt V2 contracts bind epoch, namespace, sequence, prior lineage, trust generation, source closure, and terminal evidence through separate domains and authenticated epoch contexts. The process lease is host-local and cooperative; it prevents duplicate module copies in one process from holding incompatible writer digests but does not claim durable exclusion or rollback resistance.

### Epoch-local observation durability

M561 Source Store V1 treats M553's immutable M555 Source Bundle V2 as source sequence one without copying it, then persists signed Source Renewal V1 records as contiguous sequences 2 through 4096. Sequence numbers, predecessors, and the current tip are derived from the complete authenticated ledger rather than caller claims. Renewals preserve epoch, head, manifest, namespace, policy, source-principal, and time lineage. The adapter exposed to M557 resolves an attempt authenticator only from a complete authenticated historical source lineage, so source A receipts remain verifiable and closable after the active source renews to B; a missing or corrupted historical proof degrades the whole relevant read instead of silently accepting a shorter prefix. For a complete attempt-ledger read, the adapter authenticates the source chain once, indexes it by source and policy, and resolves one canonical de-duplicated historical-source batch into ordered verifier-only decisions. It deliberately omits signing authority from the batch path.

M557 persists deterministic, immutable two-record Attempt Receipt V2 chains: a start receipt followed by exactly one terminal receipt. New starts bind the current authenticated source generation, while completion and replay authenticate the source and attempt-key generation recorded by the durable start. A successful terminal additionally requires an exact Snapshot V2 binding over the epoch head, namespace, attempt ID, start-receipt digest, source, policy, and snapshot envelope digest. Complete attempt reads structurally scan the attempt ledger once, use the M561 historical-source batch above, and submit all successful snapshot bindings as one canonical sorted batch. M560 performs one authenticated snapshot-ledger scan and returns one digest-keyed decision per binding. The source and snapshot joins are linear in their ledgers and fail closed on missing, duplicate, reordered, substituted, or callback-mutated batch evidence. Point and write paths intentionally retain singleton historical-source resolution so signing authority is selected only for the one exact transition being admitted.

M558 and M560 define and persist Snapshot V2. Each envelope binds the manifest-provided base or prior envelope, contiguous epoch-local sequence, exact M557 attempt and start receipt, durable tick, source and policy lineage, producer/key generation, component digests, and the read-model payload. The store derives sequence and predecessor from the complete durable ledger, requires an authenticated historical context and exact start receipt, refuses source-renewal-based snapshot-signer rotation inside an epoch, and exposes the reciprocal batch verifier used by M557.

M562 is the observation-only runtime coordinator for this local persistence stack. For one durable tick it acquires the M556 process lease and observation transaction lock, freshly reads the injected authenticated closure, durably writes or replays the start, runs the bounded observation callback, writes or replays the reciprocal snapshot, and only then writes or replays a successful terminal. The attempt and snapshot stores share a live runtime commit guard. Cancellation and deadline checks fence admission, callback completion, and snapshot publication; a late stop records a non-success terminal without publishing a snapshot. Callback failure or same-root reentrancy also closes non-success when the authenticated terminal signer remains available. The callback still executes in-process with the ambient permissions of Hub: the observation-only fields constrain the resulting records and store operations, not the callback's OS capabilities. It must remain trusted and side-effect-free until a real permission sandbox or process-isolation boundary exists; this runtime is not evidence of no-effect execution or hostile-plugin safety.

Retry is deterministic. An existing terminal is replayed without rerunning observation. If a prior run durably linked a valid snapshot but did not write its success terminal, the runtime authenticates the exact start/snapshot pair and closes that orphan snapshot on retry without invoking the observation callback again. The domain stores also expose conservative recovery for interrupted immutable-record publication: guarded initialization may complete only missing `records/` or `staging/` children beneath an existing exact-private root, and staging recovery discards an authenticated uncommitted one-link stage or finalizes only an exact already-linked two-link target. It never guesses a record into existence or overwrites a conflicting slot.

M563 composes those domain recoveries in fixed source, snapshot, then attempt order while the same epoch identity, coordination lease, observation lock, cancellation/deadline state, and observation-only authority are rechecked around every stage. It removes only authenticated uncommitted one-link staging artifacts or the staging name for an already-linked exact two-link target. A source-stage failure prevents snapshot and attempt recovery; no recovery path selects keys, advances the active pointer, or creates a record that was not already durably linked.

M564 is the concrete trust-composition factory, but not a production-readiness or commissioning claim. It requires injected commissioned trust, a fresh monotonic-anchor read, purpose-separated source/attempt/snapshot cryptographic services, and the exact M553 active artifacts. It authenticates a complete M555/M559/M561 source lineage, derives historical attempt and snapshot contexts only from that lineage, fixes the Snapshot V2 signer identity to the active manifest, and returns an identity-only public closure. Fresh anchor bytes must equal the active head; commissioning generation, immutable core, source currentness, and manifest bindings fail closed on drift. Source history is pinned by ordered canonical record filename and exact-content digest, so new/replaced/tampered records invalidate the composition while M563's exact content-preserving hardlink cleanup does not.

Signing authority is usable only inside one exact M562 transaction. After both cooperative locks are held, M562 mints a one-use token bound to the exact M564 session object; M564 atomically consumes it, fully authenticates anchor, trust, core, source, and manifest state, and gates attempt/snapshot signing plus signer-bearing attempt-key resolution until the session ends. Missing, replayed, caller-created, wrapped, or cross-composition tokens cannot open a session. The source-renewal signer is the narrow exception required for M561 publication and remains surrounded by fresh anchor, trust, currentness, immutable-core, callback-mutation, and reentrancy fences. Reconstructed public M557/M560 dependencies cannot sign outside M562.

A dedicated read-only restart admission recognizes only a canonical source staging record and target that authenticate as the same exact two-link inode. This permits M564 construction after a real publication crash so M563 can run; it neither unlinks the stage nor weakens the ordinary M561 complete-read path. Cleanup still requires the M556 lease and observation lock, and the source lineage is revalidated afterward.

M562b specifies the separate observation-isolation boundary. It authenticates canonical request/response frames and fresh pre/post backend attestations, and can report `enforced` only for a commissioned backend that proves process isolation, egress and write denial, child/worker/addon/WASI/inspector denial, deadline kill, output bounds, and process binding. Node's permission model remains `seatbelt-only`; no sandbox backend is selected, installed, connected to M562, or active.

Every epoch store and runtime result still denies pointer, anchor, policy, planning, execution, merge, release, deployment, publication, budget, credential, and external-mutation authority. This tranche is source-complete for host-local source/attempt/snapshot durability, guarded recovery, the observation transaction, and its fail-closed trust composition. The factory deliberately cannot select an anchor implementation, provision a key, install a trust root, or commission a provider. There is no accepted external monotonic-anchor adapter, commissioned purpose-separated key set, authenticated trust-root installation, M562b isolation backend, daemon/config activation, stopped-runtime upgrade, or mixed-version/legacy-writer exclusion. The local files and cooperative locks do not resist deletion or rollback by the same OS user. The source is committed on the development line, but it is not merged, released, deployed, commissioned, or accepted through a live product workflow.

Repository-local verification on 2026-09-04 included an exact 17-file M550-M564 run with 346/346 tests passing, successful typecheck and local build, lint with zero errors and 108 pre-existing warnings, scoped Semgrep and Gitleaks with zero findings, an offline dependency audit with zero reported vulnerabilities, and a clean whitespace check. An extended serial run completed the entire 116-file real-I/O project without an observed failure; a separate complete unit run passed 590 files with 1 skipped and 12,778 tests with 28 skipped. The combined `npm run test:ci` command still reached its enlarged runtime cap before emitting a final summary, so the single-command prepublish gate is not claimed as passed. These checks do not establish an immutable artifact, commissioning, deployment, activation, or user acceptance.

M551 adds a fresh-namespace commissioning preflight classifier, not a commissioning command. It accepts exact caller observations only, requires a disabled observer, stopped-observed daemon, absent-observed writers/locks/children, authenticated zero active attempts, stable absent legacy roots, an absent target namespace, exact writer-protocol digest agreement, and a configured-but-unverified anchor with a separately observed missing head. Even its successful state is only `locally-quiescent-unverified`: stopped-runtime verification, evidence authentication, anchor commissioning, writes, routing, reservation, activation, and all effect authority remain false.

## Delivery sequence

1. Select and independently accept one external monotonic-anchor adapter, then inject it into the implemented M564 composition. Provision the purpose-separated source, attempt, snapshot, manifest, and prepared-evidence trust services and install trust roots only through an explicit commissioning ceremony with revocation and recovery evidence.
2. Implement and commission an M562b-compatible isolation backend, connect it to the runtime through a separately reviewed integration, and prove the required pre/post attestation controls. Node permission flags alone are insufficient.
3. Add legacy- and mixed-version-writer exclusion, crash/contention acceptance on commissioned storage, and a stopped-runtime writer-upgrade protocol before any daemon/config activation.
4. Preserve the three-producer conformance runner and independently review each candidate again after it is committed and built from immutable source.
5. Commit, independently review, and publish stable producer-side packages only through each product's own release process.
6. Add the Cortex governed-retrieval and MMCP tool-surface observation contracts, integrate the bounded Locus lineage ledger behind an explicit local commissioning flow, and graduate the compatibility matrix to a separately governed conformance repository when ownership is agreed; do not merge all repositories into a monorepo.
7. Commission observation keys and producers locally, verify degraded modes, then explicitly enable one observer lane.
8. Add course-of-action simulation and independent evaluation pools using existing model capacity.
9. Promote reversible workspace work one capability at a time through nominal standing permits.
10. Add external or provider effects only after their deterministic plan, secret-delivery, rollback, canary, and outcome contracts pass live acceptance.
11. Use a transparency or hardware-backed monotonic anchor before claiming rollback-resistant history against the same local user.

## Source principles

The architecture applies [NIST zero trust](https://doi.org/10.6028/NIST.SP.800-207), [NIST cloud-native workload identity guidance](https://doi.org/10.6028/NIST.SP.800-207A), [SPIFFE workload identity concepts](https://spiffe.io/docs/latest/spiffe/concepts/), [MCP authorization and resource audience binding](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [OpenTelemetry GenAI privacy guidance](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/), and [SLSA provenance](https://github.com/slsa-framework/slsa/blob/main/spec/build-provenance.md). The distributed decision-loop inspiration comes from the [official NIWC Pacific vision page](https://www.niwcpacific.navy.mil/VISION/) and [DVIDS film record](https://www.dvidshub.net/video/950543/sea-strike-2043).
