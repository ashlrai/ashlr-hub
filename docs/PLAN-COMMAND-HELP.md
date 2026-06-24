# Plan — per-command `--help` + central glossary

**Status:** approved, not started. Branch `feat/windows-support` (or cut a fresh `feat/command-help`).
**Date drafted:** 2026-06-24

## Why
A user ran `ashlr status` and couldn't tell what `dirty` / `off-sync` / `stale` meant,
or whether `Activity (7d)` was local-only. Root cause: the one entry point muscle
memory reaches for — `ashlr status --help` — is **dead**. Today top-level `--help`/`-h`
routes to general help, and per-command `--help` is only handled ad-hoc in `docs` and
`pulse`. `ashlr status --help` just runs status with the flag ignored.

Industry standard (git/docker/kubectl/gh): `<command> --help` = that command's detail
page (usage + flags + output legend + examples). That's the fix.

## Decision (what we're building, in order)
1. **Dispatcher `--help`/`-h` catch** — one change in `src/cli/index.ts` so
   `<command> --help` works for ALL ~50 commands at once. Highest leverage; do first.
2. **`src/cli/glossary.ts`** — central term definitions, built ONLY because step 1
   needs it (status's output legend reads from it). Not a standalone feature.
3. **`status` as the worked example** — the one fully-detailed help page. Every other
   command falls back to its existing one-line `desc` + usage for free.

### Explicitly deferred / dropped (do NOT build now)
- `ashlr explain <term>` subcommand — small wrapper over the glossary; add later IF asked.
- Inline auto-fading legend footers on `status` itself — fiddly state (per-command
  view counters in config) for uncertain payoff. Skip until a 2nd user is confused.
- Standardizing `--json`/global flags (~18 ad-hoc `args.includes('--json')` checks) —
  real debt but a separate refactor. Do NOT couple to this PR.

**Stop after step 3 and see how it feels before doing more.**

## Implementation

### Step 1 — dispatcher catch (`src/cli/index.ts`)
`main()` is at `src/cli/index.ts:1368`. `cmd = argv[0]`, `rest = argv.slice(1)`.
The `switch (cmd)` starts at line 1384. Top-level `help`/`--help`/`-h` case is at
line 1733. `cmdHelp` is imported from `./help.js` (already used at line 1360).

Add BEFORE the `switch`, but AFTER the existing `help`/`--help`/`-h` bare-command
handling concern. Guard so a bare `ashlr --help` (cmd === '--help') still hits the
general-help case, and `ashlr help <topic>` is untouched:

```ts
// After: const cmd = argv[0] ?? 'help'; const rest = argv.slice(1);
// Per-command help: `ashlr <command> --help|-h` → that command's detail page.
// Bare `--help`/`-h`/`help` (cmd itself) falls through to the general help case.
const isRealCmd = cmd !== 'help' && cmd !== '--help' && cmd !== '-h';
if (isRealCmd && (rest.includes('--help') || rest.includes('-h'))) {
  const { printCommandHelp } = await import('./help.js');
  process.exitCode = printCommandHelp(cmd);
  return;
}
```

Note: a few commands (`docs`, `pulse`) parse `--help` themselves. That's fine —
the dispatcher catch fires first and wins; their internal handling becomes dead but
harmless. Optionally remove their local `--help` handling in a follow-up.

### Step 2 — `src/cli/glossary.ts` (new file)
Single source of truth for term definitions. Keyed by slug.

```ts
export interface GlossaryTerm { term: string; short: string; }
export const GLOSSARY: Record<string, GlossaryTerm> = {
  dirty:    { term: 'dirty',    short: 'uncommitted changes in the working tree (file count shown)' },
  'off-sync': { term: 'off-sync', short: 'clean tree, but ahead/behind the remote (↑ahead ↓behind)' },
  stale:    { term: 'stale',    short: 'clean & in-sync, no commit in >N days (config: staleDays, default 30)' },
  clean:    { term: 'clean',    short: 'none of the above — in sync, working tree clean' },
  session:  { term: 'session',  short: 'one (project + calendar-day) pair of local Claude Code activity' },
  tokens:   { term: 'tokens',   short: 'input + output, summed across all models (local-only data)' },
  commits:  { term: 'commits',  short: 'all authors, across all tracked repos, in the window' },
  genome:   { term: 'genome',   short: "ashlr's local RAG index of project facts/decisions" },
};
export function lookup(slug: string): GlossaryTerm | undefined { return GLOSSARY[slug]; }
```

Term facts confirmed from source (do not re-derive):
- buckets are a PRIORITY CHAIN: dirty → else off-sync → else stale → else clean
  (`src/cli/index.ts:861-867`, `cmdStatus`).
- dirty count = lines of `git status --porcelain` (`src/core/git.ts:68-73`).
- ahead/behind = `git rev-list --left-right --count @{u}...HEAD` (`src/core/git.ts:76-91`).
- staleDays default 30 (`src/core/config.ts:386`); this machine has it set to 20.
- Activity rollup is 100% local — no server aggregation
  (`src/core/observability/rollup.ts`, `buildRollup('7d')`). sessions = distinct
  (project::ISO-day) keys; tokens = tokensIn+tokensOut all models; commits via
  `git log --after` across all indexed repos, all authors (rollup.ts:283).

### Step 3 — `printCommandHelp` + registry enrichment (`src/cli/help.ts`)
`HELP_ENTRIES: HelpEntry[]` lives at `src/cli/help.ts:230` with shape
`{ cmd, desc, topic }`. `makeColors`, `isTty`, `pad` already imported there (line 19).
Color binding pattern in index.ts: `makeColors(true)` at line 547.

(a) Extend `HelpEntry` with optional detail fields:
```ts
export interface HelpEntry {
  cmd: string; desc: string; topic: HelpTopic;
  usage?: string;          // full usage line; defaults to `ashlr <cmd>`
  flags?: [string, string][]; // [flag, description]
  outputLegend?: string[]; // glossary slugs to resolve + render
  examples?: string[];
  seeAlso?: string[];
}
```

(b) Enrich the `status` entry (currently `help.ts:233`) — the worked example:
```ts
{ cmd: 'status', topic: 'core',
  desc: 'Attention board: dirty, off-sync, and stale repos; ecosystem summary.',
  usage: 'ashlr status [--json] [--no-legend]',
  outputLegend: ['dirty', 'off-sync', 'stale', 'clean', 'session', 'tokens', 'commits'],
  flags: [['--json', 'machine-readable (agents: prefer `orient --json`)']],
  seeAlso: ['ashlr explain off-sync', 'ashlr pulse', 'ashlr orient'] },
```
NOTE: only add `--no-legend` to usage if/when the inline footer ships. For now
`status` takes no real flags, so trim usage to `ashlr status` unless adding --json.

(c) Add `printCommandHelp(cmd: string): number`:
- Find entry by matching first token of `e.cmd` (split on space) === `cmd`.
  Some commands have multiple HELP_ENTRIES rows (e.g. `backlog ...`); collect all
  rows whose first token matches and list their `cmd`/`desc` as subcommands.
- Render: title (`ashlr <cmd> — <desc>`), Usage, Output legend (resolve each slug
  via `glossary.lookup`, skip unknown), Flags, Examples, See also.
- Fallback when no entry: print `ashlr <cmd>` + "no detailed help; run `ashlr help`".
- Return 0 always (help never fails the shell), matching `cmdHelp` convention.

Target render for `ashlr status --help`:
```
  ashlr status — attention board across tracked repos

  Usage
    ashlr status

  Output
    Repos grouped by state (priority order — first match wins):
      dirty     uncommitted changes in the working tree (file count shown)
      off-sync  clean tree, but ahead/behind the remote (↑ahead ↓behind)
      stale     clean & in-sync, no commit in >N days
      clean     none of the above
    Activity (7d)  local-only: sessions = project-days · tokens = in+out, all
                   models · commits = all authors, all repos

  See also
    ashlr explain off-sync   ·   ashlr pulse   ·   ashlr orient
```

## Verify
- `node bin/ashlr status --help` → detail page (not the status board).
- `node bin/ashlr status -h` → same.
- `node bin/ashlr --help` and `ashlr help` → unchanged general help.
- `node bin/ashlr help core` → unchanged topic table.
- `node bin/ashlr run --help` → falls back gracefully (no detail block, no crash).
- Run the test suite (vitest): `npm test` (228 test files). Add a test asserting
  `printCommandHelp('status')` output contains the term "off-sync".

## Key file:line references
- dispatch / `main()`: `src/cli/index.ts:1368`; switch `:1384`; help case `:1733`
- `cmdStatus` + bucket logic: `src/cli/index.ts:845`, buckets `:861-867`
- index.ts color binding: `src/cli/index.ts:547`
- `HELP_ENTRIES` + `cmdHelp` + renderers: `src/cli/help.ts:230`, `:461`
- color/pad helpers: `src/cli/ui.ts` (`makeColors`, `pad`, `isTty`, `stripAnsi`)
- git status internals: `src/core/git.ts:68-91`
- rollup internals: `src/core/observability/rollup.ts`
- staleDays default: `src/core/config.ts:386`
