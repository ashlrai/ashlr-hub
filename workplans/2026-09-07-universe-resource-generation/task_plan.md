# Resource-backed Universe generation

## Goal

Connect explicitly enrolled resource workers to Universe's existing candidate,
evaluation, feedback and acceptance loop for useful single-computer engineering.

## Phases

- [x] Explore current contracts and propose the smallest integration architecture.
- [x] Implement independent runtime, configuration and evidence lanes.
- [ ] Verify end-to-end behavior, failure/replay paths and measured acceptance.
- [ ] Publish supported source/artifact and document remaining production work.

## Constraints

- Preserve independent products, existing framework and evaluator authority.
- Keep local-chat generation working. No API fallback, hidden account switching,
  GitHub Actions, global service activation or automatic acceptance on process exit.
- Explicit pool/root/bindings and current capacity evidence; do not widen native
  task workspace authority just to generate a candidate response.
- Preserve unfinished/user work and exact source/artifact identities.

## Status

Three Explore lanes completed before implementation planning. Resource workers
will supply response text through the existing scoped parser and frozen evaluator.
Private machine bindings remain outside manifests. A nonblocking architecture
question is open; the proposed integration preserves existing evaluator authority.

Implementation owners: contract/validation; resource transport; CLI/UI/docs.
Root owns runner, store replay, campaign behavior and end-to-end verification.
Resource invocation accounting is separate from actual provider-request counts.
Campaigns pause on withheld, unavailable, replayed or non-completed resource tasks.

Independent review corrected successful-generation evidence being overwritten by
evaluator cancellation, deadline precedence over attention pauses, and current
quota/refusal evidence being ignored by a newer stored-ready observation.
The eight real-I/O integration tests now pass, including deadline expiry during
the native handoff itself. The final selected regressions pass: 2,935 distinct
backend, transport and web tests. Clean installed acceptance and publication
remain, with exact outcomes recorded in the external release evidence directory.

## Errors

Entire resume found no checkpoint on the new branch; no upgrade performed.
Two guessed test paths were absent; switched to rg inventory.
An in-flight typecheck preceded the transport seam and reported its two expected
union-type errors; the completed source passes core/web typecheck.
One native-cancellation assertion expected only cancelled, but existing process
ownership handling conservatively returned failed with a termination-authority
error. The regression now checks that exact allowed failure while preserving
successful generation evidence; no termination policy was weakened.
