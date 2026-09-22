# Qualification findings

- At exploration start, measurement main owned one builtin activity, output19 checks for
  preparation-workflows-v1, and calls activity.complete only after evaluate.
- Existing standalone tests already exercise controlled runtime/source mutations
  at a particular trusted broker request; the old installed workload mutated
  only between completed requests. V2 now adds same-call qualification.
- The new path must qualify the same selected artifact, not compiled baseline
  alone, and keep candidate code confined to its process.
- Calibration and candidate comparison now exist; their v1 diagnostic semantics
  must not silently imply new during-call coverage.

## Implemented

V2 requires23 checks and two ordered, same-candidate qualification pairs.
Qualification counters remain outside the original15 benchmark regions. V1
remains strictly readable as historical evidence; mixed versions and incomplete
qualification cannot be compared as successes. CLI and capture views show version
and qualification state. Synthetic immutable-journal v2 CLI integration is tested.

The first native gate proved all4 mutation controls, but the combined workload
timed out at899969ms (full test908569ms). A separate new invocation uses the
explicitly supported30-minute diagnostic budget; no running deadline was renewed.
Ordinary worker-plus-evaluation trial ceiling remains15minutes, so longer
diagnostics do not imply longer autonomous scored trials.

Live partial profiling found5759 broker requests,5208 ACL calls(90.4%). Repeated
requests are not automatically redundant: source/capture freshness fences must
remain. Broader ACL batching would exceed current target-only optimization scope.

Before genuine baseline capture, finish the closed scoring route and reusable
workload/finalization split. Freeze measurement bytes, then capture three matching
v2 baselines. Package calibration as separate data pinning measurement identity;
scoring identity pins that data and measurement bundle, avoiding digest cycles.

## Accepted integration

Native41730 passed all5 cases, including full23 checks and current/stale controls.
The primary rebuild matches all recorded installed/native/target identities and
three host/test source files. Primary regression589/17files passed; selected
legacy native suite13 passed with2 full-success cases explicitly excluded. These
results do not establish repeatable retained baseline calibration or scoring.

Shared workload extraction is separately checkpointed as21343f3b in firm-scoring;
69 lifecycle/packaging/failure tests and independent review passed. It is not yet
integrated or natively accepted. Its next design preserves a nested immutable
nine-file diagnostic bundle and original manifest, one outer activity, and fixed
calibration identity. Explicit scored-trial phase budget support remains necessary.
