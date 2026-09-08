# Verification

Date: 2026-09-08. Branch: `codex/universe-native-profiles`.
Base: `a7204bdac4ecf58ad074e10eec7b2846b670b138` (merged PR377).
Verifier: primary agent plus independent implementation and review agents.
The source checkpoint is committed with this document; exact package identity
and final source publication belong to the external release receipt.

## Passed local checks

- 407/407 selected tests across nine files, with no skipped or pending tests:
  account probe, launcher compatibility, native profiles, independent profile
  review, worker process, worker, commissioning CLI, profile CLI and built-CLI
  profile integration. This includes 77 newly added tests.
- Backend and web TypeScript checks; production build.
- Full lint: zero errors, 105 existing warnings. Final scoped source/test lint
  passed without warnings; real-I/O lane membership passed with 193 files.
- Documentation checker and whitespace checks.
- Independent final core/CLI/documentation review: no actionable blockers.
- Real native help checks through the three prepared launchers: Codex 0.136.0
  for both Codex profiles, Claude 2.1.257 for the Claude profile; required flags
  advertised. No inference was requested by these checks.

The six integration tests exercise built `dist`, not the final archived package.
Exact-package acceptance is a separate pending release step at this checkpoint.

## Activation and remaining dependencies

Prepared profile is not authenticated account, quota observation, native
inference, evaluated artifact or resident supervision. First Codex native login
is awaiting the user's account selection. The second Codex and Claude sign-ins
have not started; no account capacity has been enrolled from these profiles.
No credentials were copied, no billing or reset controls changed, no model
download requested, and no daemon installed. GitHub Actions remains disabled.
The full repository test suite and authenticated provider canaries were not run.

## Recovery

Preparation refuses all existing targets and leaves partial state for inspection.
Do not delete or move native state after login merely to retry preparation.
The previous merged source is the rollback identity; this change does not replace
any existing resident installation, pool configuration or desktop authentication.
