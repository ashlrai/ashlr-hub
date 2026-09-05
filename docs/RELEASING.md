# Releasing @ashlr/hub

> **Verified distribution state — 2026-09-05 UTC:** `@ashlr/hub@3.3.2` is the
> accepted npm production version. Both npm dist-tags, `latest` and `candidate`,
> resolve to `3.3.2`. Its immutable package SRI is
> `sha512-674ZY76hBxks8j9JR5QifoyMn6uxmRx6dhbgiYAuWRyrnB4Zeuo/H+rgQ1mQ/mNYf62s1ORnJcvTxbxHZFuqTA==`.
> Release run `33932333902` completed successfully at protected commit
> `2971c9f767c934e12fd056bf8c6dca5164ffe7d2`, and production-promotion
> admission run `33933861238` completed successfully against that same commit.
> The admission artifact is deliberately pre-effect evidence and records
> `promotionExecuted: false`; the live registry proves the later promotion,
> but there is not yet an immutable post-effect receipt binding that npm
> mutation back to the admission artifact.
>
> The immutable 3.3.0 package remains quarantined incident evidence and must
> never move to `latest`, be reinstalled or activated, or have its version or
> tag rewritten. Version 3.3.1 and its GitHub Release remain absent while its
> failed tag and run remain preserved. The source manifest has advanced to the
> unreleased 3.4.0 development line; the frozen 3.3.2 workflows are not a 3.4.0
> publication path. Registry promotion did not install or activate any local
> runtime, enable a resident service, configure providers, or authorize spend.

The 3.3.2 release and promotion procedures below are completed historical
evidence and recovery references. Do not recreate or move `v3.3.2`, republish
its immutable package version, or repeat its promotion effect. Their frozen
workflow assertions remain valuable fail-closed evidence, but a future release
requires a separately reviewed successor contract.

## Local verification for the 3.4.0 successor

GitHub Actions are repository-disabled. The tracked M570 policy for 3.4.0 is
verified entirely on the local macOS host with the M571 gate; local verification
does not itself authorize or perform publication or promotion.

The policy must bind the exact committed `ashlr.verify.json` digest and the
expected tarball SRI. With exact Node 24+ and npm 11+ versions from that policy
on `PATH`, run:

```bash
npm run verify:local-production -- \
  --expected-sha "$(git rev-parse HEAD)" \
  --policy .github/release-policies/vX.Y.Z.json \
  --artifact /absolute/external/path/ashlr-hub-X.Y.Z.tgz \
  --receipt /absolute/external/path/local-production-receipt.json
```

The runner verifies a clean exact commit in a fresh detached worktree, runs the
complete contract with an allowlisted environment, preserves the exact verified
tarball, keeps operational Ashlr state and services untouched, and writes a
canonical authority-free receipt outside the repository. Its disposable
scratch and sandbox-profile roots are short, exclusive mode-`0700` directories
under canonical `/private/tmp`, preserving macOS Unix-socket pathname capacity
for nested tests. Disposable `HOME`, `USERPROFILE`, `ASHLR_HOME`, and Vitest
worker homes are held separately under a mode-`0700` custody root in the
validated canonical Darwin per-user temporary directory, so custody-sensitive
tests do not inherit `/private/tmp`'s world-writable ancestry. The sandbox
allowlist covers both roots while the real user home remains denied. Only the
exact root-level `pack-evidence.json` leaf is additionally writable, and the
runner reads it through a bounded, no-follow, identity-stable descriptor. Verify
the receipt and tarball with `scripts/verify-local-production-gate-receipt.mjs` and all six
independent caller pins before separately considering any registry or GitHub
mutation. Receipt schema v2 records confinement per gate: build, package,
dependency, native, and web-test stages remain macOS-sandboxed, while the three
exact-source `test:ci` shards use the sanitized disposable environment without
an outer sandbox so their process, socket, nested-sandbox, and
filesystem-semantics tests remain truthful. Those test stages retain the host
account's authority. See
[`CONTRACT-M571.md`](contracts/CONTRACT-M571.md) for the exact boundary.

## Trusted-publisher configuration used for 3.3.2

The 3.3.2 release used npm **trusted publishing**. Any future publishing
mutation requires an authenticated maintainer with package write authority and
account-level 2FA; repository or GitHub administration alone cannot complete
or replace that registry authority.

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

## Completed 3.3.2 successor release record and frozen procedure

This section records the completed 3.3.2 successor procedure. It is not an
authorized lane for another publish. The immutable 3.3.0 candidate remains
quarantined evidence; superseding its `candidate` dist-tag did not rehabilitate,
reinstall, activate, rewrite, or promote 3.3.0.

At action time, the one-version successor-candidate lane required npm `latest`
to equal `3.0.1`, `candidate` to equal `3.3.0`, immutable version 3.3.0
to retain integrity
`sha512-mYVuJZyoXeSnnqivoLzyZggNgpJoWM8glTI7CW0oBfQ0RCHx0xueTrLwLTZBg5W+E4zPOJNbckptYeb5YsdOHw==`,
the lightweight `v3.3.0` tag to remain at
`d07f6a96eda664d865b9255f71c6f56e8cd9d7c7`, and versions 3.3.1 and 3.3.2 to
be absent. Those action-time dist-tag and 3.3.2-absence preconditions are now
historical and deliberately false: both live dist-tags resolve to 3.3.2. The
failed lightweight `v3.3.1` tag must remain at
`f2c9353db35fbf12889bddafd8acc2b7ca5ae67c`; release workflow run
`32396250683`, attempt 1, must remain completed with failure; and the v3.3.1
GitHub Release must remain absent. Never rerun that workflow, move or delete
the tag, publish or reuse version 3.3.1, or create a GitHub Release for it.
The tagged 3.3.2 merge commit's first parent remains the exact protected safe
rollback revision `d6c1a5ec3626f715018a8ffb929906ac0f52f5c9`.
Release run `33932333902` passed all 14 jobs and published the exact SRI recorded
in the verified distribution state above. Before the tag was authorized, an
authenticated npm maintainer verified with the pinned npm 11 client that
`npm trust list @ashlr/hub` exactly matched the repository, workflow,
environment, and `npm publish` permission documented above. The successful
3.3.0 publication had proved only that the binding worked for that exact attempt.
The failed 3.3.1 attempt stopped during native verification, before the
trusted-publisher binding was exercised. Neither attempt replaces the
action-time binding check that was performed for 3.3.2.

The workflow serializes runs for the exact release ref and performs the registry
admission immediately before `npm publish`. npm dist-tags do not offer a
compare-and-swap operation, so this shrinks but cannot eliminate a race with an
independent npm maintainer mutating tags outside GitHub Actions. Any unexpected
post-publication tag state is an incident and blocks the GitHub prerelease.
The release policy accepts only a lightweight tag whose current GitHub ref still
resolves directly to the event commit; annotated tags, tag rewrites, and deleted
tags fail closed.

The numbered procedure below is retained to audit and recover the completed
release. Do not execute its tag creation or publication effect again.

1. Confirm `version` in the release commit's `package.json` is exactly `3.3.2`.
2. Make sure `CHANGELOG.md` has a `## [3.3.2]` section — the release FAILS
   without one (`scripts/extract-changelog.mjs` enforces changelog discipline;
   its body becomes the GitHub release notes).
3. Confirm protected `master` is at the intended release SHA and its required
   checks are green. Commit, then create and push only the exact lightweight
   release tag (do not force, move, delete, or recreate it):

   ```bash
   test "$(git rev-parse HEAD^1)" = "d6c1a5ec3626f715018a8ffb929906ac0f52f5c9"
   git tag v3.3.2
   git push origin v3.3.2
   ```

4. `.github/workflows/release.yml` then:
   - **verify** — full CI gate (typecheck / lint / build / test);
   - **release_canary** — on a disposable GitHub-hosted runner, check out the
     exact event SHA without retained Git credentials, install exact Node
     24.19.0 and a symlink-free npm 11.19.0 runtime, invoke its canonical CLI
     directly, record the hosted Git/tar/sha256sum identities,
     install root dependencies with lifecycle scripts disabled, and run the existing signed release canary
     against that candidate plus its distinct immediate first parent. The job
     verifies the self-authenticated receipt's exact candidate/rollback identity
     and strict `NO_AUTHORITY` schema, binds the stored receipt bytes to SHA-256,
     uploads only the bounded receipt and digest for seven days, and writes only
     SHAs plus the all-false authority posture to the job summary. It has only
     `contents: read`; it has no `npm-release` environment, OIDC permission,
     publishing token, install pointer, or service authority;
   - **prepare** — without an environment or OIDC permission, check out the
     exact event SHA, verify protected-master ancestry, consume the successful
     exact-SHA verify and signed-canary gates, run `npm ci`, build, and
     `scripts/check-version.mjs`, require a clean exact-SHA build identity, and
     create one npm tarball with `prepack` and `postpack` disabled and no root
     `prepare` lifecycle defined. It does not rerun
     the full suite serially inside the private evidence umask; the required
     verify matrix already runs that suite in bounded shards. It binds the
     tarball, npm pack report, and bounded public changelog bytes into a canonical SHA-256/SRI
     manifest, then uploads attempt-unique, non-overwriting candidate and
     release-note artifacts and exports the exact created names for every
     downstream job. Failed-job-only reruns therefore reuse the successful
     prepare attempt's artifacts instead of recomputing names from the new run
     attempt. Candidate-controlled lifecycle and repository code execute only
     in this unprivileged job;
   - **publish** — after explicit `npm-release` approval, run for at most 15
     minutes, install only the pinned
     npm trusted-publishing client and download the prepared artifact. It does
     not check out the repository, install candidate dependencies, build, pack,
     extract runnable files, or invoke candidate scripts. Fixed inline workflow
     commands require exactly three bounded regular files, bind the manifest to
     the upstream SHA-256, recompute tarball SHA-256/SRI, validate the npm pack
     report, bound the complete gzip expansion before tar parsing, and require
     an exact canonical match of every normalized regular member's path,
     0644/0755 mode, and size while enforcing entry-count, expanded-size, and
     per-member caps. It streams only bounded package/build identity bytes
     without executing them, rejects any package-level registry override,
     re-establishes protected-master history, exact successor registry state,
     `latest=3.0.1`, the immutable `v3.3.0` tag identity, and the failed
     v3.3.1 tag/run/skipped-job/npm/GitHub-Release record, and requires the
     live lightweight `v3.3.2` tag to resolve to the event SHA immediately
     before the single OIDC-authenticated `npm publish
     <tarball> --ignore-scripts --provenance --access public --tag candidate`.
     It exports the exact successful publication attempt before that effect so
     a failed-job-only rerun cannot substitute its newer verifier attempt;
   - **verify_publish** — without the `npm-release` environment or OIDC, wait
     for registry propagation, require the exact SRI and provenance metadata,
     verify registry signatures/attestations with pinned npm 11, decode the
     verified SLSA statement and bind its package purl/SHA-512, repository,
     workflow path, tag ref, Git commit, push event, GitHub-hosted builder,
     workflow run, and run attempt to the exact release execution. It also
     proves 3.3.0 retained its exact integrity, `candidate` moved only from
     3.3.0 to 3.3.2, while version 3.3.1 remains absent, and every other
     pre-existing dist-tag including
     `latest=3.0.1` stayed unchanged;
   - **release** — only after `verify_publish` succeeds, download and verify the
     manifest-bound public notes artifact, recheck the live lightweight tag
     against the event SHA immediately before creation, then creates or exactly
     verifies a GitHub prerelease with `--latest=false`. This job has no npm
     tooling, token, OIDC permission, or publish command.

The prepare artifact is a same-workflow handoff, not an independently reproduced
build or separate release authority. A compromised candidate can influence the
bytes prepared for publication, but it cannot request the npm OIDC credential in
that job. The reviewed publisher publishes only the exact manifest-bound bytes;
it never executes the candidate. Independent reproduction, protected review,
registry provenance, isolated installation, rollback, and live acceptance remain
separate gates.

The signed canary is a required fail-closed reproducibility and rollback
observation, not independent release authority. The GitHub-hosted runner retains
network access and workflow infrastructure, and both the canary implementation
and its receipt verifier are pinned by the same workflow commit being evaluated.
A recorded hosted-tool identity is evidence about that run, not an immutable
toolchain guarantee; only Node and npm are version-pinned by this workflow.
A compromise of that protected source could therefore affect producer and
verifier together. Its ephemeral signature proves receipt self-consistency only;
it does not replace protected review, npm trusted-publisher identity, environment
approval, registry provenance, independently pinned rollback, or live acceptance.

For the completed release run, publication created candidate availability; it
did not itself perform production promotion. Provenance, isolated installation,
independently pinned rollback, and live acceptance subsequently passed, and a
separate explicit maintainer action requiring fresh 2FA moved npm `latest` to
3.3.2. Promotion is a separate explicit authority and remains intentionally
absent from the release workflow. No registry state proves local installation,
resident-service activation, provider configuration, or spend authority.

If npm trusted publishing is missing or its repository/workflow binding is
wrong, publication fails closed with an authentication error. Do not fall back
to a local token/OTP publish: that would bypass the workflow's full-CI,
protected-history, and provenance gates.

## Completed production promotion after 3.3.2 acceptance

`@ashlr/hub@3.3.2` was promoted to npm `latest` only after release run
`33932333902` and the GitHub prerelease succeeded, registry provenance was
verified, and an isolated, script-free install passed live acceptance against
the exact candidate integrity. Admission run `33933861238` then succeeded at
the release commit before the interactive 2FA-protected npm effect. The live
registry now resolves both `latest` and `candidate` to `3.3.2`; the quarantined
3.3.0 package retains its exact SRI and lightweight tag and remains ineligible
for `latest`.

The admission receipt is intentionally observation-only, records
`promotionExecuted: false`, and proves no npm mutation. Current registry
metadata proves that the separate effect later occurred, but no immutable
post-effect receipt currently binds that mutation to the admission artifact.
That auditability gap does not authorize a repeat promotion and should be
closed by a credential-free post-promotion observation receipt.

Before the completed dispatch of `.github/workflows/promote.yml`, a repository
administrator configured the `npm-production-promotion` environment with all
of these controls:

- protected branches only, with no custom deployment branch policies;
- exactly one required `User` reviewer, `masonwyatt23`, with no group or
  additional reviewer;
- prevent self-review disabled so Mason may approve a dispatch they initiated;
- `can_admins_bypass` set to `false`;
- no environment secrets.

This is an explicit single-owner production gate, not independent or
two-person approval. Another maintainer or automation may dispatch the
observation workflow, but only `masonwyatt23` can approve the protected job.

The workflow was dispatched from protected `master` with the successful release
run ID, exact 3.3.2 candidate SRI, acceptance-receipt SHA-256, canonical
`acceptance_observed_at`, and the explicit acceptance confirmation. The
acceptance digest and timestamp are human attestations: the workflow does not
retrieve the acceptance receipt, and neither value grants release, npm,
installation, activation, provider, credential, or spend authority. The
timestamp must not be in the future and must be no more than 24 hours old both
when admission begins and when its receipt is created.

The workflow is observation-only. It has no npm credentials, OIDC permission,
or executable npm mutation command and cannot promote the package. Its only
writes are a bounded GitHub receipt artifact and bounded job summary. Any
rerun, expired acceptance, or drift in the source SHA, protected branch,
release/tag identity, candidate integrity or dist-tags, quarantined 3.3.0
integrity/tag identity, failed v3.3.1 tag/run/npm/GitHub-Release absence,
provenance, environment protections, or accepted receipt invalidates the prior
observation; repeat acceptance and admission
against the new exact state.

After the fresh successful admission receipt, an npm package owner used a clean
maintainer shell to revalidate the live registry and owner identity. The
following effect recipe is retained as historical evidence and a recovery
reference; do not run its `dist-tag add` command again for 3.3.2. It pins the npm
client and registry explicitly and takes the expected 3.3.2 SRI from the
accepted release receipt, not from the live query:

```bash
set -euo pipefail
registry="https://registry.npmjs.org/"
: "${EXPECTED_CANDIDATE_INTEGRITY:?set from the accepted 3.3.2 release receipt}"
quarantined_integrity="sha512-mYVuJZyoXeSnnqivoLzyZggNgpJoWM8glTI7CW0oBfQ0RCHx0xueTrLwLTZBg5W+E4zPOJNbckptYeb5YsdOHw=="
promotion_root="$(mktemp -d)"
trap 'rm -rf "$promotion_root"' EXIT

npm install --global --prefix "$promotion_root" npm@11.19.0 \
  --ignore-scripts --no-audit --no-fund --bin-links=false \
  --registry="$registry"
npm_cli="$promotion_root/lib/node_modules/npm/bin/npm-cli.js"
test -f "$npm_cli" && test ! -L "$npm_cli"
test "$(node "$npm_cli" --version)" = "11.19.0"

export NPM_CONFIG_USERCONFIG="$promotion_root/npmrc"
install -m 600 /dev/null "$NPM_CONFIG_USERCONFIG"
node "$npm_cli" login --registry="$registry"
npm_owner="$(node "$npm_cli" whoami --registry="$registry")"
node "$npm_cli" owner ls @ashlr/hub --registry="$registry" \
  | awk -v owner="$npm_owner" '$1 == owner { found = 1 } END { exit !found }'

test "$(node "$npm_cli" view @ashlr/hub@3.3.2 dist.integrity \
  --registry="$registry")" = "$EXPECTED_CANDIDATE_INTEGRITY"
test "$(node "$npm_cli" view @ashlr/hub@3.3.0 dist.integrity \
  --registry="$registry")" = "$quarantined_integrity"
test "$(node "$npm_cli" view @ashlr/hub dist-tags.candidate \
  --registry="$registry")" = "3.3.2"
test "$(node "$npm_cli" view @ashlr/hub dist-tags.latest \
  --registry="$registry")" = "3.0.1"

node "$npm_cli" dist-tag add @ashlr/hub@3.3.2 latest \
  --registry="$registry"
test "$(node "$npm_cli" view @ashlr/hub dist-tags.latest \
  --registry="$registry")" = "3.3.2"
test "$(node "$npm_cli" view @ashlr/hub@3.3.0 dist.integrity \
  --registry="$registry")" = "$quarantined_integrity"
```

The completed effect did not place an OTP in the command, shell history, or
GitHub; the fresh OTP was entered only at npm's interactive prompt. npm `latest`
promotion changes public package discovery only; installing or activating a
runtime, enabling a resident service, configuring providers or application
credentials, and authorizing spend remain separate gates.

### Completed GitHub stable-release finalization after npm promotion

After both npm dist-tags resolved to the accepted 3.3.2 package, PR #340 merged
the one-shot stable-finalization lane to protected `master` at
`1a7d44efe7a8383513fea4dbfa6746fdeb9fa93d`. Workflow run `33937472105`,
attempt 1, then completed successfully from that exact commit. Do not rerun the
completed finalization or repurpose the observation-only `promote.yml`: the
latter has no mutation authority by design.

The dedicated `github-stable-release-finalization` environment, ID
`21286317607`, was verified with protected branches only, no custom branch
policies, exactly one required user reviewer (`masonwyatt23`), self-review
permitted, administrator bypass disabled, and no secrets. The workflow verified
the reviewer, branch, and bypass policy after approval and contained no
environment-secret references.

The successful run consumed release run `33932333902`, promotion-admission run
`33933861238`, the exact 3.3.2 SRI recorded above, and explicit finalization
confirmation. It preserved the package, lightweight tag, npm provenance, release
body, and empty asset set bound to release source
`2971c9f767c934e12fd056bf8c6dca5164ffe7d2`, and performed exactly one GitHub
Release PATCH. GitHub Release ID `383083121` is now stable and the GitHub latest
release for `v3.3.2` (`draft: false`, `prerelease: false`). The final bounded
artifact is ID `9960674976`, named
`github-stable-release-finalization-33937472105-1`, with artifact digest
`sha256:63c910fe2ab554493e2378e44edd9b9657531f7ff03497b8ec96a23b90d57285`;
its post-effect receipt SHA-256 is
`089add5ae05d3f439c258fdfe263279857a0fa60f3b51600f322d807d0550a17`.

That receipt proves only the bounded GitHub Release mutation. It grants no npm,
installation, runtime, service, provider, credential, or spend authority. The
exact authority, evidence, incident, and inverse-PATCH rollback policy remains
in [`contracts/CONTRACT-M523.md`](contracts/CONTRACT-M523.md) as controlled
historical recovery guidance. Any inverse PATCH requires a newly reviewed
incident decision and protected-environment approval; it is never automatic and
does not roll back npm. Registry rollback remains a separate fresh-2FA mutation.

## Historical failure recovery record — never republish an immutable npm version

The 3.3.0 publication and GitHub prerelease are already complete. Preserve this
section as incident evidence only; do not run its 3.3.0 recovery commands or
rerun release run `32104836076`.

An npm package version is immutable. Never rerun the whole workflow, rerun the
`publish` job, or run `npm publish` locally after the registry may have accepted
that version.

The protected lightweight tag `v3.2.0` remains at its original commit. Its
2026-08-15 workflow run stopped at the signed no-authority canary before the
prepare, npm publish, verification, and GitHub Release jobs. Never move, delete,
recreate, or reuse that tag or version. The protected lightweight tag `v3.2.1`
likewise remains at its original commit. Its 2026-08-15 workflow run
`31920010042` passed all nine native verification jobs and then stopped at the
signed no-authority canary because npm pack reported non-portable file modes;
the prepare, npm publish, verification, and GitHub Release jobs never ran, and
no 3.2.1 package was published. The protected lightweight tag `v3.2.2` also
remains at its original commit. Its 2026-08-15 workflow run `31923285323`
passed all nine native verification jobs and the signed no-authority canary,
then stopped at the first unprivileged prepare admission because the runner
rejected an unsupported `gh api --fail` flag. Dependency installation, build,
packing, npm publication, verification, and GitHub Release creation did not run,
and no 3.2.2 package was published. The protected lightweight tag `v3.2.3`
also remains at its original commit. Its 2026-08-16 workflow run `31926786319`
passed all nine native verification jobs and the signed no-authority canary,
then stopped in unprivileged prepare when the duplicate unsharded test pass hit
its bounded runtime cap before packing or artifact upload. No deployment
approval was requested, and npm publish, publication verification, and GitHub
Release creation were skipped; no 3.2.3 package was published. Never move,
delete, recreate, or reuse any failed tag or version. The protected lightweight
tag `v3.2.4` likewise remains at its original commit. Its 2026-08-16 workflow
run `31931284428` passed all nine native verification jobs, the signed
no-authority canary, and unprivileged prepare. After the exact npm-release
deployment was approved, the privileged job stopped in its fail-closed artifact
verifier because two pack-report aggregate predicates addressed npm's
one-element JSON array as an object. Registry admission and `npm publish` never
ran; publication verification and GitHub Release creation were skipped; no
3.2.4 package was published. Never move, delete, recreate, or reuse any failed
tag or version. The protected lightweight tag `v3.2.5` likewise remains at
`dd5d5f8fa25cbebd395a31971cf1e8d78c0195db`. Its 2026-08-16 workflow run
`31934899656`, attempt 1, passed all nine native verification jobs, the signed
no-authority canary, unprivileged prepare, and privileged registry admission.
The single publish command then stopped before its registry request because npm
interpreted the unprefixed relative tarball path as GitHub shorthand and its SSH
lookup failed. Publication verification and GitHub Release creation were
skipped; no 3.2.5 package was published. Do not rerun run `31934899656`; never
move, delete, or recreate its tag, or reuse version 3.2.5. The reviewed
canonical-path repair merged separately at protected commit
`b5554ed4881a02e7665a8ebc54f219f09a367d5d`; version 3.2.6 was the only
successor lane at that point. It subsequently published the immutable public 3.2.6
package with integrity
`sha512-b8O5Nxfb9IfYsmgSW80CAYW+3ZPlet8u7NALOfG8XGFnAAEWxvLtbLKer3psNg7rxkDrAt+rhUjzRzri72PFkA==`
under npm `candidate`, while preserving `latest=3.0.1`. Its protected
lightweight tag remains at `80d49d718d893d0cb02f85a62cd9d2691f4f39c3`.
Never move, delete, recreate, or reuse `v3.2.6` or version 3.2.6. Version 3.2.7
was the next successor lane; it subsequently published the immutable public
3.2.7 package with integrity
`sha512-Zep4krYD7uKqh2k+Z6w0sMyNDsLFjEtV1H8EqdM7yKTKCHSq79lJb7jGoH1qrfOXDBRTJTmG7bSDSPOBUFj+yA==`
under npm `candidate`, while preserving `latest=3.0.1`. Its protected
lightweight tag remains at `73931bdd31b3b4e4d905a30b5112e4cd712f7844`.
Never move, delete, recreate, or reuse `v3.2.7` or version 3.2.7. The immutable
3.3.0 candidate is quarantined and ineligible for npm `latest`; preserve its
tag, release, package, and provenance unchanged. The completed controlled
3.3.2 publication superseded its `candidate` dist-tag without changing that
immutable incident evidence. The protected
lightweight `v3.3.1` tag remains at
`f2c9353db35fbf12889bddafd8acc2b7ca5ae67c`; its workflow run `32396250683`,
attempt 1, completed with failure before npm publication or GitHub Release
creation. Preserve that exact failed attempt and both absences. Never move,
delete, recreate, rerun, publish, or reuse v3.3.1. Version 3.3.2 was the sole
successor lane and used protected revision
`d6c1a5ec3626f715018a8ffb929906ac0f52f5c9` as its exact first-parent rollback.

The following contingency was available only during the 3.3.2 release window.
It was not needed by successful run `33932333902` and must not now be executed
against the completed immutable release. If **publish had succeeded and only
`verify_publish` or the GitHub `release` job had failed**, the first step would
have been to verify that npm contained the intended tag artifact from a clean
checkout of that tag:

   ```bash
   version=3.3.2
   git switch --detach "v${version}"
tag_checkout="$(pwd)"
expected_revision="$(git rev-parse HEAD)"
: "${EXPECTED_RUN_ID:?set to the accepted GitHub Actions release run id}"
: "${EXPECTED_RUN_ATTEMPT:?set to its accepted run attempt}"
test "$(node -p 'process.versions.node.split(".")[0]')" = "24"
node_bin="$(node -p "require('node:fs').realpathSync(process.execPath)")"
toolchain_bin="$(dirname "$node_bin")"
npm_shim="$toolchain_bin/npm"
npm_shim_target="../lib/node_modules/npm/bin/npm-cli.js"
test -L "$npm_shim"
test "$(readlink "$npm_shim")" = "$npm_shim_target"
npm install --global npm@11.19.0 --ignore-scripts --no-audit --no-fund --bin-links=false
npm_cli="$(node -p "const p=require('node:path'); p.resolve(process.argv[1],process.argv[2])" "$toolchain_bin" "$npm_shim_target")"
npm_root="$(dirname "$(dirname "$npm_cli")")"
test ! -e "$npm_shim" && test ! -L "$npm_shim"
test -f "$npm_cli" && test ! -L "$npm_cli"
test "$(realpath "$npm_cli")" = "$npm_cli"
test "$(node -p "require('node:fs').lstatSync(process.argv[1]).nlink" "$npm_cli")" = "1"
test "$(node "$npm_cli" --version)" = "11.19.0"
test -z "$(find "$npm_root" -type l -print -quit)"
ln -s "$npm_shim_target" "$npm_shim"
test -L "$npm_shim"
test "$(readlink "$npm_shim")" = "$npm_shim_target"
test "$(realpath "$npm_shim")" = "$npm_cli"
test "$(npm --version)" = "11.19.0"
node "$npm_cli" ci
node "$npm_cli" run build
test -z "$(git status --porcelain --untracked-files=all)"
expected_integrity="$(node "$npm_cli" pack --dry-run --json --ignore-scripts | jq -r '.[0].integrity')"
published_integrity="$(node "$npm_cli" view "@ashlr/hub@${version}" dist.integrity)"
test -n "$expected_integrity" && test "$expected_integrity" = "$published_integrity"
test "$(node "$npm_cli" view '@ashlr/hub' dist-tags.latest)" = "3.0.1"
test "$(node "$npm_cli" view '@ashlr/hub' dist-tags.candidate)" = "$version"

verification_root="$(mktemp -d)"
trap 'rm -rf "$verification_root"' EXIT
cd "$verification_root"
node "$npm_cli" init --yes >/dev/null
node "$npm_cli" install --ignore-scripts --no-audit --no-fund --save-exact \
  "@ashlr/hub@${version}"
installed_version="$(node -p "require('./node_modules/@ashlr/hub/package.json').version")"
test "$installed_version" = "$version"
node "$npm_cli" audit signatures --json --include-attestations > npm-signature-audit.json
node "$tag_checkout/scripts/verify-npm-release-provenance.mjs" \
  npm-signature-audit.json \
  "@ashlr/hub" "$version" "$expected_integrity" \
  "https://github.com/ashlrai/ashlr-hub" ".github/workflows/release.yml" \
  "refs/tags/v${version}" "$expected_revision" "$EXPECTED_RUN_ID" "$EXPECTED_RUN_ATTEMPT"
```

The documented next step would have used GitHub's **Re-run failed jobs** control,
or the equivalent command:

```bash
gh run rerun RUN_ID --failed
```

In that failure state, because `publish` would already have been successful,
this would have rerun only unsuccessful downstream verification/release jobs,
reused the digest-bound handoff, and bound provenance to the successful
publisher's exported run attempt rather than the newer verifier attempt; it
would not have invoked npm publication. The release job also accepted an
already-created GitHub Release only when its tag, title, body, release flags,
and exact tag commit all match.

If npm publication itself had failed or its result had been ambiguous during
that release window, the recovery procedure was:

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
   version=3.3.2
   release_tag="v${version}"
   test "$(git rev-parse HEAD)" = "$(git rev-list -n 1 "$release_tag")"
   release_notes="$(mktemp)"
   trap 'rm -f "$release_notes"' EXIT
   node scripts/extract-changelog.mjs "$version" > "$release_notes"
   gh release create "$release_tag" --verify-tag --title "$release_tag" \
     --notes-file "$release_notes" --prerelease --latest=false
   ```

4. If the version is absent, rerun publish only when the log proves the publish
   command did not begin or the registry definitively rejected it before any
   publication. Unknown transport state remains a stop condition.
5. If the version exists with a different integrity, stop and treat it as a
   release incident. npm immutability means it cannot be overwritten.

There is no token/OTP fallback and no recovery path that republishes an existing
version.

If any post-publication integrity, provenance, signature, candidate-tag, or
preserved-dist-tag check fails, treat the immutable 3.3.2 version as a release
incident. Do not create the GitHub prerelease, do not install it, and do not
promote it to `latest`.

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

New candidate observations emit unsigned runtime-manifest schema v3. Schema v3
uses its own digest domain and requires
`scripts/scorecard-history-worker.mjs` to be both declared by the root package
and bound as an artifact. The verifier retains reader-first compatibility with
genuine schema-v2 packages that predate that worker, using the unchanged v2
digest domain. A schema-v2 package that does contain the worker must bind it;
the candidate slot rejects schema v2, while the rollback slot may use a valid
v2 or v3 release. This compatibility bridge preserves an independently pinned
3.3.2 rollback without weakening the current candidate contract.
The signed envelope names the v3 scorecard-worker artifact set explicitly. Its
v2 trust-root coverage remains the backward-compatible minimum: a v3 envelope
may satisfy that minimum only when its coverage exactly matches the v3 manifest
schema, so re-signing a v3 manifest with the legacy coverage literal is refused.

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
