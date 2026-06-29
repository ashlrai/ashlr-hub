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
- **phantom-secrets** (Rust): `phantom init --empty` + auto-init-on-first-add (the UX gap hit this session); `phantom import-env --stdin/--clipboard`; body-scope allowlist via .phantom.toml; auto-rotation warning; response-scrub visibility.
- **binshield** (HIGH-VALUE SECURITY): path-traversal hardening in tarball/zip extraction (RCE vector — validate realpath within extractDir / strip-components); Rizin graceful fallback; dynamic threat-pattern versioning; PyPI dependency extraction; job retry + circuit breaker.
- **stack** (Bun): provision timeout/cancellation guards (can hang indefinitely — critical reliability); complete healthcheck() across all 41 providers; multi-provider orchestration groups; provision-opts validation; provider codegen.
- **ashlr-plugin** (4244 tests, sound): snipBytes factory (8-12% token lift); recordSaving consolidation; genome-format wrapper; handler base class. (Session-critical — provides live ashlr__ tools; do cautiously / defer.)
- **ashlrcode** (`ac`): deepen ac-wave hook wiring; file-tools shared util; smarter surgical mode (intent-aware scope + file-count guard); extract @ashlr/buddy; simplify KAIROS/autopilot.
- **ashlr-workbench** (0 tests): shared scripts/lib/config.sh (kill 19+ hardcoded refs); integration test suite; atomic config-sync; LM-Studio probe backoff; MCP runtime validation.

**ALL 4 MAPS COMPLETE (2026-06-28).** ~60 opportunities across 13 repos. Highest-value safe picks for upcoming waves: binshield path-traversal (security), stack timeout guards (reliability), phantom init-UX, ashlrcode smarter-surgical, + ashlr-hub test-coverage gaps (daemon/loop, orchestrator).

## Wave tally
- **Wave 1 ✅ SHIPPED (ashlr-hub):** M197 observability (20 silent catches→logging) · M198 digest debt · M199 orchestrator tests (was 0) · M200 multibackend merge tests. Commits f539ced/6a8e063.
- **Wave 2 ✅ MOSTLY SHIPPED:** binshield path-traversal SECURITY hardening (committed in binshield, 41/41, real RCE-vector closed) · BUG-2 evaluateVerificationGate EDV-cfg + landed latent pulse-exporter/dep-parser landmine + health.ts WorkSource fix (ashlr-hub 13f37e6 — recovered a red master from a partial commit) · m201 daemon tests (32/33, last test settling) · stack timeouts + phantom init-UX AUTO-REVERTED (builds didn't pass — safety bound worked; deferred).
- **Wave 3 (in flight, cross-repo commit-local):** ashlrcode smarter-surgical (intent-aware scope + file-count guard) · core-efficiency genome robustness tests · webfetch ProviderReport errorKind · morphkit validateSemanticModel fail-fast.
- **Wave 3 ✅ SHIPPED (cross-repo commit-local):** ashlrcode smarter-surgical (intent-aware scope + file-count guard) · core-efficiency genome robustness tests (43, found 3 bugs) · webfetch ProviderReport errorKind (100d761) · morphkit validateSemanticModel fail-fast (3b0edff) · m201 daemon/loop tests now GREEN (ashlr-hub 3fa416c, found a loadConfig-strips-cfg.daemon bug).
- **REGRESSION caught+fixed:** my publish-prep (main→dist + exports={".":...}) broke @ashlr/<pkg>/<subpath> imports → ashlrcode/morphkit builds failed. Reverted all 5 packages to src-based exports + subpath wildcard; ashlrcode builds clean again (1068 modules). LESSON #2: don't change package exports without re-verifying CONSUMERS.
- **Wave 4 (in flight):** prompt-trackr API tests · ashlr-md MCP-bridge+export tests · ashlr-hub M202 cascade+browser-verify edge tests · core-efficiency atomic-cache + timeout-leak fixes. (Conservative/test-heavy after 2 self-inflicted regressions.)
- LESSON #1: commit the FULL related file-set (partial BUG-2 commit → red master, recovered).
- QUEUED BUGS (found, unfixed): loadConfig strips cfg.daemon per-tick (isContinuousMode gap); core-efficiency lock-map churn; router.ts nim-type-smell.
- DEFERRED: stack timeouts + phantom init-UX (auto-reverted, retry); ashlr-pulse fleet-emit (high-value but daemon-adjacent — defer given churn); npm publish (needs proper multi-file dist + subpath exports→dist, Mason).
- **Wave 4 ✅ (mixed):** core-efficiency atomic-cache + timeout-leak fixes (9bdc997, fixed the 3 wave-3-found bugs) · ashlr-hub M202 cascade+browser-verify edge tests (b5d67a4, 44) · morphkit/binshield build-recovery (cli-common file-subpath exports fix). prompt-trackr + ashlr-md test agents AUTO-REVERTED (test-harness setup issues — bound worked, deferred).
- **Wave 5 (in flight):** router nim-type-smell fix (ashlr-hub) · binshield Rizin graceful-fallback · webfetch rate-limiter observability · stack healthcheck() completion. (Additive/low-risk.)
- RUN SUMMARY (so far): ~18 improvements shipped across the ecosystem (binshield SECURITY fix, 2 critical ashlr-hub test-coverage gaps closed [orchestrator M199 + daemon M201], robustness fixes, ac smarter-surgical, structured federation errors, bug-finds-and-fixes). 2 self-inflicted regressions (red master, exports) — both caught + fully recovered. Several agent auto-reverts (bound working). Master green throughout (after recovery).
- **Wave 5:** router nim-type fix (79fe5fb) + binshield Rizin fallback (1e820d5) SHIPPED; webfetch rate-limiter + stack healthcheck landing.
- **Wave 6 (in flight):** phantom init-UX retry · ashlrcode file-tools refactor · ashlr-pulse test harness · prompt-trackr scoring tests · ashlr-md MCP tests · ashlr-hub loadConfig cfg.daemon fix (careful).
- (next waves appended here as they ship)

## Loop guardrails
build-verify + auto-revert · commit green only · never break a working repo · never touch ashlr-plugin runtime or hub safety-gates riskily · no npm publish · push only ashlr-hub · other repos commit-local for review.
