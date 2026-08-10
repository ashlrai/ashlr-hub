# Elite agent efficiency roadmap

Evidence review: 2026-08-09

This roadmap translates current primary-source guidance into concrete Ashlr Hub
work. It is deliberately split into three categories:

- **Shipped** means the behavior exists in this repository and has regression
  coverage.
- **Source evidence** summarizes what an official source reports.
- **Ashlr inference** is our proposed implementation direction. It is not a
  claim made by the source and grants no runtime authority.

## Current safety and efficiency floor

The following behavior is shipped in the Mission OS V1.1 source:

- Best-of-N accepts at most eight candidates, fails malformed counts closed to
  one, and runs candidate and critic work through an order-preserving two-worker
  pool. One daemon slot cannot expand into an unbounded `Promise.all` fan-out.
- Mission observations can be captured in bounded, immutable,
  host-authenticated receipts. `ashlr vision shadow` emits at most one
  zero-effect suggestion and cannot create goals, agents, proposals, merges,
  releases, deployments, publications, or external mutations.
- Mission, Cortex-candidate, and Locus-evidence schemas are bounded and exact.
  Future ecosystem evidence cannot become realization evidence without exact
  digest, identity, tenant, session, provider, tool, argument, and effect-class
  bindings.

The fleet is not yet entitled to call its scheduler economically atomic. A
candidate cap limits blast radius, but concurrent dispatch still needs durable
pre-launch budget and capability reservations.

## What current primary sources support

### Durable work needs explicit continuity artifacts

**Source evidence.** Anthropic's long-running agent harness combines an
initializer, incremental sessions, a progress file, Git history, and a clean
handoff state; it reports that context compaction alone was insufficient.
OpenAI's Codex loop similarly describes structured conversation items,
automatic compaction, and stable instructions across context windows.

- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [OpenAI: Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)

**Ashlr inference.** Add a bounded `RunContinuationCheckpointV1` at stable task
transitions and before compaction or session exit. Bind run, attempt, work item,
repository, base/head/diff, task-DAG position, last verified-green receipt,
failed approaches, context-pack digest, committed spend, and outstanding
reservations. Resume only after revalidating repository identity, HEAD,
worktree, policy, and checkpoint authentication.

Candidate modules:

- `src/core/run/agent-loop.ts`
- `src/core/run/orchestrator.ts`
- `src/core/run/local-context.ts`
- `src/core/fleet/context-rollup.ts`
- `src/core/fleet/agent-action-ledger.ts`

### Context should be small, stable, and retrieved just in time

**Source evidence.** Anthropic recommends high-signal context, non-overlapping
tools, and targeted retrieval. OpenAI's current model guidance reports
directional gains from lean prompts and warns that changing earlier messages or
tool order can defeat prompt caching.

- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [OpenAI: Latest model guidance](https://developers.openai.com/api/docs/guides/latest-model)

**Ashlr inference.** Introduce content-addressed `ContextPackV1` records with a
stable sorted prefix for policy, repository instructions, tool schemas, and
invariants; a dynamic task tail; just-in-time file/log/memory references; exact
token counts; and provider/model/policy/memory epochs. Cache metrics must join
verified outcomes, not optimize hit rate in isolation.

Candidate modules:

- `src/core/run/local-context.ts`
- `src/core/run/prompts/budget.ts`
- `src/core/fleet/context-efficiency.ts`
- `src/core/observability/usage-source.ts`
- `src/core/observability/rollup.ts`

### Multi-agent execution is valuable only for genuinely independent work

**Source evidence.** Anthropic reports a large gain on a breadth-first research
evaluation, alongside roughly 15 times chat token use, and cautions that coding
tasks often have fewer independent lanes. Its parallel compiler experiment is
explicitly an early research prototype with substantial cost.

- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Anthropic: Building a C compiler with parallel agents](https://www.anthropic.com/engineering/building-c-compiler)

**Ashlr inference.** Fan out only when mission dependencies and declared
read/write footprints prove independence. Every coding lane must have an
isolated worktree, renewable lease, bounded child allowance, and budget
reservation before spawn. Shared-file or dependent lanes serialize. Reducers
consume durable artifact and verification references, not lossy prose.

Candidate modules:

- `src/core/fabric/concurrent-dispatch.ts`
- `src/core/fleet/lane-lock.ts`
- `src/core/util/execution-lease.ts`
- `src/core/fleet/dispatch-manifest.ts`
- `src/core/vision/mission-graph.ts`

### Trace evidence and end-state evidence are different

**Source evidence.** OpenAI's Agents SDK tracing model represents model calls,
tool calls, handoffs, guardrails, and custom spans, with sensitive payload
capture controlled separately. Anthropic's evaluation guidance distinguishes a
complete trajectory from the resulting environment state and recommends
capability and regression suites, repeated trials, `pass@k`, `pass^k`, and
transcript inspection.

- [OpenAI Agents SDK: Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

**Ashlr inference.** Give every attempt a trace ID and hierarchical metadata-only
spans. Store digests, sizes, timing, status, policy decisions, token/cache/cost
data, and parent links by default. Raw prompts, outputs, patches, and tool
payloads require a separate explicit, scrubbed, bounded diagnostic mode.
Incomplete trace sources remain diagnostic and never become learning or merge
authority.

### Coding benchmark hygiene is a release concern

**Source evidence.** SWE-Lancer uses economically valued real tasks and
end-to-end tests. OpenAI no longer recommends SWE-bench Verified because of
contamination and broken tests, and its 2026 audit reports material task-health
problems in newer benchmark sets as well.

- [OpenAI: SWE-Lancer](https://openai.com/index/swe-lancer/)
- [OpenAI: Why we no longer evaluate SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- [OpenAI: Separating signal from noise in coding evaluations](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)

**Ashlr inference.** Public benchmark scores are observational comparisons, not
release authority. Build versioned internal capability and regression banks
that bind environment image, harness, hidden fail-to-pass tests, pass-to-pass
regressions, reference solution, platform, and task-health review. Report
`pass@1`, `pass^k`, cost, latency, proposal yield, and post-merge stability.

### Candidate evolution works best with objective evaluators

**Source evidence.** Google DeepMind's AlphaEvolve combines cheap-model breadth,
frontier-model depth, a persistent candidate database, and automated execution
and scoring. Its strongest evidence is in objectively measurable domains.

- [Google DeepMind: AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)

**Ashlr inference.** Use evaluator-guided evolution only where deterministic
tests or measurements define success. Preserve lineage and failed approaches;
spend frontier depth on promising or unresolved candidates; never let an
evaluator score authorize merge or substitute for product judgment.

### Safe autonomy separates reasoning from effects

**Source evidence.** GitHub Agentic Workflows are read-only by default, permit
writes through declared validated outputs, isolate secrets from the agent
runtime, and use firewalled execution.

- [GitHub: About Agentic Workflows](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows)

**Ashlr inference.** Preserve Hub's proposal-first design. Model reasoning may
recommend; typed validators, immutable receipts, leases, and existing gates own
effects. Mission evidence never grants proposal, merge, release, deployment,
publication, provider, credential, policy, budget, or business-outcome
authority.

## Execution roadmap

### P0: economic and capability safety

1. Add a crash-recoverable two-phase reservation ledger: prepare conservative
   token, dollar, backend-slot, tool-slot, and child-agent bounds before launch;
   then commit actual usage and release unused capacity.
2. Make reservations hierarchical: fleet to attempt to agent to call. A child
   cannot outspend or out-spawn its parent.
3. Replace arbitrary saturated-backend fallback with a typed ordered eligible
   set and minimum capability. If no eligible backend has capacity, queue.
4. Add the authenticated continuation checkpoint and refuse resume on repository,
   worktree, policy, or digest mismatch.

Graduation gates:

- zero launches without a durable reservation in concurrency and crash tests;
- aggregate prepared exposure never exceeds configured fleet limits;
- no ordinary or repair item executes below its required capability;
- restart replay cannot double-spend or duplicate a child launch;
- degraded reservation, source, or checkpoint state always queues or holds.

### P1: evidence, evals, and context efficiency

1. Unify privacy-safe hierarchical traces with proposal, authenticated merge,
   regression, revert, cost, and latency outcomes.
2. Build versioned internal capability and regression banks with task-health
   review and repeated-trial metrics.
3. Introduce deterministic context packs and exact cache accounting.
4. Route in shadow on task-conditioned expected cost-to-authenticated-green,
   including retries, verification, repair, judging, fan-out, and uncertainty.

Graduation gates:

- trace and outcome sources are healthy and complete for the evaluation cohort;
- regression tasks remain near-perfect across supported platforms;
- context changes reduce median tokens or latency without reducing verified
  success or increasing post-merge regressions;
- router promotions have a sample floor, confidence bound, and zero capability
  or authority divergence in shadow.

### P2: measured multi-agent autonomy

1. Schedule only dependency-independent, footprint-compatible work behind
   renewable leases and parent budget reservations.
2. Persist reducer inputs as immutable artifact references and verification
   receipts.
3. Use evaluator-guided candidate evolution only for objectively scored work.
4. Compare automatic mission suggestions with explicit operator decisions before
   permitting any one-goal planning mutation mode.

Graduation gates:

- multi-agent work beats the single-agent baseline on verified cost-to-green,
  wall time, and `pass^k`, not just throughput;
- no overlapping write footprint, duplicate proposal, lease split-brain, or
  budget oversubscription in adversarial tests;
- automatic planning has a minimum independent sample floor, zero false-ready
  cases, complete source evidence, and a crash-safe CLI/daemon lease;
- dispatch, merge, release, and deployment remain separately authorized.

## Recommended build order

1. Two-phase hierarchical reservation ledger.
2. Durable continuation checkpoint and repository revalidation.
3. Trace spine and complete outcome linkage.
4. Internal eval-bank hygiene and bounded verification-to-green.
5. Stable context packs and cache return-on-investment metrics.
6. Shadow task-conditioned routing.
7. Lease-backed dependency-aware multi-agent scheduling.
8. Evaluator-guided candidate evolution.

This order measures and economically bounds autonomy before increasing its
concurrency or authority.
