# Plan deep, execute wide — using the local context window well

One 27B model on one GPU. The question this answers: when should that capacity be
**one agent with the whole context**, and when should it be **four agents with a quarter
each**? Splitting it four ways all the time is the wrong default for thinking, and not
splitting it is the wrong default for throughput.

Every number here was measured on this machine (128 GB, Qwen3.8 27B at **Q8_0** — an
earlier version of this doc said four-bit, which was wrong; the blob is 27 GiB), not
estimated.

## The constraint that shapes everything

`llama-server` divides `-c` by `--parallel` **at launch**. A slot cannot borrow from its
neighbours, and a single request can never exceed its own slot. So "give the planner the
whole window" is not a request-time choice; it is a different server shape.

| Shape | Per-agent context | Resident | Use for |
|---|---|---|---|
| `--parallel 1 -c 262144` | 262,144 | 43.0 GB | Reading broadly, planning, review |
| `--parallel 4 -c 262144` | 65,536 | 43.4 GB | Four targeted edits at once |

262,144 is Qwen3.8 27B's native trained context. The memory figures above were measured
cold, seconds after start, and are therefore only the weights plus an empty cache. **They
understate the steady state.** From the model card's own numbers — 4 KV heads, 256 head
dim, fp16 K and V, 16 of 64 layers with a full cache — the KV costs 64 KiB per token, so
16 GiB at 262,144 against 8 GiB at 131,072. The same process later measured 47.0 GB once
the cache had filled. The 48 linear-attention layers make this far cheaper than a
full-attention model of this size, but it is not free.

**Switching shapes is cheap.** Measured at a few seconds, not a cold model load, because
the weights stay in the OS page cache across a restart. That is what makes a two-phase
design practical rather than theoretical:

```sh
ashlr local-runtime restart --slots 1 --ctx 262144   # plan
ashlr local-runtime restart --slots 4 --ctx 262144   # execute
```

## Why not just always run four slots

At four slots each agent gets 65,536 tokens, and a Claude Code system prompt measures
**23,310** on this machine. That leaves 42,226 for everything else: the files it reads,
the tool results, the conversation. Enough for a targeted edit. Not enough to read a
subsystem and hold it while reasoning about it.

At one slot the same agent has 238,834 tokens of headroom — 5.7× more. That is the
difference between "fix this function" and "read these nine files and tell me where the
abstraction is wrong".

The earlier default was worse than either: 65,536 **total**, which at four slots gave each
agent 16,384 — less than its own system prompt. The instructions did not fit before a turn
began, and nothing reported an error.

## Why splitting the work is what makes the wide phase work

The reason four agents at 65,536 is not a downgrade is that **a worker does not need the
planner's context**. The planner earns its 262,144 by reading widely and then throwing
almost all of it away. What crosses to a worker should be small by construction:

- the one task, stated so it can be done without asking a question
- the specific files it will touch, named, not described
- the constraint it must not violate, and the reason
- the check that decides whether it worked

If a worker needs the planner's full reading to proceed, the plan was not finished. A
handoff that has to carry 100k tokens of context is a planning failure, not a transport
problem — which is why the compaction below is about *deciding what not to send*, not
about compressing what you did send.

## Capture, transport, compact

Three separate problems, and conflating them is how context handoff usually goes wrong.

**Capture** is already solved and should not be rebuilt. Each vendor CLI owns a native
session and resumes it by id: `claude --resume`, `codex exec resume`, `grok --resume`.
Verse stores that id and nothing else, so the transcript of record stays in the tool that
produced it. Do not mirror transcripts into the hub; that creates a second copy that drifts.

**Transport** is the handoff artifact — the four bullets above, per worker. It is written
by the planning phase, not extracted from it afterwards. The prefix-cache lesson applies
directly: it must be **append-only per worker**. A worker's prompt that gains content at
the front on each turn invalidates its entire cached prefix, which is exactly the bug that
cost 23,500 reprocessed tokens a turn before it was found. Anything the worker learns goes
at the end, never inserted above.

**Compaction** is a decision about relevance, made once, by the phase that has the whole
picture. Two rules worth stating because both were learned the hard way here:

- Send a file path and a line range, not the file's contents. The worker has a filesystem,
  and a path costs ten tokens where the file costs thousands.
- Never compact away the *reason* for a constraint. "Do not change the public signature"
  survives; "do not change the public signature, because three callers outside this repo
  depend on it" is what stops a worker from deciding the rule looks obsolete.

## Where the split earns nothing

Worth stating plainly, because the measurement contradicts the intuition. On one GPU,
four parallel agents complete about **1.1×** more work per minute than running them one
after another — 131s per task against 151s. Parallelism buys throughput, not speed, and
not much of it.

So the wide phase is not for going faster. It is for **independent** work: four changes
that do not touch each other, where serialising them would mean four sequential reviews
instead of one. When the work is not independent, one agent with 262,144 tokens will beat
four with 65,536 every time, because the coordination cost is real and the parallel gain
is 10%.

## What is built, and what is not

Built and verified:

- Both shapes, switchable from the CLI, with the measured costs above.
- The prefix cache holding across turns (23,301 cold, then 34–556 per turn).
- Four agents running concurrently through the console's own dispatch path: 4/4 completed,
  4/4 edits correct.
- A claim check that flags a turn reporting a fix while changing no file — the failure that
  a fan-out makes easy to miss, because nobody reads four transcripts.

Not built:

- Automatic phase switching. Today it is two commands, run deliberately. That is arguably
  correct: switching restarts the server, and doing that under a running agent would kill
  its turn.
- The handoff artifact as a typed, validated object. The shape is specified above; nothing
  writes or checks it yet.
- Any measurement of whether a 262,144-token planning turn is actually *better*, rather
  than merely possible. Prompt processing is the dominant cost on this hardware — roughly
  400 tokens/sec — so a full window would take minutes to ingest before the first token is
  generated. **Measure that before designing around it.**
