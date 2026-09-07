# Resource-balancer evidence notes

## Verified starting state

- Primary Desktop checkout remains on `codex/v333-iteration` at `a01fc08663baab3039c4f1c084538de732a4fd0e`; unrelated untracked workplans preserved.
- Implementation worktree was clean after PR 363. New branch starts from fetched origin/master.
- Installed command versions: Codex CLI 0.136.0; Claude Code 2.1.257. Version/help inspection only.

## Evidence gaps

| Claim family | Current evidence | Confidence / next action |
| --- | --- | --- |
| Existing resource routing and Universe integration | Legacy routing and Universe measured-feedback contracts mapped | New optional foreground tasks; old generation/evaluation unchanged |
| Codex quota/auth protocol | Official App Server and installed exec help inspected | Explicit native payload normalizer; no polling or credential mediation |
| Claude Code quota/auth protocol | Official docs and SDK event schema inspected | Fable shares weekly Max limit; extensible bucket observations; no paid fallback |
| Concurrency, reset, cancellation, persisted evidence | Final 662 passed, one Windows-only skip across 15 files | Includes overflow regressions; exact package acceptance follows commit |
| Live multi-account operation | Not tested; no credentials or providers activated | Must not claim acceptance |

## Research stop condition

Stop discovery when consequential adapter and scheduler contracts have primary support or an explicit limitation, and another query is unlikely to change implementation scope. Preserve unsupported multi-account or quota assumptions as gaps.

## Implemented contract

- Strict pool/binding/task inputs; explicit independently authenticated native workers or numeric-loopback local text endpoints.
- Provider-window intersection, reserve policy, freshness, failure cooldown, declared shared capacity groups, rolling task caps, and atomic durable admission.
- No credential discovery/switching, quota bypass, invented usage, or automatic paid fallback. Native provider limits remain enforced independently.
- Durable receipts before launch and no automatic duplicate execution, even after restart. Token reporting is transport evidence, not acceptance or measured value.
- Raw output saved only to a new explicit private file; ledger contains fixed metadata and digests only.
- Unknown quotas require explicit operator-capped enrollment; known denial is never erased by missing or partial refreshes.
- Independent review found an evolving-bucket union overflow. Fixed with a bounded sticky refusal marker and full observation validation before every ledger write; ordinary refresh cannot recover dropped inventory.

## Verification boundaries

All tests use deterministic fixtures, inert native wrappers, local filesystem, or test-owned loopback servers. Full typecheck passed; lint has zero errors and 106 preexisting warnings. The existing Windows-only identity test is skipped on macOS. Package acceptance and source publication are separately recorded after build; none of these results proves live accounts, customer acceptance, autonomous engineering yield, registry publication, or resident activation.

Final combined command uses pinned Node 24 and Vitest with `--no-file-parallelism`,
covering all six `resource-*` files, existing m43 subprocess, m526 execution identity,
m250/m306 resource routing, and Universe model, file-operation, campaign, and
confinement integrations. Result: 662 passed, one platform skip, 15 files, 73.31s.
Backend/frontend typecheck, changed-file ESLint, diff check, and real-I/O membership
were rerun after the final normalizer/runtime overflow fix and passed.
