# Task plan: Interactive resource fleet map

## Goal

Turn the scoped resource console into a clear, interactive view of shared
capacity, enrolled workers and actual work, with useful inspection and controls.

## Phases

- [x] Explore current UI/data/runtime and choose an evidence-backed design.
- [x] Build visualization and operational interactions in parallel.
- [x] Verify semantics, accessibility, responsiveness and integrated behavior.
- [ ] Package locally, verify the installed UI and push reviewed source.

## Constraints

- Continue from master merge `38cc489550d4aadccc67ba006b4c1d4f3328e512` in the
  existing clean integration worktree; preserve the original checkout.
- No GitHub Actions, new paid resources, provider account changes, downloads or
  resident service activation. UI actions reuse existing scoped controls.
- Use actual public DTO evidence. Queued work is not assigned until dispatch;
  external reservations are not proof of live OS processes.
- Optimize operator understanding and useful control, not decorative graphs.

## Questions

1. Which account/worker/task relationships and constraints are actually known?
2. Which current controls can graph inspection make easier to use?
3. Can the same view remain navigable at 32 workers, narrow widths and by keyboard?

## Errors

- `rg --files -g AGENTS.md` found no repository instruction file and ended a
  chained read early; required skills were read separately. User instructions apply.
- Entire resume found no checkpoint for this new branch.

## Status

Implemented the full-width fleet topology, search/paging, queue diagnostics,
consistent task placement, stale-read behavior and explicit focus navigation.
Independent review corrected queued identity conflicts, cross-sampled terminal
versus occupied records, and delayed mutation focus races. Source gates passed;
installed-package acceptance and source release remain pending. Immutable final
receipts will live under `/Users/masonwyatt/.codex/artifacts/ashlr-fleet-map.GJIMH8`.
