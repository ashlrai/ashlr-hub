# Reliability findings

Previous real native probe admitted Codex at 8% used with a 10% reserve. Its
first read-only benchmark task failed after 5.845 seconds; zero cases were
evaluated and no usage was reported. Hub retained only `worker-exit-failed` and
discarded exit/signal/stderr details. Supported flags and a valid Git workspace
were confirmed, but the underlying cause was not established.

Previous two local Qwen generations failed their immutable evaluator. Their
failed attempts, feedback and tokens remain evidence, not accepted improvements.

## Current findings

- One freshly admitted read-only diagnostic established the old CLI/model
  incompatibility: Codex 0.136.0 returned a structured HTTP 400 rejection saying
  the configured model requires a newer CLI. Exit 1, no signal; no measured usage.
- The installed desktop app includes Codex 0.153.4. A separate private enrollment
  passed local flag inspection but its metadata probe failed protocol validation
  before any model call. Metadata compatibility is being investigated without
  changing account, model, global installation, or reserve.
- Added optional, browser-safe native process metadata with strict ledger and
  transport validation. Unknown legacy values remain unknown; no raw output is
  persisted in the receipt or automatically fetched by the new inspector.
- Confirmed and corrected a storage admission gap: a reservation could fit while
  its eventual receipt would not. Pre-contact admission now budgets bounded future
  settlement and quota metadata for all pending reservations.
- User selected single-computer unattended reliability as the next milestone.
- Newer native metadata diagnosis: a no-id startup notification adds `emittedAtMs`.
  The parser now accepts only an optional nonnegative safe-integer timestamp on
  notifications. Server requests, unknown keys, invalid account/quota evidence,
  and account changes still fail. Emission time never refreshes quota evidence.
