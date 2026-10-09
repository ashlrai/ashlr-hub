# Use local context for relevant work

Phantom supports deliberate local runtime shapes for broad reading or parallel,
independent work. Choose using the actual runtime window, workload and verified
outcomes. A larger window is capacity, not evidence of better work.

## Current metadata and historical trials

On October 9, 2026, read-only metadata from the installed local llama.cpp server
reported four slots, 65,536 tokens per slot and Q8_0 quantization. Its loaded blob
matched the model layers in both local `qwen3.8:27b-q8_0` and
`qwen3.8:27b-ctx64k` manifests. These tags identify the local artifact association;
they do not independently verify its upstream weights or training history. Slot
capacity does not establish how many slots are free.

The [upstream Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B)
reports a native context length of 262,144 tokens. That published model metadata
is separate from a serving window and from the provenance of a locally converted
GGUF artifact.

The measurements below were recorded in the September 21–22, 2026 local trials,
with a locally named Qwen3.8 27B Q8_0 artifact on a 128 GB machine. The weights
occupied about 27 GiB. These are historical observations, not current hardware,
prompt-size, memory, latency or quality guarantees. Window and cache arithmetic
are calculations, not measurements. See [the local fleet investigation](LOCAL-FLEET.md)
and [the dated evaluation artifacts](https://github.com/ashlrai/phantom/tree/master/src/core/local-eval/baselines).

## Context is divided at launch

`llama-server` divides its total `-c` context among `--parallel` slots. A single
request cannot use another slot's allocation. Giving one planner the entire
window requires a different server shape, rather than a request-time choice.

| Shape | Calculated context per slot | Historical startup residency | Intended use |
| --- | --- | --- | --- |
| `--parallel 1 -c 262144` | 262,144 | 43.0 GB | Broad reading, planning or review |
| `--parallel 4 -c 262144` | 65,536 | 43.4 GB | Independent targeted edits |

These residency readings were taken seconds after startup with an empty cache;
they understate steady-state residency and do not prove constant memory use. A
later reading was 47.0 GB. For the upstream architecture's full-attention layers,
an fp16 K/V calculation gives 64 KiB per cached token: 16 GiB at 262,144 versus
8 GiB at 131,072. This excludes other runtime allocations and depends on the
actual artifact and cache configuration.

The historical restart took seconds while weights remained in the OS page
cache. That is not a guaranteed restart time. Restarting during local work can
truncate active turns, so do not change shapes while work is running. These are
**mutating examples for an idle runtime**, not automatic planning phases:

```sh
phm local-runtime restart --slots 1 --ctx 262144   # broad reading
phm local-runtime restart --slots 4 --ctx 262144   # independent workers
```

The equivalent saved total-context setting is `models.llamaServer.context`.
Inspect runtime status after an authorized change; requested configuration alone
does not prove the serving window.

## Account for the actual request

The September CLI trial measured a 23,310-token system prompt. Subtracting that
historical value leaves 42,226 tokens in a 65,536-token slot, or 238,834 in a
262,144-token slot. These calculations do not measure a current CLI prompt,
tool schema or available headroom. CLI versions, instructions, tools, history
and transport affect the actual request.

The earlier total-context default of 65,536 yielded 16,384 per slot at four
slots. The recorded CLI request exceeded that window before useful work began.
Current fit logic preserves original task instructions and complete tool-call
groups, while omitting older context when necessary; an original request that
cannot fit a known window fails before the call.

Local chat and local API workers have different context paths. Chat uses the
native Claude CLI against the local endpoint; API workers assemble task, tool
schema and optional repository orientation directly. The local automatic memory
bundle is bounded at 2,400 characters. With `foundry.repoMap` enabled, repository
orientation can add a signature map capped at approximately 8,000 estimated
tokens, plus localization. That is an input-size bound, not proof that every
task consumes that many tokens.

## Give workers a useful handoff

Send the objective, relevant files and evidence, the reason for important
constraints, and the check that establishes success. Let workers read additional
source when needed. Broad tasks can legitimately need broad context; handoff
size alone is not evidence of a planning failure.

Phantom retains native session identifiers for supported CLI resumes and records
normalized events for the workbench. Keep the native transcript authoritative;
avoid creating another transcript solely to hand off work. Use stable initial
instructions and append new evidence when the transport supports prefix caching.
The historical cache experiment recorded 23,301 cold prompt tokens followed by
34–556 newly processed tokens per turn; that does not guarantee current reuse.

Use file paths and line ranges when the worker can access the same repository.
Retain why constraints matter, unresolved questions, source citations and
verification requirements. Reuse repository localization and dependency graphs
to find relevant context rather than attaching every file by default.

## Compare verified completion, not token speed alone

One September parallelism experiment recorded about 131 seconds per task versus
151 seconds in serial execution, roughly 1.1 times the throughput. It does not
establish a general parallelism ceiling or prove that one shape always wins.
Shared compute, prompt evaluation, cache reuse, tool latency and coordination
all affect the result.

The same investigation recorded prompt evaluation near 400 tokens/second. This
is a historical prefill observation, not current decode speed. Current UI
readings distinguish warm-up decode from warm-up and last-turn end-to-end speed.
End-to-end turn speed includes tools and other work; use its scope and age.

Measure verified task completion, errors, retries, input/output tokens, prefill,
decode and tool time under matched task/runtime/cache settings. A faster wrong
edit or false completion is a failure. The existing local evaluation harness
records real verification outcomes and configuration; its dated trials should
not be presented as current benchmark results.

## Supported behavior and remaining experiments

Supported source behavior includes deliberate runtime shape selection, stable
local chat prompts, native session resumes, bounded worker context, context-fit
checks and recorded speed scopes. Historical trials recorded four concurrent
dispatches with four correct edits and a check for a claimed fix with no file
change. Those observations do not establish every current workload's quality.

Automatic shape switching is not implemented. Neither the benefit of a full
262,144-token planning turn nor an optimal universal effort/concurrency setting
has been established by matched quality trials. Preserve the active runtime
while measuring request composition and relevant-context selection; change its
settings only when the evidence supports the tradeoff.
