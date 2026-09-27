# Talking to the Leader (3.14+)

The Leader is the fleet's planning agent. It reads deterministic digests of what
the fleet did (history, the ledger, seat headroom, model outcomes, reasoning
insights, lessons, its own hit-rate) and writes **memos**: the bottleneck, one
move with an expected result and a date, goals, standards and questions for
you. Since 3.14 it is also something you talk to.

There is **one Leader and one conversation**. Verse's Mind surface (⌘4),
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
- **Channels:** Verse, Telegram, CLI and System, shown as a badge on every
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

In Verse, the Directives strip at the top of Mind shows each as a chip: ×
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

---

## In Verse: Mind (⌘4)

Mind opens on the conversation: "One thread · Verse, Telegram, CLI".

- The Directives strip, then the thread: messages with channel badges, memo
  cards with the class chip, the veto countdown and **Approve** / **Veto** (a
  dry-run memo says so and has no buttons), questions with an answer box.
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
[Comms channel](../README.md#comms-channel) in the README for the config
example).

**Talking.** Send plain text and it joins the thread; the Leader's reply comes
back as a Telegram reply to your message. Reply to a Leader question to answer
it. Directive prefixes work here too.

| Command | What it does |
|---|---|
| `/leader` | The latest memo, with buttons |
| `/leader <text>` | Message the Leader |
| `/status` | Fleet status, read locally with no model call |
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
At most 3 full runs a day.

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
next run is due. Verse does not show the health state yet.
