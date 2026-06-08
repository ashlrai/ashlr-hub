# ashlr-hub

**Phase 1 of the Ashlr ecosystem hub.** A command center that indexes everything on Mason's Desktop — ~69 git repos across categorized folders — and exposes it through a fast CLI (`ashlr`) and a Raycast extension. Both read from the same `~/.ashlr/index.json`.

---

## Overview

`ashlr-hub` scans your Desktop's `github/<category>/<repo>` tree and document folders, classifies each entry, attaches git status, and writes a persistent index. From there you can fuzzy-jump into any project, tidy loose files, check repo health, or browse everything from Raycast.

This is **Phase 1**: local index + CLI + Raycast. Later phases add AI-powered search, cost dashboards, and cross-project refactoring.

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
    { "match": "*.pdf",  "matchType": "ext",  "dest": "~/Desktop/Business/",     "description": "PDF documents" },
    { "match": "*.png",  "matchType": "ext",  "dest": "~/Desktop/Assets/",        "description": "Images" },
    { "match": "*.jpg",  "matchType": "ext",  "dest": "~/Desktop/Assets/",        "description": "Images" },
    { "match": "*.zip",  "matchType": "ext",  "dest": "~/Desktop/archive/",       "description": "Archives" }
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

  // AI model config (used by future phases)
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
│   │   ├── types.ts     # Canonical types (never redefine elsewhere)
│   │   ├── config.ts    # ~/.ashlr/ management
│   │   ├── git.ts       # Git introspection (child_process, no deps)
│   │   ├── classify.ts  # Category, language, kind, description
│   │   ├── index-engine.ts  # Desktop scanner + index persistence
│   │   └── tidy.ts      # Tidy planner + applier
│   ├── cli/
│   │   ├── index.ts     # argv dispatch
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

## Phase 1 scope

This repo is **Phase 1** of the Ashlr ecosystem hub:

- [x] Desktop index (repos, doc folders, assets, symlinks)
- [x] CLI: index, go, status, ls, open, tidy, config, help
- [x] Raycast extension (read-only list + open actions)
- [ ] Phase 2: AI-powered semantic search over the index
- [ ] Phase 3: Cross-project cost + telemetry dashboard (Pulse integration)
- [ ] Phase 4: Automated tidy + refactor suggestions
