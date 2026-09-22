# Installed controller integration findings

Baseline: f00b4f01c44ab9b44e9f7e7c0eaeda377310d3f8, clean auto/p00.

- `runFixedUniverseEvaluator` is shared by ordinary trials, seed measurement
  and integration evaluation. Legacy commands remain sandboxed.
- Digest-pinned arbitrary seed code is not trusted host code. New host execution
  is limited to the installed `preparation-measurement-v1` registry entry, with
  no manifest-supplied module path, environment, executable or profile.
- Builtin identity binds all installed code and native tool bytes into the
  comparator. Rebuild/change requires new registration; no automatic adoption.
- A controller process-group receipt excludes separately detached candidates.
  Durable prepare/spawn/settle records plus independent absence checks are
  required before aggregate settlement. Missing/staging/live/unknown records
  remain unresolved and are preserved, never inferred from controller exit.
- Readonly tool workers preserve binary Git output while their whole process
  groups use the existing asynchronous owner. A shorter bounded child grace
  leaves time for the controller to drain before the host escalates.
- Preparation recipes currently construct command evaluators; supporting a
  builtin manifest does not silently enable it in resource preparation recipes.
- The benchmark still lacks full manager/successor coverage, candidate-aware
  module substitution through those paths, a frozen reward and an accepted real
  optimization. This increment must not claim any of those.

Regression diagnosis: the first expanded run passed 219/220 checks. The legacy
outer-sandbox test emitted Apple Git xcrun-cache warnings outside writable scratch.
Propagating scratch TMPDIR alone did not fix it. Standalone fixture setup now
retains its original PATH Git; validated installed activity always selects pinned
`/usr/bin/git`, and candidate readonly tools always remain fixed. The original
empty-stderr and exact nested-refusal assertions pass unchanged. No sandbox grant
was widened. Strict selected-test compilation also exposed and fixed a test-only
PID field inference that excluded the undefined spawn-error case.

Packaging review found two additional integration obligations: the portable
root-files declaration must admit the three exact host-helper files, and release
manifests must hash them. Both now use an explicit optional all-or-none set,
preserve legacy packages with no helpers, and reject broad script declarations.
The complete local build then passed. Independent review found no unsafe
widening in these changes.

The 18-suite run covered 433 tests: 431 passed and two test-harness issues were
confirmed. The package-launch test requires npm_execpath, omitted by direct
Vitest invocation; its suite is rerun via npm run test:serial. The seed fixture
used separate start/deadline clock reads and crossed a millisecond boundary,
correctly triggering 'Campaign deadline cannot be reset on resume'. Its deadline
now derives from the exact same start instant. Production deadline guards and
cancellation semantics are unchanged. The two full affected suites are rerun,
not just their previously failing cases.

Rerun result: all 93 tests in both affected files passed in 106.12s, zero skips.
Together with the sixteen passing combined-run suites, this covers 433 distinct
tests. The local npm pack dry-run includes all eleven required installed bundle,
manifest and host-helper files. Build and compiled registry resolution pass.

Exploration path correction: there is no `resources/engineering-verification.ts`
or `universe/manifest.ts`; the relevant contracts live in engineering-preparation,
types and store. One multi-file patch was refused atomically due to stale context;
the current file was read before applying smaller exact-context patches.
