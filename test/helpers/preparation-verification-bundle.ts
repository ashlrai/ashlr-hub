/** Authoring only: package existing trusted dependencies before candidate work.
 * The resulting bridge belongs to the immutable evaluator, not its mutable scope. */
import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

export async function buildPreparationVerificationBridge(repository: string, outfile: string): Promise<void> {
  const subject = resolve(repository, 'src/core/resources/engineering-preparation.ts');
  const source = readFileSync(subject, 'utf8');
  const paths = [...new Set([...source.matchAll(/\bfrom\s+'([^']+)'/g)].map(match => match[1]!))]
    .filter(path => path.startsWith('.'));
  paths.push('../universe/git-blob-batch.js');
  const imports = paths.map((path, index) => `import * as dependency${index} from ${JSON.stringify(resolve(dirname(subject), path.replace(/\.js$/, '.ts')))};`);
  await build({ stdin: { contents: `${imports.join('\n')}\nimport * as baseline from ${JSON.stringify(subject)};
    export { baseline };
    export { runVerifySubprocessAsync } from ${JSON.stringify(resolve(repository, 'src/core/run/verify-commands.ts'))};
    export { confinedUniverseArgv } from ${JSON.stringify(resolve(repository, 'src/core/universe/fixed-evaluator.ts'))};
    export const dependencies = {${paths.map((path, index) => `${JSON.stringify(path)}:dependency${index}`).join(',')}};`,
    resolveDir: repository, sourcefile: 'fixed-preparation-bridge.ts', loader: 'ts' },
    bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile,
    banner: { js: "import { createRequire as fixedCreateRequire } from 'node:module'; const require = fixedCreateRequire(import.meta.url);" },
    logLevel: 'silent' });
  // The fixed evaluator artifact must contain its entire local process boundary;
  // installed dependencies or mutable repository paths are not available there.
  for (const file of ['preparation-verification-controller.mjs', 'preparation-verification-protocol.mjs', 'preparation-verification-child.mjs']) {
    copyFileSync(join(repository, 'scripts/evaluators', file), join(dirname(outfile), file));
  }
}
