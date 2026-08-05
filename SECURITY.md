# Security & Safety

ashlr-hub runs autonomous agents against real code, so safety is a first-class
design goal, not an afterthought. This document describes the safety model and
how to report a vulnerability.

## Reporting a vulnerability

Please **do not** open a public issue for security-sensitive reports. Instead use
GitHub's **private vulnerability reporting** (Security → *Report a vulnerability*)
on this repository, or email the maintainer at the address in the repo profile.
You'll get an acknowledgement, and we'll work with you on a fix and disclosure
timeline. Good-faith research is welcome.

## The safety model (what the system will and won't do)

The autonomous operator enforces safety-critical boundaries in code rather than
asking a model to follow them. The structural guards are covered by a permanent
regression suite. Run `ashlr verify-safety` at any time to self-check the live
ones (5/5 structural checks).

| Guarantee | How it's enforced |
|---|---|
| **Proposal-only generation** — autonomous code generation emits pending proposals and cannot itself apply, push, open a PR, or deploy | The daemon's generation path imports no apply/push/PR/deploy primitive (statically guarded); manual apply and default-off auto-merge are separate authority paths |
| **Sandboxed** — autonomous code generation happens only in isolated git worktrees, never your working tree | `requireSandbox` aborts to zero tasks if a sandbox can't be created; manual inbox apply lands the approved patch on a *new branch*, never your tree |
| **Enrollment-gated** — only repos you `ashlr enroll` are ever touched; default is empty | Every mutating path calls `assertMayMutate`; a test-only `allowAnyRepo` hatch is itself env-gated |
| **Kill switch always wins** — `ashlr enroll kill on` (or `touch ~/.ashlr/KILL`) halts everything immediately | Checked first and unconditionally, before enrollment, in every gate |
| **Local-first** — your code is never sent to a cloud model by default | Cloud providers throw unless you pass `--allow-cloud` *and* a key is present |
| **Bounded** — hard daily budget + concurrency caps; crash-safe (no double-spend, orphan reclaim) | Budget/concurrency stress-tested; daemon/swarm crash recovery proven |
| **Fully audited** — every enroll, kill, proposal, approval, apply, and daemon action is logged | Append-only `~/.ashlr/audit/`; view with `ashlr audit`; secrets are scrubbed before write |

### Outward authority boundaries

| Operation | Default posture | Authority required |
|-----------|-----------------|--------------------|
| Apply a proposal to a local branch | Manual only | Explicit inbox approval and confirmation, enrollment, and kill-switch clear |
| Merge without manual approval | Disabled | Explicit auto-merge enablement plus all configured provenance, verification, risk, scope, and mutation-time gates |
| Merge without a judge | Disabled | Evidence mode additionally requires base- and diff-bound deterministic evidence and live protected-branch policy; it permits protected remote PR handoff only and refuses local fallback, self-targets, partial captures, and build/CI/manifest changes |
| Deploy | No daemon authority | Explicit `ashlr ship --deploy <target> --confirm`; pre-ship success alone does not deploy |
| Install or start an OS service | No fleet-tick authority | Explicit operator invocation of `ashlr setup` or `ashlr daemon install`; both autostart by default, while `ashlr daemon install --no-autostart` installs without starting |

These paths are independent. A green verification result, a judge verdict, or a
merge receipt does not authorize deployment or service mutation. Every gate
fails closed when its required authority or evidence is missing.

See [`docs/RELIABILITY.md`](./docs/RELIABILITY.md) for failure modes, recovery, and
the honest limits (single-machine/single-process; budget overshoot is bounded but
nonzero under concurrency; multi-machine is a gated, unbuilt seam).

## Secrets

Secrets are owned by **phantom** (the secret manager), never committed. The
knowledge index and audit trail scrub secret-shaped tokens before persisting, and
key files (`.env`, `secrets.json`, `.npmrc`, private keys, …) are skipped entirely.
Never paste a real secret into an issue, log, or proposal.

## Supported versions

This is an actively developed private cockpit; security fixes target the latest
`main`. There is no LTS branch.
