# M523 — GitHub stable-release finalization

M523 closes the public-channel gap after `@ashlr/hub@3.3.2` has already been
published, accepted, and promoted to both npm `candidate` and npm `latest`.
It changes only the existing GitHub Release with ID `383083121`: one protected
workflow run changes `prerelease` from `true` to `false` and requests
`make_latest=true`.

## Fixed identity

The workflow is pinned to all of the following:

- package `@ashlr/hub`, version `3.3.2`, lightweight tag `v3.3.2`, and source
  commit `2971c9f767c934e12fd056bf8c6dca5164ffe7d2`;
- candidate SRI
  `sha512-674ZY76hBxks8j9JR5QifoyMn6uxmRx6dhbgiYAuWRyrnB4Zeuo/H+rgQ1mQ/mNYf62s1ORnJcvTxbxHZFuqTA==`;
- successful release run `33932333902`, attempt 1, and successful promotion
  admission run `33933861238`, attempt 1;
- admission artifact ID `9959487443`, artifact digest
  `223193104d72509f481907e920a5fda586db055d9efaf3e846dd85c2c835953b`,
  and admission receipt digest
  `0b3552324284856423356d12e7b04334c530ea5471666f3fc82647426a57b86d`;
- GitHub Release ID `383083121`, notes SHA-256
  `f7b2dc191b3491ce29da3b31a6afb6703d9403f4c5ef3b0066ca0bed5a647ba5`,
  and canonical assets SHA-256
  `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`;
- prior GitHub latest Release ID `341086222`, tag `v3.0.0`; and
- first-parent rollback source
  `d6c1a5ec3626f715018a8ffb929906ac0f52f5c9`.

The empty asset list hashes as canonical JSON `[]`; the notes digest covers the
exact GitHub API body bytes. Any later body or asset edit invalidates this lane.

## Admission and effect

`.github/workflows/finalize-github-release.yml` is manual, serialized, and
one-shot. It must run from current protected `master`, and the release source
must remain in that branch's history. A read-only preflight job performs the
package, provenance, and evidence checks without a protected environment or
release-mutation permission. It uploads a bounded attempt-specific receipt.
Only the second job has `contents: write`; it downloads and verifies that exact
current-run preflight, uses the dedicated `github-stable-release-finalization`
environment, rechecks the live mutation-critical state, and verifies that the
environment:

- admits protected branches only, with no custom branch policies;
- has administrator bypass disabled; and
- has exactly one required user reviewer, `masonwyatt23`, with self-review
  permitted.

That environment is an explicit single-owner production gate, not two-person
review. It must be configured by a repository administrator before dispatch;
the workflow neither creates nor modifies it. The workflow verifies the
reviewer, protected-branch, custom-policy, and administrator-bypass settings and
contains no environment-secret references. GitHub does not expose secret values
to the job, so the repository administrator must separately confirm that the
environment secret inventory is empty.

Before the effect, the two-job lane proves the exact release and admission runs,
artifact and receipt, protected branch, lightweight tag and merge parent,
current prerelease, prior GitHub latest, unchanged notes/assets, exact npm SRI,
`latest=candidate=3.3.2`, registry signature metadata, and the decoded SLSA
provenance statement binding the package to the exact release workflow, ref,
commit, run, and attempt. It then re-reads the mutable public state immediately
before the effect.

There is exactly one GitHub mutation:

```http
PATCH /repos/ashlrai/ashlr-hub/releases/383083121
Content-Type: application/json

{"prerelease":false,"make_latest":"true"}
```

The job then requires Release ID `383083121` to be non-draft and non-prerelease,
and requires `/releases/latest` to return that same ID and `v3.3.2`. It also
rechecks npm tags/SRI, the lightweight tag, notes digest, and asset digest. A
bounded receipt records the exact evidence, effect, postconditions, and all
excluded authorities.

The protected effect job has `contents: write` only because GitHub's release
update endpoint requires it. It does not check out or execute repository code,
install npm, or download the published package. The read-only preflight is the
only job that executes the provenance verifier and inspects installed package
metadata. Neither job has OIDC permission, an npm credential, npm mutation
command, tag write, package publish, install-pointer, daemon, activation,
provider, communication, financial, or spend authority. A successful run
proves public GitHub release metadata alignment; it does not install or activate
Ashlr Hub.

## Failure and rollback

This lane is fail-closed and intentionally cannot be rerun successfully after
finalization, because its precondition requires `prerelease=true`. GitHub's
release update API has no compare-and-swap primitive, so an external repository
administrator can still race the immediate pre-effect read. Any postverification
failure is a release incident and requires inspection before another mutation.

Rollback is never automatic. A rollback requires a new reviewed protected
workflow revision, a fresh approval through the same
`github-stable-release-finalization` environment, revalidation that no newer
stable release superseded v3.3.2, and exactly this inverse GitHub request:

```http
PATCH /repos/ashlrai/ashlr-hub/releases/383083121
Content-Type: application/json

{"prerelease":true,"make_latest":"false"}
```

The rollback postcondition is `/releases/latest` returning Release ID
`341086222`, tag `v3.0.0`, while the v3.3.2 tag, notes, and assets remain
byte-identical. This inverse request does not change npm. If package discovery
must also roll back, npm `latest` restoration is a separate registry mutation
requiring its own current-state validation, protected admission, fresh
maintainer 2FA, receipt, and postverification; M523 grants no such authority.
