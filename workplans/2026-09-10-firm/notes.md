# Firm build notes

## September 10: local engineering admission continuation

- Baseline 2b4064a3, clean isolated auto/p00; Entire resume again found no checkpoint.
  Three Explore agents independently mapped admission, commissioning and real
  acceptance before editing. Missing standalone commissioning/service/account
  migration remains distinct from this existing-console readiness observation.
- Confirmed pre-existing KILL could publish launch ownership before graph stop
  admission. Readiness now exposes fixed bounded causes and gates initial launch
  before the wrapper mutex, under it, and at immutable-record publication.
- Reused existing campaign readiness, project binding, host-only factory pins,
  read-only provenance key inspection and signed graph evidence. No eligible
  worker-count gate or new quota scheduler. Occupied capacity still waits under
  the existing resource runtime policy. Active read polling avoids expensive
  factory reconstruction through the already-running return.
- Cold review caught another known-before-launch condition: an existing graph
  execution lock. Presence holds fresh launches only, without assuming a live
  owner or reclaiming a lock. Accepted linked reconciliation retains the ordinary
  proven-dead lock recovery; it is not blanket-blocked by lock presence.
- Updated real missing/pending recovery regressions to introduce KILL only after
  actual immutable launch publication. Pre-existing stop and post-acceptance race
  must not be conflated. Seven reversible blocker cases restore the exact condition
  and prove the same enrollment can subsequently dispatch.
- UI reads job and readiness independently in parallel, validates exact identity,
  closed schema/reasons and action consistency, and preserves Stop when readiness
  fails. No automatic launch, retry, account enrollment or local stop repair.
- Source and tests were frozen before broad verification. Real browser acceptance
  uses a separate temporary HOME/Git/loopback fixture and installed ephemeral
  headless Chrome. The host KILL and actual account configuration are untouched.

## September 10: workspace engineering continuation

- Baseline a0f82005, clean isolated auto/p00. Three Explore agents mapped core
  ownership, HTTP/CLI and real acceptance before implementation. No graph-root
  writes during catalog construction/status; ordinary supervisor startup can
  initialize its own existing state. UI reads never dispatch.
- Corrected an early proposal that equated the generation transport directory
  with the selected project. It must remain sterile; actual campaign seeds and
  delivery derive from the registered project and pinned directory identity.
- Fresh ownership-store reads use missing as an empty unlaunched state, not a
  malformed incomplete store. A read-only acceptance test caught the initial bug.
- Signed optional hostEnrollmentDigest and under-lock requireNewGraph protect
  initial race/restart attribution. Accepted launch with missing/pending intent
  stays held. Queue pause applies to initial admission, not in-flight cancellation.
- Shutdown needs more than a resolved graph promise: the final shared ledger
  fence rejects reserved/uncertain/unreadable receipts. A captured peer-drain hook
  prevents checking before ordinary owned tasks finish cancelling. No second
  scheduler, ledger or callback authority exposed to browser inputs.
- UI/query review corrected stale mutation responses after connection loss,
  unlock changes, unavailable-enrollment wording, empty-intent reconcile controls
  and paused-queue launch state. Existing React/style primitives were reused.
- First broad suite ran across the final source edit; its mixed-revision failures
  are not counted as a green verification. Full frozen-source rerun is required.
- Tool discovery mistakes were read-only: ResourcePoolView lives under resources,
  graph types are colocated, and a guessed manifest.ts does not exist. In-app
  browser fixture navigation was blocked; isolated installed Chrome provided
  actual local acceptance. Source static assets and networkidle waits required
  fixture-only corrections. See report.md for final evidence and limitations.

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
# September 10: exact completed engineering recovery

- Baseline `dc92e08cf4b4a55d7ee351e3d79c2e92a17f6c0a`, clean `auto/p00`.
  Entire resume found no checkpoint. Original checkout remains separately owned.
- Reused signed graph intent, immutable controller enrollment, completed campaign
  projection and verified local branch receipts; no second scheduler or ledger.
- Optional strict `graphDispatch` binds schema, canonical graph-root digest,
  graph ID, definition digest, node ID and full signed intent digest. The signed
  event chain transitively binds the original graph enrollment/deadline. Existing
  controller creation records are never backfilled with a new association.
- Factory-private recovery is synchronous receipt collection. Generic callbacks,
  copied registration metadata and unfinished controller work cannot be retried.
- Recovery validates controller outcomes against the exact folded ledger snapshot
  and rereads ledger bytes after checking every actual planned delivery/ref.
  KILL, ownership and the original deadline are checked before settlement and
  again at immutable record publication. Expiry never grants a new allowance.
- Cold review confirmed that direct re-entry of a linked child controller could
  omit the parent's shorter outer deadline. Such execution re-entry is refused,
  even with an exact copied parent link. Unlinked legacy restart behavior remains
  unchanged; graph recovery uses only existing read-only evidence projections.
- New real crash fixture intercepts only the child controller's exact physical
  lock release and sends SIGKILL after unlink. Campaign work, evaluation, delivery
  and signed graph records remain real; no production fault-injection hooks.
- Fixture-only linkage/ref mutations test refusal, not successful fabricated
  evidence. The happy recovery uses untouched actual child records and signatures.
- Initial transient test import failed while new graph imports preceded adapter
  exports; no provider calls occurred. The final frozen-source run is authoritative.
- Relocated-graph negative fixture initially copied directories with nonprivate
  modes and therefore failed before attribution validation. Explicit fixture-only
  `0700` directory modes make the copied history healthy before root-link refusal.
  Actual 21-case engineering acceptance then passed, including single-consumption
  downstream recovery with unchanged resource, campaign, branch and checkout data.

## Next workspace integration: read-only exploration, not implemented

Final recovery verification: 3,166 passes across 123 Universe/firm-MCP suites;
449 safety passes with five existing skips. Build, typecheck, lint, docs and
classification passed. Frozen-source broad run took 1,253.17 seconds; the earlier
interrupted run was not counted. No provider commissioning or public release.

- Reuse `src/core/web/resource-console-server.ts` for authenticated bounded HTTP
  routes, `pool-supervisor.ts` project bindings, and existing WorkspaceView/query
  controls. Existing jobs are individual resource tasks, not engineering graphs.
- Proposed separate **Run enrolled engineering** action selects an explicit
  startup catalog entry with project ID and expected enrollment digest. Browser
  input must not become runtime paths, evaluator commands or CLI arguments.
- Missing contracts: pinned project/repository association, durable graph-job
  identity, locally owned cancellation and restart behavior. Keep signed graph
  evidence authoritative instead of inventing duplicate task completion state.
- The existing `resource-generation.ts` calls `runResourceTask`; pin the same
  ledger/pool/bindings and shared-collector evidence as the resource console.
  The sterile generation workspace remains separate from the project checkout.
- Next acceptance should combine actual HTTP/UI launch with the real engineering
  Git/loopback fixture, simultaneous shared-capacity ordinary tasks, drift refusal,
  owned cancellation and exact recovery. No UI/server source changed in this pass.
- Non-impacting documentation edit error: a patch context did not match; no file
  changed, and the insertion was retried against this exact section heading.

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
