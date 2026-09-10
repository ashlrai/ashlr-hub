# Durable controller drain and resume

Base: `03935faca4f901e295fa08a35dab3b048f75061e`. Implement in the isolated
`codex/universe-controller-drain` worktree; preserve existing working directories.

## Contract

- Store control and drained-acknowledgement records in the existing immutable
  controller ledger. Older histories default to open admission. Older binaries
  reject new event kinds rather than ignoring an owner control.
- Serialize every ledger append with a short `.control.lock`, separate from the
  lifetime `.execution.lock`. The final intent append and drain request share
  this transaction. Never await a worker or delivery while holding it.
- A drain forbids later intents. Earlier intents remain admitted and may finish
  their campaign and already-planned delivery. Cancellation and deadlines retain
  their existing priority; drain itself never aborts active work.
- A controller acknowledges drain only after all durable intents have settled.
  Unresolved crash evidence cannot be relabelled drained just because the local
  active-worker map is empty.
- Resume requires the exact acknowledged drain sequence, changes admission only,
  and starts no process. Repeat the original manifest/runtime configuration to
  run the preserved queue. No budget, deadline, held outcome or dispatch identity
  is reset. A draining invocation exits even if a resume arrives before exit.
- Control receipts distinguish a persisted request from a drained acknowledgement.
  Read-only status never acquires locks or repairs storage.
- Runner refresh accepts only an unchanged history prefix plus valid external
  control records. Changed or incomplete history fails closed. Verified short
  transaction contention waits within the original deadline.
- Reserve control/acknowledgement capacity alongside settlement capacity. Never
  discard staging, infer free ownership from age, or initialize missing targets
  through a control command.

## Workstreams

1. Store agent: event types, parser/fold, transaction lock, append/CAS, control
   receipts, capacity and focused storage/race tests.
2. Runtime agent: bounded transaction waiting, control-aware snapshots, drain
   admission/acknowledgement, restart/status and focused controller tests.
3. Native agent: separate CLI drain/resume, active delivery, preserved pending
   queue, native restart, exact deadline and deterministic ordering acceptance.
4. Primary: CLI commands and validation, public exports, documentation, integration,
   independent review and local verification/publication evidence.

## Acceptance

Verify both drain-before-intent and intent-before-drain orderings; complete active
delivery while drained; preserve queued campaign bytes; require matching resume;
retain original deadlines; refuse malformed/staged/changed history; keep unknown
attempts unresolved. Run focused and adjacent native tests, full source/web type
checks, lint, docs and build locally. No GitHub Actions, subscription activation,
personal-account allocation changes, resident service or registry publication.
