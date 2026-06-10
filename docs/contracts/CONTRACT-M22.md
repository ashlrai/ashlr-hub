# CONTRACT-M22 — Work Discovery (`ashlr backlog`)

`ashlr backlog` derives a prioritized, scored work queue across **ENROLLED** repos,
**READ-ONLY**. Each agent edits ONLY its own file(s). Build strictly against the
signatures below.

## Shared types (`src/core/types.ts`) — ALREADY ADDED

```ts
export type WorkSource = 'issue' | 'todo' | 'test' | 'dep' | 'doc' | 'security';

export interface WorkItem {
  id: string;        // stable deterministic, e.g. `${repo}:${source}:${hash}`
  repo: string;      // absolute path of the enrolled repo
  source: WorkSource;
  title: string;
  detail: string;    // NO secrets
  value: number;     // 1..5 (5 = high value)
  effort: number;    // 1..5 (5 = high effort)
  score: number;     // = scoreItem(value, effort); higher = do first
  tags: string[];
  ts: string;        // ISO timestamp
}

export interface Backlog {
  generatedAt: string; // ISO
  repos: string[];     // absolute paths scanned
  items: WorkItem[];
}
```

---

## GLOBAL GUARDRAILS (apply to EVERY file below)

1. **READ-ONLY.** Scanners NEVER modify any repo: no file writes, no git mutations,
   no installs, no fixes, no `npm test`/`npm run build` (those execute project code).
   Only safe metadata reads: `gh` reads, `rg`/`grep`, `npm outdated --json`,
   `npm audit --json`, filesystem stats.
2. **No shell.** Invoke `gh` / `npm` / `rg` / `git` via `execFile` with **arg arrays**
   (never a shell string, never string interpolation of repo paths into a command).
3. **Bounded.** Skip `node_modules`, `.git`, `dist`. Cap files scanned, output size,
   and wall-clock time (timeouts on every spawned process). Truncate large output.
4. **Never throws.** Every scanner returns `[]` on ANY error/timeout/missing-tool.
   No exception escapes a scanner or `buildBacklog`.
5. **Enrollment-scoped.** Only `listEnrolled()` (from `core/sandbox/policy.ts`) repos
   are scanned. DEFAULT EMPTY => empty backlog. NEVER scan the whole disk/portfolio.
6. **No secrets** in any `WorkItem`, `Backlog`, or audit output.
7. Preserve all existing behavior + 2202 tests. Reuse existing modules
   (`core/integrations/github.ts` M18 `listIssues`/`githubStatus`, `core/git.ts`,
   `core/index-engine.ts`, `core/sandbox/policy.ts`, `core/sandbox/audit.ts`,
   `cli/ui.ts`). No new runtime deps. No `git commit` of ashlr-hub.

---

## `src/core/portfolio/scanners.ts`

Each scanner is **READ-ONLY, bounded, and never throws** (returns `[]` on any error).
Each receives one absolute enrolled repo path and returns its discovered items.

```ts
import type { WorkItem } from '../types';

export async function scanIssues(repo: string): Promise<WorkItem[]>;
export async function scanTodos(repo: string): Promise<WorkItem[]>;
export async function scanTests(repo: string): Promise<WorkItem[]>;
export async function scanDeps(repo: string): Promise<WorkItem[]>;
export async function scanDocs(repo: string): Promise<WorkItem[]>;
export async function scanSecurity(repo: string): Promise<WorkItem[]>;

/** All scanners, iterated by buildBacklog over each enrolled repo. */
export const SCANNERS: ReadonlyArray<(repo: string) => Promise<WorkItem[]>>;
```

Per-scanner intent (all read-only, bounded):

- **scanIssues** — open GitHub issues via M18 `listIssues` (`core/integrations/github.ts`).
- **scanTodos** — `TODO`/`FIXME`/`HACK`/`XXX` comments via `rg`/`grep` (arg arrays;
  skip `node_modules`/`.git`/`dist`; cap matches).
- **scanTests** — failing tests / red CI via M18 `githubStatus` / `gh run list` latest
  state; OR a bounded heuristic (presence of a test script, a "no tests" note). **Do
  NOT run the test suite.**
- **scanDeps** — `npm outdated --json` (stale) + `npm audit --json` (vuln severity
  counts), both bounded with timeouts. Metadata only; no installs.
- **scanDocs** — heuristics: missing/thin README, missing LICENSE, missing
  CONTRIBUTING, low test presence.
- **scanSecurity** — `binshield` findings if `binshield` is installed (read-only);
  else return `[]` (skip).

Each emitted item MUST set `score = scoreItem(value, effort)` (import from `./backlog`).

---

## `src/core/portfolio/backlog.ts`

```ts
import type { Backlog } from '../types';

/**
 * Run all SCANNERS over each repo (default = listEnrolled()), aggregate,
 * dedupe (by item id), score, persist to backlogPath(), and return the Backlog.
 * READ-ONLY w.r.t. scanned repos. Never throws from a scanner failure.
 */
export async function buildBacklog(opts?: { repos?: string[] }): Promise<Backlog>;

/** Load the persisted backlog, or null if none / unreadable. */
export function loadBacklog(): Backlog | null;

/** Absolute path of the persisted backlog (~/.ashlr/backlog.json). */
export function backlogPath(): string;

/**
 * Priority score; higher = do first. Heuristic: value / effort
 * (effort clamped >= 1, both clamped to 1..5). Deterministic, pure.
 */
export function scoreItem(value: number, effort: number): number;
```

- Default `opts.repos` = `listEnrolled()` from `core/sandbox/policy.ts`
  (DEFAULT EMPTY => `items: []`).
- Sort persisted/returned `items` by `score` descending.
- Persist atomically to `backlogPath()` (`~/.ashlr/backlog.json`).

---

## `src/cli/backlog.ts`

```ts
/**
 * `ashlr backlog`            -> list current scored items (loadBacklog()).
 * `ashlr backlog refresh`    -> re-scan via buildBacklog(), then list.
 * Flags: --repo <path>  --source <WorkSource>  --limit <n>  --json
 */
export async function cmdBacklog(args: string[]): Promise<number>;
```

- Default subcommand = list; `refresh` re-scans.
- `--repo` filters by repo, `--source` by `WorkSource`, `--limit` caps rows,
  `--json` emits raw JSON.
- Rendering reuses `cli/ui.ts`. Returns process exit code (`0` on success).
