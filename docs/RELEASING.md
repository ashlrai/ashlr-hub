# Releasing @ashlr/hub

Releases are tag-triggered and fully gated. Nothing reaches npm without an
explicit human action (pushing a `v*` tag) plus a green full-CI verify job.

## One-time setup

1. Create an npm automation token with publish rights for the `@ashlr` scope.
2. Add it as the `NPM_TOKEN` repository secret on GitHub.

## Release procedure

1. Update `version` in `package.json` (e.g. `2.2.0`).
2. Make sure `CHANGELOG.md` has a `## [2.2.0]` section — the release FAILS
   without one (`scripts/extract-changelog.mjs` enforces changelog discipline;
   its body becomes the GitHub release notes).
3. Commit, then tag and push:

   ```bash
   git tag v2.2.0
   git push origin master --tags
   ```

4. `.github/workflows/release.yml` then:
   - **verify** — full CI gate (typecheck / lint / build / test);
   - **publish** — `scripts/check-version.mjs` (tag must equal
     `package.json` version) → `npm publish --provenance --access public` →
     `gh release create` with the changelog extract.

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
