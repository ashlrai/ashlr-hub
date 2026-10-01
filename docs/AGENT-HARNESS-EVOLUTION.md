# Agent harness evolution

Architecture proposal, reviewed against the working candidate and official OpenAI
documentation on **2026-09-30**. The proposals below are not activated connectors,
new provider entitlements, or a claim of unlimited running capacity.

Build one workbench with two jobs: **Work with me** for an interactive chat and
**Work for me** for a continuing fleet responsibility. Keep account selection,
tool evidence, capacity explanations, and recovery in those workflows. Reuse the
existing harness rather than replacing every provider with one invented adapter.

## What to borrow from OpenAI

OpenAI's managed Agents API owns sessions, orchestration, compaction, and recovery;
applications provide tools and an execution environment. This is a different
integration from native Codex sessions or a ChatGPT subscription. Borrow its
session and event concepts without treating an API key as a subscription seat.
[Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview)

| Verified concept | Proposed Ashlr use | Existing seam |
| --- | --- | --- |
| Specialists have separate contexts; a manager coordinates their tasks | Delegate a bounded task with an explicit result owner, files, and return contract | [delegation-scope.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/run/delegation-scope.ts), [handoff.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/handoff.ts) |
| Handoff transfers reply ownership; agent-as-tool retains the manager's answer | Show whether a child owns the conversation or returns evidence to its parent | [session-handoff.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/session-handoff.ts), [session-engine.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/session-engine.ts) |
| Live events and saved items serve different purposes | Resume by durable cursor; reconcile saved state after disconnect; never equate child completion or stream EOF with root success | [session-store.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/session-store.ts), [verse-stream.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/verse-stream.ts), [transient-events.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/transient-events.ts) |
| Tool discovery can defer full schemas until needed | Search trusted, scoped tool metadata first; attach schemas only for the selected task | [mcp-registry.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/mcp-registry.ts), [mcp-scope.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/mcp-scope.ts), [verse-mcp-grants.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/verse-mcp-grants.ts) |

These are mappings, not claims that the existing modules implement the provider
protocol. Sources: [multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent),
[orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration),
[events and items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events),
and [tool search](https://developers.openai.com/api/docs/guides/tools-tool-search).

Tool search is provider/model dependent. Agents API deferred functions require
both enabled tool search and a deferred declaration; MCP/plugin discovery has
different rules from Responses MCP. Discovery never grants invocation rights.
For the Hub, configured MCP inventory, successful discovery, a granted tool, and
a reported call must remain distinct states. Existing
[turn-resource-evidence.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/web-ui/routes/verse/chat/turn-resource-evidence.ts)
already distinguishes reported, pending, failed, unknown, and partial evidence
without exposing tool payloads or arbitrary private names.

Programmatic tool calling can run loops, parallel reads, and result filtering in
an isolated JavaScript runtime. It does not provide Node, ambient network,
filesystem, or subprocess access. Discover deferred tools before entering the
program; tool search is a top-level operation. Prefer direct calls when each
result requires judgment or a write needs separate authorization. The proposed
Hub equivalent batches independent authorized reads, while every call still
passes its existing scope, identity, cancellation, and replay checks.
[Programmatic tool calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)

## Capacity controls and remaining seams

The candidate removes the six-seat fanout ceiling, optional agent-retention
ceiling, arbitrary daemon capacity UI ceilings, the hidden batch concurrency
clamp of eight, the separate swarm BUILD preference ceiling of eight, and the
daily USD preference ceiling of 1,000. It preserves
existing defaults and final admission. This inventory records behavior; it
does not change live settings or authorize additional spend.

| Seam | Current behavior | Classification / next treatment |
| --- | --- | --- |
| Budget controls | Items, batch parallelism, and continuous/local/cloud/total concurrency accept positive safe integers; daily USD accepts finite 0 through the exact-safe numeric ceiling, including fractions | Shared existing UI/API bounds in [caps-spec.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/web-ui/routes/verse/autonomy/caps-spec.ts); numeric representability is not a fleet quota. Explicit USD zero remains Stop; signed spend authority is unchanged |
| Batch executor | Explicit safe-integer parallelism is retained; default remains 2; worker allocation uses actual selected inventory | Former hidden clamp removed in [loop.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/daemon/loop.ts); queue, account, resources, and journal admission still apply |
| Swarm BUILD concurrency | `--parallel` accepts a positive safe integer; default remains 3, with no preference ceiling of eight | [runner.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/swarm/runner.ts) launches only actual pending tasks, reserves tokens/steps per batch, and retains provider/authority admission; malformed CLI input is refused and invalid programmatic preferences retain default 3. Planner/task-count and budget semantics are unchanged |
| Durable per-tick journal | At most 64 selected items; a larger item preference does not journal the whole backlog at once | Existing durability contract retained. API reports `journalItemCapacity`; UI explains subsequent ticks and older-server unknown capacity. Expanding or sharding this journal needs separate review |
| Item execution | `maxSteps: 100`; proven-free token ceiling defaults to 50,000 or explicit `daemon.perItemMaxTokens` | Steps remain hardcoded; token limit is a configurable default, not a universal model context guarantee |
| Continuous concurrency | Defaults local 2, cloud 6, total 8; max concurrent defaults to configured total or 8; larger safe-integer preferences survive UI/API/runtime consistently | Requested capacity still passes actual admission; invalid/fractional/nonfinite/unsafe stored values use existing defaults rather than unlimited capacity |
| Execution identity V1 | Shadow registry has 32-identity / 32-concurrency bounds and schema capacity classes also cap concurrency at 32 | Separate bounded shadow contract in [execution-identity.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/fabric/execution-identity.ts) and [config schema](../schema/config.schema.json); do not call it an unlimited account dispatcher |
| Ordinary best-of-N | Candidate cash accounting still uses subscription tier classification | Remaining actual-engine/model accounting seam in [best-of-n.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/run/best-of-n.ts); custom API engines must not become zero-dollar merely by tier |
| CLI context and delegation | Native CLI windows/options vary; context fit is a bounded byte-derived estimate; delegation metadata has projection bounds | Respect actual adapter capabilities; distinguish unknown context from zero, and diagnostic bounds from execution authority |
| Workspace isolation | Finite port range 41000–60000, allocation blocks up to 50; zero ports reserve none | Physical allocation limit; current create/restore guard is process-local, not cross-process reservation proof |
| Actual resource admission | Provider quotas, native seats, operator reserves, model memory, leases, signed scope, and cash/ACU accounting | Real constraints remain; report their observed source and freshness rather than guessing unlimited capacity |

Defaults are useful starting points; arbitrary hidden ceilings are not. Bounded
parsing, public projections, queues, and caches remain necessary to handle
malformed input and backpressure. They should report partial coverage rather
than pretend an unexamined account or omitted tool does not exist.

## Next source slice: richer admission explanations

The current slice reuses existing cap contracts and configuration; it adds no
new policy subsystem. It validates operator items/parallel/concurrency
preferences consistently and reports the actual 64-item journal capacity. Item
steps remain unchanged at 100. Next, explain effective admission from the
existing runtime observations; automatic scaling can follow after this is
observable. An operator preference expresses desired work, not a new
credential, provider entitlement, resource lease, or signed allowance.

Reuse [headroom.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/routing/headroom.ts),
[execution-capacity-lease.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/fabric/execution-capacity-lease.ts),
[capacity-wait.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/resources/capacity-wait.ts), the queue planner,
and the existing final backend admission. A free producer still needs its exact
resolved engine/model, native account, and actual result identity; locality or a
subscription-like tier alone is insufficient. Hosted Devin ACU remains a
separate configured allowance. Explicit stored daily USD zero continues to mean
Stop. No offline comparison or artificial evaluation becomes a dispatch gate.

Before widening any effective policy, return a bounded explanation containing
requested versus admitted capacity, stable engine/model/account references,
constraint kind, observation timestamp, and available/unknown status. Recheck
at reservation and launch; a UI explanation is not a lease. Use allowlisted
labels, not credentials, raw paths, prompts, or provider error bodies. Reuse
durable accounting and identity ledgers before adding a new receipt schema.

**Files:** existing routing headroom/capacity projections, daemon admission,
and the autonomy capacity explanation. Keep current preference validation in
the existing contracts. Audit ordinary best-of-N candidate and critic cash classification
in a separate focused change, using the same resolved economic proof.

**Acceptance:** unchanged old defaults; explicit requests beyond legacy UI
maxima; NaN/fractional/overflow refusal; UI/runtime agreement; concurrent
reservation conflicts; revoked/stale account observations; unknown provider
capacity; actual hardware saturation; explicit Stop; exhausted positive cash
with proven-free production; paid/unknown fallback refusal; custom frontier API
costs retained. Use deterministic behavioral tests and real admission evidence,
not an optimization benchmark that blocks useful work.

Tradeoff: this improves capacity truth immediately without promising infinite
resources. Dynamic automatic scaling can follow after the system can explain
and replay every admission decision.

## Durable wakeups, steering, and context

**Wakeups:** add an account/repository-scoped durable inbox for queue changes,
completed runs, refreshed readiness, and changed grants. Coalesce by generation,
deduplicate event IDs, reconcile persisted state after restart, and retain timed
rescans/backoff when events are missed. The existing
[fleet event bus](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/fleet/event-bus.ts) is in-process/best-effort and
can include generative handlers; it is not a durable wakeup queue or a promise
that every handler costs zero. Wakeups request reevaluation through normal
admission, never an unconditional dispatch or new service activation.

**Steering:** Verse already persists follow-ups through
[turn-queue.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/turn-queue.ts), holding them on failure/Stop.
Expose adapter capabilities separately: next-turn queue, stop-and-send, or
genuine mid-turn steering. OpenAI's documented mid-turn steering uses GPT-6
Responses WebSockets; an accepted update is queued, not yet applied, and does
not undo output or started tools. Record requested, accepted, applied/continued,
failed, and unknown states; follow the successor response identity. Do not
represent a queued CLI follow-up as provider-native steering.
[Mid-turn steering](https://developers.openai.com/api/docs/guides/steering)

**Compaction:** use [model-windows.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/model-windows.ts),
[context-fit.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/context-fit.ts), and existing adapter/context
events. Keep the latest user objective, scope, unresolved questions, checked
file citations, and outstanding tool results in a deterministic portable
handoff. Opaque provider compaction belongs to that provider/account/session;
it cannot become another provider's readable history. Responses supports both
automatic and standalone compaction, but standalone `/responses/compact` is
not supported for multi-agent responses; automatic root/child compaction has
its own configuration. Report observed compaction and missing context without
asserting complete recall.
[Compaction](https://developers.openai.com/api/docs/guides/compaction),
[Responses multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent)

The Responses multi-agent API currently has no fixed total-agent/depth limit
but defaults to three active subagent turns. Children share the configured
model and tools. Ashlr should preserve those actual provider settings while
assigning narrower application scopes; neither a child nor a handoff inherits
new account access merely because its parent can discover a tool.

## Provider and custody boundaries

The candidate's [OpenAI Agents inventory client](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/openai-agents/client.ts)
is bounded GET-only metadata; listing a session does not qualify a producer or
start a managed agent. Creation, tool execution, streaming, steering, and cost
admission are separate subsequent integrations requiring actual account access
and provider contracts. Keep this provider state separate from native session
IDs and phone/browser authority.

Reuse existing [Locus](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/integrations/locus.ts),
[Phantom secret resolution](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/integrations/secrets.ts), and scoped MCP
surfaces only for their supported credential/identity paths. A new Claude
producer credential broker needs its own verified native contract; do not
substitute an interactive-reserved profile or export subscription credentials.
Plugin installation and tool discovery do not prove per-turn attachment or
execution. Extend reported turn evidence only when an adapter can supply it.

[Dots companion](DOTS-COMPANION.md) describes personal task delegation and the
separate workspace-agent/event APIs; it does not activate a Dot engine.
Unverified Muse Code, external Grok Bot, or Dots transports remain explicit
unknown contracts until supported endpoints, entitlements, custody, and real
acceptance are established. Phone physical acceptance and installed native UI
acceptance remain distinct from browser or source checks.

Review the richer admission and automatic-scaling architecture before
implementing it. Ship the current bounded preference slice with source tests,
then verify the installed product and public
release separately; broader provider activation follows its actual human and
account requirements.
