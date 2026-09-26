/**
 * M257 → 3.14: `ashlr director` CLI command.
 *
 * The Director's model cycle is retired: the Leader is the one strategic
 * brain (vision/leader.ts), and Mason talks to it through the Leader thread
 * (`ashlr leader say`, Verse, Telegram). What remains is the read-only
 * god-view snapshot:
 *
 *   ashlr director             — print the god-view snapshot (no model call, sends nothing)
 *   ashlr director --dry-run   — the same (kept for scripts that pass it)
 *   ashlr director --help      — show usage
 */

import { loadConfig } from '../core/config.js';

export async function cmdDirector(args: string[]): Promise<number> {
  const isHelp = args.includes('--help') || args.includes('-h');

  if (isHelp) {
    console.log(`ashlr director — read-only fleet god-view (the Director is retired)

USAGE
  ashlr director              Print the god-view snapshot
  ashlr director --dry-run    The same (kept for older scripts)
  ashlr director --help       Show this help

The Director's model cycle was retired in 3.14: the Leader is the one
strategic brain. Read its memo with \`ashlr leader show\`; talk to it with
\`ashlr leader say "…"\`. cfg.comms.director no longer turns anything on.
`);
    return 0;
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    console.error('director: failed to load config');
    return 1;
  }

  try {
    const { runDirectorDryRun } = await import('../core/comms/director.js');
    console.log(await runDirectorDryRun(cfg));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`director failed: ${msg}`);
    return 1;
  }
}
