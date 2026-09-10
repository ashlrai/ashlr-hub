# Executable firm: package graph

## Goal
Implement the user's firm specification as tested executable packages, preserving
existing activation, provenance, evaluation and resource invariants.

## Phases
- [x] Read the supplied specification; isolate baseline PR #404.
- [x] Inventory reused primitives and materialize P00–P47.
- [x] Wave 1: control graph, signed traces, verifier contract, harness archive.
- [x] Integrate and test a provider-free complete path in isolated CLI processes.
- [x] Connect selected allocation receipts to explicit resource runtime enrollment.
- [x] Add general signed graph inspection and actual CLI-process coverage.
- [x] Enforce KILL at Git publication and absolute deadlines at resource admission.
- [ ] Subsequent waves: wire remaining packages in dependency order.
- [x] Review, record actual package/test receipts and exact local-only delivery state.

## Decisions
- Four active-agent slots total: parent plus three bounded workers per wave.
- Separate auto/package branches/worktrees, with parent as sole merger.
- No GitHub Actions. No provider dispatch or account allocation changes here.
- Keep compiled activation roots empty; no constitution or safety-test edits.
- Control graph initially lists planned packages; only real artifacts create
  digest-bearing edges. Never invent terminal states to satisfy a count.

## Errors
Independent review found graph serialization/ID limits, archive capacity races,
signal starvation and an unsupported Windows native cancellation path. Fixed
with new regression tests. Real-I/O graph tests use a realistic execution budget
while separately checking persisted deadline exhaustion.

## Status
P03 and P08 are integrated; cold review also tightened publication KILL checks,
runtime pinning and absolute admission deadlines. Allocation signatures remain
selection evidence; separate trusted host enrollment invokes existing resource
reservations. Real inert native/HTTP fixtures and CLI processes passed.

Thirteen locally landed component artifacts; thirty-five packages remain planned.
Full north-star completion is not claimed. Actual host KILL is active and remains
untouched. Local package, CLI, UI, release-contract and safety gates passed;
the full north-star implementation and production activation remain unfinished.

Next: connect the host adapter to truthful graph execution traces and confined
implementation/independent acceptance, then resident ticks through existing
activation. Keep cumulative cross-receipt budget accounting explicit; current
receipt bounds are not a firm-wide spend ledger.
