# Task Plan: Unified Ashlr Agent Operating System

## Goal
Define a verified, ambitious architecture and execution program that makes Ashlr Hub the desktop fleet control plane while preserving Phantom, Locus, Cortex, and wrkpad as independently valuable products and repositories.

## Scope and assumptions
- Start with read-only discovery across repositories, worktrees, local runtime state, and GitHub metadata.
- Treat Hub as the orchestration/control-plane candidate, Locus as governed tool/context infrastructure, Cortex as durable organizational intelligence, Phantom as a complementary product to be mapped from current source, and wrkpad as a guarded physical operator surface.
- Do not move Desktop folders, change remotes, merge repositories, install services, publish releases, or activate providers during discovery.
- Separate source readiness, installed-artifact readiness, resident-runtime state, production authority, and human acceptance.

## Phases
- [x] Phase 1: Establish scope, safeguards, and persistent workplan
- [x] Phase 2: Inventory repositories, Desktop clones/worktrees, branches, remotes, recent history, and Entire state
- [x] Phase 3: Reclaim Desktop safely by removing clean Hub worktrees and recovery-archiving every dirty tree before removal
- [x] Phase 4: Map architecture, contracts, overlaps, product boundaries, and runtime authority
- [x] Phase 5: Research current orchestration patterns and identify strategic gaps
- [x] Phase 6: Implement and verify the highest-leverage contract-first unified-fleet slice
- [x] Phase 7: Synthesize target architecture, GitHub organization model, consolidation sequence, and acceptance gates
- [x] Phase 8: Independently audit the blueprint and implementation for security, feasibility, edge cases, and completeness
- [x] Phase 9: Deliver verified outcomes and the next execution sequence

## Key questions
1. Which checkout is canonical for each product, and which Desktop folders are clean clones, linked worktrees, generated artifacts, or abandoned experiments?
2. What contracts should connect Hub, Phantom, Locus, Cortex, local models, Codex/Claude accounts, and wrkpad without collapsing their independent product value?
3. What is the smallest high-leverage implementation slice that proves multi-provider resource allocation toward evidence-qualified product value without making routine human approval the bottleneck?
4. Which repository topology best preserves independent release/versioning while enabling shared protocols and end-to-end tests?

## Source classes
- Current repository source, documentation, tests, package manifests, Git metadata, and local runtime diagnostics
- Current official GitHub metadata and vendor documentation for consequential platform claims
- Existing Ashlr memory only as historical context, with live verification where drift is plausible

## Decisions made
- Keep discovery non-destructive and produce a contract-first federation plan before any repository or filesystem consolidation.
- Store this workstream under `workplans/2026-09-02-unified-agent-operating-system/` to avoid overwriting existing root planning artifacts.
- User explicitly authorized removal of the redundant Desktop workspace sprawl on 2026-09-02.
- Preserve Git branch/commit history for clean worktrees and create a checksummed recovery archive for tracked and untracked dirty content before removing any dirty worktree.
- Move beyond planning in this run: implement the highest-leverage contract-first integration slice after the audits converge.
- Do not rewrite Hub wholesale: preserve its mature mission, sandbox, proposal, evidence, and authority kernel; refactor the account/runtime seam first.
- Select `Execution Identity V1` as the first source slice, default-off and shadow-only.
- Keep runtime locators and Phantom secret-name references out of exported `AshlrConfig`; use a separate strict private store keyed by opaque locator refs.
- Model Claude interactive Max separately from unattended Agent SDK credit/API capacity under the current 2026-06-15 policy.
- Translate NIWC Sea Strike and DON Spectrum-on-Demand patterns into an Ashlr Capability-on-Demand architecture: distributed sensing, course-of-action simulation, deconfliction, dynamic allocation, resilient operation, and explicit effect authorization.
- Adopt NIST-style policy engine, policy administrator, and distributed enforcement-point separation; the model is always an untrusted subject, never the authority source.
- Treat the unattended-duration example as illustrative, not a product SLA. The requirement is continuous investment of expiring model/compute capacity toward the best evolving end state.
- Keep one lean value loop and five cross-product envelopes. Use adaptive assurance rather than fixed agent committees or approval chains: routine reversible work takes the fast lane; consequence, novelty, uncertainty, disagreement, or weak evidence triggers independent review.
- Permit autonomous effectiveness classification only from acceptance thresholds frozen before execution and attributable technical/product/business outcome evidence; self-report and activity proxies have zero outcome weight.

## Errors encountered
- None.

## Status
**Complete** - Workspace consolidation, mission-systems synthesis, Execution Identity V1, Living End-State shadow allocation, independent review, and focused validation are complete. Live account authentication, dispatch wiring, installed-runtime activation, and autonomous effect permits remain separate future stages.
