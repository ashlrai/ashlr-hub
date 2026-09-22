# Durable preparation measurement capture

Base: `9338c62756f64fd1bbd965a8d651a41f08b50a86`.
Branch: `codex/preparation-measurement-capture`.

## Outcome

Retain an installed diagnostic report against an existing Universe's frozen
seed, with exact artifact/evaluator/tool identity and actual process settlement.
This is not a scored trial, accepted improvement, delivery or running service.

## Work graph and ownership

1. [x] Three independent Explore passes map persistence, execution custody and CLI patterns.
2. [x] Core builder: bounded capture types/store/runner and focused mock tests.
3. [x] CLI builder: explicit capture command, help/routing and mock tests; depends on core types.
4. [x] Independent reviewer: replay, custody, deadline, drift and publication boundaries.
5. [x] Parent: combined mock tests, source/web types, documentation, build and serialized native acceptance.
6. [x] Parent: integrate with automatic-admission recovery and verify the merged build.

Integrated code revision: `91b5d1272a0e684e26916f38a458e532b8a9642d`.
Combined build, source/web types, documentation and lane checks passed. Final
combined gate 57459 passed 146 tests across eight suites, zero skips, 31.44s;
actual recovery and capture passed on the same built source. Only the adjacent
test-lane additions conflicted during integration; both entries were retained.

Core and CLI work concurrently after the interface is fixed. Parent is sole
committer/integrator. Dependencies are a real local copy, not source.

## Decisions

- Reuse the immutable private-record store, existing Universe execution lease,
  fixed evaluator and diagnostic decoder. No new scheduler or provider calls.
- Require explicit Universe/capture IDs and root. Timeout comes from the pinned
  manifest. An immutable capture ID never renews its deadline or retries work.
- Store the raw valid report and digest in the authoritative result. An explicit
  CLI report mode emits those retained bytes; no additional output-file authority.
- Preserve failed/partial diagnostics as evidence, never as acceptance.
- An unresolved capture holds the same Universe's execution, matching existing
  evaluator ownership semantics. Other Universes remain independent. A settled
  failure ends custody but is never automatically retried.
- Preserve intent and scratch on uncertainty; do not fabricate settlement.

## Verification

Mock gates cover exact report retention, unchanged trial/archive state, replay
with no dispatch, malformed/changed identities, original deadline, cancellation,
KILL, unknown settlement and same-Universe ownership. CLI gates cover invalid
arguments, signals, redacted errors and exact raw report emission.

Completed gates: 175 mock/CLI tests in five files; 104 real-I/O tests in five
files, including the actual failed-diagnostic capture and byte-exact CLI replay.
The capture test passed in 2.554 seconds. Full-success capture through this new
command remains unverified; diagnostic output still cannot select or deliver work.

Initial build failed because the dependency symlink made npm report 491 paths
outside the package root. The validator correctly refused them. Replaced only
the task-created link with a real copy of existing pinned dependencies; no package
checks were weakened. The link is recoverable at
`/tmp/ashlr-capture-dependency-link.GdFCEQ/node_modules-link`. Build then passed.

All native gates were serialized: recovery 74134 and combined 39718 finished
before capture 17179. No accounts, allocations, activation, remote publication
or original-checkout edits.
