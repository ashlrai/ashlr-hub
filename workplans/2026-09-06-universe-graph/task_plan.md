# Universe evidence graph

## Goal

Make Universe's actual experiment, lineage, evaluation, campaign, and delivery relationships queryable and useful to engineers and agents, optimizing verified engineering yield. Complete and verify a scoped end-to-end graph increment without claiming completion of the whole operating system.

## Phases

- [x] Recover source, prior handoff, current branch and memory; dispatch three independent discovery agents.
- [x] Map existing graph and Universe patterns; settle the smallest useful graph contract.
- [x] Implement core graph analysis, CLI/API and usable console inspection in independent work streams.
- [ ] Independently test malformed/missing evidence, bounded traversal, real local state and installed package.
- [ ] Commit/push reviewed changes, verify source state and hand off exact results and remaining gaps.

## Decisions and constraints

- Preserve the original dirty Desktop checkout; work in the clean existing Universe worktree on a new codex branch.
- Local-only validation; do not enable or use GitHub Actions.
- Prefer a derived graph over a second mutable source of truth. Confirm this against discovery and user direction before significant architecture changes.
- No new graph database, provider credentials, remote execution, native-service activation or invented business-value measurements.
- Documentation and evidence must distinguish graph consistency from current artifact verification and from acceptance of a production change.

## Questions

1. Which graph relationships can be proven from existing persisted records, and which are currently only assumptions?
2. Which graph query most improves operator and agent decisions without changing execution authority?
3. How do bounds and damaged records affect completeness and confidence?

## Errors

- Independent review found incomplete relation closure at a traversal depth boundary, undetected cycles, active-run projection mismatch, missing campaign inventory treated as empty, and inconsistent incomplete counts. All fixed with regression cases.
- Root API test initially returned a mock from beforeEach (interpreted by Vitest as cleanup) and expected fallthrough rather than the existing 404 handler. Corrected the harness; all 13 API tests pass.
- TypeScript exposed closure narrowing after adding provenance fields. Capturing validated manifest/comparator digests fixed it; root/web typechecks now pass.

## Status

Source frozen after independent review. 473 unique Universe-related checks (465 broad plus 8 builder cases), 210 web tests, 449 invariants (5 existing skips), full typecheck and lint passed. Exact clean package acceptance and source promotion remain in progress. No second database, source-of-truth migration, or execution-authority change.
