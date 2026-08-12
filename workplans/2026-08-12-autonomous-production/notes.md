# Notes: Autonomous Production Integration

## Current Evidence

- Integration base: `origin/master` at `d9046fe5c99c2454c65f56e4849d20e86cef1d05`.
- Protected-master CI run `31456729674` failed; CodeQL run `31456729267` succeeded.
- A Dependabot workflow on the same SHA also failed on 2026-08-12 and must not be confused with exact source CI.
- Primary checkout is on `codex/locus-firm-fleet-docs`, one commit ahead and behind `origin/master`; it remains untouched.
- Reviewed candidate heads currently include direct automation `0c275356`, effect policy `f4a25431`, Nemotron shadow `d93d5b32`, M380 fixture `549e5937`, Windows launcher `ebc69770`, and mutation-disabled activation `e606659f`.
- The installed/runtime/release identities will be refreshed before any activation decision.
- Reviewed M380 commit `549e5937` was cherry-picked as integration commit `98e524bd`; it changes only the fixture clock and is the protected-master recovery prerequisite.
- The candidate train composes patch-equivalent M380, signed human-only effect policy, direct-proposal authority/JSON hardening, and digest-bound Nemotron shadow evaluation. It intentionally excludes the self-red Windows launcher and mutation-disabled activation PRs pending separate repair.
- Combined focused validation passed 9 files / 234 tests plus typecheck. The
  affected process-heavy invariant files passed 76/76 serially, the full
  invariant suite passed 449 with 5 expected skips, and the full M201 daemon
  loop passed 245/245 after shadow isolation was added. Build, quiet full lint,
  package dry-run, diff check, and npm audit are green.
- Gitleaks reported 77 pattern hits. Review shows they are synthetic secret-redaction fixtures/canaries or semantic domain strings, not discovered credentials. Semgrep produced 30 audit findings, predominantly unchanged dynamic-regex/shell patterns; findings in changed manager files are pre-existing label-regex sites and remain subject to security-agent review.
- Exact Windows job `93676282232` completed the scoped rollback assertion in 17.587s after its explicit 15s test timeout. The integration increases only that test's ceiling to the existing bounded 30s Windows CI budget; production rollback behavior and assertions are unchanged. Full H7 passes 12/12 and four captured repeats passed.
- Independent combined review found that shadow errors could influence
  authoritative daemon production classification. The integration now excludes
  every shadow row and its aggregate critique from production classification;
  all-shadow races emit `shadow-observation`, which is withheld from production
  learning while preserving shadow ledger and cost telemetry.

## Non-Negotiable Evidence Gates

- Exact protected source and required checks green.
- No open P0-P2 source-composition finding in the composed diff. Unattended
  production blockers are tracked separately and deliberately remain closed.
- Immutable model identity and loopback-only local transport for Nemotron; no automatic pull or mutable `latest` tag.
- Mandatory confinement and no ambient credentials for unattended execution.
- Crash-safe budget reservation and continuous kill/enrollment/lease revalidation before claiming unattended operation.
- Signed, replay-safe release/install/rollback transaction before resident mutation.
- Live runtime identity, daemon health, queue eligibility, proposal yield, and outcome evidence verified after installation.
