# CONTRACT-M571: Local production verification gate v1

Status: source-complete, local-only, fail-closed, and authority-free. This gate
does not publish, promote, install a production runtime, activate a service,
dispatch work, configure a provider, or grant permission for any of those
effects.

## Purpose

M571 replaces hosted verification capacity with one durable macOS runner for a
later release successor. It verifies a single exact clean Git commit and tree,
runs every required source, package, dependency, web, and native check, and
writes a canonical receipt to a caller-selected path outside the repository.
The external receipt avoids self-reference: no receipt or receipt digest is
committed into the source tree it attests. The local registry archive is also
built with `ASHLR_REPRODUCIBLE_PACKAGE=1`, so its `build-identity.json` is the
deterministic, uncommissioned identity (`revision:null`, `dirty:null`,
`provenance:"unavailable"`). A registry package therefore cannot claim desktop
runtime activation provenance; that remains a separate artifact and authority.

The gate consumes an M570 policy. That policy must be a tracked canonical file
under `.github/release-policies/`, match the package and lockfile version, bind
the exact raw SHA-256 of `ashlr.verify.json`, pin the exact Node 24+ and npm 11+
versions executing the gate, and contain the exact SRI later reproduced by the
packed tarball.

## Invocation

Run from an exactly clean commit with the policy already committed:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run verify:local-production -- \
  --expected-sha "$(git rev-parse HEAD)" \
  --policy .github/release-policies/vX.Y.Z.json \
  --artifact /absolute/path/outside/the/repository/ashlr-hub-X.Y.Z.tgz \
  --receipt /absolute/path/outside/the/repository/local-production-receipt.json
```

The host must provide `cargo-audit 0.22.2` and the repository-pinned OSV
Scanner; the runner rejects missing or mismatched tools before starting. The
OSV Scanner is mandatory so npm audit fallback remains available if the npm
registry advisory endpoint fails.

The runner terminates the gate process group, independently bounds inherited
output-pipe closure, and sweeps descendants carrying its per-gate execution
marker. This is operational cleanup, not a hostile-code VM boundary: source
that deliberately clears inherited environment markers before detaching, host
IPC, and system reads remain outside the receipt's isolation claim.

The artifact and receipt paths must be absolute, outside the real repository,
beneath existing current-user-owned directories that are not group- or
world-writable, and absent. Publication uses exclusive no-follow create mode
`0600`, flushes each file and parent directory, revalidates parent identity,
and never overwrites existing output. The exact packed tarball is preserved;
the standalone verifier requires it, recomputes SHA-256 and sha512 SRI, and
requires independent pins for the receipt digest, source revision and tree,
policy digest, verification-contract digest, and tarball SRI.

The output checks detect ordinary parent replacement and leaf-symlink attacks,
but do not claim atomic protection against a hostile concurrent process running
as the same user that swaps the output parent between pathname operations. Use
a private operator-owned output directory with no concurrent writers.

## Exact gate

`ashlr.verify.json.localProductionGate` is the closed execution plan. V1 runs,
in order:

1. clean `npm ci --ignore-scripts` installs for the root and Raycast lockfiles;
2. typecheck, lint, and build;
3. all three deterministic hermetic `test:ci` shards;
4. the web console suite;
5. full and production npm audits for the root and Raycast lockfiles, using the
   existing bounded npm/OSV failover;
6. a pack into a private temporary directory, an offline clean local install, CLI help,
   and `types`/`core` export smoke tests;
7. a locked Cargo dependency fetch, followed by offline Cargo format, all-target
   check, all-target clippy with warnings denied, and locked tests; and
8. Cargo audit with only the documented, still-open
   `RUSTSEC-2024-0429` Linux GLib exception.

Every subprocess runs against a fresh detached exact-SHA worktree with
`HOME`, `USERPROFILE`, `ASHLR_HOME`, npm cache/config, Cargo home, Cargo target,
and temporary paths redirected to the gate's private root. The child
environment is an allowlist; provider, npm, GitHub, shell-injection, and Git
override variables are not inherited. Native launchd integration is explicitly
disabled. The runner never invokes `gh`, a workflow, npm publication, a service
manager, or an Ashlr runtime command with operational authority. Dependency
installation, advisory audits, and the locked Cargo fetch may use the network;
all build, test, offline-native, and pack-smoke gates run under a macOS sandbox
that denies non-loopback IP egress while preserving localhost and private Unix
socket fixtures. Every gate sandbox permits writes only to explicit dependency,
build-output, and private temporary paths, and denies reads from the user home
except the exact Git metadata and installed Rust tool directories needed for
reproduction. Profiles live in a separate non-writable directory and are
device/inode/hash checked before every gate.

This is strong local containment, not a VM boundary. Host IPC and reads of
non-home system paths are not fully isolated, so the receipt records evidence
writes but does not attest that arbitrary external effects were impossible.
The repository's bounded-command adapter supplies the GNU `timeout` interface
used by the audit wrapper on macOS; no Homebrew `timeout` dependency is needed.

Tauri requires a host-triple sidecar to exist while checking its manifest. The
runner refuses an existing target, creates an inert non-operational placeholder
with exclusive mode, and removes only the file it created in a `finally` path.
The inert sidecar's device/inode identity is checked before removal. The
temporary worktree is removed and the controlling repository must return to the
same clean commit and tree before artifact and receipt publication. V1 is
intentionally macOS-only; another host fails before the native gate instead of
claiming untested parity.

## Receipt and verification

The canonical UTF-8 receipt is sorted-key JSON followed by exactly one LF and
is bounded to 256 KiB. Its closed schema binds:

- exact source revision, source tree, and clean-before/clean-after claims;
- exact Node, npm, Rust, Cargo, and cargo-audit identities plus absolute
  executable paths and file digests;
- policy ID/version/digest and verification-contract path/digest;
- package name/version/tarball name, tarball SHA-256, and sha512 SRI;
- ordered gate IDs, command digests, timestamps, duration, exit status, and
  stdout/stderr digests; and
- the disclosed local execution boundary plus all-false authority.

The verifier rejects unknown or missing keys, noncanonical bytes, malformed
hashes or SRI, missing/reordered/failed gates, old Node/npm versions, source or
binding mismatch against the complete required caller pins, persisted-artifact
byte drift, any authority bit, and any verdict other than `passed`. Command
output and environment values are not persisted.

## Explicit non-claims

A passing receipt proves that one local host observed the stated checks for the
bound source and package artifact. It is unsigned and does not prove custody,
independent review, registry state, GitHub state, publication, promotion,
desktop installation, service activation, provider operation, field behavior,
or customer acceptance. Each consequential effect remains a distinct action
with its own current-state checks and operator authority.
