/**
 * CLI handler for `ashlr ask "<question>"`.
 *
 * Performs LOCAL RAG across the indexed portfolio and prints the synthesized
 * answer with cited sources. All code stays on-machine by default — cloud is
 * NEVER used unless --allow-cloud is explicitly passed AND a key exists.
 *
 * Usage:
 *   ashlr ask "<question>" [--repo <path>] [--allow-cloud] [--json]
 *
 * Exit codes: 0 success, 1 error, 2 bad usage.
 */

import path from 'node:path';
import { pad, makeColors, isTty } from './ui.js';
import { isEnrolled } from '../core/sandbox/policy.js';

// ─── Lazy imports (graceful degradation if M25 modules not yet built) ────────

type AskFn = (
  question: string,
  opts: { repo?: string; allowCloud: boolean },
) => Promise<import('../core/types.js').AskResult>;

let _ask: AskFn | null | undefined = undefined;

async function importAsk(): Promise<AskFn | null> {
  if (_ask === undefined) {
    try {
      const mod = (await import('../core/knowledge/ask.js')) as { ask: AskFn };
      _ask = mod.ask;
    } catch {
      _ask = null;
    }
  }
  return _ask ?? null;
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

interface ParsedAskArgs {
  question: string;
  repo: string | undefined;
  allowCloud: boolean;
  json: boolean;
  help: boolean;
  error: string | undefined;
}

function parseAskArgs(args: string[]): ParsedAskArgs {
  let question: string | undefined;
  let repo: string | undefined;
  let allowCloud = false;
  let json = false;
  let help = false;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--allow-cloud') {
      allowCloud = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--repo') {
      const next = args[++i];
      if (!next || next.startsWith('--')) {
        error = '--repo requires a path argument';
        break;
      }
      repo = next;
    } else if (!a.startsWith('--')) {
      // Positional: the question
      if (question === undefined) {
        question = a;
      } else {
        // Multiple positional args — join them as the question
        question = question + ' ' + a;
      }
    } else {
      error = `Unknown flag: ${a}`;
      break;
    }
  }

  if (!error && !help && !question) {
    error = 'A question is required. Usage: ashlr ask "<question>"';
  }

  return { question: question ?? '', repo, allowCloud, json, help, error };
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const tty = isTty();
  const { bold, cyan, dim, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold('  ashlr ask') + dim(' — LOCAL RAG across the indexed portfolio'));
  out('');
  out('  ' + bold('Usage:'));
  out(`    ${cyan('ashlr ask "<question>"')} [--repo <path>] [--allow-cloud] [--json]`);
  out('');
  out('  ' + bold('Options:'));

  const opts: [string, string][] = [
    ['--repo <path>', 'Scope the search to a single enrolled repo (absolute path).'],
    ['--allow-cloud', 'Allow cloud model for synthesis if local is unavailable. SENDS CODE TO CLOUD.'],
    ['--json',        'Emit AskResult as JSON on stdout instead of human-readable output.'],
    ['--help',        'Show this help.'],
  ];
  const w = Math.max(...opts.map(([f]) => f.length));
  for (const [flag, desc] of opts) {
    out(`    ${cyan(pad(flag, w))}  ${desc}`);
  }

  out('');
  out('  ' + bold('Examples:'));
  out(`    ${cyan('ashlr ask "how does the orchestrator handle retries"')}`);
  out(`    ${cyan('ashlr ask "what deps are shared across repos"')}`);
  out(`    ${cyan('ashlr ask "where is auth logic" --repo ~/projects/my-app')}`);
  out(`    ${cyan('ashlr ask "summarize the run pipeline" --json')}`);
  out('');
  out('  ' + gray('Run `ashlr knowledge build` first to index enrolled repos.'));
  out('');
}

// ─── Human-readable output ───────────────────────────────────────────────────

function printAskHuman(result: import('../core/types.js').AskResult): void {
  const tty = isTty();
  const { bold, cyan, dim, green, yellow, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold('  Answer') + gray(` [${result.method} · ${result.local ? 'local' : 'cloud'}]`));
  out('');

  // Indent the answer body
  const lines = result.answer.split('\n');
  for (const line of lines) {
    out('  ' + line);
  }
  out('');

  if (result.sources.length === 0) {
    out(dim('  (no sources cited)'));
    out('');
    return;
  }

  out(bold('  Sources:'));
  const srcW = Math.max(
    ...result.sources.map(s => `${s.repo}:${s.file}`.length),
    12,
  );
  for (const src of result.sources) {
    const loc = `${src.repo}:${src.file}`;
    const lineRef = src.line > 0 ? yellow(`L${src.line}`) : dim('—');
    out(`    ${cyan(pad(loc, srcW))}  ${lineRef}`);
  }
  out('');

  if (!result.local) {
    out(green('  ') + yellow('Note: answer was synthesized using a CLOUD model (--allow-cloud was set).'));
    out('');
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * `ashlr ask "<question>" [--repo <path>] [--allow-cloud] [--json]`
 *
 * LOCAL RAG over the indexed portfolio. Default path: local model only, all
 * code stays on-machine. --allow-cloud opts into cloud synthesis (prints a
 * clear warning before sending code off-machine).
 *
 * Exit codes: 0 success, 1 runtime error, 2 bad usage.
 */
export async function cmdAsk(args: string[]): Promise<number> {
  const parsed = parseAskArgs(args);

  if (parsed.help) {
    printHelp();
    return 0;
  }

  if (parsed.error) {
    process.stderr.write('error: ' + parsed.error + '\n');
    process.stderr.write('Run `ashlr ask --help` for usage.\n');
    return 2;
  }

  const tty = isTty();
  const { bold, yellow, red, dim, cyan } = makeColors(tty);

  // ── ENROLLMENT-SCOPED: reject a non-enrolled --repo before any retrieval ──
  // (CONTRACT-M25 invariant 3: ask is enrolled-repos-only.) Resolve to absolute
  // and validate; loadChunks would silently return [] otherwise.
  let scopedRepo: string | undefined = parsed.repo;
  if (parsed.repo !== undefined) {
    const abs = path.resolve(parsed.repo);
    if (!isEnrolled(abs)) {
      process.stderr.write(
        red('error: ') +
        `not enrolled: ${parsed.repo}\n` +
        '       ask is scoped to enrolled repos. Enroll first: ashlr enroll add <path>\n',
      );
      return 1;
    }
    scopedRepo = abs;
  }

  // ── Privacy warning for --allow-cloud ────────────────────────────────────
  if (parsed.allowCloud && !parsed.json) {
    process.stderr.write(
      yellow('warning: ') +
      '--allow-cloud is set — repository code chunks MAY be sent to a cloud model for synthesis.\n' +
      '         Omit --allow-cloud to keep all code on-machine (default).\n',
    );
  }

  // ── Load the ask module ───────────────────────────────────────────────────
  const askFn = await importAsk();
  if (!askFn) {
    process.stderr.write(
      red('error: ') +
      'ask command requires src/core/knowledge/ask.ts (M25 module not yet built).\n',
    );
    return 1;
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  let result: import('../core/types.js').AskResult;
  try {
    result = await askFn(parsed.question, {
      repo: scopedRepo,
      allowCloud: parsed.allowCloud,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Hint when nothing is indexed yet
    if (
      msg.toLowerCase().includes('no chunks') ||
      msg.toLowerCase().includes('not indexed') ||
      msg.toLowerCase().includes('empty')
    ) {
      process.stderr.write(
        red('error: ') + 'No knowledge indexed yet.\n' +
        dim('  Run ') + cyan('ashlr knowledge build') + dim(' to index enrolled repos first.\n'),
      );
      return 1;
    }

    process.stderr.write(red('error: ') + msg + '\n');
    return 1;
  }

  // ── No chunks found: hint to build ───────────────────────────────────────
  if (result.sources.length === 0 && !result.answer.trim()) {
    if (parsed.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      process.stderr.write(
        dim('No knowledge indexed') +
        (parsed.repo ? ` for repo: ${parsed.repo}` : '') + '.\n',
      );
      process.stderr.write(
        dim('  Run ') + cyan('ashlr knowledge build') +
        (parsed.repo ? ` --repo ${parsed.repo}` : '') +
        dim(' to index enrolled repos.\n'),
      );
    }
    return 1;
  }

  // ── Output ────────────────────────────────────────────────────────────────
  if (parsed.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    // Hint when nothing is indexed but the module returned something
    if (result.sources.length === 0) {
      process.stderr.write(
        bold('Hint: ') +
        dim('no sources found — run ') +
        cyan('ashlr knowledge build') +
        dim(' to index enrolled repos.\n'),
      );
    }
    printAskHuman(result);
  }

  return 0;
}
