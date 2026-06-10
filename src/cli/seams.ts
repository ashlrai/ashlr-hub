/**
 * CLI handler for `ashlr seams` — M30 cloud-ready seams diagnostic.
 *
 * READ-ONLY. Lists every v2 seam, its ACTIVE implementation (always 'local' on
 * the default path), and whether a cloud/team impl exists (false | 'gated').
 * Proves at a glance that the hub is local-first and that the cloud/team
 * backbone is GATED on Mason — there is NO config flag or code path that can
 * activate a functional cloud backbone.
 *
 * Usage:
 *   ashlr seams [status] [--json]   # list seams + active=local + cloud=gated
 *
 * HARD SAFETY INVARIANTS (M30) reflected by this surface:
 *  - READ-ONLY: builds the registry purely from the in-memory config + static
 *    descriptors. Triggers NO I/O, instantiates NO seam impl, makes NO network
 *    connection. Never mutates anything.
 *  - LOCAL-FIRST / NO ACTIVATION PATH: `active` is 'local' for every seam by
 *    default. It only shows 'gated' when a cloud endpoint is explicitly
 *    configured — and that impl REFUSES (throws). There is no flip to a working
 *    cloud backbone.
 *  - SELF-HOSTABLE / NOTHING PUBLIC: no outward action, no phone-home.
 *
 * NOTE (integration — owned by the Build/Integrate phase, NOT this scaffold):
 *   src/cli/index.ts must add a `loadSeamsCmd = lazyCmd(() => import('./seams.js'),
 *   (m) => m.cmdSeams as Cmd, 'seams command requires src/cli/seams.ts (M30 …)')`,
 *   a `case 'seams':` in the dispatch switch, and a cmdHelp entry. The M25 review
 *   caught this wiring being missed — it MUST be added during integration.
 *
 * Exit codes: 0 success, 1 runtime error, 2 bad usage.
 */

import { loadConfig } from '../core/config.js';
import { buildSeamRegistry } from '../core/seams/registry.js';
import type { SeamRegistry, SeamStatus } from '../core/seams/types.js';
import { pad, makeColors, isTty } from './ui.js';

// ─── Arg parsing ─────────────────────────────────────────────────────────────

interface ParsedSeamsArgs {
  json: boolean;
  help: boolean;
  error: string | undefined;
}

function parseSeamsArgs(args: string[]): ParsedSeamsArgs {
  let json = false;
  let help = false;
  let error: string | undefined;

  for (const a of args) {
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === 'status') {
      // `seams` and `seams status` are equivalent (status is the only verb).
    } else if (a.startsWith('--')) {
      error = `Unknown flag: ${a}`;
      break;
    } else {
      error = `Unknown argument: ${a}`;
      break;
    }
  }

  return { json, help, error };
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const tty = isTty();
  const { bold, cyan, dim, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold('  ashlr seams') + dim(' — cloud-ready seam diagnostic (read-only)'));
  out('');
  out('  ' + bold('Usage:'));
  out(`    ${cyan('ashlr seams')} [status] [--json]`);
  out('');
  out('  ' + bold('Options:'));
  const opts: [string, string][] = [
    ['--json', 'Emit the seam registry as JSON instead of human-readable output.'],
    ['--help', 'Show this help.'],
  ];
  const w = Math.max(...opts.map(([f]) => f.length));
  for (const [flag, desc] of opts) out(`    ${cyan(pad(flag, w))}  ${desc}`);
  out('');
  out('  ' + gray('Every seam ships a working LOCAL impl. The cloud/team backbone is GATED on'));
  out('  ' + gray('Mason — there is no config flag or code path that activates it. Local-first,'));
  out('  ' + gray('self-hostable, nothing public.'));
  out('');
}

// ─── Human-readable output ─────────────────────────────────────────────────────

/** Format the ACTIVE/CLOUD cells for a single seam row (typed on SeamStatus). */
function seamCells(
  s: SeamStatus,
  c: { dim: (x: string) => string; green: (x: string) => string; yellow: (x: string) => string },
): { active: string; cloud: string } {
  const active = s.active === 'local' ? c.green(pad('local', 7)) : c.yellow(pad('gated', 7));
  const cloud = s.cloud === false ? c.dim(pad('—', 7)) : c.yellow(pad('gated', 7));
  return { active, cloud };
}

/** Render the seam registry as a ranked table. */
function printRegistryHuman(reg: SeamRegistry): void {
  const tty = isTty();
  const { bold, cyan, dim, gray, green, yellow } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold('  Seams') + gray(` [${reg.seams.length} v2 seam(s)]`));
  out('');

  const names = reg.seams.map((s) => s.name);
  const nameW = Math.max(4, ...names.map((n) => n.length));
  out(
    '  ' +
      gray(pad('SEAM', nameW)) +
      '  ' + gray(pad('ACTIVE', 7)) +
      '  ' + gray(pad('CLOUD', 7)) +
      '  ' + gray('DELEGATES TO'),
  );
  for (const s of reg.seams) {
    const { active, cloud } = seamCells(s, { dim, green, yellow });
    out(
      '  ' +
        cyan(pad(s.name, nameW)) +
        '  ' + active +
        '  ' + cloud +
        '  ' + dim(s.delegatesTo),
    );
  }
  out('');

  if (reg.allLocal) {
    out('  ' + green('All seams are serving their LOCAL implementation.'));
  } else {
    out(
      '  ' +
        yellow(`${reg.gatedConfigured} seam(s) have a configured cloud endpoint — those REFUSE (gated).`),
    );
  }
  out('  ' + gray('Cloud/team backbone is GATED on Mason: no config flag or code path activates it.'));
  out('');
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * `ashlr seams [status] [--json]`
 *
 * READ-ONLY diagnostic listing every v2 seam with its active impl (always
 * 'local' by default) and cloud availability ('gated' stub or none). Proves the
 * hub is local-first and the cloud/team backbone is gated. Mutates nothing,
 * makes no network connection, instantiates no seam impl.
 *
 * Exit codes: 0 success, 1 runtime error, 2 bad usage.
 */
export async function cmdSeams(args: string[]): Promise<number> {
  const parsed = parseSeamsArgs(args);

  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.error) {
    process.stderr.write('error: ' + parsed.error + '\n');
    process.stderr.write('Run `ashlr seams --help` for usage.\n');
    return 2;
  }

  const tty = isTty();
  const { red } = makeColors(tty);

  let reg: SeamRegistry;
  try {
    const cfg = loadConfig();
    reg = buildSeamRegistry(cfg);
  } catch (err) {
    process.stderr.write(red('error: ') + (err instanceof Error ? err.message : String(err)) + '\n');
    return 1;
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(reg) + '\n');
    return 0;
  }

  printRegistryHuman(reg);
  return 0;
}
