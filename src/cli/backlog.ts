/**
 * `ashlr backlog` — Work Discovery CLI (M22).
 *
 * Commands:
 *   backlog              List current scored backlog (load from disk or build if missing).
 *   backlog refresh      Re-scan all enrolled repos via buildBacklog(), then list.
 *
 * Flags:
 *   --repo <path>        Filter items to a specific enrolled repo.
 *   --source <source>    Filter by WorkSource (issue|todo|test|dep|doc|security).
 *   --limit <n>          Cap the number of rows shown.
 *   --json               Emit raw JSON (the full filtered Backlog object).
 *
 * Non-TTY safe. READ-ONLY — this CLI only reads the backlog; all mutations are
 * performed by buildBacklog() in core/portfolio/backlog.ts (which is itself
 * READ-ONLY with respect to the scanned repos).
 *
 * Enrollment-scoped: only enrolled repos are ever scanned. When no repos are
 * enrolled (DEFAULT EMPTY) the backlog is empty and a friendly hint is shown.
 */

import { makeColors, pad } from './ui.js';
import type { WorkItem, WorkSource } from '../core/types.js';

// ---------------------------------------------------------------------------
// Module-level lazy loaders — degrade gracefully if portfolio modules not yet built
// ---------------------------------------------------------------------------

type BuildBacklogFn = (opts?: { repos?: string[] }) => Promise<import('../core/types.js').Backlog>;
type LoadBacklogFn  = () => import('../core/types.js').Backlog | null;

let _buildBacklog: BuildBacklogFn | null | undefined;
let _loadBacklog:  LoadBacklogFn  | null | undefined;

async function getBuildBacklog(): Promise<BuildBacklogFn | null> {
  if (_buildBacklog === undefined) {
    try {
      const mod = await import('../core/portfolio/backlog.js') as {
        buildBacklog: BuildBacklogFn;
        loadBacklog:  LoadBacklogFn;
      };
      _buildBacklog = mod.buildBacklog;
      _loadBacklog  = mod.loadBacklog;
    } catch {
      _buildBacklog = null;
      _loadBacklog  = null;
    }
  }
  return _buildBacklog;
}

async function getLoadBacklog(): Promise<LoadBacklogFn | null> {
  // Ensure the module load attempt has been made.
  await getBuildBacklog();
  return _loadBacklog ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<WorkSource, string> = {
  issue:    'issue',
  todo:     'todo',
  test:     'test',
  dep:      'dep',
  doc:      'doc',
  security: 'security',
  plugin:   'plugin', // M33
  self:     'self',   // M54
};

const SOURCE_COLORS: Record<WorkSource, keyof ReturnType<typeof makeColors>> = {
  issue:    'blue',
  todo:     'yellow',
  test:     'red',
  dep:      'magenta',
  doc:      'cyan',
  self:     'green', // M54
  security: 'red',
  plugin:   'cyan', // M33
};

/** Shorten an absolute repo path: replace $HOME with ~, truncate if long. */
function shortRepo(repo: string): string {
  const home = process.env['HOME'] ?? '';
  const s = home ? repo.replace(home, '~') : repo;
  // Keep last two segments for readability.
  const parts = s.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : s;
}

/** Score bar: 5 filled blocks out of 5, proportional. */
function scoreBar(score: number): string {
  // score = value/effort, typically 0.2..5.0
  // Map to 0-5 blocks (each 0.2 wide steps → 1 block per integer score up to 5).
  const filled = Math.max(0, Math.min(5, Math.round(score)));
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

/** Print the backlog as a human-readable aligned table. */
function printTable(items: WorkItem[], tty: boolean): void {
  const col = makeColors(tty);

  if (items.length === 0) {
    console.log(col.dim('  (no items)'));
    return;
  }

  // Column widths (computed from data).
  const scoreW  = 7;   // "  5.00 " fits; fixed
  const barW    = 5;   // 5 blocks; fixed
  const srcW    = 8;   // longest source is "security"
  const repoW   = Math.min(30, Math.max(10, ...items.map(i => shortRepo(i.repo).length)));
  const veW     = 6;   // "V5/E5" fits
  const titleW  = Math.min(60, Math.max(10, ...items.map(i => i.title.length)));

  // Header.
  const hdr = [
    col.bold(pad('SCORE', scoreW)),
    col.bold(pad('', barW)),
    col.bold(pad('SRC', srcW)),
    col.bold(pad('REPO', repoW)),
    col.bold(pad('V/E', veW)),
    col.bold('TITLE'),
  ].join('  ');
  console.log('');
  console.log('  ' + hdr);
  console.log('  ' + col.dim('─'.repeat(scoreW + barW + srcW + repoW + veW + titleW + 10)));

  for (const item of items) {
    const srcColor = SOURCE_COLORS[item.source] ?? 'cyan';
    // makeColors returns an object; access by key.
    const colorFn = col[srcColor] as (s: string) => string;

    const scoreFmt = item.score.toFixed(2);
    const bar      = tty ? col.green(scoreBar(item.score)) : scoreBar(item.score);
    const src      = colorFn(pad(SOURCE_LABELS[item.source] ?? item.source, srcW));
    const repo     = col.dim(pad(shortRepo(item.repo), repoW));
    const ve       = col.dim(`V${item.value}/E${item.effort}`);
    // Truncate long titles.
    const title    = item.title.length > titleW
      ? item.title.slice(0, titleW - 1) + '…'
      : item.title;

    const row = [
      col.bold(pad(scoreFmt, scoreW)),
      bar,
      src,
      repo,
      pad(ve, veW),
      title,
    ].join('  ');
    console.log('  ' + row);
  }
  console.log('');
}

/** Print a brief summary line after a refresh. */
function printSummary(
  repos: string[],
  items: WorkItem[],
  col: ReturnType<typeof makeColors>,
): void {
  const counts: Partial<Record<WorkSource, number>> = {};
  for (const item of items) {
    counts[item.source] = (counts[item.source] ?? 0) + 1;
  }
  const breakdown = (Object.entries(counts) as [WorkSource, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([src, n]) => `${n} ${src}`)
    .join(', ');

  console.log(
    col.green('✓') + ' Backlog refreshed — ' +
    col.bold(String(items.length)) + ' item' + (items.length !== 1 ? 's' : '') +
    ' across ' + col.bold(String(repos.length)) + ' repo' + (repos.length !== 1 ? 's' : '') +
    (breakdown ? col.dim(' (' + breakdown + ')') : ''),
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr backlog [refresh] [--repo <path>] [--source <src>] [--limit <n>] [--json]`
 *
 * Returns process exit code (0 = success, 1 = error, 2 = usage error).
 */
export async function cmdBacklog(args: string[]): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  // ── Parse arguments ──────────────────────────────────────────────────────
  let subcommand: 'list' | 'refresh' = 'list';
  let filterRepo:   string | undefined;
  let filterSource: WorkSource | undefined;
  let limit:        number | undefined;
  let jsonMode      = false;

  const validSources = new Set<string>(['issue', 'todo', 'test', 'dep', 'doc', 'security']);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'refresh') {
      subcommand = 'refresh';
    } else if (a === '--json') {
      jsonMode = true;
    } else if (a === '--repo') {
      filterRepo = args[++i];
      if (!filterRepo) {
        console.error(col.red('error: ') + '--repo requires a path argument');
        return 2;
      }
    } else if (a === '--source') {
      const raw = args[++i];
      if (!raw || !validSources.has(raw)) {
        console.error(col.red('error: ') + `--source requires one of: ${[...validSources].join('|')}, got: ${raw ?? '(missing)'}`);
        return 2;
      }
      filterSource = raw as WorkSource;
    } else if (a === '--limit') {
      const raw = args[++i];
      const n = raw !== undefined ? parseInt(raw, 10) : NaN;
      if (isNaN(n) || n <= 0) {
        console.error(col.red('error: ') + `--limit requires a positive integer, got: ${raw ?? '(missing)'}`);
        return 2;
      }
      limit = n;
    } else if (a === 'list') {
      // explicit 'list' subcommand — no-op, it's the default
    } else if (a?.startsWith('-')) {
      console.error(col.red('error: ') + `Unknown flag: ${a}`);
      console.error(col.dim('Usage: ashlr backlog [refresh] [--repo <path>] [--source <src>] [--limit <n>] [--json]'));
      return 2;
    }
  }

  // ── Load portfolio modules ───────────────────────────────────────────────
  const buildBacklog = await getBuildBacklog();
  const loadBacklog  = await getLoadBacklog();

  if (!buildBacklog || !loadBacklog) {
    console.error(col.red('error: ') + 'backlog command requires src/core/portfolio/backlog.ts (M22 module not yet built).');
    return 1;
  }

  // ── Execute subcommand ───────────────────────────────────────────────────
  let backlog: import('../core/types.js').Backlog | null = null;

  if (subcommand === 'refresh') {
    if (!jsonMode) {
      process.stdout.write(col.dim('Scanning enrolled repos…') + (tty ? '\r' : '\n'));
    }
    try {
      backlog = await buildBacklog();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(col.red('error: ') + msg);
      return 1;
    }
    if (!jsonMode) {
      // Clear the scanning line on TTY.
      if (tty) process.stdout.write('\x1b[2K\r');
      printSummary(backlog.repos, backlog.items, col);
    }
  } else {
    // Default: list — load from disk; build if missing.
    backlog = loadBacklog();
    if (!backlog) {
      if (!jsonMode) {
        process.stdout.write(col.dim('No backlog found — building now…') + (tty ? '\r' : '\n'));
      }
      try {
        backlog = await buildBacklog();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(col.red('error: ') + msg);
        return 1;
      }
      if (!jsonMode && tty) {
        process.stdout.write('\x1b[2K\r');
      }
    }
  }

  // ── No enrolled repos ────────────────────────────────────────────────────
  if (backlog.repos.length === 0 && backlog.items.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify(backlog, null, 2));
      return 0;
    }
    console.log('');
    console.log(col.yellow('No repos enrolled.'));
    console.log(col.dim('  Enroll a repo to start discovering work:'));
    console.log('  ' + col.cyan('ashlr enroll add <path-to-repo>'));
    console.log('');
    return 0;
  }

  // ── Apply filters ────────────────────────────────────────────────────────
  let items = backlog.items;

  if (filterRepo) {
    // Normalize: support both absolute and partial matches.
    const norm = filterRepo.replace(/\/$/, '');
    items = items.filter(
      i => i.repo === norm || i.repo.endsWith('/' + norm) || i.repo.includes(norm),
    );
  }

  if (filterSource) {
    items = items.filter(i => i.source === filterSource);
  }

  if (limit !== undefined) {
    items = items.slice(0, limit);
  }

  // ── Output ───────────────────────────────────────────────────────────────
  if (jsonMode) {
    const out: import('../core/types.js').Backlog = {
      generatedAt: backlog.generatedAt,
      repos:       backlog.repos,
      items,
    };
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  // Human-readable header.
  const age = (() => {
    try {
      const ms = Date.now() - new Date(backlog.generatedAt).getTime();
      if (ms < 60_000)            return 'just now';
      if (ms < 3_600_000)         return `${Math.floor(ms / 60_000)}m ago`;
      if (ms < 86_400_000)        return `${Math.floor(ms / 3_600_000)}h ago`;
      return `${Math.floor(ms / 86_400_000)}d ago`;
    } catch {
      return backlog.generatedAt;
    }
  })();

  console.log('');
  console.log(
    col.bold('  ashlr backlog') +
    col.dim(` — ${items.length} item${items.length !== 1 ? 's' : ''}` +
      (filterRepo || filterSource || limit !== undefined ? ' (filtered)' : '') +
      `  ·  generated ${age}` +
      `  ·  ${backlog.repos.length} repo${backlog.repos.length !== 1 ? 's' : ''}`),
  );

  printTable(items, tty);

  if (items.length === 0 && (filterRepo || filterSource)) {
    console.log(col.dim('  No items match the current filters.'));
    console.log('');
  }

  // Hint: how to refresh.
  if (subcommand === 'list') {
    console.log(col.dim('  Run `ashlr backlog refresh` to re-scan.'));
    console.log('');
  }

  return 0;
}
