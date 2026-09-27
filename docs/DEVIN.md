# Devin in Verse (3.15)

Verse can start **Devin** sessions (Cognition's hosted coding agent) and follow
what they deliver, next to Claude Code, Codex, Grok, local models and Claude
cloud sessions. Devin is a **resource**, not a chat seat. It works in sessions
that end in a pull request, and those pull requests reach your repositories
only through the same Needs-you triage and standing merge gates as cloud PRs.

The lane is **off by default**. Nothing a Devin session produces is ever merged
automatically: Devin PRs are **shadow-only at every rollout stage**. The gates
record what they would have done, and the PR waits for you.

The code is in `src/core/devin/`, the CLI is `ashlr devin`, and the Verse routes
are under `/api/verse/devin`. The cloud lane it mirrors is described in
[CLOUD.md](CLOUD.md).

---

## Setup

You do every step yourself, in your own terminal and on app.devin.ai. Verse
never asks for the key in the page, and no HTTP route accepts one.

1. **Plan.** You need a Devin plan with API access (Teams or Enterprise).
2. **Training opt-out.** Decide whether Devin may train on your code. On paid
   plans an organization administrator can opt out on Devin's **Data Controls**
   settings page. Cognition documents that opting out also enables zero data
   retention with its model providers, and that Enterprise data is never used
   for training without written consent
   ([Security at Cognition](https://docs.devin.ai/admin/security)). Ashlr does
   not read or change this setting. Check it before you connect a private
   repository.
3. **GitHub integration, on selected repositories only.** On app.devin.ai go to
   Settings › Integrations and install Devin's GitHub integration on the
   repositories Devin should work on. Pick them one by one rather than granting
   the whole organization. Sessions need it to push `ashlr-devin/*` branches
   and open PRs. The integration is Devin's, not the `ashlr-fleet` App.
4. **API key.** On app.devin.ai go to Settings › Devin API and create one of:
   - a **service user with the Member role** (recommended: it is not tied to a
     person, and Member is enough to create and read sessions), or
   - a **personal access token**.

   Both start with `cog_`. Legacy `apk_` keys are refused because they do not
   work with the v3 API.
5. **Connect.**

   ```sh
   ashlr devin connect                 # paste the key at the hidden prompt
   ashlr devin connect --org org-…     # for an org-scoped service user
   ```

   The org id is at the top of Settings › Devin API. Connect verifies the key
   with Devin (`GET /v3/self` and a one-item session list) before storing it.
   The key goes into the **macOS Keychain** (service `ai.ashlr.devin`, trusted
   only by `/usr/bin/security`), written on stdin and never on a command line.
   It is never written to a file. `~/.ashlr/devin/connection.json` holds only
   the organization and principal. On success the lane turns on, and connect
   reminds you about the budget and the GitHub integration. The prompt works
   only in an interactive terminal, and storing the key needs macOS.
6. **Budget.** Set the ACU budget before the first launch:

   ```sh
   ashlr devin budget --acu 50         # your total ACUs; see the table below
   ashlr devin budget                  # show the budget
   ```

7. **Optional: fleet use.** `ashlr devin fleet on` records that the fleet may
   launch Devin sessions within the budget, keeping its reserve, under a
   standing grant. See [Limits](#limits): in 3.15 nothing in the fleet calls
   it yet.

Check the result with `ashlr devin status`, or the Devin card in the Resources
drawer (**⌘.**).

### Budget

Devin bills in ACUs. The budget is kept in ACUs, and any dollar figure is a
labelled **estimate**, because Devin publishes no per-ACU price for self-serve
plans. The real usage is on app.devin.ai (Settings › Usage), and the Devin card
links to it. The budget lives in `~/.ashlr/devin/budget.json`, not in config.

| Setting | Default | Flag |
|---|---|---|
| Total ACUs | 50 | `--acu` |
| Correction for usage Verse did not see | 0 | `--spent` |
| ACUs per session, sent to Devin as the hard `max_acu_limit` | 10 | `--per-session` |
| ACUs per day, used plus held by running sessions | 30 | `--per-day` |
| Reserve kept for you (the fleet never dips into it) | 10 | `--reserve` |
| Pause launches at this share of the total | 90 % | `--pause-at` |
| Sessions at once | 2 | `--max-concurrent` |
| Sessions per day | 10 | `--max-per-day` |
| Dollar estimate per ACU | $2.25 | `--usd-per-acu` |

A launch is refused, with the reason, when no budget is set, the budget is
paused, the free ACUs do not cover one session's cap, or the daily ACU, session
or concurrency cap is reached. A finished session whose usage was never read
counts its **whole** cap, so an unknown reading never looks free.

---

## Using it

**In Verse.**

- **Resources drawer (⌘.)** has a Devin card: connection state (Connected,
  Key refused, Not connected, Turned off or Not set up) with its reason, ACUs
  left with a meter, sessions running and today, the dollar estimate, and the
  Chat and Fleet readiness lines. Up to five sessions that are waiting on you
  get **Open in Devin** and a **Reply to Devin…** box. When the lane is on, the
  resource bar in the rail shows a Devin row.
- **Run in Devin** is in the composer's ⋯ sheet, under Run in cloud, and in ⌘K
  as "Run in Devin…". It sends the text in the message box as a Devin session
  on the chat project's GitHub origin, capped at the per-session ACUs, after
  asking for the mutation token. It is disabled, with the reason, when Devin is
  not connected, the lane is off, the key was refused, the project has no
  GitHub origin, the budget refuses, or the message is empty or over 20,000
  characters. The ⌘K entry opens the sheet; it never launches by itself.
- **Needs you (⌘J)** lists "Devin task ready for review" for each open PR, with
  the session's report marked unverified, and the same Land, Close, Update
  branch and Dismiss actions as a cloud PR, each pinned to the PR head. It also
  lists sessions waiting on you ("Devin is waiting") and launches that failed
  in the last 24 hours.

**From the CLI.**

```sh
ashlr devin status [--json]
ashlr devin launch "Fix the flaky retry test" --repo owner/name [--base main] [--title t]
ashlr devin list [--all] [--json]          # unfinished tasks, plus the last 3 days
ashlr devin refresh                        # read session status and ACUs; ask GitHub for PRs
ashlr devin message <task-id> "<text>"     # reply to a waiting session (up to 4,000 characters)
ashlr devin budget [--acu N] [--per-session N] [--per-day N] [--reserve N] …
ashlr devin enable | disable               # turn the lane on or off; running sessions continue on Devin
ashlr devin fleet on | off                 # fleet opt-in (default off)
ashlr devin disconnect                     # remove the key from the Keychain and turn the lane off
```

`launch` defaults `--repo` to the folder's GitHub origin and `--base` to the
repository's default branch. Exit codes: 0 ok, 1 error or refused, 2 usage.

---

## How it works

**The delivery contract.** Every prompt carries the same contract as the cloud
lane, with Devin's names. The session must:

- push only the branch `ashlr-devin/<taskId>` (task ids look like
  `dv_20260927T0412_k3f9q2`), never the base, `main`/`master` or a fork;
- open **one** PR against the base, titled `[ashlr-devin] …`, whose body ends
  in an `ashlr-devin-report` block (status `done`, `partial`, `blocked` or
  `no-change`, plus summary, tests run, risks and files changed), and open it
  even when blocked or when there is nothing to change;
- never merge, approve a PR or enable auto-merge, and never include secrets.

Each session is created with a hard `max_acu_limit` and a pinned mode (`normal`
by default; `fast`, `lite` and `ultra` are accepted, `fusion` is refused because
multi-model routing has no single producer identity). A task with no PR after
12 hours becomes `expired`.

**Tracking.** Status and ACUs come from Devin's API; delivery comes only from
GitHub, read with `gh`. A PR that Devin reports on some other branch is never
pinned. Verse refreshes every 60 seconds while a session is live and every 10
minutes otherwise. `ASHLR_DEVIN_AUTO=0` in the server's environment stops that.

**Intake into the standing gates.** When a standing grant is in force and the
lane is on, each standing tick runs the same intake as cloud PRs
([Intake into the standing gates](CLOUD.md#intake-into-the-standing-gates-313)):
same repo and base, head exactly `ashlr-devin/<taskId>`, the diff pinned to the
head and read twice, the report marked UNVERIFIED, then G0–G7 including
`ashlr/verify`. Two things differ:

- **Its own judge family.** The producer is `devin:<mode>` in the review family
  `devin`, so the G6 judge must come from another family (xAI first, then
  Codex, then Claude). Devin never judges.
- **Shadow-only.** At every rollout stage the standing pass records a
  would-merge for a Devin proposal and leaves the PR for you. The legacy merge
  pass skips Devin proposals entirely. Admitting Devin to auto-merge is a
  separate decision; the code notes it should require two judges from two
  different families, because one judge may share Devin's undisclosed model.

**API endpoints used** (Devin v3, `https://api.devin.ai/v3`, `Authorization:
Bearer cog_…`): `GET /self`, and under `/organizations/{org_id}/sessions`
create, get, list (to recover a session by its task tag when a create response
is lost) and `messages`. Reads back off on 429, 5xx and network errors. A create
is retried **only** on 429, because v3 has no idempotency key and a blind retry
could bill a second session.

**Storage.** `~/.ashlr/devin/` holds `tasks/<id>.json`, `budget.json` and
`connection.json` (directories 0700, files 0600). Logs and errors redact `cog_…`
and `apk_…` keys.

---

## Limits

- **Not a chat seat.** The Resources card's Chat line reads "n/a — Devin works
  in sessions, not chat turns". Use Run in Devin from a chat.
- **No autonomous Devin dispatcher.** `ashlr devin fleet on` sets the opt-in and
  the Fleet readiness line can read Ready, but in 3.15 nothing in the fleet
  starts a Devin session on its own. Only the intake of PRs that Devin sessions
  have already opened is automatic.
- **Not a grant engine.** A standing grant cannot name Devin as an engine yet;
  doing that safely needs a custody contract change. Fleet use is bounded by
  `devin.fleet`, a live grant with the repo in it, and the ACU reserve.
- **Never auto-merged.** Shadow-only at every stage, as above.
- **Needs you gaps.** Devin items have Land, Close, Update branch and Dismiss,
  but not the inline verdict panel or **Land all clean**, which still key on
  cloud task ids. The evidence timeline does not cover Devin tasks yet.
- **macOS only for the key.** Storing it needs the macOS Keychain.
- **Spend is in ACUs; dollars are an estimate.** Only app.devin.ai knows the
  bill.
- **Devin's side is Devin's.** Data controls, the GitHub integration's
  repository list and the service user's role are set on app.devin.ai. A 403
  from Devin usually means the service user's role is wrong; a 401 means the
  key was revoked or expired (`ashlr devin connect` again).
