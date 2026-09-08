# Findings

PR374 added bounded foreground contention waiting, not resident operation.
Prior installed acceptance was inert; a previous local-model calibration exists,
but its exact workload and limits must be inspected before claiming live readiness.

## Verified findings

- Campaign paused state combines explicit controls, clean withholding and uncertain
  results. An automatic restart policy must not classify from free-text reasons.
- Existing resource supervisor handles raw task queues, not frozen evaluator and
  campaign output/recovery. Do not bypass Universe by dispatching prompts there.
- Existing local observations have a five-minute maximum age. Codex quota refresh
  does not renew local health, so unattended local campaigns need explicit refresh.
- Read-only Ollama inventory verification succeeded this turn for qwen3-coder:30b
  at 127.0.0.1:11434, digest sha256:06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca.
  This was one inventory GET, not inference or proof of output quality.
- Prior two-generation local campaign is terminal; its observations are expired.
  Do not reset its one-use claim or treat it as currently running.

## Implementation contract

Campaign check reads one scoped store and returns typed recovery states and pinned
snapshot identities. It creates no records/locks and checks no provider readiness.
Runtime admission remains separately authoritative.

Optional private localModelConfigPath pins pool/bindings and exact local Ollama
model digests. Each generation takes one bounded sequential inventory pass before
a new resource task. No pull/load/inference/fallback or repeated polling probes.
Successful captures overlay only this invocation; file denials and uncertainty
remain independent vetoes. Failed or expired captures withhold managed capacity.
