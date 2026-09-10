# Verified local handoff

## Current continuation: real follow-up conversations

Baseline: `75d7897e9bcbd7b8677f37eca58fd95dfa29020c`; branch `auto/p00`,
`/Users/masonwyatt/.codex/worktrees/ashlr-hub/firm-p00`. Final source is the commit
containing this report. Three parallel agents implemented core context storage,
HTTP integration, and independent failure/recovery acceptance. Parent integrated
the workspace/query UI, documentation and verification.

- Follow-ups carry an explicit parent ID and transcript digest. The supervisor
  copies a flat conversation and dispatches through the existing task runtime and
  shared resource ledger. Each new task consumes normal admission; identical
  retries compare immutable submission identity before source-history lookup.
- Schema 3 preserves schemas 1/2 and existing task receipts. Accepted child copies
  survive parent deletion and restart; deleted child text is never resurrected.
  Non-retained copies are scrubbed at terminal settlement. Missing and truncated
  responses keep their actual evidence markers rather than becoming fake answers.
- New messages stay within 32 KiB; compiled conversation prompts within 256 KiB.
  Existing 4 MiB state admission reserves escaped context and future retained
  output. Malformed restored context fails closed before replay or state writes.
- UI explicitly pins a read transcript, displays copied history, and preserves
  parent intent across inspection, source deletion and same-scope restart. Only
  explicit standalone/new-task actions detach context. Worker, access, limits and
  retention remain explicit choices; no provider-native session is claimed.
- **200 resource/conversation tests passed across 11 files**, including 47 added
  cases; **1,106 UI tests passed across 66 files**. Worker/reviewer subsets overlap
  these integrated totals. Safety: **449 passed, five skipped across 41 files**.
- Full core/web typecheck, production build, quiet source/test ESLint, docs,
  real-I/O lane classification and compiled structural safety verification passed.
  A final build follows the integrated commit so build identity names clean source.
- Browser fixture verified pinning, explicit submission to an inert Spark worker,
  queued cancellation, copied null-response ancestry and retention across reload.
  Reload removed control authority while authenticated reads remained available.
  Fixture endpoints cannot contact a real provider; no Hub provider job or account
  allocation change was performed. Preview stopped after verification.
- Actual host KILL remains active; original user checkout is unchanged. No GitHub
  Actions, remote push, npm publication, desktop installation or production
  activation occurred. The entire autonomous-company goal remains active.

Next: explicit project selection over one shared account ledger, conversation
grouping/compaction, confined implementation and independent acceptance, native
desktop bootstrap/tools, then evidence-backed always-on commissioning. The 48-node
package plan is not inflated by this UI continuation: 15 locally landed component
artifacts and 33 planned packages remain the historical package accounting.

Planning and agent-building skills preserved the existing runtime; frontend and
React guidance kept context explicit and private reads out of polling caches;
engineering-documentation guidance separates tested source from live activation.

## Prior continuation: restart-safe private transcripts

Baseline: `f94387ef33761def1f71f14ba6c5c9e0589a2365`; branch `auto/p00` at
`/Users/masonwyatt/.codex/worktrees/ashlr-hub/firm-p00`. Final source is the commit
containing this report. Three parallel workers covered core implementation,
resource/HTTP integration, and independent failure/privacy acceptance; parent
implemented the UI/query layer and integrated the result.

- Explicit per-task retention persists the exact composed request (attachments
  included) and a captured response across restarts. Legacy ephemeral tasks are
  unchanged. This is a durable task transcript, not automatic multi-turn context.
- The existing supervisor's atomic state transaction stores terminal status and
  captured response together. Receipt-only recovery reports missing output and
  never reruns a task to reconstruct it. Resource task digests and ledger remain
  unchanged; no per-project or per-transcript quota allowance is created.
- UTF-8-safe response capture is bounded to 64 KiB. Worst-case JSON escaping and
  every pending retained response are reserved before admission within 4 MiB.
  Terminal-only deletion removes active transcript/session text, keeps execution
  tombstones and immutable consent, and does not renew the 256-task history limit.
- Authenticated, on-demand history reads and control-token deletion are connected
  to the workspace. Deletion clears loaded/in-flight text in both operating
  surfaces, including when the operator switches tasks while deletion is pending.
  Local plaintext retention and deletion/backup limitations are visible and documented.
- Corrected the final HTTP usage-ceiling projection: General-only quota denial
  no longer hides explicitly independent Spark capacity. Same-bucket aliases,
  account access and health vetoes remain shared. The prior server test fixture
  was updated to implement the required quota-only callback.
- **153 resource/supervisor/history tests passed across seven files**; **1,090
  UI tests passed across 65 files**. Focused worker/reviewer runs overlap these
  integrated totals. Safety: **449 passed, five skipped across 41 files**.
- Core/web typecheck, production build, quiet repository ESLint, real-I/O lane
  classification and documentation checks passed. Source and compiled safety
  verification remain local checks, not evidence of production activation.
- Browser acceptance used a named inert local fixture: retention defaulted off,
  unlocking did not submit, explicit submission queued without provider capacity,
  cancellation enabled terminal history controls, and a reload preserved readable
  request history without execution authority. HTTP tests additionally restarted
  actual console servers and verified deletion, no resurrection and no replay.

Schema 2 is first written on opted-in admission; older binaries cannot read it.
Do not downgrade against that state or clear execution history. Deletion is not
secure disk erasure and does not remove backups, crash-left temporary copies or
provider history. Read-only consoles do not start a supervisor to inspect history.

Host accounts, allocation settings and global KILL were not changed. Personal
General remains reserved; personal Spark commissioning is still outstanding.
No provider invocation, remote push, GitHub Actions, npm release, daemon activation
or production deployment occurred. The original checkout and its workplans remain
untouched. The package plan stays at 15 locally landed components and 33 planned;
these extensions do not imply full autonomous-firm completion.

Next: bounded conversation context, explicit project catalog/selection over one
shared ledger, history-preserving account enrollment, and confined implementation
with independent acceptance. Planning/agent-building guidance preserved existing
runtime contracts; frontend/React guidance shaped privacy-safe interaction;
engineering-documentation guidance kept retention, migration and activation clear.

## Current continuation: intelligence scopes and human workspace

Integration branch: `auto/p00`, isolated from the original working checkout.
Core commits: `8f86b2f9` (signed MCP resources), `94a0e7a7` (graph execution
binding), `f98ddaf0` (resource graph adapter), `d6207e8a` (quota scopes).
Workspace and documentation are recorded in the commit containing this report.

- General and Spark have explicit independent quota associations, while account
  concurrency, task caps, access and health remain shared. Unknown associations
  remain conservative. Existing account settings were not migrated or changed.
- The graph adapter binds execution policy and real completion metadata into
  signed outcomes. Rejected/interrupted work cannot unlock dependent tasks.
  Reported token usage is not independently accepted engineering yield.
- Explicitly configured MCP resources expose verified graph/trace history;
  malformed history is refused, not silently truncated or repaired.
- Workspace adds a pinned-project/task sidebar, central task composer, exact
  worker selection, actual response reads, cancellation and resizable tools dock.
  Text attachments are bounded reference data, not instructions or automatic
  uploads. The existing resource session and quota-aware dispatch path are reused.
- Drafts survive Workspace/Resources navigation without browser storage. Auth
  and host scope changes clear private state. A cold reviewer reproduced a
  late-submit session race; the fix and regression test are integrated.
- Final UI suite: **1,061 passed across 62 files**, including 56 new workspace,
  attachment and independent acceptance/navigation tests. These overlap the
  builder's 26 focused workspace/acceptance cases and are not additive.
- Graph/MCP integration: 201 passed across eight files. Quota worker: 574 distinct
  focused cases passed; parent rerun: 199 overlapping resource/graph cases.
- Final safety rerun: **449 passed, five skipped across 41 files**. Full core/web
  typecheck, production build, quiet whole-repository ESLint, documentation and
  real-I/O classification passed. Compiled `verify-safety` passed all five
  structural checks. These are local gates, not production activation evidence.
- Browser acceptance used only a clearly named inert local fixture. At 320,
  390, 1,140 and 1,440 pixels there was no horizontal overflow. Mobile panes,
  surface draft preservation and exact 520-pixel keyboard dock resizing worked.
  No browser errors were logged. No real-provider task was submitted.
- Existing-key verification: all 20 local merge attestations verify. The plan
  retains 48 packages, 15 locally landed component artifacts and 33 planned.
  Workspace and quota extensions do not fabricate additional package completion.
- Original checkout remains at `a01fc08663baab3039c4f1c084538de732a4fd0e`,
  with its prior untracked workplans untouched. This continuation changes no
  daemon/conductor activation code, constitution or H1–H8 tests from `1bcda18e`.
- Entire remains enabled in manual-commit mode; resume found no checkpoint.
  No provider activation, account migration, GitHub Actions, remote push, npm
  publication, native application installation or production deployment occurred.

Personal General remains paused. Personal Spark is authorized by user intent but
not commissioned: a durable General-only exclusion and history-preserving quota
enrollment migration are required first. Global KILL remains present and unchanged.
The desktop slice is a task workspace, **not durable multi-turn chat**. Project
switching, file browsing, PTYs, browser tools, resident firm execution and verified
self-improvement remain next milestones. Output is session-retained, not streamed;
completion is not independent acceptance. The full north star is not complete.

Frontend-design and React guidance shaped the responsive three-pane UI and scoped
async state. Browser guidance provided actual local visual acceptance. Planning,
agent-building and engineering-documentation guidance kept ownership explicit,
reused the runtime and distinguished tested implementation from activation.

## Continuation: allocation execution and general graph inspection

Implementation revision: `63d1c1016f59ae42528cb674d3f3bcc9fe77f891`, branch `auto/p00`.
Seven worker/reviewer roles across bounded waves; three cold reviews, maximum
four concurrent agents including parent. Parent alone committed and integrated.

- P03 adds general signed `firm graph` / `firm traces` CLI and SDK queries.
  Complete history verification precedes filtering; conflicts survive filtering;
  real CLI processes reject damaged signatures without exposing partial traces.
- P08 consumes signed allocation selections through separately enrolled runtime,
  pool and worker bindings. Existing reservations, quotas, reserves, access policy
  and replay identity are reused. Tests invoke real inert native/HTTP transports.
- Shared Git publication now observes KILL at its prepared transaction boundary.
  Recovery still records an exact previously published branch under active KILL.
- Runtime configuration is pinned at consumption. Effective absolute deadlines
  are also checked inside the actual resource ledger lock before reservation.
- Final affected resource/graph run: 179 passed (117 runtime, 39 adapter, 23 query).
- Final focused delivery run: 38 passed. Broader delivery/handoff run: 113 passed;
  these overlapping runs must not be added as independent coverage.
- Graph/demo/allocation/pool/package/release regression run: 201 passed across
  seven additional files. Together with the 179 and 38 runs, 418 distinct focused
  test cases passed; the broader 113-case delivery run is not added to that total.
- H1–H8: 449 passed, 5 skipped, unchanged suites. Core/web typecheck, production
  build, quiet whole-repository ESLint, docs and real-I/O membership checks passed.
- Compiled verify-safety: all five structural checks pass. Package plan: 48 valid
  nodes, 13 locally landed components, 35 planned; 16 existing-key signatures verify.
- Global KILL re-read as active/healthy and left unchanged. No actual provider
  dispatch, account changes, daemon activation, GitHub Actions or publication.
- Original checkout still points at `a01fc08663baab3039c4f1c084538de732a4fd0e`;
  its existing untracked workplans remain untouched. Entire is enabled in
  manual-commit mode on `auto/p00`; resume found no existing checkpoint.

Limits: P08 is an explicitly enrolled host API, not a connected resident firm;
allocation identity is not proof of account identity. Newly issued receipts do
not yet share cumulative hypothesis accounting. Native output limits are not
hard token/spend caps. Every completion remains independently unaccepted. Graph
effect adapters, cold model verification, resident ticks and commissioning remain.

Planning kept ownership and package receipts explicit; agent-building guidance
preserved the existing stack; documentation separates tested code from activation.

## Prior wave evidence (historical)

Implementation source: `307a55def0ec438ac6d24b9c3c187fb782551436`, plus the
subsequent resource-worker documentation and evidence ledger. Branch `auto/p00`.

- 11 locally integrated package artifacts: 10 code/test components, 1 inventory.
- 317 feature/package/real-CLI tests passed across 12 files.
- 449 H1–H8 tests passed; 5 skipped, unchanged safety suites.
- 1,005 UI tests passed across 58 files.
- 67 existing release-artifact contract tests passed.
- Full core/web typecheck, build, docs check, lint and real-I/O membership passed.
- `verify-safety --json`: all five structural checks passed in source and build.
- 48 graph-plan nodes validated; 12 existing-key merge signatures verified.
- Existing compiled activation roots, constitution, merge gate and safety tests
  unchanged from baseline. No self-diff suite was found under that literal name;
  H1–H8 and explicit protected-path diff checks are the checks actually run.
- Actual host global KILL is active. Compiled demo correctly withheld all work;
  the full accepted CLI fixture ran in test-owned homes with existing fixture keys.
- No provider/account changes, GitHub Actions, remote push, npm release, service
  activation or production deployment. The generated empty host-demo root was
  removed after confirming it held no records.
- Entire is enabled in manual-commit mode on `auto/p00`; resume found no prior
  checkpoint at start. No checkpoint ID was reported by the final status check.

At this prior checkpoint, the complete 48-package end state was not achieved;
37 packages were still planned. Use the current counts above and current
`artifacts/control-graph.json` for continuation.

Planning and agent-building skills kept work bounded within the existing runtime;
the engineering-documentation skill separated implemented, verified and activated
states and provided an evidence-led handoff.
