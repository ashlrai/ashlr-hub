# Resource-backed portfolio execution

## Goal

Close the next verified single-computer orchestration gap while preserving
existing campaign evaluation, ownership, resource caps, and private bindings.

## Phases

- [x] Explore portfolio dispatch, CLI contracts, and failure/verification patterns.
- [x] Choose the smallest compatible integration and assign independent lanes.
- [x] Implement and test normal, blocked, replay, and control behavior.
- [ ] Verify installed behavior, publish source, and record exact remaining limits.

## Constraints

No GitHub Actions, global configuration reads, real provider/model calls, credential
changes, model downloads, or resident service activation. Preserve the user
checkout. Private runtime paths must not leak into portable or public records.

## Initial questions

Should one explicitly selected runtime be shared by the portfolio's enrolled
campaigns, or does current code require a per-campaign binding map? Explore first.

## Status

Three exploration lanes confirmed a captured invocation-only resourceRuntime
can be forwarded through the existing campaign dispatcher. No portable schema,
planning, scheduling, or accounting redesign is required. A nonblocking user
question offers shared pool versus per-campaign mapping; shared pool is the
compatible default. Core/unit, CLI/docs, and independent real-I/O lanes are
implemented and frozen. Independent review passed. Root owns the final combined
regression, installed acceptance, and release. The final stable regression passed
546 tests across 20 files. Source typecheck, lint, docs and whitespace checks pass.
Installed artifact and publication outcomes are recorded in the external release
report so that acceptance does not dirty the source identity embedded in the build.

Parallel campaigns do not wait in a provider-capacity queue: unavailable workers
pause a campaign without retry. Use maxParallel 1 for a single available worker.

## Errors

Entire resume found no checkpoint on the new branch. A guessed portfolio-runtime
filename was absent; use rg inventory to locate the existing implementation.
Initial new E2E assertions expected null campaign usage for unstarted handoffs;
the existing campaign projection correctly reports zero while per-run usage is
null. Cancellation can conservatively settle uncertain when process-group
termination cannot be confirmed. Correct fixture expectations without weakening
runtime teardown or releasing uncertain capacity. The first aggregate run began
before those fixture corrections; rerun the final stable suite before reporting.
