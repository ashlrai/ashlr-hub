# Exploration notes

- PR362 supplies explicit candidate install/status/rollback and a foreground
  Universe-only launcher with an explicit experiment root.
- Prior inspection found shared `serve` loads default config, server startup
  performs stream GC, and Universe API handlers use default roots. Verify these
  seams live before choosing implementation.

## Confirmed seams and decisions

- Existing `startServer` always performs stream GC and imports general APIs;
  `cmdServe` loads writable global configuration. Neither is a scoped entrypoint.
- Shared auth and bounded read-queue implementations are extracted without
  changing the ordinary server defaults. The dedicated worker pins root at startup.
- Cookies are host-scoped, not port-scoped. New consoles use independent cookie
  names and signing state, with exact advertised Host/Origin checks.
- Main UI previously loaded general shell observers and a snapshot probe. The
  dedicated path now lazily selects a scoped composition; shared SSE hooks check
  that path before every connection/reconnection.
- All Universe operational hints use the authenticated explicit root; no browser
  mutation control is introduced. Existing graph/trial and stale/degraded labels
  are reused.
- Independent UI review found no actionable isolation issue. Shipped-byte browser
  verification remains required before claiming the complete installed flow.

## Verification so far

- Initial existing focused UI regressions: 53 passed in four files.
- Scoped/Universe focused tests before graph scope matrix: 55 in three files.
- Full web suite after graph scope matrix: 221 passed in 35 files.
- Frontend lint initially flagged a control-character regex. Replaced it with
  bounded character-code validation; changed frontend lint then passed.
- Guessed web tsconfig name was absent; package script names the actual
  `src/web-ui/tsconfig.json`. This was a command-selection error, not a product failure.
- Full TypeScript checks passed for backend and web. Full lint: zero errors,
  106 existing warnings; real-I/O membership passed with the existing soft signal.
- Independent native HTTP acceptance: 46 passed. Initial graph fixture incorrectly
  expected manifest labels; fixed to compare the exact distinct seed commits.
- Existing web/server/worker/Universe API regression set: 81 passed in six files.
- CLI/help/runtime lane: 145 passed before the canonical-root followup.
- Read-only public npm audit of production dependencies: zero vulnerabilities.
- Independent review caught unconstrained worker-to-main evidence transfer.
  Public projection and serialization are moving into the worker with an explicit
  response-byte budget and unavailable responses rather than truncated success.
