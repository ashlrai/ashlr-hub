# Research grounding for Ashlr Universe

Primary sources checked on 2026-09-06. This is a focused design review of the supplied vision, covering evolutionary search, harness selection, evaluation, and coordination. The implementation choices below are Ashlr's synthesis; each study establishes results within its own experimental setting.

## Search over measured variants

[Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) evolves coding-agent implementations using frozen foundation models and a branching archive. Its reported improvements support retaining useful lineages, including stepping stones that initially score worse. The study evaluates coding benchmarks; it supplies a mechanism for self-improvement experiments rather than evidence of autonomous company operation.

[MAP-Elites](https://arxiv.org/abs/1504.04909) retains high-performing solutions across user-chosen behavioral dimensions. Universe applies this idea through measurable niches: specialized or inexpensive variants can remain useful alongside the highest-scoring variant. Niche labels become meaningful when they affect archive replacement and future selection.

[AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) combines model-generated programs, automated evaluators, and an evolutionary database. Its strongest demonstrated applications have objectively measurable algorithmic outcomes. Universe should begin with executable outcome checks, then separately validate any proposed proxy for customer or business value.

[ShinkaEvolve](https://arxiv.org/abs/2509.19349) adds novelty-aware sampling, code-novelty rejection, and adaptive selection among proposing models. The practical sequence is cheap duplicate and validity checks before expensive evaluation, with explicit exploration budget and recorded unsuccessful proposals.

## Evaluate model and harness together

[Niklaus's released coding experiments](https://huggingface.co/buckets/joelniklaus/CodingBenchmarkResults/tree/README.md) compare ten harnesses across two models on the same 250 held-out SWE-bench Pro tasks. Harness rankings differ substantially across models. Each combination has one rollout per task, and neighboring scores have overlapping uncertainty. Universe therefore records model, harness, task family, budget, and tool configuration together.

[Stop Comparing LLM Agents Without Disclosing the Harness](https://www.preprints.org/manuscript/202605.0711/v1) reports a controlled three-model, three-harness study. It is an unreviewed concept paper with a small task sample; its variance ratio is explicitly specific to that setting. The useful lesson is disclosure and controlled comparison, rather than treating a quoted ratio as a universal design law.

[Don't Train the Model, Evolve the Harness](https://joelniklaus-harness-optimization.hf.space/) optimizes a legal-work harness using a fixed development split and a separate held-out test split. Partial rubric improvement substantially exceeds whole-task completion improvement. The report also documents a faulty promotion caused by comparing scores calculated under different cost weights. Store raw outcomes, keep full success distinct from partial credit, and recalculate comparable scores for both candidates.

## Preserve the meaning of improvement

The [DGM paper](https://arxiv.org/html/2505.22954v1) records objective hacking when an evolved agent changes logging used by a proxy evaluator. Final observations should come from an independently controlled evaluator and remain linked to its version. Generated tests can grow a challenge corpus while a fixed held-out acceptance suite supports longitudinal comparison.

[Digital Red Queen](https://arxiv.org/abs/2601.03335) studies adaptation against an accumulating set of opponents in the Core War simulation and evaluates generalization against held-out opponents. Its evidence supports retaining historical challenges and testing transfer. It does not establish that a candidate can replace its own acceptance standard and still produce a meaningful improvement claim.

## Match coordination to the work

[OrgAgent](https://arxiv.org/abs/2604.01020) compares company-style hierarchies on reasoning and question-answering benchmarks. Its compliance layer concerns final-answer structure. Treat hierarchy as a configurable execution strategy to measure, with explicit artifact ownership for dependent software work.

[ArcticSwarm](https://arxiv.org/abs/2609.01870), a September 2026 preprint, separates evidence gathering from integration and reports gains from restricting early peer reads. This supports independent research branches followed by structured review. Its results concern information-search tasks, so transfer to code integration requires a separate experiment.

[IMACS](https://arxiv.org/abs/2607.25446) separates team composition, coordination, and collaboration protocols, then learns protocol choice under quality/cost tradeoffs. Universe can represent these as distinct candidate parameters and assess them for each model binding.

## Measure workflows and memory

[TheAgentCompany](https://github.com/TheAgentCompany/TheAgentCompany) provides a reproducible simulated workplace with task initialization, resulting-state evaluation, and subordinate checkpoints. Universe can use that pattern to judge whether a workflow produced its intended artifact or application state. Historical baseline results describe their evaluated models and should remain dated.

[TaskWeave](https://arxiv.org/abs/2606.01199) studies a simulated year of organizational activity with hierarchical plans and dependency-aware trace memory. Its authors identify the setting as a simplified abstraction. Preserve intention, delegated work, and observed results separately; test real delivery independently from organizational simulation.

[M★](https://arxiv.org/abs/2604.11811) evolves executable memory schemas, storage/retrieval logic, and instructions while holding the task agent fixed. This supports task-specific memory experiments. A versioned memory policy with trace replay is a useful first integration before general code evolution.

## Implementation priorities

- Make every candidate and evaluator addressable by immutable identity.
- Separate raw execution observations from derived scores and agent claims.
- Preserve task splits, objective versions, resource limits, and failure outcomes.
- Retain useful niche elites and demonstrate that later selection uses them.
- Benchmark the deployed model/harness combination on the intended workflow.
- Expand from local experiments to products using independently observable outcomes.

The [Universe architecture](ASHLR-UNIVERSE.md) translates these findings into the local kernel and subsequent integrations. Social-media anecdotes and unverified adoption statistics are inspiration, not acceptance criteria.
