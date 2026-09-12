# Installed full-workflow measurement

Baseline: 948a7fa4cde76002b6029b61f588127e3f70c42e, clean auto/p00.
Entire resume: no checkpoint. Original working checkout is preserved.

Explore findings: fixed candidate-linked workflow graph already supports manager
open/check/replay/close, ordinary full bundle and successor check/metadata/full
bundle. Installed entry still performs only check/metadata on two file counts.
Real fixture builders live under test/helpers but contain no Vitest code.

Critical integration requirements: successor fixture setup actually runs a
command-only upstream campaign; its detached worker/evaluator groups currently
bypass builtin activity tracking. These must be tracked and fully settled before
the installed harness can honestly claim closure. Existing110s invocation budget
cannot fit300s workflow sessions. Declare the full deadline upfront; never renew.
Fixture setup counts must remain separate from candidate workload measurements.

Errors during exploration: an unmatched example glob and a guessed filename
failed harmlessly. Replaced guesses with rg file/path discovery.

Implemented: separate fixed fixture bundle with exact verify-commands import
interception. Detached command workers/evaluators receive confirmed group
settlement, shared abort and minimum caller/original remaining deadline. Direct
delivery Git is not detached and remains in the owned controller group; it also
receives cancellation and the original monotonic cutoff. This is not a complete
OS process census. Successor setup executes no model/provider requests.

Independent review corrected manifest ordering and poisoned swallowed resolved
command failures; it also required abort/deadline propagation into source
delivery. Scope closure drains pending runner promises before releasing setup.
The activity bound is explicitly8192, enough for the previously observed4361
healthy workflow operations plus other workload activity, subject to actual test.
No timeout is renewed per operation; the explicit installed allowance is900s.

First focused gate:72 tests across4 suites, zero skips,8.35s. This covers fixed
build graphs, byte determinism, registry integrity,24 activity cases and19 pure
fixture ownership cases. Full build passed. Native installed acceptance is now
running separately and serialized; earlier standalone timings exclude the
growing activity-journal cost, so budget viability is not yet assumed.

Static release checks: full lint passes with0 errors and107 existing warnings;
lane guard330 real-IO/682 unit. Source build, web typecheck and strict compilation
of all changed test entrypoints pass. Docs check115 local/31 source/36 external
links,0 network requests,0 errors. Local npm dry-run includes all8 fixed code
files plusmanifest; compressedsize12,619,555 bytes at this uncommitted build.
No package is published. None of these replaces the running installed test.

First installed gate found a real budget mismatch: manager completed with1774
validated broker operations (14 blob), successor check/metadata succeeded, but
the full-bundle read exhausted the300s child deadline. The invocation settled
all4481 recorded groups and returned checksPassed:false at17 checks. No result
was accepted. A redundant post-settlement full run was explicitly stopped with
SIGTERM to its freshly verified owned controller; cancellation then passed.
That initial suite ended13passed/2failed in681.76s, not a green acceptance run.

Correction: workflow child sessions now receive the remaining ORIGINAL900s
invocation allowance, with a shared900s protocol ceiling. Defaults remain60s,
individual tools30s, and no call can renew the outerdeadline. Add fixed internal
checkpoint text to installed failure diagnostics without exposing candidate
exceptions or private paths. Rebuild and full rerun required. A documentation
patch with an obsolete context line failed harmlessly and was reapplied narrowly.

Rebuild passed. Fresh serial gate (exec session52945) includes installed evaluator,
deadline, readonly grammar, protocol, fixture runtime, activity, registry,
workflow build graph and legacy standalone measurement suites. Do not rebuild
or edit evaluator/runtime source while this gate runs. Poll this same session;
do not restart because an observation times out. Current code is uncommitted.

Next candidate artifacts remain unapplied. Independent review found that the
first draft's per-blob payload guard lost Node's combined stdout/stderr buffer
limit. The revised artifact leaves the old helper unchanged, keeps single-file
reads on that path, and falls back to the entire original sorted sequence only
after a normally exited batch with warnings or an ordinary command failure.
Transport errors and malformed clean frames refuse without retry. A second
source review found no discrepancy with that policy. The parent reran the pure
artifact suite: 33 tests passed with zero skips in363ms. These extract the actual
patch helper and use fake subprocess calls plus the real parser; they do not
replace native compatibility or installed candidate measurement. The first
author run hit a test timeout while deep-comparing an8MiB Buffer; asserting the
same returned buffer identity and length avoided that assertion cost without
changing the timeout. No speedup is yet measured.
Broader OS census/crash recovery should not become blanket prerequisites for a
narrowly proven non-caching optimization.

Read-only throughput review found seven full activity-directory guards per
spawned group. Each currently sorts and serializes actual and expected names,
so aggregate name processing grows quadratically (with sorting overhead), not
linearly. This is source-derived complexity, not measured wall-time attribution.
A separate later candidate could use exact bounded set membership at every
existing guard, retaining all directory/owner reads, publication durability and
settlement checks. Do not modify this while acceptance runs or infer a speedup.

Latest static recheck after the artifact suite: full lint passes with0 errors,
107 existing warnings; lane guard330 real-IO/683 unit. Docs check passes with
115 local,31 source and36 external links and0 external requests. Live gate52945
continues against the unchanged installed build; the original checkout's
existing untracked workplans remain untouched.

Fresh gate progress: the FIRST full installed baseline completed all19 checks
and its independent group-absence assertions, then the repeatability test
started its second invocation. First private scratch22Owod has4,873 prepared
and4,873 settled activities plus complete.json. The next scratch is iNcUFr.
This is progress within the running test, not a completed nine-suite gate.
Session52945 remains the only native suite to resume; do not restart it or rebuild.
Source/web typechecks passed again after the pure artifact test was added.

Next continuation: three agents prepared and independently reviewed two new
native suites without running them. The parent added whole-project no-emit
typechecking with the actual privately patched source and an equality assertion
preventing a baseline-only compile. Strict selected TypeScript, scoped ESLint
and lane classification pass (332 real-IO/683 unit). The active52945 run retains
its explicit nine files and unchanged evaluator/runtime/build; classification
of the two new files does not change that already-collected selection.

Queued next command, ONLY after52945 is terminal:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH ASHLR_PREPARATION_BATCH_REPORT=1 npm run test:serial -- test/preparation-batch-candidate-acceptance.test.ts test/preparation-batch-node-boundary.test.ts test/preparation-batch-candidate.test.ts test/universe-seed-batch.test.ts --reporter=verbose
```

Recovered evidence from completed scratch22Owod: broker exchanges reconstruct
298 healthy leaf operations,1,774 manager operations/14 blobs and2,756 successor
operations/24 blobs. Workflow sum4,530/38. Every counted execution joined a
successful broker reply. Aggregate session counts are directly reconstructable;
per-call attribution uses request-file timestamps, not a persisted result
envelope. Complete activity record count4,873 comprises4 candidate and4,869 tool
groups; four tools beyond the4,865 mailbox exchanges are consistent with fixture
setup but that attribution is inferred. No persisted final stdout report was
found. These are recovered diagnostics, not a frozen reward or acceptance receipt.

Exploration errors: a guessed parser-test filename and an unmatched shell glob
failed without mutation; rg located test/universe-seed-batch.test.ts instead.

Fresh gate now reports the repeated installed baseline test PASSED in
1,229.983s: both complete19-check invocations have identical metrics/workflow
ledgers and confirmed group absence. Session52945 is still active for the
remaining corruption, post-settlement drift, cancellation and regression tests.

The installed manager-poison control also passed in57.350s, along with all
prelaunch artifact/mode/abort/deadline controls. The copied-bundle post-settlement
test is now executing its full workload; the original52945 handle remains live.
Final static check after both new tests: full lint0 errors/107 existing warnings,
332 real-I/O/683 unit classifications, and documentation check all pass.

Post-settlement installed controller drift passed in609.789s; cancellation after
real candidate registration passed in3.560s. The same52945 session continues
through its other selected suites; no test restart or runtime rebuild occurred.

Parallel inspector: 51 pure decoder/summary tests and43 mocked descriptor-reader
CLI tests passed together (94 total, zero skips,372ms). Two independent reviews
confirmed current schema/counter handling and bounded read-only file handling.
The public route is intentionally deferred until52945 is terminal. Ten actual
filesystem route tests are authored, statically checked and unrun. Unknown
totals remain null, blob counts stay subsets, and fixed diagnostic codes replace
private raw messages. This is not a scoring or acceptance adapter.

Session52945 completed successfully:226 tests, nine suites, zero skips,
2,043.92s. After terminal settlement, parent wired the inspector lazy route and
classified its ten real-filesystem tests. Agent CLI/help regressions passed48
cases in390ms. Fresh source/web typechecks pass. Native session4737 is now the
only active test gate: candidate acceptance, Node boundaries, pure patch tests,
seed parser, real-file inspector, pure report parser and mocked descriptor CLI.
The actual candidate fixture now includes both repeated and distinct blob OIDs.

Native gate4737 finished166 passed/1 failed (seven suites,74.57s). All ten actual
filesystem inspector cases, six Node boundaries, seed parser and pure inspector/
patch cases passed. Candidate healthy outputs and during-call drift passed, but
its four-file blob count was10 instead of2 (baseline8): the candidate apparently
falls back after every batch. Do not weaken the expected improvement or apply
the patch. Investigate actual batch transport/results with test-only diagnostics.

Diagnostic rerun6162 confirmed exit0 and no transport error, but every batch
carried the Apple Git launcher's xcrun cache-write denial. The original strict
assertion failed again (70.55s). No sandbox policy, native launcher or candidate
warning handling was changed. Local xcrun manpage says --no-cache refreshes the
cache; it is not established as a no-write remedy and was not enabled.

Independent review approved separate compatibility/accounting regression and
strict numerical acceptance. Default regression derives2/6/10 blob calls from
each healthy call's two actual batch status/stderr results; no drift batches are
used to justify healthy counts. Strict ASHLR_REQUIRE_BATCH_IMPROVEMENT=1 retains
the original2blob/six-fewer target for both calls. Final19441 passed215 tests,
nine suites, zero skips,74.49s, reporting improvementAccepted:false. Counts:
baseline36/2,42/8,117/8; candidate36/2,44/10,119/10. Candidate SHA-256
34a167c4dc5652f8d45ec73b54c76fba8903f1845c4cd3a77e32c999ea49e22f;
patch SHA-256cba265abf76073b5c266219f83d696e72349d7407d5468513f1c36b50922fc05.

Full build and source/web typechecks passed, docs116local/31source/36external
links (zero external requests), full lint zero errors/107 existing warnings,
scoped final lint clean. Actual built inspector help works. Package dry-run
includes all expected files; no npm publication, GitHub Actions, remote push,
provider calls or service activation. Entire remains enabled/manual-commit with
no checkpoint restored. Original checkout state remains preserved.
