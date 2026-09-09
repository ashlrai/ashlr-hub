# Ashlr Universe autonomy engineering

## Engineering objective

Ashlr Universe should turn a declared engineering objective and available compute into a continuing sequence of useful, verified improvements. The differentiator is not an unusually busy agent dashboard. It is an operating loop that chooses worthwhile work, executes it, establishes what changed, preserves useful discoveries, and improves its own methods without losing operational control.

The primary objective is **verified engineering yield: useful accepted changes per token and elapsed hour**. This brief translates research into an architecture and acceptance sequence for that objective. Research findings, maintainer guidance, current source behavior, and proposed work are deliberately separated. It is a selected engineering synthesis, not an exhaustive survey or a claim to validate every assertion made about autonomous agents.

The broader vision of an autonomous engineering organization is a product ambition. Analogies to exceptional founders, forecasts of rapidly improving models, and social claims about unprecedented productivity are not acceptance evidence. The architecture should accommodate much stronger models while remaining useful with the models and integrations that can actually complete measured work today.

## Research findings and their boundaries

### Empirical agent improvement

**Darwin Gödel Machine.** DGM evolves coding-agent implementations around frozen foundation models, maintaining an archive of variants rather than only the newest candidate. Its experiments run 80 iterations with staged evaluations. The reported SWE-bench improvement from 20% to 50% concerns the study's 200-task subset; full Polyglot performance improves from 14.2% to 30.7%. The authors estimate roughly two weeks and $22,000 for a SWE-bench run. Archive maintenance and parent selection remain fixed, and continued gains from longer execution are an open question. Sandboxing, time limits, and monitoring were part of the experiments. These results support empirical harness improvement, not unlimited growth or autonomous company operation. [DGM methods and limitations](https://arxiv.org/html/2505.22954v1).[^1]

**HyperAgents.** DGM-H makes both the task agent and its modification mechanism editable. Evaluation spans coding, paper review, simulated robotics reward design, and math grading, with five runs, bootstrap confidence intervals, and held-out evaluation. The main experiments still use fixed parent selection, evaluation protocols, and task distributions. Appendix E.5 reports that automatically modified parent selection did not outperform the handcrafted comparator despite greater sophistication. Its theoretical ability to express any computable task is not evidence of reliable performance on every task. [HyperAgents methods, limitations, and selection experiments](https://arxiv.org/html/2603.19461v1).[^2]

**AlphaEvolve.** Google DeepMind describes a system combining model-generated programs, automated evaluation, and evolutionary selection. Its reported applications include production data-center scheduling improvements and verified computational optimizations. The report says one scheduling heuristic recovers an average 0.7% of Google's worldwide compute resources. These are provider-reported results in particular environments, not independent evidence that the same gains transfer to a desktop engineering fleet. The useful pattern is a measurable objective with an evaluator capable of distinguishing improvement from plausible-looking code. [AlphaEvolve announcement](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/).[^3]

### Durable execution and evaluation guidance

**Temporal** separates deterministic workflow logic from failure-prone activities such as API and model calls. Its documentation recommends targeted activity retries rather than repeating an entire failed workflow, and supports total retry-duration limits and non-retryable errors. Default activity retries can be unlimited; a framework default is therefore not a desktop resource policy. [Temporal retry policies](https://docs.temporal.io/encyclopedia/retry-policies).[^4]

**LangGraph** persists graph checkpoints and successful sibling-task writes, but replay from an earlier checkpoint re-executes later nodes, including API and model requests. Its documented persistence modes trade performance against crash durability. Separately, its fault-tolerance interface distinguishes hard run timeouts from idle timeouts: tokens, callbacks, or child scheduling can refresh an idle clock without demonstrating useful output. These are maintainer-described semantics, not guarantees for an untested integration. [Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers), [fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance).[^5][^6]

**Anthropic's evaluation guidance** distinguishes the agent transcript from the resulting environment state, separates capability evaluation from regression protection, and contrasts at-least-one-success metrics with repeated all-success reliability. Its multi-agent research report describes a 90.2% internal research-evaluation improvement over a single-agent configuration, alongside approximately 15 times chat token usage. It also notes that tightly dependent coding work is less naturally parallel than broad research. These observations support selective delegation, not a universal relationship between agent count and engineering value. [Agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).[^7][^8]

**METR's productivity follow-up** explains why its newer data is an unreliable estimate of current AI speedup: developer and task selection changed, and concurrent agents made task-time reporting difficult. The follow-up includes 57 developers, 143 repositories, and over 800 tasks. The authors consider increased speedup plausible but characterize evidence for its magnitude as weak. Neither historical slowdown nor enthusiastic self-report should substitute for measurement in the actual engineering environment. [Productivity experiment update](https://metr.org/blog/2026-02-24-uplift-update/).[^9]

## Current source foundation

The following describes implemented source behavior, not a release or live-commissioning claim. The canonical operational contracts remain [Ashlr Universe](ASHLR-UNIVERSE.md) and [resource pools](RESOURCE-POOLS.md).

The Universe runner (`src/core/universe/runner.ts` in the source checkout) performs bounded candidate generation and fixed evaluation. It freezes candidate artifacts before scoring and checks comparator identity. Its new generation diagnostics distinguish not-started, withheld, unresolved, timed-out, and failed generation without converting these into measured code rejection. Evaluation failures likewise have fixed phase diagnostics. A failed generation can inform a later attempt while leaving an already accepted elite intact. The feedback implementation (`src/core/universe/feedback.ts`) binds shared feedback to recorded provenance rather than treating arbitrary private error output as model instructions.

The metadata lease (`src/core/resources/quota-refresh-lease.ts`) records lifecycle evidence and classifies why recovery cannot proceed. The resource console (`src/core/web/resource-console-server.ts`) projects a bounded acquisition-time diagnosis containing a reason and marker version. This is not a continuously refreshed process inspection, provider health observation, or permission to remove a pending record. Registered-group recovery, incomplete registration, missing legacy evidence, and uncertain cleanup remain materially different states.

Focused source-checkout tests exercise generation diagnostics (`test/universe-generation-diagnostics.test.ts`) and collector diagnostics (`test/resource-collector-diagnostics.test.ts`) with inert transports or private fixtures. Such tests establish the exercised behavior only. This brief does not establish a current deployed SHA, active account connection, successful provider-backed campaign, or production acceptance; those require separate runtime receipts. Source and test files are not included in the installed package.

## A bounded campaign as the autonomy unit

**Proposed architecture.** The useful autonomy unit is a campaign with an objective, scope, resource envelope, evaluation contract, and durable outcome. A campaign may keep improving after the first passing artifact. Its bounds define which resources and systems belong to the work, not how clever the model may be inside that scope.

The campaign should distinguish discovery, implementation, evaluation, integration, and operational observation. These phases may overlap when dependencies permit, but each has an explicit artifact contract. A discovery agent can change its hypothesis; it cannot retroactively relabel an unsuccessful implementation as an accepted product improvement. A verifier can reject a candidate without destroying the evidence that makes its failure useful.

Persistence must retain the campaign's original resource allowance and deadline across restart. Launching a new process is not a new grant of tokens. The executor needs enough remaining capacity to evaluate an attempted change, preserve its result, and stop cleanly. Admission should therefore reserve completion overhead rather than spend the final available budget on another speculative generation.

Recovery needs separate evidence for intent, launch, settlement, and outcome. A missing worker is not proof that an external operation had no effect. Conversely, a lost observer should not invalidate an already verified artifact. Recovery should resume eligible unfinished work or preserve ambiguity explicitly; it should neither replay everything nor permanently abandon every interrupted campaign.

## Verified engineering yield

**Proposed measurement contract.** Count a useful accepted change only when it has a unique artifact identity, satisfies declared acceptance criteria, introduces the intended behavior or measurable improvement, and preserves required regressions. Deduplicate equivalent artifacts and repeated evaluation of the same result. A passing unchanged candidate contributes zero new engineering yield, even when its execution was perfectly healthy.

Acceptance needs provenance: objective version, source revision, artifact digest, evaluator version, environment identity, trial receipt, and integration result where relevant. If a later regression reverses acceptance, retain the original event and record the reversal. This supports gross accepted yield, retained yield, and rework cost without rewriting history.

The denominator must include unsuccessful work. Excluding failed generations, discarded experiments, repeated evaluation, or integration cleanup makes an inefficient fleet appear productive. Unknown token usage must remain unknown; it cannot silently become zero. Report coverage alongside any ratio so incomplete accounting cannot win a routing comparison.

| Measure | Definition and interpretation |
| --- | --- |
| Accepted changes per million tokens | Unique accepted changes divided by attributable input and output tokens; unavailable when coverage is insufficient |
| Accepted changes per elapsed hour | Throughput over campaign wall time, including waiting and recovery |
| Agent-hours | Summed worker execution time; exposes parallel resource consumption independently of wall time |
| Human intervention minutes | Active correction or decision time, distinct from unattended waiting |
| No-op pass rate | Passing evaluations with no accepted new improvement |
| Retained acceptance | Accepted changes that remain valid after a declared observation interval |
| Recovery overhead | Time and resources consumed reconciling interrupted work |

These dimensions should remain visible rather than disappear inside one opaque score. Product-value weights can supplement them, but their definition and revision belong in the objective record. A tiny performance optimization and a revenue-critical feature are not interchangeable simply because both produce one commit.

For example, compare two hypothetical campaigns solving the same declared task set. One produces six retained improvements with substantial failed-generation overhead; the other produces four using fewer tokens and less human correction. Neither dominates on every dimension. The scheduler should express the chosen tradeoff explicitly, including uncertainty, rather than award victory to whichever generated more files.

## Resource allocation across accounts and local models

**Required policy behavior.** Support two separately identified Codex account bindings without assuming that changing a browser or desktop login establishes concurrent CLI availability. Keep the personal account paused for fleet work when reserved for interactive use. A configured 75% fleet ceiling must remain effective; an explicit change to 100% is a separate policy revision. These are required operating policies, not claims about the current live connection state.

Quota windows are not fungible token wallets. Admission must respect the relevant short and long windows, freshness, reservations, concurrency, and account identity. A daily or weekly allowance cannot be inferred from a generic “connected” badge. Authentication failure, missing telemetry, policy pause, and temporary contention should have different explanations and different next steps.

Do not automate desktop account switching as a substitute for a supported isolated binding. Do not assume a consumer subscription includes an API or programmatic execution entitlement. Claude, Grok, and future providers should expose capabilities explicitly: supported transport, identity evidence, usage evidence, cancellation semantics, and allowed execution mode. Missing capabilities remain visible rather than being emulated through undocumented credential handling.

Local models should compete on measured task cohorts. A useful benchmark records exact model artifact and quantization, runtime version, hardware, memory pressure, context size, structured-output correctness, task acceptance, latency, and resource consumption. Separate warm from cold performance. Local availability does not establish reasoning quality, and larger downloads do not establish higher engineering yield.

Start by assigning a candidate local model one narrow, independently scored role. Expand its workload only after it demonstrates comparable quality at a favorable cost or latency. Retain a fallback route, but do not let fallback hide the original failure or consume an unapproved account. Account allocation and capability routing should be explainable separately.

## Graphs as executable evidence

**Proposed architecture.** Use related graphs with distinct semantics rather than one untyped universe of nodes. The work graph tracks dependencies and ownership. The artifact graph tracks immutable inputs and outputs. The experiment graph tracks candidate lineage and comparisons. The operational graph tracks workers, accounts, reservations, and observed health.

An edge should explain what it carries: a specification, source snapshot, candidate artifact, evaluation receipt, resource reservation, or release identity. This makes graph engineering materially useful. When a shared component changes, the system can find affected evaluators and downstream consumers instead of relying on an agent to remember an earlier conversation.

The control room should answer five questions immediately: what is being attempted, why it was selected, what it costs, what evidence exists, and what can happen next. Selecting a node should reveal its current artifact, objective version, remaining budget, last heartbeat, latest meaningful result, and recovery classification. Textual states must accompany color and animation.

Human interjection should operate on the same durable contracts as agent actions. Pausing new admission should not erase running work. Reprioritization should affect pending scope without silently rewriting completed acceptance. A changed objective should create a new version and make incompatible comparisons visible. The UI should show the expected effect of an intervention before applying it.

## Measured harness adaptation

**Proposed architecture.** Treat prompts, tool descriptions, context assembly, planning strategies, and model routing as versioned candidate components. Agents may propose modifications to these components and explain the observed failure they address. Improvements must be compared on stable task cohorts, not merely demonstrated on the failure example used to invent them.

A cohort identity should include the model, harness, tool contract, task distribution, evaluator, execution environment, and resource envelope. Otherwise an apparent prompt improvement might actually reflect a faster machine, a newer model, or easier tasks. Comparisons should include both representative work and difficult regressions, with repeated trials where stochastic variation could alter the decision.

Preserve separate development, validation, and held-out acceptance roles. Adaptive evaluation is valuable, but changing the evaluator creates a new comparison context. An agent may recommend a better test or rubric; that proposal must not erase previous failures or retroactively approve its own candidate. The acceptance mechanism can evolve through its own measured change process.

Keep research hypotheses distinct from established facts in persistent memory. “The previous prompt caused overcorrection” is a hypothesis until a comparison supports it. Attach source receipts, confidence, contradictory observations, and supersession links. This prevents polished explanations from hardening into routing rules merely because they were repeated across generations.

Parallelism should follow dependency structure. Independent exploration and cold-start verification are strong candidates for fan-out. Conflicting edits require ownership and integration sequencing. A campaign should record the marginal value of extra workers, including duplicate work and merge overhead. Agent count is an experimental parameter, not a success metric.

## Three-stage acceptance roadmap

### Stage 1: repeatable single-computer campaigns

Commission one explicit objective with known account bindings or an evaluated local model. Demonstrate generation, independent evaluation, artifact retention, and continued improvement within the original envelope. Verify that paused workers are never selected and that unavailable quota evidence cannot manufacture capacity.

Inject interruption before launch registration, during execution, after process exit, and before outcome persistence. Acceptance requires preserved budgets, no duplicate execution where outcome is ambiguous, intact accepted artifacts, and a clear next action. Collect a repeatable campaign receipt rather than declaring success from a dashboard screenshot. Run validation locally; this stage does not depend on GitHub Actions.

### Stage 2: autonomous integration within declared repositories

Add dependency-aware work planning and delivery into explicit integration targets. Each task must identify affected contracts and the checks needed before integration. Conflicts, invalidated baselines, and changed requirements should return work to planning with preserved evidence, not trigger uncontrolled rewriting of unrelated repositories.

Acceptance requires a complete chain from objective through implemented behavior to integrated artifact, plus rollback rehearsal and downstream regression coverage. Operational observation should distinguish released, reachable, healthy, and accepted. Public publication or production mutation must use the configured release authority and target-specific receipt; a successful local build is not production truth.

### Stage 3: evidence-driven self-improvement and portfolio allocation

Permit bounded experiments on harness behavior and resource routing, then compare them with the established cohort. Promote only changes that satisfy declared quality and reliability conditions. Retain the incumbent and rollback identity. A model upgrade should enter the same evaluation process rather than inherit trust from a product name.

Extend prioritization from individual tasks to product outcomes only when outcome observations are available and attributable. The fleet may propose new experiments, features, or cost-reduction work; each proposal needs a measurable hypothesis and the cheapest credible acceptance path. This expands ambition without substituting activity for value.

The end state is not a system with no boundaries. It is a system whose routine work requires little intervention because its objectives, resources, evidence, and recovery behavior are dependable. Stronger models should expand the class of work it can complete; they should not require abandoning the measurement infrastructure that makes those gains observable.

## Sources

[^1]: Jenny Zhang et al. [Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents](https://arxiv.org/html/2505.22954v1). May 29, 2025, v1. Methods, benchmark subsets, cost estimate, and limitations.
[^2]: Jenny Zhang et al. [HyperAgents](https://arxiv.org/html/2603.19461v1). arXiv v1 header March 19, 2026; rendered manuscript also displays August 24, 2026. Methods, held-out evaluation, limitations, and Appendix E.5.
[^3]: Google DeepMind, AlphaEvolve team. [AlphaEvolve: A Gemini-powered coding agent for designing advanced algorithms](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/). May 14, 2025. Provider-reported architecture and applications.
[^4]: Temporal. [What is a Temporal Retry Policy?](https://docs.temporal.io/encyclopedia/retry-policies). Living documentation; retrieved September 8, 2026. Retry scope, defaults, time bounds, and failure classes.
[^5]: LangChain. [Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers). Living documentation; retrieved September 8, 2026. Persistence, replay, and durability modes.
[^6]: LangChain. [Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance). Living documentation; retrieved September 8, 2026. Retry policies and run/idle timeout semantics.
[^7]: Anthropic. [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). January 9, 2026. Outcome measurement, grading, and repeated reliability.
[^8]: Anthropic. [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system). June 13, 2025. Internal research results, token costs, and delegation experience.
[^9]: Joel Becker et al., METR. [We are Changing our Developer Productivity Experiment Design](https://metr.org/blog/2026-02-24-uplift-update/). February 24, 2026. Productivity measurement limitations and concurrent-agent attribution.
