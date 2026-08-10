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
- environment: leave blank (the workflow does not use a GitHub environment);
- allowed action: **npm publish**.

The equivalent authenticated npm CLI command requires npm 11.15.0 or newer:

```bash
npm trust github @ashlr/hub \
  --repo ashlrai/ashlr-hub \
  --file release.yml \
  --allow-publish
npm trust list @ashlr/hub
```

The `trust list` output must show the exact repository and workflow binding
before a tag is authorized. npm does not validate the binding when it is saved;
a typo otherwise fails only at publish time. The release workflow uses a pinned
npm 11 client on a GitHub-hosted Node 24 runner, requests `id-token: write`, and
does not inject `NODE_AUTH_TOKEN`.

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
   - **publish** — verify protected-master ancestry → install the pinned npm 11
     trusted-publishing client → `scripts/check-version.mjs` (tag must equal
     `package.json` version) → OIDC-authenticated
     `npm publish --provenance --access public` → `gh release create` with the
     changelog extract.

If npm trusted publishing is missing or its repository/workflow binding is
wrong, publication fails closed with an authentication error. Do not fall back
to a local token/OTP publish: that would bypass the workflow's full-CI,
protected-history, and provenance gates.

## Local dry-run

```bash
npm pack                          # prepack builds; inspect the tarball
node scripts/check-version.mjs v$(node -p "require('./package.json').version")
node scripts/extract-changelog.mjs
```

The CI pack-smoke step installs the tarball into a clean directory and
exercises both the `ashlr` bin and the `@ashlr/hub/types` + `/core` entry
points, so a broken exports map can never ship.

## Install channels

- **git checkout** (contributors): `ashlr update` = `git pull --ff-only` + rebuild.
- **npm install** (users): `ashlr update` detects the npm channel, checks the
  registry (bounded, degrades offline), and installs only with `--yes`.
