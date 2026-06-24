/**
 * CLI handler for `ashlr setup` — M97 first-run setup wizard.
 *
 * Orchestrates: config → models → editors → symlink → genome → phantom →
 *   doctor → daemon-service → engines (readiness + auth guidance) →
 *   enroll (discover repos) → final readiness summary.
 *
 * Flags:
 *   --yes    Accept defaults / non-interactive (auto-enroll, skip confirmations).
 *            Implied when stdin is not a TTY. Used by the Tauri desktop app.
 *   --wire   Wire detected editors (backup-first, idempotent).
 *   --json   Emit OnboardResult as JSON on stdout.
 *
 * SAFETY:
 *   - Never auto-enters credentials. Engine auth = guidance strings only.
 *   - Non-TTY safe: no prompts, no readline.
 *   - Idempotent: safe to re-run at any time.
 */

import { loadConfig } from '../core/config.js';
import { setupWizard } from '../core/onboard.js';
import type { OnboardResult, OnboardStep } from '../core/types.js';
import { pad, makeColors, isTty } from './ui.js';

const { bold, dim, red, green, yellow, cyan } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Step rendering
// ---------------------------------------------------------------------------

const STEP_GLYPH: Record<string, string> = {
  ok:       '✓',
  wired:    '✓',
  detected: '~',
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

function renderStep(s: OnboardStep): string {
  const glyph = STEP_GLYPH[s.status] ?? '?';
  const color = STEP_COLOR[s.status] ?? ((x: string) => x);
  return `  ${color(glyph)} ${pad(s.name, 16)}  ${dim(s.detail)}`;
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

function buildSummary(steps: OnboardStep[]): string {
  // Count engine readiness from the engines step detail if present.
  const engineStep = steps.find((s) => s.name === 'engines');
  const engineSummary = engineStep?.detail.match(/(\d+)\/(\d+) engines ready/);

  const daemonStep = steps.find((s) => s.name === 'daemon-service');
  const daemonOk = daemonStep?.status === 'ok';

  const enrollStep = steps.find((s) => s.name === 'enroll');
  const enrollMatch = enrollStep?.detail.match(/(\d+) total enrolled/);
  const enrollCount = enrollMatch ? enrollMatch[1] : null;

  const parts: string[] = [];

  if (engineSummary) {
    parts.push(`${engineSummary[1]}/${engineSummary[2]} engines ready`);
  }
  if (daemonOk) {
    parts.push('daemon installed');
  } else if (daemonStep) {
    parts.push(yellow('daemon needs setup'));
  }
  if (enrollCount !== null) {
    parts.push(`${enrollCount} repo(s) enrolled`);
  } else if (enrollStep?.status === 'detected') {
    parts.push(yellow('repos pending enrollment'));
  }

  return parts.length > 0 ? parts.join(', ') : 'setup complete';
}

// ---------------------------------------------------------------------------
// cmdSetup
// ---------------------------------------------------------------------------

/**
 * `ashlr setup` — full first-run setup wizard.
 *
 * Returns 0 on success (even if some steps are 'manual' — those are advisory).
 * Returns 1 only when config is broken or a blocking doctor check fails.
 */
export async function cmdSetup(args: string[]): Promise<number> {
  const jsonMode  = args.includes('--json');
  const wireMode  = args.includes('--wire');
  const yesMode   = args.includes('--yes') || !process.stdin.isTTY;

  const cfg = loadConfig();

  let result: OnboardResult;
  try {
    result = await setupWizard(cfg, { wire: wireMode, yes: yesMode });
  } catch (err) {
    // setupWizard is guaranteed never-throw, but be defensive.
    const msg = err instanceof Error ? err.message : String(err);
    if (!jsonMode) {
      console.error(`  ${red('✗')} setup wizard failed unexpectedly: ${msg}`);
    }
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ready ? 0 : 1;
  }

  // ── Human-readable output ──────────────────────────────────────────────────
  console.log('');
  console.log(bold('  ashlr setup') + dim('  — first-run fleet wizard'));
  console.log('');

  for (const s of result.steps) {
    console.log(renderStep(s));
  }
  console.log('');

  // Summary line
  const summary = buildSummary(result.steps);
  const manualCount = result.steps.filter((s) => s.status === 'manual').length;
  const statusLine = !result.ready
    ? red('✗ setup incomplete')
    : manualCount > 0
      ? yellow('! setup complete (some steps need attention)')
      : green('✓ setup complete');

  console.log(`  ${statusLine}  ${dim(summary)}`);
  console.log('');

  // Next steps
  for (const ns of result.nextSteps) {
    if (ns.startsWith('try:')) {
      console.log(`  ${green(ns)}`);
    } else {
      console.log(`  ${dim('→')} ${cyan(ns)}`);
    }
  }
  if (result.nextSteps.length > 0) console.log('');

  return result.ready ? 0 : 1;
}
