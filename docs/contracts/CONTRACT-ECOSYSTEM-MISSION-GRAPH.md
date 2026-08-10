# Ecosystem Mission Graph Contract

Status: implementation contract for a bounded, planning-only V1. This document
does not activate Hub, Locus, Cortex, a daemon, a connector, or any production
workflow. Source files, tests, a dashboard, and a locally valid preview are not
activation or production-readiness evidence.

## 1. Purpose

The Ecosystem Mission Graph preserves the reason for engineering work while
making cross-repository ordering explicit. It is a deterministic directed
acyclic graph (DAG) of work nodes and human gates. V1 compiles untrusted
planning input, validates exact repository targets, and projects read-only
readiness from observations supplied by a separately authoritative caller.

The graph answers four bounded questions:

1. What change is intended, and what deliverable and evidence are expected?
2. Which exact enrolled repository owns each engineering node?
3. Which upstream nodes or human decisions must be complete first?
4. Which business outcome hypothesis and guardrails must survive the handoff?

It does **not** answer whether an agent may execute, whether a proposal may be
approved, whether code may merge, or whether a business outcome actually
occurred.

## 2. Ecosystem responsibility model

### 2.1 Ashlr Hub: engineering control plane

Hub owns:

- the enrolled repository set and exact repository resolution;
- strategist briefing parsing and bounded mission compilation;
- goal-focus, duplicate, collision, and capacity checks;
- planning-only readiness projections;
- sandboxed engineering work, verification evidence, and proposals under
  Hub's existing independent authority gates; and
- local operator explanations of why a node is ready or blocked.

Hub does not own company memory, provider identity, or business truth. A graph
status is never a dispatch, merge, release, or deployment authorization.

### 2.2 Ashlr Cortex: intent and accountability plane

Cortex should own, in a future governed integration:

- company intent, workstream scope, and responsibility assignments;
- accountable humans, due dates, and human decisions;
- permission-filtered business observations; and
- human-confirmed outcome status.

Cortex may eventually offer a mission candidate or an outcome observation. It
must not select Hub repositories, operate coding agents, declare engineering
verification, or silently approve a Hub proposal. V1 has no Cortex connector
and stores no Cortex identifier.

### 2.3 Locus: identity and capability plane

Locus should own, in a future governed integration:

- principal x tenant x provider bindings;
- sealed sessions, expiration, allowlists, and frozen selectors;
- credential resolution outside model context;
- provider-call allow, deny, and require-approval decisions; and
- audited human pin or CI mint actions.

Locus readiness would prove only that one connector call may use one bounded
identity. It must not confer Hub goal-adoption, execution, proposal, merge, or
deployment authority. V1 has no Locus connector and stores no credential or
binding material.

### 2.4 Human: cross-plane authority

Only an explicit human or an already-authorized external control may join the
planes. Depending on the existing product workflow, that may include:

- selecting or pinning a Locus identity;
- approving a Cortex responsibility or business-outcome mutation;
- explicitly adopting a Hub briefing into local goals;
- approving a Hub proposal;
- authorizing merge, release, deployment, publication, daemon activation, or
  another external effect.

A `human-gate` node records that such a decision is required. It cannot make
the decision.

## 3. Non-goals and authority boundary

V1 does not:

- fetch Cortex or Locus data;
- persist a mission graph as a new system of record;
- create a goal merely by compiling or projecting a graph;
- select, claim, route, dispatch, execute, or supervise an agent;
- write a repository, worktree, branch, proposal, provider, or remote;
- approve, merge, push, deploy, publish, send, buy, or activate anything;
- promote a learned policy or treat model output as verified evidence;
- convert engineering completion into business-outcome proof; or
- treat a missing, unreadable, truncated, unauthorized, or stale source as a
  healthy empty source.

The V1 authority string in operator projections is `planning-only`. A preview
entry with disposition `create` means only "eligible for the existing explicit
goal-adoption operation after all other checks." It is not permission to run
engineering work.

## 4. V1 canonical schema

The TypeScript interfaces in `src/core/vision/mission-graph.ts` are the V1 wire
contract. The condensed shape below is normative; documentation, API
projections, fixtures, and tests must remain compatible with it.

```ts
type MissionGraphNodeKind = 'work' | 'human-gate';
type MissionGraphRiskClass = 'low' | 'medium' | 'high';

interface MissionOutcomeContractInput {
  desiredOutcome: string;
  successSignals: readonly string[];
  guardrails: readonly string[];
}

interface MissionGraphNodeInput {
  kind: MissionGraphNodeKind;
  key: string;
  title: string;
  objective: string;
  deliverable: string;
  riskClass: MissionGraphRiskClass;
  targetRepo?: string | null;
  dependsOn?: readonly string[];
  acceptance: readonly string[];
  outcomeContract?: MissionOutcomeContractInput;
}

interface MissionGraphInput {
  missionKey: string;
  title: string;
  objective: string;
  createdAt: string;
  nodes: readonly MissionGraphNodeInput[];
}

interface EcosystemMissionGraphNodeV1 {
  kind: MissionGraphNodeKind;
  key: string;
  title: string;
  objective: string;
  deliverable: string;
  riskClass: MissionGraphRiskClass;
  repo: string | null;
  dependsOn: string[];
  acceptance: string[];
  outcomeContract?: {
    desiredOutcome: string;
    successSignals: string[];
    guardrails: string[];
  };
}

interface EcosystemMissionGraphV1 {
  schemaVersion: 1;
  digestAlgorithm: 'sha256';
  graphDigest: string;
  missionKey: string;
  title: string;
  objective: string;
  createdAt: string;
  nodes: EcosystemMissionGraphNodeV1[];
}
```

### 4.1 Bounds and normalization

The compiler must reject invalid input rather than silently expanding it.

| Field | V1 rule |
| --- | --- |
| Graph nodes | 1..24 |
| Dependencies per node | 0..8 |
| Acceptance criteria per node | 1..8 |
| Success signals, if outcome contract exists | 1..8 |
| Guardrails, if outcome contract exists | 1..8 |
| Canonical digest payload | at most 128 KiB UTF-8 |
| Key | 1..80 lowercase letters, digits, `.`, `_`, or `-`, bounded by alphanumeric characters |
| Title | 1..200 characters |
| Mission or node objective | 1..4,000 characters |
| Deliverable or desired outcome | 1..1,000 characters |
| Acceptance, success signal, or guardrail | 1..500 characters each |
| `createdAt` | exact canonical ISO-8601 string round-trippable by `Date` |

Strings are Unicode NFC-normalized and trimmed. Node keys must be unique.
Dependency keys must be unique within a node, must exist in the same graph,
must not refer to the node itself, and must form a DAG.

The general compiler accepts up to 24 nodes so other bounded private callers
can reuse it. The V1 strategist adapter remains more restrictive: it accepts at
most three proposed goals from one briefing.

### 4.2 Repository targeting

A `work` node must resolve to either:

- one exact enrolled absolute root; or
- one exact basename that matches exactly one enrolled root.

Relative paths containing `/` or `\\`, missing repositories, and ambiguous
basenames fail closed. The compiled `repo` is the canonical enrolled absolute
root supplied to this compiler invocation.

A `human-gate` node is repository-neutral: its compiled `repo` is `null`, and
supplying a non-null target is invalid.

V1 performs lexical resolution against the enrolled-root list. It does not by
itself prove physical identity across symlinks, mounts, devices, or repository
replacements. Any caller requiring physical-repository identity must use the
existing stronger enrollment/canonicalization boundary before compilation.

### 4.3 Digest semantics

The compiler sorts nodes by key and sorts dependencies, acceptance criteria,
success signals, and guardrails before hashing a canonical JSON payload. Given
the same normalized content and explicit `createdAt`, compilation must produce
the same graph and lowercase 64-character SHA-256 `graphDigest`.

`graphDigest` provides deterministic integrity and deduplication. It is **not**
authentication, authorization, a signature, a secret, or proof of provenance.
Any persisted graph must be revalidated and its digest recomputed before use.
Changing `createdAt` or any canonical content intentionally changes the digest.

## 5. Outcome contracts

An outcome contract preserves a planning hypothesis:

- `desiredOutcome`: what should improve for a user or Ashlr.ai;
- `successSignals`: bounded descriptions of what later evidence could show;
- `guardrails`: constraints that must remain true.

It is optional per node for compatibility. If present, both `successSignals`
and `guardrails` are required and non-empty.

Outcome contracts are prose, not executable predicates. V1 does not fetch
metrics, establish a baseline, wait for a measurement window, evaluate a
signal, or write outcome truth to Cortex. In particular:

- `acceptance` describes evidence for the engineering deliverable;
- `successSignals` describe desired later impact;
- a work observation of `realized` means the caller observed its engineering
  realization predicate, not that the desired business outcome occurred; and
- a graph projection of `complete` means all nodes are observed complete, not
  that the company outcome is human-confirmed.

Risk classes and guardrail prose are informational planning metadata. They do
not relax or create a sandbox, verification, proposal, merge, or deployment
policy.

## 6. Lifecycle and observation contract

V1 has no mutable graph lifecycle record. Its lifecycle is a sequence of pure
or explicitly separate operations:

1. **Briefing parsed.** Optional mission metadata is bounded as untrusted model
   output. Legacy flat briefings remain valid.
2. **Graph compiled.** Repository targets and DAG structure are validated; a
   deterministic graph or explicit validation issues are returned.
3. **Evidence observed elsewhere.** A caller reads Hub goal/milestone state or
   an explicitly authorized human receipt. The graph module does not perform
   that read.
4. **Projection calculated.** The graph and observations produce read-only node
   statuses and blockers.
5. **Adoption preview calculated.** Existing goal-source, focus-cap, duplicate,
   collision, repository, dependency, and human-gate checks determine whether
   each proposed work goal is eligible.
6. **Optional explicit goal adoption.** The existing user-invoked adoption path
   may create eligible Hub goals. This is a separate planning mutation. It
   does not modify a target repository or start engineering execution.
7. **Later projections.** A fresh observation set may unlock downstream nodes.
   The projection itself never performs the unlocked action.

No source file, test, API response, or UI rendering proves that step 6 occurred.

### 6.1 Observation schema

```ts
type MissionNodeObservedState =
  | 'active'
  | 'proposed'
  | 'realized'
  | 'failed';

interface MissionNodeObservation {
  nodeKey: string;
  state?: MissionNodeObservedState; // work nodes only
  humanApproved?: boolean;          // human-gate nodes only
}
```

Observations are caller assertions, not self-authenticating receipts. A caller
must use the strongest existing authoritative reader available and must not
invent positive evidence. If it cannot reliably determine realization, it
must omit the observation or default realization to false.

Duplicate observations, unknown node keys, work observations on human gates,
and human approvals on work nodes invalidate the entire projection. A failed
projection must not return a partial ready set.

## 7. Readiness and unlock semantics

### 7.1 Node projection

```ts
type MissionNodeProjectionStatus =
  | 'blocked'
  | 'ready'
  | 'active'
  | 'proposed'
  | 'awaiting-human'
  | 'complete'
  | 'failed';
```

Nodes are projected in topological order. For each node:

1. `blockedBy` contains every dependency whose projected status is not
   `complete`.
2. If `blockedBy` is non-empty, status is `blocked`, even if the caller supplied
   out-of-order positive evidence for this node.
3. With dependencies complete, a `human-gate` is `complete` only when its
   observation has `humanApproved: true`; otherwise it is `awaiting-human`.
4. With dependencies complete, a `work` node maps observed `failed`,
   `realized`, `proposed`, and `active` to `failed`, `complete`, `proposed`, and
   `active`, respectively.
5. A work node with complete dependencies and no observation is `ready`.

A failed upstream node leaves downstream nodes blocked. V1 does not implement
retry, waiver, skip, alternate branch, or automatic re-planning semantics.

### 7.2 Graph projection

Graph status is calculated with this precedence:

1. `failed` if any node failed;
2. `complete` if every node is complete;
3. `in-progress` if any node is active or proposed;
4. `awaiting-human` if any node awaits a human;
5. `ready` if any node is ready;
6. otherwise `blocked`.

This aggregate is explanatory. Consumers must inspect per-node `blockedBy` and
must not interpret the aggregate as a generalized permission.

### 7.3 Adoption-preview unlock

For the strategist integration, a graph-ready work node is only one input to
the existing preview. A `create` disposition additionally requires:

- a complete, non-degraded goal inventory;
- an exact enrolled repository;
- no duplicate existing goal;
- no deterministic goal-ID collision;
- capacity under both the active-goal focus limit and briefing goal cap; and
- no invalid mission graph.

Human-gate nodes are never materialized as repository goals. They remain
`human-gate-required` until a future, separately authorized caller supplies an
approval observation. V1 strategist preview does not manufacture such an
observation.

"Unlock" therefore means only "eligible to be presented by the planning
preview." It does not unlock agent dispatch, proposal approval, merge, release,
deployment, provider mutation, or Cortex writeback.

## 8. Human gates and receipts

V1 represents a human decision structurally but does not define a durable
approval-receipt format. Therefore:

- `humanApproved: true` is trusted only to the degree the caller is trusted;
- it must never be inferred from an LLM response, a checkbox rendering, test
  success, an existing branch, or an unauthenticated request;
- a gate's completion does not approve a different Hub/Cortex/Locus action;
- approval scope must be one node and one graph digest; and
- expiry, revocation, actor identity, and artifact binding remain V2 work.

Until an authenticated receipt exists, production-facing callers should omit
human approval and keep the gate `awaiting-human`.

### 8.1 Goal binding

A goal materialized from a valid graph carries an immutable `mission` binding:

```ts
interface GoalMissionBindingV1 {
  schemaVersion: 1;
  graphDigest: string;
  missionKey: string;
  nodeKey: string;
}
```

Only a goal whose full binding matches the freshly compiled graph and node may
provide realization evidence for that node. Objective and repository equality
remain useful for deduplication and collision detection, but can never prove
realization. This prevents historical work with the same title from satisfying
a changed deliverable, acceptance set, risk, or outcome contract.

## 9. Degraded and missing source behavior

Source health is outside the core graph schema because V1 receives explicit
inputs. Integrations must retain source state beside their projection.

### 9.1 Goal inventory

- `healthy`: normal duplicate, capacity, collision, and realization checks may
  proceed.
- `missing` with an explicit complete inventory result: may mean zero existing
  goals; callers must not infer this from an exception.
- `degraded`, unreadable, truncated, malformed, raced, or limit-exceeded:
  fail closed. No goal receives `create`; surface the degradation reason.

If an existing goal is found but the caller cannot reliably apply the
realization predicate, it must not mark the corresponding node `realized`.
That can delay downstream work, but it avoids a false unlock.

### 9.2 Strategist briefing

- no briefing directory or no records is an explicit `missing` state;
- at least one record exists but the latest cannot be read is `degraded`, not
  missing and not an empty briefing;
- the API must return `briefing: null` and `preview: null` when no briefing is
  available; and
- a preview exception must produce a degraded snapshot with `preview: null`,
  not a healthy partial preview.

The detailed reader caps total directory entries, candidate JSON files, and
individual file bytes, rejects non-regular files and invalid briefing schemas,
and returns explicit source quality. A valid older record behind an unreadable
newer record remains degraded rather than being presented as a healthy latest
briefing.

### 9.3 Enrollment

Repository resolution requires a complete enrolled-root snapshot. Failure to
read enrollment must degrade the preview; it must not treat every target as
unenrolled while presenting the overall source as healthy.

### 9.4 Future Cortex and Locus sources

Unauthorized, expired, stale, truncated, workstream-mismatched, or conflicted
external reads must remain distinct degraded states. None may be converted to
an empty successful result. V2 must carry bounded reason codes and observed-at
timestamps; V1 must not invent them.

## 10. Privacy and security

### 10.1 Data classification

The compiled V1 graph is private operator data. It may contain:

- absolute repository paths;
- strategy and objective prose;
- acceptance evidence descriptions; and
- business outcome hypotheses.

These fields may reveal usernames, project names, roadmap details, or company
priorities. They must not enter public telemetry, external logs, analytics,
training data, or an unrelated model prompt by default.

### 10.2 Operator API projection

Any local web/API projection must:

- preserve `authority: 'planning-only'` and explicit source health;
- replace absolute paths with bounded repository basenames;
- omit graph internals not required for the view;
- keep arrays and prose bounded;
- render all model-originated strings as text, never executable HTML; and
- remain behind Hub's existing operator authentication and network boundary.

A basename is pseudonymous at best and can still be sensitive. Sanitizing a
path does not authorize public exposure.

### 10.3 Prohibited content

The graph and projection must never contain:

- provider tokens, client secrets, cookies, session seals, or credential
  values;
- a resolved Locus `CredentialRef` value;
- raw provider payloads or unrestricted Cortex memory;
- prompts containing unrelated tenant or workstream data;
- arbitrary environment dumps, browser diagnostics, or secret-bearing command
  output; or
- an executable shell command supplied by a model.

### 10.4 Validation and trust

All model-produced graph input is untrusted. Runtime validation is required at
every deserialize boundary. The SHA-256 digest detects canonical content
changes but does not identify the author. A caller must not use it as a MAC or
approval signature.

## 11. Crash safety and idempotency

### 11.1 Compiler and projector

The compiler and projector are pure with respect to external state:

- `createdAt` is explicit rather than read from the clock;
- they perform no persistence, repository write, provider call, or dispatch;
- the same valid inputs produce the same output;
- invalid inputs return bounded issues and no partial valid graph; and
- a process crash cannot leave a partially persisted graph because these
  functions persist nothing.

This is computation idempotency, not effect idempotency.

### 11.2 Existing goal adoption

Explicit goal adoption is a separate existing write path. V1 does not promise
mission-wide atomicity across several goal files. If a process crashes after
one goal is created and before another is created, the next preview must
re-read the complete goal inventory and reconcile duplicates/collisions rather
than overwrite history.

Each goal persistence failure must be reported as a failed outcome. A partial
multi-goal result must not be described as fully adopted. Degraded inventory
on retry blocks further creation.

Mission reconciliation uses atomic create-if-absent installation for the
deterministic goal id. It must never replace an existing file after a stale
preview, and exactly one concurrent creator may win. Existing mission binding
metadata cannot be changed by ordinary goal persistence. A collision is a held
planning outcome, not a successful create.

### 11.3 Future persistent graph or relay

Any V2 persistence or cross-product effect must add:

- an authenticated envelope bound to `graphDigest`, node key, transition,
  source revision, principal, tenant, and expiry;
- an idempotency key for each requested effect;
- compare-and-swap or transactional revision checks;
- atomic write or durable transaction semantics;
- receipt lookup before retry;
- explicit `transport-unknown` handling with no blind replay; and
- reconciliation that distinguishes not-attempted, attempted, committed,
  rejected, and unknown outcomes.

No V1 digest is sufficient for those guarantees.

## 12. Versioned roadmap

### V1: Hub-local, planning-only mission graph

Bounded V1 scope:

- compile and validate a deterministic DAG;
- resolve exact enrolled repositories;
- preserve deliverables, acceptance evidence, risk labels, and optional outcome
  contracts from new strategist briefings;
- leave legacy flat briefings compatible;
- derive read-only readiness from Hub goal observations;
- fail closed on invalid graphs and degraded goal inventory;
- show dependency and outcome context in CLI/operator UI;
- expose only a path-sanitized, source-aware local API projection; and
- keep goal adoption explicit and all engineering authority unchanged.

V1 is not complete merely because the contract or source exists. Completion
requires the acceptance evidence in section 13 against the exact revision.

### V2: governed cross-product mission relay

V2 may be designed only after the V1 local seam is stable. It should add:

1. a versioned, permission-filtered Cortex mission-candidate envelope;
2. Locus-bound identity provenance for each external read or write proposal;
3. authenticated, expiring human receipts scoped to graph digest and node;
4. durable source revisions and conflict detection;
5. measurement windows and typed outcome observations distinct from
   engineering completion;
6. proposal-only Cortex outcome writeback with explicit human review;
7. transport-unknown reconciliation and effect idempotency; and
8. revocation, retention, deletion, workstream-isolation, and audit policy.

V2 must not give Hub unrestricted Cortex memory, put Locus secrets in model
context, equate Cortex approval with Hub merge authority, or allow any product
to become a confused deputy for another.

## 13. Acceptance tests and evidence

These are release criteria, not claims that they currently pass.

### 13.1 Core graph contract

Primary test target: `test/m491.ecosystem-mission-graph.test.ts`.

- identical normalized input with different node/list order yields identical
  compiled graphs and digests;
- content tampering produces `digest-mismatch`;
- exact absolute roots and one unambiguous basename resolve;
- missing, malformed, relative, and ambiguous targets fail closed;
- human gates reject repository targets;
- duplicate keys/dependencies, missing dependencies, self-dependencies, and
  cycles fail closed;
- graph/list/text/byte bounds are enforced;
- invalid deliverable, risk, acceptance, and outcome contracts fail closed;
- duplicate, unknown, and kind-incompatible observations invalidate the whole
  projection;
- downstream nodes remain blocked despite out-of-order `realized` evidence;
- a human gate remains awaiting until explicit approval; and
- graph aggregate precedence matches section 7.2.

### 13.2 Strategist and adoption compatibility

Primary test target: `test/m485.mission-compiler.test.ts`, with existing vision
regressions retained.

- legacy flat briefings compile and adopt exactly as before;
- mission metadata survives parsing with all bounds enforced;
- invalid mission graphs yield only `mission-graph-invalid` skips;
- only roots or nodes with realized dependencies are preview-ready;
- human-gate nodes never materialize as goals;
- outcome text is preserved as planning metadata and never used as proof;
- exact repo plus normalized objective deduplication still holds;
- deterministic goal-ID collisions never overwrite archived/done goals;
- focus and briefing caps still apply after graph readiness;
- malformed/truncated goal records block all creates; and
- a goal-store failure reports failure and does not report a created goal.

### 13.3 CLI and local API

- CLI preview displays node key, dependencies, deliverable, acceptance,
  outcome, success signals, guardrails, and human-gate status without adopting;
- CLI preview ends with an explicit read-only/no-authority statement;
- the mission API is GET-only and does not run the strategist or adopt goals;
- missing briefing returns explicit missing source state and null preview;
- unreadable briefing or goal inventory returns degraded state;
- degraded goal inventory never emits a `create` disposition;
- absolute paths never appear in the serialized operator response;
- graph/source validation issues are bounded and contain no secret values; and
- legacy web/API endpoints remain unchanged.

### 13.4 Security and privacy

- secret canaries placed in environment/credential fixtures never appear in
  graphs, digests displayed with context, logs, API JSON, or UI text;
- repository roots containing a username serialize only as bounded basenames in
  the operator projection;
- HTML/script strings in strategist prose render as inert text;
- an unauthenticated request cannot obtain mission data if the surrounding Hub
  API requires operator authentication;
- SHA-256 digest equality never bypasses a human or policy gate; and
- no test requires real Cortex, Locus, provider, daemon, network, or production
  credentials.

### 13.5 Crash and idempotency

- compile/project repeatability holds across process invocations;
- a failed compile returns no reusable partial graph;
- a write failure cannot be reported as goal creation;
- retry after partial goal adoption re-reads inventory and does not overwrite
  an existing deterministic goal; and
- no V1 test claims mission-wide transactional goal adoption, external-effect
  idempotency, or transport-unknown recovery.

### 13.6 Verification record

Release evidence must record:

- exact commit SHA and dirty/clean worktree state;
- exact commands and exit codes;
- focused test results for core graph, strategist/adoption, CLI, and API;
- typecheck, build, lint/diff-check results required by the repository;
- skipped hosted checks separately from passed local checks; and
- explicit confirmation that no daemon activation, provider mutation,
  deployment, publication, or production probe occurred unless separately
  authorized and evidenced.

## 14. Truthful completion statement

The strongest V1 statement supported by this contract and green local tests is:

> The inspected revision implements a bounded, Hub-local, planning-only mission
> graph that can validate cross-repository dependencies and project readiness
> without granting execution authority.

It is not evidence that Hub, Locus, and Cortex are integrated, that autonomous
engineering is active, that a daemon is running, that any proposal merged, or
that any business outcome changed.
