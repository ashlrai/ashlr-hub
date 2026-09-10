# Firm build notes

Baseline: 5c270bc73890e474463c31764d51e76196ad2e3f.
User specification read in full from the attachment supplied this turn.
Original checkout and prior architecture worktree preserved.

Current runtime has finite campaign/controller execution and immutable delivery
primitives. A persistent company graph and self-improvement wiring are not yet
commissioned. This work must add executable paths, not reclassify source as live.
# September 10: durable workspace continuation

## Verified implementation

- Atomic schema2 history lives in the existing supervisor state. Legacy schema1
  upgrades only on explicit opt-in; task digests and resource ledger stay unchanged.
- 64 KiB UTF-8 output prefixes, 4 MiB total state, 256 retained job identities.
  Worst-case escaped output headroom is reserved before admission.
- Core/HTTP integration: 153 tests. UI: 1,090 tests. Targeted subsets overlap.
- Fixed General ceiling display veto incorrectly hiding independent Spark.
  Existing server mock needed the newly required quota-only callback; fixed mock,
  not a production permissive fallback.
- Cold UI review fixed task-switch deletion and cached/in-flight output invalidation
  in both workspace and Resources inspector. Tests cover each confirmed regression.
- Browser inert fixture: retain option unchecked by default; unlock did not submit;
  explicit task remained queued with no eligible capacity, cancelled, survived UI
  reload, and its exact request was read with no control token. No provider dispatch.
- Durable multi-turn context/project catalog remain future work. Host account
  settings and global KILL remain unchanged; no production/publication claim.

- Baseline `f94387ef`, clean `auto/p00`; Entire resume found no checkpoint.
- `pool-supervisor.ts` owns one private atomic JSON state and existing local lock.
  Queue input is removed at terminal settlement; output is bounded memory only.
- The resource ledger binds pool/bindings, while supervisor scope also binds one
  workspace. Project selection must preserve that shared account ledger.
- Durable history must not silently change retention for legacy tasks, reveal
  prompts through polling snapshots, or replay work to reconstruct lost output.
- Investigating final HTTP ceiling projection: per-worker quota exclusions must
  not become whole-account exclusions for explicitly independent quota scopes.
- Non-impacting discovery errors: nonexistent pool-supervisor-types.ts and
  resource-api.ts guesses; located console-types.ts and existing resource modules.
