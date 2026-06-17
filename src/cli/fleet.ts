/**
 * `ashlr fleet` — M49 fleet control plane + observability CLI.
 *
 * Subcommands:
 *   fleet status [--json]
 *       Print a READ-ONLY snapshot of the whole fleet: daemon liveness +
 *       today's spend, per-backend recent dispatches + quota, queue size,
 *       proposal counts (pending / frontier-pending / applied), recent
 *       auto-merges, and the kill-switch (paused) state. Never mutates.
 *   fleet pause
 *       Engage the global kill switch (setKill(true)) — same effect as
 *       `ashlr daemon stop`'s kill: any running loop halts on its next tick and
 *       nothing autonomous dispatches until resumed. Idempotent.
 *   fleet resume
 *       Release the kill switch (setKill(false)). Idempotent.
 *
 * Pause/resume are the ONLY mutations here, and they touch ONLY the kill-switch
 * sentinel (no repo, no spend, no proposals). `fleet status` is fully read-only.
 */

import type { AshlrConfig } from '../core/types.js';
import type { FleetStatus } from '../core/fleet/status.js';
import { makeColors, isTty } from './ui.js';

const { bold, dim, green, red, yellow, cyan } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Pure formatter — exported for unit testing (no I/O, no color deps).
// ---------------------------------------------------------------------------

/**
 * Render a FleetStatus as a plain (no-color) multi-line string. Pure and
 * deterministic — does no I/O and takes no color dependency, so it is fully
 * unit-testable.
 */
export function formatFleetStatus(s: FleetStatus): string {
  const lines: string[] = [];
  const pausedTag = s.killed ? '  [PAUSED — kill switch engaged]' : '';

  lines.push('Fleet status' + pausedTag);
  lines.push('');

  // Daemon
  lines.push(`Daemon:    ${s.daemon.running ? 'running' : 'stopped'}`);
  lines.push(`  last tick:     ${s.daemon.lastTickAt ?? '—'}`);
  lines.push(`  spend today:   $${s.daemon.todaySpentUsd.toFixed(4)}`);
  lines.push('');

  // Backends
  lines.push('Backends:');
  if (s.backends.length === 0) {
    lines.push('  (none)');
  } else {
    const nameW = Math.max(8, ...s.backends.map((b) => b.backend.length));
    for (const b of s.backends) {
      const name = b.backend + ' '.repeat(Math.max(0, nameW - b.backend.length));
      lines.push(`  ${name}  dispatches(24h)=${b.dispatchesRecent}  quota=${b.quota}`);
    }
  }
  lines.push('');

  // Queue
  lines.push(`Queue:     ${s.queue.backlogItems} backlog item(s)`);
  lines.push('');

  // Proposals
  lines.push('Proposals:');
  lines.push(`  pending:           ${s.proposals.pending}`);
  lines.push(`  frontier pending:  ${s.proposals.frontierPending}`);
  lines.push(`  applied:           ${s.proposals.applied}`);
  lines.push('');

  // Merges
  lines.push(`Merges:    ${s.merges.recent} auto-merge(s) in last 24h`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Config loader (lazy, graceful)
// ---------------------------------------------------------------------------

async function loadCfg(): Promise<AshlrConfig | null> {
  try {
    const { loadConfig } = await import('../core/config.js');
    return loadConfig();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Subcommand: status (READ-ONLY)
// ---------------------------------------------------------------------------

async function cmdFleetStatus(jsonMode: boolean): Promise<number> {
  const cfg = await loadCfg();
  if (!cfg) {
    process.stderr.write(red('error: ') + 'failed to load config.\n');
    return 1;
  }

  let status: FleetStatus;
  try {
    const { buildFleetStatus } = await import('../core/fleet/status.js');
    status = await buildFleetStatus(cfg);
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'failed to build fleet status: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    return 0;
  }

  console.log('');
  console.log(bold('  ashlr fleet') + dim(' — control plane + observability'));
  console.log('');
  for (const line of formatFleetStatus(status).split('\n')) {
    // Colorize the paused banner line; leave the rest plain.
    if (line.includes('[PAUSED')) console.log('  ' + yellow(line));
    else console.log('  ' + line);
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommands: pause / resume (kill-switch only)
// ---------------------------------------------------------------------------

async function setKillSwitch(on: boolean): Promise<number> {
  try {
    const { setKill } = await import('../core/sandbox/policy.js');
    setKill(on);
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'failed to toggle kill switch: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  console.log('');
  if (on) {
    console.log(green('  ✓ fleet paused') + dim(' — kill switch engaged.'));
    console.log(dim('  Any running loop halts on its next tick; nothing autonomous dispatches.'));
    console.log(dim('  Resume with `ashlr fleet resume`.'));
  } else {
    console.log(green('  ✓ fleet resumed') + dim(' — kill switch released.'));
    console.log(dim('  The daemon may dispatch again on its next tick (if running).'));
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * M59: a conservative starter `cfg.foundry` block. Installed backends +
 * OS confinement on + auto-merge OFF. No mergeAuthority models are guessed (the
 * user pins those); no API engines are added (they need keys). Adding more is
 * config-only — see docs/FOUNDRY-CONFIG.md.
 */
function starterFoundry(): NonNullable<AshlrConfig['foundry']> {
  return {
    allowedBackends: ['builtin', 'claude', 'codex', 'hermes'],
    confinement: { '*': { mode: 'os', networkEgress: false, onUnsupported: 'fallback' } },
    autoMerge: { enabled: false },
  };
}

/**
 * `ashlr fleet init [--write]` — print (default) or merge (--write, only when
 * absent) a starter cfg.foundry. NEVER overwrites an existing foundry block.
 */
async function cmdFleetInit(args: string[]): Promise<number> {
  const write = args.includes('--write');
  const { loadConfig, saveConfig, CONFIG_PATH } = await import('../core/config.js');
  const cfg = loadConfig();
  const block = { foundry: starterFoundry() };

  if (!write) {
    console.log('');
    console.log(dim('  # Starter cfg.foundry — merge into ' + CONFIG_PATH));
    console.log(dim('  # Full reference: docs/FOUNDRY-CONFIG.md'));
    console.log(JSON.stringify(block, null, 2));
    console.log('');
    console.log(dim('  Re-run `ashlr fleet init --write` to merge it (only when foundry is absent).'));
    return 0;
  }

  if (cfg.foundry) {
    console.error(
      yellow('note: ') +
        'cfg.foundry already present in ' +
        CONFIG_PATH +
        ' — not overwriting. Edit it by hand (see docs/FOUNDRY-CONFIG.md).',
    );
    return 1;
  }

  cfg.foundry = starterFoundry();
  saveConfig(cfg);
  console.log(
    green('✓ ') +
      'wrote a starter cfg.foundry to ' +
      CONFIG_PATH +
      ' (auto-merge OFF; set provider keys + pass --allow-cloud to use API backends).',
  );
  return 0;
}

export async function cmdFleet(args: string[]): Promise<number> {
  const [sub, ...rest] = args;

  if (sub === '--help' || sub === '-h' || sub === 'help' || sub === undefined) {
    printFleetHelp();
    return 0;
  }

  switch (sub) {
    case 'status':
      return cmdFleetStatus(rest.includes('--json'));
    case 'init':
      return cmdFleetInit(rest);
    case 'pause':
      return setKillSwitch(true);
    case 'resume':
      return setKillSwitch(false);
    default:
      process.stderr.write(red('error: ') + `unknown fleet subcommand: ${sub}\n`);
      printFleetHelp();
      return 2;
  }
}

function printFleetHelp(): void {
  console.log('');
  console.log(bold('  ashlr fleet') + dim(' — fleet control plane + observability (M49)'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr fleet status [--json]   ${cyan('# read-only fleet snapshot')}`);
  console.log(`    ashlr fleet init [--write]    ${cyan('# print/merge a starter cfg.foundry')}`);
  console.log(`    ashlr fleet pause             ${cyan('# engage kill switch (pause fleet)')}`);
  console.log(`    ashlr fleet resume            ${cyan('# release kill switch (resume fleet)')}`);
  console.log('');
}
