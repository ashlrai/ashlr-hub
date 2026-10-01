/**
 * CLI startup import budget.
 *
 * `ashlr --version`, `--help` and other lightweight commands should only
 * evaluate the CLI dispatcher and a handful of core helpers. Heavy command
 * modules (setup.js alone reaches ~230 modules across fleet/run/authority)
 * must be loaded with a dynamic `import()` inside their `case`, never through
 * a static top-level import of src/cli/index.ts.
 *
 * This walks the static import graph of the TypeScript sources (type-only
 * imports are erased by tsc and are ignored) so it needs no build and no HOME.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const ENTRY = resolve(ROOT, 'src/cli/index.ts');
// Measured at 16 modules when this guard was added; leave modest headroom.
const STARTUP_MODULE_BUDGET = 40;

const STATIC_IMPORT_RE =
  /^\s*(import|export)\s+(?!type\s)([^;]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm;

function staticDeps(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(STATIC_IMPORT_RE)) {
    const clause = m[2] ?? '';
    // `import { type A, type B } from` is erased as well.
    const names = /\{([^}]*)\}/.exec(clause)?.[1];
    if (names && clause.trim().startsWith('{') && names.split(',').every(n => !n.trim() || n.trim().startsWith('type '))) continue;
    const target = resolve(dirname(file), m[3]!.replace(/\.js$/, '.ts'));
    if (existsSync(target)) out.push(target);
  }
  return out;
}

function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...staticDeps(file));
  }
  return seen;
}

describe('CLI startup import budget', () => {
  const closure = [...staticClosure(ENTRY)].map(f => relative(ROOT, f));

  it('keeps heavy command modules off the static startup graph', () => {
    expect(closure).not.toContain('src/cli/setup.ts');
    expect(closure).not.toContain('src/cli/doctor-init.ts');
    expect(closure).not.toContain('src/core/doctor.ts');
  });

  it(`statically loads at most ${STARTUP_MODULE_BUDGET} local modules`, () => {
    expect(closure.length, closure.join('\n')).toBeLessThanOrEqual(STARTUP_MODULE_BUDGET);
  });
});
