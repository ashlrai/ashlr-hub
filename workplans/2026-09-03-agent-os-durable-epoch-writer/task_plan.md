# Task Plan: Agent OS durable epoch writer

## Goal

Implement and adversarially verify the local, source-only durability and recovery layer for M546/M550 epochs without commissioning an external anchor, provisioning keys, wiring the daemon, or granting write/effect authority to observation evidence.

## Phases

- [x] Phase 1: Map existing storage, lock, durability, M546, and M550 invariants.
- [x] Phase 2: Freeze the narrow writer/recovery API and failure taxonomy.
- [x] Phase 3: Implement exact-private epoch preparation, immutable artifacts, recovery marker, and active-pointer storage.
- [x] Phase 4: Implement deterministic recovery classification and injected anchor orchestration without a concrete adapter.
- [x] Phase 5: Add crash-point, alias/symlink, concurrency, replay, stale-writer, corruption, and authority tests.
- [x] Phase 6: Run independent red-team, security scans, focused/adjacent tests, typecheck, lint, build, and exact-state verification.
- [x] Phase 7: Publish implementation and commissioning-boundary report.

## Key Questions

1. Which pieces can safely be implemented as local durable primitives before an external anchor is commissioned?
2. How do we guarantee that prepared state and a local pointer can never be interpreted as the external commit point?
3. Which existing exact-private storage and lock primitives can be reused without weakening their invariants?

## Decisions Made

- The normative M546 specification and M550 canonical protocol are the architectural baseline; this tranche does not redesign their external commit semantics.
- The implementation will use injected dependencies for anchor reads/CAS and authenticated ledger verification; no network adapter or trust root will be selected.
- A locally prepared epoch and local active pointer remain non-authoritative caches. Only exact external-head agreement may classify a committed transition.
- M550 control digests remain canonical `sha256:<64>` values. Existing signed V1 source/snapshot digests remain raw 64-hex; field-specific validators must preserve both contracts without accepting two spellings for one field.
- Existing Source Bundle V1 and Attempt Receipt V1 remain unchanged. Epoch-aware V2 envelopes are required because V1 cannot represent sequence reset with prior-epoch lineage.
- Pointer mutation may be reached only through a live injected `anchor.read()` performed while both the unforgeable process lease and cross-process observation lock are held.
- No legacy import, deletion, retention, daemon/config integration, key provisioning, release, or activation is authorized.

## Errors Encountered

- `request_user_input` was unavailable in Default mode; the strategic direction question was left non-blocking in commentary and work proceeded under the already-approved M546/M550 architecture.
- The first M556 test expected macOS `/var/...` spelling while the lease correctly canonicalized it to `/private/var/...`; the fixture now compares the real parent path and preserves alias collapse.
- Semgrep flagged a literal HMAC key used only to derive deterministic M555 test values; the fixture did not need authentication, so it now uses domain-separated SHA-256 and the exact scan is rerun.

## Status

**Complete as a source-only, uncommissioned tranche.** M553-M556 are implemented and independently red-teamed. No external anchor, producer, daemon, key, release, or effect path was commissioned.
