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

The autonomous operator is **safe by construction** — these are not policies you
trust the model to follow, they are guards enforced in code and covered by a
permanent regression suite. Run `ashlr verify-safety` at any time to self-check
the live ones (5/5 structural checks).

| Guarantee | How it's enforced |
|---|---|
| **Proposal-only** — nothing pushes, merges, opens PRs, deploys, or applies a change without your explicit `ashlr inbox approve` | The Approval Inbox is the sole outward path; the daemon imports no apply/push/PR/deploy primitive (statically guarded) |
| **Sandboxed** — autonomous code work happens only in isolated git worktrees, never your working tree | `requireSandbox` aborts to zero tasks if a sandbox can't be created; the approved patch lands on a *new branch*, never your tree |
| **Enrollment-gated** — only repos you `ashlr enroll` are ever touched; default is empty | Every mutating path calls `assertMayMutate`; a test-only `allowAnyRepo` hatch is itself env-gated |
| **Kill switch always wins** — `ashlr enroll kill on` (or `touch ~/.ashlr/KILL`) halts everything immediately | Checked first and unconditionally, before enrollment, in every gate |
| **Local-first** — your code is never sent to a cloud model by default | Cloud providers throw unless you pass `--allow-cloud` *and* a key is present |
| **Bounded** — hard daily budget + concurrency caps; crash-safe (no double-spend, orphan reclaim) | Budget/concurrency stress-tested; daemon/swarm crash recovery proven |
| **Fully audited** — every enroll, kill, proposal, approval, apply, and daemon action is logged | Append-only `~/.ashlr/audit/`; view with `ashlr audit`; secrets are scrubbed before write |

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
