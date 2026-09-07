# Ashlr Universe

Ashlr Universe is the long-term product direction for Hub: an open runtime that turns an engineering objective and a resource budget into a continuing search for better products, tools, and ways of working. Hub supplies execution, integration, and observation. A universe supplies the objective, candidate population, experiments, and accumulated evidence.

The useful unit of progress is an improvement demonstrated in a working environment. A universe should be able to propose alternatives, build them, evaluate their effects, retain useful variants, and use the result to choose its next experiment. As models improve, the same loop can explore more ambitious work.

## Start with the local experiment kernel

The Universe kernel runs a complete local experiment: a manifest describes candidates and a fixed evaluator; a bounded run executes operator commands or requests candidate edits from an explicitly configured local model, records observations, and selects elites within defined niches. A later run can select parents from the archive. The bundled deterministic demonstration provides a reproducible way to inspect this behavior without model credentials or a running model service.

This is a development feature in Hub. Its evidence establishes local candidate generation, evaluation, selection, bounded multi-generation campaigns, foreground orchestration across campaigns, and delivery of a retained artifact to a new local Git branch. Subscription-backed generation, resident execution, multi-repository product delivery, customer feedback, and external payments are later integrations. Existing fleet activation and release behavior is documented in the [Hub architecture](ARCHITECTURE.md).

The command surface is `ashlr universe`. From a source checkout with dependencies installed, build locally with `npm run build`, then run:

```sh
node bin/ashlr universe demo --json
node bin/ashlr universe status --json
node bin/ashlr universe archive --json
```

The demo creates a private seed repository and two generations under `~/.ashlr/universe`. It compares stable-deduplication implementations using fixed correctness cases and measured source size. Expect passing variants in separate niches, a rejected order-breaking variant, and second-generation parent references. `--root <absolute private directory>` chooses a separate experiment store.

Use `ashlr universe init --manifest <file.json>` to register an experiment and `ashlr universe run <id>` for one generation. `status [id]` and `archive [id]` inspect persisted results. These commands also accept `--root` and `--json`; see the [manifest type](../src/core/universe/types.ts) and `ashlr universe help`. The CLI and JSON results serve engineers and other agents.

Applications can use the same typed interface via `@ashlr/hub/universe`:

```js
import { initUniverse, runUniverse, readUniverseOverview } from '@ashlr/hub/universe';

initUniverse(manifest, { root }); // A validated, immutable experiment definition.
const run = await runUniverse(manifest.id, { root, signal: abortController.signal });
const overview = readUniverseOverview({ root });
```

Each `run` creates one generation. When the trial budget is smaller than the
variant population, successive generations rotate through that population.

Local execution currently requires macOS `sandbox-exec`. Linux execution awaits a verified isolation profile; Windows execution is unsupported. The console at `/next#/universe` reads the default store. Use CLI inspection with the same `--root` for experiments in a custom store.

The local web server moves its expensive global dashboard, fleet, control,
history, and proposal reads to one bounded background thread. Universe reads and
HTTP authentication remain responsive while those summaries are calculated.
Identical pending reads share work; the queue and deadlines are bounded. A failed
summary returns an unavailable response, not an empty-success result. Daemon
observation becomes explicitly unknown if its reader fails. Successful or partial
token-authorized mutation attempts invalidate the worker's cached state. This
thread is a performance boundary, not an untrusted-code sandbox; it does not
change the authority of the existing readers or enable fleet dispatch.

## Generate candidates with an existing local model

Use a local OpenAI-compatible chat endpoint you already operate, such as a
running Ollama or LM Studio server. Universe does not install models, start a
service, choose an account, send credentials, or fall back to a remote provider.
The configured model name records your selection; it does not attest which model
the endpoint actually serves.

Start from a pinned experiment with a working evaluator. Replace one variant's
`command` with `generation`; do not combine `generation` with `command` or the
legacy top-level variant `model` field. This variant example assumes the pinned
seed contains a regular UTF-8 file named `candidate.mjs`:

```json
{
  "id": "local-coder",
  "niche": "compact",
  "hypothesis": "Simplify the implementation while preserving all observable behavior.",
  "generation": {
    "kind": "local-chat",
    "endpoint": "http://127.0.0.1:11434/v1",
    "model": "your-loaded-model",
    "files": ["candidate.mjs"],
    "maxOutputTokens": 2048
  }
}
```

Replace `your-loaded-model` with the model served by your existing endpoint and
choose the intended port. Only numeric-loopback HTTP endpoints are accepted;
the broker and receipt endpoint is normalized to `/v1`. Review the declared files before
running: their contents, the objective, hypothesis, generation, and parent
identity are sent to that endpoint. Ambient provider credentials, repository-wide context,
evaluator files not declared in `files`, and tool access are not provided.
An endpoint may itself proxy another service; a loopback address is not proof
that inference stays on this machine. Configure the server accordingly.

From the built checkout, register your manifest with
`node bin/ashlr universe init --manifest /absolute/path/to/universe.json`.
Registration writes the immutable local experiment definition but makes no model
request. Run `node bin/ashlr universe run <id> --json` to make the configured
local requests and write a generation. Cancel with Ctrl+C. Inspect the result
with `node bin/ashlr universe status <id> --json` or `/next#/universe`.

The broker asks for replacement text, not executable tool calls:

```json
{"edits":[{"path":"candidate.mjs","content":"complete replacement text"}]}
```

Each edit must target a unique, declared, existing regular file. New paths,
duplicate paths, extra JSON keys, NUL bytes, non-UTF-8 files, and malformed output
are rejected. The limits are 16 declared files, 64 KiB per file, 128 KiB current-parent
file content, 128 KiB replacement content, 256 KiB complete request/response bodies,
and 1–16,384 requested output
tokens. If complete valid reported usage shows that output budget was exceeded, the candidate is
rejected and reported consumption is retained; this cannot undo tokens already
spent or independently enforce an unreported provider limit. The run's time budget also bounds generation. Valid edits are frozen and
passed to the pinned evaluator; producing an edit does not admit it to the
archive. Candidate and evaluator subprocesses still have network access denied.

If the endpoint is unavailable or the model output fails validation, inspect the
trial's generation receipt and error. An attempted request can consume tokens
even if no candidate is accepted. Fix the endpoint or define a new experiment
when changing an immutable manifest, then explicitly run the next generation;
there is no implicit paid-provider retry.

### Read generation usage accurately

Each model trial records provider and configured model, normalized endpoint,
request-start status, prompt/response digests, generation duration, changed
files, and token-accounting coverage. Counters come from the endpoint's transport
response, not the model-authored edit JSON. They are provider-reported values,
not independent metering or proof of model identity.

`generationUsage` summarizes only model-generation requests. `tokensUsed` is
the sum of input and output tokens only for a completed generation where at least
one recorded request started and every recorded request reported valid counters.
Otherwise totals remain `null`; complete reports from a subset of requests remain
available in individual trial receipts. Partial fields within one response are
treated as unavailable. A hard exit can occur before an in-flight request writes
its receipt, so unfinished, interrupted, and failed generations withhold aggregate
totals; their coverage counts describe recorded requests, not all possible spend.
Reported zero
is distinct from unavailable. Command/evaluator work is outside this token
scope, and `costUsd` remains `null`: no API-equivalent subscription bill,
electricity cost, or hardware amortization is inferred. The console shows passed
trials and archive admissions separately from generation success; none of these
counts establishes accepted production changes or customer value.

## Continue autonomously with a bounded campaign

A campaign runs successive generations of one registered universe in the current
process. It keeps searching after the first passing candidate. Its original
budget, completed work, interruptions, and stop reason remain inspectable across
invocations. It does not install a daemon, start a model service, or publish code.

First register a universe with a working fixed evaluator. Save a campaign
manifest such as this, replacing `my-experiment` with that universe's ID:

```json
{
  "schemaVersion": 1,
  "id": "local-search",
  "universeId": "my-experiment",
  "budget": {
    "maxGenerations": 12,
    "maxDurationMs": 600000,
    "maxModelRequests": 48,
    "maxStagnantGenerations": 4,
    "maxReportedTokens": null
  },
  "feedback": true
}
```

From the built Hub checkout:

1. Register the local definition:

   ```sh
   node bin/ashlr universe campaign init --manifest /absolute/path/to/campaign.json
   ```

   Registration persists the definition but makes no model requests.

2. Start the execution process:

   ```sh
   node bin/ashlr universe campaign run local-search
   ```

   This action runs configured commands and model requests within the campaign
   budget. It continues without approval between generations; keep the process
   running while it works. With `feedback: true`, bounded observations from prior
   evaluation accompany subsequent generation prompts. The original objective
   and evaluator remain fixed; feedback is evidence, not authority to change them.

   Feedback uses the latest completed generation containing that same variant.
   It can include a failed trial's score, numeric metrics, deliberately shareable
   diagnostics, and the declared files from its verified artifact. A failed
   attempt does not become the retained parent. Previous-attempt file context is
   separately limited to 128 KiB total and 64 KiB per file; the complete request,
   including current files and feedback, must still fit the 256 KiB transport cap.

3. Inspect persisted progress from another terminal or the Universe console:

   ```sh
   node bin/ashlr universe campaign status local-search --json
   ```

   The console shows campaigns for the selected universe, budget progress,
   reservations, archive admissions, strict improvements, and generation links.
   It keeps refreshing while a campaign runs, including gaps between generations.
   The console is read-only; its command examples do not execute automatically.

Control the exact campaign from a terminal:

```sh
node bin/ashlr universe campaign pause local-search
node bin/ashlr universe campaign stop local-search
node bin/ashlr universe campaign resume local-search
```

`pause` and `stop` request cooperation from the campaign owner. A
`pause-requested` or `stop-requested` response is not acknowledgment that work has
stopped; inspect status until the owner acknowledges it. A paused or interrupted
campaign can continue with `run` or its `resume` alias. Terminal campaigns remain
terminal. Resume does not refund attempts or reservations and does not restart
the original deadline. Ctrl+C interrupts the foreground invocation; inspect its
recorded state before continuing. These controls do not clear the legacy fleet
kill switch or reactivate its daemon.

Use `--root <private directory>` consistently on every campaign command when the
universe is in a custom store. The console reads the default store. `status`
without an ID lists recorded campaigns, and `--json` returns one result document
for agents. Successful command handling or campaign termination is not a claim
that the project succeeded.

### Interpret campaign limits and evidence

Generation attempts and model-request reservations are budget allocations, not
counts of accepted work. A campaign step is tied to its durable run identity;
recovery reconciles that identity rather than treating a missing campaign update
as permission to execute completed work again. Interrupted work remains visible
and is not promoted as a completed generation.

Stagnation measures generations without an archive change. Initial admission to
an empty niche is distinct from a strict improvement over its prior elite; the
console reports both. A campaign may end at its stagnation limit with no passing
candidate. Read its reason and individual evaluator evidence before drawing a
conclusion about usefulness.

Evaluators may supply structured `diagnostics` in addition to numeric metrics:

```json
{"passed":false,"score":0,"diagnostics":[{"code":"INVALID_DATE","message":"Reject calendar rollover instead of formatting it.","path":"format.ts","line":48}]}
```

Only deliberately shareable messages belong here: they are saved locally and
may be sent to the configured model when campaign feedback is enabled. Raw
process output and arbitrary failure stacks are not substituted for this
contract. Diagnostics are bounded to 16 entries, 512 characters per message,
and 8 KiB serialized in total; optional paths must be relative and line numbers
positive integers. The console displays diagnostic codes only and omits messages
and private locations. Generation receipts preserve feedback provenance and a
digest, not an additional copy of the feedback file contents.

`maxReportedTokens` is an optional stop threshold based on reported consumption,
not a preventive spending ceiling. Requests can consume tokens before a result
arrives, and interrupted requests may have incomplete accounting. The recorded
token subtotal does not prove complete spend. Missing usage remains unavailable,
and no dollar cost or business yield is inferred. When `maxReportedTokens` is set,
incomplete model usage prevents further requests; resuming does not reset this
uncertainty. The absolute duration limit
continues to elapse while the process is paused or absent.

If records are degraded, inspect the reported reason before retrying. Do not
delete evidence or reset the definition to make a refusal disappear. To change
an immutable campaign budget or experiment contract, register a new, explicitly
identified campaign or universe as appropriate.

## Coordinate campaigns with a dependency graph

A portfolio composes already registered campaigns across distinct Universes.
Independent campaigns run concurrently, up to `maxParallel`; a dependent campaign
waits for its prerequisites to reach `completed`. This is **ordering**, not artifact
transfer or an acceptance gate: a campaign can complete because its budget or
stagnation limit was reached without finding a useful artifact. An already
completed campaign satisfies its node without rerunning, even if the portfolio's
dependency edges were declared later. These edges do not create historical causal
evidence in the experiment graph.

Save a caller-owned portfolio file after registering the three campaigns below
with their own evaluators and budgets, each in a different Universe:

```json
{
  "schemaVersion": 1,
  "id": "builder-portfolio",
  "maxParallel": 2,
  "maxDurationMs": 600000,
  "tasks": [
    { "campaignId": "parser-search", "dependsOn": [] },
    { "campaignId": "formatter-search", "dependsOn": [] },
    { "campaignId": "integration-search", "dependsOn": ["parser-search", "formatter-search"] }
  ]
}
```

1. Inspect the proposed ordering without executing or creating a store:

   ```sh
   node bin/ashlr universe portfolio plan --manifest /absolute/path/to/portfolio.json --json
   ```

   The plan reads only the enrolled campaigns and reports ready, waiting,
   completed, blocked, busy, or unavailable nodes. Unknown dependencies, duplicate
   IDs, cycles, and malformed definitions are rejected. Missing/degraded selected
   evidence or multiple campaigns sharing one Universe prevent all dispatch.
   A healthy plan containing only ready, waiting, or completed nodes exits 0;
   blocked, busy, unavailable, or degraded plans exit 1. Planning never runs work.

2. Start the explicitly enrolled campaigns in the foreground:

   ```sh
   node bin/ashlr universe portfolio run --manifest /absolute/path/to/portfolio.json --json
   ```

   This executes configured commands and any configured local model requests.
   Each campaign retains its original evaluator, lease, generation/request/token
   accounting, stagnation limit, and deadline. A campaign is attempted at most
   once per invocation. Failures and operator pauses block descendants while
   independent branches can continue. A campaign already owned elsewhere is
   reported busy; the portfolio neither adopts nor cancels that owner.

3. Inspect individual campaign progress using `campaign status <id> --json` or
   the existing Universe console. `portfolio run` returns one final result:
   `plan` is the initial snapshot; `outcomes` records each attempted or skipped
   campaign and its observed evidence. Exit 0 means all portfolio nodes completed,
   not that all projects succeeded. Incomplete, cancelled, timed-out, failed, or
   blocked execution exits 1; invalid arguments or manifests exit 2.

Ctrl+C or the portfolio duration limit cancels and awaits owned campaign calls
before returning. Cancellation is cooperative and cleanup may exceed that time
limit. Use the existing campaign pause/stop commands for individual controls;
a pause arriving between planning and execution is not silently resumed.

To continue after inspecting the result, run the same portfolio file again.
This explicit invocation may resume campaigns already paused or interrupted at
its start. Completed work is not replayed; attempts and reservations are not
refunded, and original campaign deadlines do not restart. A portfolio invocation
has a new duration window, but cannot replenish any campaign's budget.

The file is the portfolio definition, not a new durable scheduler database.
Campaign ledgers remain the recovery state. The result is a per-invocation
observation, not a globally atomic snapshot or a persisted portfolio history.
Keep the foreground process running; no daemon, model service, account, or
background restart is installed. The limits are 64 enrolled campaigns, 8 active
campaign calls, and 24 hours per invocation. `maxParallel` limits this invocation's
campaign calls, not each campaign's trial workers, host-wide concurrency, account
quota, or aggregate token spend. Independent invocations retain their own limits.

Use `--root <private directory>` consistently when campaigns use a custom store.
The SDK exposes the same workflow:

```ts
import { readUniversePortfolioPlan, runUniversePortfolio } from '@ashlr/hub/universe';

const plan = readUniversePortfolioPlan(definition, { root });
const result = await runUniversePortfolio(definition, { root, signal });
```

`validateUniversePortfolioDefinition` validates caller input without I/O.
`buildUniversePortfolioPlan` is a pure projection of already validated campaign
snapshots, not an authentication API. Actual execution always performs its own
targeted reads and admission checks; supplying a plan does not authorize work.

## Deliver a retained artifact to a repository

Delivery connects a current niche elite to a usable branch in the experiment's
pinned seed repository. It does not edit the working tree, index, or current
HEAD. A dirty checkout can remain dirty and untouched. The new commit's parent
is the pinned seed revision, not the repository's current branch tip; later
integration may therefore need conflict resolution and fresh tests.

1. Read the archive and choose the exact current elite's `trialId`:

   ```bash
   ashlr universe archive <universe-id> --json
   ```

2. Explicitly authorize the local branch mutation by invoking delivery with a
   new `codex/` branch name:

   ```bash
   ashlr universe deliver <universe-id> \
     --trial <elite-trial-id> --branch codex/my-evaluated-change --json
   ```

   This writes Git objects and creates only that local branch. It does not
   switch branches, invoke hooks or working-tree filters, merge, push, execute
   candidate code, or deploy. If the artifact matches the pinned base, the
   result is `unchanged` and no branch is created. A pre-existing unrelated
   branch is never overwritten.

3. Inspect the durable receipt and local commit:

   ```bash
   ashlr universe deliveries <universe-id> --json
   git -C /absolute/path/to/seed-repository show --stat <receipt-commit>
   ```

   Receipts bind the universe, trial, run, manifest, comparator, artifact,
   base commit, new commit, tree, and changed files. Reading checks the
   branch against its receipt. An altered or missing branch is degraded
   evidence, not another accepted change. The console exposes the same evidence
   under **Repository delivery** and links back to the source generation.

   The console's privacy filter may abbreviate home paths and hide full digests.
   Its Git example expands the abbreviated home safely; use the local
   `deliveries --json` command for exact identity values.

The delivery intent is persisted before the branch becomes visible. If a call
is interrupted, repeat the exact universe, trial, and branch command to
reconcile its intent; never delete a receipt to force a retry. `pending` is not
confirmation that a branch was delivered. Reads do not resume pending work.
Use `--root /absolute/private/store` consistently for a nondefault store.

The SDK exports `deliverUniverseElite(id, { trialId, branch, root? })` and
`readUniverseDeliveries(id, { root? })` from `@ashlr/hub/universe`.
Delivery requires a healthy experiment and a verified retained artifact; it
shares the campaign/generation execution lease. A live campaign must finish
or acknowledge a pause before delivery can start.

The committed tree is checked against the evaluated artifact before branch
creation. This preserves the existing result; it is **not a fresh evaluation**
or proof of product usefulness. Local branch delivery, merge acceptance,
package publication, deployment, and customer value are separate outcomes.
Keep the source branch and receipt for review or later integration; removal of
either is a separate explicit repository/storage operation.

## Trace results through the evidence graph

Use the graph to answer which code a trial inherited, which earlier outcome
provided feedback, which evaluator measured it, and whether a retained artifact
has a verified local branch delivery. It is derived from the existing records;
there is no separate graph database to synchronize.

These commands only read evidence. Replace `my-experiment` with a registered ID
and copy a node ID from the first response into the second command:

```sh
ashlr universe graph my-experiment --json
ashlr universe graph my-experiment --node '<node-id>' --direction ancestors --depth 64 --json
```

Use `descendants` to inspect downstream relationships. Depth is bounded to
1–64; a depth-limited result is explicitly incomplete. Traversal JSON contains
`{graph, traversal}`: graph counts cover the full included projection, while
`traversal.nodeIds` and `traversal.edgeIds` identify the selected subgraph.
`--root` selects a private custom store. A missing store is not created, and a
missing, degraded, or incomplete read exits with code 1 rather than claiming
complete results. Invalid CLI arguments exit with code 2.

The SDK exposes the same graph and browser-safe traversal:

```js
import { readUniverseGraph, traverseUniverseGraph } from '@ashlr/hub/universe';

const graph = readUniverseGraph('my-experiment', { root });
const trial = graph.nodes.find((node) => node.kind === 'trial' && node.currentElite);
if (trial) {
  const ancestry = traverseUniverseGraph(graph, {
    nodeId: trial.id, direction: 'ancestors', maxDepth: 64,
  });
}
```

`buildUniverseGraph(overview, universeId)` is a pure projection for callers
that already hold a validated overview. It does not authenticate arbitrary
caller-supplied objects. The storage reader validates the selected experiment,
projects matching campaign histories against that sample, and inspects only that
experiment's delivery repository. Unreadable campaign identity records make the
inventory incomplete because their membership cannot be established.

### Read relationships and findings accurately

- **Parent** means inherited candidate code. **Feedback** means a preceding
  same-variant evaluator outcome that informed the attempt. A failed attempt can
  provide feedback without becoming a parent.
- Trials and artifacts are separate occurrences, even when their content digests
  match. Repeated outputs are grouped as findings, not merged into a single node.
- Campaign reservations remain distinguishable from runs that actually started.
- A repeated-output finding identifies matching recorded content, not why the
  model repeated it or whether another attempt is worthwhile. Reported token
  coverage remains explicit; missing counters are not treated as zero spend.
- An undelivered-current-elite finding is an observation for inspection, not an
  instruction to deliver or a promise that the change is useful in production.
- Historical artifact digests are recorded evidence, not fresh byte checks of
  every artifact. Verified local delivery uses the existing receipt, artifact,
  Git object and ref checks. Neither graph consistency nor delivery establishes
  a remote push, merge, deployment or accepted production change.

Fixed node, edge and finding bounds are returned in `limits`. `complete: false`
and structured `issues` expose truncated or unresolved evidence; counts describe
included nodes, not unknown omitted totals. Graph traversal never starts work,
changes a campaign budget or grants execution authority.

In the Universe console, open **Evidence graph** to load the selected experiment
on demand. Filter or select nodes, follow relationships, and inspect the exact
source trial using the existing trial view. Refresh is explicit; changing graph
focus does not reread the filesystem. The authenticated read-only endpoint is
`GET /api/universe/graph?universeId=my-experiment`; it rejects other query fields,
including filesystem roots. Opaque graph IDs preserve topology through privacy
filtering, while exact digest and other secret-shaped metadata may be hidden in
the browser. Use local CLI JSON for exact provenance.

## Five engines, one feedback loop

| Engine | Responsibility | First useful integration |
| --- | --- | --- |
| Population | Preserve candidate ancestry and strong variants across different kinds of work. | Archive measured elites by niche and select the next experiment's parents. |
| Organization | Allocate bounded work and assemble outputs with explicit dependencies. | Independent candidate trials followed by a shared evaluation and selection step. |
| World model | Preserve what was attempted, observed, selected, and superseded. | Typed decision records linked to candidate, evaluator, and run identities. |
| Scientist | Turn a hypothesis into a comparison that can disprove it. | Fixed evaluation contracts, repeatable trials, and retained failure evidence. |
| Economy | Allocate time, tokens, and money toward observed value. | Per-run limits, elapsed time, and provider-reported local generation tokens with explicit coverage. Dollar cost remains unmeasured (`null`); product and customer outcomes are later integrations. |

These responsibilities can evolve independently while sharing one experiment record. They describe software responsibilities rather than a required number of agents or a fixed human-style org chart.

## The experiment contract

An experiment connects an objective to evidence through a small sequence:

```text
manifest + prior archive
  → choose candidate or parent
  → execute within the run budget
  → independently evaluate the resulting artifact
  → record observations and the decision
  → retain an elite or preserve the failure record
  → use the archive in the next run
```

Candidate identity, evaluator identity, objective version, and resource limits must accompany the result. A candidate's self-description is useful context; the evaluator's observed result determines selection.

Command workers execute in a writable copy of their selected parent; model-generation variants replace declared files in that copy through the local broker. The evaluator runs from the pinned seed and receives the frozen candidate path through `ASHLR_UNIVERSE_CANDIDATE`. Its standard output must be one JSON object containing `passed` (boolean), `score` (finite number), optional `metrics` (named finite numbers), and optional deliberately shareable `diagnostics`. A nonzero exit, timeout, or malformed result fails the trial. Scores become comparable only within the same pinned experiment definition.

Commands are supplied by the operator and execute with network access denied and scoped filesystem writes. The process boundary is suitable for these local experiments, rather than arbitrary hostile-code execution in a VM. Cancellation and timeouts target the invocation's owned process group; termination of deliberately detached descendants is not established by this runner.

Newly written evidence is budgeted to 15 KiB per trial and 1 MiB per final record,
including its envelope. The existing shared private-store hard ceiling and the
Universe ledger's 64 MiB aggregate limit are unchanged. Before model contact, the
runner preflights space for the declared generation receipt. Evaluator measurements
are accepted only when the complete trial fits: an oversized measurement fails
the trial before assignment, without silently trimming metrics or diagnostics.
The generation receipt and frozen candidate artifact remain available. This is a
writer policy; existing version-one records retain their reader compatibility.

The archive preserves raw dimensions so future comparisons can use a consistent objective. When objective weights or evaluation conditions change, both challenger and incumbent need comparable measurements. Partial progress and complete task success remain distinct fields in the measurement model.

Niches represent meaningful differences such as task family, execution cost, or latency. A global winner can hide useful low-cost or specialized variants. A retained failure can supply correction context without becoming an archive parent.

## Architecture that can absorb better models

Keep model and harness identity together. A model upgrade, tool change, retrieval policy, memory program, or coordination topology creates a new experimental condition. Measure that condition on the intended task family before inheriting a previous configuration's performance assumptions.

For research, independent exploration preserves alternatives until evidence is ready to combine. For dependent software changes, explicit artifact contracts and integration ownership keep the work coherent. Both are available strategies for the organization engine to compare.

The world model should distinguish intentions, observations, and conclusions. A decision record answers what was attempted, which inputs and policy applied, what execution produced, what verification found, and why a variant was retained. Derived views can summarize those records for a UI or an agent without replacing the underlying evidence.

The evaluator is independently versioned. New generated tests can enrich a challenge suite while fixed held-out acceptance checks preserve comparisons across generations. This supports evolving the verification capability while maintaining an interpretable history of improvement.

Custom evaluator authors must keep acceptance logic outside the process executing candidate code. Run candidates through a bounded probe, treat returned values as data, and perform assertions and scoring in the evaluator process. The bundled demonstration uses this separation; a pinned evaluator file alone cannot make candidate-authored process effects trustworthy.

## Path toward the full Universe

1. **Local evidence loop:** reproducible candidate execution, fixed evaluation, bounded resources, durable decisions, and archive-driven selection.
2. **Model-driven discovery:** local model edit generation now joins the same experiment contract. Extend it to verified subscription adapters and experiments on prompts, tools, routing, and memory.
3. **Engineering portfolio:** connect experiments to enrolled repositories, integration branches, local verification, release artifacts, and operational observations.
4. **Product learning:** connect measured reliability and customer outcomes to the objective; compare variants through explicit experiments and attribute outcomes to the deployed artifact.
5. **Ecosystem participation:** expose capabilities and evidence through agent-facing interfaces; add delegated work and economic integrations with accountable resource settlement.

Each stage should demonstrate a better outcome on a real task and preserve a reproducible path back to the evidence. The destination is an engineering system whose experimentation improves the system itself and the products it builds.

See the [research grounding](UNIVERSE-RESEARCH.md) for the methods and their evidence limits, and the [North Star](NORTH-STAR.md) for the broader product objective.
