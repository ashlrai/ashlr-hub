# CONTRACT — M18: Wire Ashlr into the agentic toolbelt (GitHub · Vercel · Editors · Identity · Notify)

Build against THIS contract. Each agent edits ONLY its own file(s). Reuse existing modules
(`core/dashboard.ts buildSnapshot`, `core/mcp-registry.ts` + M3 `ashlr mcp install` write pattern,
`core/phantom.ts`, `cli/ui.ts`, `core/git.ts`, `cli/doctor-init.ts`). No new runtime deps.
Preserve all existing behavior and the 1745 tests. Do NOT git commit ashlr-hub.

## GLOBAL RULES — read-first, mutations gated

- **READ-FIRST is SAFE.** `githubStatus`, `listPrs`, `listIssues`, `vercelStatus`, `listDeploys`,
  `detectEditors`, `getIdentity` are read-only. They reuse the INSTALLED CLIs (`gh`, `vercel`,
  `phantom`) which own their own auth. **NEVER handle, read, log, or print raw tokens.**
- **Read producers MUST NEVER throw.** On any failure (CLI missing, not logged in, not a repo,
  not linked, malformed output, non-zero exit) they return a safe "empty/unknown/unlinked/logged-out"
  shape. No exceptions escape to the caller.
- **OUTWARD MUTATIONS are EXPLICIT / opt-in / confirm-gated — never automatic.** This covers
  `createPr` (gh pr create / comment), `notify` (webhook post), and deploy (stays in `ashlr ship`,
  already `--confirm`). A mutation runs only on an explicit user-invoked command with confirmation.
- **No secret values** are logged or printed anywhere. Identity is NAMES/status only.
- **Editor-wire is backup-first + deep-merge + idempotent + LOCAL**, reusing the M3 install pattern;
  it writes ONLY the target editor's config file. `configPath` makes it temp-config-safe for tests.
- **During BUILD/INTEGRATE/VERIFY:** do NOT create real PRs/issues/comments, do NOT deploy, do NOT
  post real notifications. Test command CONSTRUCTION + read paths + dry-runs only; editor-wire tests
  run ONLY against TEMP config files (like the M3 tests).

## TYPES (already added to `src/core/types.ts` — do not redefine)

```ts
export interface GithubStatus {
  isRepo: boolean;
  openPrs: number;
  openIssues: number;
  ci: 'passing' | 'failing' | 'pending' | 'none';
  repo: string | null;
}
export interface VercelStatus {
  linked: boolean;
  latestState: string | null;
  url: string | null;
}
export interface Identity {
  loggedIn: boolean;
  user: string | null;
  tier: string | null;
  team: string | null;
}
export interface NotifyTarget {
  slackWebhook?: string;
  discordWebhook?: string;
}
// AshlrConfig extended with: notify?: NotifyTarget;
```

## MODULE: `src/core/integrations/github.ts` (read-only via `gh`; createPr explicit+gated)

```ts
import type { GithubStatus } from '../types.js';

/** Read-only repo snapshot via `gh`. NEVER throws — degrades to a not-a-repo shape. */
export function githubStatus(cwd: string): GithubStatus;

/** A single PR summary (read-only list). */
export interface PrSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
}
/** List open PRs via `gh pr list`. NEVER throws — returns [] on any failure. */
export function listPrs(cwd: string): PrSummary[];

/** A single issue summary (read-only list). */
export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  author: string;
}
/** List open issues via `gh issue list`. NEVER throws — returns [] on any failure. */
export function listIssues(cwd: string): IssueSummary[];

/**
 * EXPLICIT, MUTATING. Creates a PR via `gh pr create`. Caller MUST gate this
 * behind an explicit `ashlr gh pr create` + confirm — never automatic.
 * May reject/throw on failure; the result reports outcome on success.
 */
export interface CreatePrOpts {
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
}
export interface CreatePrResult {
  ok: boolean;
  url: string | null;
  detail: string;
}
export async function createPr(cwd: string, opts: CreatePrOpts): Promise<CreatePrResult>;
```

- `githubStatus`: `isRepo` via `gh repo view --json nameWithOwner` (success => repo set); `openPrs`
  via `gh pr list --state open --json number`; `openIssues` via `gh issue list --state open --json number`;
  `ci` via `gh pr checks` / `gh run list` aggregated to passing|failing|pending; `none` when no checks.
- All read fns spawn `gh` with cwd, parse `--json` output, swallow every error.

## MODULE: `src/core/integrations/vercel.ts` (read-only via `vercel`)

```ts
import type { VercelStatus } from '../types.js';

/** Read-only linked-project snapshot via `vercel`. NEVER throws — degrades to unlinked. */
export function vercelStatus(cwd: string): VercelStatus;

/** A single deployment summary (read-only). */
export interface DeploySummary {
  url: string;
  state: string;
  createdAt: string | null;
  target: string | null;
}
/** List recent deploys via `vercel ls`. NEVER throws — returns [] on any failure. */
export function listDeploys(cwd: string): DeploySummary[];
```

- `linked` is true when `.vercel/project.json` exists / `vercel` resolves the project for cwd.
- `latestState` + `url` taken from the most recent deployment. Deploy itself stays in `ashlr ship`.

## MODULE: `src/core/integrations/editors.ts` (reuse M3 install pattern; backup+merge+idempotent)

```ts
/** Detect installed editors by their config dirs (~/.claude, ~/.codex, ~/.cursor). */
export function detectEditors(): string[]; // subset of ['claude','codex','cursor']

/**
 * Wire the ashlr MCP gateway (and note genome) into one editor's MCP config,
 * reusing the M3 `ashlr mcp install` pattern: backup-first, deep-merge into
 * mcpServers, idempotent (re-run is a no-op), never clobber existing entries.
 * LOCAL only — writes only the target's config file. `configPath` overrides the
 * default path so tests run against a TEMP file (never a real editor config).
 */
export async function wireEditor(
  target: 'claude' | 'codex' | 'cursor',
  opts: { configPath?: string }
): Promise<{ ok: boolean; detail: string }>;
```

## MODULE: `src/core/integrations/identity.ts` (phantom names/status only)

```ts
import type { Identity } from '../types.js';

/** Read caller identity via `phantom` cloud status/team. NAMES/status only —
 *  NEVER secret values. NEVER throws — degrades to logged-out when absent. */
export function getIdentity(): Identity;
```

## MODULE: `src/core/integrations/notify.ts` (opt-in outward post; no-op if unset)

```ts
import type { AshlrConfig } from '../types.js';

/**
 * Post a concise completion summary to a configured webhook (M18).
 * STRICT NO-OP when neither cfg.notify.slackWebhook nor discordWebhook is set:
 * returns false WITHOUT any network call. When set, posts `text` (no secrets)
 * and returns true on success. NEVER posts without a configured webhook.
 */
export async function notify(text: string, cfg: AshlrConfig): Promise<boolean>;
```

## CLI

```ts
// src/cli/gh.ts
/** `ashlr gh <pr|issue|ci>` — read-only lists/status. `ashlr gh pr create`
 *  is the ONLY mutation and requires an explicit confirm before createPr(). */
export function cmdGh(args: string[]): Promise<number>;

// src/cli/vercel.ts
/** `ashlr vercel <ls|logs>` — read-only deploys/latest logs. Deploy lives in `ashlr ship`. */
export function cmdVercel(args: string[]): Promise<number>;

// src/cli/wire.ts
/** `ashlr wire <claude|codex|cursor|all>` — wire MCP gateway into editor config(s).
 *  Defaults to detected editors; backup-first, idempotent, local. */
export function cmdWire(args: string[]): Promise<number>;

// src/cli/notify.ts
/** `ashlr notify test` — send a test ping to the configured webhook(s).
 *  NO-OP (informative exit) when no webhook is configured. */
export function cmdNotify(args: string[]): Promise<number>;
```

- `status`/`doctor` surface `github`/`vercel`/`identity` one-liners:
  - `GitHub: N open PRs · CI passing/failing` (only when cwd is a gh repo).
  - `Vercel: <latestState> <url>` (only when a project is linked).
  - `You: <user> · tier <tier> · team <team>` (degrades gracefully when logged out).
  - doctor adds an identity check that degrades gracefully when phantom is not logged in.

## VERIFY

- `npm run typecheck` passes (types.ts already typechecks with the new shapes).
- Existing 1745 tests still pass; new tests use TEMP configs / dry-runs / command-construction only.
