# Quickstart — zero to verified local observation in 5 steps

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

> No public desktop release or installer is currently available. Install through
> npm/CLI as shown above; the web dashboard is included in that runtime.
> Linux remains supported through npm/CLI and the web dashboard.
> Linux desktop artifacts are quarantined for `GHSA-wrw7-89jp-8q8g` /
> `RUSTSEC-2024-0429`.
> Enforcement covers fresh source builds, the default Tauri configuration, and
> the official release workflow. Repository workflow 301689703 must remain
> externally `disabled_manually`; its configured output is draft-only. Ruleset
> 20660876 protects `refs/tags/desktop-v*` with a Mason-only bypass, but tag
> protection is necessary, not sufficient: a tag can select a historical commit
> whose workflow predates this quarantine.
> A hostile `--config` combined with an
> already-built/staged executable is outside source-build enforcement and must
> never be treated as admitted release output.

---

## Step 2 — Initialize local configuration

```sh
ashlr init
```

`ashlr init` creates local configuration and reports readiness without creating
a resident OS service. In the current release, compiled daemon and conductor
trust roots are empty, so live non-dry execution is dormant. `ashlr setup`
refuses before reading or changing setup state because resident
install/reinstall/repair/restart authority is withheld. Use
`ashlr daemon start --once --dry-run`, status, and the local console for
admitted observation.

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

`ashlr setup` does not reach backend detection or auth guidance in this release;
it refuses before config or wizard work while resident service authority is
dormant. Authenticate an owner-invoked engine directly, then use the read-only
doctor command below. Common engine guidance:

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

The new console is at `/next/`; `/` remains the separately labelled legacy
dashboard. Copy the read token printed at startup into `/next/`'s **Read token**
control. All proprietary JSON reads and the live event stream are authenticated
even on loopback. The new console discards the raw read token immediately after
the exchange; the server mints a 15-minute, read-only, HttpOnly,
SameSite=Strict cookie for EventSource.
Since cookies are host-scoped rather than port-scoped, the ticket is also bound
to a browser-generated 256-bit client proof kept in origin-scoped
`sessionStorage`. The cookie plus proof survives a `/next/` reload until the
ticket expires. After expiry, re-enter the raw read token; `/next/` cannot renew
silently because it does not retain that token. EventSource places only that proof—not the read or mutation
token—in its same-origin query. The proof has no authority without the matching
signed HttpOnly ticket, and responses set `Referrer-Policy: no-referrer`.
Neither the cookie nor its proof can authorize a mutation. Restarting the
server rotates the read token and invalidates every prior read session.
The per-process raw read token remains valid until server restart, but `/next/`
does not store it. The legacy dashboard at `/` separately retains its raw read
token in tab `sessionStorage` to renew its cookie.

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
cookie are never accepted by mutation routes. `/next/` holds the mutation token
only in module memory for a 20-minute idle window; it never writes it to
`sessionStorage`, local storage, a cookie, or a URL, and **Lock** clears it
immediately. The legacy dashboard at `/` prompts independently per mutation
action. Ordinary dashboard reading never grants mutation authority.

The dashboard shows:

- **Fleet status** — daemon running/idle, today's spend, queue depth, pending proposals
- **Runs & Swarms** — history of all agent runs with per-task detail
- **Inbox** — pending proposals waiting for approval
- **Pulse** — rolling activity analytics (1d/7d/30d)
- **Genome** — memory entries built from completed runs

---

## Starting the fleet

Once repos are enrolled and at least one engine is ready, the current production
build still admits only observation because its compiled runtime trust roots
are empty:

```sh
# Dry run — preview what would be worked, no proposals created, $0 spent
ashlr daemon start --once --dry-run

# Live one-shot — currently refuses before dispatch or proposal creation
ashlr daemon start --once

# Foreground continuous loop — currently refuses before effects
ashlr daemon start

# Check status
ashlr daemon status

```

Review proposals before anything touches a branch:

```sh
ashlr inbox           # list pending proposals
ashlr inbox show <id> # inspect a proposal
```

Automatic merge is disabled by default. When explicitly enabled, only proposals
that satisfy the configured evidence, scope, provenance, and remote-PR gates may
merge; all others remain pending for inbox review.

Dry-run, `ashlr daemon status`, and the local console are the verified current
runtime paths. Test-only injected roots do not activate the shipped daemon,
conductor, or resident service.

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
| Interactive TUI | `ashlr tui` |
| Doctor / health check | `ashlr doctor` |
| Fleet status | `ashlr fleet status` |
| Dry-run one daemon tick | `ashlr daemon start --once --dry-run` |
| Local console | `ashlr serve` |

Full command reference: `ashlr help` or the main [README](../README.md).
