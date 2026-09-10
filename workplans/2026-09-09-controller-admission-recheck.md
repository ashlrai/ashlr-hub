# Revalidate controller admission after contention

## Goal

Close the stale-check window when a portfolio controller waits on its short
control transaction before recording a dispatch intent. Reuse the existing
durable ledger, fixed enrollment, dependency ordering and original deadline.

Base: `0007c7d5bcf718af9ce1675a50599e6a842b0e98`.
Branch: `codex/universe-admission-recheck`, isolated from the primary checkout.

## Contract

- Revalidate target campaign identity, records and dispatch eligibility, plus
  recorded prerequisite and required delivery evidence, after obtaining the
  control transaction on every admission attempt.
- The synchronous check precedes intent publication. Drain retains precedence;
  cancelled, expired, changed or uncertain work creates no new intent.
- Avoid nested control locks and release unused Universe execution leases on
  refusal. No callback can yield admission across asynchronous execution.
- The control lock serializes controller records; it does not make independent
  campaign stores or Git refs a globally atomic snapshot.
- Preserve task priority, budgets, delivery requirements and account policy.
  No provider activation, service changes, or GitHub Actions.

## Ownership and verification

1. Runtime agent: store guard, runtime revalidation, focused regression tests.
2. Native agent: independent-process lock contention acceptance with inert work.
3. Review agent: independent ordering, cleanup and compatibility review.
4. Primary: canonical docs, test-lane registration, integration verification,
   source publication and pinned local-candidate receipt.

Demonstrate failure on prior behavior and success after the change, including
unchanged evidence proceeding and changed evidence refusing before dispatch.
Run controller/store/CLI adjacent tests, typechecks, lint, docs and build locally.
Keep installed-candidate acceptance separate from provider-backed commissioning.
