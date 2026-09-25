# The cloud lane (3.11)

The cloud lane lets Ashlr Verse start **Claude Code cloud sessions**
(claude.ai/code) and follow what they deliver. You can start one from chat, from
Command or from the CLI. Verse can also start them itself, to work through its
own improvement backlog. Sessions run on your Claude account. That includes its
cloud credits, so work continues after the subscription's weekly window is
spent.

The lane never merges anything. Every task ends as a **draft pull request** on
GitHub. From there the existing merge gates (see
[Autonomy with custody](VERSE.md#autonomy-with-custody-310)) or you decide what
happens to it.

The contracts live in `src/core/cloud/types.ts`. The user guide in Verse is
[the Cloud lane section of VERSE.md](VERSE.md#cloud-lane-311).

---

## How a launch works

These mechanics were checked against Claude Code 2.1.280 on 2026-09-24. They
decide the shape of everything else.

- **Only the interactive CLI can create a session.** The command is
  `claude --cloud "<task>"`, and with `-p` it is refused. Verse therefore runs
  the CLI under a pseudo-terminal: `script -q /dev/null <argv…>` on macOS and
  `script -qec "<quoted argv>" /dev/null` on Linux. On success the CLI prints
  three lines and exits 0:

  ```text
  Created cloud session: <title>
  View: https://claude.ai/code/session_<id>?from=cli&m=0
  Resume with: claude --teleport session_<id>
  ```

  Verse strips ANSI and OSC sequences from the output and reads the session id,
  link and title from those lines. Anything else is classified as a failure
  (see [Failure codes](#failure-codes)).
- **It runs as the `claude-a` seat.** The launcher is the argv array in that
  seat's native profile (`~/.ashlr/native-profiles/claude-a/command.json`),
  which is signed in with a claude.ai account. Verse never uses the `claude`
  on your `PATH`, which may be API-key authenticated: cloud sessions refuse API
  keys. The prompt is passed as a single argv element, never through a shell
  on macOS.
- **The session clones the working directory's GitHub `origin` at its current
  branch,** and that branch must already be pushed. So Verse never launches
  from your own clones. It keeps a separate shallow checkout per repository
  under `~/.ashlr/cloud/checkouts/<owner>__<name>`, fetches the base branch
  into it, checks it out with its upstream set, and launches from there. It
  uses your normal git credentials. Launches in one checkout run one at a time,
  because two `--cloud` runs in the same folder conflict.
- **Verse cannot read a session back.** Attaching to an existing session is not
  enabled for this account, so every task is told to deliver to GitHub
  instead (the [delivery contract](#the-delivery-contract)), and Verse tracks
  it with `gh`.
- **A launch times out after 90 seconds.** If no session has appeared by then,
  the process group is killed and the task fails with `timeout`.

The whole flow, in order: validate the request, check the budget gates, save
the task as `queued`, wait for the repository's launch slot, prepare the
checkout, build the prompt, launch, then save `running` with the session link,
or `failed` with a plain reason.

### What Verse checks before launching

- The repository must look like `owner/name` (letters, digits, `.`, `_`,
  `-`).
- The task text is cut to 20,000 characters. The title is its first line, at
  most 80 characters, unless one is given.
- **Seat status is read from disk only.** The seat is ready when the `claude-a`
  profile's `command.json` exists and parses to an argv array. Otherwise
  Verse says "The Claude seat isn't set up on this Mac." It does not run the
  CLI to check sign-in, because that would cost a process on every page load.
  A signed-out seat shows up at launch time as an `auth` failure.

---

## The delivery contract

Every prompt Verse sends is your task text followed by a fixed contract. The
stored task keeps only your text. The contract tells the session to:

1. create and work on the branch `ashlr-cloud/<taskId>`, starting from the
   base branch you chose, and never push to any other branch;
2. never merge anything;
3. run the repository's relevant tests, commit and push;
4. open a **draft** pull request against the base branch titled
   `[ashlr-cloud] <title>`;
5. end the PR body with a fenced `ashlr-cloud-report` JSON block:

   ````text
   ```ashlr-cloud-report
   {
     "status": "done",
     "summary": "One or two sentences on what changed.",
     "testsRun": ["npx vitest run test/example.test.ts"],
     "risks": ["Anything a reviewer should look at first."],
     "filesChanged": 3
   }
   ```
   ````

   `status` is one of `done`, `partial`, `blocked` or `no-change`.
   `filesChanged` is optional.
6. If nothing needs changing, still push an empty commit and open the PR with
   status `no-change`, so Verse sees that the task finished.

Task ids look like `ct_20260924T2331_k3f9q2`: sortable, and safe to use in a
branch name.

Verse reads the **last** well-formed report block in the PR body and
validates it. A missing, malformed or oversized block leaves the task's report
empty; the PR is still tracked.

### Task states

| State | Meaning |
|---|---|
| `queued` | Accepted and waiting for its repository's launch slot. |
| `launching` | The CLI is running under the pseudo-terminal. |
| `running` | The session exists. No PR yet. |
| `pr-open` | A draft or ready PR exists on `ashlr-cloud/<id>`. |
| `merged` | The PR was merged, by the gates or by you. |
| `closed` | The PR was closed without merging, or you dismissed the task in Verse. Dismissing never touches GitHub. |
| `failed` | The launch failed. The failure code and a plain reason are recorded. |
| `expired` | No PR appeared within 6 hours. The session link still works. |

**Tracking.** For each task that is not finished, Verse asks GitHub for a PR
whose head is the task's branch (`gh pr list --head ashlr-cloud/<id>`). A task
moves from `running` to `pr-open`, and from `pr-open` to `merged` or
`closed`. A `running` task with no PR after 6 hours becomes `expired`. If `gh`
fails, tasks stay as they were; tracking never throws into the page or the
scheduler.

---

## The budget, and why it is an estimate

Claude does not expose the credit balance. Neither `/usage` nor the CLI shows
it. So every spend figure in the lane is an **estimate**, and Verse labels it
as one everywhere it appears:

> Estimated at $3 per session — Claude doesn't expose the credit balance.
> Check it on claude.ai and adjust here.

The real balance is at <https://claude.ai/settings/usage>, and Verse links to
it next to every figure.

**How the estimate is built.** Estimated spend is your adjustment plus the
per-session estimate of every task that reached `running` or later. A failed
launch costs nothing. Estimated remaining is the total minus that. The
estimate for a task is fixed when it launches, so changing the per-session
figure later does not rewrite history. Use the adjustment to correct the
estimate after checking claude.ai, or to count credits spent before Verse
started tracking.

| Setting | Default | What it does |
|---|---|---|
| Credits total | $250 | What you say the account has. |
| Spent adjustment | $0 | Added to the estimate. Use it to calibrate against claude.ai. |
| Estimate per session | $3 | The flat figure charged to each launched session. |
| Max concurrent | 4 | Sessions launching or running at once, from any origin. |
| Max sessions per day | 20 | Launches per local calendar day, from any origin. |
| Self-improvement | on | Whether Verse may launch backlog items without a click. |
| Self-improvement repo | `ashlrai/ashlr-hub` | Where self-improvement tasks go. |
| Self-improvement per day | 4 | Self-improvement launches per local day. |
| Self-improvement reserve | $40 | Self-improvement stops when estimated remaining credits fall below this. |

"Today" is your local calendar day, not UTC. Settings are saved in
`~/.ashlr/cloud/budget.json`. Every update is validated and clamped, and a
missing or corrupt file falls back to the defaults.

**Gates.** Before anything is saved or launched, the budget answers two
questions, each with a plain sentence when the answer is no:

- **Can launch?** Checked for every launch. It holds the concurrency limit, the
  daily session cap and the credit estimate.
- **Can self-improve?** Checked additionally for launches Verse starts on its
  own. It adds the self-improvement switch, the self-improvement daily cap
  ("4 of 4 self-improvement launches used today.") and the reserve.

A refused launch is recorded nowhere and costs nothing. It comes back with the
`budget` failure code and the gate's sentence.

---

## Self-improvement

Verse keeps a backlog of work on itself and can hand items to cloud sessions.

- **Built-in items** live in `src/core/cloud/improvement-backlog.ts`. Each is
  a complete brief for a session working in `ashlrai/ashlr-hub`: long-failing
  tests, the first-paint JavaScript target, the runtime probe's event-loop
  stall, harness settings at dispatch, the router's λ weights, and similar
  gaps known as of 3.10.1. The delivery contract is appended to each brief.
- **Your items and the Leader's** are added to `~/.ashlr/cloud/backlog.json`.
  The file is validated and holds at most 200 items. The Leader turns
  code-change actions from its memos into items with ids like
  `leader-<memoId>-<n>`. Its class-C actions still go to Needs you.
- **Claims.** An item is claimed by its newest task. It becomes available
  again 3 days after that task ends `closed`, `failed` or `expired`, and never
  after it ends `merged`.
- **Order.** The next item is the highest priority (1 first), then built-in
  order.

There are two ways to launch backlog items:

- **Improve Verse** (the button on Command, `ashlr cloud improve`, or
  `POST /api/verse/cloud/improve`) launches up to `count` items now: one by
  default, five at most. It checks only the launch gate, because you asked.
- **The scheduler** runs inside the Verse server. It starts when the cloud
  module first loads, never under a test runner. Every 10 minutes it refreshes
  task states from GitHub. Two minutes after start, and then every 60 minutes,
  it launches the next backlog item. Scheduled launches need self-improvement
  switched on **and** the self-improvement gate open. So with the defaults
  Verse starts at most 4 sessions a day on its own, and stops when the estimate
  reaches the $40 reserve. The two jobs never overlap themselves, and each
  distinct error is logged once.

---

## Using it

**In Verse.**

- **Command** has a Cloud card beside the burn-downs. It shows estimated
  credits remaining as a meter ("$X of $250 · estimate") with a link to
  claude.ai usage, and sessions today. Each task has a state chip, **Open in
  Claude** for the session and a link to its PR. The card also has **New cloud
  task**, **Improve Verse**, the self-improvement switch with its daily cap,
  and **Edit budget**.
- In **Chat**, the composer's ⋯ sheet has **Run in cloud**. It sends the typed
  prompt as a cloud task for the chat's project. It is available only when the
  project has a GitHub origin and the seat is ready. Otherwise it is disabled,
  and its tooltip says why.
- **Needs you** lists "Cloud task ready for review" for each task with an open
  PR, with its title, PR link and report summary. It also lists launches that
  failed in the last 24 hours, with the reason.
- **Fleet** shows a "Cloud · N running" chip in its lanes row.
- **Settings ▸ Usage** has a Cloud credits panel with the same budget fields.

**From the CLI.**

```sh
ashlr cloud launch "Fix the flaky retry test" --repo ashlrai/ashlr-hub --base master
ashlr cloud list [--all] [--json]
ashlr cloud refresh                        # ask GitHub for PRs now
ashlr cloud improve [--count N]            # launch backlog items now
ashlr cloud budget --total 250 --spent 12 --per-session 3 --max-per-day 20 \
                   --self-improve on --self-improve-max 4 --reserve 40
ashlr cloud backlog
```

`launch` defaults `--repo` to the current directory's GitHub origin.

**Over HTTP** (the Verse server). `GET /api/verse/cloud` needs the read session.
POST routes need the mutation token, a JSON content type and a bounded body:

| Route | What it does |
|---|---|
| `GET /api/verse/cloud` | Overview: seat status, budget view, the newest 100 tasks and the backlog. Refreshes nothing, so it is cheap. |
| `POST /api/verse/cloud/launch` | Launch one task (`repo`, `prompt`, optional `baseBranch` and `title`). |
| `POST /api/verse/cloud/budget` | Change any subset of the budget. |
| `POST /api/verse/cloud/refresh` | Refresh task states from GitHub. |
| `POST /api/verse/cloud/improve` | Launch up to `count` backlog items. |
| `POST /api/verse/cloud/tasks/<id>/dismiss` | Mark a task `closed` ("Dismissed in Verse."). Does not touch GitHub. |

Responses carry no absolute paths and no secrets.

---

## Failure codes

A failed launch records one of these codes and a plain sentence.

| Code | What happened | What to do |
|---|---|---|
| `seat-unavailable` | The `claude-a` launcher is missing or is not a native profile. | Prepare the seat (`ashlr resources profile prepare --provider claude`) and sign it in. |
| `auth` | The CLI said cloud sessions need a claude.ai account ("requires authentication with a Claude.ai account"). | Sign the `claude-a` seat in with its claude.ai login, not an API key. |
| `not-enabled` | Cloud sessions are not enabled for the account. | Enable them on claude.ai; Verse cannot. |
| `rate-limited` | The provider refused: rate limit, usage limit or out of credits. | Check the balance on claude.ai and correct the budget. |
| `no-remote` | No GitHub origin, not a git repository, or the branch is not pushed. | Push the base branch; check the repo name. |
| `checkout-failed` | Verse could not prepare its checkout. | Check your git credentials for that repository. |
| `budget` | A budget gate refused before anything launched. | Read the gate's sentence; raise the limit or wait for tomorrow. |
| `timeout` | No session appeared within 90 seconds. | Retry; if it repeats, run `claude --cloud` by hand from the checkout to see why. |
| `unparsed` | The CLI exited without printing a recognisable session. | Same as `timeout`. |
| `unknown` | Anything else. | The recorded sentence carries what the CLI said. |

---

## Where things are stored

Everything lives under `~/.ashlr/cloud/` (the same Ashlr home the rest of the
hub uses). Directories are `0700` and files `0600`. Files are written
atomically and opened without following symlinks.

```text
~/.ashlr/cloud/
├── tasks/<id>.json     # one file per task
├── budget.json         # your budget settings
├── backlog.json        # operator and Leader backlog items
└── checkouts/<owner>__<name>/   # the shallow launch checkouts
```

---

## Turning it off

- **Stop Verse launching on its own.** Switch self-improvement off: the toggle
  on the Cloud card, **Settings ▸ Usage**, or
  `ashlr cloud budget --self-improve off`. Tracking continues; nothing launches
  unless you ask.
- **Stop the scheduler entirely.** Start the Verse server with
  `ASHLR_CLOUD_AUTO=0` in its environment. Neither the 10-minute refresh nor
  the hourly self-improvement runs. Manual launches and **Refresh** still work.
- **Nothing launches without the seat.** With no `claude-a` native profile the
  lane refuses every launch with `seat-unavailable`.

Existing sessions keep running on claude.ai whatever you do here. Stop them
there, and close their PRs on GitHub.

---

## Limits

- Spend is an estimate. Only claude.ai knows the balance.
- Verse cannot read a session back, so it knows what a task did only from its
  PR and report block. A session that ignores the contract shows as `running`
  and then `expired`. Its link still works.
- The lane launches only through the `claude-a` seat. Other seats cannot start
  cloud sessions.
- Nothing in the lane merges. A cloud PR goes through the same custody gates as
  any other fleet change, or waits for you.
