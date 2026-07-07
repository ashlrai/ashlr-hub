# CONTRACT-M334 — Dormant-flag activation program (gateway + concurrent dispatch)

Safe, staged activation of two flag-gated subsystems that have shipped dark:

- **M247 InferenceGateway** (`cfg.foundry.fabric.gateway`) — consolidates the
  double routeBackend + quota guard + subscription throttle + M53 block into
  one traceable decision.
- **M255/M256 Concurrent dispatch** (`cfg.foundry.fabric.concurrentDispatch`,
  `maxSlotsPerBackend`, `workhorseDispatch`) — parallel per-backend dispatch;
  the wall-clock multiplier that makes a fast Sonnet 5 workhorse (M321) and
  multi-model best-of-N (M333) pay off.

## Invariants (hold at every stage)

1. Proposal-only autonomy; frontier-only merge authority; kill switch; budget
   caps — none of these paths are touched by activation.
2. Shadow mode NEVER changes a routing decision — the legacy result always
   wins; the gateway runs observe-only beside it.
3. Outcome processing (ledger writes, `linkOutcome`'s in-place JSONL rewrite,
   inbox mutations) stays on the SERIAL side of the tick (M332 constraint).
4. Every default flip is a one-line, revert-friendly commit.

## Stage 1 — instrumentation (SHIPPED with M334)

- `fabric.gatewayShadow` flag: for each legacy-routed dispatch, run
  `gateway.decide()` observe-only and append a comparison record to
  `~/.ashlr/fabric/gateway-shadow-YYYY-MM-DD.jsonl`.
- `divergenceStats()` evaluates the exit criteria live (`src/core/fabric/
  gateway-shadow.ts`).
- `DaemonTick.durationMs` — tick wall-clock stamped by the recordTick funnel
  and exported as `ashlr.fleet.tick_duration_ms` on fleet.tick pulse spans;
  the stage-2 soak compares p50/p95 before/after enabling concurrent
  dispatch. (A dedicated per-tick concurrency-used counter was NOT added —
  `tick.backends` per-backend dispatch counts plus the wall-clock delta carry
  the same soak signal without new plumbing through the dispatch closure.)
- Concurrent dispatch: the m255/m256 suites already prove slot caps and
  flag-off byte-identity; m334 adds divergence-classification coverage.

## Stage 2 — supervised soak (OPERATIONAL, no code)

1. Enable `fabric.concurrentDispatch: true, maxSlotsPerBackend: 2` on the
   operator's own enrollment for ≥1 week. Watch: tick wall-clock p50/p95,
   proposals/tick, todaySpentUsd vs the serial baseline, judge-verdict
   distribution drift, 429/backoff counters. Zero h-suite regressions in CI.
2. Enable `fabric.gatewayShadow: true` until `divergenceStats()` reports
   ≥ **200 decisions**, divergence rate < **2%**, and **ZERO** safety-relevant
   divergences (gateway-would-dispatch where legacy blocked).

## Stage 3 — default flips (one line each, in order)

1. `concurrentDispatch` default → true (`maxSlotsPerBackend: 2`).
2. `gateway` default → true (one release later).
3. `workhorseDispatch` default → true with Sonnet 5 as the configured
   workhorse (M256 exists precisely for a fast, cheap frontier workhorse).

A failed criterion at any stage reverts the newest flip and returns to
stage 2 with the counter reset.
