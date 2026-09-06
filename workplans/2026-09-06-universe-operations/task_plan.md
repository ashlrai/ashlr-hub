# Universe operational completion

## Goal

Advance the merged campaign runtime toward useful unattended engineering work
and a verifiable production handoff. Optimize accepted engineering yield, not
token consumption, process count, or an unverified completion label.

## Phases

- [x] Verify source ownership, merged baseline, memory, and Entire context.
- [x] Explore unattended operation, provider integration, and release gates.
- [x] Select the next complete increment and confirm any material architectural choice.
- [x] Implement independently owned lanes with regression coverage.
- [ ] Verify native behavior, real outcomes, package identity, and console flow locally.
- [ ] Integrate exact source and document what is and is not production-active.

## Constraints and decisions

- Begin at master merge `14f8f8637b5cbdd38ce7d71e27de7889692b35ec`.
- Preserve the primary checkout and its unrelated workplans.
- Reuse the existing private ledger, campaign owner, and model adapter.
- GitHub Actions remain disabled. Do not reactivate the quarantined legacy daemon.
- Existing campaigns keep their pinned objectives, evaluators, and resource limits.
- No inferred account changes, paid API fallback, credential transfer, model downloads,
  or provider startup. Source integration, package publication, and resident activation
  are reported separately with actual evidence.

## Questions

- Which existing owner/service primitive can recover campaigns without duplicate dispatch?
- What missing harness capability prevents the configured subscriptions from doing useful work?
- What exact local gates distinguish the merged code from a releasable installed product?

## Status

Implement evaluated artifact delivery into an explicit new local Git branch.
The branch is based on the pinned seed, with a verified artifact-identical tree,
and does not edit the user's checkout/index/HEAD, merge, or push. Core, CLI, and
installed-package verification are independent lanes; root integrates console
visibility, documentation, and independent acceptance. The strategic question
offered recovery as an alternative; absent a reply, use recommended delivery.

Recovery already prevents duplicate dispatch, but detached child cleanup after
SIGKILL is not proven. Subscription harness invocation budgets and managed hooks
are not equivalent to the current one-request text-only model adapter. Neither
gap will be hidden by a new supervisor or a permissive agent wrapper.

## Errors and context

Entire resume found no checkpoint for this new branch. A discovery command used
stale guessed web/test paths and an unmatched zsh glob; use rg --files to resolve
the actual paths before continuing. No files or product state were affected.
The first web test invocation transposed the config filename; the correct
`npm run test:web` command passes. Full lint initially identified two new branch
validator regex errors; the validator now uses character checks and scoped lint
passes. Review found and fixed historical receipt provenance, exact trial
navigation, Git symbolic-ref creation race, and transaction deadline handling.

Implementation verification is complete. Final clean build/package inspection,
the existing evaluated calendar artifact's delivery, local console refresh,
and protected source integration remain. npm publication is blocked by a
verified local E401; no GitHub Actions or npm publishing attempt was made.
