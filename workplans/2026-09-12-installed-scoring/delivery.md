# Scoring runtime checkpoint — September 12, 2026

## Implemented, not commissioned

Primary integration update: the tested source corrections are now integrated
locally on `auto/p00` at `f16acb0708a1a3b7016c069fab8abbbb21b4b38b`, preserving
the previous primary qualification notes. The full build and source/web types,
full lint (zero errors;107warnings), docs and lane checks pass. Primary runtime
identity is `25d5787412e177238745216d259a9167768ca6460bfed126cc453eb714d0f953`.
Extended native/regression gate73003 is still live; it includes actual repeated
workloads and post-settlement drift/cancellation controls, not just fast unit
tests. Primary source and dist must remain frozen until that handle settles.

The latest strict optimization comparison passed independently on the matching
isolated target; exact records are in `rebased-candidate-comparison.json`.
Neither this source integration nor its diagnostic comparison commissions the
scorer or fleet. The older console ports57294/56322 are not listening; a fresh
compiled stop check remains healthy/active. Real configuration paths still need
to be established. The following sections preserve earlier checkpoint evidence
and must not be read as a claim that older build identities qualify this one.

The candidate branch `codex/preparation-scoring-runtime` now contains the closed
calibrated scoring route, fixed installed owner, explicit authoring package,
regional nonregression/scope checks and optional separate worker budget. The
workspace inspector displays that budget. Ordinary builds do not install the
scoring package, and no real calibration or accepted improvement is claimed.

The scoring and first-candidate delivery increment is committed locally at
`3ba66add`; the subsequent compiler gate has passed local verification in this isolated
worktree. Primary `auto/p00` remains at `b3abe997` with its earlier
qualification increment. Neither checkout has been pushed or deployed here.

Current source: `/Users/masonwyatt/.codex/worktrees/ashlr-hub/firm-scoring`,
Compiler source was checkpointed at `d44c9911`; full-source capture support at
`782aed2e`; closed recipe support and its rebased candidate are integrated at
`f0606832`. The combined build has diagnostic identity
`3a711953b85b5c3b51435743a5ddb0a9fcabf871a22f2087e53a7265d16c72b5` and is not yet
qualified. Its native gate is live on handle10612. The preceding4937844f... bundle
passed all five native cases and is preserved at
`/Users/masonwyatt/.codex/artifacts/ashlr-preparation-runtime-pin.HJhKaA/preparation`;
its receipt is `rebuilt-bundle-qualification.json`. The still-earlier460b5f...
qualified bundle remains separately preserved in the earlier backup.

## Verification

- Combined regression: 806 tests / 24 files / zero skipped, 47.51 seconds.
- Additional runner/model/campaign/integration: 129 / 6 / zero skipped, 45.99 seconds.
- Browser data and inspector: 54 / 2 / zero skipped, 721 ms.
- Final package/scorer/budget/registry rerun: 183 / 4 / zero skipped, 2.05 seconds.
  This overlaps the combined gate; do not add these counts as unique tests.
- Source and web TypeScript checks passed. Lane classification passed:
  339 real-IO and 701 unit files. Full lint previously passed with 107 existing
  warnings; final edited package/driver scoped lint and syntax passed.
- Package-owner success and refusal tests use explicitly synthetic measurements.
  They prove integration behavior, not genuine calibrated native execution.
- September12 continuation: first-candidate improvement over a passed measured
  seed now has its own provenance proof. Existing failed repair opt-in and null
  archive lineage remain unchanged. Parent Node24 gate passed71tests/4files,
  zero skipped,36.00seconds. It includes a real generic worker/evaluator/campaign
  and local branch/replay test (4333ms), nine synthetic-score/private-Git cases,
  37 pure proof cases and24 driver safety cases. Existing delivery/repair gate
  passed33tests/2files/zero skipped,99.08seconds. Source/web types, docs and lane
  checks passed. Lane inventory is now341 real-IO and703 unit files.

## Completed native acceptance

Session `87267` is TERMINAL exit0: all five cases passed, zero skipped,
1258.55seconds, observed September12 at09:02:56UTC. The full workload
passed23checks/two qualifications/15regions,4828 benchmark processes, with
confirmed process settlement; its report SHA matches the prior qualified report.
The separate runtime-current/runtime-stale/source-current/source-stale controls
passed34108/29370/189611/64556ms. Do not poll or restart the terminal handle.
The exact installed aggregate is
`460b5fd4191872533b4fe9c84a464f2d67b6f14a574979481e4dc7eb0e857547`;
full identities are in `bundle-identity.json`. This run proves only the extracted
diagnostic workload, not a scoring package, real baseline or candidate delivery.
Subsequent campaign source changes are embedded in a rebuilt diagnostic bridge
and fixture asset; the old result does not qualify a new build identity.

## Remaining commissioning sequence

1. Compiler source/package verification is complete: parent Node24 gate passed
   241 tests across six files, zero skipped,11.19seconds. Full local build passed;
   source/web types, scoped lint, docs and lane classification passed. The package
   tests exercise real tiny-project compiler subprocesses, not the full native
   workload. Actual full-project authoring/closed compilation passed separately.
2. Qualify the exact combined diagnostic bytes, then retain the result separately
   from the older qualified bundles. Native handle15864 is terminal5/5passed;
   current handle10612 tests the new3a711953... bytes. Full-project
   packaged compiler acceptance has now passed2/2: baseline5900ms and TS2322
   refusal5926ms within60seconds and a1-GiB V8 heap, with independently confirmed
   process absence. This test packages synthetic calibration solely to exercise
   the compiler; it does not produce a genuine score or usable calibration.
3. Resolve the real global stop through the operator; never bypass it. The latest
   read-only check found healthy/active/present. The prior attempt retained only
   a preflight failure, not usable capture data.
4. Finish combined-build qualification and strict rebased candidate acceptance
   before collecting a Hub-deliverable calibration. Recipe600c099c is now
   integrated asf0606832. The changed target and import graph need their own
   evidence;4937844f... results cannot qualify the new build. A private
   one-file calibration cannot be reused for a full
   Hub seed. After resolving the real stop, run
   `run-calibration.mjs` only against an explicitly empty private
   evidence root and a fixed original deadline. It has NOT been executed. It
   obtains three distinct matching v2 captures in one Universe, retains failures,
   and only then calls the existing calibration API. No automatic retries.
   For Hub delivery use the explicit trailing `--seed source-repository` option.
   It selects only this checkout at its pinned HEAD, requires matching raw tracked
   bytes/index and safe effective Git configuration, and proves the materialized
   full seed before capture. It never recursively snapshots the live checkout or
   invokes working-tree clean/process filters. Omission preserves the private
   one-file diagnostic mode. Evidence must be outside the source repository.
5. Author the calibrated package from those genuine captures; prove a native
   baseline, target-only accepted improvement, and integrated delivery.

The existing executable path does not need another scheduler:

- Author through `buildPreparationScoringBuiltin({ measurementDirectory,
  capture: { root, universeId, captureIds, expectedSourceDigest } })` exported
  from `scripts/build-preparation-score.mjs`. This production helper reads real
  capture records and installs the fixed package; the lower-level synthetic
  package helper is not a commissioning substitute.
- Prepare with `resources pool engineering prepare --check --json`, then the
  same explicit options without `--check` and with `--expected-plan-digest`.
  The recipe fixes scope, workers, original deadlines and a new local branch.
- Use the prepared report's `consoleArguments.automatic` for a self-contained
  quota-aware run. It starts the shared collector and the pinned supervision
  queue. A bare `universe campaign run --resource-runtime ...` does not start
  that collector: prepared quota runtimes require `shared-collector` mode and
  otherwise hold on missing/stale quota evidence.
- A measured passing seed followed by a strictly better changed candidate may
  create the planned local branch. Equality is not improvement. Local branch
  delivery is distinct from integration, remote publication and deployment.

Independent recipe review found a further pre-dispatch gap: the calibrated
immutable inventory can differ from the seed materialized by Git when replacement
objects are present. The score later refuses the mismatch, but preparation must
refuse before making the work eligible. A narrow retained-seed identity check is
implemented and tested in `firm-builtin-recipes`, outside the frozen native run.
It checks the actual retained artifact before campaign/catalog creation and on
replay, while preserving valid target-only successors and legacy command pins.
Primary integration and commissioning must include that correction.

Compiler authoring review found a related source-provenance gap: checking only
the target hash allowed already-weakened reverse consumers or configuration to
enter the frozen compiler graph. The isolated correction requires the genuine
full inventory on the production authoring path, validates every calibrated
file's bytes/size/mode/identity before and after capture, and refuses untracked
compiler source/configuration outside the separately trusted dependency tree.
The regression demonstrates actual false compiler acceptance without the new
inventory binding and refusal with it. Both corrections passed independent review
and the parent combined131tests/6files/zero skipped56.06seconds. Source types,
scoped lint, documentation and diff checks passed. They are not yet part of the
frozen3a711953... bundle being qualified by10612.

Corrections are committed locally as
`8e448d831c7ed1cfbac9ec5b477a087a0147d74f` on
`codex/preparation-builtin-recipes`; that worktree is clean. Packaging now asserts
the production full-inventory argument and passed52/52, zero skipped,8.83seconds.
Initial isolated attempts failed before exercising that contract because compiled
modules were absent, then because the root dependency symlink violated canonical
compiler-path requirements. The parent emitted TypeScript only into the isolated
tree and replaced only its development dependency link with a local TypeScript
copy plus links to the other existing dependencies. Main dependencies and frozen
dist were unchanged. The final rerun is the passing evidence; earlier failures
are not represented as passes. Source/web types, scoped lint, docs and lane checks
passed (343real-IO/705unit in the isolated tree).

The optimization artifact is rebased again onto target blob
`c0fa8821cc81e73ef9cc03d006cbffc08f8c6933`;33pure tests, scratch apply/reverse and
full-project selected-source compilation passed (725roots/1041files/no diagnostics).
Patch SHA is `ab53b036e471081ea638a200b7b336724fc116b09135fe634e6b53f7e83ed615`;
candidate SHA is `e0781f818bf3c34d51c21a358c1204a11b9242ceff0015c24ef898c2dc5041b7`.
The strict31973 result below applies to the preceding59a46145... target, not this
new rebase. Its native comparison remains pending; it has not been applied to
production source or accepted through a calibrated campaign.

Independent review corrected inherited Git environment overrides, directory
fsync for evidence publication, and a final stop/deadline check after calibration
publication. Driver syntax/lint pass, but its native end-to-end flow is untested.

No autonomous provider calls, account allocation changes,
KILL overrides, resident fleet activation, GitHub Actions, remote publication,
or production deployment were performed by this implementation packet.

Latest combined verification:397tests/12files/zero skipped59.29seconds, full local
build, docs/lane checks. Full-project packaged compiler rerun passed2/2,25.93s;
actual baseline6121ms and TS2322 refusal6035ms, both independently settled under
the existing60-second/1-GiB V8 heap limits. The target source SHA is
9452a70b39bb3f9afcc3160b3c30044a2656438fc54976476fa2fe3adb2090a5.
Strict rebased candidate comparison31973 is terminal exit0:1/1 passed, zero
skipped,75.95seconds (test68.278seconds). Four-file check and metadata each reduced
blob launches from8 to2 and total broker launches by exactly6; one-file results
and its2blob launches were unchanged. Exact results, ledger accounting,
same-child drift refusal and confirmed close passed. The optional raw-report
flag was not enabled, so absolute total broker counts and a fresh Git digest
were not retained; do not substitute historical values. This private native
comparison is not a calibrated accepted campaign or local Hub branch delivery.
The broader five-case gate10612 remains live; no repeat was started.
