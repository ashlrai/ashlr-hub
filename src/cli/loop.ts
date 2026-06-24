/**
 * loop.ts — M55 (v5 Open Fleet): the `ashlr loop` conductor.
 *
 * One polished front door to the continuous fleet: renders the M49 control-plane
 * snapshot (per-backend throughput, queue, merges, quota) and then runs the
 * PROVEN, proposal-first daemon over the enrolled portfolio. It is a thin wrapper
 * over `runDaemon` + `buildFleetStatus`; it adds NO new dispatch or mutation path.
 * The kill-switch + daily-budget guards live in core runDaemon/tick.
 *
 * Default is a SINGLE tick (safe; will not hang the terminal). `--watch` runs the
 * continuous loop (Ctrl-C to stop).
 *
 * SAFETY: this module imports no outward-mutation primitive — it never applies
 * proposals, opens pull requests, pushes a remote, or deploys.
 */

import { makeColors } from './ui.js';

const USAGE =
  'Usage: ashlr loop [--watch] [--dry-run]\n' +
  '\n' +
  '  Goal-aware conductor: advance active goal milestones first (frontier-planned,\n' +
  '  sandboxed, proposal-only), then fall back to the backlog daemon when no active\n' +
  '  goals exist. Default: one tick. --watch runs continuously.\n' +
  '  Respects the kill-switch (~/.ashlr/KILL) + daily budget.\n' +
  '\n' +
  '  Flags:\n' +
  '    --watch / --continuous   Run continuously (Ctrl-C to stop)\n' +
  '    --dry-run                Show what WOULD advance; create no proposals\n' +
  '    --allow-cloud            Allow cloud engines for planning and execution';

export async function cmdLoop(args: string[]): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const watch = args.includes('--watch') || args.includes('--continuous');
  const dryRun = args.includes('--dry-run');
  const allowCloud = args.includes('--allow-cloud');
  const once = !watch; // default: one tick — never silently hang the terminal.

  const { loadConfig } = await import('../core/config.js');
  const cfg = loadConfig();

  console.log('');
  console.log(col.bold('  ashlr loop') + col.dim(' — goal-aware conductor'));
  console.log('');

  // M49 control-plane snapshot (best-effort).
  try {
    const { buildFleetStatus } = await import('../core/fleet/status.js');
    const { formatFleetStatus } = await import('./fleet.js');
    const status = await buildFleetStatus(cfg);
    for (const line of formatFleetStatus(status).split('\n')) console.log('  ' + line);
    console.log('');
  } catch {
    // status is best-effort — never block the loop on it.
  }

  // Surface fleet posture + mode (honest, cheap).
  const fo = cfg.foundry;
  console.log(
    col.dim(
      `  intelligence: ${fo?.intelligence ? 'on' : 'off'} · auto-merge(main): ` +
        `${fo?.autoMerge?.enabled ? 'on' : 'off'} · mid→branch: ` +
        `${fo?.autoMerge?.midToBranch ? 'on' : 'off'}`,
    ),
  );
  console.log(
    col.dim(
      `  ${dryRun ? 'dry-run' : 'live'} · ${once ? 'one tick' : 'continuous (Ctrl-C to stop)'} · ` +
        `proposal-only · kill: ~/.ashlr/KILL${allowCloud ? ' · cloud: on' : ''}`,
    ),
  );
  console.log('');

  // Show active goals snapshot so the user sees what the conductor will work on.
  try {
    const { listGoals } = await import('../core/goals/store.js');
    const { progressOf } = await import('../core/goals/advance.js');
    const active = listGoals({ status: 'active' });
    if (active.length > 0) {
      console.log(col.bold('  Active goals:'));
      for (const g of active.slice(0, 5)) {
        const prog = progressOf(g);
        const pct = Math.round(prog.fractionDone * 100);
        const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
        console.log(
          `  ${col.dim('•')} ${g.objective.slice(0, 60)}${g.objective.length > 60 ? '…' : ''}` +
            col.dim(` [${bar} ${pct}%]`),
        );
      }
      if (active.length > 5) {
        console.log(col.dim(`  … and ${active.length - 5} more`));
      }
      console.log('');
    } else {
      console.log(col.dim('  No active goals — will run backlog daemon.'));
      console.log('');
    }
  } catch {
    // Goal listing is best-effort.
  }

  // Run the goal-aware conductor. Goals are advanced first; backlog daemon is
  // the fallback when no active goals exist. The conductor respects the
  // kill-switch + daily budget and dispatches only sandboxed, proposal-only work.
  const { runConductor } = await import('../core/goals/conductor.js');
  const summary = await runConductor(cfg, { once, dryRun, allowCloud });

  console.log('');

  // Display conductor cycle summary.
  if (summary.killSwitchTripped) {
    console.log(col.yellow('  kill-switch on — no work dispatched (rm ~/.ashlr/KILL to resume)'));
  } else if (summary.daemonFallback) {
    console.log(col.dim('  backlog mode (no active goals) — any proposals await review in `ashlr inbox`.'));
  } else {
    // Goals mode: show what advanced.
    if (summary.goalActivity.length > 0) {
      console.log(col.bold('  This cycle:'));
      for (const act of summary.goalActivity) {
        const pct = Math.round(act.fractionDone * 100);
        const tag = act.goalCompleted
          ? col.green(' ✓ done')
          : act.proposalFiled
            ? col.dim(' → proposal filed')
            : col.dim(' (dry-run)');
        console.log(
          `  ${col.dim('•')} ${act.objective.slice(0, 48)}${act.objective.length > 48 ? '…' : ''}` +
            col.dim(` › ${act.milestoneTitle.slice(0, 32)}`) +
            tag +
            col.dim(` [${pct}%]`),
        );
      }
    }
    console.log('');
    const parts: string[] = [];
    if (summary.goalsAdvanced) parts.push(`${summary.goalsAdvanced} goal${summary.goalsAdvanced !== 1 ? 's' : ''} advanced`);
    if (summary.proposalsFiled) parts.push(`${summary.proposalsFiled} proposal${summary.proposalsFiled !== 1 ? 's' : ''} filed`);
    if (summary.goalsDone) parts.push(`${summary.goalsDone} goal${summary.goalsDone !== 1 ? 's' : ''} completed`);
    if (parts.length > 0) {
      console.log(col.green('  ✓ ') + col.dim(parts.join(' · ') + ' — review proposals in `ashlr inbox`.'));
    } else {
      console.log(col.dim('  nothing to advance this cycle.'));
    }
  }
  return 0;
}
