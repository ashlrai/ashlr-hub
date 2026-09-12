#!/usr/bin/env node
/** Authoring/build time only. Never build dependencies from a candidate artifact.
 * Installed runtime code consumes the fixed files and verifies their manifest;
 * esbuild and the source checkout are not runtime requirements. */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const PREPARATION_BUILTIN_ID = 'preparation-measurement-v1';
export const PREPARATION_BUILTIN_FILES = Object.freeze([
  'preparation-bridge.mjs',
  'preparation-verification-activity.mjs',
  'preparation-verification-child.mjs',
  'preparation-verification-controller.mjs',
  'preparation-verification-fixtures.mjs',
  'preparation-verification-protocol.mjs',
  'preparation-verification-tool.mjs',
  'preparation-verification.mjs',
]);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Shared with private test packaging. repository is trusted authoring source,
 * not an argument accepted by the installed evaluator or the build CLI. */
export async function buildPreparationVerificationBridge(repository, outfile) {
  const root = realpathSync(repository);
  const subject = join(root, 'src/core/resources/engineering-preparation.ts');
  const candidateSpecifier = 'ashlr:preparation-candidate';
  // This separate trusted graph must never inline the baseline subject. Every
  // nested reader, including successor re-exports, resolves to the same slot.
  const workflow = await build({ absWorkingDir: root,
    entryPoints: [join(root, 'scripts/evaluators/preparation-verification-workflow.ts')],
    bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, metafile: true,
    banner: { js: 'import { require as fixedWorkflowRequire } from "ashlr:preparation-native"; const require = fixedWorkflowRequire;' },
    plugins: [{ name: 'exact-preparation-candidate', setup(builder) {
      builder.onResolve({ filter: /engineering-preparation\.[cm]?[jt]s$/ }, async args => {
        if (args.pluginData?.candidateResolved) return;
        const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind,
          pluginData: { candidateResolved: true } });
        if (resolved.errors.length) return { errors: resolved.errors };
        if (resolved.path && realpathSync(resolved.path) === subject) return { path: candidateSpecifier, external: true };
      });
    } }], logLevel: 'silent' });
  if (Object.keys(workflow.metafile.inputs).some(file => resolve(root, file) === subject)) {
    throw new Error('Trusted workflow unexpectedly includes baseline preparation');
  }
  const workflowImports = Object.values(workflow.metafile.outputs).flatMap(output => output.imports);
  if (!workflowImports.some(entry => entry.path === candidateSpecifier) ||
      workflowImports.some(entry => entry.path !== candidateSpecifier && !isBuiltin(entry.path))) {
    throw new Error('Trusted workflow has an unsupported dependency');
  }
  const workflowNatives = [...new Set(workflowImports.filter(entry => isBuiltin(entry.path)).map(entry => entry.path))].sort();
  const workflowSource = workflow.outputFiles[0]?.text;
  if (!workflowSource || Buffer.byteLength(workflowSource) > 32 * 1024 * 1024) throw new Error('Trusted workflow exceeds source limit');
  const source = readFileSync(subject, 'utf8');
  const paths = [...new Set([...source.matchAll(/\bfrom\s+'([^']+)'/g)].map(match => match[1]))]
    .filter(path => path.startsWith('.'));
  if (!paths.includes('../universe/git-blob-batch.js')) paths.push('../universe/git-blob-batch.js');
  const imports = paths.map((path, index) => `import * as dependency${index} from ${JSON.stringify(resolve(dirname(subject), path.replace(/\.js$/, '.ts')))};`);
  mkdirSync(dirname(outfile), { recursive: true });
  await build({ absWorkingDir: root, stdin: {
    contents: `${imports.join('\n')}\n${workflowNatives.map((specifier, index) => `import * as workflowNative${index} from ${JSON.stringify(specifier)};`).join('\n')}
    import * as baseline from ${JSON.stringify(subject)};
    export { baseline };
    export const workflowSource = ${JSON.stringify(workflowSource)};
    export const workflowDependencies = {${workflowNatives.map((specifier, index) => `${JSON.stringify(specifier)}:workflowNative${index}`).join(',')}};
    export { runVerifySubprocessAsync } from ${JSON.stringify(join(root, 'src/core/run/verify-commands.ts'))};
    export { confinedUniverseArgv } from ${JSON.stringify(join(root, 'src/core/universe/fixed-evaluator.ts'))};
    export const dependencies = {${paths.map((path, index) => `${JSON.stringify(path)}:dependency${index}`).join(',')}};`,
    resolveDir: root, sourcefile: 'fixed-preparation-bridge.ts', loader: 'ts',
  }, bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile,
  banner: { js: "import { createRequire as fixedCreateRequire } from 'node:module'; const require = fixedCreateRequire(import.meta.url);" },
  logLevel: 'silent' });
  const runner = realpathSync(join(root, 'src/core/run/verify-commands.ts'));
  const wrapper = realpathSync(join(root, 'scripts/evaluators/preparation-verification-fixture-runtime.ts'));
  // Only the trusted fixture graph is rewritten. The wrapper's own imports
  // retain the actual runner and every other export without recursive wrapping.
  const fixtures = await build({ absWorkingDir: root,
    entryPoints: [join(root, 'scripts/evaluators/preparation-verification-fixtures.ts')],
    bundle: true, platform: 'node', target: 'node24', format: 'esm', metafile: true,
    outfile: join(dirname(outfile), 'preparation-verification-fixtures.mjs'),
    banner: { js: "import { createRequire as fixedCreateRequire } from 'node:module'; const require = fixedCreateRequire(import.meta.url);" },
    plugins: [{ name: 'owned-fixture-runner', setup(builder) {
      builder.onResolve({ filter: /verify-commands\.[cm]?[jt]s$/ }, async args => {
        if (args.importer === wrapper || args.pluginData?.fixtureRunnerResolved) return;
        const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind,
          pluginData: { fixtureRunnerResolved: true } });
        if (resolved.errors.length) return { errors: resolved.errors };
        if (resolved.path && realpathSync(resolved.path) === runner) return { path: wrapper };
      });
    } }], logLevel: 'silent' });
  const fixtureInputs = Object.keys(fixtures.metafile.inputs).map(file => resolve(root, file));
  if (!fixtureInputs.includes(wrapper) || !fixtureInputs.includes(runner) ||
      fixtureInputs.some(file => file.startsWith(join(root, 'test') + '/')) ||
      Object.values(fixtures.metafile.outputs).flatMap(output => output.imports).some(entry => !isBuiltin(entry.path))) {
    throw new Error('Trusted fixture has an unsupported dependency');
  }
  for (const file of PREPARATION_BUILTIN_FILES) {
    if (['preparation-bridge.mjs', 'preparation-verification.mjs', 'preparation-verification-fixtures.mjs'].includes(file)) continue;
    copyFileSync(join(root, 'scripts/evaluators', file), join(dirname(outfile), file));
  }
}

/** A fixed content manifest: no timestamps, absolute build paths or self-hash. */
export async function buildPreparationBuiltin() {
  const output = join(sourceRoot, 'dist/core/universe/builtins/preparation');
  await buildPreparationVerificationBridge(sourceRoot, join(output, 'preparation-bridge.mjs'));
  copyFileSync(join(sourceRoot, 'scripts/evaluators/preparation-verification.mjs'), join(output, 'preparation-verification.mjs'));
  const manifest = { schemaVersion: 1, id: PREPARATION_BUILTIN_ID, files: PREPARATION_BUILTIN_FILES.map(name => ({
    name, digest: createHash('sha256').update(readFileSync(join(output, name))).digest('hex'),
  })) };
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest) + '\n', { mode: 0o644 });
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error('The preparation builtin build accepts no arguments');
  await buildPreparationBuiltin();
}
