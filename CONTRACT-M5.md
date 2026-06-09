# CONTRACT-M5 — local-first observability (`ashlr pulse`)

M5 adds local-first observability to the hub: cost/tokens/activity rollups computed
**locally** from Claude Code transcripts, M4 run records, and git commit activity.
All numbers are computed offline; any Pulse cloud config is best-effort/informational only.

Build against the type contract in `src/core/types.ts` (M5 section). Each build agent
writes ONLY its own file(s). Zero new runtime deps. No git commit.

## PRIVACY GUARDRAILS (top priority)

- Read ONLY usage **metadata** from transcripts: token counts, model id, timestamp,
  and the project **path** (decoded from the encoded dir name).
- NEVER read, parse, store, or print message **content** — no prompts, completions,
  tool args/results, file contents. The parser extracts only the
  `usage` / `model` / `timestamp` fields per line and ignores everything else.
- Never print secrets. Aggregation writes nothing outside `~/.ashlr/`
  (an optional cache under `~/.ashlr/cache/` is permitted).

## PERFORMANCE

- Transcripts may be large/many: stream **line-by-line**, do not `JSON.parse` whole files.
- Filter by the time window **early**; skip files whose `mtime` is older than the window.
- Tolerate malformed lines (skip silently). Bounded work — never hang.

---

## Types added in `src/core/types.ts` (M5 section)

```ts
export interface UsageEvent {
  ts: string;
  project: string | null;
  model: string;
  source: 'claude' | 'run';
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ProjectActivity {
  project: string;
  sessions: number;
  commits: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  lastActive: string | null;
}

export interface DailyUsage {
  day: string;            // YYYY-MM-DD
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  sessions: number;
}

export interface ModelUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  calls: number;
}

export interface BudgetAlert {
  level: 'ok' | 'warn' | 'over';
  window: string;
  spentUsd: number;
  capUsd: number | null;
  spentTokens: number;
  capTokens: number | null;
  message: string;
}

export interface ActivityRollup {
  window: string;
  since: string;          // ISO timestamp of window start
  totals: {
    tokensIn: number;
    tokensOut: number;
    estCostUsd: number;
    sessions: number;
    commits: number;
  };
  byProject: ProjectActivity[];
  byDay: DailyUsage[];
  byModel: ModelUsage[];
  budget: BudgetAlert;
}
```

`AshlrConfig.telemetry` extended (all optional):

```ts
telemetry: {
  pulse?: string;
  budgetUsd?: number;
  budgetTokens?: number;
  budgetWindow?: '1d' | '7d' | '30d';
};
```

---

## EXACT signatures to implement

### `src/core/observability/usage-source.ts`

```ts
import type { UsageEvent } from '../types.js';

/**
 * Collect normalized UsageEvents from local sources with ts >= sinceMs.
 *
 * Sources (local, read-only):
 *   (a) ~/.claude/projects/<encoded-project>/*.jsonl  — METADATA ONLY.
 *       Each line is a JSON event; assistant message events carry a `usage`
 *       object { input_tokens, output_tokens, cache_creation_input_tokens,
 *       cache_read_input_tokens } plus a model id and a timestamp. Map
 *       input_tokens->tokensIn, output_tokens->tokensOut,
 *       cache_read_input_tokens->cacheRead, cache_creation_input_tokens->cacheWrite.
 *       project = decodeProjectPath(dirName). source = 'claude'.
 *   (b) ~/.ashlr/runs/*.json  (M4 RunState) — usage{tokensIn,tokensOut},
 *       provider/model, createdAt. source = 'run'. project = null (or run id).
 *
 * Stream line-by-line; skip files older than sinceMs via mtime; tolerate
 * malformed lines; NEVER read message content. Returns events filtered to
 * ts >= sinceMs (ms epoch). Never throws.
 */
export function collectUsageEvents(sinceMs: number): UsageEvent[];

/** Absolute path to ~/.claude/projects (honors $HOME). */
export function claudeProjectsDir(): string;

/**
 * Decode an encoded Claude project dir name back to an absolute project path.
 * Claude encodes path separators (and leading slash) as dashes, e.g.
 * '-Users-masonwyatt-Desktop-foo' -> '/Users/masonwyatt/Desktop/foo'.
 */
export function decodeProjectPath(dirName: string): string;
```

### `src/core/observability/rollup.ts`

```ts
import type { AshlrConfig, ActivityRollup } from '../types.js';

/**
 * Build the full window rollup. Pure aggregation over:
 *   - collectUsageEvents(now - windowToMs(window))  (tokens, sessions, models, cost)
 *   - git commit counts per indexed repo via core/git (commits within window)
 *   - estCostUsd(provider/model, in, out) from run/budget for cost
 *   - evalBudget(...) from budget-alert for the budget field
 *
 * opts.project (optional) restricts the rollup to a single project (match by
 * decoded path or basename). Sessions counted per distinct transcript file.
 * byDay ascending; byProject/byModel sorted by est cost (desc).
 */
export function buildRollup(
  window: '1d' | '7d' | '30d',
  cfg: AshlrConfig,
  opts?: { project?: string },
): ActivityRollup;

/** Window label -> milliseconds ('1d'->86_400_000, '7d', '30d'). Unknown -> 7d. */
export function windowToMs(window: string): number;
```

### `src/core/observability/budget-alert.ts`

```ts
import type { AshlrConfig, BudgetAlert } from '../types.js';

/**
 * Evaluate the budget cap for a window against spent totals.
 *
 * `totals` is the spent-so-far summary: { spentUsd: number; spentTokens: number }.
 * Caps read from cfg.telemetry.budgetUsd / budgetTokens (either may be unset/null).
 * level: 'over' when any cap exceeded; 'warn' when >= 80% of any cap; else 'ok'.
 * message is a concise human-readable status. Never throws.
 */
export function evalBudget(
  totals: { spentUsd: number; spentTokens: number },
  cfg: AshlrConfig,
  window: string,
): BudgetAlert;
```

### `src/cli/pulse.ts`

```ts
/**
 * `ashlr pulse` — rich local observability dashboard.
 *
 * Flags:
 *   --json                  machine-readable ActivityRollup
 *   --window 1d|7d|30d      window (default 7d)
 *   --project <name>        restrict to a single project
 *
 * Renders: window summary (totals + cost), by-project table, top models,
 * budget status (warn/over highlighted). Honors privacy guardrails — prints
 * only aggregate metadata, never content. Returns process exit code.
 */
export async function cmdPulse(args: string[]): Promise<number>;
```

---

## Surfaces (downstream wiring, not part of the core contract)

- `ashlr pulse` registered in `src/cli/index.ts` -> `cmdPulse`.
- `ashlr status`: add a compact `Activity (7d)` line from `buildRollup('7d', cfg)`.
- `ashlr doctor`: warn when `budget.level` is `warn`/`over`.
- Raycast: add a "Pulse" view backed by `ashlr pulse --json`.
