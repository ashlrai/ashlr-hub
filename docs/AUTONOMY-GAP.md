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
| Resident company ticks | UNWIRED | The resource console has a bounded engineering-supervision queue with durable deadline/pause/attempt state and evidence-driven retry suppression. Optional automatic admission removes the per-plan Run action. A private successor policy now connects verified local delivery to an accounted proposal, a new objective seeded at that delivered commit, and the same queue. Original deadlines, fixed evaluators and resource limits remain binding. An OS resident service, indefinite budget renewal and actual-account commissioning remain unwired; this is not an activated company. |
| Enrollment of the ecosystem | UNWIRED | Existing enrollment machinery must be reused. Thirteen trusted product roots were not independently enumerated or enrolled in this run. |
| Daily and consolidated memory | UNWIRED | `firm-memory.ts` stores immutable daily entries and CAS-linked master versions under an explicit private root. It does not modify real user memory or provide the full Markdown/wiki/genome projection yet. |
| Harness archive and frozen evaluation | UNWIRED | `harness-archive.ts` stores baseline/evaluator bytes and successes/failures with strict mutable-path admission. No proposer or promotion effect is connected; supplied verifier linkage is not authenticated outcome evidence. |
| Harness evolution and Red Queen | MISSING | Separate proposer, matched evaluation, memory-program evolution and evaluator-copy populations remain required. Candidates cannot change their selecting evaluator. |
| New product universes and mass sensor | MISSING | Existing invention/experiment primitives are not a complete brand→repo→preview→real sister-product acceptance loop. |
| Payment broker | UNWIRED | `payment-broker.ts` is a pure capped simulation with carried holds. No rail, keys, transfers or AP2/x402 compatibility is claimed. Durable authenticated serialization remains the caller's responsibility. |
| Exception-only inbox | UNWIRED | Existing daemon opt-in auto-merge pass already uses inbox authority. Reuse it; do not create a parallel ungated drainer. |
| Global stop | UNWIRED | Existing sandbox KILL policy is authoritative. New graph checks it plus a restrictive root-local sentinel. Resource workers now use the same shared policy before transport and during active cancellation; broader pre-intent controller integration still needs wiring. Native Windows dispatch is explicitly unavailable until owned cancellation is supported; local HTTP still works. |
| Operator interface | UNWIRED | The resource console includes registered project switching over one account ledger, separate session drafts, opt-in durable transcripts, digest-pinned same-project follow-ups, retention/deletion, text attachments, output, cancellation and a resizable inspector. Control-unlocked file browsing reads pinned project directories; explicit attachment copies the viewed snapshot and provenance, never later disk contents. Immutable directory bindings and project-local holds preserve unrelated work; accepted context survives source deletion and restart without replay. Missing/truncated responses stay explicit. Unsent drafts are not persisted and auth/scope changes clear private UI state. Conversation compaction, terminal/browser panels, native desktop bootstrap and resident-firm controls remain unwired. |
| Activation | UNWIRED | Resident authority now comes from the Touch-ID-signed standing grant (custody key compiled into `STANDING_GRANT_TRUST_ROOTS`): `runDaemon` opens a standing session and re-verifies the grant, Stop and the switch every tick, and `liveConductorActivationAuthorized()` follows the grant's `conductorGoals`. `ashlr authority resident start` — typed by the operator in a terminal, clean build, active grant, Stop off — is the one admitted launchd install/restart path ([RESIDENT-RUNTIME.md](RESIDENT-RUNTIME.md)). Legacy service paths stay denied and the permit-based daemon/conductor compiled roots stay empty. Not commissioned: no grant has been signed and no resident service started, so this is not EXISTS-LIVE. |

## Next executable milestones

The local workspace now has a read-only [engineering outcome inspector](RESOURCE-POOLS.md#read-engineering-outcomes-and-resource-use)
joining exact campaign evaluations and verified local deliveries to recorded
worker tokens and execution time. Unknown coverage remains explicit; this is
cumulative observation, not causal model ranking, automatic routing or proof of
production acceptance. Controlled benchmark-driven policy promotion remains unwired.

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
evidence. Opt-in appendable admission lets new prepared objectives enter the
existing loop without a restart. With host-configured `autoAdmitPrepared`,
preparation automatically queues them without a per-plan human Run action.
The additional [automatic successor policy](RESOURCE-POOLS.md#automatic-successors-from-verified-deliveries)
lets a model propose bounded follow-up work using delivered-artifact context and
measurements. The host pins a new objective to the verified commit and retains
the selected evaluator, file scope and original resource/deadline limits. Lost
paid output remains held rather than regenerated. This is not budget renewal,
an installed resident service or proof of useful open-ended ideation. Status
reads have no dispatch effect. The configured Engineering workspace now exposes
read-only successor lineage, intent capacity, original deadline and held reasons.
New prepared/queued plans refresh the project catalog without changing selection;
queued status is explicitly distinct from executed or delivered work. This
observability does not commission accounts or install a resident service.
Terminal/browser panels, conversation compaction and native desktop bootstrap
remain separate gaps.

The [engineering preparation command](RESOURCE-POOLS.md#prepare-an-engineering-objective)
now connects a reviewed objective, fixed evaluator, selected project and existing
workers to initialized experiments/campaigns and linked console catalogs. It
derives matching digests and preserves the existing account ledger. Preparation
through the standalone command does not invent the objective or evaluator,
start work or establish live capacity.
Host-configured preparation profiles now expose this path in the workspace:
objective entry, read-only plan check, explicit preparation and receipt-backed
same-console enrollment. Registration reload itself does not launch work;
the engineering pane and configured supervisor use the shared execution owner.
This removes manual per-objective catalog assembly, not the requirement for a
trusted evaluator matched to the requested work or for live account commissioning.
Incomplete registration remains explicit; exact completed registration replay
changes no registration state. With host-enabled `autoAdmitPrepared`, the console
records the ordinary objective's original queue binding and attempts admission.
The host retries missing admission for those durably marked registrations,
including after restart, without a second prepare request. Recovery preserves
the original deadline, lifetime cap and pause; unmarked or incomplete
registration is not adopted. An uncertain response may mean registration never
completed, while durably registered automatic work may proceed before explicit
reconciliation. Exact replay remains available without duplicating work;
preparation and admission results remain distinct.

The [offline autonomous setup](RESOURCE-POOLS.md#set-up-an-autonomous-engineering-loop)
joins these pieces for a first registered objective: one recipe and bounded
policy produce matching preparation profiles, appendable supervision, successor
configuration and the foreground console argument vector. Check mode is read-only;
setup publishes private artifacts and a real initial preparation registration,
without constructing an execution owner or starting work. This closes the static
catalog-to-successor registration gap. Exact completed replay does not rewrite
account history or renew deadlines; changed or incomplete setup is held.
The read-only [predecessor completion check](RESOURCE-POOLS.md#inspect-a-completed-predecessor)
joins the finished queue, scoped registrations, graph and evaluated-delivery
proofs, generation/proposal receipts, successor lineage and evaluator custody.
It identifies a unique delivered tip and preserves explicit stop responses.
This is historical evidence, not an atomic publication seal or authority to
create another operating window. The new foreground
[standing-mission runner](RESOURCE-POOLS.md#run-a-bounded-standing-mission)
composes existing console ownership with durable scope reservations, verified
delivered-tip rollover and accounted next-objective proposals. It pins one original
mission deadline and fixed per-scope evaluator/resource policy, honors host stop
at dispatch/publication, and reconciles retained results rather than issuing new
proposal identities. This source integration is not an installed resident service,
an unlimited-history scheduler, or actual-account commissioning evidence.
The generated command still needs actual account capacity and an appropriate
fixed evaluator. The [graded Hub verification benchmark proposal](../artifacts/hub-verification-benchmark-plan.md#installed-builtin-measurement-route)
now has a closed installed `preparation-measurement-v1` launch route on
macOS/Node 24. Its trusted controller launches the candidate separately; ordinary
command evaluators are unchanged, and their unsupported nested-sandbox route
still fails closed. The builtin pins its nine-file bundle, Node, the selected
actual developer Git executable, fixed ls/ps/sandbox launchers and matching host
helpers. Read-only Git selection checks only secure canonical installations at
`/Library/Developer/CommandLineTools/usr/bin/git`, then
`/Applications/Xcode.app/Contents/Developer/usr/bin/git`; candidate PATH and
`DEVELOPER_DIR` cannot choose the tool. Unsafe existing paths refuse rather than
fall back. Its path and bytes are pinned, not its transitive native libraries.
The sandbox and raw-stderr behavior are unchanged. This new implementation
invalidates prior comparator pins. A strict private-copy native comparison now
verifies six fewer launches for each four-file check/metadata read, unchanged
one-file counts and during-call drift refusal. The candidate remains unapplied;
the pinned-Git implementation's installed/native regression gate passed 145 tests
across eight suites with zero skips. Full installed candidate acceptance remains
pending. Fixed asynchronous tool workers
preserve raw bytes, while invocation-bound activity receipts and independent group-absence
checks prevent a controller exit from claiming all inner work settled.
The earlier default-registry test completed two matching measurements; its focused
coverage includes 433 tests across 18 suites (see the proposal's handoff).
The output is deliberately rejected as
Universe evaluation evidence. A candidate-linked workflow extension now exposes
explicit manager restoration/check/replay and successor reads for real-process
measurement. It uses the actual manager and owner over a disclosed nonexecuting
supervisor fixture view. The installed `preparation-workflows-v1` workload now
includes these operations, runtime/source drift refusals and detached setup-group
ownership, with one invocation deadline. Real-process tests cover repeatability,
candidate substitution, installed-runtime drift and cancellation; its output
remains non-scoring measurement. A read-only
[`preparation-measurement` inspector](ASHLR-UNIVERSE.md#inspect-preparation-measurements)
summarizes explicit report files without treating reported checks as acceptance.
An explicit [capture command](ASHLR-UNIVERSE.md#capture-preparation-measurements)
now retains seed-only diagnostic reports with immutable intent/receipt custody,
original deadline and artifact/evaluator/tool pins. Real installed failed-check
capture and byte-exact no-write replay are verified; full-success capture through
this new command remains a separate gate. It does not score, select, dispatch a
model or deliver into the registered repository. Pending custody fences that
Universe's execution under the existing owner contract, not a new global lock.
Additional candidate-linked during-call probes challenge runtime
and delivered-branch freshness using deliberately stale candidate controls;
their trusted test-only injector preserves original native results. These are
correctness controls, not a frozen score or a final-return-only source proof.
The full manager/successor correctness workload,
frozen competitive reward, OS-wide process census, native transitive dependency
pins and arbitrary controller-crash recovery remain open. This is neither an
accepted Hub optimization nor provider/account/service activation. Build and
manifest configuration are documented in the linked proposal.
Actual-process setup testing also exposed a responsiveness gap: a status GET
reset after waiting about 73 seconds during successor preparation, while the
console remained alive and a fresh connection returned 200. Source inspection
identifies synchronous source-proof work on the console's event loop as a
plausible contributor; the request wait is not a direct CPU-time measurement.
Read reconnection is not a latency fix; keeping status and stop
handling responsive during that work needs its own measured improvement.

The explicit [control-room responsiveness gate](RESOURCE-POOLS.md#diagnose-automatic-intake-latency)
now measures fresh, non-retried requests during proposal admission, source proof
and successor preparation. On baseline `104650e8`, its two-second target failed:
post-result status took about 64 seconds; a pause sent during preparation returned
409 after about 50 seconds because successor admission had already advanced the
revision. B started before pause could be applied. This is an operator-control
starvation defect, not only keep-alive reconnection behavior. Batched seed reads
and omission of unused repeated diagnostics preserve correctness but are not a
substitute for proving responsive controls: the candidate still took about
61 seconds for status and returned pause 409 after about 48 seconds in the same
gate. Default correctness-test success
must not be reported as passing this separate gate or as always-on readiness.

The worker-isolation continuation (based on `82b2c881`) moves existing preparation
and coordinator proofs off the HTTP thread without removing ACL or publication
checks. Its final corrected-source actual-CLI run accepted pause in 71 ms,
returned health in about 1 ms and withheld B entirely, with original accounting
intact. It still failed the same gate: successor-status requests queued for
6.0–52.3 seconds. An initial parent supervision read also took 2.161 seconds
(outside the seven fixed assertions). Uninterrupted two-delivery/restart
acceptance passed separately with exact accounting and zero read recoveries.
Independent status projection and expensive parent owner checks remain open;
these local results do not establish always-on or production readiness.

The independent-journal-reader continuation (based on `d56309ce`) passed the
same seven two-second probes, strengthened to verify the returned milestones.
On this local run, fresh successor status took 19–114 ms, health about 1 ms,
and accepted pause 67 ms; B was neither admitted nor executed. A prior run of
the new reader returned one 503 near publication despite meeting latency limits.
Bounded fresh sampling now handles a coherent record set classified solely as
changing, without accepting partial records or touching locks. These are measured
single-host runs, not a universal SLA. The UI separates recorded milestones from
worker connection. A connected worker is not
proof that its inner coordinator loop is running.
The strengthened two-delivery/restart fixture also passed, including exact
accounting, fresh request-window samples and a digest matched to the actual
immutable journal. This remains controlled-fixture evidence, not authenticated
provider commissioning or proof of autonomous product judgment.

The lifecycle continuation adds a separate last-reported coordinator transition,
timestamp and fixed reason. Its sequence and original configuration pins are
independent from journal freshness and worker connection. A caught successor-loop
fault can therefore be visible without closing unrelated enrolled work. This is
observability, not automatic recovery or proof that a historical `running` report
is current activity. Useful model-generated Hub improvement still requires a
current, pinned evaluator and accepted delivery; prior shipped optimizations
cannot be counted as new autonomous yield.

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
2. Prepare a meaningful pinned Hub evaluator and reviewed recipe. Use autonomous
   setup for a registered initial objective and matching successor/queue policy,
   with explicit mutable files, allowed workers, budgets and local delivery
   targets. Commission the real
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
