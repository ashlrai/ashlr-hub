# Universe autonomous execution continuation

## Goal

Deliver the next executable capability toward verified engineering yield, reusing
the measured experiment runtime rather than adding observational layers by default.

## Phases

- [x] Check current source, memory, ownership and Entire context.
- [x] Explore execution, local release and independent product acceptance in parallel.
- [x] Select and state a bounded implementation contract and strategic direction.
- [x] Implement independent lanes and verify meaningful end-to-end behavior.
- [ ] Verify exact source/artifact, publish source and record remaining limitations.

## Boundaries

- Base: merged PR360 `a097e9083f82eded6ff31420515531a9e4bb9b1b`.
- Preserve the primary Desktop checkout and unrelated work.
- No GitHub Actions. No automatic credential/account switching or provider fallback.
- Exploration makes no model requests, publication or service changes.
- Keep acceptance and reported resource evidence distinct from model claims.
- No framework rewrite; use the established non-eve runtime.

## Status

Implemented opt-in multi-file engineering with independent protocol/replay,
filesystem/model and native acceptance lanes. Root integrated the runner, public
SDK, guide and package checks. Broad regression and exact-package qualification
are in progress. Strategic question offered multi-file engineering
versus stable local installation; proceeding with the recommended first option
unless the user redirects.

## Implementation contract

1. Preserve the replacement-only mode, normalized legacy configuration and prior
   prompt/feedback/receipt bytes. New operations are explicitly opted in.
2. Retain `generation.files` as at most 16 immutable mutable-file paths. Add
   `fileOperations: {schemaVersion: 1, contextFiles: []}` with at most 16 disjoint
   read-only context paths. All mutable paths permit create/replace/delete as
   their current presence allows; no globs, renames or undeclared paths.
3. Use exact operation objects and one operation per path. Validate all inputs,
   current-file state, output shape and byte budgets before any write. Keep
   current parent separate from failed previous-attempt files.
4. Pin explicit presence/absence and operation outcome evidence. Replay against
   the immutable parent/prior artifacts and scoped manifest, not a model claim.
5. Preserve request, token, duration, stagnation, cancellation and retry accounting.
   Partial filesystem failure must never reach successful evaluation/admission.
6. Reuse the existing fixed evaluator, artifact archive, graph and local delivery.
   Native acceptance adds a new parser helper and updates actual Hub parser source
   in a private challenge; separately verify deletion of a test-owned obsolete file.
7. Test the installed package and exact Git artifact, not only TypeScript mocks.
   No real model requests are planned for the deterministic acceptance lane.
8. Defer subscription adapters and qualified local installer; both require distinct
   integration work and are not represented as complete by this file capability.

## Errors and observations

- No repository-local AGENTS.md found; inherited Codex instructions were read.
  The no-match exit stopped the initial chained setup; resumed setup explicitly.
- Entire resume found no saved checkpoint for either continuation branch.
