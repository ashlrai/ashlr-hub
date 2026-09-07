# Universe commissioning and supported release path

## Goal

Advance the existing agent-native engineering runtime from separately verified
components to a documented, useful real-execution path and reviewed release.

## Phases

- [x] Inspect runtime, release state and canonical documentation in parallel.
- [x] Select and implement the highest-value bounded operational gap.
- [x] Verify source and actual execution at the appropriate scope.
- [ ] Verify the installed artifact, publish reviewed source where supported and record exact state.

## Constraints

- Keep GitHub Actions disabled; run verification locally.
- Preserve original dirty checkout and independently useful federated products.
- Reuse the established non-eve runtime; no framework migration or new billing.
- Do not infer actual model yield or deployment from source or synthetic tests.
- Resolve exact resources before activation; no credential changes, account-limit
  bypass, unrelated provider calls, public data exposure or global service changes.

## Questions

1. Can Universe currently execute evaluated improvements using the resource pool?
2. What real execution can the existing authenticated providers safely establish?
3. Which release and onboarding claims are stale or contradict implemented code?

## Status

Pre-pack checkpoint: direct occupied-task ordering fix, canonical documentation
and installed-documentation checker are implemented. 1,240 selected tests,
typecheck, lint and build pass. Exact clean artifact/install and source publication
are the next step; their immutable identity and outcomes belong in the final
artifact receipt and pull request, not this pre-commit checkpoint.

Real local model trials failed independently; the native benchmark correctly
withheld work at the configured quota reserve. The direct fix is not counted as
locally generated accepted work. Full Universe integration and registry/resident
production remain open, separate from completion of this bounded increment.

## Errors

- No repository AGENTS.md found; user-supplied project instructions apply.
- Entire resume found no previous checkpoint for the new branch.
- Initial package build rejected the three newly curated documentation paths at
  its exact portability allowlist. Updating only those explicit entries and
  preserving the required runtime declarations; rebuild remains pending.
- Documentation contract checks exposed stale Unreleased/wording assertions and
  an immutable historical changelog block. Preserve the historical block's exact
  hash; put current corrections outside the release record.
