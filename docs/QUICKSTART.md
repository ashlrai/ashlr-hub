# Quickstart — zero to running fleet in 5 steps

Requires **Node.js 22+**. Works on macOS, Linux, and Windows.

---

## Step 1 — Install

```sh
npm install -g @ashlr/hub
```

Verify:

```sh
ashlr --version
```

> Alternatively, download the desktop app (no Node.js required) from
> [GitHub Releases](https://github.com/ashlrai/ashlr-hub/releases) — it bundles
> the binary and runs setup automatically on first launch.

---

## Step 2 — Run the setup wizard

```sh
ashlr setup
```

The wizard runs these steps in order and reports the status of each:

| Step | What it does |
|------|-------------|
| `config` | Writes `~/.ashlr/config.json` with defaults |
| `models` | Detects locally running model servers (Ollama, LM Studio) |
| `editors` | Detects Claude Code, Cursor, Windsurf |
| `symlink` | Ensures `ashlr` is on PATH |
| `genome` | Creates `~/.ashlr/genome/` for memory storage |
| `phantom` | Checks Phantom Secrets status (optional) |
| `doctor` | Runs final readiness checks |
| `daemon-service` | Installs the daemon as an OS service (launchd/systemd) |
| `engines` | Checks each configured backend and prints auth guidance |
| `enroll` | Auto-discovers repos under configured roots and offers enrollment |

Steps marked `!` need manual follow-up (shown in the summary). Steps marked `✓` are complete. The wizard is idempotent — safe to re-run at any time.

**Non-interactive mode** (CI, scripts, desktop app first-launch):

```sh
ashlr setup --yes
```

---

## Step 3 — Enroll repos

The daemon only works repos you have explicitly enrolled. Default enrollment is empty — nothing is scanned until you add a repo.

```sh
ashlr enroll add ~/path/to/my-project
ashlr enroll list                        # confirm what is enrolled
```

To remove a repo:

```sh
ashlr enroll remove ~/path/to/my-project
```

---

## Step 4 — Authenticate engines

`ashlr setup` prints auth guidance for each backend. Here are the common ones:

| Engine | How to authenticate |
|--------|-------------------|
| Claude (Anthropic) | `export ANTHROPIC_API_KEY=sk-ant-...` (or use Phantom: `phantom add ANTHROPIC_API_KEY`) |
| Codex (OpenAI) | `export OPENAI_API_KEY=sk-...` |
| Local (Ollama) | Start Ollama (`ollama serve`) — no key needed |
| Local (LM Studio) | Start LM Studio server on default port — no key needed |
| NIMs | `export NVIDIA_NIM_API_KEY=...` (or use Phantom: `phantom add NVIDIA_NIM_API_KEY`) |

Check engine readiness at any time:

```sh
ashlr fleet doctor
```

This prints a table of every configured backend — installed, authenticated, ready — with a fix hint for anything that needs attention.

---

## Step 5 — Open Mission Control

```sh
ashlr serve
```

Opens the web dashboard at **http://127.0.0.1:7777** (bound to localhost only — never externally reachable).

```sh
ashlr serve --open    # also opens the browser automatically
```

The dashboard shows:
- **Fleet status** — daemon running/idle, today's spend, queue depth, pending proposals
- **Runs & Swarms** — history of all agent runs with per-task detail
- **Inbox** — pending proposals waiting for approval
- **Pulse** — rolling activity analytics (1d/7d/30d)
- **Genome** — memory entries built from completed runs

---

## Starting the fleet

Once repos are enrolled and at least one engine is ready:

```sh
# Dry run — preview what would be worked, no proposals created, $0 spent
ashlr daemon start --once --dry-run

# One real tick — deposits proposals into the inbox
ashlr daemon start --once

# Continuous loop (runs until stopped or daily budget is hit)
ashlr daemon start

# Check status
ashlr daemon status

# Stop
ashlr daemon stop
```

Review proposals before anything touches a branch:

```sh
ashlr inbox           # list pending proposals
ashlr inbox show <id> # inspect a proposal
```

**Proposals are never applied automatically.** Nothing reaches a real branch until you approve it in the inbox.

---

## Kill switch

If you need to halt all autonomous activity immediately:

```sh
ashlr enroll kill on    # sets ~/.ashlr/KILL — all mutating ops refuse immediately
ashlr enroll kill off   # clears the kill switch
```

Or via the fleet control plane:

```sh
ashlr fleet pause    # same effect
ashlr fleet resume
```

---

## What next?

| Task | Command |
|------|---------|
| Ad-hoc agent run against a spec | `ashlr run <specId>` |
| Multi-agent swarm | `ashlr swarm <specId>` |
| Interactive TUI | `ashlr tui` |
| Doctor / health check | `ashlr doctor` |
| Fleet control plane | `ashlr fleet status` · `ashlr fleet watch` |
| Update ashlr | `ashlr update` |

Full command reference: `ashlr help` or the main [README](../README.md).
