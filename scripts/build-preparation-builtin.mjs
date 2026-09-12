#!/usr/bin/env node
/** Authoring/build time only. Never build dependencies from a candidate artifact.
 * Installed runtime code consumes the fixed files and verifies their manifest;
 * esbuild and the source checkout are not runtime requirements. */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const PREPARATION_BUILTIN_ID = 'preparation-measurement-v1';
export const PREPARATION_BUILTIN_FILES = Object.freeze([
  'preparation-bridge.mjs',
  'preparation-verification-activity.mjs',
  'preparation-verification-child.mjs',
  'preparation-verification-controller.mjs',
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
  const source = readFileSync(subject, 'utf8');
  const paths = [...new Set([...source.matchAll(/\bfrom\s+'([^']+)'/g)].map(match => match[1]))]
    .filter(path => path.startsWith('.'));
  if (!paths.includes('../universe/git-blob-batch.js')) paths.push('../universe/git-blob-batch.js');
  const imports = paths.map((path, index) => `import * as dependency${index} from ${JSON.stringify(resolve(dirname(subject), path.replace(/\.js$/, '.ts')))};`);
  mkdirSync(dirname(outfile), { recursive: true });
  await build({ absWorkingDir: root, stdin: {
    contents: `${imports.join('\n')}\nimport * as baseline from ${JSON.stringify(subject)};
    export { baseline };
    export { runVerifySubprocessAsync } from ${JSON.stringify(join(root, 'src/core/run/verify-commands.ts'))};
    export { confinedUniverseArgv } from ${JSON.stringify(join(root, 'src/core/universe/fixed-evaluator.ts'))};
    export const dependencies = {${paths.map((path, index) => `${JSON.stringify(path)}:dependency${index}`).join(',')}};`,
    resolveDir: root, sourcefile: 'fixed-preparation-bridge.ts', loader: 'ts',
  }, bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile,
  banner: { js: "import { createRequire as fixedCreateRequire } from 'node:module'; const require = fixedCreateRequire(import.meta.url);" },
  logLevel: 'silent' });
  for (const file of PREPARATION_BUILTIN_FILES) {
    if (file === 'preparation-bridge.mjs' || file === 'preparation-verification.mjs') continue;
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
