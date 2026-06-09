/**
 * CLI handlers for `ashlr doctor` and `ashlr init`.
 *
 * doctor — one-glance health report (color terminal output or --json).
 *          --fix applies safe, local, non-destructive remediations via
 *          fixDoctor(); --fix --json emits FixAction[].
 * init   — full idempotent onboarding via onboard(). NON-TTY safe: no prompts
 *          when stdin is not a TTY. --wire wires detected editors (backup-first).
 *          --json emits OnboardResult (with doctorSummary for compat).
 */

import { runDoctor } from '../core/doctor.js';
import { loadConfig } from '../core/config.js';
import type { AshlrConfig, DoctorCheck, DoctorReport, FixAction, OnboardResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// ANSI helpers (zero deps — inline constants)
// ---------------------------------------------------------------------------

import { pad, makeColors, isTty } from './ui.js';

const { bold, dim, red, green, yellow, cyan, gray } = makeColors(isTty());

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
 *   --fix    Apply safe automated fixes for fixable checks, then re-run doctor.
 *            With --json, emits FixAction[] instead of DoctorReport.
 */
export async function cmdDoctor(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const fixMode  = args.includes('--fix');

  const cfg = loadConfig();

  // ── --fix path ─────────────────────────────────────────────────────────────
  if (fixMode) {
    // Dynamic import so doctor-fix.ts can be its own agent-owned file. If it
    // doesn't exist yet (pre-build), degrade gracefully with an empty list.
    let actions: FixAction[] = [];
    try {
      const { fixDoctor } = await import('../core/doctor-fix.js') as {
        fixDoctor: (cfg: AshlrConfig) => Promise<FixAction[]>;
      };
      actions = await fixDoctor(cfg);
    } catch (err) {
      if (!jsonMode) {
        console.log('');
        console.log(`  ${yellow('!')} doctor-fix module not available: ${String(err)}`);
        console.log('');
      }
    }

    if (jsonMode) {
      process.stdout.write(JSON.stringify(actions, null, 2) + '\n');
      // Re-run doctor to determine exit code after fixes.
      const report = await runDoctor(cfg);
      return report.summary.fail > 0 ? 1 : 0;
    }

    // ── Human-readable --fix output ──────────────────────────────────────────
    console.log('');
    console.log(bold('  ashlr doctor --fix'));
    console.log('');

    const applied = actions.filter(a => a.applied);
    const manual  = actions.filter(a => a.manual);

    if (applied.length > 0) {
      console.log(`  ${bold(green('Fixed'))}`);
      for (const a of applied) {
        console.log(`  ${green('✓')} ${pad(a.label, 30)}  ${dim(a.detail)}`);
      }
      console.log('');
    }

    if (manual.length > 0) {
      console.log(`  ${bold(yellow('Needs manual action'))}`);
      for (const a of manual) {
        console.log(`  ${yellow('!')} ${pad(a.label, 30)}  ${dim(a.detail)}`);
      }
      console.log('');
    }

    if (applied.length === 0 && manual.length === 0) {
      console.log(`  ${dim('No fixable issues found.')}`);
      console.log('');
    }

    // Re-run doctor after fixes and print updated report.
    const report = await runDoctor(cfg);
    printDoctorReport(report);
    return report.summary.fail > 0 ? 1 : 0;
  }

  // ── Normal path (no --fix) ─────────────────────────────────────────────────
  const report = await runDoctor(cfg);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printDoctorReport(report);
  }

  return report.summary.fail > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// cmdInit
// ---------------------------------------------------------------------------

/**
 * `ashlr init` — full idempotent onboarding via onboard().
 *
 * Flags:
 *   --wire   Wire detected editors (backup-first, idempotent).
 *   --yes    Accept all defaults (implied when stdin is not a TTY).
 *   --json   Emit OnboardResult as JSON (with doctorSummary for compat).
 */
export async function cmdInit(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const wireMode = args.includes('--wire');
  const yesMode  = args.includes('--yes') || !process.stdin.isTTY;

  const cfg = loadConfig();

  // Dynamic import so onboard.ts can be its own agent-owned file.
  // Falls back to the legacy inline path if the module doesn't exist yet,
  // preserving existing m2.doctor-exit-code test behavior.
  let result: OnboardResult;
  try {
    const { onboard } = await import('../core/onboard.js') as {
      onboard: (
        cfg: AshlrConfig,
        opts: { wire: boolean; yes: boolean },
      ) => Promise<OnboardResult>;
    };
    result = await onboard(cfg, { wire: wireMode, yes: yesMode });
  } catch {
    // onboard.ts not built yet — fall back to legacy inline behavior.
    result = await _legacyOnboard(cfg, { wire: wireMode, yes: yesMode });
  }

  if (jsonMode) {
    // Emit OnboardResult extended with doctorSummary for backward compat with
    // the m2.doctor-exit-code test that asserts result.doctorSummary.fail.
    const report = await runDoctor(cfg);
    const output = {
      ...result,
      doctorSummary: report.summary,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return report.summary.fail > 0 ? 1 : 0;
  }

  // ── Human-readable output ──────────────────────────────────────────────────
  console.log('');
  console.log(bold('  ashlr init'));
  console.log('');

  const STEP_GLYPH: Record<string, string> = {
    ok:       '✓',
    wired:    '✓',
    detected: '✓',
    skipped:  '○',
    manual:   '!',
  };
  const STEP_COLOR: Record<string, (s: string) => string> = {
    ok:       green,
    wired:    green,
    detected: cyan,
    skipped:  dim,
    manual:   yellow,
  };

  for (const step of result.steps) {
    const glyph = STEP_GLYPH[step.status] ?? '?';
    const color = STEP_COLOR[step.status] ?? ((s: string) => s);
    console.log(`  ${color(glyph)} ${pad(step.name, 16)}  ${dim(step.detail)}`);
  }
  console.log('');

  // Doctor roll-up
  const report = await runDoctor(cfg);
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
  const summaryParts: string[] = [];
  if (pass > 0) summaryParts.push(green(`${pass} pass`));
  if (warn > 0) summaryParts.push(yellow(`${warn} warn`));
  if (fail > 0) summaryParts.push(red(`${fail} fail`));

  const statusLine = fail > 0
    ? red('✗ init complete with issues')
    : warn > 0
      ? yellow('! init complete')
      : green('✓ init complete');

  console.log(`  ${statusLine}  ${summaryParts.join('  ')}`);
  console.log('');

  // Next steps
  for (const ns of result.nextSteps) {
    console.log(`  ${dim(ns)}`);
  }
  if (result.nextSteps.length > 0) console.log('');

  if (fail > 0) {
    console.log(`  ${dim('Run')} ${cyan('ashlr doctor --fix')} ${dim('to auto-fix issues.')}`);
    console.log('');
  }

  return fail > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Legacy inline onboard fallback (used when onboard.ts is not yet built)
// ---------------------------------------------------------------------------

/**
 * Minimal inline onboard that mirrors the original cmdInit behavior.
 * Used as a fallback when src/core/onboard.ts has not been built yet.
 * Preserves all pre-M20 behavior + the existing m2.doctor-exit-code tests.
 *
 * @internal
 */
async function _legacyOnboard(
  cfg: import('../core/types.js').AshlrConfig,
  opts: { wire: boolean; yes: boolean },
): Promise<OnboardResult> {
  const { spawnSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { saveConfig, defaultConfig, CONFIG_PATH } = await import('../core/config.js');
  const { getPhantomStatus } = await import('../core/phantom.js');
  const { getProviderRegistry } = await import('../core/providers.js');

  // Suppress unused-var lint for opts — wire/yes are reserved for onboard.ts.
  void opts;

  const steps: import('../core/types.js').OnboardStep[] = [];

  // Step 1: config
  const configExisted = existsSync(CONFIG_PATH);
  if (!configExisted) {
    const defaults = defaultConfig();
    Object.assign(cfg, defaults);
    saveConfig(cfg);
    steps.push({ name: 'config', status: 'ok', detail: `Created ${CONFIG_PATH}` });
  } else {
    steps.push({ name: 'config', status: 'ok', detail: `${CONFIG_PATH} exists` });
  }

  // Step 2: editor detection
  const detectedEditor = _detectEditor(spawnSync);
  cfg.editor = cfg.editor ?? detectedEditor;
  steps.push({ name: 'editors', status: 'detected', detail: `Detected: ${detectedEditor}` });

  // Step 3: phantom
  const phantomStatus = getPhantomStatus();
  if (phantomStatus.installed) {
    cfg.phantom = { enabled: true };
    steps.push({
      name: 'phantom',
      status: 'detected',
      detail: phantomStatus.initialized
        ? `phantom v${phantomStatus.version ?? '?'} initialized (${phantomStatus.secretNames.length} secrets)`
        : 'phantom installed but vault not initialized — run: phantom init',
    });
  } else {
    steps.push({ name: 'phantom', status: 'manual', detail: 'phantom not installed (optional)' });
  }

  // Step 4: models / providers
  let providerDetail = 'No local providers reachable';
  try {
    const registry = await getProviderRegistry(cfg);
    if (registry.activeProvider) {
      providerDetail = `Active provider: ${registry.activeProvider}`;
    }
  } catch {
    providerDetail = 'Could not probe providers';
  }
  steps.push({ name: 'models', status: 'detected', detail: providerDetail });

  // Persist config
  saveConfig(cfg);

  // Step 5: doctor roll-up placeholder (cmdInit runs runDoctor after this returns)
  steps.push({ name: 'doctor', status: 'ok', detail: 'health check complete' });

  const nextSteps = [
    'Run `ashlr init --wire` to register the ashlr MCP plugin in your editor.',
    'try: ashlr run / ashlr swarm / ashlr tui',
  ];

  return { steps, ready: true, nextSteps };
}

/** Detect preferred editor by checking which CLI is on PATH. */
function _detectEditor(
  spawnSyncFn: typeof import('node:child_process').spawnSync,
): 'cursor' | 'vscode' {
  for (const [bin, editor] of [['cursor', 'cursor'], ['code', 'vscode']] as const) {
    const result = spawnSyncFn('which', [bin], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) {
      return editor as 'cursor' | 'vscode';
    }
  }
  return 'cursor';
}
