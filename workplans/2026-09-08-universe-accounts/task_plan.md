# Universe multi-account operation

## Goal

Make the supported path for two Codex subscriptions, Claude Code, local models
and Grok explicit and operationally useful, without mistaking configured accounts
for authenticated workers or subscription access for API entitlement.

## Phases

- [x] Parallel provider research and existing runtime exploration.
- [x] Select and implement the verified commissioning gap.
- [x] Validate declared capacity grouping and local end-to-end behavior without claiming live identity.
- [x] Record verification and remaining activation requirements; exact publication state is kept in the external release receipt.

## Constraints

No GitHub Actions. Preserve original checkout and account credentials. No billing
or new paid API usage without a concrete user choice. Use official provider
interfaces and separate account identities; do not circumvent rate limits.

## Status

Implementation: reusable local-runtime preflight and explicit native launcher
compatibility commands. Three parallel agents cover runtime implementation,
launcher implementation, provider research and independent review. Main owns CLI,
documentation and integration. Existing non-eve runtime is preserved.

User currently switches Codex accounts in the desktop app; simultaneous native
workers still need independently authenticated directories/launchers. No existing
credential material will be copied. Grok Build is installed and advertises ACP,
but a runnable Hub adapter requires verified configuration/tool isolation and
terminal/usage/cancellation contracts; the check must not label it runnable.

Branch based on merged PR376. Entire resume found no checkpoint.

## Errors

Discovery tried nonexistent worker-bindings.ts, pool-status.ts and commands/test
paths. Correct paths were located with rg --files; no implementation failure.
One scoped ESLint unnecessary-regex-escape finding in the launcher checker was
fixed before final verification. Grok fixture argv was updated to include the
final explicit no-auto-update flag before its integration run.
