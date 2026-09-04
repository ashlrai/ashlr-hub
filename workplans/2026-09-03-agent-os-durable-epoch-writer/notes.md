# Notes: Agent OS durable epoch writer

## Current state

- Branch: `codex/v333-iteration` at `6d1bf2fe8a237343681049043ec50fa1b6bf307f`.
- The checkout contains extensive uncommitted user/agent work; preserve all unrelated changes.
- Entire is enabled in manual-commit mode and has no checkpoint for this branch.
- M546 defines the external CAS as the sole commit point; prepared local state and the active pointer are non-authoritative caches.
- M550 implements strict canonical manifest/head formats, preflight, deterministic operation IDs, and post-CAS classification, but no I/O.
- M551 remains a caller-evidence classifier and does not prove stopped runtime or authorize commissioning.

## Hard boundaries

- No concrete external anchor adapter or network I/O.
- No key generation, credential lookup, trust-root installation, or policy activation.
- No daemon/config/runtime wiring.
- No legacy migration, retention deletion, commit, push, release, publication, or activation.
- No evidence object can authorize writes or effects.

## Research log

- Existing reusable durability surfaces include `fsyncDirectory`, exact directory identity checks, immutable private record stores, Agent OS source/snapshot/attempt stores, and observation transaction locking.
- Detailed dependency and crash-matrix findings are being gathered by parallel agents.
- The external head bytes, not the local path layout, are the authoritative epoch identity. Local reads therefore need exact canonical head/manifest validation plus explicit external comparison before any pointer recovery.
- The required ordering is file write -> file fsync -> namespace publication -> containing-directory fsync -> exact reread. Pointer installation additionally requires the current anchor bytes and fully verified prepared epoch to agree.
- Existing `agent-os-observation-lock.ts` is a host-local transaction lock backed by `local-store-lock.ts`; it does not itself supply the distinct process-resident protocol-digest lease required by M546.
- Incomplete temporary state may be ignored, but a complete old epoch must never be removed by recovery. Orphan quarantine/deletion remains a separate maintenance protocol and is excluded here.
- The local epoch store must avoid exposing a generic arbitrary-path writer. Inputs should be canonical M550 bytes plus bounded exact artifacts, with paths derived below one pinned private root.

## Contract gaps found before implementation

- **P0 digest type mismatch:** M550 currently treats every digest as `sha256:<64>`, while signed Source V1 and Snapshot V1 records use raw 64-hex values. Resolution: field-specific formats; never a permissive dual-format validator.
- **P0 impossible successor source:** Source Bundle V1 requires sequence one if and only if the predecessor is its zero genesis, so it cannot represent a new epoch's sequence-one source linked to the previous epoch tip. Resolution: a separately signed epoch-aware Source Bundle V2; do not weaken V1.
- **P0 pointer authority risk:** no API may install a caller-supplied head based on a Boolean or prior classifier result. Pointer recovery must perform a live injected anchor read inside both locks and require exact prepared-state agreement.
- **P0 immutable clobber risk:** manifest, first-source, intended-head, and marker publication must be exclusive/no-clobber. Replace-by-rename is restricted to the mutable active pointer under exact expected-state checks.
- **P1 attempt identity mismatch:** current UUIDv4 attempt receipts are not epoch-bound. Resolution: an epoch-aware Attempt Receipt V2 with a domain-separated control digest ID.
- **P1 lease gap:** implement a process-global, identity-branded protocol-digest lease and pair it with the existing cross-process observation transaction lock.
- Windows directory fsync has intentionally weaker platform semantics today. The epoch writer must remain unsupported/uncommissioned there until equivalent power-loss acceptance exists.

## Implemented outcome

- M550 now uses field-specific digest formats and rejects cross-format substitution and post-epoch-one genesis resets.
- M553 provides exact-private immutable epoch preparation and a non-authoritative local active pointer. It pins and rechecks directory identity around writes and renames, closes file and parent-directory durability barriers, and requires a fresh exact anchor read while both locks are held before pointer mutation or replay.
- M554 provides a pure recovery planner with no I/O or hidden authority. Compatibility evidence for source, snapshot, and attempt epoch support must be independently verified.
- M555 provides epoch-aware Source Bundle V2 and Attempt Receipt V2 formats with separated signing/authentication domains, prior-epoch lineage, deterministic epoch-bound attempt identity, and authenticated active-epoch context verification.
- M556 provides a process-global, identity-branded writer lease keyed by canonical store root and writer-protocol digest. It is deliberately described as cooperative and process-resident only.
- All results remain observation-only. M553 deliberately reports source compatibility as unverified until a real M555 producer and closure verifier are integrated.

## Independent red-team findings closed

- Exact local pointer replay now performs a fresh anchor reread rather than accepting an earlier observation.
- Replay after rename but before parent-directory fsync now closes the missing durability barrier before success.
- Windows fails closed at runtime instead of accepting injected platform claims.
- Attempt verification now requires authenticated exact active-epoch context.
- Source and snapshot genesis sentinels cannot reset semantic lineage after epoch one.

## Verification notes

- The focused M550-M556 plus adjacent M373/M414/M416 matrix passed 183 tests with 1 explicitly skipped.
- The independent red-team matrix passed 164 tests across seven files.
- The complete repository suite passed 15,562 tests with 45 skipped across 696 passing files and 1 skipped file.
- Typecheck, scoped lint, full lint, build, exact Semgrep, exact Gitleaks, offline npm audit, and diff whitespace checks passed; full lint retained pre-existing warnings and the real-I/O lane retained its documented soft signal.
- No central security findings tracker exists at the expected path, so the scoped report remains in this repository.
