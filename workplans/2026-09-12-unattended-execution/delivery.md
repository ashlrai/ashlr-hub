# Successor admission: completed local increment

New automatic successors now check fresh quota eligibility before expensive source
verification or durable proposal intent publication. Unavailable capacity or an
unreadable sample is reconsidered by the existing poll inside the original deadline;
it consumes neither a proposal slot nor a worker request.

The read-only preflight and final transaction share the same fresh-only veto and
conservative observation merging. Cached ready quota cannot rescue a current
refusal. Account aliases, General/Spark scope rules, reserves, paused accounts,
occupancy and task caps retain existing policy. Final dispatch remains authoritative;
this does not make the sample-to-intent interval atomic or retry uncertain paid work.

## Evidence

- Source commit: 29f3e0551a04e9beca55984a6afea988749d065b, auto/p00.
- 395 distinct tests across 14 files passed, plus a repeated 24-case helper check.
- Real loopback acceptance: 3/3 passed, 315.70 seconds. One campaign delivers, quota
  denies follow-up without an intent, fresh evidence allows the successor, and its
  two generations deliver from the exact prior commit. Tests retain the original
  deadline, policies, five accounted receipts, seed context and restart no-replay.
- Independent implementation and acceptance review found no blocking findings.
- Source/test types, scoped lint, docs, lane classification and full clean build passed.
- Evaluator changed from 25d57874 to 9a051509; nine asset hashes verified. Bridge and
  fixture bundles changed. Prior exact-digest native qualification is historical,
  not transferred to the new bundle. Current structural/registry/lifecycle tests passed.
- Entire resume found no checkpoint on auto/p00; no restored checkpoint was relied on.

## Remaining operational gates

Run the current default builtin qualification against the rebuilt identity before
claiming exact-current native qualification; genuine three-capture calibration is
still a distinct requirement. No scoring package was commissioned in this increment.

At the fresh 2026-09-12T11:08:34Z read, the real global stop was healthy and active,
and the collector had a legacy v1 pending record without recoverable ownership
evidence. No cleanup or bypass was attempted. Actual Spark enrollment, preserved
personal General reservation and fresh account usage still require commissioning.

No provider was contacted, real account policy changed, fleet activated, remote
branch pushed or package/site published. This completes the successor preflight
increment, not the whole autonomous-company vision.
