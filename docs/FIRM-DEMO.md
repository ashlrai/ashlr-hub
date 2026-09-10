# Run and inspect signed firm graphs

This source-build demo exercises the new graph kernel without contacting a model,
running candidate code, switching accounts, changing HOME or activating a daemon.
It is a deterministic fixture, not an autonomous engineering deployment.
For real, explicitly enrolled engineering campaigns, use the
[engineering execution path](#execute-an-enrolled-engineering-portfolio) below.

## Prerequisites

- Build this branch locally with `npm ci --ignore-scripts` and `npm run build`.
- Supply an existing absolute, canonical directory owned by you with mode `0700`.
  Use a dedicated directory: one graph definition is pinned to each root.
- The existing host-local provenance key must already be available. These commands
  do not create or replace it. Missing or unsafe key storage returns unavailable.
- Leave the existing global KILL switch engaged if you intend to stop execution.
  The demo does not clear it. A `KILL` entry inside the explicit demo root is an
  additional restrictive stop, not another authority source.

## Execute and inspect

Replace `/absolute/private/firm-demo` with your dedicated directory:

```sh
node bin/ashlr universe firm demo --root /absolute/private/firm-demo --json
node bin/ashlr universe firm status --root /absolute/private/firm-demo --json
node bin/ashlr universe firm query --root /absolute/private/firm-demo --entity node:verify-liar --limit 2 --json
```

The fixture records two genuinely different boolean XOR strategies. Its builder
emits a declarative four-row result; a separate deterministic checker resolves
the pinned specification and checks every row. A second builder emits a wrong
row while claiming every test passed. The checker rejects that candidate.

Successful fixture output has `status: "accepted-fixture"`, four completed nodes,
one deliberately rejected node, eleven signed event traces and a retained conflict
link. The underlying graph is **not** labeled completely successful: rejection is
the intended negative control. Filtered queries retain conflict links even when
their other endpoint is outside the page. The graph reader verifies signatures;
the underlying structural query reports `signatureVerification: "not-performed"`
because authentication happened at the reader boundary, not in that pure filter.

`status` and `query` are read-only. Re-running `demo` preserves existing history:
completed work is not dispatched again, unresolved intents are held, and the
original sixty-second execution deadline is not renewed. After expiry, use
`status` to inspect a completed fixture; a new execution needs a new explicit root.

SIGINT, SIGTERM and KILL request cooperative cancellation. The fixture has no
subprocesses, but the generic graph waits for trusted adapters to settle; it cannot
force-terminate an arbitrary in-process callback. Never interpret a timeout as
proof that externally owned work is dead or safe to retry.

## Evidence boundary

### Inspect any signed graph

The fixture-specific `status` and `query` commands retain their original contract.
Use `graph` and `traces` for any persisted control graph, including incomplete
graphs. These commands neither dispatch work nor acquire execution ownership:

```sh
node bin/ashlr universe firm graph --root /absolute/private/firm-graph --json
node bin/ashlr universe firm traces --root /absolute/private/firm-graph --action graph-settled --entity node:builder --limit 20 --json
```

Trace filters also accept inclusive `--since` and `--until` UTC ISO timestamps.
The default page contains up to 100 traces in history order; the maximum is 256.
Conflict links remain intact even when the other trace is outside the page.
`status: "available"` describes verified evidence availability, not execution
success. Consult `graph.status` or `graphStatus` for the recorded execution state.
Missing or unverifiable history exits with code 1 and exposes no traces; invalid
filters exit with code 2. No keys are created. Read-only inspection remains
available under KILL, but it does not prove a worker is currently alive.

### Agent-first MCP resources

The existing MCP gateway exposes signed graph history only when the host has
explicitly configured an existing private graph directory in its Ashlr config:

```json
{ "firm": { "graphRoot": "/absolute/private/firm-graph" } }
```

This is a config fragment, not a replacement for the rest of your configuration.
The root must be absolute, canonical, owned by the current user and mode `0700`.
Absent or invalid configuration advertises no firm resources. The gateway offers:

- `ashlr://firm/graph` — verified graph history and recorded execution state.
- `ashlr://firm/traces` — traces, with optional `entity`, `action`, `since`,
  `until` and `limit` query parameters; the same limits as the CLI apply.

The caller cannot supply a filesystem path or signing key in the URI. Reads
neither execute work nor create keys, enrollment or audit records. This guarantee
applies to the resource handlers: the gateway retains its existing startup and
native-tool behavior. These resources contain private model/task evidence; expose
the gateway only to clients trusted to read that configured graph.

Signed JSON is preserved exactly. Responses exceeding 64 KiB return an explicit
unavailable result, not a truncated or scrubbed signature-bearing document. Use
narrower trace filters when possible. Unknown or duplicate parameters, unsafe
roots and damaged evidence also return unavailable. Signature verification says
nothing about current worker liveness or independent outcome acceptance.

### Enrolled resource-generation graph nodes

The `@ashlr/hub/universe` source-build API exports
`createFirmResourceControlHandler(host, requestsByNodeId)`. The trusted host
supplies existing allocation receipts, pinned runtime/pool/worker enrollment,
and exact requests. The factory returns a frozen handler plus `nodeInputs`:

```ts
import { createFirmResourceControlHandler, runControlGraph } from '@ashlr/hub/universe';

// host and request are already validated, explicitly enrolled host data.
const binding = createFirmResourceControlHandler(host, { research: request });
const report = await runControlGraph({
  schemaVersion: 1, id: 'enrolled-research', maxConcurrent: 1,
  maxDurationMs: 60_000,
  nodes: [{ id: 'research', kind: 'explore', requires: [],
    input: binding.nodeInputs.research }],
}, { root: graphRoot, handlers: { explore: binding.handler } });
```

Do not construct `host` from model output or give a model runtime paths/commands
to select. Request and enrollment digests bind the node to its captured host
configuration. Existing quota, reserve, ownership, cancellation, runtime pin and
durable task-replay checks still apply. Only enrolled `explore` nodes are admitted.

Successful generation records `resource-completion`, the host policy identity,
an output digest, and reported token usage when available. USD stays unknown.
It is **not** an independently verified implementation: the artifact keeps
`verifiedAccepted: false`, and its verifier remains unavailable. A separate
acceptance step must evaluate downstream work.

Held, replayed, failed, uncertain, cancelled or oversized completions reject the
node and withhold its dependents. An exception after intent can remain unresolved
and is not automatically retried. Oversized content is omitted while its digest
and bounded receipt remain; it cannot be mistaken for a successful truncated
artifact. Guarded integration/delivery/harness mutation kinds still require their
existing effect gates. This API is not resident-firm activation, automatic account
commissioning, or cumulative cross-receipt budget accounting.

### Execute an enrolled engineering portfolio

The source-build `universe firm engineer` command connects a signed `deliver`
node to the existing restartable portfolio controller. It does not introduce a
second scheduler or resource ledger. The controller runs existing campaigns,
applies declared file operations in confined candidates, uses the pinned fixed
evaluator, and delivers measured improvements to explicit local branches.
All tasks in this enrollment must have delivery targets; dependency ordering
waits for their planned handoffs.

The same engine is available through the private resource console's
[project-bound Engineering runs pane](RESOURCE-POOLS.md#evaluated-engineering-runs).
Its startup catalog binds the project and shared accounting scope into the signed
graph definition. The browser supplies only an enrolled ID and digest; ordinary
chat remains a separate operation. Console-owned graphs must retain their console
enrollment identity and cannot be adopted as unrelated CLI graphs.

Prerequisites: macOS with the existing verified evaluator confinement, initialized
Universe experiments and campaigns, fixed evaluator wrappers using the documented
JSON measurement protocol, a private resource runtime, and an existing host
provenance key. All variants must use `resource-pool` generation with explicit
`fileOperations`; native and local-chat workers participate through that shared
pool. The generation workspace remains a separate sterile Git directory, not the
project checkout. See [Universe configuration](ASHLR-UNIVERSE.md) and
[resource pools](RESOURCE-POOLS.md). Enrollment does not connect accounts or change
their existing reserves, owner pauses, allocation ceilings or model permissions.

An owner-controlled `0600` JSON file in a private directory contains exactly
`schemaVersion: 1`, `graphId`, and `host`. The host contract is
[`FirmEngineeringControlHost`](../src/core/universe/firm-engineering-control-handler.ts):

| Field | Meaning |
| --- | --- |
| `nodeId` | Enrolled graph delivery node ID |
| `root` | Existing private Universe store; not the graph directory |
| `constitutionVersion`, `policyEpoch` | Host policy metadata, not an activation permit |
| `definition` | Existing portfolio definition with explicit campaign IDs, dependencies, concurrency and duration |
| `deliveryPlan` | `schemaVersion: 1` plan: one campaign ID, new `codex/` branch and exact seed `baseCommit` per task; optional `allowInitialRepair: true` requires the measured failing-seed proof below |
| `resourceRuntime` | Explicit private canonical runtime file |
| `expectedRuntimeDigest` | SHA-256 of the canonical validated runtime JSON; not a hash of raw file formatting |

Do not derive this host enrollment from model output. The factory captures the
configuration, campaign/manifest/comparator identities, and pool/binding digest.
Graph input contains only binding and request digests. The graph accepts this
delivery registration only from the concrete factory: copying its metadata or
supplying an arbitrary callback does not unlock delivery or other guarded kinds.

1. Inspect the chosen enrollment without running workers, evaluators or delivery:

   ```sh
   node bin/ashlr universe firm engineer --root /absolute/private/engineering-graph \
     --enrollment /absolute/private/engineering.json --check --json
   ```

   `validated-enrollment` returns `enrollmentDigest`. This is a configuration
   check, not proof of credentials, capacity, execution permission or acceptance.
   The command creates neither a graph nor a controller.

2. After reviewing the exact campaigns, budgets and branch targets, explicitly
   run that enrollment using the returned digest:

   ```sh
   node bin/ashlr universe firm engineer --root /absolute/private/engineering-graph \
     --enrollment /absolute/private/engineering.json \
     --expected-enrollment-digest <digest-from-check> --json
   ```

   This step can consume the selected workers' usage and publish local Git
   branches. It does not merge, check out, push or deploy them. Existing KILL
   controls remain effective; SIGINT/SIGTERM requests cancellation and waits for
   owned work to settle. Runtime pins are enforced at each resource-generation
   handoff. Parent stop/ownership checks also reach final worker launch and Git's
   prepared branch-ref transaction.

3. Inspect recorded results with `universe firm graph` and `universe firm traces`
   against the same graph root. A completed engineering artifact joins the
   controller record digest, campaign and comparator identities, generation
   receipt, fixed-evaluation evidence, frozen artifact, and verified local commit.
   Its `graphDispatch` links the controller enrollment to the exact signed graph
   intent, including the graph root, definition and node identities.
   `verifiedAccepted: true` means **fixed-evaluator and local-branch acceptance
   only**, not general correctness, human acceptance or production deployment.

A passing first candidate establishes an archive baseline but has no parent or
archive improvement delta. By default, delivery requires a later changed, passing
improvement over an accepted parent. A delivery-plan target may explicitly set
`allowInitialRepair: true` to deliver that first passing repair **only** when an
earlier completed step of the same campaign, or its opt-in evaluator-only seed
measurement, evaluated the unchanged seed, failed with a valid finite score,
and provides positive improvement (in the same niche for a prior trial)
meeting the fixed metric threshold. Its archived bytes must still equal the
pinned seed. Unmeasured failures, unchanged successes and arbitrary first passes
do not qualify. The first repair's parent and archive delta remain `null`;
eligibility is a separate proof, not rewritten lineage. Restart inspection
requires the same opt-in and intact evidence. Omitting the field retains the
default; `false`, `null` and other values are invalid.

The delivery option consumes existing baseline evidence. For a new campaign,
`measureSeed: true` performs the fixed seed evaluation before model reservation,
inside the original time budget, with no generation, trial or model request.
See [seed measurement and recovery](ASHLR-UNIVERSE.md#measure-the-seed-before-spending-a-model-request).
Graph-level spend remains
unknown because campaign totals can include prior work; underlying resource
receipts retain reported usage where available.

Use a new controller ID for the first graph execution. The adapter refuses an
already existing controller instead of attributing someone else's completion to
this node. Repeating an intact completed graph within its original deadline does
not dispatch again. No resident service or always-on loop is installed by this
command.

#### Recover a graph interrupted after completed delivery

If the process died after completed campaign delivery but before the controller
or graph recorded settlement, repeat step 2 with the **same** graph directory,
enrollment file and expected digest. This remains a mutating execution command:
it may acknowledge a proven completed child dispatch, append a signed graph
settlement and, for a multi-node API graph, run
otherwise-ready pending work within the original budget. Inspect first when you
only want status; do not change IDs or delete history to force a retry.

The concrete engineering adapter performs receipt-only recovery. It does not
call or resume the controller runner, run evaluators, reserve quota, contact providers,
or publish another branch. It requires all of the following:

- The original graph history verifies and the same factory enrollment is bound.
- The child controller's persisted `graphDispatch` exactly matches the canonical
  graph-root digest, graph/definition/node identity and full signed intent digest.
- Controller outcomes are already completed or exact attributed in-flight
  dispatches have proven completed campaign history and existing delivery.
  Every planned delivery is freshly verified, including its current ref.
- The original **parent graph** deadline has not expired, KILL is off, and graph
  ownership is held. A child's earlier deadline is never renewed: expiry does
  not prevent acknowledgement of effects already completed under its dispatch.

For the second case, the adapter acquires the existing controller execution
lease and appends only verified `settled` metadata before proving graph success.
It rechecks exact parent linkage, enrollment, runtime pins, campaign/receipt
evidence, stop state and ownership at final record publication. A drain request
does not prevent acknowledgement of completed work; recovery does not resume
admission or manufacture a drain acknowledgement. Pending or held child work is
not executed by this path. A failed lock release can leave a valid durable
settlement while returning no recovery result; inspect history before retrying.

A successful recovery appends one ordinary signed settlement whose artifact has
`reason: "engineering-reconciled"`; subsequent calls do not repeat it. Legacy
controllers without a parent link, missing controllers, unproven in-flight work,
altered bindings, drifted branches and unverifiable evidence remain unresolved.
The link is attribution evidence, not an activation permit or process isolation.
An exact-owned healthy in-flight controller leaves a new graph attempt
unresolved even when no diagnostic could be recorded. Only proof of completed
effects can resolve it. Already terminal rejected graph nodes are not reopened
or rewritten by this change.
If the controller call throws after settlement committed, or returns a transient
failure over completed outcomes, the adapter first rereads the exact persisted
enrollment and all completed outcomes. Only that fresh proof can preserve an
unresolved acknowledgement for later recovery; the thrown call or status wrapper
is never accepted as success. Permanent delivery-proof rejections remain terminal.
Do not resume a graph-owned controller through the standalone controller runner:
execution re-entry is refused even with the exact copied link, because that link
cannot restore graph ownership or its shorter outer deadline. Read-only
controller inspection remains supported; legacy unlinked controllers retain their
existing restart behavior.

After expiry or under KILL, use read-only graph/controller inspection; recovery
does not write a settlement or unlock descendants. Graph and campaign allowances
are never renewed by re-entry. Recovering interrupted child work that has not
durably completed is a separate workflow, not an automatic retry here.

The macOS acceptance fixtures exercise actual confined evaluation and local Git
publication, then fault only the confirmation read. Run them from a development
checkout with dependencies installed:

```sh
npx vitest run test/universe-controller-handoff-diagnostics.test.ts test/universe-engineering-handoff-recovery.test.ts
```

They assert no repeated worker request, evaluation or branch publication during
recovery. The separate `test/universe-graph-controller-reconciliation.test.ts`
suite uses real private records with inert proof fixtures to check final-write
vetoes and terminal rejected-node preservation. These are local acceptance
tests, not provider activation or unattended production commissioning.

### A real Hub source campaign

The first fixed Hub-code evaluator is
[`scripts/evaluators/backlog-marker-paths.mjs`](../scripts/evaluators/backlog-marker-paths.mjs).
This recipe requires the full source checkout; the evaluator and acceptance
fixture are not shipped in the npm package.
It measures marker-item path classification against 142 fixed cases. The raw
scanner already filters non-code paths; this campaign repairs the shared item
filter used for historical/custom backlog input. It does not introduce a new
work-selection policy or claim measured subscription savings.

The evaluator was committed before the candidate at
`9bf75b598fbfc6a5b7ec289a2d3419b1a18469b8`. Use that full seed revision to
reproduce the baseline: 82 cases pass and 60 fail, producing `passed: false`
and score `0`. All 142 cases must pass for score `1`; an unchanged candidate
cannot meet this objective. Security/breaking-change exceptions and ordinary
source work are part of the fixed comparison, not optional follow-up checks.

The automated acceptance uses a deterministic loopback worker supplying the
independently reviewed source from
`e2e4e33d588a63d36d81ed23e50adb18b197b8df`. It verifies resource-accounted
application, evaluation and local delivery of that exact candidate, not real-model
ideation or provider commissioning. Both pinned commits must be available in
local Git history; a shallow checkout may need its history populated first.

To prepare this campaign through the existing manifest/campaign interfaces:

- Pin the canonical Hub repository path and full seed revision above. Preserve
  the commit in local Git history; never substitute the current checkout when
  reproducing the historical baseline.
- Set `evaluation.command` to the canonical Node executable followed by
  `--experimental-vm-modules`, `--no-warnings`, and
  `scripts/evaluators/backlog-marker-paths.mjs`. The tested runtime is Node 24.
  Use a bounded evaluator timeout, such as 5,000 ms. Universe runs the script
  from the immutable seed and supplies `ASHLR_UNIVERSE_CANDIDATE`; the script
  never defaults to the current directory.
- Use one `resource-pool` variant with the existing pool ID, canonical
  pool/bindings digest and explicit allowed worker IDs. The only mutable file
  is `src/core/portfolio/value-filter.ts`. Enable `fileOperations` schema 1;
  keep the evaluator and all tests outside the mutable scope.
- Use the existing maximize metric with minimum improvement `0`. Keep explicit
  trial, generation, request, time and reported-token limits. Three requests
  and one concurrent generation are sufficient for the controlled acceptance
  sequence; they are not a forecast of how many requests a real model needs.
  An observed-token threshold is not a hard provider spend cap.
- Bind the campaign to the registered Hub project, its same shared accounting
  runtime, a separate sterile transport workspace, and a new explicit local
  `codex/` delivery branch whose base commit is the seed revision. Do not enroll
  additional accounts or replace ledger history to make the campaign admissible.
- Set that delivery target's `allowInitialRepair` to `true`. For a new campaign,
  set `measureSeed: true` to evaluate the seed before the first worker request.
  Enable `feedback: true` so every new worker generation receives the bounded,
  digest-pinned `seedContext` alongside its current source and trial feedback.
  The one-response fixture checks the actual prompt's failed seed score,
  case statistics and declared diagnostics before supplying the reviewed repair.
  A separate three-generation acceptance fixture retains that exact seed context
  alongside an accepted parent and later trial feedback. These are controlled
  workers verifying evidence/dispatch/delivery plumbing, not autonomous model
  ideation or proof of general model quality. Without
  seed measurement, ensure an earlier completed generation actually evaluates
  the unchanged seed in the same campaign. The legacy controlled acceptance
  sequence is unchanged seed (failed
  evaluation), attempted evaluator edit (refused without measurement), then the
  changed repair (all fixed cases passing). A real model response is not
  guaranteed to follow this sequence. No initial delivery is allowed without
  the recorded, byte-verified failing-seed measurement.

Run the [standalone commissioning check](RESOURCE-POOLS.md#check-engineering-configuration-without-starting-the-fleet)
before starting the console, then use the enrolled engineering execution path
above. Real execution can consume the selected account allowance and create a
local branch; it still requires the intended enrollment, budgets and effective
stop policy. Inspect the graph, evaluated artifact and exact delivered diff
before integrating it. This recipe does not clear KILL, change reserves, create
credentials, push a branch or start a resident scheduler.

The evaluator uses a timeout-bounded VM for measurement isolation, with expected
results and the final verdict held outside candidate code. It accepts only
synchronous boolean classifications, rejects runtime imports, and bounds source
size and both synchronous and asynchronous evaluation. **The VM is not a security
sandbox.** Continue to use Universe's existing OS-confined fixed evaluator.
The documented Node/flag contract is required; unsupported runtimes may fail
before the JSON protocol. A passing finite case matrix is evidence for this
specific behavior, not independent business acceptance or general intelligence.

### What signatures establish

The trace uses the existing provenance HMAC. This is integrity under a host-local
key, not process isolation, independent model judgment, anti-rollback protection,
resource capacity or an activation permit. Distinct checker IDs are caller-enrolled
metadata. The engineering path uses the existing confined fixed evaluator; a
separately commissioned cold-model reviewer remains a different integration.

Memory, harness archive and payment broker tests exercise separate components;
this demo does not claim it already composes them into the resident company loop.
See the [autonomy gap map](AUTONOMY-GAP.md) for the remaining integrations.

## Local checks

```sh
npm run typecheck
npm run lint
npm run check:docs
npx vitest run test/universe-firm-demo.test.ts test/universe-control-graph.test.ts
node bin/ashlr verify-safety --json
npm run test:invariants
```

No GitHub Actions are required or invoked. Preserve and report any skipped
invariant tests rather than claiming their coverage was executed.
