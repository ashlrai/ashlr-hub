/**
 * M257: `ashlr director` CLI command.
 *
 * Usage:
 *   ashlr director             — run one director cycle (sends Telegram if configured)
 *   ashlr director --dry-run   — print the director digest WITHOUT sending Telegram
 *   ashlr director --help      — show usage
 *
 * The --dry-run flag is the primary testing/inspection path: it builds the real
 * god-view snapshot, calls the LLM against live state, and prints the digest +
 * decision to stdout — no Telegram, no requests posted.
 *
 * SAFETY: the director is READ-ONLY in M257 (no goal mutations). Communicates
 * only through Telegram and postRequest('decision-needed'). Never bypasses safety
 * gates. High-stakes actions escalate to Mason — never auto-act.
 */

import { loadConfig } from '../core/config.js';

export async function cmdDirector(args: string[]): Promise<number> {
  const isDryRun = args.includes('--dry-run') || args.includes('-n');
  const isHelp = args.includes('--help') || args.includes('-h');

  if (isHelp) {
    console.log(`ashlr director — Elon Director strategic reasoning cycle

USAGE
  ashlr director              Run one director cycle (sends Telegram digest)
  ashlr director --dry-run    Print digest without sending Telegram (testable)
  ashlr director --help       Show this help

FLAGS
  --dry-run, -n    Build real god-view + call LLM, print digest to stdout
                   Does NOT send Telegram. Does NOT post any requests.
  --help, -h       Show this help

GATING
  The live director cycle (without --dry-run) requires cfg.comms.director=true.
  Dry-run mode always runs regardless of the gate — it's read-only inspection.

SAFETY (M257 MVP)
  Read + reason + communicate only. No goal mutations. No merge/push/apply.
  High-stakes decisions (enrollment, releases, spend, arch) → escalate to Mason.
  All existing gates (sandbox, judge, scope-cap, kill-switch, enrollment) intact.
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

  if (isDryRun) {
    try {
      const { runDirectorDryRun } = await import('../core/comms/director.js');
      const output = await runDirectorDryRun(cfg);
      console.log(output);
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`director --dry-run failed: ${msg}`);
      return 1;
    }
  }

  // Live cycle — requires cfg.comms.director=true
  const directorEnabled =
    (cfg.comms as Record<string, unknown> | undefined)?.['director'] === true;

  if (!directorEnabled) {
    console.log(
      'Director is disabled (cfg.comms.director=false). Use --dry-run to inspect live state, or set cfg.comms.director=true to enable the live cycle.',
    );
    return 0;
  }

  try {
    const { runDirectorCycle } = await import('../core/comms/director.js');
    await runDirectorCycle(cfg);
    console.log('Director cycle complete.');
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`director cycle failed: ${msg}`);
    return 1;
  }
}
