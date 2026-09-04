# Dependency security policy

Ashlr Hub checks the root and Raycast npm lockfiles plus
`desktop/src-tauri/Cargo.lock` on every pull request, relevant `master` push,
weekly schedule, and manual audit run. The workflow has read-only repository
authority. Every action is pinned to a full commit, and the RustSec scanner is
an exact release archive whose SHA-256 digest is verified before execution.
The npm lockfiles must first reproduce through strict `npm ci`. The primary
scanner remains pinned npm, with full and production audits for both graphs.
Only a recognized transport failure after three bounded attempts may invoke an
exact OSV-Scanner release binary whose SHA-256 digest is verified. A valid npm
vulnerability report never falls back, and an unavailable or non-clean fallback
also fails the job. Each lane records its provider result in the job summary.

## Dependabot cooldown

Routine npm and Cargo version updates wait 3 days for patch releases, 7 days
for minor releases, 30 days for major releases, and 5 days when a SemVer class
is unavailable. This is a review window for newly published packages, not a
security-update delay: GitHub applies `cooldown` only to version updates, so
Dependabot security updates bypass it.

For a non-security emergency, add the exact dependency name to that ecosystem's
`cooldown.exclude` list in a dedicated pull request. The pull request must link
the incident or release blocker, name the reviewing maintainer, state an expiry
date, and remove the exclusion after the update merges. Wildcard exclusions are
not permitted. Security advisories need no override because they already bypass
the cooldown.

## Desktop RustSec containment

The audit ignores exactly `RUSTSEC-2024-0429` while Linux desktop output remains
quarantined. That exception does not resolve, dismiss, or downgrade
`GHSA-wrw7-89jp-8q8g`; Dependabot alert 32 must remain open until the supported
Tauri v3 / GTK4 migration resolves to `glib >=0.20` and the documented Linux
desktop quarantine exit review succeeds. The root Linux CLI, Bun sidecar, and
web dashboard remain supported.

RustSec reports 17 existing warning-class findings in the Tauri v2 dependency
graph (unmaintained GTK3-era crates and other warning advisories). They are
visible debt, not green health. The audit fails on every non-excepted
vulnerability; warning-class findings remain reported while the desktop
migration is quarantined and tracked separately.

The gate's introduction also updates only `plist` 1.9.0 to 1.10.0 and its
`quick-xml` child from 0.39.4 to 0.41.0. That removes
`RUSTSEC-2026-0194` and `RUSTSEC-2026-0195` without changing a direct desktop
manifest dependency.

A path, git, or vendored replacement for GLib is not remediation. RustSec can
omit non-default-registry packages from its vulnerability lookup, so such a
replacement could create a false clean result without a supported release. The
policy tests require the vulnerable GLib package to retain its exact crates.io
registry source and checksum, prohibit Cargo patch/source replacement, and keep
the Linux build, bundle, workflow, and external-disable controls intact.
