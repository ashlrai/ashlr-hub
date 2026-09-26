# Ashlrverse competitive acceptance

This is a dated product and verification plan, not a claim that Ashlrverse is
currently better than another product. Checked against public vendor material on
2026-09-25. A feature in source, a published package, an installed runtime, a
commissioned account and an operating autonomous fleet are separate states.

## The bar has moved

Warp now describes [Factories](https://www.warp.dev/blog/open-infrastructure-for-building-a-software-factory)
as infrastructure for cloud agents, versioned factory configuration, multiple model
harnesses, governance, measurements and self-improvement. It calls Factories
closed beta. Its [benchmarks](https://www.warp.dev/blog/warp-factory-benchmarks)
compare configurations on fixed task sets. The terminal supplies
[structured command blocks](https://docs.warp.dev/terminal/blocks), while its
[security overview](https://docs.warp.dev/enterprise/security-and-compliance/security-overview)
describes organizational controls. [Cursor cloud agents](https://cursor.com/docs/cloud-agent)
and [automations](https://cursor.com/docs/cloud-agent/automations) establish
another baseline for remote work and scheduled triggers.

The current source checkout implements a multi-seat workbench, local model
routing, a cloud task lane, bounded experiment machinery and a documented
standing-authority design. The [operator guide](VERSE.md), [cloud guide](CLOUD.md)
and [activation gap map](AUTONOMY-GAP.md) define what is actually connected.
The repo's release docs state that the shipped resident fleet is dormant:
service mutation is withheld and compiled daemon/conductor trust roots are
empty. Cloud tasks can deliver draft PRs, but their reports are session-authored
claims, not independent checks.

## Product direction

Build the operator-owned engineering workspace around five questions that are
answerable from evidence at every step:

1. What objective and repository scope did the operator delegate?
2. Which exact worker, model, account and source revision acted?
3. What artifact changed, and what did independent checks actually run?
4. What was published at which immutable revision, and did it stay healthy?
5. What did the accepted result cost in tokens, time and human correction?

The differentiator to test is a continuous, inspectable chain from an objective
through artifact, evaluation, pull request, release and observed outcome. The
operator should be able to stop admission, inspect uncertainty and reproduce a
decision without treating a model's report as verification.

## Acceptance sequence

| Gate | Evidence required | Current boundary |
| --- | --- | --- |
| Cloud delivery identity | PR repository, number, URL, base and head match the requested task; edited or missing report is shown as unverified | A source fix now checks exact identity and drops removed reports; gate and release verification are still required before treating it as installed behavior |
| Local task quality | Fixed task cohort, exact model/harness/runtime, repeated trials, independent correctness checks and cost/latency | Universe has local fixed evaluators; no comparative claim against Warp follows from them |
| Standing autonomy | Operator-signed scope, commissioned provider, active trust root, bounded dispatch, restart recovery, Stop and rollback rehearsal | The production resident path is dormant; source paths and dry runs do not commission it |
| Release identity | Exact source and artifact digest, build/test record, immutable deployment, health and rollback identity | The public site and npm package have separate release identities; local `ship:local` is not public publication |
| Adopted value | User acceptance, defects after release and human correction time tied to the original objective | A merged PR or dashboard count is not accepted product value |

## Comparative benchmark contract

To substantiate a scoped “significantly better” claim, pre-register a meaningful
effect threshold and pass/fail criteria, then run Ashlrverse and the comparison
product on the same representative private task cohort, under permitted accounts
and comparable resource envelopes. Freeze the task specification and acceptance
suite before either system sees them. Record the exact versions, models, prompts,
permissions, compute, retries and human interventions. Do not change an
evaluator after viewing a candidate result without starting a new cohort.

Use at least three kinds of work: a small bug with a reproducible failure, a
multi-file feature with browser acceptance, and an interrupted task that must
recover without duplicate effects. Include tasks that require declining unsafe
or out-of-scope changes. Score accepted behavior, post-release defects, elapsed
time, attributable token or credit use and operator minutes separately. Include
onboarding time and operator usability when comparing whole products. Report
unknown usage as unknown. Compare medians and distributions over repeated runs,
not a single best screenshot or agent count. Any resulting claim must name the
task population, versions, sample size, effect and uncertainty; a narrow cohort
cannot establish overall product superiority.

The current release should not claim superiority until those trials and a
same-revision production acceptance path exist. Warp's public descriptions are
product claims; this document does not independently validate its performance.
