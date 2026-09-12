/** Authoring only: package existing trusted dependencies before candidate work.
 * The resulting bridge belongs to the immutable evaluator, not its mutable scope. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

export async function buildPreparationVerificationBridge(repository: string, outfile: string): Promise<void> {
  const subject = resolve(repository, 'src/core/resources/engineering-preparation.ts');
  const source = readFileSync(subject, 'utf8');
  const paths = [...new Set([...source.matchAll(/\bfrom\s+'([^']+)'/g)].map(match => match[1]!))]
    .filter(path => path.startsWith('.'));
  paths.push('../universe/git-blob-batch.js');
  const imports = paths.map((path, index) => `import * as dependency${index} from ${JSON.stringify(resolve(dirname(subject), path.replace(/\.js$/, '.ts')))};`);
  await build({ stdin: { contents: `${imports.join('\n')}\nimport * as baseline from ${JSON.stringify(subject)};
    export { baseline }; export const dependencies = {${paths.map((path, index) => `${JSON.stringify(path)}:dependency${index}`).join(',')}};`,
    resolveDir: repository, sourcefile: 'fixed-preparation-bridge.ts', loader: 'ts' },
    bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile,
    banner: { js: "import { createRequire as fixedCreateRequire } from 'node:module'; const require = fixedCreateRequire(import.meta.url);" },
    logLevel: 'silent' });
}
