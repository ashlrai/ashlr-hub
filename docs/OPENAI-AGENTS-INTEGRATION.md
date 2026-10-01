# Managed OpenAI Agents API integration

Verified against official documentation on 2026-09-30. This document covers the managed **Agents API**, distinct from the Agents SDK and Ashlr's existing Codex CLI/subscription integration.

## What this release implements

The managed API hosts an agent harness with durable sessions, turns, recovery and environment management. Ashlr now exposes a **read-only inventory foundation**:

```sh
ashlr openai-agents sessions --limit 20 --json
ashlr openai-agents inspect <session-id> --json
ashlr openai-agents turns <session-id> --limit 20 --json
ashlr openai-agents sessions --after <nextCursor> --limit 20 --json
```

These commands use host-held `OPENAI_API_KEY` only when a read executes. Configure the variable through your existing secure environment/provider setup; never place keys in command arguments or chat. Help and invalid arguments perform no credential lookup or network request. Missing authentication gives setup guidance without asking for plaintext credentials. No key is stored, sent to an executor, or exposed in output. This release adds no SDK dependency or startup connection probe.

Every call is one GET to `https://api.openai.com/v1/agents/sessions` or an ID-scoped session/turn endpoint, with `OpenAI-Beta: agents=v1`. Redirects are refused. Limits are 1–100 records per page, 2 MiB per response and 15 seconds across headers/body; declared or streamed overflows fail explicitly. `hasMore` and `nextCursor` preserve partial inventory, rather than silently truncating it. Errors are categorical; raw provider response bodies and transport exception messages are withheld. [Session list reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/list), [session retrieval](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/retrieve), [turn list reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/turns/methods/list).

Output projects only session ID, creation timestamp, status, agent ID/model and required-action count; turns project IDs, timestamps, status and root/subagent attribution. Instructions, inputs, outputs, tool arguments, environment configuration, files and error messages are excluded. JSON results explicitly contain `readOnly:true` and `executionQualified:false`. Session `idle` does not prove environment readiness; turn `completed` does not prove every tool succeeded or a change was accepted. Usage is not reported by this slice, rather than inventing zero token use. [Session contract](https://developers.openai.com/api/docs/guides/agents-api/sessions), [error and completion semantics](https://developers.openai.com/api/docs/guides/agents-api/errors).

This is not a connected fleet seat, autonomous dispatch, event stream, conversation import or personal Dot controller. It has no create/input/steer/cancel/approve/download operation. Successful inventory access does not qualify a model, environment, account or standing grant for execution.

## Provider contract and access boundaries

The official Python/TypeScript clients expose `beta.agents.sessions`; OpenAI manages orchestration, context compaction and recovery. API inference/tools/container charges are separate from ChatGPT or Codex subscription access. Ashlr's existing `codex exec` lane remains distinct. Existing signed metered-spend limits must not be enlarged to accommodate this integration. [Overview](https://developers.openai.com/api/docs/guides/agents-api/overview), [architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture), [quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart).

`gpt-6.1-sol` is an official API model identifier. Its appearance in native account catalogs or these session metadata does not establish permission to create managed sessions with it. Managed-session/model qualification still requires the intended project, API access and an explicitly authorized live test. Supported reasoning efforts must follow the selected model's contract. [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [agent configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration).

Managed sessions currently use US data residency and are not eligible for Zero Data Retention, including sessions with self-hosted execution. A model's broader residency availability does not expand this service contract. [Environment security](https://developers.openai.com/api/docs/guides/agents-api/environments/security).

Personal Dots and workspace-agent controls have separate documented surfaces and qualification requirements. The read-only managed API command does not inherit their identities, subscriptions, conversations or permissions. See [Dots companion integration](DOTS-COMPANION.md) for those contracts and remaining gates.

## Concrete next adapter slice

Ashlr's [src/core/verse/adapters/codex.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/adapters/codex.ts) parses CLI JSONL; [src/core/verse/session-store.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/verse/session-store.ts) stores local chat events; [src/core/run/engine-registry.ts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/run/engine-registry.ts) registers CLI agents and OpenAI-compatible model endpoints. A managed-session harness cannot be treated as a Chat Completions model endpoint. The new [contracts](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/openai-agents/contracts.ts) and [client](https://github.com/ashlrai/ashlr-hub/blob/master/src/core/openai-agents/client.ts) boundary can support a later explicit managed adapter, but currently exposes metadata reads only.

The next implementation should preserve provider session/turn/item/event identity and root/subagent attribution. Open a stream before sending input. Active-session input can steer a turn; idle input starts a turn. Text deltas append, whereas final text events replace accumulated text. Reconnect by buffering a new stream, reading current state/saved items and restoring pending actions from current `required_actions`; do not replay input or approval merely because transport was lost. Stream closure or idle state is not success. [Session events and reconnect](https://developers.openai.com/api/docs/guides/agents-api/sessions/events).

Before any mutation, add an explicit API account/profile identity, signed repo/model/spend/environment scope, revocation and kill checks, pending-action approval custody, durable outcome reconciliation and deployment gates. The provider error guide does not establish an idempotency contract for ambiguous creates or inputs: do not blindly retry them. Test disconnect-after-acceptance and external-effect reconciliation before fleet admission. [Errors and recovery](https://developers.openai.com/api/docs/guides/agents-api/errors).

Self-hosted execution uses OpenAI's harness with `codex exec-server` in an isolated executor. Keep the application key outside that environment. The documented executor key has restricted environment connection permissions and must share the application's organization/project/principal; this is not a reason to copy personal OAuth credentials or the application key into a sandbox. Egress includes the official API and executor WebSocket control host. A separate host-held broker remains necessary for third-party credentials. [Self-hosted environment contract](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted).

Hosted artifacts are immutable published copies associated with completed turns; metadata and downloads are separate. Self-hosted files remain in the selected executor/provider filesystem rather than automatically becoming hosted artifacts. Later downloads require enrolled-repo/path confinement, byte budgets and explicit custody. [Files and artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files).

Managed subagents share their session's execution environment/filesystem; enabling them does not provide independent isolation. Keep coordinator/subagent IDs and observed tool outcomes separate. Usage is best-effort, may arrive later and is not an invoice; report nullable coverage and measured matched-task comparisons rather than assumed token savings from persistent sessions. [Multi-agent contract](https://developers.openai.com/api/docs/guides/agents-api/multi-agent), [observability](https://developers.openai.com/api/docs/guides/agents-api/observability).

## Acceptance

[Read-only contract tests](https://github.com/ashlrai/ashlr-hub/blob/master/test/openai-agents-read.test.ts) uses injected transports and fake provider contracts. It verifies fixed GET/header/redirect behavior, credential laziness, strict identity/pagination/status/timestamp validation, partial/empty distinction, response and deadline bounds, cancellation, safe errors/key-echo rejection, CLI discovery and refusal of unsupported actions. It makes no provider calls and establishes source behavior only. Real API access, live managed-model qualification, dispatch, recovery, artifacts and resident activation remain separate acceptance steps.
