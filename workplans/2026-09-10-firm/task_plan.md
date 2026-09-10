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
Independent review found graph serialization/ID limits, archive capacity races,
signal starvation and an unsupported Windows native cancellation path. Fixed
with new regression tests. Real-I/O graph tests use a realistic execution budget
while separately checking persisted deadline exhaustion.

## Status
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
