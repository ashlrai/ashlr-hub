# Installed scoring runtime

Goal: connect qualified candidate execution to a fixed calibrated scoring route,
so the autonomous loop can select verified improvements rather than diagnostic
or self-reported success. This is a dependency of the full Ashlrverse goal.

Base: qualification candidate c1749a1f, not yet integrated. Its native gate41730
runs in a different worktree; never modify that worktree's installed assets.

- [x] Explore reusable workload boundaries, lifecycle effects and build identities.
- [x] Extract shared workload execution without changing its operations, counts,
  confinement, diagnostics or original deadline. One outer completion/output.
- [ ] Verify extraction, then add closed scoring selection and fixed calibration
  packaging before freezing any baseline measurement bytes.
- [ ] Obtain three real matching v2 baseline captures and retain reviewed data.
- [ ] Verify scoring, target-only scope, all15 regional nonregression conditions,
  worker/evaluation budget support, accepted improvement and integrated delivery.

## Ownership

Runtime agent owns source-only workload extraction, existing diagnostic entry and
builder adjustments. Parent owns integration and verification; other agents review
and add separate bounded tests only after the runtime interface is explicit.

## Constraints

Keep nine installed files and exact command semantics. No invented calibration,
provider calls, real stop-switch overrides, account changes, GitHub Actions or
release publication. Current ordinary worker trials remain15minutes; longer
diagnostic capture does not imply longer scored trial capability.

## Status

Extraction is implemented in this isolated worktree, pending independent review.
The five-file focused gate passed 69 tests, zero skipped, in 18.10 seconds.
Full build passed, and importing the installed entry with Node started no workload
and exposed both the shared workload and diagnostic adapter. Packaging retains
nine installed files. These are lifecycle/packaging checks, not a full positive
native execution of the extracted bundle, a calibrated score or accepted source.

The scoring design will import the shared workload from an immutable nested copy
of the exact nine-file measurement bundle and its manifest. Calibration pins that
measurement identity; a separate score identity pins the entry, calibration and
nested bundle. One outer activity and original wall/monotonic deadline remain
authoritative. Finish scoring-capable bytes before obtaining baseline captures.

A separate trial-budget increment remains needed: explicit worker phase allowance
within a whole-trial deadline for the future closed scoring route, preserving
legacy semantics when omitted. No such budget or scoring selection exists yet.
