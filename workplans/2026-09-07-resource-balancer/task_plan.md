# Task plan: Account-aware engineering resource balancing

## Goal

Connect a local-first resource scheduler to Hub/Universe execution, maximizing verified useful engineering work per token and hour across explicitly configured Codex, Claude Code, and local resources. Preserve separate account limits, authentication, reservations, and evidence rather than inventing a shared token budget.

## Scope and assumptions

- Existing Hub and Universe TypeScript runtime; no framework migration.
- Research current official provider documentation and installed CLI contracts; do not inspect credential contents or call undocumented quota endpoints.
- Source changes, deterministic local acceptance, and local release validation are in scope. GitHub Actions, registry publication, resident activation, credential changes, and paid provider requests are excluded.
- Unknown, stale, exhausted, or mismatched quota evidence must remain distinguishable. Subscription usage is not an API token allowance.
- The user's objective remains verified engineering yield. No unmeasured claim that a model, account, or local resource is optimal.

## Phases

- [x] Discovery: mapped existing routing, quota, generation, and provider interfaces with three independent agents.
- [x] Follow-up: primary sources establish native CLI interfaces and incomplete quota visibility; architecture question sent asynchronously.
- [x] Synthesis and implementation: separate explicit foreground resource tasks, without changing Universe replay or shadow authority.
- [ ] Verification and delivery (in progress): independent acceptance, focused and adjacent tests, typecheck, lint, package checks where applicable, exact release state.

## Questions

1. Which observed load-balancer project inspired the request? Its name/link is optional; official support is authoritative.
2. Can configured account resources be bound to independently authenticated workers without Hub manipulating credentials?
3. Which executable seam produces immediate value while preserving Universe's measured-feedback invariants?

## Decisions and errors

- 2026-09-07: Clean worktree branched from origin/master as `codex/universe-resource-balancer`; Entire resume found no checkpoint.
- The requested `update_plan` tool is unavailable in tool discovery (checked by name and description). This persistent plan is the fallback.
- Initial combined skill output was truncated; required skills were reread fully before applying their workflows.
- A discovery search included nonexistent `src/core/providers`; inspect actual provider layout instead.
- Scope decision: an explicit foreground resource-task pool is independent from the legacy daemon and Universe's local-chat receipt. Native workers remain unmodified owner-authenticated CLI commands; Hub never reads or switches their credentials. No API proxy or service activation.
- Optional unknown-quota admission must be explicitly configured and operator-capped; known exhaustion cannot be converted to unknown to bypass it. Provider limits remain independently enforced by each native tool.
- Assignments are durable before launch, concurrency is tracked across processes, and ambiguous attempts remain occupied rather than silently replaying after a lease timeout.
- Verification of a worker result is not verification of a useful engineering change. Universe's fixed evaluation/archive stays unchanged.

## Status

Implementation and independent source review complete. Final combined verification:
662 passed across 15 files, one Windows-only skip. Full backend/frontend
typecheck passed. Full lint passed with 106 existing warnings and no errors;
real-I/O registration passed. Overflow regressions passed in both provider normalization
and native task settlement. Exact installed-package acceptance and source publication
are the post-commit delivery steps; their immutable evidence is emitted separately.
No provider executions, account changes, or production activation.
