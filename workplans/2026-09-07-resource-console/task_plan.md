# Resource pool operations console

## Goal

Deliver a distinctive, usable visual operations interface for Ashlr's resource
balancer and actual task instances, grounded in recorded and supervised state.
Continue toward autonomy through bounded execution, not fabricated live metrics.

## Phases

- [x] Explore existing console, frontend, session, resource, and verification patterns.
- [x] Confirm scope and contracts; review the design before implementation.
- [x] Implement independent UI, read-model/supervision, and server/CLI work streams.
- [ ] Verify focused and adjacent tests, browser behavior, and exact local package.
- [ ] Deliver source, artifact, evidence, and explicit remaining commissioning gaps.

## Working assumptions and questions

- Preserve the independent foreground resource-pool and Universe contracts.
- Never label an old reservation a currently live native process. Separate owned
  dispatch activity, durable occupancy, hypothetical routing, and accepted value.
- No GitHub Actions, credential discovery/switching, provider requests, global
  replacement, or resident activation during implementation and fixture acceptance.
- Optional user question: operational foreground queue with submit/pause/cancel
  versus monitoring first. Recommend the operational console given this request.
- New server authority must be explicit at startup and limited to the selected
  pool/workspace; do not expose general shell/path/config operations to the browser.

## Decisions and errors

- Started clean branch `codex/resource-pool-console` from origin/master
  `8422403e6ee75d53529ac330225869a0e9404c70`. Primary Desktop checkout unchanged.
- Entire resume found no checkpoint.
- Three agents independently exploring UI, evidence/runtime, and server acceptance.
- Frontend-design and React guidance inform a deliberate operations workspace;
  persistent planning and Hub verification guide implementation and acceptance.
- Build-agents guidance permits the established non-eve runtime; no framework,
  gateway, provider credential, or deployment migration is introduced.
- Operational-console assumption follows the user's requested functional/autonomous
  interface; optional scope question is outstanding, with this direction recommended.
- Use a separate `/resources/` entry, scoped session reads, a separate memory-held
  control token, and execution only when workspace+execution capability is supplied
  at startup. Existing read tickets remain GET-only; existing Universe stays read-only.
- Add bounded durable queued intents and instance-owned async dispatch, preserving
  queue/pause state across restart without replaying previously dispatching work.
  Keep raw task results bounded and session-local; status contains metadata only.
- Reuse the background read worker only for evidence reads, never model execution.

## Status

Implementation complete; independent review and real-HTTP acceptance passed.
Visual browser acceptance, final regression/build/package and source delivery remain.
No provider execution. Engineering-documentation skill governs canonical runbook
updates and separates implementation, local acceptance and commissioning claims.

### Resolved verification findings

- Protected pool/binding/observation files as well as the ledger from placement
  inside the selected writable workspace.
- Isolated task-ID conflicts from unrelated work and audited instance-owned
  uncertainty at shutdown, including dispatches no longer in the active map.
- Fixed a notification test's expired fixture clock without changing production.
- Initial search used a nonexistent resource type filename; used the actual
  pool-policy/worker contracts already established by acceptance tests instead.
