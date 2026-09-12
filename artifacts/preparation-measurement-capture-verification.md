# Durable preparation capture — local verification

Date: September 12, 2026. Base: `9338c62756f64fd1bbd965a8d651a41f08b50a86`.
Branch: `codex/preparation-measurement-capture`.

## Outcome

The explicit `universe preparation-measurement-capture` command retains an
installed diagnostic against an existing frozen seed. Private immutable intent
and receipt records bind original deadline, artifact, manifest, comparator,
installed evaluator, Node and native-tool identities. Valid report bytes retain
their SHA-256 and length. Failed checks are evidence, not an accepted improvement.

An exact replay emits recorded evidence without invoking the evaluator again.
An unresolved attempt holds execution for its own Universe, not unrelated ones.
Known settled failure does not create an automatic retry. A definite final
identity/stop guard refusal may retain a settled failure only after proving the
original intent, ownership and empty receipt slot; uncertain storage/ownership
does not take this path. No score, trial, elite, provider or delivery is created.
Isolated evaluator fixtures may create their own branches.

## Gates

- Combined mocked core/review/CLI gate: **175 tests, five files, zero skips**.
- Serialized real-I/O gate: **104 tests, five files, zero skips, 37.94 seconds**.
  Includes actual capture, real-file inspection, existing seed evaluator/store
  custody and signed graph execution regressions.
- Actual installed capture test: **2.554 seconds**. Callable but deliberately
  invalid candidate functions produce a valid failed-check report. The command
  returns 1; custody is recorded with confirmed group settlement. Two CLI replays
  leave the store unchanged and keep evaluator calls at one. Inspector reports
  missing totals as unknown. Source refs, repository, seed and Universe records
  remain unchanged. No trial/campaign/model execution occurs.
- Source/web typechecks, strict new-test typechecks, scoped lint, documentation,
  real-I/O lane classification and diff checks passed. Full build passed.

Review corrected enum coercion, receipt timestamp ordering, final-publication
failure handling and historical identity labels. A packaging failure caused by
the development dependency symlink was resolved with a local dependency copy,
without relaxing the package-root checks.

## Integrated verification

Integration onto automatic recovery produced code revision
`91b5d1272a0e684e26916f38a458e532b8a9642d`. Its build, source/web types,
documentation and lane checks passed. The final combined gate passed **146
tests, eight suites, zero skips, 31.44 seconds**. Actual recovery passed in
24.973s and installed failed-diagnostic capture in 2.304s on that same build.
These durations describe the local fixtures, not product throughput benchmarks.

The per-Universe guard does not install a global lock. Existing enclosing
portfolio controllers can hold their entire enrollment on acquisition refusal;
independence means separately acquired execution contexts, not every dependent
branch within a halted portfolio.

## Not established

Full-success native capture through the new command, benchmark scoring,
automatic archive selection, accepted/delivered self-improvement, browser
geometry, actual provider commissioning, service activation and production
publication remain separate gates. The new command is a diagnostic evidence
producer, not proof of a running autonomous company.
