# Universe graph implementation report

## Implemented

- Derived occurrence graph for Universe, seed, evaluator, campaign, reservation, run, trial, artifact and delivery records.
- Separate parent-code and evaluator-feedback edges; identical content does not merge occurrences.
- Deterministic comparator-scoped opaque identities, explicit source completeness and bounded node/edge/finding envelopes.
- Iterative ancestor/descendant traversal with cycle detection and complete induced relationships at a depth boundary.
- Repeated-output and undelivered-current-elite observations with explicit token coverage, not estimated savings or production acceptance.
- Targeted storage reader, SDK exports, strict CLI, authenticated read-only API and on-demand paginated console inspector.
- Canonical operator guide updated; no new graph database or runtime dependency.

## Verification so far

- 465 tests passed across the broad Universe/package-smoke run (22 files). The subsequently added builder file passed 8 cases, for 473 unique related tests in total.
- All graph-specific cases also passed together: 110 across 5 files, overlapping the preceding counts.
- 210 web tests across 34 files passed; 46 focused graph/Universe UI cases are included, not additional.
- Root/web TypeScript checks passed.
- 449 invariant tests passed across 41 files; 5 existing skips remain. This is not the full M571 production release gate.
- Full lint passed with zero errors and 106 existing warnings. Real-I/O classification passed with only the pre-existing m11 soft signal.
- Production build passed. The final clean-commit build/package identity is recorded in the external post-commit handoff, not inferred here.
- Actual browser inspection passed graph opening, distinct parent/feedback tracing, and navigation from generation 3's parent to exact generation 1 trial evidence. Layout, readable controls and keyboard focus were visually inspected.

## Existing real-model evidence inspected without running models

For campaign-calendar-94544f09, the graph returned healthy/complete evidence with 17 nodes, 27 edges, 3 trials, 1 current elite and 1 checked local delivery. Generation 3's parent is generation 1; its feedback source is generation 2. One repeated-output finding correctly accounts for 3 matching recorded artifacts and 9,580 reported generation tokens. This is prior benchmark evidence, not new model work or three improvements. A sample targeted read completed in 351 ms on this machine; it is not a general performance guarantee.

## Distribution boundaries

GitHub Actions remains disabled. Npm authentication was rechecked at 2026-09-07T00:01Z and returned E401; public latest/candidate tags remain 3.3.2. No publishing, resident-service activation or provider/account changes were performed. Local-only successor release policy and full exact-artifact production release gates remain separate unfinished work. The graph is observation-only; it does not yet schedule cross-project work.

This is a pre-commit verification snapshot. Final package acceptance, source SHA, push/merge status and refreshed server identity belong in the final release handoff outside this verified tree.
