/**
 * `ashlr eval` — M44 local-agent eval harness.
 *
 * Runs a fixed set of small coding/reasoning goals (see eval-fixtures.ts)
 * through the hub's own agent loop TWICE per fixture — once with adaptive
 * prompts OFF, once ON — and reports per-fixture metrics (steps-to-done,
 * status, tokens). This is the "proof" milestone for the M41–M43 uplift.
 *
 * Adaptive prompts are toggled via the ASHLR_ADAPTIVE_PROMPTS env var, which
 * adaptivePromptsEnabled(cfg) reads FIRST (before cfg.models.adaptivePrompts).
 *
 *   ashlr eval [--budget N] [--limit N] [--json]
 *
 * Exit codes:
 *   0  always (even when no local model — prints a clear hint and returns 0)
 */

import type { RunOptions, RunState, AshlrConfig } from '../core/types.js';
import { EVAL_FIXTURES, type EvalFixture } from './eval-fixtures.js';
import { makeColors, isTty, pad } from './ui.js';

const { bold, dim, yellow, red, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Public, pure data shapes (testable without runGoal)
// ---------------------------------------------------------------------------

/** Per-fixture result after running OFF then ON. */
export interface EvalRow {
  id: string;
  goal: string;
  /** Steps taken with adaptive prompts OFF. */
  stepsOff: number;
  /** Steps taken with adaptive prompts ON. */
  stepsOn: number;
  /** Whether the OFF run reached status 'done'. */
  doneOff: boolean;
  /** Whether the ON run reached status 'done'. */
  doneOn: boolean;
  /** Total tokens (in+out) for the OFF run. */
  tokensOff: number;
  /** Total tokens (in+out) for the ON run. */
  tokensOn: number;
  /** Set when the fixture failed to run at all (caught error). */
  error?: string;
}

/** Aggregate over all rows. */
export interface EvalSummary {
  fixtures: number;
  totalStepsOff: number;
  totalStepsOn: number;
  doneOff: number;
  doneOn: number;
  totalTokensOff: number;
  totalTokensOn: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing
// ---------------------------------------------------------------------------

/** Aggregate EvalRows into a summary. Pure. */
export function summarize(rows: EvalRow[]): EvalSummary {
  const s: EvalSummary = {
    fixtures: rows.length,
    totalStepsOff: 0,
    totalStepsOn: 0,
    doneOff: 0,
    doneOn: 0,
    totalTokensOff: 0,
    totalTokensOn: 0,
    errors: 0,
  };
  for (const r of rows) {
    s.totalStepsOff += r.stepsOff;
    s.totalStepsOn += r.stepsOn;
    s.totalTokensOff += r.tokensOff;
    s.totalTokensOn += r.tokensOn;
    if (r.doneOff) s.doneOff++;
    if (r.doneOn) s.doneOn++;
    if (r.error) s.errors++;
  }
  return s;
}

/**
 * Render a plain (no-color) eval table + summary as a string. Pure — does no
 * I/O, takes no color dependencies, so it's deterministic and unit-testable.
 *
 * Columns: id | off(done/steps/tokens) | on(done/steps/tokens).
 */
export function formatEvalTable(rows: EvalRow[]): string {
  const idW = Math.max(8, ...rows.map((r) => r.id.length));
  const cell = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const num = (n: number) => String(n);
  const doneMark = (b: boolean) => (b ? 'done' : 'fail');

  const lines: string[] = [];
  lines.push('Adaptive prompts: OFF vs ON');
  lines.push('');
  lines.push(
    `${cell('id', idW)}  ${cell('off:done', 10)} ${cell('off:steps', 10)} ${cell('off:tok', 10)}  ` +
      `${cell('on:done', 10)} ${cell('on:steps', 10)} ${cell('on:tok', 10)}`,
  );
  lines.push('-'.repeat(idW + 2 + 33 + 2 + 33));
  for (const r of rows) {
    if (r.error) {
      lines.push(`${cell(r.id, idW)}  ERROR: ${r.error}`);
      continue;
    }
    lines.push(
      `${cell(r.id, idW)}  ` +
        `${cell(doneMark(r.doneOff), 10)} ${cell(num(r.stepsOff), 10)} ${cell(num(r.tokensOff), 10)}  ` +
        `${cell(doneMark(r.doneOn), 10)} ${cell(num(r.stepsOn), 10)} ${cell(num(r.tokensOn), 10)}`,
    );
  }

  const s = summarize(rows);
  lines.push('');
  lines.push(
    `TOTAL  fixtures=${s.fixtures}  done OFF=${s.doneOff}/${s.fixtures} ON=${s.doneOn}/${s.fixtures}  ` +
      `steps OFF=${s.totalStepsOff} ON=${s.totalStepsOn}  ` +
      `tokens OFF=${s.totalTokensOff} ON=${s.totalTokensOn}` +
      (s.errors ? `  errors=${s.errors}` : ''),
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Arg parsing (minimal — mirrors run.ts style)
// ---------------------------------------------------------------------------

interface ParsedEvalArgs {
  budget: number;
  limit?: number;
  json: boolean;
  usageError?: string;
}

const DEFAULT_EVAL_BUDGET = 4000;

function parseEvalArgs(args: string[]): ParsedEvalArgs {
  const result: ParsedEvalArgs = { budget: DEFAULT_EVAL_BUDGET, json: false };
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--budget') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        result.usageError = '--budget requires a positive number';
        return result;
      }
      result.budget = Math.floor(v);
      i++;
    } else if (arg === '--limit') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        result.usageError = '--limit requires a positive number';
        return result;
      }
      result.limit = Math.floor(v);
      i++;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Run one fixture twice (OFF then ON)
// ---------------------------------------------------------------------------

type RunGoalFn = (goal: string, cfg: AshlrConfig, opts: RunOptions) => Promise<RunState>;

function buildOpts(budget: number): RunOptions {
  // noCapture lives on the run.ts parse layer (not on RunOptions), so we attach
  // it via the same extra-prop escape hatch the CLI uses; it's ignored if unread.
  const opts: RunOptions & { noCapture?: boolean } = {
    budget: { maxTokens: budget },
    parallel: 1,
    tools: false,
    json: true,
    noMemory: true,
    noCapture: true,
  };
  return opts;
}

/**
 * Run a single fixture twice. Any failure is caught and recorded on the row —
 * one bad fixture never aborts the whole eval.
 */
async function evalFixture(
  fixture: EvalFixture,
  cfg: AshlrConfig,
  budget: number,
  runGoal: RunGoalFn,
): Promise<EvalRow> {
  const row: EvalRow = {
    id: fixture.id,
    goal: fixture.goal,
    stepsOff: 0,
    stepsOn: 0,
    doneOff: false,
    doneOn: false,
    tokensOff: 0,
    tokensOn: 0,
  };

  const prev = process.env.ASHLR_ADAPTIVE_PROMPTS;
  try {
    // ── OFF ────────────────────────────────────────────────────────────────
    process.env.ASHLR_ADAPTIVE_PROMPTS = '0';
    const off = await runGoal(fixture.goal, cfg, buildOpts(budget));
    row.stepsOff = off.usage.steps;
    row.doneOff = off.status === 'done';
    row.tokensOff = off.usage.tokensIn + off.usage.tokensOut;

    // ── ON ─────────────────────────────────────────────────────────────────
    process.env.ASHLR_ADAPTIVE_PROMPTS = '1';
    const on = await runGoal(fixture.goal, cfg, buildOpts(budget));
    row.stepsOn = on.usage.steps;
    row.doneOn = on.status === 'done';
    row.tokensOn = on.usage.tokensIn + on.usage.tokensOut;
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
  } finally {
    // Restore the env var to its pre-fixture value.
    if (prev === undefined) delete process.env.ASHLR_ADAPTIVE_PROMPTS;
    else process.env.ASHLR_ADAPTIVE_PROMPTS = prev;
  }

  return row;
}

// ---------------------------------------------------------------------------
// `ashlr eval` — main
// ---------------------------------------------------------------------------

export async function cmdEval(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printEvalHelp();
    return 0;
  }

  const parsed = parseEvalArgs(args);
  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  // Load config.
  let cfg: AshlrConfig;
  try {
    const { loadConfig } = await import('../core/config.js');
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load config: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Guard: a local provider must be reachable. getActiveClient throws when no
  // local provider is up (and allowCloud:false). If so, the eval cannot run —
  // print a clear hint and return 0 (graceful, not an error).
  try {
    const { getActiveClient } = await import('../core/run/provider-client.js');
    await getActiveClient(cfg, { allowCloud: false });
  } catch {
    const msg =
      'eval needs a local model — start Ollama or LM Studio, then re-run `ashlr eval`.';
    if (parsed.json) {
      process.stdout.write(JSON.stringify({ skipped: true, reason: msg }) + '\n');
    } else {
      process.stdout.write('\n  ' + yellow('eval skipped: ') + msg + '\n\n');
    }
    return 0;
  }

  // Load orchestrator.
  let runGoal: RunGoalFn;
  try {
    const mod = await import('../core/run/orchestrator.js');
    runGoal = mod.runGoal as RunGoalFn;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load orchestrator: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  const fixtures = parsed.limit ? EVAL_FIXTURES.slice(0, parsed.limit) : EVAL_FIXTURES;

  if (!parsed.json) {
    process.stderr.write(
      seInfo(`running ${fixtures.length} fixture(s) × 2 (adaptive OFF/ON), budget ${parsed.budget} tok each\n`),
    );
  }

  const rows: EvalRow[] = [];
  for (const fixture of fixtures) {
    if (!parsed.json) {
      process.stderr.write(seInfo(`  • ${fixture.id} …\n`));
    }
    const row = await evalFixture(fixture, cfg, parsed.budget, runGoal);
    rows.push(row);
  }

  // Output.
  if (parsed.json) {
    process.stdout.write(
      JSON.stringify({ rows, summary: summarize(rows) }, null, 2) + '\n',
    );
  } else {
    console.log('');
    console.log(bold('  ashlr eval') + dim(' — M44 adaptive-prompt proof'));
    console.log('');
    for (const line of formatEvalTable(rows).split('\n')) {
      console.log('  ' + line);
    }
    console.log('');
  }

  return 0;
}

// stderr progress helper (kept terse; cyan when TTY)
function seInfo(s: string): string {
  return process.stderr.isTTY ? cyan(s) : s;
}

function printEvalHelp(): void {
  console.log('');
  console.log(bold('  ashlr eval') + dim(' — local-agent eval harness (M44)'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr eval [--budget N] [--limit N] [--json]`);
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log('');
  const opts: [string, string][] = [
    ['--budget N', `Max tokens per run (default: ${DEFAULT_EVAL_BUDGET}).`],
    ['--limit N', 'Only run the first N fixtures.'],
    ['--json', 'Emit JSON { rows, summary } instead of a table.'],
  ];
  const w = Math.max(...opts.map(([o]) => o.length));
  for (const [o, d] of opts) {
    console.log(`    ${cyan(pad(o, w))}  ${d}`);
  }
  console.log('');
  console.log('  ' + bold('What it does:'));
  console.log('');
  console.log(`    ${gray('Runs a fixed fixture set through the agent loop twice each —')}`);
  console.log(`    ${gray('adaptive prompts OFF then ON — and reports steps/done/tokens.')}`);
  console.log(`    ${gray('Needs a local model (Ollama / LM Studio); skips cleanly if none.')}`);
  console.log('');
}
