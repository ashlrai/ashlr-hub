# Implementation report

## Implemented

- `ashlr runtime install`: explicit local archive, SHA256, revision, version and
  private store. Descriptor-pinned bounded reads, maintained USTAR header parser,
  canonical regular files, clean build identity and bundled dependency checks.
- Staged extraction, actual installed CLI/SDK smoke, interpreter-bound runtime
  manifest, durable selection and retained rollback package. No npm execution,
  registry lookup, lifecycle scripts, PATH changes or service activation.
- Read-only status and per-process pinned foreground Universe execution with an
  explicit experiment root. Cancel forwarding escalates for an unresponsive
  exact child after five seconds, without claiming process-tree cleanup.
- Independent current/previous verification: damaged previous state does not
  disable a valid current; damaged current can roll back to a valid predecessor.
- User and agent help, canonical installation/recovery documentation and package
  smoke coverage for the installed command.

## Validation before source commit

- Broader Universe/help/package suites: 1,020 passed across 45 files.
- Updated package smoke regression suite: 30 passed.
- Existing artifact/manifest/launch-revalidation suites: 125 passed, 1 existing skip.
- Web suite: 211 passed across 34 files.
- New CLI plus existing help/agent-document compatibility: 88 passed.
- Independent acceptance: 26 passed; core store: 10 passed; new CLI: 66 passed.
- TypeScript including web: passed. Full lint: no errors, 106 existing warnings;
  changed-file lint and diff check: passed.
- Production dependency audit: zero reported vulnerabilities; parser plus five
  transitives added as bundled dependencies.
- Final independent archive/store/CLI combination and exact clean-source package
  acceptance are recorded in the external release handoff after completion.

The initial direct-Vitest artifact test omitted npm_execpath and failed one
existing toolchain assertion. Running via pinned npm resolved that environment
issue without a product change. A new double-failure test initially targeted a
cached filesystem function rather than the actual finalization seam. Corrected
injection now proves removed-marker recovery when pointer restoration also fails;
the final 26-case independent suite passes. No failing check was waived.

## Qualification and remaining scope

This is an unsigned, Git-pinned local candidate installation. It does not satisfy
the separate M571 production-policy gate, publish npm, provision subscription
accounts, activate the dormant resident fleet, remove the kill switch, or isolate
the existing console from default config and stream-maintenance paths. CLI smoke
executes the explicitly trusted package and is not arbitrary-code confinement.

An interrupted/failed selection restoration leaves explicit degraded evidence
for inspection. Retained packages and staging directories are not pruned.
No automatic repair, service restart or experiment-data rollback is implied.

Source branch: `codex/universe-local-runtime`; base:
`08c5d750290c3ed43c32a5256778830b50dca758`. The primary Desktop checkout is
untouched. Exact source SHA, artifact hashes, installed native acceptance and
publication state will be pinned in the external release handoff.
