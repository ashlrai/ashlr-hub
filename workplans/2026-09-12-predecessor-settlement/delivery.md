# Predecessor completion evidence — September 12, 2026

## Delivered locally

Source implementation: `f5742544f438ab1790bb86e72c2aeeb7e910ed1e`.
Built source: `af624cc4f4f4df9875a254a4b110a8352f22970f`, branch `auto/p00`,
clean build identity, package version 3.4.0. Parent integrated three parallel
agent workstreams and independent review. The original dirty checkout was not edited.

`resources pool engineering predecessor check` is a real read-only CLI over
the same setup, queue, graph, evaluated-delivery and resource-ledger records used
by execution. It requires the original plan digest and persisted deadline,
identifies a unique delivered successor tip, and preserves explicit stop output.
Generation/proposal receipt mismatches, incomplete admission, ambiguous lineage,
retained execution ownership or unresolved evaluator custody withhold the result.
Existing console execution uses the extracted shared validators/readers; it has
not been replaced by an independent scheduler.

`verified` is historical evidence, not an atomic seal, renewed allowance or
dispatch authority. No provider requests, account/reserve changes, collector
recovery, global-stop clearing, daemon installation, GitHub Actions, remote push,
site deployment or npm publication were performed.

## Verification

- Parent focused regression: **311 tests passed across 10 files**.
  `19696`:63 tests/3 files,3.53s. `56680`:248 tests/7 files,68.71s.
  This includes real private-state/restart and Git tests plus explicitly mocked
  adversarial join and CLI tests. It is not 311 live-provider tests.
- `39372`, `28782`, agent strict test imports: types, changed-source/test lint,
  and diff checks passed. Source CLI help and rejection of `--execute` passed.
- `99271`: full local build passed,257 web modules. Compiled CLI help passed;
  `dist/build-identity.json` reports the built source above with `dirty:false`.
- Installed `preparation-measurement-v1` bundle inspected successfully,9 files,
  digest `06fe700ea4a3e34bbe578c645bc3232251b2ed9811edf7a4f6eb4d2b8c110c7d`.
  Prior native qualification does **not** transfer to this changed bundle.

### Real fixture evidence and incomplete encompassing test

The private loopback setup fixture produced four generations, one successor
proposal, two evaluated local branches and five completed resource receipts.
These are actual local CLI/Git/evaluator operations with fixture responses,
not authenticated model-provider or production work.

1. Diagnostic `59071` delivered both campaigns by215.21s and passed direct
   predecessor assertions. Added synchronous inspection delayed restart beyond
   the encompassing360s test timeout. It failed; it is not counted as passed.
2. Revised `78819` moved offline inspection after the original restart/replay
   path. That path finished by246.66s; direct predecessor proof passed in98.074s.
   The outer run then exited143 during the CLI assertion with no final Vitest
   result. Cause remains unverified; no surviving fixture worker was observed,
   and existing evaluator-custody readers reported settled work. The unselected
   legacy case was filtered, not passed. No effect deadline was changed.
3. Supplemental isolated CLI `28249` exited0 with no signal/error/stderr in
   **114.041s**. It verified the exact delivered tip and left all240 fixture
   entries and4 original private HOME entries unchanged. The original signing
   context was validated against both existing completed graph journals.
4. Supplemental control `31390` exited0 in146.871s. Removing exactly one real
   generation receipt returned `held`/`completion-evidence-unavailable` in36.982s,
   without further changes. Restoring exact original bytes restored the same
   verified evidence digest and tip in109.219s. Only the ledger's timestamps
   changed from the deliberate write/restore. The fixture remains retained.

The new read-only CLI test child bound is180s because its measured114s runtime
exceeds the originally copied90s bound. The encompassing test now allows900s
for added offline controls; original setup CLI90s and console execution360s
bounds remain unchanged. A complete green rerun of the encompassing Vitest case
is still outstanding. Supplemental assertions do not erase that limitation.

## Next work

Inspection is synchronous and too slow for a live event loop. Reuse verified
metadata within each independent sample, retaining final source and receipt
checks; the static call-count opportunity is documented in notes.md, not claimed
as a measured speedup. Then implement the standing-mission owner that consumes
this evidence, performs an accounted next-objective proposal and publishes the
next scoped setup under its retained mission lease and resource policy. Human
per-objective queue actions are not part of that intended loop.

Account commissioning, always-on service operation, full native qualification
and public production delivery remain separate unfinished work. Entire reports
enabled/manual-commit on `auto/p00`; initial resume found no checkpoint.
