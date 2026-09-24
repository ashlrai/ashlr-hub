/**
 * V3.10 Track B unit U3 — the Tier-1 closure snapshot (SPEC-310B §2: "A
 * closure-snapshot test fails CI when any Tier-1 import closure grows").
 *
 * The Tier-1 roots are the ashlr-hub source files that decide what the fleet
 * may do (authority/protected-paths.ts TIER1_SOURCE_PATTERNS, minus HTTP API
 * modules). Their RUNTIME import closure is authority code in all but name:
 * a file that joins it can change a gate without touching a protected path.
 * So growth must be a reviewed act — this test fails until the snapshot is
 * regenerated, and the snapshot file is itself Tier-1 protected
 * (test/fixtures/authority/**), so only Mason can bless new members.
 *
 * Regenerate after a reviewed change:
 *   ASHLR_UPDATE_TIER1_CLOSURE=1 npx vitest run test/authority-tier1-closure-310b.test.ts
 *
 * Runtime closure = static imports that survive compilation (type-only
 * imports and type-only named bindings are erased), re-exports, and literal
 * dynamic `import()`s. Pure: reads source files, spawns nothing.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isTier1ClosureRoot } from '../src/core/authority/protected-paths.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(ROOT, 'test', 'fixtures', 'authority', 'tier1-closure.json');

interface ClosureSnapshot {
  v: 1;
  note: string;
  roots: string[];
  closure: string[];
}

function listSource(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSource(full));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function runtimeSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let runtime = true;
      if (clause?.isTypeOnly) runtime = false;
      else if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const elements = clause.namedBindings.elements;
        if (elements.length > 0 && elements.every((element) => element.isTypeOnly)) runtime = false;
      }
      if (runtime) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const elements = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      if (!node.isTypeOnly && !(elements && elements.length > 0 && elements.every((element) => element.isTypeOnly))) {
        out.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) out.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    `${base}.ts`,
    join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function computeClosure(): { roots: string[]; closure: string[] } {
  const roots = listSource(join(ROOT, 'src'))
    .map((file) => relative(ROOT, file).split('\\').join('/'))
    .filter((path) => isTier1ClosureRoot(path))
    .sort();
  const seen = new Set<string>();
  const stack = roots.map((path) => join(ROOT, path));
  while (stack.length > 0) {
    const file = stack.pop()!;
    const rel = relative(ROOT, file).split('\\').join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const specifier of runtimeSpecifiers(file)) {
      const target = resolveLocal(file, specifier);
      if (target) stack.push(target);
    }
  }
  return { roots, closure: [...seen].sort() };
}

describe('Tier-1 authority import closure (SPEC-310B §2)', () => {
  const current = computeClosure();

  if (process.env['ASHLR_UPDATE_TIER1_CLOSURE'] === '1') {
    it('writes the snapshot (ASHLR_UPDATE_TIER1_CLOSURE=1)', () => {
      const snapshot: ClosureSnapshot = {
        v: 1,
        note: 'Runtime import closure of the ashlr-hub Tier-1 roots. Growth must be reviewed: regenerate with ASHLR_UPDATE_TIER1_CLOSURE=1 npx vitest run test/authority-tier1-closure-310b.test.ts',
        roots: current.roots,
        closure: current.closure,
      };
      writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
      expect(current.closure.length).toBeGreaterThan(current.roots.length);
    });
    return;
  }

  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as ClosureSnapshot;

  it('found the Tier-1 roots (the gate modules are among them)', () => {
    for (const root of ['src/core/inbox/merge.ts', 'src/core/fleet/host-merge.ts', 'src/core/fleet/merge-gates.ts', 'src/core/authority/protected-paths.ts']) {
      expect(current.roots).toContain(root);
    }
    expect(current.roots).not.toContain('src/core/routing/budget-api.ts');
  });

  it('no new Tier-1 root appeared without a reviewed snapshot update', () => {
    const known = new Set(snapshot.roots);
    const added = current.roots.filter((root) => !known.has(root));
    expect(added, `new Tier-1 roots — review, then regenerate: ASHLR_UPDATE_TIER1_CLOSURE=1 npx vitest run test/authority-tier1-closure-310b.test.ts`).toEqual([]);
  });

  it('the runtime import closure has not grown', () => {
    const known = new Set(snapshot.closure);
    const grown = current.closure.filter((file) => !known.has(file));
    expect(grown, [
      'These files joined the Tier-1 authority import closure. Each can now change what a gate does',
      'without touching a protected path. Review why, then regenerate the snapshot:',
      '  ASHLR_UPDATE_TIER1_CLOSURE=1 npx vitest run test/authority-tier1-closure-310b.test.ts',
    ].join('\n')).toEqual([]);
  });

  it('the snapshot is sorted, unique and repo-relative (src/ plus the shipped scripts src/ imports)', () => {
    expect([...snapshot.closure].sort()).toEqual(snapshot.closure);
    expect(new Set(snapshot.closure).size).toBe(snapshot.closure.length);
    for (const file of snapshot.closure) expect(file.startsWith('src/') || file.startsWith('scripts/')).toBe(true);
  });
});
