/**
 * CLI handler for `ashlr onboard` — a TTY-aware GUIDED first-activation
 * walkthrough + one-command rollback. See docs/contracts/CONTRACT-H7.md
 * (BUILD ITEM 3, 4, 5).
 *
 * H7 ABSOLUTE RULES (proven by test/h7.onboard.test.ts + test/h7.rollback.test.ts):
 *  - ONBOARD-NEVER-AUTO-APPLIES: onboard chains ONLY the pre-existing human
 *    gates — preflight (read-only) → enroll ONE repo (the explicit enrollment
 *    gate, H6-audited) → daemon --dry-run --once (read-only, creates NO proposal)
 *    → print a human-readable PLAN → point the user at `ashlr inbox` (review
 *    only). It NEVER applies/approves a proposal, NEVER pushes/PRs/deploys, and
 *    NEVER runs a live (non-dry) daemon. It imports NO outward primitive.
 *  - ROLLBACK-INWARD-ONLY: `--rollback <repo>` only narrows state — unenroll +
 *    sweepRepoSandboxes (scoped to the repo; a LIVE owner is never reclaimed) +
 *    (opt-in --kill) setKill(true). The full trail is audited by the H6 audit()
 *    inside policy.ts.
 *  - Non-interactive (--yes OR non-TTY): prints the numbered steps as guidance
 *    WITHOUT prompting and WITHOUT enrolling (mirrors cmdInit yesMode).
 *  - No new runtime deps; node builtins + existing modules only.
 *
 * Wiring: BUILD/INTEGRATION adds `case 'onboard'` + a `loadOnboardCmd` lazy
 * loader in src/cli/index.ts + a cmdHelp entry (+ optional `unenroll` alias).
 */

import { resolve } from 'node:path';
import { loadConfig } from '../core/config.js';
import { buildReadiness } from '../core/readiness.js';
import type { ReadinessReport } from '../core/readiness.js';
import { enroll, unenroll, setKill, listEnrolled } from '../core/sandbox/policy.js';
import { tick } from '../core/daemon/loop.js';
import { loadBacklog, buildBacklog } from '../core/portfolio/backlog.js';
import { sweepRepoSandboxes } from '../core/sandbox/worktree.js';
import { makeColors, isTty } from './ui.js';
import type { AshlrConfig, WorkItem } from '../core/types.js';

const { bold, dim, red, green, yellow, cyan } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Prompt — readline y/N confirm. Exported so tests can spy/mock it without
// touching a live TTY. Resolves false when stdin is not a TTY (so a non-TTY
// run NEVER enrolls; the caller's yesMode short-circuits before this anyway).
// ---------------------------------------------------------------------------

/** Interactive readline confirm (y/N). Resolves false when stdin is not a TTY. */
export async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = await import('node:readline');
  return new Promise<boolean>((resolveP) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question + ' [y/N] ', (answer) => {
      rl.close();
      resolveP(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Test seam: cmdOnboard calls the confirm prompt THROUGH this indirection object
 * so a unit test can override `confirm` without a live TTY (a direct
 * module-internal call to the exported `promptConfirm` cannot be spied across
 * the ESM boundary). Production always uses the real `promptConfirm`.
 */
export const _internals: { confirm: (question: string) => Promise<boolean> } = {
  confirm: promptConfirm,
};

// ---------------------------------------------------------------------------
// renderDryRunPlan (BUILD ITEM 5) — human-readable, dry-run (NO outward action)
// ---------------------------------------------------------------------------

/**
 * Render a HUMAN-READABLE dry-run PLAN (BUILD ITEM 5). Re-derives the same
 * would-run selection the dry-run uses (listEnrolled → buildBacklog → top-K) and
 * runs tick(cfg,{dryRun:true}) for the authoritative count. Creates NO proposal,
 * spends $0, takes NO outward action.
 *
 * WRITE NOTE (not strictly side-effect-free): the authoritative
 * tick(cfg,{dryRun:true}) persists the daemon RUN-STATE via saveDaemonState
 * before returning (loop.ts dry-run branch). That write is the pre-existing,
 * H6-audited dry-run behavior — it persists the H5-self-healed run-state flag
 * (it NEVER sets running:true and NEVER creates a proposal), is bounded to the
 * (isolated-in-tests) ~/.ashlr/daemon.json, and is never an outward action.
 * Everything else here (listEnrolled / loadBacklog / buildBacklog) is a pure
 * read.
 *
 * Sequence:
 *   1. enrolled = listEnrolled()                 (read)
 *   2. tick(cfg,{dryRun:true}) — authoritative itemsConsidered (NO proposal, $0;
 *      persists daemon run-state only — never an outward action)
 *   3. loadBacklog()/buildBacklog({repos:enrolled}) — the SAME scan the tick
 *      used, for titles (read)
 *   4. format `N item(s) across M repo(s)` + a bulleted list of the top-K titles,
 *      explicitly labelled a PLAN that creates NO proposals.
 *
 * Never throws — degrades to a legible "0 item(s)" plan on any read error.
 */
export async function renderDryRunPlan(cfg: AshlrConfig): Promise<string> {
  const enrolled = listEnrolled();

  // (2) Authoritative count from the existing read-only dry-run path. The
  // dry-run branch of tick() returns proposalsCreated:0, spentUsd:0,
  // reason:'dry-run' — it creates NO proposal and spends nothing.
  let itemsConsidered = 0;
  try {
    const t = await tick(cfg, { dryRun: true });
    itemsConsidered = t.itemsConsidered;
  } catch {
    itemsConsidered = 0;
  }

  // (3) The matching titles. Prefer the PERSISTED backlog (loadBacklog reads
  // ~/.ashlr/backlog.json — the same scored, top-score-first set the daemon last
  // computed; pure read, never throws). If none is persisted yet, fall back to a
  // fresh read-only buildBacklog scan over the enrolled repos. Both are
  // read-only and create no proposal.
  let items: WorkItem[] = [];
  try {
    const persisted = loadBacklog();
    if (persisted && persisted.items.length > 0) {
      items = persisted.items;
    } else {
      const backlog = await buildBacklog({ repos: enrolled });
      items = backlog.items;
    }
  } catch {
    items = [];
  }

  // Present exactly the top-`itemsConsidered` titles the dry-run would work.
  const planned = items.slice(0, itemsConsidered);
  const repoCount = new Set(planned.map((i) => i.repo)).size;

  const lines: string[] = [];
  lines.push(bold('  Dry-run plan') + dim('  (preview only — creates NO proposals, spends $0)'));
  lines.push('');
  if (planned.length === 0) {
    lines.push(
      `  ${dim('0 item(s) would run')}` +
        `${enrolled.length === 0 ? dim(' — no repo enrolled yet') : dim(' — backlog is empty for enrolled repo(s)')}`,
    );
  } else {
    lines.push(
      `  ${green(String(planned.length))} item(s) would run across ` +
        `${green(String(repoCount))} repo(s):`,
    );
    for (const it of planned) {
      lines.push(`    ${cyan('•')} ${it.title}${it.detail ? dim(` — ${it.detail}`) : ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// rollback (BUILD ITEM 4) — INWARD CLEANUP ONLY
// ---------------------------------------------------------------------------

/**
 * ROLLBACK (BUILD ITEM 4) — INWARD CLEANUP ONLY. In order:
 *   1. unenroll(repo)                  (H6-audited enroll:remove)
 *   2. sweepRepoSandboxes(repo)        (SCOPED to this repo; a LIVE owner is
 *                                       NEVER reclaimed; the age guard is
 *                                       dropped so a fresh crash-leftover from
 *                                       the very activation being undone IS
 *                                       reclaimed — true one-command undo)
 *   3. opts.kill ⇒ setKill(true)       (opt-in; H6-audited kill:on)
 * Returns 0. NEVER widens access; NEVER an outward action.
 */
export async function rollback(repo: string, opts: { kill: boolean }): Promise<number> {
  const abs = resolve(repo);

  // 1. Narrow the enrollment gate. Idempotent; H6-audited enroll:remove.
  unenroll(abs);

  // 2. Reclaim THIS repo's crash-leftover sandboxes (scoped). The scoped sweep
  //    drops the 6h age guard (so a FRESH leftover from the activation being
  //    undone is reclaimed too) but KEEPS the ownerAlive guard, so it NEVER
  //    force-removes a LIVE in-flight worktree; each removal inherits
  //    removeSandbox's full containment guards.
  let swept: string[] = [];
  try {
    swept = sweepRepoSandboxes(abs);
  } catch {
    swept = [];
  }

  // 3. Opt-in: pause ALL autonomy in the same step (H6-audited kill:on).
  if (opts.kill) setKill(true);

  console.log('');
  console.log(bold('  ashlr onboard --rollback'));
  console.log('');
  console.log(`  ${green('✓')} unenrolled ${dim(abs)}`);
  console.log(
    `  ${green('✓')} swept ${swept.length} leftover sandbox(es) for this repo ` +
      dim('(a live in-flight worktree is never reclaimed)'),
  );
  if (opts.kill) {
    console.log(`  ${yellow('!')} kill switch ON ${dim('— all autonomy paused')}`);
  }
  console.log('');
  console.log(`  ${dim('Re-enable any time with')} ${cyan('ashlr onboard')}.`);
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Blocker / guidance rendering
// ---------------------------------------------------------------------------

function printBlockers(report: ReadinessReport): void {
  console.log('');
  console.log(bold('  ashlr onboard') + dim('  — preflight'));
  console.log('');
  console.log(`  ${red('✗')} ${bold('not ready')} ${dim('— resolve the blocker(s) below, then re-run.')}`);
  console.log('');
  for (const b of report.blockers) {
    console.log(`  ${red('✗')} ${b.detail}${b.fix ? `\n      ${dim('fix:')} ${cyan(b.fix)}` : ''}`);
  }
  console.log('');
}

/**
 * Non-interactive guidance: print the numbered FIRST-ACTIVATION steps WITHOUT
 * prompting and WITHOUT enrolling. Mirrors cmdInit's yesMode — it DESCRIBES the
 * activation; the human still runs the explicit enroll/inbox steps themselves.
 */
function printSteps(repoHint: string): void {
  console.log('');
  console.log(bold('  ashlr onboard') + dim('  — first safe activation (steps)'));
  console.log('');
  console.log(`  ${dim('Run these in order. Each step is the explicit human gate — nothing runs on its own.')}`);
  console.log('');
  console.log(`  ${cyan('1.')} ${bold('Preflight')}   ${dim('ashlr preflight')}                      ${dim('— read-only readiness check')}`);
  console.log(`  ${cyan('2.')} ${bold('Enroll ONE')}  ${dim(`ashlr sandbox enroll ${repoHint}`)}   ${dim('— the explicit enrollment gate')}`);
  console.log(`  ${cyan('3.')} ${bold('Dry-run')}     ${dim('ashlr daemon start --dry-run --once')}    ${dim('— preview the plan; NO proposal, $0')}`);
  console.log(`  ${cyan('4.')} ${bold('Review')}      ${dim('ashlr inbox')}                          ${dim('— review + approve; NEVER auto-applied')}`);
  console.log(`  ${cyan('5.')} ${bold('Rollback')}    ${dim(`ashlr onboard --rollback ${repoHint}`)}  ${dim('— one-command undo')}`);
  console.log('');
  console.log(`  ${dim('Re-run interactively (a TTY, no --yes) to be guided through steps 1–3 automatically.')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdOnboard — the dispatcher entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr onboard` — guided first-activation walkthrough.
 *   - `--rollback <repo> [--kill]` routes to rollback().
 *   - else: preflight → (TTY) confirm + enroll ONE repo → dry-run PLAN →
 *     point at `ashlr inbox` → offer rollback.
 *   - `--yes` OR non-TTY: print the numbered steps WITHOUT prompting/enrolling.
 * Returns 0 on success, non-zero when preflight blocks.
 */
export async function cmdOnboard(args: string[]): Promise<number> {
  const cfg = loadConfig();

  // ── Rollback route ────────────────────────────────────────────────────────
  if (args.includes('--rollback')) {
    const idx = args.indexOf('--rollback');
    // The repo is the positional right after --rollback, else the first
    // non-flag positional, else cwd.
    const positional = args.filter((a, i) => !a.startsWith('--') && i !== idx + 1);
    const repo =
      args[idx + 1] && !args[idx + 1].startsWith('--')
        ? args[idx + 1]
        : positional[0] ?? process.cwd();
    const kill = args.includes('--kill');
    return rollback(repo, { kill });
  }

  // ── yesMode = non-interactive guidance (NO prompt, NO enroll) ──────────────
  const yesMode = args.includes('--yes') || !process.stdin.isTTY;

  // Candidate repo: first positional arg, else cwd.
  const repoArg = args.find((a) => !a.startsWith('--'));
  const candidate = resolve(repoArg ?? process.cwd());

  // ── Step 1: Preflight (READ-ONLY). Blockers ⇒ STOP, do nothing else. ───────
  const report = await buildReadiness(cfg);
  if (!report.ready) {
    printBlockers(report);
    return 1;
  }

  // Non-interactive: print the numbered steps and STOP — never enroll, never
  // dry-run on the user's behalf. The human runs the explicit gates.
  if (yesMode) {
    printSteps(repoArg ?? candidate);
    return 0;
  }

  // ── Interactive walkthrough ────────────────────────────────────────────────
  console.log('');
  console.log(bold('  ashlr onboard') + dim('  — first safe activation'));
  console.log('');
  console.log(
    `  ${green('✓')} ${bold('ready')}` +
      (report.warnings.length ? dim(`  (${report.warnings.length} warning(s) — non-blocking)`) : ''),
  );
  for (const w of report.warnings) {
    console.log(`    ${yellow('!')} ${dim(w.detail)}`);
  }
  for (const note of report.info) {
    console.log(`    ${dim('•')} ${dim(note.detail)}`);
  }
  console.log('');

  // ── Step 2: Enroll ONE repo (the explicit human gate; H6-audited) ──────────
  const before = listEnrolled();
  const confirmed = await _internals.confirm(`  Enroll ${cyan(candidate)} for autonomous work?`);
  if (!confirmed) {
    console.log('');
    console.log(
      `  ${dim('No repo enrolled. Re-run when ready, or run')} ${cyan('ashlr preflight')} ${dim('to re-check.')}`,
    );
    console.log('');
    return 0;
  }
  enroll(candidate); // idempotent; the ONLY mutating call in the whole flow
  const after = listEnrolled();
  console.log('');
  console.log(
    `  ${green('✓')} enrolled ${dim(candidate)} ${dim(`(${before.length} → ${after.length} repo(s))`)}`,
  );
  console.log('');

  // ── Step 3: Dry-run PLAN (READ-ONLY — NO proposal, $0 spend) ───────────────
  const plan = await renderDryRunPlan(cfg);
  console.log(plan);

  // ── Step 4: Point at the inbox (REVIEW ONLY — never auto-approve/apply) ─────
  console.log(
    `  ${bold('Next:')} review what would run with ${cyan('ashlr inbox')} ${dim('— nothing is applied until YOU approve it there.')}`,
  );
  console.log('');

  // ── Step 5: Offer the one-command rollback ─────────────────────────────────
  console.log(
    `  ${dim('Undo this activation any time:')} ${cyan(`ashlr onboard --rollback ${candidate}`)}${dim(' [--kill]')}`,
  );
  console.log('');

  return 0;
}
