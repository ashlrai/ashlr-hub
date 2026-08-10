# Notes: Ashlr Autonomous Engineering Team OS

## Baseline
- Primary checkout: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub`, branch `master`, five uncommitted agent-owned files, 539 commits behind `origin/master` after fetch.
- Clean implementation worktree: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub-autonomous-team-os-v1`, branch `codex/autonomous-team-operating-system-v1`, based on `origin/master` `66516043`.
- Current upstream already contains Fleet OS PR #225 via `cf8380e8`; do not reimplement its Mission Compiler, Operator Briefing, spend recovery, or existing readiness surfaces.
- Prior live evidence was proposal-starved; verify current status before selecting work.

## Research Log
- Upstream `origin/master` at implementation start was `66516043` and already includes Fleet OS PR #225 (`cf8380e8`).
- Open work is dense around daemon recovery/quarantine, proposal settlement, remote PR lifecycle, canary rollback evidence, outcome assurance, and fleet-status authority. Avoid those files unless an unavoidable integration seam is proven.
- The installed `ashlr` release reports revision `18a60269`, daemon stopped, auto-merge disabled, 20 visible backlog items, 8 freshly queued autonomy items blocked by repair control, 0 pending proposals, and a degraded dispatch-outcome source (4/4 rows invalid). This is read-only evidence; no runtime activation was performed.
- `Goal` persists only objective/project/status/milestones/timestamps. A milestone has a prose acceptance hint, while the goal has no bounded outcome contract, success signals, constraints, review horizon, or explicit non-authority semantics.
- The strategist asks for substantive goals and rationale, but `proposedGoals` persist only objective and target repo. Mission adoption therefore loses the rationale and any definition of business success at the exact handoff from vision to execution.
- Candidate slice: add backward-compatible, bounded goal outcome contracts generated during Mission Compiler preview, preserved through explicit adoption, and visible in CLI/API/Mission Control. Keep them planning-only: they must not attest completion, weaken verification, authorize merge/deploy, or trigger provider/external mutation.
- Autonomy audit: the execution loop is strong per repository, but strategist goals are flat. A mission cannot express `Cortex contract -> Hub consumer -> Locus end-to-end proof` or unlock downstream work only after verified realized completion.
- Ecosystem audit: Hub should remain the engineering control plane, Locus the principal/tenant/provider credential and session-isolation plane, and Cortex the company responsibility/deadline/accountability plane. The later cross-product seam should be a governed Cortex -> Hub -> Cortex mission loop, beginning with read-only scoped intake.
- Selected implementation: Ecosystem Mission Graph V1 plus outcome contracts and read-only operator visibility. This is deliberately lower-collision than daemon, Fleet Status, proposal settlement, remote PR, canary, or outcome-assurance work currently in flight.
- Clean-worktree dependency install and baseline TypeScript check passed; `npm audit` reported zero vulnerabilities during `npm ci`.
- Implemented a pure, versioned mission DAG with exact canonical repo targets, bounded validation, deterministic SHA-256 digest, dependency projection, human gates, deliverable evidence, risk, and outcome contracts.
- Strategist mission metadata is additive: legacy flat briefings remain supported. A fresh graph preview blocks invalid graphs, incomplete dependencies, human gates, degraded goal inventories, duplicates, collisions, and focus overflow.
- `ashlr vision reconcile` is an explicit local planning mutation. It re-reads authoritative enrollment and verified realized-merge evidence, creates at most one newly ready goal, and does not apply spec evolution, dispatch, propose, merge, deploy, or publish.
- The Goals view now includes a GET-only, path-redacted, source-aware Mission Outcome Room. It exposes thesis, current state, gap, dependencies, deliverables, acceptance evidence, success signals, guardrails, risk, and human-gate status without adding an approval or execution control.
- Goal mission bindings now carry the exact graph digest, mission key, and node key. Historical goals with matching prose cannot satisfy a changed mission contract, and atomic create-if-absent prevents concurrent reconciliation from overwriting an existing deterministic goal.
- Briefing and goal readers now bound total directory entries and candidate files, reject symlinks/non-regular/oversized records, validate persisted mission metadata strictly, and surface incomplete or degraded provenance rather than adopting a stale older record.
- Three independent adversarial passes found and closed authority, correctness, security, determinism, accessibility, and operator-language defects. No P0/P1 remained in the final reviews. The remaining product evidence gap is a rendered browser/DOM regression; the committed UI contract test is static-source plus API behavior.
- Final focused verification before upstream rebase: 148/148 tests passed across existing vision, strategist adoption, goal-source quality, mission compiler, graph kernel, and Outcome Room suites. All 41 invariant modules passed (445 passed, 5 skipped). TypeScript, browser JavaScript syntax, build, audit, and `git diff --check` passed. Lint exited 0 with zero errors and 101 repository warnings.
- A full `npm run test:ci` attempt ran until the repository's 900-second hard cap. Every completed module passed and no failure was reported, but collection stopped while entering `test/h5.disk-cap.test.ts`; this is incomplete evidence and is not reported as a full-suite pass.
- Upstream advanced six commits to `90a0f6d6` during implementation. Those commits touch canary rollback evidence, remote handoff, and best-of-N files only; none overlap this slice. The implementation commit rebased without conflict, and the exact rebased revision again passed 148/148 focused tests, all 41 invariant modules (445 passed, 5 skipped), typecheck, build, browser JavaScript syntax, audit, and diff checks. Lint again exited 0 with zero errors and 101 repository warnings.
- A hermetic local server fixture returned a healthy GET-only `/api/vision/mission` projection with `authority:"planning-only"`, an awaiting-human lifecycle, and no mutation surface. Headless Chrome DOM capture was not reliable on the host, so this smoke does not close the rendered accessibility evidence gap.

## Risks
- Many concurrent worktrees and branches are active; file-level overlap is a first-class constraint.
- Autonomous execution, merge, deployment, and learning have different authority and evidence requirements.
- Hub source changes do not change the resident daemon until build/install/restart is separately authorized and verified.
- A prose outcome contract can look authoritative unless every surface labels it as an intent/measurement plan rather than observed proof.
- Static UI contract tests do not replace a rendered narrow-viewport, keyboard, and screen-reader acceptance case; add that before promoting the Outcome Room evidence claim beyond source-level confidence.

## Outcome Room Design Plan
- Subject: the operating contract for Ashlr.ai's autonomous engineering team. Audience: Mason as director. Single job: understand what the fleet is trying to achieve, what is blocked on what, and which claimed proof is actually observed.
- Palette: inherit Hub's existing control-plane tokens instead of introducing a second brand system; use the existing cool blue for planned/ready, amber for human gates or incomplete evidence, green only for verified realized proof, and muted graphite for dependency-blocked work.
- Type: preserve the app's existing display/body/utility roles so the room feels native. Use utility/monospace treatment only for immutable mission/node references, never for the mission thesis.
- Layout concept: a quiet mission thesis on the left and a horizontal evidence/dependency rail on the right. The rail is structural: nodes are ordered by dependency, not decorative numbering.

```text
+ Mission outcome --------------------------------------------------+
| What changes for Ashlr.ai       | Intent -> Build -> Proof         |
| measurable success signals      | [ready]--[blocked]--[human gate] |
| constraints / non-goals         | selected node evidence           |
+------------------------------------------------------------------+
```

- Signature: one `Intent -> Built -> Proved` chain that visually refuses to color a node green unless the underlying projection reports verified realized evidence. This extends Fleet OS's existing proof-chain language into strategic work.
- Motion: none required in V1. Snapshot refreshes should preserve focus, scroll, and disclosure state; reduced-motion behavior remains unchanged.
- Accessibility: semantic headings and list/table roles, visible focus, no color-only statuses, complete button/link names, and compact/mobile layout that becomes a vertical dependency rail without horizontal scrolling.
- Self-critique: a generic grid of KPI cards would obscure causality. The revised design spends its one distinctive gesture on the dependency/evidence rail and keeps surrounding controls quiet. It avoids new decorative gradients, fonts, and animation because this is a high-trust operating surface inside an established product.
