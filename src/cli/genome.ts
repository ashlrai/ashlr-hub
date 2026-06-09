/**
 * `ashlr recall`, `ashlr learn`, and `ashlr genome` CLI commands (M7 + M16).
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
 *   ashlr genome --teach "<note>" [--title <t>] [--project <p>] [--json]
 *     Append a high-value explicit memory tagged 'teach'.
 *
 *   ashlr genome consolidate [--json]
 *     Merge near-duplicate genome entries (backup-first, no data loss).
 *
 *   ashlr genome export <file> [--format json|md] [--json]
 *     Export the full genome to a portable JSON or Markdown file.
 *
 *   ashlr genome playbook "<goal>" [--limit N] [--json]
 *     Synthesize a playbook from past genome entries for a goal.
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
  ConsolidationResult,
  Playbook,
} from '../core/types.js';

// ---------------------------------------------------------------------------
// Lazy imports — genome core modules are built by other M7/M16 agents.
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
// M16 lazy imports — consolidate / export / playbook modules
// ---------------------------------------------------------------------------

type ConsolidateGenomeFn = (
  cfg: import('../core/types.js').AshlrConfig,
) => Promise<ConsolidationResult>;

type ExportGenomeFn = (
  cfg: import('../core/types.js').AshlrConfig,
  dest: string,
  format: 'json' | 'md',
) => { ok: boolean; count: number; path: string };

type BuildPlaybookFn = (
  goal: string,
  cfg: import('../core/types.js').AshlrConfig,
  opts?: { limit?: number },
) => Promise<Playbook>;

type PlaybookTextFn = (p: Playbook, maxChars: number) => string;

async function importConsolidate(): Promise<{ consolidateGenome: ConsolidateGenomeFn }> {
  return import('../core/genome/consolidate.js') as Promise<{
    consolidateGenome: ConsolidateGenomeFn;
  }>;
}

async function importExport(): Promise<{ exportGenome: ExportGenomeFn }> {
  return import('../core/genome/export.js') as Promise<{
    exportGenome: ExportGenomeFn;
  }>;
}

async function importPlaybook(): Promise<{
  buildPlaybook: BuildPlaybookFn;
  playbookText:  PlaybookTextFn;
}> {
  return import('../core/genome/playbook.js') as Promise<{
    buildPlaybook: BuildPlaybookFn;
    playbookText:  PlaybookTextFn;
  }>;
}

// ---------------------------------------------------------------------------
// ANSI helpers — non-TTY safe (same pattern as run.ts / ship.ts)
// ---------------------------------------------------------------------------

import { pad, makeColors, isTty } from './ui.js';
import { parsePositiveInt } from './args.js';

const { bold, dim, red, green, yellow, cyan, gray, magenta } = makeColors(isTty());

/**
 * Write a line to stdout. Routes through process.stdout.write (not console.log)
 * so output is reliably captured by callers/tests that intercept the stream and
 * so it is unaffected by any console wiring. Appends a trailing newline.
 */
function out(line = ''): void {
  process.stdout.write(line + '\n');
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
      const parsed = parsePositiveInt('limit', args[++i]);
      if ('error' in parsed) { result.usageError = parsed.error; return result; }
      result.limit = parsed.n;
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
      `${pad(yellow(scoreStr), scoreW, 'right')}  ` +
      `${pad(methodColor, methodW)}  ` +
      `${pad(projectStr, projectW)}  ` +
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

  printRecallHuman(hits.filter(h => h.score > 0), parsed.query);
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
// `ashlr genome [subcommand] [options]`
//
// M16 subcommands routed from cmdGenome:
//   --teach "<note>"   — genome --teach
//   consolidate        — genome consolidate
//   export <file>      — genome export
//   playbook "<goal>"  — genome playbook
//
// Default (no subcommand): original M7 health panel.
// ---------------------------------------------------------------------------

// ---- subcommand detection ----

/**
 * Scan args for a known M16 subcommand keyword or flag.
 * Returns the subcommand name, or null to fall through to the health panel.
 */
function detectSubcommand(
  args: string[],
): 'teach' | 'consolidate' | 'export' | 'playbook' | null {
  for (const arg of args) {
    if (arg === '--teach')     return 'teach';
    if (arg === 'consolidate') return 'consolidate';
    if (arg === 'export')      return 'export';
    if (arg === 'playbook')    return 'playbook';
  }
  return null;
}

// ---- genome --teach ----

interface ParsedTeachArgs {
  note:        string;
  title?:      string;
  project?:    string;
  json:        boolean;
  usageError?: string;
}

function parseTeachArgs(args: string[]): ParsedTeachArgs {
  const result: ParsedTeachArgs = { note: '', json: false };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--teach') {
      const val = args[++i];
      if (!val || val.startsWith('--')) {
        result.usageError = `--teach requires a value, got: ${val ?? '(missing)'}`;
        return result;
      }
      result.note = val;
      i++;
    } else if (arg === '--json') {
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
    } else if (!arg.startsWith('--')) {
      // positional tokens (e.g. 'genome' itself) — skip silently
      i++;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  if (!result.note.trim()) {
    result.usageError =
      'Usage: ashlr genome --teach "<note>" [--title <title>] [--project <name>] [--json]';
  }

  return result;
}

async function runTeach(
  args: string[],
  _cfg: import('../core/types.js').AshlrConfig,
): Promise<number> {
  const parsed = parseTeachArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  let appendHubEntry: AppendHubEntryFn;
  let hubStorePath:   HubStorePathFn;
  try {
    const mod  = await importGenomeStore();
    appendHubEntry = mod.appendHubEntry;
    hubStorePath   = mod.hubStorePath;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load genome/store module: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Always tag 'teach'; preserve any project scoping.
  // Note: 'source' is a GenomeEntry field set by appendHubEntry, not a LearnInput field.
  const input: LearnInput = {
    text:    parsed.note,
    title:   parsed.title,
    project: parsed.project,
    tags:    ['teach'],
  };

  let entry: GenomeEntry;
  try {
    entry = appendHubEntry(input);
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to write teach entry: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  const storePath = hubStorePath();

  if (parsed.json) {
    process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
    return 0;
  }

  out('');
  out(bold('  ashlr genome --teach') + gray('  — high-value memory stored'));
  out('');
  out(`  ${bold('Title:')}    ${cyan(entry.title)}`);
  out(`  ${bold('ID:')}       ${dim(entry.id)}`);
  if (entry.project) {
    out(`  ${bold('Project:')} ${cyan(entry.project)}`);
  }
  out(`  ${bold('Tags:')}     ${entry.tags.map(t => dim(`#${t}`)).join(' ')}`);
  out(`  ${bold('Store:')}    ${gray(storePath)}`);
  out(`  ${bold('At:')}       ${relativeTime(entry.ts)}`);
  out('');
  out(dim('  Tagged #teach — surfaces in playbook synthesis and recall.'));
  out('');

  return 0;
}

// ---- genome consolidate ----

interface ParsedConsolidateArgs {
  json:        boolean;
  usageError?: string;
}

function parseConsolidateArgs(args: string[]): ParsedConsolidateArgs {
  const result: ParsedConsolidateArgs = { json: false };

  for (const arg of args) {
    if (arg === '--json') {
      result.json = true;
    } else if (
      arg === 'consolidate' || arg === '--help' ||
      arg === '-h'          || arg === 'help'
    ) {
      // subcommand token or help — no-op here
    } else if (arg.startsWith('--')) {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  return result;
}

async function runConsolidate(
  args: string[],
  cfg: import('../core/types.js').AshlrConfig,
): Promise<number> {
  const parsed = parseConsolidateArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  let consolidateGenomeFn: ConsolidateGenomeFn;
  try {
    const mod = await importConsolidate();
    consolidateGenomeFn = mod.consolidateGenome;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load genome/consolidate module (M16 not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  let result: ConsolidationResult;
  try {
    result = await consolidateGenomeFn(cfg);
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Consolidation failed: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }

  const { before, after, merged, backupPath } = result;
  const savedCount = before - after;

  out('');
  out(bold('  ashlr genome consolidate') + gray('  — deduplication complete'));
  out('');

  const labelW = 22;
  function row(label: string, value: string): void {
    out(`  ${bold(pad(label, labelW))}  ${value}`);
  }

  row('Entries before',    cyan(String(before)));
  row('Entries after',     cyan(String(after)));
  row('Merged (removed)',  merged > 0 ? yellow(String(merged)) : dim(String(merged)));
  row('Net reduction',     savedCount > 0 ? green(`-${savedCount}`) : dim('0'));
  row('Backup written',    gray(backupPath));

  out('');
  if (merged === 0) {
    out(`  ${dim('No near-duplicate entries found — genome is already clean.')}`);
  } else {
    out(`  ${dim(`Merged ${merged} near-duplicate group(s). No data lost — backup at:`)}`);
    out(`  ${gray(backupPath)}`);
  }
  out('');

  return 0;
}

// ---- genome export ----

interface ParsedExportArgs {
  dest:          string;
  format:        'json' | 'md';
  formatExplicit: boolean;
  json:          boolean;
  usageError?:   string;
}

function parseExportArgs(args: string[]): ParsedExportArgs {
  const result: ParsedExportArgs = {
    dest:           '',
    format:         'json',
    formatExplicit: false,
    json:           false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--format') {
      const val = args[++i];
      if (val !== 'json' && val !== 'md') {
        result.usageError = `--format must be 'json' or 'md', got: ${val ?? '(missing)'}`;
        return result;
      }
      result.format         = val;
      result.formatExplicit = true;
      i++;
    } else if (arg === 'export') {
      // subcommand token — skip
      i++;
    } else if (!arg.startsWith('--')) {
      if (result.dest) {
        result.usageError = `unexpected extra argument: ${arg}`;
        return result;
      }
      result.dest = arg;
      i++;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  if (!result.dest.trim()) {
    result.usageError =
      'Usage: ashlr genome export <file> [--format json|md] [--json]';
    return result;
  }

  // Infer format from extension when --format was not explicit
  if (!result.formatExplicit) {
    result.format = result.dest.endsWith('.md') ? 'md' : 'json';
  }

  return result;
}

async function runExport(
  args: string[],
  cfg: import('../core/types.js').AshlrConfig,
): Promise<number> {
  const parsed = parseExportArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  let exportGenomeFn: ExportGenomeFn;
  try {
    const mod = await importExport();
    exportGenomeFn = mod.exportGenome;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load genome/export module (M16 not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  const result = exportGenomeFn(cfg, parsed.dest, parsed.format);

  if (parsed.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? 0 : 1;
  }

  out('');
  if (result.ok) {
    out(bold('  ashlr genome export') + gray('  — genome exported'));
    out('');
    const labelW = 14;
    function row(label: string, value: string): void {
      out(`  ${bold(pad(label, labelW))}  ${value}`);
    }
    row('Entries',  cyan(String(result.count)));
    row('Format',   parsed.format === 'md' ? 'markdown' : 'json');
    row('Path',     gray(result.path));
    out('');
    out(dim(`  Portable export — no lock-in. ${result.count} entries written.`));
  } else {
    out(bold('  ashlr genome export') + red('  — export failed'));
    out('');
    out(`  ${red('Failed to write to:')} ${gray(parsed.dest)}`);
    process.stderr.write(
      red('error: ') + `export failed (path: ${result.path})\n`,
    );
    return 1;
  }
  out('');

  return 0;
}

// ---- genome playbook ----

/** Hard cap on the playbook text printed/injected by the CLI. */
const PLAYBOOK_CLI_MAX_CHARS = 4000;

interface ParsedPlaybookArgs {
  goal:        string;
  limit?:      number;
  json:        boolean;
  usageError?: string;
}

function parsePlaybookArgs(args: string[]): ParsedPlaybookArgs {
  const result: ParsedPlaybookArgs = { goal: '', json: false };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--limit') {
      const parsed = parsePositiveInt('limit', args[++i]);
      if ('error' in parsed) { result.usageError = parsed.error; return result; }
      result.limit = parsed.n;
      i++;
    } else if (arg === 'playbook') {
      // subcommand token — skip
      i++;
    } else if (!arg.startsWith('--')) {
      if (result.goal) {
        result.usageError = `unexpected extra argument: ${arg}`;
        return result;
      }
      result.goal = arg;
      i++;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  if (!result.goal.trim()) {
    result.usageError =
      'Usage: ashlr genome playbook "<goal>" [--limit N] [--json]';
  }

  return result;
}

function printPlaybookHuman(p: Playbook, text: string): void {
  out('');
  out(bold('  ashlr genome playbook') + gray(`  — "${p.goal}"`));
  out('');

  if (p.entries.length === 0) {
    out(`  ${dim('No past entries found for this goal.')}`);
    out(`  ${dim('Run more goals or use `ashlr learn` to build the genome.')}`);
    out('');
    return;
  }

  out(`  ${bold('Sources:')} ${dim(`${p.entries.length} past entry/entries recalled`)}`);
  out('');

  // Indent the synthesized playbook text 2 spaces for readability
  for (const line of text.split('\n')) {
    out(`  ${line}`);
  }

  out('');
  out(
    dim(`  ${p.entries.length} source(s)  ·  local genome  ·  `) +
    dim('`ashlr recall` to search manually'),
  );
  out('');
}

async function runPlaybook(
  args: string[],
  cfg: import('../core/types.js').AshlrConfig,
): Promise<number> {
  const parsed = parsePlaybookArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  let buildPlaybookFn: BuildPlaybookFn;
  let playbookTextFn:  PlaybookTextFn;
  try {
    const mod = await importPlaybook();
    buildPlaybookFn = mod.buildPlaybook;
    playbookTextFn  = mod.playbookText;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load genome/playbook module (M16 not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  let playbook: Playbook;
  try {
    playbook = await buildPlaybookFn(parsed.goal, cfg, { limit: parsed.limit });
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'buildPlaybook failed: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(playbook, null, 2) + '\n');
    return 0;
  }

  const text = playbookTextFn(playbook, PLAYBOOK_CLI_MAX_CHARS);
  printPlaybookHuman(playbook, text);
  return 0;
}

// ---- genome health panel (original M7 behavior — the default) ----

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

  const projectEntries = Math.max(0, totalEntries - hubEntries);

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
    out(`  ${dim('Search:')}   ${cyan('ashlr recall "<query>"')}`);
    out(`  ${dim('Add:')}      ${cyan('ashlr learn "<text>" [--project <name>] [--tags a,b]')}`);
    out(`  ${dim('Teach:')}    ${cyan('ashlr genome --teach "<note>"')}`);
    out(`  ${dim('Playbook:')} ${cyan('ashlr genome playbook "<goal>"')}`);
    out(`  ${dim('Export:')}   ${cyan('ashlr genome export <file.json|file.md>')}`);
  }

  out('');
}

/**
 * `ashlr genome [subcommand] [options]`
 *
 * M16 subcommands:
 *   --teach "<note>"     — store a high-value explicit memory tagged 'teach'
 *   consolidate          — merge near-duplicate entries (backup-first, no data loss)
 *   export <file>        — export full genome to portable JSON or Markdown
 *   playbook "<goal>"    — synthesize a playbook from past genome entries
 *
 * Default (no subcommand): prints genome health panel.
 * --json is honored on all subcommands and the health panel.
 *
 * Exit codes: 0 success, 1 module/runtime error, 2 bad usage.
 */
export async function cmdGenome(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printGenomeHelp();
    return 0;
  }

  // Load config — required by all paths
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

  // Route M16 subcommands
  const sub = detectSubcommand(args);
  if (sub === 'teach')       return runTeach(args, cfg);
  if (sub === 'consolidate') return runConsolidate(args, cfg);
  if (sub === 'export')      return runExport(args, cfg);
  if (sub === 'playbook')    return runPlaybook(args, cfg);

  // Default: original M7 health panel
  const parsed = parseGenomeArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
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
  out(bold('  ashlr genome') + dim(' — shared memory health + compounding genome (M16)'));
  out('');
  out('  ' + bold('Usage:'));
  out('');
  out(`    ashlr genome [subcommand] [options]`);
  out('');
  out('  ' + bold('Subcommands:'));
  out('');

  const subs: [string, string][] = [
    ['(none)',             'Print genome health panel (entry counts, size, staleness, embeddings).'],
    ['--teach "<note>"',   'Store a high-value explicit memory tagged #teach.'],
    ['consolidate',        'Merge near-duplicate entries (backup-first, no data loss).'],
    ['export <file>',      'Export full genome to portable JSON or Markdown (read-only).'],
    ['playbook "<goal>"',  'Synthesize a playbook from past genome entries for a goal.'],
  ];

  const subW = Math.max(...subs.map(([s]) => s.length));
  for (const [sub, desc] of subs) {
    out(`    ${cyan(pad(sub, subW))}  ${desc}`);
  }

  out('');
  out('  ' + bold('Common options:'));
  out('');
  out(`    ${cyan('--json')}  Emit machine-readable JSON on stdout (honored by all subcommands).`);
  out('');
  out('  ' + bold('Examples:'));
  out('');
  out(`    ${cyan('ashlr genome')}`);
  out(`    ${cyan('ashlr genome --teach "Always use --no-capture on dry-run flows"')}`);
  out(`    ${cyan('ashlr genome --teach "..." --title "Dry-run tip" --project ashlr-hub')}`);
  out(`    ${cyan('ashlr genome consolidate')}`);
  out(`    ${cyan('ashlr genome consolidate --json')}`);
  out(`    ${cyan('ashlr genome export ~/genome-backup.json')}`);
  out(`    ${cyan('ashlr genome export ~/genome-backup.md --format md')}`);
  out(`    ${cyan('ashlr genome playbook "scaffold a new CLI command"')}`);
  out(`    ${cyan('ashlr genome playbook "deploy to vercel" --limit 8 --json')}`);
  out('');
  out('  ' + bold('Notes:'));
  out('');
  out(`    ${dim('• consolidate: writes a timestamped backup of hub.jsonl first — no data loss.')}`);
  out(`    ${dim('• export: read-only, portable; no lock-in. Extension (.json/.md) infers format.')}`);
  out(`    ${dim('• playbook: local-only synthesis; falls back to concatenated recall on failure.')}`);
  out(`    ${dim('• teach: tagged #teach for elevated weight in playbook synthesis.')}`);
  out('');
  out('  ' + bold('Related commands:'));
  out('');
  out(`    ${cyan('ashlr recall "<query>"')}  ${dim('— search the genome')}`);
  out(`    ${cyan('ashlr learn "<text>"')}    ${dim('— add an entry')}`);
  out('');
}
