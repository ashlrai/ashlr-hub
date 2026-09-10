# Verified local handoff

## Continuation: allocation execution and general graph inspection

Implementation revision: `63d1c1016f59ae42528cb674d3f3bcc9fe77f891`, branch `auto/p00`.
Seven worker/reviewer roles across bounded waves; three cold reviews, maximum
four concurrent agents including parent. Parent alone committed and integrated.

- P03 adds general signed `firm graph` / `firm traces` CLI and SDK queries.
  Complete history verification precedes filtering; conflicts survive filtering;
  real CLI processes reject damaged signatures without exposing partial traces.
- P08 consumes signed allocation selections through separately enrolled runtime,
  pool and worker bindings. Existing reservations, quotas, reserves, access policy
  and replay identity are reused. Tests invoke real inert native/HTTP transports.
- Shared Git publication now observes KILL at its prepared transaction boundary.
  Recovery still records an exact previously published branch under active KILL.
- Runtime configuration is pinned at consumption. Effective absolute deadlines
  are also checked inside the actual resource ledger lock before reservation.
- Final affected resource/graph run: 179 passed (117 runtime, 39 adapter, 23 query).
- Final focused delivery run: 38 passed. Broader delivery/handoff run: 113 passed;
  these overlapping runs must not be added as independent coverage.
- Graph/demo/allocation/pool/package/release regression run: 201 passed across
  seven additional files. Together with the 179 and 38 runs, 418 distinct focused
  test cases passed; the broader 113-case delivery run is not added to that total.
- H1–H8: 449 passed, 5 skipped, unchanged suites. Core/web typecheck, production
  build, quiet whole-repository ESLint, docs and real-I/O membership checks passed.
- Compiled verify-safety: all five structural checks pass. Package plan: 48 valid
  nodes, 13 locally landed components, 35 planned; 16 existing-key signatures verify.
- Global KILL re-read as active/healthy and left unchanged. No actual provider
  dispatch, account changes, daemon activation, GitHub Actions or publication.
- Original checkout still points at `a01fc08663baab3039c4f1c084538de732a4fd0e`;
  its existing untracked workplans remain untouched. Entire is enabled in
  manual-commit mode on `auto/p00`; resume found no existing checkpoint.

Limits: P08 is an explicitly enrolled host API, not a connected resident firm;
allocation identity is not proof of account identity. Newly issued receipts do
not yet share cumulative hypothesis accounting. Native output limits are not
hard token/spend caps. Every completion remains independently unaccepted. Graph
effect adapters, cold model verification, resident ticks and commissioning remain.

Planning kept ownership and package receipts explicit; agent-building guidance
preserved the existing stack; documentation separates tested code from activation.

## Prior wave evidence (historical)

Implementation source: `307a55def0ec438ac6d24b9c3c187fb782551436`, plus the
subsequent resource-worker documentation and evidence ledger. Branch `auto/p00`.

- 11 locally integrated package artifacts: 10 code/test components, 1 inventory.
- 317 feature/package/real-CLI tests passed across 12 files.
- 449 H1–H8 tests passed; 5 skipped, unchanged safety suites.
- 1,005 UI tests passed across 58 files.
- 67 existing release-artifact contract tests passed.
- Full core/web typecheck, build, docs check, lint and real-I/O membership passed.
- `verify-safety --json`: all five structural checks passed in source and build.
- 48 graph-plan nodes validated; 12 existing-key merge signatures verified.
- Existing compiled activation roots, constitution, merge gate and safety tests
  unchanged from baseline. No self-diff suite was found under that literal name;
  H1–H8 and explicit protected-path diff checks are the checks actually run.
- Actual host global KILL is active. Compiled demo correctly withheld all work;
  the full accepted CLI fixture ran in test-owned homes with existing fixture keys.
- No provider/account changes, GitHub Actions, remote push, npm release, service
  activation or production deployment. The generated empty host-demo root was
  removed after confirming it held no records.
- Entire is enabled in manual-commit mode on `auto/p00`; resume found no prior
  checkpoint at start. No checkpoint ID was reported by the final status check.

At this prior checkpoint, the complete 48-package end state was not achieved;
37 packages were still planned. Use the current counts above and current
`artifacts/control-graph.json` for continuation.

Planning and agent-building skills kept work bounded within the existing runtime;
the engineering-documentation skill separated implemented, verified and activated
states and provided an evidence-led handoff.
