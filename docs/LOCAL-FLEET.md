# Running a local agent fleet on Qwen3.8

Goal: many local coding agents at once, 24/7, with no cloud dependency — the same way Claude Code or
Codex would be used, but on this machine.

## The finding that determines the architecture

**Ollama cannot run Qwen3.8 agents concurrently.** Measured on this machine, four concurrent
requests to `qwen3.8:27b-ctx64k` on Ollama 0.33.3:

```
wall 15.2s   per-request 3.7, 7.6, 11.4, 15.2
```

That four-second stagger is queueing, not parallelism. The server log says why, and it is a hard
constraint rather than a tuning problem:

```
WARN source=sched.go:509 msg="model architecture does not currently support parallel requests"
     architecture=qwen35
```

`OLLAMA_NUM_PARALLEL` does not help — the scheduler refuses before it is consulted, and resident
memory stays at a single KV slot. Note also that the qwen35 hybrid/sliding-window attention defeats
Ollama's prompt cache (`forcing full prompt re-processing due to lack of cache data`, four times in
a sixteen-second test), which matters for agent loops that resend a growing transcript each turn.

**llama-server does run them concurrently.** Same model file, same machine:

```
wall  9.1s   per-request 8.6, 8.9, 9.0, 9.0
```

All four finish together — continuous batching across four slots sharing ONE copy of the weights.
That is 1.7x the throughput at four agents, and unlike running four Ollama instances it costs 27 GB
once rather than 27 GB per agent.

## The resulting setup

Two runtimes, each doing what it is good at:

| Runtime | Port | Role |
|---|---|---|
| Ollama | 11434 | model discovery (`/api/tags`, `/api/ps`), embeddings (`bge-m3`), single interactive Verse chats |
| llama-server | 8080 | the parallel agent fleet — many concurrent coding agents |

Both resident is ~58 GB of 128 GB, which leaves room for KV cache and the rest of the machine.

llama-server is launched against the GGUF blob Ollama already downloaded, so there is no second copy
on disk:

```
llama-server -m ~/.ollama/models/blobs/sha256-<qwen3.8-model-layer> \
  --port 8080 --parallel 4 -c 65536 --host 127.0.0.1
```

The manifest at `~/.ollama/models/manifests/registry.ollama.ai/library/qwen3.8/27b-ctx64k` names the
model layer's digest; the blob is that digest with `:` replaced by `-`.

The hub already has a `llama-server` engine (`src/core/run/engines.ts`, M144) that speaks the
OpenAI-compatible surface at `/v1`, with the base URL resolved from `cfg.models.llamaServer.baseUrl`,
then `LLAMA_SERVER_BASE_URL`, then `http://localhost:8080/v1`.

## What "local only" has to mean

Local-only is not just a preferred model — it is a refusal. Cloud engines must be unreachable, not
merely deprioritised, so an accidental frontier dispatch cannot spend money the operator has
deliberately forgone. The hub already has the seam: `provider-client.ts` throws on a cloud provider
without `--allow-cloud`, and `router.ts` checks `cloudKeyAvailable`.

## Concurrency is bounded by slots, not by ambition

Four slots is what this configuration was measured at. Raising `--parallel` raises KV cache memory
linearly, and past the point where the cache no longer fits, throughput collapses rather than
degrading gracefully. Any fleet-level concurrency cap must be derived from the serving runtime's
actual slot count, not set independently — two different numbers is how a queue becomes invisible.

That derivation is only worth anything if it reaches the dispatcher, which took three fixes:

* **Use the derived answer, don't re-clamp it.** `resolveCfg` always populates
  `daemon.concurrency.local` with a default of 2, so intersecting the derived number with it
  pinned an unconfigured four-slot machine at two agents while every surface reported four.
  `resolveLocalPoolCap` (`src/core/daemon/loop.ts`) is now the single rule, and a test pins it.
* **Tier by locality, not by trust tier.** The fleet's engine is registered `tier: 'mid'` because it
  is branch-eligible after verification, and the pool maps everything that is not tier `'local'`
  into the cloud bucket — so the slot ceiling, which only ever applies to `TieredPool.local`,
  bounded nothing the fleet dispatched. `poolTierForBackend` tiers by `LOCAL_ONLY_BACKENDS`.
* **Follow the path the tick actually takes.** With `fabric.concurrentDispatch` on, the tiered pool
  is never consulted. The measured slot count is handed to that planner as a per-backend override
  (`ConcurrentDispatchCfg.slotsByBackend`), and when `fabric.maxSlotsPerBackend` is the tighter
  number the reported limiter says `config` rather than `serving-slots`.

## The fence was the real ceiling, and it is not any more

Before any of the above mattered, one agent ran at a time regardless of slots.
`runApiModelSandboxed` acquired the process-wide, cross-process **outward mutation fence** at the
top of a run and released it at the end — spanning the entire model loop, which is ~99% of wall
time and performs no outward mutation. Every agent past the first blocked on it.

The fence still means exactly what it meant — at most one agent positioned to make outward
mutations — but it is now held only for the sections that make them: the policy gate before the
run, and proposal filing plus sandbox cleanup after it. It is released across inference and
re-acquired before filing, and re-acquiring re-mints the cleanup authority, which re-checks
`~/.ashlr/KILL`. A kill armed mid-inference therefore refuses the filing rather than being outrun
by a fence taken twenty minutes earlier, and `pause` reaches quiescence without waiting behind a
model.

Sandbox *creation* genuinely does mutate the source repo's `.git`, so it keeps the fence — but
through `createSandboxAsync`, which waits off the event loop. The synchronous
`acquireOutwardMutationFence` spins on `Atomics.wait`: raising its timeout does not make a waiter
more likely to win (the holder is in the same process and holds across awaits), it just freezes the
hang watchdog, the queue-lease renewer, the shutdown handler and the control plane for the duration.

Measured after the change, four concurrent agents on four real repos:

```
per-agent 50.3 / 41.2 / 50.9 / 41.7 s      wall 50.9 s
peak busy 4/4 slots        321 of 328 samples had >= 2 slots busy
```

## What actually bounds a free fleet

A local dispatch costs $0, so a USD budget cap can never fire for it. The bounds that do:

| Bound | Where |
|---|---|
| serving slots | `/props.total_slots`, read back from the live server |
| `daemon.perTickItems` | how many items one tick may claim |
| `daemon.localFleet.maxDispatchesPerDay` | an explicit non-monetary daily ceiling, **default 400** |
| the outward mutation fence | still one-at-a-time for engines that hold it across a run (`builtin` via `runSwarm`) |

The daily ceiling is reserved *before* a turn runs and released if the turn never dispatched, so a
long-running agent is visible to it for its whole duration. Writing `null` is an explicit opt-out
and is reported as one; junk falls back to the default, because "we could not parse your ceiling"
must never mean "run unbounded".

## Running it 24/7

`ashlr local-runtime install` writes a launchd agent. Two things make that safe rather than merely
convenient:

* **It is refused while `~/.ashlr/KILL` is engaged,** and while the bind host is not loopback.
  llama-server has no authentication of any kind — whoever reaches the port can run inference and
  read every slot's prompt through `/slots` — so a permanently installed, LAN-exposed inference
  server needs more than an environment variable. `ASHLR_LOCAL_RUNTIME_HOST` alone is downgraded
  back to loopback and the downgrade is reported; `models.llamaServer.allowNonLoopback: true` is
  the only way out, and `install` still refuses.
* **The plist runs a shim, not a frozen blob path.** Ollama's store is content-addressed, so the
  `sha256-…` path resolved at install time is garbage-collected by the next `ollama pull` — at
  which point `KeepAlive` would respawn llama-server against a missing file every ten seconds
  forever while every surface reported only `state: 'down'`. The shim checks the frozen path, falls
  back to `ashlr local-runtime resolve-model` to re-read the manifest, and `exec`s — so launchd
  still supervises llama-server's own pid.

A launchd `KeepAlive` restart gives the runtime a new pid that nothing rewrites into the ownership
record, so `probeLlamaRuntime` re-adopts it read-only when exactly one llama-server on the port was
launched from the binary the record names. Without that, the job we installed ourselves reported
`managed: false`, the cockpit hid its own controls, and `stop` refused.

## The Claude-CLI-to-llama-server gap (measured, unresolved)

The interactive path is not blocked by the mutation fence — Verse sessions take no fence, no sandbox
and no global lock, only a per-session busy guard. Many concurrent chats are architecturally fine.

llama-server does serve the Anthropic Messages API at `/v1/messages`, so pointing the Claude CLI at
it is possible in principle, and three concurrent agents did run genuinely in parallel: 176s, 181s,
183s against a 183s wall.

But all three failed their task, for a reason worth recording:

- **With Qwen3.8's native chat template**, the CLI's request is rejected before inference:
  `Jinja Exception: System message must be at the beginning`. The CLI supplies its system prompt via
  Anthropic's top-level `system` field, and the conversion does not place it where the template
  demands. Every turn returns `API Error: 500`.
- **With `--chat-template chatml`**, the ordering is accepted and the 500 disappears, but tool
  calling breaks: the model *narrates* using the Read tool instead of emitting a tool call, and raw
  `<think>` tags leak into the text. One turn, no edits, no tools invoked.

So today the choice is correct-but-serial (Ollama, whose template handles Qwen3.8's tool calls
properly — the benchmark's 8-turn agent runs prove it) or parallel-but-tool-less (llama-server).
Neither is "many working local coding agents", and claiming otherwise from the parallelism number
alone would be wrong.

What would close it, in rough order of cost: a chat template that keeps Qwen3.8's tool-call and
reasoning blocks while tolerating a trailing system message; or a small Anthropic-shaped shim that
normalises message order before forwarding to llama-server's native-template endpoint; or an agent
runner that speaks the OpenAI tool-call shape directly, which llama-server already serves correctly
and which the hub's own `llama-server` engine uses — that engine is wired and tested, so autonomous
fleet dispatch does not have this problem. It is specifically the Claude CLI as the agent runner
that does.

### Why the template patch did not work (and what it ruled out)

I patched Qwen3.8's own template to accept a *leading run* of system messages instead of only one,
on the theory that Claude Code's multi-block system prompt arrives as consecutive system messages.
The assertion still fired — and because it was now guarded by the new flag, that failure is itself
the finding: **the system message arrives after a user message has already been rendered.**

So this is not a message-ordering problem that a template edit can fix. The system content is placed
mid-conversation, and the template's system branch emits nothing (the system prompt is assembled
before the loop), so simply deleting the assertion would silently DROP the agent's instructions —
strictly worse than the 500, because it would fail quietly.

Ruled out: `--chat-template chatml` (accepts the ordering, loses tool calls), and patching the
system-position assertion (does not address the real placement).

Still open, and the right next step: inspect what `/v1/messages` actually forwards for a Claude Code
request — llama-server logs the rendered prompt at higher verbosity — and decide whether the fix
belongs in llama-server's Anthropic-to-chat conversion or in a small normalising shim in front of it.
Do not delete the assertion.

## RESOLVED: Claude Code now drives llama-server

Two fixes, and the second only surfaced once the first was gone.

**1. The message shape.** Captured from a real Claude Code request through a logging proxy: the CLI
sends a top-level `system` field AND a system-role turn sitting SECOND in `messages`, after a user
turn. Qwen3.8's template refuses any system role that is not first, hence the 500 on every turn.

`src/core/local-runtime/llama/anthropic-shim.ts` lifts system-role turns into the top-level `system`
block, which the template consumes before its loop. Nothing is dropped and every other turn keeps
its order. Deleting the template assertion instead would have been WORSE: that branch renders
nothing, so a late system turn would vanish silently and the agent would lose its instructions with
no error at all.

**2. Context is divided by slots, not shared.** With the template fixed the next error was honest:
`request (23310 tokens) exceeds the available context size (16384 tokens)`. `--parallel 4` splits
`-c` four ways, so 64k became four 16k slots, and Claude Code's system prompt alone is ~23k. Running
`-c 131072 --parallel 4` gives each slot 32k and clears it.

**Slots and per-agent context compete for the same memory.** Choosing a slot count is choosing how
much context each agent gets; a fleet sized without accounting for the agent runner's own system
prompt will fail at dispatch rather than degrade.

Verified: a single Claude Code agent completes the full loop on Qwen3.8 through llama-server — three
turns, real tool calls, correct edit on disk.

### The throughput/latency trade, measured

Four concurrent agents saturate all four slots, but each agent's share of the model shrinks
accordingly. A task a single agent finishes in roughly three minutes takes well over fifteen when
four run together. Parallelism here buys THROUGHPUT, not speed.

That makes it right for unattended or background fleet work, and poor for a human waiting on one
interactive answer. Size the fleet for the job: fewer slots with more context each for interactive
use, more slots for batch work.
