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

Use `ashlr universe init --manifest <file.json>` to register an experiment and `ashlr universe run <id>` for one generation. `status [id]` and `archive [id]` inspect persisted results. These commands also accept `--root` and `--json`; see the [source manifest type](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/universe/types.ts) and `ashlr universe help`. The CLI and JSON results serve engineers and other agents.

Applications can use the same typed interface via `@ashlr/hub/universe`:

```js
import { initUniverse, runUniverse, readUniverseOverview } from '@ashlr/hub/universe';

initUniverse(manifest, { root }); // A validated, immutable experiment definition.
const run = await runUniverse(manifest.id, { root, signal: abortController.signal });
const overview = readUniverseOverview({ root });
```

Each `run` creates one generation. When the trial budget is smaller than the
variant population, successive generations rotate through that population.

Local execution currently requires macOS `sandbox-exec`. Linux execution awaits a verified isolation profile; Windows execution is unsupported. The general Hub console at `/next#/universe` reads the default store. Use the [scoped foreground console](#observe-one-universe-store) or CLI inspection with the same `--root` for experiments in a custom store.

The local web server moves its expensive global dashboard, fleet, control,
history, and proposal reads to one bounded background thread. Universe reads and
HTTP authentication remain responsive while those summaries are calculated.
Identical pending reads share work; the queue and deadlines are bounded. A failed
summary returns an unavailable response, not an empty-success result. Daemon
observation becomes explicitly unknown if its reader fails. Successful or partial
token-authorized mutation attempts invalidate the worker's cached state. This
thread is a performance boundary, not an untrusted-code sandbox; it does not
change the authority of the existing readers or enable fleet dispatch.

## Install a pinned local runtime

Use `ashlr runtime` to install a trusted, locally built Hub package independently
of its source checkout. This is an **unsigned local candidate**, not a registry
publication or a production-qualified resident service. Obtain the archive's
SHA256, clean Git revision and package version from your trusted build handoff;
matching a hash proves identity, not that unknown code is safe to execute.

The bootstrap CLI must already be built or installed. The archive must contain
its bundled dependencies and clean Git build identity. Installation accepts
bounded USTAR regular-file archives, rejects links and ambiguous paths, verifies
the package and dependency inventory, and smoke-tests the installed CLI and SDK.
It invokes neither npm nor lifecycle scripts and performs no registry download.
Smoke checks execute the explicitly trusted candidate; they are not a sandbox
for arbitrary package code.

Choose an absolute, private runtime store with an existing physical parent.
Do not use a source checkout or an existing application-data directory. The
following install command authorizes local writes and candidate smoke execution
only in the managed installation workflow; it does not start a campaign or
resident service:

```sh
node bin/ashlr runtime install \
  --store /absolute/private/runtime-store \
  --artifact /absolute/path/ashlr-hub-3.4.0.tgz \
  --sha256 <trusted-archive-sha256> \
  --revision <trusted-clean-git-revision> \
  --version 3.4.0 --json
node bin/ashlr runtime status --store /absolute/private/runtime-store --json
```

Each installed version has its own package directory, manifest and receipt.
Selection changes atomically after validation; a failed replacement keeps the
previous selection. Status and launch recheck the installed runtime, bundled
dependencies and recorded Node executable. Missing-store status does not create
the store. Packages and failed staging directories are retained, not pruned.
Installation never changes your existing `ashlr` executable, PATH, startup items
or kill switch.

Run an installed Universe command in the foreground through the managed
launcher. Operational commands require their own absolute `--root`, distinct
from the runtime `--store`. This example explicitly authorizes the deterministic
demo to create a seed repository and run bounded local experiments:

```sh
node bin/ashlr runtime run --store /absolute/private/runtime-store -- \
  universe demo --root /absolute/private/experiments --json
node bin/ashlr runtime run --store /absolute/private/runtime-store -- \
  universe status --root /absolute/private/experiments --json
```

`runtime run` pins one installation for the lifetime of its child process,
forwards terminal I/O and cancellation, and propagates the child's exit status.
After cancellation it allows five seconds for shutdown, then kills that exact
child if necessary; a repeated interrupt also escalates. This is not a claim of
process-tree cleanup by the launcher.
It does not choose models or accounts or create background work. A campaign or
portfolio command performs the work declared by its existing manifest and
budgets, including configured local model requests. Normal Universe execution
requirements, including the macOS isolation profile, still apply.

To explicitly restore the retained verified predecessor, run:

```sh
node bin/ashlr runtime rollback --store /absolute/private/runtime-store --json
node bin/ashlr runtime status --store /absolute/private/runtime-store --json
```

Rollback changes the selected package for future launches only; it does not
restart a running process or roll back experiment data. An invalid current
package can be replaced by a verified predecessor, but an invalid predecessor
is never selected. A damaged previous package does not prevent launching a
verified current package. If neither verifies, preserve the store and inspect
the installation evidence; no automatic repair or deletion occurs.

Only Universe commands are accepted by `runtime run`. Ordinary `update`,
general Hub commands and `serve` are not forwarded. Use `universe console` below
for scoped observation through the managed runtime; the general `serve` command
still reads shared configuration and performs stream maintenance.
The versioned package's absolute `binPath` is also returned for trusted direct
use, but direct invocation bypasses managed launch-time verification.

## Observe one Universe store

Open a foreground, read-only console for an explicit absolute experiment root:

```sh
node bin/ashlr universe console --root /absolute/private/experiments --json
```

Or use an already installed, verified local runtime:

```sh
node bin/ashlr runtime run --store /absolute/private/runtime-store -- \
  universe console --root /absolute/private/experiments --json
```

These commands authorize a loopback listener for observation, not experiment
execution. The default port is an available ephemeral port; `--port N` accepts
0 through 65535. Keep the command running. Open its `consoleUrl` in your browser
and paste the `readToken` from its startup record. No browser opens automatically.
The token is private authority: do not share startup output or retain it in logs.
URLs never contain the token. The browser exchanges it for a short-lived,
HttpOnly session cookie bound to a per-tab client proof. Separate console
instances have independent sessions.

The console shows the authenticated store path, experiment measurements,
campaign progress, retained artifacts, delivery evidence and the on-demand
evidence graph. Operational command examples include that same shell-quoted
root. The page observes saved evidence; it has no execution buttons. Use the CLI
to start or control work, then refresh. Active runs and campaigns refresh their
overview every three seconds; the graph refreshes only when requested.

The dedicated server does not initialize the default Hub configuration, clean
streams, discover providers, or start the general dashboard's event channel.
Its bounded worker reads Universe records from the startup-selected store and
checks recorded repository-delivery references. A missing store is reported
without creating it; unavailable and incomplete records do not
become successful empty results. This is process separation for responsiveness,
not a sandbox for an untrusted store or arbitrary repository code.
Public redaction and serialization happen inside the worker. Each JSON projection
has a 16 MiB UTF-8 response limit and a 30-second default read deadline; excess
or failed work returns unavailable rather than a truncated successful graph.
Use targeted CLI inspection when a store exceeds the console's response budget.

The protected read surface consists of `/api/universe/console` (scope metadata),
`/api/universe` (overview) and `/api/universe/graph?universeId=ID` (graph).
Browser-supplied roots, unknown parameters, unrelated Hub APIs and data mutations
are rejected. Session exchange/logout use `/api/session`. The public `/health`
route establishes listener liveness only; it does not attest store health.
Browser requests must match the advertised loopback origin when an Origin header
is present. There is no cross-origin API support. Native clients may use the
read-token header without an Origin header.

Press Ctrl-C to close the console, or send SIGTERM to its exact foreground
process. Shutdown closes its listener, connections and read worker; it does not
pause a separately running campaign. Restarting creates new session authority.
An occupied port or invalid arguments fail before printing a successful startup
record. Choose another explicit port or the default rather than stopping an
unrelated process. No service, launch item, registry release or fleet activation
is part of this workflow.

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
evaluator files not explicitly declared as mutable files or read-only context,
and tool access are not provided.
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

### Create, replace, and delete declared files

Opt into file operations when an experiment needs new modules, removed files,
or supporting source that the model may read but must not change:

```json
{
  "kind": "local-chat",
  "endpoint": "http://127.0.0.1:11434/v1",
  "model": "your-loaded-model",
  "files": ["src/parser.ts", "src/markdown/lines.ts", "src/obsolete.ts"],
  "maxOutputTokens": 4096,
  "fileOperations": {
    "schemaVersion": 1,
    "contextFiles": ["src/types.ts"]
  }
}
```

This is the `generation` object inside a variant. `files` remains an immutable
list of at most 16 mutable paths; `contextFiles` adds at most 16 disjoint,
read-only regular UTF-8 files. Mutable paths may be absent in the current parent.
The model sees explicit present/absent state, current contents, and read-only
context. Without `fileOperations`, the existing replacement-only protocol and
its requirement that every declared file exists are unchanged.

The opt-in response is exactly one JSON object with an `operations` array:

```json
{"operations":[{"op":"replace","path":"src/parser.ts","content":"complete replacement text"},{"op":"create","path":"src/markdown/lines.ts","content":"complete new file text"},{"op":"delete","path":"src/obsolete.ts"}]}
```

Create requires an absent file; replace and delete require a present file.
Delete has no `content` key. Each path may appear once, must exactly match a
declared mutable path, and cannot name a directory. Missing parent directories
for a new file are created inside the candidate. Empty operations are valid;
an identical replacement does not count as a changed file. No globs, renames,
undeclared paths, case/Unicode aliases, overlapping ancestor paths, links, or
read-only-context edits are accepted. The complete batch and its byte budget
are validated before applying any operation.

The combined current contents, read-only context, and previous-attempt text must
fit 128 KiB; each file remains limited to 64 KiB. Replacement/new content remains
bounded by 128 KiB, with the same 256 KiB transport and requested-output limits.
A constant package-owned worker applies data under macOS filesystem confinement
with network denied; this mode verifies that confinement is available before
contacting the model. The batch is not an atomic filesystem transaction. A
partial write, detected file-state race, cancellation, or worker failure fails the trial and discards
its scratch candidate without evaluation or archive admission. Reported usage
from an already-started request is retained.

Receipts pin the file-state context digest and each actual operation's before/
after content digests. `null` means absent, not an empty file. Replay reconstructs
the retained parent and verifies the artifact's actual file states; receipt
claims alone cannot establish the transition. With campaign feedback enabled,
the previous attempt's state is separate from the retained parent: a failed
attempt may have created a file while the retained parent still lacks it. An
attempt without an artifact has unknown file state, not an empty repository.
When feedback is disabled, previous-attempt state and text are omitted.

Use the same run/campaign, archive, graph, comparison, and delivery commands.
Adding file operations does not change the fixed evaluator, acceptance metric,
resource limits, or the distinction between a locally retained artifact and an
accepted production change. Changing the immutable file scope requires a new
experiment definition.

### Read generation usage accurately

Each direct-local model trial records provider and configured model, normalized endpoint,
request-start status, prompt/response digests, generation duration, changed
files, and token-accounting coverage. Counters come from the endpoint's transport
response, not the model-authored edit JSON. They are provider-reported values,
not independent metering or proof of model identity.

For direct-local-only generations, `generationUsage` summarizes model-generation
requests. `tokensUsed` is
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

## Generate candidates through an enrolled resource pool

This opt-in source path uses the [resource pool runtime](RESOURCE-POOLS.md) as a
generation transport. It does not replace the local-chat path, configure accounts,
start services, install models, or fall back to an undeclared provider. Enroll and
commission the intended workers first, retain their shared ledger, and confirm
the exact native CLI/model pair can run under the selected account. Admission
still checks fresh observations, shared capacity, reserves, and operator caps.

Existing local-chat manifests and receipts retain their original shape. Older
builds do not understand `resource-pool` generation configurations or receipts.
Once a store contains them, inspect it with the supporting runtime build or a
compatible successor. Downgrading the runtime does not make those records
readable; do not strip or rewrite evidence to make an older build accept it.

Replace a variant's local generation configuration with this shape. Set
`poolDigest` to the SHA-256 digest of the canonical validated `{pool, bindings}`
used by the resource runtime; it is not the hash of either raw JSON file.
The example's digest placeholder must be replaced before registration.

From the built checkout, this read-only command validates the selected private
pool and bindings and prints that digest; it does not contact a worker:

```sh
node --input-type=module -e '
import { readResourceJson } from "./dist/core/resources/pool-runtime.js";
import { validateResourcePool } from "./dist/core/resources/pool-policy.js";
import { validateResourceBindings } from "./dist/core/resources/worker.js";
import { canonical, digest } from "./dist/core/universe/artifacts.js";
const [poolPath, bindingsPath] = process.argv.slice(1);
const pool = validateResourcePool(readResourceJson(poolPath));
const bindings = validateResourceBindings(readResourceJson(bindingsPath), pool);
console.log(digest(canonical({ pool, bindings })));
' /absolute/private/pool.json /absolute/private/bindings.json
```

```json
{
  "kind": "resource-pool",
  "poolId": "builder-pool",
  "poolDigest": "REPLACE_WITH_64_LOWERCASE_HEX_DIGEST",
  "allowedWorkerIds": ["native-builder", "local-reviewer"],
  "files": ["candidate.mjs"],
  "maxOutputTokens": 2048
}
```

The existing `fileOperations` opt-in can also declare create/delete operations.
The worker returns text; Universe validates and applies only the declared file
operations, freezes the candidate, and runs the same pinned evaluator. Resource
task completion alone cannot validate candidate JSON or admit an artifact.
Native CLI read-only mode is not tool-free operation or a filesystem-read
confinement guarantee. It must not be described as the local chat broker's
tool-free security boundary. Review the native launcher's own environment and
read access before authorizing it to receive this experiment's context.

Keep execution locators in a separate private JSON file, outside the manifest,
candidate, and version control:

```json
{
  "schemaVersion": 1,
  "poolPath": "/absolute/private/pool.json",
  "bindingsPath": "/absolute/private/bindings.json",
  "observationsPath": "/absolute/private/observations.json",
  "root": "/absolute/private/shared-pool-ledger",
  "workspace": "/absolute/private/empty-generation-workspace"
}
```

The runtime file and referenced configuration must be canonical absolute private
regular files with mode `0600`.
`root` is the existing shared pool ledger, not a new per-trial ledger that bypasses
shared capacity. `workspace` is a mode-`0700`, empty Git root containing only its
`.git` directory, with no tracked files, dedicated to response generation. It
must be separate from the entire Universe store, pool ledger, and candidate
directory. Keep
credentials in the enrolled native account setup, not in this runtime file.
Fresh explicit worker observations are required even when the pool allows
unknown quota; unknown quota permission is not fresh health evidence.
The runtime reads the explicit observation file; it does not activate a quota
collector. Ongoing refresh requires a separately commissioned collector. Without
fresh evidence, admission is withheld and the campaign pauses; this is not a
claim of uninterrupted unattended operation.

From the built Hub checkout, after explicitly authorizing the selected workers
to receive the declared files and generation context:

```sh
node bin/ashlr universe run experiment-id --root /absolute/private/universe \
  --resource-runtime /absolute/private/resource-runtime.json --json
node bin/ashlr universe campaign run campaign-id --root /absolute/private/universe \
  --resource-runtime /absolute/private/resource-runtime.json --json
```

These commands consume enrolled worker resources and write trial/task receipts.
Use campaign `resume` with the same explicit runtime option to continue; the
runtime path is not persisted as campaign authority. It is accepted only by
`universe run` and campaign `run/resume`, not `init`, status, archive, or the
read-only console. Inspect the experiment and pool receipts before resuming a
withheld, unavailable, or unresolved attempt. Existing task IDs are not a reason
to redispatch or apply an unavailable historical response. No automatic retry,
account change, capacity release, or model/CLI upgrade is implied.

The portfolio runner does not yet accept or forward `--resource-runtime`.
Run resource-backed campaigns directly with campaign `run/resume`; portfolio
execution cannot supply their private binding and would record a not-started
attempt, consume its generation-invocation reservation, and pause the campaign.

The generation receipt records resource pool, allowed workers, selected worker
and model when known, task/receipt digests, dispatch evidence, and the task's
outcome separately from generation validity and evaluator acceptance. Private
runtime paths, launcher commands, credentials, and raw worker output are not
part of that provenance. The Universe inspector and its existing graph-to-trial
link show recorded evidence; they do not inspect another pool root or establish
current worker liveness.
Some digests are redacted by the existing web privacy filter; use scoped CLI
JSON output for exact digest comparison. A displayed task ID is a provenance
reference, not a cross-store authorization or a live resource-console link.

Resource generation keeps `requestStarted: false`: a CLI invocation can make
zero or multiple provider requests, whose count is not measured here. Optional
`generationUsage.resourceAttempts` counts attempted handoffs with settled,
replayed, or unavailable evidence; known not-started/withheld attempts are
excluded. `resourceReportedAttempts` counts settled handoffs with reported usage.
Unknown or replayed usage cannot establish a complete new spend total. Per-worker
usage scopes remain visible, including Claude main-loop-only accounting. Reported
zero stays zero; absent, partial, or interrupted accounting stays unavailable.
For mixed local/resource generations, combined totals require a completed run,
usage from every started direct-local request and every attempted resource
handoff, and at least one measured request or handoff. Incomplete resource
coverage cannot be hidden by fully measured local requests.
This bridge is not proof of unattended production reliability or accepted work.

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

   New feedback-enabled generations also pin `feedbackVersion: 2` in their run
   records and send a separate `searchContext` block, including on the first
   request when there is no previous attempt. It contains the fixed metric name,
   direction and minimum improvement; the retained parent's run/trial occurrence,
   score and recorded artifact digest; and the previous same-variant outcome's
   selection result and delta. A seed has no measured baseline score. A passing
   trial is not necessarily an improvement: replacing an elite requires a
   positive delta that also meets the minimum improvement.

   Repetition evidence covers completed attempts of the same variant against the
   current parent occurrence. It includes only the latest 16 eligible attempts,
   with total count and truncation made explicit. Its matching count includes the
   latest sampled artifact itself and counts recorded digest matches, not fresh
   artifact verification or identical evaluator outcomes. It does not skip model
   requests, cache evaluation, change scheduling, or estimate wasted/saved tokens.

   Each prepared v2 prompt binds this context in its receipt with
   `search.schemaVersion` and `search.digest`; failures before prompt preparation
   have no search digest. Store replay independently rebuilds it from the prior run
   history and retained archive; current or future trials cannot supply prompt
   evidence. Existing v1 feedback bytes and receipts remain unchanged. Old runs
   without `feedbackVersion` replay and recover as legacy runs; the version is not
   retroactively added to their records.

   The SDK exports `buildUniverseSearchContext(summary, variant)`,
   `validateUniverseSearchContext(value)`, and `searchContextReceipt(context)`.
   These are pure context helpers, not ledger verification: use a healthy summary
   from `readUniverseOverview` as the builder input. Runtime replay performs the
   independent history checks; passing a structural validator alone grants no
   execution or acceptance authority.

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

Generation attempts and generation-invocation reservations are budget allocations, not
counts of accepted work. A campaign step is tied to its durable run identity;
recovery reconciles that identity rather than treating a missing campaign update
as permission to execute completed work again. Interrupted work remains visible
and is not promoted as a completed generation.

The legacy JSON field `maxModelRequests` and recorded `reservedModelRequests`
retain their names. Each reservation budgets one generation transport invocation,
not a native provider API request. Native invocations may make zero or multiple
provider calls. Resource-pool campaigns still require the explicit private
`--resource-runtime` file on each run/resume; a console visit does not supply it.

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
digest, not an additional copy of the feedback file contents. The console also
shows the search-context version and digest when recorded; it does not display
an additional copy of prompt content. Receipt validity establishes the supplied
context, not a measured improvement in model decision quality.

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

## Compare measured campaign progress

Compare two explicitly named campaigns without executing either one:

```sh
node bin/ashlr universe compare baseline-search challenger-search --root /absolute/private/store --json
```

The report separates source integrity, matched controls, observed feedback,
executed workload, evaluator progress, and reported resources. It reads only the
selected campaigns and their pinned Universes, including independent local Git
delivery verification. Each source is sampled and rechecked once; this is a
bounded consistency check, not an atomic global snapshot. Missing or changing
evidence remains unavailable or degraded. Reading does not create a store,
acquire an execution lease, contact a model, or run candidates.

Exit 0 means healthy, complete, comparable evidence—not a winning challenger.
Exit 1 means missing, degraded, incomplete, or unmatched evidence; descriptive
per-campaign results remain available. Exit 2 means invalid arguments. The two
campaign IDs must be distinct. Unknown and duplicate flags are rejected.

### Set up a paired feedback experiment

1. Prepare one committed seed and a working fixed evaluator. Create two Universe
   manifests with distinct IDs but the same objective, exact seed repository and
   commit, metric, evaluator, ordered variants, and run budget. Keep the model,
   endpoint, hypothesis, editable files, output cap, and concurrency identical.
2. Prefer evaluator arguments relative to the pinned seed, for example
   `["/absolute/path/to/node", "evaluate.mjs"]`. The exact comparator digest
   includes the pinned command and executable identity. Absolute seed arguments
   can expand to different per-Universe paths and make the pair incompatible;
   the comparison deliberately does not normalize this difference away.
3. Register both Universes with `universe init --manifest <file> --root <store>`.
   Register one new campaign for each with `campaign init`, identical campaign
   budgets, and distinct IDs. For a bundled-feedback comparison, set baseline
   `feedback: false` and challenger `feedback: true`.
4. Run both campaigns with the existing `campaign run <id> --root <store>`
   command. These explicit run commands execute the configured work. Keep the
   host/model configuration stable, and let each campaign finish. Do not run
   other generations in these Universes before, between, or after their steps.
5. Run `compare` with the two campaign IDs and the same store. Different stop
   points, interrupted work, unequal variant schedules, or other history can
   prevent matched comparison even when the configured budgets were equal.

New feedback-enabled runs use search-context v2. Disabling feedback removes
both evaluator/file feedback and the v2 search context, so this contrast is
labeled `feedback-bundle-v2`. It is **not** an isolated measurement of the new
search context. Repeated, independently paired experiments are needed before
drawing conclusions about real-model performance; a deterministic fixture or a
single pair does not establish general uplift or a causal winner.

A campaign containing both legacy-v1 and search-v2 requests has a mixed treatment.
Its measured per-campaign rates remain descriptive, but paired comparison is
ineligible and comparative score deltas are withheld.

### Interpret the comparison

`matching.comparator` requires exact comparator identity. Configuration matching
covers ordered variants and both levels of budgets; feedback is reported
separately. Workload matching compares the executed campaign work. Comparative
score deltas require matched controls/workload and healthy, fresh, complete,
fully attributed histories. Positive `directionAdjustedDelta` means the
challenger's retained score is better under the declared metric, including a
minimization metric. It is not a business-value estimate.

Counts distinguish passed trials, first niche admissions, strict retained
improvements, and distinct selected artifact digests excluding the seed. A
passing unchanged trial is not a new useful artifact. Final niche scores come
from selected occurrences in that campaign, never from a later global elite.
Prior, interleaved, and later unrelated runs make normalized comparison
ineligible rather than silently contributing credit.

Rates use all recorded attempted work, not only successful requests. Token rates
require complete reported usage and a positive denominator. Time rates use summed
recorded run duration, **not** inference time or elapsed campaign wall time;
`timing.wallSpanMs` is separate. Incomplete work or unusable denominators produce
`null` rates with reasons. These are local experimental progress rates, not
accepted changes per token, subscription savings, or independently metered cost.

Delivery counts require exact campaign run/trial attribution and verified Git
evidence. Multiple branches carrying the same artifact for the same repository
and base commit count as one distinct delivered artifact. Delivery to a local
branch is not merge, production deployment, or customer acceptance:
`acceptedChanges` remains `null`, and report authority is `observation-only`.
Raw prompts, source files, and evaluator diagnostics are not copied into this
report.

The SDK exposes the same observation:

```js
import { readUniverseCampaignComparison } from '@ashlr/hub/universe';

const root = '/absolute/private/store';
const report = readUniverseCampaignComparison('baseline-search', 'challenger-search', { root });
if (report.matching.comparable) {
  console.log(report.scoreDeltas);
}
```

`buildUniverseCampaignComparison` is a pure projection of detached, independently
validated source snapshots. It does not authenticate caller-invented evidence.

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

Command workers execute in a writable copy of their selected parent; model-generation variants replace declared files, or opt into declared create/replace/delete operations, through the local broker. The evaluator runs from the pinned seed and receives the frozen candidate path through `ASHLR_UNIVERSE_CANDIDATE`. Its standard output must be one JSON object containing `passed` (boolean), `score` (finite number), optional `metrics` (named finite numbers), and optional deliberately shareable `diagnostics`. A nonzero exit, timeout, or malformed result fails the trial. Scores become comparable only within the same pinned experiment definition.

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
2. **Model-driven discovery:** direct-local and explicitly bound resource-pool generation join the same experiment contract. Commission and measure each model/account pairing; extend experiments to prompts, tools, routing, and memory.
3. **Engineering portfolio:** connect experiments to enrolled repositories, integration branches, local verification, release artifacts, and operational observations.
4. **Product learning:** connect measured reliability and customer outcomes to the objective; compare variants through explicit experiments and attribute outcomes to the deployed artifact.
5. **Ecosystem participation:** expose capabilities and evidence through agent-facing interfaces; add delegated work and economic integrations with accountable resource settlement.

Each stage should demonstrate a better outcome on a real task and preserve a reproducible path back to the evidence. The destination is an engineering system whose experimentation improves the system itself and the products it builds.

See the [research grounding](UNIVERSE-RESEARCH.md) for the methods and their evidence limits, and the [North Star](NORTH-STAR.md) for the broader product objective.
