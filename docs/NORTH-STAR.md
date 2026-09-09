<a id="ashlr-universe--north-star"></a>

# Ashlrverse — North Star

> Build for a factory whose models become ten times more capable. The objective
> should become more ambitious without replacing the factory.

> **Aspirational design context — not current runtime activation guidance.**
> This document defines the target state. The local Universe experiment kernel
> executes and measures bounded code experiments; it is not a resident engineering
> firm. Current compiled daemon and conductor trust roots remain empty.

## Vision

**Build Ashlrverse into an agent-native operating system for engineers and builders: a self-improving engineering fleet optimizing verified engineering yield—useful accepted changes per token and hour.**

Give it an idea, a starting portfolio, resources, and the scope of work it may
undertake. It should discover worthwhile opportunities, design experiments,
build competing approaches, test real artifacts, judge outcomes, and invest its
next unit of effort using what it learned. Its product vision can evolve from
evidence rather than freezing into a backlog of the first ideas it generated.

The ambition is continuous invention, not only code maintenance. The fleet should
challenge its own plans, discover better features and methods, and carry useful
work through integration and operation. It should improve its harnesses and
coordination through the same evidence-led process it applies to products.

Hub is the local execution and observation kernel. Ashlrverse is the wider
product vision: continuing search, resource allocation, and organizational
learning above it. Universe remains the name of the existing experiment runtime
and its compatibility interfaces. Subscription
capacity, cloud models, and local compute are resources to allocate according to
measured usefulness and provider limits. More tokens spent is not itself progress.
Preserve operator reserves and compare outcomes before spending more; idle
capacity is useful only when the next task can produce value.

## Three pillars (in order of ambition)

1. **Recursive self-improvement.** Experiment on harnesses, tools, memory, model selection, and coordination using independent, comparable evidence.
   Keep diverse useful variants and retain their ancestry. A candidate may improve
   the evaluator, but cannot rewrite the acceptance evidence used to select itself.

2. **Ecosystem product factory.** Turn real engineering work into useful, tested, shipped products with users.
   Ideation, implementation, integration, operation, and learning belong in the
   same loop. Evaluate product outcomes, not only code quantity or benchmark wins.

3. **The composition platform.** Independently valuable projects become stronger through shared interfaces and evidence.
   Hub, Cortex, Phantom, Locus, Plugin, Stack, and Core Efficiency retain their own
   repositories and identities. The desktop console and physical agent board are
   views and controls for the same system, not separate sources of truth.

## The engineer

Sets intent and delegates scope and resources. Routine decisions and effectiveness
assessment should run automatically from observable evidence. Bring the engineer
decisions that require new direction or authority, not every implementation step.
An operator can inspect, interrupt, redirect, and reproduce the system's work.
Autonomy should expand through demonstrated reliability and delegated scope,
without making the human approve every routine step or treating an agent's
confidence as independent proof of success.

## How we measure "grand" (not vanity)

- **Verified engineering yield:** useful accepted changes per measured token and hour.
- **Products shipped + adopted:** real features, releases, reliability, and users.
- **Capabilities invented:** useful net-new functionality, not just maintenance.
- **Compounding capability:** compare current and prior systems on the same tasks.
- **Measurement integrity:** unknown tokens remain unknown; local test scores are
  not customer acceptance, revenue, or deployment proof. Preserve raw dimensions.

## Near-term ambitious bets (vs internal plumbing)

- Run competing implementations, retain per-niche winners, and use them as the next generation's parents.
- Connect measured experiments to a real ecosystem product's local acceptance suite.
- Allocate frontier and local model work using observed quality and resource use.
- Learn from accepted and rejected changes, operational behavior, and user feedback.

## From parallel agents to an integrated engineering loop

The target is an objective-to-candidate loop, not a larger collection of agents:
an approved objective, explicitly enrolled repositories and a resource envelope
produce independently verified improvements on retained local candidate branches.
The engineer can delegate routine decomposition, implementation, testing and
effectiveness assessment within that envelope. New product direction and new
external authority remain explicit decisions.

Model roles are configurable starting hypotheses, not account identities or
guarantees of capability:

| Role | Initial model assignment | Evidence required from the role |
| --- | --- | --- |
| Design and challenge | Astra | Alternatives, a dependency graph, scoped interfaces, acceptance criteria and reasons to reject the plan. |
| Integrate and implement | Terra | Composable changes and a freshly tested combined candidate, not only independently passing branches. |
| Bounded implementation and test repair | Luna | Narrow changes, reproducible checks and a finite retry budget before escalation. |

Route these roles through enrolled workers; preserve account exclusions, shared
capacity and operator reserves before considering model preference. An account
used by the engineer can remain unavailable to the unattended fleet, including
all aliases of that capacity. Percentage allocation is an admission policy, not
a guarantee that already-running work cannot cross a usage threshold.

### Three implementation milestones

These are planned capabilities, not activation instructions. The current
[portfolio runtime](ASHLR-UNIVERSE.md#coordinate-campaigns-with-a-dependency-graph)
orders campaigns and can require local branch delivery. Explicit integration
handoff can now seed a new downstream experiment. A separate
[checkpointed portfolio controller](ASHLR-UNIVERSE.md#restart-a-checkpointed-portfolio)
preserves campaign dispatch history and one deadline across invocations; it does
not yet schedule integration handoff automatically.

The first milestone now has four executable local primitives:
[checked composition planning](ASHLR-UNIVERSE.md#inspect-a-combined-delivery-plan)
and [fresh combined evaluation](ASHLR-UNIVERSE.md#evaluate-a-pinned-combined-candidate),
followed by [explicit new-branch delivery](ASHLR-UNIVERSE.md#inspect-and-deliver-an-evaluated-combination)
and [downstream experiment registration](ASHLR-UNIVERSE.md#hand-a-combined-commit-to-a-new-experiment).
Evaluation retains the combined artifact and fixed-suite measurements without
rerunning a settled request. Delivery pins that passing outcome and preserves
existing branches. Handoff records the verified source lineage with a new
manifest and fresh comparator, without inheriting scores or starting work.
Automatic branch advancement, portfolio-triggered handoff, and recovery of
partially initialized seeds remain unfinished; existing manifests are not
silently rewritten.

**Later: automatic branch advancement.** This is a planned extension, not enabled
by new-branch delivery. An advancement request must name the expected current
commit and delegated target branch. A changed base requires newly evaluated
combined evidence; prior passing evidence cannot stand in for that check.
Use an atomic compare-and-swap update, retain durable intent and completion,
and reconcile interruption before another update. Preserve unexpected human
changes instead of overwriting them, and keep local advancement separate from
remote push or deployment authority.

1. **Accept the combined product.** Define a one-repository integration contract
   with pinned upstream delivery commits/trees, base revision, permitted paths,
   fixed acceptance suite and target candidate branch. One integration owner
   composes changes in an isolated worktree and tests the combined tree. A new
   dependent manifest pins the accepted result; existing manifests stay immutable.
   Acceptance: both upstream changes are present, jointly failing or conflicting
   changes never advance the candidate ref, changed input evidence is rejected,
   and replay of settled integration does not duplicate work.
2. **Continue reliably across interruption.** Persist invocation identity,
   pending transitions, fenced ownership, next observation time and remaining
   aggregate allowance above existing campaign and resource ledgers. Retry clean
   capacity withholding within the authorized budget; retain uncertain work and
   owner pauses. Acceptance: crash injection before dispatch, after reservation,
   after settlement and during delivery causes no duplicate dispatch or ref
   advancement. Restart preserves budgets; cancellation drains owned work. Start
   with a restartable foreground command before commissioning a resident service.
   The checkpointed campaign DAG is the first implemented slice: recorded
   completions can release dependants, untouched branches can continue on
   restart, and completed calls with a lost controller receipt can be reconciled
   using their unique campaign start/settlement identity and exact history.
   Planned delivery must already be verified; recovery neither repeats workers
   nor creates missing branches. Legacy, incomplete and mismatched dispatches
   remain held. Automatic interrupted-session resumption, integration/handoff
   nodes and resident supervision remain separate work; this is not yet an
   end-to-end always-on controller.
3. **Learn the division of labor.** Compare baseline and role-based policies on
   the same enrolled tasks using accepted improvements, rework, elapsed time and
   reported usage with coverage. Keep each repair loop finite and retain consumed
   allowance on escalation. Hold acceptance evidence fixed while evaluating a
   candidate, including a proposed harness change. Unknown usage stays unknown.

Dependency layers and blocker impact are observations, not new scheduling
authority. Keep declared task priority while collecting evidence for later
ranking experiments. Structural descendant counts are neither predicted time
savings nor proof of product value. Reserve enough capacity to finish integration
and independent review of work already started, rather than spending the entire
allowance generating more disconnected changes.

## Wiring

`docs/NORTH-STAR.md` and `docs/ECOSYSTEM-MAP.md` ground strategy and invention.
Goals should be substantive (value ≥ 4), bound to a concrete repo and verifiable
outcome, and decomposed into shippable milestones. The [Ashlrverse operator guide](ASHLR-UNIVERSE.md)
describes its five engines, current executable scope, and path to the full system.
