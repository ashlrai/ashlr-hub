# Ashlr Autonomous Engineering Program

Status: V1 source implementation proposed in a draft branch. Focused and
invariant verification are green; the full repository suite reached its hard
runtime cap and is not claimed as complete. No resident daemon, merge
authority, external connector, production release, or deployment was activated
by this workstream.

## North star

Ashlr Hub should feel like an excellent autonomous engineering organization,
not a bag of coding agents. A human should be able to state an outcome, see the
smallest coherent cross-repository mission that advances it, understand why
each leg is ready or blocked, and receive trustworthy proof without supervising
every tool call.

The system earns more autonomy by making five things continuously legible:

1. intent: what changes for Ashlr.ai or its users;
2. ownership: which exact product and repository owns each deliverable;
3. causality: what must be realized before the next leg becomes eligible;
4. evidence: what is proposed, built, landed, verified, and later observed; and
5. authority: which transitions are automatic, proposal-only, or human-owned.

The operative product metric is not agent activity. It is verified useful
outcome throughput per unit of human attention, inside explicit cost, security,
privacy, and change-authority constraints.

## Product architecture

### Ashlr Hub: engineering control plane

Hub turns bounded intent into repository-scoped engineering plans, sandboxed
work, verification evidence, and reviewable proposals. It owns repository
enrollment, goal focus, mission compilation, agent execution policy, proposal
lifecycles, and operator explanation. It must not invent company truth or
credential authority.

### Ashlr Locus: identity and capability plane

Locus should bind principal, tenant, provider, scope, expiry, and credential
selection outside model context. It answers whether one narrowly described
external call may use one identity. That answer never grants Hub permission to
create a goal, merge code, deploy, publish, or mutate Cortex.

### Ashlr Cortex: intent and accountability plane

Cortex should hold company outcomes, workstreams, responsibility, deadlines,
decisions, and permission-filtered observations. It can eventually offer Hub a
mission candidate and receive a proposal-only outcome update. It must not pick
repository roots, operate coding agents, or declare engineering proof.

### Human: constitutional authority

The human sets direction and owns consequential crossings between planes:
credential pins, company accountability changes, high-risk mission gates,
proposal approval, merge, release, deployment, publication, and policy
expansion. Automation can prepare the decision and assemble evidence; it cannot
silently redefine the decision.

## The missing loop

Hub already has strong per-repository mechanics and Fleet OS exception
briefings. The remaining leverage gap was continuity from strategic intent to
cross-repository delivery. Flat strategist goals could not express a sequence
such as `Cortex contract -> Hub consumer -> Locus-backed proof`, and the web
control plane did not preserve rationale, outcome, dependencies, or evidence at
the handoff into goals.

The V1 answer is an Ecosystem Mission Graph: a deterministic, bounded,
planning-only DAG whose nodes carry an exact repository, deliverable,
acceptance evidence, risk, optional business outcome contract, and dependencies.
Human gates are repository-neutral nodes and cannot satisfy themselves.

## Delivered V1 slice

### Mission graph kernel

`src/core/vision/mission-graph.ts` provides pure compile, validate, digest, and
projection functions. It accepts at most 24 nodes, validates exact canonical
enrolled roots or an unambiguous basename, rejects cycles and malformed edges,
bounds all text and arrays, and hashes canonical normalized content with
SHA-256. It imports no persistence or outward-action module.

Projection is explanatory. A downstream node remains blocked until every
upstream node projects complete, even if out-of-order positive evidence is
supplied. The digest detects content changes; it is not a signature or grant.

### Strategist and explicit reconciliation

New strategist briefings can carry stable node keys, dependencies,
deliverables, acceptance evidence, risk, human gates, and outcome contracts.
The additions are optional, so legacy flat briefings preserve their existing
behavior.

The compiler previews graph validity and readiness using current goal focus,
deduplication, collision, enrollment, and source-health checks. An upstream
work node counts as realized only when every required milestone is backed by an
applied proposal with passing verification and realized-merge evidence.
The goal must also carry the exact graph digest, mission key, and node key;
historical work with similar wording cannot unlock a changed contract.

`ashlr vision reconcile` is deliberately explicit and narrow. It re-reads the
latest briefing and authoritative local evidence, then attempts at most one
newly dependency-ready goal. It is a local planning mutation. It does not
re-apply strategist spec evolution, dispatch an agent, create a proposal, merge,
deploy, publish, start the daemon, or change autonomous-merge policy.
Goal creation is atomic create-if-absent, so a stale preview or concurrent
reconciler cannot overwrite an activated goal with a fresh planning record.

### Mission Outcome Room

The Goals view now opens with a read-only Mission Outcome Room. Its distinctive
element is a dependency/evidence rail rather than another dashboard of activity
cards. It shows the mission thesis, current state, gap, target, dependency,
deliverable, acceptance evidence, desired outcome, success signals, guardrails,
risk, and human-gate status.

The backing `/api/vision/mission` route is GET-only. It does not run the
strategist or adopt work. It bounds briefing-source inspection, fails closed on
degraded goal or enrollment authority, computes readiness from the same
verified completion predicate, strips absolute paths to bounded basenames, and
passes the result through the existing public JSON sanitizer. The view adds no
approve, reconcile, execute, merge, or deploy control.

Lifecycle and adoption are presented separately. A node may be proposed,
active, complete, failed, or dependency-blocked while the compiler independently
explains whether it would create or hold a local goal now. This prevents an
already active or realized mission leg from looking merely skipped.

## Authority matrix

| Transition | V1 behavior | Required authority for more |
| --- | --- | --- |
| Briefing to graph | Pure, read-only compilation | None |
| Graph to readiness | Pure projection over explicit observations | None |
| Ready node to local goal | Explicit CLI; at most one per reconcile | Human invocation and existing local policy |
| Goal to agent work | Unchanged existing Hub controls | Existing dispatch/sandbox authority |
| Work to proposal | Unchanged proposal-only path | Existing verification policy |
| Proposal to merge | Unchanged | Existing human/merge policy |
| Merge to deploy or publish | Not added | Separate release authority and evidence |
| Cortex or provider mutation | Not implemented | Governed Locus identity plus explicit product authority |
| Human gate completion | Never inferred in V1 strategist flows | Authenticated, scoped human receipt |

## Evidence and release gates

Source quality is part of the product contract. Missing, malformed, unreadable,
truncated, raced, or bounded-out sources cannot masquerade as healthy empty
state. Repository targeting is exact and fail-closed. Outcome prose remains a
hypothesis; green tests or a realized merge do not prove a business outcome.

Before this slice can be called source-ready, the exact revision must pass:

- focused mission graph, compiler, API, and UI tests;
- existing vision, goal, web API, and authority regressions;
- TypeScript, JavaScript syntax, lint, build, invariants, audit, and diff checks;
- independent authority/security, correctness, and operator-UX review; and
- full local CI, with skipped hosted checks reported separately.

The current branch has passed the focused and invariant gates, but its full
local CI attempt reached the repository's 15-minute hard cap after all completed
modules had passed. That run is incomplete, not green. A rendered browser
acceptance case for the responsive and assistive-technology behavior also
remains a recommended pre-promotion evidence gate.

Runtime activation is a later gate. The installed Ashlr build remains distinct
from this source revision; daemon installation/start, automatic merge, and any
production probe require explicit authorization and live evidence.

## Prioritized program

### V1.1: durable mission receipt

Add an immutable local receipt that binds briefing identity, graph digest,
created goals, milestone/proposal identifiers, exact revisions, verification,
realized merges, human decisions, and observed outcome evidence. Reads must be
bounded and race-safe; writes must be atomic and idempotent. The receipt remains
observational and cannot itself authorize the next effect.

### V1.2: automatic bounded reconciliation

After the receipt exists, allow one daemon-tick reconciliation to propose one
newly ready planning goal under a lease, explicit budget, current enrollment,
complete goal inventory, and the same verified completion predicate. Begin in
shadow mode, compare suggested versus human-invoked decisions, and require a
separate activation gate before local mutation.

### V2: governed Cortex mission intake

Define a versioned, permission-filtered Cortex mission-candidate envelope with
workstream identity, source revision, accountable human, desired outcome,
constraints, due date, and replay protection. Hub may compile it only after an
explicit local mapping chooses exact enrolled repositories. Conflicts and stale
sources block rather than merge implicitly.

### V2.1: Locus-bound external evidence

Use Locus only for narrowly scoped connector reads or proposal-only writes. An
envelope binds principal, tenant, provider, selectors, purpose, expiry, and
idempotency key. Credentials never enter mission graphs, model prompts, logs,
or Cortex payloads.

### V2.2: outcome writeback

Separate engineering realization from business observation. After a defined
measurement window, Hub may assemble a proposed Cortex update containing the
mission digest, evidence pointers, caveats, and unknowns. A human or existing
Cortex authority approves the company-truth mutation.

### V3: team learning without silent policy drift

Learn which mission decompositions, repository sequences, models, review paths,
and verification contracts produce realized value. Keep learning metadata-only
and cohort-aware. Policy changes, new permissions, automatic merges, and larger
budgets remain proposed changes with rollback criteria, not self-modifying
defaults.

## Definition of success

This program succeeds when Mason can open one surface and answer, in under a
minute: what outcome the team is pursuing, why these exact changes matter, what
is ready, what is blocked, what has actually landed with verified evidence,
which business signal is still unobserved, and which decision still belongs to
him. The system should then keep doing safe useful work without needing him to
translate context between products or supervise agent mechanics.
