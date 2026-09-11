# Autonomous firm: implementation and activation gaps

This is the implementation map for the September 10, 2026 firm build, based on
`5c270bc73890e474463c31764d51e76196ad2e3f` and the local `auto/p00` package branch.
It is not a commissioning certificate. No production authorization, account
connection or running resident process was established by this source audit.

The executable package plan lives in
[`artifacts/control-graph.json`](../artifacts/control-graph.json). Planned `requires`
are not execution edges. A runtime edge exists only after its source artifact
digest is committed into a dispatch intent. Package reports and unsigned trace
stubs are review aids, not signed runtime evidence.

## Classification

- **EXISTS-LIVE** requires current end-to-end operational evidence. No item below
  receives this classification merely because source or a CLI exists.
- **UNWIRED** means some tested implementation exists but the complete firm path
  is not connected or commissioned. Existing command callers are noted explicitly.
- **MISSING** means the required behavior is not implemented in the reviewed path.

## Function map

| North-star function | State | Existing machinery and remaining gap |
| --- | --- | --- |
| Purpose and living end state | UNWIRED | `value-allocation.ts` binds mission/spec evidence to the pure portfolio scorer; `value-allocation-store.ts` persists signed ID-bound receipts. `firm-resource-execution.ts` now consumes a selected receipt through explicit host enrollment and existing resource reservations. The resident planner/graph caller remains unwired. |
| Competing plans and artifact graph | UNWIRED | `control-graph.ts` persists signed intent/settlement and artifact dependencies. `firm-resource-control-handler.ts` connects enrolled response generation. The engineering adapter and CLI connect explicit host enrollment to resource-accounted confined file operations, fixed evaluation and strict-improvement local branch delivery. The optional resource-console Engineering runs pane adds project-pinned ID/digest launch, durable stop and recorded graph inspection on that same engine. Exact completed-child receipts can reconcile interrupted graph settlement; resident planning, unfinished child recovery and live commissioning remain unwired. |
| Worker identity, quotas and reserves | UNWIRED | `src/core/resources/pool-runtime.ts` and `native-profile.ts` implement explicit bindings, admission and profile isolation. Offline additive pool evolution preserves old receipts, conversation origins, allocation and account-wide pauses while admitting new configuration epochs. Separate persisted General/Spark scope reservations preserve account-wide pauses and shared capacity. Actual account commissioning remains unfinished. |
| Codex, Claude and local execution | UNWIRED | Existing resource generation calls the pool. Personal general Codex remains reserved; personal Spark is permitted by user intent but needs explicit quota-scoped enrollment and safe policy/ledger migration. Preserve configured ceilings; do not interpret worker usage as account-wide spend. |
| Grok execution | MISSING | Account connection/display is distinct from the core pool provider enum, which supports Codex, Claude and local workers. |
| Learned routing | UNWIRED | `src/core/run/router.ts` and daemon already call learned routing. New accepted-work receipts still need an evidence-backed feedback connection. |
| Best-of-N worktree execution | UNWIRED | `src/cli/swarm.ts` dispatches existing swarms. The new firm graph does not yet dispatch these swarms or isolate their sessions. |
| Cold rival verification | UNWIRED | `cold-verifier.ts` binds a minimal request to distinct enrolled execution IDs and a nonce. Physical isolation and evaluator quality belong to the transport; identity strings alone do not prove either. |
| Signed decisions and conflicts | UNWIRED | `decision-trace.ts` signs with existing read-only provenance and preserves conflicts. The graph uses it; sandboxed engine, daemon and all other effects are not yet joined. |
| Agent-first queries and MCP | UNWIRED | `firm graph` / `firm traces` and optional gateway resources inspect signed history with bounded filters and retained conflicts. MCP requires an explicit private `firm.graphRoot`; real CLI processes are tested. Live ownership, operator controls and resident projections remain separate. |
| Integration and handoff | UNWIRED | Existing integration/evaluation/delivery/handoff commands are local primitives. Git publication now rechecks global KILL under its prepared ref lock; exact already-published intents can still settle receipts under KILL. New integrate/deliver graph kinds remain withheld until these gates are explicitly connected. |
| Automatic branch advancement | MISSING | Existing delivery creates a new branch. Expected-old-commit CAS advancement must preserve unexpected human commits and exact evaluation evidence. |
| Restart recovery | UNWIRED | The engineering graph acknowledges proven completed dispatches only under its exact signed parent link and freshly verified delivery receipts. Default recovery is receipt-only. New enrollments can pin `allowPendingContinuation: true` to continue declared never-started campaigns under original deadlines, KILL and shared ownership. Explicit console-owned supervision now invokes this recovery after process restart, preserving its own deadline, pause and attempt state. Uncertain or held work stays unresolved. Actual-account commissioning remains unverified. See [recovery and continuation](FIRM-DEMO.md#continue-declared-pending-campaigns-after-recovery). |
| Resident company ticks | UNWIRED | The resource console now has an explicit finite engineering-supervision queue calling the existing graph owner, with durable deadline/pause/attempt state and evidence-driven retry suppression. Real CLI crash/restart and local evaluator acceptance are tested. Dynamic ideation/enrollment, an OS resident service and actual-account commissioning remain unwired; this is not an activated company. |
| Enrollment of the ecosystem | UNWIRED | Existing enrollment machinery must be reused. Thirteen trusted product roots were not independently enumerated or enrolled in this run. |
| Daily and consolidated memory | UNWIRED | `firm-memory.ts` stores immutable daily entries and CAS-linked master versions under an explicit private root. It does not modify real user memory or provide the full Markdown/wiki/genome projection yet. |
| Harness archive and frozen evaluation | UNWIRED | `harness-archive.ts` stores baseline/evaluator bytes and successes/failures with strict mutable-path admission. No proposer or promotion effect is connected; supplied verifier linkage is not authenticated outcome evidence. |
| Harness evolution and Red Queen | MISSING | Separate proposer, matched evaluation, memory-program evolution and evaluator-copy populations remain required. Candidates cannot change their selecting evaluator. |
| New product universes and mass sensor | MISSING | Existing invention/experiment primitives are not a complete brand→repo→preview→real sister-product acceptance loop. |
| Payment broker | UNWIRED | `payment-broker.ts` is a pure capped simulation with carried holds. No rail, keys, transfers or AP2/x402 compatibility is claimed. Durable authenticated serialization remains the caller's responsibility. |
| Exception-only inbox | UNWIRED | Existing daemon opt-in auto-merge pass already uses inbox authority. Reuse it; do not create a parallel ungated drainer. |
| Global stop | UNWIRED | Existing sandbox KILL policy is authoritative. New graph checks it plus a restrictive root-local sentinel. Resource workers now use the same shared policy before transport and during active cancellation; broader pre-intent controller integration still needs wiring. Native Windows dispatch is explicitly unavailable until owned cancellation is supported; local HTTP still works. |
| Operator interface | UNWIRED | The resource console includes registered project switching over one account ledger, separate session drafts, opt-in durable transcripts, digest-pinned same-project follow-ups, retention/deletion, text attachments, output, cancellation and a resizable inspector. Control-unlocked file browsing reads pinned project directories; explicit attachment copies the viewed snapshot and provenance, never later disk contents. Immutable directory bindings and project-local holds preserve unrelated work; accepted context survives source deletion and restart without replay. Missing/truncated responses stay explicit. Unsent drafts are not persisted and auth/scope changes clear private UI state. Conversation compaction, terminal/browser panels, native desktop bootstrap and resident-firm controls remain unwired. |
| Activation | UNWIRED | Existing daemon/conductor compiled roots remain empty, and broader conductor activation returns false. Runtime source completeness is not permission to bypass that door. |

## Next executable milestones

The local workspace now connects signed engineering graphs to resource-accounted
confined changes, fixed evaluation, explicit branch delivery and exact completed
receipt recovery. Its [local admission view](RESOURCE-POOLS.md#evaluated-engineering-runs)
exposes known stop/configuration/ownership holds before accepting a new launch.
The [standalone commissioning check](RESOURCE-POOLS.md#check-engineering-configuration-without-starting-the-fleet)
now validates the complete explicit enrollment before starting a console, without
initializing stores or changing account history. It reports local configuration
and known holds, not authenticated capacity or permission to launch.
These are implemented local paths, not proof of an operating company.

The optional automatic-engineering panel now exposes console-wide supervision,
durable pause/resume, original deadlines and per-enrollment invocation/hold
evidence. Its status reads have no dispatch effect. Terminal/browser panels,
conversation compaction and native desktop bootstrap remain separate gaps.

The [engineering preparation command](RESOURCE-POOLS.md#prepare-an-engineering-objective)
now connects a reviewed objective, fixed evaluator, selected project and existing
workers to initialized experiments/campaigns and linked console catalogs. It
derives matching digests and preserves the existing account ledger. Preparation
does not invent the objective or evaluator, start work or establish live capacity.
Host-configured preparation profiles now expose this path in the workspace:
objective entry, read-only plan check, explicit preparation and receipt-backed
same-console enrollment. Completed registrations reload on restart without
launching; the existing engineering pane runs them through the shared owner.
This removes manual per-objective catalog assembly, not the requirement for a
trusted evaluator matched to the requested work or for live account commissioning.
Incomplete registration remains explicit; exact completed replay changes no state.

The [offline pool upgrade](RESOURCE-POOLS.md#upgrade-a-pool-without-resetting-history)
removes the need to discard accounting or conversations when adding workers.
Its explicit digest-pinned transition preserves prior identity and has a held
interruption/resume path. It is not live account commissioning: existing personal
account pauses still span Spark aliases, and new quota evidence is required.
Independent scope reservations now allow the operator to save a General-only
hold before deliberately releasing an account-wide pause. They do not make that
transition automatically or establish live Spark entitlement.

1. Apply the standalone check to the intended Hub enrollment and resolve its
   actual configuration/ownership findings without resetting shared accounting.
2. Prepare a meaningful pinned Hub evaluator and reviewed recipe using the
   preparation command, with explicit mutable files, allowed workers, budgets
   and local delivery targets. Commission the real
   accounts separately: personal Spark must preserve General reservation, shared
   account capacity, existing account-wide pauses and prior ledger history. A
   fresh empty ledger is not an acceptable migration shortcut.
3. Commission the [finite console-owned supervision queue](RESOURCE-POOLS.md#automatic-engineering-supervision)
   with explicit enrollment digests and its own fixed deadline. Durable pause,
   overlap suppression and actual process-restart acceptance are implemented;
   an installed service and dynamic tick production remain separate milestones.
4. Commission one Hub feature end to end: idea, competing plans, confined change,
   independent checks, integrated artifact and measured accepted-work yield.
5. Extend integration into independently tested expected-old-commit branch
   advancement and recovery of unfinished work, without weakening existing
   identity, deadline, ownership or delivery checks.
6. Expand to a sister product only after the Hub loop has acceptance evidence;
   resident ideation, measured routing improvement and harness evolution remain
   separate work, not capabilities inferred from a successful code trial.

## Evidence and limitations

The detailed baseline call-site audit is
[`artifacts/firm-gap-inventory.json`](../artifacts/firm-gap-inventory.json).
That inventory deliberately records its earlier package-worktree revision;
new package results are tracked separately rather than retroactively described as
baseline behavior. Tests must run locally: GitHub Actions remain unused.

An HMAC proves integrity under the existing host-local provenance key, not
separation from a same-user process that can read that key, external truth,
effect authority or anti-rollback storage. A cooperative handler must return
after cancellation; the graph does not claim JavaScript can terminate an
uncooperative callback. Unavailable evidence remains unavailable.
