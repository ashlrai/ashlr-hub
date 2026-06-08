# ashlr-hub

**Command center for the Ashlr ecosystem.** Indexes everything on Mason's Desktop — ~69 git repos across categorized folders — and exposes it through a fast CLI (`ashlr`) and a Raycast extension. Both read from the same `~/.ashlr/index.json`. M2 adds identity awareness (Phantom secrets), local-model discovery (LM Studio + Ollama), and a one-glance health check.

---

## Overview

`ashlr-hub` scans your Desktop's `github/<category>/<repo>` tree and document folders, classifies each entry, attaches git status, and writes a persistent index. From there you can fuzzy-jump into any project, tidy loose files, check repo health, run onboarding, or browse everything from Raycast.

---

## Install

### Prerequisites

- Node.js v22+
- `~/.local/bin` on your `PATH` (already configured)

### One-command install

```sh
./install.sh
```

That script:
1. Runs `npm run build` (compiles TypeScript to `dist/`)
2. Symlinks `bin/ashlr` → `~/.local/bin/ashlr`
3. Verifies `ashlr help` runs cleanly

The script is idempotent — safe to re-run after pulling updates.

### Manual install

```sh
npm run build
ln -sf "$(pwd)/bin/ashlr" ~/.local/bin/ashlr
chmod +x bin/ashlr
ashlr help
```

---

## CLI reference

All commands are zero-dependency (Node builtins only). The binary is `ashlr`.

### `ashlr init [--yes]`

Idempotent onboarding. Run once after install (or any time) to ensure your config is valid, detect local models, and optionally enable Phantom secrets.

- Creates `~/.ashlr/config.json` with sensible defaults if it does not exist.
- Detects LM Studio (`:1234`) and Ollama (`:11434`) and probes for available models.
- Checks whether `phantom` is installed; when present, enables the integration automatically (`phantom.enabled: true`). It does **not** prompt for phantom.
- Prompts for the editor only when run interactively; `--yes` / non-TTY auto-detects it.
- `--yes` (or non-TTY stdin) — accepts all defaults silently, never prompts. Safe to run in CI or scripts.
- Exits non-zero when the resulting health check has any failures.

```sh
ashlr init          # interactive onboarding
ashlr init --yes    # non-interactive; accept all defaults
ashlr init --json   # machine-readable InitResult JSON
```

Example output (`ashlr init --yes`, first run, Ollama up / LM Studio down):

```
  ashlr init

  Config not found. Creating ~/.ashlr/config.json
  ✓ phantom v0.6.0 not initialized
     run: phantom init to initialize a vault

  Probing local model providers…
  ○ lmstudio   down http://localhost:1234/v1/models (fetch failed)
  ✓ ollama up http://localhost:11434/api/tags — llama3, qwen2.5, deepseek-r1 +6 more
  active provider: ollama

  ✓ Created ~/.ashlr/config.json

  Health checks:
  ! Index file present                      ~/.ashlr/index.json not found — run ashlr index to build it
     fix: ashlr index
  ! Phantom secrets CLI                     phantom v0.6.0 installed but vault not initialized
     fix: phantom init
  ! Local provider: lmstudio                http://localhost:1234/v1/models is down — fetch failed
     fix: Start LM Studio and enable the local server

  ! init complete  7 pass  3 warn
```

---

### `ashlr doctor`

One-glance health check. Probes the runtime (Node, git, PATH, install), config, index, Phantom integration, the ashlr MCP plugin, and every provider endpoint; prints a structured report grouped into Failures / Warnings / Passing and exits non-zero (1) if any check fails.

```sh
ashlr doctor          # human-readable, color when TTY
ashlr doctor --json   # full DoctorReport as JSON
```

Checks use glyphs `✓` (pass) `!` (warn) `✗` (fail), each with an optional `fix:` hint. The summary line is space-separated (`8 pass  3 warn`) and omits zero counts.

Example output (Ollama up / LM Studio down, vault not yet initialized):

```
  ashlr doctor  — 6/8/2026, 7:17:50 PM

  Warnings
  ! Index file present                      ~/.ashlr/index.json not found — run ashlr index to build it
     fix: ashlr index
  ! Phantom secrets CLI                     phantom v0.6.0 installed but vault not initialized
     fix: phantom init
  ! ashlr MCP plugin registered             ashlr MCP server not found in ~/.claude/settings.json, ~/.mcp.json, or ~/.claude.json
     fix: Add the ashlr MCP server via: ashlr init  or install the ashlr Claude Code plugin
  ! Local provider: lmstudio                http://localhost:1234/v1/models is down — fetch failed
     fix: Start LM Studio and enable the local server

  Passing
  ✓ Node.js version                         v22.22.3 (>= 18 required)
  ✓ git installed                           git version 2.49.0
  ✓ ~/.local/bin on PATH                    /Users/you/.local/bin is on PATH
  ✓ ashlr installed                         /Users/you/.local/bin/ashlr
  ✓ Config file exists                      ~/.ashlr/config.json is valid JSON
  ✓ Index file freshness                    Index is 0.0 days old
  ✓ Local provider: ollama                  http://localhost:11434/api/tags is up (9 models)
  ✓ Active provider                         Active provider: ollama (local)

  8 pass  3 warn
```

> The `Active provider` check labels the resolved provider as `(local)` or, when only a cloud key (e.g. `ANTHROPIC_API_KEY`) is available, `(cloud fallback)`.

Exit code 0 when all checks pass or warn; non-zero when any check is `fail`.

---

### `ashlr index [--refresh]`

Build and persist the Desktop index to `~/.ashlr/index.json`.

- On first run (or when the index file is absent) it always rebuilds.
- `--refresh` forces a full rescan even if a cached index exists.

```sh
ashlr index           # build index if missing
ashlr index --refresh # force full rescan
```

---

### `ashlr go [query] [--open | --cd]`

Fuzzy-jump to a project. Without a query, presents an interactive picker over all indexed items. With a query, filters the list first.

- `--open` — opens the selected item in your configured editor (default: Cursor)
- `--cd` — prints the absolute path (pipe into `cd` via shell function)

```sh
ashlr go                        # interactive picker, all items
ashlr go artist-encyclopedia    # filter then pick
ashlr go precious-grove --open  # open in Cursor
ashlr go ashlrcode --cd         # print path for cd
```

Shell function tip — add to your `.zshrc`:

```sh
j() { local p; p=$(ashlr go "$1" --cd) && cd "$p"; }
```

---

### `ashlr status`

Summarize the current index: item counts by kind and category, dirty repos, and stale repos (not committed in `staleDays` days).

```sh
ashlr status
```

Example output:

```
Index: 71 items  (built 2 hours ago)
  repo        57
  doc-folder   6
  symlink      5
  other        3

Categories:
  dev-tools              12
  side-projects          18
  professional-tools      7
  artist-encyclopedias    4
  client-engagements      6
  forks                   5
  ashlrai                 5

Dirty repos:   3
Stale repos:   8  (> 30 days)
```

---

### `ashlr ls [category]`

List all indexed items. Optionally filter by category name.

```sh
ashlr ls                   # all items
ashlr ls dev-tools         # only dev-tools repos
ashlr ls side-projects
```

---

### `ashlr open <query>`

Resolve `query` to an indexed item (name match) and open it in your configured editor.

```sh
ashlr open ashlr-hub
ashlr open precious-grove
```

If the query matches multiple items, an interactive picker is shown.

---

### `ashlr tidy [--apply]`

Plan (or apply) moves of loose top-level Desktop files according to the tidy rules in `~/.ashlr/config.json`.

- By default, prints a dry-run plan — no files are moved.
- `--apply` executes the moves (mkdir -p destination, then rename).
- Keepers (see config) are never touched. Symlinks and git repos are never moved.

```sh
ashlr tidy           # dry-run: show what would move
ashlr tidy --apply   # execute the plan
```

---

### `ashlr config [get | set <key> <value> | path]`

Read or write `~/.ashlr/config.json`.

```sh
ashlr config path               # print path to config file
ashlr config get                # pretty-print full config
ashlr config get editor         # print one key
ashlr config set editor vscode  # update a key
ashlr config set staleDays 14
```

---

### `ashlr help`

Print usage summary.

```sh
ashlr help
```

---

## Config reference — `~/.ashlr/config.json`

Created automatically on first run with sensible defaults. Edit directly or via `ashlr config set`.

```jsonc
{
  "version": 1,

  // Roots to scan (depth ~3)
  "roots": ["/Users/masonwyatt/Desktop"],

  // Default editor for deep links
  // "cursor" => cursor://file/<path>
  // "vscode"  => vscode://file/<path>
  "editor": "cursor",

  // Repos with no commit in this many days are flagged "stale" in `ashlr status`
  "staleDays": 30,

  // Maps category folder names to display labels
  "categories": {
    "dev-tools": "Dev Tools",
    "side-projects": "Side Projects",
    "professional-tools": "Professional Tools",
    "artist-encyclopedias": "Artist Encyclopedias",
    "client-engagements": "Client Engagements",
    "forks": "Forks",
    "ashlrai": "AshlrAI"
  },

  // Rules for `ashlr tidy` — evaluated in order; first match wins
  // matchType: "glob" | "regex" | "ext"
  "tidyRules": [
    { "match": "*.pdf",  "matchType": "ext",  "dest": "~/Desktop/Business/",  "description": "PDF documents" },
    { "match": "*.png",  "matchType": "ext",  "dest": "~/Desktop/Assets/",    "description": "Images" },
    { "match": "*.jpg",  "matchType": "ext",  "dest": "~/Desktop/Assets/",    "description": "Images" },
    { "match": "*.zip",  "matchType": "ext",  "dest": "~/Desktop/archive/",   "description": "Archives" }
  ],

  // Paths (names or absolute) that tidy will NEVER move
  "keepers": [
    "Rent Application.pdf",
    "ASHLRAI",
    "rde-other",
    "Keys & Recovery",
    "github",
    "Evero Notes",
    "OneDrive - James Madison University",
    "tts agents"
  ],

  // M2: Phantom secrets integration
  // Read-only — only secret names/status are ever surfaced, never values.
  // Set enabled: true via `ashlr init` or manually; `ashlr doctor` reports vault status.
  "phantom": {
    "enabled": true
  },

  // M2: AI model config — local-first provider chain
  // providerChain: ordered list; first reachable provider wins (lmstudio -> ollama -> anthropic).
  // Endpoints probed at runtime by `ashlr doctor` and `ashlr init`.
  "models": {
    "lmstudio": "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF",
    "ollama": "llama3",
    "providerChain": ["lmstudio", "ollama", "anthropic"]
  },

  // Telemetry (optional)
  "telemetry": {
    "pulse": ""
  },

  // Tool paths resolved at init time
  "tools": {
    "entire": "/usr/local/bin/entire",
    "aw": "/usr/local/bin/aw",
    "claude": "/usr/local/bin/claude",
    "pulse-agent": "/usr/local/bin/pulse-agent"
  }
}
```

Config is validated against `schema/config.schema.json` (JSON Schema draft-07).

---

## M2: Identity & model awareness

M2 turns `~/.ashlr/config.json` into the real unified source of truth and adds two new surface areas: **Phantom secrets** and the **local-model/provider registry**.

### Provider registry — local-first failover

`ashlr` probes local endpoints in `providerChain` order and resolves the first one that is up as the active provider. Probes never throw — every endpoint returns a typed result regardless of whether it is reachable.

| Provider  | Default endpoint                   | Model list source             |
|-----------|------------------------------------|-------------------------------|
| lmstudio  | `http://localhost:1234/v1/models`  | `data[].id` (OpenAI-compat)   |
| ollama    | `http://localhost:11434/api/tags`  | `models[].name`               |
| anthropic | cloud fallback (no probe)          | —                             |

`ashlr init` discovers available providers and writes discovered model names into config. `ashlr doctor` probes all endpoints and reports each one as `pass` / `warn` / `fail`. If neither local provider is reachable, the chain falls through to `anthropic`.

### Phantom secrets integration

`ashlr` integrates with the [`phantom`](https://github.com/nicholasgasior/phantom) secrets CLI for identity management. The integration is **strictly read-only** — secret values are never read, captured, or printed. Only names and vault status are surfaced.

- `ashlr init` detects `phantom` on PATH and enables the integration automatically (sets `phantom.enabled: true`); it does not prompt.
- `ashlr doctor` reports: installed, version, initialized, and the count/names of secrets in the vault.
- `phantom.enabled: true` in config activates doctor checks for the vault.
- Phantom CLI flags are verified at runtime via `phantom --help`; the integration degrades gracefully if a subcommand is unavailable.

---

## Raycast extension

The Raycast extension reads `~/.ashlr/index.json` directly — it does not re-scan. Run `ashlr index` at least once first.

### Import steps

```sh
# 1. Install extension dependencies
cd src/raycast
npm ci

# 2. Start the dev server (Raycast hot-reload)
npm run dev
```

Then in Raycast:

1. Open Raycast preferences → Extensions → click **+** → **Import Extension**
2. Select the `src/raycast` folder
3. The extension will appear as **"Ashlr Hub"**

### Available Raycast commands

| Command | Description |
|---|---|
| Search Projects | List view over all indexed items; filter by name or category |

Actions available on each item:

- **Open in Editor** — opens in Cursor (or VSCode if configured)
- **Reveal in Finder** — opens the folder in Finder
- **Copy Path** — copies the absolute path to clipboard

The extension re-reads `~/.ashlr/index.json` on each activation. Refresh the index with `ashlr index --refresh` from the terminal when you add new repos.

---

## Project structure

```
ashlr-hub/
├── bin/ashlr            # CLI entrypoint (ESM wrapper)
├── src/
│   ├── core/
│   │   ├── types.ts         # Canonical types (never redefine elsewhere)
│   │   ├── config.ts        # ~/.ashlr/ management
│   │   ├── git.ts           # Git introspection (child_process, no deps)
│   │   ├── classify.ts      # Category, language, kind, description
│   │   ├── index-engine.ts  # Desktop scanner + index persistence
│   │   ├── tidy.ts          # Tidy planner + applier
│   │   ├── providers.ts     # M2: local-model endpoint probing + registry
│   │   ├── phantom.ts       # M2: Phantom secrets status (read-only)
│   │   └── doctor.ts        # M2: one-glance health check aggregator
│   ├── cli/
│   │   ├── index.ts     # argv dispatch (index/go/status/ls/open/tidy/config/doctor/init/help)
│   │   ├── open.ts      # Editor / Finder / Terminal launchers
│   │   └── picker.ts    # fzf (if present) or readline picker
│   └── raycast/         # Raycast extension (own package.json)
│       └── src/
│           ├── lib/
│           │   ├── index.ts   # loadIndex()
│           │   └── open.ts    # openInEditor(), openInFinder()
│           └── commands/
├── schema/
│   └── config.schema.json
├── test/
├── dist/                # compiled output (git-ignored)
├── CONTRACT.md          # binding interface spec
├── CONTRACT-M2.md       # M2 extension to the contract
├── install.sh           # build + symlink installer
└── package.json
```

---

## Development

```sh
npm run build      # tsc → dist/
npm run dev        # tsx (no compile step; for quick iteration)
npm test           # vitest
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

Zero runtime dependencies in `core/` and `cli/` — Node builtins only.

---

## Milestone scope

### M1 — shipped, GREEN

- [x] Desktop index (repos, doc folders, assets, symlinks)
- [x] CLI: `index`, `go`, `status`, `ls`, `open`, `tidy`, `config`, `help`
- [x] Raycast extension (read-only list + open actions)
- [x] 108 tests passing

### M2 — identity & model awareness

- [x] `ashlr init` — idempotent onboarding, NON-TTY safe (`--yes`)
- [x] `ashlr doctor` — one-glance health check with pass/warn/fail + fix hints
- [x] Provider registry — LM Studio + Ollama probing, local-first failover chain
- [x] Phantom secrets integration — read-only, names/status only, never values
- [x] `phantom` + `models` config fields unified in `~/.ashlr/config.json`

### Future

- [ ] Phase 3: AI-powered semantic search over the index
- [ ] Phase 4: Cross-project cost + telemetry dashboard (Pulse integration)
- [ ] Phase 5: Automated tidy + refactor suggestions
