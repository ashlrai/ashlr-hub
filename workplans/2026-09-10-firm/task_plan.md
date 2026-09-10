# Executable firm: package graph

## Goal
Implement the user's firm specification as tested executable packages, preserving
existing activation, provenance, evaluation and resource invariants.

## Phases
- [x] Read the supplied specification; isolate baseline PR #404.
- [x] Inventory reused primitives and materialize P00–P47.
- [x] Wave 1: control graph, signed traces, verifier contract, harness archive.
- [x] Integrate and test a provider-free complete path in isolated CLI processes.
- [x] Connect selected allocation receipts to explicit resource runtime enrollment.
- [x] Add general signed graph inspection and actual CLI-process coverage.
- [x] Enforce KILL at Git publication and absolute deadlines at resource admission.
- [x] Bind enrolled resource generation to graph effects, outcomes and measured usage.
- [x] Expose signed graph evidence through explicitly configured MCP resources.
- [x] Separate General/Spark quota scopes without splitting shared account capacity.
- [x] Build and independently verify the first real project-bound human task workspace; final integrated gates recorded in report.md.
- [x] Add explicit local transcript retention and deletion through the existing task supervisor, API and workspace.
- [x] Verify per-scope quota ceilings stay independent in the final HTTP projection.
- [x] Add real digest-pinned follow-up conversations and independent replay/deletion acceptance.
- [x] Register multiple projects with immutable bindings over one shared ledger.
- [x] Connect explicit project selection and isolated session drafts in the workspace.
- [x] Verify catalog migration, project-local holds, accounting and UI isolation.
- [x] Map existing desktop file/tool primitives and choose the next complete integration.
- [x] Implement registered-project file browsing and explicit task-context attachment.
- [x] Verify file access, context isolation and browser interaction end-to-end.
- [x] Trace and connect the next missing unattended execution/evaluation/delivery seam.
- [x] Independently verify real outcomes and update the authoritative handoff.
- [x] Map exact signed graph dispatch and child-controller enrollment recovery contracts.
- [x] Persist parent linkage and implement factory-only receipt reconciliation without redispatch.
- [x] Verify real crash-after-delivery recovery, attribution failures, deadlines and cold review.
- [x] Build and document the verified recovery path and remaining commissioning gaps.
- [x] Explore workspace engineering enrollment, shared-ledger ownership and HTTP contracts with three agents.
- [x] Implement project-pinned engineering catalog and durable owned graph launch/cancellation.
- [x] Wire private startup enrollment, authenticated HTTP and engineering workspace controls.
- [x] Verify real HTTP evaluation/delivery, shared capacity, cancellation/restart and browser interaction.
- [x] Review integration, update canonical documentation and record exact local delivery state.
- [x] Explore engineering admission, commissioning and post-publication recovery with three agents.
- [x] Add observational readiness and refuse known launch blockers before ownership publication.
- [x] Surface actionable readiness in the workspace without hiding cancellation or claiming capacity.
- [x] Verify pre-launch no-effect holds, post-launch races, API identity and responsive interaction.
- [x] Record frozen-source validation and remaining commissioning requirements.
- [x] Explore whole-enrollment commissioning without supervisor startup with three agents.
- [x] Share strict persisted-state and project/enrollment validation with startup.
- [x] Implement standalone commissioning inspection and explicit CLI.
- [x] Prove read-only behavior against real filesystem/history and subprocess fixtures.
- [x] Verify compatibility and document the next actual Hub commissioning step.
- [ ] Subsequent waves: wire remaining packages in dependency order.
- [x] Review, record actual package/test receipts and exact local-only delivery state.

## Decisions
- Four active-agent slots total: parent plus three bounded workers per wave.
- Separate auto/package branches/worktrees, with parent as sole merger.
- No GitHub Actions. No provider dispatch or account allocation changes here.
- Keep compiled activation roots empty; no constitution or safety-test edits.
- Control graph initially lists planned packages; only real artifacts create
  digest-bearing edges. Never invent terminal states to satisfy a count.

## Errors
Commissioning continuation: review caught a 1 MiB serializer cap imposed on valid
4 MiB supervisor history; restored the store-specific limit and reran escaped
history regressions. Fixed a project-binding type mismatch, fixture setup missing
an await, per-project registration labeling, startup catalog size parity, and
runtime-cache pins before the frozen sweep. Added fixed runtime failure reasons
and worker exclusion summaries. Two guessed test-script paths did not exist;
the real-I/O registry is `test/config/realio-lane-membership.mjs`. A plan patch
matched stale wording and made no changes; corrected against the current file.
There is no separate `tsconfig.test.json`; explicit strict changed-test checking
found a fixture Map inference error after broad tests. Added only its generic
type annotation and reran the changed test and strict test typecheck.

Readiness continuation: an initial DOM test queried the asynchronous admission
panel before the catalog loaded; corrected it to await rendered evidence. A
transient web typecheck ran before the agreed graph-lock reason reached the
shared core type. Both were rerun after integration. Read-only searches also
included two guessed nonexistent paths (`.ashlr` and `src/core/kill-switch.ts`);
correct source is `src/core/sandbox/policy.ts`. No files changed by those searches.

Workspace verification: the first broad sweep overlapped a final peer-drain
patch, loading old runtime with new tests. Its three failures and unhandled
rejection are recorded as a failed mixed-source run; the frozen-source rerun is
the release gate. No test weakened to accommodate it. Independent checks also
caught fresh-store and termination-uncertainty gaps; both have regressions.

Current recovery review caught a legacy ordering regression while refusing linked
controller execution re-entry: strict history reads must follow proven-dead
record-writer lock reclamation, not precede it. The broad run was intentionally
stopped before counting it as verification; the ordering and a focused regression
passed before restarting the final frozen-source sweep. Both legacy resume and
linked refusal now have real child-owned orphan-writer-lock regressions.

Independent review found graph serialization/ID limits, archive capacity races,
signal starvation and an unsupported Windows native cancellation path. Fixed
with new regression tests. Real-I/O graph tests use a realistic execution budget
while separately checking persisted deadline exhaustion.

## Status
Current continuation from `487d9ad67a430513071ddec700c03a9ffb95ddf6`:
completed standalone commissioning increment. Frozen regression recorded 4,401
passes and five existing skips; strict changed-test typechecking and the final
annotation-only rerun passed. Full end-state work remains open; see report.md.

Implementation ownership and design:
standalone whole-enrollment commissioning. Core agent extracts shared strict
state/project/enrollment validation; CLI agent owns explicit engineering check
command; acceptance agent owns real isolated subprocess/no-write tests. Parent
joins inspection stages and documents operational use. No fake supervisor or
shallow project-header decoder. Configuration validity and known local holds are
not live admission, provider authentication or evaluation acceptance. Missing
stores may be projected as would-register; never create them during inspection.
Shared account history and pause policy remain authoritative and unchanged.

Previous completed continuation from `2b4064a32769362b11a32664af459e29bdfb8ca8`:
read-only engineering admission. Exploration confirmed pre-existing KILL can
publish an accepted launch before the graph checks its stop gate, leaving the
enrollment permanently held without work. Core agent owns observational checks
and publication guards; protocol agent owns the read endpoint; acceptance agent
owns actual isolated HTTP/Git race tests. Parent owns UI, documentation and final
integration. Preserve final effect-time checks and temporary quota capacity waits.
No actual KILL, account pause, ledger migration or provider activation changes.

UI design: retain the technical control room, Space Grotesk headings and IBM Plex
Sans data text. Reuse navy canvas #0e1730, surface #111e3a, ice text #edf3ff,
blue accent #8babff and amber held state #f5a259 through existing semantic tokens
(including light theme). Add one left-aligned admission strip between selection
and objective: observed state, sampled time and specific causes with recovery
guidance. This is not another row of decorative metrics. Status/cancel must remain
available even if readiness fails; observation never retries a launch. Stack on
mobile, preserve focus and reduced motion. Existing launch rechecks remain the
authority; no status claims provider access or reserved capacity.

Previous completed continuation from `a0f820058d32dc86b5c2eabbc52f7c390ec4ba6e`:
project-bound workspace engineering. Three agents own core enrollment/runtime,
HTTP/CLI integration and independent real-I/O acceptance. Parent owns UI/query,
documentation and final integration. Existing graph/controller/resource ledgers
remain execution truth. Catalog/status never start work; explicit ID-and-digest
launch does. Cancellation is durable, and restart never renews a deadline.

UI plan: retain the project/task rail; add a separate Engineering mode spanning
the conversation and inspector area. Use existing Space Grotesk / IBM Plex Sans,
deep-blue/ice semantic tokens and compact mono only for evidence identifiers.
Show enrolled objective, dependency order, budget, delivery branch and observed
state beside explicit launch/cancel controls. Text labels accompany all colors.
Critique: a second narrow chat card would hide the graph/evidence relationship;
the full-width engineering pane resolves this while keeping ordinary task drafts
intact. Stack dependency details on narrow viewports; keyboard focus and reduced
motion use existing conventions. Do not imply a successful model reply is an
accepted change, or a configured enrollment is active work.

Current continuation from `dc92e08cf4b4a55d7ee351e3d79c2e92a17f6c0a`:
exact completed-child reconciliation. Parent owns graph intent context, branded
receipt-only recovery and documentation; controller agent owns strict optional
parent-link enrollment with legacy compatibility; acceptance agent owns actual
CLI-process crash after real delivery; cold reviewer owns independent guards.
The parent link binds canonical graph-root digest, graph/definition/node identity
and the full signed intent digest. Only completed matching child records plus
fresh verified deliveries can settle an unresolved graph node. No new dispatch,
budget renewal, host activation or external publication. Recovery runs only
within the original deadline and existing KILL/ownership gates.
Final frozen-source Universe/firm-MCP sweep: 3,166 passes across 123 suites.
Safety: 449 passes and five existing skips. Build, core/web typecheck, lint,
documentation and real-I/O classification passed. The local recovery milestone is
complete; the broader north-star and host commissioning remain unfinished.

Implemented locally from `c2b598da`: a host-enrolled signed graph adapter over the
existing restartable portfolio controller, resource-backed campaigns, fixed
evaluation and explicit local branch delivery. Core agent owns the concrete
adapter and guarded-node registration; independent test agent owns real Git and
loopback-resource acceptance; cold reviewer audits attribution and effect gates.
Parent owns runtime digest propagation, CLI entry point, documentation and
integration. No new scheduler or ledger, no host activation or public release.
Fresh affected verification passed 484 tests across 15 suites; 449 invariant
passes and five existing skips were retained. The initial broad-sweep findings,
fixture-isolation corrections and final reruns are explicit in report.md.

Implemented locally from `1d1febaf`: three agents mapped and built scoped file
access, HTTP integration and independent acceptance. Parent integrated the Files
inspector, snapshot provenance, responsive clearing and documentation. Real files
can be previewed and explicitly attached without invoking a worker. Resource
2,475, UI 1,174 and safety 449 passes/five skips are recorded in report.md.
Native PTY/browser support and unattended commissioning remain next milestones.

Implemented locally from `b3ad1a26`: shared-ledger project selection. Preserve legacy default
workspace and scope digest; schema 4 adds immutable registered project bindings.
Startup catalogs may add projects or omit them to disable new work, never silently
rebind an old identity. Missing/replaced directories hold affected queued work;
independent projects continue. Runtime resolves registered IDs, not browser paths.
Three agents own core migration, CLI/HTTP and independent acceptance. Parent owns
project UI/query integration, documentation and final verification. Session-only
per-project drafts are the recommended default; no private drafts written to disk.

Completed local continuation from `75d7897e`: real server-assembled follow-up
conversations on the existing shared quota ledger. Three parallel assignments:
core snapshot/digest persistence, HTTP validation and tests, and independent
acceptance. Parent owns UI/query integration and final verification.

Contract: explicit parent task plus transcript digest; new request retains its
own text. Flat context copies survive source-parent deletion and restart without
replay. Every child receives ordinary task admission. Retained child copies are
deleted separately; non-retained copies are scrubbed at terminal settlement.
New-message limit stays 32 KiB; canonical runtime context is bounded at 256 KiB
with visible refusal, not silent truncation. Project switching and commissioning
remain next milestones, not claimed complete by this work.

Completed continuation from `f94387ef`: opt-in transcripts and final per-scope
HTTP ceiling projection are implemented and independently tested. Legacy tasks
keep settled-prompt deletion and session-only output; retained tasks survive
restart without replay. UI deletion clears both surfaces' cached private text.
Project selection must keep one ledger and one supervisor, not a quota store per
project. Its immutable catalog/job-scope migration is a separate follow-up.

Current continuation: graph execution and signed MCP resources integrated;
independent Codex quota scopes integrated through collector, shared evidence,
locked admission, supervision and console IPC. Personal General remains reserved;
personal Spark is authorized by user intent but not commissioned. Existing account
pause and pinned historical ledger need scoped-policy/enrollment migration first.

User added the desktop operating-layer direction and approved Ashlr Hub first,
with other projects explicitly selected. Three investigations found no existing
durable conversation, file-browser, PTY or embedded browser contract. The first
slice reuses real scoped resource task APIs, a project/task rail, composer, output
and details dock, text attachments and existing account controls. Persistent chat,
multi-project shared-ledger dispatch and native tools remain separate milestones.

P03 and P08 are integrated; cold review also tightened publication KILL checks,
runtime pinning and absolute admission deadlines. Allocation signatures remain
selection evidence; separate trusted host enrollment invokes existing resource
reservations. Real inert native/HTTP fixtures and CLI processes passed.

Fifteen locally landed component artifacts; thirty-three packages remain planned.
Full north-star completion is not claimed. Actual host KILL is active and remains
untouched. Local package, CLI, UI, release-contract and safety gates passed;
the full north-star implementation and production activation remain unfinished.

Next: conversation grouping/compaction and
confined implementation/independent acceptance. Multi-turn context is implemented;
conversation grouping and compaction remain. Resident ticks still require the
existing activation path. Current receipt bounds are not a firm-wide spend ledger.
