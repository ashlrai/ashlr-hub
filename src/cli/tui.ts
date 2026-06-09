/**
 * `ashlr tui` / `ashlr dash` — interactive terminal dashboard (M13).
 *
 * Flags:
 *   --once   Render one frame to stdout and exit (headless/scripting/test path).
 *
 * Delegates all rendering and key-handling to src/tui/app.ts via runTui().
 * Loads config via the existing loadConfig() helper and propagates the exit
 * code returned by runTui() back to the process.
 */

import { loadConfig } from '../core/config.js';

// ---------------------------------------------------------------------------
// Lazy loader — mirrors the pattern used for every other post-M4 command so
// the CLI degrades gracefully when src/tui/app.ts has not yet been built.
// ---------------------------------------------------------------------------

type RunTuiFn = (cfg: import('../core/types.js').AshlrConfig, opts: { once: boolean }) => Promise<number>;

let _runTui: RunTuiFn | null | undefined = undefined;

async function tryLoadRunTui(): Promise<RunTuiFn | null> {
  if (_runTui === undefined) {
    try {
      const mod = (await import('../tui/app.js' as unknown as string)) as { runTui: RunTuiFn };
      _runTui = mod.runTui;
    } catch {
      _runTui = null;
    }
  }
  return _runTui ?? null;
}

// ---------------------------------------------------------------------------
// cmdTui
// ---------------------------------------------------------------------------

/**
 * Entry point for `ashlr tui` and its alias `ashlr dash`.
 *
 * @param args  Remaining argv after the command token (e.g. ['--once']).
 * @returns     Exit code: 0 on success, 1 on error.
 */
export async function cmdTui(args: string[]): Promise<number> {
  const once = args.includes('--once');

  const runTui = await tryLoadRunTui();
  if (runTui === null) {
    console.error('error: tui command requires src/tui/app.ts (M13 module not yet built).');
    return 1;
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: failed to load config — ${msg}`);
    return 1;
  }

  return runTui(cfg, { once });
}
