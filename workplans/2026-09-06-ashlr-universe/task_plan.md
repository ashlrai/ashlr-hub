# Ashlr Universe implementation

## Goal

Make Universe a working experiment and evolution layer in Hub: instantiate an objective and resource envelope, run competing variants, evaluate actual artifacts, retain useful results and decision traces, and expose the same persisted state to engineers and agents.

## Phases

- [x] Read the supplied vision, inspect repository ownership and recent history.
- [x] Map reusable runtime, storage, verification, CLI, and dashboard patterns with independent agents.
- [x] Verify research claims that affect implementation; distinguish aspiration from tested capability.
- [x] Build a complete local Universe experiment loop and product surface.
- [x] Run focused regressions, typecheck, lint, production build, and an independent end-to-end review.
- [ ] Commit and push reviewable source with exact evidence and an honest remaining roadmap.

## Decisions

- Universe is the North Star and product layer; Hub remains its kernel and distribution, with independently useful ecosystem repositories.
- Start from origin/master d1f007d0d379b2c4cdb87a50613a57256cfd5aed in a clean worktree; preserve the primary checkout.
- Keep all verification local; GitHub Actions are disabled at the user's request.
- Retain the already verified 3.4.0 artifact as a separate release candidate; new source does not inherit its test receipt.
- User selected verified engineering yield: useful accepted changes per token and hour.

## Open questions

- Full provider-backed mutation and real portfolio acceptance are later integrations; no synthetic demo result is engineering yield evidence.

## Status

The executable loop, interfaces, and independent review are complete for the local
kernel. All five two-generation demo checks pass in source and extracted-package
runs. Normal source PR integration is in progress. Full model-driven portfolio operation
and npm publication are not represented as complete.
