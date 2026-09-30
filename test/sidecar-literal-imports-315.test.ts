/**
 * The desktop sidecar is `bun build --compile` of dist/ (scripts/build-sea.mjs). Bun bundles
 * a dynamic `import()` only when its specifier is a literal; a variable specifier is resolved
 * at runtime against the binary's virtual FS (/$bunfs/root/…) and ALWAYS misses, even when
 * the module is bundled through another path. The catch every lazy loader has then turns the
 * miss into a silently-missing feature: 3.15 found the Leader's Jev layer (#552), the Verse
 * session engine's reasoning tap, five doctor sections and the swarm runner's sandbox,
 * audit and inbox loads all dark in the binary this way.
 *
 * This walks every runtime source file under src/core and src/cli with the TypeScript AST
 * and fails on any `import(x)` whose argument is not a string literal (`'./a.js' as string`
 * is fine: tsc erases the cast). Only the entries below may load a computed specifier, and
 * each says why that is correct.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

/** Files allowed a computed specifier, and why. */
const ALLOWED: Record<string, string> = {
  // A user-installed plugin lives on disk outside the binary by definition.
  'src/core/plugins/registry.ts': 'loads operator-installed plugin entry points from disk',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.d\.ts$|\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function isLiteralSpecifier(node: ts.Expression): boolean {
  let expr = node;
  while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isTypeAssertionExpression(expr)) expr = expr.expression;
  return ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr);
}

function computedImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (!arg || !isLiteralSpecifier(arg)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        hits.push(`${relative(ROOT, file)}:${line + 1}: ${node.getText(source).slice(0, 100)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('the compiled sidecar can bundle every lazy import', () => {
  it('no runtime source loads a computed specifier outside the documented exceptions', { timeout: 30_000 }, () => {
    const files = [...sourceFiles(join(ROOT, 'src', 'core')), ...sourceFiles(join(ROOT, 'src', 'cli'))];
    expect(files.length).toBeGreaterThan(500);
    const offenders = files
      .filter((file) => !(relative(ROOT, file).split('\\').join('/') in ALLOWED))
      .flatMap(computedImports);
    expect(offenders).toEqual([]);
  });

  it('the exceptions are still real (a stale entry would hide a new offender)', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(computedImports(join(ROOT, file)).length, `${file} no longer loads a computed specifier; drop it from ALLOWED`).toBeGreaterThan(0);
    }
  });

  it('the session engine loads the reasoning tap with a literal import', () => {
    const text = readFileSync(join(ROOT, 'src', 'core', 'verse', 'session-engine.ts'), 'utf8');
    expect(text).toContain("import('../reasoning/ingest-verse.js')");
  });
});
