# Ashlr Unified Agent Operating System Blueprint

Date: 2026-09-02  
Owner: Mason / Ashlr  
Status: Architecture selected; Hub, Locus, and Cortex workspaces consolidated; Execution Identity V1 and Living End-State allocator implemented in shadow mode

## The decision

Build **Ashlr Hub as the local FleetOS kernel**: the one scheduler, evidence ledger, operator topology, and engineering-effect gate for every Codex account, Claude execution surface, and local model the founder legitimately controls.

Do not merge all product source into Hub. Do not rewrite Hub from scratch. The current Hub already contains the hard, valuable machinery—mission DAGs, proposal-first autonomy, sandboxed worktrees, multi-backend routing, provenance, verification, budgets, MCP aggregation, and an operating UI. A rewrite would erase hundreds of tests and years of encoded safety behavior. We will refactor the provider/account boundary and compose the products through versioned protocols.

The system should feel like one product while remaining five independently valuable products:

| Plane | Product | Owns | Must never own |
| --- | --- | --- | --- |
| Company intelligence | Cortex | Goals, business context, responsibility, memory, business-state approval | Model credentials, engineering scheduling, Git/release authority |
| Fleet kernel | Hub | Mission compilation, scheduling, provider/model routing, workspaces, verification, receipts, operator UI | Raw secrets, tenant identity truth, implicit business approval |
| Execution identity | Locus | Principal, tenant, provider account, sealed session, wrong-account prevention | Fleet priorities, code acceptance, secret values |
| Secret plane | Phantom | Vault, scoped placeholders, TTL leases, network-edge injection | Mission selection, account policy, model context |
| Operator I/O | wrkpad | Six live agent slots, status lights, guarded pause/resume/stop and navigation | Generic shell, push/merge/deploy, credentials, approval inference |

## The product thesis

The opportunity is larger than “run many coding agents.” Commodity agents will get faster. The durable value is the control system around them:

- use every legitimate execution pool without mixing accounts or credentials;
- route work to the cheapest model that can pass the required evidence threshold;
- keep local models busy on exploration, tests, refactors, and candidate generation;
- escalate ambiguity and risk to stronger models;
- convert every run into durable evidence and learning;
- make autonomy visible, interruptible, and accountable;
- spend expiring subscription and local-compute capacity on the highest-value mix of building and learning;
- grant standing authority to routine, reversible work inside a founder-defined constitution, escalating only when a proposed action would exceed it.

The resulting IP is an **evidence-bearing autonomy kernel**—not another model wrapper and not another dashboard.

## Capability-on-Demand: the Sea Strike and Spectrum insight

The linked NIWC Pacific “VISION” page is the official home of the 4:32 concept film [Sea Strike 2043](https://www.niwcpacific.navy.mil/VISION/), not a published software framework named VISION. The film depicts a compressed loop: sense an uncertain environment, simulate courses of action, let a human commander redefine the objective, compose modular capabilities, execute specialist work in parallel, and request explicit authorization before synchronized automated effects. Its closing frame names AI, real-time decision aids, modular systems, advanced manufacturing, autonomy, resilient communications, directed energy, long-range effects, and electronic-warfare/cyber convergence. It is an aspirational concept artifact, not evidence that every depicted capability is operational.

DON's current [Spectrum-on-Demand](https://www.doncio.navy.mil/%28emrqdynnvd5tp0y4kvriys55%29/CHIPS/ArticleDetails.aspx?ID=20514) work provides the deeper systems analogy: distributed sensing, closed-loop notifications, predictive congestion/interference modeling, dynamic coexistence, deconfliction, machine-speed allocation, and human oversight for a scarce and contested resource.

Ashlr should turn that pattern into **Capability-on-Demand**. Hub treats model/account quota, context, GPU/CPU/RAM, storage, worktrees, tools, network paths, human attention, and effect authority as an “agentic spectrum” that it continuously senses, deconflicts, allocates, and reroutes. This is an Ashlr design inference—not Navy endorsement, defense readiness, or a claim that a single public DON platform called “Spectrum” exists.

The operating loop becomes:

```text
sense capacity + posture + mission state
  -> make sense through competing plans and simulations
  -> select a course of action under explicit policy
  -> allocate short-lived capability leases
  -> execute specialists in parallel
  -> continuously re-evaluate and revoke when conditions change
  -> authorize each consequential effect separately
  -> measure the outcome and learn
```

The north-star product sentence is: **Ashlr turns heterogeneous AI agents into an identity-driven, continuously authorized, mission-engineered fleet that maneuvers across constrained compute and model resources while delivering cryptographically attributable business outcomes.**

## Living End-State: intelligence as investable capacity

The product requirement is not that the fleet run unattended for a particular number of days. The requirement is that available intelligence—Codex and Claude subscription capacity, Agent SDK/API credit, local inference, wall time, compute, and worktrees—be continuously invested toward the best reachable product state. Subscription quota is expiring inventory: unused capacity near reset has real opportunity cost, but token burn and agent activity have no intrinsic value.

Hub therefore runs one compact loop:

```text
evolving end state
  -> falsifiable product hypotheses
  -> price impact + information gain + strategic/IP leverage + resource cost
  -> allocate a small portfolio
  -> build and test in parallel
  -> verify against acceptance frozen before execution
  -> observe technical, product, and business outcomes
  -> continue, stop, or reallocate
  -> revise the working end state from evidence
```

The loop is intentionally not a standing committee of planner, critic, judge, governor, and approver agents. Routine, reversible work can be planned, built, and deterministically checked in one fast lane. A separate model family or evaluator is introduced only when consequence, novelty, uncertainty, disagreement, or evidence quality crosses a threshold. The assurance burden adapts to the decision.

The founder defines a small constitution: purpose, prohibited outcomes, protected metrics, external commitments, authority ceiling, and who may amend it. Inside that envelope, Hub may autonomously choose features, kill weak ideas, open branches, merge, canary, deploy, observe, and roll back only for task classes that have an explicit standing permit and tested recovery path. This is not per-action human approval. A human decision is required when the fleet wants to expand or amend its constitutional authority, make a new external commitment, or take an effect whose reversibility and acceptance contract have not already been established.

The fleet may mark its own work effective, but never from its own narrative. An effectiveness result requires thresholds frozen before work began plus complete, attributable evidence. The ladder remains explicit:

- **Technically effective:** the intended behavior passed independent or deterministic verification on the exact artifact.
- **Product effective:** the deployed behavior produced the defined user or system outcome within the observation window.
- **Business effective:** the outcome produced and retained the defined company value.

Missing, stale, self-authored, or causally weak evidence yields `unknown` or `hold`, not success. Early falsification is valuable when it prevents further waste.

Continuous operation is a resilience property, not a fixed-duration product requirement. Hub must checkpoint and resume work automatically, renew standing permits before expiry, isolate credential or quota failure to one execution lane, preserve other healthy lanes, trigger preauthorized rollback from objective canaries, and run tactical, daily, and weekly self-review at different planning horizons. A fleet-wide halt is reserved for shared invariant failure, not one exhausted account.

## Target system

```text
                          ASHLR FLEETOS

  Cortex                         Hub Mission Kernel
  intent + RACI  ──signed────▶  compile DAG / schedule / verify
                                  │
                                  │ ExecutionIdentityRef
                                  ▼
  wrkpad ◀──bounded status──  Identity + Capacity Router
  six agents / guarded I/O         │
                                  │ sealed session request
                                  ▼
                              Locus identity plane
                                  │
                                  │ opaque SecretLeaseRef
                                  ▼
                              Phantom secret plane
                                  │
             ┌────────────────────┼─────────────────────┐
             ▼                    ▼                     ▼
       Codex App Server     Claude Agent SDK       Local runtime
       account A / B        credit/API pool        Ollama/llama.cpp
             │                    │                     │
             └──────── sandboxed worktree + tools ─────┘
                                  │
                                  ▼
                    diff + tests + evidence receipts
                                  │
                       effect-specific authority gate
                                  │
                       branch / PR / merge / release
                                  │
                    outcome receipt back to Cortex
```

## The first architectural correction: execution identity

Hub currently understands one `codex` and one `claude`, not two Codex subscription accounts and distinct Claude capacity pools. It inherits one ambient credential environment and keys some capacity/backoff by engine. That is unsafe and wastes capacity.

`ExecutionIdentityV1` makes account identity a first-class, opaque scheduling dimension:

```text
engine: codex
executionIdentityRef: exid_7d2…       # opaque inside public flows
authKind: chatgpt-subscription        # policy metadata
privateRuntimeLocatorRef: local_4a…   # private store only
capacityPolicyRef: codex-max
locusBindingRef: locus_91…            # opaque
concurrency: 1
authorityCeiling: proposal
```

Rules:

1. Account labels, emails, paths, auth files, tokens, and secret values never enter prompts, proposals, telemetry, plugin APIs, or public JSON.
2. Quota, cooldown, backoff, cost, health, and assignments key on `(engine, executionIdentityRef)`.
3. Unknown or stale identity evidence yields zero trusted capacity.
4. Each Codex account runs through a separately authenticated App Server/runtime and private credential domain.
5. Claude interactive Max, Claude Agent SDK credit, and pay-as-you-go API are distinct resources. They are never presented as one pool.
6. Local model identities include the exact server, model, quantization, context, tool protocol, and eval profile—not merely “Ollama is running.”
7. The first release is shadow-only: it shows the assignment Hub would choose without switching credentials or launching a new account.

OpenAI's supported local integration primitives are a strong fit: the [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) manages threads, while [App Server](https://learn.chatgpt.com/docs/app-server) exposes account login, thread lifecycle, and rate-limit readings. Authentication remains isolated under the documented [`CODEX_HOME`/credential-store boundary](https://learn.chatgpt.com/docs/auth).

Anthropic's current policy materially changes the design: `claude -p` and Agent SDK automation now use a [separate monthly SDK credit](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), not the interactive Max allowance. Interactive [agent teams](https://code.claude.com/docs/en/agent-teams) can complement Hub, but they are experimental and should not become the durable scheduler.

## The small protocol kernel

Avoid turning every concern into a service, team, or ceremony. Cross-product interoperability needs five durable envelopes; identity, secrets, risk, resource, and revocation data are nested facets or references inside them:

| Envelope | Purpose | Key facets |
| --- | --- | --- |
| `IntentEnvelopeV1` | State what outcome is worth pursuing and how it can be falsified | Cortex assignment, living-end-state version, hypothesis, baseline, frozen acceptance, source revision |
| `CapabilityLeaseV1` | Reserve a bounded execution capability | opaque execution identity, Locus session, runtime attestation, quota/compute/worktree budget, Phantom lease refs, expiry |
| `EffectPermitV1` | Express standing or one-shot authority at the enforcement edge | task class, resource scope, obligations, consequence ceiling, revocation, recovery contract |
| `RunReceiptV1` | Bind exact execution and artifact evidence | source/artifact digests, tools, resource spend, tests, independent checks, policy decisions |
| `OutcomeReceiptV1` | Record whether value actually appeared and persisted | hypothesis, technical/product/business thresholds, observation window, causal grade, rollback/retention |

These are one protocol kernel, not five new daemons. Internal types such as `ExecutionIdentityV1`, risk signals, secret leases, and revocation events can evolve without forcing artificial product boundaries. A successful receipt still does not silently grant the next effect; the standing permit determines whether the next transition is automatic or must stop.

## Zero-trust command architecture

[NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final) and the [DoD Zero Trust Strategy](https://dodcio.defense.gov/Portals/0/Documents/Library/DoD-ZTStrategy.pdf) separate policy decision from policy enforcement and reject implicit trust based on location or ownership. For Ashlr, “local,” “our repo,” “our agent,” “authenticated once,” and “the model said it passed” confer no automatic authority.

```text
Cortex mission intent
        |
        v
Hub Policy Engine <--- identity, posture, risk, budget, data labels
  deny / challenge / grant + obligations
        |
Hub Policy Administrator
  mints signed, short-lived capability/effect permits
        |
        +--> dispatch enforcement point
        +--> Locus session/sandbox/egress enforcement point
        +--> Phantom secret-lease enforcement point
        +--> Git/merge enforcement point
        +--> deploy/provider enforcement point
        +--> wrkpad presence/abort enforcement point
        |
immutable receipts -> continuous re-evaluation -> revoke/contain
```

Every decision evaluates subject, action, resource, environment, and obligations. Enforcement occurs at dispatch, privileged tool calls, context resume, privilege escalation, commit, merge, deploy, secret access, external send, and material posture change. A valid standing permit makes routine transitions automatic; the system should not manufacture a human checkpoint at each edge. Offline or degraded policy can preserve or reduce an existing bounded privilege; it cannot create new authority.

The DoD seven-pillar model translates cleanly as a design checklist:

| DoD pillar | Ashlr control surface |
| --- | --- |
| User | Founder, teammate, service, and organizational identity |
| Device | Mac, runner, secure hardware, local runtime, posture |
| Application & Workload | Agent, model, plugin, task, and tool identity |
| Data | Source, memory, artifacts, secrets, lineage, sensitivity |
| Network & Environment | Provider session, IPC, egress, sandbox, worktree |
| Automation & Orchestration | Policy engine, scheduler, permits, revocation, kill switch |
| Visibility & Analytics | Signed receipts, confidence, cost, drift, anomaly, outcomes |

## Provider roster

### Codex

- Run one isolated local Codex App Server per account profile.
- Authenticate each account once through the user-owned device/browser flow.
- Read rate-limit evidence per profile and schedule accordingly.
- Use SDK/App Server threads rather than scraping the desktop UI.
- Never copy or pool auth tokens.

### Claude

- Treat interactive Max sessions as founder/teammate capacity.
- Treat Agent SDK/`claude -p` as a separate credit or API-backed unattended executor.
- Pass an explicit MCP configuration and least-privilege permission policy to every run.
- Remove `--dangerously-skip-permissions` from the desired end state; use a brokered permission callback/effect permit.

### Local models

- Standardize on an OpenAI-compatible adapter so Ollama, llama.cpp, LM Studio, and future runtimes can compete behind the same contract.
- Keep conversation state and retries in Hub because Ollama's Responses compatibility does not provide durable state continuity.
- Maintain an eval card per exact model configuration: coding domain, context limit, tool reliability, structured-output reliability, throughput, energy/cost, and verified acceptance rate.
- Graduate authority by measured cohort: explore → draft → test author → bounded patch → branch candidate. Local models do not reach main because they are local; they earn authority through evidence.

## Autonomy model

“Fully autonomous” means continuous judgment and operation inside a small standing constitution, not a chain of routine human approvals and not unlimited effects.

| Level | Autonomous behavior | Required evidence |
| --- | --- | --- |
| A0 Observe | Inventory, health, topology, queue, capacity | Fresh signed observation |
| A1 Think | Research, decompose, simulate, critique | Reproducible artifacts |
| A2 Propose | Create isolated diffs and test evidence | Sandboxed receipt, no outward effect |
| A3 Branch | Push a bounded branch / open draft PR | Standing permit, exact repo/SHA/scope, green gates |
| A4 Merge | Merge low-risk changes | Independent verification, protected checks, rollback plan, revocable policy |
| A5 Operate | Release/deploy/repair within a signed task class | Standing or one-shot effect permit, canary, immutable artifact, rollback, post-effect receipt |

The fleet can become operationally autonomous through A5 for well-defined, reversible classes under standing permits. Credentials, spending ceilings, customer-data classes, public commitments, protected policy, and irreversible business actions remain constitutional boundaries; changing those boundaries is distinct from executing inside them.

## GitHub organization

Keep these separate product repositories:

- `ashlr-hub` — fleet kernel and operator UI
- `phantom-secrets` — secret vault/broker
- `locus` — identity/session plane
- `ashlr-cortex` — company intelligence plane
- `wrkpad` — physical operator surface

Add a small `ashlr-protocol` repository/package when the first two cross-product contracts stabilize. It should contain language-neutral JSON Schemas, canonical fixtures, digest/canonicalization rules, generated TypeScript/Rust bindings, compatibility policy, and conformance tests. Do not vendor application source or use Git submodules.

Use an integration/meta repository only for:

- compatible component-version manifests;
- end-to-end contract tests across pinned revisions;
- architecture decisions and threat models;
- release/rollback evidence;
- fleet-wide scorecards.

Repository independence remains real: every product builds, tests, versions, and ships on its own. The compatibility matrix proves which released versions work together.

### Rationalize adjacent projects

- `ashlr-pulse`: optional remote/team observability; Hub owns the local operator view.
- `ashlr-plugin`: shared tool-efficiency surface for host agents and fleet workers.
- `ashlrcode`: standalone executor backend, not a second scheduler.
- `ashlr-workbench`: adapter/evaluation lab, not a competing command center.
- `ashlr-ao`: treat as a predecessor/candidate archive after unique-IP comparison with Hub.
- `ashlr-mux`: optional terminal surface feeding the same Hub session projection.
- `ashlr-stack`: infrastructure capability invoked through effect permits.

## Workspace lifecycle

The Desktop should contain one visible source folder per product. Agent workspaces belong under a managed runtime root, not beside the canonical checkout:

```text
~/.ashlr/worktrees/<repo-id>/<run-id>/
```

Every worktree receives a lease containing owner/session, base SHA, branch, creation/expiry, process identity, dirty state, and recovery policy. Garbage collection may remove only a clean expired tree with no live process. Dirty trees produce a named Git ref, binary patch, untracked archive, manifest, and checksums before removal.

This run applied that policy manually across Hub, Locus, and Cortex. Hub removed or relocated 257 redundant visible worktrees/clones and recovery-archived 22 dirty trees, reclaiming 39.46 GiB. Locus now has one canonical checkout at `/Users/masonwyatt/Desktop/github/dev-tools/locus`, with 49.544 GiB of clean worktrees removed after complete bundles and archive refs were verified. Cortex now has one canonical checkout at `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cortex`; its visible Desktop footprint fell by 27.61 GiB after dirty patches, untracked archives, bundles, and 52 archive refs were verified. The visible Desktop reduction is about **116.6 GiB**; recovery evidence remains intentionally retained under `~/.ashlr/recovery`.

## Operator experience

The Hub desktop should open to a topology, not a list of logs:

- six primary agent/account slots, matching wrkpad;
- per-slot model, account pool, current mission, headroom, sandbox, trust tier, and evidence freshness;
- dependency graph across repositories;
- exception-first attention queue: blocked, needs approval, degraded, failed, ready;
- one global kill switch plus scoped pause by mission, repo, provider, account, and effect class;
- replayable run timeline from intent → identity → tools → diff → tests → permit → outcome;
- capacity optimizer showing local/cloud/subscription utilization and accepted-change yield;
- no raw prompt content or credentials in default telemetry.

wrkpad is the tactile projection of this topology. Its fixed keys can select the six slots; its guarded controls can pause/resume/stop; everything else stays in the Hub UI.

## Fleet Digital Mission Range

Before increasing outward authority, build a deterministic range for the fleet:

- synthetic repositories, credentials, providers, customer data, and deployment targets;
- record/replay of agent sessions and signed decisions;
- fault injection for provider loss, partitions, quota exhaustion, storage pressure, stale identity, and conflicting worktrees;
- adversarial prompt injection, memory poisoning, malicious plugins, symlink escape, secret exfiltration, and audit tampering;
- counterfactual scheduling that compares model/team/policy choices against verified outcomes;
- shadow policy evaluation where the current policy enforces and candidate policy decisions are compared without effects.

Promotion follows one evidence ladder: simulation → recorded replay → read-only shadow → branch-only trial → supervised effect → bounded autonomous effect with rollback.

## Execution roadmap

### Now: stabilize the kernel

1. Complete `Execution Identity V1` in shadow mode with adversarial isolation tests.
2. Add the shadow Living End-State portfolio: falsifiable hypotheses, expiring resource envelopes, deterministic allocation, stop-loss, and evidence-qualified effectiveness.
3. Rebuild Hub from exact source and make source/dist/installed/runtime identity explicit.
4. Replace the contradictory local-model health signals with one canonical adapter status.
5. Add automatic leased-worktree placement and recovery-first garbage collection.

### Next: connect the planes

6. Implement a real authenticated Cortex `IntentEnvelopeV1` → Hub intake with idempotency and receipt return.
7. Replace copied Locus adapters with one versioned client/schema and conformance fixtures.
8. Move Hub's secret-reveal exception into a Locus-scoped worker using Phantom opaque leases/proxy injection.
9. Emit one provider-neutral fleet/session projection for Hub UI, wrkpad, Pulse, and mux.

### Then: turn autonomy on by evidence

10. Run two Codex account profiles, Claude SDK/API capacity, and local-model pools in shadow scheduling.
11. Compare predicted allocations with verified technical, product, and business outcomes; calibrate quality, impact, cost, latency, and information gain.
12. Graduate narrow task classes through branch, merge, canary, deploy, observe, and rollback under standing permits.
13. Stage the exact Hub release, install a pinned artifact, activate a resident service, and run canary/rollback acceptance as separate claims.

## Company-level metrics

The dashboard should optimize outcomes, not agent activity:

- receipt-qualified product and business value per million tokens;
- realized information gain and useful hypothesis kill rate;
- founder engineering hours genuinely saved;
- idea-to-retained-outcome cycle time and 30/90-day outcome survival;
- human interventions per accepted change;
- cost and subscription capacity per accepted change;
- local-model share of accepted work;
- rollback and escaped-defect rate;
- wrong-account actions: zero;
- credential exposure to model/log/config: zero;
- stale/abandoned visible worktrees: zero;
- percentage of business priorities with fresh engineering outcome receipts.

Verified proposals per day, accepted-change yield, and time to green proposal remain operational diagnostics. They must never outrank retained outcomes or become targets the fleet can game with low-value activity.

## Non-negotiable gates

- Credentials, auth homes, secret values, and tenant identifiers are never prompt context.
- A plugin is not a credential isolation boundary.
- Unknown/degraded capacity is unavailable, never a healthy zero or open slot.
- Provider usage limits and terms are respected; the fleet does not simulate interactive use to bypass billing or rate limits.
- Public release, production deploy, new spend, provider activation, customer data access, and irreversible external communication must be covered by a standing or one-shot permit; the fleet cannot infer authority from technical success.
- Source, tests, packaged artifact, installed artifact, resident service, production effect, and human acceptance remain separate claims.

## Definition of success

Ashlr succeeds when Mason can state or amend the company constitution and end state, then watch the fleet continuously choose the best features and experiments, spend expiring Codex/Claude/local capacity intelligently, build and test in parallel, kill weak hypotheses early, and progress from verified artifact to retained business outcome. The Hub and six-key board expose the topology and only high-value exceptions—without a credential entering model context, without routine human approval becoming the bottleneck, and without ambiguity about which account, repo, artifact, evidence, or standing authority produced an effect.
