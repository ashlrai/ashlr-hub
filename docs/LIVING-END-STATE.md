# Living End-State portfolio shadow

The Living End-State loop turns strategy into a small, falsifiable portfolio. It treats prepaid Codex, Claude, and local-model token/time windows as expiring inventory and ranks work by expected product impact, information gain, strategic leverage, reusable IP, dependency unlock, probability, and resource cost—not PR count or activity.

V1 has three concepts:

1. `ValueHypothesisV1` binds one falsifiable claim, factor-source digest, and frozen acceptance contract to exact vision-spec and mission-graph digests. A hypothesis is `effective` only after the frozen observation window closes and the caller supplies a complete, preverified outcome receipt bound to the metric, window, artifact, deployment, baseline, causal-evidence floor, and an independent observer digest. The caller remains responsible for cryptographic receipt verification before calling this pure module. Self-report, stale evidence, or incomplete evidence cannot do so; a guardrail may fail early.
2. `ResourceEnvelopeV1` describes values-free public capacity for Codex, Claude, and local execution identities. Unknown, stale, reserved, exhausted, expired, or source-incomplete capacity contributes nothing. An unshardable bet must fit one compatible identity; splitting is allowed only when its hypothesis declares it shardable and supplies a shard-plan digest.
3. `PortfolioShadowV1` hard-gates constraints and stop conditions, exposes every score factor, ranks deterministically, and applies the fixed V1 guardrails of at most three active bets, twelve candidates, a 10% or greater reserve, and 40% or less per bet. These are initial concentration controls, not an ideal end-state allocation theory; a later policy version must derive them from live fleet capacity. Routine reversible work follows the fast path. Higher risk or uncertainty adds a bounded assurance obligation to that bet; it does not create a standing review committee or claim that assurance has occurred.

The stop rules are frozen outcome refutation, guardrail breach, deadline, token/time/attempt exhaustion, repeated inconclusive windows, and marginal expected value below the hypothesis floor. Effective hypotheses also stop because their stated outcome has been achieved. Once a preverified experiment receipt exists, the hypothesis holds without new allocation until its observation window closes; this avoids duplicating the build and confounding its outcome. A downstream human effect gate does not block shadow research or engineering allocation; this module has no effect authority either way.

The versioned `product-value-v1` score is explicit: `0.40 * probability * product impact + 0.25 * information gain + 0.15 * strategic leverage + 0.12 * reusable IP leverage + 0.08 * dependency unlock`, minus bounded risk, token, time, and assurance-cost penalties. Probability applies once to product impact; information gained from a failed bet retains value. V1 factors remain estimates, but their required factor-source digest makes the provenance reference explicit. They order shadow investments only and are ineligible for live learning until the referenced estimates have calibrated receipts. Scores never confer authority.

`shardable: true` means the shadow estimator may pool compatible provider inventory and must carry a shard-plan digest. It is not an executable lease. Live allocation requires validation of the referenced per-shard capability and dependency plan before resources can be reserved.

This module is pure decision support. The caller supplies the clock, source state, evidence, resource observations, and hypotheses. It performs no model or provider call, filesystem or network access, persistence, dispatch, goal creation, proposal, merge, release, deployment, rollback, publication, budget mutation, or learning mutation. Every authority and effect bit is permanently `false`; no standing authority is implied.

## Minimal flow

```text
versioned vision + mission graph
            |
            v
  falsifiable hypotheses ---- preverified independent outcomes
            |                              |
            +--------------+---------------+
                           v
             hard gates and stop rules
                           |
                           v
     product/IP/information value per token and minute
                           |
                           v
       bounded shadow allocation from expiring inventory
```

Use `createValueHypothesisV1` to canonicalize and digest-bind a draft, `buildPortfolioShadowV1` to produce the portfolio, and `verifyPortfolioShadowV1` to fail closed on unknown fields, changed content, impossible allocation relations, or any enabled authority/effect bit. The hashes provide deterministic integrity and lineage, not authenticity; authenticated source evidence must already have been verified at the caller boundary. V1 is intentionally not wired to the API, daemon, strategist, backlog, quota reservation, or execution paths.
