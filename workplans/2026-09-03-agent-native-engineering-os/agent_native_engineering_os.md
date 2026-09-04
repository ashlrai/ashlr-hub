# Ashlr Agent-Native Engineering OS

Status: observation-first source foundation and adversarial verification complete; commissioning, released provenance, and higher authority stages remain future gates

## Product thesis

Ashlr Hub should be the operating system for an autonomous engineering fleet, not another agent chat or a thin model router. Its job is to turn intent, models, accounts, local compute, repositories, tools, evidence, and bounded authority into a continuously improving portfolio of valuable engineering outcomes.

The operating-system analogy is precise:

| OS primitive | Ashlr primitive |
| --- | --- |
| CPU and accelerators | Codex, Claude, local models, and future provider capacity |
| RAM and durable storage | bounded context, Cortex memory, artifacts, receipts, and decision history |
| processes | missions and falsifiable value hypotheses |
| scheduler | Hub's single fleet scheduler and resource allocator |
| process isolation | repositories, worktrees, sandboxes, and scoped credentials |
| device drivers | Phantom, Locus, Ashlr Stack, wrkpad, MCP, CLIs, browsers, and provider adapters |
| context and compute efficiency | Ashlr Plugin and `@ashlr/core-efficiency` compact retrieval, budgets, cache hints, and savings evidence |
| kernel security | execution identity, least privilege, standing permits, policy, and kill paths |
| observability | topology, evidence chains, outcome windows, capacity, and exception-first status |
| package/application boundary | independently shippable Hub, Cortex, Locus, Phantom, and wrkpad products |

## The one control loop

The system should have one legible control loop rather than a collection of agents critiquing one another without a shared objective:

1. **Sense** — observe the current product, market, code, runtime, capacity, risk, and outcome evidence.
2. **Form hypotheses** — express at most three active investments with explicit value, cost, probability, acceptance, guardrails, and observation windows.
3. **Allocate** — spend the most perishable trusted capacity first while protecting interactive reserves and preventing double allocation.
4. **Execute** — decompose work into isolated missions and dispatch only within granted identity, tool, repository, budget, and effect authority.
5. **Verify** — require executable acceptance plus artifact, receipt, and outcome evidence appropriate to risk.
6. **Learn** — distinguish effective, refuted, guardrail-breached, inconclusive, and still-observing results. Update the vision and portfolio from evidence, not activity volume.
7. **Repeat** — checkpoint the cycle so ancestry, replay, forks, and degradation are inspectable.

The north star is receipt-qualified retained product and user value. Reusable IP, information gain, and value per expiring token/time window are first-class contributors. Commits, merges, tests, agents, tokens, and hours saved are operational diagnostics; none is proof of value by itself.

## Kernel invariants

- Hub is the sole cross-product scheduler. Cortex supplies memory and intelligence; Phantom supplies governed secret access; Locus supplies workspace/context surfaces; Ashlr Stack supplies provider lifecycle and health; Ashlr Plugin supplies the agent-facing efficiency surface; `@ashlr/core-efficiency` supplies reusable compression, budgeting, token, genome, and local-context primitives; wrkpad supplies deliberate physical controls. They remain useful alone.
- No model, agent, plugin, or tool self-grants authority. Identity, permission, budget, environment, and effect scope are independent dimensions.
- A digest is an integrity binding, not authenticity or truth. Trust also requires provenance, freshness, cross-source binding, and a verified receipt chain.
- Unknown capacity is zero capacity. Stale observations do not become permission. Reset windows are scheduling inputs, not invitations to bypass provider rules.
- A proposal is not execution; source completion is not installation; tests are not deployment; deployment is not adoption; adoption is not retained value.
- Routine reversible engineering can eventually run under standing permits. Irreversible, external, financial, credential, production, publication, and high-blast-radius actions remain explicitly governed unless a narrowly scoped standing permit says otherwise.
- Autonomous self-assessment is allowed only against predeclared acceptance and outcome contracts. The actor that produced an artifact cannot erase contradictory evidence or redefine success after seeing the result.
- Degradation is local by default. One unavailable account or device should reduce the affected lane, not halt the fleet, unless a shared safety or integrity invariant is broken.

## Spectrum, zero trust, and ICAM applied to engineering

The useful lesson from electromagnetic-spectrum operations is dynamic allocation under contention: maintain a current picture of heterogeneous capacity, assign it to the highest-value compatible mission, detect interference or loss, and re-plan without losing command intent. In Ashlr, the spectrum is model usage windows, local compute, isolated worktrees, tools, attention, and time.

Zero trust makes every dispatch an evaluated request rather than an inherited ambient permission. ICAM becomes the binding among human principal, workload identity, model/account, repository, worktree, tool, credential capability, mission, and allowed effects. The scheduler should decide from continuously verified posture and issue the smallest short-lived capability that can complete the step.

This avoids two bad extremes: a fleet too constrained to create value, and a fleet whose autonomy is merely unbounded credential possession.

## Autonomy progression

| Tier | System behavior | Promotion evidence |
| --- | --- | --- |
| 0 — observe | values-free inventory and topology only | privacy, freshness, identity, and determinism tests |
| 1 — shadow decide | create hypotheses and allocations without effects | replay agreement, counterfactual quality, no invented inputs |
| 2 — propose | prepare plans, patches, and effect manifests | executable acceptance, scoped rollback, independent verification |
| 3 — bounded execute | perform reversible local engineering under standing permits | low escape rate, reliable recovery, receipt completeness |
| 4 — governed operate | perform selected provider/production actions under narrow permits | live canaries, blast-radius limits, revocation, audited outcomes |
| 5 — adaptive portfolio | evolve end state and resource allocation from retained-value evidence | longitudinal calibration, anti-Goodhart audits, human override integrity |

Promotion is per capability and per effect class, never a single global “autonomous” switch.

## Current implementation slice

The current source slice establishes the Tier 0–1 substrate:

- **Execution Identity V1** separates multiple Codex accounts, Claude capacity, local engines, and future providers through public digests and private runtime locators. It is default-off, shadow-only, and grants no dispatch authority.
- **Living End-State portfolio** ranks no more than three falsifiable investments, reserves capacity, binds frozen outcome evidence, and keeps every effect bit false.
- **Strategic investment compiler** converts a strategist briefing into portfolio hypotheses only when every numeric assumption and acceptance contract is supplied explicitly. It does not infer economics from prose.
- **Capability Spectrum** creates a values-free inventory and atomic lane allocation across model, compute, worktree, and tool capacity. Unknown, stale, exhausted, and invalid resources contribute zero.
- **Agent-native kernel shadow** composes identity, portfolio, evidence, resources, and checkpoint lineage into a deterministic sense/allocate/observe receipt.
- **Agent OS cockpit** is a read-only decision spine for the living end state, bottleneck, exception-first action, reset-aware capacity lanes, and three active bets. It is mounted only behind the authenticated observation-only Agent OS read path and renders missing/degraded state instead of accepting a fabricated backend view.

These components are source capabilities, not authenticated runtime activation. They do not dispatch models, touch providers, reserve capacity, modify repositories, start a daemon, merge, release, deploy, publish, or prove business outcomes.

## Implemented read-only integration boundary

The backend seam is one internal read model assembled from verified persisted inputs owned by Hub:

- `/api/vision/mission` remains the source of strategist intent and mission topology.
- Execution Identity supplies redacted capacity observations, never locators or account labels.
- Capability Spectrum supplies only verified resource and contention state.
- The portfolio supplies explicit hypotheses and frozen outcome decisions.
- The kernel supplies lifecycle, reasons, counts, and checkpoint receipt.

The authenticated `/api/agent-os` read path drives the cockpit only when those sources exist and agree. An empty or inconsistent source renders as degraded/unknown, never as invented progress. A default-off observer can compile externally signed source bundles into snapshots, but no trust keys or released producers are installed and no live scheduling authority follows from the read path. Future dispatch remains in the existing mission, policy, sandbox, proposal, and receipt paths rather than a second runtime.

## Expanded ecosystem contract

The additional Ashlr projects are not absorbed into Hub. They become independently shippable services behind small, versioned observation and capability contracts:

- **Ashlr Plugin** is the agent-facing efficiency shell across Codex and Claude Code. Its compact MCP tools, hooks, genome, and session accounting should emit privacy-preserving efficiency receipts that Hub can use for context-policy evaluation. The user's reported lifetime saving of more than 260 million tokens is a strong product signal, but Hub should import only auditable counters and benchmark confidence—not a marketing number or raw prompt/tool content.
- **`@ashlr/core-efficiency`** is the reusable policy engine beneath Plugin and future local-model workers: compression tiers, token estimation, provider-aware budgets, caching helpers, genome retrieval, session logs, and small-context management. Hub should depend on stable library contracts rather than copy those implementations.
- **Ashlr Stack** is the provider/service control plane. It should expose read-only stack shape, health, quota, and planned-effect manifests to Hub. Provision, deprovision, OAuth, billing, webhook, or credential effects remain inside Stack and Phantom behind their own exact permits; a Hub observation never becomes provider authority.
- **Phantom** remains the vault and credential-capability broker. Hub and Stack receive narrow references or short-lived capabilities, never secret values in mission, model, telemetry, or Agent OS snapshots.

Together these form a clean vertical path: Plugin senses agent-context cost; Core Efficiency calculates compact execution policies; Hub allocates missions and capacity; Cortex supplies durable organizational knowledge; Locus supplies governed workspace context/tools; Stack plans and verifies external service topology; Phantom brokers secrets; wrkpad provides deliberate local controls. Each boundary must carry versioned receipts, freshness, provenance, privacy class, and literal authority claims.

## Verified source state on 2026-09-03

The original kernel/cockpit slice passed 190 focused/adjacent tests with one Windows-only skip, all 100 web tests, core and web typechecks, full repository lint with zero errors, the full production build, and whitespace validation. Those counts predate the production-observer tranche. Independent adversarial passes on that original slice found and closed capability-verifier, evidence-provenance, checkpoint-lineage, acceptance-replay, prompt-injection, privacy, count-partition, clock-skew, cross-spectrum identity-binding, and cloud-as-local classification defects.

The monolithic repository test command was also attempted. It continued through broad integration fixtures for more than ten minutes without producing a terminal summary and was stopped cleanly; it is not part of the passing claim above.

This is therefore a hardened, internal Tier 0–1 source foundation. It is not yet an installed or authenticated Agent OS runtime, and it does not claim Tier 2–5 autonomy.
