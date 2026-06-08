/**
 * CLI handlers for `ashlr doctor` and `ashlr init`.
 *
 * doctor — one-glance health report (color terminal output or --json).
 * init   — idempotent onboarding: ensure config, detect providers + phantom,
 *           set editor, persist config. NON-TTY safe: never prompts when stdin
 *           is not a TTY (--yes / pipe-friendly). Supports --json for machine
 *           output.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { loadConfig, saveConfig, defaultConfig, CONFIG_PATH } from '../core/config.js';
import { runDoctor } from '../core/doctor.js';
import { getPhantomStatus } from '../core/phantom.js';
import { getProviderRegistry } from '../core/providers.js';
import type { AshlrConfig, DoctorCheck, DoctorReport } from '../core/types.js';

// ---------------------------------------------------------------------------
// ANSI helpers (zero deps — inline constants)
// ---------------------------------------------------------------------------

const IS_TTY = process.stdout.isTTY === true;

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  cyan:    '\x1b[36m',
  gray:    '\x1b[90m',
} as const;

function colorize(code: string, s: string): string {
  if (!IS_TTY) return s;
  return `${code}${s}${C.reset}`;
}

function bold(s: string):    string { return colorize(C.bold,    s); }
function dim(s: string):     string { return colorize(C.dim,     s); }
function red(s: string):     string { return colorize(C.red,     s); }
function green(s: string):   string { return colorize(C.green,   s); }
function yellow(s: string):  string { return colorize(C.yellow,  s); }
function cyan(s: string):    string { return colorize(C.cyan,    s); }
function gray(s: string):    string { return colorize(C.gray,    s); }

/** Strip ANSI escape codes (for measuring display width). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Left-pad a possibly-ANSI-colored string to a visible width. */
function pad(s: string, width: number): string {
  const vis = stripAnsi(s).length;
  return s + ' '.repeat(Math.max(0, width - vis));
}

// ---------------------------------------------------------------------------
// Doctor output helpers
// ---------------------------------------------------------------------------

const GLYPH: Record<string, string> = {
  pass: '✓',
  warn: '!',
  fail: '✗',
};

const STATUS_COLOR: Record<string, (s: string) => string> = {
  pass: green,
  warn: yellow,
  fail: red,
};

function formatCheck(check: DoctorCheck): string {
  const glyph  = GLYPH[check.status] ?? '?';
  const color  = STATUS_COLOR[check.status] ?? ((s: string) => s);
  const status = color(`${glyph} ${check.label}`);
  const detail = dim(check.detail);
  let line = `  ${pad(status, 40)}  ${detail}`;
  if (check.fix) {
    line += `\n  ${gray('   fix:')} ${cyan(check.fix)}`;
  }
  return line;
}

function printDoctorReport(report: DoctorReport): void {
  const { checks, summary, generatedAt } = report;

  console.log('');
  console.log(bold('  ashlr doctor') + gray(`  — ${new Date(generatedAt).toLocaleString()}`));
  console.log('');

  // Group by status in display order: fail → warn → pass
  const groups: Array<{ label: string; statuses: string[] }> = [
    { label: 'Failures',  statuses: ['fail'] },
    { label: 'Warnings',  statuses: ['warn'] },
    { label: 'Passing',   statuses: ['pass'] },
  ];

  for (const { label, statuses } of groups) {
    const group = checks.filter(c => statuses.includes(c.status));
    if (group.length === 0) continue;

    const headerColor = statuses[0] === 'fail' ? red
                      : statuses[0] === 'warn' ? yellow
                      : green;
    console.log(`  ${bold(headerColor(label))}`);
    for (const check of group) {
      console.log(formatCheck(check));
    }
    console.log('');
  }

  // Summary line
  const parts: string[] = [];
  if (summary.pass > 0)  parts.push(green(`${summary.pass} pass`));
  if (summary.warn > 0)  parts.push(yellow(`${summary.warn} warn`));
  if (summary.fail > 0)  parts.push(red(`${summary.fail} fail`));

  console.log(`  ${parts.join('  ')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdDoctor
// ---------------------------------------------------------------------------

/**
 * `ashlr doctor` — print a health report. Exits 1 if any check fails.
 *
 * Flags:
 *   --json   Emit the DoctorReport as JSON on stdout (no color).
 */
export async function cmdDoctor(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');

  const cfg = loadConfig();
  const report = await runDoctor(cfg);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printDoctorReport(report);
  }

  return report.summary.fail > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// cmdInit helpers
// ---------------------------------------------------------------------------

/** Prompt for a line via readline, or return `defaultVal` when not a TTY. */
async function prompt(question: string, defaultVal: string): Promise<string> {
  if (!process.stdin.isTTY) return defaultVal;

  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [${defaultVal}]: `, answer => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

/** Detect preferred editor by checking which CLI is on PATH. */
function detectEditor(): 'cursor' | 'vscode' {
  // Prefer Cursor; fall back to VS Code
  for (const [bin, editor] of [['cursor', 'cursor'], ['code', 'vscode']] as const) {
    const result = spawnSync('which', [bin], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) {
      return editor as 'cursor' | 'vscode';
    }
  }
  return 'cursor'; // default
}

/** Result shape for JSON machine output from `ashlr init`. */
interface InitResult {
  configPath: string;
  configCreated: boolean;
  editor: string;
  phantom: {
    installed: boolean;
    initialized: boolean;
    secretCount: number;
  };
  providers: Array<{
    id: string;
    url: string;
    up: boolean;
    modelCount: number;
  }>;
  activeProvider: string | null;
  doctorSummary: { pass: number; warn: number; fail: number };
}

// ---------------------------------------------------------------------------
// cmdInit
// ---------------------------------------------------------------------------

/**
 * `ashlr init` — idempotent onboarding.
 *
 * Flags:
 *   --yes    Accept all defaults (implied when stdin is not a TTY).
 *   --json   Emit structured InitResult JSON on stdout.
 */
export async function cmdInit(args: string[]): Promise<number> {
  const jsonMode  = args.includes('--json');
  const yesMode   = args.includes('--yes') || !process.stdin.isTTY;

  // ── Step 1: Ensure config exists ──────────────────────────────────────────
  const configExisted = existsSync(CONFIG_PATH);
  let cfg: AshlrConfig;

  if (!configExisted) {
    cfg = defaultConfig();
    if (!jsonMode) {
      console.log('');
      console.log(bold('  ashlr init'));
      console.log('');
      console.log(`  ${yellow('Config not found.')} Creating ${cyan(CONFIG_PATH)}`);
    }
  } else {
    cfg = loadConfig();
    if (!jsonMode) {
      console.log('');
      console.log(bold('  ashlr init') + gray(`  — updating ${CONFIG_PATH}`));
      console.log('');
    }
  }

  // ── Step 2: Editor detection / selection ──────────────────────────────────
  const detectedEditor = detectEditor();
  let chosenEditor: 'cursor' | 'vscode';

  if (yesMode) {
    // Use detected editor (or preserve existing if already set to something valid)
    chosenEditor = cfg.editor ?? detectedEditor;
  } else {
    if (!jsonMode) {
      console.log(`  ${dim('Detected editor:')} ${cyan(detectedEditor)}`);
    }
    const answer = await prompt(
      `  Editor (cursor/vscode)`,
      cfg.editor ?? detectedEditor,
    );
    chosenEditor = (answer === 'vscode') ? 'vscode' : 'cursor';
  }

  cfg.editor = chosenEditor;

  if (!jsonMode && !yesMode) {
    console.log(`  ${green('✓')} editor = ${cyan(chosenEditor)}`);
    console.log('');
  }

  // ── Step 3: Phantom detection ─────────────────────────────────────────────
  const phantomStatus = getPhantomStatus();

  if (!jsonMode) {
    if (phantomStatus.installed) {
      const initStr = phantomStatus.initialized
        ? green('initialized')
        : yellow('not initialized');
      const secretStr = phantomStatus.initialized
        ? dim(` — ${phantomStatus.secretNames.length} secret(s)`)
        : '';
      console.log(`  ${green('✓')} phantom ${phantomStatus.version ? gray(`v${phantomStatus.version}`) : ''} ${initStr}${secretStr}`);
      if (phantomStatus.initialized && phantomStatus.secretNames.length > 0) {
        console.log(`  ${gray('   secrets:')} ${phantomStatus.secretNames.map(n => cyan(n)).join(', ')}`);
      }
      if (!phantomStatus.initialized) {
        console.log(`  ${gray('   run:')} ${cyan('phantom init')} to initialize a vault`);
      }
    } else {
      console.log(`  ${yellow('!')} phantom not installed  ${dim('(optional — secrets manager)')}`);
      console.log(`  ${gray('   install:')} ${cyan('brew install phantom-secrets-mcp/phantom/phantom')}`);
    }
    console.log('');
  }

  // Persist phantom.enabled if installed — reuse the already-computed status
  // rather than re-spawning `phantom --version`.
  if (phantomStatus.installed) {
    cfg.phantom = { enabled: true };
  }

  // ── Step 4: Provider probe ────────────────────────────────────────────────
  if (!jsonMode) {
    console.log(`  ${dim('Probing local model providers…')}`);
  }

  const registry = await getProviderRegistry(cfg);

  if (!jsonMode) {
    for (const provider of registry.providers) {
      if (provider.up) {
        const modelList = provider.models.length > 0
          ? dim(` — ${provider.models.slice(0, 3).join(', ')}${provider.models.length > 3 ? ` +${provider.models.length - 3} more` : ''}`)
          : '';
        console.log(`  ${green('✓')} ${cyan(provider.id)} ${green('up')} ${gray(provider.url)}${modelList}`);
      } else {
        const errStr = provider.error ? dim(` (${provider.error})`) : '';
        console.log(`  ${dim('○')} ${pad(provider.id, 10)} ${gray('down')} ${gray(provider.url)}${errStr}`);
      }
    }

    if (registry.activeProvider) {
      console.log(`  ${dim('active provider:')} ${cyan(registry.activeProvider)}`);
    } else {
      console.log(`  ${yellow('!')} No local providers reachable — remote fallback only`);
    }
    console.log('');
  }

  // ── Step 5: Persist config ────────────────────────────────────────────────
  saveConfig(cfg);

  if (!jsonMode) {
    const verb = configExisted ? 'Updated' : 'Created';
    console.log(`  ${green('✓')} ${verb} ${cyan(CONFIG_PATH)}`);
    console.log('');
  }

  // ── Step 6: Doctor summary ────────────────────────────────────────────────
  const report = await runDoctor(cfg);

  if (jsonMode) {
    const result: InitResult = {
      configPath: CONFIG_PATH,
      configCreated: !configExisted,
      editor: chosenEditor,
      phantom: {
        installed: phantomStatus.installed,
        initialized: phantomStatus.initialized,
        secretCount: phantomStatus.secretNames.length,
      },
      providers: registry.providers.map(p => ({
        id: p.id,
        url: p.url,
        up: p.up,
        modelCount: p.models.length,
      })),
      activeProvider: registry.activeProvider,
      doctorSummary: report.summary,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    // Print abbreviated doctor summary (just counts + any failures/warnings)
    const failChecks = report.checks.filter(c => c.status === 'fail');
    const warnChecks = report.checks.filter(c => c.status === 'warn');

    if (failChecks.length > 0 || warnChecks.length > 0) {
      console.log(`  ${bold('Health checks:')}`);
      for (const check of [...failChecks, ...warnChecks]) {
        console.log(formatCheck(check));
      }
      console.log('');
    }

    const { pass, warn, fail } = report.summary;
    const parts: string[] = [];
    if (pass > 0) parts.push(green(`${pass} pass`));
    if (warn > 0) parts.push(yellow(`${warn} warn`));
    if (fail > 0) parts.push(red(`${fail} fail`));

    const statusLine = fail > 0
      ? red('✗ init complete with issues')
      : warn > 0
        ? yellow('! init complete')
        : green('✓ init complete');

    console.log(`  ${statusLine}  ${parts.join('  ')}`);
    console.log('');

    if (fail > 0) {
      console.log(`  ${dim('Run')} ${cyan('ashlr doctor')} ${dim('for full details.')}`);
      console.log('');
    }
  }

  return report.summary.fail > 0 ? 1 : 0;
}
