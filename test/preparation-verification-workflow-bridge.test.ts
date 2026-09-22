/** Build/parse only: generated evaluator and candidate code are never evaluated. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPreparationVerificationBridge, PREPARATION_BUILTIN_FILES } from '../scripts/build-preparation-builtin.mjs';

const builds = vi.hoisted(() => [] as Array<{
  options: import('esbuild').BuildOptions;
  result: import('esbuild').BuildResult;
}>);
vi.mock('esbuild', async importOriginal => {
  const original = await importOriginal<typeof import('esbuild')>();
  return { ...original, async build(options: import('esbuild').BuildOptions) {
    const result = await original.build(options);
    builds.push({ options, result });
    return result;
  } };
});

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(repository, 'src/core/resources/engineering-preparation.ts');
const candidateSlot = 'ashlr:preparation-candidate';
const installedFiles = ['preparation-bridge.mjs', 'preparation-verification-activity.mjs',
  'preparation-verification-child.mjs', 'preparation-verification-controller.mjs', 'preparation-verification-fixtures.mjs',
  'preparation-verification-native.mjs', 'preparation-verification-protocol.mjs', 'preparation-verification-tool.mjs', 'preparation-verification.mjs'];
let root: string;
let first: string;
let second: string;
let workflow: string;
let graph: import('esbuild').Metafile;

function parsed(text: string) {
  return ts.createSourceFile('fixed-workflow.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}
function imports(text: string) {
  return parsed(text).statements.filter(ts.isImportDeclaration).map(statement => {
    if (!ts.isStringLiteral(statement.moduleSpecifier)) throw new Error('Nonliteral fixed import');
    const bindings = statement.importClause?.namedBindings;
    return { path: statement.moduleSpecifier.text,
      names: bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map(element => element.propertyName?.text ?? element.name.text) : [] };
  });
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-workflow-bridge-')));
  first = join(root, 'first'); second = join(root, 'second');
  await buildPreparationVerificationBridge(repository, join(first, 'preparation-bridge.mjs'));
  const captured = builds.find(entry => entry.options.metafile === true);
  if (!captured?.result.metafile || !captured.result.outputFiles?.[0]) throw new Error('Missing workflow build graph');
  graph = captured.result.metafile; workflow = captured.result.outputFiles[0].text;
  // The mutable artifact location cannot redirect author-time dependency input.
  const candidate = join(root, 'candidate');
  mkdirSync(join(candidate, 'scripts/evaluators'), { recursive: true, mode: 0o700 });
  mkdirSync(join(candidate, 'src/core/resources'), { recursive: true, mode: 0o700 });
  writeFileSync(join(candidate, 'scripts/evaluators/preparation-verification-workflow.ts'), 'export const candidateOnly = true;\n');
  writeFileSync(join(candidate, 'src/core/resources/engineering-preparation.ts'), 'export const candidateOnly = true;\n');
  vi.stubEnv('ASHLR_UNIVERSE_CANDIDATE', candidate);
  await buildPreparationVerificationBridge(repository, join(second, 'preparation-bridge.mjs'));
}, 30000);

afterAll(() => {
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('fixed candidate-linked workflow packaging', () => {
  it('bundles the real manager and successor alias without inlining baseline preparation', () => {
    const inputs = Object.keys(graph.inputs).map(file => resolve(repository, file));
    expect(inputs).toContain(join(repository, 'scripts/evaluators/preparation-verification-workflow.ts'));
    expect(inputs).toContain(join(repository, 'src/core/resources/console-engineering-preparation.ts'));
    expect(inputs).toContain(join(repository, 'src/core/resources/engineering-preparation-registry.ts'));
    expect(inputs).toContain(join(repository, 'src/core/resources/engineering-successor-preparation.ts'));
    expect(inputs).not.toContain(target);
    const external = Object.values(graph.outputs).flatMap(output => output.imports);
    expect(external.some(entry => entry.path === candidateSlot && entry.external)).toBe(true);
    expect(external.every(entry => entry.external && (entry.path === candidateSlot || isBuiltin(entry.path)))).toBe(true);
  });

  it('routes both ordinary and successor named imports through the candidate slot', () => {
    const candidateImports = imports(workflow).filter(entry => entry.path === candidateSlot);
    const names = new Set(candidateImports.flatMap(entry => entry.names));
    for (const name of ['checkResourceEngineeringPreparation', 'readPreparedResourceEngineeringBundle',
      'readPreparedResourceEngineeringMetadata', 'prepareResourceEngineeringBundle',
      'readResourceEngineeringSuccessorBundle', 'readResourceEngineeringSuccessorMetadata',
      'checkResourceEngineeringSuccessorPreparation', 'prepareResourceEngineeringSuccessorBundle']) {
      expect(names.has(name), name).toBe(true);
    }
    expect(imports(workflow).every(entry => entry.path === candidateSlot ||
      entry.path === 'ashlr:preparation-native' || isBuiltin(entry.path))).toBe(true);
  });

  it('embeds the exact inspected workflow as inert string data in the existing bridge', () => {
    const bridge = parsed(readFileSync(join(first, 'preparation-bridge.mjs'), 'utf8'));
    const declarations = bridge.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations);
    const value = declarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'workflowSource')?.initializer;
    expect(value && ts.isStringLiteral(value) ? value.text : undefined).toBe(workflow);
  });

  it('pins all three generated graphs and copies only the fixed trusted sidecars', () => {
    expect(PREPARATION_BUILTIN_FILES).toEqual(installedFiles);
    expect(readdirSync(first).sort()).toEqual(installedFiles.slice().sort());
    for (const name of installedFiles.filter(name => !['preparation-bridge.mjs', 'preparation-verification-fixtures.mjs', 'preparation-verification.mjs'].includes(name))) {
      expect(readFileSync(join(first, name))).toEqual(readFileSync(join(repository, 'scripts/evaluators', name)));
    }
  });

  it('is byte deterministic and ignores a candidate-supplied workflow or dependency source', () => {
    expect(readdirSync(second).sort()).toEqual(readdirSync(first).sort());
    for (const name of readdirSync(first)) expect(readFileSync(join(second, name))).toEqual(readFileSync(join(first, name)));
    const graphs = builds.filter(entry => entry.options.metafile === true).map(entry => entry.result.metafile);
    expect(graphs).toHaveLength(6);
    expect(graphs[3]).toEqual(graphs[0]);
    for (const index of [1, 2]) {
      expect(graphs[index + 3]!.inputs).toEqual(graphs[index]!.inputs);
      expect(Object.values(graphs[index + 3]!.outputs)).toEqual(Object.values(graphs[index]!.outputs));
    }
  });

  it('embeds the source-only workload into the installed entry without a tenth file', () => {
    const entryGraph = builds.filter(entry => entry.options.metafile === true)[2]!.result.metafile!;
    expect(Object.keys(entryGraph.inputs).sort()).toEqual([
      'scripts/evaluators/preparation-verification.mjs', 'scripts/evaluators/preparation-workload.mjs',
    ]);
    const sidecars = new Set(['./preparation-verification-controller.mjs', './preparation-verification-activity.mjs',
      './preparation-verification-protocol.mjs', './preparation-verification-native.mjs', './preparation-verification-fixtures.mjs']);
    const external = Object.values(entryGraph.outputs).flatMap(output => output.imports);
    expect(external.every(row => row.external && (isBuiltin(row.path) || sidecars.has(row.path)))).toBe(true);
    const entry = readFileSync(join(first, 'preparation-verification.mjs'), 'utf8');
    expect(entry).not.toEqual(readFileSync(join(repository, 'scripts/evaluators/preparation-verification.mjs'), 'utf8'));
    expect(imports(entry).some(row => row.path === './preparation-workload.mjs')).toBe(false);
    expect(readdirSync(first)).not.toContain('preparation-workload.mjs');
  });

  it('ships baseline fixture setup separately with owned generator and evaluator imports', () => {
    const fixtureGraph = builds.filter(entry => entry.options.metafile === true)[1]!.result.metafile!;
    const wrapper = 'scripts/evaluators/preparation-verification-fixture-runtime.ts';
    const runner = 'src/core/run/verify-commands.ts';
    expect(Object.keys(fixtureGraph.inputs)).toContain(wrapper);
    expect(Object.keys(fixtureGraph.inputs)).toContain(runner);
    expect(Object.keys(fixtureGraph.inputs)).toContain('src/core/resources/engineering-preparation.ts');
    expect(Object.keys(fixtureGraph.inputs).some(file => file.startsWith('test/'))).toBe(false);
    for (const caller of ['src/core/universe/runner.ts', 'src/core/universe/fixed-evaluator.ts']) {
      const paths = fixtureGraph.inputs[caller]!.imports.map(row => row.path);
      expect(paths).toContain(wrapper); expect(paths).not.toContain(runner);
    }
    expect(fixtureGraph.inputs[wrapper]!.imports.some(row => row.path === runner)).toBe(true);
    expect(Object.values(fixtureGraph.outputs).flatMap(output => output.imports).every(row => isBuiltin(row.path))).toBe(true);
  });
});
