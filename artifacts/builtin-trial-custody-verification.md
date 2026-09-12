# Built-in trial custody verification

September 12, 2026. Source base:
`3a1429407f2b734468ebb46936be4b53a4056c6a`.
Implementation branch: `codex/builtin-trial-custody`.

## Operational change

Ordinary builtin trials now publish an immutable dispatch intent before
evaluator launch. Only explicit not-started or confirmed process-group
settlement can close that intent. The fixed evaluator also checks its separately
owned inner activity; a passing-looking report does not replace those facts.

Uncertain return, post-dispatch exception, or failed settlement publication
preserves scratch and activity records, drains the current batch after
cooperative cancellation, suppresses selection, and holds further work for the
same Universe. The guard covers fresh acquisition and existing campaign leases.
Other independently acquired Universes are not globally locked. Known settled
failure may continue; not-started never earns a score.

The private store reuses the existing immutable record utility. It reserves both
records and settlement bytes before dispatch, with a hard limit of 4,096 records
(2,048 evaluator invocations) per Universe. It rejects unknown enum values,
changed attribution, malformed paths, getters and proxies. This change provides
no deletion, automatic uncertain retry, journal migration or retroactive proof
for old trials. Legacy command-evaluator behavior remains unchanged.

## Verified gates

- Final pure/inert combined regression gate: **185 tests, seven files, zero skips, 2.18s**.
  Fixed evaluator seam, new custody codec/store, existing diagnostic capture and
  inner activity tests. Subprocesses are mocked in the new tests; these results
  do not prove actual native process settlement.
- Source typecheck, strict new-test typecheck, scoped lint, documentation check
  and test-lane classification passed. Strict checking initially found an
  over-narrow inferred callback type in a new test helper; an explicit callback
  annotation fixed it without changing product behavior.
- Independent runner checks include same-held-lease refusal, a stop after intent
  publication, malformed settlement, paired publication failures, and sibling
  cancellation/drain. Independent source review found no blocking issue.
- Initial native gate: **18 passed, one failed, three files, 21.49s**. The failed
  assertion incorrectly required all confirmed scratch to be removed. Existing
  cleanup is explicitly best-effort; installed fixture seeds have frozen 0500
  directories. The actual evaluator settled and wrote its paired records. The
  lost-return case passed. Acceptance is being corrected to observe the actual
  cleanup error, retain this limitation, and prove a subsequent generation can
  run without weakening the custody checks. No product cleanup behavior changed.
- Final serialized native gate: **19 tests, three files, zero skips, 23.79s**.
  Actual installed failed-diagnostic trials now prove two consecutive generations
  publish paired custody records without elites and preserve prior records.
  A separate actual diagnostic followed by injected return loss retains scratch
  and intent-only custody, rejects fresh same-Universe admission, and leaves
  the ledger unchanged. This injection does not claim an actual leaked process;
  test cleanup requires fresh kernel-backed inner-activity confirmation.
- A second gate remained **18 passed / one failed, 19.48s** because native ESM
  `rmSync` cannot be spied on through its nonconfigurable namespace. This failed
  before the first evaluator dispatch. The observation helper is being changed
  to transparent call-through; product behavior and actual removal stay intact.
- The next native observation returned **ENOTEMPTY** from recursive removal
  (18 passed / one failed, 21.63s), not the hypothesized EACCES/EPERM. The test
  now admits that observed parent-directory error only together with bounded
  proof of an owned nonwritable descendant; no arbitrary cleanup failure is
  silently accepted. The next-generation assertion remains required.

The final gates cover **204 tests across ten files**. The build passed, and the
new acceptance source passed strict TypeScript and scoped lint. Source was held
fixed throughout native testing; corrections affected only test observation and
its expectations of preexisting best-effort cleanup. There were no provider
calls, quota changes, GitHub Actions, resident activation or public deployment.

## Integration verification

Implementation commit `9d09e2a01cc066a9c7f355fd8c1f99c27cd56d4e`
was integrated onto `auto/p00` as
`c78bbea917ec54fadc424679135014670afe5b25`. The primary rebuild passed.
The complete focused gate then passed **204 tests, ten files, zero skips,
25.74s** on that integration source. Documentation, lane classification, driver
lint and diff checks also passed. No native test process remains active.
Subsequent handoff changes affect documentation and the explicit diagnostic
driver, not the runtime or tests verified by this gate.

## Separate native baseline attempt

The retained full-success capture driver stopped at preflight after 67ms:
the real global KILL switch was healthy and active. No evaluator was dispatched,
no provider was contacted, and the switch was neither cleared nor redirected.
The failed attempt remains in the private `ashlr-preparation-full-capture.BvfQ68`
evidence directory. The driver now labels active/unavailable KILL separately
without exposing raw errors. It was not retried.

## Remaining end-state work

Full-success retained capture, three repeatable frozen baseline vectors, a
separate trusted scoring builtin, full selected-candidate mutation controls,
exact target-only delivery, account commissioning and resident service activation
remain separate milestones. This is a restart-safety repair, not a claim of
accepted self-improvement, production publication, or a running autonomous firm.
Automatic reclamation of settled, protected fixture scratch is also not provided;
long-running operation still needs a separately verified storage lifecycle.
