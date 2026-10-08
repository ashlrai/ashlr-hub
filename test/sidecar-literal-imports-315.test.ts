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

// This consumer deliberately runs the current installed Node package's helper,
// not candidate code or a bundled SEA copy. Admit only its complete guarded body.
const DISK_HELPER_FILE = 'src/core/desktop/qualified-update.ts';
const diskHelperBody = ts.createSourceFile('guard.ts', `async function load(root: string) {
  if (!root || root !== runningPackageRoot()) hold('unsupported-installed-runtime');
  return await import(pathToFileURL(join(root, 'scripts', 'local-app-transaction.mjs')).href) as TransactionModule;
}`, ts.ScriptTarget.ES2022, true).statements[0] as ts.FunctionDeclaration;
const printer = ts.createPrinter({removeComments: true});
function printedBody(body: ts.Block, source: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, body, source);
}
function isInstalledDiskHelper(file: string, node: ts.CallExpression, source: ts.SourceFile): boolean {
  if (relative(ROOT, file).split('\\').join('/') !== DISK_HELPER_FILE) return false;
  let parent: ts.Node = node;
  while (parent.parent && !ts.isFunctionLike(parent)) parent = parent.parent;
  if (!ts.isFunctionDeclaration(parent) || parent.parent !== source || parent.name?.text !== 'loadInstalledDesktopTransaction'
      || !parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      || parent.parameters.length !== 1 || parent.typeParameters?.length || !parent.body) return false;
  const parameter = parent.parameters[0]!;
  return ts.isIdentifier(parameter.name) && parameter.name.text === 'root' && parameter.type?.kind === ts.SyntaxKind.StringKeyword
    && !parameter.initializer && !parameter.dotDotDotToken && !parameter.questionToken
    && printedBody(parent.body, source) === printedBody(diskHelperBody.body!, diskHelperBody.getSourceFile());
}

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

function computedImports(file: string, text = readFileSync(file, 'utf8')): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if ((!arg || !isLiteralSpecifier(arg)) && !isInstalledDiskHelper(file, node, source)) {
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
      .flatMap(file => computedImports(file));
    expect(offenders).toEqual([]);
  });

  it('the exceptions are still real (a stale entry would hide a new offender)', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(computedImports(join(ROOT, file)).length, `${file} no longer loads a computed specifier; drop it from ALLOWED`).toBeGreaterThan(0);
    }
  });

  it('admits exactly the fixed guarded disk helper, while generic imports in that file still fail', () => {
    const file = join(ROOT, DISK_HELPER_FILE);
    const source = readFileSync(file, 'utf8');
    const sourceAst = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
    const admitted: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && isInstalledDiskHelper(file, node, sourceAst)) admitted.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sourceAst);
    expect(admitted).toHaveLength(1);
    expect(computedImports(file, source + '\nconst unrelated = import(globalThis.specifier);')).toHaveLength(1);
  });

  it.each(['other-file', 'missing-guard', 'before-guard', 'nested', 'extra-import', 'different-helper', 'different-root'])('rejects %s disk-helper lookalikes', shape => {
    let file = join(ROOT, DISK_HELPER_FILE);
    let body = diskHelperBody.body!.getText();
    if (shape === 'other-file') file = join(ROOT, 'src/core/desktop/other.ts');
    if (shape === 'missing-guard') body = body.replace("if (!root || root !== runningPackageRoot()) hold('unsupported-installed-runtime');", '');
    if (shape === 'before-guard') body = `{
      const helper = await import(pathToFileURL(join(root, 'scripts', 'local-app-transaction.mjs')).href);
      if (!root || root !== runningPackageRoot()) hold('unsupported-installed-runtime');
      return helper as TransactionModule;
    }`;
    if (shape === 'extra-import') body = body.replace('{', '{ const another = import(root);');
    if (shape === 'different-helper') body = body.replace('local-app-transaction.mjs', 'other.mjs');
    if (shape === 'different-root') body = body.replace("join(root, 'scripts'", "join(candidateRoot, 'scripts'");
    let text = `async function loadInstalledDesktopTransaction(root: string) ${body}`;
    if (shape === 'nested') text = `function wrapper() { ${text} }`;
    expect(computedImports(file, text).length).toBeGreaterThan(0);
  });

  it('the session engine loads the reasoning tap with a literal import', () => {
    const text = readFileSync(join(ROOT, 'src', 'core', 'verse', 'session-engine.ts'), 'utf8');
    expect(text).toContain("import('../reasoning/ingest-verse.js')");
  });
});
