# Findings

PR373 provides optional one-pass pinned quota refresh before resource generation.
Same-root concurrent collectors currently refuse; capacity withholding pauses
campaigns. Inspect existing primitives before choosing bounded waiting or shared
collector lifetime. Preserve task identity and monotonic owner deadlines.

## Chosen contract

User explicitly selected bounded waiting. The private runtime accepts optional
capacityWaitMs from 0 to 60000; omission and zero retain legacy behavior. A positive
value establishes one monotonic pre-admission allowance for the collector and
worker stages. Existing outer generation deadlines remain authoritative.

Wait only for verified live collector ownership or otherwise eligible reserved
worker capacity. Unknown ownership, retained pending fences, uncertain receipts,
quota/task denials, stale evidence and cancellation are not capacity to reclaim.
Polling is read-only and asynchronous. Capture quota once, not once per poll.

One immutable resource task survives an explicit no-receipt admission race. Any
receipt or exception ends retries; existing own identities can reach atomic
replay/conflict after expiry but cannot recover output or create a new dispatch.
Keep invocation vetoes bounded by enrolled workers, including denials observed
during waiting. Only managed captures may overlay the latest observation file.

No persistent queue, fairness guarantee, live queue metrics, or hard provider-start
timestamp is claimed. No UI or public receipt schema changes are needed for this
increment. The installed offline fixture tests packaging, not account activation.
