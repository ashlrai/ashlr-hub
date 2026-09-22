# Predecessor settlement for standing missions

## Goal

Enable automatic campaign rollover from verified delivery and completed prior
obligations, using existing execution and accounting proofs, not owner closure
alone. The full autonomous-fleet goal remains open.

## Phases

- [x] Inspect clean primary8d4368c8 and prior completed gates.
- [x] Map state/delivery/journal joins with three agents.
- [x] Extract shared read-only supervision and delivered-source readers.
- [x] Integrate the predecessor check and verify retained-fixture CLI/refusal behavior.
- [x] Independently review, build and document remaining mission activation work.

See delivery.md:311 focused tests passed; retained-fixture controls passed;
the encompassing source-CLI acceptance run was interrupted and is not counted
as passed. Full fleet autonomy and production activation remain unfinished.

## Ownership

State agent owns supervision validation/read module and original owner integration.
Delivery agent owns delivered-source extraction and original preparation wrapper.
Parent owns cross-join/caller and integration. Reviewer maps graph/custody gaps and
audits final joins. No provider calls, actual account changes, stop clearing,
collector recovery, service activation or public publication. Entire resume found
no checkpoint. Original dirty checkout remains untouched.
