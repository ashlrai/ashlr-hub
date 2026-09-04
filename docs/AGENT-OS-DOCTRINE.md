# Agent OS Doctrine

Status: architecture doctrine. This document does not grant runtime authority or assert that the described end state is deployed.

## Mission

Ashlr Hub is the local-first operating system for an autonomous engineering fleet. Its purpose is not to maximize agent activity. Its purpose is to continuously convert available model capability, repository context, governed tools, and verified evidence into durable company value.

The end state is a system that can:

1. maintain a living, evidence-linked view of the best attainable product state;
2. generate multiple courses of action rather than lock onto the first plausible plan;
3. allocate Codex, Claude, local-model, human, compute, and time capacity to the highest-value verified bets;
4. execute reversible work within narrow identity- and capability-bound authority;
5. verify outcomes in the real environment, not merely source completion;
6. learn from effectiveness evidence and replan without waiting for routine human coordination; and
7. stop, isolate, or escalate when identity, evidence, budget, reversibility, or environmental assumptions no longer hold.

## Design inspiration: distributed decision advantage

NIWC Pacific describes *Sea Strike 2043* as distributed maritime operations in a contested environment using emerging technology, innovative strategy, and real-time intelligence. The film depicts a human-machine team comparing courses of action, fusing distributed observations, reconfiguring modular capabilities, using resilient communications, and synchronizing effects only after explicit authorization.

The engineering-system translation is direct, but not literal:

| Sea Strike concept | Agent OS design rule |
| --- | --- |
| Distributed operations | Repositories and agents remain independently useful but participate through one mission, evidence, and capability fabric. |
| Real-time decision aids | The cockpit leads with the current bottleneck, verified exceptions, capability headroom, and highest-value bets. |
| Course-of-action simulation | Generate competing implementation strategies, red-team their assumptions, and choose using expected value and evidence quality. |
| Human-machine teaming | Humans specify intent and exceptional constraints; the fleet handles routine planning, execution, verification, and replanning. |
| Pre-authorized capability | Standing permits are narrow, expiring, revocable, identity-bound, budget-bound, and effect-class-specific. Policy eligibility is never execution authority. |
| Modular systems | Models, harnesses, tools, and repositories expose typed capabilities and receipts instead of being hard-wired into one provider workflow. |
| Resilient communications | Durable state, leases, replay-safe events, checkpoints, and degraded-mode behavior survive process and provider failure. |
| Sensor fusion | Claims are projections over authenticated source evidence with visible completeness, freshness, and provenance. |
| Effect synchronization | Multi-repository or external effects use an explicit plan, preconditions, immediately rechecked authority, idempotency, and outcome receipts. |
| Contested spectrum | Prompt injection, stale context, compromised tools, account exhaustion, and conflicting concurrent agents are normal operating conditions. |

The `/VISION/` URL is a showcase for *Sea Strike 2043*, not evidence of a
separate published system named VISION. The film is a future-concept thinking
aid, not proof that its depicted capabilities are fielded. Likewise, public DON
material describes the electromagnetic-spectrum enterprise as policy,
governance, people, equipment, procedures, information, and infrastructure—not
as one verified software product named Spectrum. Agent OS adopts the control
patterns, not an unsupported equivalence or government-compliance claim.

Sources: [NIWC Pacific vision page](https://www.niwcpacific.navy.mil/VISION/),
[official DVIDS video record](https://www.dvidshub.net/video/950543/sea-strike-2043),
[DON Electromagnetic Battle Space Governance Board charter](https://www.doncio.navy.mil/FileHandler.ashx?id=16121),
and [DON Information Superiority Vision 2.0](https://www.doncio.navy.mil/FileHandler.ashx?id=22154).

## Capacity as contested spectrum

Codex and Claude subscriptions, local-model accelerators, context windows,
browser sessions, sandboxes, repositories, credentials, network paths, and
human attention are finite channels with interference, reset windows, variable
quality, and different consequence limits. The resource control plane must:

1. sense authenticated capacity and health without exposing credential values;
2. reserve capacity for high-priority and recovery work before opportunistic use;
3. route by mission value, measured model fitness, cost, latency, isolation,
   data sensitivity, quota, and current risk;
4. prevent double allocation through atomic, expiring leases;
5. apply fairness, backpressure, preemption, and circuit breaking;
6. degrade to smaller local scopes when providers or connectivity disappear;
7. reconcile interrupted work idempotently when capacity returns; and
8. learn from measured outcome per token and wall-clock time, not utilization.

This is an engineering inference from DON's closed-loop spectrum-on-demand
concept, which describes distributed sensing, interference monitoring,
predictive congestion management, dynamic allocation, and human oversight. It
does not claim that Ashlr implements or is endorsed by that system. Source:
[DON Spectrum on Demand](https://www.doncio.navy.mil/chips/ArticleDetails.aspx?ID=20514).

## Kernel architecture

The Agent OS kernel is a control loop with six planes:

1. **Intent plane** — living end state, mission graph, invariants, acceptance criteria, and current bottleneck.
2. **Identity and capability plane** — execution identity, workload identity, provider/model/tool capabilities, account headroom, reset windows, and environment binding.
3. **Planning plane** — competing value hypotheses, courses of action, dependency graphs, expected value, evidence plans, and reversible checkpoints.
4. **Execution plane** — sandboxed agents and tools operating through narrow leases and the existing effect-authority machinery.
5. **Evidence plane** — append-only authenticated observations, verification manifests, outcome windows, counterfactuals, and source-quality states.
6. **Command plane** — exception-first operator experience, kill/revoke controls, audit, replay, and explicit human authorization for materially consequential effects.

No plane may silently manufacture authority for another. A good plan is not a permit. A permit is not an execution. A passing source test is not a deployed effect. A deployed effect is not a valuable outcome.

## Zero-trust and ICAM rules

Zero trust in Agent OS means every workload, tool call, repository mutation, provider request, and effect is treated as untrusted until its exact identity, context, capability, and current policy are verified.

- Never trust an agent because it ran earlier in the same task.
- Bind authority to principal, workload, repository, mission, spec, tool, environment, budget, time window, acceptance criteria, rollback evidence, and revocation epoch.
- Separate observation authenticity from effect authority. Host-local HMAC evidence does not become a deployment or merge credential.
- Recheck kill state, revocation, budget, freshness, and scope immediately before an effect.
- Prefer short-lived, least-privilege capabilities over ambient credentials.
- Keep account locators and secrets private; expose only values-free capability state to planning and UI layers.
- Treat missing or incomplete evidence as unavailable, never as a healthy zero.
- Make every external or irreversible effect replay-safe, attributable, and recoverable where recovery is genuinely possible.

### Decision, administration, and enforcement

The control plane uses the separation in NIST SP 800-207:

- **Policy decision point:** evaluates signed identity, resource, environment,
  risk, budget, freshness, mission, and effect-class facts. It can allow, deny,
  or revoke eligibility, but it performs no effect.
- **Capability administrator:** converts an allowed decision into one
  single-purpose, short-lived, audience-bound capability. It cannot broaden the
  decision or reuse an expired/revoked grant.
- **Policy enforcement point:** the local broker immediately rechecks the
  capability and current posture, confines the process/tool session, mediates
  I/O, terminates access, and emits an outcome receipt.

The three roles require disjoint interfaces and audit events even when they run
on one desktop. No planner, model, dashboard, repository file, environment
variable, or self-authored score may call the enforcement point directly.

Sources: [NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final),
[DoD Enterprise ICAM Reference Design](https://dodcio.defense.gov/Portals/0/Documents/Cyber/DoD_Enterprise_ICAM_Reference_Design.pdf),
and [DoD Zero Trust Reference Architecture v2.0](https://dodcio.defense.gov/Portals/0/Documents/Library/%28U%29ZT_RA_v2.0%28U%29_Sep22.pdf).

### Identity and evidence envelope

Every dispatch and effect must bind a canonical envelope containing:

- human or service principal, agent/workload instance, model endpoint, account,
  tool, broker, repository, worktree, revision, runtime, and device identities;
- mission, objective, hypothesis, acceptance contract, sensitivity, data
  lineage, retention, budget, deadline, and effect class;
- policy version and epoch, decision inputs and reason codes, capability ID,
  issuance/expiry, audience, nonce, and revocation state; and
- start/end state, resource use, verifier identity, produced artifacts,
  outcome observation, recovery status, and immutable receipt identity.

Unknown, stale, incomplete, unauthenticated, or conflicting fields produce an
unavailable or denied state. They never collapse into a healthy default.

## Autonomy ladder

Autonomy expands by proven effect class, not by a single global switch.

1. **Observe** — read and authenticate state; no effects.
2. **Recommend** — generate value hypotheses and courses of action; no effects.
3. **Simulate** — run tests, sandboxes, replay, and adversarial canaries.
4. **Build** — perform workspace-local reversible edits under a narrow permit.
5. **Propose** — create commits or change proposals with complete evidence.
6. **Integrate** — merge or push only through the existing authorization and effect journal.
7. **Operate** — deploy, communicate externally, or spend materially only under explicit current authority and acceptance monitoring.

Each rung has its own identity, evidence, budget, revocation, recovery, and acceptance contract. Evidence from one rung does not prove the next.

## Resource economics

Subscription tokens are perishable capacity, but utilization alone is not value. The scheduler should optimize expected durable value under uncertainty:

`priority = expected outcome value x information gain x strategic compounding x time sensitivity / (token cost x failure risk x coordination cost)`

The expression is a planning model, not a validated financial metric. Estimates must remain labeled, bounded, and replaceable by observed outcomes. Cheap or local models should absorb parallel exploration, classification, replay, mutation testing, and background verification when their measured reliability is sufficient. Frontier capacity should be reserved for high-leverage synthesis, difficult implementation, and independent criticism.

## Effectiveness and self-critique

The fleet may mark its own work effective only when the acceptance contract named the measurement in advance and an independent observation supplies the result. Self-authored prose is not outcome evidence.

Every value bet should close with one of four states:

- **effective** — the predeclared outcome threshold was met with complete evidence;
- **refuted** — evidence disproved the thesis;
- **inconclusive** — the observation window or source quality was insufficient; or
- **superseded** — the mission changed, with the replacement linkage recorded.

The learning loop retains failed hypotheses, verifier disagreements, elapsed time, token cost, operator intervention, and downstream outcome. It should reward calibrated prediction and durable impact, not code volume or agent agreement.

DoD's zero-trust roadmap treats capability, activity, outcome, assessment, and
authority as distinct evidence. Agent OS uses the same useful separation:

- **implemented** — source and artifact evidence exists for the capability;
- **enforced** — the exact runtime rejects bypass and degraded inputs;
- **effective** — a predeclared outcome threshold passed an independent
  observation window;
- **commissioned** — an authorized operator bound the exact identities,
  infrastructure, policies, keys, and rollback path; and
- **production-authorized** — a current, scoped, revocable grant admits this
  exact effect class.

Regression, expired evidence, changed configuration, identity drift, failed
adversarial checks, or revoked authority automatically lowers the state. A
component is never "fully complete" as a permanent self-assertion.

Sources: [DoD Zero Trust Capabilities and Activities v1.1](https://dodcio.defense.gov/Portals/0/Documents/Library/ZT-CapabilitiesActivities.pdf),
[DoD Continuous Authorization to Operate](https://dodcio.defense.gov/Portals/0/Documents/Library/20220204-cATO-memo.PDF),
and [CISA Zero Trust Maturity Model v2.0](https://www.cisa.gov/sites/default/files/2023-04/zero_trust_maturity_model_v2_508.pdf).

## Production acceptance contract

The control loop is not live until one exact release passes all of these gates:

1. **Fresh composition:** the cockpit reconstructs an authenticated snapshot in
   under 60 seconds, remains fresh for 24 hours, rejects a forged or replayed
   source, and visibly degrades after a producer crash.
2. **Concurrent allocation:** two separately identified Codex accounts, one
   supported Claude capacity source, and one local model can run concurrently
   through atomic leases without credential crossover or double allocation.
3. **Containment:** execution uses an authenticated deny-default broker;
   network, filesystem, process, environment, time, output, and cleanup limits
   are enforced, and a kill/revoke reaches the broker in under one second at
   p99 during the acceptance run.
4. **Course-of-action choice:** each material bet records at least two genuinely
   different plans, assumptions, predicted value/cost, red-team findings, and a
   deterministic selection reason before implementation begins.
5. **Value-loop closure:** at most three active strategic bets each have a
   frozen hypothesis, baseline, budget, stop rule, independent outcome source,
   and terminal classification. A benchmark of at least 20 representative
   missions must show more than 20 percent improvement in accepted outcome per
   token over the declared FIFO baseline before adaptive routing is promoted.
6. **Effect-class canary:** each new effect class completes at least 50 admitted
   actions over seven days with complete receipts, under 10 percent human
   intervention, zero unreceipted effects, and a tested rollback under five
   minutes before broader standing authority is considered.
7. **Golden ecosystem mission:** one mission crosses Plugin, Hub, Cortex or
   Locus, an isolated agent, Phantom, and Stack through typed contracts while
   each product remains independently usable; every handoff retains identity,
   provenance, sensitivity, and acceptance linkage.
8. **Operator command:** physical and software kill/revoke controls are tested
   under load. The Work Louder emergency action must be authenticated and reach
   local enforcement in under 250 milliseconds at p99 without relying on a
   cloud round trip.

These thresholds are initial promotion criteria, not validated performance
claims. Acceptance evidence must name its exact release, host, configuration,
policy epoch, data set, clock interval, and verifier.

## Current implementation boundary

The current tranche establishes source-level contracts for execution identity, capability spectrum, living end state, strategic investment, an observation-only kernel, an authenticated Agent OS snapshot path, an inert standing-permit evaluator, and a read-only cockpit.

It intentionally does not schedule a producer or grant live effect authority because a production source for the complete Agent OS read-model input does not yet exist. Until that source exists, the correct runtime state is missing or degraded. Historical rollback resistance also requires an anchor outside the same-user local store; host-local authenticated chains must publish that limitation.

## Next implementation sequence

1. Create durable production registries for verified mission, capability, portfolio, hypothesis, and redacted display inputs.
2. Add an observation producer after durable daemon ticks, with overlap suppression, deadlines, cancellation, and attempt receipts.
3. Add counterfactual course-of-action simulation and adversarial evaluation using isolated model pools.
4. Connect standing-permit eligibility to the existing activation/effect-authority path without adding a parallel trust root.
5. Introduce effectiveness observation windows and automatic portfolio reallocation.
6. Add cross-repository mission packages so Hub, Phantom, Cortex, Locus, MMCP, and Work Louder remain independent products while sharing typed identity, evidence, and capability contracts.
7. Add an external transparency or hardware-backed monotonic anchor before claiming historical rollback protection.
