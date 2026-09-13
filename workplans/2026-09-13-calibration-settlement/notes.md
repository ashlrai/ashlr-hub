# Findings

The fixed evaluator authenticates schema-two activity with an invocation-private key. The old calibration driver calls inspectBuiltinActivity without that key after completion, which necessarily refuses schema two.

The new guard compares the returned capture with readUniversePreparationMeasurementCapture, including exact intent and receipt. It requires a newly recorded successful capture, verified identity, confirmed process-group settlement, and completed diagnostics when present. Legacy receipts without diagnostics retain their shape. Existing report/source/artifact and immutable replay checks remain.

Do not persist keys or reinterpret historical PID reuse. An authenticated in-process settlement and a durable receipt are different evidence layers; readback verifies retained evidence, not a new process observation.

Workspace follow-on: mission phases close the shared console, ordinary supervisor shutdown cancels active jobs, and predecessor checks refuse every unresolved shared-pool receipt. A persistent human workspace needs durable ownership attribution and separate mission lifetimes, not removal of the shared drain guard alone. No lifecycle change made here.
