# Quickstart — run and inspect Ashlr Universe

Start with a bounded local experiment, then commission real workers separately.
The source implementation and the package currently published to npm can differ;
check the [release record](https://github.com/ashlrai/ashlr-hub/blob/master/docs/RELEASING.md)
before assuming a globally installed `ashlr` includes these commands.

| What you want to do | Supported path |
|--------------------|----------------|
| Run reproducible code experiments without model credentials | [Current Universe kernel](#run-the-current-universe-kernel) |
| Inspect one experiment store and its evidence graph | [Scoped Universe console](ASHLR-UNIVERSE.md#observe-one-universe-store) |
| Run explicitly configured Codex, Claude Code or local workers | [Resource Pool commissioning](RESOURCE-POOLS.md#commission-native-accounts-and-local-capacity) |
| View worker assignments, capacity and a controllable foreground queue | [Resource operations console](RESOURCE-POOLS.md#operate-the-resource-console) |
| Run independently of a mutable source checkout | [Pinned local runtime](ASHLR-UNIVERSE.md#install-a-pinned-local-runtime) |
| Inspect existing general Hub configuration and proposals | [General Hub setup](#general-hub-and-legacy-fleet-setup) |

## Run the current Universe kernel

Prerequisites: a trusted source checkout, Git and Node.js 22.15+. Current Universe
experiment execution additionally requires macOS `sandbox-exec`; Linux isolation
and Windows execution are not yet supported for that path. Building the CLI and
reading supported console evidence are separate from executing experiments.

1. In the repository root, install the locked dependencies and build the CLI and
   web assets. Installation and build execute trusted repository scripts locally:

   ```sh
   npm ci
   npm run build
   node bin/ashlr universe help
   ```

2. Choose a new absolute private experiment root, outside the source checkout,
   with an existing physical parent. Run the demonstration only in that selected
   root; it creates a seed repository and performs bounded local code execution:

   ```sh
   node bin/ashlr universe demo --root /absolute/private/experiments --json
   ```

   Expect tested code variants, rejected candidates and later-generation parent
   references. This deterministic example proves the experiment mechanism, not
   model capability or accepted product value. No provider account is required.

3. Inspect the same root without starting another experiment:

   ```sh
   node bin/ashlr universe status --root /absolute/private/experiments --json
   node bin/ashlr universe archive --root /absolute/private/experiments --json
   ```

4. Start its foreground, read-only loopback console:

   ```sh
   node bin/ashlr universe console --root /absolute/private/experiments --json
   ```

   Open the printed URL, enter its private read token and inspect campaigns,
   trials and the evidence graph. Keep the terminal running; Ctrl-C stops this
   console. Never share its startup token or put it in a URL. If records appear
   missing, compare the console's displayed root with the command above before
   creating more state. See the [operator guide](ASHLR-UNIVERSE.md) for failure
   recovery and campaign controls.

The demonstration can be replaced with explicitly configured local-model
generation or the opt-in [resource generation bridge](ASHLR-UNIVERSE.md#generate-candidates-through-an-enrolled-resource-pool).
The bridge uses enrolled native or local workers through Resource Pools; it needs
an explicit private runtime binding, fresh observations and resource limits
before dispatch. The fleet map does not create accounts or evidence. Follow the
commissioning guide above before authorizing generation.

## General Hub and legacy fleet setup

The remaining steps configure the general dashboard and legacy enrolled-repo
workflows. They are not prerequisites for a scoped Universe or resource console,
and do not activate resident autonomous work. The package runtime requires Node
22.15+; platform support depends on the command being used.

---

## Step 1 — Install

```sh
npm install -g @ashlr/hub
```

Verify:

```sh
ashlr --version
```

> **Desktop distribution — checked 2026-09-07 UTC:** No public desktop release or installer is currently available
> from this repository. Existing macOS and Windows installer assets are draft-only;
> their presence is not a published or accepted desktop release. Recheck the
> [GitHub releases](https://github.com/ashlrai/ashlr-hub/releases) before installation.
> Use the [release record](https://github.com/ashlrai/ashlr-hub/blob/master/docs/RELEASING.md)
> to distinguish published npm/desktop artifacts from current source. Installing
> one artifact does not commission the other; the CLI includes a web dashboard.
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

| Engine path | Authentication boundary |
|-------------|-------------------------|
| Native Codex or Claude Code subscription | Use the owner's authenticated native CLI and an explicit binding; see [account commissioning](RESOURCE-POOLS.md#commission-native-accounts-and-local-capacity) for account separation and verification |
| Usage-billed API backend | Separate provider credentials and billing authority; an API key is not evidence of subscription capacity |
| Local Ollama or LM Studio | An explicitly selected loopback model server with measured health and capability; no provider key is implied |

Do not add API keys as a fallback for unavailable subscription quota. Do not copy
credential files to manufacture another worker identity. Native login, resource
enrollment, observed capacity and completed work are distinct checks.

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

Serves the web dashboard at **http://127.0.0.1:7777**, bound to loopback. Do not
expose it through a tunnel or reverse proxy; that is not a supported remote
authentication deployment.

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
