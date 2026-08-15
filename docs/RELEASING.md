# Releasing @ashlr/hub

Releases are tag-triggered and fully gated. Nothing reaches npm without an
explicit human action (pushing a `v*` tag) plus a green full-CI verify job.

## One-time setup

An npm package owner must configure **trusted publishing** before any release
tag is pushed. This is an npm registry mutation and requires an authenticated
maintainer with package write authority and account-level 2FA; repository or
GitHub administration alone cannot complete it.

On npmjs.com, open `@ashlr/hub` → **Settings** → **Trusted Publisher** and bind:

- provider: **GitHub Actions**;
- organization/user: `ashlrai`;
- repository: `ashlr-hub`;
- workflow filename: `release.yml` (filename only, including `.yml`);
- environment: `npm-release` (exact, case-sensitive);
- allowed action: **npm publish**.

The `npm trust` command requires npm 11.15.0 or newer. The release workflow pins
the current npm 11 client, 11.19.0; the equivalent authenticated command is:

```bash
npm trust github @ashlr/hub \
  --repo ashlrai/ashlr-hub \
  --file release.yml \
  --environment npm-release \
  --allow-publish
npm trust list @ashlr/hub
```

The `trust list` output must show the exact repository and workflow binding
before a tag is authorized. npm does not validate the binding when it is saved;
a typo otherwise fails only at publish time. The release workflow uses a pinned
npm 11 client on a GitHub-hosted Node 24 runner, requests `id-token: write`, and
does not inject `NODE_AUTH_TOKEN`.

The GitHub-side controls are configured as follows:

- environment `npm-release` has no secrets, admits only the `v*` deployment
  pattern, and requires approval from GitHub user `masonwyatt23`;
- self-review is allowed and administrators can bypass, so this is an explicit
  Mason approval gate, **not** independent two-person approval;
- active tag ruleset `Release tags require Mason` protects `refs/tags/v*` from
  creation, update, or deletion, with Mason as the sole always-bypass actor.

These GitHub controls do not activate npm trusted publishing. An npm package
owner must still create and verify the exact repository, workflow, and
`npm-release` environment binding above before any release tag is pushed.

After the first trusted publish succeeds, set npm publishing access to **Require
two-factor authentication and disallow tokens**, revoke obsolete npm write
tokens, and delete the unused `NPM_TOKEN` GitHub secret. Do not remove those
fallback credentials before the trusted publisher has been configured and
verified.

## Release procedure

1. Update `version` in `package.json` (e.g. `2.2.0`).
2. Make sure `CHANGELOG.md` has a `## [2.2.0]` section — the release FAILS
   without one (`scripts/extract-changelog.mjs` enforces changelog discipline;
   its body becomes the GitHub release notes).
3. Confirm protected `master` is at the intended release SHA and its required
   checks are green. Commit, then create and push only the exact release tag:

   ```bash
   git tag v2.2.0
   git push origin v2.2.0
   ```

4. `.github/workflows/release.yml` then:
   - **verify** — full CI gate (typecheck / lint / build / test);
   - **publish** — wait for explicit `npm-release` approval → verify
     protected-master ancestry → install the pinned npm 11 trusted-publishing
     client → `scripts/check-version.mjs` (tag must equal `package.json` version)
     → upload one digest-verified, 64 KiB-max public changelog artifact from
     runner-temporary storage (the package checkout stays clean) →
     OIDC-authenticated `npm publish --provenance --access public`;
   - **release** — only after npm publish succeeds, download and verify that
     bounded artifact, then create or exactly verify the GitHub Release. This
     job has no npm tooling, token, OIDC permission, or publish command.

If npm trusted publishing is missing or its repository/workflow binding is
wrong, publication fails closed with an authentication error. Do not fall back
to a local token/OTP publish: that would bypass the workflow's full-CI,
protected-history, and provenance gates.

## Failure recovery: never republish an immutable npm version

An npm package version is immutable. Never rerun the whole workflow, rerun the
`publish` job, or run `npm publish` locally after the registry may have accepted
that version.

If **publish succeeded and only the GitHub `release` job failed**, first verify
that npm contains the intended tag artifact from a clean checkout of that tag:

```bash
version=3.2.0
git switch --detach "v${version}"
test "$(node -p 'process.versions.node.split(".")[0]')" = "24"
npm install --global npm@11.19.0 --ignore-scripts --no-audit --no-fund
test "$(npm --version)" = "11.19.0"
npm ci
npm run build
test -z "$(git status --porcelain --untracked-files=all)"
expected_integrity="$(npm pack --dry-run --json --ignore-scripts | jq -r '.[0].integrity')"
published_integrity="$(npm view "@ashlr/hub@${version}" dist.integrity)"
test -n "$expected_integrity" && test "$expected_integrity" = "$published_integrity"
```

Then use GitHub's **Re-run failed jobs** control, or the equivalent command:

```bash
gh run rerun RUN_ID --failed
```

Because `publish` is already successful, this reruns only the separate
`release` job and reuses the digest-bound handoff; it does not invoke npm. The
release job also accepts an already-created GitHub Release only when its tag,
title, body, release flags, and exact tag commit all match.

If npm publication itself failed or its result is ambiguous:

1. Inspect the workflow log and query `npm view "@ashlr/hub@${version}"` until
   registry state is known; do not infer failure from a lost response.
2. If the version exists, compare `dist.integrity` exactly as above, then inspect
   its npm provenance attestation. It must identify `ashlrai/ashlr-hub`,
   `.github/workflows/release.yml`, the expected GitHub Actions run, and the exact
   tag commit. A matching package without matching provenance is a release
   incident; never invoke publish again.
3. If npm accepted the version but the `publish` job later concluded failed, the
   dependent `release` job was skipped. Do not use **Re-run failed jobs** because
   that would attempt `publish` again and stop at the immutable-version guard.
   After the integrity and provenance checks above, create the GitHub Release
   manually from a clean checkout of the exact tag and its exact extracted
   changelog notes. This manual path applies even when the seven-day handoff
   artifact has not expired:

   ```bash
   set -euo pipefail
   version=3.2.0
   release_tag="v${version}"
   test "$(git rev-parse HEAD)" = "$(git rev-list -n 1 "$release_tag")"
   release_notes="$(mktemp)"
   trap 'rm -f "$release_notes"' EXIT
   node scripts/extract-changelog.mjs "$version" > "$release_notes"
   gh release create "$release_tag" --verify-tag --title "$release_tag" --notes-file "$release_notes"
   ```

4. If the version is absent, rerun publish only when the log proves the publish
   command did not begin or the registry definitively rejected it before any
   publication. Unknown transport state remains a stop condition.
5. If the version exists with a different integrity, stop and treat it as a
   release incident. npm immutability means it cannot be overwritten.

There is no token/OTP fallback and no recovery path that republishes an existing
version.

## Local dry-run

```bash
npm pack                          # prepack builds; inspect the tarball
node scripts/check-version.mjs v$(node -p "require('./package.json').version")
node scripts/extract-changelog.mjs
```

The CI pack-smoke step installs the tarball into a clean directory and
exercises both the `ashlr` bin and the `@ashlr/hub/types` + `/core` entry
points, so a broken exports map can never ship.

### Signed observation-only canary

Before authorizing a release, an exact commit can be inspected through the
same dependency-inventory, runtime-manifest, signed-envelope, and release-pair
APIs used by the runtime release controls:

```bash
npm --silent run release:canary -- \
  --candidate "$(git rev-parse HEAD)" \
  --expected-revision "$(git rev-parse HEAD)" \
  --trusted-protected-source
```

An optional rollback commit must be a distinct ancestor of the candidate:

```bash
npm --silent run release:canary -- \
  --candidate "$(git rev-parse HEAD)" \
  --expected-revision "$(git rev-parse HEAD)" \
  --rollback "$(git rev-parse HEAD^)" \
  --trusted-protected-source
```

This command has **no OS sandbox**. The acknowledgement flag does not establish
trust; it records the caller's assertion that every selected commit is trusted,
protected source. Run it only in a disposable VM or disposable OS account with
no production credentials, services, data, network authority, or active Ashlr
runtime. Candidate-controlled build and CLI code executes, so environment and
external effects are explicitly **unattested**. A temporary prefix and stripped
environment variables reduce accidental exposure but are not confinement.

Each of the two observations starts with its own Git archive, extraction,
recursive no-symlink/no-special-file check, npm cache, dependency install,
build, pack, production-only offline script-free artifact install, export
smoke, and CLI smoke. It verifies the generated dependency inventory and full
installed runtime tree, builds a runtime manifest bound to the caller-selected
exact commit and Node interpreter, and requires the independently produced
observations to match byte-for-byte. Archive builds truthfully retain
`build-identity.json` provenance as `unavailable`; they never manufacture a
`github-actions` identity. Extraction is supported only on Darwin with checked
bsdtar or Linux with checked GNU tar and fails closed elsewhere.

The release evidence is signed and immediately verified with a fresh Ed25519
key held only in process memory. Its envelope expires after 10 minutes and its
key declaration after 15 minutes. The final redacted receipt is also
canonically signed and includes its ephemeral SPKI public key, signature, key
digest, and signed-input digest. Those bundled values establish signature
**self-consistency only**: an attacker who can replace the receipt can also
generate another key and re-sign it. The verifier therefore returns false
unless the caller supplies an expected receipt digest or SPKI-key digest. The
caller must obtain that pin through an independent trusted channel; the
verifier cannot determine where a supplied value came from. The bundled public
key has no external identity, trust anchor, provenance, or authority. The
temporary tree is removed before the receipt is emitted. Private-key bytes,
paths, raw command output, credentials, source, manifests, and evidence
envelopes are not returned.

To retain and independently check the self-authenticated integrity wrapper:

```bash
receipt_path="$(mktemp)"
npm --silent run release:canary -- \
  --candidate "$(git rev-parse HEAD)" \
  --expected-revision "$(git rev-parse HEAD)" \
  --trusted-protected-source > "$receipt_path"
# A trusted producer now transmits the matching pin over a separate channel.
: "${EXPECTED_CANARY_RECEIPT_SHA256:?set from an independent trusted channel}"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { verifySelfAuthenticatedCanaryReceipt } from "./scripts/run-signed-release-canary.mjs";
  const bundle = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const expected = { signedCanonicalReceiptSha256: process.argv[2] };
  if (!verifySelfAuthenticatedCanaryReceipt(bundle, expected)) process.exit(1);
' "$receipt_path" "$EXPECTED_CANARY_RECEIPT_SHA256"
rm -f "$receipt_path"
```

Successful verification against an independently obtained pin establishes only
that the receipt matches that pin and its signature. Verification using values
copied from the same bundle would establish only self-consistency and is
not distinguishable by the helper, so it provides no tamper resistance.
Neither result establishes who ran the command, whether the selected source
was protected, whether effects were contained, or whether any release or
runtime action is authorized.

This canary is evidence, not authorization. It grants **zero** permission to
publish, tag, install an active runtime, launch, deploy, start a service,
activate, or roll back. Even a verified candidate/rollback pair remains
`observation-only`; the normal protected CI, npm trusted-publisher approval,
release tag, provenance, runtime installation, launch, and production
acceptance gates remain separate and mandatory.

## Install channels

- **git checkout** (contributors): `ashlr update` = `git pull --ff-only` + rebuild.
- **npm install** (users): `ashlr update` detects the npm channel, checks the
  registry (bounded, degrades offline), and installs only with `--yes`.
