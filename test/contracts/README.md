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

## Clean current and release-source qualification, 2026-10-09 UTC

Inspected a separate clean, isolated local `origin/main` snapshot at
`/Users/masonwyatt/Documents/Codex/2026-10-08/task-3/secrets-current`, HEAD
`8f3795bb1ee62a5723e622d7bcdf1d2781c71624`, workspace version **0.7.9**.
This post-release main snapshot is distinct from the immutable release commit
`7a51ce5` and from the dirty owner's checkout above. A second detached worktree
at `/Users/masonwyatt/Documents/Codex/2026-10-08/task-3/secrets-release-v079`
was created from task-owned `secrets-support-base` Git metadata at exact commit
`7a51ce512ec4aee12cc29ff859036af63fbe93db`. Both source checkouts stayed clean;
no source or lockfile edits were made.

The pinned installed compiler was verified as
`rustc 1.95.0 (59807616e 2026-04-14)` and
`cargo 1.95.0 (f2d3ce0bd 2026-03-21)`. Both builds used a separate task-owned
target cache, two jobs, and locked dependency versions:

```sh
CARGO_TARGET_DIR=/Users/masonwyatt/Documents/Codex/2026-10-08/task-3/secrets-current-target \
RUSTUP_TOOLCHAIN=1.95.0-aarch64-apple-darwin \
/Users/masonwyatt/.cargo/bin/cargo build --locked -p phantom-secrets --bin phantom --jobs 2
```

The first offline main build stopped because locked `rmcp 3.5.0` was absent
from the cached index. Normal online access then hit sandbox DNS failure;
normal test/release builds hit sandbox registry-cache unpack permissions.
Subsequent requested sandbox escalations were approved for only the recognized,
public crates.io dependencies in the existing locks. Every external lock source
was `registry+https://github.com/rust-lang/crates.io-index`; no alternate registry
or Git dependency was used. The main build then succeeded in **2m51s**, and the
exact release-source build succeeded in **1m08s**. No dependency upgrades,
global companion installation, credential provisioning, or owner build-target use occurred.

The binaries were preserved separately before target reuse. Both report
`phantom 0.7.9`; SHA-256 distinguishes the post-release main source from the
exact release source:

| Source | Preserved executable under the task workspace | SHA-256 | Real grammar | Missing/invalid status |
| --- | --- | --- | --- | --- |
| Main `8f3795bb` | `secrets-current-bin/phantom` | `ffa6508d77ae22d293549e6989d2670c05d8cfed3ece8d6ad8992e27b2f6199d` | 9/9 passed | 2/2 passed |
| Release `7a51ce51` | `secrets-release-v079-bin/phantom` | `81a5eeaed46b938887808607996ddb175664e7c87a80b31cec4af64a60fd44c8` | 9/9 passed | 2/2 passed |

The synthetic grammar-safety lane passed **4/4**. Main's three `help_tests::`
unit tests passed **3/3**. The exact
`commands::reveal::tests::legacy_noninteractive_bypass_is_always_rejected`
unit test passed **1/1 on each source**; it returns before config/vault access.
Native tests used a scrubbed environment and task-owned HOME/config/temp paths.
The release source has no `help_tests::` module: that initial filter matched zero
tests, which is not counted as a pass. Its exact denial test subsequently passed.

The release grammar fixture initially cancelled all nine tests when its copied
executable was named `secrets-release-v079-phantom`: clap's usage text includes
the actual executable basename, while the guard requires canonical `phantom`.
Safe `env --help` confirmed that spelling difference. Copying the byte-identical
binary to `secrets-release-v079-bin/phantom` passed all nine checks. The guard was
not weakened; no negative probe ran after the initial preflight failure. Use a
preserved file named `phantom` when reproducing this strict grammar lane.

The separate task-owned `secrets-status-smoke.mjs` executed only `status --json`
against absent and deliberately malformed synthetic configs in disposable
directories. On both binaries it asserted the entire exact v1 object:
`initialized: false`, `inspection: "metadata-only"`, dotenv/vault uninspected,
proxy lifecycle `"not-inspected"`, listener unauthenticated, and only
`config-missing` or `config-invalid`. Stderr was empty; synthetic dotenv markers
and filesystem paths never appeared; fixtures and binary hashes stayed unchanged.
No valid config, real profile, vault operation, provider call, or listener was used.

Evidence logs under `/Users/masonwyatt/Documents/Codex/2026-10-08/task-3`:
`secrets-current-approved-build.log`, `secrets-current-cli-contract.log`,
`secrets-current-safety-contract.log`, `secrets-current-approved-help-unit.log`,
`secrets-current-reveal-denial-unit.log`, `secrets-current-status-contract.log`,
`secrets-release-v079-approved-build.log`,
`secrets-release-v079-canonical-cli-contract.log`,
`secrets-release-v079-status-contract.log`, and
`secrets-release-v079-reveal-denial-unit.log`. Initial offline/sandbox/renamed
failures are preserved in the corresponding earlier logs.

The clean checkout remained unchanged after the attempt. `Cargo.lock` retained
SHA-256 `3a2a17c8692ba851e7ea9e997e570729710371580f1fecb1d7d397c200a3faa0`;
`rust-toolchain.toml` has SHA-256
`24ef3b9d3edbd850aa386cb0a98e10450b0030991a4537cb359f54d49dbbb33a`.
The release lock retained SHA-256
`c276fff73a9bce35facd5258a3a6c4871264cf0d3b8311d62c2913c14ff17baf` and
pins `rmcp 1.5.0`, rather than main's `3.5.0`.

Read-only current-source checks still establish the incompatible grammar:

- `crates/phantom-cli/src/main.rs`, SHA-256
  `acec55674c9d391cf176eaacb3db497a67d7aba53ae456497407fc2c39b96a90`:
  `Env` exposes only an output filename option, and `Unwrap` has no positional
  key argument.
- `crates/phantom-cli/src/commands/reveal.rs`, SHA-256
  `b0689e5e7ad93ac7d403fe52fe4f94ec0c76e0b05ff036a4babd0853281087db`:
  legacy `--yes` is rejected before config/vault access; otherwise attached
  stdin/stderr terminals and typed confirmation are required. The early `--yes`
  rejection is also covered by the exact unit test above; the full terminal
  ceremony remains unexercised.

These are local, unoptimized macOS ARM64 builds from pinned source, not downloaded
or attested official release assets. Full workspace tests, cross-platform behavior,
initialized/locked-vault status, the terminal ceremony, credential injection,
broker/lease readiness, and official release-asset execution remain unverified.

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

Not exercised here: official 0.7.9 release assets, dirty source build/tests,
the full trusted-terminal reveal ceremony, real vault metadata, child injection,
broker/lease readiness, cross-platform execution, or the workbench adapter's
runtime behavior. Those remain owner-coordinated follow-up validation.
