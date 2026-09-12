# Spark enrollment preparation

## Goal

Prepare a usable, private General/Spark configuration from existing account
configuration without changing accounting, unpausing accounts or contacting providers.

## Phases

- [x] Explore actual persisted configuration and existing migration contracts.
- [x] Confirm supported General model, shared capacity and quota bucket contracts.
- [x] Implement pure planner, private proposal CLI and independent regression tests.
- [x] Review, validate locally and prepare real configuration proposal without applying.
- [x] Retain evidence and hand off explicit activation blockers.

## Decisions

- Work in a separate worktree; primary native gate 73003 keeps its source/build frozen.
- Reuse additive pool evolution; this increment does not replace the ledger or scheduler.
- Preserve personal pause and 75% allocation. General exclusion is a proposed descriptor,
  never a replacement of existing exclusions or an automatic unpause.
- Claude native /usage can be cached: display data must not authorize dispatch.
- Legacy collector pending record lacks ownership proof; do not delete or bypass it.

## Status

Implemented and verified on the isolated branch. Real private proposal prepared;
existing-ledger evolution check refuses uncertain-work (legacy collector pending
record retained). No migration, reservation, unpause, quota refresh or activation.
Primary native gate 73003 remains live; this branch is not integrated into its
frozen source or build. No deployment or remote publication was performed.

## Corrections

- Cold review and independent filesystem tests caught semantic JSON comparison
  being weaker than manifest byte hashes; verification now checks exact bytes.
- Capture own-data file options once; pin the new directory before permissions
  assurance so replacement cannot become the accepted initial identity.
- Initial root planning-file placement overlapped inherited tracked notes; the
  originals were restored exactly from HEAD and the new plan moved here. A final
  Git diff confirmed no changes to root notes.md or task_plan.md.
