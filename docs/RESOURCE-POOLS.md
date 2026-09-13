# Account-aware resource pools

Use `ashlr resources pool` to assign an explicit engineering task to one enrolled
Codex, Claude Code, or local-model worker. Admission combines quota evidence,
operator task limits, and shared-account concurrency. Each assignment is durably
recorded before launch. This is a foreground task runner, not a resident scheduler
or an extension of the legacy daemon's authority. The scoped operations console
adds a durable queue and visual dispatch controls for that same pool.

This source feature is not yet a published registry release. Native adapter
flag and event contracts were checked against Codex CLI 0.136.0 and Claude Code
2.1.257 on September 7, 2026. This is not proof of model compatibility: the exact
CLI/model pair needs an explicit authenticated canary with the enrolled account.
Fixture-based tests use inert executables and loopback responses; they do not
establish authenticated multi-account production acceptance.

Workers now consult the existing global `~/.ashlr/KILL` policy immediately before
transport and poll it every 50 ms during execution. Active or unreadable policy
cancels through the original transport's cleanup path; the polling interval is
not a hard real-time guarantee. Cancellation preserves reported usage, completed
output and uncertain native-process cleanup. It does not refund a reservation or
prove that no provider work occurred. Native Windows workers report
`worker-kill-cancellation-unsupported` before launch because owned cancellation
is not implemented there; the local HTTP worker remains supported.

## Engineering workspace

The scoped console offers **Workspace** alongside **Resources**, also reachable
at `/resources/#resource-workspace`. It uses the same read session, explicit
control-token unlock, supervisor, account policies and quota-aware admission.
Opening the workspace does not start a task. The first slice contains:

- A project rail showing the server-confirmed workspace and actual task records.
- A central task composer with enrolled model/worker selection and read-only
  workspace access by default. Explicit edit mode still needs control authority.
- A resizable output/details dock, recorded task state, reported usage, and
  cancellation of console-owned work.
- Explicitly selected UTF-8 text attachments. Up to four files, 16 KiB each;
  the complete prompt including framing must fit 32 KiB. Unsupported formats,
  invalid text, duplicate names and overflow are rejected without truncation.

Attachment text is included in the selected task's prompt only when submitted.
Selection alone does not upload files. Unsent drafts and attachments remain in tab
memory, not browser storage. Switching surfaces preserves them; closing/disconnecting
or changing the confirmed scope discards them. Returned output is plain text, not
executable markup.

### Prepare an engineering objective

`ashlr resources pool engineering prepare` turns one reviewed objective and
competing hypotheses into a complete campaign bundle. It derives matching pool
and enrollment digests from your existing runtime and project catalog. It does
**not** run the objective, connect an account or start supervision.

Prerequisites are a built source checkout, existing private resource runtime and
project catalog, and an enabled project with a full Git seed commit. A command
recipe must contain an independently reviewed evaluator; the closed scoring
builtin described below instead uses its separately installed package. Preserve the existing accounting directory,
allocation, account pauses and receipt history. The new output needs an existing
private `0700` parent outside projects, transport workspaces and shared accounting.
Do not move the prepared bundle: experiment evidence contains absolute paths.
`--workspace` is the existing console's default workspace; the recipe's
`projectId` selects the target from its project catalog.

The exact recipe is defined by
[`ResourceEngineeringRecipe`](../src/core/resources/engineering-preparation-types.ts).
It includes identity/objective/project/seed, metric and fixed evaluator,
trial/campaign budgets, generation scope, delivery, execution metadata and
supervision limits. `generation.hypotheses` contains each variant's `id`, `niche`
and `hypothesis`; `files` are mutable, `contextFiles` are read-only context,
and `allowedWorkerIds` must already exist in the pool. The evaluator stays outside
mutable scope. The preparer enables seed measurement, retained feedback and
confined file operations; it does not invent an evaluator or choose a valuable
objective. `delivery.allowInitialRepair: true` still requires measured failing-seed
evidence before first-pass delivery.

Preparation also accepts `evaluation: { builtin: "preparation-process-score-v1",
timeoutMs: 1800000 }` when the [calibrated scorer](ASHLR-UNIVERSE.md#calibrated-preparation-scoring)
is already installed. It does not install or calibrate that evaluator. This closed
route requires the `preparation_processes` minimizing metric, integer improvement
threshold, compatible budgets, and exactly one mutable path:
`src/core/resources/engineering-preparation.ts`. The complete committed seed must
match the calibration's protected inventory; a one-file private calibration cannot
enroll a full Hub repository. All context paths must be tracked. The plan pins the
installed evaluator and rechecks it during preparation, replay and receipt
publication. Replacement invalidates the plan rather than silently adopting new
acceptance rules. Diagnostic-only and arbitrary builtins are refused. Existing
automatic admission and supervision can consume the resulting bundle, but a
prepared recipe alone does not establish account capacity or running autonomy.
The materialized experiment seed must also match the immutable Git inventory
validated against calibration, before campaign/catalog creation and on replay.
Git replacement objects cannot substitute different files during materialization.
A mismatch leaves incomplete output for inspection, without a receipt or eligible
campaign; no automatic repair or worker dispatch follows. A target-only successor
is checked against its own requested seed, not forced back to the baseline bytes.

1. Write a reviewed recipe as private `0600` JSON, including a new `codex/`
   delivery branch and explicit budgets. The [historical marker-filter recipe](FIRM-DEMO.md#a-real-hub-source-campaign)
   supplies a reproducible evaluator and failing seed. That defect is already
   repaired on this package branch; reproducing it is not a new improvement.
2. Inspect without creating files or registering work:

   ```sh
   node bin/ashlr resources pool engineering prepare \
     --recipe /absolute/private/reviewed-recipe.json \
     --output /absolute/private/bundles/hub-improvement \
     --resource-runtime /absolute/private/resource-runtime.json \
     --workspace /absolute/projects/ashlr-hub \
     --projects /absolute/private/projects.json \
     --check --json
   ```

   `status: "planned"` includes `planDigest`, project/seed identity and intended
   output paths. This is configuration evidence, not authenticated capacity or
   acceptance. No campaign, key, directory or execution owner is created.
3. **Register the bundle** by repeating the command without `--check`. Optionally
   supply `--expected-plan-digest` to pin the separately reviewed check. Without
   it, the command captures and rechecks its own plan in one invocation. This
   materializes the pinned seed and registers local experiment/campaign state,
   but never runs a worker or evaluator.

   | Output | Purpose |
   | --- | --- |
   | `manifest.json` / `campaign.json` | Derived definitions with seed measurement and feedback |
   | `universe/` | Immutable seed/comparator and initialized campaign |
   | `graph/` | Dedicated graph root, not a started execution |
   | `engineering.json` | Project-pinned enrollment using the existing shared ledger |
   | `supervision.json` | Digest-pinned queue for explicit automatic startup |
   | `receipt.json` | Final verified preparation receipt |

4. Read `commissioning.status` and reasons. A prepared bundle can still be held
   by KILL, account policy, missing evidence or ownership. Use the
   [standalone checker](#check-engineering-configuration-without-starting-the-fleet)
   and resolve the actual hold without resetting history.
5. To intentionally start execution, use the returned `consoleArguments.manual`
   or `consoleArguments.automatic` with the built CLI. Human output prints quoted
   commands; JSON preserves argument arrays. Neither is executed by preparation.
   Both start an execution-capable console and can resume ordinary queued tasks;
   the automatic form also starts the engineering queue without a browser click.

Exact completed preparation can be replayed before or after execution: it verifies
recipe/runtime/project/evaluator pins, generated catalogs and immutable experiment
evidence without rewriting them or resetting usage/deadlines. Incomplete or
changed bundles are refused and retained for inspection, never automatically
deleted or repaired. `intent.json` is not proof of completion; the final receipt
is required. This bridge prepares one project/objective with multiple variants;
dynamic idea generation, cross-project dependencies and integrating delivered
branches into your working checkout remain separate capabilities.

### Set up an autonomous engineering loop

Use `ashlr resources pool engineering setup` when you want a registered initial
objective and compatible profile, appendable queue and successor policies in one
setup. This is different from the single-objective `prepare` command above:
its static enrollment alone is not a preparation-manager registration and cannot
seed the automatic successor path simply by adding a successor flag.

Prerequisites are an existing shared resource ledger, registered or explicitly
selected project catalog, a pinned recipe with a fixed evaluator, and an existing
empty private output directory outside both projects and accounting. The initial
recipe's delivery branch must be `codex/<recipe.id>`; setup refuses a different
branch rather than silently substituting one. The ledger must contain valid
persisted accounting; an empty replacement directory is not accepted. Stop the
owning console, direct resource work and quota collector normally before setup.
Unresolved dispatches or collector state must be investigated. Existing objective
registration history requires its original preparation context. An explicit
`registrationScope` in the private setup policy can instead select a separate
preparation history, as described below. Do not remove locks or reset accounting
to proceed; a new scope is not recovery of unresolved old work.

The private policy selects the bounded operating window's queue/profile identity
and proposal resources. It does not contain credentials or change account reserves:

```json
{
  "schemaVersion": 1,
  "id": "hub-improvement",
  "profileId": "hub-fixed-checks",
  "label": "Hub verification improvement",
  "acceptance": "Preserve the fixed correctness checks and improve the declared metric.",
  "maxEnrollments": 4,
  "maxConcurrent": 1,
  "autoAdmitPrepared": true,
  "successors": {
    "allowedWorkerIds": ["enrolled-worker"],
    "maxOutputTokens": 1024,
    "proposalTimeoutMs": 120000,
    "maxSuccessors": 3,
    "pollIntervalMs": 3000
  }
}
```

Replace the example worker ID with an already-enrolled worker. Queue timing and
attempt limits come from the recipe's `supervision` section; `maxSuccessors` must
leave room for the initial objective within `maxEnrollments`. Optional
`autoAdmitPrepared` also lets subsequent ordinary preparation enter this queue;
the successor coordinator uses its own explicitly configured admission path.

From the built source checkout, inspect the exact proposed setup without writes:

```sh
node bin/ashlr resources pool engineering setup \
  --recipe /absolute/private/recipe.json \
  --policy /absolute/private/autonomous-policy.json \
  --output /absolute/private/empty-setup-directory \
  --resource-runtime /absolute/private/runtime.json \
  --workspace /absolute/project \
  --projects /absolute/private/projects.json \
  --check --json
```

The result includes a `planDigest` and known local holds. It does not attest live
provider capacity or start the queue deadline. To create the explicitly selected
setup, rerun those same inputs without `--check`, adding
`--expected-plan-digest <the-returned-SHA256>`. This writes the initial bundle and
its real immutable preparation registration, matching `profiles.json`,
`supervision.json`, `successors.json`, and setup intent/receipt evidence. Existing
accounting is retained. Exact completed replay verifies without rewriting;
partial or changed setup remains held for inspection, not erased and retried.

The prepared result returns `consoleArguments`, an argument vector for the
existing foreground console. **Setup does not execute it.** Starting that console
is an effectful action: it may resume ordinary queued tasks, run the initial
objective, consume permitted resources and deliver local branches. Once the
initial delivery is verified, the configured successor loop can propose, prepare
and queue another objective without a per-objective human action. The original
deadline begins at first console startup and is preserved on restart.

Seed materialization reads the pinned Git blobs in one bounded batch, verifies
every object identity and the aggregate byte limit before creating seed files,
then verifies the resulting disk artifact digest. Immutable registration still
rechecks the prepared bundle and live owner at every publication boundary; it
does not rebuild unused commissioning diagnostics at those internal boundaries.
These reductions do not make the remaining synchronous proof work nonblocking.
See the [responsiveness limitation](AUTONOMY-GAP.md#next-executable-milestones) before
treating the console as an unattended always-on service.

KILL, pauses, uncertainty holds and account reserves remain authoritative. This
command does not authenticate accounts, install a service, renew allowance or
deploy production. A usable evaluator must offer meaningful additional headroom:
an already-passing binary test cannot prove repeated strict improvement. The
[Hub verification benchmark proposal](../artifacts/hub-verification-benchmark-plan.md)
records a candidate graded metric and its still-unfinished evaluator requirements.

### Inspect a completed predecessor

After the owning console closes normally, agents can inspect whether a setup's
entire admitted successor chain has completed. Keep the original setup plan
digest and persisted supervision deadline; do not calculate a new deadline:

```sh
node bin/ashlr resources pool engineering predecessor check \
  --recipe /absolute/private/recipe.json \
  --policy /absolute/private/policy.json \
  --output /absolute/private/setup \
  --resource-runtime /absolute/private/runtime.json \
  --workspace /absolute/project \
  --projects /absolute/private/projects.json \
  --expected-plan-digest ORIGINAL_SETUP_SHA256 \
  --expected-deadline-at ORIGINAL_PERSISTED_ISO_DEADLINE \
  --json
```

Replace both uppercase pins with retained values. This command is read-only.
`verified` identifies the unique delivered tip only after checking scoped
registration and queue membership, completed graphs, evaluated local deliveries,
generation and proposal receipts, successor admission, and settled evaluator
custody. Extra unlinked objectives, missing receipts, unfinished proposals,
retained execution locks, or changed evidence produce `held`. It does not reclaim
locks or repair history. Exit codes are `0` verified, `1` held/unavailable, and
`2` invalid arguments.

`continuation: "stop-requested"` preserves an explicit successor stop response;
`"eligible"` only means no such stop was recorded at the delivered tip. Neither
grants execution permission. `executionAuthorized` and `effectsExecuted` remain
`false`. Unknown token or timing measurements remain unknown; a missing worker
receipt cannot be treated as completed accounting. Evidence is sampled twice,
not atomically sealed against another process. The standing-mission owner below
revalidates it at publication and applies its retained limits, account
reserves, stop state, and project policy. This command does not renew a finite
queue, create the next setup, start a service, or deploy a branch.
The current implementation performs synchronous private-file and Git proof
reads. Use it as an offline inspection after normal console shutdown, not as a
high-frequency UI poll or inside a live owner's event loop. It does not pause
the original deadline while inspecting evidence.

Within each sample, setup verification reconstructs each registration's committed
metadata once and uses it for both its catalog and delivered-source projection.
The second sample reconstructs those facts independently; nothing is cached
across calls or campaigns. The ordinary setup check and completed setup replay
remain independent of delivery: a prepared-but-unrun setup is valid setup
evidence, not proof of completed engineering work.

### Run a bounded standing mission

The foreground mission runner composes the existing console: execute a scope,
drain its workers, verify the delivered chain, request an accounted next objective,
and prepare a new scope from the verified commit. It needs no per-objective **Run**
action. The evaluator, permitted files, workers, account reserves and per-scope
budgets remain fixed; model output supplies only a name/objective or a stop request.

Create a private JSON configuration matching
[`ResourceEngineeringMissionConfig`](../src/core/resources/engineering-mission-store.ts).
`initial.setup` contains the **recipe and policy objects**, plus the absolute
`output`, `resourceRuntime`, `workspace` and `projectsFile` paths used for an
already prepared setup. Pin its retained `expectedPlanDigest`. Select an existing
private `root` outside project and resource-control directories, one original
ISO `deadlineAt`, `maxScopes` (1–64, including the initial scope), and
`pollIntervalMs` (100–60000). The configuration has `schemaVersion: 1` and a
stable `id`. It contains no credentials or console tokens.

For a **new mission**, opt into measured context by adding this top-level
configuration field (this fragment is not a complete configuration):

```json
{
  "proposalFeedback": "measured-outcomes-v1"
}
```

This gives the next-objective proposer bounded evidence from the latest verified
delivered enrollment: campaign/comparator identities, seed and selected scores,
stage counts, recorded token subtotals and summed worker-execution timings.
Partial observations retain their measured counts and subtotals, with explicit
incomplete coverage and `null` totals; missing measurements are not zero usage or
zero duration. Acceptance remains fixed-evaluator-and-local-branch-only, and
metrics are campaign-cumulative, not causal credit for one graph invocation.
This context does not change workers, routing, budgets, acceptance or authority,
and does not establish product acceptance.

Omitting the field preserves legacy configuration and proposal bytes. Do not add
it to an existing mission journal: it changes the pinned configuration digest.
The original settled-record schema is unchanged. Replay regenerates context from
verified evidence and requires the exact retained proposal task; meaningful
measurement changes, including partial timing, hold rather than silently rewrite
or dispatch the old task. Context detail is bounded to 16 KiB. If valid detail
exceeds that bound, the proposer receives an explicit unavailable envelope with
its evidence digest, not truncated metrics. Invalid source/bounds proof can hold
completion. Opt-in proposal prompts are bounded to 64 KiB; fixed feedback
unavailability and prompt-bound diagnostics are retained in invocation history.
No model, provider or real mission acceptance is implied by this option.

For opted-in missions, `mission check` reports the configured feedback mode.
`mission status` includes `recordedFeedback`: the latest retained proposal's scope
index, availability, fixed fallback reason, evidence digest and campaign count.
An unrecorded or invalid envelope is explicit; no prompt text is exposed. This is
proposal **intent**, not proof the worker consumed it, and status does not
revalidate current delivery or usage evidence. Legacy status output is unchanged.

From the repository root, check the selected configuration without starting work:

```sh
node bin/ashlr resources pool engineering mission check \
  --config /absolute/private/mission.json --json
```

The result includes `configDigest` and initial setup holds. A checked configuration
does not prove live capacity. After selecting the account/work scope and resolving
its holds, the following **effectful** command starts configured collectors and
workers, consumes allowed resources, evaluates changes and creates local delivery
branches. Replace `CHECKED_SHA256` with the exact check result:

```sh
node bin/ashlr resources pool engineering mission run \
  --config /absolute/private/mission.json \
  --expected-config-digest CHECKED_SHA256 --execute --json
```

Progress events go to stderr, including the current scope and loopback console
URL; the final report goes to stdout. Exit `0` means checked or the configured
mission finished, `1` means held/stopped/unavailable, and `2` means invalid arguments.
Finished does not mean the broader product vision or production deployment is complete.

For a fast, read-only journal view, run
`node bin/ashlr resources pool engineering mission status --config /absolute/private/mission.json --json`.
It reports recorded phase, reserved/settled scope counts, the original remaining
time, completion reason and recorded delivered tip. It does not start an owner,
read provider usage or rerun Git proof. `ownerState: "not-observed"` and
`deliveryState: "not-revalidated"` prevent recorded progress being mistaken for
current liveness or branch integrity. Status exits `0` for a valid observation,
including an unstarted or expired mission; unreadable/drifted history exits `1`.

The `invocations` field separately reports retained runner attempts: the latest
start, final outcome/reason, monotonic elapsed time and per-scope phase durations.
It also counts attempts without a terminal observation. A missing outcome means
**unknown**, not an active worker or permission to retry. Final outcomes are
recorded after console shutdown and mission-lock release; either failure is
retained as a held result when final observation publication succeeds.
Setup failures before ownership have no invocation
record and remain visible only in the command's returned report.

These private immutable observations live in `mission-invocations`, separate
from the execution decisions in `mission-events`. They contain no prompts,
model output, console URLs or credentials. Repeated phase notifications share
one timing bucket; timings are available after finalization, not a live heartbeat.
The journal is bounded to 4096 starts and 8192 total records, with no automatic
eviction. Unreadable/full history prevents a new recorded invocation. A reported
finalization failure returns `invocation-record-unavailable`; publication may
already have committed an outcome or left history unreadable. Only a missing
finish record means the outcome is unknown. Writer-lock cleanup failure can also
leave history unreadable without a finalization error; preserve it for inspection.
Neither status nor invocation history renews a deadline or proves delivery.

SIGINT/SIGTERM, global KILL, deadline expiry, lost ownership or a `STOP` entry in
the mission root prevent further execution and drain owned work. Existing account
and queue pauses are not cleared. Immutable `mission-events` retain reservations,
setup pins, original queue deadlines, completion proofs and exact proposal results.
Rerun the same command/configuration to reconcile proven work; changing the deadline
or scope cap is not a restart. A lost or uncertain proposal is not regenerated under
a new identity. Temporary HTTP 503 **snapshot reads** wait within the original
deadline; mutation failures, authentication refusals and quota denials do not use
that retry path. Preserve incomplete setup or unresolved records for inspection.

This is a foreground implementation, not an installed resident service or a
commissioned account fleet. It retains existing finite history limits, performs
synchronous offline proof checks between owners, and does not advance existing
branches, push Git, publish packages, or deploy applications. Long-running native
acceptance and provider-specific qualification remain separate release gates.

### Prepare and run objectives in the workspace

With `--engineering-preparation /absolute/private/profiles.json`, an execution
console can prepare new objectives and enroll them without a restart. This
requires `--execute`, `--workspace` and `--projects`; a pre-existing `--engineering`
catalog is optional. Existing account policies, quota evidence and shared ledger
are reused. Startup can resume ordinary queued tasks, just like any execution
console. By default, preparation does not launch engineering work. The optional
host policy below can automatically admit prepared objectives to supervision.

The private `0600` configuration follows
[`ResourceConsoleEngineeringPreparationConfig`](../src/core/resources/console-engineering-preparation-types.ts):

- `schemaVersion: 1`;
- `outputRoot`: an existing private `0700` directory for new bundles, outside
  writable projects, transport workspaces and shared accounting;
- `resourceRuntime`: the existing runtime using this console's exact ledger,
  pool, bindings, observations and optional shared collector configuration;
- `profiles`: up to 16 unique entries containing `id`, `label`, `acceptance`
  and a complete reviewed `recipe` from the preceding section.

Each profile fixes the project, full seed commit, evaluator, metric, permitted
files, read-only context, hypotheses, workers and budgets. Its `acceptance` text
explains what the fixed evaluator actually measures; it is not itself a passing
result. The recipe's identity/name/objective are template defaults. A submitted
objective overrides those three fields; delivery always uses the new local
`codex/<objective-id>` branch. Browser requests cannot provide commands, paths,
account settings or wider permissions. Keep the configuration outside writable
projects. Do not place secrets in profiles, objective text or acceptance labels.

1. In **Workspace**, select the intended project and open **Engineering runs**.
2. Unlock controls, select an evaluation profile and inspect its fixed scope.
   Enter an objective that this evaluator can measure. A name is limited to
   120 UTF-8 bytes and objective text to 4,000 bytes.
3. Select **Check plan**. This only reads local configuration and evidence;
   it does not create output, reserve quota or run workers/evaluators. Review
   the seed, file scope, budgets, delivery branch and checked plan digest.
4. Select **Prepare plan** to create the bundle and immutable registration.
   The existing engineering pane selects the newly enrolled plan in the same
   console. With `autoAdmitPrepared: true`, this action is labelled **Prepare and
   queue** and also admits the prepared plan to the existing automatic queue.
   Preparation and queue admission are not accepted engineering work.
5. In the default manual mode, inspect local launch checks, then use **Run
   enrolled plan** to authorize its existing bounded worker/evaluator/delivery
   flow. Stop and evidence controls are the same controls used for
   startup-enrolled plans.

Profiles, checks and preparation use control-authenticated POST requests with an
explicit matching Origin. Profile listing (`/api/resources/engineering/profiles`,
body `{projectId}`) and checking (`/api/resources/engineering/prepare/check`, body
`{id,profileId,name,objective}`) remain read-only. Preparation at
`/api/resources/engineering/prepare` adds `expectedPlanDigest` and returns the
verified plan, enrollment and `created`/`replayed` disposition. No evaluator
command or host output path is exposed through these projections.
When automatic admission is configured, the response also contains
`automaticAdmission: {state: "admitted" | "unavailable", supervisionId}`. This
reports queue admission, not a worker launch or completed result. If admission
is unavailable, the prepared registration is still durable. The host retries
admission for ordinary objectives carrying the durable automatic-admission
marker, including after restart with the same queue identity. It rechecks saved
evidence and preserves the original deadline, lifetime enrollment cap and pause;
it does not invent a replacement objective. Inspect supervision rather than
creating a new ID to hide the hold. Registration without this marker is not
automatically adopted by recovery.

With automatic admission configured, an authenticated read session can inspect
`GET /api/resources/engineering/automatic-admission`. This returns the original
queue identity and deadline, sampling time, recovery state, and bounded pending
enrollment IDs/digests with hold reasons. Reading it does not prepare, admit or
launch work. An unconfigured console returns 403. `ready` means the last pass
had no pending holds, not that a worker ran or delivered a result; inspect
supervision and outcome receipts for those facts.

| Hold reason | Meaning and next action |
| --- | --- |
| `verification-pending` | Another marked obligation received this pass's proof check; allow a later bounded pass. |
| `evidence-unavailable` | Saved evidence could not be verified; inspect the original preparation without inventing a new objective ID. |
| `binding-changed` | The registration belongs to a different original queue binding; recovery does not migrate it. |
| `capacity` | Admission is full; completed entries still count against the lifetime cap. |
| `admission-unavailable` | Admission or its budget is unavailable; check supervision health, the original deadline and current ownership. This is not a promise that retry will succeed. |

Pending rows describe the last reconciliation, not a continuously verified
inventory. Check `sampledAt`; a full queue skips fresh proof reconstruction and
may retain prior pending reasons. Paused queues can accept verified entries but
remain paused. Recovery never renews the deadline or increases the cap.

The workspace's **Automatic engineering** panel displays this same queue-bound
report when automatic preparation admission is enabled. Expand **Review pending
registrations** to inspect holds. The sample time comes from the host, not the
browser's last refresh. Disconnected, failed or superseded reads leave retained
details explicitly historical; a clear recovery pass is not a running worker or
completed delivery. Recovery reads share supervision's polling cycle and have
a five-second deadline, without adding execution controls. A failed recovery
read does not disable pause when supervision's own evidence and control access
remain valid.

Completed registration survives restart through private
`console-engineering-preparations` records in the existing resource root. Reload
verifies the exact profile, accounting/project context and completed bundle
before enrolling it; it never initializes missing output or starts a graph.
Unrelated profiles may be added on restart without invalidating existing
objectives. Removing/changing a profile already used by a saved objective, moving
output or changing its accounting context requires inspection; do not discard
history to make startup pass. Existing console instances refuse changed profile
files until restarted with the intended configuration.
Startup validates every configured profile and saved registration as one set.
A disabled/drifted project or invalid historical bundle blocks this
preparation-enabled console from starting; it is not silently hidden while the
remaining profiles launch work. Restore or review the affected configuration
and evidence before restarting.

After an uncertain prepare response, retain the same objective ID and input.
Registration may not have completed. Refresh evidence and explicitly
**Reconcile preparation**; exact completed replay verifies without rewriting
registration records. If automatic work was durably registered, the host may
recover admission and run it before this reconciliation, within the original
deadline and cap; a paused queue stays paused. Reconciliation uses the same
queue entry, so an already admitted plan is not duplicated.
Incomplete bundles/staging remain held for inspection, not deleted or repaired
automatically.
The combined static and prepared enrollment catalog is bounded to 32 entries.
By default, preparation uses the original `console-engineering-preparations`
store and preserves its existing digests. A host can explicitly select a separate
history using optional `registrationScope` in the private preparation config, or
in the setup policy that generates it. The scope is a 1–64 character lowercase
identifier matching `[a-z0-9][a-z0-9_-]*`, not a path or an objective-request field.
It selects `console-engineering-preparations-scope-<id>` beneath the **same account
ledger root** and is included in the checked context and plan identity. Each
scope retains its own 32-registration limit. Reads, replay, startup restoration
and automatic-admission recovery inspect only the selected history, never merge
or fall back to another scope. Changing a running configuration remains refused.

For an explicitly configured subsequent campaign, close the previous console
normally, retain its output and records, and use a new scope, private output and
unique objective/supervision identities. Shared usage receipts, task-window caps,
account pauses, General/Spark reservations and allocation ceilings still apply.
The scope does not start work, verify that previous obligations are settled,
renew a deadline or authorize continuous campaign rollover. Do not switch scopes
to bypass uncertain preparation, delivery or ownership. An automatic standing
mission must separately prove predecessor settlement before selecting a new
scope; that caller is not yet implemented. The shared pool ledger also retains
its existing attempt/storage bounds, so this is not an unlimited-history claim.

For bounded, model-proposed follow-up work at a verified delivered commit, see
[automatic successors](#automatic-successors-from-verified-deliveries). Accumulation
into an existing integration branch and production deployment remain separate capabilities.

### Evaluated engineering runs

The optional **Engineering runs** pane is separate from ordinary chat. It runs an
explicitly enrolled portfolio through the existing signed graph, campaign
controller, resource pool, confined evaluation and local branch delivery. Opening
the pane, selecting a plan or refreshing evidence never dispatches work. Account
connections, quota reserves and worker permissions are unchanged.

Prerequisites are the same as the [enrolled engineering CLI](FIRM-DEMO.md#execute-an-enrolled-engineering-portfolio):
initialized experiments and campaigns, fixed evaluators, explicit new `codex/`
delivery targets, private resource runtime and existing host provenance. Every
campaign seed must be the selected registered project. The generation transport
workspace must remain a separate sterile Git directory. The runtime must use the
console's exact pool, bindings, observations and accounting root. When quota
collection is configured, use that same quota configuration with
`quotaEvidenceMode: "shared-collector"`; do not start another collector.

For a new objective, the [preparation command](#prepare-an-engineering-objective)
generates the experiment, campaign and catalogs used below. Manual enrollment
remains available for existing advanced portfolio configurations.

For a source-built local console:

1. Review the existing engineering host enrollment and the intended project,
   campaign budgets, evaluator and delivery branches. This action can consume
   enrolled model allowance and create local Git branches; it does not publish
   them remotely. Preserve the seed checkout and record the intended branch names.
2. Create a private `0600` catalog outside writable projects. The exact
   [`ResourceConsoleEngineeringCatalog`](../src/core/resources/console-engineering.ts)
   has `schemaVersion: 1` and `enrollments` (1–32 entries). Each entry contains
   `id`, `projectId`, `graphId`, `graphRoot`, and the same `host` object documented
   for the engineering CLI. Use registered lowercase project/enrollment IDs,
   distinct controllers, and distinct existing private graph directories. Never
   store the catalog in the repository or accept model-generated host settings.
3. Run the [standalone commissioning check](#check-engineering-configuration-without-starting-the-fleet)
   against the same files. Review every enrollment and worker, including holds.
   The check is nonexecuting; it does not register projects or authenticate accounts.
4. Start the existing execution console with `--projects` and the new
   `--engineering /absolute/private/engineering-catalog.json` option. For example,
   after substituting the reviewed local paths:

   ```sh
   node bin/ashlr resources pool console \
     --root /absolute/private/shared-resource-ledger \
     --pool /absolute/private/pool.json \
     --bindings /absolute/private/bindings.json \
     --observations /absolute/private/observations.json \
     --execute --workspace /absolute/projects/ashlr-hub \
     --projects /absolute/private/projects.json \
     --engineering /absolute/private/engineering-catalog.json
   ```

5. Open **Workspace**, select the registered project, then **Engineering runs**.
   Inspect the declared dependency order, campaign and experiment limits,
   delivery branches and enrollment digest. These limits are ceilings, not an
   estimate of current account balance. The standard resource ledger still
   decides admission across ordinary tasks and engineering generations. Review
   **Before this plan runs** for local admission checks. A held plan lists fixed
   reason codes with operator guidance; after resolving the condition, select
   **Refresh evidence**. Refreshing never launches or retries work.
6. Unlock controls and select **Run enrolled plan**. The browser sends only the
   enrollment ID and displayed digest, never a command, path or revised budget.
   Launch creates durable ownership evidence; status reads show signed graph
   evidence. A recorded delivery means fixed-evaluator/local-branch acceptance,
   not production deployment or proof that the branch has not subsequently moved.

**Stop engineering run** persists a stop record before aborting owned work. It
does not undo a branch already delivered. **Pause task queue** prevents new
engineering launches but does not terminate an already active engineering run.
At most four enrolled graphs are active in one console owner; resource limits
can impose a lower concurrency. Automatic supervision below reuses this same
owner and quota ledger; it does not create additional worker capacity.

Readiness is a sampled local observation, not a worker connection test, capacity
reservation or permission to execute. It checks known stop switches, owner and
project availability, signing-identity presence, runtime/campaign/accounting pins,
and recorded campaign, graph and launch state. For a fresh launch, an existing
graph execution lock or controller enrollment also withholds admission. Lock
presence alone does not establish whether its owner is alive; the check does not
repair or remove it. Existing accepted-work reconciliation retains its ordinary
proven-dead lock recovery. Temporary resource occupancy remains subject to the
existing bounded capacity wait, not a new hard readiness denial.

Known blockers are checked before acquiring launch ownership, again under that
ownership, and immediately before publishing the first accepted launch. A hold
detected before ownership acquisition leaves the graph and launch store
untouched, so resolving it does not require inventing a new enrollment. The final
publication check can still leave staging/store directories if a condition races
in during publication; no provider dispatch follows a refused publication.
Post-acceptance races retain the existing uncertain-work holds below. A passing
sample is never a guarantee that execution will start or succeed. If readiness
cannot be read, the workspace still exposes recorded run evidence and its stop
control. New launch remains withheld.

Without explicit automatic supervision, restart never launches an enrollment,
creates a new graph identity or renews its allowance. **Reconcile completed work** uses only the existing
exact completed-child receipt recovery within the original deadline. A previous
accepted launch with no graph intent stays held, as do unfinished or mismatched
children. Do not rename the graph/controller to retry uncertain work. A cancelled
enrollment remains cancelled after restart. If a request loses its response,
refresh evidence before taking another action; closing a browser panel does not
cancel backend work.

Metadata/status routes use read-session authentication; start/cancel require
control authority and an exact Origin. All responses are bounded and no-store:

| Route | Result |
| --- | --- |
| `GET /api/resources/engineering` | Enrolled summaries, including project identity and digest |
| `GET /api/resources/engineering/:id` | Recorded graph/ownership projection |
| `GET /api/resources/engineering/:id/readiness` | Non-dispatching local admission sample; `ready`, `blocked` or `not-applicable` |
| `GET /api/resources/engineering/:id/outcomes` | Read-only campaign evaluation, local delivery and exact worker-usage attribution |
| `POST /api/resources/engineering/start` | `{enrollmentId, expectedEnrollmentDigest}` → owned job, HTTP 202 |
| `POST /api/resources/engineering/:id/cancel` | Empty object → durable stop projection |

The readiness response binds `enrollmentId` and `enrollmentDigest`, with
`schemaVersion: 1`, `sampledAt`, `status`, `action` (`launch`, `reconcile`, `continue` or
`none`), fixed `reasons`, `scope: "local-admission-check-only"`,
`effectsExecuted: false` and `providerContacted: false`. A blocked response has
no action. Those flags describe admission itself: it does not launch graph work,
probe a provider or reserve a worker. Existing supervisor ownership checks remain
fail-closed; discovering a lost lease can stop already owned ordinary tasks.
Readiness does not suppress that cancellation behavior or claim the surrounding
service is inert. This endpoint checks an already started console; it is not a standalone
read-only commissioning command, because console startup can initialize the
ordinary supervisor. Use the standalone check below before startup. No private
paths or raw storage errors are returned.

Startup may initialize the ordinary supervisor and resume queued ordinary tasks,
including worker dispatch. Engineering graph work starts automatically only when
the explicit supervision configuration below is supplied.
Explicit console close aborts and awaits owned engineering
and ordinary work before collector teardown. An external stop signal can stop
collectors concurrently. Neither path bypasses existing uncertainty holds.
After graph execution, a clean close also requires a readable shared resource
ledger with no reserved or uncertain attempts, checked after ordinary task drain.
An unrelated unresolved attempt can conservatively withhold clean shutdown; the
diagnosis does not claim that engineering created it.

New Universe generations record `origin` on the resource task and its reserved
receipt before worker dispatch. The closed shape is
`{kind: "universe-generation", universeId, runId, variantId}`. It must match the
existing deterministic task ID, and the full task digest includes it. Settlement
and exact replay retain that provenance even when no final trial is published.
It records the host's dispatch origin, not completion, acceptance, or permission
to release a worker or advance a successor.

Legacy tasks and receipts without origin remain readable and are not backfilled.
Adding, stripping, or changing origin on an existing task conflicts; do not edit
the ledger or create replacement IDs to bypass that conflict. An old pending
generation cannot silently acquire the new envelope during restart. The shared
shutdown fence above remains in force until independently scoped mission
lifecycle and complete ownership checks are implemented and accepted.

Successor-coordinator proposals similarly record
`{kind: "engineering-successor-proposal", scopeDigest, proposalKey}`. The scope
digest binds the full coordinator enrollment (including its pool, deadline and
pinned workspace); the proposal key preserves its existing task ID. Journal
readback verifies that scope, and receipt readback requires the same origin as
the retained task intent. Legacy proposal intents keep their original envelope.
This does not yet attribute mission-level proposals submitted as ordinary console
tasks. Older binaries reject origin-bearing receipts: coordinate reader upgrades
before using a shared live ledger, and never strip provenance as a rollback.

### Read engineering outcomes and resource use

Select an enrolled plan in Workspace → **Engineering runs**, then choose
**Read outcome evidence**. The inspector reads only on request; graph polling
does not repeatedly load campaign evidence. **Refresh outcome evidence** samples
again. Changing the project, enrollment or authenticated session discards the
previous result. A failed refresh removes the old report rather than presenting
it as current.

The report connects each declared campaign trial to its exact shared-ledger
resource receipt, including historical pool/worker identity. It shows separate
counts for evaluated, passed, rejected, selected and strictly improved candidates,
plus currently verified planned local deliveries. These stages overlap: they
are not a funnel, a model ranking or proof of production acceptance. A first
passing repair is not automatically a strict improvement over a prior trial.
Seed score and direction-adjusted changes remain separate from parent-trial
feedback. Scores are never aggregated across different comparators.
For campaigns with a measured passing seed, local delivery must beat that seed
by the declared positive improvement threshold in every generation. Improving
only a worse intermediate candidate does not qualify as delivered progress.

Usage includes unsuccessful attempts, not just the final selected candidate.
**Recorded token subtotal** preserves known input/output usage when another
attempt is unknown; a complete total is `null` until all observed attempts have
matching reported usage. No attempts means no measured total, not a zero-cost
success. Execution time is the sum of matching terminal worker measurements,
not elapsed campaign time, evaluator time, total company time or provider billing.
Missing timing retains its own coverage count and a `null` total independently
of token coverage. Worker rows show participation, not sole credit for an artifact.

The authenticated read-token endpoint above resolves an enrollment ID through
the host-owned project binding. It accepts no browser-supplied file paths and
uses two bounded observations to detect changing evidence. Missing, mismatched
or changing evidence yields an unavailable/degraded report; moved delivery
branches lose their verified-delivery count. **Evidence coverage complete**
describes the sampled evidence, not whether a campaign has finished.

This is cumulative campaign attribution, not costs isolated to one graph
invocation. Raw worker receipts remain `verifiedAccepted: false`; the existing
resource performance report remains `quality: 'unmeasured'`. This separate
fixed-evaluator/local-branch report creates neither production acceptance nor
automatic routing, account allocation, execution, repair or promotion authority.

### Automatic engineering supervision

The optional `--engineering-supervision /absolute/private/supervision.json`
flag adds a finite unattended queue to the existing execution console. It requires
`--execute`, `--projects` and either `--engineering` or
`--engineering-preparation`. Starting this configured console
can consume enrolled provider allowance and deliver local branches **without a
browser click**. Keep this file private (`0600`), outside every writable project.
It contains exact enrollment digests obtained from the engineering catalog API;
the placeholder below must be replaced with the displayed 64-character digest.

```json
{
  "schemaVersion": 1,
  "id": "hub-night-shift",
  "maxDurationMs": 14400000,
  "pollIntervalMs": 3000,
  "maxConcurrent": 1,
  "maxAttemptsPerEnrollment": 4,
  "enrollments": [
    {
      "enrollmentId": "hub-improvements",
      "expectedEnrollmentDigest": "REPLACE_WITH_VERIFIED_ENROLLMENT_DIGEST"
    }
  ]
}
```

The accepted limits are 1–86,400,000 ms duration, 100–60,000 ms polling,
1–4 concurrent graph invocations, 1–16 invocations per enrollment, and 1–32
unique enrollments. Invocations are **not** model requests or account usage;
the original campaign/resource ceilings still apply. Declaration order is
preserved. This default configuration fixes the queue. It cannot change
evaluators or enlarge its own settings.

#### Automatically admit new prepared work

To let a running console take new objectives without a per-plan Run action,
configure an appendable queue before its first start. For example, with the
preparation profiles already configured:

```json
{
  "schemaVersion": 1,
  "id": "hub-objective-intake",
  "maxDurationMs": 14400000,
  "pollIntervalMs": 3000,
  "maxConcurrent": 1,
  "maxAttemptsPerEnrollment": 4,
  "maxEnrollments": 12,
  "autoAdmitPrepared": true,
  "enrollments": []
}
```

`maxEnrollments` enables append-only admission and bounds the total retained
queue to 1–32 enrollments, including completed entries. Only this mode permits
an empty initial queue. `autoAdmitPrepared: true` additionally requires
preparation profiles: each authenticated successful prepare operation records
its original queue binding and attempts admission automatically. Startup and
bounded, non-overlapping background passes recover pending marked ordinary
registrations under that same binding; failed or incomplete preparation is not
silently completed. A host-authorized agent can use the same
profile/check/prepare protocol as the UI; it needs no separate human launch.
Checks remain nonexecuting. The selected profile still fixes the evaluator,
seed, file scope, allowed workers and per-campaign limits.

Prepared work admitted while paused stays paused. An empty queue, or a queue
whose current work is complete, waits for new admissions until the original
deadline. Admission wakes that existing loop; it does not create another
scheduler, renew time, clear stop records, release accounts or reset attempts.
Completion does not free the lifetime enrollment cap. Changing policy under an
existing supervision ID is refused rather than silently migrating its authority.

Without `autoAdmitPrepared`, an appendable queue accepts explicit admission via
**Add plan to automatic work** or the authenticated API below. A request contains
`{enrollments: [{enrollmentId, expectedEnrollmentDigest}], expectedRevision}`.
The entire batch must resolve to current host-owned enrollments. New entries
are persisted atomically in request order before execution can begin, using the
same revision as pause controls. Stale additions, conflicting digests, expired
budgets and capacity overflow are refused. An exact all-existing retry is
read-only and does not duplicate work; future revisions are never accepted.

#### Retained execution and recovery

Construction persists the original deadline, configuration digest, pause revision
and per-plan invocation evidence under the shared resource root's
`engineering-supervision/<id>/` directory. It does not dispatch. The console
starts the caller after its listener and configured collectors are ready.
Private exclusive ownership and compare-and-swap persistence prevent overlapping
callers and unnoticed state replacement. Polling does not write heartbeat records.

Restarting with the same configuration retains the original deadline, including
downtime, pause state and consumed invocation allowance. Changed settings under
the same ID are refused. Do not delete state or invent a new ID to replay uncertain
work. Proven completed work may reconcile; continuing declared never-started
campaigns additionally requires the enrollment's existing
`allowPendingContinuation: true` policy. Unchanged unresolved evidence cannot
trigger another invocation each poll. Missing evidence, unknown execution,
durable cancellation, original deadlines and KILL remain authoritative.

The Workspace **Engineering runs** pane displays **Automatic engineering** only
when this feature is configured. Its scope is console-wide, not the currently
selected project. It shows the original deadline, each pinned plan's state,
fixed hold reasons and invocation count. **Pause automatic launches** persists
a revision-checked pause across restarts; **Resume automatic launches** does not
renew any deadline. Pausing does not cancel active work; use that plan's Stop
control. Closing the browser does not stop supervision. Closing the console
aborts and drains its automatic invocations before releasing their ownership.

| Route | Result |
| --- | --- |
| `GET /api/resources/engineering-supervision` | Bounded observation only; never launches or writes state |
| `POST /api/resources/engineering-supervision` | Exact `{paused, expectedRevision}` control; stale revisions return conflict |
| `POST /api/resources/engineering-supervision/admit` | Append ID/digest pairs under the current revision; requires the configured admission policy |

Reads require the existing read session. Writes require the control token and
exact Origin; responses are no-store. The hyphenated route deliberately preserves
`/engineering/supervision` as a possible existing enrollment-detail route.

This implements console-owned unattended execution, **not** an installed OS
service, real-account commissioning or public deployment. Optional automatic
successors below add bounded ideation and delivered-seed preparation. Neither makes same-user storage
tamper-proof or guarantee monotonic wall time across process restarts.

#### Automatic successors from verified deliveries

Add `--engineering-successors /absolute/private/successors.json` to an execution
console that already has preparation profiles and appendable supervision.
Starting with this policy authorizes **provider-consuming proposal work and local
successor delivery without a per-objective human action**. Omit the flag to disable
this capability. Keep the file private (`0600`) and outside writable projects.

```json
{
  "schemaVersion": 1,
  "supervisionId": "hub-objective-intake",
  "profileId": "hub-quality",
  "allowedWorkerIds": ["enrolled-proposer"],
  "maxOutputTokens": 2048,
  "proposalTimeoutMs": 60000,
  "maxSuccessors": 8,
  "pollIntervalMs": 3000
}
```

Replace the example identifiers with an existing supervision ID, preparation
profile and enrolled pool worker IDs. On first coordinator enrollment,
`maxSuccessors` must fit the supervision's remaining enrollment slots;
existing queue entries also consume its `maxEnrollments` lifetime capacity.
Policy limits are 1–32 successor intents, 1–8192 output tokens per proposal,
1–900,000 ms per proposal and 100–60,000 ms polling. The original supervision
deadline and shared account/quota/allocation controls apply in addition. This
configuration does not connect accounts or change their reservations.

The coordinator follows this sequence:

1. Select a completed, preparation-registered objective in the configured project.
2. Check fresh admission evidence against the existing resource planner before
   proving the source or publishing a new intent. If no allowed worker is eligible,
   or evidence cannot be read, reconsider on a later poll within the **same original
   deadline**, without consuming a proposal intent or successor slot. Then
   verify its campaign, evaluation and local branch-delivery evidence, persist a
   deterministic proposal intent and use the existing resource ledger
   for one read-only proposal task. Context includes the profile acceptance text,
   seed and delivered scores, measured parent delta, and bounded text from the
   **delivered artifact**, not the possibly older working checkout.
3. Accept only strict JSON: `{"action":"stop"}` or
   `{"action":"propose","name":"...","objective":"..."}`. The model supplies
   intent, not paths, commands, evaluators, worker authority or a seed revision.
4. Prepare a new objective with its seed pinned to the verified delivered commit,
   retaining the selected profile's evaluator, file scope, worker allowlist and
   campaign limits. Its manifest records the source campaign and delivery digests.
5. Admit that exact enrollment to the existing supervision queue. Subsequent
   execution still requires evaluated improvement and its planned local delivery.

Passing the seed is not sufficient improvement. Each successor retains its seed
measurement across its own campaign. The source branch is freshly verified before
proposal dispatch, preparation and admission; once launched, the successor works
from its immutable seed, not a branch that it continuously follows. No existing
branch is advanced, and no push, merge or production promotion is implied.

`GET /api/resources/engineering-successors` uses the existing read session and
returns no-store metadata: original deadline, source/successor/task identities,
live phase and held state. It returns 403 when unconfigured. Private context,
source paths, prompts and raw model output are not in this response. Configured
consoles advertise `engineeringSuccessorsSupported: true` and show **Successor
planning** in the Engineering workspace. The read-only lineage panel shows the
profile, original deadline, consumed intent slots, source enrollment, proposal
task and reserved successor identity. It refreshes status every three seconds
after the previous read settles; disconnected or failed samples stay visibly
stale. A changed coordinator identity requires reloading the console.

**Queued means admitted, not executed or delivered.** Inspection is available
only for plans resolved in the current project's catalog. Newly prepared or
queued identities request one catalog refresh without changing the selected
plan; foreign-project plans do not appear in that project's selector. If the
catalog refresh fails, use **Refresh evidence** to retry the read. Existing
supervision status also refreshes selected-plan evidence when automatic work
starts or settles. None of these observation effects launches a worker.

There is no separate successor mutation endpoint; pause automatic launches
using the existing supervision control. Pausing does not cancel work
already dispatched. Console shutdown aborts and drains owned proposal and
engineering work together.

The private successor journal stores bounded source context and model output;
it is local evidence, **not encrypted storage**. Treat it as source-sensitive.
Explicit truncation/omission metadata accompanies bounded file excerpts. Valid
UTF-8 excerpts preserve BOM and line endings; invalid complete files are omitted,
and an incomplete code point is dropped only at a genuinely truncated prefix. A
completed result is retained even if a pause or source drift subsequently blocks
the next action. `stop` ends follow-up for that source, not unrelated queued work.
Every retained intent, including stopped or held proposals, consumes the successor
cap. Restart does not replenish the cap or renew the deadline.

Pre-intent eligibility is read-only, not a reservation: final dispatch still
checks admission atomically. Cached observations cannot override a fresh quota
refusal. Capacity or evidence can change during source verification; this check
does not promise atomic eligibility through intent publication.

An explicit no-reservation capacity denial may wait within the original deadline.
Unknown ownership, invalid output, missing paid output, incomplete preparation,
source drift and quota denial **after intent publication** remain held. Restart
reconciles exact persisted results and registrations; it never invents another proposal identity to recover
lost paid output. Inspect the retained evidence and underlying quota/source issue;
do not delete journals, reset counters or create new IDs to conceal uncertainty.
This is bounded autonomous follow-up, not an unlimited resident company or an
independently commissioned production fleet.

#### Diagnose automatic intake latency

Consoles configured with automatic successors run preparation and successor
coordination in a dedicated local worker thread. That thread retains the original
fresh verification, staging and locally acquired locks; it does not receive
serialized leases or cached proof authority. The main thread keeps the HTTP
listener, engineering owner, account collector and durable supervision queue.
Internal calls back to those owners are bounded and revision-checked. Ordinary
explicit admission while paused remains supported; autonomous successor admission
is withheld when the parent observes pause, close or the original deadline.

Closing requests drain rather than killing an effectful thread on a timer. An
ambiguous mutating call or unexpected worker failure stops the background path;
it must not automatically replay with a new revision or replace the worker.
Inspect retained evidence if shutdown reports uncertainty. The API, private
configuration and account-reserve settings are unchanged.

Successor status uses a separate read-only worker, prewarmed before execution.
Each request reads the immutable journal against the original startup pins and
rechecks the selected configuration file. Overlapping requests receive distinct
read jobs, not a shared earlier sample. A missing enrollment, incomplete writer
stage, corrupt record or mismatched attribution makes the read unavailable;
observation never acquires a lease, repairs records or dispatches work.

A coherent record set marked only as changing can be sampled again within the
same request: at most ten attempts, with new attempts admitted only within a
500 ms window. Each attempt repeats the configuration and full journal checks.
This does not retry malformed/staged/unsafe evidence or treat a lock as proof of
a live owner. It is not a hard completion deadline for a synchronous proof.

The console labels this evidence **Verified journal** and displays its sample
time and worker connection separately. An intent without a result means only
that the intent was recorded, not that the response was lost. Recorded proposal,
preparation and admission milestones are not live activity reports, current
accounting verification or proof of downstream delivery. A late response after
worker exit, fault or console close is rejected. Parent-owned projections can
still be expensive; verify the independent gate below before making latency
or always-on claims.

The separate **Last reported coordinator** field describes a process-local
transition, with its own timestamp and fixed reason. `running` means the loop
started or cleared its guard; it does not establish active model execution or
current health. `held` means an execution guard refused work (which can include
pause, configuration/project drift or ownership uncertainty), or that its signal was aborted.
`waiting` means at least one otherwise-ready source was deferred before a new
proposal intent: `proposal-workers-ineligible` reports no eligible allowed worker;
`proposal-admission-unavailable` reports that fresh admission evidence could not
be verified. If both occur in one pass, unavailable evidence takes precedence.
Neither reason implies quota exhaustion specifically or promises a start time.
Waiting consumes no new intent slot for that source and retains the original
deadline; other sources may already have recorded work. Unchanged waiting polls
retain the report timestamp and sequence. Actual progress clears waiting, while
pause, stop, deadline and close take precedence. Deploy the matching console UI
with this backend so its strict decoder recognizes the new lifecycle value.
The `held` state is not automatically labelled as a user pause. A caught loop failure reports
`faulted` without closing independent enrolled work. Deadline and explicit close
transitions are reported separately. Missing reports are unknown.

Reports are pinned to the initialized supervision ID, configuration digest and
original deadline. A strictly increasing sequence orders transitions from that
one worker; wall time is display metadata. Invalid, reordered or differently
bound reports cannot replace the last valid report or refresh its timestamp.
Refreshing the journal does not refresh the coordinator report, and a connected
worker can legitimately accompany a faulted coordinator. These observations
never authorize execution, renew budgets, replay work or trigger a restart.

Run the independent control-room responsiveness gate on macOS from the repository:

```sh
npm run test:engineering-responsiveness
```

It uses the actual setup and console CLI with private temporary Git repositories,
fixed evaluators and a loopback worker. It does not use your provider accounts.
Seven fresh, non-retried HTTP probes cover proposal admission, source proof and
successor preparation; one authenticated pause must prevent successor admission.
Each measured response must complete within two seconds. A longer observation
ceiling records the actual stall and does **not** relax that assertion. The test
also verifies original deadline, delivery, exact charged proposal and unchanged
account policies. It prints bounded `RESPONSIVENESS_MEASUREMENTS`, without tokens
or private source content, and cleans its child processes and temporary state.

This is an explicit performance acceptance gate, separate from `npm test`.
Treat a failure as an unresolved responsiveness defect, not permission to raise
the target, retry the control action or claim always-on readiness. Passing the
default correctness tests does not satisfy this gate. Other platforms are not
covered by this macOS fixture; compare revisions on the same otherwise-idle host.

The successor acceptance fixture uses temporary Git repositories, fixed evaluators
and loopback workers, not your enrolled provider accounts. To print existing
proof-call and preparation timings without adding extra validation reads:

```sh
ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING=1 npx vitest run \
  test/resource-engineering-successor-acceptance.test.ts \
  --no-file-parallelism --reporter=verbose
```

This creates and cleans fixture-local branches and journals. Timings are one-host
observations, not a model-quality benchmark or a production latency guarantee.

On macOS, the local acceptance fixture can print bounded phase timings for preparation,
completion, shutdown, startup restoration and exact replay:

```sh
ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING=1 npx vitest run \
  test/resource-engineering-supervisor-admission-acceptance.test.ts \
  --no-file-parallelism --reporter=verbose \
  -t 'automatically admits newly prepared objectives'
```

Run from the repository with its development dependencies installed. This test
creates disposable private files, Git repositories and a loopback worker; it
does not use connected provider accounts. It retains the existing test and
campaign time limits. Unselected cases are not evidence of coverage.

`ADMISSION_PHASE` records contain fixed fixture phase names and monotonic times,
not prompts, account tokens or paths. Timings are off by default. HTTP preparation
includes event-loop interleaving with automatic execution, and the replay
aggregate contains its named child phases; do not add nested durations twice or
treat these numbers as provider latency. Compare the same test under controlled
host load before attributing a timeout or speedup to a particular change.

Committed-objective checks and replay derive their public plan from a freshly
verified bundle report. They do not reuse a previous request's filesystem
evidence. The reader's before/after captures and the registration writer's final
publication checks remain required, including when observations change during
the call. Missing receipts and changed inputs are refused, not reconstructed.

### Check engineering configuration without starting the fleet

From a built source checkout, inspect the exact private files intended for console
startup. Prepare the experiments, campaigns, delivery plan and catalogs described
above first; this command does not discover or create them.

```sh
node bin/ashlr resources pool engineering check \
  --root /absolute/private/shared-resource-ledger \
  --pool /absolute/private/pool.json \
  --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json \
  --workspace /absolute/projects/ashlr-hub \
  --projects /absolute/private/projects.json \
  --engineering /absolute/private/engineering-catalog.json \
  --json
```

Include the same `--quota-config /absolute/private/quota.json` when the console
uses a shared collector. The configuration is inspected, never refreshed. Omit
`--json` for a human summary of stages, enrollment identities, worker policies,
exclusions and recheck hints. Paths must be canonical, absolute and non-root;
the command accepts neither execution flags nor implicit default configuration.

| Result | Meaning and next step |
| --- | --- |
| `configured` / exit 0 | At least one enrollment has valid local configuration and no reported enrollment hold. Review all rows and worker exclusions before starting the console. This is not live admission or authenticated capacity. |
| `held` / exit 1 | No enrollment is currently actionable under these local checks. Review fixed reasons; KILL, paused policies and ownership remain unchanged. |
| `unavailable` / exit 1 | A required input or strict history check failed. Repair the identified configuration through its normal owner, preserving the existing ledger and project attribution, then recheck. |
| Invalid arguments / exit 2 | Correct the explicit paths and supported options; no inspection was started. |

Reports bind each enrollment to its digest and project ID. `would-register` means
that project is only proposed; `persisted` means its historical binding already
exists. Disabled or replaced directories remain held rather than being silently
rebound. The check validates complete schema 1–4 supervisor history, shared pool
history, resource runtime and project/campaign/delivery linkage. Captured
configuration is reread to detect drift during inspection. Missing stores remain
missing; drift never causes a new empty ledger to replace existing accounting.

The report declares `scope: "local-commissioning-check-only"`,
`admission: "not-attested"`, `effectsExecuted: false` and
`providerContacted: false`. It starts no supervisor, listener, collector, provider
or evaluator; creates no keys, storage or locks; performs no ownership recovery
and changes no usage policy. Runtime inspection issues three bounded read-only
Git queries in the explicit transport workspace. It is not a native login probe.
Worker eligibility is an observation, not a reservation: stale quota, temporary
capacity and exhausted windows remain visible without converting them into new
permanent execution holds. Existing graph/launch/controller history requires
inspection in the owned console; this command never reconciles or replays it.
Successful launch, evaluation, delivery and production acceptance remain separate.

### Retained task transcripts

On execution-enabled consoles, select **Retain this task locally** before sending
to keep its exact submitted prompt (including attachment text), copied conversation
context when following up, and captured response
in the private local supervisor store. This is opt-in per task; legacy requests
with no `retainHistory` flag, or `false`, retain their existing ephemeral behavior.
Text is not encrypted by Ashlrverse. Only retain information appropriate for this
computer and its backups.

Select the task and choose **Read transcript** to inspect retained text after a
browser or console restart. The authenticated read is on demand, never included in
fleet polling snapshots. A response is captured only from a fresh completed result
whose receipt matches the ledger. Terminal state and captured text are published
together. If a crash leaves a completed receipt without captured output, the UI
reports no response; it never reruns work to reconstruct one.

Captured output is limited to a UTF-8-safe 64 KiB prefix with explicit truncation.
Admission reserves worst-case JSON-escaped output space for all pending retained
tasks within the existing 4 MiB supervisor state limit. Capacity refusal happens
before dispatch. Deleting retained text frees text capacity, **not** the existing
256-job identity limit; task tombstones and quota accounting remain intact.

For a settled or cancelled task, unlock controls and choose **Delete transcript**,
then confirm. This removes this transcript, its copied context and console-session output, not task
records, provider history, backups, crash-left temporary copies or recoverable disk
blocks. It is not secure disk erasure and cannot be undone through this console.
Queued, dispatching and unresolved tasks cannot have their transcript deleted.
Deletion and identical retries preserve the original retention choice and never
restore deleted text or create a new usage allowance.
Already accepted follow-ups have independent copies of their context. Deleting
the source transcript does not delete those copies or cancel accepted work;
delete each retained descendant separately when needed.

API: `POST /api/resources/tasks` accepts optional boolean `retainHistory`;
`GET /api/resources/tasks/:id/history` requires read authority;
`POST /api/resources/tasks/:id/history/delete` requires control authority and `{}`.
Only the fixed-workspace execution console exposes this capability. Starting a
supervisor simply to read history is not supported: it can resume queued work.
The first opted-in task upgrades supervisor state to schema 2; the first follow-up
upgrades it to schema 3, without changing legacy task rows or resource-ledger
digests. Older binaries cannot read these newer schemas;
do not downgrade against that live state or clear it to bypass incompatibility.

### Follow-up conversations

On a console advertising `followUpSupported`, read a retained transcript for a
settled or cancelled task, then choose **Follow up from this task**. The composer
shows the parent identity and number of prior turns. Choose the enrolled worker,
workspace access and limits for the new task, then send it explicitly. Selecting
another task for inspection does not retarget that draft. **Start standalone** or
**New task** explicitly removes the parent. No previous worker, edit permission
or retention choice is inherited.

The browser submits only the new request and an explicit content pin:

```json
"parent": {
  "taskId": "earlier-task",
  "expectedTranscriptDigest": "<64-character digest returned by the history read>"
}
```

The server validates the pin, copies the flat prior conversation and appends the
new request in a versioned prompt envelope. It never nests previously assembled
prompts or trusts browser-supplied history. Missing responses and truncation remain
explicit evidence, not fabricated answers. Each child has its own task ID and
normal admission through the **same account ledger**. Branching from one parent
is supported; identical retries return the accepted task before looking up the
parent again, including after parent deletion or restart.

The new request (including attachments) remains limited to 32 KiB. The complete
serialized provider prompt is limited to 256 KiB; overflow is refused before
admission, without silent truncation or summarization. The existing 4 MiB state
limit also applies. These are byte limits, not model token-capacity estimates.
Pending tasks keep frozen context across restarts. Without retention consent,
copies are discarded at terminal settlement; retained children keep copies until
explicit deletion. A new follow-up cannot read a deleted parent, but an already
accepted child does not depend on that parent's remaining text.

This is server-supplied multi-turn context, not native provider-session resumption.
Native invocations remain ephemeral. Long-conversation compaction and live token
streaming are not implemented.
Live output comes from the producing console session; opted-in transcripts can
survive it. Neither is a token stream. A
completed task does not establish independent acceptance of its changes.

### Multiple registered projects, one account ledger

An execution console can register additional projects through `--projects` while
keeping `--workspace` as its explicit default. Use the existing resource root,
pool, bindings and observations; **do not create another account ledger per
project**. This remains one supervisor, queue and metadata collector.

The optional private catalog is a JSON file outside all writable workspaces:

```json
{
  "schemaVersion": 1,
  "projects": [
    { "id": "cortex", "label": "Ashlr Cortex", "workspace": "/projects/ashlr-cortex" }
  ]
}
```

Catalog IDs are stable, unique lowercase identifiers. `default` is reserved for
`--workspace`; do not list it again. Up to 31 additional projects are supported.
Labels are trimmed plain text, limited to 128 UTF-8 bytes. Paths must be explicit,
canonical directories. The private catalog is owner-only, a regular single-link
file, and bounded to 256 KiB. Registration neither creates directories nor repairs
permissions. Duplicate roots and control-store overlap are refused. Explicit
nested projects are allowed; working-directory selection is **not a filesystem
sandbox** or a claim that a native worker cannot access another repository.

After enrolling the exact directories you intend to permit, an execution-enabled
startup uses the existing command with an additional option:

```sh
ashlr resources pool console \
  --root /private/resource-store \
  --pool /private/resource-config/pool.json \
  --bindings /private/resource-config/bindings.json \
  --observations /private/resource-config/observations.json \
  --execute --workspace /projects/ashlr-hub \
  --projects /private/resource-config/projects.json
```

This command can resume queued work and invoke enrolled workers; it is not a
read-only inspection command. Configure account access, quotas and the intended
working directories before starting. The browser receives registered IDs and
paths, but sends only `projectId`; it cannot enroll an arbitrary path. The default
selection and an omitted `projectId` normalize identically for legacy retries.
Cross-project follow-ups are refused. Account task caps, concurrency, pauses and
quota observations remain shared across all projects.

The left rail switches projects. Drafts, attachment text, worker choices and
follow-up pins stay separate for visited projects in current browser memory;
reload/disconnect discards unsent drafts. Prior project reads are cancelled when
switching. Receipts without a proven supervisor project binding remain in
Resources instead of being guessed into a project's task list.

The first explicit catalog adoption atomically upgrades supervisor state to
schema 4. Existing schemas 1–3 keep their task, receipt and conversation digests.
The legacy default pathname is preserved; its current directory identity is
adopted at migration, not asserted retrospectively. Subsequent bindings pin the
canonical path and directory device/inode, not modification times or Git HEAD.
Ordinary source edits therefore remain valid. Older binaries cannot read schema
4; do not downgrade against the upgraded store or erase it to bypass validation.

Adding a new ID is supported. Reordering or relabeling does not change identity.
Omitting a previously registered project disables new work without deleting its
history or binding. Its queued work remains held; independent projects continue.
Restart without `--projects` disables additional projects while preserving the
default and historical records. Exact retries remain idempotent. Re-enabling the
same ID and path requires the original pinned directory identity; rebinding an
old ID to another path is refused. The registry's 32-identity capacity is not reset
by omission. Automated rebinding and registry compaction are not implemented.

Missing, replaced or symlinked registered directories hold affected work. Identity
is rechecked before admission, under the ledger lock and before worker invocation.
If the final check fails after reservation, the attempt records failure without
calling the worker; the task allowance stays consumed and no provider usage is
invented. This project-local failure does not establish a provider outage. These
checks reduce replacement races; string-based process working directories do not
eliminate every time-of-check/time-of-use race or provide confinement.

### Browse project files and attach a snapshot

Catalog-enabled execution consoles expose a **Files** tab in the workspace
inspector. Select a registered project, unlock controls, and choose **Browse
files**. A read-session link alone cannot inspect source files. The same control
authority used for task actions authorizes these explicit file reads; merely
unlocking or opening the tab does not read a directory or invoke a model.

Open a directory or enter a project-relative directory, then select a file to
preview. The server reads regular UTF-8 text up to 64 KiB, marks partial previews,
and returns a SHA-256 digest of the **returned bytes**, not any omitted suffix.
Directories are inspected one level at a time, with a 256-entry scan limit;
oversized listings fail explicitly rather than masquerading as complete. No
recursive indexing or background filesystem scan occurs.

**Attach viewed snapshot** copies the preview into the current project's draft.
It does not reread the file on send. Its relative path, project ID and snapshot
digest accompany the copied reference text. Files changed after preview do not
silently replace the attachment. Attachments remain bounded at four files and
16 KiB each, within the complete 32 KiB request limit. Partial/oversized previews
cannot be attached; duplicate basenames must be resolved by removing the existing
attachment first. Common extensionless repository files such as `Dockerfile`,
`Makefile`, `LICENSE`, and the allowed metadata files can also be attached. Other
unsupported filenames can be previewed but not attached. Sending, provider admission and optional transcript retention remain
separate actions with the existing accounting and plaintext-retention behavior.

Reads require a currently enabled, pinned project binding and console ownership.
All relative directory components and file identities are checked before/after
reading. Symlinks, hardlinks, special files, unsafe permissions, known credential
paths and dependency/build directories are refused. Hidden paths are excluded
except ordinary repository metadata: `.github`, `.gitignore`, `.gitattributes`
and `.editorconfig`. These checks are not comprehensive secret detection or an
OS-enforced filesystem sandbox. Review previews before sending their content to a
provider; ordinary source files can also contain secrets.

Preview text and listing state stay out of polling snapshots and browser storage.
Switching projects, hiding the workspace/file panel, losing control access or
changing console sessions clears previews and cancels in-flight reads. Explicitly
attached draft copies remain separate from preview state and retain the existing
session-only draft lifecycle. File browsing itself changes no task/ledger state.

The API uses control-token-authenticated POST requests with a matching Origin:
`/api/resources/projects/:id/files/list` and `/api/resources/projects/:id/files/read`,
each with exactly `{ "path": "relative/path" }` (empty path lists the root).
Paths stay out of request URLs; responses are `no-store`. No filesystem write,
delete, rename, terminal command or browser navigation API is introduced.

The next operating-layer milestones are conversation grouping and compaction,
owned PTY sessions, and an isolated browser bridge. The existing Tauri wrapper
remains a source-only draft; this web surface is not a commissioned installer.

## Resource semantics

| Resource | Source | Admission behavior |
| --- | --- | --- |
| Provider windows | Explicit native quota observations | Every known window applies; missing is unknown, not zero |
| Operator task cap | Private durable reservation ledger | All admitted tasks count, including failure and cancellation |
| Concurrent slots | Unfinished reservations in the same ledger | Workers with the same `capacityKey` share slots and task caps |
| Local-model readiness | Fresh explicit health observation | Readiness is required; no cloud fallback or model download |

Workers are ranked by declared priority, then lowest normalized quota/task/slot
pressure, then stable ID. Priority is not a measured model-quality score. This
increment records usage but does **not** claim to optimize verified engineering
yield automatically. A completed worker result always has `verifiedAccepted:false`.

Use one shared ledger root for all workers representing the same resource pool.
Limits are per ledger, not machine-global provider limits. `capacityKey` is an
operator-declared identity: Hub does not inspect credentials to establish whether
two profiles actually represent the same account. All aliases of one account must
use the same key. Shared groups must have identical concurrency/task bounds.
Account-health, transport, retry and operator-pause denials block the entire
group. Quota denials also remain account-wide unless exact model quota scopes
have been explicitly enrolled as described below.

### Independent Codex quota scopes

Optional `quotaScope` on a pool worker pins a versioned quota association. It is
not model discovery, an entitlement claim, or a new concurrency identity:

| Exact model | Worker `quotaScope` | Collector `bucketIds` |
| --- | --- | --- |
| `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | `codex-general-v1` | `["codex"]` |
| `gpt-5.3-codex-spark` | `codex-spark-v1` | `["codex_bengalfox"]` |

General and Spark workers for one account must retain the **same `capacityKey`**,
account-hint match, concurrency bound and rolling task cap. Separate bucket IDs
are accepted only for explicitly supported provider/model/scope combinations.
Unknown models and unscoped aliases retain conservative sharing. Claude and local
workers remain supported by their existing adapters; no Claude quota association
is inferred from a display name such as Fable, Opus or Sonnet.

When enrolled, General exhaustion or stale General quota does not consume Spark's
independent headroom. Spark exhaustion, missing evidence or unknown percentages
cannot borrow General headroom. Account authentication failures, explicit pauses,
retry/cooldown and uncertain process ownership still apply across both. Existing
operator-capped unknown-quota opt-in is unchanged; adding a scope does not enable it.

The collector, shared evidence, capacity wait, locked admission, queue and console
carry quota-only vetoes separately from account vetoes. The host API's optional
`quotaUnavailableWorkerIds` denotes a quota-only veto; `unavailableWorkerIds`
retains its account-wide meaning. Callers of a scoped collector must forward
both. A valid percentage remains a provider observation, not an inferred token
price or a benchmark score. No paid overage or automatic credit reset is enabled.

Scope mappings are source-supported associations, not proof a specific account
can execute a model. Confirm availability and both current quota windows using
the enrolled account's native evidence before an authenticated canary. OpenAI
describes Spark as a fast, text-only coding model; that is not evidence that it
is interchangeable with Sonnet or a local Qwen model. See the
[official model documentation](https://learn.chatgpt.com/docs/models).

**Upgrade existing pools explicitly.** Pool/binding digests pin historical
receipts. Use the [offline evolution command](#upgrade-a-pool-without-resetting-history)
instead of editing active enrollment or selecting an empty ledger. A saved
account pause still blocks Spark aliases after an upgrade. The separate
[quota reservation controls](#reserve-general-or-spark-independently) can reserve
one account's General scope while permitting its Spark scope under the other
admission checks; task-level `allowedWorkerIds` is not a durable reserve.

### Prepare a Spark alias from existing General configuration

Use this offline helper when one supported General Codex worker represents an
account and you want to propose its separate Spark allowance. It copies the
existing account binding, capacity key, limits and reserve, annotates General,
and constructs the matching quota configuration. Other accounts are unchanged.
The helper refuses preexisting aliases that need a separately reviewed evolution.

From a current built checkout, with existing private pool, bindings and quota
configuration files and a private `0700` parent directory:

```sh
node bin/ashlr resources pool spark prepare \
  --pool /absolute/private/pool-before.json \
  --bindings /absolute/private/bindings-before.json \
  --quota-config /absolute/private/quota-before.json \
  --general-worker personal --spark-worker personal-spark \
  --output /absolute/private/new-spark-proposal --json
```

This **creates a new private proposal directory**, not an enrolled account. The
output path must not exist, even as an empty directory. It contains `pool.json`,
`bindings.json`, `quota-config.json`, `general-reservation.json`, an intent and a
manifest with exact output-byte hashes. The manifest's input digest identifies
the captured JSON values, not the input files' whitespace. Files contain existing
launcher configuration/account hints: keep them private and out of source control.
The CLI reports paths, digests and fixed status fields, not launcher/hint contents.

Use the proposed pool and bindings in the [existing migration procedure](#upgrade-a-pool-without-resetting-history).
That separate check still validates the actual ledger, owners and retained work.
Keep the account paused through migration, then merge the **single proposed
General exclusion** with the existing [quota-scope policy](#reserve-general-or-spark-independently)
using its fresh revision. Do not replace other exclusions with this descriptor.
Only after that reservation is verified should account unpausing be considered.
Existing account pauses and allocation ceilings are untouched by preparation.

Preparation supplies no quota observations, account authentication, engineering
runtime pins or service activation. Fresh exact-scope quota and all other
admission checks still apply. On failure, preserve any incomplete output for
inspection; a manifest alone is not proof that the command succeeded. After
resolving the cause, use a new output path. This command never resumes or
overwrites an existing proposal and never deletes migration or collector records.

### Upgrade a pool without resetting history

`ashlr resources pool evolve` adds workers or supported quota annotations while
preserving the shared ledger. It does not connect an account or refresh quota.
Use a current built checkout: older binaries reject the upgraded ledger schema.
Keep the original pool and binding documents alongside the reviewed next versions;
the command reads but never rewrites those input files.

Supported evolution is additive. Existing worker IDs, model/provider, transport
bindings, policy and capacity keys cannot be removed or remapped. An unscoped
worker may receive its supported exact quota annotation. A new alias of an
existing account must use the same launcher/endpoint, capacity key, concurrency
and rolling task limits, without weakening its reserve or unknown-quota policy.
Reusing a known launcher under a new capacity key is refused. An operator still
owns the truth of a genuinely new account binding; arbitrary wrappers are not
independent proof of account identity.

1. Stop the console and quota collector and settle reserved/uncertain work.
   Existing ownership or ambiguous collector markers must be inspected, not
   deleted to force an upgrade. Keep KILL and account policy as configured.
2. Inspect the exact existing store and proposed configuration without writes:

   ```sh
   node bin/ashlr resources pool evolve check \
     --root /absolute/private/shared-ledger \
     --workspace /absolute/projects/ashlr-hub \
     --pool /absolute/private/pool-before.json \
     --bindings /absolute/private/bindings-before.json \
     --next-pool /absolute/private/pool-next.json \
     --next-bindings /absolute/private/bindings-next.json --json
   ```

   Review the plan digest, added/annotated workers, preserved receipt/job counts
   and `heldQueuedIds`. `--workspace` is the existing console's default workspace.
   Queued tasks keep their original routing; they remain held for explicit
   cancellation and re-enrollment, never automatically gain new workers.
3. **Apply the local store migration** with the same arguments, replacing
   `check` with `apply` and adding `--expected-plan-digest` with that exact digest.
   This acquires local ownership, writes private pool snapshots and non-content
   console identity proofs, installs an admission barrier, upgrades console
   origin metadata, then publishes the
   active ledger. It does not launch tasks, change input configs or reset policy.
4. Start the console explicitly with the reviewed next pool/bindings and matching
   collector configuration. Prior receipts retain their old pool digest and
   transcript hashes remain stable. New conversations use the active epoch;
   new follow-ups can reference retained old transcripts. Deleted text stays
   deleted. Whole-ledger metrics include verified old and new epochs, without
   turning unmatched tasks into a model-quality benchmark.

Allocation ceilings/revisions, account-wide pauses and capacity task counts
survive. Adding Spark alone therefore does not bypass a personal account pause.
When a quota annotation changes, the old combined reading is retained in the
private migration snapshot; its active windows are invalidated and availability
is withheld until fresh exact-scope evidence arrives. This is evidence
invalidation, not a new provider failure observation. Capture times and retry
denials are not renewed or erased. New workers receive no invented observation;
old shared collector evidence cannot certify the new pool/configuration.

Once published, an interrupted upgrade's admission barrier keeps work blocked. Inspect its private
`pool-evolution/` journal and rerun **the same apply inputs and original digest**
to resume an exactly staged transition. Unrecognized, partial or changed state
is refused, not automatically repaired. Partial staging before barrier publication
leaves the old ledger intact but still requires inspection. Do not delete journals, rewrite old
receipts, downgrade the binary or use an empty ledger as recovery. Exact completed
replay is read-only and must not overwrite later work, deletion or cancellation.
The ledger supports at most 16 configuration epochs within its existing byte
and task-identity bounds; this is not automatic archival or compaction.

The journal does not archive conversation text. Console recovery uses hashes and
immutable job identities. Explicit resume can remove only its exact, complete,
private temporary console file; partial, changed or multiply linked files remain
held for inspection. This is not a secure-erasure guarantee for operating-system
backups or other copies outside this store.

CLI JSON failures expose bounded hold codes when known: `ownership-present`,
`uncertain-work`, `incomplete-journal` or `state-conflict`. Other failures are
reported generically without exposing private input or filesystem contents.
None of these codes authorizes deleting ownership or history records.

Existing Universe runtime, campaign, graph and engineering-enrollment pins remain
unchanged. Prepare/review new work against the next configuration; an upgrade
does not silently migrate or authorize old engineering campaigns.

## Enroll explicit workers

Store input JSON as owned regular files with mode `0600`. Use canonical absolute
paths without symlinks. Keep the private ledger outside writable task workspaces.
Its parent must exist; `run` creates only its selected `0700` root, while `status`
never creates storage. Runtime persistence is currently POSIX-only.

The pool file contains policy, not secrets. This example uses conservative
operator bounds, not provider-advertised allowances:

```json
{
  "schemaVersion": 1,
  "id": "engineering",
  "workers": [
    {
      "id": "codex-a",
      "provider": "codex",
      "model": "your-supported-codex-model",
      "maxConcurrent": 1,
      "reservePercent": 15,
      "maxTasksPerWindow": 6,
      "taskWindowMs": 3600000,
      "priority": 50
    },
    {
      "id": "local-a",
      "provider": "local",
      "model": "your-loaded-local-model",
      "maxConcurrent": 1,
      "reservePercent": 0,
      "maxTasksPerWindow": 20,
      "taskWindowMs": 3600000,
      "priority": 40
    }
  ]
}
```

The separate bindings file must cover every worker exactly once:

```json
[
  {
    "workerId": "codex-a",
    "capacityKey": "account-a",
    "kind": "native-cli",
    "command": ["/absolute/owner-managed/codex-a"]
  },
  {
    "workerId": "local-a",
    "capacityKey": "local-compute",
    "kind": "local-chat",
    "endpoint": "http://127.0.0.1:11434/v1"
  }
]
```

A native command is an absolute executable or a trusted owner-managed wrapper
prefix. It must forward appended native CLI arguments and stdin unchanged, and
must already select its intended account through the vendor's supported
authentication. The runner does not create wrappers, log in, copy OAuth tokens, switch
accounts, scrape keychains/transcripts, consume reset credits, or alter billing.
Direct native executables use their existing default authentication. Do not map
the same default account to multiple independent capacity keys.

Bindings are trusted local code, not model-generated input or a security sandbox.
Hub passes a small environment containing existing system paths/locale/home,
without ambient API keys, account-switching variables, proxy variables, or Node
loader overrides. A wrapper or cached native profile can still select paid
billing; confirm its account, model eligibility, and overage settings before use.

### Commission native accounts and local capacity

#### Prepare isolated native profiles

`ashlr resources profile prepare` creates a new owner-private profile; it does
not sign in or enroll capacity. Choose an existing mode-`0700` parent outside
repositories, task workspaces and version control. Select the canonical regular
executable behind the vendor's installation symlink, without updating it.

```sh
ashlr resources profile prepare --provider codex \
  --directory /absolute/private/profiles/codex-a \
  --executable /absolute/canonical/codex-executable --json
```

Repeat with a **different new directory** for `codex-b`. For an isolated Claude
login, use `--provider claude` and its canonical native executable; Grok uses
`--provider grok` with a separate private `GROK_HOME`. This writes
`launcher.mjs`, `command.json` and a preparation-only `profile.json` as mode
`0600`, plus empty private state directories. Existing targets are never reused,
repaired or overwritten. A partial failure retains its leaf for inspection;
never delete it automatically because a later login may have added credentials.

The standalone launcher pins the selected native and Node executable paths and
checks its original private directory identities. It uses `process.execve` to
preserve PID, process group and stdio. A Node runtime supporting that API and a
supported POSIX system are required; relocating/replacing state directories or
removing the pinned runtime can invalidate the launcher. A native OS-level exec
failure is still a process failure, not a guarantee of a redacted exception.

Codex gets its own `CODEX_HOME` with explicit file credential storage and ChatGPT
login selection. Forwarded config overrides permit simple unquoted bare/dotted
keys only; the two selected authentication keys cannot be overridden through
normal launcher arguments. Claude gets separate `CLAUDE_CONFIG_DIR` and
`ANTHROPIC_CONFIG_DIR` directories and disabled native updates. This avoids
reusing the default Anthropic profile directory as a fallback. [Codex native
authentication](https://learn.chatgpt.com/docs/auth), [Anthropic profile resolution](https://platform.claude.com/docs/en/manage-claude/wif-reference#configuration-directory).

The native child receives only existing PATH/HOME/TMPDIR/LANG/LC_ALL plus the
fixed profile selectors. HOME is unchanged. This is owner-managed launcher code,
not a sandbox, account-independence proof or billing attestation. In particular,
Node startup happens before the launcher sanitizes the native child's environment;
run manual commands from a trusted shell. Hub dispatch already strips loader
overrides before starting the wrapper.

The returned `loginCommand` is the **separate interactive native sign-in** to run
when ready. Codex uses `login`; Claude uses `auth login --claudeai`; Grok uses
`--no-auto-update login --oauth`. Finish the
vendor's browser flow with the intended account, then verify account/billing and
quota before enrollment. `authentication:not-checked` in the preparation manifest
never changes into a live login-status claim. Use its `command.json` with
`resources launcher check`, and the contained argv as the pool binding's `command`.
No credential is read or copied, and preparation requests no model inference.

#### Verify identity and capacity

Authentication is an operator step outside the runner. Adding a worker to JSON
does not authenticate it or establish its quota. Keep native account directories
and launcher files outside task-writable workspaces.
Switching accounts in a desktop app is not simultaneous CLI enrollment. To run
two Codex subscriptions concurrently, complete the native sign-in separately for
each selected state directory; never copy the first account's credentials to
create the second worker.

1. Select a supported, version-pinned native executable. For two Codex accounts,
   use separate owner-managed launchers and native state directories. `CODEX_HOME`
   selects Codex's state location; `--profile` only selects configuration and is
   **not** evidence of a separate account. Verify the active account and storage
   mode through each exact launcher using native login/status before enrollment;
   do not duplicate credential files. [Codex state and profiles](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations),
   [native authentication](https://learn.chatgpt.com/docs/auth).
2. For Claude Code, select a dedicated `CLAUDE_CONFIG_DIR` in the owner-managed
   launcher and authenticate with the native flow. That directory also scopes
   its macOS Keychain entry. Confirm the account and billing source in the native
   client: cached API profiles or an API key selected by a wrapper can supersede
   subscription login. Hub deliberately does not inherit ambient account-selector
   variables. [Claude authentication and precedence](https://code.claude.com/docs/en/authentication).
3. Enroll each verified identity separately, for example `codex-a`, `codex-b`,
   and `claude-a`. Give aliases of the **same** account one `capacityKey`; different
   worker names, models, or launcher paths do not establish separate allowances.
   Start with one concurrent task per account and explicit task limits. Capture
   quota evidence before dispatch, or deliberately select bounded unknown-quota
   bootstrap. Never rotate identities to evade an account's known denial.
4. For local calibration, an existing `qwen3-coder:30b` Q4_K_M installation is a
   useful starting candidate with `maxConcurrent:1`, not a hardwired best model.
   Pin the installed model digest and measure its results on the same tasks as
   the native workers before expanding concurrency. Use only the explicitly
   selected, already-running loopback endpoint. Hub neither downloads the model
   nor starts its server, and local-chat cannot use native workspace file tools.

Test the exact launcher first with a small explicit task in an expendable
workspace, then inspect its result, resource observation, and diff before using
the queue. This dispatch consumes the selected provider's allowance; a healthy
local fixture is not evidence that native credentials or plan entitlements work.

### Check launcher capabilities before dispatch

Run this against the exact operator-trusted launcher you intend to enroll. The
mode-`0600` command file contains its argv array, for example
`["/absolute/owner-managed/codex-a"]`; it contains no credentials. The working
directory must already be owned, mode `0700`, canonical, and outside candidates.

```sh
ashlr resources launcher check --provider codex \
  --command /absolute/private/codex-a-command.json \
  --cwd /absolute/private/launcher-check --json
```

Repeat with each distinct launcher and `--provider claude` for Claude Code.
This command requests only native help/version output through the trusted prefix,
under one bounded deadline (default 10 seconds, `--timeout-ms` up to 30 seconds).
Native startup and wrappers can still maintain their own configuration/cache;
the command does not request login, authentication status, quota, inference,
reset credits or paid fallback. It writes no Hub enrollment or ledger.

Exit zero and `status:supported` mean required flags were **advertised**, not that
the full argument combination or a model works. Missing flags, known unsupported
Claude versions, failures, output limits and uncertain cleanup have fixed reason
codes. Unknown version formats remain `null`; they are not minimum-version proof.
Reports omit raw native output, commands, paths and account identifiers. Finish
commissioning with native identity/billing verification, quota evidence and an
explicit allowance-consuming canary as described above.

### Grok Build integration status

`--provider grok` checks native `agent stdio` help with auto-updates disabled.
Even when advertised upstream support is found, it returns exit one with
`hubTransport:not-implemented`. Grok is not currently an enrollable pool provider.

Grok Build documents headless and ACP interfaces and a separate `GROK_HOME` for
native state. Subscription entitlement and the selected billing route still need
account-specific verification. A Hub adapter must establish configuration/tool
isolation, cached-auth behavior, terminal and usage semantics, and cancellation;
top-level flags alone do not prove ACP enforcement. Do not substitute a Claude
binding or silently introduce an API key. [Native integration](https://docs.x.ai/build/cli/headless-scripting),
[native settings](https://docs.x.ai/build/settings/reference).

## Supply quota observations

### Probe an enrolled Codex launcher without generating work

After authenticating and enrolling the exact launcher, capture a private report:

```sh
ashlr resources pool probe --pool /absolute/private/pool.json \
  --bindings /absolute/private/bindings.json --worker codex-a --bucket codex \
  --output /absolute/private/new-codex-a-probe.json --json
```

This explicitly contacts the launcher's native App Server for account metadata and
quota windows. It creates no thread, turn, or model request and does not select a
different account. Native authentication/cache maintenance can still occur. The
fixed helper runs in private scratch, not the task project; native global
configuration remains native-managed. Trusted wrapper prefixes must forward
`app-server --stdio` and appended configuration arguments.

The private report contains `poolDigest`, an opaque `accountHint`, `planType`, and
a normalized `observation`, never raw account email, credential material or native
diagnostics. Account metadata is checked before and after quota capture. The
hint hashes reported account type/email/plan; the native endpoint supplies no
stable workspace/account identifier. It is **not proof of independent capacity**.
Use `--expected-account-hint` to pin a previously checked hint. Null/API-key
identity, drift, malformed protocol or an unsupported launcher produce no usable
observation. A successfully observed report can still contain unknown or exhausted
quota; exit zero means metadata was observed, not that work is admissible.

The report path must be new and is reserved with mode `0600` before native
contact. Failed preflight can leave an empty report file. The command writes no
pool ledger or enrollment and never resets quota. Its timeout is 10 seconds by
default, configurable with `--timeout-ms` from 1 to 30,000. Cancellation awaits
owned process cleanup; an uncertain result requires reconciliation before retry.

### Import explicitly captured evidence

The observations file is an array. A complete observation contains `workerId`,
canonical ISO `observedAt` and `expiresAt`, `health` (`ready` or `unavailable`),
`windows`, and `retryAfter` (ISO or null). Each window has `id`, `usedPercent`
(0–100 or null), and `resetsAt` (ISO or null). Optional `updatedAt` identifies the
latest capture while an older `observedAt` retains the age of untouched windows.
No observation may declare more than five minutes of freshness.

Normalize an owner-supplied decoded Codex `account/rateLimits/read` result:

```sh
ashlr resources pool observe --pool /absolute/private/pool.json \
  --worker codex-a --provider codex --input /absolute/private/native-limits.json \
  --captured-at 2026-09-07T12:00:00.000Z --bucket codex --json
```

The timestamp above is illustrative: supply the actual capture time. This command
does not query the provider or refresh old evidence. It emits a normalized array
with a 60-second freshness ceiling measured from that capture. Codex requires
1–4 explicit bucket IDs; its multi-bucket response takes precedence over the
legacy single bucket. Both primary and secondary windows remain separate.

For Claude, use `--provider claude` and a decoded native `rate_limit_event` with
nested `rate_limit_info`; omit `--bucket`. `--previous /absolute/private/observations.json`
retains other workers and previously known windows. Buffered events from an
executed Claude worker also enter the durable ledger. Their freshness starts at
dispatch, not at delayed output parsing, so long-running buffered evidence may
already be stale. Safe unknown future bucket names are retained; a new rejected
bucket is not ignored just because Hub has not seen its model name before.

Reset time is a recheck hint, never evidence of restored capacity. Omitted,
unknown, expired, and mixed-age updates cannot clear a known denial. Recovery
requires newer fresh evidence for the exact window with a known percentage and
future reset. A fresh single-window export without `--previous` can update that
window; the ledger retains others. `status` merges evidence for display only;
`run` persists admitted observations even when no task can be placed.

Default behavior refuses unknown subscription quota. Setting an individual
worker's optional `allowUnknownQuota:true` explicitly permits bounded bootstrap
under its operator task/concurrency caps. It never bypasses known exhaustion,
unavailable health, future-dated evidence, or provider backoff. This mode is not
a guarantee that a provider will accept the task or that overage is disabled.

## Run one task

An explicit task file:

```json
{
  "schemaVersion": 1,
  "id": "architecture-review-001",
  "allowedWorkerIds": ["codex-a", "local-a"],
  "prompt": "Explain the tradeoffs in the supplied design. Do not modify files.",
  "cwd": "/absolute/project",
  "timeoutMs": 120000,
  "maxOutputTokens": 2048,
  "mode": "read-only"
}
```

Choose allowed workers with compatible capabilities. Local-chat receives only
the explicit prompt and returns text; it does not read or edit `cwd`. Codex uses
its native read-only/workspace-write sandbox selection. Claude read-only mode
disables built-in tools; explicit workspace-write enables restricted file tools,
not shell/code/network tools. Neither task mode grants independent evaluator,
merge, deployment, or service authority. Native tools may retain managed policy
behavior: this adapter is not a separate OS confinement implementation.

Inspect without dispatch:

```sh
ashlr resources pool status --root /absolute/private/ledger \
  --pool /absolute/private/pool.json --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json --json
```

The following command **executes the selected worker**, consumes its resource
allowance, and may edit the explicit workspace when `mode` is `workspace-write`.
Use an expendable checkout or worktree for editing and verify its diff/tests:

```sh
ashlr resources pool run --root /absolute/private/ledger \
  --pool /absolute/private/pool.json --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json --task /absolute/private/task.json \
  --output /absolute/private/new-result.txt --json
```

The output path must not exist. It is reserved with mode `0600` before contact;
failed/refused runs can leave an empty file, identified in result metadata. Raw
worker text is never printed or stored in the ledger. Omit `--output` to discard
it after recording its digest. Replaying a completed task returns only its
receipt, not discarded text; requesting a new output file on replay fails rather
than rerunning the worker. Task IDs cannot be reused with changed content.

Concurrent invocations share atomic admission under a short store lock. The lock
does not span model execution. Each native task may make multiple vendor requests:
`maxTasksPerWindow` is **not** an inference-request cap. Local-chat sends a bounded
single request with `max_tokens`; native `maxOutputTokens` is only an observed
post-completion cutoff. Missing token counts remain null. No dollar-cost estimate
or unused-subscription-token estimate is invented.

### Interpret reported usage

New execution evidence labels known paired token counters with `usageScope`:

| Scope | What the existing counters measure |
| --- | --- |
| `codex-turn` | Native completed-turn input and output usage |
| `claude-main-loop` | Final result's main-loop input, cache-read and cache-creation input, and output usage |
| `local-chat-completion` | The selected local endpoint's single completion usage |

Claude's `modelUsage` has a broader query-pipeline scope, including subagents and
other work; Hub does not substitute it for the existing main-loop counters or
sum it with them. These counters do not establish billing or total account usage.
Older receipts without execution scope remain unclassified; missing or malformed
usage remains null. [Claude result accounting](https://code.claude.com/docs/en/agent-sdk/python#resultmessage).

Claude `subtype:success` alone is insufficient: `is_error:true`, aborted/error
terminal metadata, or deferred tools cannot establish completion. Duplicate
results, conversation resets, and explicitly nonhuman result origins do not
establish attributable usage for this one-prompt adapter. Safe terminal counts
can still be recorded for a failed attempt; reported usage is not acceptance.

## Operate the resource console

Start with an authenticated, read-only view of the explicit pool:

```sh
ashlr resources pool console --root /absolute/private/ledger \
  --pool /absolute/private/pool.json --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json
```

Open the printed `/resources/` URL and enter the printed read token. The server
binds only to `127.0.0.1`, uses an instance-specific read session, and never places
tokens in URLs. Without either metadata option, read-only mode does not create a
missing ledger at startup or launch workers. Saving an allocation can create its
private ledger state even when task execution is disabled.
The pool and bindings are fixed at startup; only the selected observations file
is reread. Reloading the dashboard does not refresh the age of quota evidence.

The capacity board groups worker aliases by account/resource key. It shows all
reported quota windows, exclusion reasons, occupied slots, and the next eligible
worker under current policy. That routing preview is not a promised assignment.
Activity distinguishes console-owned dispatches from external reservations whose
process liveness is unknown. Reported token subtotals and missing coverage remain
separate; completed work is not automatically verified engineering value.

### Follow work through the fleet map

The map connects **declared shared capacity → enrolled workers → recorded
assignments**. Select any worker or task to open its inspector and move keyboard
focus to the selected heading. Inspection preserves an unsent task draft;
background refreshes do not move focus. Successful submission opens the queued
task's inspector so its assignment and cancellation controls are easy to find.
Use **Back to fleet map** to return without losing the map search or selection.

Search by worker, provider, model, capacity key or task ID. The map pages through
eight workers at a time, three assignments per worker and eight tasks per waiting
lane; displayed counts distinguish the current page from all included records.
The source's omitted-history count remains visible. On narrow screens the same
relationships stack vertically, with native buttons and readable relationship
text rather than hover-only controls.

Queued tasks occupy a separate lane: their allowed workers are possibilities,
not assignment edges. Queue previews explain quota, occupancy, parallel limits,
pause and unavailable evidence. Recorded quota recheck times are hints, not
promised task start times. Pending or conflicting assignments are shown separately
until records agree. A settled supervisor job and an earlier occupied receipt
can coexist because sources are sampled separately; that remaining occupancy is
explicit rather than silently treated as released capacity.

After a failed refresh, retained records stay labeled as historical throughout
retry. New submission and resume wait for a successful read; pause and owned-task
cancellation remain available. Output is loaded only on request. A failed output
reload identifies previously loaded text as an older read, and changing console
instances clears session-local output. The map itself never starts workers,
probes accounts or changes scheduling policy.

### Inspect collector records without starting collection

A plain read-only console, with neither `--quota-config` nor
`--connections-config`, includes **Collector record inspection** in the resource
view. Authenticated snapshot reads inspect the existing private pending record;
they do not acquire a collector lease, attempt recovery, query boot/process
identity or contact providers. No execution or recovery control is added.

This is a separate `collectorInspection` projection, not `metadataCollector`
startup lifecycle. The panel distinguishes:

- No pending record observed: not proof of readiness or fresh quota.
- Legacy ownership evidence missing: preserve the v1 record; a restart or reboot
  alone cannot reconstruct missing original ownership evidence.
- Pending record observed: the versioned marker exists, but recovery has not
  been evaluated. It is not declared unrecoverable.
- Inspection unavailable: unsafe, malformed, missing-root or changing evidence
  cannot establish presence or contents.

The sample timestamp is local inspection time, never a provider capture time.
After polling fails, the original sample remains explicitly historical. Account
pauses, General/Spark reservations and usage ceilings remain unchanged. Configured
native collection and execution consoles retain their separate lifecycle path;
adding either metadata configuration is still an explicit opt-in to native work.

### Keep Codex quota evidence fresh in the foreground

Create a private `0600` quota configuration using the exact `poolDigest` and
`accountHint` from successful probe reports for this normalized pool and bindings:

```json
{
  "schemaVersion": 1,
  "poolDigest": "REPLACE_WITH_64_HEX_POOL_DIGEST",
  "workers": [
    {
      "workerId": "codex-a",
      "accountHint": "REPLACE_WITH_64_HEX_REPORTED_ACCOUNT_HINT",
      "bucketIds": ["codex"]
    }
  ]
}
```

Every alias sharing a managed worker's capacity key must be included with the
same hint and bucket IDs. The same hint across different capacity keys is refused;
different hints still do not prove independent subscription capacity. Changing
the pool/bindings requires a newly verified configuration. Missing or unsupported
bucket information remains unknown; do not choose buckets merely to omit a known
limit.

Append `--quota-config /absolute/private/quota-config.json` to the console command
to opt in. This works in read-only or execution mode. It creates the selected
private root if absent and owns an exclusive collector lock. No native probe
runs in this collector without this flag; the separate account monitor described
below requires its own explicit option. Browser requests never trigger probes. Keep this
fourth control file outside the writable workspace as well.

One collector sequentially probes configured Codex workers, normally every 30
seconds per worker, with bounded failure backoff up to five minutes and a
10-second probe deadline. Actual captures expire after 60 seconds; a large or
slow pool can expire honestly rather than extending its timestamps. Failed,
unknown, incomplete, exhausted, expired or identity-mismatched managed evidence
blocks the entire shared-capacity group, **even with `allowUnknownQuota:true`**.
This transient gate applies after the normal ledger merge; it never fabricates
fresh health observations or changes durable task/receipt identity. Newer external
zero readings cannot clear the collector's native reserve/exhaustion gate. Other
evidence still participates in the existing conservative timestamp/window merge.

The **Native quota reads** panel shows collector state, fixed failure reasons,
last successful capture and next attempt. Observed metadata is separate from
quota completeness and dispatch eligibility. After a failed console read, the
panel labels retained statuses as **Last reported**, uses neutral unknown styling,
and identifies scheduled times as historical throughout retries. Original capture
timestamps remain unchanged; only a successful console read clears this state.
An unreadable saved allocation explicitly withholds admission rather than
presenting observed metadata as usable capacity. Raw account hints are excluded from
the browser. Closing the console aborts and awaits its collector. Uncertain native
cleanup or a crash retains `.resource-quota-refresh-pending.json`, which blocks a
replacement collector even after its old process lease expires. Do not delete
control records simply to retry. The collector is not a resident service and
cannot recover an ambiguously running native process.

When collector ownership is cleanly refused, the console stays available with
its original configuration and a **Native metadata collection** blocked status.
Configured flags do not mean native reads are running. Managed quota workers
remain withheld; the console starts no metadata coordinator, probes or heartbeat.
The panel distinguishes another owner, reconciliation-required, and unavailable
ownership. It offers no automatic retry or force-clear action. Cancellation or
unconfirmed cleanup still fails startup rather than presenting a usable fallback.

When acquisition can identify the cause, the collector snapshot includes an
optional `recovery` diagnosis containing only a fixed `reasonCode` and
`markerVersion`. The desk explains missing legacy evidence, incomplete command
registration, unconfirmed owner/group absence, identity mismatch and invalid
records. These are sampled startup findings, not current process observations.
Repeated dashboard reads do not acquire a lease or run new identity probes.
Historical views label the diagnosis as historical. Unknown or contradictory
reason/version pairs are rejected by the client rather than rendered as advice.
Legacy v1 records lack owner, boot and group evidence; neither a console restart
nor a computer reboot alone makes those records automatically recoverable.
The diagnostic does not authorize clearing, replaying or replacing evidence.

The console and one-shot quota captures use schema v4 markers when bounded macOS
OS reads verify a machine fingerprint and boot-session UUID; only a digest of the
machine UUID is persisted. Untracked internal lease callers retain v2. Under the
existing exclusive lock, a matching machine and a different verified boot allow
exact-marker recovery. A private, bounded latest authorization receipt is durably
written to `.resource-quota-refresh-recovery.json` before removal. It records
permission to unlink, not proof of unlink completion or a successful quota read.
Fresh quota evidence is still required afterward. Sleep/wake is not a reboot.
Legacy v1, same-boot v2, malformed, changed, different-machine or unverifiable markers
stay blocked. Unsupported platforms write conservative v1 markers. This does not
relax PID-reuse lock checks or reconcile task execution receipts.

For v4, a private bounded schema-2 `.resource-quota-refresh-activity.json` sidecar
records up to two reservations, tied to the immutable marker and owner token.
Each command transitions from `ready` to durable `preparing` before spawn, then
to `registered` with its owned process-group ID, and back to `ready` only after
verified settlement. Registration precedes delivery of helper input. A publication
failure with a spawned child requests bounded owned-process teardown and returns
uncertainty; it cannot invent a clean receipt. The coordinator settles the reservation only
after the adapter confirms that no process started or its owned POSIX group is
absent. All four metadata adapters request these explicit runner receipts,
including each Claude auth/version/usage stage. Exit code alone is insufficient.
Read-only group-absence checks never restore signaling authority over an exited
or recycled process. A budget expiring before native contact settles its local
reservation without inventing a provider sample.

For a normal helper close, the runner can observe a briefly lingering group for
up to one second, within the original execution deadline. These are signal-zero
checks only; no termination signal is sent after the leader exits. Fixed
monotonic and wall-clock bounds prevent a delayed event-loop callback from
accepting a late absence result. Persistent groups, permission errors, expired
cleanup bounds and failed lifecycle publication remain unconfirmed. A helper's
exit code alone still cannot release its metadata reservation.

A later acquisition may recover v4 on the same boot when the machine and boot
match, the former owner PID is proven absent with `ESRCH`, no reservation is
`preparing`, and every `registered` group is also proven absent with `ESRCH`.
Only signal-zero observations are used: recovery never kills a persisted group.
It writes the authorization receipt, then rechecks the owner, groups, boot, lock,
marker and sidecar before removal. This covers a crash after group exit but before
durable settlement. Present groups, permission errors, unknown records and the
spawn-before-registration crash window remain blocked. Legacy v3 records can
recover on the same boot only with an exactly idle schema-1 sidecar; their active
reservations lack process-group evidence and remain blocked.
The sidecar stays as a bounded historical record after close and is replaced by
the next owner; its old identity cannot authorize a new marker. This assumes
trusted private ledger storage and does not protect against malicious same-user
file restoration or processes that escape their owned group. No task replay,
resident restart service or quota freshness is implied by passive recovery.

An unexpected runner throw after invocation is attempted is not an ordinary
completed failure. Codex, Grok and Claude status adapters return cleanup uncertainty
and retain their scratch directory when that invocation has no settlement result.
The collectors also stop on thrown, missing or invalid-status probe results.
They abort queued/repeated reads before releasing the shared permit, await active
peers, and refuse clean closure so the pending marker survives. This includes
one-shot quota captures. Pre-contact adapter refusals and explicit settled failures
keep their existing behavior. These checks do not certify the absence of detached
or daemonized descendants; an idle counter alone cannot authorize same-boot recovery.

Programmatic one-shot callers can inspect `ResourceQuotaRefreshError.workerDiagnostics`
after awaited cleanup fails. Its bounded, frozen records contain the pinned
worker ID, probe status, a fixed cleanup failure class, group-settlement state,
and timeout/cancellation flags. Unknown evidence is labeled unknown. The existing
error message remains compatible. These records contain no raw native output,
exception cause, account hints or partial observations; they cannot authorize
admission or refresh quota timestamps. A prior worker's `observed` status in an
otherwise failed pass does not make its readings available for execution.

Universe resource generation can reuse this pinned configuration through its
optional private [`quotaConfigPath`](ASHLR-UNIVERSE.md#generate-candidates-through-an-enrolled-resource-pool).
That mode performs one bounded capture per configured alias before a new
generation, confirms cleanup, and then uses ordinary atomic resource admission
for one task identity. It does not use this console's recurring refresh loop or modify the source
observations file. Both modes share the same root-level collector lease and
pending marker, so collectors are never duplicated. Universe's optional private
`capacityWaitMs` can asynchronously wait for a verified live collector to release
the lease and for an otherwise eligible reserved worker slot to settle. It shares
one pre-admission allowance within the generation deadline; capture is not repeated
on capacity polls. Unknown ownership, retained fences, quota denials and uncertain
task occupancy still refuse. Without positive waiting, contention remains immediate.
To consume the running console's readings without waiting for its lease to close,
Universe can explicitly select
[`quotaEvidenceMode: "shared-collector"`](ASHLR-UNIVERSE.md#share-the-foreground-consoles-quota-collector)
alongside `quotaConfigPath`. The console writes a private five-second witness on
collector transitions and a one-second heartbeat. Readers verify the exact
configuration and live owner before reserving work; no duplicate collector or
fallback probe is started. Native timestamps and failures remain authoritative;
existing file-level denials and the current allocation still gate admission.
Without this opt-in, console readings are not supplied to a separate Universe
process.

For existing local Ollama bindings, Universe's private `localModelConfigPath`
option pins exact model digests and renews short-lived evidence via inventory-only
reads before new generation tasks. It does not run this console's collector or
perform inference during inventory checks. See the [Universe local refresh
guide](ASHLR-UNIVERSE.md#renew-explicitly-pinned-local-model-evidence) for enrollment,
deadline, denial and scope rules.

Claude admission continues to use supplied/native execution events: its documented status
line quotas are populated after a session API response, not a standalone complete
quota polling API. Local workers continue to require fresh explicit health.
No synthetic Claude prompt, undocumented quota scraping, API-key fallback,
account switching, or Grok subscription entitlement is introduced.

### Connect accounts without starting tasks

Append `--connections-config /absolute/private/connections.json` to monitor
explicit native profiles. Keep this file private (`0600`) outside any writable
worker workspace. For example:

```json
{
  "schemaVersion": 1,
  "intervalMs": 30000,
  "accounts": [
    {
      "id": "codex-personal",
      "label": "Personal Codex",
      "provider": "codex",
      "command": ["/absolute/node", "/absolute/profile/launcher.mjs"]
    }
  ]
}
```

One to eight accounts are supported, with providers `codex`, `claude`, or `grok`
and an interval from 30 seconds to one hour. Use the exact command emitted by
`resources profile prepare`; complete each native login separately. An optional
`expectedAccountHint` pins a previously verified native identity privately.
Labels are operator descriptions, not evidence of identity or separate capacity.
Do not enroll two profiles of the same account as independent subscriptions.

The monitor checks at most two native clients concurrently, without overlapping
cycles. When both metadata options are enabled, the account monitor and admission
collector share one FIFO, two-client budget as well as the existing collector
lease. Queued reads recheck ownership before launch. An uncertain cleanup in
either collector cancels both before another queued read can start; the pending
reconciliation marker remains until cleanup is confirmed. Active clients retain
their permits until their process owners settle. This coordinates concurrency,
not deduplication: separately configured collectors can still read the same
account for their distinct display/admission contracts.
Closing the console aborts and awaits owned metadata clients. No credentials are
copied, browser sessions imported, model prompts submitted, or workers enrolled.
Native clients can maintain authentication/cache state and contact ancillary
services while starting. Monitoring is foreground-only, not a resident service.

The connection ledger deliberately separates authentication, metadata health,
quota windows and execution support:

- Codex uses native account and rate-limit metadata. Unknown or expired windows
  never become zero usage. Monitoring alone does not supply admission observations.
- Claude uses native `auth status --json` and, for the verified native version
  2.1.257 only, its built-in noninteractive `/usage` command. Customizations,
  tools and MCP are disabled; conversation persistence is disabled. This local
  command reports session, all-model weekly and recognized model-scoped windows
  without model inference. Unknown versions receive no slash command and remain
  auth-only. Identity is compared before/after the read and pinned across monitor
  cycles; raw identities and activity diagnostics never reach the browser.
  **Native usage is display-only:** Claude floors percentages and can silently
  fall back to cached usage. Hub therefore labels them approximate, leaves exact
  reset timestamps null, preserves validated native reset text, and makes no
  quota-freshness or network-health claim. A newly collected report is not proof
  of freshly measured usage. Unsupported/incomplete output stays unknown.
- Grok uses native ACP auth/billing metadata, with identity checked before and
  after billing. Cached authentication alone cannot establish live health. Missing
  billing configuration remains unknown. Grok has no Hub task execution adapter;
  an observed plan or on-demand setting never authorizes paid overage.

### Reserve subscription usage for other work

Append `--allocation-controls` to enable the **Fleet usage allocation** slider.
Unlock it with the separate printed control token, choose 0–100%, and save. This
does not require `--execute` and does not enable task submission. The saved ceiling
applies to new subscription work using this exact pool ledger, including Universe
generation. It is not a global restriction on other apps or other ledger roots.

The same capability exposes **Fleet account access**. Uncheck a worker and save
to reserve it for your own work. Paused workers and every alias sharing their
capacity key are excluded from subsequent task admission in this ledger, even
if a task allowlist includes them. The pause does not log you out, hide usage,
change enrollment, cancel work already reserved, or affect your desktop Codex
session. For example, pause Personal Codex while leaving CMP allowed for fleet
work. CMP still needs fresh quota and must pass the saved usage ceiling.

Account access and usage allocation have independent revisions. Saving a pause
does not alter the percentage ceiling. Both changes use the reservation lock and
reject stale revisions; refresh before deliberately replacing another edit.
An allowed worker is not necessarily ready or running. The pause is durable
across restart but applies only to this pool's ledger, not arbitrary other apps.

### Reserve General or Spark independently

The **Quota reservations** control is separate from account access and the usage
ceiling. It requires a current console snapshot, an unlocked control token and
the existing `--allocation-controls` capability. Only explicitly enrolled
account/scope pairs are offered. Reserving General does not reserve an explicitly
pinned Spark bucket on the same account. An unscoped alias on that account is
withheld conservatively, without turning its policy hold into a Spark quota denial.

To keep General for your own work while permitting Spark:

1. Enroll both exact quota scopes using the existing reviewed pool configuration
   and, for an existing ledger, the history-preserving upgrade above.
2. Select General in **Quota reservations** and save. This is a durable local
   admission-policy write, not account login or provider quota collection.
3. Verify the saved reservation before explicitly releasing any whole-account
   pause in account access. Existing account pauses are never cleared by saving
   scope reservations; they always block both scopes.
4. Check current eligibility and quota evidence. Permitted Spark can still be
   withheld by provider health/retry, stale readings, allocation limits, KILL,
   shared concurrency or task caps. No new provider allowance is created.

Saved reservations apply to subsequent reservations, not tasks already reserved
or running. They persist through restart and additive pool upgrades, including
new matching aliases. Receipt history, observations, account access and allocation
revisions are unchanged. Releasing a scope reservation is an explicit save; it
does not resume an account or start a task. No such changes are made automatically
to existing user accounts.

For an authorized local integration, `POST /api/resources/quota-scope-access`
accepts exactly `{exclusions, expectedRevision}`; each exclusion is
`{capacityKey, quotaScope}` using `codex-general-v1` or `codex-spark-v1` and an
enrolled matching worker. The request needs the control token and explicit
matching Origin. The response is `{quotaScopeAccess}` with detached exclusions,
its independent incremented revision and update time. Stale revisions return
409; malformed selectors return 400. GET `/api/resources` reports the current
policy and reapplies its holds to cached eligibility without changing captured
provider observations. Use the current binary: old readers reject policy-bearing
ledgers they cannot interpret.

### Interpret the fleet usage ceiling

- **75%** stops admitting new subscription tasks once any required reported quota
  window reaches 75% used, targeting 25% headroom for other work.
- **100%** allows admission up to native limits; provider refusals, task caps,
  occupancy and other checks still apply. It does not enable overage or reset limits.
- **0%** withholds all new subscription work. Local workers are unaffected.

Account usage reported by the provider includes outside activity, not merely Hub
work. Each window is evaluated separately; percentages are never summed across
accounts or windows. Unknown or stale quota blocks subscription admission below
100%, even if the pool previously allowed unknown quota. This currently means
Claude's display-only native report cannot guarantee a reserved quota allowance.

The account view draws the saved ceiling as a reference on current, timestamped
quota windows, with per-window percentage-point comparisons. It is not an account
dispatch decision or a sum across subscriptions. Historical, unknown, reset-expired
and native cached reports have no ceiling comparison. Claude's `/usage` reports
are marked approximate and may be cached even when sign-in was just checked.

The **Account reference summary** identifies the most-used window (including
ties) and the smallest percentage-point margin below the saved ceiling. It uses
the maximum reported usage, never a sum. Every reported window must have verified
usage and a future reset, and the account observation must be current, signed in
and reachable; otherwise the account-level comparison is unavailable. A positive
margin that rounds to zero is labeled less than 0.01 percentage point. This is a
reference comparison, not remaining tokens, promised capacity or an execution
decision. The pure helper uses the snapshot timestamp, not the browser clock.

An explicit saved ceiling replaces static worker reserve percentages. With no
saved setting, existing reserve policy remains unchanged; the UI's initial 75%
draft is not active until saved. Edits use a revision check: another operator's
change must be reloaded before saving. Admission rereads the policy under the same
lock as reservation, so lowering the ceiling invalidates an earlier eligible
preview. In-flight tasks are not cancelled and can cross the threshold; this is
an admission cutoff, not a guaranteed hard spending cap.

### Enable and control task execution

To enable task submission, explicitly select a workspace and execution capability:

```sh
ashlr resources pool console --root /absolute/private/ledger \
  --pool /absolute/private/pool.json --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json \
  --execute --workspace /absolute/project-worktree --max-parallel 4
```

**This command can execute durable queued tasks immediately.** Confirm the enrolled
accounts, billing settings, workspace and existing queue before starting. The
ledger and all three control files must be outside the writable workspace. Treat
native bindings as trusted local programs, not a sandbox. Review workspace changes
and task receipts before accepting results; use the checkout's normal versioned
recovery process for unwanted edits.

Enter the separately printed control token through **Unlock controls**. A read
token or read-session cookie cannot submit, pause, resume or cancel work. The
browser can choose only the task ID, prompt, eligible workers, mode, timeout and
output bound; it cannot change the workspace, command, endpoint or environment.
Read sessions expire after 15 minutes; the browser keeps the control token only
in memory for 20 minutes. Token expiry, closing a tab, or losing the HTTP connection
does not stop already queued or dispatched work.

The foreground supervisor provides:

- **Durable scheduling:** queued tasks and pause state survive restart. Unattempted
  work resumes when unpaused and capacity becomes available. A dispatch intent is
  saved before invoking a worker; previously dispatching work is never replayed
  after a crash, even when no receipt is available.
- **Pause and cancel:** pause blocks new starts, not in-flight work. Cancel removes
  queued work or aborts a dispatch owned by this server instance. It cannot stop
  an external reservation. These stop controls remain available when evidence is
  stale or unavailable.
- **Exact-task cancellation:** authenticated controllers can send
  `{"expectedTaskDigest":"<64 lowercase hex characters>"}` to
  `POST /api/resources/tasks/:id/cancel`. The supervisor compares that pin with
  the retained task digest before changing queued state or signalling a worker.
  A mismatch returns 409 without cancellation; malformed pins return 400.
  Derive the pin from the controller's retained full task envelope, not a task
  name alone. The existing empty-object human cancellation remains supported.
  A pin is an identity check, not additional authority: control authentication
  and the server's worker-ownership checks still apply. Active cancellation is
  a request; confirm terminal settlement before treating the task as stopped.
  This does not yet detach mission lifetime from the workspace service.
- **Evidence recovery:** missing/corrupt observations stop new admissions but do
  not cancel admitted work. Polling recovers automatically after the selected
  private file is repaired with fresh evidence. Quota reset time alone does not
  release a denial. Storage or lock failures stop the supervisor.
- **Private output:** results are fetched only on demand and retained in server
  memory, at most 256 KiB per task and 4 MiB total. Eviction, restart or shutdown
  loses raw output. The durable queue retains prompts only while queued or
  dispatching; metadata views omit them. A read session can view retained output.
- **Bounded execution:** default four parallel jobs, configurable from one to 16;
  at most 64 queued jobs, a 32 KiB prompt per task, and 256 retained queue identities
  within a 4 MiB state file. History is not silently evicted into replayable work.
  Admission reserves future metadata space; large escaped prompts can reach the
  byte limit before the count limits.
  Capacity exhaustion requires an explicit migration, not deleting state to reuse
  identities. The underlying pool ledger has its separate limits below.

SIGINT/SIGTERM closes the server, aborts its owned work and awaits cleanup. An
unconfirmed termination makes shutdown fail rather than claiming a clean stop.
Already external or unresolved reservations remain distinguishable from this
instance's work. Preserve their receipts and reconcile them before retrying with
a new task ID. Only one supervisor can own a selected ledger at a time.

`--json` emits one private startup record containing scope, URL and tokens; do not
paste it into logs or source control. `--port 0` chooses an available port. This
console has no resident-service installation, machine-global quota collector, account
login, global fleet discovery, or connection to Universe's evaluator. It does not
expose the general Hub API or event stream. The process must remain running for
its queue to advance.

## Measure execution and calibrate a worker

The dispatch desk's **Worker performance** table summarizes all retained ledger
receipts, including history omitted from the task list. Choose one execution
outcome to see its measured sample count and nearest-rank p50/p95. These are
unmatched tasks, not a model ranking. Timing uses a monotonic clock around the
worker adapter; it includes preparation and cleanup, excludes queue/reservation
and durable settlement, and is not provider latency. Old receipts retain unknown
timing. Each receipt and worker summary labels token scope; Claude main-loop
counts exclude subagents. None of these counters establishes accepted work or a
billing total. The optional versioned `execution` field preserves old-ledger
readability; older Hub versions that reject it cannot read a newly measured
ledger, so preserve a pre-upgrade ledger copy for rollback rather than stripping
fields from live records.

Use the fixed `review-calibration-v1` suite to establish a small, repeatable
read-only review baseline. Its three code-comprehension cases have four fixed
checks each. Generated text is parsed as JSON and is never executed. This is a
calibration check, not proof of repository implementation skill. All tasks pass
through normal quota admission, durable reservations and cancellation.

After independently authenticating/enrolling the chosen native worker, or
selecting a running numeric-loopback Ollama endpoint with an installed model,
run the following from the installed Hub CLI. This command **executes model
requests and consumes that worker's resources**. Use an existing canonical
workspace and private manifests as described above; substitute your own explicit
paths and enrolled worker ID.

```sh
ashlr resources pool benchmark \
  --root /absolute/private/pool-ledger \
  --pool /absolute/private/pool.json \
  --bindings /absolute/private/bindings.json \
  --observations /absolute/private/observations.json \
  --workspace /absolute/benchmark-workspace \
  --worker local-reviewer --run-id baseline-001 \
  --expected-model-digest sha256:REPLACE_WITH_INSTALLED_64_HEX_DIGEST \
  --repeats 2 --timeout-ms 120000 --max-output-tokens 512 \
  --output /absolute/private/baseline-001.json --json
```

Local calibration requires the exact Ollama inventory digest and rechecks it
before every task; it never downloads a model. Omit `--expected-model-digest` for
native workers, whose configured model ID is not independently attested. Supply
fresh, truthful readiness observations; `allowUnknownQuota` alone does not imply
health. Normal observation expiry and quota denials remain effective throughout
the run. No service or recurring benchmark is installed.

The exclusive output file contains suite/workload digests, model identity scope,
per-case checks and durable receipts, without raw prompts or responses. Compare
only matching suite/workload digests, and separately control machine load,
runtime version, context allocation, warm/cold state and tool environment before
attributing differences to a model. Record repeated trials; the default is one
repeat, with at most three. A complete score measures the fraction of cases with
every check passing. An interrupted or unscored suite has `score: null`, not a
fabricated zero or success. Exit 0 requires every case to pass.

SIGINT/SIGTERM abort owned work and await its adapter. A failed/uncertain task or
lost settlement stops the suite without retrying. Inspect the ledger before
starting a new run. Reusing a recorded run ID/worker is refused because raw
responses are not durably available for rescoring. Existing report files are
never overwritten; failed preflight can leave an empty reserved output file.
Benchmark reports do not change routing priorities or accept changes. The
separate opt-in [Universe resource generation path](ASHLR-UNIVERSE.md#generate-candidates-through-an-enrolled-resource-pool)
can use the shared pool for candidate responses; a benchmark does not enable it.

## Failure and recovery

SIGINT/SIGTERM abort the owned request/process and await bounded cleanup. Native
process ownership is limited to the existing subprocess runner's process-group
contract, not escaped descendants. No failure is silently restarted on another
worker. A new attempt requires a new task ID and another reservation.

Failed and timed-out tasks add a one-minute shared-group cooldown. Reserved or
uncertain attempts continue occupying slots indefinitely; elapsed time does not
prove their workers stopped. There is no automatic crash reconciliation or
slot-release command in this increment. Stop the affected pool and reconcile the
worker and private receipt evidence before resuming; do not delete the ledger to
manufacture capacity. Pool/binding changes are refused against an existing ledger
rather than resetting its history. Preserve it for any explicit migration.

### Read a native failure

Select the task in the resource console to read **Receipt diagnosis**. It uses
the receipt's fixed reason code, not the separately sampled supervisor reason.
The explanation and next check do not fetch raw output, retry a task, release
capacity, or mark work accepted. A zero native exit code does not override a
failed terminal event or another failed receipt check.

After a native invocation returns, its receipt can include `nativeProcess`:
schema version `1`, scope `native-process`, an observed exit code (`0`–`255`) or
`null`, an allowlisted signal or `null`, and the boolean fields `stderrPresent`
and `outputTruncated`. Timeout, cancellation, process-error, and signal paths
do not turn runner-synthesized codes into measured exits. Captured stderr can
include runner notices; its presence is not proof of a vendor error, and its
absence is not proof of success. Truncation refers to bounded stdout or stderr
capture. This extension contains no captured text or provider error message.
Legacy receipts, local workers, reservations, and pre-invocation failures can
omit it; absence is unknown, not zero or empty capture.

Older builds with strict receipt validation may refuse a ledger containing this
extension. Preserve the ledger and use a compatible build; do not remove receipt
fields to make an older reader accept it.

| Recorded reason | Next check |
| --- | --- |
| `worker-cli-upgrade-required` | The configured model was rejected because the native CLI needs an upgrade. Select or update a compatible CLI, then recheck the enrolled account and quota before a new attempt. Hub does not change the CLI or model automatically. |
| `worker-exit-failed` / `worker-process-failed` | Check the configured launcher, executable, CLI/model compatibility, and private account environment. Exit status alone does not establish an authentication or quota cause. |
| `worker-terminal-failed` / `worker-terminal-missing` / `worker-invalid-events` | Check the supported native event format and task scope. Partial output or process exit `0` is not sufficient completion evidence. |
| `worker-output-truncated` / `worker-output-token-limit` | Review task scope and configured response budget before a deliberate new attempt; do not accept the failed response. |
| `worker-timed-out` | Review the deadline and task scope, confirm cleanup, and refresh capacity evidence. |
| `worker-termination-uncertain` | Stop the affected pool and reconcile process ownership and private receipt evidence. The slot remains occupied; do not delete the ledger to release it. |

An unrecognized reason gets a generic explanation, not raw error text or a
guessed cause. A deliberate new attempt still requires a new task ID and normal
admission checks. The diagnosis is guidance for recovery, not automatic recovery
or a claim of unattended production reliability.

### Ledger recovery boundaries

Each observation holds at most eight windows. If successive valid snapshots
exceed that inventory, the ledger retains seven strongest readings and a
`hub_observation_overflow` hard-denial marker. Its `100` is a refusal sentinel,
not measured usage. Ordinary refresh cannot clear that marker because recovery
of discarded windows is unproven; stop and reconcile the pool before a deliberate
schema migration. The ledger remains readable and does not dispatch through the
overflow.

The bounded store retains up to 4,096 task identities and 4 MiB. Before starting
a worker, admission budgets worst-case settlement metadata for every reserved
task and the bounded quota inventory. Insufficient receipt headroom refuses the
new admission; it does not evict history. Existing receipt reads and replay
behavior are unchanged. The store does not prune old identities into replayable
work. These limits, explicit enrollment, incomplete
vendor quota coverage, and manual ambiguous-run recovery mean this is not yet an
unattended production fleet. Universe's versioned generation receipts, measured
feedback, evaluator, and archive selection remain independent acceptance steps.
The opt-in [generation bridge](ASHLR-UNIVERSE.md#generate-candidates-through-an-enrolled-resource-pool)
links recorded pool tasks to Universe trials without activating a service.
Universe [portfolio execution](ASHLR-UNIVERSE.md#coordinate-campaigns-with-a-dependency-graph)
can supply one explicit `--resource-runtime` to its enrolled, pinned-pool
campaigns. Planning does not validate worker readiness. The shared ledger and
fresh-observation requirements still apply; portfolio concurrency does not add
an automatic capacity-waiting queue or retry.
`ashlr runtime run` still forwards Universe commands only; it does not forward
the standalone resource-pool CLI.

## Provider research and billing boundaries

Research checked September 7, 2026; provider rules and models can change.

- Codex documents subscription authentication separately from usage-billed API
  authentication. App Server exposes account quota windows and metered bucket IDs;
  those percentages cannot be converted to a fixed token allowance.
  [OpenAI authentication](https://learn.chatgpt.com/docs/auth),
  [App Server account limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).
- Claude supports separately authenticated configuration directories, including
  directory-specific macOS credential storage. Its terms distinguish an end user
  using the unmodified native CLI from third-party credential intermediation.
  This implementation does not collect or proxy subscription credentials and is
  not a blanket determination that every multi-account deployment is permitted.
  [Claude authentication](https://code.claude.com/docs/en/authentication#credential-management),
  [credential-use requirements](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).
- The proposed separate monthly Agent SDK credit change was paused. The current
  notice says native print/SDK usage still draws from subscription limits. Do not
  implement the superseded table below that notice as a new resource balance.
  [Claude SDK plan notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- On Max, Fable 5/5.1 can use up to 50% of the **same** weekly allowance, not an
  additional allowance. Continued Fable use after that limit can involve paid
  credits. Hub neither enables such credits nor guarantees the owner has disabled
  them. The exact Fable native wire bucket name was not established; no name or
  numeric allowance is hardcoded into the scheduler.
  [Fable plan limits](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan).
- Claude's documented status-line windows may independently disappear after
  reset. A complete daily/per-model quota polling API was not established. Local
  non-Claude models remain on the local adapter, not a faux-Claude gateway.
  [Status-line resource fields](https://code.claude.com/docs/en/statusline),
  [Claude gateway support](https://code.claude.com/docs/en/llm-gateway).
- Grok Build has an official native CLI, headless output modes, and an ACP stdio
  interface. Hub has **no Grok worker transport** yet: a version-pinned terminal
  result/usage contract and a tested tool/customization boundary are still needed.
  Its documented child-network restriction is a no-op on macOS, so a similarly
  named sandbox is not proof of equivalent containment.
  [Grok Build scripting](https://docs.x.ai/build/cli/headless-scripting),
  [sandbox limits](https://docs.x.ai/build/features/sandbox).
- Grok Bot is an external cloud-computer product, not this console's local
  desktop-control worker. The August 26 announcement expands plan access and
  describes its own usage pool; a public Hub-controllable Bot API and this user's
  exact entitlement have not been established. Do not infer either from a Grok
  subscription. [Grok Bot plan announcement](https://x.ai/news/grok-bot-more-plans),
  [Grok Bot FAQ](https://docs.x.ai/grok-bot/faq).
- Consumer access, native Build access, and an xAI API-key billing account are
  distinct integration choices. The documented API route uses API credentials
  and metered billing; confirm any account-specific included credits, overage,
  or auto-top-up before use. Hub does not fall back to a paid xAI endpoint.
  [xAI API quickstart](https://docs.x.ai/developers/quickstart),
  [API billing](https://docs.x.ai/developers/faq/billing).

For implementation and local regressions, see `src/core/resources/` and
`test/resource-*.test.ts`. Run focused tests, backend/web typecheck, and lint
locally. No GitHub Actions, provider credentials, or real model calls are needed
for this feature's deterministic acceptance suite.
## Firm allocation execution adapter

The Universe SDK exports `executeFirmResourceTask(request, host, { signal })`.
This is an explicit host API, not an always-on dispatcher or a new daemon
activation path. It does not discover accounts or change allocation sliders.

The request binds an allocation ID, exact receipt digest, original hypotheses and
their digest, one selected hypothesis, a prompt, timeout, and output allowance.
The trusted host separately supplies the private allocation root, candidate path,
current constitution version/policy epoch, and an enrollment mapping from the
selected execution identity to a pinned runtime, pool and worker. The allocation
signature remains selection evidence; it does not grant execution authority or
prove that a worker belongs to a particular account.

The adapter rejects human-gated, irreversible, sharded, expired or unallocated
work. It passes the runtime digest to the consuming runtime so changing the
ledger path between validation and consumption cannot silently create a second
execution. Existing pool reservations, current quota observations, worker access
restrictions, reserve ceilings and owned transport cleanup remain in force.

One fixed completion operation is identified by receipt digest and hypothesis
ID. Aliases reuse that identity; changed prompts or task limits conflict in the
same retained ledger. Replays never return recovered model output or dispatch a
new worker. Hosts must retain enrollment/ledger custody. A newly issued receipt
is a new scope: this adapter does **not** implement cumulative cross-receipt
hypothesis accounting or enforce hard provider-wide token spending limits.
Native output limits are checked after the provider response, not a prepaid cap.

Inspect `completion.resource.dispatch` and `taskStatus` for actual admission and
execution; `disposition: "attempted"` means the runtime was called, not that a
provider ran. Every result retains `verifiedAccepted: false`. Response data still
needs independent evaluation before it can count toward engineering yield.
KILL, cancellation and the earlier of hypothesis deadline/inventory reset request
cooperative cancellation; polling is bounded at 50 ms, not hard real-time.
The absolute deadline is also rechecked synchronously under the resource ledger
lock before new admission, so setup and capacity waiting cannot renew its window.
Tests use inert HTTP/native fixtures, not live Codex, Claude or Grok accounts.
