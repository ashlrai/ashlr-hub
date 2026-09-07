# Universe decision-quality continuation

## Goal

Improve verified engineering yield by giving candidate generators truthful, replay-verifiable search context while preserving legacy evidence and the existing bounded runtime.

## Phases

- [x] Re-establish merged source, clean worktree, memory, and Entire context.
- [x] Parallel exploration of feedback contracts, independent replay, and native acceptance.
- [x] Finalize a bounded versioned implementation plan.
- [x] Implement and independently review core, integration, and acceptance workstreams.
- [ ] Local verification, exact-source package acceptance, source publication and handoff.

## Boundaries

- Start from merged portfolio master 52e6561825b345bbbf7f5bdd86b3633ecc0d211a.
- No GitHub Actions, resident activation, account/provider changes, or live/default-store execution.
- Preserve existing non-eve stack, campaign scheduling/budgets, retained-parent selection, fixed evaluator, and legacy feedback byte contracts.
- A repeat is recorded evidence, not proof future work is worthless or an estimate of saved tokens.
- Primary Desktop checkout remains untouched.

## Status

Source implementation frozen. Combined Universe/package regression (747), web (211), types, lint, and invariants (449 with 5 existing skips) pass. Clean-source packaging, exact artifact acceptance, and source publication remain in progress.

## Implementation plan

1. Add a bounded search-context builder and strict validator with schemaVersion 2. Include metric name/direction/minImprovement, retained parent occurrence and score, previous attempt selection/delta, and up to 16 same-variant/current-parent completed attempts with explicit sample coverage and repetition counts.
2. Preserve v1 feedback objects and digests byte-for-byte. New feedback-enabled runs pin feedbackVersion 2 in start/final records and add a separate generation.search receipt containing only version and digest.
3. Include search context on the first feedback-enabled request even when previous-outcome feedback is absent. Keep bounded existing files/transport/evidence budgets; reconstruct context from the historical prefix during independent store replay.
4. Resolve parent occurrences by run and trial, not bare trial IDs. No result caching, automatic variant suppression, inferred savings, or modified winner selection.
5. Preserve recorded legacy versions during interrupted run-ID recovery. Reject run/receipt version mismatch and context-provenance tampering.
6. Verify native maximize/minimize fixtures that correct after ties, legacy replay, boundary/replay regressions, observer metadata, and exact installed package behavior. Update the single canonical operator guide.

## Errors

- No Entire checkpoint found. Repository-local AGENTS.md search had no matches; inherited /Users/masonwyatt/.codex/AGENTS.md was read.
- Two exploratory shell globs matched no files; resolved the actual UI path with rg --files and used explicit paths thereafter.
- Initial pure tests exposed a signed-zero fixture mismatch and missing rejection of an invalid mixed command/model variant. The fixture now mirrors durable JSON zero normalization; the builder rejects mixed variants. Final focused rerun passed.
