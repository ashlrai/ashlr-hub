# Task Plan: Agent-Native Engineering OS

## Goal

Advance Ashlr Hub from two isolated shadow primitives into a coherent, testable operating-system kernel for autonomous engineering fleets while preserving Hub, Cortex, Locus, Phantom, and wrkpad as independently shippable products.

## Product assumptions

- Hub is the kernel and sole fleet scheduler; this is an extension of the established architecture, not a new competing orchestrator.
- Models/accounts are schedulable compute; missions are processes; worktrees are isolation; tools are devices; evidence/outcomes are kernel truth.
- The first integrated release remains read-only/shadow by default. It must prove decisions before live dispatch or effects.
- Routine reversible engineering should eventually flow under standing permits. This workstream does not infer live authority from source changes.
- Keep the protocol and UX small enough to be operable: one value loop, one capability/resource view, one receipt chain.

## Phases

- [x] Phase 1: Restore repository, Entire, memory, and prior-work context
- [x] Phase 2: Map the minimal kernel integration seam and current UI/runtime data paths
- [x] Phase 3: Implement the highest-leverage non-overlapping kernel, runtime, and operator slices
- [x] Phase 4: Integrate slices and close security/correctness findings
- [x] Phase 5: Run focused and adjacent verification plus independent adversarial review
- [x] Phase 6: Produce exact achieved-state, activation, and remaining-work documentation

## Workstreams

1. Kernel: compile vision, mission, hypotheses, resources, and outcome receipts into one shadow control-loop snapshot.
2. Runtime: expose account-aware capacity and reset-window inventory through an internal read-only service boundary.
3. Operator experience: expose the living portfolio and capability spectrum in the existing Hub topology without creating another dashboard product.
4. Verification: challenge privacy, authority, determinism, resource accounting, recovery, and anti-Goodhart behavior.

## Decisions made

- Modify the established Hub stack rather than introduce Eve; the agent-building skill explicitly preserves an established non-Eve runtime.
- Reuse the newly verified Execution Identity and Living End-State modules rather than reimplementing them.
- Delegate independent file scopes and integrate centrally because the active branch already contains owned uncommitted work.

## Errors encountered

- `entire resume codex/v333-iteration` found no checkpoint; current context is reconstructed from Git, workplans, memory, and live source.

## Status

**Original source slice complete; observer integration remains unactivated** — the shadow kernel, capability spectrum, strict strategy compiler, read model, and cockpit are implemented and adversarially hardened. A later tranche mounted the cockpit behind an authenticated observation-only endpoint and added a default-off observer, but no trust keys, released producers, daemon activation, or live authority exist.

## Verification record for the original kernel/cockpit slice

- 10 focused and adjacent files: 190 passed, 1 Windows-only skip.
- Full web suite: 28 files, 100 passed.
- Core and web TypeScript: passed.
- Full repository lint: passed with 0 errors and 108 non-blocking existing warnings; changed-file lint had one pre-existing unused-fixture warning in `test/m184.ecosystem-context.test.ts`.
- Full production build: passed; 179 web modules transformed and release metadata generated.
- `git diff --check`: passed.
- Monolithic `npm test`: attempted and stopped after ten minutes without a terminal summary; it exercised broad existing integration paths but is not claimed as passing.

These counts predate the production-observer tranche and must not be presented as its exact-final regression evidence; the observer workplan records that tranche separately.
