# Ashlr Universe

Ashlr Universe is the long-term product direction for Hub: an open runtime that turns an engineering objective and a resource budget into a continuing search for better products, tools, and ways of working. Hub supplies execution, integration, and observation. A universe supplies the objective, candidate population, experiments, and accumulated evidence.

The useful unit of progress is an improvement demonstrated in a working environment. A universe should be able to propose alternatives, build them, evaluate their effects, retain useful variants, and use the result to choose its next experiment. As models improve, the same loop can explore more ambitious work.

## Start with the local experiment kernel

The Universe kernel runs a complete local experiment: a manifest describes candidates and a fixed evaluator; a bounded run executes operator commands or requests candidate edits from an explicitly configured local model, records observations, and selects elites within defined niches. A later run can select parents from the archive. The bundled deterministic demonstration provides a reproducible way to inspect this behavior without model credentials or a running model service.

This is a development feature in Hub. Its evidence establishes local candidate generation, evaluation, and selection mechanics. Subscription-backed generation, resident execution, multi-repository product delivery, customer feedback, and external payments are later integrations. Existing fleet activation and release behavior is documented in the [Hub architecture](ARCHITECTURE.md).

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
are rejected. The limits are 16 declared files, 64 KiB per file, 128 KiB total
file content in each direction, 256 KiB request/response bodies, and 1–16,384 requested output
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

Command workers execute in a writable copy of their selected parent; model-generation variants replace declared files in that copy through the local broker. The evaluator runs from the pinned seed and receives the frozen candidate path through `ASHLR_UNIVERSE_CANDIDATE`. Its standard output must be one JSON object containing `passed` (boolean), `score` (finite number), and optional `metrics` (named finite numbers). A nonzero exit, timeout, or malformed result fails the trial. Scores become comparable only within the same pinned experiment definition.

Commands are supplied by the operator and execute with network access denied and scoped filesystem writes. The process boundary is suitable for these local experiments, rather than arbitrary hostile-code execution in a VM. Cancellation and timeouts target the invocation's owned process group; termination of deliberately detached descendants is not established by this runner.

The archive preserves raw dimensions so future comparisons can use a consistent objective. When objective weights or evaluation conditions change, both challenger and incumbent need comparable measurements. Partial progress and complete task success remain distinct fields in the measurement model.

Niches represent meaningful differences such as task family, execution cost, or latency. A global winner can hide useful low-cost or specialized variants. A retained failure can also be a useful parent when a later mutation builds on its strengths.

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
