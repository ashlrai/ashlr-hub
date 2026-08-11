# Ashlr Hub: Next-Level Autonomous Engineering Lab

## Thesis

Ashlr Hub should become the open scientific control plane for agent organizations
that can prove their work. Its moat is not agent count, model access, dashboards,
or autonomy rhetoric. Its moat is the ability to turn a human mission into a
bounded, reproducible, verified, accepted, stable outcome while preserving
separate authority for proposals, merges, releases, deployments, credentials,
money, and runtime activation.

The immediate objective is deliberately narrower than “fully autonomous”:

> Produce one useful protected merge from one real objective with less than ten
> minutes of operator attention, then prove it remains green and unreverted for
> seven days.

Repeating that outcome is the prerequisite for every more ambitious claim.

## Current truth

Ashlr has unusually strong safety and evidence primitives: proposal-first work,
isolated worktrees, bounded agent loops, provenance, protected-merge evidence,
post-merge observation, deterministic gates, resource-aware routing, Mission
Graph planning, repair flows, and explicit degraded-source semantics.

The live operating result is nevertheless fail-stopped. This snapshot was taken
at 2026-08-11 04:50 UTC using `ashlr daemon status --json`,
`ashlr fleet status --json`, local proposal-store inspection, `git rev-parse`,
and the GitHub pull-request API:

- the installed 3.1.0 runtime is stopped while source is 3.2.0;
- 25 repositories are enrolled, but 20 are silent;
- 20 work items are visible and zero are eligible;
- 11 active goals exceed the configured focus threshold of four;
- proposal history is readable, yet all 672 observed fleet proposals are
  rejected and none applied;
- there are zero pending proposals and zero recent fleet-reported merges;
- dispatch-outcome evidence is degraded, with four of four rows invalid;
- autonomy evidence packs and post-merge evidence are absent;
- 212 of 268 scanner observations are unavailable;
- 60 pull requests are open, 53 as drafts.

This is not a model-quality shortage. It is a product-conversion, operating-
kernel, and evidence-closure failure.

## North Star and guardrails

### North Star

**Weekly Active Outcome Teams:** teams receiving at least one mission-linked,
human-accepted, protected-branch merge that remains green and unreverted for
seven days with no more than ten minutes of operator intervention.

The per-team operating metric is **Stable Autonomous Outcomes per Week**.

### Required attributes of an outcome

An outcome must be operator-requested or mission-linked, substantive, verified
on the exact base and diff, accepted by the repository owner, observed after
merge, and bound to model, cost, latency, retries, and human attention.

Proposal count, dispatch count, token volume, model fan-out, receipt count, and
dashboard activity are diagnostic variables, never success metrics.

### Guardrails

- zero unauthorized repository, credential, release, deploy, service, provider,
  or financial effects;
- no credential is available inside an unattended execution capsule, and the
  defined adversarial suite detects zero leakage;
- no launch may cause aggregate maximum authorized exposure to exceed its parent
  or fleet cap; ambiguous provider settlement quarantines the reservation;
- under five percent seven-day regression or revert rate only after a declared
  sample floor and confidence interval are met;
- decreasing cost and operator minutes per stable outcome;
- no production claim without exact installed-runtime evidence;
- no learning or policy promotion from incomplete, selected, or uncalibrated
  outcome evidence.

## Ruthless focus

Until Ashlr records at least 20 stable real-world outcomes, freeze:

- new dashboards and flat fleet-status fields;
- new model aliases, providers, judge personas, and autonomy levels;
- broad multi-agent fan-out;
- new receipt types and bespoke ledgers;
- automatic mission planning and multi-host execution;
- marketplace, public SaaS, and ecosystem expansion;
- self-improvement claims based on synthetic verdicts or reflection prose.

Also cap work in progress. Sixty open pull requests and eleven stale goal lanes
are inventory, not throughput. New work should displace or close old work.

## Target operating architecture

```text
Human / Director Authority
        |
        v
Signed Mission Ledger
  outcomes, DAG, risk, repo contracts, human gates
        |
        v
Scheduler Reconciler
  priority, dependencies, capabilities, leases, reservations
        |
        v
Execution Capsule
  exact base/worktree, mandatory confinement, egress, context, checkpoint
        |
        v
Evidence Fabric
  trace, artifact identities, verifier evidence, independent review
        |
        v
Effect Controllers
  proposal -> protected merge -> release -> deploy -> runtime activation
  each separately authorized, receipted, canaried, and rollback-bound
        |
        v
Reliability Director
  SLOs, incidents, selective circuit breakers, rollback, escalation
        |
        v
Outcome Ledger
  post-merge stability, adoption, operator time, business value
        |
        +------------- measured feedback -------------+
```

No authority is transitive. A model may propose; a verifier may attest; a merge
controller may merge only an exact protected revision; a release controller may
publish only an exact artifact; deployment and activation require distinct
capabilities and rollback evidence.

Repository files, issue text, pull-request prose, tool output, retrieved memory,
and model-generated content are untrusted data. They cannot become instructions,
policy, capabilities, or authority without a typed, independently validated
transition.

New authority logic belongs in small, focused modules with thin adapters. Do not
expand `daemon/loop.ts`, `fleet/status.ts`, `inbox/merge.ts`,
`run/orchestrator.ts`, or `sandbox/worktree.ts` with another authority branch.

## Build sequence

### Stage 0A — Close the first-outcome authority gap

An independent adversarial review found that the existing direct external-agent
path is not a sufficient unattended boundary. Confinement defaults off, provider
CLIs retain broader host access than the proposal contract implies, linked
worktrees share Git metadata, pending proposals can enter existing auto-merge
machinery, proposal correlation is race-prone, and kill/enrollment revocation is
not continuously enforced through child termination and capture.

Before adding an unattended `--until-proposal` mode:

- require an immutable `human-only` review policy, preserve it through judging
  and verification, and prohibit every verdict from elevating apply, auto-merge,
  branch, push, remote-handoff, or merge authority;
- bind success only to the run's exact filed `proposalId`, then reload and prove
  exact repo, run, work generation, diff hash, provenance, signature, non-partial
  state, and durable pending authority;
- acquire a cross-process lane over canonical repo, objective digest, and pinned
  base commit, with crash-safe replay of one generation;
- create a narrowly scoped `FirstOutcomePermitV1` that durably prepares the
  maximum single-generation planning, model, verification, one-repair, and
  capture envelope before any planning or provider execution. Installation uses
  a one-generation compare-and-swap; the permit settles exactly once or enters
  quarantine, and crash or ambiguous recovery conservatively charges its full
  exposure. Stage 1 later generalizes it into hierarchical fleet admission;
- monitor kill-switch and enrollment revocation during execution, terminate the
  owned process tree, and refuse capture after revocation;
- require a sealed execution capsule: mandatory OS confinement, isolated HOME,
  and unsupported-platform refusal. Unattended execution receives no writable
  access to the source repository's Git common directory, refs, hooks, config,
  remotes, index, or credentials; it uses an isolated clone/object snapshot or
  an equivalent separately rooted Git namespace. Sentinel tests prove the
  source refs, config, hooks, and common directory remain unchanged. The capsule
  receives no provider credential. An API-model executor may reach only a local
  authenticated broker over a bound Unix socket or Windows named-pipe/loopback
  capability; that broker owns provider egress and credentials. External CLI
  unattended execution remains refused;
- prove hostile-agent attempts to approve, auto-merge, mutate services/config,
  bypass hooks, update refs, push, invoke nested or additional provider CLIs, or
  use raw egress leave every sentinel unchanged.

The existing resident setup refusal remains intact. A future non-service setup
command must be separately named and explicitly authorized; it must not be a
`skipDaemon` escape hatch in the current wizard.

The pre-existing `ashlr goal --direct` path should be treated as interactive,
operator-supervised functionality until it is hardened to the same contract. Its
same-repository before/after proposal-delta heuristic must be replaced by exact
run-bound durable proposal authority even if First Outcome Mode is deferred.

### Stage 0B — Prove the product loop

Build **First Outcome Mode**:

```text
ashlr goal "<real objective>" --project <repo> --until-proposal
```

After Stage 0A and a separate review of the credential/egress boundary, it admits
exactly one enrolled repository and objective, runs one
bounded execution generation with at most one explicitly budgeted existing
verification repair, and terminates with either one exact verified human-only
pending proposal or one explicit terminal blocker. It emits a bounded derived
CLI result envelope from existing durable run, proposal, and verification
records; the envelope has no replay or authority role and creates no new ledger.

`human-only` does not suppress observational judging or verification. It is
immutable on the exact proposal and prevents any judge verdict from granting
apply, auto-merge, push, or remote-handoff authority. Applying or delivering the
proposal requires a separately authenticated human approval capability.

It never merges, pushes, publishes, deploys, installs a service, creates a
credential, changes a provider, or promotes a policy.

Graduation requires a real protected PR accepted by a human and stable for seven
days. A fixture-only green test is necessary but insufficient.

### Stage 1 — Make autonomy economically and spatially atomic

Build **Autonomous Dispatch Admission V1**, a crash-safe hierarchical reservation
required before any autonomous launch. Bind mission/node/work identity, repo and
base, backend minimum capability, maximum tokens/dollars/steps/tool effects/
children/slots, confinement and egress digests, owner process identity, expiry,
generation, and parent reservation. This generalizes the conservative
single-generation `FirstOutcomePermitV1` into atomic fleet and child admission.

States are `prepared -> launched -> settled | cancelled | quarantined`. A child
cannot exceed its parent. Missing or ambiguous state queues work. Restart
recovery conservatively charges unresolved exposure or quarantines it.

Production unattended profiles must use real OS confinement. Unsupported
platforms must refuse unattended work rather than silently fall back.

### Stage 2A — Establish experiment identity

Before running an arena experiment, add the minimal experiment registry and
causal trace schema needed to bind hypothesis, cohort, arm assignment,
propensity, model/harness/prompt/tool/environment hashes, exact budget, cost,
latency, verifier identities, and terminal outcome. It is an append-only research
domain with deterministic projections and imports no effect authority. It is the
first compatible segment of the broader Stage 3 event spine, not a temporary
bespoke ledger.

### Stage 2B — Build the scientific lab

Create **ASHLR-ARENA**, beginning with a contract-first verifier shadow lab:

- control: current planner and candidate path;
- treatment: structured definition-of-done contract, independent contract
  evaluator, and up to three bounded verifier-feedback iterations;
- equal token and wall-time budgets;
- no proposal or outward-effect authority;
- exact harness, model, prompt, tool, environment, cost, latency, step, and
  assignment-propensity identities;
- hidden verifier success as the primary endpoint;
- repeated stochastic trials and bootstrap confidence intervals;
- public negative and null results.

The research system must explicitly forbid imports of apply, merge, push,
publish, deploy, credential, service-activation, and config-write primitives.

### Stage 3 — Complete the reliability and causal loop

Extend the Stage 2A schema into a unified causal event spine for mission ->
reservation -> execution ->
artifact -> verification -> proposal -> merge -> release -> runtime -> product
outcome. Use append-only events and deterministic projections; adapt existing
ledgers incrementally rather than migrating them all at once.

Add SLOs, error budgets, an incident ledger, severity, owner, mitigation receipt,
postmortem, and selective circuit breakers. A local fleet that cannot explain
and recover from its own stopped state is not ready for distributed operation.

### Stage 4 — Scale only mechanisms that win

Enable dependency-aware multi-agent work only when equal-budget experiments show
better verified success, cost-to-green, wall time, and human attention than a
single-agent control. Log topology and assignment propensities. Promote routing,
memory, prompt, verifier, and topology changes only after held-out evaluation,
shadow trials, and explicit human policy promotion.

## Research programs

1. **Science of agent organizations:** select single-agent, Best-of-N,
   specialist parallelism, planner/generator/evaluator, or graph topology from
   measured task structure—not fashion.
2. **Verifier engineering:** contract synthesis, hidden tests, mutation testing,
   metamorphic and differential checks, adversarial reward-hacking corpora, and
   verifier false-accept measurement.
3. **Long-horizon coherence:** durable milestones, assumptions, fresh-context
   handoffs, progress-sensitive replanning, stuck detection, and rollback to the
   last green checkpoint.
4. **Calibrated autonomy:** Brier score, expected calibration error,
   risk-coverage curves, selective accuracy, and escalation policy evaluation.
   Self-reported confidence never widens authority.
5. **Verified memory:** provenance, temporal supersession, contradiction,
   revocation, abstention, poisoning tests, and causal with-memory/no-memory
   outcome comparisons.
6. **Agent-computer interface design:** empirically optimize tool schemas,
   observations, error messages, semantic diffs, preconditions, and remediation.
7. **Automated research engineering:** agents propose falsifiable hypotheses,
   preregister experiments, run sandboxed trials, replicate independently, and
   produce signed reports; findings cannot deploy themselves.

## 30 / 90 / 180-day outcomes

### 0–30 days

- recover a green protected baseline; any early 3.2 publication/install proof is
  diagnostic only and cannot satisfy resident evidence after later source work;
- close the Stage 0A authority gap, then ship one-shot First Outcome Mode without
  resident-service authority;
- only after final Stage 0A source, repeat exact-head release, install, activation,
  and resident identity gates for the resident claim;
- prune or explicitly defer stale goals and draft PR inventory;
- run ten genuine tasks in one product and one repository cohort;
- target at least five accepted PRs and three seven-day-stable outcomes;
- publish an honest report including failures, cost, operator time, and
  regressions;
- recruit three to five concierge design partners.

### 30–90 days

- reach 20 stable outcomes across at least five repositories;
- land hierarchical dispatch admission and mandatory confinement;
- establish the frozen internal eval bank and ASHLR-ARENA first experiment;
- make GitHub issues and checks the primary collaboration surface;
- add a shared inbox, attribution, owner-machine apply, and distributed leases
  only after the local kernel is reliable;
- reach 40 percent accepted conversion on all admitted, non-duplicate work
  generations and five paying design partners; exclusions and every terminal
  blocker remain in the denominator report.

### 90–180 days

- operate the complete observe -> diagnose -> patch -> verify -> approve ->
  merge -> monitor -> rollback loop;
- add the causal event spine and incident operating system;
- enable measured multi-agent policies and shadow routing optimization;
- publish reproducible research artifacts and negative results;
- prove four consecutive weekly stable outcomes for retained teams;
- target 20 retained paying teams, under five percent regressions, and positive
  gross margin after model spend.

## Evidence principles

Current research supports executable verifier loops, structured long-horizon
artifacts, specialized agents for separable work, trace/outcome evaluation,
least-privilege confinement, and provenance-aware memory. It does not support
the blanket claim that more agents, longer context, reflection, vector search,
LLM judging, or benchmark scores create reliable autonomy.

Seven-day stability means an exact authenticated protected-merge identity,
required checks green, unreverted status, no attributable regression or incident,
and complete observation coverage across the window. Missing monitoring is
unknown, never stable.

Useful primary references:

- [OpenAI agent evaluations](https://developers.openai.com/api/docs/guides/agent-evals)
- [OpenAI harness engineering](https://openai.com/index/harness-engineering/)
- [Anthropic long-running agent harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Google study of agent-system scaling](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)
- [AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)
- [SWE-agent and agent-computer interfaces](https://arxiv.org/abs/2405.15793)
- [AgentDojo security benchmark](https://openreview.net/pdf?id=m1YYAQjO3w)

## Production boundary

This document is a program and research contract. It grants no proposal, merge,
release, deployment, publication, credential, provider, policy, financial,
service-installation, or runtime-activation authority. Source merge, protected
CI, package publication, installed runtime, daemon operation, and production
outcomes remain separate evidence gates.
