# Contributing to ashlr-hub

`ashlr-hub` is the local-first command center for the Ashlr dev-tool ecosystem —
a TypeScript CLI (`ashlr`) plus a Raycast extension that index your machine and
expose it through a single front door. This guide covers the dev environment,
conventions, and the contracts-first workflow the project is built on.

---

## Prerequisites

- **Node.js >= 22** (`engines.node` is `>=22`; CI and the build assume it)
- **git** on `PATH`
- `~/.local/bin` on your `PATH` if you want to install the CLI locally (macOS/Linux)
- Optional, only exercised by some commands at runtime: `phantom`, `ollama` /
  LM Studio, `gh`, `vercel`, `stack`. None are required to build or test.

The hub builds, tests, and runs natively on **macOS, Linux, and Windows**. The
suite is platform-agnostic (no symlink/`/`-separator/timezone assumptions leak
into assertions); CI runs on Linux, and a local pre-push hook (below) is the
guard for Windows-specific regressions.

The toolchain is intentionally lean: `typescript`, `tsx`, `vitest`, and
`eslint` / `typescript-eslint` are the only devDependencies.

---

## Setup

```sh
npm ci          # clean, lockfile-exact install of devDependencies
```

The only runtime dependency is `@modelcontextprotocol/sdk` (used by the MCP
gateway). See "Zero-runtime-dep core" below.

To install the CLI on your machine while developing:

```sh
# macOS / Linux
./install.sh    # builds dist/, symlinks bin/ashlr -> ~/.local/bin/ashlr, smoke-tests `ashlr help`

# Windows (PowerShell or cmd) — install.sh is bash-only, so use npm link
npm ci && npm run build && npm link   # puts `ashlr` on PATH via the npm global prefix
```

`install.sh` is idempotent — re-run it after pulling changes. On Windows, re-run
`npm run build` after pulling (the `npm link` shim points at `dist/`).

---

## Everyday commands

| Command            | What it does                                              |
|--------------------|----------------------------------------------------------|
| `npm run dev`      | Run the CLI from source via `tsx` (no compile step). E.g. `npm run dev -- status` |
| `npm test`         | Run the full vitest suite once (`vitest run`)            |
| `npm run lint`     | ESLint over the repo                                      |
| `npm run typecheck`| `tsc --noEmit` — strict type check, no emit              |
| `npm run build`    | `tsc -p tsconfig.json` → emits `dist/` (declarations + sourcemaps) |

`bin/ashlr` is a thin ESM shim that imports `dist/cli/index.js`, so the
installed binary always runs the compiled output. For fast iteration use
`npm run dev` (runs `src/cli/index.ts` directly through `tsx`).

### Definition of green

A change is ready when all four pass — wrapped in one script:

```sh
npm run verify   # typecheck + lint + build + test
```

The test suite must stay green and must not shrink (3,100+ tests across
`test/`). Tests are organized by milestone (`m2.*.test.ts`, `m3.*.test.ts`, …)
plus the M1 core suites (`classify`, `config`, `git`, `tidy`, `open`, etc.).

### Pre-push safeguard

A repo-tracked git hook runs `npm run verify` before every push — the local
guard that catches Windows-specific regressions (CI is Linux-only). Enable it
once per clone:

```sh
git config core.hooksPath .githooks
```

Skip it for a single push with `SKIP_VERIFY=1 git push`.

---

## Conventions

### ESM / NodeNext — `.js` import extensions

The project is `"type": "module"` with `module`/`moduleResolution` set to
`NodeNext`. **Always import sibling modules with the `.js` extension**, even
though the source file is `.ts`:

```ts
import { getGitStatus } from './git.js';        // not './git' or './git.ts'
import type { AshlrConfig } from './types.js';
```

This is non-negotiable — NodeNext resolution requires it at runtime.

### Strict TypeScript

`tsconfig.json` enables `strict`, plus `noImplicitOverride`, `noUnusedLocals`,
`noUnusedParameters`, and `noFallthroughCasesInSwitch`. Write code that passes
`npm run typecheck` with zero suppressions. Avoid `any`; prefer the canonical
types in `src/core/types.ts`.

### Zero-runtime-dep core

Everything under `src/core/` and `src/cli/` is built on **Node builtins only** —
no third-party runtime imports. The single allowed runtime dependency,
`@modelcontextprotocol/sdk`, is confined to the MCP layer (`mcp-gateway.ts`,
`run/agent-loop.ts`). **Do not add new runtime dependencies.** If you reach for
a library, reconsider — the design goal is a portable, fast, dependency-free
binary.

(The Raycast extension under `src/raycast/` has its own `package.json` and React
toolchain; it is excluded from the main `tsconfig` and lives independently.)

### One module per file

Each subsystem is a single focused module that owns one responsibility:
`git.ts` does git introspection, `classify.ts` classifies items, `tidy.ts`
plans/applies moves, and so on. Keep modules cohesive; don't reach across
concerns. CLI command handlers live in `src/cli/` and stay thin — they parse
argv and delegate to `core/`.

### Hermetic vitest tests

Tests must be hermetic — no dependence on the developer's real `~/.ashlr/`,
real Desktop, network, or installed tools. Drive the code through injected
config and temp directories; fixtures live in `test/fixtures/`. A test should
pass identically on any machine and in CI. Never read or assert against the
user's actual home directory state.

### No personal absolute paths in source

Source and example comments must not hardcode personal filesystem paths
(`/Users/<name>/...`). Resolve runtime paths from `os.homedir()` (the config
layer already does this), and use homedir-relative or generic placeholders
(`~/Desktop`, `/Users/you/...`) in docs and comments so the code is portable.
The `~/.ashlr/` runtime layout itself is intentional — don't change it.

### Author attribution

Author attribution (Mason Wyatt / `masonwyatt23` / ashlr.ai) is intentional and
must be preserved.

---

## Contracts-first pattern

ashlr-hub is built **contract-first**, which is what lets multiple agents build
disjoint modules in parallel without colliding.

1. **`src/core/types.ts` is THE CONTRACT.** It holds every shared type
   (`AshlrConfig`, `IndexedItem`, `AshlrIndex`, `DoctorReport`, `RunState`,
   `ActivityRollup`, `ProjectTemplate`, genome types, …). Import these types —
   **never redefine them** in another module.

2. **`CONTRACT.md` plus per-milestone extensions** (`CONTRACT-M2.md` …
   `CONTRACT-M7.md`) are the binding interface spec. Each one pins the exported
   function signatures and type shapes a milestone's modules must satisfy. Do
   not change an exported signature without updating the corresponding contract
   file in the same change.

3. **Build to the contract.** Implement against the declared signatures so that
   modules written independently compose cleanly. Because each agent edits a
   disjoint set of files against a frozen interface, parallel work merges without
   conflicts.

When you add a milestone or change a public surface: update `types.ts` and the
relevant `CONTRACT*.md` first, then implement, then test.

---

## Commit style

- Keep commits focused and atomic; one logical change per commit.
- Use a concise, imperative subject line (e.g. `add genome embedding rerank
  fallback`), with a body explaining the "why" when it isn't obvious.
- A commit should leave the tree green (typecheck + lint + test + build).
- Don't commit `dist/` (it is git-ignored) or machine-specific paths.

---

## Project layout

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full module map, the `~/.ashlr/`
home layout, how a command flows end to end, and the milestone → module mapping.
