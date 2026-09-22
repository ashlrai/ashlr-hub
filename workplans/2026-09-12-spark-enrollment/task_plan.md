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

## Follow-through: passive collector inspection

- [x] Explore current fallback, recovery semantics and UI contracts.
- [x] Add a separate local-record inspection projection; never acquisition lifecycle.
- [x] Integrate plain read-only HTTP responses and a compact historical-aware UI panel.
- [x] Verify real HTTP/file preservation, decoder privacy and component behavior.

Inspection is automatic only for a plain read-only console without either native
metadata configuration. It reads the selected root, reports absent/pending/
unavailable, and never constructs owners, probes processes, attempts recovery or
contacts providers. Absence is not readiness; valid modern markers are not called
unrecoverable. Legacy recovery still needs operator-owned evidence beyond a clock
or missing lock. Primary native73003 remains live with its runtime unchanged.

Actual read-only preview on port63764 was verified through the in-app browser,
then closed on its exact owned process (session96314 terminal0). Desktop and
390x844 mobile rendering showed the legacy marker and retained75%personal
reservation policy. No horizontal overflow. After shutdown, an explicit refresh
marked the original6:31:51AM sample historical rather than renewing its time.
Temporary viewport override reset and created tab closed. Browser startup token
stayed in its private artifact and was never printed or committed.

Parent source/HTTP/regression gate8159 passed104tests/4files/0skips9.38s, plus
source types, lane checks and documentation checks. Agent UI gate84746 passed
421tests/4files/0skips3.85s; full web types and scoped lint passed. Isolated
TypeScript+web build61573 passed (257modules). These do not qualify primary's
still-running native gate. See inspection-verification.json for scopes.

## Corrections retained

- Cold review and independent filesystem tests caught semantic JSON comparison
  being weaker than manifest byte hashes; verification now checks exact bytes.
- Capture own-data file options once; pin the new directory before permissions
  assurance so replacement cannot become the accepted initial identity.
- Initial root planning-file placement overlapped inherited tracked notes; the
  originals were restored exactly from HEAD and the new plan moved here. A final
  Git diff confirmed no changes to root notes.md or task_plan.md.
- Preview creation inside the browser tool's restricted JavaScript context failed
  with process unavailable before a server handle existed. Used the checked-in
  standalone preview script instead; it reserves a private startup output,
  prints no token and owns explicit shutdown. The preview is now stopped.
