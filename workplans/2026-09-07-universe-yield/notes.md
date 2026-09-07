# Findings

- Previous graph increment is clean, merged, and recorded in workplans/2026-09-06-universe-graph.
- Campaign loop already uses durable reservation, shared Universe lease, explicit foreground ownership, time/generation/request/token/stagnation limits, and pause/stop controls.
- Graph currently identifies recorded repeated outputs but does not change execution policy.
- Public npm publication was previously blocked by authentication and an incomplete local-only successor release path; current task must not confuse feature validation with publication readiness.
- Explore found that adaptive within-campaign dispatch would change exact schedule replay contracts. It requires versioned policy and independent decision replay and is outside this portfolio increment.
- Model feedback omits selected/delta and metric context; versioned yield feedback is a worthwhile independent next change, not bundled into the scheduler.
- Release assessment: existing policy parent/SRI bind an older candidate; exact Node24.18.0/npm11.16.0 are already installed. Hosted publication verifier still requires GitHub Actions provenance. No publication/authentication changes attempted.
- Portfolio defaults to explicit dependency ordering across distinct Universes, not yield prediction or causal lineage. Existing completed campaigns satisfy prerequisites, even if they produced no useful artifact; docs and result scope must make this explicit.
- Independent control-race finding: execution ownership excludes other runners but not the owner-control lock. Startup now compares the exact admitted ledger while holding the short control lock; only its own recovery append can advance that checkpoint. A conflicting pause/stop never receives a foreign failure settlement.
- Runtime root and definition are captured independently before asynchronous work. The deadline is checked again inside deferred dispatch rather than relying only on timer callbacks.
- Independent native tests verify parallel roots and dependency join, serial ceiling, completed-with-rejected-artifact ordering, stopped-branch isolation, degraded preflight, cancellation, deadline, late pause, and rerun idempotence.
- Canonical operator guide reviewed against source and its JSON example validated. No separate overlapping operator document was added.
