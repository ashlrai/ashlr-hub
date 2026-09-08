# Verification

Record distinct selected tests, independent review, exact source identity,
installed acceptance, and publication status here. No provider calls authorized
as part of source tests; use inert workers and existing fixture patterns.

## Final source verification

- Stable aggregate: **546 passed / 20 files**, zero failed or skipped. Includes
  all seven new real-I/O portfolio/resource cases and campaign/resource, CLI,
  verified-runtime forwarding, documentation, and command-contract regressions.
- Earlier in-flight aggregate had three fixture expectation failures, now
  corrected and independently rerun in the full stable aggregate. Do not add
  repeated focused runs to the distinct test count.
- Full core/web typecheck passed on the frozen implementation and fixture.
- Full lint: zero errors, 105 pre-existing warnings. Final changed-file ESLint
  also passed after the new tests were frozen.
- Real-I/O membership: 177 real-I/O / 631 unit files, passed; pre-existing m11
  fixture-size advisory remains non-gating.
- Documentation: 8 entrypoints, 67 local links, 28 source links, 27 external links,
  zero external requests, zero errors. Whitespace check passed.
- Independent core/CLI/docs review passed. Existing teardown, uncertain-capacity
  accounting, ownership, and campaign completion semantics were not weakened.
- No real model/account calls, global configuration reads, credential changes,
  GitHub Actions, or persistent service activation were used.

## Installed acceptance and publication

Clean build, offline installed-CLI acceptance, exact hashes, source publication,
and remaining limits will be recorded in:
`/Users/masonwyatt/.codex/artifacts/ashlr-portfolio-resources.aVrhwO/RELEASE.md`.

The reviewed acceptance harness is inert: it proves two ordered CLI-dispatched
campaigns share one capped ledger, preserve evaluated artifacts and usage links,
and do not repeat worker calls on terminal rerun. It does not measure model
quality, commission subscription accounts, or activate the resident fleet.
