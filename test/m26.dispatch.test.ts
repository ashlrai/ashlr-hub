/**
 * m26.dispatch.test.ts — guards the `reflect` command's wiring into the CLI
 * dispatcher (src/cli/index.ts).
 *
 * The M25 review caught that a new command's dispatcher wiring (lazyCmd loader,
 * `case` in the switch, and `cmdHelp` listing) had NO automated test, so an
 * edit could silently make the command unreachable through `main()` while the
 * command module itself still type-checked. This test closes that seam for M26:
 * it asserts, at the SOURCE level, that
 *   1. a `loadReflectCmd` lazyCmd loader exists and imports './reflect.js',
 *   2. the dispatch switch has a `case 'reflect':` that calls it,
 *   3. the help listing (`cmdHelp`) advertises all three reflect surfaces.
 *
 * It also asserts the command module exposes the expected `cmdReflect` export,
 * so the loader's contract stays intact.
 *
 * NOTE (naming): named *dispatch* (not *index*) on purpose — m25.index.test.ts
 * actually exercises knowledge-indexing internals, NOT CLI routing. Keeping the
 * routing guard under a clearly-named file avoids re-introducing that gap.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const indexSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'cli', 'index.ts'),
  'utf8',
);

describe('reflect — dispatcher wiring (src/cli/index.ts)', () => {
  it('defines a loadReflectCmd lazyCmd loader importing ./reflect.js', () => {
    expect(indexSrc).toMatch(/const\s+loadReflectCmd\s*=\s*lazyCmd\s*\(/);
    // The loader must import the reflect command module and pick cmdReflect.
    expect(indexSrc).toMatch(/import\(\s*['"]\.\/reflect\.js['"]\s*\)/);
    expect(indexSrc).toMatch(/m\.cmdReflect\s+as\s+Cmd/);
  });

  it("has a `case 'reflect':` in the dispatch switch that invokes the loader", () => {
    expect(indexSrc).toMatch(/case\s+['"]reflect['"]\s*:/);
    // The case must actually call the lazy loader (not be a dead label).
    const caseIdx = indexSrc.indexOf("case 'reflect'");
    expect(caseIdx).toBeGreaterThan(-1);
    const caseBody = indexSrc.slice(caseIdx, caseIdx + 400);
    expect(caseBody).toMatch(/loadReflectCmd\s*\(/);
  });

  it('advertises all three reflect surfaces in the help listing', () => {
    // The cmdHelp table must list the base command and both subcommands so the
    // command is discoverable via `ashlr help`.
    expect(indexSrc).toMatch(/['"]reflect \[--since <Nd>\]['"]/);
    expect(indexSrc).toMatch(/['"]reflect playbooks( \[--persist\])?['"]/);
    expect(indexSrc).toMatch(/['"]reflect propose['"]/);
  });
});

describe('reflect — command module contract', () => {
  it('exports cmdReflect as the loader expects', async () => {
    const mod = await import('../src/cli/reflect.js');
    expect(typeof mod.cmdReflect).toBe('function');
  });
});
