# Dots beside Ashlr Verse

Verified against official OpenAI documentation on **2026-09-30**. This guide
describes an operator workflow and a proposed connector. No Dot, account,
plugin, schedule, or remote connection was activated by this work.

Dots can coordinate engineering work through ChatGPT, use enabled supported
plugins, and delegate tasks. OpenAI describes Dots as powered by GPT-6 Astra
with a cloud computer; access is rolling out by account. This does not add a
Dot engine, CLI seat, observed quota, or GPT-6.1 model entitlement to Verse.
Delegated Codex and Work tasks use their own product limits. Check availability
in the actual account before planning capacity. [Meet dots](https://learn.chatgpt.com/docs/dots)

## Use the companion today

1. Open Dots in ChatGPT and choose the intended account/workspace. Enable the
   GitHub or other supported plugins needed for the task and verify their
   tools actually work. A plugin listing alone does not establish a working
   account connection. [Build plugins](https://learn.chatgpt.com/docs/build-plugins)
2. To delegate into this Mac, connect it from **Computers → Your computer →
   Allow access**. The documented limit is currently one connected personal
   computer; the Dot's cloud computer remains separate. Local skills require
   the connected computer. Cloud browser sign-ins do not inherit Mac sessions.
   Do not export native subscription credentials to the cloud computer.
   [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)
3. Give the Dot an exact repository, task, branch, and acceptance criteria.
   Local Codex/Work delegation needs the connected computer online with
   ChatGPT open. Already-configured Codex cloud environments can run new cloud
   coding tasks while that computer is off. Continuing an existing task uses
   its original environment; changing the connected computer does not move it.
   [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)

For **Work with me**, use a task such as:

> Continue my existing Codex task named `<exact title>` for `<repo>` at
> `<branch and full SHA>`. Help investigate `<problem>`, propose the smallest
> complete fix, and return the changed files and acceptance evidence. Keep
> the implementation in that task so I can steer it there.

For **Work for me**, make the continuing responsibility concrete:

> Coordinate `<named repo/task>` until `<acceptance criteria>` are met. Use
> the connected computer's Codex tasks for implementation and enabled plugins
> for source evidence. Follow my existing authorization for this task and
> the repository's account, spend, signing, and Stop boundaries. Notify me
> when complete, blocked, or a decision needs me; cite the exact source SHA
> and separate source, installed product, and public release evidence.

Specify any schedule's timezone, end condition, and notification destination;
confirm it was saved. For event-driven work, ask which events the connected
service supports and confirm the subscription. A connected service does not
automatically monitor events. Inspect delegated tasks in Activity. New tasks
receive their assigned context, rather than every prior conversation.
[Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)

An ongoing scoped instruction can authorize future work within existing
permissions; extra confirmation for every action is not necessary by default.
Custom rules do not grant new access. Pause the Dot, stop delegated Activity,
and cancel schedules separately when stopping the whole workflow. Stopping
does not undo completed actions. [Controls](https://learn.chatgpt.com/docs/dots/controls)

## What the Hub currently implements

The [Grok companion guide](https://github.com/ashlrai/ashlr-hub/blob/master/docs/GROK-BOT-COMPANION.md) documents manual reviews and an
optional provider webhook handoff. It explicitly distinguishes acceptance
from completion and does not implement a two-way Hub Bot connector. Dots can
serve the same companion role through its supported task delegation; a Grok
webhook URL cannot be reused as a Dot trigger.

| Existing surface | Actual contract | Dots implication |
| --- | --- | --- |
| Verse agents API | Local workbench reads and operator-gated mutations; no Dot backend | Local Codex tasks may use the workbench under existing permissions; cloud access needs its own connector |
| Verse agent-tools MCP | Per-turn bearer, live chat scopes, revocation on turn end/Stop | Unsuitable as a persistent external subscription credential |
| Verse MCP protocol | Lists `2026-07-28`, but handles only initialize, ping, and tool methods | Does not implement `server/discover` or MCP Events |
| Automations webhook | Loopback-only, bounded strict payload, operator mutation gate | Not a public ChatGPT callback or an authenticated cloud ingress |
| Hub MCP gateway / Ashlr Plugin | Local stdio tool surfaces | Installed tools are not automatically enabled ChatGPT plugins or Dot connections |

These claims come from [agents-api.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/agents-api.ts),
[verse-mcp.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/verse-mcp.ts),
[verse-mcp-grants.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/verse-mcp-grants.ts),
[automations-api.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/automations-api.ts), and
[mcp-gateway.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/mcp-gateway.ts). No live Dot transport was tested.

## Supported programmatic paths

The cited personal-Dots guides do not document a general API to create Dots,
send arbitrary messages, poll their conversations, or import their usage.
This is not a claim that OpenAI has no agent APIs: the separate **published
Workspace Agents API** provides a trigger endpoint, idempotency, and beta run
status. It requires its own access token and API channel. Its documentation
currently says agent response retrieval is unavailable. Do not represent a
workspace agent trigger as a personal Dot seat or a completed review.
[Workspace agent runs](https://learn.chatgpt.com/workspace-agents/trigger-runs)

For event-driven coordination, ChatGPT supports **MCP 2.0 Events**. An
authenticated plugin exposes discovery plus `events/list`, `events/subscribe`,
and `events/unsubscribe`. The user requests monitoring; ChatGPT supplies a
callback and signing secret. The server verifies a public HTTPS callback,
persists the scoped subscription, and signs event deliveries. A successful
delivery acknowledges receipt, not completed work. Refresh, revocation,
unsubscribe, replay policy, idempotency, and bounded retries belong to the
connector. [MCP Events](https://developers.openai.com/plugins/build/mcp-events)

## Next implementation slice

Build a separate authenticated **read-only fleet evidence plugin** with
`fleet_status` and `review_evidence` tools and a `fleet.review_ready` event
filtered by repository/PR. Reuse existing projections; report exact head SHA,
check identifiers, and evidence freshness. The ChatGPT-facing connection
requires **user OAuth 2.1 authorization code with S256 PKCE**. Validate token
issuer, resource/audience, expiry, and scopes on every request, and use the
redirect registered for the actual connection. ChatGPT cannot substitute a
customer API key or a machine-to-machine/service-account grant for this user
flow. [Plugin authentication](https://developers.openai.com/plugins/build/auth)

A dedicated revocable service identity may broker internal upstream reads;
it does not authenticate ChatGPT to the plugin. Exclude phone pairing, UI
cookies, turn/mutation tokens, raw transcripts, grants, and credentials from
this external surface. Event payloads are untrusted data, never authority.
Keep dispatch behind the existing local/signed execution paths.

Acceptance must cover cross-account isolation, callback SSRF/redirect refusal,
signature verification, duplicate/out-of-order delivery, restart/expiry,
revocation, and cancellation. Prove one real subscribed ChatGPT event is
received; separately inspect the resulting delegated task and output. Do not
claim a completed integration from a webhook acknowledgment.

Developer testing can use a configured Secure MCP Tunnel; publication requires
a public HTTPS MCP endpoint. Connect, inspect discovered tools/events, and
exercise both successful and refused requests in the actual account before
showing **Connected** in Verse. A locally installed stdio server is only the
starting transport. [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
