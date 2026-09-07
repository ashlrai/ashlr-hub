# Native worker reliability and unattended operation

## Goal

Make real worker failures diagnosable and advance an evidence-backed execution
path toward reliable unattended engineering, without mislabeling partial
integration as a completed autonomous product.

## Phases

- [x] Explore native failure, receipt/UI contracts and unattended recovery gaps.
- [x] Agree the smallest useful contract and implement independent lanes.
- [ ] Verify source, actual native behavior and installed runtime end to end.
- [ ] Publish supported source/artifacts and record remaining production work.

## Decisions and constraints

- Start from merged PR 369, master 98916ad856536cdd6be2dc1d0414f6b8b517f273.
- Keep existing framework, account identities, quota reserves and independent
  product boundaries. No GitHub Actions, API-key fallback or account switching.
- A failed native task is not proof of model execution; token absence is unknown.
- Start with bounded diagnostic metadata, not raw provider output in the ledger.
- Any real diagnostic invocation must use a private task workspace, read-only
  mode, fresh quota admission and an explicit small request/time envelope.
- No resident-service activation or automatic retry of ambiguous work.

## Questions

1. What caused the actual native failure after successful quota admission?
2. Which reusable contracts can preserve safe diagnostics through ledger and UI?
3. What remains necessary for continued useful work through failures/restarts?

## Status

User selected unattended single-computer reliability over multi-computer work.
Three independent lanes: native real diagnosis, backend metadata implementation,
and inspector/documentation. Root owns public/query contracts and integration.
The optional nativeProcess extension retains bounded exit/signal/capture metadata
without raw text or changes to retry/admission semantics. Legacy absence remains
unknown. Synthetic timeout/cancellation exit codes are not reported as native exits.
The newer native metadata protocol was diagnosed from one bounded capture and
patched narrowly: optional notification emission timestamps are validated but
never used as quota freshness or authority. Independent review passed.
Clean candidate and installed acceptance are the current phase. Final artifact,
browser, native canary and publication evidence will be recorded in the private
`ashlr-native-reliability.RYAxE5` artifact handoff, keeping raw captures outside Git.

## Errors

- No Entire checkpoint on the new branch. No repository AGENTS.md found.
