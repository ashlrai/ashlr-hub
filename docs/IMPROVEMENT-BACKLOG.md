# Ashlr Ecosystem Improvement Backlog

> Maintained by the autonomous improvement loop (deep-map → prioritize → build-verified waves → commit green).
> Prioritized value × low-risk. Started 2026-06-28. Maps: ✅ ashlr-hub, ✅ apps/lib (6 repos), ⏳ agent-tooling, ⏳ security/infra.

## Hermes-inspired patterns (verified-real product, NousResearch; metrics held skeptically)
- Closed self-improvement loop (auto-create skills from completed tasks, refine on reuse) → fleet self-improving/genome
- Hibernating serverless backends (sleep idle, wake on demand) → multi-backend fleet cost
- One gateway, many surfaces (Telegram/Slack/CLI → one agent) → comms + Pulse split
- Diff/PR-as-unit-of-work · repo-map grounding · interrupt-and-redirect (cross-verified staples)

## ashlr-hub (the fleet) — top opportunities
1. ✅WAVE1 M198 — M29 digest store debt (mkdir handling + dedup emptyPortfolio)
2. ✅WAVE1 M197 — daemon/inbox/web observability (8+ silent catches → structured logging; additive, h-series-safe)
3. ✅WAVE1 M199 — orchestrator.ts integration tests (2325 LOC, was ZERO tests — CRITICAL gap)
4. ✅WAVE1 M200 — multi-backend merge-gate tests (NIM/Kimi had no coverage)
5. Dual-router audit (run/router vs fleet/router — reconcile/document scope)
6. require()-in-ESM cleanup (formalize ESM-only; bit north-star/vision-approve/config)
7. daemon/loop.ts (1424 LOC) integration tests (critical path, ZERO tests)
8. Cascade M155 auto-rollback (deferred); browser-verify M171 edge-case tests

## Cross-ecosystem (from the apps/lib map — committed LOCAL in each repo, not pushed)
- **ashlr-pulse** (highest-leverage integration): realtime event push (Supabase Realtime → live fleet dashboard); fleet-event bidirectional sync (Pulse as the fleet's nervous system); materialized peer-share-safe views; add a test harness. **Make the fleet emit to Pulse.**
- **morphkit** (highest debt): decompose the 5078-LOC SwiftUI generator into layout modules; validateSemanticModel() fail-fast; AI→heuristic fallback + LRU cache; kill 223 `any` casts.
- **prompt-trackr** (0.7% coverage): API integration tests (revenue-critical); refactor sync/route.ts; extension test harness; heuristic edge cases.
- **ashlr-md**: component test harness; export E2E; MCP bridge event-flow tests.
- **webfetch**: ProviderReport errorKind enum; pHash {hash,algorithm,confidence}; metadata confidence calibration; rate-limiter observability.
- **ashlr-core-efficiency**: genome fitness robustness tests; manifest atomic-write safety; embeddings cache validation; compression tier-ordering integration test.

## Wave tally
- **Wave 1 (in flight):** M197 observability · M198 digest debt · M199 orchestrator tests · M200 multi-backend merge tests (all ashlr-hub, build-verified, commit-green).
- (next waves appended here as they ship)

## Loop guardrails
build-verify + auto-revert · commit green only · never break a working repo · never touch ashlr-plugin runtime or hub safety-gates riskily · no npm publish · push only ashlr-hub · other repos commit-local for review.
