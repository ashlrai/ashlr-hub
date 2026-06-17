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
  '  Run the autonomous fleet over every enrolled repo: discover work, route\n' +
  '  each item across the polyglot roster by trust tier, run it sandboxed, and\n' +
  '  file PROPOSALS (review via `ashlr inbox`). Default: one tick. --watch runs\n' +
  '  continuously. Respects the kill-switch (~/.ashlr/KILL) + daily budget.';

export async function cmdLoop(args: string[]): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const watch = args.includes('--watch') || args.includes('--continuous');
  const dryRun = args.includes('--dry-run');
  const once = !watch; // default: one tick — never silently hang the terminal.

  const { loadConfig } = await import('../core/config.js');
  const cfg = loadConfig();

  console.log('');
  console.log(col.bold('  ashlr loop') + col.dim(' — the fleet conductor'));
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

  console.log(
    col.dim(
      `  ${dryRun ? 'dry-run' : 'live'} · ${once ? 'one tick' : 'continuous (Ctrl-C to stop)'} · ` +
        'proposal-only · kill: ~/.ashlr/KILL',
    ),
  );

  // Run the conductor over the proven, proposal-first daemon. runDaemon respects
  // the kill-switch + daily budget and dispatches only sandboxed, proposal-only
  // work — this wrapper introduces no new behavior.
  const { runDaemon } = await import('../core/daemon/loop.js');
  await runDaemon(cfg, { once, dryRun });

  console.log('');
  console.log(col.green('  ✓ ') + col.dim('loop finished — any proposals await review in `ashlr inbox`.'));
  return 0;
}
