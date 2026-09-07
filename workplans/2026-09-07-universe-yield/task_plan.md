# Universe yield runtime continuation

## Goal

Advance unattended, useful engineering yield using the existing Universe runtime and graph evidence; implement a bounded complete increment with local verification and truthful release status.

## Phases

- [x] Re-establish exact merged source, preserved worktree, memory, and Entire context.
- [x] Parallel exploration of campaign scheduling, evidence-driven yield, and release constraints.
- [x] Choose a scoped implementation using existing contracts; record detailed plan.
- [x] Implement independent workstreams with regression tests.
- [x] Independent review and local source verification.
- [ ] Exact clean-source packaging, publication of source, and external handoff.

## Decisions and boundaries

- Begin from merged graph PR #357, master d5cda0d9c7a7495720c7f95cd48d933c93261c03.
- No GitHub Actions, provider/account changes, resident service activation, or default-store mutation during tests.
- Preserve the primary Desktop checkout and existing unrelated work.
- Existing non-eve runtime stays in place; no framework/database rewrite.
- Graph observation is not scheduling authority or production acceptance.

## Open questions

- Which existing campaign/runtime gap gives the largest verified improvement in unattended engineering yield?
- Can this increment be validated with deterministic fixtures and an offline installed package?

## Implementation plan

1. Add a strict bounded portfolio manifest: explicit campaign IDs and dependency edges, maxParallel (1-8), per-invocation maxDurationMs (up to 24h), no implicit inventory discovery. Validate duplicate IDs/edges, unknown dependencies, cycles, and distinct Universes before any work.
2. Add a read-only plan projection from targeted campaign reads. It separates ready/waiting/completed/blocked/busy/unavailable nodes and provides deterministic topological order. A completed campaign satisfies ordering only, not accepted production value.
3. Compose existing runUniverseCampaign calls into a foreground concurrency-limited DAG runner. Revalidate pinned definition/manifest/comparator identities before dispatch, preserve campaign budgets, avoid automatic retries, cancel and await owned work on deadline/signal, and block descendants of unsuccessful outcomes while independent work can continue.
4. Add strict plan/run CLI plus public SDK exports and agent help/completions. No web dispatch or new scheduling authority; existing console continues to observe campaigns.
5. Test pure planning, scheduler concurrency/dependency/control/error behavior, native multi-Universe execution, and installed package interfaces. Update the canonical operator guide.

Portfolio manifests remain caller-owned files. Campaign ledgers are the durable state; rerunning the same manifest re-reads them without resetting budgets. Invocation concurrency is not a host-wide or provider quota. Initial degraded/missing selected evidence prevents all dispatch.

## Errors encountered

- Entire resume found no checkpoint on the prior or new branch.
- Two exploratory lookups used nonexistent script names. Installed smoke is in scripts/run-local-pack-smoke.mjs; real-I/O membership is in test/config/realio-lane-membership.mjs.
- TypeScript narrowed closure-mutated stop state incorrectly; final status reason selection now reads the typed result.
- Independent review found that a pre-start snapshot alone did not exclude a late owner pause. Startup now uses a compare-and-append checkpoint inside the existing control transaction; native and injected-boundary regressions passed.
- Native degraded-ledger fixture initially used the wrong test-owned filename; corrected to ledger/records/00000000.json, then passed.
- Documentation audit separated plan exit semantics from run completion semantics.

## Status

Source verification complete: 639 Universe/package checks, 210 web tests, 449 invariants (5 existing skips), TypeScript, lint, build, and whitespace checks passed. Preparing clean commit; final artifact and source publication evidence belongs in the external post-commit handoff.
