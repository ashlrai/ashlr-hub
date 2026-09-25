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

This page is the user guide.

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
| ⌘1 | **Command** | What needs me, and is the company producing? The autonomy switch, Stop, the budget pill and the grant chip; a one-line verdict ("Autonomous · 5 building · 7 merged today · 0 reverts · Claude 46% reserved for you"); Needs you; the Leader's memo; five KPIs; a burn-down per seat; a 12-hour swimlane. |
| ⌘2 | **Fleet** | What is running where, and why that seat? A live swimlane by lane and phase, the gate funnel with refusal reasons, "why this seat" for each dispatch, parked work, the repo table with pause and resume, and Overnight. The 3.9 Autonomy panels live under **Fleet ▸ Advanced**. |
| ⌘3 | **Growth** | Is the output compounding? Merges per week, cost per merge, model ROI, a calendar of merges, the harness history and the experiment results. |
| ⌘4 | **Mind** | What did the Leader decide, and was it right? Its memos with each move's 7-day outcome, its hit-rate, the reasoning insights, the standards it set, and the action log with Veto. |
| ⌘5 | **Chat** | The interactive workbench: sessions, transcript, dock (Terminal, Preview, Review) and composer. |

The **gear** at the foot of the rail holds Settings (⌘,), **Apps & Accounts**,
Usage and Shortcuts (⌘/). Beside it, a small ring shows the scarcest seat's
five-hour window.

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
Approvals. Splits: All, Approvals, Fleet, Chats, Accounts (`H`/`L` switch).
`J`/`K` move, ↩ opens, `A` approves, `R` rejects, `V` vetoes, `E` marks done.
Approve, reject and veto confirm first, then ask for the mutation token. An
empty drawer says "All clear" with the fleet's status line.

### Command palette (⌘K)

Opens in under 50 ms and never switches surface on its own. Results are
grouped Needs you › Chats (running first) › Actions › Go to › Seats & Apps ›
Projects. Start with `>` for actions only or `#` for chats only; ⇥ fills an
argument ("New chat on…" → a seat). An empty query lists your last five
actions. Guarded actions ("Stop running chats…", "Stop the fleet…") confirm,
then ask for the token. Every palette entry, menu item, shortcut and key
handler reads one catalog, `routes/verse/shell/command-catalog.ts`.

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

**Dock.** One pane or a vertical split of two, 320 px to 60 % of the window;
a sheet below 1024 px and a bottom sheet on a phone.

- **Terminal** (⌃`; ⌃⇧` for a new tab): a real login shell per tab in the
  chat's folder, with copy on select, "Send selection to chat" and a
  screen-reader mode. Up to 8 tabs; scrollback is 256 KB in memory only; a tab
  idle for 12 h is closed; tabs survive a page reload. It needs the desktop app
  (the sidecar's Bun runtime provides the pseudo-terminal). Under plain Node the
  pane offers **Open in Terminal.app** instead.
- **Preview** (⌘⇧B): loopback dev servers (`http://127.0.0.1:*`,
  `http://localhost:*`) with back, forward, reload and a Desktop/375 frame. Its
  dev-server list comes from `.claude/launch.json`, `package.json` scripts and
  listening ports; **Start** runs the server in a Terminal tab and waits for the
  port. The html, markdown, svg, image and pdf files the chat wrote open as
  **artifacts** under a CSP sandbox, an opaque origin with no access to Verse's
  cookies.
- **Review** (⌘⇧D): This turn, Uncommitted or Branch, as a file tree with
  unified or split diffs. The gutter's `+` adds a note; **Add to message** drafts
  `path:line: note` into the composer.
- **Tasks** lists the tools and subagents running in this turn and the other
  running chats; **Context** is this chat's memory, roots and handoff.

**Branch bar and pull requests.** One bar per root with changes
(`ashlr-hub  v310-foundation  +35,079 −1,074  [Create PR ▾]`). Its button
follows the repository's state: Commit, Push, Create PR, Merge (only when
checks are green and the branch is mergeable) or View PR. A commit is refused
while a turn is running in that repository, so you never commit half an edit.
**Isolate in worktree** in the new-chat dialog creates
`~/.ashlr-worktrees/<repo>/<name>` on the branch `verse/<name>`.

---

## Seats

A seat is one place a turn can run: an **engine** plus the **account** (or local
model) it is pinned to. Sessions are seat-bound — changing the seat on an
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

Autonomy stays dormant until you run the one-time setup:

```sh
ashlr authority setup --dry-run   # print every step and what it would do
ashlr authority setup             # do them, pausing only where you must act
ashlr authority status            # grant, switch, Stop, rollout stage, ledger, custody
```

`setup` does every step it can and stops only for what no agent may do: the
`sudo` install of the custody helper, Touch ID (key creation and the first
grant), the two GitHub browser clicks for the `ashlr-fleet` App, `claude
setup-token`, and confirming the archive of the old `~/.ashlr/activation/`. It
prints exactly what it did. Afterwards the only recurring step is one Touch ID
per 30-day grant, or after an authority deploy.

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

The Leader is the fleet's planning agent. It reads deterministic digests (fleet
history, the ledger, seat headroom, model ROI, reasoning insights and its own
hit-rate), never raw reasoning, and writes a memo: the bottleneck, one move with
an expected result and a date, goals, standards, and questions for you. It runs
daily and after notable events, at most three times a day, on Grok or a local
model; Claude only for a weekly deep run that fits inside your reserve, and never
Codex. With no standing grant it runs on free local models or not at all.
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

### Learning, reasoning data and experiments

Reasoning from every chat and fleet run is stored as data, scrubbed of secrets
and home paths, local-only and private (0600): text for 30 days, derived
features for 180. It is never replayed into a prompt. Deterministic extractors
turn it into insights (repeated failures, loops, verification gaps, wins),
which feed Mind and the Leader. Harness changes (prompts, effort, sampling,
routing weights) are tested as paired experiments with a confidence interval
against held-out tasks, adopted only through the gate, and rolled back
automatically if a 48-hour canary falls below baseline.

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
  seats load no MCP servers (`--strict-mcp-config`); the page says so.

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
| ⌘N | New chat |
| ⌘, / ⌘/ | Settings / keyboard shortcuts |
| ⌘[ / ⌘] | Back / forward through surfaces and chats |
| ⌃⇥ / ⌃⇧⇥ | Next / previous recent chat |
| ⌘⇧\ | Show or hide rail labels |

In Chat:

| Keys | Action |
|---|---|
| ⌘\ | Show or hide the dock |
| ⌃` / ⌃⇧` | Terminal / new terminal tab |
| ⌘⇧B / ⌘⇧D | Preview / Review changes |
| ⌘B / ⌘F | Chat list / find in chat |
| ⌥↑ / ⌥↓ | Previous / next turn |
| ⌘⇧M / ⌘⇧I / ⌘⇧E | Permission mode / model / effort |
| ⌘U | Attach files |
| ↩ | Send (queues while a turn runs, up to 3) |
| ⇧↩ | Newline |
| ⌘⇧↩ | Stop the running turn and send |
| Esc | Stop the running turn (only from an empty composer with no overlay open) |

In the Needs-you drawer: `J`/`K` move, ↩ opens, `A` approve, `R` reject,
`V` veto, `E` done, `H`/`L` switch splits. On a focused chart card: `T` shows it
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
  not surface per-tool approval prompts yet ("Ask" mode arrives in 3.11); use
  the CLI directly when you want to approve each tool call.
- The Terminal pane needs the desktop app (Bun's pseudo-terminal). A browser
  tab against `ashlr verse` under Node gets **Open in Terminal.app** instead.
- Preview frames loopback dev servers only. Anything else opens in your
  browser. Side chats, split sessions, hunk staging and multi-seat compare are
  deferred to 3.11.
- No virtualized transcript. Very long sessions render every event — continue in
  a fresh chat when the handoff banner appears anyway.
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
- Autonomy is dormant until `ashlr authority setup` has installed the custody
  helper, compiled your key into the trust roots and signed a grant. Without a
  grant, the switch cannot go above what the config-level daemon allows, and
  nothing merges.
- Claude as a fleet **producer** waits for a credential proxy (3.11). In 3.10
  Claude only judges and runs the Leader, with no tools.
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
