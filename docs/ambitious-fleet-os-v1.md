# Ambitious Fleet OS V1

## Product thesis

Ashlr Hub should feel like an always-on engineering chief of staff, not a wall of telemetry. Its first job is to convert an operator's intent into bounded work, keep that work moving through the existing evidence gates, and surface only the exceptions that need judgment.

This slice advances that thesis in three connected places:

1. **Mission Compiler** turns a strategist briefing into at most three deduplicated, repository-bound goals. Preview is read-only; adoption is explicit and verifies exact persistence.
2. **Operator Briefing** puts `Needs you`, `Autonomous now`, and `Last proof` ahead of the detailed fleet panels, with a compact `Observed -> Decided -> Acted -> Proved` evidence chain.
3. **Crash-safe resident autonomy** makes spend authority durable across abrupt termination, midnight rollover, stale process ownership, and resident-service restart behavior.

## Operator experience

The main screen is intentionally exception-first:

```text
Mission Control
  Needs you          Autonomous now       Last proof
  [safe next action] [bounded work state] [O -> D -> A -> P]

  Evidence and telemetry (collapsed by default)
    readiness | fleet | goals | learning | dispatch | repair | evidence
```

- Every suggested command is visible and individually copyable; the browser never executes it.
- A clear/continue command is withheld unless the snapshot and readiness proof are fresh, the kill state is exactly inactive, authority is known and unblocked, and no human action is pending.
- Unknown, paused, stale, or blocked state yields a read-only inspection action.
- Polling and event-stream refreshes preserve focus, scroll position, and disclosure state.
- The settings dialog traps and restores focus and remains scrollable in mobile, short, zoomed, and safe-area viewports.

## Mission Compiler contract

- `ashlr vision preview` is non-mutating and reports selected goals plus deterministic skip reasons.
- Candidate goals must resolve to one exact enrolled repository path or one unambiguous exact basename; missing, malformed, or ambiguous targets fail closed.
- A briefing compiles at most three goals and respects goal-focus capacity.
- Exact raw objectives are reserved across all stored statuses and projects because goal filenames are objective-derived. Normalized objective/project identities are also reserved, including archived and completed history.
- Adoption reports `created`, `skipped`, or `failed` per goal and returns a failing exit status for degraded inventory, partial persistence, or write failure.
- A creation is successful only when the exact minted ID, objective, project, `createdAt`, and `updatedAt` are read back from storage.

## Durable autonomy contract

- A versioned spend guard is durably created before provider dispatch and carries the accounting identity, owner identity, budget day, budget snapshot, reserved exposure, and selected item IDs.
- State and guard transitions use file and parent-directory synchronization so success is not reported before the filesystem ordering boundary is durable.
- Startup recovery requires provably dead ownership. An exact accounting receipt permits idempotent cleanup; unknown exposure fails closed rather than reopening spend authority.
- Dispatch is capped to the guard's bounded item capacity.
- Cross-midnight recovery accounts the old budget day before establishing the new day.
- Persistence failures become terminal daemon failures. Resident service definitions must restart nonzero failures while intentional operator stop/kill remains a clean exit.

## Authority boundaries

This work does **not** expand merge, deployment, publication, provider-token, or external-mutation authority.

- Source changes remain proposal-only and subject to the existing verifier and protected-remote gates.
- Mission adoption requires an explicit CLI action; preview cannot write goals.
- Dashboard actions are copy-only.
- Unknown durability or spend exposure blocks further same-day provider authority.
- A successful build, local test, or dashboard render is not evidence that the resident daemon is installed, running, or production-authorized.

## Release gates

- [x] Independent P0/P1 reviews are clear.
- [x] Focused mission, dashboard, daemon, budget, state, and service suites pass.
- [x] Typecheck, changed-file lint, build, audit, invariants, and diff integrity pass.
- [x] Full `npm run test:ci` passes from the synchronized branch.
- [x] Desktop and constrained/mobile browser inspections pass with no console errors.
- [ ] Branch is committed and pushed for protected CI.
- [ ] Resident daemon activation is separately approved and verified from the deployed artifact.

### Local evidence

- Changed-surface regression: 14 files, 799/799 tests.
- Safety invariants: 41 files, 445 passed, 5 platform-skipped.
- Full suite: 610 files passed, 2 platform-skipped; 13,950 tests passed, 42 skipped.
- Typecheck, build, dependency audit, and diff integrity passed.
- Full lint: 0 errors, 101 pre-existing warnings.
- Browser: 1440x900 and 390x844; no console errors or warnings; mobile settings containment and focus restoration verified.

Status: source-ready for protected review. Resident activation remains intentionally separate and is not claimed by this branch.
