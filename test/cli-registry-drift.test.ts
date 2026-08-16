/**
 * Structural anti-drift test for the CLI command registries.
 *
 * src/cli/index.ts's `main()` dispatch switch (`switch (cmd) { ... }`) is the
 * SINGLE SOURCE OF TRUTH for which top-level commands actually exist — it is
 * what runs when a user types `ashlr <cmd>`. Three other files each keep a
 * DUPLICATE list for a different purpose:
 *   - src/cli/completions.ts  TOP_LEVEL_COMMANDS  (shell completion + "did you mean")
 *   - src/cli/help.ts         HELP_ENTRIES        (`ashlr help --all` / topic tables)
 *
 * A prior audit found both had silently drifted out of sync with the switch
 * (completions.ts was missing 20 live commands; help.ts was missing 9) — the
 * kind of drift that makes the CLI's own discovery surfaces (completion,
 * "did you mean", help) blind to commands that actually work. This test
 * parses the real switch out of index.ts with a regex and diffs it against
 * both registries so a future command addition/removal that forgets to
 * update completions.ts or help.ts FAILS CI instead of silently rotting.
 *
 * This file lives in test/ (not owned by any single CLI-file agent) and reads
 * src/cli/index.ts read-only — it does not import or execute it, so it has no
 * dependency on index.ts's module graph.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';
import { HELP_ENTRIES } from '../src/cli/help.js';

const INDEX_TS_PATH = join(__dirname, '..', 'src', 'cli', 'index.ts');

/**
 * Extract the literal top-level command names dispatched by main()'s
 * `switch (cmd) { case '...': ... }`. Bounded to the switch body (between
 * `switch (cmd) {` and the `} catch (err) {` that closes main()'s try block)
 * so we never pick up an unrelated `case` from a different switch elsewhere
 * in the file. Case labels are always plain identifiers here (`case 'foo':`)
 * — flag-shaped aliases like `--version`/`-h` and the internal
 * `__skills-audit-worker` worker entry point don't start with a letter, so
 * the regex excludes them by construction (a real user-facing command name
 * always starts with a-z).
 */
function extractDispatchedCommands(): string[] {
  const src = readFileSync(INDEX_TS_PATH, 'utf8');

  const switchStart = src.indexOf('switch (cmd) {');
  if (switchStart === -1) {
    throw new Error(
      'cli-registry-drift: could not find `switch (cmd) {` in src/cli/index.ts — ' +
      'has main() been restructured? Update extractDispatchedCommands() to match.',
    );
  }
  const catchMarker = '\n  } catch (err) {';
  const switchEnd = src.indexOf(catchMarker, switchStart);
  if (switchEnd === -1) {
    throw new Error(
      'cli-registry-drift: could not find the end of the dispatch switch ' +
      '(`} catch (err) {`) in src/cli/index.ts — update the boundary marker.',
    );
  }

  const switchBody = src.slice(switchStart, switchEnd);
  const caseRe = /case '([a-zA-Z][a-zA-Z0-9-]*)':/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(switchBody)) !== null) {
    found.add(m[1]!);
  }
  return [...found];
}

const dispatched = extractDispatchedCommands();

describe('CLI registry anti-drift (structural, parses src/cli/index.ts)', () => {
  it('sanity: extraction finds a plausible number of commands', () => {
    // Guards the extractor itself against silently matching nothing (e.g. if
    // index.ts's switch is ever renamed/restructured without updating the
    // boundary markers above — a false "everything is in sync" is worse than
    // a loud failure here).
    expect(dispatched.length).toBeGreaterThanOrEqual(70);
    expect(dispatched).toContain('daemon');
    expect(dispatched).toContain('inbox');
    expect(dispatched).toContain('help');
  });

  it('never dispatches the internal skills-audit worker entry point as a user command', () => {
    // Defense in depth: even if the regex were loosened, `__skills-audit-worker`
    // must never leak into a user-facing registry.
    expect(dispatched).not.toContain('__skills-audit-worker');
  });

  it('every dispatched command is completable (TOP_LEVEL_COMMANDS has no gaps)', () => {
    const missing = dispatched.filter((cmd) => !TOP_LEVEL_COMMANDS.includes(cmd));
    expect(missing, `completions.ts TOP_LEVEL_COMMANDS is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('TOP_LEVEL_COMMANDS has no stale entries (every listed command is still dispatched)', () => {
    const dispatchedSet = new Set(dispatched);
    const stale = TOP_LEVEL_COMMANDS.filter((cmd) => !dispatchedSet.has(cmd));
    expect(stale, `completions.ts TOP_LEVEL_COMMANDS has stale/removed entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('every dispatched command is documented in `ashlr help --all` (HELP_ENTRIES has no gaps)', () => {
    const helpCmds = new Set(HELP_ENTRIES.map((e) => e.cmd.split(' ')[0]));
    // 'dash' is a pure alias of 'tui' and 'version' is covered by the
    // --version/-v aliases sharing the same dispatch case; both are still
    // individually documented (see help.ts), so no exemption is needed here
    // beyond what HELP_ENTRIES actually lists.
    const missing = dispatched.filter((cmd) => !helpCmds.has(cmd));
    expect(missing, `help.ts HELP_ENTRIES is missing: ${missing.join(', ')}`).toEqual([]);
  });
});
