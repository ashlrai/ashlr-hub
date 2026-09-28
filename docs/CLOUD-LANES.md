# The cloud and Devin lanes (overview)

> Moved from the top-level [README](../README.md) to keep the README short. Content is unchanged apart from link paths. Full details: [CLOUD.md](CLOUD.md) and [DEVIN.md](DEVIN.md).

## The cloud lane

New in 3.11. Verse can start **Claude Code cloud sessions** (claude.ai/code) and
track what they deliver. They run on your Claude account, including its cloud
credits, so they keep working after the subscription window is spent.

- **Start one** from Command (**New cloud task**), from a chat (**Run in cloud**
  in the composer's ⋯ sheet), or with `ashlr cloud launch "<task>"`. Verse can
  also work through its own improvement backlog: **Improve Verse** launches the
  next item now, and with self-improvement on the server launches at most 4 a
  day on its own.
- **Each task is instructed to deliver to GitHub.** Verse cannot read a session
  back, so it asks the session to push `ashlr-cloud/<taskId>` and open a **draft**
  PR with a report block. Verse follows a matching PR with `gh` and lists it in
  Needs you when open. Failed launches and missing PRs remain separate states.
  **Nothing in the lane merges.**
- **Spend is an estimate, and is labelled as one.** Claude does not expose the
  credit balance. Verse counts $3 per launched session against $250 by default,
  and you correct it after checking
  [claude.ai/settings/usage](https://claude.ai/settings/usage). Limits: 4 at
  once, 20 a day, and self-improvement stops at a $40 reserve.
- **It launches only as the `claude-a` seat**, signed in with a claude.ai
  account. Cloud sessions refuse API keys.
- **Turn it off:** `ashlr cloud budget --self-improve off` stops launches Verse
  starts itself, and `ASHLR_CLOUD_AUTO=0` stops the background scheduler.
- **Under a standing grant** (3.13), a cloud PR on a granted repo is taken in by
  the standing merge pass and lands only through G0–G7, from the fleet App's
  own PR. Everything else is triaged in Needs you with a Clean or Held verdict.

How it works, the delivery contract, the budget math and every failure code:
[`docs/CLOUD.md`](https://github.com/ashlrai/ashlr-hub/blob/master/docs/CLOUD.md).

### The Devin lane (3.15)

Devin (Cognition) sits beside the cloud lane, **off by default**.
`ashlr devin connect` verifies a `cog_…` key (a service user with the Member
role, or a personal access token) and stores it in the macOS Keychain;
`ashlr devin budget --acu <n>` sets an ACU budget with a per-session hard cap
and a reserve. Then pick **Devin (cloud)** in New chat for a Devin session per
chat, or **Devin (CLI)** to drive the `devin` agent on this Mac (after
`devin auth login`). **Run in Devin** (composer ⋯ sheet or ⌘K) or
`ashlr devin launch "<task>"` hands off a task that must deliver one PR from
`ashlr-devin/<taskId>`. With `ashlr devin fleet on`, custody helper 1.1.0 or
later and a grant that names Devin, the fleet may launch Devin on well-scoped
backlog work. Devin PRs come to Needs you and go through the same standing
gates as cloud PRs, where a Devin PR merges only at a stage that names Devin
and with judges from two different model families; otherwise it is shadow and
waits for you. Setup (including Devin's training opt-out and GitHub
integration) and limits:
[`docs/DEVIN.md`](https://github.com/ashlrai/ashlr-hub/blob/master/docs/DEVIN.md).
