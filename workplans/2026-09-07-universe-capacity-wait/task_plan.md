# Temporary capacity recovery for Universe

## Goal

Allow useful unattended progress through temporary contention without duplicating
provider work, clearing uncertainty, or resetting campaign budgets.

## Phases

- [x] Explore existing admission, collector ownership, and campaign controls.
- [x] Select a bounded compatible contract and assign implementation lanes.
- [x] Implement and verify contention, cancellation, expiry and replay behavior.
- [ ] Accept the exact local package and publish verified source.

## Constraints

Preserve original checkout. No GitHub Actions, credential/global-config inspection,
live provider calls, account changes, resident activation, or arbitrary cleanup.
Inert private fixtures only. A known absent admission is not the same as an
uncertain or already-reserved task. Never retry ambiguous work.

## Status

User selected bounded waiting. Implement optional private capacityWaitMs (0–60000),
one shared monotonic allowance for verified collector contention and eligible
worker slots, capped by existing generation deadlines. Three lanes: read-only
capacity helper, collector wait, inert parallel-campaign acceptance. Main owns
Universe integration, documentation and final verification. No new receipt schema.

Source validation is complete. The final phase is intentionally a pre-publication
snapshot: the external release receipt records exact clean commit, package,
installed acceptance and publication without dirtying the accepted source tree.

## Errors encountered

- A lane-registration style issue was corrected before lint passed.
- The first integration fixture observed the old lock API; its bounded timeout
  exposed fixture instrumentation drift. It now observes the strict outcome API.
- Independent review found cached unmanaged evidence and expired-positive-budget
  zero fallback. Regressions cover both; final review also identified retention of
  intermediate managed denials and a one-millisecond quota argument boundary.
- Installed harness review caught a capture limit above the runner's 1 MiB cap;
  corrected before the one-use harness was executed.
- Two documentation patch attempts had mismatched context and made no changes;
  reapplied against the inspected text.
