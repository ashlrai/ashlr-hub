# Mission OS: operator guide

Mission OS turns one strategic briefing into a bounded cross-repository plan,
shows the operator what is dependency-ready, and can record an authenticated
observation of that state. It is designed to make autonomy legible before it
becomes automatic.

This guide describes the current source tree. Source code and passing local
tests do not prove that a packaged binary, resident daemon, Cortex or Locus
connector, release, deployment, or production workflow is installed or active.

## The model

Mission OS separates intent, evidence, and authority:

```text
strategist briefing
        |
        v
bounded mission DAG ----> read-only preview
        |                        |
        |                        v
        |                 exact hold reasons
        v
authenticated observation receipt ----> zero-effect shadow suggestion
        |
        +---- explicit `approve` or `reconcile` is still required to create goals
```

The mission graph is a planning DAG. A work node names one exact enrolled
repository and its upstream dependencies. A human-gate node says that a human
decision is required; it cannot supply that decision.

The receipt is an immutable local observation. It records bounded lifecycle and
verification facts while keeping all authority flags false. The shadow
suggestion answers only: "what would the existing planning policy select now?"
It creates nothing and grants nothing.

## Responsibility boundaries

| Plane | Current responsibility | Explicit non-authority |
| --- | --- | --- |
| Ashlr Hub | Enrolled repositories, mission compilation, goal capacity and dedupe, engineering evidence, sandboxed proposal production | No company truth, credential authority, human approval, business outcome, automatic merge, release, or deploy authority from Mission OS |
| Ashlr Cortex | Future governed company intent, accountability, human decisions, and permission-filtered business observations | No current connector; cannot select Hub repositories, verify engineering, or approve Hub proposals |
| Ashlr Locus | Future governed principal, tenant, provider, sealed-session, and credential-reference decisions outside model context | No current connector; identity readiness would not grant Hub planning, execution, merge, or deployment authority |
| Human/operator | Explicitly adopts planning state and separately authorizes consequential actions through their existing gates | A graph, receipt, model answer, or green test never substitutes for this authority |

Cortex and Locus are architectural boundaries in V1, not integrated runtime
dependencies. Hub does not fetch their data, persist their identifiers, resolve
their credentials, or write outcomes back to them.

## Commands and effects

Run installed builds as `ashlr vision ...`. From a source checkout, the
equivalent development invocation is `npm run dev -- vision ...`.

| Command | Reads | Writes | Authority/effect |
| --- | --- | --- | --- |
| `ashlr vision show` | Current end-state spec | Nothing | Read-only |
| `ashlr vision review [--project <repo>]` | Spec, repository state, configured strategist backend | Latest strategic briefing | Produces planning input; does not create a goal or proposal |
| `ashlr vision preview` | Latest briefing, enrollment, complete goal inventory | Nothing | Read-only; reports exact targets, selections, and hold reasons |
| `ashlr vision shadow [--json]` | Briefing, enrollment, complete goals and proposals, realized-merge authority evidence | One immutable receipt, or replays the matching receipt | Observation-only; emits at most one `would-create` or `hold` suggestion and changes no operational state |
| `ashlr vision approve` | Latest briefing and planning sources | Evolves the spec and adopts selected goals | Explicit planning mutation; still no dispatch, proposal, merge, release, or deployment |
| `ashlr vision reconcile` | Latest briefing and current goal/proposal state | At most one newly dependency-ready goal | Explicit planning mutation; no dispatch or outward effect |

`shadow` is deliberately not filesystem-read-only: its one permitted write is
the private receipt under `~/.ashlr/mission-receipts/`. The suggestion itself
has `maxGoalCreations: 0`, every effect flag is `false`, and the command does not
call goal adoption, agent dispatch, proposal creation, merge, release,
deployment, publication, provider, policy, or budget APIs.

The local Mission Control Goals view is stricter: its Mission Outcome Room
never records a receipt. It requires a complete immutable receipt ledger when
that ledger exists, recognizes an exactly missing ledger without creating it,
selects the newest authenticated receipt for the exact mission key and graph,
recomputes the suggestion from current complete briefing, enrollment, goal,
and proposal snapshots, and displays only a bounded public summary. It shows
`missing`, `withheld`, or `unavailable` rather than treating absent, stale,
partial, malformed, or mismatched evidence as a current suggestion.

## Recommended operator workflow

### 1. Establish bounded inputs

```sh
ashlr preflight
ashlr enroll list
ashlr vision review
```

Review can use a configured model and may therefore use the backend explicitly
selected by the operator. It writes a briefing; it is not an approval.

### 2. Inspect the exact plan

```sh
ashlr vision preview
```

Confirm the target repository for every work node, dependency ordering,
acceptance evidence, outcome hypothesis, guardrails, and any human gate. A
`create` preview disposition means only "eligible for a later explicit planning
operation." It is not permission to execute.

### 3. Capture the zero-effect decision

```sh
ashlr vision shadow
ashlr vision shadow --json
```

Human-readable success is one of:

```text
Mission reconcile shadow
  WOULD CREATE node <node-key>
  receipt <receipt-id>
  Observation only: no goal, milestone, repository, agent, proposal, merge,
  release, deployment, publication, external mutation, policy, or budget state changed.
```

```text
Mission reconcile shadow
  HELD (<reason>)
  receipt <receipt-id>
  Observation only: ...
```

An abridged JSON success envelope is shown below. The real `suggestion` also
contains its authenticated basis, complete bounds/effects, and stable identity
digests.

```json
{
  "schemaVersion": 1,
  "mode": "shadow",
  "authority": "observation-only",
  "state": "would-create",
  "receipt": {
    "disposition": "recorded",
    "receiptId": "<sha256>",
    "receiptDigest": "<sha256>"
  },
  "suggestion": {
    "decision": { "disposition": "would-create", "reason": "would-create" },
    "bounds": { "maxSuggestions": 1, "maxGoalCreations": 0 },
    "effects": { "goals": false, "agents": false, "proposals": false }
  }
}
```

`state` may be `would-create` or `held`. An identical semantic retry reports
receipt disposition `replayed`, keeps the same receipt and suggestion
identities, and preserves the earliest stored observation. The full suggestion
contains false flags for goals, milestones, repositories, agents, proposals,
merges, releases, deployments, publications, external mutations, policy, and
budgets.

After a receipt exists, open Mission Control and select **Goals** to see the
same decision class in the Mission Outcome Room. This dashboard projection is
read-only: it exposes only the bounded disposition and reason, selected node
key and kind, observation-only authority, and an all-false effects summary.
Receipt presence details, timestamps, IDs, digests, HMAC references, source
digests, objectives, proposal or diff evidence, repository paths, tenant
aliases, and the full suggestion basis do not cross the unauthenticated public
API. Refreshing the page does not create or replay a receipt.

Withheld JSON returns nonzero and is intentionally smaller:

```json
{
  "schemaVersion": 1,
  "mode": "shadow",
  "authority": "observation-only",
  "state": "withheld",
  "reason": "<fail-closed-reason>",
  "effects": {
    "missionReceipt": "none",
    "outward": "none"
  }
}
```

Failure effects are two independent facts. Before a write, they are
`missionReceipt: "none"` and `outward: "none"`. After a proven receipt write,
`missionReceipt` is `"recorded"` or `"replayed"` while `outward` remains
`"none"`. If receipt publication is conflicted or cannot be proven,
`missionReceipt` and `outward` are both `"unknown"`; the CLI never reports
`none` for an ambiguous persistence result. Receipt details remain alongside
the effects object whenever a persistence disposition exists.

Exit codes are `0` for a verified `would-create` or `held` suggestion, `1` when
evidence or persistence is withheld, and `2` for invalid command usage.

### 4. Make the planning decision explicitly

Choose one, after reviewing the preview and shadow output:

```sh
ashlr vision approve
# or advance only the next dependency-ready node:
ashlr vision reconcile
```

Then use the ordinary goal and inbox surfaces:

```sh
ashlr goals list
ashlr goals status <goal-id>
ashlr goals advance <goal-id>
ashlr inbox
```

Goal creation remains planning-only. `goals advance` is a separate sandboxed,
proposal-producing action. Proposal approval, merge, release, deployment,
publication, resident daemon activation, and external provider mutation remain
separate gates.

## Evidence and privacy

Mission Receipt V1 stores authenticated metadata, not the briefing or raw work:

- briefing, enrollment, goal, proposal, verification, and merge evidence are
  represented by domain-separated digests;
- goal, milestone, and proposal identifiers become HMAC references;
- objectives, rationale, repository paths, diffs, verification commands and
  output, PR URLs, provider payloads, credentials, human decisions, and raw
  business outcomes are not persisted in the receipt;
- exact mission node keys, lifecycle statuses, blocker keys, merge source, and
  realized merge revision remain visible because they are required to explain
  the engineering observation; and
- business outcome is always `not-observed`; human-decision and outcome evidence
  completeness remain false.

The capture adapter accepts at most 512 complete goal records, 4,096 complete
proposal records, and 512 milestones in aggregate. The receipt accepts 1–24
mission nodes, at most 64 milestones per node and 512 total, and at most 256 KiB
of canonical serialized data. Exceeding a bound withholds the receipt rather
than truncating evidence into an apparently complete record.

Receipts use the existing 32-byte host provenance key at
`~/.ashlr/foundry/provenance.key`; Mission OS never creates that key. The HMAC
proves that a process holding the same local key recorded the bytes. It is not
an independent verifier, a remote attestation, or protection against an attacker
who can read the user's key. Do not copy the key into logs, tickets, prompts, or
support bundles.

Receipt reads are bounded and private-store checks fail closed on unsafe
ownership, permissions, links, replacement races, truncation, malformed data,
or missing authentication. A complete missing goal or proposal store is an
authoritative empty source; an unreadable, partial, capped, or degraded store is
not.

Authenticated realized-merge checks may consult read-only Git authority. They
do not run a merge, mutate a repository, push, or contact Cortex or Locus.

## Troubleshooting

| Symptom/reason | Meaning | Safe next step |
| --- | --- | --- |
| `briefing-source-incomplete` | Latest briefing is absent, unreadable, partial, or degraded | Run `ashlr vision review`, then `ashlr vision preview`; do not hand-edit an untrusted briefing into place |
| `enrollment-source-incomplete` or `repository-not-enrolled` | Enrollment authority is degraded or a work node does not bind one exact enrolled root | Run `ashlr preflight` and `ashlr enroll list`; repair enrollment through the enrollment CLI |
| `goal-source-incomplete` / `proposal-source-incomplete` | A bounded authoritative inventory could not be completed | Inspect `ashlr goals list` and `ashlr inbox`; repair filesystem ownership/permissions before retrying rather than treating records as absent |
| `mission-graph-invalid` / `invalid-mission-goal-binding` | The graph digest, dependency DAG, target, or exact goal mission tuple does not validate | Run `ashlr vision preview`; regenerate the briefing after correcting the strategic input or enrollment |
| `linked-proposal-missing` / `linked-proposal-repository-mismatch` | A mission milestone points at evidence outside the complete inventory or wrong repo | Inspect the linked goal and proposal; never substitute a similarly named proposal |
| `receipt-key-unavailable` | The existing provenance key is absent or unsafe | Do not fabricate or paste a key. Inspect `~/.ashlr/foundry/` ownership and the normal signed-evidence setup that owns key creation |
| `receipt-conflicted` / `receipt-persistence-failed` | Immutable no-clobber publication or exact point verification failed | Stop retry loops, preserve the store, inspect local disk/permissions, and run `ashlr doctor`; do not delete receipt records as a first response |
| `receipt-invalid` / `suggestion-invalid` | Authentication or canonical integrity failed | Treat the output as untrusted, preserve evidence, and investigate the local key/store before any planning mutation |
| `dependency-blocked` / `human-gate-required` / `no-ready-node` | The verified result is a normal hold, not an error | Complete the upstream engineering work or make the required decision through its real authority surface; rerun shadow afterward |

Never "fix" a withheld result by editing a receipt, changing a digest, deleting a
goal/proposal record, or weakening source completeness. The failure is the
safety result.

## Production boundary and roadmap

Current V1 source provides the mission graph, evidence-normalized capture,
immutable authenticated receipt, zero-effect shadow planner, and
`ashlr vision shadow [--json]` integration. Before claiming operational
availability, separately verify that the intended commit was built, packaged,
installed, and invoked; if a daemon is involved, verify the installed artifact
and daemon state independently.

The receipt is one host process's observation, not a lease over the underlying
sources. Concurrent source changes can make it historical immediately after
capture. The explicit `approve` and `reconcile` planning mutations do not yet
append Mission Receipt V1 post-effect evidence, and no automatic daemon
reconciler is activated by this work.

The following are roadmap directions, not present authority or commitments:

1. post-effect receipts for explicit planning mutations;
2. a shared CLI/daemon reconciliation lease with crash-safe recovery;
3. independently authenticated human-decision evidence;
4. permission-filtered Cortex mission-candidate and outcome envelopes;
5. Locus-bound identity references that never expose credentials to model
   context; and
6. a separately activated automatic planning mode only after sustained shadow
   evidence, with merge, release, deployment, publication, provider, policy,
   budget, and business-outcome authority still independent.

Normative details live in the
[Ecosystem Mission Graph contract](./contracts/CONTRACT-ECOSYSTEM-MISSION-GRAPH.md)
and [Mission Observation Receipt V1 contract](./contracts/CONTRACT-MISSION-RECEIPT-V1.md).
