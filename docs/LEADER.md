# Talking to the Leader (3.14+)

## Release-backed articles (successor candidate)

The opt-in `release-articles` maintenance lane follows Phantom's latest stable
GitHub release. It uses fresh official GitHub and npm reads to bind the exact
numeric repository and current name, release tag, commit and source tree,
all 15 CI platform jobs and their required steps, dependency Audit, public
asset metadata, and npm version/integrity. It does not download or execute
release assets. Registry integrity and GitHub asset digests are metadata
observations, not independent byte verification or build-adoption authority.

```sh
ashlr release-articles status --json
ashlr release-articles enable ashlrai/phantom
ashlr release-articles sync --json
ashlr release-articles disable
```

Enablement permits this maintenance lane, not a new grant. A current autonomous
standing grant with exact `ashlrai/ashlar-landing` merge scope, an enrolled
checkout and Stop off is required before it queues an article in the existing
fleet task store. The resident standing tick calls the same maintenance path;
dry runs and disabled/missing configuration do not probe providers or create
state. Disable stops future maintenance; already queued work remains under the
normal fleet task and Stop controls. No new daemon, cron, credentials, paid
artwork, newsletter or social messaging is installed.

A proposed import contains only public identity/version data. This historical
3.24.3 example retains its original legacy repository identity:

```json
{"v":1,"repository":"ashlrai/ashlr-hub","version":"3.24.3"}
```

Use `ashlr release-articles import proposed.json`, then
`ashlr release-articles sync 3.24.3 --json` to observe that explicit version.
Private operational indexes, saved PASS flags and extra keys are refused.
Fresh configuration in the canonical source defaults to `ashlrai/phantom`;
saved configurations and imported historical records keep their recorded
repository. After a repository rename, explicitly select its current exact
name when updating an existing configuration; redirects do not transfer a
grant or activate the renamed label.

The public article draft contains only validated public facts and citations.
The content task reuses the company's authored-story, cover, RSS and SEO
pipeline. Its canonical URL is `https://ashlr.ai/news/phantom-release-3-24-3`
for version 3.24.3. It adds a small public evidence marker beneath
`/research/phantom-releases/3.24.3/evidence.json` and cites it in the article.
The marker binds `{v,releaseKey,factsDigest,canonical}`; it contains no private
receipts, paths, account balances, prompts or tokens. Conceptual art must be
labeled, and numerical benchmark claims need separate public measurements.

| State | Meaning |
|---|---|
| `pending-public-verification` | Fresh official facts are missing or incomplete; no publication claim. |
| `blocked-repository-authority` | Facts can be read, but the exact company repository is not currently authorized/enrolled. |
| `queued` | A real normal fleet task exists; repository checks, PR controls and deployment still apply. |
| `awaiting-production` | Coding work finished or an enqueue outcome is ambiguous; live publication is not confirmed. |
| `published` | The canonical public page and matching public evidence marker were freshly observed. |

A separate phm.dev teaser is queued only after the canonical company article
is observed live and `ashlrai/phantom-secrets` has its own exact standing merge
scope and enrollment. Its production observation is independent. Task
completion never becomes a deployment receipt. A private locked manifest
retains durable per-release/digest task identities even after finished tasks
are pruned. Corrections reuse the canonical article URL, wait for an active
producer and preserve its original publication date. An ambiguous crash is
held for inspection rather than silently duplicating work.

Rollback uses a normal reviewed source correction/removal and deployment;
withdrawing a database story alone cannot remove an authored source article.
This section documents successor source, not activation in the installed
3.24.3 release. Actual publication and company scope activation remain separate
operational steps after source qualification.

The Leader is the fleet's planning agent. It reads deterministic digests of what
the fleet did (history, the ledger, seat headroom, model outcomes, reasoning
insights, lessons, its own hit-rate) and writes **memos**: the bottleneck, one
move with an expected result and a date, goals, standards and questions for
you. Since 3.14 it is also something you talk to.

There is **one Leader and one conversation**. Phantom's Mind surface (⌘4),
Telegram and the `ashlr leader` CLI all read and write the same thread. The
legacy "Elon mode" dialogue and the Director are retired into it; free text from
Telegram reaches the real Leader.

What the Leader may *do* is bounded by your standing grant, never by the
conversation. Directives steer its judgement; they never widen the grant. See
[STANDING-AUTHORITY.md](STANDING-AUTHORITY.md) and
[Autonomy with custody](VERSE.md#autonomy-with-custody-310).

---

## The conversation

- **One thread**, stored at `~/.ashlr/vision/leader/thread.jsonl` (append-only,
  0600, one scrubbed message per line). Above 1 MiB it is archived to
  `thread.1.jsonl`, keeping the newest 1,000 lines. Secrets, home paths and
  emails are scrubbed from your text and from the Leader's.
- **Channels:** Phantom, Telegram, CLI and System, shown as a badge on every
  message.
- **Replies** go through the Leader's own seat routing and budget, with no
  tools: Grok first, then local models (see [Reliability](#reliability)).
  Replies never use Claude, whatever `foundry.leader.claudeFallback` says; that
  opt-in applies to memo runs only. A reply sees the last 30 messages. When it cannot think (no seat, a failure,
  or the 60-calls-a-day cap) it says so ("I can't think right now: …") instead
  of staying silent.
- **Limits:** your message up to 4,000 characters; replies time out after 120
  seconds.
- A reply goes to Telegram only when you wrote from Telegram. Memos, questions
  and updates are sent to Telegram as well as shown in the thread.

---

## Directives

A directive is standing guidance that rides in every memo run until you
retire it. It is the one trusted block in the Leader's prompt.

**From any channel**, start the first line of a message with a prefix:

| Prefix | Stored as |
|---|---|
| `focus: <text>` | focus, "Focus on …" |
| `stop: <text>` | stop, "Stop …" |
| `priority: <text>` | priority |
| `directive: <text>` | guidance |

A message without a prefix that reads like standing guidance ("from now on…",
"never…", "double down on…") is checked by a separate model call that sees only
your message; a question is never treated as a directive. You see "Standing
directive recorded: …" when one is captured.

**Manage them:**

```sh
ashlr leader directives                      # active directives
ashlr leader directives --all                # including retired
ashlr leader directives add "ship binshield's retry fix first" --kind priority
ashlr leader directives retire <directiveId>
```

In Phantom, the Directives strip at the top of Mind shows each as a chip: ×
retires it, **+ Add directive** adds one, with a live counter against the
300-character limit. ⌘K "Add Leader directive…" opens the same box. On
Telegram, `/directives` lists them.

Limits: 20 active at once (retire one to add another), 300 characters each,
duplicates are ignored. Stored in `~/.ashlr/vision/leader/operator-directives.json`.

---

## Memos, answers and approvals

**Action classes.** Every action in a memo carries a class:

- **A** applies at once and can be vetoed at any time.
- **B** applies after a veto window (the grant's `leader.vetoMinutes`, 30
  minutes to 24 hours). A spend-raising action whose window would close
  between 00:00 and 07:00 waits until 07:00 unless the budget mode is all-in.
- **C** is outside the grant. It is never applied; it goes to Needs you with
  the Leader's argument.

With no grant, the switch at Propose, or the ladder at shadow, a memo is a
**dry run**: it is recorded and nothing applies.

**Approve early.** Approving a class-B action inside its window claims it the
same way the window closing would and runs the same checks (the ledger row and
today's grant). If they pass, it applies now and stays vetoable; if not, it is
refused and stays scheduled. Approving a class-C ask records your approval; it
does not apply it. To allow it, widen the grant yourself (`ashlr authority`).

**Veto** runs the action's recorded inverse. Veto on a memo vetoes all of its
actions.

**Answer.** Questions in memos can be answered. Answers (for 30 days) and
approvals (for 14) feed the next memo run.

When the Leader supplies a structured question, it offers one choice, several
choices, or a short answer. Multiple choice includes **Select all** and
**Clear**; selecting options does not send them until you submit. The same
question and saved answer appear on desktop, phone and Telegram. You can use
the separate conversation composer while leaving a question draft in place.

Structured answers are recorded once. If another device answers first, the
form shows that saved answer rather than overwriting it. A lost connection or
an uncertain submission keeps your draft while the app checks the saved
answer. Buttons expire after 24 hours; you can still reply in plain text.
Questions without structured choices keep their existing answer box.

---

<a id="in-verse-mind-4"></a>

## In Phantom: Mind (⌘4)

Mind opens on the conversation: "One thread · Phantom, Telegram, CLI".

- The Directives strip, then the thread: messages with channel badges, memo
  cards with the class chip, the veto countdown and **Approve** / **Veto** (a
  dry-run memo says so and has no buttons), questions with choices or an answer box.
- The composer at the bottom. Sending asks for the mutation token once; your
  draft is kept. "Leader is thinking…" shows while a reply is pending, and a
  failed send offers Retry and Discard.
- Below the conversation: each move's 7-day outcome, the hit-rate and
  standards, reasoning insights and the action log with Veto.
- ⌘K "Message the Leader…" focuses the composer from anywhere. On Command, the
  foot of the Leader card shows the latest message and a **Message the
  Leader… ⌘4** button. A Leader question in Needs you (⌘J) has **Answer**,
  which jumps to it in Mind.

The conversation works with autonomy off; memos are then dry runs.

---

## On Telegram

**Setup.** Create a bot with @BotFather, then:

```sh
ashlr comms setup-telegram     # prints the steps and finds your chat id
```

Configuration: `comms.enabled: true`, `comms.channel: "telegram"`,
`comms.telegram.botToken` (or `TELEGRAM_BOT_TOKEN` in the environment) and
`comms.telegram.chatId`. Messages from any other chat are dropped. The poller
runs as the launchd job `ai.ashlr.comms-poll` every 3 minutes (see the
[Comms channel](https://github.com/ashlrai/phantom/blob/master/docs/HUB-REFERENCE.md#comms-channel) in the Phantom reference for the config
example).

**Talking.** Send plain text and it joins the thread; the Leader's reply comes
back as a Telegram reply to your message. Reply to a Leader question to answer
it. Directive prefixes work here too.

Structured questions use buttons for choices, selection and submission.
Short answers use a reply prompt. Ordinary messages can be sent while a
question is open; they do not clear its selections. Old buttons and repeated
submissions cannot replace an already saved structured answer. Plain-text
replies remain available for refining an answer.

| Command | What it does |
|---|---|
| `/leader` | The latest memo, with buttons |
| `/leader <text>` | Message the Leader |
| `/status`, `/brief` | The instant brief: shipped, running, blockers, next ([Founder mode](#founder-mode-315)) |
| `/task <owner/repo> <text>` | Hand work to an enabled Telegram automation ([Automations](VERSE.md#automations-315)) |
| `/directives` | Your standing directives: id, kind and text |
| `/settings` | The Leader's settings and the standards it set |
| `/help`, `/start` | Help |

`pause`, `resume`, `snapshot` and `revert:<id>:<repo>` are also understood as
keywords.

**Buttons.** Memos arrive with **[Approve] [Veto] [Details]**. Approve is
shown only when an action is waiting on you: it applies a scheduled class-B
action early (after the same checks as its window closing), or records your
approval of a class-C ask. Veto is shown only while an action is live. An old
button answers "That button has expired."

**Digests are change-driven.** A digest speaks only when something changed:
merges, fleet PRs opened, reverts, seats exhausted or reset, cloud tasks
finished. When nothing changed it stays silent, apart from at most one line
after a day idle. Informational messages never queue behind an unanswered
question. Everything is HTML-escaped and long messages are split safely.
While the Leader line is on (the default with Telegram), this 6-hourly digest
stays silent, because the morning and evening briefs carry what shipped.

---

## Founder mode (3.15)

**The voice.** The memo prompt, the conversation and the Telegram line share
one founder-operator voice: first principles, ownership and urgency, bias to
action, "the best part is no part", bets sized with numbers, blunt and brief,
and every reply ends with the next move. It is the Leader, an AI; any line in
which it claims to be a real person or a human is rewritten before it is
sent. On Telegram a reply is cut to 6 lines, ending `… (say "more" for the
rest)`; "more" sends the rest (up to 30 lines), and asking for detail gets
the longer reply at once.

**The Leader line on Telegram.** On by default whenever Telegram is
configured; `comms.leaderLine: false` turns the scheduled briefs and pings
off (the conversation still works). It runs from `ashlr comms cycle`, the
poller's job.

- **Briefs.** A morning brief and an evening recap at `comms.briefTimes`
  (default `["08:00", "19:00"]`) in `comms.timeZone` (default
  `America/New_York`): what shipped with PR links, what is running, blockers,
  the next moves and one question. A slot missed by more than 3 hours is
  skipped.
- **Instant brief.** "status", "update", "what's up", `/status` or `/brief`
  gets the same brief at once, built from recorded state (the ledger, the
  cloud and Devin stores, the Leader's state and questions). A model writes
  only its one-line narrative, and the brief goes without it after 8 seconds.
- **Pings.** A result ping for work you asked for ("PR is up …"). Event pings
  only for a revert (when Jev, if set up, thinks it is worth the
  interruption), a failed revert (urgent) and the Leader being down (at most
  once a day).
- **Limits.** Quiet hours `comms.quietHours` (default `{ "start": 23, "end": 7
  }`, local hours) hold everything but urgent pings. At most
  `comms.maxPingsPerDay` (default 6) ordinary pings a day, 20 minutes apart,
  and at most 4 urgent ones.
- **Questions.** One at a time; the next waits until you answer, or for 24
  hours. Structured questions show their supplied choices or a short-answer
  prompt. Legacy yes/no questions retain **Yes**, **No** and **Your call**.

**What you say, and what it does.** Each message is read as one of status,
detail ("more"), approve, veto, answer, directive, task or chat. Rules decide,
and Jev may classify first when it is set up; approve and veto always need an
action id (`la-…`) or a reply to a message that carries actions, and are
never taken from a model's guess. "Go build X" or "fix Y in owner/repo"
becomes work at once, in `comms.leaderRepo` (fresh default `ashlrai/phantom`; saved overrides remain unchanged)
when you name no repo: small work goes to the fleet; larger work to a cloud
session, then Devin, when the budget allows and the mode is not reserve; and
back to the fleet if a paid lane refuses, which the reply says. Your request
counts as your approval, through the same path as an Approve tap.

**Actions it may take**, each classed by the same policy as every other
action, with the same dry-run rule, veto windows and ledger:

| Action | Class |
|---|---|
| `directive.self`: a standing note to itself, fed back to it as untrusted data, never mixed with your directives | A |
| `backlog.add`: queue work in the cloud backlog (spends nothing) | A (C outside the grant) |
| `cloud.launch`: a Claude cloud session | B, spend-raising (C outside the grant or in reserve mode) |
| `devin.launch`: a Devin session through the fleet entry point (needs `devin.fleet` and a grant that names Devin) | B, spend-raising (C outside the grant or in reserve mode) |
| `playbook.upsert`: a new playbook version; a veto writes the prior text back as a new version | B |
| `automation.upsert`: create or update an automation; a veto restores or deletes it | B |

Every paid lane still applies its own budget gate at launch.

**Self-improvement.** Once a day, from 09:00 local time, the Leader ranks
Phantom improvements from recurring retro causes, its own failures,
Needs-you friction, usage and the open gates in
`docs/VERSE-COMPETITIVE-ACCEPTANCE.md`, and routes each pick to the cheapest
capable lane: no fixed daily launch ceiling, a 7-day cooldown per idea, no
paid lanes in reserve, nothing enacted in a dry run. The line posts the report
with Approve and Veto. `foundry.leader.selfImprove: false` turns it off.

**Jev's advice on memos.** After a memo's actions are classed and applied, Jev
(when set up) is asked about up to 8 class-A and class-B actions. When it
thinks one deserves a stricter class, the memo says so ("— Jev suggests class
B (advisory; the class above stands)") and records it in `actionAdvice`. The
advice never lowers or changes a class, never approves anything, and no gate
reads it.

---

## From the CLI

```sh
ashlr leader say "focus: the flaky retry test in binshield"
ashlr leader thread [--limit 20] [--json]
ashlr leader answer <questionId> "yes, but only on ashlrcode"
ashlr leader approve <actionId>
ashlr leader veto <actionId> [--note "why"]      # or: veto --memo <memoId>
ashlr leader directives [add|retire|list]
ashlr leader show [--json]      # latest memo, hit-rate, health, pending veto windows
ashlr leader run [--force]      # run now and wait for the memo
ashlr leader tick [--wait]      # apply due class-B actions, grade moves, run if due
```

Exit codes: 0 ok, 1 error or refused, 2 bad usage.

---

## Reliability

**Seats.** A memo run tries, in order: the router's pick (Grok; Claude only
for the weekly deep run), other Grok seats, then local models (fast ones such as
gpt-oss 20B before large dense ones such as a 27B), and Claude last only when
you opt in with `foundry.leader.claudeFallback: true`. That opt-in never
applies to conversation replies or check-ins. Never Codex. With no
standing grant it runs on local models only. Local calls stream, so a slow
local model is not cut off by a fetch timeout.

**Retries.** A failed full run retries at 15 minutes, 45 minutes and 2 hours.
Three full runs a day by default. Advanced Leader preferences accept a positive
safe integer or **No preference limit** for full runs, all runs and Grok lanes.
Absent settings retain the existing defaults. The separate interval, quiet hours,
single-flight and retry schedule still apply. See the
[goal and Leader preference table](AGENT-HARNESS-EVOLUTION.md#operator-goal-and-leader-preferences).

**Check-ins.** Every `foundry.leader.checkinHours` (default 2; 0 turns them
off) during `foundry.leader.workingHours` (default 08–22), the Leader looks
again, but runs only when the evidence changed materially. A new directive,
answer or approval counts. Check-ins are advisory, never retried, and capped
with full runs at 8 model runs a day. In reserve budget mode they use local
models only.

**One run at a time.** A cross-process lock and a stale-decision re-check stop
the daemon and the comms poller from running the same slot twice.

**Health.** `ashlr leader show` and `GET /api/verse/leader` report
`healthy` (the first seat wrote the memo), `degraded` (a fallback did, a retry
is pending, or the last memo is over 36 hours old), `down` (no seat, or the
retries are spent) or `unknown` (never run), with the seats tried and when the
next run is due. Phantom does not show the health state yet.
