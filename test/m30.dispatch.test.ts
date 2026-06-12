/**
 * m30.dispatch.test.ts — guards the `seams` command's wiring into the CLI
 * dispatcher (src/cli/index.ts).
 *
 * The M25 review caught a new command's dispatcher wiring (lazyCmd loader,
 * `case` in the switch, and `cmdHelp` listing) shipping with NO automated test,
 * so an edit could silently make the command unreachable through `main()` while
 * the command module itself still type-checked. M26 established the
 * dispatch-guard convention (test/m26.dispatch.test.ts) to close that seam.
 *
 * The M30 review flagged that m30.cli.test.ts exercises `cmdSeams` only by
 * importing it directly — it never asserts the index.ts wiring. This test
 * follows the M26 convention for the `seams` command: it asserts, at the SOURCE
 * level, that
 *   1. a `loadSeamsCmd` lazyCmd loader exists and imports './seams.js' and
 *      picks `cmdSeams`,
 *   2. the dispatch switch has a `case 'seams':` that calls the loader,
 *   3. the help listing (`cmdHelp`) advertises `seams` and `seams status`.
 *
 * It also asserts the command module exposes the expected `cmdSeams` export, so
 * the loader's `(m) => m.cmdSeams as Cmd` contract stays intact.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const indexSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'cli', 'index.ts'),
  'utf8',
);

// M32: the help table moved from cli/index.ts (inline cmdHelp) to cli/help.ts
// (HELP_ENTRIES). Discoverability assertions now read the help module source.
const helpSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'cli', 'help.ts'),
  'utf8',
);

describe('seams — dispatcher wiring (src/cli/index.ts)', () => {
  it('defines a loadSeamsCmd lazyCmd loader importing ./seams.js and picking cmdSeams', () => {
    expect(indexSrc).toMatch(/const\s+loadSeamsCmd\s*=\s*lazyCmd\s*\(/);
    // The loader must import the seams command module...
    expect(indexSrc).toMatch(/import\(\s*['"]\.\/seams\.js['"]\s*\)/);
    // ...and pick the cmdSeams export (the loader's contract).
    expect(indexSrc).toMatch(/m\.cmdSeams\s+as\s+Cmd/);
  });

  it("has a `case 'seams':` in the dispatch switch that invokes the loader", () => {
    expect(indexSrc).toMatch(/case\s+['"]seams['"]\s*:/);
    // The case must actually call the lazy loader (not be a dead label).
    const caseIdx = indexSrc.indexOf("case 'seams'");
    expect(caseIdx).toBeGreaterThan(-1);
    const caseBody = indexSrc.slice(caseIdx, caseIdx + 400);
    expect(caseBody).toMatch(/loadSeamsCmd\s*\(/);
  });

  it('advertises the seams surfaces in the help listing', () => {
    // The cmdHelp table must list the base command and the `status` subcommand
    // so the command is discoverable via `ashlr help`.
    expect(helpSrc).toMatch(/['"]seams['"]\s*,/);
    expect(helpSrc).toMatch(/['"]seams status['"]\s*,/);
  });
});

describe('seams — command module contract', () => {
  it('exports cmdSeams as the loader expects', async () => {
    const mod = await import('../src/cli/seams.js');
    expect(typeof mod.cmdSeams).toBe('function');
  });
});
