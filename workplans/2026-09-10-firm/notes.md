# Firm build notes

## September 10: evaluated engineering graph continuation

- Resumed clean `c2b598da` on `auto/p00`; Entire resume found no checkpoint.
  Three agents mapped existing evaluation/delivery, desktop ownership and
  autonomy gaps before implementation. Reused the portfolio controller rather
  than creating another campaign scheduler or quota ledger.
- Chosen complete local slice: concrete host-enrolled signed delivery graph
  adapter, digest-checked foreground CLI, actual resource-backed file operations,
  fixed evaluation and strict-improvement branch delivery. PTY/desktop wrapper,
  resident planning and live account commissioning remain separate milestones.
- Cold review found runtime-digest propagation missing above the generation
  broker, outer deadline reassignment dropping its parent cap, and final worker
  and prepared Git-ref checks not carrying synchronous parent ownership. All
  are now connected; confined file-operation preflight/apply and evaluator
  admission also check parent stop.
- A prior completed controller under a held execution lock could otherwise be
  misattributed to a new graph. New-enrollment refusal is checked under the
  controller transaction; lock refusal cannot return a successful new-enrollment
  result. Adapter additionally rejects report reasons and verifies exact receipts.
- Reserved engineering metadata now requires the concrete factory registration
  and delivery node kind. A copied descriptor on an ordinary explore node cannot
  manufacture an engineering completion.
- Test corrections: initial new real-I/O suite used the default five-second lane
  timeout before registration. A deadline test wrongly compared the persisted
  inner deadline with the outer effective execution cap. A new controller test
  expected a report where the API intentionally throws on forbidden adoption.
  Corrected these expectations; no production allowances were weakened.
- Broad regression also exposed two older CLI subprocess fixtures which dropped
  their temporary HOME and reached the real host's active KILL at Git delivery.
  Diagnosis confirmed the existing production stop gate correctly withheld the
  operation. Drain/crash fixtures now pass explicit private HOME/USERPROFILE/
  ASHLR_HOME; no host kill state or production stop semantics were changed.
- Discovery guesses for portfolio-runtime/portfolio-run and dedicated generation
  test files did not exist; resolved through actual rg inventories. CLI lint
  rejected control-byte regex syntax; replaced it with character-code validation.
  See report.md for final integrated gates, not overlapping agent subtotal counts.

## September 10: file-tool continuation

- Resumed clean `1d1febaf` worktree; Entire found no checkpoint. Three parallel
  explorers mapped filesystem utilities, HTTP lifecycle and real evaluator gaps.
- Existing stable-file-read is private-store-oriented, lossy UTF-8 and rejects
  oversized files. New project reads reuse its identity/nofollow/owner pattern
  with all relative ancestors checked and a strict bounded UTF-8 prefix.
- Existing finite command/browser verifiers are not interactive PTY/browser
  sessions. No suitable routes/dependencies exist; this milestone wires real
  file browsing and explicit copied context without labeling those tools complete.
- Reviewer found generic404 dispatch wording and top-level hidden-workspace
  preview lifecycle gaps; fixed both with tests. Parent also cleared previews on
  mobile-pane changes and preserved three-tab keyboard navigation.
- One old UI assertion expected the obsolete file-panel-unavailable wording;
  updated it to the new capability-specific message. Corrected an attachment
  validator type annotation; discovery guesses for attachments.ts/api.ts and
  safety globs failed, then resolved against rg file inventories.
- Full resource suite 2,475 passed; browser inert fixture browsed/read/attached
  README and verified control-lock clearing. No real task submitted in browser.
- Known limits remain explicit: observational not OS confinement, private-name
  filters not secret detection, bounded previews not silently truncated context.

## September 10: shared-ledger project continuation

- Baseline `b3ad1a26`; three agents divided core, HTTP and independent acceptance.
  Parent owned UI/query integration, documentation and final verification.
- Reused the existing supervisor and ledger rather than one quota store per
  project. Schema 4 adds directory identities without changing legacy digests.
  New roots require a private startup catalog; historical bindings never rebind.
- Cold review prompted a final post-reservation directory check and a narrow
  accounting distinction: a veto has no worker execution or provider cooldown,
  but does not erase its consumed reservation. Legacy startup compatibility is
  preserved; the stronger inverse-overlap check requires explicit catalog mode.
- Broad resource testing found three deterministic old fixture failures: two
  mocked quota collectors omitted quotaUnavailableWorkerIds, already required
  at baseline. Corrected the fixtures, not production behavior; final 2,421 passed
  including the new legacy startup compatibility regression.
- UI 1,126 passed; safety 449 passed with five existing skips. Browser verified
  per-project draft recovery, filtered tasks and reload clearing in an inert
  fixture. Real I/O tests verify selected cwd and shared concurrency/task caps.
- User checkout and actual active KILL retained. No account migration, provider
  job, remote publication or activation. Native tools and commissioning remain.

## September 10: follow-up conversation continuation

- Baseline `75d7897e`; clean isolated `auto/p00`, original checkout preserved.
  Entire resume found no checkpoint. Three agents covered core, HTTP and cold
  acceptance; parent integrated UI/query contracts and documentation.
- Chose copied flat context rather than live ancestry lookup: accepted children
  remain stable after source deletion. Each task retains only its own prompt plus
  flat prior turns, never a recursively composed provider prompt.
- Added separate immutable submission digest so duplicate child retry precedes
  parent lookup and remains idempotent after deletion/restart. Runtime receipt
  identities and shared account ledger are unchanged.
- Cold review caught silent draft detachment on parent deletion and a too-small
  JSON read bound for escaped captured output. Both corrected with UI/query tests.
- Integrated 200 resource tests; 1,106 UI tests; 449 safety passes, five skips.
  Independent and builder subsets overlap, not additive productivity counts.
- Real browser fixture queued/cancelled a retained child, displayed copied
  ancestry, and recovered it on reload with read authority only. Local HTTP
  transport fixtures additionally proved actual flat prompt input and no replay.
- Original KILL sentinel remains active. No Hub account/provider commissioning,
  publication, GitHub Actions or remote pushes. Project switching/native tools
  and full autonomous company loop remain unfinished.

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
