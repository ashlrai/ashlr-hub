# Firm build notes

## September 10: graph-owned pending campaign continuation

- Latest user answer retains measured seed context throughout the campaign.
  Already implemented: independent review verified per-generation seed context
  alongside changing parent/latest feedback; the two selected seed suites passed
  16/16 locally. No scheduler or acceptance changes are needed for that answer.
- UI plan: retain existing semantic surface/ice/navy/indigo theme tokens and
  Space Grotesk display/IBM Plex reading hierarchy; left-aligned dependency plan
  beside persistent inspector, with explicit action at the bottom. This is a
  policy disclosure change, not a palette/layout redesign. No new motion/assets.
- Actual continuation acceptance caught a reentrant read: the parent stop guard
  read a campaign while its own immutable writer lock was held, blocking B.
  Keep live authority/runtime checks writer-safe; full campaign proof remains
  before continuation, at existing controller admission, and after completion.

- Fresh baseline a2f9931ec5da1132c5d8cf030b5f6f5a5dcc4f7d is clean.
  Previous turn was verified progress (2,051 selected passing tests and a clean
  local build), not a blocked turn. Entire resume found no checkpoint.
- Three independent explorations confirmed the existing controller scheduler
  already has pending/no-intent, prerequisite delivery, original budget and
  shared quota admission. Reuse it rather than build another scheduler.
- Design: host `allowPendingContinuation: true` is included in immutable binding;
  absent flag remains byte-compatible receipt-only. A separate async registered
  callback receives a kernel-issued, non-copyable, live capability for this
  signed unresolved graph intent. Standalone linked-controller resume stays
  refused. No provider/account/global-KILL/service activation is part of tests.
- Controller lease must span receipt acknowledgement and scheduling. Reconcile
  proven prior effects, refuse any remaining held/uncertain attempt, then admit
  only untouched pending campaign rows. Never change seeds or renew deadlines.
  Declared dependencies gate execution; they do not silently provide A's artifact
  as B's source. Explicit dataflow is a separate existing/new-experiment contract.
- Kernel runs continuation at most once per graph invocation under existing
  ownership/KILL/original deadline; capability is revoked in finally. CLI/check
  and console readiness must disclose effectful continuation instead of calling
  it read-only reconciliation. Existing enrollments gain no new effects.
- Acceptance: distinct Universes, upfront two-task shared pool, actual A delivery
  confirmation fault, then exactly one B request; totals two requests, four
  evaluations, two refs with unchanged A and original graph intent. Include
  copied capability, default-off, uncertain B, drift, drain/KILL/deadline and
  ownership refusal, keeping all existing safety/account policy code unchanged.

## September 10: evaluator-only seed measurement

- `measureSeed: true` is an immutable opt-in; absence preserves legacy serialized
  definitions and projections. The evaluator-only intent/result lives in the
  existing campaign ledger, before any step or model reservation. Existing lease,
  comparator, exact seed, confinement, KILL, parent stop and deadline still govern.
- A measured result is not a trial, archive parent, delta or generation-zero
  feedback. It is bounded parsed evidence with explicit seed context. A failing
  measurement can support first-response local delivery only with the existing
  explicit `allowInitialRepair: true` plan and positive threshold-meeting change.
- Independent review identified two cross-cutting gaps: a residual evaluator
  could outlive its campaign and a late stop could arrive during record writing.
  Shared execution admission now refuses unresolved seed intents on that Universe;
  result publication reuses the private writer's final prepublish guard. Known
  unrelated Universes remain independent. No cleanup or replay is inferred.
- Proof has distinct seed intent/result digest references; legacy failed-trial
  proof shape is unchanged. Final Git checks and recovery reread current campaign,
  trial, manifest and baseline bytes. No raw evaluator output is retained.
- Readiness distinguishes unresolved and operational failures; its web decoder
  accepts those closed reasons and renders them as past observations, with no
  execution or automatic retry control. Seed measurement is not automatically
  included in model feedback; that remains a separate provenance-aware increment.
- Three parallel agents authored runtime, proof/acceptance and independent tests.
  They exhausted account usage after saving work. Parent performs remaining local
  gates and delivery; no substitute account/provider is silently selected.

## September 10: measured initial Hub repair

- Independent evaluator committed first at `9bf75b59`; actual source baseline
  passes 82/142 fixed cases and fails 60. Candidate `e2e4e33d` changes only the
  marker-title path extraction and adds 75 focused regressions. The raw scanner
  already filters non-code paths: scope is shared historical/custom WorkItems,
  not proven fresh-scanner leakage or measured token savings.
- Real full-Hub-seed fixture initially reached the passing repair but withheld
  delivery in three diagnostic runs. A first selected elite correctly has null
  parent/delta; old campaign delivery required a prior passing parent. Do not
  invent lineage or weaken the frozen evaluator to get a delivery receipt.
- `allowInitialRepair: true` explicitly permits a positive finite improvement
  against an earlier valid failed evaluation of the exact unchanged seed in the
  same campaign/niche. Reuse immutable campaign/run/step/comparator identities;
  verify baseline bytes at final Git effect checks and during read-only recovery.
  Default delivery policy is unchanged. The mode consumes recorded evidence and
  does not introduce an automatic baseline-evaluation request.
- The helper has 47 pure tests; independent delivery review adds 14 actual local
  campaign/Git tests including tamper inside the prepared ref transaction. An
  early fixture run hit the default unit timeout before real-I/O classification;
  no production budget was raised. Strict changed-test typecheck found a wrong
  `universePath` import in full-Hub acceptance; that test-only import was corrected
  after its in-flight run finished, then typechecked before one clean rerun.
- Controlled worker proposals are baseline bytes, an evaluator edit that must
  be refused, and the exact already-reviewed candidate blob. Their loopback
  usage counts are fixtures, not provider telemetry or autonomous ideation.
- Keep both evaluator and candidate commits in integration ancestry, not only
  cherry-picked source, so full-history clones can reproduce immutable pins.
- Host KILL remains active/healthy. No actual provider requests, account policy
  changes, history migration, persistent activation, Actions or remote release.

### Historical next-step exploration (implemented in the continuation above)

An immutable opt-in campaign seed-measurement phase could use the existing
execution lease, fixed evaluator confinement, parser and original wall-clock
deadline before generation. Record separate intent/result events pinned to
campaign, comparator and exact seed; never invent a generation-zero variant,
passing elite or failed parent. It should reserve zero model requests, reuse a
settled exact result, and hold an unresolved intent rather than automatically
rerun uncertain evaluator work. Delivery would need a distinct proof reference
to those event digests. Test first-response repair, passing seed, malformed
output, timeout/cancellation, crash replay, byte/comparator drift, exhaustion
and unchanged legacy campaigns. This was the proposal at `2baeef06`; the new
continuation above implements the opt-in evaluator-only path.

## September 10: standalone engineering commissioning

- Baseline 487d9ad6, isolated auto/p00; three agents mapped strict validation,
  the CLI boundary and actual no-write acceptance before implementation. Entire
  resume found no checkpoint. Parent owns checker, integration and final commit.
- Shared detached schema 1–4 decoder validates complete task/transcript history;
  project previews preserve immutable historical pins and append-only registration.
  Shared enrollment preparation produces the live owner's same digests without
  constructing a supervisor, taking a lease or activating a collector.
- Standalone stages inspect explicit pool/bindings/observations, project catalog,
  supervisor and ledger history, enrollment linkage and resource runtime. Re-read
  captured configuration for drift. Missing state/key/ownership is not repaired.
- Closed report exposes fixed failures, enrollment identities and local policy
  holds; invalid runtime reports retain the failing runtime stage without leaking
  private partial records. Runtime cache includes the expected digest, not just
  a path. Per-enrollment registration does not inherit unrelated additions.
- Fifteen real subprocess fixtures snapshot every fixture/HOME directory and file
  (identity, permissions, timestamps excluding atime, contents), proving no
  writes or create/remove lock cycles. Worker listener receives zero requests;
  evaluator is never called. Historical policies, retained jobs, corrupt evidence,
  missing roots/keys, replaced projects and ownership/KILL holds are covered.
- Fifteen independent mocked tests cover option accessors, semantic snapshot
  drift, digest-pinned runtime caching, runtime diagnostics and capacity honesty.
  CLI tests show per-worker exclusions while keeping configured distinct from
  admission. No fixture evidence is described as authenticated account acceptance.
- Source/tests frozen before broad regression. Existing host KILL remains
  active/healthy; actual accounts, personal General reservation, shared capacity,
  old ledger, native profiles and services remain untouched.
- Independent next-campaign exploration found a concrete selection-quality bug
  in `src/core/portfolio/value-filter.ts`: backlog marker paths with spaces, test
  suffixes or Windows separators can bypass non-code filtering. Candidate only,
  not part of this release: first author a fixed evaluator proving baseline
  failure and preserved security/source-work exceptions, commit it before pinning
  the seed, and allow only that source file to change. Pin its existing shared
  resource runtime, measured request budget and explicit local delivery branch.
  No evaluator, campaign or provider execution was created by this exploration.

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
# September 10: retained measured seed context

- Baseline `5b8af0aecc1fc32f0f7ad7bcfacd05430697e665`, isolated `auto/p00`.
  User explicitly chose to retain seed context throughout a campaign.
- Three parallel streams: shared broker/receipt codec, independent history and
  restart validation, actual resource acceptance plus existing UI inspector.
- Context is separate historical evidence, not a trial/parent or acceptance.
  New measured-seed campaigns with feedback pin it once per generation; legacy
  absent-context runs and prompt bytes remain unchanged.
- Full run context is bounded to 16 KiB; each generation receipt stores only its
  version and digest. Existing trial/final record budgets remain enforced.
- Raw campaign reconstruction avoids recursive summary projection. Run start,
  final and prompted receipts are checked against the same exact measurement.
- Cold review found and corrected a missing parent-stop recheck after synchronous
  context verification. Another review required version-two search evidence for
  every seeded run; historical unpinned version-one runs remain supported.
- Web serialization omits seed diagnostic messages and paths in both run and
  campaign views, without rewriting private records. Inspector adds receipt
  details only when present, with no extra requests or layout redesign.
- Initial full-Hub acceptance exposed an unresolved automatic-delivery handoff
  despite 142/142 evaluated cases passing; investigate before claiming delivery.
  Final frozen-source results belong in report.md, not this exploratory log.
- Non-impacting errors: early metrics narrowing fixed; standalone strict test
  checking found an existing intentional extra-field fixture needing an unknown
  cast. Initial empty patch hunk was rejected; corrected patch succeeded.
# September 10: durable handoff diagnosis and exact recovery

- Final small actual graph acceptance passed (1 test, no skips, 27.50 s).
  It proves one worker request, two evaluations and one Git ref publication
  across injected degraded confirmation, exact-link/stop/ownership/drift
  refusals, expired child/live parent plus drain recovery, and replay.
- First graph fixture retained an unresolved result instead of completing its
  acknowledgement. The helper's aggregate ten-second cap was removed in favor
  of the already supplied parent deadline, with a ten-second fallback only
  when absent. A later run passed; the first refusal's exact cause was not
  recorded, so this is not a claim that the historical full-Hub failure is fixed.
- Cold review added final immutable-publication proof/stop guards, old terminal
  rejected-node immutability, and preservation of near-capacity legacy cleanup.
  A preexisting control test assumed a once-only settlement callback and reread
  its ledger recursively; it now checks the captured records at both the short
  transaction and immutable writer publication boundaries. Final diagnostics
  and controls: 66 passed; source/strict test types and scoped lint passed.
- Final web suite: 1,243 passed / 75 files, no skips (10.73 s). Existing UI
  inspector now shows historical closed stage/code diagnostics without exposing
  private intent digests or adding fetches, retries, or raw exception text.
- Final controller/portfolio gate: 665 passed / 29 files, no skips (236.48 s).
  Final graph/control/engineering gate after cleanup-edge additions: 141 passed /
  eight files, no skips (109.68 s). All eight changed core tests pass strict
  TypeScript. Production build and five compiled structural checks pass. Final
  full-Hub same-source acceptance: two passes, no skips (180.98 s). Together
  with the web gate: 2,051 passes / 113 disjoint files, no skips. Local commit
  and clean build identity are the final handoff steps.
- First 29-file gate reported 658 passes and one fixture JSONL parse failure
  while waiting for initial native contact, before cancellation assertions.
  The unchanged cancellation case passed in isolation. The fixture reader now
  waits for a complete newline-terminated snapshot and still rejects malformed
  complete records; six parser cases were added. All original cancellation
  assertions and budgets remain unchanged. Focused file: 13 passed, no skips.
- Parent/cold review found a further committed-settlement cleanup edge: the
  controller can throw after durable metadata publication or return an
  unavailable wrapper over complete outcomes. The adapter now preserves only
  freshly proven exact all-completed acknowledgements for later recovery,
  not permanent delivery-proof rejections. In-flight matching separately permits
  projected pending dependency reasons; pending work is never executed by the
  receipt-only helper. Actual cleanup/wrapper and pending-child tests passed.
  Early fixture setup issues (same-Universe child; fault hook before
  initial ledger creation) required test-only corrections.

- Baseline `49206a87ec19b34861e5bb63a16af7e8b92b26fa`, clean isolated
  `auto/p00`; Entire resume found no checkpoint. Previous turn was verified
  progress, not a wait or blocker. Host/provider/account settings remain outside
  the fixture work.
- Explore found a concrete seed recovery bug: completed dispatch attribution
  admitted only step events, rejecting valid seed measurement intent/result
  events. The strict campaign fold already proves that pair belongs to the same
  session; recovery can accept it without relaxing dispatch identity.
- A post-publication read-only delivery inspection can fail while the actual
  branch and receipt exist. Its ten-second inspection budget is a plausible
  trigger for the historical intermittent failure, not a proven diagnosis.
- New immutable diagnostic events record one bounded controller-owned phase and
  closed code per exact dispatch intent. They do not settle work, release slots,
  change outcomes, retry calls or expose raw exception properties.
- Independent real fixture reproduces post-publication confirmation failure:
  one worker, two evaluations and one branch publication; direct receipt-only
  restart acknowledges completed work without repeating any effect.
- Graph-level gap: initial incomplete controller reports became terminal rejected
  nodes, while branded recovery only accepted already settled child controllers.
  Implement receipt-only metadata reconciliation for the exact graph binding and
  leave healthy in-flight acknowledgement failures unresolved. Do not reopen
  historical terminal rejected graphs or weaken normal fresh-enrollment rules.
- Preserve existing clocks: child deadline is not renewed; completed-effect
  metadata cleanup may occur after it, but graph deadline/KILL/ownership still
  gate graph-linked reconciliation. Drain blocks new admission, not settlement.
- Design plan uses existing white #ffffff/ice #f5f7fc/navy #172746 and #0e1730/
  indigo #526fe8 tokens, Space Grotesk display and IBM Plex text. A left-aligned
  diagnostic table reuses bounded horizontal scrolling and existing focus styles.
  Layout: outcomes -> historical failure stage/code/time -> receipt guidance.
  No new animation, hooks, fetches or decorative dashboard cards.
- Cold review caught optional diagnostic capacity competing with old settlement
  and control reserves; preserve already-admitted cleanup. Another review asked
  for final prepublication settlement checks used by graph metadata recovery.
- Read-only discovery guessed nonexistent Controller route globs; located the
  actual inspector under src/web-ui/app and controller-status decoder under data.

## Next-step exploration (proposal only, not implemented)

- Reuse the existing controller scheduler and shared ledger for untouched pending
  descendants; it already checks original campaign pins, prerequisite delivery,
  ownership and no prior intent. Do not create another scheduling subsystem.
- Keep receipt-only recovery distinguishable from effectful continuation. A
  proposed host-bound opt-in plus separate branded asynchronous callback would
  preserve old enrollment semantics; this is an architectural option, not an
  implemented or approved permission change.
- Require the original graph intent and live kernel context, reconcile proven
  prior effects, then admit only genuinely pending campaign rows under both
  original deadlines and existing drain/KILL/runtime/quota guards. Never resume
  through a copied graph descriptor or renew an enrollment deadline.
- Acceptance should prove one downstream request after upstream delivery,
  repeated-interruption idempotency, unchanged reserves, exact pins/receipts,
  and no new effects from legacy receipt-only or ambiguous histories.
