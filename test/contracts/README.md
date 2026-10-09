# Phantom Secrets CLI compatibility fixture

The workbench's optional `foundry.usePhantom` adapter currently calls
`phantom env KEY`, then `phantom unwrap KEY`, as though either command returns
a secret value. The real CLI rejects both argument forms. `env` generates
`.env.example`; `unwrap` restores `package.json` script wrappers. The existing
`test/m168.phantom-secrets.test.ts` mocks a lookup contract that Secrets does
not implement.

Run this separate Node test lane with an **explicit, already reviewed local
Secrets executable**, using Node 22.15 or later:

```sh
PHANTOM_CONTRACT_BIN=/absolute/path/to/phantom node --test test/contracts/phantom-secrets-cli.test.mjs
```

Without the variable, the suite visibly skips and executes zero binary checks.
An invalid explicit path fails rather than silently skipping. The fixture does
not resolve `phantom` through PATH, install packages, rebuild Secrets, or join
the existing Vitest `.test.ts` lanes. A passing fixture establishes the CLI
grammar described below; it does **not** certify the existing adapter.

The closed command set permits only `--version`, `env|unwrap|reveal|list|exec
--help`, and three parser-rejection commands with synthetic arguments. Rejection
requires clap exit code 2, empty stdout, and an argument/usage diagnostic;
configuration or vault errors do not count as success.
The suite's before-hook requires both exact help usage forms without any
positional arguments before any negative probe. A changed grammar cancels the
suite. The invocation helper independently requires both successful grammar
reviews and an unchanged executable hash before every negative probe.
The child environment is
reconstructed without inherited credentials, proxy variables, session bearers,
loader hooks, or user configuration paths. HOME, config/data/cache/state paths,
and temporary paths point at a disposable directory; PATH points at an empty
directory. Each invocation checks that its synthetic `.env`, package script
fixture, and directory inventory remain unchanged. Cleanup runs even on failure.
The fixture emits the executable's resolved path, SHA-256, reported version,
and Node version, then checks the binary hash again after testing.

These controls are not an OS sandbox or keychain isolation mechanism. Keep
valid vault/reveal/exec/init/env/unwrap commands outside this fixture. The
`reveal` negative check deliberately uses an unknown option so the command
handler is never reached. `list --help` checks availability of `--json`, not
the returned metadata schema. `exec --help` checks grammar, not proxy or child
environment behavior.

## Local observations, 2026-10-09 UTC

Workbench base: `6e574831ff9ce491eeb81c991ce2444cfdfad8cd` (3.26.1), isolated
branch `codex/companion-contracts-local`. No runtime adapter changes are included.

Secrets inspected checkout:
`/Users/masonwyatt/Desktop/github/dev-tools/phantom-secrets`, HEAD
`b3672b4806569249217be2d3c68d8bd75eccffe8`, branch `docs/accuracy-fixes`, with
extensive pre-existing dirty changes. This checkout is not the current release
branch: its worktree inventory also contains `codex/release-v079` at `7a51ce5`.
Neither checkout was edited or rebuilt. Compiled binary-to-source correspondence
is unknown, despite both binaries reporting version 0.6.0.

| Executable under the inspected checkout | SHA-256 | Reported version | Result |
| --- | --- | --- | --- |
| `target/debug/phantom` (mtime Aug 30) | `825ceb6d1aaa5080487b979f76b19263447af6dd6adcd5e1c15accbfc2def79c` | `phantom 0.6.0` | 9/9 passed |
| `target/release/phantom` (mtime Aug 16) | `5af1f71e10597335827a8fcf26be2b35359f33387eaf22284cfbb1805bdce5eb` | `phantom 0.6.0` | 9/9 passed |

Both runs used Node v22.22.3 and left the synthetic fixture unchanged. The
no-variable run visibly skipped the suite and executed zero checks.

The separate synthetic safety lane runs without a Secrets binary:

```sh
node --test test/contracts/phantom-secrets-cli-safety.test.mjs
```

Its POSIX executable fixtures advertise changed `env <KEY>`, `unwrap <TARGET>`,
and optional `env [SECRET]` grammar, plus a failing help command. All four prove
the before-hook cancels the suite and the executable receives only version/help calls. Their only writes
are disposable invocation records; they contain no real command handlers.

Dirty source provenance at inspection:

- `crates/phantom-cli/src/main.rs`, SHA-256
  `fa8d2ccff295006be11d585ad006401766d9329416937158a6147a5ceb0e02b0`:
  `Env` has only `--output`; `Unwrap` has no key argument; `Reveal` retains a
  hidden legacy `--yes` argument.
- `crates/phantom-cli/src/commands/reveal.rs`, SHA-256
  `2580e9cac89473df621cc1ac3f52619f38015233787313714d74a900ac98c654`:
  the handler rejects `--yes` before config/vault access and otherwise requires
  attached stdin/stderr terminals and typed confirmation. This is source
  inspection evidence, **not a tested behavior of either compiled binary**.

## Adapter-owner handoff

Keep `foundry.usePhantom` disabled by default. Remove the unsupported plaintext
lookup assumption through a separately owned review. Do not replace it with
agent-side `reveal`, export, or another extraction path. Requested credentials
must not be reported as available or silently treated as satisfied by ambient
environment variables when the approved provider contract is absent.

Agree the value-blind capability and execution boundary with the Secrets owner
before implementing a replacement. Configuration presence or parseability alone
does not establish vault readiness or child credential injection. Tests for any
new metadata or execution contract should use a pinned owner-built artifact and
cover missing/uninitialized/locked state, per-project isolation, rejection, and
value-free outputs. Proxy URLs may contain session bearers and must never be
logged or persisted. Dormant lease/broker paths must remain fail-closed.

Not exercised here: current 0.7.9 release artifacts, dirty source build/tests,
trusted-terminal reveal rejection, real vault metadata, child injection,
broker/lease readiness, cross-platform execution, or the workbench adapter's
runtime behavior. Those remain owner-coordinated follow-up validation.
