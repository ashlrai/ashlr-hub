# Task Plan: M546 Agent OS Rollover, Anchor, and Evidence Attestation

## Goal

Specify a source-only, fail-closed protocol for bounded Agent OS history epochs, external monotonic anchor compare-and-swap, and detached external evidence attestation without implementing or activating any adapter.

## Phases

- [x] Phase 1: Establish scope and review the current source, snapshot, attempt, and external evidence boundaries.
- [x] Phase 2: Define protocol states, invariants, rollover eligibility, and crash recovery transitions.
- [x] Phase 3: Define the threat model and assurance vocabulary.
- [x] Phase 4: Review the package for completeness, internal consistency, and non-activation boundaries.

## Key Questions

1. How can bounded ledgers roll forward without allowing sequence reset, history substitution, or mixed-version writers?
2. What ordering makes local epoch creation and external anchor CAS recoverable after every crash point?
3. How must origin identity, claim truth, release provenance, and authority remain independent?

## Decisions Made

- M546 is documentation only; it adds no runtime imports, adapters, configuration, keys, network access, or activation path.
- A filesystem-only checkpoint cannot claim rollback protection; that claim requires a separately operated or hardware-backed monotonic anchor.
- Existing V1 external receipt bytes remain unchanged; authenticity is carried in a detached envelope.
- The external CAS is the sole epoch commit point; prepared local state and the local active pointer are non-authoritative caches.
- Epoch-local source and snapshot sequence reset is safe only when their first records bind the preceding epoch tips and attempt identity also includes the epoch.
- Producer-origin, release-provenance, independent-outcome, and live-acceptance assurance remain orthogonal.

## Errors Encountered

- None.

## Status

**Complete** - The source-only specification and threat model are internally reviewed; no runtime, adapter, configuration, key, or activation path was added.
