/**
 * `ashlr recall`, `ashlr learn`, and `ashlr genome` CLI commands (M7).
 *
 * Commands:
 *   ashlr recall "<query>" [--limit N] [--no-embeddings] [--json]
 *     Search the aggregated genome and print ranked hits.
 *
 *   ashlr learn "<text>" [--title <t>] [--project <p>] [--tags a,b] [--json]
 *     Append a memory entry to ~/.ashlr/genome/hub.jsonl.
 *
 *   ashlr genome [--json]
 *     Print genome health panel (entry counts, projects, size, staleness,
 *     embeddings availability).
 *
 * Exit codes:
 *   0  success
 *   1  error (missing module, I/O failure)
 *   2  bad usage
 */

import type {
  GenomeEntry,
  RecallHit,
  GenomeHealth,
  LearnInput,
} from '../core/types.js';

// ---------------------------------------------------------------------------
// Lazy imports — genome core modules are built by other M7 agents.
// Pattern mirrors run.ts / ship.ts: attempt dynamic import, degrade gracefully.
// ---------------------------------------------------------------------------

type RecallFn = (
  query: string,
  cfg: import('../core/types.js').AshlrConfig,
  opts?: { limit?: number; embeddings?: boolean },
) => Promise<RecallHit[]>;

type AppendHubEntryFn = (input: LearnInput) => GenomeEntry;
type HubStorePathFn   = () => string;

type GenomeHealthFn = (
  cfg: import('../core/types.js').AshlrConfig,
) => GenomeHealth;

async function importGenomeStore(): Promise<{
  appendHubEntry: AppendHubEntryFn;
  hubStorePath:   HubStorePathFn;
  genomeHealth:   GenomeHealthFn;
}> {
  return import('../core/genome/store.js') as Promise<{
    appendHubEntry: AppendHubEntryFn;
    hubStorePath:   HubStorePathFn;
    genomeHealth:   GenomeHealthFn;
  }>;
}

async function importGenomeRecall(): Promise<{ recall: RecallFn }> {
  return import('../core/genome/recall.js') as Promise<{ recall: RecallFn }>;
}

async function importConfig(): Promise<{
  loadConfig: () => import('../core/types.js').AshlrConfig;
}> {
  return import('../core/config.js') as Promise<{
    loadConfig: () => import('../core/types.js').AshlrConfig;
  }>;
}

// ---------------------------------------------------------------------------
// ANSI helpers — non-TTY safe (same pattern as run.ts / ship.ts)
// ---------------------------------------------------------------------------

const IS_TTY = process.stdout.isTTY === true;

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
} as const;

function colorize(code: string, s: string, tty = IS_TTY): string {
  if (!tty) return s;
  return `${code}${s}${C.reset}`;
}

function bold(s: string):    string { return colorize(C.bold,    s); }
function dim(s: string):     string { return colorize(C.dim,     s); }
function red(s: string):     string { return colorize(C.red,     s); }
function green(s: string):   string { return colorize(C.green,   s); }
function yellow(s: string):  string { return colorize(C.yellow,  s); }
function cyan(s: string):    string { return colorize(C.cyan,    s); }
function gray(s: string):    string { return colorize(C.gray,    s); }
function magenta(s: string): string { return colorize(C.magenta, s); }

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Write a line to stdout. Routes through process.stdout.write (not console.log)
 * so output is reliably captured by callers/tests that intercept the stream and
 * so it is unaffected by any console wiring. Appends a trailing newline.
 */
function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const vis    = stripAnsi(s).length;
  const spaces = Math.max(0, width - vis);
  return align === 'left' ? s + ' '.repeat(spaces) : ' '.repeat(spaces) + s;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Format bytes into a human-readable string (B / KB / MB). */
function fmtBytes(n: number): string {
  if (n < 1024)         return `${n} B`;
  if (n < 1024 * 1024)  return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Relative time from an ISO string. Returns 'never' for null. */
function relativeTime(iso: string | null): string {
  if (!iso) return gray('never');
  const ms = Date.now() - new Date(iso).getTime();
  const s  = Math.floor(ms / 1000);
  const m  = Math.floor(s  / 60);
  const h  = Math.floor(m  / 60);
  const d  = Math.floor(h  / 24);
  if (d > 0)  return `${d}d ago`;
  if (h > 0)  return `${h}h ago`;
  if (m > 0)  return `${m}m ago`;
  if (s >= 0) return `${s}s ago`;
  return 'just now';
}

/**
 * Produce a short snippet of the entry text (first non-empty line up to
 * `maxChars`), suitable for display in a hit list.
 */
function snippet(text: string, maxChars = 120): string {
  const first = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  if (first.length <= maxChars) return first;
  return first.slice(0, maxChars - 1) + '…';
}

// ---------------------------------------------------------------------------
// `ashlr recall "<query>" [--limit N] [--no-embeddings] [--json]`
// ---------------------------------------------------------------------------

interface ParsedRecallArgs {
  query:        string;
  limit?:       number;
  noEmbeddings: boolean;
  json:         boolean;
  usageError?:  string;
}

function parseRecallArgs(args: string[]): ParsedRecallArgs {
  const result: ParsedRecallArgs = {
    query:        '',
    noEmbeddings: false,
    json:         false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--no-embeddings') {
      result.noEmbeddings = true;
      i++;
    } else if (arg === '--limit') {
      const val = args[++i];
      const n   = val !== undefined ? parseInt(val, 10) : NaN;
      if (isNaN(n) || n <= 0) {
        result.usageError = `--limit requires a positive integer, got: ${val ?? '(missing)'}`;
        return result;
      }
      result.limit = n;
      i++;
    } else if (!arg.startsWith('--')) {
      if (result.query) {
        result.usageError = `unexpected extra argument: ${arg}`;
        return result;
      }
      result.query = arg;
      i++;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  if (!result.query.trim()) {
    result.usageError =
      'Usage: ashlr recall "<query>" [--limit N] [--no-embeddings] [--json]';
  }

  return result;
}

function printRecallHuman(hits: RecallHit[], query: string): void {
  if (hits.length === 0) {
    out('');
    out(`  ${dim(`No genome entries matched "${query}".`)}`);
    out(`  ${dim('Add entries with: ashlr learn "<text>"')}`);
    out('');
    return;
  }

  const scoreW   = 6;
  const methodW  = 9;
  const titleW   = 32;
  const projectW = 18;

  out('');
  out(bold('  ashlr recall') + gray(`  — ${hits.length} hit(s) for "${query}"`));
  out('');
  out(
    `  ${bold(pad('#', 3))}  ` +
    `${bold(pad('Score', scoreW, 'right'))}  ` +
    `${bold(pad('Method', methodW))}  ` +
    `${bold(pad('Project', projectW))}  ` +
    `${bold(pad('Title', titleW))}`,
  );
  out(
    `  ${'─'.repeat(3)}  ${'─'.repeat(scoreW)}  ${'─'.repeat(methodW)}  ` +
    `${'─'.repeat(projectW)}  ${'─'.repeat(titleW)}`,
  );

  hits.forEach((hit, idx) => {
    const { entry, score, method } = hit;
    const num         = String(idx + 1);
    const scoreStr    = score.toFixed(3);
    const methodColor = method === 'embedding' ? magenta(method) : cyan(method);
    const projectStr  = entry.project
      ? cyan(entry.project.length > projectW ? entry.project.slice(0, projectW - 1) + '…' : entry.project)
      : gray('(hub)');
    const titleStr    = entry.title.length > titleW
      ? entry.title.slice(0, titleW - 1) + '…'
      : entry.title;

    out(
      `  ${pad(dim(num), 3)}  ` +
      `${pad(yellow(scoreStr), scoreW + (IS_TTY ? 9 : 0), 'right')}  ` +
      `${pad(methodColor, methodW + (IS_TTY ? 9 : 0))}  ` +
      `${pad(projectStr, projectW + (IS_TTY ? 9 : 0))}  ` +
      titleStr,
    );

    // Snippet on the next line, indented
    const snip = snippet(entry.text);
    if (snip) {
      out(`  ${''.padStart(3 + 2 + scoreW + 2 + methodW + 2 + projectW + 2)}${gray(snip)}`);
    }

    // Tags line (if any)
    if (entry.tags.length > 0) {
      const tagStr = entry.tags.map(t => dim(`#${t}`)).join(' ');
      out(`  ${''.padStart(3 + 2 + scoreW + 2 + methodW + 2 + projectW + 2)}${tagStr}`);
    }

    // Separator between hits
    if (idx < hits.length - 1) out('');
  });

  out('');
  out(
    dim(`  ${hits.length} result(s)  ·  source: local genome  ·  `) +
    dim('ashlr learn "<text>" to add more'),
  );
  out('');
}

/**
 * `ashlr recall "<query>" [--limit N] [--no-embeddings] [--json]`
 *
 * Exit codes: 0 success, 1 module/runtime error, 2 bad usage.
 */
export async function cmdRecall(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printRecallHelp();
    return 0;
  }

  const parsed = parseRecallArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  // Load config
  let cfg: import('../core/types.js').AshlrConfig;
  try {
    const { loadConfig } = await importConfig();
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load config: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Load recall function
  let recallFn: RecallFn;
  try {
    const mod = await importGenomeRecall();
    recallFn  = mod.recall;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load genome/recall module (M7 not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Execute recall
  let hits: RecallHit[];
  try {
    hits = await recallFn(parsed.query, cfg, {
      limit:      parsed.limit,
      // Default CLI behavior opts INTO embedding rerank (best-effort, local-only).
      // recall() falls back to keyword automatically when no local model is
      // present or any embedding call fails. --no-embeddings forces keyword-only.
      embeddings: !parsed.noEmbeddings,
    });
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Recall failed: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
    return 0;
  }

  printRecallHuman(hits, parsed.query);
  return 0;
}

// ---------------------------------------------------------------------------
// `ashlr learn "<text>" [--title <t>] [--project <p>] [--tags a,b] [--json]`
// ---------------------------------------------------------------------------

interface ParsedLearnArgs {
  text:        string;
  title?:      string;
  project?:    string;
  tags:        string[];
  json:        boolean;
  usageError?: string;
}

function parseLearnArgs(args: string[]): ParsedLearnArgs {
  const result: ParsedLearnArgs = {
    text: '',
    tags: [],
    json: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--title') {
      const val = args[++i];
      if (!val || val.startsWith('--')) {
        result.usageError = `--title requires a value, got: ${val ?? '(missing)'}`;
        return result;
      }
      result.title = val;
      i++;
    } else if (arg === '--project') {
      const val = args[++i];
      if (!val || val.startsWith('--')) {
        result.usageError = `--project requires a value, got: ${val ?? '(missing)'}`;
        return result;
      }
      result.project = val;
      i++;
    } else if (arg === '--tags') {
      const val = args[++i];
      if (!val || val.startsWith('--')) {
        result.usageError = `--tags requires a comma-separated list, got: ${val ?? '(missing)'}`;
        return result;
      }
      result.tags = val.split(',').map(t => t.trim()).filter(t => t.length > 0);
      i++;
    } else if (!arg.startsWith('--')) {
      if (result.text) {
        result.usageError = `unexpected extra argument: ${arg}`;
        return result;
      }
      result.text = arg;
      i++;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  if (!result.text.trim()) {
    result.usageError =
      'Usage: ashlr learn "<text>" [--title <title>] [--project <name>] [--tags a,b] [--json]';
  }

  return result;
}

/**
 * `ashlr learn "<text>" [--title <t>] [--project <p>] [--tags a,b] [--json]`
 *
 * Appends a GenomeEntry to ~/.ashlr/genome/hub.jsonl. Never overwrites.
 * Confirms what was stored — does NOT print secrets or full text verbatim
 * (only the title, id, and store path are echoed).
 *
 * Exit codes: 0 success, 1 module/I-O error, 2 bad usage.
 */
export async function cmdLearn(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printLearnHelp();
    return 0;
  }

  const parsed = parseLearnArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  // Load store module
  let appendHubEntry: AppendHubEntryFn;
  let hubStorePath:   HubStorePathFn;
  try {
    const mod    = await importGenomeStore();
    appendHubEntry = mod.appendHubEntry;
    hubStorePath   = mod.hubStorePath;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load genome/store module (M7 not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Build input
  const input: LearnInput = {
    text:    parsed.text,
    title:   parsed.title,
    project: parsed.project,
    tags:    parsed.tags.length > 0 ? parsed.tags : undefined,
  };

  // Append entry
  let entry: GenomeEntry;
  try {
    entry = appendHubEntry(input);
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to write genome entry: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  const storePath = hubStorePath();

  if (parsed.json) {
    // Return the full entry as JSON — text is the user's own note, safe to echo.
    process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
    return 0;
  }

  // Human output: confirm title + id + path; do NOT echo text back (avoids
  // accidental secret exposure if text was pasted from a sensitive context).
  out('');
  out(bold('  ashlr learn') + gray('  — entry stored'));
  out('');
  out(`  ${bold('Title:')}    ${cyan(entry.title)}`);
  out(`  ${bold('ID:')}       ${dim(entry.id)}`);
  if (entry.project) {
    out(`  ${bold('Project:')} ${cyan(entry.project)}`);
  }
  if (entry.tags.length > 0) {
    out(`  ${bold('Tags:')}     ${entry.tags.map(t => dim(`#${t}`)).join(' ')}`);
  }
  out(`  ${bold('Store:')}    ${gray(storePath)}`);
  out(`  ${bold('Source:')}   ${entry.source}`);
  out(`  ${bold('At:')}       ${relativeTime(entry.ts)}`);
  out('');
  out(
    dim('  Use `ashlr recall "') + dim(entry.title.slice(0, 40)) + dim('"` to find it later.'),
  );
  out('');

  return 0;
}

// ---------------------------------------------------------------------------
// `ashlr genome [--json]`
// ---------------------------------------------------------------------------

interface ParsedGenomeArgs {
  json:        boolean;
  usageError?: string;
}

function parseGenomeArgs(args: string[]): ParsedGenomeArgs {
  const result: ParsedGenomeArgs = { json: false };

  for (const arg of args) {
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--help' || arg === '-h' || arg === 'help') {
      // handled upstream
    } else if (!arg.startsWith('--')) {
      // ignore subcommand tokens like 'status' (the command is implicit)
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  return result;
}

function printGenomeHuman(health: GenomeHealth): void {
  const {
    totalEntries,
    projects,
    hubEntries,
    sizeBytes,
    lastLearnedAt,
    embeddingsAvailable,
  } = health;

  const projectEntries = totalEntries - hubEntries;

  // Status badge
  const statusBadge = totalEntries === 0
    ? yellow('empty')
    : green('ok');

  out('');
  out(bold('  ashlr genome') + gray('  — shared memory health'));
  out('');

  const labelW = 22;
  function row(label: string, value: string): void {
    out(`  ${bold(pad(label, labelW))}  ${value}`);
  }

  row('Status',              statusBadge);
  row('Total entries',       cyan(String(totalEntries)));
  row('  hub entries',       String(hubEntries));
  row('  project entries',   String(projectEntries));
  row('Projects covered',    projects > 0 ? cyan(String(projects)) : dim('0'));
  row('Store size',          fmtBytes(sizeBytes));
  row('Last learned',        lastLearnedAt ? relativeTime(lastLearnedAt) : dim('never'));
  row('Embeddings (local)',
    embeddingsAvailable
      ? green('available  ') + dim('(Ollama reranking active)')
      : dim('unavailable') + gray('  (keyword-only; start Ollama + bge-m3 to enable)'),
  );

  out('');

  if (totalEntries === 0) {
    out(`  ${dim('Genome is empty. Add entries with:')}`);
    out(`  ${cyan('ashlr learn "<text>"')}`);
  } else {
    out(`  ${dim('Search:')}  ${cyan('ashlr recall "<query>"')}`);
    out(`  ${dim('Add:')}     ${cyan('ashlr learn "<text>" [--project <name>] [--tags a,b]')}`);
  }

  out('');
}

/**
 * `ashlr genome [--json]`
 *
 * Prints genome health panel. --json emits a GenomeHealth object.
 *
 * Exit codes: 0 success, 1 module/runtime error, 2 bad usage.
 */
export async function cmdGenome(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printGenomeHelp();
    return 0;
  }

  const parsed = parseGenomeArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  // Load config
  let cfg: import('../core/types.js').AshlrConfig;
  try {
    const { loadConfig } = await importConfig();
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load config: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Load store module
  let genomeHealthFn: GenomeHealthFn;
  try {
    const mod = await importGenomeStore();
    genomeHealthFn = mod.genomeHealth;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load genome/store module (M7 not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Compute health
  let health: GenomeHealth;
  try {
    health = genomeHealthFn(cfg);
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'genomeHealth failed: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(health, null, 2) + '\n');
    return 0;
  }

  printGenomeHuman(health);
  return 0;
}

// ---------------------------------------------------------------------------
// Help printers
// ---------------------------------------------------------------------------

function printRecallHelp(): void {
  out('');
  out(bold('  ashlr recall') + dim(' — search the shared genome'));
  out('');
  out('  ' + bold('Usage:'));
  out('');
  out(`    ashlr recall ${cyan('"<query>"')} [options]`);
  out('');
  out('  ' + bold('Options:'));
  out('');

  const opts: [string, string][] = [
    ['--limit N',         'Max hits to return (default: cfg.genome.maxRecall, typically 5).'],
    ['--no-embeddings',   'Skip embedding rerank; use keyword/TF-IDF scoring only.'],
    ['--json',            'Emit RecallHit[] JSON on stdout.'],
  ];

  const optW = Math.max(...opts.map(([o]) => o.length));
  for (const [opt, desc] of opts) {
    out(`    ${cyan(pad(opt, optW))}  ${desc}`);
  }

  out('');
  out('  ' + bold('Examples:'));
  out('');
  out(`    ${cyan('ashlr recall "typescript module resolution"')}`);
  out(`    ${cyan('ashlr recall "ollama embeddings" --limit 10')}`);
  out(`    ${cyan('ashlr recall "scaffold" --no-embeddings')}`);
  out(`    ${cyan('ashlr recall "genome" --json')}`);
  out('');
  out('  ' + bold('Notes:'));
  out('');
  out(`    ${dim('• Local-first: ranking uses keyword/TF-IDF by default.')}`);
  out(`    ${dim('• If Ollama is up and has an embedding model (e.g. bge-m3), hits are')}`);
  out(`    ${dim('  reranked with embeddings automatically (best-effort, no cloud).')}`);
  out(`    ${dim('• Sources: per-project .ashlrcode/genome/ dirs + ~/.ashlr/genome/hub.jsonl.')}`);
  out('');
}

function printLearnHelp(): void {
  out('');
  out(bold('  ashlr learn') + dim(' — store a memory in the genome'));
  out('');
  out('  ' + bold('Usage:'));
  out('');
  out(`    ashlr learn ${cyan('"<text>"')} [options]`);
  out('');
  out('  ' + bold('Options:'));
  out('');

  const opts: [string, string][] = [
    ['--title <title>',    'Short heading for the entry (derived from text when omitted).'],
    ['--project <name>',   'Scope the entry to a project (must match an indexed repo name).'],
    ['--tags a,b,c',       'Comma-separated tags for filtering/grouping.'],
    ['--json',             'Emit the stored GenomeEntry as JSON on stdout.'],
  ];

  const optW = Math.max(...opts.map(([o]) => o.length));
  for (const [opt, desc] of opts) {
    out(`    ${cyan(pad(opt, optW))}  ${desc}`);
  }

  out('');
  out('  ' + bold('Examples:'));
  out('');
  out(`    ${cyan('ashlr learn "Use NodeNext module resolution with .js import extensions"')}`);
  out(`    ${cyan('ashlr learn "Ollama runs on :11434; /api/embeddings for vectors" --project ashlr-hub')}`);
  out(`    ${cyan('ashlr learn "deploy to Vercel via CLI" --tags vercel,deploy,cli')}`);
  out(`    ${cyan('ashlr learn "M7 genome contract" --title "Genome types" --json')}`);
  out('');
  out('  ' + bold('Notes:'));
  out('');
  out(`    ${dim('• APPEND-ONLY: never overwrites or deletes existing entries.')}`);
  out(`    ${dim('• Writes to ~/.ashlr/genome/hub.jsonl.')}`);
  out(`    ${dim('• With --project, may also drop a note under the project\'s .ashlrcode/genome/.')}`);
  out(`    ${dim('• Never stores secrets — treat this like a commit message.')}`);
  out('');
}

function printGenomeHelp(): void {
  out('');
  out(bold('  ashlr genome') + dim(' — shared memory health and status'));
  out('');
  out('  ' + bold('Usage:'));
  out('');
  out(`    ashlr genome [--json]`);
  out('');
  out('  ' + bold('Options:'));
  out('');
  out(`    ${cyan('--json')}  Emit GenomeHealth JSON on stdout.`);
  out('');
  out('  ' + bold('Health panel shows:'));
  out('');
  out(`    ${dim('• Total entries (hub + project genomes combined)')}`);
  out(`    ${dim('• Number of projects covered')}`);
  out(`    ${dim('• Hub store size on disk (~/.ashlr/genome/hub.jsonl)')}`);
  out(`    ${dim('• Timestamp of the most recently learned entry')}`);
  out(`    ${dim('• Whether a local embedding model is available for reranking')}`);
  out('');
  out('  ' + bold('Related commands:'));
  out('');
  out(`    ${cyan('ashlr recall "<query>"')}  ${dim('— search the genome')}`);
  out(`    ${cyan('ashlr learn "<text>"')}    ${dim('— add an entry')}`);
  out('');
}
