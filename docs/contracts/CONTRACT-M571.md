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
committed into the source tree it attests.

The gate consumes an M570 policy. That policy must be a tracked canonical file
under `.github/release-policies/`, match the package and lockfile version, bind
the exact raw SHA-256 of `ashlr.verify.json`, pin the exact Node 24+ and npm 11+
versions executing the gate, and contain the exact SRI later reproduced by the
packed tarball. No production policy is added by this milestone.

## Invocation

Run from an exactly clean commit with the policy already committed:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run verify:local-production -- \
  --expected-sha "$(git rev-parse HEAD)" \
  --policy .github/release-policies/vX.Y.Z.json \
  --receipt /absolute/path/outside/the/repository/local-production-receipt.json
```

The host must provide `cargo-audit 0.22.2`; the runner rejects other or
missing versions. The audit fallback also fails closed if neither the npm
advisory endpoint nor the repository's pinned OSV Scanner is available.

The receipt path must be absolute, outside the real repository, beneath an
existing real directory, and absent. Publication uses exclusive create mode
`0600`, flushes the file and parent directory, and never overwrites an existing
receipt. The standalone verifier can pin the receipt digest, source revision
and tree, policy digest, verification-contract digest, and tarball SRI.

## Exact gate

`ashlr.verify.json.localProductionGate` is the closed execution plan. V1 runs,
in order:

1. typecheck, lint, and build;
2. all three deterministic hermetic `test:ci` shards;
3. the web console suite;
4. full and production npm audits for the root and Raycast lockfiles, using the
   existing bounded npm/OSV failover;
5. a pack into a private temporary directory, a clean local install, CLI help,
   and `types`/`core` export smoke tests;
6. Cargo format, locked all-target check, locked all-target clippy with warnings
   denied, and locked tests; and
7. Cargo audit with only the documented, still-open
   `RUSTSEC-2024-0429` Linux GLib exception.

Every subprocess runs with `HOME`, `USERPROFILE`, and `ASHLR_HOME` redirected
to the gate's private temporary root. Native launchd integration is explicitly
disabled. The runner removes GitHub credentials from the child environment and
never invokes `gh`, a workflow, npm publication, a service manager, or an Ashlr
runtime command. Dependency acquisition and advisory audits may perform
read-only network queries; build, test, pack, and installation effects remain
confined to the checkout's ignored build products or private temporary root.
Existing Cargo/Rustup caches may be read or updated by their normal tools.
The repository's bounded-command adapter supplies the GNU `timeout` interface
used by the audit wrapper on macOS; no Homebrew `timeout` dependency is needed.

Tauri requires a host-triple sidecar to exist while checking its manifest. The
runner refuses an existing target, creates an inert non-operational placeholder
with exclusive mode, and removes only the file it created in a `finally` path.
The repository must return to the same clean commit and tree before receipt
publication. V1 is intentionally macOS-only; another host fails before the
native gate instead of claiming untested parity.

## Receipt and verification

The canonical UTF-8 receipt is sorted-key JSON followed by exactly one LF and
is bounded to 256 KiB. Its closed schema binds:

- exact source revision, source tree, and clean-before/clean-after claims;
- exact Node, npm, Rust, Cargo, and cargo-audit identities;
- policy ID/version/digest and verification-contract path/digest;
- package name/version/tarball name, tarball SHA-256, and sha512 SRI;
- ordered gate IDs, command digests, timestamps, duration, exit status, and
  stdout/stderr digests; and
- the disclosed local execution boundary plus all-false authority.

The verifier rejects unknown or missing keys, noncanonical bytes, malformed
hashes or SRI, missing/reordered/failed gates, old Node/npm versions, source or
binding mismatch against caller pins, any authority bit, and any verdict other
than `passed`. Command output and environment values are not persisted.

## Explicit non-claims

A passing receipt proves that one local host observed the stated checks for the
bound source and package artifact. It is unsigned and does not prove custody,
independent review, registry state, GitHub state, publication, promotion,
desktop installation, service activation, provider operation, field behavior,
or customer acceptance. Each consequential effect remains a distinct action
with its own current-state checks and operator authority.
