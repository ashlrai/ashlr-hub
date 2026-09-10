# Controller owner-control acceptance

## Scope

Base: `2a6a29db175e8dab764221e666eb74c28f7c840e`. Work takes place in
`codex/universe-owner-control-acceptance`, separate from the user's existing
checkout. Verify existing cross-process owner controls before introducing a
new controller-wide control protocol.

## Implementation plan

1. Preserve the readiness reason after the existing completion-identity and raw
   record checks when a dispatched campaign settles without completing. Keep
   delivery-specific reasons and all existing scheduling decisions unchanged.
2. Test a real controller subprocess against a separate campaign pause/stop CLI
   process: acknowledge control, drain its worker, release leases, hold dependent
   work, complete independent work once, and preserve the deadline on restart.
3. Test real SIGINT and SIGTERM through the production controller CLI handler:
   await cancellation cleanup, return its documented exit code, and never replay
   held attempts after restart.
4. Document the exact operator controls and their limitations in the canonical
   Universe guide and CLI help. Run focused and adjacent controller/campaign
   tests, TypeScript, lint, documentation checks, and production build locally.
5. Independently review the diff and record exact verification outcomes before
   source publication or installation. No GitHub Actions are used.

## Boundaries

Tests use temporary Git repositories and inert local integer workers; they do
not connect subscriptions, consume model requests, or activate a resident fleet.
No account policy, personal usage reserve, native daemon trust, deadline,
automatic replay, immutable ledger schema, or public publication policy changes.
Campaign controls are not controller-wide drain/resume. That larger capability
requires a separate design and dispatch-admission synchronization.

## Ownership

- Primary: integration, CLI help, documentation, validation, release evidence.
- Native acceptance agent: cross-process campaign pause/stop tests.
- Signal acceptance agent: cross-process SIGINT/SIGTERM tests.
- Controller agent: reason preservation and focused regression tests.
