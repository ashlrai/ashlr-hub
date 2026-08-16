# M493 Mission Observation Receipt Contract

## Purpose

Mission OS (`docs/MISSION-OS.md`, M300s series) needs a durable, tamper-evident
record of what planning state existed at a point in time — which briefing was
read, which goals and proposals existed, which mission-graph nodes were
ready — so a later reconciler or auditor can trust that a claimed observation
actually happened, without granting that receipt any power to act on its own.
M493 is that record: an immutable, signed observation, not an executable
artifact.

## Hard rule

A receipt is only ever produced from **complete** source inputs. `sourcesComplete`
(`src/core/vision/mission-receipt.ts:850`) requires every one of
`briefingSource`, `enrollmentSource`, `goalSource`, and `proposalSource` to be
independently valid; if any one is degraded, `recordMissionObservationReceipt`
(`mission-receipt.ts:857`) returns disposition `source-degraded` and persists
nothing — a partial observation is never recorded as if it were complete.

Signing uses the same host-shared Ed25519 provenance key as other Ashlr
receipts (`src/core/foundry/provenance.js`, `loadOrCreateKey` /
`loadExistingProvenanceKey`). `createMissionObservationReceipt`
(`mission-receipt.ts:830`) and `verifyMissionObservationReceipt`
(`mission-receipt.ts:842`) both operate **read-only** against an existing
key — neither one creates a key or a store as a side effect of being called;
if no key exists yet, both return `null` rather than provisioning one
implicitly.

Persistence goes through the same write-once, exclusive-stage, fsync,
no-clobber-hard-link, point-reread pattern used by every other immutable
private record in this repo (see `CONTRACT-M463.md` for the general shape).
A successful `recordMissionObservationReceipt` call rereads its own just-written
record via `readImmutablePrivateRecordPoint` and refuses to report success
(`persistence-failed`) unless that reread is exact-complete and the receipt ID
matches — the same discipline as M460's policy-assignment receipts.

## Authority

Every receipt is metadata only. It records: which briefing was observed
(digest, not content — `missionObservationBriefingDigest`,
`mission-receipt.ts:378`), which goals/milestones/proposals existed and their
statuses, and which mission-graph nodes were ready — never prompts, diffs,
file paths, or model output. A receipt:

- Grants no goal-creation, proposal, merge, dispatch, or routing authority.
- Does not prove the observed goals/proposals were *correct* — only that they
  were observed, signed, and durably recorded at that point.
- Is consumed only by other observation-only Mission OS surfaces (the shadow
  reconciler in M494/M497/M502) to verify a suggestion is grounded in a real,
  signed prior observation — never by an execution path.

## Surface

- `createMissionObservationReceipt(input): MissionObservationReceiptV1 | null`
- `verifyMissionObservationReceipt(value): MissionObservationReceiptV1 | null`
- `recordMissionObservationReceipt(input, options): MissionObservationReceiptRecordResult`
- `readMissionObservationReceipts(...)`, `readMissionObservationReceiptPoint(...)`
- `recoverMissionObservationReceiptStore()` — reader-only recovery, creates
  and mutates nothing beyond what M463-style immutable-store recovery permits
- `missionObservationReceiptRootPath()` (`mission-receipt.ts:797`)

## Verification

`test/m493.mission-receipt.test.ts` proves:

- A receipt is refused (`source-degraded`) when any one of the four required
  sources is missing or invalid, even if the other three are complete.
- `verifyMissionObservationReceipt` never creates a key or store as a side
  effect and returns `null` cleanly when no key exists.
- A successful record reads back byte-identical via the exact point-reread
  path; a reread mismatch is reported as `persistence-failed`, never as a
  silently-accepted write.
- Concurrent/replayed writes for the same receipt converge on one record
  (`recorded` vs `replayed` disposition), never a duplicate.

## Non-goals

- Not a mission-execution authority — see `docs/MISSION-OS.md` for the
  explicit list of what `vision shadow`/`vision reconcile` do and do not
  grant.
- Not a transparency log or independent third-party attestation; same
  host-shared-key threat boundary as every other Ashlr provenance receipt
  (see `CONTRACT-M463.md` "Authority And Threat Boundary").
- Does not itself decide what goes into a briefing or which goals are
  "ready" — it only signs and durably records what the caller already
  computed.
