# Notes: Ashlr Hub Next-Level Autonomous Lab

## Current Evidence

- Volatile counts in this section belong to the 2026-08-11 04:50 UTC snapshot and command/API inventory recorded in `NEXT_LEVEL_AUTONOMOUS_LAB.md`; they must be refreshed before an execution decision.
- Protected source, npm publication, installed runtime, resident daemon operation, and production deployment are separate gates.
- Protected master contains prior control-plane hardening, but current draft candidates remain separate from shipped behavior: PR #268 is Windows launcher work, PR #270 is Linux desktop quarantine, PR #278 is mutation-disabled activation admission, and PR #279 is the M380 fixture repair. Draft PRs are neither protected-master capability nor installed/runtime authority.
- The current protected master is not green because a date-bound M380 fixture crossed its 30-day reconciliation window; draft PR #279 contains the independently reviewed test-only repair.
- Resident service activation remains intentionally unavailable until a native, signed, replay-safe, crash-safe launchd transaction exists.
- The installed runtime is still 3.1.0 while source is 3.2.0; the resident daemon is stopped and has no recent tick.
- Fleet status reports 25 enrolled repositories, 20 queued items, zero eligible items, zero pending proposals, and eight repair-control-blocked items.
- Eleven actionable goals remain active and suppress new invention; the visible goal samples are stale rather than advancing toward closure.
- Generated work is repair-heavy: nine generated items, all self-heal, with eight proposal repairs, six diagnostic reslices, two capture repairs, and zero invention.
- Outcome authority is incomplete: dispatch-production evidence read four rows and rejected all four; autonomy evidence packs are absent and their authority is cold-start.
- Proposal source completeness is healthy (672/672), so zero pending proposals is not explained by a missing proposal index.
- Scanner evidence is degraded (212/268 observations unavailable) and the resolution observer is stale/deadline-exceeded with zero witnesses.
- These facts point to a conversion and liveness failure between queued intent, useful code changes, verified proposals, and durable outcomes—not a shortage of schedulers, models, or dashboards.
- GitHub currently has 60 open pull requests, 53 of them drafts; the oldest sampled drafts have been open since July 20. This is work-in-progress inventory, review debt, and product-surface fragmentation—not evidence of autonomous throughput.

## Audit Inputs

### Product / Founder

- North Star: Weekly Active Outcome Teams, measured only by accepted protected merges that survive seven days with bounded operator time.
- Live product truth is 672 rejected / 0 applied proposals, zero recent merges, 20 visible / zero eligible work, 11 stale active goals, a stopped older runtime, and 53 draft PRs.
- The killer demo is a fresh install taking one genuine issue through reproduce, bounded investigation, patch, regression test, exact verification, approval, protected merge, and seven-day stability observation.
- Freeze feature-surface expansion until the product produces at least 20 stable real-world outcomes.
- Recommended first slice: First Outcome Mode, a one-repo/one-objective one-shot path that terminates in one verified pending proposal or one explicit blocker without merge, deploy, publish, or service authority.

### Frontier Agent Research

- Positioning: the open scientific control plane for agent organizations that can prove their work, not another multi-agent framework.
- Prompt optimization is currently non-scientific by default because its built-in metric is invariant to the prompt; memory, confidence, routing, and self-improvement remain observational until held-out causal evaluation exists.
- Multi-agent topology must be an experimental policy with equal-budget single-agent controls; more agents are not a success metric.
- Build ASHLR-ARENA with frozen task health, repeated trials, exact harness/model/environment identities, cost, latency, human attention, safety failures, and confidence intervals.
- Recommended research slice after product conversion: contract-first planner/generator/evaluator shadow experiments with no proposal or effect authority.

### Autonomous-Team Architecture

- Ashlr is a strong safety substrate but not a live autonomous organization; fail-closed behavior has become fail-stopped behavior.
- The missing operating kernel is a signed mission ledger, scheduler reconciler, economically atomic execution capsule, unified evidence spine, separately authorized effect controllers, reliability director, and outcome ledger.
- Current risk concentrations include optional OS confinement, no hierarchical reservation transaction, fragmented causal ledgers, five oversized authority modules, no incident operating system, and cloud coordination stubs.
- Recommended infrastructure slice after first product proof: crash-safe hierarchical execution reservations binding mission, repo/base, backend capability, cost/tokens/steps/tools/children/slots, confinement, owner identity, expiry, and parent reservation.
- No autonomous launch should occur without durable reservation and mandatory confinement; Windows should refuse unattended execution until it has a real confinement boundary.

## Candidate Themes

- Intent-to-useful-work conversion rather than dispatch throughput.
- Durable evidence graph connecting missions, attempts, proposals, verification, merge, release, runtime, and outcomes.
- Verifier-driven iteration with calibrated uncertainty and bounded resource envelopes.
- Privacy-preserving learning from receipted outcomes, never from raw rejected content or secrets.
- Production authority as a distinct signed transaction rather than an incidental side effect of planning.
- A fail-closed conversion controller should explain every attempted work item as converted, safely no-op, policy-blocked, evidence-degraded, awaiting-human-decision, or retry-eligible; unclassified terminal states must never silently recycle.
- The first operating metric should be authenticated useful outcomes per bounded dollar-hour, with proposal rate, merge rate, regression-free survival, latency, and human intervention as diagnostic factors rather than vanity goals.

## First Outcome Security Audit

- General unattended First Outcome Mode is currently NO-GO. External Claude/Codex processes can run while confinement defaults off, use permissive CLI flags, retain real user-home access, share repository Git metadata, and can reach unrelated local CLIs or raw network paths.
- A pending proposal is not necessarily human-only: the existing auto-merge pass can ingest pending proposals unless a new immutable review policy is enforced at every entry point.
- Existing `goal --direct` correlation uses a before/after same-repo inbox delta and can misattribute a concurrent proposal. Exact run-bound proposal outcome and durable pending authority already exist and must replace this heuristic.
- Goal storage lacks the generation/CAS semantics required for idempotent unattended replay, and retries do not share one atomic economic reservation.
- Kill and enrollment authority are checked before launch but not continuously enforced through child termination and proposal capture.
- Required prerequisite: sealed execution capsule; exact run/proposal identity; human-only review policy; repo/objective/base lane; a durable atomic `FirstOutcomePermitV1`; continuous revocation; hostile-engine and concurrency tests. Hierarchical fleet reservations are the later Stage 1 generalization, not a First Outcome prerequisite.
- Until those prerequisites land, a future alias may only provide a bounded derived result envelope with no replay, authority, ledger role, additional loop, or retry. Unattended external CLI execution remains categorically refused; API-model execution must cross only the reviewed local authenticated broker boundary.
