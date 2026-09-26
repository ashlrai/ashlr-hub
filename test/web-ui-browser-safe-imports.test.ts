/**
 * Every module the web UI loads at runtime must EVALUATE in a browser.
 *
 * The Verse console shares pure helpers with the backend by importing
 * src/core/** modules directly (cloud types, seat readiness, context math,
 * the secret scrubber…). Vite ships those modules to the browser verbatim, so
 * a module-level `process.platform` / `process.env` / `Buffer` read in any of
 * them throws `ReferenceError: process is not defined` the moment its chunk
 * loads. 3.11.4 shipped exactly that: cloud-model.ts began importing
 * `scrubSecrets` from core/util/scrub.ts, whose top-level
 * `const CASE_INSENSITIVE_FS = process.platform === …` took down the Command
 * and Fleet sections ("Command isn't in this build yet") on every launch.
 * No unit test caught it because jsdom runs on Node, where `process` exists.
 *
 * This contract walks the runtime import graph from every non-test web-ui file
 * (type-only imports are erased — the web tsconfig sets verbatimModuleSyntax,
 * so an unmarked import IS a runtime import) and fails on any Node-only global
 * referenced during module evaluation. References inside function bodies are
 * fine: they run only when called, and a browser caller can avoid them (or
 * guard with `typeof process`).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'src', 'web-ui');
const NODE_ONLY_GLOBALS = new Set(['process', 'Buffer', '__dirname', '__filename', 'require']);

function webEntries(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : webEntries(path);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return [];
    return /(\.test|[.-]test-support)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts') ? [] : [path];
  });
}

function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.(m?js|jsx)$/, '');
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null; // CSS modules, assets, JSON — not script
}

/** Specifiers this file loads at runtime (static value imports, re-exports, dynamic imports). */
function runtimeSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly = clause?.isTypeOnly
        || (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.length > 0
          && clause.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Node-only globals read while the module body runs (not inside functions). */
function loadTimeNodeGlobals(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    // Deferred code: runs only when called.
    if (ts.isFunctionLike(node) && !ts.isCallSignatureDeclaration(node)) return;
    // Type positions never evaluate.
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    // `typeof process === 'undefined'` is the guard, not a use.
    if (ts.isTypeOfExpression(node)) return;
    // Instance fields initialise per construction, not at load.
    if (ts.isPropertyDeclaration(node) && !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) return;
    if (ts.isIdentifier(node) && NODE_ONLY_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const isName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isVariableDeclaration(parent) && parent.name === node)
        || ts.isBindingElement(parent) || ts.isImportSpecifier(parent) || ts.isShorthandPropertyAssignment(parent);
      if (!isName) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(`${node.text} @ line ${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('web UI runtime modules are browser-safe', () => {
  it('no module reachable from src/web-ui reads a Node-only global at load time', () => {
    const seen = new Set<string>();
    const queue = webEntries(WEB);
    const violations: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const hit of loadTimeNodeGlobals(sf)) violations.push(`${relative(ROOT, file)}: ${hit}`);
      for (const specifier of runtimeSpecifiers(sf)) {
        const next = resolveRelative(file, specifier);
        if (next && !seen.has(next)) queue.push(next);
      }
    }
    // Sanity: the walk really leaves src/web-ui (it must reach the shared core modules).
    expect([...seen].some((f) => f.includes(`${join('src', 'core')}`))).toBe(true);
    expect(violations).toEqual([]);
  });

  it('the detector flags load-time reads and ignores deferred or guarded ones', () => {
    const scan = (code: string) => loadTimeNodeGlobals(ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true));
    // The 3.11.4 regression, verbatim.
    expect(scan("const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';"))
      .toEqual(['process @ line 1', 'process @ line 1']);
    expect(scan('export const size = Buffer.byteLength("x");')).toEqual(['Buffer @ line 1']);
    expect(scan('class A { static home = process.env.HOME; }')).toEqual(['process @ line 1']);
    expect(scan([
      'function f() { return process.platform; }',
      'const g = () => process.env.HOME;',
      "class B { field = process.cwd(); m() { return Buffer.from('x'); } }",
      "const ok = typeof process !== 'undefined';",
      'const o = { process: 1 }; o.process;',
    ].join('\n'))).toEqual([]);
  });
});
