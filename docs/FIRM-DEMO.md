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
evaluator, and delivers strict measured improvements to explicit local branches.
All tasks in this enrollment must have delivery targets; dependency ordering
waits for their planned handoffs.

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
| `deliveryPlan` | Existing `schemaVersion: 1` plan: one campaign ID, new `codex/` branch and exact seed `baseCommit` per task |
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

A passing first candidate establishes a baseline but has no measured improvement
delta. An unchanged or merely passing candidate cannot satisfy strict-improvement
delivery. A later changed, passing improvement over an accepted parent is needed.
Keep this distinction when setting campaign budgets. Graph-level spend remains
unknown because campaign totals can include prior work; underlying resource
receipts retain reported usage where available.

Use a new controller ID for the first graph execution. The adapter refuses an
already existing controller instead of attributing someone else's completion to
this node. Repeating an intact completed graph within its original deadline does
not dispatch again. No resident service or always-on loop is installed by this
command.

#### Recover a graph interrupted after completed delivery

If the process died after the child controller durably completed but before the
graph recorded settlement, repeat step 2 with the **same** graph directory,
enrollment file and expected digest. This remains a mutating execution command:
it may append a signed graph settlement and, for a multi-node API graph, run
otherwise-ready pending work within the original budget. Inspect first when you
only want status; do not change IDs or delete history to force a retry.

The concrete engineering adapter performs receipt-only recovery. It does not
call or resume the controller, run evaluators, reserve quota, contact providers,
or publish another branch. It requires all of the following:

- The original graph history verifies and the same factory enrollment is bound.
- The child controller's persisted `graphDispatch` exactly matches the canonical
  graph-root digest, graph/definition/node identity and full signed intent digest.
- Controller outcomes are durably completed, with unchanged campaign evidence
  and fresh verification of every planned delivery, including the current ref.
- The original deadline has not expired, KILL is off, and graph ownership is held.

A successful recovery appends one ordinary signed settlement whose artifact has
`reason: "engineering-reconciled"`; subsequent calls do not repeat it. Legacy
controllers without a parent link, missing or still-in-flight controllers,
altered bindings, drifted branches and unverifiable evidence remain unresolved.
The link is attribution evidence, not an activation permit or process isolation.
Do not resume a graph-owned controller through the standalone controller runner:
execution re-entry is refused even with the exact copied link, because that link
cannot restore graph ownership or its shorter outer deadline. Read-only
controller inspection remains supported; legacy unlinked controllers retain their
existing restart behavior.

After expiry or under KILL, use read-only graph/controller inspection; recovery
does not write a settlement or unlock descendants. Graph and campaign allowances
are never renewed by re-entry. Recovering interrupted child work that has not
durably completed is a separate workflow, not an automatic retry here.

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
