# Devin in Verse (3.15)

Verse works with **Devin** (Cognition's hosted coding agent) in three places:

- **Two chat seats.** **Devin (cloud)** runs a Devin session per chat; **Devin
  (CLI)** drives the `devin` command-line agent on this Mac. Both are in New
  chat beside Claude Code, Codex, Grok and local models.
- **A lane you hand tasks to.** **Run in Devin** and `ashlr devin launch` start
  a session that must deliver one pull request.
- **A fleet producer.** Under a standing grant that names Devin, the fleet can
  launch Devin sessions on well-scoped backlog work.

Every Devin pull request reaches your repositories only through the same
Needs-you triage and standing merge gates as cloud PRs. Under a grant,
**Devin cloud** PRs merge only when the current stage names `devin` and judges
from two different model families approve. Cloud intake records a mode, not
the model that ran. **Devin CLI** work using a host-signed elite model (SWE-2,
GPT-6 Astra/Sol/Luna, or an elite Claude id) can pass on green tests without
judges under an `elite-direct` grant. Otherwise the gates record a would-merge
(shadow) and the PR waits for you
([AUTHORITY.md §1a](AUTHORITY.md#1a-elite-self-land-315)).

The lane is **off by default**; only the Devin (CLI) seat appears without it,
once Cognition's `devin` CLI is installed. The code is in `src/core/devin/`, the CLI is
`ashlr devin`, and the Verse routes are under `/api/verse/devin`. The cloud
lane it mirrors is described in [CLOUD.md](CLOUD.md).

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

7. **Optional: the Devin CLI seat.** Install and sign in to Cognition's CLI in
   your own terminal:

   ```sh
   brew install --cask devin-cli
   devin auth login
   ```

   The **Devin (CLI)** seat appears in New chat once the binary is found. It
   does not use the API key above.
8. **Optional: fleet use.** Three things, all yours:
   - `ashlr devin fleet on` records the opt-in.
   - Reinstall the custody helper so it can sign grants that name Devin
     (helper 1.1.0 or later): `sudo scripts/install-custody.sh` from the
     ashlr-hub checkout. With an older helper, a drafted grant leaves Devin
     out and its summary says to reinstall.
   - Sign a grant that includes Devin: `ashlr authority draft`, or re-approve
     from Verse. With the opt-in on, a key connected and the new helper, the
     draft adds `devin` to the grant and a Devin seat that may only produce.

   Until the grant names Devin, the Devin card's Fleet line reads **Not in the
   grant** and the fleet launches nothing.

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
| Fleet sessions at once | 1 | `--fleet-concurrent` |
| Fleet sessions per day | 3 | `--fleet-per-day` |
| Dollar estimate per ACU | $2.25 | `--usd-per-acu` |

A launch is refused, with the reason, when no budget is set, the budget is
paused, the free ACUs do not cover one session's cap, or the daily ACU, session
or concurrency cap is reached. A finished session whose usage was never read
counts its **whole** cap, so an unknown reading never looks free.

Devin (cloud) chats are your own work: they count against the ACU budget, but
never against the fleet caps or the reserve. A chat's first message is gated
like any launch; follow-ups in an existing chat are not re-checked against
the daily cap or the pause, because the session's own ACU cap bounds them.
**Devin (CLI) chats are not counted at all**: the CLI reports no usage, and
the Devin card says so.

---

## Using it

### Chat with Devin

Pick a Devin seat in **New chat**.

- **Devin (cloud)** (seat id `devin`). The chat's first message starts a Devin
  v3 session on the folder's GitHub origin; each later message is sent to that
  session. Devin's replies stream back into the transcript, with status chips
  (working, waiting for you, asleep, finished), a card for each PR it opens and
  an ACU reading in the chat header ("3/10 ACU"). A session that went to sleep
  wakes on your next message. **Stop** asks which you mean: stop watching
  (Devin keeps working; your next message checks in) or terminate the session,
  which cannot be resumed. In **Plan** mode Devin is told to investigate and
  propose, and to change nothing until you say so. The seat is disabled, with
  the reason, when Devin is not connected, the lane is off or the key was
  refused.
- **Devin (CLI)** (seat id `devin-cli`) runs your local `devin` agent over the
  Agent Client Protocol (`devin acp`). It streams text, thinking and tool
  calls, resumes the CLI's own session, and answers the CLI's permission
  requests by the chat's permission mode (Plan allows read-only tools). Models
  offered: Devin's default, opus, sonnet, swe, codex and gemini. Before every
  turn Verse checks that the binary is installed and that the CLI's
  credentials file exists (it never runs the CLI to check). If not, the turn
  is refused before anything starts:
  - "The Devin CLI is logged out. Run `devin auth login` in a terminal, then
    send again."
  - "The Devin CLI is not installed on this Mac. Install it with `brew install
    --cask devin-cli`, run `devin auth login`, then send again."

Both seats run through Verse's own turn process, and every line they print is
scrubbed. The Auto seat line above the composer is hidden on Devin chats, and
Auto never picks a Devin seat. A handoff note can start a Devin chat, and a
Devin chat can be handed off like any other. A `!macro` typed in a Devin chat
runs its playbook ([Playbooks](VERSE.md#playbooks-315)); a playbook is never
auto-matched to a chat.

**Where chat PRs go.** A PR from a Devin (cloud) chat comes to Needs you like
any Devin PR, naming the chat. A GitHub PR link that a Devin (CLI) turn prints
is recorded for that chat (`~/.ashlr/devin/cli-prs/`), shown as the chat's PR
card, and listed in Needs you with **Dismiss** only. Verse did not check those
PRs, so there is no Land or Close; the item expires after 7 days.

### Hand Devin a task

- **Run in Devin** is in the composer's ⋯ sheet, under Run in cloud, and in ⌘K
  as "Run in Devin…". It sends the text in the message box as a Devin session
  on the chat project's GitHub origin, capped at the per-session ACUs, after
  asking for the mutation token. It is disabled, with the reason, when Devin is
  not connected, the lane is off, the key was refused, the project has no
  GitHub origin, the budget refuses, or the message is empty or over 20,000
  characters. The ⌘K entry opens the sheet; it never launches by itself.
- **From the CLI:**

  ```sh
  ashlr devin status [--json]
  ashlr devin launch "Fix the flaky retry test" --repo owner/name [--base main] [--title t] [--json]
  ashlr devin list [--all] [--json]          # unfinished tasks, plus the last 3 days
  ashlr devin refresh [--json]               # read session status and ACUs; ask GitHub for PRs
  ashlr devin message <task-id> "<text>"     # reply to a waiting session (up to 4,000 characters)
  ashlr devin budget [--acu N] [--per-session N] [--per-day N] [--reserve N] …
  ashlr devin enable | disable               # turn the lane on or off; running sessions continue on Devin
  ashlr devin fleet on | off                 # fleet opt-in (default off)
  ashlr devin disconnect                     # remove the key from the Keychain and turn the lane off
  ```

  `launch` defaults `--repo` to the folder's GitHub origin and `--base` to the
  repository's default branch. Exit codes: 0 ok, 1 error or refused, 2 usage.
- **Playbooks.** A launch whose text contains a `!macro`, or that names a
  playbook, carries that playbook's text ahead of the delivery contract and
  records its version on the task. A named playbook that does not exist
  refuses the launch before anything is spent.

### In the Resources drawer (⌘.)

The Devin card shows the connection state (Connected, Key refused, Not
connected, Turned off or Not set up) with its reason, ACUs left with a meter,
sessions running and today, the dollar estimate, and two readiness lines:

- **Chat:** "Pick “Devin (cloud)” in New chat. Each chat is one Devin
  session." when ready, or what to fix.
- **Fleet:** Off, Waiting, **Not in the grant** (with "Draft a new grant (or
  re-approve) with the Devin fleet opt-in on."), Paused or Ready.

A line for the CLI reads "Devin (CLI): usage not reported by the CLI, so CLI
chats are not counted here", with "run `devin auth login`" when the CLI is
logged out. Up to five sessions waiting on you get **Open in Devin** and a
**Reply to Devin…** box. When the lane is on, the resource bar in the rail
shows a Devin row.

### In Needs you (⌘J)

Each open Devin PR is "Devin task ready for review", with the session's
report marked unverified, a **Clean** or **Held** verdict and the same actions
as a cloud PR: **Land**, **Close**, **Update branch** and **Dismiss**, each
pinned to the PR head, and **Land all clean**. **Evidence** opens the task's
timeline: session status and detail, ACUs used out of the cap with the dollar
estimate, messages sent from Verse, and the shared PR, gate, merge and release
steps. Close takes an optional one-line reason (up to 200 characters); the
task records "Closed in Verse: <reason>", the GitHub close comment includes
it, and the retro learns from it. Sessions waiting on you ("Devin is
waiting") and launches that failed in the last 24 hours are listed too.

---

## How it works

**The delivery contract.** Every task prompt carries the same contract as the
cloud lane, with Devin's names. The session must:

- push only the branch `ashlr-devin/<taskId>` (task ids look like
  `dv_20260927T0412_k3f9q2`), never the base, `main`/`master` or a fork;
- open **one** PR against the base, titled `[ashlr-devin] …`, whose body ends
  in an `ashlr-devin-report` block (status `done`, `partial`, `blocked` or
  `no-change`, plus summary, tests run, risks and files changed), and open it
  even when blocked or when there is nothing to change;
- never merge, approve a PR or enable auto-merge, and never include secrets.

A cloud chat gets a chat version of the contract: the same branch, one PR and
no merging, but it may converse first. Each session is created with a hard
`max_acu_limit` and a pinned mode (`normal` by default; `fast`, `lite` and
`ultra` are accepted, `fusion` is refused because multi-model routing has no
single producer identity). A task with no PR after 12 hours becomes
`expired`. A chat that ends without a PR is not a failed task end.

**Tracking.** Status and ACUs come from Devin's API; delivery comes only from
GitHub, read with `gh`. A PR that Devin reports on some other branch is never
pinned. Verse refreshes every 60 seconds while a session is live and every 10
minutes otherwise. `ASHLR_DEVIN_AUTO=0` in the server's environment stops that.

**Devin's own engine identity.** In routing and in grants Devin is its own
engine, `devin`. It has no dispatch lane of its own and no capacity row, and
reserve budget mode keeps it off. A grant may name it only as a producer: a
Devin seat can never judge or lead.

**The fleet launcher.** Once per standing tick, after the cloud-PR intake and
never on a dry run, the daemon may launch one Devin session. It checks, in
order, and the first check that fails decides: KILL; a grant in force; the lane
on (`devin.enabled`); the fleet opt-in (`devin.fleet`); the grant's current
stage naming `devin` with a producer seat; the key; the budget mode; and the
fleet budget (reserve, daily ACUs, sessions per day, concurrency, and the
fleet caps). KILL is read again just before the API call. It takes work from
the shared cloud backlog: the Leader's `work.dispatch` items and bounded-fix
areas (bug, issue, tests, reliability, accessibility, ux, charts, accounts and
similar), on a repository in the grant, with a brief of at most 8,000
characters. An item claimed by one lane is never taken by the other. Each
launch is written to the ledger before the call (`devin:fleet-launch`; if that
row is refused, nothing launches), then `devin:fleet-launched` or
`devin:fleet-launch-failed`; `devin:fleet-hold` records why it is holding,
when that changes. The daemon re-reads Devin session status at most every 2
minutes. The Leader's `devin.launch` action and automations with the `devin`
lane use the same fleet entry point and gates.

**The Devin CLI as a fleet producer (`devin-cli`).** The fleet can also run
the local Devin CLI on the compiled SWE-2 allowlist, originally listed as free
on a Devin Max account with CLI 3000.11.3. That historical listing does not
establish fresh account-specific pricing or perpetual free use. It works like
the Codex and Claude Code CLI engines: each run gets a sandbox worktree, and
its edit is captured as a pending proposal. The command is
`devin -p --model <m> --permission-mode smart --respect-workspace-trust false -- <goal>`.

- **Permission mode.** `smart` is the least permissive mode that can both
  edit and run tests: `auto` is read-only and `accept-edits` has no shell.
  `dangerous` and Devin's own `--sandbox` are never used; the run's OS
  confinement is the containment.
- **Authorization.** It is the `devin-cli` lane, but the grant still names
  only `devin`. The same switches as the fleet launcher apply: the lane on
  (`devin.enabled`), the fleet opt-in (`devin.fleet`), and the grant's stage
  naming `devin` with a producer Devin seat. The budget mode must also allow
  the Devin seat.
- **Model.** Set it with `devin.fleetModel`; the default is `swe-2-high`.
  Only the compiled models (`swe-2-high`, `swe-2-medium`, `swe-2-max`) run under
  autonomy; other models hold because their billed spend cannot be read back.
- **Readiness.** The probe checks executable access and credentials-file
  presence, as it does for the CLI chat seat. A missing file closes the lane
  with the fixing command. Presence does not validate the provider login,
  account identity or pricing; qualify the current account, model and price
  before autonomous activation.
- **Routing.** The lane has one slot. It takes work that no other seat can
  take right now.
- **Recording and cost.** Runs are recorded as `devin-cli:<model>` and cost
  accounting retains the historical zero-charge classification. That is not
  a current provider billing observation.
- **Login.** An autonomous run gets a private copy of the CLI's login.
  Nothing is written back to your real login.

**Cash exhaustion and pricing qualification (3.18).** The Devin CLI does not
qualify for the new exhausted-USD exception. Its existing positive-budget
admission and the hosted lane's separate ACU policy remain unchanged. Before
activating the CLI lane, qualify the actual account, exact model and current
price; missing or historical evidence must not be presented as fresh zero-price
proof. A future account-pricing admission contract must expire and recheck that
evidence. The [official pricing page](https://devin.ai/pricing), reviewed on
October 1, 2026, advertises eligible-plan free SWE-2 in Desktop and CLI through
October 16, 2026; it does not promise indefinite free access.

**Intake into the standing gates.** When a standing grant is in force and the
lane is on, each standing tick runs the same intake as cloud PRs
([Intake into the standing gates](CLOUD.md#intake-into-the-standing-gates-313)):
same repo and base, head exactly `ashlr-devin/<taskId>`, the diff pinned to the
head and read twice, the report marked UNVERIFIED, then G0–G7 including
`ashlr/verify`. Two things differ:

- **Two judges.** The producer is `devin:<mode>` in the review family `devin`,
  and Devin never judges. For a Devin proposal, G6 looks at the newest verdict
  from each judge family, under the usual single-judge rules (eligible frontier
  judge, another family, merge intent, fresh, attested). Ships from **two
  different families** pass; one ship waits for a judge from another family;
  any eligible rejection refuses. One judge alone is not enough, because it
  may share Devin's undisclosed underlying model.
  **Elite self-land (3.15).** When the producer identity names an elite
  model, no judge is needed, not even one; this applies to the local CLI
  lane's `devin-cli:swe-2-high` and `devin-cli:gpt-6-sol`, and to `devin:`
  with the same ids. The current stage must be `elite-direct`. G3's tests and
  G7's `ashlr/verify` decide. A cloud session records only its mode
  (`devin:normal`), which names no model, so it still needs two judges. A
  vendor-named suffix never changes Devin's family: `devin-cli:gpt-6-sol` is
  family `devin`, not `openai`.
- **Merging.** At merge time the standing pass merges a Devin PR only if the
  live stage names `devin` and either the recorded judges still satisfy the
  two-judge rule or, for elite work, the stage is still `elite-direct` and the
  model still allowed. Otherwise it records the would-merge as `shadow` and
  the PR waits for you. The legacy merge pass never merges Devin work.

**API endpoints used** (Devin v3, `https://api.devin.ai/v3`, `Authorization:
Bearer cog_…`): `GET /self`, and under `/organizations/{org_id}/sessions`
create, get, list (to recover a session by its task tag when a create response
is lost), `messages`, and delete (terminating a chat's session, after you
confirm). Reads back off on 429, 5xx and network errors. A create is retried
**only** on 429, because v3 has no idempotency key and a blind retry could
bill a second session.

**Storage.** `~/.ashlr/devin/` holds `tasks/<id>.json`, `budget.json`,
`connection.json` and `cli-prs/` (directories 0700, files 0600). Logs and
errors redact `cog_…` and `apk_…` keys.

---

## Limits

- **Merging needs a grant that names Devin, and either two judges or a verified
  elite Devin CLI model under `elite-direct`.** Cloud Devin still needs two
  judges. Otherwise Devin PRs are shadow: the gates record a would-merge and
  the PR waits for you.
- **Fleet use needs a new custody helper and a new grant.** Helpers before
  1.1.0 cannot sign a grant that names Devin.
- **CLI chats are unmetered and unverified.** The CLI reports no usage, so its
  chats are not counted in the ACU budget, and its PRs get only Dismiss in
  Needs you.
- **macOS only for the key.** Storing it needs the macOS Keychain.
- **Spend is in ACUs; dollars are an estimate.** Only app.devin.ai knows the
  bill.
- **Devin's side is Devin's.** Data controls, the GitHub integration's
  repository list and the service user's role are set on app.devin.ai. A 403
  from Devin usually means the service user's role is wrong; a 401 means the
  key was revoked or expired (`ashlr devin connect` again). A `!macro` also
  stays in the text Devin receives, so a Devin-side playbook with the same
  macro would apply as well.
