# Quickstart — zero to running fleet in 5 steps

Requires **Node.js 22.15+**. Works on macOS, Linux, and Windows.

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
> the binary and runs setup automatically on first launch. Desktop installers
> are currently published only for macOS and Windows. Linux remains supported
> through npm/CLI and the web dashboard; Linux desktop artifacts are quarantined
> for `GHSA-wrw7-89jp-8q8g` / `RUSTSEC-2024-0429`.
> Enforcement covers fresh source builds, the default Tauri configuration, and
> the official release workflow. A hostile `--config` combined with an
> already-built/staged executable is outside source-build enforcement and must
> never be treated as admitted release output.

---

## Step 2 — Initialize local configuration

```sh
ashlr init
```

`ashlr init` creates local configuration and reports readiness without creating
a resident OS service. In the current release, `ashlr setup` refuses before
reading or changing setup state because resident install/reinstall/repair/restart
authority is withheld. Use `ashlr daemon start --once` for admitted work.

Initialization reports these steps:

| Step | What it does |
|------|-------------|
| `config` | Writes `~/.ashlr/config.json` with defaults |
| `models` | Detects locally running model servers (Ollama, LM Studio) |
| `editors` | Detects Claude Code, Cursor, Windsurf |
| `symlink` | Ensures `ashlr` is on PATH |
| `genome` | Creates `~/.ashlr/genome/` for memory storage |
| `phantom` | Checks Phantom Secrets status (optional) |
| `doctor` | Runs final readiness checks |
| `engines` | Checks each configured backend and prints auth guidance |
| `enroll` | Auto-discovers repos under configured roots and offers enrollment |

Steps marked `!` need manual follow-up (shown in the summary). Steps marked `✓`
are complete. Initialization is idempotent and safe to re-run.

**Non-interactive mode** (CI, scripts, desktop app first-launch):

```sh
ashlr init --yes
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

Copy the read token printed at startup into the **Read token** control. All
proprietary JSON reads and the live event stream are authenticated even on
loopback. The raw token stays in the current tab's `sessionStorage`; the server
mints a 15-minute, read-only, HttpOnly, SameSite=Strict cookie for EventSource.
Since cookies are host-scoped rather than port-scoped, the ticket is also bound
to a browser-generated 256-bit client proof kept in origin-scoped
`sessionStorage`. EventSource places only that proof—not the read or mutation
token—in its same-origin query. The proof has no authority without the matching
signed HttpOnly ticket, and responses set `Referrer-Policy: no-referrer`.
Neither the cookie nor its proof can authorize a mutation. Restarting the
server rotates the read token and invalidates every prior read session.
The 15-minute expiry applies only to the cookie ticket. The per-process raw
read token remains valid until server restart, and the current tab renews its
ticket while that token remains in `sessionStorage`.

For a headless read, supply the startup token directly:

```sh
curl -H "X-Ashlr-Token: $ASHLR_DASHBOARD_READ_TOKEN" \
  http://127.0.0.1:7777/api/fleet
```

Only static assets and `GET /api/health` with the bounded `{ "ok": true }`
projection are public. Because the server intentionally uses plain HTTP on
loopback, the cookie is not marked `Secure`; Ashlr does not trust
`X-Forwarded-Proto` and has no reverse-proxy/TLS mode.

`--allow-dispatch` prints a separate mutation token. The read token and read
cookie are never accepted by mutation routes. The browser requests the
mutation token anew for every enabled action, uses it only for that request,
and does not retain it in JavaScript state; ordinary dashboard reading never
grants mutation authority.

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

# Foreground continuous loop (runs until stopped or daily budget is hit)
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

Automatic merge is disabled by default. When explicitly enabled, only proposals
that satisfy the configured evidence, scope, provenance, and remote-PR gates may
merge; all others remain pending for inbox review.

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
