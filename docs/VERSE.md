# Ashlr Verse

Verse is the operator console for the whole Ashlr hub. One window: chat with an
agent that can edit your repos, run the autonomous fleet and keep it on a leash,
approve or reject what it produced while you were away, and see what every
account and local model is costing you.

It is served by the normal `ashlr serve` server at `/verse/`, opened by
`ashlr verse`, and wrapped by the macOS desktop app in `desktop/`.

- Build contracts: `docs/VERSE-CONTRACT-V1.md` (sessions) and
  `docs/VERSE-CONTRACT-V2.md` (redesign + control plane).
- Context windows, compaction, modes, handoff and shared memory:
  [`docs/VERSE-CONTEXT.md`](VERSE-CONTEXT.md) — the authority for every number
  the context meter shows.
- Design language: `docs/VERSE-DESIGN-V2.md`.
- Shared types: `src/core/verse/types.ts` (V1, frozen),
  `src/core/verse/control-types.ts` (V2) and
  `src/core/verse/workbench-types.ts` (3.10 workbench; owned by one unit, frozen
  for the others).
- 3.10 routes, gates and wire shapes: `docs/VERSE-CONTRACT-V1.md`, section
  "V3.10 additive contract".
- Standing authority, Touch ID grants, the rollout ladder and the ledger:
  [`docs/STANDING-AUTHORITY.md`](STANDING-AUTHORITY.md), the authority for
  everything autonomy may do without you.
- The cloud lane (Claude Code cloud sessions, their budget and delivery
  contract): [`docs/CLOUD.md`](CLOUD.md).
- Talking to the Leader from Verse, Telegram and the CLI:
  [`docs/LEADER.md`](LEADER.md).
- Devin as chat seats, a lane and a fleet producer (setup, budget, delivery,
  the two-judge rule, limits): [`docs/DEVIN.md`](DEVIN.md).
- The integrated browser and what agents may do with it:
  [`docs/VERSE-BROWSER.md`](VERSE-BROWSER.md).
- The Jev decision layer, its call sites and its bounds:
  [`docs/JEV-INTEGRATION.md`](JEV-INTEGRATION.md).

This page is the user guide. It describes 3.15.

**At a glance.**

| Where | What it is for |
|---|---|
| ⌘1 **Command** | What needs you, the autonomy switch and rollout ladder, the Leader's memo, seat burn-downs, the Cloud card |
| ⌘2 **Fleet** | What runs where, the gate funnel, every shadow decision with its G0–G7 chips |
| ⌘3 **Growth** | Whether output compounds, and **Lessons**: retros and the knowledge you approved |
| ⌘4 **Mind** | The **Leader conversation**: one thread with Verse, Telegram and the CLI, directives, memos to approve or veto |
| ⌘5 **Chat** | The workbench: Claude Code, Codex, Grok, local and Devin seats, with a panel for Terminal, Browser, Changes, Files, Sources and Reasoning, and Run in cloud and Run in Devin |
| ⌘J **Needs you** | Everything waiting on you, including cloud and Devin PRs to land or close |
| ⌘. **Resources** | Every account, local runtime, cloud credits and Devin, each with a Chat and a Fleet readiness line |
| Gear ▸ **Repo wiki** | A private architecture wiki per repo, and Ask the codebase |
| Gear ▸ **Playbooks** | Versioned task templates, run with a `!macro` in any chat or lane |
| Gear ▸ **Automations** | Issues, red builds, schedules and webhooks that become work in a lane |
| ⌘K | Every chat, action, seat, project and repo from one field |

---

## Start it

```sh
ashlr verse                      # start the server with dispatch enabled, open http://127.0.0.1:7777/verse/
ashlr verse --port 7777          # pick the port (the desktop app always uses 7777)
ashlr verse --no-open            # do not open a browser tab
ashlr verse --no-open --json     # print one machine-readable JSON line instead of the banner
```

`ashlr verse` is `ashlr serve --allow-dispatch` plus the Verse entry point. It
prints the same two tokens `ashlr serve` prints:

| Token | Used for | Where it goes |
|-------|----------|---------------|
| Read token | reading seats, projects, sessions, usage, and the SSE event stream | pasted once into the SessionGate; exchanged for a short-lived HttpOnly cookie |
| Mutation token | creating sessions, sending turns, changing caps or scope, approving proposals | asked for by the mutation dialog the first time you dispatch |

With `--json` the line is `{"url","consoleUrl","port","allowDispatch","readToken","token",...}`.
The desktop app reads that line from the sidecar's stdout and hands the tokens
straight to the window, so there is no paste step there. Neither token is ever
written to disk, logged, or sent anywhere other than `127.0.0.1`.

The server binds to `127.0.0.1` only. Do not expose it to other hosts.

---

## The five surfaces

3.10 reorganised Verse around one question per surface. The icon rail down the
left switches between them, and ⌘1–⌘5 do the same.

| Key | Surface | What it answers |
|-----|---------|-----------------|
| ⌘1 | **Command** | What needs me, and is the company producing? The autonomy switch, Stop, the budget pill and the grant chip; while a grant is active, the **rollout ladder** ("Shadow · 1 of 8", progress bars toward the next stage, what happened last) and the grant countdown with Re-approve under 7 days; a one-line verdict ("Autonomous · 5 building · 7 merged today · 0 reverts · Claude 46% reserved for you"); Needs you; the Leader's memo; five KPIs; a burn-down per seat; the Cloud card; a 12-hour swimlane. |
| ⌘2 | **Fleet** | What is running where, and why that seat? A live swimlane by lane and phase, **Shadow decisions** (every proposal with G0–G7 chips, the outcome and why), the gate funnel with refusal reasons, "why this seat" for each dispatch, parked work, the repo table with pause and resume, and Overnight. The 3.9 Autonomy panels live under **Fleet ▸ Advanced**. |
| ⌘3 | **Growth** | Is the output compounding? Merges per week, cost per merge, model outcomes, a calendar of merges, the harness history, the experiment results, and **Lessons** (3.15). |
| ⌘4 | **Mind** | Talk to the Leader. The **conversation** (3.14): one thread across Verse, Telegram and the CLI, with directives, memo cards to approve or veto, and its questions to answer. Below it, the Leader's hit-rate and the reasoning insights. |
| ⌘5 | **Chat** | The interactive workbench: sessions, transcript, composer and a panel of tabs and splits (Terminal, Browser, Changes, Files, Sources, Reasoning, Tasks, Context), with **Run in cloud** and **Run in Devin** in its ⋯ sheet. |

The **gear** at the foot of the rail holds Settings (⌘,), **Apps & Accounts**,
Usage, **Repo wiki**, **Playbooks** and **Automations** (3.15) and Shortcuts
(⌘/). Beside it, a small ring shows
the scarcest seat's five-hour window.

**Shadow decisions (Fleet).** One row per proposal the standing pass
considered: chips for G0 Authority, G1 Protected paths, G1b Tamper, G2 Scope,
G3 Verify, G4 Claims, G5 Blast radius, G6 Judge and G7 GitHub checks, the
outcome with a one-sentence reason, and Evidence and PR links. Ladder
regressions are shown above the list. While the ladder is at shadow, this is
where you read what the fleet *would* have merged.

**Where the 3.9 sections went.** Chat is ⌘5. Autonomy is Fleet (its panels
under Fleet ▸ Advanced). Approvals is the **Needs you** drawer (⌘J). Usage and
Settings are in the gear tray, and MCP is inside Apps & Accounts. A saved 3.9
section is migrated once, and a v2 user sees a single "Chat moved to ⌘5" notice.
The first launch of each day opens Command, so the overnight digest is the
first thing you see. Later launches reopen the surface you left.

**Rail badges.** Command shows the Needs-you count. Chat shows a pulsing amber
dot while any chat runs (the count is in its accessible name). Fleet shows the
autonomy state, and Mind a dot when there is a memo you have not opened.

**Surfaces stay alive.** The last three surfaces stay mounted while hidden, and
Chat stays mounted once visited, so switching back is instant and a half-typed
message survives. A hidden surface stops polling and catches up when it is back
in view; nothing polls faster than every 2 s.

Every chart has a table twin (its ⋯ menu, or `T` when the card has focus), a
designed empty state ("Fleet dark since Sep 1") and a hatched fill for values
that were not measured. An unmeasured value is shown as "—", never as zero.

**Seat burn-down history.** Command's per-seat burn-downs keep the whole
window across reloads. Each seat's 5-hour and weekly readings are logged to
`~/.ashlr/routing/capacity-history.jsonl` (0600) by the Verse server and by the
daemon, and served from `GET /api/verse/budget/history`. The log holds at least
8 days and stays under about 2 MiB; once it is full, older readings are thinned
per seat before any are dropped. To stop recording, set
`ASHLR_CAPACITY_HISTORY=0` in the environment of the Verse server and the
daemon. Both then stop writing, and the burn-downs keep only what the page
reads while it is open plus whatever the log already holds.

### Needs you (⌘J)

One drawer for everything waiting on you: owner-lane PRs the fleet may not
merge, the Leader's class-C asks and questions, repos on owner hold, seats that
need reconnecting, a grant about to expire, and the proposals that used to be
Approvals. Cloud and Devin PRs arrive here too, each with a Clean or Held
verdict and Land, Close and Update branch
([Triage in Needs you](CLOUD.md#triage-in-needs-you)); a Leader question
has **Answer**, which jumps to it in Mind. Splits: All, Approvals, Fleet,
Chats, Accounts (`H`/`L` switch). `J`/`K` move, ↩ opens, `X` selects, `A`
approves, `R` rejects, `V` vetoes, `E` marks done.
Approve, reject and veto confirm first, then ask for the mutation token. An
empty drawer says "All clear" with the fleet's status line.

### Command palette (⌘K)

Opens in under 50 ms and never switches surface on its own. Results are
grouped Needs you › Chats (running first) › Actions › Go to › Seats & Apps ›
Projects. Start with `>` for actions only or `#` for chats only; ⇥ fills an
argument ("New chat on…" → a seat). An empty query lists your last five
actions. Guarded actions ("Stop running chats…", "Stop the fleet…") confirm,
then ask for the token. Every palette entry, menu item, shortcut and key
handler reads one catalog, `routes/verse/shell/command-catalog.ts`; its keys
are written once in `command-keys.ts`, the half the first paint loads.

Actions worth knowing by name:

| Area | Palette entries |
|---|---|
| Leader | Message the Leader…, Add Leader directive… (both open Mind) |
| Wiki | Open repo wiki… (⇥ picks a repo), Ask the codebase… |
| Playbooks | Open Playbooks, Run playbook… |
| Automations | Open Automations, New automation… |
| Lanes | Run in cloud…, Run in Devin… (both open the composer's sheet; neither launches on its own) |
| Autonomy | Autonomy: Off / Propose / Autonomous, Approve grant…, Re-approve grant…, Autonomy status, Stop the fleet…, Copy autonomy setup command |
| Budget | Budget mode: All-in / Balanced / Reserve |
| Chat | New chat, New chat on…, Stop running chats…, Create pull request…, Merge pull request… |
| Panels | Open Resources, Show or hide the resource bar, Open Needs you, Keyboard shortcuts, each workbench pane, Focus mode, Move the panel (beside or below the chat) |

### Chat

Sessions are listed in the sidebar grouped by project, newest first, each with a
2px engine marker, its title and a relative time. A running session shows a
small pulsing dot. The sidebar's search box does two things with one query: it
filters chat titles and project paths instantly, and, a moment later, lists the
chats whose **messages** match — your messages and the assistant's, every word
required, recent chats ranked higher — each with a snippet around the match.
That second half is a bounded scan of Verse's own session files on this
machine; nothing is sent to a model and nothing spends.

The transcript is a single 720px reading column. Your turn is a quiet rounded
block aligned right, on the hover ground in primary text; the assistant's is
plain prose at full measure with no box. Markdown gets real typographic
hierarchy, and code blocks have a language label and a copy button on hover.
A finished turn ends in a muted footer — how long it took and, if any call
failed, "2 failures in this turn — jump to the first" — rather than a duration
line of its own between turns.

Tool calls collapse to one line each — glyph, tool name in mono, truncated
argument, an edit's `+12 −3`, right-aligned duration — and a run of them
collapses further into one activity row (below). Expand any of them for the
full input and output. Failures tint the left rule and say so in words. Paths
in tool and file rows read relative to the chat's folders (`src/math.ts`, else
`~/…`); hover one for the full path.

The composer grows to 40% of the viewport, gains the accent on focus, and docks
at the bottom of the same 720px measure. Its placeholder reads "Ask anything —
@ to add files, / for commands". Context shows as a small ring with its
percentage, in the header and again in the composer footer — one reading drawn
twice, so the two cannot disagree. Hover either for the tokens
(`142,000 of 1,000,000 tokens`) and where the CLI compacts.

**How a turn actually runs.** Each turn spawns one vendor CLI process
(`claude -p`, `codex exec`, `grok -p`) in the project directory with
`--permission-mode acceptEdits` (or Codex's `workspace-write` sandbox), streams
its output as normalized events, and exits. Nothing holds stdin open between
turns; the vendor conversation is resumed by id on the next turn, so the
conversation's memory is the vendor's own. **Stop** cancels the running turn
(SIGINT to the process group, SIGKILL after 10 s). Turns also time out on their
own.

Sessions persist in `~/.ashlr/verse/sessions/` (`<id>.json` plus an append-only
`<id>.events.jsonl`) and reappear after a restart.

**Context meter.** How full the conversation is: the prompt size of the most
recent model call (input + cache-read + cache-creation tokens) drawn against
the model's **whole** window, with a tick where the CLI will auto-compact —
`142k / 1M · compacts ≈367k`. The window is the one the CLI actually reported
for the last turn when it reports one, else the seat's catalog for that model
and mode; hover the meter to see which, plus the mode and what compaction does.
It turns amber at 80 % of the compaction point and red at 95 % — *before* the
CLI compacts, not after — and shows a reading past the window as over-window
rather than pinning at 100 %. `n/a` means the window is unknown, not zero.

- **Codex** readings are exact once Verse has read the seat's own session file
  (it re-reads it every 2 s during a turn). Until then the figure is an upper
  bound and is prefixed `≤`.
- When the CLI compacts, the transcript shows a divider —
  `Auto-compacted 967k → 19k in 1m 58s` (Codex too, from the readings either side
  of its compaction), or `Codex compacted its context` when there are no counts —
  so the meter's drop is never unexplained.
- **Compact now** asks the CLI to compact on demand by sending `/compact` as an
  ordinary turn; the divider reads `Compacted on request …`. Every Claude and local
  session has it in the chip next to the meter — the Standard / Expansive chip, or
  a chip reading **Context** on local chats and the 200k Claude models, which have
  no mode to switch — once the chat has had a turn; the handoff banner offers it too.
  It is free on a local seat, though slow on a large model (about 2½ minutes for a
  15k context on a 27B tag). **On a paid seat it spends usage** — the CLI reads the
  whole context to write its summary. It is not offered on Codex or Grok.

**Context mode.** Next to the meter, on models that have one, a chip switches
the session between **Standard** and **Expansive**, from the next turn:

| Engine | Standard (default for new chats) | Expansive |
|---|---|---|
| Claude 1M models (Fable, Opus 5.x / 4.8, Sonnet 5) | compacts at ≈367k | compacts at ≈967k |
| Codex GPT-6 / GPT-5.6 | 258.4k window, compacts at ≈245k | 828.4k window, compacts at ≈785k |
| Grok, local, Claude 200k models, GPT-5.5 | their native window | not offered |

Expansive costs more usage on **every** later turn, because each turn re-sends
the whole conversation; it pays off for coupled, cross-cutting work that needs a
lot in view at once. The menu quotes the ratio of the two compaction points
(≈2.6× on Claude, ≈3.2× on Codex). On Codex that is not the whole story: OpenAI
reportedly counts GPT-5.6 requests above 272k at about 2× against plan limits (a
single secondary source; GPT-6 Astra reportedly exempt), so a turn near the
expansive limit may count about 6× a standard one — every Expansive prompt on
Codex says so.

**Chats from before 3.9 keep their full window.** Earlier versions let the
Claude CLI compact near 967k. A Claude chat created before 3.9 on a 1M model is
therefore recorded as **Expansive** the first time 3.9 loads it, and runs exactly
as it did — upgrading compacts nothing. New Claude chats start in Standard.

**Switching to Standard can compact.** Standard → Expansive is always free.
Expansive → Standard is free while the session is below the Standard compaction
point; above it (a Claude chat at 600k, a Codex chat at 500k) the CLI compacts on
the **next turn** — a summary of the whole context that spends usage on a paid
seat, replaces early turns and starts a new prompt cache. The menu warns before
you switch. Verse may suggest it — after repeated compactions, or when
the reachable code only fits expansive — but never switches it on for you. The
new-chat dialog sets the mode for a new session and can make it the seat's
default. Why the default is not the full window: `docs/VERSE-CONTEXT.md` §2.

**Continue in a fresh chat.** When a session is near its compaction point, has
compacted twice, or has sat idle for over an hour with a large context, a banner
under the meter says so and offers **Continue in a fresh chat…**. That builds a
handoff note from the session's own log — goal, latest asks, current state,
files touched, commands, errors, each root's `git diff --stat` — with no model
call. You can edit it, choose any seat, model and mode for the new session (a
Claude chat can continue on Codex), and see whether the note fits. The optional
**Ask *seat* to summarize first** button sends one ordinary — paid — turn to the
current session and folds its reply in (the request itself is not carried into
the new chat as your latest ask). Creating the new session is free: it opens with
"Continued from …", the note is waiting in the composer, and nothing is sent
until you press send.

**Project memory.** Every seat working on a project shares one small memory
directory outside the repository (`~/.ashlr/verse/memory/<project>-<hash>/`).
Each session tells its agent where it is and asks it to keep `MEMORY.md` a
short index of durable facts with their reasons — decisions, conventions,
gotchas, plan status — and never secrets. Claude, Codex and local seats read
and update the live file; Grok's CLI cannot be given the directory, so a Grok
session sees the copy taken when the chat began and cannot change it. It is on
by default; the Resources panel shows it and lets you edit, clear, or turn it
off per project or everywhere. A session keeps the memory setting it was created with.
It is not free on a paid seat: its block (up to 6 KB) rides in the system prompt of
every turn — cached after the first, but cached tokens still count — and the agent
spends a little extra work reading and updating `MEMORY.md`. The editor shows a
sanitized copy (secret-looking text as `[REDACTED]`, your home as `~`) and says so;
a save that would write those placeholders over the real values is refused.

The Resources panel also shows the current session's efficiency: cache-hit
ratio, average and peak context per turn, compactions, and a warning once the
session has been idle past the one-hour prompt-cache lifetime — the next turn
re-reads the whole context at full cost.

**Dictation.** The microphone uses the browser's Web Speech API when the runtime
provides it. WKWebView — which is what the desktop app is — does not, so there
the button explains itself and you use system dictation (Wispr Flow,
Superwhisper, macOS dictation) into the composer, which is an ordinary textarea.

### The 3.10 chat workbench

**Sidebar.** Filter chips (All, Running, Needs you, Pinned) sit under the
search box. Chats group as Pinned, then projects, then Archived (collapsed).
Each row carries one status: a pulse with elapsed time, failed, an unread dot,
or the time. A running row adds a muted second line from the live activity feed
("npm test, 1m 02s", or the tail of the live reasoning). Hover or right-click to
pin, archive, rename, hand off or delete. Unread is counted by turns: a chat that
existed before 3.10 does not show unread on its first launch.

**Transcript.** Consecutive tool calls fold into one activity row ("▸ Ran 12
commands · read 8 files · edited 3 files · 1 failed · 2m 14s"); a failure or a
running call opens the group on just those rows. A **chapter rail** on the
right edge has one tick per turn (red failed, amber running) plus markers for
compaction, handoff and recovery; hover shows the prompt and a click jumps to
it. Screen readers hear a polite announcement only when a turn starts, finishes
or fails. A command block's **Run in terminal** pastes the command into the
Terminal pane and never runs it.

**Live reasoning.** Claude, Codex and Grok stream their reasoning while they
think. The thinking block shows three live lines, then collapses to
"Thought 12s, ~1.8k tok ▸". Settings ▸ Chat chooses Collapsed (default),
Expanded or Hidden. Above the composer, the live status line reads
"● Running npm test, 1m 02s, 38 tok/s, Stop" — every figure is measured from the
CLI's own events, and nothing is estimated. Reasoning is also kept as data for
insights (below), scrubbed and local.

**Above the composer**, each row hidden when empty: one notice at a time (seat
health first, then retry and recovery, then context advice) with "+N more";
queued turns; the live status line; and the **branch bar**.

**Composer.** It is always editable. ↩ during a running turn queues the message
on the server (up to 3); the queue sends when the turn ends cleanly, and holds
and asks after a failure or Stop. ⌘⇧↩ stops the turn and sends. Attach files by
upload, paste or drop (⌘U); they are stored in
`~/.ashlr/verse/attachments/<session>/` (0600) and that one folder is shared
with the turn. `@` fuzzy-finds project files and `/` offers handoff, compact,
new, plan, effort and model.

The footer is one row. On the left: attach, dictation and the **permission
mode** — Plan, Accept edits (the default), Auto, or Bypass, which is red and
confirmed per chat. The labels are short and never cut off; the full name
("Bypass permissions") is in the tooltip. On the right: the **seat chip**, the
**model** picker, **effort**, the context ring and **Send ⏎**. The seat chip
names only the account ("Claude Max", or "Local"), so the model appears once, in
its picker. Its tooltip shows plan, windows, resets, health and what autonomy
may use of that seat, and its menu offers "Continue on ‹seat›" and the budget
mode. Effort ("Effort: High") appears only when the seat can set it. While a
turn runs, Send becomes **Queue** and a square **■** Stop sits beside it. A
narrow window folds the row instead of truncating it: "Effort:" becomes an
icon, then the seat chip shows only its monogram, the permission mode only its
icon, and last the pickers move into a **⋯** sheet. An option a seat cannot run
is disabled with the reason.

**Panel.** Terminal, Browser, Changes, Files, Sources, Reasoning, Tasks and
Context live in the chat's panel; see
[The workbench panel](#the-workbench-panel-315).

**Branch bar and pull requests.** One bar per root with changes
(`ashlr-hub  v310-foundation  +35,079 −1,074  [Create PR ▾]`). Its button
follows the repository's state: Commit, Push, Create PR, Merge (only when
checks are green and the branch is mergeable) or View PR. A commit is refused
while a turn is running in that repository, so you never commit half an edit.
**Isolate in worktree** in the new-chat dialog creates
`~/.ashlr-worktrees/<repo>/<name>` on the branch `verse/<name>`.

### The workbench panel (3.15)

The conversation stays in the middle. The **panel** sits beside it or under it
(⌘K "Move the panel (beside or below the chat)") and holds tabs and splits of
**panes**. ⌘\ shows or hides it. Each chat remembers its own panel layout (the
40 most recently opened chats); sizes and placement are shared by the window.
Below 1024 px the panel is a sheet, and below 480 px a bottom sheet. A sheet
restored open when the page loads closes with Esc even while the composer has
focus.

| Pane | Key | What it holds |
|---|---|---|
| Terminal | ⌃` (⌃⇧` new tab) | Your shells in the chat's folders, with command blocks, and a read-only Agent tab |
| Browser | ⇧⌘B | A browser you and the chat's agents share |
| Changes | ⇧⌘D | Every turn's checkpoint, a diff review, Accept / Reject, Undo and Redo |
| Files | ⇧⌘O | The chat's folders, and the files it read or changed (a simple list for now) |
| Sources | ⇧⌘S | Everything the chat's answers drew on, de-duplicated across the chat |
| Reasoning | ⇧⌘Y | Every turn's reasoning in one scroll, with what the turn did |
| Tasks, Context | — | Running tools and subagents; this chat's memory, roots and handoff |

**Focus mode** (⇧⌘F, or ⌘K "Focus mode") hides the rail, the chat list and
the panel and leaves the conversation. ⇧⌘F again, Esc outside a text field,
or the **Exit focus** pill leaves it, and so does a pane key, which then shows
that pane. Focus mode is not remembered across reloads, and leaving Chat ends
it. A link of the form `/verse/?chat=<id>&pane=<pane>` opens a chat with a pane
showing (use `pane=diff` for Changes); "Copy link to this chat" is in the chat
menu. Other code can add a pane through the pane registry
(`src/web-ui/routes/verse/panes/README.md`).

**Terminal.** A real login shell per tab in the chat's folder, drawn with
xterm on WebGL: ⌘F finds, ⌘-click opens a URL or a `file:line`, copy on
select, and **Send selection** (secret-scrubbed) drafts into the message box.
A tab holds at most two panes (⌘D splits right, ⌥⌘D down). Tabs, splits and
scrollback survive a page reload. Up to 8 tabs; a tab idle for 12 hours is
closed.

- **Command blocks.** In zsh, bash and fish, each command becomes a block with
  its command line, folder, duration, exit code and output (the tail, up to
  256 KB per block and 4 MB per tab). Verse wires this up without editing your
  dotfiles; other shells start as before, without blocks. A dot on each
  prompt line opens the block's actions, ⌘↑ / ⌘↓ jump between commands, and
  ⇧⌘K opens the **Blocks** view: Copy output, Send to chat, Explain and fix
  (on a failed block), Paste command and Show in terminal.
- **Agent tab.** Every shell command the chat's agents ran (Claude's Bash,
  Codex's commands, local seats' commands), as blocks. It is read-only and
  never re-runs anything; **Paste command** types a command at your prompt
  and stops there.
- **KILL.** With `~/.ashlr/KILL` engaged, agent terminal tabs are refused and
  open ones are hung up. Your own shells stay open.
- The Terminal needs the desktop app, whose Bun runtime provides the
  pseudo-terminal. Under plain Node the pane says so.

**Browser.** An address bar, back, forward and reload, up to 8 tabs, device
sizes (fill, 1280, 820, 390), zoom, "Open in your browser", and the chat's dev
servers one click away. In the desktop app each tab is a native webview, so
any site loads, and the pane can take screenshots (macOS), show console
output, errors and failed requests, and pick an element. In a browser tab or
an older desktop shell it falls back to an `<iframe>` for loopback pages.
**Send to chat** drafts the page, its logs, a picked element and a screenshot
into the message box; it never sends. A per-chat switch, off by default, lets
the chat's **Claude and local seats** look through the pane with five
read-mostly tools (status, navigate, screenshot, read text, console), on
localhost unless you allow another origin for that chat. Agents cannot click,
type or submit. Details: [VERSE-BROWSER.md](VERSE-BROWSER.md).

**Changes and checkpoints.** Before every agent turn, on every seat, Verse
snapshots each repository the chat can reach into a hidden commit
(`refs/ashlr/checkpoints/<chat>/<turn>/<root>/pre`), and again after it
(`…/post`). Your index, stash, HEAD and branches are never touched. Files over
8 MB, or past 128 MB in total, are skipped and listed; more than 20,000
changed paths means no checkpoint for that turn, and the pane says so. The
**Changes** pane has a **Turns | Git** switch:

- **Turns** shows **This turn** (what the turn did) or **Since turn** / **All
  turns** (checkpoint to what is on disk now), as a file tree with unified or
  side-by-side diffs and word-level emphasis. A file changed after the agent
  is marked **edited**; one too large to capture, **not captured**.
- **Accept** or **Reject** per file (a file reject needs a second click) or
  per hunk. Reject restores from the checkpoint; a hunk that moved is refused
  rather than misapplied.
- **Undo turn…**, **Rewind to before turn N…** and **Redo** always preview
  first: what is restored, removed and left alone. A file you edited after
  the agent gets a three-way choice: Merge both (only when the merge is
  clean), Keep current or Use checkpoint. Apply is refused if anything changed
  since the preview.
- **Commit…** and **Open PR…** use the usual dialogs. **Git** is the
  uncommitted and branch review, where the gutter's `+` adds a note and **Add
  to message** drafts `path:line: note` into the composer.

Reject, Undo and Redo are refused while this chat, or any chat whose folders
overlap it, has a turn running. Every checkpoint and decision is recorded in
`~/.ashlr/verse/checkpoints/<chat>.jsonl` (0600). `ASHLR_VERSE_CHECKPOINTS=0`
in the server's environment turns checkpoints off.

**Reasoning and Sources.** Every answer ends with numbered **Sources**: files
read, with the line range the call proved (`parser.ts:12-51`), pages fetched,
web searches, docs and wiki pages, and shared memory. A cited file opens in
your editor at its line, confined to the chat's folders; when it cannot, the
row jumps to the call that read it. A settled turn's footer says what it did
in one line ("Read 8 files · edited 3 files (+42 −7) · ran 4 commands (1
failed) · 2 web lookups"), and a seat that keeps its reasoning to itself says
so. Local reasoning models that write `<think>…</think>` stream that as
reasoning. The **Sources** pane lists every source the chat used, with the
turns that cited it, filters and **Cite** into the message; **Reasoning**
shows each turn's thinking in order. Past 40 turns the transcript keeps
far-away turns as placeholders (the newest 10 and the running turn always
render).

### Every seat together (3.15)

A line above the composer makes the seats work as one. **Auto** names the seat
for this message and the one reason ("Qwen 27B (local) — quick explanation —
free and private on this Mac."), using the seat router in interactive mode,
where the fleet's reserves never bind you. **Send to** overrides it for one
message; a message bound for another seat continues the conversation there
with the zero-spend handoff note, and a change of seat is shown before it is
sent. **Cheap-first** lets a local model draft and escalates a weak draft
(failed, hedging, looping, cut off, no code for a code request) to a frontier
seat with the draft quoted. **Compare** sends one prompt to 2–3 seats side by
side and continues with the answer you pick; **Review with ‹seat›** asks a
seat from another model family to review the last answer. The seat chip's
**Continue on ‹seat›** hands off in one click; nothing is spent until Send.
A local model's badge shows its context window, measured tokens/s, "On this
Mac · private" for loopback runtimes, and **Warm up**. The meter shows tokens
and API list-price equivalents across every seat the thread touched, and what
cheap-first saved. Auto never picks a Devin or cloud seat, the line is hidden
on Devin chats, and a local-only repository is routed over local seats only.
On send, the message is labelled once by the
[Jev decision layer](#the-jev-decision-layer-315) when it is installed, else
by rules. Every turn still goes through the ordinary session routes and gates.

---

## Seats

A seat is one place a turn can run: an **engine** plus the **account** (or local
model) it is pinned to. The engines are Claude Code, Codex, Grok and local; you
get one seat per signed-in account, so two Codex accounts are two Codex seats
side by side. Devin adds two chat seats, **Devin (cloud)** and **Devin (CLI)**
(see [Devin](#devin-315)). Claude cloud sessions are a lane you hand a task to
(Run in cloud), not a chat seat. Sessions are seat-bound — changing the seat on an
existing chat starts a new session. To carry the work across, use **Continue in
a fresh chat** (above) rather than starting cold.

### Your subscriptions

Seats come from `~/.ashlr/account-connections/connections.json` (the same file
`ashlr` uses for native-profile launchers). Each account becomes one seat with
`engine = provider`. Windows below are what each CLI measures against, and the
point where it auto-compacts in standard mode; the full table, with where every
number comes from, is `docs/VERSE-CONTEXT.md` §1.

| Engine | Models offered | Window · compacts at | Identity colour |
|--------|----------------|----------------------|-----------------|
| `claude` | Fable 5.1, Opus 5.5, Fable 5, Opus 5, Opus 4.8, Sonnet 5 | 1M · ≈367k (≈967k expansive) | `#c96442` |
| `claude` | Opus 4.5, Haiku 4.5 | 200k · ≈167k | `#c96442` |
| `codex` | the seat's own catalog — GPT-6 Astra / Sol / Luna, GPT-5.6 Sol / Terra / Luna, GPT-5.5 | 258.4k · ≈245k (828.4k · ≈785k expansive, not GPT-5.5) | `#10a37f` |
| `grok` | the seat's own catalog — Grok 4.7, Grok 4.7 Fast, Grok 4.6, Grok 4.5 | 500k · 400k | `#6b7280` |
| `local` | Ollama tags that support tool use | what the runner serves · window − 33k | `#7c5cff` |

Codex and Grok models are read from the seat's **own** model catalog
(`native-state/models_cache.json` beside its launcher), so a seat offers exactly
what its account and CLI version serve. A Codex seat that has never run a turn
has no catalog yet; it shows Verse's built-in list and says so.

The model picker shows each model's window and compaction point. A model the
seat cannot run is listed but disabled, with the reason — most often **binary
skew**: a seat's launcher execs one pinned CLI binary, which never updates
itself, so Opus 5.5 (which needs Claude Code 2.1.280) is disabled on a seat
pinned to 2.1.257. The seat shows its CLI version and a note with the fix:
`ashlr resources profile repin --directory <dir> --executable <path>`. Add
`--dry-run` to see the change without writing; a real repin first saves the
profile's three files as `.prev` copies, which together restore the old pin.
(Verse 3.5–3.8 offered Opus 5.5 as `claude-opus-5.5`; the CLI resolved that id to
Opus 5, so those sessions ran Opus 5. They keep their recorded id, but their next
turns ask for the real Opus 5.5 — so on a seat still pinned below 2.1.280 Verse
refuses the turn with the reason (`VERSE_MODEL_UNAVAILABLE`) instead of starting
a CLI that cannot run it. Re-pin the seat, or continue the chat in a fresh session
on another model.)

These are your **subscriptions**, not API keys — the work runs through the
vendor CLI signed in as that account, so it draws on the plan you already pay
for. The account's launcher command (which pins `CLAUDE_CONFIG_DIR` /
`CODEX_HOME` / `GROK_HOME`) stays on the server and is never returned by the
API, never logged, and never shown in the UI.

The engine colour is used for the 2px seat marker, the seat pill tint and the
usage bar — never for text.

Health comes from `observations.json` when present, plus Claude's rolling-window
usage from `src/core/fabric/claude-usage.ts`. Otherwise a seat reads `unknown` —
which is shown as `unknown`, not as zero. Seats whose health is `unavailable`
are listed but disabled with the reason. Health is advisory: it never blocks a
turn.

### Local Ollama models

If Ollama is reachable (`cfg.models.ollama`, default `http://127.0.0.1:11434`),
every tag whose `/api/show` capabilities include `tools` becomes a `local:<tag>`
seat under the **Local** group — a model without tool use cannot drive an
agentic session. (Only an older Ollama that reports no capabilities at all falls
back to the name heuristic: `coder`, `code`, `qwen`, `deepseek`, `devstral`,
`llama`.)

The context window is the one the runner actually serves, resolved in this
order (details and evidence in `docs/VERSE-CONTEXT.md` §1.5):

1. on the llama-server lane, the per-slot window (`/props`), whatever the tag
   says;
2. a `num_ctx` pinned in the tag's Modelfile, capped at the model's trained
   length;
3. otherwise Ollama's own default for an unpinned request — the
   `OLLAMA_CONTEXT_LENGTH` or VRAM-based default the running server logged, else
   `OLLAMA_CONTEXT_LENGTH` in Verse's environment, and only then the loaded
   context from `/api/ps` (which another app may have loaded at its own size) —
   which depends on the machine, so a tag that serves 256k here may serve far
   less on a smaller Mac;
4. only when `/api/show` fails, a `ctxNNk` suffix in the tag (`:ctx64k` or
   `-ctx64k`), else 65,536 tokens.

Verse passes that window to the CLI (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`), which
otherwise assumes 200k for a model it does not know and never compacts before a
64k runner overflows. With it, a 64k seat compacts at ≈32.5k — its fixed prompt
already takes about 15k, so pick a larger-window tag for long local sessions.
Before each turn Verse re-checks the tag's window and updates the chat's stored
one if it changed, so the CLI and the meter always use the same, current number.
A tag whose window is under 56k is listed but disabled, with the reason: Claude
Code would compact on every turn.

Local seats run the plain `claude` binary with `ANTHROPIC_BASE_URL` pointed at
Ollama's Anthropic-compatible endpoint — same transcript, tool cards and resume
behaviour as a Claude seat, no cloud account involved, no marginal cost. The
Usage section frames that as `localSavingsUsd`: money you did not spend because
the work ran locally. When Ollama is down the Local group is empty and the
Resources panel says so.

---

## Autonomy with custody (3.10)

3.10 lets the fleet merge on its own, and only inside a scope you signed. The
full model is in [`docs/STANDING-AUTHORITY.md`](STANDING-AUTHORITY.md); this is
the operator's view of it.

- **One Touch ID raises authority.** A standing grant lists the repos, engines,
  risk and size caps, spend ceiling and Leader classes. It is signed by a key in
  this Mac's Secure Enclave, shown in full in the Touch ID prompt, bound to this
  Mac and valid for at most 30 days. Nothing else can widen what autonomy may
  do: not config, not the Leader, not an agent.
- **Lowering never asks.** The Command top bar's switch (Off, Propose,
  Autonomous) goes down instantly. **■ Stop** writes `~/.ashlr/KILL` (the same
  fail-closed stop described below). **Revoke** switches off and requires a new
  grant to resume. Raising the switch past what the grant allows opens the
  Touch ID sheet, which shows the scope and expiry you are about to sign.
- **The ramp is automatic.** The grant carries a rollout ladder (shadow, then
  staged merge, then full). Autonomy advances a stage when that stage's criteria
  are met in the ledger and drops back one stage on any breach. It can never
  pass the last stage you signed.
- **Every merge is remote and reversible.** The fleet works only in its own
  mirrors (`~/.ashlr/fleet/mirrors/`), never in your checkouts. Each change
  passes the merge gates in order, is judged by a model from a different family
  than the one that wrote it, is merged on GitHub pinned to its SHA with
  `Ashlr-Grant`, `Ashlr-Gates` and `Ashlr-Ledger-Head` trailers, and is watched
  for two hours afterwards. A red merge is reverted automatically and the repo
  quarantined.
- **Protected paths go to you.** Authority, sandbox, merge and release code,
  manifests, CI and similar paths are never auto-merged; the PR lands in Needs
  you with the `ashlr:owner-lane` label.
- **One ledger.** Grants, switches, stops, gates, merges, reverts, holds and
  every Leader action are rows in a hash-chained log
  (`~/.ashlr/authority/ledger.jsonl`). A broken chain halts everything until a
  new grant is signed. `ashlr authority ledger verify` checks it.
- **Changed authority code pauses the grant.** Deploying a build that changes
  the authority surface pauses autonomy ("authority code changed — re-approve")
  until one more Touch ID.

**Current status (3.15).** Autonomy ships dormant and is turned on by you, on
macOS, in three moves: `ashlr authority setup` (custody helper, Secure
Enclave key, trust root, `ashlr-fleet` App, Claude token, rulesets or local
enforcement, first grant), then `ashlr authority resident start` typed in your
own terminal, which installs the resident daemon under the grant
([RESIDENT-RUNTIME.md](RESIDENT-RUNTIME.md)). A new grant starts on the
**shadow** stage: the gates run on every proposal and record would-merges,
and no repository merges until the ladder advances. On the maintainer's Mac a
standing grant is active and the ladder is at stage 1 of 8 (shadow).

```sh
ashlr authority setup --dry-run   # print every step and what it would do
ashlr authority setup             # do each step; pauses for what only you can do
ashlr authority status            # grant, switch, Stop, rollout stage, ledger, custody
ashlr authority resident start    # in your own terminal, with the grant active
ashlr authority re-approve        # Touch ID, after a deploy that changed authority code
```

`setup` does every step it can and stops for what no agent may do: the `sudo`
install of the custody helper, Touch ID (key creation and the first grant),
the two GitHub browser clicks for the `ashlr-fleet` App, `claude
setup-token`, and confirming the archive of the old `~/.ashlr/activation/`. It
prints exactly what it did. Afterwards the recurring steps are one Touch ID per
30-day grant, and one after installing a release that changed authority code
(3.15 does: the lessons and Devin work grew the authority surface), followed by
`ashlr authority resident stop` and `start` so the daemon runs the new build.
The resident daemon still re-verifies the grant, Stop and the switch on every
tick.

Private repositories on GitHub's free plan cannot have rulesets. There, a grant
uses **local enforcement** with the fleet App's host-verified `ashlr/verify`
check, and `ashlr authority status` says which repos are enforced which way.

### Budget modes

Every seat has a budget policy under one of three modes. Settings live in
`~/.ashlr/budget.json`; the budget pill on Command and the seat chip in Chat
open the same control, clamped to the grant's ceiling.

| Mode | Autonomy may use |
|---|---|
| **all-in** | Everything available. No reserves. |
| **balanced** (default) | Up to each seat's reserve. Claude keeps 40 % of its weekly window for you and is never used while its five-hour window is above 70 %. Grok keeps no reserve. Local models are free and unlimited. |
| **reserve** | Free local models first, and only a small paid slice (85 % of every paid window is kept for you). |

Codex is off for autonomy in every mode until you switch it on. An unknown
reading makes a seat ineligible for autonomous work, never eligible: your
reserve is not spent on a guess. Your own chats ignore reserves (the reserves
exist for you); a chat is refused only when its seat cannot run a turn at all.

### Account health

A background sweep checks every seat every 10 minutes, using status commands
only (`auth status`, `login status`, `--version`, a local `/api/version`). It
detects signed-out, exhausted and expiring sessions and a CLI build that no
longer matches the seat's pin. A seat that cannot run a turn refuses before the
CLI starts (409 `seat-not-ready`, with the reason) instead of failing
mid-turn. **Reconnect** opens the seat's own login in Terminal; Verse never
types, reads or stores a credential.

### The Leader

The Leader is the fleet's planning agent, and since 3.14 you talk to it: one
conversation across Mind (⌘4), Telegram and `ashlr leader say`, with standing
directives, answers to its questions and early approvals. The full guide is
[`docs/LEADER.md`](LEADER.md).

It reads deterministic digests (fleet history, the ledger, seat headroom, model
outcomes, reasoning insights, approved lessons and its own hit-rate), never raw
reasoning, and writes a memo: the bottleneck, one move with an expected result
and a date, goals, standards, and questions for you. It runs daily and after
notable events, at most three full runs a day, plus check-ins every 2 hours in
working hours when the evidence changed. Seats fall back Grok → fast local →
large local, with Claude only for a weekly deep run that fits inside your
reserve (or by opt-in), and never Codex. Failed runs retry at 15 minutes, 45
minutes and 2 hours. With no standing grant it runs on free local models or not
at all.
From the CLI, `ashlr leader tick` is the same pass the daemon makes: it applies
class-B actions whose veto window has passed, grades due moves, and starts a
run only when one is due. `ashlr leader show`, `run` and `veto` cover the rest.
Since 3.10 `ashlr vision review` is an alias of `ashlr leader tick --wait`; it
no longer runs the legacy Strategist or writes a briefing. The nightly
`ai.ashlr.oversight` job should run the plist that
`ashlr leader oversight-plist --print` prints (see
[Authority](AUTHORITY.md#7-nightly-oversight)).

- **Class A** actions (focus goals, dispatch work, pause a repo, move the budget
  toward reserve, start an experiment) apply at once and can be vetoed at any
  time.
- **Class B** actions (new goals, move the budget toward all-in within the
  grant, more Grok lanes, enabling Codex after its reset, adopting a harness that
  passed its gate) apply after a 30-minute veto window. A spend-raising action
  whose window would end between 00:00 and 07:00 waits for the next morning
  unless the mode is all-in.
- **Class C** is anything outside the grant. It goes to Needs you with the
  Leader's argument attached.

**Veto** undoes one action, or a whole memo, by running its recorded inverse.
Each move is graded after 7 days, and the grades are the Leader's hit-rate on
Mind.

**Founder mode (3.15).** The Leader speaks as a blunt, brief founder-operator
(it never claims to be a real person) and can do more under the grant:
launch a cloud or Devin task, add backlog work, keep its own notes, and save a
new playbook or automation version, each with its class and veto window. On
Telegram it sends a morning brief and an evening recap, answers "status" at
once from recorded state, turns "go build X" into work, and asks one question
at a time. Once a day it may pick up to three Ashlr Verse improvements of its
own (at most one paid). Jev may add an advisory note to a memo when it thinks
an action deserves a stricter class; the class the policy set always stands.
Details: [LEADER.md](LEADER.md#founder-mode-315).

### Learning, reasoning data and experiments

Reasoning from every chat and fleet run is stored as data, scrubbed of secrets
and home paths, local-only and private (0600): text for 30 days, derived
features for 180. It is never replayed into a prompt. Deterministic extractors
turn it into insights (repeated failures, loops, verification gaps, wins),
which feed Mind and the Leader. Harness changes (prompts, effort, sampling,
routing weights) are tested as paired experiments with a confidence interval
against held-out tasks, adopted only through the gate, and rolled back
automatically if a 48-hour canary falls below baseline.

### Lessons: retros and approved knowledge (3.15)

Every way a task ends now produces a short **retro**: a merge, a gate refusal,
an owner-lane PR, a failed verify, a revert, a closed PR, a cloud task that
merged, blocked, failed or expired, the same for Devin tasks, and a Leader
action you vetoed or that was refused. A Devin chat that ends without a PR is
not a failed task end. Retros come from a sweep over the last 30 days of what
is already recorded (the authority ledger, the inbox, cloud and Devin task
files and the Leader's action log), so nothing is hooked into the merge path,
and re-sweeping writes nothing new. A sweep writes at most 40 new retros.

Each retro has a stable root-cause code (for example `gate:files-over-cap`,
`verify:typecheck`, `revert:ci-red`, `closed:by-mason`), what to do differently,
a better prompt and **suggested knowledge**: short notes scoped to a repo, path
globs and task kinds. Infrastructure causes (no required checks, verifier
unavailable, cloud auth) are counted and charted but never become a lesson. An
optional model pass (`foundry.retroModel`, **off by default**; local or Grok,
never Claude, at most 12 calls a day) can refine a retro but never replace its
cause. When Jev is set up, generic causes (`fleet:failed`, `cloud:unknown` and
the like) also get a category from it; the codes themselves never change.

**Suggested knowledge is used only after you approve it.** In **Growth ▸
Lessons** you approve, edit then approve, or reject each note; a rejected note
is never suggested again. Approved notes are added, only where their scope
matches and within a 16 KiB cap that drops whole notes, to fleet goals, cloud
briefs and the Leader's evidence. When nothing matches, the prompt is exactly
what it was before. **Propose for AGENTS.md** files an ordinary fleet task that
goes through every gate; it never writes to a repository directly. The Leader's
veto lessons are read back into its evidence and into tasks the Leader started.

Lessons shows recurring failure causes (stacked by fleet, cloud and Leader),
the suggested-knowledge queue, recent retros (each expandable to its cause,
next steps and better prompt), approved knowledge with hit counts, and Leader
veto lessons. It loads separately, so Growth's first paint never waits on it.

**When sweeps run.** `ashlr verse` sweeps in the background: first 5 minutes
after start, then hourly, skipping a tick while a sweep is running or when the
last one is under 10 minutes old. It runs only on the live console (not with
`--no-accounts`) and never in the daemon. `ASHLR_RETRO_SWEEP_TIMER=0` in the
server's environment turns the timer off. Opening Lessons also starts a sweep
when the last one is over 10 minutes old, and **Sweep now** runs one
immediately. Everything is stored under `~/.ashlr/learn/` (0700/0600), scrubbed
of secrets, home paths and emails.

## Repo wiki and Ask (3.15)

**Gear ▸ Repo wiki**, ⌘K "Open repo wiki…" (⇥ picks a repo) or `ashlr wiki`
keeps a private architecture wiki for each enrolled repository: an overview, a
module map with the import graph and blast radius, key flows, data stores,
commands, and "How to change X" guides for the most-imported modules or the
areas you steer it toward. Each page is model prose on top of a deterministic,
cited Reference section.

- **Verified citations.** A `file:line` citation is kept only if the file is in
  the repository and the line exists; anything else is removed and counted
  ("N unverifiable removed"). A citation opens your editor at that line, or
  GitHub at the commit the page was written from.
- **Private.** Pages live only under `~/.ashlr/knowledge/wiki/<repo>/`, never in
  the repository, and are secret-scrubbed when stored and again when served.
- **Your models.** Generation uses the Leader's check-in seat plan: local models
  first, Grok only when the grant lists that seat and the repo is not
  local-only, **never Claude**. Global local-only mode, the reserve budget mode,
  `foundry.wiki.localOnly`, `foundry.wiki.localOnlyRepos` or `"localOnly": true`
  in the repo's steering file force local. With no allowed model, pages are
  built from repository facts alone ("facts-only").
- **Fresh and bounded.** "Generated at abc1234 · 3 pages stale" comes from git
  blob ids; only pages whose inputs changed are rebuilt, within a page budget
  (default 8) and a token budget (default 60k) per run. Builds run in the
  background. Existing wikis refresh one stale repo at a time in the Verse
  background (`foundry.wiki.autoRefresh=false` stops it).
- **Steering.** `.ashlr/wiki.json` (include, exclude, focus, notes, ignorePaths,
  pages, maxPages, localOnly). `.devin/wiki.json` is also read, so a
  DeepWiki-style `repo_notes` and `pages` file works as is.

**Ask the codebase** (⌘K "Ask the codebase…" or `ashlr wiki ask`) retrieves
over wiki pages, the knowledge index and genome notes, and answers with
citations. It says "not found" when those do not cover the question, and
withholds an answer that has no verifiable citation. With no model it returns
the best passages, cited.

```sh
ashlr wiki build [repo] [--all] [--force] [--no-model] [--pages N] [--tokens N]
ashlr wiki status [repo]
ashlr wiki show <repo> [page]
ashlr wiki ask "where are standing grants verified?" [--repo <path|name>] [--no-model]
```

## Playbooks (3.15)

A **playbook** is a reusable task template. It is Markdown with front-matter
(`id`, `name`, `macro`, `description`, `kinds`, `repos`, `globs`, `auto`,
`budget-usd`, `budget-minutes`, `done-when`) and up to six sections: Outcome
and Procedure (required), Specifications, Advice, Forbidden actions and
Required from user. Versions never change once written: they are stored as
`~/.ashlr/playbooks/<id>/v<N>.md`, and an edit writes the next version.

Seven starters ship built in, all with auto-match off:

| Playbook | Macro |
|---|---|
| `fix-failing-test` | `!fix-test` |
| `fix-issue` | `!fix-bug` |
| `dependency-bump` | `!bump-deps` |
| `add-tests-for-module` | `!add-tests` |
| `docs-sync` | `!docs-sync` |
| `perf-regression` | `!perf-fix` |
| `security-fix` | `!security-fix` |

**How a task gets one.** In order: it names a playbook (`id`, `!macro` or
`id@v3`); its text contains a `!macro` (not inside code; an unknown `!word`
is left alone); or, for fleet, cloud and Devin tasks only, it matches a
playbook whose `auto` is on by kind, repo and globs. The rendered block is
capped at 16 KiB, dropping optional sections whole. A task with no playbook
gets exactly the prompt it got before.

- **In any chat.** A `!macro` typed in a message runs its playbook on every
  seat (Claude Code, Codex, Grok, local, Devin). The block is appended to what
  the seat receives; your message is logged as you typed it, with a
  **Playbook: ‹name› · v‹N›** chip under it. Chats never auto-match.
- **In the lanes.** Fleet goals, cloud briefs, Devin prompts and the Leader's
  `work.dispatch` carry the playbook, and every run records `id@version`, so
  the Playbooks section can show merged, refused, reverted and failed counts
  per version.
- **In Verse.** Gear ▸ **Playbooks** lists them with a version picker, shows
  each as an engine reads it with its outcomes, and saves an edit as a new
  version ("Edit from vN" restores an older one). **Run…** writes the macro
  into the message box. Typing `!` in the composer suggests macros, the ⋯
  sheet has "Use playbook…", and ⌘K has "Open Playbooks" and "Run playbook…".

```sh
ashlr playbook list [--json]
ashlr playbook show <id>[@vN] [--source] [--json]
ashlr playbook new <id> [--file path] [--note "why"]
ashlr playbook edit <id> [--file path] [--note "why"]
ashlr playbook run <id>[@vN] [--repo owner/name] [--lane cloud|devin] [--task "text"] [--title t] [--base branch] [--json]
```

`run` goes through the same services and gates as `ashlr cloud launch` and
`ashlr devin launch`.

## Automations (3.15)

An **automation** is a standing instruction: when its trigger fires, send one
task to one lane through that lane's own entry point.

| Trigger | Notes |
|---|---|
| GitHub issues or PRs | By labels (all must match) and/or a search query. With a query and no label, only issues from the repo's owner, members and collaborators fire. |
| Red default branch | Failing checks on the head commit, once per commit. |
| Schedule | A subset of RRULE (hourly, daily, weekly, monthly, with interval, days, hours and minutes), in local time. |
| Local webhook | `POST /api/verse/automations/<id>/webhook`, loopback only, with the mutation token. |
| Telegram | `/task <owner/repo> <text>` |

| Lane | What it does |
|---|---|
| `fleet` | Queues a fleet task that the daemon runs under the standing grant and the merge gates. |
| `cloud` | Launches a cloud task as self-improvement, so the self-improvement switch, daily cap and reserve apply. |
| `devin` | Launches a Devin session through the fleet entry point: opt-in, grant and fleet budget. |
| `leader-review` | Puts the item in Needs you; Approve sends it through the same gates. |

A firing is held back, never forced, by KILL and Stop, a standing grant that
covers the repo, the automation's own limits (in flight, per day, a monthly
spend cap) and then the lane's gates. The same source item makes one task per
automation, remembered for 30 days. Optional Jev triage may pick a lane from
an allowed list, a playbook, or send a doubtful item to review; it can never
drop work. Verse checks triggers every minute on the live console
(`ASHLR_AUTOMATIONS_AUTO=0` turns that off). Firings are recorded in
`~/.ashlr/automations/firings.jsonl` with links to the source and the lane's
task.

Gear ▸ **Automations** lists each automation's last and next firing, queue,
in flight, today, spend and success rate, with on/off, Run now, Dry run, Edit
and Delete, and says why nothing dispatches when KILL is on or no grant
covers it. New automations start from four templates, all **disabled**: fix
issues labelled `ashlr` (fleet), a nightly flaky-test hunt (cloud), weekly
dependency bumps (fleet) and fix a red main (cloud). ⌘K has "Open
Automations" and "New automation…".

```sh
ashlr automations list [--json]
ashlr automations templates
ashlr automations add --template <id> [--name "…"] [--repos o/n,o/n|*] [--lane <lane>] [--enable]
ashlr automations add --file <automation.json> [--enable]
ashlr automations enable <id> | disable <id> | remove <id>
ashlr automations fire <id> [--dry-run] [--repo o/n] [--text "…"] [--title "…"]
```

## The Jev decision layer (3.15)

Jev is TypeSafe AI's fast classification model. `src/core/decide/` is one
layer every call site goes through, with the same rules everywhere: a
deterministic fallback is always there, each kind has a confidence gate,
answers are cached, a daily paid-call budget applies (1,500 by default), and
`ASHLR_JEV_DISABLE=1` or `ASHLR_CLASSIFY_DISABLE=1` turns it off. Without a
key, nothing is sent and the rules decide. Nothing it says touches the risk
checks, merge authority or the G-gates; safety-adjacent kinds are advisory or
can only escalate. Each decision is logged to
`~/.ashlr/jev/decisions/YYYY-MM-DD.jsonl` without the text it classified.

Where it is asked today:

| Kind | Where |
|---|---|
| engine-error | Classifying sandboxed-engine failures |
| completion-claim | Checking completion claims in the merge passes |
| task-class | Reflection goals, retro task kinds and swarm playbook distillation; the chat's Auto seat label |
| judge-verdict, taste-verdict, red-team-verdict | Reading what the fleet's judge, taste critic and red team said (red team: can only add a finding) |
| retro-root-cause | Categorising generic retro causes |
| needs-you-priority | Ordering Needs you within a severity band, in the background |
| interrupt-worthiness | Whether a landed revert is worth a Telegram ping |
| lane-choice | "Go build X" on the Leader's line; the Devin fleet launcher (can only narrow) |
| trigger-triage | Automations with triage on |
| action-class | Advisory notes on Leader memos (never lowers a class) |
| operator-intent | Classifying what you text the Leader (never invents an approval) |

`ashlr jev status [--json]` and `ashlr jev test "<text>" [--kind …]` show what
it is doing; the Resources drawer has a Jev card and Usage a "Jev decisions"
panel. Cost figures are estimates. Thresholds, bounds and file locations:
[JEV-INTEGRATION.md](JEV-INTEGRATION.md#the-decision-layer-srccoredecide).

## Equal partners: one tier model (3.15)

Claude Code, Codex (both accounts) and Devin (cloud and CLI) are one **elite** tier. Grok and Devin's SWE models
(free on the Devin plan) are **fast**; local models are **free** — except Qwen 3.8 27B, which counts as elite while
staying free. Tier is per model, and cost basis (subscription, credits, per token, free) is a separate axis. The
table lives in `src/core/routing/tiers.ts`, and the router, the Auto seat, Compare, the handoff menu, the New chat
picker and the Resources drawer all read it.

- **Routing** ranks tiers, never providers. Inside a tier it prefers more headroom, then a subscription turn over a
  metered one, then lower latency. Cheap work climbs the cost ladder from free seats upward. Reserves and budget
  modes are still per seat, so the Claude reserve Mason keeps for himself is a configured reserve, not a preference.
- **Devin** is routable for your own chats, just like Claude and Codex. The Auto seat can pick it or stay on it,
  Compare can pit Claude against Codex and Devin, and handoff offers it. A seat that also has a cheaper-tier model,
  such as the Devin CLI's SWE, uses that model for cheap work. The fleet still runs Devin only through its own
  lane, grant and ACU reserve. Devin is never auto-picked to review another model's answer.
- **Hard work you are waiting on** goes to a hosted elite seat before an elite local model, because local models
  are slower on this Mac. The local model is still ahead of every fast or free seat.

## Resources: the drawer and the bar (3.11)

- **Resources drawer (⌘.).** Open it from the edge tab, the rail button or "Open Resources" in ⌘K. It holds one
  card per resource, grouped by tier (3.15) — never by provider:
  - **Elite:** every Claude and Codex account, **Devin** (cloud and CLI on one
    card; see [Devin](#devin-315)), and the Claude cloud credits — plus the
    local runtime while it runs Qwen 3.8 27B;
  - **Fast:** Grok;
  - **Free · local:** the local runtime and its models, with their context
    windows (one Local card spans Ollama, LM Studio and llama-server);
  - **Decision layer:** the **Jev** card (decisions today by kind, confidence,
    fallback rate and estimated cost; see
    [The Jev decision layer](#the-jev-decision-layer-315)).
  Every card has the same rows: a facts line (tier · cost basis · models ·
  reserve), status, usage against its window or budget, and the readiness
  lines. Inside a tier, usable cards come first, then a subscription before a
  metered balance. It opens as an overlay or pins as a column, and remembers
  which. While a chat turn is running, ⌘. in the composer stops the turn
  instead.
- **Readiness lines (3.14).** Every card says whether the resource is usable in
  each place, with the fixing command when it is not: "Chat: ready / why" and
  "Fleet: ready · reserve kept / why". A seat can be ready for your chats but
  not for the fleet, for example while its window is inside the reserve kept
  for you, or when there is no standing grant.
- **Resource bar.** It sits in the rail foot and is always on:
  - one battery per resource, showing how much of its binding window is left;
  - green when usable, amber when low, red when spent or signed out;
  - with rail labels shown, the full name above a battery and a value; with labels hidden, upright batteries under
    each logo.
  Hover or focus a row for every window and its reset, the reserve and when a spent account comes back. Click a row
  to open the drawer. **Hide resource bar** (drawer footer, or ⌘K) brings back the single capacity ring.
- **Provider marks.** Engine tiles, the seat chip, the chat header, ⌘K, the tasks pane and chart lane labels show
  the provider's own mark: Anthropic's Claude, OpenAI, xAI's Grok or Ollama (path data from @lobehub/icons, MIT).
  The account's name is always written beside the mark.
- The rail head, the app icon, the menu-bar icon and verse.ashlr.ai carry the Ashlr.AI keystone "A".

## Cloud lane (3.11)

Verse can start **Claude Code cloud sessions** (claude.ai/code) and follow what
they deliver. They run on your Claude account, including its cloud credits, so
work continues after the subscription's weekly window is spent. The mechanics,
the delivery contract, the budget math and every failure code are in
[`docs/CLOUD.md`](CLOUD.md). This is the operator's view.

- **Where to start one.** **New cloud task** on Command's Cloud card (repo,
  base branch, task text), **Run in cloud** in the composer's ⋯ sheet (the
  typed prompt, for the chat's project), or `ashlr cloud launch "<task>"`.
  Run in cloud is disabled, with the reason in its tooltip, when the project
  has no GitHub origin or the seat is not ready.
- **What a task delivers.** Verse cannot read a session back. Every task is
  told to push the branch `ashlr-cloud/<taskId>` and open a **draft** PR
  titled `[ashlr-cloud] <title>`, ending in an `ashlr-cloud-report` block
  (status, summary, tests run, risks). Verse checks GitHub with `gh` every 10
  minutes, or now with **Refresh**. A task with an open PR shows in Needs you
  as "Cloud task ready for review", with its report summary.
- **Nothing merges from the lane.** A cloud PR goes through the custody gates
  above, or waits for you. Dismissing a task in Verse marks it closed and does
  not touch GitHub.
- **The seat.** Sessions launch only as the `claude-a` seat's native profile,
  signed in with a claude.ai account. Cloud sessions refuse API keys, so the
  `claude` on your `PATH` is never used. The seat counts as ready when its
  profile's `command.json` exists and holds an argv array. Verse does not run the CLI to check sign-in,
  so a signed-out seat shows up as an `auth` failure at launch.

**Spend is an estimate, and is always labelled as one.** Claude does not expose
the credit balance. The Cloud card shows "$X of $250 · estimate": $3 per
launched session (failed launches cost nothing) plus an adjustment you set
after checking <https://claude.ai/settings/usage>, which it links to. **Edit
budget** (also in Settings ▸ Usage ▸ Cloud credits, and
`ashlr cloud budget`) sets the total, the adjustment, the per-session
estimate, at most 4 sessions at once and 20 a day.

**Improve Verse.** Verse keeps a backlog of work on itself: built-in briefs
plus items you or the Leader add. **Improve Verse** launches the next item now.
With self-improvement on (the default), the server also launches one on its own
two minutes after start and then hourly, at most 4 a day, and stops when
estimated credits fall below the $40 reserve. The Cloud card's switch, or
`ashlr cloud budget --self-improve off`, stops that. `ASHLR_CLOUD_AUTO=0` in the
server's environment stops the scheduler entirely. Fleet's lanes row shows
"Cloud · N running".

**Cloud PRs and the gates (3.13).** Under a standing grant, a cloud PR on a
granted repository is taken in by the standing merge pass and can land only
through G0–G7, from the fleet App's own PR. Everything else is triaged in Needs
you. See [Intake into the standing gates](CLOUD.md#intake-into-the-standing-gates-313).

## Devin (3.15)

Devin (Cognition) shows up in four places. Everything except the CLI seat is
off until you run `ashlr devin connect`; the CLI seat appears once the `devin`
binary is installed.

- **Chat seats.** **Devin (cloud)** runs one Devin session per chat, with its
  replies, status, PR cards and ACU reading in the transcript. **Devin (CLI)**
  drives the `devin` agent on this Mac; Verse checks that it is installed and
  logged in before each turn and says what to run if not. The Auto seat line
  is hidden on Devin chats.
- **A lane.** **Run in Devin** in the composer's ⋯ sheet and in ⌘K, or `ashlr
  devin launch`. Each session must deliver one PR from `ashlr-devin/<taskId>`
  with an `ashlr-devin-report` block, capped at a per-session ACU limit.
- **The fleet.** Under a grant that names Devin (with the fleet opt-in and a
  custody helper new enough to sign it), the daemon may launch Devin on
  well-scoped backlog work, at most 1 at a time and 3 a day by default.
- **Needs you.** Devin PRs get the same Clean or Held verdict, Land, Close,
  Update branch, Land all clean and Evidence as cloud PRs. Under a grant they
  go through the standing gates, where a Devin PR merges only if the stage
  names Devin and judges from two different model families approved it;
  otherwise the gates record a would-merge and the PR waits for you.

Setup (plan, training opt-out, GitHub integration, service user, `ashlr devin
connect`, ACU budget, the CLI) and limits: [`docs/DEVIN.md`](DEVIN.md).

## Fleet ▸ Advanced — the daemon cockpit

In 3.10 the V2 Autonomy panels live under **Fleet ▸ Advanced**. They set the
config-level limits; a standing grant bounds them from above, because effective
policy is the minimum of the grant, the config and the compiled ceilings.

The Autonomy section is the cockpit for the hub's existing daemon. The loop
picks work off your goals and backlog, dispatches it to seats, and files the
results as proposals in Approvals. You read the results later instead of
watching it happen.

### Status and controls

The header tells you whether the daemon is running, the current direction mode,
when the last tick ran and how it went, when the next one is due, and today's
spend against the daily cap as a single line meter.

- **Start** / **Stop** the loop — the ordinary controls. Stop is just "stop the
  daemon"; it does not disable anything else.
- **Run one tick** — do exactly one pass, now, and show what it did. The honest
  way to find out what the loop would do before letting it run unattended.
- **Emergency stop** — see below. Separated, confirm-guarded, and labelled for
  what it is.

### How spend is bounded

Every limit is editable in the Budget & limits panel and takes effect live (the
daemon re-reads its config each tick), with an inline "applied live"
confirmation on commit:

| Limit | Range | What it does |
|---|---|---|
| Daily USD budget | 0–1000 | Hard ceiling on spend per day. **0 means stopped** — the panel says so rather than letting you set it silently. |
| Items per tick | 1–50 | How much work one pass may pick up. |
| Parallelism | 1–16 | How many dispatches run at once. |
| Tick interval | 30 s – 24 h | How often the loop wakes. |
| Max concurrent | 1–32 | Ceiling across everything. |
| Concurrency: local / cloud / total | 0–32 each | Splits the ceiling between free local work and paid cloud work. |
| Subscription max percent | 1–100 | How much of a subscription's window the fleet may consume before it backs off. |
| Per-engine dispatch limits | max ≥ 0 per engine/window | Rate limits per engine, checked against the dispatch ledger. |

Each control shows its current value **and the live usage against it**, so a
limit is never an abstract number. Usage also breaks down local vs cloud for the
period, so you can see how much of the day ran for free.

### How scope is bounded

The loop can only touch repositories in the enrollment registry. The Scope panel
lists them and lets you add and remove them by absolute path.

- Non-absolute paths, non-directories, and anything under `~/.codex/artifacts`
  are rejected.
- **An empty registry means the daemon does nothing.** The empty state says that
  plainly rather than looking like a loading failure.

Enrollment is the single biggest lever you have. A repo that is not enrolled
cannot be written to by the fleet, whatever the caps say.

### What it did while you were away

The Activity view is the audit trail: recent ticks, dispatches, and every
recorded action with its result and time, newest first, filterable by action and
result. The Safety view runs the `verify-safety` report as five pass/fail checks
with a re-run button.

Goals and the backlog are shown read-only in V2.

### The emergency stop — what it actually does

**It is not a pause.** Pressing it writes the global sentinel file
`~/.ashlr/KILL`, and that file is read fail-closed across the whole hub: the
kill switch counts as *on* unless it is proven absent.

While it is armed:

- the autonomous loop refuses to dispatch;
- outward mutations are fenced — an operation already inside the fence may
  finish, but nothing new gets in after the sentinel is observed;
- **the agent's own `mcp-native` write tools are refused too.** That includes the
  agent you are chatting with in the Chat section. This is the part people are
  surprised by, so the confirm step spells it out.

Clear it from the same control. Clearing also takes the fence, so it cannot race
with a mutation that is mid-flight.

If you only want the loop to stop, use **Stop**, not the emergency stop.

---

## Approvals

In 3.10 Approvals is the **Approvals** split of the Needs-you drawer (⌘J).

Everything the fleet produced that needs a human is here, pending first. Each row
shows its risk class, repo, title, engine and age. Opening one gives you the
summary, a real syntax-aware diff, the verify result, the decision evidence and
the provenance.

**Approve is destructive.** A `pr` proposal pushes a branch and opens a pull
request. Approving therefore requires an explicit confirm step that names the
repo and the kind of proposal, and shows what will happen before you click.

---

## Usage

Usage is in the gear tray. The same per-seat capacity strip now appears in
Apps & Accounts, the new-chat dialog and onboarding, so there is one
description of each seat rather than four.

One card per seat: engine marker, plan, window meters with reset times, and
tokens used. Plus the local-vs-cloud split for the period, `localSavingsUsd`
framed as money not spent, and dispatch-ledger usage against each configured
per-engine limit. Each seat card also aggregates its chat sessions' context
efficiency — cache-hit ratio and compactions — computed in the browser from
usage Verse already stores.

Where a number does not exist, it says so. Claude has no local utilization
signal and Grok's probe is not on `/api/usage`; both render as **unknown**
rather than as a fabricated zero. If a per-day spend series cannot be derived
from the data on hand, you get the aggregate and a note that the series is
unavailable — not an invented curve.

---

## Apps & Accounts

Gear tray ▸ Apps & Accounts replaces the MCP section and the Resources
panel's account view. Rows are grouped:

- **Accounts:** per seat, the plan, connection health, the five-hour and weekly
  windows with reset times, and "Reserved for you 40 %". Actions: Reconnect,
  Fix (shows the exact command), Edit budget.
- **Desktop:** Claude Desktop's "Use Ollama models" (shown off, with Restore;
  Verse's local seat already routes to Ollama) and Hermes Desktop. Turning
  either on confirms first and shows the command.
- **Terminal agents:** Claude Code, Codex, Grok, Hermes, Aider, Goose,
  OpenCode, Droid, Pi and Cline, each with its installed version (or "not
  installed") and its own launch command. `ollama launch <id>` is offered only
  where the installed Ollama lists that agent. **Launch ▸** opens a Terminal in
  the current project; the command is built by the server from the catalog,
  never taken from the page.
- **Local models:** Ollama (version, models, last measured tok/s),
  llama-server's health, LM Studio.
- **MCP servers**, per seat, with the same add flow as before. Claude and local
  seats load no MCP servers (`--strict-mcp-config`); the page says so. The one
  exception is Verse's own browser tools, on a chat where you switched agent
  access on in the Browser pane ([VERSE-BROWSER.md](VERSE-BROWSER.md)).

Nothing on this page spends: it runs status commands and loopback reads only,
and Launch or a toggle opens a visible Terminal that you drive.

---

## Theming and appearance

Settings → Appearance. Everything applies instantly — there is no save button —
and persists in `localStorage` under `ashlr.verse.appearance.v1`. "Reset to
defaults" undoes the lot.

| Control | Options |
|---|---|
| Theme | System / Light / Dark |
| Accent | Eight presets plus a hue slider |
| Density | Comfortable / Compact |
| Display font | Space Grotesk / UI sans / Mono |
| Radius | Sharp / Default / Soft |
| Reduce motion | Forces all durations to 1 ms (`prefers-reduced-motion` is respected by default anyway) |

The interface is monochrome by design: colour carries meaning (a status, an
engine identity, a destructive action) and nothing else. Fonts are self-hosted —
there is no network font access — so appearance works offline.

In the desktop app the theme also drives the **native window background**, so a
dark-mode launch never flashes white before the page paints.

---

## Keyboard shortcuts

In the console (browser or desktop). ⌘/ shows this list in the app, read from
the same catalog the handlers use.

| Keys | Action |
|---|---|
| ⌘1 – ⌘5 | Command, Fleet, Growth, Mind, Chat |
| ⌘K | Command palette |
| ⌘J | Needs you |
| ⌘. | Resources drawer (in the composer while a turn runs: stop the turn) |
| ⌘N | New chat |
| ⌘, / ⌘/ | Settings / keyboard shortcuts |
| ⌘[ / ⌘] | Back / forward through surfaces and chats |
| ⌃⇥ / ⌃⇧⇥ | Next / previous recent chat |
| ⌘⇧\ | Show or hide rail labels |

In Chat:

| Keys | Action |
|---|---|
| ⌘\ | Show or hide the panel |
| ⌃` / ⌃⇧` | Terminal / new terminal tab |
| ⇧⌘B / ⇧⌘D / ⇧⌘O | Browser / Changes / Files |
| ⇧⌘S / ⇧⌘Y | Sources / Reasoning |
| ⇧⌘F | Focus mode (Esc outside a text field leaves it) |
| ⌘B / ⌘F | Chat list / find in chat |
| ⌥↑ / ⌥↓ | Previous / next turn |
| ⌘⇧M / ⌘⇧I / ⌘⇧E | Permission mode / model / effort |
| ⌘U | Attach files |
| ↩ | Send (queues while a turn runs, up to 3) |
| ⇧↩ | Newline |
| ⌘⇧↩ | Stop the running turn and send |
| Esc | Stop the running turn (only from an empty composer with no overlay open); closes a panel sheet restored open on a narrow window |

In the Terminal pane: ⌘D / ⌥⌘D split right / down, ⌘F find, ⌘↑ / ⌘↓
previous / next command, ⇧⌘K the Blocks view.

In the Needs-you drawer: `J`/`K` move, ↩ opens, `X` select, `A` approve,
`R` reject, `V` veto, `E` done, `H`/`L` switch splits. On a focused chart card: `T` shows it
as a table.

Desktop app only, from the macOS menu bar:

| Keys | Action |
|---|---|
| ⌘, | Settings |
| ⌘R | Reload |
| ⇧⌘L | Toggle light / dark |
| ⌘= / ⌘− / ⌘0 | Zoom in / out / actual size |
| ⌘Z / ⇧⌘Z / ⌘X / ⌘C / ⌘V / ⌘A | Undo / Redo / Cut / Copy / Paste / Select All |
| ⌘M / ⌘W / ⌘H / ⌘Q | Minimize / Close window / Hide / Quit |

⌘1–⌘5, ⌘K and ⌘N are deliberately **not** bound in the native menu so they reach
the page. ⌃⌥Space is a system-wide hotkey the desktop app registers (off by
default; Settings ▸ Desktop): it brings Verse forward and focuses the composer.

---

## Desktop app (macOS)

The Tauri app in `desktop/` is a native window around Verse plus a menu-bar
item. It is a source-only draft — there is no public installer (see
`DESKTOP.md`). Full detail, including the native↔web shell contract, is in
[`desktop/README.md`](../desktop/README.md).

What it does on launch:

1. Opens a small **launch window** immediately, so the app is never an invisible
   process while the server boots.
2. Checks whether anything already holds `127.0.0.1:7777`. If so it says exactly
   that and offers to adopt the running server, retry, or quit — it does not
   spin forever, and it does not silently attach to someone else's server.
3. Spawns the bundled `ashlr` sidecar as
   `ashlr verse --port 7777 --no-open --json`, reads the single JSON startup
   line, takes `readToken` and `token`, and drops the line. It is never
   forwarded to the event bus, to stderr, or to the launch window.
4. Creates the **Ashlr Verse** window at `http://127.0.0.1:7777/verse/` with
   `window.__ASHLR_TOKENS__` already set, so the SessionGate never asks for a
   paste. The window has an overlay title bar with the traffic lights inset into
   the console's own 48px header strip, remembers its size and position in
   `~/.ashlr/desktop/window-state.json`, and paints its background in the
   current theme before the page loads.
5. If the bundled CLI does not know `verse` yet, it falls back once to
   `ashlr serve --port 7777 --allow-dispatch --json`.

Closing the window hides it to the menu bar. **Quit** — ⌘Q, the Ashlr menu, or
the menu-bar item — kills the sidecar and exits.

The sidecar is reaped on every exit path, so no orphan server is left behind:
a normal quit kills it and its worker children, a signal (`pkill`, Ctrl-C)
triggers a handler that does the same, and if the app is SIGKILLed or crashes,
the **next launch** kills the sidecar it left behind before probing the port.
After quitting, `pgrep -fl "Contents/MacOS/ashlr verse"` should print nothing.

The menu-bar item lists the running chats (its title shows "● N" while any
run), **Needs you…**, **New chat**, **Stop running chats…** (native confirm,
then each chat is cancelled), **Show** and **Quit**. The tray may stop chats; it
never starts, stops or steers the fleet. Fleet Stop lives on Command, behind a
confirm step, on purpose.

While the window is unfocused, the app raises banners for finished and failed
chats, new Needs-you items and seat-health changes (notifications are on by
default; Settings ▸ Desktop). The Dock badge counts Needs-you items. Unsigned
builds deliver banners through `osascript`, so they appear as Script Editor. The
tray and the Dock badge are the reliable signals there. Details:
[`desktop/README.md`](../desktop/README.md).

### Install it on this Mac

There is no public installer (that policy is unchanged), but building Ashlr for
your own Mac and keeping it in the Dock is supported:

```sh
REPO=/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub

# 1. Build. Run the WHOLE sequence in "Build it" below, not just the last step:
#    npm run build:binary → prepare-sidecar.mjs → CI=true cargo tauri build.
#    A bare `cargo tauri build` rebuilds the Rust shell around whatever web
#    assets were already staged, which is how a stale UI gets installed.
cd "$REPO/desktop" && CI=true cargo tauri build

# 2. Verify the bundle carries this build's assets (see "Verify the bundle"
#    below) BEFORE replacing a copy you are relying on.

# 3. Install, replacing any previous copy.
rm -rf /Applications/Ashlr.app
cp -R "$REPO/desktop/src-tauri/target/release/bundle/macos/Ashlr.app" /Applications/
```

Then, **once**: the build is unsigned, so macOS refuses an ordinary
double-click. Right-click (or Control-click) `Ashlr.app` → **Open** → **Open**.
If no Open button appears, use System Settings → Privacy & Security →
**Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/Ashlr.app`.
With Ashlr running, right-click its Dock icon → **Options → Keep in Dock**.

**To update:** quit Ashlr, repeat steps 1–3, launch again. The Gatekeeper
exemption is remembered per app path, so a rebuild copied over the same location
normally opens straight away. Nothing in `~/.ashlr` is touched by installing or
replacing the bundle — config, seats, autonomy state and window geometry all
survive.

### Build it

Prerequisites: Rust ≥ 1.85 with `cargo install tauri-cli --version "^2"`, Bun
1.x, Node ≥ 18, Xcode command line tools. From the repo root:

```sh
# 1. Compile the CLI into a single Bun executable (runs the web build first)
npm ci
npm run build:binary                     # → dist-bin/ashlr + dist-bin/public/

# 2. Stage it as the Tauri sidecar for the host triple
node desktop/scripts/prepare-sidecar.mjs # → desktop/src-tauri/binaries/ashlr-aarch64-apple-darwin
                                         # → desktop/src-tauri/resources/public/

# 3. Generate the app icons (once, or after changing icons/icon.svg)
cd desktop && npm run icons

# 4. Bundle
cd desktop && CI=true cargo tauri build  # release .app + .dmg
cd desktop && cargo tauri build --debug  # fast, unoptimized
```

Output: `desktop/src-tauri/target/release/bundle/macos/Ashlr.app` and
`.../dmg/Ashlr_<version>_aarch64.dmg`. About 6 minutes cold, ~90 seconds when
only the bundling has to be redone.

**The order is the whole trick.** The `.app` bundles a *copy* of the web
assets, staged three times on the way in — `vite build` writes
`dist/core/web/public`, `build:binary` copies that to `dist-bin/public`,
`prepare-sidecar.mjs` copies that to `desktop/src-tauri/resources/public`, and
only then does `cargo tauri build` copy that last directory into
`Ashlr.app/Contents/Resources/public`. `beforeBuildCommand` is deliberately
empty, so Tauri rebuilds **nothing**: skip step 1 or step 2 and you get a
freshly compiled Rust shell wrapped around whatever assets a previous run left
in `resources/`. That has shipped a stale UI more than once. Run steps 1, 2 and
4 in that order every time, even when only the web changed.

#### Two gotchas

**1. `npm run build` cannot pass on this machine, and `build:binary` calls it.**
Its `scripts/build-release-dependency-inventory.mjs` step refuses to run when
the npm on `PATH` resolves through symlinks — here it exits with `npm runtime
closure contains a symbolic link`. `scripts/build-sea.mjs` shells out to
`npm run build`, so `npm run build:binary` inherits the failure. Work around it
with a `PATH` shim that intercepts exactly `npm run build`, runs the remaining
steps individually, and delegates every other npm invocation untouched:

```sh
REPO=/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub
SHIM=$(mktemp -d); REAL_NPM=$(which npm)
cat > "$SHIM/npm" <<EOF
#!/bin/sh
REAL_NPM="$REAL_NPM"
if [ "\$1" = "run" ] && [ "\$2" = "build" ] && [ \$# -eq 2 ]; then
  set -e; cd "$REPO"
  "\$REAL_NPM" exec -- tsc -p tsconfig.json
  node scripts/copy-assets.mjs
  node scripts/build-preparation-builtin.mjs
  "\$REAL_NPM" exec -- vite build --config vite.config.web.ts
  node scripts/build-identity.mjs
  exit 0
fi
exec "\$REAL_NPM" "\$@"
EOF
chmod +x "$SHIM/npm"
cd "$REPO" && PATH="$SHIM:$PATH" npm run build:binary
```

The omitted step only writes a release dependency inventory; nothing the `.app`
needs at runtime comes from it. Keep the shim out of `PATH` for everything else
— it is a build workaround, not a fix.

**2. `CI=1` is rejected by the Tauri CLI. Use `CI=true`.** The CLI parses the
variable as a boolean and treats `1` as malformed, so the build exits before it
bundles anything. `CI=true` is what skips the Finder-driven DMG layout (see
below).

#### Verify the bundle actually carries the new assets

Do not trust the build log for this — it reports that it copied a directory,
not which directory. Check the bundle itself:

```sh
APP=desktop/src-tauri/target/release/bundle/macos/Ashlr.app

# a. the current native↔web shell contract is present
grep -rl 'ashlr:desktop-command' "$APP/Contents/Resources/public/next/assets/"

# b. …and it is THIS build's copy, not an older one that also had it
diff <(cd dist/core/web/public/next/assets && ls | sort) \
     <(cd "$APP/Contents/Resources/public/next/assets" && ls | sort)
```

(a) on its own proves nothing: the listener has been in every build for a
while, so a months-old bundle passes it. (b) is the real test — Vite filenames
are content hashes, so an identical file list means byte-identical assets.

Then launch it and read the sockets rather than the screen:

```sh
open "$APP"

lsof -nP -iTCP:7777
#  LISTEN from Ashlr.app/Contents/MacOS/ashlr  → the sidecar booted
#  a second ESTABLISHED line from com.apple.WebKit.Networking → the window
#  loaded the page AND the injected tokens were accepted (that connection is
#  the SSE stream, which a 401 would never have opened)

ls -a ~/.ashlr/account-connections/ledger | grep -E 'lock|pending'
#  .resource-quota-refresh.lock and .resource-quota-refresh-pending.json exist
#  WHILE it runs — that is the collector lease, and it means the app is
#  gathering live account telemetry rather than serving an empty Usage view

osascript -e 'tell application "Ashlr" to quit'
lsof -nP -iTCP:7777                        # silent → port released
pgrep -fl 'Contents/MacOS/ashlr verse'     # silent → sidecar reaped
ls -a ~/.ashlr/account-connections/ledger | grep -E 'lock|pending'
                                           # silent → lease released
```

A lock or pending file surviving the quit means the lease was stranded and the
next launch will fall back to read-only evidence; delete neither by hand
without checking that no collector is running.

**The `.app` is the artifact that matters**; the `.dmg` is only a wrapper for
handing the app to someone else. The DMG step drives Finder over AppleScript to
lay out the disk-image window, and that step is flaky — it needs a logged-in
graphical session with Automation permission, and it leaves a mounted
`/Volumes/dmg.XXXXXX` behind when it fails. `beforeBundleCommand` now clears
that leftover automatically (`desktop/scripts/dmg-preflight.mjs`), and
`CI=true cargo tauri build` skips the Finder step entirely, producing a plain
DMG around an identical app. A DMG failure never invalidates the `.app` that
was already written. Full diagnosis in `desktop/README.md`.

For a dev loop without bundling, `cd desktop && cargo tauri dev` — it still
launches the staged sidecar, so run steps 1–2 first.

---

## Known limits

**Chat**
- One seat per session, and one primary project (a workspace adds extra roots).
  Switching either starts a new chat; **Continue in a fresh chat** carries a
  deterministic handoff note across. Beyond that note and the shared project
  memory, a session knows only what its own vendor conversation holds.
- Permission modes are Plan, Accept edits (default), Auto and Bypass. Verse does
  not surface per-tool approval prompts yet; use
  the CLI directly when you want to approve each tool call.
- The Terminal pane needs the desktop app (Bun's pseudo-terminal). Under plain
  Node the pane says so. A terminal tab holds at most two visible panes.
- The Browser pane loads any site only in the desktop app with the current
  shell; elsewhere it frames loopback dev servers and opens anything else in
  your browser. Agents get its tools only on Claude and local seats, and
  cannot click or type. See [VERSE-BROWSER.md](VERSE-BROWSER.md).
- The Files pane is a simple list of folders and touched files, not a file
  browser yet. Side chats and split sessions are not built yet.
- Past 40 turns the transcript renders far-away turns as placeholders, but a
  very long session still costs context — continue in a fresh chat when the
  handoff banner appears.
- `!macro` runs a playbook in any chat, but a chat never auto-matches one.
- Devin (CLI) chats report no usage, so they are not counted in the Devin
  budget, and their PRs get only Dismiss in Needs you.
- Verse never compacts, summarizes or switches context mode on its own. The
  CLIs compact themselves; Verse shows it. **Compact now** is the operator's, on
  Claude and local sessions only; it was verified headless on a local seat and not
  run on a paid one, where it spends.
- Codex can compact somewhat before the meter's tick (its check also counts
  tool output since the last call); the tick is a ceiling, not a promise.
- The meter measures the prompt, not the reply. One very long reply can carry a
  session past its compaction point within a single turn.
- Grok and Codex resume rely on each vendor's `--resume` / `exec resume`
  behaviour; if a vendor CLI changes its JSON shapes the adapter needs updating
  (`src/core/verse/adapters/`).
- Local seats need the `claude` binary on `PATH` and an Anthropic-compatible
  Ollama; models without tool-use support are not offered as seats, because
  they could chat but never edit.
- Dictation depends on the runtime. WKWebView has no `SpeechRecognition`; use
  system dictation in the desktop app.

**Autonomy**
- Autonomy is dormant until you act: it needs the custody helper, your key
  compiled into the standing-grant trust roots, a Touch ID grant and
  `ashlr authority resident start`. It is macOS-only. A new grant starts at
  shadow, where nothing merges. The legacy permit-based daemon and conductor
  roots stay empty; the resident daemon runs only under a standing grant.
- Installing a release that changes authority code pauses the grant until
  `ashlr authority re-approve` (Touch ID).
- Claude as a fleet **producer** waits for a credential proxy. Claude judges
  and runs the Leader, with no tools; Claude cloud sessions are a separate
  lane whose PRs go through the same gates.
- A Devin PR merges only under a grant whose stage names Devin and with two
  judges from different families; otherwise it is shadow. Fleet use of Devin
  needs custody helper 1.1.0 or later and a grant that names it
  ([DEVIN.md](DEVIN.md#limits)).
- Caps bound spend per day, not per task. A single expensive dispatch can still
  consume a large share of the day's budget before the meter catches up.
- Spend figures are the hub's own accounting, not the vendor's billing. Treat
  them as close, not authoritative.
- Goals and the backlog are read-only in the Advanced panels — create and edit
  them through the CLI, or let the Leader focus them (every change is in the
  action log and can be vetoed).
- The emergency stop is global and fail-closed. If the sentinel cannot be read,
  the hub behaves as though it is armed. That is deliberate, and it means a
  broken `~/.ashlr` looks like a stopped fleet.

**Usage**
- Claude has no local utilization signal and Grok's probe is not on
  `/api/usage`. Both are shown as unknown. Nothing is estimated to fill the gap.

**Agents board auto-merge**
- Auto-merge is off for each agent until the operator enables it. It also needs
  `ASHLR_VERSE_AUTOMERGE_CHECKS` set to the exact, comma-separated names of
  required code checks (for example, `CI, Typecheck`). An unset or malformed
  setting holds every automatic merge. A green Vercel preview alone does not
  count as code verification.
- Verse reads those checks again on the PR's current head immediately before
  its SHA-pinned squash merge. Each named check must appear exactly once and
  have succeeded. GitHub branch protection should require the same checks;
  a check name by itself does not authenticate which GitHub App reported it.
- Repositories without live code CI should leave auto-merge off. The current
  ashlr-hub GitHub Actions workflows must be enabled and passing before their
  names can serve as auto-merge gates.

**Desktop**
- macOS only. Linux Tauri builds are quarantined (`GHSA-wrw7-89jp-8q8g` /
  `RUSTSEC-2024-0429`); see `DESKTOP.md`.
- Unsigned and un-notarized — expect the one-time Gatekeeper prompt.
- The port is fixed at 7777. If something else holds it, the app tells you and
  offers to adopt it, but it cannot move to another port.
- Tokens are held in memory only and are not persisted between launches.
- A drag region cannot move the window while the window is unfocused (an
  upstream Tauri limitation of the overlay title bar): first click focuses,
  second click drags.
- Auto-update is inert until a signing key is configured.
